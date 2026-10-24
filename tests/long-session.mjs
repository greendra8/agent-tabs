// Regression test for agents losing their tabs mid-task (field report, 24 Oct): one agent keeps a
// tab through pauses, an extension reload and a broker restart, reconnecting like Claude Code
// does (a new MCP session from the same process after the broker forgets the old one).
//
//   node tests/long-session.mjs                 quick: ~1 minute, short pauses
//   LONG_SESSION_MINUTES=65 node tests/long-session.mjs   long: 65 minutes, 5-minute pauses
//
// Restarts the broker (launchd) and reloads the extension, which real agents now survive too.
// Needs the fixture server on 127.0.0.1:47699.

import { execFileSync } from "node:child_process";
import { connectAgent } from "./client.mjs";

const FIXTURE = "http://127.0.0.1:47699/index.html";
const totalMinutes = Number(process.env.LONG_SESSION_MINUTES ?? 0);
const pauseMs = totalMinutes ? 5 * 60000 : 5000;
const started = Date.now();
const log = (message) => console.log(`${new Date().toISOString()} +${Math.round((Date.now() - started) / 1000)}s ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const health = await (await fetch("http://127.0.0.1:47615/health")).json();
      if (health.extensionConnected) return health;
    } catch {}
    await sleep(1000);
  }
  throw new Error("broker or extension did not come back");
}

let agent = await connectAgent("long-session");
const spareSessions = [];
// Like Claude Code: if the broker no longer knows the session, reconnect and retry once. Claude
// Code opens two sessions when it reconnects and may make its first call on one and carry on with
// the other, so this does the same.
async function call(tool, args) {
  try {
    return await agent.call(tool, args);
  } catch (error) {
    if (!/404|Unknown MCP session|session/i.test(error.message)) throw error;
    log(`session lost (${error.message.slice(0, 60)}); reconnecting with two sessions`);
    const first = await connectAgent("long-session");
    spareSessions.push(first);
    await first.call("browser_list_tabs", {});
    agent = await connectAgent("long-session");
    return agent.call(tool, args);
  }
}

const { data } = await call("browser_open_tab", { url: FIXTURE, label: "long session" });
const tabId = data.tabId;
log(`opened tab ${tabId}`);

let step = 0;
const failures = [];
async function checkpoint(what) {
  step++;
  try {
    const { data: tabs } = await call("browser_list_tabs", {});
    const mine = tabs.tabs.map((t) => t.tabId);
    if (!mine.includes(tabId)) throw new Error(`tab ${tabId} missing; agent sees ${JSON.stringify(mine)}`);
    const snap = await call("browser_snapshot", { tabId, interactiveOnly: true, filter: "Same-tab link" });
    if (!snap.texts[1].includes("Same-tab link")) throw new Error("snapshot lost the page");
    await call("browser_click", { tabId, text: "Check focus" });
    log(`step ${step} ok after ${what}`);
  } catch (error) {
    failures.push(`${what}: ${error.message}`);
    log(`step ${step} FAILED after ${what}: ${error.message}`);
  }
}

await checkpoint("start");
await sleep(pauseMs);
await checkpoint("pause");

execFileSync("pkill", ["-USR2", "-f", "agent-tabs/broker/server.mjs"]); // npm run reload-extension
log("extension reload requested");
await sleep(3000);
await healthy();
await checkpoint("extension reload");

execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${process.env.AGENT_TABS_LABEL ?? "local.agent-tabs.broker"}`]);
log("broker restarted");
await sleep(2000);
await healthy();
await checkpoint("broker restart");

const deadline = started + totalMinutes * 60000;
while (Date.now() + pauseMs < deadline) {
  await sleep(pauseMs);
  await checkpoint(`pause (${Math.round((Date.now() - started) / 60000)} min)`);
}

await call("browser_close_tab", { tabId });
await agent.close();
for (const spare of spareSessions) await spare.close();
log(failures.length ? `FAILED ${failures.length}/${step}: ${failures.join(" | ")}` : `passed ${step}/${step} checkpoints in ${Math.round((Date.now() - started) / 60000)} min`);
process.exit(failures.length ? 1 : 0);
