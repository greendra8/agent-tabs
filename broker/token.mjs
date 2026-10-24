// The shared secret between the broker and the extension. Stored in ~/.config/agent-tabs/token
// and copied into extension/token.json (git-ignored), which the extension reads at start-up, so
// nobody has to paste it. Web pages can't read extension files that aren't web-accessible.

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.mjs";

export const TOKEN_FILE = path.join(CONFIG_DIR, "token");
export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const EXTENSION_TOKEN_FILE = path.join(EXTENSION_DIR, "token.json");

export function ensureToken({ rotate = false } = {}) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let token = !rotate && fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "";
  if (!token) {
    token = randomBytes(32).toString("hex");
    fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  }
  const copy = JSON.stringify({ token }) + "\n";
  if (!fs.existsSync(EXTENSION_TOKEN_FILE) || fs.readFileSync(EXTENSION_TOKEN_FILE, "utf8") !== copy) {
    fs.writeFileSync(EXTENSION_TOKEN_FILE, copy, { mode: 0o600 });
  }
  return token;
}

export function tokenMatches(expected, candidate) {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Chrome derives an extension's id from the public key in its manifest.
export function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
