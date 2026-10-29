// lib/applovin.js — server-side purchase events for AppLovin's Conversion API (Axon).
// The storefront pixel only fires purchase on Shopify checkout, which this shop no longer uses.
// Docs: https://support.applovin.com/en/growth/promoting-your-websites/api/conversion-api
//       https://support.applovin.com/en/growth/promoting-your-websites/track-and-optimize/events-and-objects
// Env: APPLOVIN_CAPI_KEY (required to send; unset = log and skip), APPLOVIN_EVENT_KEY (optional pixel id)
import crypto from "node:crypto";

export const DEFAULT_EVENT_KEY = "39e4030b-05d4-4ccf-a868-d6a93ec89d02";
const TIMEOUT_MS = 3000;

// Cart / cookie / query keys that identify an AppLovin click or the Axon pixel.
// Kept in sync with theme/whop-cart-checkout.liquid TRACK and lib/pricing.js trimming.
export const isApplovinAttr = (k) => /^_?ax|^aleid$|^alart$/i.test(String(k || ""));

// The Conversion API page tells advertisers to send website conversions and says AppLovin
// attributes from aleid / alart / axwrt / hashed email. It does not say to forward every
// order on the site. Purchases are sent only when the order carries one of these signals;
// AppLovin then decides whether the click was theirs.
export function hasApplovinSignal(attrs) {
  const a = attrs || {};
  if (String(a.utm_source || "").trim().toLowerCase() === "applovin") return true;
  return Object.entries(a).some(([k, v]) => v != null && String(v).trim() !== "" && isApplovinAttr(k));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function timeoutSignal(ms) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// AppLovin hashing guidelines (Events and objects). Empty string = do not send the field.
export function hashEmail(email) {
  const trimmed = String(email ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").toLowerCase();
  if (!/^[!-?A-~]+@[!-?A-~]+$/.test(trimmed)) return "";
  const at = trimmed.indexOf("@");
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.split("+")[0].replace(/\./g, "");
  return local ? sha256(`${local}@${domain}`) : "";
}

const KEYPAD = { a: "2", b: "2", c: "2", d: "3", e: "3", f: "3", g: "4", h: "4", i: "4", j: "5", k: "5", l: "5", m: "6", n: "6", o: "6", p: "7", q: "7", r: "7", s: "7", t: "8", u: "8", v: "8", w: "9", x: "9", y: "9", z: "9" };

// Digits only, letters via keypad, leading zeros removed, country code kept (E.164 without '+').
function phoneDigits(raw) {
  let digits = "";
  for (const ch of String(raw ?? "").trim().toLowerCase()) {
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (KEYPAD[ch]) digits += KEYPAD[ch];
  }
  return digits.replace(/^0+/, "");
}

export function hashPhone(raw) {
  const digits = phoneDigits(raw);
  return digits ? sha256(digits) : "";
}

// Separate hash of the last 10 digits. Omit when the raw value contains a letter or is shorter than 10.
export function hashPhoneLast10(raw) {
  const s = String(raw ?? "").trim();
  if (!s || /[a-z]/i.test(s)) return "";
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10) return "";
  return sha256(digits.slice(-10));
}

function publicIp(raw) {
  let ip = String(raw || "").trim();
  if (!ip) return null;
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return null;
    if (a === 169 && b === 254) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
    if (a === 100 && b >= 64 && b <= 127) return null;
    return ip;
  }
  if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return null;
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low)) return null;
  return ip;
}

// Shopper IP + user agent from the checkout request. Private and loopback addresses are dropped:
// AppLovin discards events that come from a non-public IP.
export function clientContext(req) {
  const h = req?.headers || {};
  const one = (v) => Array.isArray(v) ? v.join(",") : v;
  const chain = [one(h["x-real-ip"]), one(h["x-forwarded-for"])].filter(Boolean).join(",");
  const ip = chain.split(",").map((s) => publicIp(s)).find(Boolean) || null;
  const ua = String(one(h["user-agent"]) || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300) || null;
  return { ip, ua };
}

// Copy the shopper's IP and user agent onto the tracking bag that becomes order attributes.
// The webhook reads these when Whop's payment payload has no user agent of its own.
export function trackingWithClient(tracking, req) {
  const net = clientContext(req);
  const t = { ...(tracking && typeof tracking === "object" ? tracking : {}) };
  if (net.ua && !t.client_user_agent) t.client_user_agent = net.ua;
  if (net.ip && !t.client_ip_address) t.client_ip_address = net.ip;
  return { tracking: t, net };
}

const round2 = (cents) => Number((Math.round(Number(cents)) / 100).toFixed(2));

function postal(zip, country) {
  const z = String(zip ?? "").trim();
  if (!z) return "";
  if (String(country || "").toUpperCase() === "US") return z.replace(/\D/g, "").slice(0, 5);
  return z.replace(/\s+/g, "").slice(0, 10);
}

function eventTime(paidAt) {
  if (paidAt == null || paidAt === "") return Date.now();
  const t = new Date(paidAt).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function sourceUrl() {
  const base = String(process.env.CHECKOUT_URL || "https://checkout.madespecial.store").replace(/\/$/, "");
  return `${base}/?return=1`;
}

// lines: [variantId, qty, unitPriceCents] in the same currency as totalCents (the amount Whop charged).
// An order-level discount is spread onto unit prices so `price` is the discounted unit price.
function itemsFromLines(lines, totalCents) {
  const parsed = (lines || []).map(([v, q, u]) => ({ id: String(v), q: Math.max(1, Number(q) || 1), u: Math.max(0, Math.round(Number(u) || 0)) }))
    .filter((l) => l.id && l.id !== "undefined" && l.id !== "null");
  const gross = parsed.reduce((s, l) => s + l.q * l.u, 0);
  const due = Math.max(0, Math.round(Number(totalCents) || 0));
  return parsed.map((l) => {
    const paidUnit = gross > 0 ? Math.round((l.u * due) / gross) : l.u;
    const discount = Math.max(0, round2(l.u - paidUnit));
    return {
      item_id: l.id,
      item_variant_id: l.id,
      quantity: l.q,
      price: round2(paidUnit),
      ...(discount > 0 && { discount }),
    };
  });
}

function firstAttr(attrs, keys) {
  for (const k of keys) {
    const v = attrs?.[k];
    if (v != null && String(v).trim() !== "") return String(v).trim().slice(0, 500);
  }
  return "";
}

// Builds the POST body. Does not send. Currency is the currency Whop charged (presentment, `order.c`),
// and value is that charge in major units (cents / 100), which is the amount due. Shipping is free on
// this checkout. Tax is not stored separately, so tax is 0 — see the PR notes.
export function buildAxonPurchase(info) {
  const currency = String(info.currency || "").trim().toUpperCase();
  const items = itemsFromLines(info.lines, info.totalCents);
  if (!/^[A-Z]{3}$/.test(currency) || !items.length || !Number.isFinite(Number(info.totalCents)))
    return { skipped: "bad_money" };
  const attrs = info.attrs || {};
  const email = hashEmail(info.email);
  const phone = hashPhone(info.phone);
  const phoneLast10 = hashPhoneLast10(info.phone);
  const aleid = firstAttr(attrs, ["_axeid", "aleid"]);
  const alart = firstAttr(attrs, ["_axart", "alart"]);
  const axwrt = firstAttr(attrs, ["_axwrt", "axwrt"]);
  const country = String(info.country || "").trim().toUpperCase();
  const zip = postal(info.zip, country);
  const dedupeId = String(info.dedupeId || firstAttr(attrs, ["_axon_event_id"]) || `whop-${info.payId || "order"}`).slice(0, 200);
  const ip = publicIp(info.ip);
  const ua = String(info.ua || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300);
  const user_data = {
    esi: "web",
    ...(ip && { client_ip_address: ip }),
    ...(ua && { client_user_agent: ua }),
    ...(aleid && { aleid }),
    ...(alart && { alart }),
    ...(axwrt && { axwrt }),
    ...(email && { email }),
    ...(phone && { phone }),
    ...(phone && phoneLast10 && phoneLast10 !== phone && { phone_last10_hashed: phoneLast10 }),
    ...(country && /^[A-Z]{2}$/.test(country) && { country_code: country }),
    ...(zip && { zip }),
  };
  const body = {
    events: [{
      name: "purchase",
      event_time: eventTime(info.paidAt),
      event_source_url: info.sourceUrl || sourceUrl(),
      dedupe_id: dedupeId,
      user_data,
      data: {
        currency,
        value: round2(info.totalCents),
        transaction_id: String(info.orderName || info.payId || dedupeId).slice(0, 120),
        shipping: 0,
        tax: 0,
        items,
      },
    }],
  };
  return { body, dedupeId };
}

// Never throws. Missing API key is logged and skipped so checkout keeps working before the key is set.
export async function sendAxonPurchase(info) {
  const key = String(process.env.APPLOVIN_CAPI_KEY || "").trim();
  if (!key) {
    console.log(`applovin_capi skipped no_key${info?.payId ? " " + info.payId : ""}`);
    return { skipped: "no_key" };
  }
  let built;
  try { built = buildAxonPurchase(info || {}); }
  catch (e) { console.error("applovin_capi", e.message); return { error: "build_failed" }; }
  if (!built.body) {
    console.error("applovin_capi", built.skipped || "not_sent");
    return built;
  }
  try {
    const r = await fetch(`https://b.applovin.com/v1/event?pixel_id=${encodeURIComponent(String(process.env.APPLOVIN_EVENT_KEY || DEFAULT_EVENT_KEY).trim())}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify(built.body),
      signal: timeoutSignal(TIMEOUT_MS),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("applovin_capi", r.status, text.slice(0, 300));
      return { status: r.status, dedupeId: built.dedupeId };
    }
    console.log("applovin_capi", r.status, info.orderName || info.payId, built.dedupeId);
    return { status: r.status, dedupeId: built.dedupeId };
  } catch (e) {
    console.error("applovin_capi", e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message);
    return { error: "request_failed" };
  }
}
