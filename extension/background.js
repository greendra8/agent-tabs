// Agent Tabs service worker: connects to the local broker and runs the operations it sends.
//
// The broker (broker/server.mjs) serves MCP to Claude agents; each agent's MCP
// session id arrives with every operation, and decides which tabs it may touch.

import * as cdp from "./cdp.js";
import * as sessions from "./sessions.js";
import { setPolicy } from "./policy.js";
import { ops } from "./ops.js";

const BROKER_URL = "ws://127.0.0.1:47615/extension";
const VERSION = chrome.runtime.getManifest().version;

let socket = null;
let welcomed = false;
let connecting = null; // one connection attempt at a time (start-up fires several triggers at once)
let retryTimer = null;
const tabQueues = new Map(); // tabId -> tail of that tab's operation queue

// ---------- broker link ----------

async function loadToken() {
  try {
    const response = await fetch(chrome.runtime.getURL("token.json"));
    return (await response.json()).token;
  } catch {
    return null;
  }
}

function connect() {
  connecting ??= openSocket().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function openSocket() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const token = await loadToken();
  if (!token) {
    await setStatus("No token.json in the extension folder. Run `npm run setup` in the agent-tabs repo, then reload the extension.");
    return;
  }
  const ws = new WebSocket(BROKER_URL);
  socket = ws;
  ws.onopen = async () => {
    await sessions.ready;
    ws.send(JSON.stringify({ type: "hello", token, version: VERSION, agents: sessions.agentList() }));
  };
  ws.onmessage = (event) => handleMessage(ws, JSON.parse(event.data));
  ws.onclose = () => {
    if (socket !== ws) return; // an older socket the broker replaced
    socket = null;
    welcomed = false;
    setStatus("Broker not reachable (is the launchd agent running?).");
    scheduleRetry();
  };
  ws.onerror = () => {};
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, 3000);
}

function reply(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export function reportEvent(kind, detail) {
  if (socket && welcomed) reply(socket, { type: "event", kind, detail });
}

async function handleMessage(ws, message) {
  if (message.type === "ping") return reply(ws, { type: "pong" });
  if (message.type === "welcome") {
    welcomed = true;
    setPolicy(message.policy ?? {});
    sessions.setWindowMode(message.window);
    // Agents are not ended here: the broker adopts them for reconnecting clients, and ends the
    // ones whose client has gone.
    await setStatus(`Connected to the broker (${new Date().toLocaleTimeString()}).`);
    return;
  }
  if (message.type === "policy") {
    setPolicy(message.policy ?? {});
    return;
  }
  if (message.type === "reload") {
    // Sent by `npm run reload-extension` after the extension's files change.
    chrome.runtime.reload();
    return;
  }
  if (ws !== socket || !welcomed || !message.op) return;
  const { id, sessionId, op, args = {}, client } = message;
  try {
    await sessions.ready;
    await sessions.noteClient(sessionId, client);
    const handler = ops[op];
    if (!handler) throw new Error(`Unknown operation ${op}`);
    const result = await serialisedPerTab(args.tabId, () => handler(sessionId, args));
    reply(ws, { id, result });
  } catch (error) {
    reply(ws, { id, error: String(error?.message ?? error) });
  }
}

// Operations on the same tab run one at a time; different tabs run in parallel.
function serialisedPerTab(tabId, run) {
  if (tabId === undefined) return run();
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  tabQueues.set(tabId, current);
  current.finally(() => {
    if (tabQueues.get(tabId) === current) tabQueues.delete(tabId);
  }).catch(() => {});
  return current;
}

async function setStatus(text) {
  await chrome.storage.session.set({ status: text, statusAt: Date.now() }).catch(() => {});
}

// ---------- wiring ----------

cdp.onPopup(async (openerTabId, url) => {
  const sessionId = sessions.ownerOf(openerTabId);
  if (!sessionId) return null;
  const tabId = await sessions.createTab(sessionId, { openerTabId });
  await cdp.ensureAttached(tabId);
  await cdp.send(tabId, "Page.navigate", { url }).catch(() => {});
  reportEvent("popup_rerouted", { openerTabId, tabId });
  return tabId;
});

// Backstop for popups the injected guard didn't catch (for example Cmd-click, or a page that
// stops click propagation): claim the new tab for the same agent.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId }) => {
  await sessions.ready;
  const sessionId = sessions.ownerOf(sourceTabId);
  if (!sessionId || sessions.ownerOf(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await sessions.claimTab(sessionId, tabId).catch(() => {});
  await cdp.ensureAttached(tabId).catch(() => {});
  const win = tab ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  const signInPopup = win?.type === "popup";
  cdp.note(
    cdp.state(sourceTabId),
    signInPopup
      ? `A sign-in popup opened as tab ${tabId} (its own window). Finish the sign-in there; it usually closes itself and returns to this tab.`
      : `The page opened tab ${tabId} directly (not caught by the popup guard); it now belongs to this agent.`,
  );
  reportEvent(signInPopup ? "signin_popup" : "popup_escaped", { sourceTabId, tabId, active: Boolean(tab?.active) });
});

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (sessions.ownerOf(tabId)) reportEvent("debugger_detached", { tabId, reason });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await sessions.ready;
  cdp.dropState(tabId);
  await sessions.forgetTab(tabId);
});

chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
