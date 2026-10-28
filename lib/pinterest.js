// lib/pinterest.js — server-side checkout events for Pinterest's Conversions API v5.
// Pinterest's purchase event is named checkout. The browser tag does not fire on Whop checkout.
// Docs: https://developers.pinterest.com/docs/track-conversions/track-conversions-in-the-api/
// Env: PINTEREST_CAPI_TOKEN and PINTEREST_AD_ACCOUNT_ID (both required to send).
// The browser tag id (2613242346032) is not the ad account id and is not sent on this endpoint.
import crypto from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

const TIMEOUT_MS = 3000;

// epik is the landing-URL click id. _epik is the cookie Pinterest prefers for click_id.
export const isPinterestAttr = (k) => /^_?epik$/i.test(String(k || ""));

const SOURCE_KEY = /^(utm_source|utm_medium|sub12)$/i;

function isPinterestSource(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  if (s === "pinterest" || s === "pinterest.com" || s === "www.pinterest.com") return true;
  return /(?:^|[\s._-])pinterest(?:$|[\s._-])/.test(s);
}

// Sent only when the order has a Pinterest signal: epik, the _epik cookie, or
// utm_source / utm_medium / sub12 naming Pinterest. One event per Whop payment.
export function hasPinterestSignal(attrs) {
  const a = attrs || {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null || String(v).trim() === "") continue;
    if (isPinterestAttr(k)) return true;
    if (SOURCE_KEY.test(k) && isPinterestSource(v)) return true;
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

export function hashEmail(email) {
  const trimmed = String(email ?? "").trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return "";
  return sha256(trimmed);
}

// Digits with country code. Symbols, letters, and leading zeros removed.
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

const round2 = (cents) => (Math.round(Number(cents)) / 100).toFixed(2);

function eventTimeSec(paidAt) {
  const now = Math.floor(Date.now() / 1000);
  if (paidAt == null || paidAt === "") return now;
  if (typeof paidAt === "number" && Number.isFinite(paidAt)) {
    const sec = paidAt > 1e12 ? Math.floor(paidAt / 1000) : Math.floor(paidAt);
    return sec > 0 ? sec : now;
  }
  const t = Date.parse(String(paidAt));
  return Number.isFinite(t) ? Math.floor(t / 1000) : now;
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

// Presentment currency and value. Pinterest parses value from a string. click_id prefers the
// _epik cookie over the epik query param, which is what Pinterest's docs ask for.
// event_id defaults to whop-<payment id>. Upsells pass dedupeId whop-<upsell payment id>.
export function buildPinterestCheckout(info) {
  const currency = String(info.currency || "").trim().toUpperCase();
  const { ids, num } = lineIds(info.lines);
  if (!/^[A-Z]{3}$/.test(currency) || !ids.length || !(Number(info.totalCents) > 0))
    return { skipped: "bad_money" };
  const attrs = info.attrs || {};
  const email = hashEmail(info.email);
  const phone = hashPhone(info.phone, info.country);
  const clickId = (attrMatching(attrs, /^_epik$/i) || attrMatching(attrs, /^epik$/i)).slice(0, 500);
  const ip = publicIp(info.ip);
  const ua = String(info.ua || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300);
  const eventId = String(info.eventId || info.dedupeId || `whop-${info.payId || "order"}`).slice(0, 200);
  const user_data = {
    ...(email && { em: [email] }),
    ...(phone && { ph: [phone] }),
    ...(ip && { client_ip_address: ip }),
    ...(ua && { client_user_agent: ua }),
    ...(clickId && { click_id: clickId }),
  };
  const body = {
    data: [{
      event_name: "checkout",
      action_source: "web",
      event_time: eventTimeSec(info.paidAt),
      event_id: eventId,
      event_source_url: httpUrl(info.pageUrl) || sourceUrl(),
      user_data,
      custom_data: {
        currency,
        value: round2(info.totalCents),
        order_id: String(info.orderName || info.payId || eventId).slice(0, 120),
        content_ids: ids,
        num_items: num,
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

// Never throws. Missing token or ad account id is logged and skipped.
export async function sendPinterestCheckout(info) {
  try {
    if (!hasPinterestSignal(info?.attrs)) return { skipped: "no_signal" };
    const token = String(process.env.PINTEREST_CAPI_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
    if (!token) {
      console.log(`pinterest_capi skipped no_token${info?.payId ? " " + info.payId : ""}`);
      return { skipped: "no_token" };
    }
    const account = String(process.env.PINTEREST_AD_ACCOUNT_ID || "").trim();
    if (!account) {
      console.log(`pinterest_capi skipped no_account${info?.payId ? " " + info.payId : ""}`);
      return { skipped: "no_account" };
    }
    let built;
    try { built = buildPinterestCheckout(info || {}); }
    catch (e) { console.error("pinterest_capi", e.message); return { error: "build_failed" }; }
    if (!built.body) {
      console.error("pinterest_capi", built.skipped || "not_sent");
      return built;
    }
    const url = `https://api.pinterest.com/v5/ad_accounts/${encodeURIComponent(account)}/events`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(built.body),
      signal: timeoutSignal(TIMEOUT_MS),
    });
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    const failed = events.filter((e) => e && e.status === "failed");
    const processed = Number(parsed?.num_events_processed);
    if (!r.ok || failed.length || (Number.isFinite(processed) && processed < 1)) {
      const message = failed.map((e) => e.error_message).filter(Boolean).join("; ") || parsed?.message || text;
      console.error("pinterest_capi", r.status, redact(message, token));
      return { status: r.status, processed: Number.isFinite(processed) ? processed : null, eventId: built.eventId };
    }
    console.log("pinterest_capi", r.status, info.orderName || info.payId, built.eventId);
    return { status: r.status, processed: Number.isFinite(processed) ? processed : 1, eventId: built.eventId };
  } catch (e) {
    console.error("pinterest_capi", e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message);
    return { error: "request_failed" };
  }
}
