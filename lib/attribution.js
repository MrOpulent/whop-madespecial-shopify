// Landing URL and referrer carried from the cart onto the Shopify order.
// orderCreate has no landing_site input. referringSite is the referrer Shopify stores on the order.
// sourceUrl is the only other URL the mutation accepts; it is the landing page, shown on the order.
// sourceName "web" is what Shopify and Triple Whale treat as online-store traffic. The Admin API
// documents it as a sales-channel attribution handle, and this app is the Whop Orders app, so Shopify
// may reject "web" or overwrite it with the app id. Callers retry without the rejected field.

const LANDING_KEYS = ["landing_site", "landing_page", "landing_url", "first_landing_page"];
const REFERRER_KEYS = ["referring_site", "referrer", "referring_url"];

export function httpUrl(value, max = 1024) {
  const s = String(value ?? "").trim();
  if (!s || s.length > max) return "";
  let u;
  try { u = new URL(s); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password) return "";
  const out = u.toString();
  return out.length <= max ? out : "";
}

function firstValue(attrs, keys) {
  const bag = attrs && typeof attrs === "object" ? attrs : {};
  for (const k of keys) if (bag[k]) return bag[k];
  const lower = new Map(Object.entries(bag).map(([k, v]) => [String(k).toLowerCase(), v]));
  for (const k of keys) if (lower.get(k)) return lower.get(k);
  return "";
}

export function orderWebFields(attrs) {
  const landing = httpUrl(firstValue(attrs, LANDING_KEYS));
  const referrer = httpUrl(firstValue(attrs, REFERRER_KEYS));
  return {
    ...(referrer && { referringSite: referrer }),
    ...(landing && { sourceUrl: landing }),
    sourceName: "web",
  };
}

// Removes whichever web fields Shopify just rejected. Returns true when the order changed.
export function stripRejectedWebFields(order, errors) {
  const blob = (errors || []).map((e) => `${e?.field || ""} ${e?.message || ""}`).join(" ");
  let changed = false;
  if (order?.sourceName && /source[\s_]?name|attribution/i.test(blob)) { delete order.sourceName; changed = true; }
  if (order?.sourceUrl && /source[\s_]?url/i.test(blob)) { delete order.sourceUrl; changed = true; }
  if (order?.referringSite && /referring[\s_]?site/i.test(blob)) { delete order.referringSite; changed = true; }
  if (order?.test === true && /["'\s,]test["'\s,\]]/i.test(` ${blob} `)) { delete order.test; changed = true; }
  return changed;
}
