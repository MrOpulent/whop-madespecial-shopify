// lib/outcraft.js — OutcraftAI abandoned-checkout recovery (Custom API lead source).
//   checkout/updated   from the checkout page while the shopper fills it in (api/abandon.js)
//   checkout/completed from the Whop webhook when the payment succeeds (api/whop-webhook.js)
// unique_id is the checkout journey id (j), so a completed payment stops the outreach for that checkout.
// cart_link opens api/recover.js, which prices the same cart again and opens a fresh checkout.
// Env: OUTCRAFT_TRIGGER_URL (the campaign's POST endpoint). Not set = nothing is sent.
import { createRecoverLink } from "./session.js";

export const OUTCRAFT_TIMEOUT_MS = 2500;
const money = (cents) => (Math.round(Number(cents) || 0) / 100).toFixed(2);
const str = (v, max = 120) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : undefined; };
const e164 = (v) => { const s = String(v || "").trim(); return /^\+[1-9]\d{6,14}$/.test(s) ? s : undefined; };
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

export function outcraftUrl() {
  const u = String(process.env.OUTCRAFT_TRIGGER_URL || "").trim();
  return /^https:\/\/[^/]+\/\S+$/.test(u) ? u : "";
}

// Click id, UTMs and subs travel in the recovery link, so a recovered sale keeps its ad attribution.
const TRACK = /clickid|^rtk|^utm_|^sub\d{1,2}$|^fbclid$|^_fbc$|^_fbp$|^ttclid$|^sccid$|^_ax|^cmpid$/i;
function trackingAttrs(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (!TRACK.test(k)) continue;
    out[k] = String(v).slice(0, 200);
    if (JSON.stringify(out).length > 900) { delete out[k]; break; }
  }
  return out;
}
const utms = (attrs) => Object.fromEntries(Object.entries(attrs || {}).filter(([k]) => /^utm_/i.test(k)).map(([k, v]) => [k.toLowerCase(), String(v).slice(0, 120)]));

// The cart behind a checkout session, as a link that rebuilds it later (sessions expire after a few hours).
export function recoverLink(base, s) {
  const it = (s.it || []).map(([v, q, props]) => (props && Object.keys(props).length ? [v, q, props] : [v, q]));
  const r = createRecoverLink({ j: s.j, it, mk: s.mk, ...(s.dc?.length && { dc: s.dc }), ...(s.wp && { wp: s.wp }), a: trackingAttrs(s.attrs) });
  return `${String(base).replace(/\/$/, "")}/api/recover?r=${r}`;
}

function items(order, disp) {
  return (order?.l || []).map(([v, q, u], i) => drop({
    id: String(v),
    name: str(order.nm?.[i] || disp?.[i]?.title, 200),
    quantity: Number(q) || 1,
    price: money(u),
  }));
}

// What the shopper has typed so far. Every field is optional except what Outcraft needs to reach them.
function shipping(c) {
  return drop({
    first_name: str(c.first_name, 80), last_name: str(c.last_name, 80),
    address1: str(c.address1, 200), address2: str(c.address2, 200), city: str(c.city, 120),
    province_code: str(c.province, 40), zip: str(c.zip, 20),
    country_code: /^[A-Z]{2}$/.test(String(c.country_code || "")) ? c.country_code : undefined,
    phone: e164(c.phone),
  });
}

// checkout/updated: s is the signed checkout session, c the contact and address from the checkout form.
// Returns null when there is nobody to contact yet (no phone and no email).
export function buildUpdated(s, c, cartLink) {
  c = c && typeof c === "object" ? c : {};
  const phone = e164(c.phone);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email || "").trim()) ? String(c.email).trim().slice(0, 200) : undefined;
  if (!phone && !email) return null;
  const ship = shipping(c);
  return drop({
    outcraft_event: "checkout/updated",
    unique_id: s.j,
    phone,
    // The phone is optional on this checkout. Without this, an email-only checkout would wait for a phone forever.
    ...(!phone && { should_verify_phone_presence: false }),
    cart_link: cartLink,
    final_price: money(s.tot),
    currency: s.cur,
    tax_price: "0.00",
    shipping_price: "0.00",
    items: items(s.order, s.disp),
    discount_codes: [...(s.dc || []), ...(s.wp ? [s.wp] : [])],
    shipping_details: ship,
    email,
    first_name: ship.first_name,
    last_name: ship.last_name,
    country_code: ship.country_code || s.mk,
    language: str(c.language, 10),
    timezone: str(c.timezone, 60),
    context: drop({ market: s.mk, ...utms(s.attrs) }),
  });
}

// checkout/completed, from the paid Whop payment. o is the order metadata, j the journey id of the checkout.
export function buildCompleted({ j, paidCents, o, attrs, email, phone, ship, method }) {
  const codes = String(o?.dc || "").split(",").map((x) => x.trim()).filter((x) => x && x !== "BUNDLE-UPSELL");
  const shipping_details = drop({
    first_name: str(ship?.first), last_name: str(ship?.last),
    address1: str(ship?.line1, 200), address2: str(ship?.line2, 200), city: str(ship?.city),
    province_code: str(ship?.state, 40), zip: str(ship?.postal_code, 20),
    country_code: ship?.country ? String(ship.country).toUpperCase() : undefined,
    phone: e164(phone),
  });
  return drop({
    outcraft_event: "checkout/completed",
    unique_id: j,
    final_price: money(paidCents),
    currency: o?.c,
    discount_codes: codes,
    items: items(o),
    shipping_details,
    phone: e164(phone),
    email: str(email, 200),
    first_name: shipping_details.first_name,
    last_name: shipping_details.last_name,
    country_code: shipping_details.country_code,
    context: drop({ payment_provider: "whop", payment_method: str(method, 60), ...utms(attrs) }),
  });
}

// Never throws and never waits more than OUTCRAFT_TIMEOUT_MS: a checkout or an order must not depend on it.
export async function sendOutcraft(payload) {
  const url = outcraftUrl();
  if (!url || !payload) return { skipped: !url ? "not_configured" : "no_payload" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OUTCRAFT_TIMEOUT_MS),
    });
    if (!r.ok) console.error("outcraft", payload.outcraft_event, r.status, (await r.text().catch(() => "")).slice(0, 300));
    return { status: r.status };
  } catch (e) {
    console.error("outcraft", payload.outcraft_event, e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message);
    return { error: "request_failed" };
  }
}
