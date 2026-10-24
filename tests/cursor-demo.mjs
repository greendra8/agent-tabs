// Demo for watching the agent cursor: fills and submits the fixture form in a loop for 2 minutes.
// Open the "agent: cursor demo" tab group in Chrome to watch. Needs the fixture server on :47699.
import { connectAgent } from "./client.mjs";

const agent = await connectAgent("cursor-demo");
const { data } = await agent.call("browser_open_tab", { url: "http://127.0.0.1:47699/index.html", label: "cursor demo" });
const tabId = data.tabId;
await agent.call("browser_handle_cookie_banner", { tabId });
const until = Date.now() + 120000;
for (let round = 1; Date.now() < until; round++) {
  await agent.call("browser_scroll", { tabId, to: "top" });
  await agent.call("browser_fill", {
    tabId,
    fields: [
      { selector: "#name", value: `Demo round ${round}` },
      { selector: "#city", value: round % 2 ? "Oslo" : "Bergen" },
      { selector: "#agree", value: round % 2 === 1 },
      { selector: "#notes", value: "Filled by the agent, top to bottom." },
    ],
  });
  await agent.call("browser_batch", { tabId, steps: [{ action: "click", selector: "#submit" }, { action: "hover", selector: "#hover-target" }, { action: "click", selector: "#focus-check" }] });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
await agent.call("browser_close_tab", { tabId });
await agent.close();
