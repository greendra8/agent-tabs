// Broker configuration: ~/.config/agent-tabs/config.json, merged over these defaults.
// The file only needs the keys you want to change; see README.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BW } from "./bitwarden.mjs";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-tabs");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  allow: [], // when non-empty, agents may only load these sites
  deny: [], // sites agents may never load (none by default: agents act where the user asks them to)
  paymentGuard: true, // on checkout/payment pages, acting needs allowPayment (see README)
  requireMcpToken: false, // true: MCP clients must send "Authorization: Bearer <token>" (see README)
  // Close an agent's tabs after this long without a tool call. Some hosts keep a finished
  // subagent's process alive, so this (not process exit) is what cleans up after it. Long enough
  // for agents that pause to think or write notes.
  idleMinutes: 60,
  window: "current", // "current": the last-focused window; "dedicated": one separate agent window
  cursor: "auto", // the agent cursor: "auto" (Claude mark for Claude clients, else a neutral arrow), "claude" or "neutral"
  uploadRoots: [os.homedir(), "/tmp", "/private/tmp", "/private/var/folders"],
  bitwardenCommand: BW, // tests point this at tests/fake-bw.mjs
};

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Ignoring unreadable ${CONFIG_FILE}: ${error.message}`);
  }
  const config = { ...DEFAULTS, ...file };
  config.uploadRoots = config.uploadRoots.map(expandHome);
  return config;
}

export function watchConfig(onChange) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let timer = null;
  fs.watch(CONFIG_DIR, (_event, name) => {
    if (name !== "config.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => onChange(loadConfig()), 300);
  });
}

function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
