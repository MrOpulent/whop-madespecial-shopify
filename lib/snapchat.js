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

// ScCid / sc_click_id / _scclid is the ad click id (user_data.sc_click_id).
// _scid / sc_cookie1 is the pixel's first-party cookie (user_data.sc_cookie1), a different value.
// os_version is not a signal: the store records it for every browser, and keep() in pricing.js preserves it.
export const isSnapAttr = (k) => /^(?:sc_click_id|sccid|_scclid|_scid|sc_cookie1)$/i.test(String(k || ""));

const SOURCE_KEY = /^(utm_source|utm_medium|sub12)$/i;

function isSnapSource(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  if (s === "snap" || s === "snapchat" || s === "snapchat.com" || s === "www.snapchat.com") return true;
  return /(?:^|[\s._-])snapchat(?:$|[\s._-])/.test(s);
}

// A click id or cookie we will actually send. Rejects blank, unreplaced macros ({sub8}), and whitespace.
export function usableSnapId(v) {
  const s = String(v ?? "").trim();
  if (s.length < 8 || s.length > 500) return "";
  if (/[\s{}<>]/.test(s)) return "";
  if (/^(undefined|null|none|n\/a)$/i.test(s)) return "";
  return s;
}

// Sent only when the order has a Snapchat signal: a real ScCid, the _scid cookie, or
// utm_source / utm_medium / sub12 naming Snapchat (exact "snap" counts). One event
// per Whop payment, after the Shopify order exists, so retries do not send twice.
export function hasSnapSignal(attrs) {
  const a = attrs || {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null || String(v).trim() === "") continue;
    if (isSnapAttr(k) && usableSnapId(v)) return true;
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

// external_id: hashing recommended. Emails are lowercased so they match hashEmail; other ids stay as given.
export function hashExternalId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const norm = s.includes("@") ? s.toLowerCase() : s;
  return sha256(norm.slice(0, 256));
}

// Lowercase, punctuation and spaces removed, letters kept (so "Raphaël" stays "raphaël").
function hashPerson(raw) {
  const s = String(raw ?? "").trim().toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}]/gu, "");
  return s ? sha256(s) : "";
}

export function hashCity(raw) {
  const s = String(raw ?? "").trim().toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}]/gu, "");
  return s ? sha256(s) : "";
}

// US: 2-letter code. Elsewhere: lowercase letters only.
export function hashState(raw, country) {
  const cc = String(country || "").toUpperCase();
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (cc === "US") {
    if (!/^[a-z]{2}$/.test(s)) return "";
  } else s = s.replace(/[^\p{L}]/gu, "");
  return s ? sha256(s) : "";
}

// US: first 5 digits. UK: area + district + sector (SW1A 1AA -> sw1a1).
export function hashZip(raw, country) {
  const cc = String(country || "").toUpperCase();
  let z = String(raw ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!z) return "";
  if (cc === "US") z = z.replace(/\D/g, "").slice(0, 5);
  else if (cc === "GB") {
    const m = z.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d)/);
    z = m ? m[1] + m[2] : z.replace(/[^A-Z0-9]/g, "");
  } else z = z.replace(/[^A-Z0-9]/g, "");
  z = z.toLowerCase();
  return z ? sha256(z) : "";
}

export function hashCountry(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(s)) return "";
  return sha256(s);
}

// Client-supplied OS versions only. "15.0.0" from userAgentData, not free text.
export function cleanOsVersion(v) {
  const s = String(v ?? "").trim();
  return /^\d{1,3}(\.\d{1,4}){0,3}$/.test(s) ? s : "";
}

export function cleanDeviceModel(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, "").replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 40);
  if (s.length < 2 || /^(wv|linux|android|windows|mac|khtml)$/i.test(s)) return "";
  return s;
}

// Snap Event Quality reads os_version. Chrome's reduced UA still carries a version;
// this fills the field when the client did not send one.
export function osVersionFromUa(ua) {
  const s = String(ua || "");
  let m;
  if ((m = s.match(/(?:CPU (?:iPhone )?OS|iPhone OS|CPU OS) (\d+)[_.](\d+)(?:[_.](\d+))?/i)))
    return [m[1], m[2], m[3]].filter(Boolean).join(".");
  if ((m = s.match(/Android (\d+(?:\.\d+){0,2})/i))) return m[1];
  if ((m = s.match(/Windows NT (\d+\.\d+)/i))) return m[1];
  if ((m = s.match(/Mac OS X (\d+)[_.](\d+)(?:[_.](\d+))?/i)))
    return [m[1], m[2], m[3]].filter(Boolean).join(".");
  if ((m = s.match(/CrOS \S+ (\d+(?:\.\d+){0,2})/))) return m[1];
  return "";
}

export function deviceModelFromUa(ua) {
  const s = String(ua || "");
  let m;
  if ((m = s.match(/Android [^;]*;\s*([^;)]+?)\s*(?:Build\/|[);])/i))) {
    const model = cleanDeviceModel(m[1]);
    if (model) return model;
  }
  if (/iPhone/i.test(s)) return "iPhone";
  if (/iPad/i.test(s)) return "iPad";
  return "";
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

// Prefer the explicit click-id parameter, then ScCid, then the _scclid cookie some pixels set.
export function snapClickId(attrs) {
  for (const re of [/^(?:sc_click_id)$/i, /^sccid$/i, /^_scclid$/i]) {
    const id = usableSnapId(attrMatching(attrs, re));
    if (id) return id.slice(0, 200);
  }
  return "";
}

export function snapCookie1(attrs) {
  const id = usableSnapId(attrMatching(attrs, /^_scid$/i)) || usableSnapId(attrMatching(attrs, /^sc_cookie1$/i));
  return id ? id.slice(0, 200) : "";
}

// Snap extracts ScCid from event_source_url when the field is also present. Append it if missing.
function withClick(url, clickId) {
  if (!clickId) return url;
  try {
    const u = new URL(url);
    let has = false;
    for (const [k, v] of u.searchParams) {
      if ((/^sccid$/i.test(k) || k.toLowerCase() === "sc_click_id") && usableSnapId(v)) has = true;
    }
    if (!has) u.searchParams.set("ScCid", clickId);
    return u.toString().slice(0, 1000);
  } catch {
    return url;
  }
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
  const external = hashExternalId(info.externalId || info.email);
  const fn = hashPerson(info.firstName);
  const ln = hashPerson(info.lastName);
  const ct = hashCity(info.city);
  const st = hashState(info.state, info.country);
  const zp = hashZip(info.zip, info.country);
  const country = hashCountry(info.country);
  const scClick = snapClickId(attrs);
  const scCookie = snapCookie1(attrs);
  const ip = publicIp(info.ip || attrMatching(attrs, /^client_ip_address$/i));
  const ua = String(info.ua || attrMatching(attrs, /^client_user_agent$/i) || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300);
  // Prefer the checkout browser's userAgentData version; otherwise parse the UA so coverage is not limited to Snap's parser.
  const os = cleanOsVersion(info.osVersion) || cleanOsVersion(attrMatching(attrs, /^os_version$/i)) || osVersionFromUa(ua);
  const model = cleanDeviceModel(info.deviceModel) || cleanDeviceModel(attrMatching(attrs, /^device_model$/i)) || deviceModelFromUa(ua);
  const eventId = String(info.eventId || info.dedupeId || `whop-${info.payId || "order"}`).slice(0, 200);
  const user_data = {
    ...(email && { em: email }),
    ...(phone && { ph: phone }),
    ...(fn && { fn }),
    ...(ln && { ln }),
    ...(ct && { ct }),
    ...(st && { st }),
    ...(zp && { zp }),
    ...(country && { country }),
    ...(external && { external_id: external }),
    ...(ip && { client_ip_address: ip }),
    ...(ua && { client_user_agent: ua }),
    ...(scClick && { sc_click_id: scClick }),
    ...(scCookie && { sc_cookie1: scCookie }),
    // v3 user_data holds the match keys Event Quality scores. os_version is the conversion-parameter name.
    ...(os && { os_version: os }),
    ...(model && { device_model: model }),
  };
  const body = {
    data: [{
      event_name: "PURCHASE",
      action_source: ACTION_SOURCE,
      event_time: eventTimeMs(info.paidAt),
      // Pixel SDK client_dedup_id must equal this event_id. Purchase browser events use whop-<payment id>.
      event_id: eventId,
      event_source_url: withClick(httpUrl(info.pageUrl) || sourceUrl(), scClick),
      user_data,
      custom_data: {
        currency,
        value: round2(info.totalCents),
        order_id: String(info.orderName || info.payId || eventId).slice(0, 120),
        content_ids: ids,
        num_items: String(num),
        // Same names on custom_data: the v3 partner mapping puts device fields here.
        ...(os && { os_version: os }),
        ...(model && { device_model: model }),
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
