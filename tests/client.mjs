// Minimal MCP client for tests: one instance = one agent session.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";

export const BROKER_URL = new URL(process.env.AGENT_TABS_URL ?? "http://127.0.0.1:47615/mcp");

export async function connectAgent(name = "test-agent") {
  const client = new Client({ name, version: "1.0.0" });
  // Sent always, so tests also work with requireMcpToken on.
  const token = fs.readFileSync(`${os.homedir()}/.config/agent-tabs/token`, "utf8").trim();
  const transport = new StreamableHTTPClientTransport(BROKER_URL, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const response = await client.callTool({ name: tool, arguments: args });
    const texts = response.content.filter((c) => c.type === "text").map((c) => c.text);
    const images = response.content.filter((c) => c.type === "image");
    if (response.isError) throw new Error(`${tool}: ${texts.join(" ")}`);
    let data;
    try {
      data = JSON.parse(texts[0]);
    } catch {
      data = texts[0];
    }
    return { data, texts, images };
  };
  return { client, transport, call, close: () => transport.terminateSession().catch(() => {}).then(() => client.close()) };
}
