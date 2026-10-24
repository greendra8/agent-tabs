// Agent Tabs broker: one local process between Claude agents (MCP over Streamable HTTP at
// http://127.0.0.1:47615/mcp) and the Agent Tabs Chrome extension (WebSocket at /extension).
//
// Every MCP session is one agent. Its agent id goes with each operation, so the extension can give
// each agent its own tab group and refuse access to anyone else's tabs. When an agent ends (DELETE,
// its client process exits, or it idles out) the extension closes its tabs.
//
// Agents survive restarts. The extension keeps its agents (with each client's PID) in
// chrome.storage.local. When the broker restarts, Claude Code reconnects with a new MCP session; the
// extension reports its agents as orphans, and the first new session from the same client process
// that calls a tool adopts its orphan, tabs and all.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, watchConfig } from "./config.mjs";
import { ensureToken, tokenMatches, extensionId } from "./token.mjs";
import { logAction, logEvent } from "./action-log.mjs";
import { INSTRUCTIONS, registerTools } from "./tools.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.AGENT_TABS_PORT ?? 47615);
const VERSION = "1.0.0";
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const DEFAULT_CALL_TIMEOUT_MS = 40000;
const SCREENSHOT_DIR = path.join(os.homedir(), "Library", "Caches", "agent-tabs", "screenshots");
const SCREENSHOT_RETENTION_MS = 3 * 24 * 3600 * 1000;

const token = ensureToken();
const EXTENSION_ORIGIN = `chrome-extension://${extensionId()}`;
let config = loadConfig();

// ---------- extension link ----------

let extension = null; // the authenticated WebSocket
const pending = new Map(); // call id -> { resolve, reject, timer }
let nextCallId = 1;

function callExtension(agentId, op, args = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, client = {}) {
  if (!extension) {
    return Promise.reject(new Error("The Agent Tabs Chrome extension is not connected. Chrome may be closed, or the extension disabled; ask the user to check chrome://extensions."));
  }
  const id = nextCallId++;
  extension.send(JSON.stringify({ id, sessionId: agentId, op, args, client }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${op} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}

function welcome(socket, reported = []) {
  socket.send(JSON.stringify({ type: "welcome", policy: { allow: config.allow, deny: config.deny, paymentGuard: config.paymentGuard }, window: config.window }));
  // Agents the extension has but no live session uses: keep them for adoption.
  const live = new Set([...sessions.values()].map((s) => s.agentId));
  for (const agent of reported) {
    if (!live.has(agent.id) && !orphans.has(agent.id)) orphans.set(agent.id, { pid: agent.pid ?? null, label: agent.label ?? "", since: Date.now() });
  }
  if (orphans.size) logEvent("orphans_waiting", { count: orphans.size });
}

const extensionServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

extensionServer.on("connection", (socket) => {
  let authenticated = false;
  const authTimer = setTimeout(() => socket.close(4001, "no hello"), 5000);
  let keepAlive = null;

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!authenticated) {
      if (message.type !== "hello" || !tokenMatches(token, message.token)) {
        logEvent("extension_rejected", { reason: "bad token" });
        socket.close(4003, "bad token");
        return;
      }
      authenticated = true;
      clearTimeout(authTimer);
      if (extension && extension !== socket) extension.close(4000, "replaced");
      extension = socket;
      welcome(socket, message.agents);
      // Messages keep the MV3 service worker alive; protocol-level pings don't count.
      keepAlive = setInterval(() => socket.send(JSON.stringify({ type: "ping" })), 20000);
      logEvent("extension_connected", { version: message.version });
      return;
    }
    if (message.type === "pong") return;
    if (message.type === "event") {
      logEvent(message.kind, message.detail);
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error));
    else call.resolve(message.result);
  });

  socket.on("close", () => {
    clearTimeout(authTimer);
    clearInterval(keepAlive);
    if (extension !== socket) return;
    extension = null;
    logEvent("extension_disconnected");
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new Error("The Chrome extension disconnected during the call."));
      pending.delete(id);
    }
  });
});

watchConfig((updated) => {
  config = updated;
  extension?.send(JSON.stringify({ type: "policy", policy: { allow: config.allow, deny: config.deny, paymentGuard: config.paymentGuard } }));
  logEvent("config_reloaded", { deny: config.deny.length, allow: config.allow.length });
});

// ---------- MCP sessions ----------

const sessions = new Map(); // MCP session id -> { transport, lastActivity, label, client, pid, agentId }
const orphans = new Map(); // agent id -> { pid, label, since }: agents waiting to be adopted

// The agent a session acts as, decided at its first tool call: an orphan from the same client
// process when there is exactly one; else the agent another session from the same client process
// already adopted (Claude Code opens two sessions when it reconnects after a broker restart, and
// may adopt on one and carry on with the other); else the session itself.
function agentFor(sessionId, session) {
  if (session.agentId) return session.agentId;
  const candidates = session.pid ? [...orphans].filter(([, orphan]) => orphan.pid === session.pid) : [];
  const sibling = session.pid
    ? [...sessions].find(([id, other]) => id !== sessionId && other.pid === session.pid && other.client === session.client && other.agentId && other.agentId !== id)
    : undefined;
  if (candidates.length === 1) {
    const [agentId, orphan] = candidates[0];
    orphans.delete(agentId);
    session.agentId = agentId;
    session.label ||= orphan.label;
    logEvent("session_adopted", { session: sessionId.slice(0, 8), agent: agentId.slice(0, 8), label: orphan.label });
  } else if (sibling) {
    session.agentId = sibling[1].agentId;
    session.label ||= sibling[1].label;
    logEvent("session_adopted", { session: sessionId.slice(0, 8), agent: session.agentId.slice(0, 8), label: session.label, via: "sibling session" });
  } else {
    session.agentId = sessionId;
  }
  return session.agentId;
}

// Which cursor the agent's tabs show: the Claude mark only for Claude clients (Claude Code sends
// clientInfo.name "claude-code"), a neutral arrow for everyone else, unless the config picks one.
function cursorStyle(client) {
  if (config.cursor === "claude" || config.cursor === "neutral") return config.cursor;
  return /claude/i.test(client) ? "claude" : "neutral";
}

function createSession() {
  const server = new McpServer({ name: "agent-tabs", version: VERSION }, { instructions: INSTRUCTIONS });
  let sessionId = null;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessionId = id;
      sessions.set(id, { transport, lastActivity: Date.now(), label: "", client: "", pid: null, pidReady: null, agentId: null });
      logEvent("session_started", { session: id.slice(0, 8) });
    },
  });
  transport.onclose = () => {
    if (sessionId) endSession(sessionId, "closed by client");
  };

  // logArgs are the tool's own arguments; args (sent to the extension) may hold secrets.
  const call = async (tool, op, args, timeoutMs, logArgs = args) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("This MCP session has ended.");
    session.lastActivity = Date.now();
    await session.pidReady;
    const agentId = agentFor(sessionId, session);
    if (op === "open_tab" && args.label) session.label = args.label;
    const started = Date.now();
    try {
      const result = await callExtension(agentId, op, args, timeoutMs, { pid: session.pid, label: session.label, cursor: cursorStyle(session.client) });
      logAction({ session: sessionId, label: session?.label, tool, args: logArgs, url: result?.url, ok: true, ms: Date.now() - started });
      return result;
    } catch (error) {
      logAction({ session: sessionId, label: session?.label, tool, args: logArgs, ok: false, ms: Date.now() - started, error: error.message });
      throw error;
    } finally {
      if (session) session.lastActivity = Date.now();
    }
  };
  registerTools(server, { call, config: () => config, screenshotDir: SCREENSHOT_DIR });
  server.connect(transport);
  return transport;
}

async function endSession(sessionId, reason) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.transport.close().catch(() => {});
  const agentId = session.agentId;
  if (!agentId) {
    logEvent("session_ended", { session: sessionId.slice(0, 8), reason, closedTabs: 0, keptTabs: 0 });
    return;
  }
  // Another live session can share the agent (it adopted it); the agent ends with the last one.
  if ([...sessions.values()].some((s) => s.agentId === agentId)) return;
  await endAgent(agentId, session.label, reason, sessionId);
}

async function endAgent(agentId, label, reason, sessionId = agentId) {
  let outcome = {};
  try {
    outcome = (await callExtension(agentId, "end_session")) ?? {};
  } catch {
    // Not connected: the agent stays in the extension and comes back as an orphan.
  }
  logEvent("session_ended", { session: sessionId.slice(0, 8), label, reason, closedTabs: outcome.closed?.length ?? 0, keptTabs: outcome.kept?.length ?? 0 });
}

// Claude Code neither ends its MCP session nor keeps a connection open when it exits, so the
// broker watches the client process itself: agents are always local processes.
function clientPid(socket) {
  return new Promise((resolve) => {
    execFile("/usr/sbin/lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${socket.remotePort}`, "-sTCP:ESTABLISHED"], (_error, stdout) => {
      const pids = String(stdout ?? "").split("\n").map(Number).filter((pid) => pid && pid !== process.pid);
      resolve(pids[0] ?? null);
    });
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

setInterval(() => {
  const now = Date.now();
  const idleMs = config.idleMinutes * 60000;
  for (const [id, session] of sessions) {
    if (session.pid && !processAlive(session.pid)) endSession(id, "client process exited");
    else if (now - session.lastActivity > idleMs) endSession(id, `idle for ${config.idleMinutes} min`);
  }
  if (!extension) return;
  for (const [agentId, orphan] of orphans) {
    const gone = orphan.pid ? !processAlive(orphan.pid) : now - orphan.since > 2 * 60000;
    if (gone || now - orphan.since > idleMs) {
      orphans.delete(agentId);
      endAgent(agentId, orphan.label, gone ? "client process exited (orphan)" : `orphan not adopted in ${config.idleMinutes} min`);
    }
  }
}, 15000).unref();

// ---------- HTTP ----------

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reject(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function handleMcp(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (sessionId && !session) return reject(res, 404, "Unknown MCP session; start a new one."); // client re-initializes
  const body = req.method === "POST" ? await readJson(req) : undefined;
  if (session) {
    session.lastActivity = Date.now();
    return session.transport.handleRequest(req, res, body);
  }
  if (req.method !== "POST" || !isInitializeRequest(body)) return reject(res, 400, "Send an initialize request first.");
  const pid = clientPid(req.socket); // looked up while the connection is certainly open
  const transport = createSession();
  await transport.handleRequest(req, res, body);
  const created = sessions.get(transport.sessionId);
  if (created) {
    created.client = body.params?.clientInfo?.name ?? "";
    created.pidReady = pid;
    created.pid = await pid;
    logEvent("session_client", { session: transport.sessionId.slice(0, 8), client: created.client, pid: created.pid });
  }
}

const httpServer = http.createServer((req, res) => {
  // DNS-rebinding and cross-site protection: only local host names, and no browser origins.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "") || req.headers.origin) {
    res.writeHead(403).end();
    return;
  }
  const { pathname } = new URL(req.url, `http://${HOST}`);
  if (pathname === "/admin/cleanup-tabs" && req.method === "POST") {
    // Needs the broker token, so only this macOS user (who can read ~/.config/agent-tabs/token) can call it.
    if (!tokenMatches(token, String(req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
      res.writeHead(403).end();
      return;
    }
    const dryRun = new URL(req.url, `http://${HOST}`).searchParams.has("dryRun");
    callExtension("admin", "cleanup_tabs", { dryRun }, 30000).then(
      (outcome) => {
        if (!dryRun) logEvent("tabs_cleaned_up", outcome);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(outcome));
      },
      (error) => reject(res, 503, error.message),
    );
    return;
  }
  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION, extensionConnected: Boolean(extension), sessions: sessions.size, orphans: orphans.size }));
    return;
  }
  if (pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  // Optional hardening: only clients that know the token (readable by this macOS user) may connect.
  if (config.requireMcpToken && !tokenMatches(token, String(req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
    reject(res, 401, "This agent-tabs broker requires Authorization: Bearer <token> (see ~/.config/agent-tabs/token).");
    return;
  }
  handleMcp(req, res).catch((error) => {
    console.error("mcp request failed:", error);
    if (!res.headersSent) reject(res, 500, "Internal error");
  });
});

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);
  if (pathname !== "/extension" || req.headers.origin !== EXTENSION_ORIGIN || !ALLOWED_HOSTS.has(req.headers.host ?? "")) {
    logEvent("extension_rejected", { reason: "bad origin or path", origin: String(req.headers.origin ?? "").slice(0, 80) });
    socket.destroy();
    return;
  }
  extensionServer.handleUpgrade(req, socket, head, (ws) => extensionServer.emit("connection", ws, req));
});

// ---------- housekeeping ----------

// `npm run reload-extension` sends SIGUSR2: reload the extension so it picks up changed files.
process.on("SIGUSR2", () => {
  extension?.send(JSON.stringify({ type: "reload" }));
  logEvent("extension_reload_requested");
});

function pruneScreenshots() {
  if (!fs.existsSync(SCREENSHOT_DIR)) return;
  for (const day of fs.readdirSync(SCREENSHOT_DIR)) {
    const dir = path.join(SCREENSHOT_DIR, day);
    if (Date.now() - fs.statSync(dir).mtimeMs > SCREENSHOT_RETENTION_MS) fs.rmSync(dir, { recursive: true, force: true });
  }
}
pruneScreenshots();
setInterval(pruneScreenshots, 3600 * 1000).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`agent-tabs broker ${VERSION} on http://${HOST}:${PORT}/mcp (extension ${EXTENSION_ORIGIN})`);
  logEvent("broker_started", { version: VERSION, port: PORT });
});
