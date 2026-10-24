// Trusted mouse and keyboard input through CDP. Works on hidden tabs; nothing here changes focus.

import { send } from "./cdp.js";

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_ALIASES = { Ctrl: "Control", Cmd: "Meta", Command: "Meta", Option: "Alt", ControlOrMeta: "Meta" };

// key -> [code, windowsVirtualKeyCode, text]
const KEYS = {
  Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8],
  Delete: ["Delete", 46], Insert: ["Insert", 45], " ": ["Space", 32, " "], Space: ["Space", 32, " "],
  ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
  Shift: ["ShiftLeft", 16], Control: ["ControlLeft", 17], Alt: ["AltLeft", 18], Meta: ["MetaLeft", 91],
  "-": ["Minus", 189, "-"], "=": ["Equal", 187, "="], "[": ["BracketLeft", 219, "["], "]": ["BracketRight", 221, "]"],
  "\\": ["Backslash", 220, "\\"], ";": ["Semicolon", 186, ";"], "'": ["Quote", 222, "'"], ",": ["Comma", 188, ","],
  ".": ["Period", 190, "."], "/": ["Slash", 191, "/"], "`": ["Backquote", 192, "`"],
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = [`F${i}`, 111 + i];
for (let i = 0; i <= 9; i++) KEYS[String(i)] = [`Digit${i}`, 48 + i, String(i)];
for (let c = 97; c <= 122; c++) {
  const key = String.fromCharCode(c);
  KEYS[key] = [`Key${key.toUpperCase()}`, c - 32, key];
}

// Chrome on macOS ignores synthetic editing shortcuts unless the editing command is named.
// Control+A is mapped like Meta+A because agents often send the Windows/Linux shortcut.
const MAC_COMMANDS = {
  "Meta+a": "selectAll", "Control+a": "selectAll", "Meta+c": "copy", "Meta+x": "cut", "Meta+v": "paste",
  "Meta+z": "undo", "Meta+Shift+z": "redo", "Control+c": "copy", "Control+x": "cut", "Control+v": "paste", "Control+z": "undo",
};

function parseCombo(combo) {
  const parts = combo.split("+");
  // "Control++" means Control and the "+" key.
  const keyName = combo.endsWith("++") ? "+" : parts.pop();
  if (combo.endsWith("++")) parts.splice(-2);
  const modifiers = parts.map((m) => MODIFIER_ALIASES[m] ?? m);
  for (const m of modifiers) if (!(m in MODIFIER_BITS)) throw new Error(`Unknown modifier "${m}" in "${combo}"`);
  return { modifiers, keyName };
}

function keyInfo(keyName, shift) {
  const lower = keyName.length === 1 ? keyName.toLowerCase() : keyName;
  const entry = KEYS[keyName] ?? KEYS[lower];
  if (!entry) {
    if (keyName.length === 1) return { key: keyName, code: "", keyCode: 0, text: keyName };
    throw new Error(`Unknown key "${keyName}". Use names like Enter, Tab, Escape, ArrowDown, PageDown, F5, a, 1.`);
  }
  const [code, keyCode, text] = entry;
  const upperCase = /^[a-z]$/.test(lower) && (shift || keyName !== lower);
  const key = upperCase ? lower.toUpperCase() : keyName;
  return { key, code, keyCode, text: upperCase ? key : text };
}

export async function pressCombo(tabId, combo) {
  const { modifiers, keyName } = parseCombo(combo);
  let bits = 0;
  for (const m of modifiers) {
    bits |= MODIFIER_BITS[m];
    const [code, keyCode] = KEYS[m];
    await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: m, code, windowsVirtualKeyCode: keyCode, modifiers: bits });
  }
  const info = keyInfo(keyName, modifiers.includes("Shift"));
  const commandKey = [...modifiers.filter((m) => m !== "Shift"), ...(modifiers.includes("Shift") ? ["Shift"] : []), keyName.toLowerCase()].join("+");
  const command = MAC_COMMANDS[commandKey];
  // Text is only produced when no modifier other than Shift is held.
  const producesText = info.text !== undefined && (bits & ~MODIFIER_BITS.Shift) === 0;
  await send(tabId, "Input.dispatchKeyEvent", {
    type: producesText ? "keyDown" : "rawKeyDown",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    modifiers: bits,
    ...(producesText ? { text: info.text, unmodifiedText: info.text } : {}),
    ...(command ? { commands: [command] } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: bits });
  for (const m of [...modifiers].reverse()) {
    bits &= ~MODIFIER_BITS[m];
    const [code, keyCode] = KEYS[m];
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: m, code, windowsVirtualKeyCode: keyCode, modifiers: bits });
  }
}

// Types character by character with key events, for widgets that listen to keydown/keypress.
export async function typeSlowly(tabId, text, delayMs = 30) {
  for (const char of text) {
    if (char === "\n") {
      await pressCombo(tabId, "Enter");
    } else {
      const info = KEYS[char] ?? KEYS[char.toLowerCase()];
      const base = { key: char, code: info?.[0] ?? "", windowsVirtualKeyCode: info?.[1] ?? 0 };
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base, text: char, unmodifiedText: char });
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export function insertText(tabId, text) {
  return send(tabId, "Input.insertText", { text });
}

export function modifierBits(modifiers = []) {
  return modifiers.reduce((bits, m) => bits | (MODIFIER_BITS[MODIFIER_ALIASES[m] ?? m] ?? 0), 0);
}

export async function mouseMove(tabId, x, y, modifiers = 0) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers });
}

// Press and release are sent separately so a dialog opened by the press handler can't hang the
// release; the caller races the whole click against dialogs.
export async function mouseClick(tabId, x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) {
  await mouseMove(tabId, x, y, modifiers);
  for (let count = 1; count <= clickCount; count++) {
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count, modifiers });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count, modifiers });
  }
}

export async function mouseWheel(tabId, x, y, deltaX, deltaY) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}
