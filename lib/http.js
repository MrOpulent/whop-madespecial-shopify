// lib/http.js — CORS for the store's domain(s) and preview links.
// ALLOWED_ORIGIN takes any number of entries, separated by commas, spaces or new lines. Each entry is either
//   an exact origin:      https://madespecial.store
//   or a wildcard:        https://*.shopifypreview.com   (any subdomain, e.g. https://abc123.shopifypreview.com)
// Trailing slashes and paths are ignored. Example:
//   https://madespecial.store, https://www.madespecial.store, https://madespecial.myshopify.com, https://*.shopifypreview.com
const DEFAULT = "https://madespecial.store";

function rules() {
  return (process.env.ALLOWED_ORIGIN || DEFAULT)
    .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => {
      const m = s.match(/^(https?:\/\/)?([^/]+)/i);
      if (!m) return null;
      const proto = (m[1] || "https://").toLowerCase(), host = m[2].toLowerCase();
      if (!host.includes("*")) return { exact: proto + host };
      // "*." matches one or more subdomain labels; nothing else is a wildcard
      const re = "^" + proto.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") +
        host.split("*.").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(?:[a-z0-9-]+\\.)+") + "$";
      return { re: new RegExp(re, "i") };
    }).filter(Boolean);
}

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  const o = String(origin).replace(/\/+$/, "").toLowerCase();
  return rules().some((r) => (r.exact ? r.exact === o : r.re.test(o)));
}

// Sets CORS headers. Returns true when the request was a preflight (already answered).
export function cors(req, res) {
  const origin = req.headers?.origin;
  if (isAllowedOrigin(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

// Absolute base URL of this deployment as the shopper sees it (e.g. https://checkout.madespecial.store).
// Proxies sometimes send a comma-separated forwarded host; only the first value is the shopper's host.
export function baseUrl(req) {
  if (process.env.CHECKOUT_URL) return process.env.CHECKOUT_URL.replace(/\/$/, "");
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim();
  const proto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  return `${proto}://${host}`;
}

// Journey log: one line per checkout step, all sharing the checkout's journey id (j).
// Vercel > Logs: search  j=<id>  for one shopper's whole path, or  JOURNEY  for all; problems are logged as errors.
export function journey(j, step, data = {}, problem = false) {
  const line = `JOURNEY j=${String(j || "-").slice(0, 16)} step=${String(step).slice(0, 40)} ${JSON.stringify(data).slice(0, 600)}`;
  (problem ? console.error : console.log)(line);
}
