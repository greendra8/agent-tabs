// One JSON line per tool call in ~/Library/Logs/agent-tabs/actions.log. Records what was done and
// where (host and the start of the path), never page content, typed text, query strings or tokens.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "agent-tabs");
const LOG_FILE = path.join(LOG_DIR, "actions.log");
const MAX_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });

// Argument values that are safe to log as-is; everything else is logged by length or presence.
const PLAIN_ARGS = new Set(["tabId", "ref", "action", "direction", "to", "choice", "button", "doubleClick", "fullPage", "waitUntil", "key", "repeat", "interactiveOnly", "keep", "level", "clear", "slowly", "submit", "force", "networkIdle"]);

export function logAction({ session, label, tool, args = {}, url, ok, ms, error }) {
  const entry = { at: new Date().toISOString(), session: session?.slice(0, 8), ...(label ? { label } : {}), tool, args: summarise(args), ...(url ? { page: safeLocation(url) } : {}), ok, ms };
  if (error) entry.error = String(error).slice(0, 200);
  write(entry);
}

export function logEvent(kind, detail = {}) {
  write({ at: new Date().toISOString(), event: kind, ...detail });
}

function write(entry) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error("action log:", error.message);
  }
}

function summarise(args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (key === "url") out.url = safeLocation(value);
    else if (PLAIN_ARGS.has(key)) out[key] = value;
    else if (typeof value === "string") out[key] = `<${value.length} chars>`;
    else if (Array.isArray(value)) out[key] = `<${value.length} items>`;
    else out[key] = "<set>";
  }
  return out;
}

// Host plus the first two path segments, with long segments (likely ids or tokens) masked.
export function safeLocation(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
    const segments = parsed.pathname.split("/").filter(Boolean).slice(0, 2).map((s) => (s.length > 24 || /\d{6,}/.test(s) ? "…" : s));
    return parsed.host + (segments.length ? "/" + segments.join("/") : "");
  } catch {
    return "?";
  }
}
