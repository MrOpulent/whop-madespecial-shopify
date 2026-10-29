// RedTrack on the checkout domain. The store records the click (rtkclickid-store / __clickid).
// This domain is a different host, so the click id is carried on the checkout session and URL,
// then each step is posted back to that same click. Ad pixels are configured inside RedTrack.

const CLICKID_KEYS = ["__clickid", "rtkclickid-store", "rtkclickid", "clickid", "rtkcid", "cid"];

const money = (cents) => Math.round(Number(cents) || 0) / 100;

export function redtrackOrigin() {
  return String(process.env.REDTRACK_TRACKING_ORIGIN || "https://trk.madespecial.store").replace(/\/$/, "");
}

export function redtrackPostback() {
  return process.env.REDTRACK_POSTBACK_URL || `${redtrackOrigin()}/postback`;
}

export function clickIdFrom(bag) {
  const map = new Map();
  for (const [k, v] of Object.entries(bag || {})) {
    if (v == null || String(v).trim() === "") continue;
    map.set(String(k).toLowerCase(), String(v).trim());
  }
  for (const k of CLICKID_KEYS) {
    const v = map.get(k);
    if (v && v !== "undefined") return v.slice(0, 200);
  }
  for (const [k, v] of map) if (k.includes("clickid") && v !== "undefined") return v.slice(0, 200);
  return "";
}

function timeout(ms) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// Same event id as the checkout page, so RedTrack counts one conversion when both arrive.
// sum is only sent for Purchase and Upsell (shop currency for the order, offer currency for an upsell).
export async function postRedtrack({ clickid, type, sum, currency, eventId } = {}) {
  const id = String(clickid || "").trim();
  const event = String(type || "").trim();
  if (!id || id === "undefined" || !event) return { skipped: "no_click" };
  try {
    const u = new URL(redtrackPostback());
    u.searchParams.set("clickid", id);
    u.searchParams.set("type", event);
    if (eventId) u.searchParams.set("eventid", String(eventId));
    if (sum != null && sum !== "" && Number.isFinite(Number(sum))) u.searchParams.set("sum", Number(sum).toFixed(2));
    if (currency) u.searchParams.set("currency", String(currency));
    await fetch(u, { signal: timeout(2500) });
    return { ok: true };
  } catch (e) {
    console.error("redtrack_postback", event, e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message);
    return { error: "request_failed" };
  }
}

// What the checkout page needs to keep posting to the click the store already opened.
export function adsFor(s) {
  return {
    clickid: clickIdFrom(s?.attrs),
    redtrack: redtrackOrigin(),
    postback: redtrackPostback(),
    purchaseType: process.env.REDTRACK_EVENT || "Purchase",
    eventId: String(s?.j || ""),
    currency: s?.cur || "USD",
    value: money(s?.tot),
    shopCurrency: s?.order?.sc || s?.cur || "USD",
    shopValue: money(s?.order?.st ?? s?.tot),
  };
}
