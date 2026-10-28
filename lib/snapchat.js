// lib/snapchat.js — server-side PURCHASE events for Snapchat's Conversions API v3.
// The storefront pixel does not fire on Whop checkout.
// Docs: https://developers.snap.com/marketing-api/Conversions-API/UsingTheAPI
//       https://developers.snap.com/marketing-api/Conversions-API/Parameters
// Env: SNAP_CAPI_TOKEN (required to send; unset = log and skip), SNAP_PIXEL_ID (optional pixel id)
import crypto from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export const DEFAULT_PIXEL_ID = "72a34e54-4d52-4807-ad88-c1c97e4c40f1";
// Current CAPI v3 web value. The parameters enum is WEB, OFFLINE, MOBILE_APP. WEBSITE is not accepted.
export const ACTION_SOURCE = "WEB";
const TIMEOUT_MS = 3000;

// ScCid is the landing-URL click id. _scid is the pixel cookie (sent as sc_cookie1).
export const isSnapAttr = (k) => /^sccid$|^_scid$/i.test(String(k || ""));

const SOURCE_KEY = /^(utm_source|utm_medium|sub12)$/i;

function isSnapSource(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  if (s === "snap" || s === "snapchat" || s === "snapchat.com" || s === "www.snapchat.com") return true;
  return /(?:^|[\s._-])snapchat(?:$|[\s._-])/.test(s);
}

// Sent only when the order has a Snapchat signal: ScCid, the _scid cookie, or
// utm_source / utm_medium / sub12 naming Snapchat (exact "snap" counts). One event
// per Whop payment, after the Shopify order exists, so retries do not send twice.
export function hasSnapSignal(attrs) {
  const a = attrs || {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null || String(v).trim() === "") continue;
    if (isSnapAttr(k)) return true;
    if (SOURCE_KEY.test(k) && isSnapSource(v)) return true;
  }
  return false;
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function timeoutSignal(ms) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export function pixelId() {
  return String(process.env.SNAP_PIXEL_ID || DEFAULT_PIXEL_ID).trim() || DEFAULT_PIXEL_ID;
}

export function hashEmail(email) {
  const trimmed = String(email ?? "").trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return "";
  return sha256(trimmed);
}

// Country code, digits only, no '+' and no leading zeros. Snap's published example:
// "+44 844 412 4653" -> "448444124653".
export function phoneDigits(raw, country) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cc = country && /^[A-Za-z]{2}$/.test(String(country)) ? String(country).toUpperCase() : undefined;
  const n = parsePhoneNumberFromString(s, cc) || parsePhoneNumberFromString(s.startsWith("+") ? s : `+${s.replace(/\D/g, "")}`);
  let digits = n && n.isValid() ? n.number.replace(/\D/g, "") : s.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  digits = digits.replace(/^0+/, "");
  return digits.length >= 8 ? digits : "";
}

export function hashPhone(raw, country) {
  const digits = phoneDigits(raw, country);
  return digits ? sha256(digits) : "";
}

function publicIp(raw) {
  let ip = String(raw || "").trim();
  if (!ip) return "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return "";
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return "";
    if (a === 169 && b === 254) return "";
    if (a === 172 && b >= 16 && b <= 31) return "";
    if (a === 192 && b === 168) return "";
    if (a === 100 && b >= 64 && b <= 127) return "";
    return ip;
  }
  if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return "";
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low)) return "";
  return ip;
}

const round2 = (cents) => Number((Math.round(Number(cents)) / 100).toFixed(2));

// Snap accepts seconds or milliseconds and asks for millisecond granularity.
function eventTimeMs(paidAt) {
  if (paidAt == null || paidAt === "") return Date.now();
  if (typeof paidAt === "number" && Number.isFinite(paidAt)) {
    const ms = paidAt > 1e12 ? paidAt : paidAt * 1000;
    return ms > 0 ? Math.round(ms) : Date.now();
  }
  const t = Date.parse(String(paidAt));
  return Number.isFinite(t) ? t : Date.now();
}

function sourceUrl() {
  const base = String(process.env.CHECKOUT_URL || "https://checkout.madespecial.store").replace(/\/$/, "");
  return `${base}/?return=1`;
}

function httpUrl(v) {
  const s = String(v || "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  return s.slice(0, 1000);
}

function attrMatching(attrs, re) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (re.test(k) && v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function lineIds(lines) {
  const parsed = (lines || []).map(([v, q]) => ({
    id: String(v),
    q: Math.max(1, Number(q) || 1),
  })).filter((l) => l.id && l.id !== "undefined" && l.id !== "null");
  return { ids: parsed.map((l) => l.id), num: parsed.reduce((s, l) => s + l.q, 0) };
}

// Presentment currency and value (order.c, order.t cents), same as AppLovin and TikTok.
// event_id defaults to whop-<payment id>. Upsells pass dedupeId whop-<upsell payment id>.
export function buildSnapPurchase(info) {
  const currency = String(info.currency || "").trim().toUpperCase();
  const { ids, num } = lineIds(info.lines);
  if (!/^[A-Z]{3}$/.test(currency) || !ids.length || !(Number(info.totalCents) > 0))
    return { skipped: "bad_money" };
  const attrs = info.attrs || {};
  const email = hashEmail(info.email);
  const phone = hashPhone(info.phone, info.country);
  const scClick = attrMatching(attrs, /^sccid$/i).slice(0, 500);
  const scCookie = attrMatching(attrs, /^_scid$/i).slice(0, 500);
  const ip = publicIp(info.ip);
  const ua = String(info.ua || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300);
  const eventId = String(info.eventId || info.dedupeId || `whop-${info.payId || "order"}`).slice(0, 200);
  const user_data = {
    ...(email && { em: email }),
    ...(phone && { ph: phone }),
    ...(ip && { client_ip_address: ip }),
    ...(ua && { client_user_agent: ua }),
    ...(scClick && { sc_click_id: scClick }),
    ...(scCookie && { sc_cookie1: scCookie }),
  };
  const body = {
    data: [{
      event_name: "PURCHASE",
      action_source: ACTION_SOURCE,
      event_time: eventTimeMs(info.paidAt),
      event_id: eventId,
      event_source_url: httpUrl(info.pageUrl) || sourceUrl(),
      user_data,
      custom_data: {
        currency,
        value: round2(info.totalCents),
        order_id: String(info.orderName || info.payId || eventId).slice(0, 120),
        content_ids: ids,
        num_items: String(num),
      },
    }],
  };
  return { body, eventId };
}

function redact(text, token) {
  let out = String(text || "");
  if (token) out = out.split(token).join("[redacted]");
  return out.slice(0, 300);
}

// Never throws. The access token is a query param and is never written to the log.
export async function sendSnapPurchase(info) {
  try {
    if (!hasSnapSignal(info?.attrs)) return { skipped: "no_signal" };
    const token = String(process.env.SNAP_CAPI_TOKEN || "").trim();
    if (!token) {
      console.log(`snap_capi skipped no_token${info?.payId ? " " + info.payId : ""}`);
      return { skipped: "no_token" };
    }
    let built;
    try { built = buildSnapPurchase(info || {}); }
    catch (e) { console.error("snap_capi", e.message); return { error: "build_failed" }; }
    if (!built.body) {
      console.error("snap_capi", built.skipped || "not_sent");
      return built;
    }
    const url = `https://tr.snapchat.com/v3/${encodeURIComponent(pixelId())}/events?access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(built.body),
      signal: timeoutSignal(TIMEOUT_MS),
    });
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const status = parsed && typeof parsed === "object" ? String(parsed.status || "") : "";
    if (!r.ok || (status && status.toUpperCase() !== "VALID")) {
      console.error("snap_capi", r.status, status || "no_status", redact(parsed?.reason || text, token));
      return { status: r.status, snapStatus: status || null, eventId: built.eventId };
    }
    console.log("snap_capi", status || r.status, info.orderName || info.payId, built.eventId);
    return { status: r.status, snapStatus: status || "VALID", eventId: built.eventId };
  } catch (e) {
    console.error("snap_capi", e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message);
    return { error: "request_failed" };
  }
}
