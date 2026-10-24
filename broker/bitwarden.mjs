// Logins from the user's Bitwarden vault, for browser_fill_login.
//
// The Bitwarden CLI (`bw`, Homebrew) holds the vault; scripts/bitwarden-unlock.command logs in,
// unlocks and stores the session key in the macOS keychain. Only logins whose saved URIs match
// the tab's URL (Bitwarden's own matching, as its autofill uses) are ever returned, so a page
// can't get another site's password. Secrets go from here to the extension, never to the agent.

import { execFile } from "node:child_process";
import fs from "node:fs";

const KEYCHAIN_ACCOUNT = "agent-tabs";
const KEYCHAIN_SERVICE = "agent-tabs-bitwarden";
const SYNC_EVERY_MS = 10 * 60 * 1000;
let lastSync = 0;

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, BW_NOINTERACTION: "true" } }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().split("\n")[0].slice(0, 200)));
      else resolve(stdout);
    });
  });
}

// launchd gives the broker a minimal PATH, so look in Homebrew's locations.
export const BW = ["/opt/homebrew/bin/bw", "/usr/local/bin/bw"].find((p) => fs.existsSync(p)) ?? "bw";

async function sessionKey(command) {
  if (command !== BW) return "test-session"; // a fake bw for tests needs no unlock
  try {
    return (await run("/usr/bin/security", ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"])).trim();
  } catch {
    throw new Error("Bitwarden isn't unlocked for agents. Ask the user to run scripts/bitwarden-unlock.command in the agent-tabs folder.");
  }
}

// Logins saved for this URL, with secrets. command is the bw binary (tests use a fake).
export async function loginsFor(url, command) {
  const session = await sessionKey(command);
  if (Date.now() - lastSync > SYNC_EVERY_MS) {
    await run(command, ["sync", "--session", session]).catch(() => {}); // pick up logins added since
    lastSync = Date.now();
  }
  let items;
  try {
    items = JSON.parse(await run(command, ["list", "items", "--url", url, "--session", session]));
  } catch (error) {
    throw new Error(`Bitwarden lookup failed (${error.message}). If the vault is locked, ask the user to run scripts/bitwarden-unlock.command.`);
  }
  return items
    .filter((item) => item.type === 1 && item.login)
    .map((item) => ({ id: item.id, name: item.name, username: item.login.username ?? "", password: item.login.password ?? "", hasTotp: Boolean(item.login.totp) }));
}

export async function totpFor(id, command) {
  const session = await sessionKey(command);
  return (await run(command, ["get", "totp", id, "--session", session])).trim();
}
