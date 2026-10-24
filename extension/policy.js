// Which URLs agent tabs may load. The broker sends the allow and deny lists from
// ~/.config/agent-tabs/config.json when it connects; this module only matches them.
//
// Pattern syntax (case-insensitive):
//   example.com          the host and all its subdomains
//   *bank*               a glob over the whole host name
//   google.com/payments  a host pattern plus a path prefix

let allowRules = [];
let denyRules = [];
export const policyFlags = { paymentGuard: true };

const BLOCKED_SCHEMES = new Set(["file:", "chrome:", "chrome-extension:", "chrome-untrusted:", "devtools:", "view-source:", "javascript:"]);

export function setPolicy({ allow = [], deny = [], paymentGuard = true }) {
  allowRules = allow.map(parsePattern);
  denyRules = deny.map(parsePattern);
  policyFlags.paymentGuard = paymentGuard !== false;
}

function parsePattern(raw) {
  const text = String(raw).trim().toLowerCase();
  const slash = text.indexOf("/");
  const host = slash === -1 ? text : text.slice(0, slash);
  const pathPrefix = slash === -1 ? "" : text.slice(slash);
  const hostRegex = host.includes("*")
    ? new RegExp("^" + host.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
    : null;
  return { raw: String(raw), host, hostRegex, pathPrefix };
}

function matches(rule, url) {
  const host = url.hostname.toLowerCase();
  const hostMatches = rule.hostRegex ? rule.hostRegex.test(host) : host === rule.host || host.endsWith("." + rule.host);
  return hostMatches && url.pathname.toLowerCase().startsWith(rule.pathPrefix);
}

// Returns null when the URL is allowed, otherwise the reason it is blocked.
export function blockedReason(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return `not a valid URL: ${href}`;
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) return `${url.protocol} URLs are not available to agents`;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null; // about:, data:, blob:
  const denied = denyRules.find((rule) => matches(rule, url));
  if (denied) return `${url.hostname} is on the agent-tabs deny list (${denied.raw})`;
  if (allowRules.length && !allowRules.some((rule) => matches(rule, url))) {
    return `${url.hostname} is not on the agent-tabs allow list`;
  }
  return null;
}
