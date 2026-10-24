// Operations the broker can call. Each takes the calling agent's session id and the tool's
// arguments. Only `show` changes which tab or window is focused.

import * as cdp from "./cdp.js";
import { send, ensureAttached, raceDialog, waitFor, activeRequests, takeNotes } from "./cdp.js";
import * as sessions from "./sessions.js";
import { blockedReason, policyFlags } from "./policy.js";
import { snapshot } from "./snapshot.js";
import { pressCombo, typeSlowly, insertText, modifierBits, mouseMove, mouseClick, mouseWheel } from "./input.js";
import * as page from "./page-functions.js";

const EVALUATE_SECRET_PATTERN = /document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|navigator\s*\.\s*credentials|cookieStore/;

export const ops = {
  async open_tab(sessionId, { url, label }) {
    if (label) await sessions.setLabel(sessionId, label);
    if (url) assertAllowed(url);
    const tabId = await sessions.createTab(sessionId);
    await ensureAttached(tabId);
    if (url) return ops.navigate(sessionId, { tabId, url });
    return result(cdp.state(tabId));
  },

  async list_tabs(sessionId) {
    const tabs = [];
    for (const tabId of sessions.ownedTabIds(sessionId)) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        await sessions.forgetTab(tabId);
        continue;
      }
      const st = cdp.state(tabId);
      tabs.push({ tabId, url: tab.url || tab.pendingUrl, title: tab.title, loading: tab.status === "loading", kept: sessions.isKept(tabId), ...(st.dialog ? { dialog: st.dialog.type } : {}) });
    }
    return { tabs };
  },

  async close_tab(sessionId, { tabId }) {
    sessions.requireOwner(sessionId, tabId);
    await cdp.detach(tabId);
    await sessions.forgetTab(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    return { closed: tabId };
  },

  async navigate(sessionId, { tabId, url, action, waitUntil = "load", timeoutMs = 20000 }) {
    const st = await tabFor(sessionId, tabId, { allowBlockedPage: true });
    const loadsBefore = st.loadCount;
    const domBefore = st.domContentCount;
    const navigationsBefore = st.navigationCount;
    const sameDocumentBefore = st.sameDocumentCount;
    if (action === "reload") {
      await send(tabId, "Page.reload", {});
    } else if (action === "back" || action === "forward") {
      const { currentIndex, entries } = await send(tabId, "Page.getNavigationHistory");
      const entry = entries[currentIndex + (action === "back" ? -1 : 1)];
      if (!entry) throw new Error(`There is no page to go ${action} to.`);
      assertAllowed(entry.url);
      await send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
    } else {
      if (!url) throw new Error("Give a url or an action (back, forward, reload).");
      assertAllowed(url);
      const response = await send(tabId, "Page.navigate", { url }, { timeoutMs });
      if (response.errorText && response.errorText !== "net::ERR_ABORTED") {
        return result(st, { error: `Navigation failed: ${response.errorText}` });
      }
      if (!response.loaderId) return result(st); // same-document navigation
    }
    if (waitUntil !== "commit") {
      const loaded = await waitFor(
        st,
        (s) =>
          s.dialog ||
          (waitUntil === "domcontentloaded" ? s.domContentCount > domBefore : s.loadCount > loadsBefore) ||
          (s.navigationCount > navigationsBefore && !s.mainLoading) ||
          s.sameDocumentCount > sameDocumentBefore,
        timeoutMs,
      );
      if (!loaded) cdp.note(st, `The page was still loading after ${timeoutMs / 1000} s; carry on or use browser_wait_for.`);
      else if (waitUntil === "networkidle") await networkIdle(st, Math.max(1000, timeoutMs / 2));
      // A single-page app changes its URL first and redraws afterwards; let it settle before the
      // result describes the page (otherwise the payment check can still see the previous step).
      else if (st.sameDocumentCount > sameDocumentBefore) await settle(st, 2000);
    }
    return result(st);
  },

  async snapshot(sessionId, { tabId, filter, rootRef, interactiveOnly, maxChars }) {
    const st = await tabFor(sessionId, tabId);
    const { text, notes } = await snapshot(st, { filter, rootRef, interactiveOnly, maxChars });
    notes.forEach((n) => cdp.note(st, n));
    return result(st, { snapshot: text });
  },

  async get_text(sessionId, { tabId, ref, selector, offset = 0, maxChars = 20000 }) {
    const st = await tabFor(sessionId, tabId);
    let read;
    if (selector && !ref) {
      // Every match, separated by "---", for lists such as result cards.
      read = await evaluate(st, page.selectorText, [selector, offset, maxChars]);
      if (!read.matches) throw new Error(`No element matches the selector ${selector}.`);
    } else {
      const node = await resolveNode(st, { ref });
      read = node ? await callOn(st, node, page.elementText, [offset, maxChars]) : await evaluate(st, page.pageText, [offset, maxChars]);
    }
    const { total, text, matches } = read;
    const next = offset + text.length < total ? offset + text.length : null;
    return result(st, { totalChars: total, offset, ...(next !== null ? { nextOffset: next } : {}), ...(matches ? { matches } : {}), text });
  },

  async screenshot(sessionId, { tabId, ref, selector, fullPage = false, format = "jpeg", quality = 75 }) {
    const st = await tabFor(sessionId, tabId, { allowDialog: true });
    // Page.getLayoutMetrics works while a dialog blocks page scripts; Runtime.evaluate doesn't.
    const { cssVisualViewport: viewport, visualViewport: deviceViewport, cssContentSize: content } = await send(tabId, "Page.getLayoutMetrics");
    const ratio = deviceViewport.clientWidth / viewport.clientWidth || 1;
    let clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight };
    let beyondViewport = false;
    const node = await resolveNode(st, { ref, selector });
    if (node) {
      await scrollNodeIntoView(st, node);
      const box = await nodeBox(st, node);
      const metrics = (await send(tabId, "Page.getLayoutMetrics")).cssVisualViewport;
      clip = { x: metrics.pageX + box.x - 8, y: metrics.pageY + box.y - 8, width: box.width + 16, height: box.height + 16 };
      beyondViewport = box.height + 16 > metrics.clientHeight; // the element is scrolled into view
    } else if (fullPage) {
      clip = { x: 0, y: 0, width: content.width, height: Math.min(content.height, 7900) };
      beyondViewport = true;
    }
    // Capture in CSS pixels: half the size of a Retina capture, and plenty for reading.
    const { data } = await send(
      tabId,
      "Page.captureScreenshot",
      { format, ...(format === "jpeg" ? { quality } : {}), clip: { ...clip, scale: node ? 1 : 1 / ratio } /* element clips with a scale below 1 come back magnified, so they stay at device resolution */, captureBeyondViewport: beyondViewport, fromSurface: true },
      { timeoutMs: 30000 },
    );
    const tab = await chrome.tabs.get(tabId);
    return { data, mimeType: `image/${format}`, width: Math.round(clip.width), height: Math.round(clip.height), url: cdp.shortUrl(tab.url), title: tab.title, notes: takeNotes(st) };
  },

  async click(sessionId, { tabId, ref, selector, text, exact, x, y, button = "left", doubleClick = false, modifiers = [], force = false, allowPayment = false }) {
    const st = await tabFor(sessionId, tabId);
    await guardPayment(st, allowPayment);
    const { point, node, box } = await targetPoint(st, { ref, selector, text, exact, x, y });
    if (node && !force) {
      const blocker = await coveredBy(st, node, point);
      if (blocker) {
        throw new Error(`The element is covered by an overlay, ${blocker}, at its centre. Close the overlay (for a cookie banner, browser_handle_cookie_banner), scroll, or pass force: true to click it anyway.`);
      }
    }
    const clicked = node ? await callOn(st, node, page.describeElement).catch(() => undefined) : `point ${Math.round(point.x)},${Math.round(point.y)}`;
    if (text && !ref && !selector) {
      const count = await evaluate(st, page.countTextMatches, [text, exact ?? false]).catch(() => 1);
      if (count > 1) cdp.note(st, `${count} visible elements match the text "${text}"; clicked the best match. Use a ref from browser_snapshot to pick a specific one.`);
    }
    const navigationsBefore = st.navigationCount;
    st.fileChooser = null;
    await showCursor(st, point, true);
    // Measure again after the cursor's glide: the page may have shifted in the meantime.
    const again = node ? await targetPoint(st, { node }) : { point };
    const target = again.point;
    if (target.x !== point.x || target.y !== point.y) await showCursor(st, target, false);
    await raceDialog(st, mouseClick(tabId, target.x, target.y, { button, clickCount: doubleClick ? 2 : 1, modifiers: modifierBits(modifiers) }));
    await settle(st);
    if (st.fileChooser) cdp.note(st, "The click opened a file chooser; use browser_upload with the same element to choose files.");
    return result(st, { clicked, ...(st.navigationCount > navigationsBefore ? { navigated: true } : {}) });
  },

  async hover(sessionId, { tabId, ref, selector, text, exact, x, y }) {
    const st = await tabFor(sessionId, tabId);
    const { point, box } = await targetPoint(st, { ref, selector, text, exact, x, y });
    await showCursor(st, point, false);
    await raceDialog(st, mouseMove(tabId, point.x, point.y));
    await settle(st, 1000);
    return result(st);
  },

  async type(sessionId, { tabId, ref, selector, text, clear = true, slowly = false, submit = false, allowPayment = false }) {
    const st = await tabFor(sessionId, tabId);
    await guardPayment(st, allowPayment);
    const node = await resolveNode(st, { ref, selector });
    if (node) await focusNode(st, node, clear);
    else if (clear) await pressCombo(tabId, "Meta+a");
    if (text === "" && clear) await raceDialog(st, pressCombo(tabId, "Backspace"));
    else if (slowly) await raceDialog(st, typeSlowly(tabId, text));
    else await raceDialog(st, insertText(tabId, text));
    if (submit && !st.dialog) await raceDialog(st, pressCombo(tabId, "Enter"));
    await settle(st, submit ? 8000 : 1500);
    const value = node && !st.dialog ? await callOn(st, node, page.currentValue).catch(() => undefined) : undefined;
    return result(st, value !== undefined ? { value: value.slice(0, 500) } : {});
  },

  async fill(sessionId, { tabId, fields, allowPayment = false }) {
    const st = await tabFor(sessionId, tabId);
    await guardPayment(st, allowPayment);
    const filled = [];
    for (const field of fields) {
      const node = await resolveNode(st, field);
      if (!node) throw new Error("Each field needs a ref or selector.");
      const kind = await callOn(st, node, page.elementKind);
      const name = field.ref ?? field.selector;
      if (kind.tag === "select") {
        const aim = await targetPoint(st, { node });
        await showCursor(st, aim.point, true);
        const values = Array.isArray(field.value) ? field.value.map(String) : [String(field.value)];
        filled.push({ field: name, selected: await callOn(st, node, page.selectOptions, [values]) });
      } else if (kind.type === "checkbox" || kind.type === "radio" || kind.role === "checkbox" || kind.role === "switch" || kind.role === "radio") {
        const wanted = field.value === true || field.value === "true";
        if (kind.checked !== wanted) {
          const aim = await targetPoint(st, { node });
          await showCursor(st, aim.point, true);
          const { point } = await targetPoint(st, { node }); // measured again after the glide
          await raceDialog(st, mouseClick(tabId, point.x, point.y));
        }
        filled.push({ field: name, checked: (await callOn(st, node, page.elementKind)).checked });
      } else {
        await focusNode(st, node, true);
        const value = String(field.value ?? "");
        await raceDialog(st, value === "" ? pressCombo(tabId, "Backspace") : insertText(tabId, value));
        filled.push({ field: name, value: (await callOn(st, node, page.currentValue)).slice(0, 200) });
      }
      if (st.dialog) break;
    }
    await settle(st, 1500);
    return result(st, { filled });
  },

  async select(sessionId, { tabId, ref, selector, values, allowPayment = false }) {
    const st = await tabFor(sessionId, tabId);
    await guardPayment(st, allowPayment);
    const node = await resolveNode(st, { ref, selector });
    if (!node) throw new Error("Give the <select> element's ref or selector.");
    const selected = await callOn(st, node, page.selectOptions, [values]);
    await settle(st, 1500);
    return result(st, { selected });
  },

  async press(sessionId, { tabId, key, repeat = 1, ref, selector, allowPayment = false }) {
    const st = await tabFor(sessionId, tabId);
    await guardPayment(st, allowPayment);
    const node = await resolveNode(st, { ref, selector });
    if (node) await focusNode(st, node, false);
    for (let i = 0; i < Math.min(repeat, 50) && !st.dialog; i++) await raceDialog(st, pressCombo(tabId, key));
    await settle(st, 3000);
    return result(st);
  },

  async scroll(sessionId, { tabId, ref, selector, text, direction, amount, to }) {
    const st = await tabFor(sessionId, tabId);
    const node = await resolveNode(st, { ref, selector, text });
    const before = await evaluate(st, page.scrollPosition);
    if (to === "top" || to === "bottom") {
      await evaluate(st, page.scrollPage, [to, 0, 0]);
    } else if (direction) {
      const distance = amount ?? Math.round(before.viewportHeight * 0.8);
      const dx = direction === "left" ? -distance : direction === "right" ? distance : 0;
      const dy = direction === "up" ? -distance : direction === "down" ? distance : 0;
      const { point } = node ? await targetPoint(st, { node }) : { point: { x: 200, y: Math.round(before.viewportHeight / 2) } };
      await mouseWheel(tabId, point.x, point.y, dx, dy);
      await sleep(250);
      const after = await evaluate(st, page.scrollPosition);
      // Wheel events can be ignored in hidden tabs; fall back to scrolling from script.
      if (!node && after.scrollY === before.scrollY && after.scrollX === before.scrollX) await evaluate(st, page.scrollPage, ["", dx, dy]);
      if (node && after.scrollY === before.scrollY) await callOn(st, node, page.scrollElementBy, [dx, dy]);
    } else if (node) {
      await callOn(st, node, page.scrollIntoViewCentre);
    } else {
      throw new Error("Give a ref or selector to scroll to, a direction, or to: top/bottom.");
    }
    await settle(st, 1500);
    return result(st, { position: await evaluate(st, page.scrollPosition) });
  },

  async drag(sessionId, { tabId, from, to, allowPayment = false }) {
    const st = await tabFor(sessionId, tabId);
    await guardPayment(st, allowPayment);
    const start = (await targetPoint(st, from)).point;
    const end = (await targetPoint(st, to)).point;
    st.drag = null;
    await send(tabId, "Input.setInterceptDrags", { enabled: true }).catch(() => {});
    try {
      await mouseMove(tabId, start.x, start.y);
      await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1 });
      for (let step = 1; step <= 10; step++) {
        const x = start.x + ((end.x - start.x) * step) / 10;
        const y = start.y + ((end.y - start.y) * step) / 10;
        await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      }
      // An HTML5 drag (draggable=true) is intercepted by CDP and has to be dropped explicitly.
      const data = await waitFor(st, (s) => s.drag, 300);
      if (data) {
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await send(tabId, "Input.dispatchDragEvent", { type, x: end.x, y: end.y, data });
        }
      }
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1 });
    } finally {
      await send(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
    }
    await settle(st, 1500);
    return result(st);
  },

  async wait_for(sessionId, { tabId, text, textGone, selector, state = "visible", url, networkIdle: idle, timeMs, timeoutMs = 15000 }) {
    const st = await tabFor(sessionId, tabId);
    const started = Date.now();
    if (timeMs) await sleep(Math.min(timeMs, 30000));
    const deadline = Date.now() + Math.min(timeoutMs, 60000);
    const urlMatcher = url && /^\/.+\/[a-z]*$/.test(url) ? new RegExp(url.slice(1, url.lastIndexOf("/")), url.slice(url.lastIndexOf("/") + 1)) : null;
    const unmet = async () => {
      const failed = [];
      if (url) {
        const current = (await chrome.tabs.get(tabId)).url ?? "";
        if (urlMatcher ? !urlMatcher.test(current) : !current.includes(url)) failed.push("url");
      }
      if (text && !(await evaluate(st, page.textPresent, [text]).catch(() => false))) failed.push("text");
      if (textGone && (await evaluate(st, page.textPresent, [textGone]).catch(() => true))) failed.push("textGone");
      if (selector && !(await evaluate(st, page.selectorState, [selector, state]).catch(() => false))) failed.push("selector");
      if (idle && (st.mainLoading || activeRequests(st) > 0 || Date.now() - st.lastNetworkAt < 500)) failed.push("networkIdle");
      return failed;
    };
    let failed = await unmet();
    while (failed.length && Date.now() < deadline && !st.dialog) {
      await sleep(300);
      failed = await unmet();
    }
    return result(st, { matched: failed.length === 0, waitedMs: Date.now() - started, ...(failed.length ? { unmet: failed } : {}) });
  },

  async evaluate(sessionId, { tabId, expression, ref, selector, allowSecrets = false }) {
    const st = await tabFor(sessionId, tabId);
    if (!allowSecrets && EVALUATE_SECRET_PATTERN.test(expression)) {
      throw new Error("agent-tabs does not let agents read cookies or browser storage.");
    }
    const node = await resolveNode(st, { ref, selector });
    let response;
    if (node) {
      const { object } = await send(tabId, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId });
      response = await send(
        tabId,
        "Runtime.callFunctionOn",
        { functionDeclaration: `function () { return (${expression})(this); }`, objectId: object.objectId, returnByValue: true, awaitPromise: true },
        { sessionId: node.sessionId },
      );
    } else {
      response = await send(tabId, "Runtime.evaluate", { expression, awaitPromise: true, replMode: true });
      // replMode doesn't await a promise the expression evaluates to; do that, then take its value.
      const remote = response.result;
      if (!response.exceptionDetails && remote?.objectId) {
        response = await send(tabId, "Runtime.callFunctionOn", { functionDeclaration: "async function () { return await this; }", objectId: remote.objectId, returnByValue: true, awaitPromise: true });
        send(tabId, "Runtime.releaseObject", { objectId: remote.objectId }).catch(() => {});
      }
    }
    if (response.exceptionDetails) throw new Error(`Page script threw: ${exceptionText(response.exceptionDetails)}`);
    const value = response.result.value !== undefined ? response.result.value : response.result.description ?? response.result.type;
    let json = JSON.stringify(value) ?? "undefined";
    if (json.length > 20000) json = json.slice(0, 20000) + `… (${json.length} chars)`;
    return result(st, { result: json });
  },

  async dialog(sessionId, { tabId, action = "status", promptText }) {
    const st = await tabFor(sessionId, tabId, { allowDialog: true, allowBlockedPage: true });
    const dialog = st.dialog;
    if (action === "status" || !dialog) return result(st, { dialog: dialog ? publicDialog(dialog) : null });
    await send(tabId, "Page.handleJavaScriptDialog", { accept: action === "accept", ...(promptText !== undefined ? { promptText } : {}) }, { sessionId: dialog.sessionId });
    st.dialog = null;
    await settle(st, 2000);
    return result(st, { handled: { ...publicDialog(dialog), action } });
  },

  async upload(sessionId, { tabId, ref, selector, paths }) {
    const st = await tabFor(sessionId, tabId);
    const node = await resolveNode(st, { ref, selector });
    if (!node) throw new Error("Give the ref or selector of the file input or upload button.");
    const kind = await callOn(st, node, page.elementKind);
    if (kind.tag === "input" && kind.type === "file") {
      await send(tabId, "DOM.setFileInputFiles", { files: paths, backendNodeId: node.backendNodeId }, { sessionId: node.sessionId });
    } else {
      const chooserOpen = st.fileChooser && Date.now() - st.fileChooser.openedAt < 60000;
      if (!chooserOpen) {
        st.fileChooser = null;
        const { point } = await targetPoint(st, { ref, selector });
        await raceDialog(st, mouseClick(tabId, point.x, point.y));
      }
      const chooser = await waitFor(st, (s) => s.fileChooser, 5000);
      if (!chooser) throw new Error("That element did not open a file chooser. Find the <input type=file> in a snapshot and use its ref.");
      await send(tabId, "DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId }, { sessionId: chooser.sessionId });
      st.fileChooser = null;
    }
    await settle(st, 2000);
    return result(st, { uploaded: paths.map((p) => p.split("/").pop()) });
  },

  async downloads(sessionId, { tabId }) {
    const tabIds = tabId ? [tabId] : sessions.ownedTabIds(sessionId);
    if (tabId) sessions.requireOwner(sessionId, tabId);
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
    const list = [];
    for (const id of tabIds) {
      for (const download of cdp.state(id).downloads) {
        const item = items.find((i) => i.url === download.url || i.finalUrl === download.url);
        list.push({
          tabId: id,
          file: download.suggestedFilename,
          state: item?.state ?? download.state,
          bytes: item?.bytesReceived ?? download.receivedBytes,
          path: item?.filename || undefined,
          source: withoutQuery(download.url),
        });
      }
    }
    return { downloads: list };
  },

  async console(sessionId, { tabId, level, limit = 50 }) {
    const st = await tabFor(sessionId, tabId, { allowDialog: true });
    const entries = st.console.filter((e) => !level || e.level === level).slice(-Math.min(limit, 200));
    return { tabId, entries };
  },

  async handle_cookie_banner(sessionId, { tabId, choice = "reject" }) {
    const st = await tabFor(sessionId, tabId);
    // The banner can be in the page or in an iframe.
    for (const frame of cdp.frameTargets(st)) {
      const frameSession = frame.sessionId;
      const remote = await evaluate(st, page.findConsentButton, [choice], { ...frame, returnByValue: false }).catch(() => null);
      const node = await nodeFromRemote(st, frameSession, remote);
      if (!node) continue;
      const label = await callOn(st, node, page.shortLabel).catch(() => "");
      const { point } = await targetPoint(st, { node });
      await raceDialog(st, mouseClick(tabId, point.x, point.y));
      await settle(st, 3000);
      return result(st, { clicked: label || "(button)", inIframe: Boolean(frameSession) });
    }
    return result(st, { clicked: null, message: `No cookie banner with a ${choice} button was found; most likely the page has no banner (or it was already answered). Carry on.` });
  },

  async fill_login(sessionId, { tabId, values }) {
    const st = await tabFor(sessionId, tabId);
    const tab = await chrome.tabs.get(tabId);
    const siteDomain = baseDomain(new URL(tab.url).hostname);
    // First choice: type with real key presses, which sites like Apple's sign-in expect. Fields
    // are found and tagged in whichever frame holds them (page or same-site iframe), then focused
    // and typed into. If that fails (e.g. a password manager menu opens and Chrome detaches us),
    // values are set without focus instead.
    let typed = [];
    let fallbackReason = "";
    try {
      typed = await typeCredentials(st, values, siteDomain);
    } catch (error) {
      fallbackReason = error.message;
      await ensureAttached(tabId);
    } finally {
      for (const frame of cdp.frameTargets(st)) await evaluate(st, page.clearFillMarkers, [], frame).catch(() => {});
    }
    const filled = new Set(typed);
    const frameErrors = new Set();
    if (!filled.size) {
      // Right after a re-attach, iframe sessions take a moment to come back, so try a few times.
      for (let attempt = 0; attempt < 4 && !filled.size; attempt++) {
        if (attempt) await sleep(700);
        for (const frame of cdp.frameTargets(st)) {
          const kinds = await evaluate(st, page.fillCredentialFields, [values, siteDomain, false], frame).catch((error) => {
            frameErrors.add(error.message.slice(0, 120));
            return [];
          });
          kinds.forEach((kind) => filled.add(kind));
        }
      }
      if (filled.size && fallbackReason) {
        cdp.note(st, `Filled without typing (typing failed: ${fallbackReason.slice(0, 160)}). Some sites reject values that weren't typed.`);
      }
    }
    if (!filled.size) {
      const detail = frameErrors.size ? ` (frame errors: ${[...frameErrors].join("; ")})` : "";
      throw new Error(`No visible sign-in fields on this page${detail}. Open the sign-in form first (for two-step sign-ins, the field for the current step must be showing).`);
    }
    await settle(st, 1500);
    return result(st, { filled: [...filled], ...(typed.length ? { typed: true } : {}) });
  },

  // Several steps in one call, in order, stopping at the first failure.
  async batch(sessionId, { tabId, steps }) {
    const ACTIONS = ["navigate", "click", "type", "fill", "select", "press", "hover", "scroll", "drag", "wait_for", "handle_cookie_banner", "get_text", "snapshot"];
    const done = [];
    for (const [index, step] of steps.entries()) {
      const { action, ...args } = step;
      if (!ACTIONS.includes(action)) throw new Error(`Step ${index + 1}: unknown action "${action}". Use one of ${ACTIONS.join(", ")}.`);
      try {
        const outcome = await ops[action](sessionId, { ...args, tabId });
        const { clicked, value, matched, selected, filled, navigated, notes, text, snapshot: tree } = outcome ?? {};
        const read = text ?? tree;
        done.push({ step: index + 1, action, ok: true, ...(read !== undefined ? { text: read.length > 8000 ? read.slice(0, 8000) + "…" : read } : {}), ...(clicked ? { clicked } : {}), ...(value !== undefined ? { value } : {}), ...(matched !== undefined ? { matched } : {}), ...(selected ? { selected } : {}), ...(filled ? { filled } : {}), ...(navigated ? { navigated } : {}), ...(notes?.length ? { notes } : {}) });
        if (matched === false) break; // a wait that timed out: later steps would act on the wrong page
      } catch (error) {
        done.push({ step: index + 1, action, ok: false, error: error.message });
        break;
      }
    }
    const st = cdp.state(tabId);
    return result(st, { steps: done, completed: done.filter((s) => s.ok).length, of: steps.length });
  },

  // Hands a step to the user (2-step code, CAPTCHA, approval): keeps the tab open even if the agent's
  // session ends. The agent then asks the user and waits for the page to move on.
  async handoff(sessionId, { tabId, reason, done = false }) {
    const st = await tabFor(sessionId, tabId, { allowDialog: true, allowBlockedPage: true });
    await sessions.setKept(tabId, !done);
    const group = sessions.groupTitleFor(tabId);
    return result(st, done ? { handoff: "ended" } : { handoff: "waiting", tellUser: `Open the "${group}" tab group in Chrome and ${reason}` });
  },

  // The only operation that changes focus: for when the user asks to see a page.
  async show(sessionId, { tabId }) {
    sessions.requireOwner(sessionId, tabId);
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await sessions.setKept(tabId, true);
    return { tabId, shown: true, kept: true, note: "The tab is now in front and will stay open after this agent finishes." };
  },

  async keep(sessionId, { tabId, keep = true }) {
    sessions.requireOwner(sessionId, tabId);
    await sessions.setKept(tabId, keep);
    return { tabId, kept: keep };
  },

  // Admin (npm run cleanup-tabs): closes tabs in agent tab groups that no live agent owns, such as
  // kept tabs and tabs left behind by crashes. Tabs a live agent owns are left alone.
  async cleanup_tabs() {
    const groups = await chrome.tabGroups.query({});
    const agentGroups = new Set(groups.filter((group) => /^agent\b/.test(group.title ?? "")).map((group) => group.id));
    const tabs = (await chrome.tabs.query({})).filter((tab) => agentGroups.has(tab.groupId));
    const closing = tabs.filter((tab) => !sessions.ownerOf(tab.id)).map((tab) => tab.id);
    if (closing.length) await chrome.tabs.remove(closing);
    for (const tabId of closing) {
      cdp.dropState(tabId);
      await sessions.forgetTab(tabId);
    }
    return { closed: closing.length, stillOwned: tabs.length - closing.length };
  },

  async end_session(sessionId) {
    const { closed, kept } = await sessions.endSession(sessionId, (tabId) => cdp.detach(tabId));
    closed.forEach((tabId) => cdp.dropState(tabId));
    return { closed, kept };
  },
};

// ---------- helpers ----------

function assertAllowed(url) {
  const reason = blockedReason(url);
  if (reason) throw new Error(`Blocked: ${reason}.`);
}

async function tabFor(sessionId, tabId, { allowDialog = false, allowBlockedPage = false } = {}) {
  sessions.requireOwner(sessionId, tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    await sessions.forgetTab(tabId);
    throw new Error(`Tab ${tabId} has been closed.`);
  }
  const st = await ensureAttached(tabId);
  if (!allowDialog && st.dialog) {
    throw new Error(`Tab ${tabId} has an open ${st.dialog.type} dialog ("${st.dialog.message}"). Accept or dismiss it with browser_dialog first.`);
  }
  if (!allowBlockedPage && tab.url) {
    const reason = blockedReason(tab.url);
    if (reason) throw new Error(`This tab shows a blocked page: ${reason}.`);
  }
  return st;
}

async function result(st, extra = {}) {
  const tab = await chrome.tabs.get(st.tabId).catch(() => null);
  if (tab?.url && tab.url !== st.paymentNotedFor && !st.dialog) {
    const signals = await paymentCheck(st);
    if (signals.length) {
      st.paymentNotedFor = tab.url;
      cdp.note(st, `This is a checkout or payment page (${signals.join(", ")}). Nothing has been paid. Don't enter payment details or confirm anything unless the user explicitly asked for this purchase.`);
    }
  }
  const notes = takeNotes(st);
  return {
    tabId: st.tabId,
    url: cdp.shortUrl(tab?.url || tab?.pendingUrl),
    title: tab?.title,
    ...extra,
    ...(st.dialog ? { dialog: publicDialog(st.dialog) } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function publicDialog(dialog) {
  return { type: dialog.type, message: dialog.message, ...(dialog.defaultPrompt ? { defaultPrompt: dialog.defaultPrompt } : {}) };
}

// Payment guard: on a page that takes payment, reading and navigating are fine, but acting
// (click, type, fill, select, press, drag) needs allowPayment, which agents may only pass when
// the user explicitly asked for that purchase. Card fields or a payment provider's frame count on
// their own; otherwise two of: a checkout-style URL, a pay button, payment method choices.
async function paymentCheck(st) {
  if (!policyFlags.paymentGuard) return [];
  const signals = await evaluate(st, page.paymentSignals).catch(() => []);
  const supporting = ["checkout URL", "pay button", "payment methods"].filter((s) => signals.includes(s)).length;
  const strong = signals.includes("card fields") || signals.includes("payment provider frame") || supporting >= 2;
  return strong ? signals : [];
}

async function guardPayment(st, allowPayment) {
  if (allowPayment) return;
  const signals = await paymentCheck(st);
  if (signals.length) {
    throw new Error(`This looks like a checkout or payment page (${signals.join(", ")}). You can read it, take screenshots or navigate away, but clicking or typing here needs allowPayment: true, which you may only pass if the user explicitly asked you to make this purchase or payment.`);
  }
}

// Moves the visible agent cursor to a point (main-frame viewport coordinates). It only animates,
// and so only costs time, when the tab is in front where someone can watch it.
async function showCursor(st, point, clicking = false) {
  const tab = await chrome.tabs.get(st.tabId).catch(() => null);
  const watched = Boolean(tab?.active);
  const duration = watched ? 260 : 0;
  const { style, label } = sessions.cursorFor(st.tabId);
  st.cursor = { x: point.x, y: point.y, label, style };
  await evaluate(st, page.moveAgentCursor, [point.x, point.y, clicking, duration, label, style]).catch(() => {});
  if (watched) await sleep(duration);
}

// Waits briefly for whatever an action started: a navigation, or requests it triggered.
async function settle(st, maxMs = 5000) {
  await sleep(150);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && !st.dialog) {
    const quietFor = Date.now() - st.lastNetworkAt;
    if (st.popupsOpening === 0 && !st.mainLoading && ((activeRequests(st) === 0 && quietFor >= 250) || quietFor >= 1500)) return;
    await sleep(100);
  }
}

async function networkIdle(st, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && !st.dialog) {
    if (!st.mainLoading && activeRequests(st) === 0 && Date.now() - st.lastNetworkAt >= 500) return;
    await sleep(100);
  }
}

async function evaluate(st, fn, args = [], { sessionId, contextId, returnByValue = true } = {}) {
  const response = await send(
    st.tabId,
    "Runtime.evaluate",
    { expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue, awaitPromise: true, ...(contextId ? { contextId } : {}) },
    { sessionId },
  );
  if (response.exceptionDetails) throw new Error(exceptionText(response.exceptionDetails));
  return returnByValue ? response.result.value : response.result;
}

// Calls fn with the node as `this`.
async function callOn(st, node, fn, args = []) {
  const { object } = await send(st.tabId, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId }).catch(() => {
    throw new Error("That element is no longer in the page; take a new snapshot.");
  });
  try {
    const response = await send(
      st.tabId,
      "Runtime.callFunctionOn",
      { functionDeclaration: fn.toString().replace(/^(async\s+)?(\w+)\s*\(/, "$1function $2("), objectId: object.objectId, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
      { sessionId: node.sessionId },
    );
    if (response.exceptionDetails) throw new Error(exceptionText(response.exceptionDetails));
    return response.result.value;
  } finally {
    send(st.tabId, "Runtime.releaseObject", { objectId: object.objectId }, { sessionId: node.sessionId }).catch(() => {});
  }
}

async function nodeFromRemote(st, sessionId, remote) {
  if (!remote?.objectId || remote.subtype === "null") return null;
  try {
    const { node } = await send(st.tabId, "DOM.describeNode", { objectId: remote.objectId }, { sessionId });
    return { sessionId, backendNodeId: node.backendNodeId };
  } finally {
    send(st.tabId, "Runtime.releaseObject", { objectId: remote.objectId }, { sessionId }).catch(() => {});
  }
}

async function resolveNode(st, { ref, selector, text, exact = false, node }) {
  if (node) return node;
  if (ref) {
    const found = st.refs.get(ref);
    if (!found) throw new Error(`Unknown ref ${ref}. Refs come from browser_snapshot and reset when the page navigates; take a new snapshot.`);
    return found;
  }
  if (selector) {
    const found = await findInFrames(st, page.deepQuerySelector, [selector]);
    if (!found) throw new Error(`No element matches the selector ${selector}.`);
    return found;
  }
  if (text) {
    const found = await findInFrames(st, page.findByText, [text, exact]);
    if (!found) throw new Error(`No visible element with the text "${text}".`);
    return found;
  }
  return null;
}

// The first frame (main frame first) where fn returns an element.
async function findInFrames(st, fn, args) {
  for (const frame of cdp.frameTargets(st)) {
    const remote = await evaluate(st, fn, args, { ...frame, returnByValue: false }).catch(() => null);
    const node = await nodeFromRemote(st, frame.sessionId, remote).catch(() => null);
    if (node) return node;
  }
  return null;
}

async function targetPoint(st, target) {
  const ways = ["ref", "selector", "text"].filter((key) => target[key] !== undefined && target[key] !== "");
  if (ways.length > 1 || (ways.length && (target.x !== undefined || target.y !== undefined))) {
    throw new Error(`Give exactly one target: ref, selector, text, or x and y (got ${[...ways, ...(target.x !== undefined ? ["x/y"] : [])].join(" + ")}).`);
  }
  let node = await resolveNode(st, target);
  if (!node) {
    if (typeof target.x === "number" && typeof target.y === "number") return { point: { x: target.x, y: target.y }, node: null };
    throw new Error("Give a ref, selector, text, or x and y.");
  }
  await scrollNodeIntoView(st, node);
  let box;
  try {
    box = await nodeBox(st, node);
  } catch (error) {
    // Visually hidden inputs (custom checkboxes, radios, file inputs) are clicked through their
    // label or nearest visible ancestor, as a person would.
    const proxy = await visibleProxy(st, node);
    if (!proxy) throw error;
    node = proxy;
    await scrollNodeIntoView(st, node);
    box = await nodeBox(st, node);
  }
  // Aim at the centre of the part of the element that is inside the viewport.
  const { cssLayoutViewport: viewport } = await send(st.tabId, "Page.getLayoutMetrics");
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, viewport.clientWidth);
  const bottom = Math.min(box.y + box.height, viewport.clientHeight);
  if (right <= left || bottom <= top) throw new Error("The element is outside the visible area and could not be scrolled into view.");
  return { point: { x: (left + right) / 2, y: (top + bottom) / 2 }, node, box };
}

async function visibleProxy(st, node) {
  const { object } = await send(st.tabId, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId }).catch(() => ({}));
  if (!object) return null;
  try {
    const response = await send(
      st.tabId,
      "Runtime.callFunctionOn",
      { functionDeclaration: page.visibleProxy.toString(), objectId: object.objectId, returnByValue: false },
      { sessionId: node.sessionId },
    );
    return await nodeFromRemote(st, node.sessionId, response.result);
  } finally {
    send(st.tabId, "Runtime.releaseObject", { objectId: object.objectId }, { sessionId: node.sessionId }).catch(() => {});
  }
}

async function scrollNodeIntoView(st, node) {
  await send(st.tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId }).catch(() =>
    callOn(st, node, page.scrollIntoViewCentre).catch(() => {}),
  );
}

// The element's bounding box in main-frame viewport coordinates (CSS pixels).
async function nodeBox(st, node) {
  let quads;
  try {
    ({ quads } = await send(st.tabId, "DOM.getContentQuads", { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId }));
  } catch {
    throw new Error("That element is no longer in the page; take a new snapshot.");
  }
  const quad = quads?.find((q) => Math.abs((q[4] - q[0]) * (q[5] - q[1])) > 1);
  if (!quad) throw new Error("That element is not visible (no size on the page).");
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const offset = node.sessionId ? await frameOffset(st, node.sessionId) : { x: 0, y: 0 };
  return { x: Math.min(...xs) + offset.x, y: Math.min(...ys) + offset.y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// Where a cross-origin iframe's viewport starts, in main-frame viewport coordinates.
async function frameOffset(st, sessionId, depth = 0) {
  const info = st.children.get(sessionId);
  if (!info || depth > 5) throw new Error("That element's frame is gone; take a new snapshot.");
  for (const owner of [undefined, ...st.children.keys()]) {
    if (owner === sessionId) continue;
    try {
      const { backendNodeId } = await send(st.tabId, "DOM.getFrameOwner", { frameId: info.frameId }, { sessionId: owner });
      const { model } = await send(st.tabId, "DOM.getBoxModel", { backendNodeId }, { sessionId: owner });
      const parent = owner ? await frameOffset(st, owner, depth + 1) : { x: 0, y: 0 };
      return { x: model.content[0] + parent.x, y: model.content[1] + parent.y };
    } catch {
      // Not owned by this session; try the next one.
    }
  }
  throw new Error("Could not find the iframe that contains that element.");
}

// What a click at `point` would actually hit, if not the node. Only checked in the main frame.
async function coveredBy(st, node, point) {
  if (node.sessionId) return null;
  let hit;
  try {
    hit = await send(st.tabId, "DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true });
  } catch {
    return null;
  }
  if (!hit?.backendNodeId || hit.backendNodeId === node.backendNodeId) return null;
  const [{ object: target }, { object: hitObject }] = await Promise.all([
    send(st.tabId, "DOM.resolveNode", { backendNodeId: node.backendNodeId }),
    send(st.tabId, "DOM.resolveNode", { backendNodeId: hit.backendNodeId }),
  ]);
  try {
    const response = await send(st.tabId, "Runtime.callFunctionOn", {
      functionDeclaration: page.coveringElement.toString().replace(/^function coveringElement/, "function"),
      objectId: target.objectId,
      arguments: [{ objectId: hitObject.objectId }],
      returnByValue: true,
    });
    return response.result?.value ?? null;
  } catch {
    return null; // e.g. the hit is in another frame's JavaScript world; can't compare, so don't block
  } finally {
    send(st.tabId, "Runtime.releaseObject", { objectId: target.objectId }).catch(() => {});
    send(st.tabId, "Runtime.releaseObject", { objectId: hitObject.objectId }).catch(() => {});
  }
}

async function focusNode(st, node, selectAll) {
  await scrollNodeIntoView(st, node);
  const box = await nodeBox(st, node).catch(() => null);
  if (box) await showCursor(st, { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 }, true);
  await send(st.tabId, "DOM.focus", { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId }).catch(() => {});
  if (await callOn(st, node, page.focusAndSelect, [selectAll])) return;
  // Not focusable directly (custom widget): click it, then try again.
  const { point } = await targetPoint(st, { node });
  await raceDialog(st, mouseClick(st.tabId, point.x, point.y));
  if (!(await callOn(st, node, page.focusAndSelect, [selectAll])) && selectAll) await pressCombo(st.tabId, "Meta+a");
}

// Tags sign-in fields, then types each value into its field with real key events. Returns the
// kinds typed. Multi-box one-time codes are set directly by the page function (no tag). If a
// password manager's menu still opens and Chrome detaches us mid-way, recover and retype.
async function typeCredentials(st, values, siteDomain) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await typeCredentialsOnce(st, values, siteDomain);
    } catch (error) {
      if (attempt >= 3) throw error;
      await ensureAttached(st.tabId); // closes the menu if one is open
      await sleep(500);
    }
  }
}

// While credentials are typed, the page must not look focused: password managers open their
// menu for a focused field only when document.hasFocus() is true, which focus emulation makes so.
async function setFocusEmulation(st, enabled) {
  for (const sessionId of [undefined, ...st.children.keys()]) {
    await send(st.tabId, "Emulation.setFocusEmulationEnabled", { enabled }, { sessionId }).catch(() => {});
  }
}

async function typeCredentialsOnce(st, values, siteDomain) {
  await setFocusEmulation(st, false);
  try {
    return await typeIntoMarkedFields(st, values, siteDomain);
  } finally {
    // Leave no login field focused, or turning focus emulation back on fires a focus event that
    // password managers answer with their menu.
    for (const frame of cdp.frameTargets(st)) await evaluate(st, () => document.activeElement?.blur?.(), [], frame).catch(() => {});
    await setFocusEmulation(st, true);
  }
}

async function typeIntoMarkedFields(st, values, siteDomain) {
  const typed = [];
  for (const frame of cdp.frameTargets(st)) {
    const kinds = await evaluate(st, page.fillCredentialFields, [values, siteDomain, true], frame).catch(() => []);
    for (const kind of kinds) {
      const remote = await evaluate(st, page.deepQuerySelector, [`[data-agent-tabs-fill="${kind}"]`], { ...frame, returnByValue: false }).catch(() => null);
      const node = await nodeFromRemote(st, frame.sessionId, remote);
      if (!node) {
        typed.push(kind); // set directly by the page function (multi-box code)
        continue;
      }
      // Quiet mode keeps password managers' menus (which would lock us out) from opening.
      await evaluate(st, () => (globalThis[Symbol.for("agent-tabs-quiet")] = true), [], frame);
      try {
        await send(st.tabId, "DOM.focus", { backendNodeId: node.backendNodeId }, { sessionId: node.sessionId });
        await callOn(st, node, page.focusAndSelect, [true]);
        await typeSlowly(st.tabId, values[kind], 15);
      } finally {
        await evaluate(st, () => (globalThis[Symbol.for("agent-tabs-quiet")] = false), [], frame).catch(() => {});
      }
      if ((await callOn(st, node, page.valueLength)) !== values[kind].length) throw new Error(`typing into the ${kind} field didn't stick`);
      typed.push(kind);
    }
    if (typed.length) break;
  }
  return typed;
}

// example.co.uk -> example.co.uk, signin.example.com -> example.com
function baseDomain(host) {
  const parts = host.split(".");
  const twoLevel = parts.length > 2 && parts.at(-1).length === 2 && ["co", "com", "gov", "ac", "org", "net", "ltd", "plc"].includes(parts.at(-2));
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

function exceptionText(details) {
  return (details.exception?.description ?? details.text ?? "unknown error").split("\n")[0].slice(0, 300);
}

function withoutQuery(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "data:" ? "data: URL" : parsed.origin + parsed.pathname;
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
