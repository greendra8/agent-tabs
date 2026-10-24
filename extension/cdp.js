// chrome.debugger (CDP) attachment and per-tab runtime state.
//
// Focus rules, modelled on the Codex Chrome extension:
// - Emulation.setFocusEmulationEnabled on every attach, so hidden pages behave as if focused.
// - Popups (window.open, target=_blank links and forms) are rerouted into background tabs by a
//   guard script injected before page scripts; Chrome would otherwise open a foreground tab or
//   window and raise Chrome.
// - The native file chooser is intercepted, so it never opens a macOS dialog.
// - Screenshots use Page.captureScreenshot, never chrome.tabs.captureVisibleTab.

import { blockedReason } from "./policy.js";
import { moveAgentCursor } from "./page-functions.js";

const CDP_VERSION = "1.3";
const COMMAND_TIMEOUT_MS = 20000;
const CONSOLE_LIMIT = 200;
const POPUPS_PER_MINUTE = 10;
const DIALOG_AUTO_DISMISS_MS = 120000;

const tabs = new Map(); // tabId -> TabState
let popupHandler = async () => {};

// The page-visible binding the popup guard calls. Random per install, so pages can't guess it,
// and stable across service worker restarts, so guards in already-loaded pages keep working
// after a re-attach.
let bindingName = "";
const bindingReady = chrome.storage.local.get("bindingName").then(async (saved) => {
  bindingName = saved.bindingName ?? "__at" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  if (!saved.bindingName) await chrome.storage.local.set({ bindingName });
});

export function onPopup(handler) {
  popupHandler = handler;
}

export function state(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = {
      tabId,
      attached: false,
      attaching: null,
      children: new Map(), // CDP sessionId -> { frameId, url }
      frameContexts: new Map(), // "sessionId|frameId" -> id of the frame's main-world JS context
      inflight: new Map(), // sessionId|requestId -> start time
      lastNetworkAt: 0,
      mainLoading: false,
      loadCount: 0,
      domContentCount: 0,
      navigationCount: 0,
      sameDocumentCount: 0, // pushState/hash navigations (single-page apps)
      dialog: null,
      fileChooser: null,
      downloads: [],
      console: [],
      notes: [],
      refs: new Map(), // "e12" -> { sessionId, backendNodeId }
      refKeys: new Map(), // "sessionId|backendNodeId" -> "e12"
      nextRef: 1,
      popupTimes: [],
      popupsOpening: 0, // rerouted popups still being created; actions wait for them
      cursor: null, // { x, y, label }: where the agent cursor was, redrawn on each new page
      drag: null,
      waiters: new Set(),
    };
    tabs.set(tabId, st);
  }
  return st;
}

export function dropState(tabId) {
  tabs.delete(tabId);
}

export function note(st, text) {
  st.notes.push(text);
  if (st.notes.length > 20) st.notes.shift();
}

export function takeNotes(st) {
  const notes = st.notes;
  st.notes = [];
  return notes;
}

// Resolves with check(st) once it is truthy (re-evaluated on every CDP event for the tab), or
// with null after timeoutMs.
export function waitFor(st, check, timeoutMs) {
  const watch = watchFor(st, check);
  const timer = setTimeout(() => watch.cancel(), timeoutMs);
  return watch.promise.finally(() => clearTimeout(timer));
}

// Like waitFor without a timeout; cancel() resolves the promise with null.
export function watchFor(st, check) {
  let finish;
  const promise = new Promise((resolve) => {
    finish = (value) => {
      st.waiters.delete(waiter);
      resolve(value);
    };
  });
  const waiter = () => {
    const value = check(st);
    if (value) finish(value);
  };
  st.waiters.add(waiter);
  waiter();
  return { promise, cancel: () => finish(null) };
}

// Runs an input action, but returns early if it opens a JavaScript dialog: CDP input commands
// don't complete while a dialog blocks the page.
export async function raceDialog(st, action) {
  const dialog = watchFor(st, (s) => s.dialog);
  action.catch(() => {}); // may reject after we stop waiting for it
  try {
    await Promise.race([action, dialog.promise]);
  } finally {
    dialog.cancel();
  }
}

function wake(st) {
  for (const waiter of [...st.waiters]) waiter();
}

export function send(tabId, method, params = {}, { sessionId, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  const command = chrome.debugger.sendCommand(target, method, params);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs} ms`)), timeoutMs);
    command.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------- attach ----------

export async function ensureAttached(tabId) {
  const st = state(tabId);
  if (st.attached) return st;
  st.attaching ??= attach(st).finally(() => {
    st.attaching = null;
  });
  await st.attaching;
  return st;
}

async function attach(st) {
  await bindingReady;
  for (let attempt = 1; ; attempt++) {
    try {
      await chrome.debugger.attach({ tabId: st.tabId }, CDP_VERSION);
      break;
    } catch (error) {
      const message = String(error?.message);
      if (/already attached/i.test(message) && attempt === 1) {
        // After a service worker restart the tab can still be attached to us.
        await chrome.debugger.detach({ tabId: st.tabId }).catch(() => {});
      } else if (/different extension/i.test(message) && attempt <= 3) {
        // Another extension's frame is in the page, usually Bitwarden's autofill menu, opened
        // because a login field has focus. Chrome won't let us debug the tab until it goes, so
        // move focus off the field (which closes the menu) and try again.
        await chrome.scripting
          .executeScript({
            target: { tabId: st.tabId, allFrames: true },
            func: () => {
              document.activeElement?.blur?.();
              document.querySelectorAll("bit-notification-bar-root").forEach((bar) => bar.remove());
            },
          })
          .catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 700));
      } else if (/different extension/i.test(message)) {
        throw new Error("Another extension's menu (probably Bitwarden's autofill menu) is open in this tab, and Chrome blocks agent control while it is. Use browser_fill_login instead of clicking login fields.");
      } else {
        throw error;
      }
    }
  }
  st.attached = true;
  await configureTarget(st);
}

// Applied to the tab and to every cross-origin iframe target.
async function configureTarget(st, sessionId) {
  const call = (method, params) => send(st.tabId, method, params, { sessionId });
  const optional = (method, params) => call(method, params).catch(() => {});
  await call("Page.enable");
  await call("Runtime.enable");
  await optional("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  await optional("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Runtime.addBinding", { name: bindingName });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: popupGuard(), runImmediately: true });
  await optional("Page.setInterceptFileChooserDialog", { enabled: true });
  await call("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
  await optional("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "iframe", exclude: false }],
  });
}

export async function detach(tabId) {
  const st = tabs.get(tabId);
  tabs.delete(tabId);
  if (st?.attached) await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  const st = tabs.get(tabId);
  if (!st) return;
  st.attached = false;
  st.children.clear();
  st.inflight.clear();
  st.dialog = null;
  if (reason === "canceled_by_user") note(st, "The user cancelled debugging for this tab from Chrome's infobar; it will be re-attached on the next action.");
  wake(st);
});

// ---------- events ----------

chrome.debugger.onEvent.addListener((source, method, params) => {
  const st = tabs.get(source.tabId);
  if (!st) return;
  handleEvent(st, source.sessionId, method, params).catch((error) => console.warn("agent-tabs event", method, error));
  wake(st);
});

async function handleEvent(st, sessionId, method, params) {
  switch (method) {
    case "Fetch.requestPaused": {
      const reason = blockedReason(params.request.url);
      if (reason) {
        // Embedded frames (such as a background Google sign-in iframe) are blocked silently.
        const topLevel = !sessionId && (!st.mainFrameId || params.frameId === st.mainFrameId);
        if (topLevel) note(st, `Blocked navigation: ${reason}.`);
        await send(st.tabId, "Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, { sessionId });
      } else {
        await send(st.tabId, "Fetch.continueRequest", { requestId: params.requestId }, { sessionId });
      }
      return;
    }
    case "Target.attachedToTarget": {
      const child = params.sessionId;
      st.children.set(child, { frameId: params.targetInfo.targetId, url: params.targetInfo.url });
      try {
        await configureTarget(st, child);
      } finally {
        await send(st.tabId, "Runtime.runIfWaitingForDebugger", {}, { sessionId: child }).catch(() => {});
      }
      return;
    }
    case "Target.detachedFromTarget":
      st.children.delete(params.sessionId);
      return;
    case "Runtime.bindingCalled":
      if (params.name === bindingName) await reroutePopup(st, params.payload);
      return;
    case "Page.javascriptDialogOpening": {
      if (params.type === "beforeunload") {
        // Same as Codex: leaving a page is never blocked by "unsaved changes" prompts.
        await send(st.tabId, "Page.handleJavaScriptDialog", { accept: true }, { sessionId }).catch(() => {});
        return;
      }
      const dialog = { type: params.type, message: params.message.slice(0, 500), defaultPrompt: params.defaultPrompt, sessionId, openedAt: Date.now() };
      st.dialog = dialog;
      note(st, `A JavaScript ${params.type} dialog is open: "${dialog.message}". Handle it with browser_dialog.`);
      // An unattended dialog blocks the page; dismiss it if nobody handles it.
      setTimeout(() => {
        if (st.dialog !== dialog) return;
        send(st.tabId, "Page.handleJavaScriptDialog", { accept: false }, { sessionId }).catch(() => {});
        note(st, `The ${dialog.type} dialog "${dialog.message}" was dismissed automatically after ${DIALOG_AUTO_DISMISS_MS / 1000} s.`);
      }, DIALOG_AUTO_DISMISS_MS);
      return;
    }
    case "Page.javascriptDialogClosed":
      st.dialog = null;
      return;
    case "Page.fileChooserOpened":
      st.fileChooser = { backendNodeId: params.backendNodeId, mode: params.mode, sessionId, openedAt: Date.now() };
      return;
    case "Page.downloadWillBegin":
      st.downloads.push({ guid: params.guid, url: params.url, suggestedFilename: params.suggestedFilename, state: "inProgress", startedAt: Date.now() });
      note(st, `Download started: ${params.suggestedFilename}. Check it with browser_downloads.`);
      return;
    case "Page.downloadProgress": {
      const download = st.downloads.find((d) => d.guid === params.guid);
      if (download) Object.assign(download, { state: params.state, receivedBytes: params.receivedBytes, totalBytes: params.totalBytes });
      return;
    }
    case "Page.frameStartedLoading":
      if (!sessionId && isMainFrame(st, params.frameId)) st.mainLoading = true;
      return;
    case "Page.frameNavigated":
      if (!sessionId && !params.frame.parentId) {
        st.mainFrameId = params.frame.id;
        st.navigationCount++;
        clearRefs(st);
      }
      return;
    case "Page.navigatedWithinDocument":
      if (!sessionId && isMainFrame(st, params.frameId)) st.sameDocumentCount++;
      return;
    case "Page.domContentEventFired":
      if (!sessionId) {
        st.domContentCount++;
        // A new document starts without the agent cursor; put it back where it was.
        if (st.cursor) {
          const { x, y, label, style } = st.cursor;
          await send(st.tabId, "Runtime.evaluate", { expression: `(${moveAgentCursor})(${x}, ${y}, false, 0, ${JSON.stringify(label)}, ${JSON.stringify(style)})` }).catch(() => {});
        }
      }
      return;
    case "Page.loadEventFired":
      if (!sessionId) {
        st.mainLoading = false;
        st.loadCount++;
      }
      return;
    case "Page.frameStoppedLoading":
      if (!sessionId && isMainFrame(st, params.frameId)) st.mainLoading = false;
      return;
    case "Network.requestWillBeSent":
      if (params.type !== "WebSocket" && params.type !== "EventSource") {
        st.inflight.set(`${sessionId}|${params.requestId}`, Date.now());
        st.lastNetworkAt = Date.now();
      }
      return;
    case "Network.loadingFinished":
    case "Network.loadingFailed":
      if (st.inflight.delete(`${sessionId}|${params.requestId}`)) st.lastNetworkAt = Date.now();
      return;
    case "Runtime.executionContextCreated": {
      const { id, auxData } = params.context;
      if (auxData?.isDefault && auxData.frameId) st.frameContexts.set(`${sessionId ?? ""}|${auxData.frameId}`, { sessionId, contextId: id, frameId: auxData.frameId });
      return;
    }
    case "Runtime.executionContextDestroyed":
      for (const [key, frame] of st.frameContexts) {
        if (frame.sessionId === sessionId && frame.contextId === params.executionContextId) st.frameContexts.delete(key);
      }
      return;
    case "Runtime.executionContextsCleared":
      for (const [key, frame] of st.frameContexts) if (frame.sessionId === sessionId) st.frameContexts.delete(key);
      return;
    case "Runtime.consoleAPICalled":
      pushConsole(st, params.type, (params.args ?? []).map(describeRemote).join(" "));
      return;
    case "Runtime.exceptionThrown":
      pushConsole(st, "exception", params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "");
      return;
    case "Input.dragIntercepted":
      st.drag = params.data;
      return;
  }
}

function isMainFrame(st, frameId) {
  return !st.mainFrameId || st.mainFrameId === frameId;
}

function describeRemote(arg) {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type;
}

function pushConsole(st, level, text) {
  st.console.push({ at: new Date().toISOString(), level, text: String(text).slice(0, 1000) });
  if (st.console.length > CONSOLE_LIMIT) st.console.shift();
}

export function activeRequests(st) {
  const now = Date.now();
  let count = 0;
  for (const [key, startedAt] of st.inflight) {
    // Long-polling and stuck requests shouldn't block "network idle" forever.
    if (now - startedAt > 30000) st.inflight.delete(key);
    else count++;
  }
  return count;
}

async function reroutePopup(st, url) {
  const now = Date.now();
  st.popupTimes = st.popupTimes.filter((t) => now - t < 60000);
  if (st.popupTimes.length >= POPUPS_PER_MINUTE) {
    note(st, `Ignored a popup to ${url}: more than ${POPUPS_PER_MINUTE} popups in a minute.`);
    return;
  }
  st.popupTimes.push(now);
  const reason = blockedReason(url);
  if (reason) {
    note(st, `Blocked a popup: ${reason}.`);
    return;
  }
  st.popupsOpening++;
  try {
    const tabId = await popupHandler(st.tabId, url);
    note(st, `New background tab ${tabId} opened (the page tried to open ${shortUrl(url)} in a new tab or window).`);
  } finally {
    st.popupsOpening--;
    wake(st);
  }
}

export function shortUrl(url, max = 200) {
  return url && url.length > max ? url.slice(0, max) + "…" : url;
}

// Every frame's main-world JavaScript context, main frame first. Same-site iframes share the
// page's process and CDP session but have their own context; cross-site ones have their own
// session. Page code that must see into iframes runs once per entry.
export function frameTargets(st) {
  const frames = [...st.frameContexts.values()];
  const isMain = (frame) => !frame.sessionId && frame.frameId === st.mainFrameId;
  frames.sort((a, b) => Number(isMain(b)) - Number(isMain(a)));
  return frames.length ? frames : [{ sessionId: undefined, contextId: undefined }];
}

// ---------- element refs ----------

export function refFor(st, sessionId, backendNodeId) {
  const key = `${sessionId ?? ""}|${backendNodeId}`;
  let ref = st.refKeys.get(key);
  if (!ref) {
    ref = `e${st.nextRef++}`;
    st.refKeys.set(key, ref);
    st.refs.set(ref, { sessionId, backendNodeId });
  }
  return ref;
}

function clearRefs(st) {
  st.refs.clear();
  st.refKeys.clear();
}

// ---------- popup guard (runs in the page's main world before page scripts) ----------

function popupGuard() {
  return `(() => {
  const name = ${JSON.stringify(bindingName)};
  const installed = Symbol.for("agent-tabs-guard");
  if (globalThis[installed]) return;
  Object.defineProperty(globalThis, installed, { value: true });
  const sameWindowTargets = ["", "_self", "_parent", "_top", "_unfencedtop"];
  const staysInPage = (name) => {
    name = String(name ?? "").toLowerCase();
    if (sameWindowTargets.includes(name)) return true;
    return [...document.querySelectorAll("iframe, frame")].some((f) => (f.getAttribute("name") ?? "").toLowerCase() === name);
  };
  // Sign-in popups report back to this page through window.opener, so they open for real
  // (Chrome may come forward while one is open); every other popup becomes a background tab.
  const SIGN_IN_HOSTS = /(^|\\.)(accounts\\.google\\.com|appleid\\.apple\\.com|idmsa\\.apple\\.com|login\\.microsoftonline\\.com|login\\.live\\.com|github\\.com|gitlab\\.com|login\\.salesforce\\.com|auth0\\.com|okta\\.com|clerk\\.[a-z.]+)$/;
  const SIGN_IN_PATHS = /\\/__\\/auth\\/handler|\\/oauth2?\\/|\\/o\\/oauth2|\\/authorize\\b|\\/sso\\b|\\/saml2?\\//i;
  const isSignIn = (url) => SIGN_IN_HOSTS.test(url.hostname) || SIGN_IN_PATHS.test(url.pathname);
  const reroute = (href) => {
    let url;
    try { url = new URL(href, document.baseURI); } catch { return false; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (isSignIn(url)) return false;
    // Looked up per call: after a debugger re-attach the binding is a new function.
    const binding = globalThis[name];
    if (typeof binding !== "function") return false;
    try { binding(url.href); } catch { return false; }
    return true;
  };
  // A page in a background tab can ask Chrome to raise its window; agent tabs never need that.
  window.focus = function focus() {};
  // Password managers put their autofill menus into the page as frames of their own extension,
  // and Chrome blocks debugging a tab while another extension's frame is in it. Two defences:
  // - ignore markers (Bitwarden honours data-bwignore once its hidden "Allow websites to exclude
  //   fields to autofill" setting is on; 1Password and LastPass have their own);
  // - while browser_fill_login types (the quiet flag is set), focus and click events on inputs
  //   are stopped before the password manager's own listeners, which open the menu, see them.
  //   This listener is registered first because this script runs before the page and extensions.
  const IGNORE = ["data-bwignore", "data-1p-ignore", "data-lpignore"];
  const QUIET = Symbol.for("agent-tabs-quiet");
  const hushed = new WeakSet();
  const hush = (event) => { if (globalThis[QUIET]) event.stopImmediatePropagation(); };
  const mark = (el) => {
    for (const name of IGNORE) if (!el.hasAttribute(name)) el.setAttribute(name, name === "data-lpignore" ? "true" : "");
    if (!hushed.has(el)) {
      hushed.add(el);
      el.addEventListener("focus", hush);
      el.addEventListener("click", hush);
    }
  };
  // Bitwarden's "save this login?" bar is another extension frame; agents never need it, so it is
  // removed as soon as it is inserted, before its frame loads.
  const PASSWORD_MANAGER_BARS = "bit-notification-bar-root";
  const markAll = (root) => {
    if (root.matches?.(PASSWORD_MANAGER_BARS)) return root.remove();
    if (root.matches?.("input")) mark(root);
    root.querySelectorAll?.("input").forEach(mark);
  };
  const watch = (root) => {
    markAll(root);
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) markAll(node);
    }).observe(root, { childList: true, subtree: true });
  };
  watch(document);
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init);
    watch(root);
    return root;
  };
  const originalOpen = window.open;
  window.open = function open(url, target, features) {
    if (url && !staysInPage(target === undefined ? "_blank" : target) && reroute(String(url))) {
      const noopener = String(features ?? "").split(",").some((f) => /^\\s*no(opener|referrer)\\s*(=\\s*(1|yes|true))?\\s*$/i.test(f));
      return noopener ? null : { closed: false, focus() {}, blur() {}, close() {}, postMessage() {} };
    }
    return originalOpen.apply(this, arguments);
  };
  // A capture listener re-arms a bubble listener on every click, so the decision is made after
  // page handlers had their chance to call preventDefault (as Codex does).
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
    if (!link || !link.href || (link.hasAttribute("download") && link.origin === location.origin)) return;
    const target = link.target || document.querySelector("base[target]")?.target || "";
    if (!staysInPage(target) && reroute(link.href)) event.preventDefault();
  };
  window.addEventListener("click", () => {
    window.removeEventListener("click", onClick);
    window.addEventListener("click", onClick, { once: true });
  }, true);
  const onSubmit = (event) => {
    const form = event.target;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement)) return;
    const target = event.submitter?.getAttribute("formtarget") || form.target || document.querySelector("base[target]")?.target || "";
    if (staysInPage(target)) return;
    const method = (event.submitter?.getAttribute("formmethod") || form.method || "get").toLowerCase();
    if (method === "get") {
      const url = new URL(event.submitter?.getAttribute("formaction") || form.action, document.baseURI);
      url.search = new URLSearchParams(new FormData(form, event.submitter ?? undefined)).toString();
      if (reroute(url.href)) event.preventDefault();
    } else {
      // A POST body can't be replayed in another tab; submit it in this tab instead.
      form.target = "_self";
    }
  };
  window.addEventListener("submit", () => {
    window.removeEventListener("submit", onSubmit);
    window.addEventListener("submit", onSubmit, { once: true });
  }, true);
})();`;
}
