// Functions that run inside the page through CDP (Runtime.evaluate / Runtime.callFunctionOn).
// They are serialised with toString(), so each must be self-contained: no imports, no closures.
// Functions called on an element receive it as `this`.

// document.querySelector that also searches open shadow roots.
export function deepQuerySelector(selector) {
  const search = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const inner = search(el.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  };
  return search(document);
}

// The smallest visible element whose text matches, preferring interactive elements.
export function findByText(text, exact) {
  const wanted = text.replace(/\s+/g, " ").trim().toLowerCase();
  const labelOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().toLowerCase();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const interactive = "a, button, input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=radio], [onclick], [tabindex]";
  let best = null;
  const consider = (el) => {
    const label = labelOf(el);
    if (!(exact ? label === wanted : label.includes(wanted)) || !visible(el)) return;
    const score = (el.matches(interactive) ? 0 : 1_000_000) + (label === wanted ? 0 : 100_000) + label.length;
    if (!best || score < best.score) best = { el, score };
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      consider(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return best?.el ?? null;
}

export function pageText(offset, maxChars) {
  const text = document.body?.innerText ?? "";
  return { total: text.length, text: text.slice(offset, offset + maxChars) };
}

export function elementText(offset, maxChars) {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  const text = el.innerText ?? el.textContent ?? "";
  return { total: text.length, text: text.slice(offset, offset + maxChars) };
}

// Returns null when a click at the element's centre is fine, otherwise a short description of
// the overlay that would swallow it. Only overlays count: a fixed or sticky layer, or a modal
// dialog, that doesn't contain the target (cookie banners, modals, sticky bars). In-flow layers
// such as styling wrappers, ripples and labels receive the click just as a person's would.
export function coveringElement(hit) {
  const target = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  const contains = (outer, inner) => {
    for (let node = inner; node; node = node.parentNode || node.host) if (node === outer) return true;
    return false;
  };
  if (!hit || contains(target, hit) || contains(hit, target)) return null;
  if (hit instanceof HTMLLabelElement && hit.control === target) return null;
  const el = hit.nodeType === Node.ELEMENT_NODE ? hit : hit.parentElement;
  if (getComputedStyle(el).pointerEvents === "none") return null; // can't take the click
  let overlay = null;
  for (let node = el; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement || node.getRootNode().host) {
    if (contains(node, target)) return null;
    const position = getComputedStyle(node).position;
    if (position === "fixed" || position === "sticky" || node.tagName === "DIALOG" || node.getAttribute("role") === "dialog" || node.getAttribute("aria-modal") === "true") {
      overlay = node;
      break;
    }
  }
  if (!overlay) return null;
  const id = el.id ? `#${el.id}` : "";
  const classes = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  const text = (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `<${el.tagName.toLowerCase()}${id}${classes}>${text ? ` "${text}"` : ""}`;
}

export function elementKind() {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  return {
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") ?? "").toLowerCase(),
    role: el.getAttribute("role") ?? "",
    checked: "checked" in el ? el.checked : el.getAttribute("aria-checked") === "true",
    multiple: Boolean(el.multiple),
    editable: el.isContentEditable,
  };
}

// Focuses the element and optionally selects its content, so typed text replaces it.
// Returns whether focus actually landed in the element.
export function focusAndSelect(selectAll) {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  el.focus({ preventScroll: true });
  if (selectAll) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      try {
        el.select();
      } catch {}
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  const active = el.getRootNode().activeElement ?? document.activeElement;
  return el === active || el.contains(active);
}

export function currentValue() {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  return "value" in el ? String(el.value) : el.innerText;
}

export function selectOptions(wanted) {
  const el = this;
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error("Not a <select> element. For custom dropdowns, click the control and then click the option.");
  }
  const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
  const options = [...el.options];
  const chosen = wanted.map((w) => options.find((o) => o.value === w) ?? options.find((o) => norm(o.label) === norm(w)) ?? options.find((o) => norm(o.label).includes(norm(w))));
  const missing = wanted.filter((_, i) => !chosen[i]);
  if (missing.length) {
    const available = options.slice(0, 40).map((o) => `"${o.label}" (${o.value})`).join(", ");
    throw new Error(`No option matching ${missing.map((m) => `"${m}"`).join(", ")}. Options: ${available}`);
  }
  for (const option of options) option.selected = el.multiple ? chosen.includes(option) || option.selected : option === chosen[0];
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return [...el.selectedOptions].map((o) => o.label);
}

export function scrollIntoViewCentre() {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  el.scrollIntoView({ block: "center", inline: "nearest" });
}

export function scrollPosition() {
  const root = document.scrollingElement ?? document.documentElement;
  return { scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), scrollHeight: root.scrollHeight, viewportHeight: innerHeight };
}

export function scrollPage(to, deltaX, deltaY) {
  const root = document.scrollingElement ?? document.documentElement;
  if (to === "top") root.scrollTo(0, 0);
  else if (to === "bottom") root.scrollTo(0, root.scrollHeight);
  else root.scrollBy(deltaX, deltaY);
}

export function scrollElementBy(deltaX, deltaY) {
  let el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))) {
    el = el.parentElement;
  }
  (el && el !== document.body ? el : document.scrollingElement).scrollBy(deltaX, deltaY);
}

export function textPresent(text) {
  return (document.body?.innerText ?? "").toLowerCase().includes(text.toLowerCase());
}

export function selectorState(selector, state) {
  const find = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const inner = find(el.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  };
  const el = find(document);
  if (state === "attached") return Boolean(el);
  if (state === "detached") return !el;
  const visible = Boolean(el) && (() => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  })();
  return state === "hidden" ? !visible : visible;
}

// Finds the button of a cookie/consent banner for the given choice ("reject" or "accept").
// Known consent platforms first, then button text in several languages, but only inside
// something that looks like a consent banner.
export function findConsentButton(choice) {
  const KNOWN = {
    reject: ["#onetrust-reject-all-handler", "#didomi-notice-disagree-button", "#CybotCookiebotDialogBodyButtonDecline", "[data-testid='uc-deny-all-button']", ".fc-cta-do-not-consent", ".cmpboxbtnno", ".sp_choice_type_REJECT_ALL", "#truste-consent-required", "[data-cookiefirst-action='reject']"],
    accept: ["#onetrust-accept-btn-handler", "#didomi-notice-agree-button", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "#CybotCookiebotDialogBodyButtonAccept", "[data-testid='uc-accept-all-button']", ".fc-cta-consent", ".cmpboxbtnyes", ".sp_choice_type_11", "#truste-consent-button", "[data-cookiefirst-action='accept']"],
  };
  const LABELS = {
    reject: /^no,? thanks?$|^(reject|decline|deny|refuse|disagree)( all)?( cookies| optional cookies| non-essential cookies| additional cookies)?$|^(use |allow |accept )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?$|^continue without (accepting|agreeing)$|^(avvis|avslå)( alle)?( informasjonskapsler)?$|^(kun|bare) (nødvendige|påkrevde)( informasjonskapsler)?$|^(alle )?ablehnen$|^nur (notwendige|erforderliche|essenzielle)( cookies)?( (erlauben|akzeptieren|zulassen|verwenden))?$|^(tout )?refuser( tout)?$|^continuer sans accepter$|^rechazar( todo| todas)?$|^rifiuta( tutto| tutti)?$|^(alles )?weigeren$|^(neka|avvisa)( alla)?$|^afvis( alle)?$/i,
    accept: /^(accept|allow|agree|ok|okay|got it|i agree|i accept|agree and (close|continue)|yes,? i agree)( all)?( cookies)?$|^(godta|aksepter|godkjenn|tillat)( alle)?( informasjonskapsler)?$|^jeg (godtar|forstår)$|^(alle )?(cookies )?akzeptieren$|^alle cookies akzeptieren$|^(zustimmen|einverstanden)$|^(tout )?accepter( tout)?$|^j'accepte$|^aceptar( todo| todas)?$|^accetta( tutto| tutti)?$|^(akkoord|accepteren)$|^(godkänn|acceptera)( alla)?$|^accepter alle$/i,
  };
  const CONTEXT = /cookie|consent|gdpr|privacy|cmp|onetrust|didomi|usercentrics|cookiebot|sp_message|qc-cmp|truste|samtykke|personvern|informasjonskapsler|datenschutz/i;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  for (const selector of KNOWN[choice]) {
    const el = all.find((candidate) => candidate.matches(selector) && visible(candidate));
    if (el) return el;
  }
  const inConsentContext = (el) => {
    if (/^consent\./.test(location.hostname)) return true;
    let node = el;
    for (let depth = 0; node && depth < 15; depth++) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const attrs = `${node.id} ${typeof node.className === "string" ? node.className : ""} ${node.getAttribute("aria-label") ?? ""}`;
        if (CONTEXT.test(attrs)) return true;
        const style = getComputedStyle(node);
        const floating = node.getAttribute("role") === "dialog" || node.getAttribute("aria-modal") === "true" || style.position === "fixed" || style.position === "sticky";
        if (floating && CONTEXT.test((node.textContent ?? "").slice(0, 3000))) return true;
      }
      node = node.parentNode || node.host;
    }
    return false;
  };
  const clickable = all.filter((el) => el.matches("button, a, [role=button], input[type=button], input[type=submit]") && visible(el));
  for (const el of clickable) {
    const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (label.length <= 60 && LABELS[choice].test(label) && inConsentContext(el)) return el;
  }
  return null;
}

export function shortLabel() {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  return (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

// Text of every element matching the selector, separated by "---", for lists of cards or rows.
export function selectorText(selector, offset, maxChars) {
  const els = [...document.querySelectorAll(selector)];
  const text = els.map((el) => (el.innerText ?? el.textContent ?? "").trim()).join("\n---\n");
  return { matches: els.length, total: text.length, text: text.slice(offset, offset + maxChars) };
}

// How many visible elements findByText would consider for this text.
export function countTextMatches(text, exact) {
  const wanted = text.replace(/\s+/g, " ").trim().toLowerCase();
  const interactive = "a, button, input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=radio], [onclick], [tabindex]";
  let count = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll(interactive)) {
      const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
      const rect = el.getBoundingClientRect();
      if ((exact ? label === wanted : label.includes(wanted)) && rect.width > 0 && rect.height > 0) count++;
    }
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return count;
}

// A short description of the element, for action results: role or tag plus its label.
export function describeElement() {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return label ? `${role} "${label}"` : role;
}

// For an element without a box: its label, else its nearest ancestor that has one.
export function visibleProxy() {
  const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
  const hasBox = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const label = el.labels?.[0] ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
  if (label && hasBox(label)) return label;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) if (hasBox(node)) return node;
  return null;
}

// Fills sign-in fields of this document (and same-site iframes) without focusing them, so
// password managers' in-page menus don't open. Returns which kinds were filled, never values.
export function fillCredentialFields(values, siteDomain, markOnly = false) {
  const baseDomain = (host) => {
    const parts = host.split(".");
    const twoLevel = parts.length > 2 && parts.at(-1).length === 2 && ["co", "com", "gov", "ac", "org", "net", "ltd", "plc"].includes(parts.at(-2));
    return parts.slice(twoLevel ? -3 : -2).join(".");
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !el.disabled && !el.readOnly;
  };
  // markOnly: tag the fields (data-agent-tabs-fill) so the caller can type into them for real.
  const setValue = (el, value, kind) => {
    if (markOnly && kind) {
      el.setAttribute("data-agent-tabs-fill", kind);
      return;
    }
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const docs = [];
  const collect = (doc) => {
    try {
      if (baseDomain(doc.location.hostname) !== siteDomain) return; // never fill another site's frame
      docs.push(doc);
      for (const frame of doc.querySelectorAll("iframe, frame")) {
        try {
          if (frame.contentDocument) collect(frame.contentDocument);
        } catch {}
      }
    } catch {}
  };
  collect(document);
  const inputsOf = (root) => {
    const found = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll("*")) {
        if (el instanceof HTMLInputElement) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return found;
  };
  const hint = (el) => `${el.name} ${el.id} ${el.getAttribute("aria-label") ?? ""} ${el.placeholder} ${el.autocomplete}`.toLowerCase();
  const OTP = /one-time-code|otp|totp|2fa|mfa|one.?time|verification|security.?code|auth(entication)?.?code|passcode|digit/;
  const filled = new Set();
  for (const doc of docs) {
    const inputs = inputsOf(doc).filter(visible);
    const passwords = inputs.filter((el) => el.type === "password" && el.autocomplete !== "new-password");
    if (values.totp) {
      const otp = inputs.filter((el) => el.type !== "password" && (el.autocomplete === "one-time-code" || OTP.test(hint(el))));
      const boxes = otp.filter((el) => el.maxLength === 1);
      if (boxes.length >= values.totp.length) {
        [...values.totp].forEach((digit, i) => setValue(boxes[i], digit));
        filled.add("totp");
      } else if (otp.length) {
        setValue(otp[0], values.totp, "totp");
        filled.add("totp");
      }
    }
    if (values.password && passwords.length) {
      setValue(passwords[0], values.password, "password");
      filled.add("password");
    }
    if (values.username) {
      const textual = inputs.filter((el) => ["text", "email", "tel"].includes(el.type) && !OTP.test(hint(el)));
      let user =
        textual.find((el) => /^(username|email)\b/.test(el.autocomplete)) ??
        textual.find((el) => el.type === "email") ??
        textual.find((el) => /user|email|e-mail|login|account|apple.?id|phone|identifier/.test(hint(el)));
      if (!user && passwords.length) {
        // The text field just before the password field.
        user = textual.filter((el) => el.compareDocumentPosition(passwords[0]) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
      }
      if (user) {
        setValue(user, values.username, "username");
        filled.add("username");
      }
    }
  }
  return [...filled];
}

// Removes the data-agent-tabs-fill markers from this document and its same-site iframes.
export function clearFillMarkers() {
  const clear = (doc) => {
    doc.querySelectorAll("[data-agent-tabs-fill]").forEach((el) => el.removeAttribute("data-agent-tabs-fill"));
    for (const frame of doc.querySelectorAll("iframe, frame")) {
      try {
        if (frame.contentDocument) clear(frame.contentDocument);
      } catch {}
    }
  };
  clear(document);
}

// Length of the element's value, so a typed fill can be checked without reading the secret.
export function valueLength() {
  return String(this.value ?? "").length;
}

// Signs that this page takes payment. Returns the signals found (empty when none).
export function paymentSignals() {
  const signals = [];
  const path = location.pathname.toLowerCase();
  if (/(^|\/|-)(checkout|payment|payments|pay|betaling|betal|kasse|kassa|bezahlen|zahlung|paiement|pago|purchase|confirm|confirmation|order-review|review-order)(\/|-|\.|$)/.test(path) || /^(checkout|pay|payment|payments|secure)\./.test(location.hostname)) {
    signals.push("checkout URL");
  }
  const cardField = document.querySelector('input[autocomplete^="cc-"], input[name*="cardnumber" i], input[name*="card_number" i], input[id*="cardnumber" i], input[name*="cvc" i], input[name*="cvv" i]');
  if (cardField) signals.push("card fields");
  const PROVIDERS = /js\.stripe\.com|checkout\.stripe\.com|adyen|klarna|vipps|nets\.eu|netaxept|paypal|braintree|worldpay|checkout\.com|cybersource|payex|nexi|dibs|mollie|swedbank|mobilepay/i;
  if ([...document.querySelectorAll("iframe[src], form[action]")].some((el) => PROVIDERS.test(el.getAttribute("src") ?? el.getAttribute("action") ?? ""))) {
    signals.push("payment provider frame");
  }
  // A button that pays or places the order, in a few languages ("Complete payment", "Betal nå",
  // "Place order", "Buy now", "Bestill og betal", "Zahlungspflichtig bestellen").
  const PAY_BUTTON = /\b(pay|payment|betal|betaling|kjøp|purchase|place order|buy now|complete (order|booking)|confirm and pay|book and pay|bestill og betal|fullfør (kjøp|betaling|bestilling)|zahlungspflichtig|jetzt kaufen|payer|paiement)\b/i;
  const labelOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const buttons = [...document.querySelectorAll("button, input[type=submit], [role=button]")];
  if (buttons.some((el) => { const label = labelOf(el); return label.length < 60 && PAY_BUTTON.test(label); })) signals.push("pay button");
  // Payment method choices: a page offering two or more is a payment page even before card
  // fields or a provider's frame load.
  const METHODS = /\b(apple pay|google pay|vipps|klarna|paypal|mobilepay|swish|sofort|ideal|credit card|debit card|kort|bankkort)\b/i;
  const methods = new Set();
  for (const el of document.querySelectorAll("button, label, [role=radio], [role=button], input[type=radio], img[alt]")) {
    const match = (labelOf(el) || el.getAttribute("alt") || "").match(METHODS);
    if (match) methods.add(match[1].toLowerCase());
  }
  if (methods.size >= 2) signals.push("payment methods");
  return signals;
}

// Draws the agent's cursor so someone watching the tab can follow it, with the agent's name tag
// and a double ripple on each click. style "claude" is the slowly turning Claude mark (for Claude
// clients); "neutral" is a blue arrow. Both have a white outline and shadow, so they show on light
// and dark pages.
// Rendered in a closed shadow root (page CSS can't touch it) and ignores the pointer.
export function moveAgentCursor(x, y, clicking, durationMs, label, style = "claude") {
  const KEY = Symbol.for("agent-tabs-cursor");
  const COLOR = style === "claude" ? "#d97757" : "#2563eb";
  let ui = globalThis[KEY];
  if (ui && ui.style !== style) ui.host.remove(); // the config changed: redraw in the new style
  if (!ui || !ui.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.id = "__agent_tabs_cursor";
    host.style.cssText = "position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    // The Claude mark (path from Simple Icons, viewBox 0 0 24 24), drawn twice: a white copy with a
    // wide stroke behind gives it an outline that shows on dark pages.
    const CLAUDE = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
    // A plain pointer arrow with its tip at (3, 2), for other clients.
    const ARROW = "M3 2v17.5l4.6-4.3 2.9 6.6 3.1-1.3-2.9-6.6h6.4Z";
    // A constructed stylesheet, not a <style> element: strict page CSPs (gov.uk) block those.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
        .cursor { position: fixed; left: 0; top: 0; will-change: transform; transition-property: transform, width, height, opacity; transition-timing-function: cubic-bezier(.22, 1, .36, 1); }
        .press { margin: -13px 0 0 -13px; width: 26px; height: 26px; transition: transform 180ms cubic-bezier(.34, 1.56, .64, 1); }
        .pop .press { transform: scale(1.3); }
        .mark { display: block; filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .5)) drop-shadow(0 0 3px rgba(0, 0, 0, .25)); }
        .claude .mark { animation: spin 9s linear infinite; }
        .neutral .press { margin: -2px 0 0 -3px; width: 22px; height: 22px; transform-origin: 3px 2px; }
        .neutral.pop .press { transform: scale(1.2); }
        .tag { position: absolute; left: 13px; top: 13px; padding: 3px 9px 4px; border-radius: 999px; background: ${COLOR}; color: #fff; white-space: nowrap;
               font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
               box-shadow: 0 2px 8px rgba(0, 0, 0, .3), inset 0 0 0 1px rgba(255, 255, 255, .3); }
        .neutral .tag { left: 15px; top: 19px; }
        .ring { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2.5px solid ${COLOR};
                box-shadow: 0 0 0 1px rgba(255, 255, 255, .45); opacity: 0; animation: ring 620ms cubic-bezier(.22, 1, .36, 1) forwards; }
        .ring.second { animation-delay: 130ms; border-width: 1.5px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes ring { from { transform: scale(.3); opacity: .95; } to { transform: scale(1.8); opacity: 0; } }
      `);
    root.adoptedStyleSheets = [sheet];
    const mark = style === "claude"
      ? `<svg class="mark" width="26" height="26" viewBox="-1.5 -1.5 27 27"><path d="${CLAUDE}" fill="#fff" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="${CLAUDE}" fill="${COLOR}"/></svg>`
      : `<svg class="mark" width="22" height="22" viewBox="0 0 24 24"><path d="${ARROW}" fill="${COLOR}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    root.innerHTML = `<div class="cursor ${style}"><div class="press">${mark}</div><div class="tag"></div></div>`;
    (document.body ?? document.documentElement).appendChild(host);
    ui = globalThis[KEY] = { host, root, style, cursor: root.querySelector(".cursor"), tag: root.querySelector(".tag") };
  }
  ui.tag.textContent = label;
  ui.cursor.style.transitionDuration = `${durationMs}ms`;
  ui.cursor.style.transform = `translate(${x}px, ${y}px)`;
  if (clicking) {
    setTimeout(() => {
      ui.cursor.classList.add("pop");
      setTimeout(() => ui.cursor.classList.remove("pop"), 180);
      for (const className of ["ring", "ring second"]) {
        const ring = Object.assign(document.createElement("div"), { className });
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        ui.root.appendChild(ring);
        setTimeout(() => ring.remove(), 800);
      }
    }, durationMs);
  }
}
