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
// sum is the shopper currency for InitiateCheckout, and the shop currency for Purchase and Upsell.
export async function postRedtrack({ clickid, type, sum, currency, eventId } = {}) {
  const id = String(clickid || "").trim();
  const event = String(type || "").trim();
  if (!id || id === "undefined" || !event) return { skipped: "no_click" };
  try {
    const u = new URL(redtrackPostback());
    u.searchParams.set("clickid", id);
    u.searchParams.set("type", event);
    if (eventId) {
      u.searchParams.set("eventid", String(eventId));
      u.searchParams.set("rdtk_event_id", String(eventId));
    }
    if (sum != null && sum !== "" && Number.isFinite(Number(sum))) u.searchParams.set("sum", Number(sum).toFixed(2));
    if (currency) u.searchParams.set("currency", String(currency));
    await fetch(u, { signal: timeout(2500) });
    return { ok: true };
  } catch (e) {
    console.error("redtrack_postback", event, e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message);
    return { error: "request_failed" };
  }
}

function attr(bag, ...keys) {
  const map = new Map();
  for (const [k, v] of Object.entries(bag || {})) {
    if (v == null || String(v).trim() === "") continue;
    map.set(String(k).toLowerCase(), String(v).trim());
  }
  for (const k of keys) {
    const v = map.get(k.toLowerCase());
    if (v && v !== "undefined") return v.slice(0, 300);
  }
  return "";
}

// Axon requires items on begin_checkout. Prices are the shopper's unit price.
function axonItems(s) {
  const lines = Array.isArray(s?.order?.l) ? s.order.l : [];
  const disp = Array.isArray(s?.disp) ? s.disp : [];
  const names = Array.isArray(s?.order?.nm) ? s.order.nm : [];
  return lines.map((l, i) => {
    const id = String(l?.[0] || "");
    if (!id) return null;
    const image = String(disp[i]?.image || "");
    const item = {
      item_id: id,
      item_variant_id: id,
      item_name: String(disp[i]?.title || names[i] || "").slice(0, 120),
      price: money(l[2]),
      quantity: Number(l[1]) || 1,
    };
    if (/\.(png|jpe?g)(\?|$)/i.test(image)) item.image_url = image;
    return item;
  }).filter(Boolean);
}

// What the checkout page needs to keep posting to the click the store already opened.
// axon is the AppLovin Event Key already installed on madespecial.store. Purchase stays on
// RedTrack's server postback; this page only fires the funnel events Shopify checkout never sees.
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
    track: s?.cs?.m !== 0,
    axon: process.env.AXON_EVENT_KEY || "39e4030b-05d4-4ccf-a868-d6a93ec89d02",
    aleid: attr(s?.attrs, "aleid", "_axeid"),
    items: axonItems(s),
  };
}
