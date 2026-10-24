// End-to-end test against the local fixture (tests/fixtures, served on 127.0.0.1:47699) through the
// running broker and the real extension. Drives Chrome in background tabs only.
//
// Run: (cd tests/fixtures && python3 -m http.server 47699 --bind 127.0.0.1) & npm run test:e2e

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectAgent } from "./client.mjs";

const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:47699/index.html";
const results = [];
const started = Date.now();

async function check(name, run) {
  const t = Date.now();
  console.log(`${new Date().toISOString()} START ${name}`);
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`PASS ${name} (${Date.now() - t} ms)${detail ? " — " + detail : ""}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: error.message });
    console.log(`FAIL ${name} (${Date.now() - t} ms) — ${error.message.slice(0, 400)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const agent = await connectAgent("e2e");
const other = await connectAgent("e2e-other");
let tabId;
let refs = {};

const logText = async () => (await agent.call("browser_get_text", { tabId, selector: "#log" })).texts[1];
const snapshotRefs = async () => {
  const { texts } = await agent.call("browser_snapshot", { tabId, interactiveOnly: true });
  refs = {};
  for (const line of texts[1].split("\n")) {
    const match = line.match(/^- \w+ "([^"]+)".*\[ref=(e\d+)\]/);
    if (match) refs[match[1]] ??= match[2];
  }
  return texts[1];
};

await check("open tab in background", async () => {
  const { data } = await agent.call("browser_open_tab", { url: FIXTURE, label: "e2e" });
  tabId = data.tabId;
  assert(data.title === "agent-tabs fixture", `title ${data.title}`);
  return `tab ${tabId}`;
});

await check("snapshot has refs, shadow DOM and iframe content", async () => {
  const text = await snapshotRefs();
  for (const name of ["Same-tab link", "Shadow button", "Frame button", "Reject all", "Name"]) assert(refs[name], `missing ${name}`);
  return `${text.split("\n").length} interactive lines`;
});

await check("cookie banner: reject", async () => {
  const { data } = await agent.call("browser_handle_cookie_banner", { tabId });
  assert(data.clicked === "Reject all", JSON.stringify(data));
  assert((await logText()).includes("consent rejected"), "log missing");
});

await check("covered check: in-flow layer clicks through, fixed modal is refused", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Styled button"] });
  assert((await logText()).includes("styled clicked"), "styled button click did not land");
  await agent.call("browser_click", { tabId, ref: refs["Show modal overlay"] });
  let refusal = "";
  try {
    await agent.call("browser_click", { tabId, ref: refs["Under modal"] });
  } catch (error) {
    refusal = error.message;
  }
  assert(/covered by an overlay, <div#modal>/.test(refusal), `not refused: ${refusal}`);
  await agent.call("browser_click", { tabId, ref: refs["Under modal"], force: true }); // lands on the modal, which closes
  await agent.call("browser_click", { tabId, ref: refs["Under modal"] });
  assert((await logText()).includes("under modal clicked"), "click after closing the modal did not land");
});

await check("hidden checkbox is clicked through its label; ambiguous text is reported", async () => {
  const { data } = await agent.call("browser_click", { tabId, ref: refs["Hidden checkbox"] });
  assert((await logText()).includes("hidden checkbox true"), `not checked; ${JSON.stringify(data)}`);
  const ambiguous = await agent.call("browser_click", { tabId, text: "Search", exact: true });
  assert(ambiguous.data.notes?.some((n) => /2 visible elements match/.test(n)), JSON.stringify(ambiguous.data));
  return `clicked ${data.clicked}`;
});

await check("window.focus() is neutralised; conflicting click targets are refused", async () => {
  const { data } = await agent.call("browser_evaluate", { tabId, expression: "String(window.focus)" });
  assert(data.result.includes("function focus() {}"), data.result);
  const marked = await agent.call("browser_evaluate", { tabId, expression: "['data-bwignore','data-1p-ignore','data-lpignore'].every((a) => document.getElementById('name').hasAttribute(a))" });
  assert(marked.data.result === "true", "inputs are not marked for password managers");
  let refused = "";
  try {
    await agent.call("browser_click", { tabId, text: "Search", x: 10, y: 10 });
  } catch (error) {
    refused = error.message;
  }
  assert(/exactly one target/.test(refused), `not refused: ${refused}`);
});

await check("focus emulation: hidden tab reports hasFocus=true", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Check focus"] });
  const log = await logText();
  assert(log.includes("hasFocus=true"), log.split("\n").pop());
  return log.split("\n").pop();
});

await check("type, select, fill and submit", async () => {
  const typed = await agent.call("browser_type", { tabId, ref: refs["Name"], text: "Agent test" });
  assert(typed.data.value === "Agent test", `value ${typed.data.value}`);
  await agent.call("browser_select", { tabId, ref: refs["City"], values: ["Bergen"] });
  await agent.call("browser_fill", { tabId, fields: [{ ref: refs["I agree"], value: true }, { ref: refs["Notes"], value: "hello" }] });
  await agent.call("browser_click", { tabId, ref: refs["Submit"] });
  const log = await logText();
  assert(log.includes("submitted name=Agent test city=ber agree=true"), log.split("\n").pop());
});

await check("browser_batch runs several steps in one call; the agent cursor is drawn", async () => {
  const { data } = await agent.call("browser_batch", {
    tabId,
    steps: [
      { action: "type", ref: refs["Name"], text: "Batch test" },
      { action: "select", ref: refs["City"], values: ["Oslo"] },
      { action: "click", ref: refs["Submit"] },
      { action: "wait_for", text: "submitted name=Batch test", timeoutMs: 3000 },
    ],
  });
  assert(data.completed === 4 && data.of === 4, JSON.stringify(data.steps));
  const cursor = await agent.call("browser_evaluate", { tabId, expression: "Boolean(document.getElementById('__agent_tabs_cursor'))" });
  assert(cursor.data.result === "true", "no agent cursor in the page");
  const failing = await agent.call("browser_batch", { tabId, steps: [{ action: "click", selector: "#does-not-exist" }, { action: "click", ref: refs["Submit"] }] });
  assert(failing.data.completed === 0 && failing.data.steps.length === 1 && !failing.data.steps[0].ok, `should stop at the first failure: ${JSON.stringify(failing.data.steps)}`);
});

await check("browser_handoff keeps the tab and says where to go", async () => {
  const { data } = await agent.call("browser_handoff", { tabId, reason: "enter the 6-digit code" });
  assert(data.handoff === "waiting" && /agent: e2e/.test(data.tellUser), JSON.stringify(data));
  const kept = (await agent.call("browser_list_tabs")).data.tabs.find((t) => t.tabId === tabId)?.kept;
  assert(kept === true, "handoff tab not kept");
  await agent.call("browser_handoff", { tabId, reason: "", done: true });
  const read = await agent.call("browser_batch", { tabId, steps: [{ action: "get_text", selector: "h1" }] });
  assert(read.data.steps[0].text?.includes("agent-tabs fixture"), JSON.stringify(read.data.steps));
  await snapshotRefs(); // the handoff released the tab, which resets refs (the user may have changed the page)
});

await check("press: select all + Backspace clears the field", async () => {
  await agent.call("browser_press", { tabId, ref: refs["Name"], key: "Meta+a" });
  await agent.call("browser_press", { tabId, key: "Backspace" });
  const { data } = await agent.call("browser_evaluate", { tabId, expression: "document.getElementById('name').value" });
  assert(data.result === '""', `value ${data.result}`);
});

const tabCount = async () => (await agent.call("browser_list_tabs")).data.tabs.length;

await check("target=_blank link opens a background tab in the group", async () => {
  const before = await tabCount();
  const { data } = await agent.call("browser_click", { tabId, ref: refs["Target blank link"] });
  await new Promise((r) => setTimeout(r, 800));
  const tabs = (await agent.call("browser_list_tabs")).data.tabs;
  assert(tabs.length === before + 1, `tabs ${before} -> ${tabs.length}; notes ${JSON.stringify(data.notes)}`);
  assert(tabs.some((t) => t.url?.includes("from=blank")), JSON.stringify(tabs.map((t) => t.url)));
  assert(data.notes?.some((n) => /New background tab \d+/.test(n)), `click result didn't report the new tab: ${JSON.stringify(data)}`);
  return data.notes?.[0];
});

await check("window.open popup opens a background tab", async () => {
  const before = await tabCount();
  await agent.call("browser_click", { tabId, ref: refs["window.open popup"] });
  await new Promise((r) => setTimeout(r, 800));
  const tabs = (await agent.call("browser_list_tabs")).data.tabs;
  assert(tabs.length === before + 1 && tabs.some((t) => t.url?.includes("from=window-open")), JSON.stringify(tabs.map((t) => t.url)));
});

await check("form with target=_blank opens a background tab", async () => {
  const before = await tabCount();
  await agent.call("browser_click", { tabId, ref: refs["Form with target=_blank"] });
  await new Promise((r) => setTimeout(r, 800));
  const tabs = (await agent.call("browser_list_tabs")).data.tabs;
  assert(tabs.length === before + 1 && tabs.some((t) => t.url?.includes("from=form-blank")), JSON.stringify(tabs.map((t) => t.url)));
});

await check("alert dialog: reported, then accepted", async () => {
  const { data } = await agent.call("browser_click", { tabId, ref: refs["Alert"] });
  assert(data.dialog?.type === "alert", JSON.stringify(data));
  let refused = false;
  try {
    await agent.call("browser_snapshot", { tabId });
  } catch (error) {
    refused = /dialog/.test(error.message);
  }
  assert(refused, "snapshot was not refused while the dialog was open");
  await agent.call("browser_dialog", { tabId, action: "accept" });
  assert((await logText()).includes("alert closed"), "log missing");
});

await check("confirm dialog: dismissed", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Confirm"] });
  await agent.call("browser_dialog", { tabId, action: "dismiss" });
  assert((await logText()).includes("confirm returned false"), "log missing");
});

await check("prompt dialog: accepted with text", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Prompt"] });
  const status = await agent.call("browser_dialog", { tabId });
  assert(status.data.dialog?.type === "prompt", JSON.stringify(status.data));
  await agent.call("browser_dialog", { tabId, action: "accept", promptText: "Bergen" });
  assert((await logText()).includes("prompt returned Bergen"), "log missing");
});

const uploadFile = path.join(os.homedir(), "Downloads", "agent-tabs-upload-test.txt");
fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
fs.writeFileSync(uploadFile, "agent-tabs upload test\n");

await check("upload to a file input", async () => {
  await agent.call("browser_upload", { tabId, selector: "#file", paths: [uploadFile] });
  const log = await logText();
  assert(log.includes("file chosen: agent-tabs-upload-test.txt 23"), log.split("\n").pop());
});

await check("upload through a button's file chooser", async () => {
  await agent.call("browser_upload", { tabId, ref: refs["Upload via button"], paths: [uploadFile] });
  const log = await logText();
  assert(log.includes("hidden file chosen: agent-tabs-upload-test.txt"), log.split("\n").pop());
});

await check("upload of a hidden file is refused", async () => {
  let refused = false;
  try {
    await agent.call("browser_upload", { tabId, selector: "#file", paths: [path.join(os.homedir(), ".zshrc")] });
  } catch (error) {
    refused = /not allowed/.test(error.message);
  }
  assert(refused, "~/.zshrc upload was not refused");
});

await check("download is listed", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Download a file"] });
  await new Promise((r) => setTimeout(r, 1500));
  const { data } = await agent.call("browser_downloads", { tabId });
  const download = data.downloads.find((d) => d.file === "agent-tabs-test.txt");
  assert(download?.path && fs.existsSync(download.path), JSON.stringify(data));
  fs.rmSync(download.path); // don't leave test files in ~/Downloads
  return JSON.stringify(download);
});

await check("hover", async () => {
  await agent.call("browser_hover", { tabId, selector: "#hover-target" });
  assert((await logText()).includes("hovered"), "log missing");
});

await check("drag and drop", async () => {
  await agent.call("browser_drag", { tabId, from: { selector: "#drag" }, to: { selector: "#drop" } });
  const log = await logText();
  assert(log.includes("dropped") || log.includes("mouseup on drop zone"), log.split("\n").pop());
  return log.split("\n").pop();
});

await check("click in shadow DOM", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Shadow button"] });
  assert((await logText()).includes("shadow clicked"), "log missing");
});

await check("click in iframe", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Frame button"] });
  const { texts } = await agent.call("browser_snapshot", { tabId, filter: "Frame clicked" });
  assert(texts[1].includes("Frame clicked"), texts[1]);
});

await check("SPA route change and wait_for text", async () => {
  await agent.call("browser_click", { tabId, text: "Route two", exact: true });
  const { data } = await agent.call("browser_wait_for", { tabId, url: "#/two", text: "Route: #/two", timeoutMs: 5000 });
  assert(data.matched, JSON.stringify(data));
  await agent.call("browser_click", { tabId, ref: refs["Load content after 1.5 s"] });
  const waited = await agent.call("browser_wait_for", { tabId, text: "Loaded later", timeoutMs: 5000 });
  assert(waited.data.matched, JSON.stringify(waited.data));
  return `waited ${waited.data.waitedMs} ms`;
});

await check("wait_for network idle after fetch", async () => {
  await agent.call("browser_click", { tabId, ref: refs["Fetch"] });
  const { data } = await agent.call("browser_wait_for", { tabId, networkIdle: true, text: "fetch done", timeoutMs: 8000 });
  assert(data.matched, JSON.stringify(data));
});

await check("long page: scroll, paged text, filtered snapshot", async () => {
  const { data } = await agent.call("browser_scroll", { tabId, to: "bottom" });
  assert(data.position.scrollY > 10000, JSON.stringify(data.position));
  let offset = 0;
  let found = false;
  let pages = 0;
  while (offset !== undefined && pages < 20) {
    const page = await agent.call("browser_get_text", { tabId, offset, maxChars: 20000 });
    found ||= page.texts[1].includes("END-OF-LONG-PAGE");
    offset = page.data.nextOffset;
    pages++;
  }
  assert(found, "end marker not found by paging");
  const snap = await agent.call("browser_snapshot", { tabId, filter: "END-OF-LONG-PAGE" });
  assert(snap.texts[1].includes("END-OF-LONG-PAGE"), snap.texts[1]);
  const scrolled = await agent.call("browser_scroll", { tabId, direction: "up", amount: 600 });
  assert(scrolled.data.position.scrollY < data.position.scrollY, "wheel scroll up did nothing");
  return `${pages} text pages`;
});

await check("screenshots of the hidden tab: viewport, full page, element", async () => {
  const shot = await agent.call("browser_screenshot", { tabId });
  assert(shot.images[0]?.data.length > 1000, "no image");
  const full = await agent.call("browser_screenshot", { tabId, fullPage: true });
  const element = await agent.call("browser_screenshot", { tabId, selector: "#consent, h1" });
  const meta = JSON.parse(shot.texts[0]);
  const fullMeta = JSON.parse(full.texts[0]);
  const elementMeta = JSON.parse(element.texts[0]);
  assert(fs.existsSync(meta.savedTo), "screenshot file missing");
  assert(fullMeta.height > meta.height, "full page not taller");
  return `viewport ${meta.width}x${meta.height}, full ${fullMeta.width}x${fullMeta.height}, element ${elementMeta.width}x${elementMeta.height}, saved ${meta.savedTo}`;
});

await check("evaluate works; cookie access refused", async () => {
  const { data } = await agent.call("browser_evaluate", { tabId, expression: "document.title" });
  assert(data.result === '"agent-tabs fixture"', data.result);
  let refused = false;
  try {
    await agent.call("browser_evaluate", { tabId, expression: "document.cookie" });
  } catch (error) {
    refused = /cookies/.test(error.message);
  }
  assert(refused, "document.cookie was not refused");
});

await check("console messages are captured", async () => {
  await agent.call("browser_evaluate", { tabId, expression: "console.warn('agent-tabs console test'); 1" });
  const { data } = await agent.call("browser_console", { tabId });
  assert(data.entries.some((e) => e.text.includes("agent-tabs console test")), JSON.stringify(data.entries.slice(-3)));
});

await check("navigate, back, forward, reload", async () => {
  await agent.call("browser_click", { tabId, text: "Same-tab link" });
  let { data } = await agent.call("browser_navigate", { tabId, action: "back" });
  assert(data.url.endsWith("index.html") || data.url.includes("index.html#"), data.url);
  ({ data } = await agent.call("browser_navigate", { tabId, action: "forward" }));
  assert(data.url.includes("page2.html"), data.url);
  ({ data } = await agent.call("browser_navigate", { tabId, action: "reload" }));
  assert(data.title === "agent-tabs page 2", data.title);
});

await check("deny list in config.json blocks a site", async () => {
  const configFile = path.join(os.homedir(), ".config", "agent-tabs", "config.json");
  if (fs.existsSync(configFile)) return "skipped: a real config.json exists";
  fs.writeFileSync(configFile, JSON.stringify({ deny: ["denied.example.com"] }));
  try {
    await new Promise((r) => setTimeout(r, 1000)); // the broker reloads the config
    let blocked = false;
    try {
      await agent.call("browser_navigate", { tabId, url: "https://denied.example.com/" });
    } catch (error) {
      blocked = /deny list/.test(error.message);
    }
    assert(blocked, "denied.example.com not blocked");
  } finally {
    fs.rmSync(configFile, { force: true });
    await new Promise((r) => setTimeout(r, 1000));
  }
});

await check("fill_login from (fake) Bitwarden: password never returned; authenticator step; sign-in popup", async () => {
  const configFile = path.join(os.homedir(), ".config", "agent-tabs", "config.json");
  if (fs.existsSync(configFile)) return "skipped: a real config.json exists";
  fs.writeFileSync(configFile, JSON.stringify({ bitwardenCommand: path.resolve("tests/fake-bw.mjs") }));
  try {
    await new Promise((r) => setTimeout(r, 1000));
    await agent.call("browser_navigate", { tabId, url: FIXTURE.replace("index.html", "login.html") });
    const filled = await agent.call("browser_fill_login", { tabId });
    assert(filled.data.filled.includes("username") && filled.data.filled.includes("password") && filled.data.typed, JSON.stringify(filled.data));
    assert(!filled.texts.join(" ").includes("correct horse"), "the password leaked into the tool result");
    await agent.call("browser_click", { tabId, text: "Sign in", exact: true });
    const log = (await agent.call("browser_get_text", { tabId, selector: "#log" })).texts[1];
    assert(log.includes("signed in as agent@example.com with 13-char password"), log);
    const totp = await agent.call("browser_fill_login", { tabId, totp: true });
    assert(totp.data.filled.includes("totp"), JSON.stringify(totp.data));
    await agent.call("browser_click", { tabId, text: "Verify", exact: true });
    assert((await agent.call("browser_get_text", { tabId, selector: "#log" })).texts[1].includes("otp 123456"), "otp not filled");
    const actions = fs.readFileSync(path.join(os.homedir(), "Library", "Logs", "agent-tabs", "actions.log"), "utf8");
    assert(!actions.includes("correct horse") && !actions.includes("123456"), "a secret reached the action log");
    // A sign-in popup opens for real (so the page keeps its window.opener handle), which brings
    // Chrome to the front. Only checked when asked: E2E_SIGNIN_POPUP=1 npm run test:e2e
    if (!process.env.E2E_SIGNIN_POPUP) return "sign-in popup not checked (set E2E_SIGNIN_POPUP=1; it brings Chrome forward)";
    const popup = await agent.call("browser_click", { tabId, text: "Sign in with Google" });
    await new Promise((r) => setTimeout(r, 1500));
    const tabs = (await agent.call("browser_list_tabs")).data.tabs;
    const signIn = tabs.find((t) => t.url?.includes("accounts.google.com"));
    assert(signIn, `no sign-in popup tab: ${JSON.stringify(tabs.map((t) => t.url))}; notes ${JSON.stringify(popup.data.notes)}`);
    assert((await agent.call("browser_get_text", { tabId, selector: "#log" })).texts[1].includes("popup returned true"), "window.open did not return a real window");
    await agent.call("browser_close_tab", { tabId: signIn.tabId });
    return popup.data.notes?.[0];
  } finally {
    fs.rmSync(configFile, { force: true });
    await new Promise((r) => setTimeout(r, 1000));
  }
});

await check("payment guard: a quiz with Stripe's hidden frame is not a payment page", async () => {
  const { data } = await agent.call("browser_navigate", { tabId, url: FIXTURE.replace("index.html", "quiz.html") });
  assert(!data.notes?.some((n) => /checkout or payment page/.test(n)), `quiz flagged as payment page: ${JSON.stringify(data.notes)}`);
  const click = await agent.call("browser_click", { tabId, text: "Continue" });
  assert(click.data.title === "Quiz step 2", `Continue click didn't run: ${JSON.stringify(click.data)}`);
});

await check("payment guard: checkout page is flagged; acting needs allowPayment", async () => {
  const { data } = await agent.call("browser_navigate", { tabId, url: FIXTURE.replace("index.html", "checkout.html") });
  assert(data.notes?.some((n) => /checkout or payment page/.test(n)), `no payment note: ${JSON.stringify(data)}`);
  let refused = "";
  try {
    await agent.call("browser_click", { tabId, text: "Pay NOK 1,119" });
  } catch (error) {
    refused = error.message;
  }
  assert(/allowPayment/.test(refused), `click not refused: ${refused}`);
  await agent.call("browser_snapshot", { tabId }); // reading is fine
  await agent.call("browser_click", { tabId, text: "Pay NOK 1,119", allowPayment: true });
  assert((await agent.call("browser_get_text", { tabId, selector: "#log" })).texts[1].includes("paid (test)"), "allowPayment click did not land");
  await agent.call("browser_navigate", { tabId, action: "back" });
  // A Vy-style payment step: no card fields yet, but payment methods and "Complete payment".
  const vy = await agent.call("browser_navigate", { tabId, url: FIXTURE.replace("index.html", "booking-v2/abc/payment.html") });
  assert(vy.data.notes?.some((n) => /checkout or payment page/.test(n)), `vy-style page not flagged: ${JSON.stringify(vy.data)}`);
  let vyRefused = "";
  try {
    await agent.call("browser_click", { tabId, text: "Complete payment" });
  } catch (error) {
    vyRefused = error.message;
  }
  assert(/allowPayment/.test(vyRefused), `Complete payment click not refused: ${vyRefused}`);
  await agent.call("browser_navigate", { tabId, action: "back" });
});

await check("SPA back/forward returns promptly", async () => {
  await agent.call("browser_navigate", { tabId, url: FIXTURE });
  await agent.call("browser_handle_cookie_banner", { tabId }); // in a short window it covers the links
  await agent.call("browser_click", { tabId, text: "Route one", exact: true });
  await agent.call("browser_click", { tabId, text: "Route two", exact: true });
  const started = Date.now();
  const { data } = await agent.call("browser_navigate", { tabId, action: "back" });
  assert(data.url.endsWith("#/one"), data.url);
  assert(Date.now() - started < 5000 && !data.notes?.some((n) => /still loading/.test(n)), `slow or flagged: ${JSON.stringify(data)}`);
});

await check("isolation: another agent can't see or touch this agent's tabs", async () => {
  const { data } = await other.call("browser_list_tabs");
  assert(data.tabs.length === 0, `other agent sees ${data.tabs.length} tabs`);
  let refused = false;
  try {
    await other.call("browser_snapshot", { tabId });
  } catch (error) {
    refused = /not one of this agent's tabs/.test(error.message);
  }
  assert(refused, "other agent could read the tab");
});

await check("keep_tab toggles", async () => {
  const kept = await agent.call("browser_keep_tab", { tabId });
  const unkept = await agent.call("browser_keep_tab", { tabId, keep: false });
  assert(kept.data.kept === true && unkept.data.kept === false, "keep flags wrong");
});

await check("full-page screenshot of a scrolled page keeps the scroll position", async () => {
  const { data } = await agent.call("browser_open_tab", { url: FIXTURE.replace("index.html", "sticky.html") });
  await agent.call("browser_scroll", { tabId: data.tabId, text: "Departure 25" });
  const before = await agent.call("browser_evaluate", { tabId: data.tabId, expression: "scrollY" });
  const shot = await agent.call("browser_screenshot", { tabId: data.tabId, fullPage: true });
  assert(shot.images.length === 1, "no image");
  const after = await agent.call("browser_evaluate", { tabId: data.tabId, expression: "scrollY" });
  assert(Number(before.data.result) > 1000 && after.data.result === before.data.result, `scrollY ${before.data.result} -> ${after.data.result}`);
  await agent.call("browser_close_tab", { tabId: data.tabId });
});

await check("close_tab closes a page with a \"Leave site?\" prompt", async () => {
  const { data } = await agent.call("browser_open_tab", { url: FIXTURE.replace("index.html", "leave.html") });
  await agent.call("browser_type", { tabId: data.tabId, selector: "#name", text: "Alex" }); // user activation arms the prompt
  const started = Date.now();
  await agent.call("browser_close_tab", { tabId: data.tabId });
  assert(Date.now() - started < 5000, `close_tab took ${Date.now() - started} ms`);
  const { data: list } = await agent.call("browser_list_tabs", {});
  assert(!list.tabs.some((t) => t.tabId === data.tabId), "tab still listed");
});

await check("closing the session closes all its tabs", async () => {
  const before = await tabCount();
  await agent.close();
  await other.close();
  await new Promise((r) => setTimeout(r, 1000));
  const log = fs.readFileSync(path.join(os.homedir(), "Library", "Logs", "agent-tabs", "actions.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ended = log.reverse().find((e) => e.event === "session_ended" && e.label === "e2e");
  assert(ended?.closedTabs === before, `closed ${ended?.closedTabs} of ${before}`);
  return `closed ${ended.closedTabs} tabs`;
});

fs.rmSync(uploadFile, { force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (process.env.RESULTS_FILE) fs.writeFileSync(process.env.RESULTS_FILE, JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
