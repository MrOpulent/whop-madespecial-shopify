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
  for (const [k, v] of map) {
    if (k === "sc_click_id" || k === "_scid" || k === "sccid") continue; // Snap ids are not the RedTrack click
    if (k.includes("clickid") && v !== "undefined") return v.slice(0, 200);
  }
  return "";
}

function timeout(ms) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const safeToken = (v) => String(v ?? "-").replace(/[\s\r\n]/g, "").slice(0, 80) || "-";

// One line per postback. No click id, no URL, no secrets.
export function redtrackResultLine(result, status, type, order, eventId) {
  return `redtrack_postback ${safeToken(result)} ${safeToken(status)} ${safeToken(type)} ${safeToken(order)} ${safeToken(eventId)}`;
}

// Purchase event id. Upsells use the upsell payment id so they do not replace the original purchase.
// Refunds reuse this same id, which is what RedTrack matches on eventid.
export function purchaseEventId({ journey, paymentId, upsell } = {}) {
  if (upsell) return paymentId ? `upsell-${paymentId}` : "";
  return String(journey || "");
}

// Explicit test marker, or a Whop payment that says it is not live. Nothing is inferred from the email.
const TEST_FLAG = /^(1|true|yes)$/i;
export function isTestPayment(payment, attrs) {
  const p = payment || {};
  if (p.test === true || p.livemode === false) return true;
  const mode = String(p.mode || p.environment || "").toLowerCase();
  if (mode === "test" || mode === "sandbox") return true;
  const bag = { ...(p.metadata || {}), ...(attrs || {}) };
  return ["test", "test_order", "_test"].some((k) => TEST_FLAG.test(String(bag[k] ?? "").trim()));
}

// Shop-currency amount for a refund, as a negative sum. presentmentCents is the shopper-currency refund.
export function refundShopSum(order, presentmentCents) {
  const pres = order?.totalReceivedSet?.presentmentMoney;
  const shop = order?.totalReceivedSet?.shopMoney;
  const presCents = Math.round(Number(pres?.amount || 0) * 100);
  const shopCents = Math.round(Number(shop?.amount || 0) * 100);
  const part = Math.max(0, Math.round(Number(presentmentCents) || 0));
  if (shop?.currencyCode && presCents > 0 && shopCents > 0 && part > 0)
    return { sum: -Math.round(shopCents * part / presCents) / 100, currency: shop.currencyCode };
  return { sum: -(part / 100), currency: pres?.currencyCode || "USD" };
}

// Same event id as the checkout page, so RedTrack counts one conversion when both arrive.
// sum is only sent for Purchase, Upsell, and Refund (negative). order is the Shopify order name, for the log line.
export async function postRedtrack({ clickid, type, sum, currency, eventId, order } = {}) {
  const id = String(clickid || "").trim();
  const event = String(type || "").trim();
  if (!id || id === "undefined" || !event) return { skipped: "no_click" };
  const line = (result, status) => redtrackResultLine(result, status, event, order || "-", eventId || "-");
  try {
    const u = new URL(redtrackPostback());
    u.searchParams.set("clickid", id);
    u.searchParams.set("type", event);
    if (eventId) u.searchParams.set("eventid", String(eventId));
    if (sum != null && sum !== "" && Number.isFinite(Number(sum))) u.searchParams.set("sum", Number(sum).toFixed(2));
    if (currency) u.searchParams.set("currency", String(currency));
    const res = await fetch(u, { signal: timeout(2500) });
    (res.ok ? console.log : console.error)(line(res.ok ? "ok" : "fail", res.status));
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error(line("fail", e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : "0"));
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
