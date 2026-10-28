// lib/tiktok.js — server-side Purchase events for TikTok's Events API.
// The Shopify TikTok pixel never fires on Whop checkout, so purchase-optimized campaigns see nothing.
// Docs: https://business-api.tiktok.com/portal/docs/supported-events/v1.3
//       https://business-api.tiktok.com/portal/docs/report-app-web-offline-or-crm-events/v1.3
// Env: TIKTOK_EVENTS_TOKEN (required to send; unset = log and skip), TIKTOK_PIXEL_CODE (optional pixel code)
import crypto from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export const DEFAULT_PIXEL_CODE = "DB9H2D3C77U0NJ5DOPB0";
// Current Events API standard for a completed web payment. TikTok renamed CompletePayment to Purchase
// (March 2025). The supported-events list and the official /event/track/ sample both use Purchase,
// which is the event purchase-optimized campaigns match. CompletePayment is not in that list.
export const PURCHASE_EVENT = "Purchase";
const TIMEOUT_MS = 3000;
const ENDPOINT = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

// Keys the theme copies off the storefront. Kept in sync with theme/whop-cart-checkout.liquid TRACK
// and the "never drop" list in lib/pricing.js. ttclid is the click id; _ttp is the pixel cookie.
export const isTikTokAttr = (k) => /^_?ttclid$|^_ttp$/i.test(String(k || ""));

const SOURCE_KEY = /^(utm_source|utm_medium|sub12)$/i;

// "tiktok", "TikTok", "tiktok.com", "tiktok_ads". Not a substring of an unrelated word.
function isTikTokSource(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  if (s === "tiktok" || s === "tiktok.com" || s === "www.tiktok.com") return true;
  return /(?:^|[\s._-])tiktok(?:$|[\s._-])/.test(s);
}

// A Purchase is sent only when this order carries a TikTok signal:
//   - ttclid (ad click), or
//   - the _ttp cookie (TikTok's match key; often the only one left after the hop to checkout), or
//   - utm_source / utm_medium / sub12 naming TikTok.
// _ttp alone is included on purpose. The pixel sets it on the shop domain, and checkout is a
// different domain, so ttclid is frequently missing while _ttp was copied onto the order.
// TikTok decides whether that cookie matches an ad. Orders with none of these are not sent,
// so a Google or direct purchase is not reported. One event per Whop payment (the webhook
// sends only after the Shopify order is created) so the same order is not counted twice.
export function hasTikTokSignal(attrs) {
  const a = attrs || {};
  for (const [k, v] of Object.entries(a)) {
    if (v == null || String(v).trim() === "") continue;
    if (isTikTokAttr(k)) return true;
    if (SOURCE_KEY.test(k) && isTikTokSource(v)) return true;
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

export function pixelCode() {
  return String(process.env.TIKTOK_PIXEL_CODE || DEFAULT_PIXEL_CODE).trim() || DEFAULT_PIXEL_CODE;
}

// Trim and lowercase, then SHA-256. TikTok does not strip dots or plus-tags (unlike AppLovin).
export function hashEmail(email) {
  const trimmed = String(email ?? "").trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return "";
  return sha256(trimmed);
}

// E.164 ("+12133734253") then SHA-256. Invalid numbers are omitted, not hashed raw.
export function e164(raw, country) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cc = country && /^[A-Za-z]{2}$/.test(String(country)) ? String(country).toUpperCase() : undefined;
  const n = parsePhoneNumberFromString(s, cc) || parsePhoneNumberFromString(s.startsWith("+") ? s : `+${s.replace(/\D/g, "")}`);
  return n && n.isValid() ? n.number : "";
}

export function hashPhone(raw, country) {
  const phone = e164(raw, country);
  return phone ? sha256(phone) : "";
}

// Customer id as-is (trimmed). An email fallback is lowercased so it matches hashEmail.
export function hashExternalId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const norm = s.includes("@") ? s.toLowerCase() : s;
  return sha256(norm.slice(0, 256));
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

function eventTime(paidAt) {
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

function firstAttr(attrs, keys) {
  for (const k of keys) {
    const v = attrs?.[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function attrMatching(attrs, re) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (re.test(k) && v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// lines: [variantId, qty, unitPriceCents] in the currency Whop charged. An order-level discount
// is spread onto unit prices so price is the discounted unit price (same rule as AppLovin).
function itemsFromLines(lines, totalCents, names) {
  const parsed = (lines || []).map(([v, q, u], i) => ({
    id: String(v),
    q: Math.max(1, Number(q) || 1),
    u: Math.max(0, Math.round(Number(u) || 0)),
    name: names && names[i] != null ? String(names[i]).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) : "",
  })).filter((l) => l.id && l.id !== "undefined" && l.id !== "null");
  const gross = parsed.reduce((s, l) => s + l.q * l.u, 0);
  const due = Math.max(0, Math.round(Number(totalCents) || 0));
  return parsed.map((l) => {
    const paidUnit = gross > 0 ? Math.round((l.u * due) / gross) : l.u;
    return {
      content_id: l.id,
      ...(l.name && { content_name: l.name }),
      quantity: l.q,
      price: round2(paidUnit),
    };
  });
}

// Builds the POST body. Does not send. Currency and value are the presentment amount Whop charged
// (order.c and order.t cents), matching AppLovin. event_id defaults to whop-<payment id>, which is
// also what an upsell must use (whop-<upsell payment id>) so it does not collide with the parent.
export function buildTikTokPurchase(info) {
  const currency = String(info.currency || "").trim().toUpperCase();
  const contents = itemsFromLines(info.lines, info.totalCents, info.names);
  if (!/^[A-Z]{3}$/.test(currency) || !contents.length || !Number.isFinite(Number(info.totalCents)))
    return { skipped: "bad_money" };
  const attrs = info.attrs || {};
  const email = hashEmail(info.email);
  const phone = hashPhone(info.phone, info.country);
  const external = hashExternalId(info.externalId || info.email);
  const ttclid = attrMatching(attrs, /^_?ttclid$/i).slice(0, 500);
  const ttp = attrMatching(attrs, /^_ttp$/i).slice(0, 500);
  const ip = publicIp(info.ip);
  const ua = String(info.ua || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300);
  const eventId = String(info.eventId || info.dedupeId || `whop-${info.payId || "order"}`).slice(0, 200);
  const url = httpUrl(info.pageUrl) || httpUrl(firstAttr(attrs, ["landing_url", "page_url"])) || sourceUrl();
  const referrer = httpUrl(info.referrer) || httpUrl(firstAttr(attrs, ["referrer", "referer"]));
  const user = {
    ...(ttclid && { ttclid }),
    ...(ttp && { ttp }),
    ...(email && { email }),
    ...(phone && { phone }),
    ...(external && { external_id: external }),
    ...(ip && { ip }),
    ...(ua && { user_agent: ua }),
  };
  const body = {
    event_source: "web",
    event_source_id: pixelCode(),
    data: [{
      event: PURCHASE_EVENT,
      event_time: eventTime(info.paidAt),
      event_id: eventId,
      user,
      page: { url, ...(referrer && { referrer }) },
      properties: {
        currency,
        value: round2(info.totalCents),
        content_type: "product",
        contents,
        content_ids: contents.map((c) => c.content_id),
        num_items: contents.reduce((s, c) => s + c.quantity, 0),
        order_id: String(info.orderName || info.payId || eventId).slice(0, 120),
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

// Never throws. Missing token is logged and skipped so checkout keeps working before the key is set.
// InitiateCheckout is not sent from here: the Shopify pixel may still emit it on the storefront,
// and this server does not share that event_id.
export async function sendTikTokPurchase(info) {
  try {
    if (!hasTikTokSignal(info?.attrs)) return { skipped: "no_signal" };
    const token = String(process.env.TIKTOK_EVENTS_TOKEN || "").trim();
    if (!token) {
      console.log(`tiktok_events skipped no_token${info?.payId ? " " + info.payId : ""}`);
      return { skipped: "no_token" };
    }
    let built;
    try { built = buildTikTokPurchase(info || {}); }
    catch (e) { console.error("tiktok_events", e.message); return { error: "build_failed" }; }
    if (!built.body) {
      console.error("tiktok_events", built.skipped || "not_sent");
      return built;
    }
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body: JSON.stringify(built.body),
      signal: timeoutSignal(TIMEOUT_MS),
    });
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const code = parsed && typeof parsed === "object" ? parsed.code : undefined;
    if (!r.ok || code !== 0) {
      const message = parsed?.message || text;
      console.error("tiktok_events", r.status, code ?? "no_code", redact(message, token), parsed?.request_id || "");
      return { status: r.status, code: code ?? null, eventId: built.eventId };
    }
    console.log("tiktok_events", code, info.orderName || info.payId, built.eventId);
    return { status: r.status, code, eventId: built.eventId };
  } catch (e) {
    console.error("tiktok_events", e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message);
    return { error: "request_failed" };
  }
}
