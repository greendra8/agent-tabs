// Accessibility-style page snapshot with element refs, built from Chrome's own accessibility tree
// (so roles and names match what assistive tech sees, and shadow DOM is included). Iframes,
// including cross-origin ones in their own CDP session, are expanded in place.
//
// Output, one line per node:
//   - button "Search" [ref=e14]
//   - textbox "From" [ref=e9]: Oslo S
//   - checkbox "I agree" [checked=false] [ref=e22]

import { send, refFor } from "./cdp.js";

const SKIP_ROLES = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
// Unnamed containers whose children are shown in their place.
const TRANSPARENT_ROLES = new Set(["none", "generic", "presentation", "GenericContainer", "group", "Section", "paragraph", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Div", "Pre", "Abbr", "Ruby", "time", "emphasis", "strong", "Mark", "subscript", "superscript", "code", "DescriptionListDetail", "DescriptionListTerm", "contentinfo", "Canvas"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "treeitem", "ComboBoxGrouping", "ComboBoxMenuButton", "TextFieldWithComboBox", "PopUpButton", "DisclosureTriangle", "SearchBox", "ToggleButton"]);
const SHOWN_PROPERTIES = ["checked", "selected", "expanded", "pressed", "disabled", "required", "invalid", "level", "readonly", "modal"];
const ALWAYS_SHOWN = new Set(["checked", "expanded", "pressed"]); // shown even when false
const MAX_TEXT = 300;
const MAX_FRAMES = 12;
const CONSENT_PATTERN = /cookie|consent|privacy|gdpr|samtykke|informasjonskapsler|datenschutz/i;

export async function snapshot(st, { filter, rootRef, interactiveOnly = false, maxChars = 40000 } = {}) {
  const lines = [];
  const context = { st, lines, frames: 0, interactiveOnly, filter: filter?.toLowerCase(), consent: false };
  let root = null;
  let rootSession;
  if (rootRef) {
    root = st.refs.get(rootRef);
    if (!root) throw new Error(`Unknown ref ${rootRef}; take a new snapshot.`);
    rootSession = root.sessionId;
  }
  await emitFrame(context, rootSession, undefined, 0, root?.backendNodeId);

  let text = "";
  let shown = 0;
  for (const line of lines) {
    if (text.length + line.length + 1 > maxChars) break;
    text += line + "\n";
    shown++;
  }
  const notes = [];
  if (shown < lines.length) notes.push(`Snapshot truncated: showed ${shown} of ${lines.length} lines. Use filter, rootRef, interactiveOnly or a larger maxChars to see more.`);
  if (context.consent) notes.push("A cookie or consent banner seems to be present; browser_handle_cookie_banner can dismiss it.");
  return { text, notes, lineCount: lines.length };
}

async function emitFrame(context, sessionId, frameId, depth, rootBackendNodeId) {
  const { nodes } = await send(context.st.tabId, "Accessibility.getFullAXTree", frameId ? { frameId } : {}, { sessionId });
  if (!nodes?.length) return;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  let start = nodes[0];
  if (rootBackendNodeId !== undefined) {
    start = nodes.find((node) => node.backendDOMNodeId === rootBackendNodeId);
    if (!start) throw new Error("That ref is no longer in the page; take a new snapshot.");
  }
  await emitNode(context, byId, start, sessionId, depth, start.role?.value === "RootWebArea");
}

async function emitNode(context, byId, node, sessionId, depth, isRoot = false) {
  const children = (node.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);
  const role = node.role?.value ?? "";
  const name = clean(node.name?.value);
  const emitChildren = async (childDepth) => {
    for (const child of children) await emitNode(context, byId, child, sessionId, childDepth);
  };

  if (isRoot) return emitChildren(depth);
  if (node.ignored || SKIP_ROLES.has(role)) return emitChildren(depth);
  if (role === "StaticText") {
    if (name) addLine(context, depth, "text", JSON.stringify(name), "", "", sessionId, node.backendDOMNodeId, false);
    return;
  }
  if (TRANSPARENT_ROLES.has(role) && !name) return emitChildren(depth);

  const props = Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value]));
  const interactive = INTERACTIVE_ROLES.has(role) || props.focusable === true;
  let attributes = "";
  for (const key of SHOWN_PROPERTIES) {
    // Tristate properties arrive as the strings "true", "false" and "mixed".
    const value = props[key] === "false" ? false : props[key] === "true" ? true : props[key];
    if (value === undefined || (value === false && !ALWAYS_SHOWN.has(key))) continue;
    attributes += key === "level" ? ` [level=${value}]` : ` [${key}=${value}]`;
  }
  if (role === "link" && typeof props.url === "string" && !props.url.startsWith("javascript:")) {
    attributes += ` [url=${shortLink(props.url)}]`;
  }
  const value = node.value?.value;
  const valueText = value !== undefined && value !== "" && String(value) !== name ? `: ${clean(String(value))}` : "";
  if (CONSENT_PATTERN.test(name) && /dialog|region|banner|alertdialog|Iframe/i.test(role)) context.consent = true;

  addLine(context, depth, role, name ? JSON.stringify(name) : "", attributes, valueText, sessionId, node.backendDOMNodeId, interactive);

  if (role === "Iframe" || role === "IframePresentational") {
    await emitIframe(context, node, sessionId, depth + 1);
    return;
  }
  // A child that only repeats this node's name adds nothing.
  if (children.length === 1 && children[0].role?.value === "StaticText" && clean(children[0].name?.value) === name) return;
  await emitChildren(depth + 1);
}

function addLine(context, depth, role, name, attributes, valueText, sessionId, backendNodeId, interactive) {
  if (context.interactiveOnly && !interactive) return;
  const ref = backendNodeId ? ` [ref=${refFor(context.st, sessionId, backendNodeId)}]` : "";
  const body = `- ${role}${name ? " " + name : ""}${attributes}${ref}${valueText}`;
  if (context.filter && !body.toLowerCase().includes(context.filter)) return;
  const indent = context.interactiveOnly || context.filter ? "" : "  ".repeat(Math.min(depth, 20));
  context.lines.push(indent + body);
}

async function emitIframe(context, node, sessionId, depth) {
  if (!node.backendDOMNodeId || context.frames >= MAX_FRAMES) return;
  context.frames++;
  const tabId = context.st.tabId;
  try {
    const { node: described } = await send(tabId, "DOM.describeNode", { backendNodeId: node.backendDOMNodeId, depth: 1 }, { sessionId });
    const frameId = described.frameId ?? described.contentDocument?.frameId;
    if (!frameId) return;
    // A cross-origin frame lives in its own target; its CDP session is keyed by frame id.
    const child = [...context.st.children].find(([, info]) => info.frameId === frameId);
    if (child) await emitFrame(context, child[0], undefined, depth);
    else if (described.contentDocument) await emitFrame(context, sessionId, frameId, depth);
  } catch {
    // Frames that are mid-navigation or detached are skipped.
  }
}

// Links keep their origin and path; long query strings (mostly tracking) are elided.
function shortLink(url) {
  const queryAt = url.indexOf("?");
  const trimmed = queryAt !== -1 && url.length > 100 ? url.slice(0, queryAt) + "?…" : url;
  return trimmed.length > 150 ? trimmed.slice(0, 150) + "…" : trimmed;
}

function clean(value) {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text;
}
