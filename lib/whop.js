// lib/whop.js — Whop REST API + webhook signature check, no SDK (the SDK's API changes between major versions).
// Env: WHOP_API_KEY, WHOP_COMPANY_ID (biz_...), WHOP_WEBHOOK_SECRET
import crypto from "node:crypto";

const API = "https://api.whop.com/api/v1";

export async function createCheckout(body) {
  const r = await fetch(`${API}/checkout_configurations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WHOP_API_KEY}` },
    body: JSON.stringify({ account_id: process.env.WHOP_COMPANY_ID, ...body }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Whop ${r.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// Standard Webhooks: HMAC-SHA256 of "id.timestamp.body", keyed with the secret's literal bytes (as Whop signs it)
export function verifyWebhook(rawBody, headers) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!secret || !id || !ts || !sig) throw new Error("missing webhook headers or secret");
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error("webhook timestamp too old");
  const expected = crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${rawBody}`).digest();
  const ok = String(sig).split(" ").some((part) => {
    const [ver, b64] = part.split(",");
    if (ver !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!ok) throw new Error("bad webhook signature");
  return JSON.parse(rawBody);
}

// Read a payment (fallback when a webhook arrives without the shipping address)
export async function getPayment(id) {
  const r = await fetch(`${API}/payments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}` } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Whop ${r.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// One-time: the Whop product every checkout belongs to. collect_shipping_address makes Whop's checkout
// show the Shipping address form (and send it back on the payment).
export async function createShippingProduct(title) {
  const r = await fetch(`${API}/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WHOP_API_KEY}` },
    body: JSON.stringify({ account_id: process.env.WHOP_COMPANY_ID, title, collect_shipping_address: true, visibility: "hidden" }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Whop ${r.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// Charge a confirmation token from the branded checkout (Payment Elements flow).
// Returns { ok, status, data }: data is the payment ({ id, status, client_secret }) or Whop's error body.
export async function createPayment(body, idempotencyKey) {
  const r = await fetch(`${API}/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
    },
    body: JSON.stringify({ account_id: process.env.WHOP_COMPANY_ID, ...body }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: r.ok, status: r.status, data };
}

// Register a custom domain with Whop for Apple Pay (Domains API). Returns Whop's reply.
export async function registerApplePayDomain(domain) {
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WHOP_API_KEY}` };
  let r = await fetch(`${API}/domains`, { method: "POST", headers: h,
    body: JSON.stringify({ account_id: process.env.WHOP_COMPANY_ID, domain, apple_pay: {} }) });
  let text = await r.text();
  if (!r.ok) {
    // Already on the account: find it and switch Apple Pay on
    const l = await fetch(`${API}/domains?domain=${encodeURIComponent(domain)}&account_id=${process.env.WHOP_COMPANY_ID}`, { headers: h });
    const list = await l.json().catch(() => ({}));
    const id = (list.data || [])[0]?.id;
    if (!id) return { ok: false, status: r.status, data: text.slice(0, 500) };
    r = await fetch(`${API}/domains/${id}`, { method: "PATCH", headers: h, body: JSON.stringify({ apple_pay: {} }) });
    text = await r.text();
  }
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
  return { ok: r.ok, status: r.status, data };
}
