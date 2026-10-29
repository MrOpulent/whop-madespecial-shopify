// lib/whop.js — Whop REST API + webhook signature check, no SDK (the SDK's API changes between major versions).
// Env: WHOP_API_KEY, WHOP_COMPANY_ID (biz_...), WHOP_WEBHOOK_SECRET
import crypto from "node:crypto";
import { minimalReturnUrl, returnUrlTooLong } from "./return-url.js";

const API = "https://api.whop.com/api/v1";

// Whop allows at most 500 characters per metadata value. Long values (order lines, tracking, address) are split
// into key__0, key__1 … plus key__n = number of parts, and joined back by unpackMeta when read.
const PART = 450;
export function packMeta(meta) {
  const out = {};
  for (const [k, v0] of Object.entries(meta || {})) {
    const v = v0 == null ? "" : typeof v0 === "string" ? v0 : JSON.stringify(v0);
    if (v.length <= PART) { out[k] = v; continue; }
    const n = Math.ceil(v.length / PART);
    for (let i = 0; i < n; i++) out[`${k}__${i}`] = v.slice(i * PART, (i + 1) * PART);
    out[`${k}__n`] = String(n);
  }
  return out;
}
export function unpackMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) if (!/__\d+$|__n$/.test(k)) out[k] = v;
  for (const [k, v] of Object.entries(meta)) {
    const m = k.match(/^(.*)__n$/); if (!m) continue;
    let s = ""; for (let i = 0; i < Number(v); i++) s += meta[`${m[1]}__${i}`] ?? "";
    out[m[1]] = s;
  }
  return out;
}
const withMeta = (p) => (p && p.metadata ? { ...p, metadata: unpackMeta(p.metadata) } : p);

export async function createCheckout(body) {
  const r = await fetch(`${API}/checkout_configurations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WHOP_API_KEY}` },
    body: JSON.stringify({ account_id: process.env.WHOP_COMPANY_ID, ...body, ...(body.metadata && { metadata: packMeta(body.metadata) }) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Whop ${r.status}: ${text.slice(0, 500)}`);
  return withMeta(JSON.parse(text));
}

// Standard Webhooks: HMAC-SHA256 of "id.timestamp.body", keyed with the secret's literal bytes (as Whop signs it)
// Accepts webhooks from the current account (WHOP_WEBHOOK_SECRET) and, while moving accounts, the old one
// (WHOP_WEBHOOK_SECRET_OLD), so payments made just before the switch still become Shopify orders.
export function verifyWebhook(rawBody, headers) {
  const secrets = [process.env.WHOP_WEBHOOK_SECRET, process.env.WHOP_WEBHOOK_SECRET_OLD].filter(Boolean);
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!secrets.length || !id || !ts || !sig) throw new Error("missing webhook headers or secret");
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error("webhook timestamp too old");
  const ok = secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${rawBody}`).digest();
    return String(sig).split(" ").some((part) => {
      const [ver, b64] = part.split(",");
      if (ver !== "v1" || !b64) return false;
      const got = Buffer.from(b64, "base64");
      return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    });
  });
  if (!ok) throw new Error("bad webhook signature");
  return JSON.parse(rawBody);
}

// Read a payment (fallback when a webhook arrives without the shipping address)
// The current account, plus the old one while moving accounts (WHOP_API_KEY_OLD + WHOP_COMPANY_ID_OLD)
function accounts() {
  const a = [{ key: process.env.WHOP_API_KEY, id: process.env.WHOP_COMPANY_ID, old: false }];
  if (process.env.WHOP_API_KEY_OLD && process.env.WHOP_COMPANY_ID_OLD) a.push({ key: process.env.WHOP_API_KEY_OLD, id: process.env.WHOP_COMPANY_ID_OLD, old: true });
  return a;
}
export async function getPayment(id) {
  let last;
  for (const acc of accounts()) {
    const r = await fetch(`${API}/payments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${acc.key}` } });
    const text = await r.text();
    if (r.ok) return { ...withMeta(JSON.parse(text)), _old: acc.old };
    last = new Error(`Whop ${r.status}: ${text.slice(0, 500)}`);
  }
  throw last;
}

// Refund all (amount null) or part of a payment back to the buyer's original payment method, on whichever account
// owns it (current, or old during a move). amount is in major units of the payment's own currency.
// idempotencyKey makes retries safe (never refunds twice).
export async function refundPayment(id, amount, idempotencyKey, metadata) {
  let last;
  for (const acc of accounts()) {
    const r = await fetch(`${API}/payments/${encodeURIComponent(id)}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${acc.key}`, ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }) },
      body: JSON.stringify({ ...(amount != null && { partial_amount: amount }), ...(metadata && { metadata }) }),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    if (r.ok) return { ok: true, status: r.status, data };
    last = { ok: false, status: r.status, data };
    if (r.status !== 404) return last; // only "not found" means: try the other account
  }
  return last;
}

// Paid payments of this account created after `since` (ISO date), newest first, up to `max`.
export async function listPaidPayments(since, max = 200) {
  const out = [];
  for (const acc of accounts()) {
    let after = null, got = 0;
    while (got < max) {
      const q = new URLSearchParams({ account_id: acc.id, status: "paid", created_after: since,
        order: "created_at", direction: "desc", first: "50", ...(after && { after }) });
      const r = await fetch(`${API}/payments?${q}`, { headers: { Authorization: `Bearer ${acc.key}` } });
      const text = await r.text();
      if (!r.ok) { if (acc.old) { console.error("old account list", r.status); break; } throw new Error(`Whop ${r.status}: ${text.slice(0, 500)}`); }
      const j = JSON.parse(text);
      const page = (j.data || []).map((p) => ({ ...withMeta(p), _old: acc.old }));
      out.push(...page); got += page.length;
      if (!j.page_info?.has_next_page || !j.page_info.end_cursor) break;
      after = j.page_info.end_cursor;
    }
  }
  return out;
}

// Readable explanation when the API key is missing a permission (scope)
export function scopeProblem(data) {
  const txt = typeof data === "string" ? data : data?.error?.message || data?.message || JSON.stringify(data || "");
  const m = String(txt).match(/not authorized for the ([a-z_:]+) scope/i);
  return m ? `Whop API key is missing the "${m[1]}" permission: Whop dashboard > Developer > API keys > edit the key, tick ${m[1]}, save, then put the key in Vercel WHOP_API_KEY and redeploy.` : null;
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

// Whop rejects return_url above 2,048 characters ("return_url is too long").
const RETURN_URL_MAX = 2048;
function clampReturnUrl(url) {
  const s = String(url || "");
  if (s.length <= RETURN_URL_MAX) return s;
  try {
    const u = new URL(s);
    const q = u.searchParams.get("upsell") === "1" ? "return=1&upsell=1" : "return=1";
    const short = `${u.origin}/?${q}`;
    return short.length <= RETURN_URL_MAX ? short : `${u.origin}/`;
  } catch {
    return s.slice(0, RETURN_URL_MAX);
  }
}

// Charge a confirmation token from the branded checkout (Payment Elements flow).
// Returns { ok, status, data }: data is the payment ({ id, status, client_secret }) or Whop's error body.
// accountId: which account the shopper's card form belonged to (the old one only during an account move).
// retried is internal: the too-long retry calls this again so the short URL is clamped and logged the same way.
export async function createPayment(body, idempotencyKey, accountId, retried) {
  const acc = accounts().find((a) => a.id && a.id === accountId) || accounts()[0];
  const payload = { account_id: acc.id, ...body, ...(body.metadata && { metadata: packMeta(body.metadata) }) };
  if (payload.return_url) payload.return_url = clampReturnUrl(payload.return_url);
  if (typeof payload.return_url === "string") console.log(`return_url_len ${payload.return_url.length}${retried ? " retry=1" : ""}`);
  const r = await fetch(`${API}/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${acc.key}`,
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  const result = { ok: r.ok, status: r.status, data };
  if (retried || result.ok || !returnUrlTooLong(result.data) || typeof payload.return_url !== "string") return result;
  const shorter = minimalReturnUrl(payload.return_url);
  if (!shorter || shorter === payload.return_url) return result;
  return createPayment({ ...body, return_url: shorter }, idempotencyKey ? `${idempotencyKey}:short` : undefined, acc.id, true);
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
