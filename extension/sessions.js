// Agent sessions, their tab groups and which tabs they own.
//
// One agent (normally one broker MCP session) = one session here = one tab group. A session can
// only see and touch tabs it owns. State is kept in chrome.storage.local, which survives service
// worker restarts and extension reloads, so agents keep their tabs through updates.

const GROUP_COLORS = ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow", "grey"];

let sessions = {}; // sessionId -> { label, groupId, colorIndex, pid, cursor }
let tabOwners = {}; // tabId -> sessionId
let keptTabs = {}; // tabId -> true: left open when the session ends
let windowMode = "current"; // "current" or "dedicated"
let dedicatedWindowId = null;

export const ready = chrome.storage.local.get(["sessions", "tabOwners", "keptTabs", "dedicatedWindowId"]).then(async (saved) => {
  sessions = saved.sessions ?? {};
  tabOwners = saved.tabOwners ?? {};
  keptTabs = saved.keptTabs ?? {};
  dedicatedWindowId = saved.dedicatedWindowId ?? null;
  // Tab ids don't survive a browser restart; forget tabs that no longer exist.
  const open = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
  for (const tabId of Object.keys(tabOwners)) if (!open.has(Number(tabId))) delete tabOwners[tabId];
  for (const tabId of Object.keys(keptTabs)) if (!open.has(Number(tabId))) delete keptTabs[tabId];
  await save();
});

function save() {
  return chrome.storage.local.set({ sessions, tabOwners, keptTabs, dedicatedWindowId });
}

// Records the client behind a session: its process, so the broker can hand the session back to the
// same client after it restarts, and which cursor its tabs show ("claude" or "neutral").
export async function noteClient(sessionId, { pid, label, cursor } = {}) {
  if (!sessionId || !(pid || cursor)) return;
  const session = (sessions[sessionId] ??= newSession());
  const next = { pid: pid ?? session.pid, label: session.label || label?.slice(0, 40) || "", cursor: cursor ?? session.cursor };
  if (next.pid === session.pid && next.label === session.label && next.cursor === session.cursor) return;
  Object.assign(session, next);
  await save();
}

// Agents with at least one tab, for the broker when it (re)connects.
export function agentList() {
  return Object.entries(sessions)
    .filter(([id]) => ownedTabIds(id).length)
    .map(([id, session]) => ({ id, pid: session.pid ?? null, label: session.label ?? "" }));
}

export function setWindowMode(mode) {
  windowMode = mode === "dedicated" ? "dedicated" : "current";
}


export function ownerOf(tabId) {
  return tabOwners[tabId];
}

export function ownedTabIds(sessionId) {
  return Object.entries(tabOwners)
    .filter(([, owner]) => owner === sessionId)
    .map(([tabId]) => Number(tabId));
}

// How the agent's cursor looks in a tab: the Claude mark or a neutral arrow, with the agent's name.
export function cursorFor(tabId) {
  const session = sessions[tabOwners[tabId]];
  const style = session?.cursor === "neutral" ? "neutral" : "claude";
  return { style, label: session?.label || (style === "claude" ? "Claude" : "Agent") };
}

// The title of the tab group a tab is in, for telling the user where to look.
export function groupTitleFor(tabId) {
  return groupTitle(sessions[tabOwners[tabId]] ?? {});
}

export function isKept(tabId) {
  return Boolean(keptTabs[tabId]);
}

export async function setKept(tabId, keep) {
  if (keep) keptTabs[tabId] = true;
  else delete keptTabs[tabId];
  await save();
}

export function requireOwner(sessionId, tabId) {
  if (tabOwners[tabId] !== sessionId) {
    throw new Error(`Tab ${tabId} is not one of this agent's tabs. Use browser_list_tabs to see your tabs.`);
  }
}

export async function setLabel(sessionId, label) {
  const session = (sessions[sessionId] ??= newSession());
  session.label = label.slice(0, 40);
  if (session.groupId !== undefined) {
    await chrome.tabGroups.update(session.groupId, { title: groupTitle(session) }).catch(() => {});
  }
  await save();
}

function newSession() {
  const used = new Set(Object.values(sessions).map((s) => s.colorIndex));
  let colorIndex = 0;
  while (used.has(colorIndex) && colorIndex < GROUP_COLORS.length) colorIndex++;
  return { label: "", colorIndex: colorIndex % GROUP_COLORS.length };
}

function groupTitle(session) {
  return session.label ? `agent: ${session.label}` : "agent";
}

// Opens a background tab for the session and returns its id. The tab is never activated, and a
// new window (only when Chrome has none to use) is created unfocused.
export async function createTab(sessionId, { openerTabId } = {}) {
  const session = (sessions[sessionId] ??= newSession());
  const windowId = await windowFor(session, openerTabId);
  let tabId;
  if (windowId === null) {
    const created = await chrome.windows.create({ focused: false, url: "about:blank" });
    tabId = created.tabs[0].id;
    if (windowMode === "dedicated") dedicatedWindowId = created.id;
  } else {
    const tab = await retryTabEdit(() =>
      chrome.tabs.create({ windowId, url: "about:blank", active: false, ...(openerTabId ? { openerTabId } : {}) }),
    );
    tabId = tab.id;
  }
  await claimTab(sessionId, tabId);
  return tabId;
}

async function windowFor(session, openerTabId) {
  if (openerTabId) {
    const opener = await chrome.tabs.get(openerTabId).catch(() => null);
    if (opener) return opener.windowId;
  }
  if (session.groupId !== undefined) {
    const group = await chrome.tabGroups.get(session.groupId).catch(() => null);
    if (group) return group.windowId;
  }
  if (windowMode === "dedicated") {
    const existing = dedicatedWindowId !== null && (await chrome.windows.get(dedicatedWindowId).catch(() => null));
    return existing ? existing.id : null;
  }
  // Same choice as Codex: the last-focused normal window, else any normal window, else a new
  // unfocused one (null).
  const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (last && last.type === "normal" && !last.incognito) return last.id;
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return all.find((w) => !w.incognito)?.id ?? null;
}

export async function claimTab(sessionId, tabId) {
  const session = (sessions[sessionId] ??= newSession());
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  if (win.type !== "normal") {
    // Sign-in popups live in popup windows, which can't hold tab groups.
    tabOwners[tabId] = sessionId;
    await save();
    return;
  }
  const group = session.groupId !== undefined && (await chrome.tabGroups.get(session.groupId).catch(() => null));
  if (group && group.windowId === tab.windowId) {
    await retryTabEdit(() => chrome.tabs.group({ groupId: group.id, tabIds: tabId }));
  } else {
    session.groupId = await retryTabEdit(() => chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } }));
    await chrome.tabGroups
      .update(session.groupId, { title: groupTitle(session), color: GROUP_COLORS[session.colorIndex], collapsed: true })
      .catch(() => {});
  }
  tabOwners[tabId] = sessionId;
  await save();
}

export async function forgetTab(tabId) {
  if (!(tabId in tabOwners) && !(tabId in keptTabs)) return;
  delete tabOwners[tabId];
  delete keptTabs[tabId];
  await save();
}

// Closes the session's tabs, except kept ones, which stay open and are released from agent control.
// Returns the tab ids it closed and kept.
export async function endSession(sessionId, releaseTab) {
  const tabIds = ownedTabIds(sessionId);
  const kept = tabIds.filter((id) => keptTabs[id]);
  const closing = tabIds.filter((id) => !keptTabs[id]);
  for (const tabId of kept) {
    await releaseTab(tabId).catch(() => {});
    delete tabOwners[tabId];
    delete keptTabs[tabId];
  }
  for (const tabId of closing) delete tabOwners[tabId];
  const session = sessions[sessionId];
  delete sessions[sessionId];
  await save();
  if (closing.length) await chrome.tabs.remove(closing).catch(() => {});
  if (kept.length && session?.groupId !== undefined) {
    await chrome.tabGroups.update(session.groupId, { title: `${groupTitle(session)} (kept)` }).catch(() => {});
  }
  return { closed: closing, kept };
}

// chrome.tabs edits fail while the user is dragging a tab; retry briefly.
async function retryTabEdit(edit) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await edit();
    } catch (error) {
      if (attempt >= 10 || !/cannot be edited right now/i.test(String(error?.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
