// Quick checks without Chrome: every source file parses, and so does the guard script the
// extension injects into pages (it is built from a template string, so escaping mistakes only
// show up there).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

let failed = false;
const files = [...fs.readdirSync("extension").filter((f) => f.endsWith(".js")).map((f) => path.join("extension", f)), ...fs.readdirSync("broker").filter((f) => f.endsWith(".mjs")).map((f) => path.join("broker", f))];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--input-type=module", "--check"], { input: fs.readFileSync(file) });
  } catch {
    console.log(`FAIL ${file} does not parse`);
    failed = true;
  }
}

const cdp = fs.readFileSync("extension/cdp.js", "utf8");
const start = cdp.indexOf("function popupGuard() {");
const source = new Function("bindingName", cdp.slice(start, cdp.indexOf("\n}\n", start) + 2) + "; return popupGuard();")("__check");
try {
  new Function(source);
} catch (error) {
  console.log(`FAIL the injected popup guard does not parse: ${error.message}`);
  failed = true;
}
const signIn = new Function(`${source.match(/const SIGN_IN_HOSTS[^\n]+\n[^\n]+\n[^\n]+/)[0]}; return isSignIn;`)();
const cases = [["https://accounts.google.com/o/oauth2/v2/auth", true], ["https://example.firebaseapp.com/__/auth/handler", true], ["https://www.booking.com/hotel/no/x.html", false], ["https://evilgithub.com/", false]];
for (const [url, expected] of cases) {
  if (signIn(new URL(url)) !== expected) {
    console.log(`FAIL isSignIn(${url}) should be ${expected}`);
    failed = true;
  }
}
console.log(failed ? "check failed" : `check passed (${files.length} files, guard, ${cases.length} sign-in cases)`);
process.exit(failed ? 1 : 0);
