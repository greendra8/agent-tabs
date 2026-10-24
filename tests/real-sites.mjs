// Read-only reliability probe on real sites: load, cookie banner, snapshot size and timing,
// paged text, screenshot. Never submits anything. Usage: node tests/real-sites.mjs [url ...]

import { connectAgent } from "./client.mjs";

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["https://www.vy.no/", "https://www.booking.com/", "https://www.google.com/travel/flights?hl=en"];

const agent = await connectAgent("real-sites");
const timed = async (label, run) => {
  const started = Date.now();
  try {
    const value = await run();
    return { label, ms: Date.now() - started, value };
  } catch (error) {
    return { label, ms: Date.now() - started, error: error.message.slice(0, 200) };
  }
};

for (const url of urls) {
  const rows = [];
  const open = await timed("open+load", () => agent.call("browser_open_tab", { url, label: "probe" }));
  rows.push(open);
  const tabId = open.value?.data.tabId;
  if (tabId) {
    rows.push(await timed("cookie banner", async () => (await agent.call("browser_handle_cookie_banner", { tabId })).data.clicked));
    rows.push(await timed("snapshot (full)", async () => {
      const { texts } = await agent.call("browser_snapshot", { tabId, maxChars: 200000 });
      return `${texts[1].length} chars, ${texts[1].split("\n").length} lines, notes ${JSON.parse(texts[0]).notes?.length ?? 0}`;
    }));
    rows.push(await timed("snapshot (interactive)", async () => {
      const { texts } = await agent.call("browser_snapshot", { tabId, interactiveOnly: true });
      return `${texts[1].length} chars, ${texts[1].split("\n").length} lines`;
    }));
    rows.push(await timed("get_text", async () => `${(await agent.call("browser_get_text", { tabId })).data.totalChars} chars total`));
    rows.push(await timed("screenshot", async () => `${(await agent.call("browser_screenshot", { tabId })).images[0].data.length} b64 bytes`));
    rows.push(await timed("scroll bottom", async () => JSON.stringify((await agent.call("browser_scroll", { tabId, to: "bottom" })).data.position)));
    await agent.call("browser_close_tab", { tabId });
  }
  console.log(`\n${url}  (final: ${open.value?.data.url ?? "-"})`);
  for (const row of rows) console.log(`  ${row.label.padEnd(24)} ${String(row.ms).padStart(6)} ms  ${row.error ? "ERROR " + row.error : typeof row.value === "string" ? row.value : ""}`);
}
await agent.close();
