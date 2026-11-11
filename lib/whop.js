// lib/whop.js — Whop REST API + webhook signature check, no SDK (the SDK's API changes between major versions).
// Env: WHOP_API_KEY, WHOP_COMPANY_ID (biz_...), WHOP_WEBHOOK_SECRET
import crypto from "node:crypto";

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

// Read a shipment by ship_ id, or by the pay_ id it fulfills. 404 tries the other account during a move.
export async function getShipment(id) {
  const sid = String(id || "").trim();
  if (!sid) throw new Error("Whop 400: missing shipment id");
  let last;
  for (const acc of accounts()) {
    const r = await fetch(`${API}/shipments/${encodeURIComponent(sid)}`, { headers: { Authorization: `Bearer ${acc.key}` } });
    const text = await r.text();
    if (r.ok) return { ...JSON.parse(text), _old: acc.old };
    last = new Error(`Whop ${r.status}: ${text.slice(0, 500)}`);
    if (r.status !== 404) throw last;
  }
  throw last || new Error("Whop 404: shipment not found");
}

// Attach a carrier tracking number to a Whop payment (PayPal orders only; the caller checks the method).
// Whop follows the parcel from here. A PayPal order id is not required: payment_id is the Whop pay_ id.
// 404 tries the other account during a move. Same idempotency key on a retry does not create a second shipment.
export async function createShipment(paymentId, trackingNumber, idempotencyKey) {
  const id = String(paymentId || "").trim();
  const tracking = String(trackingNumber || "").trim().slice(0, 128);
  if (!id || !tracking) return { ok: false, status: 400, data: { error: "missing payment_id or tracking_number" } };
  const list = accounts().filter((a) => a.key);
  if (!list.length) return { ok: false, status: 401, data: { error: "missing_api_key" } };
  let last = { ok: false, status: 404, data: { error: "not_found" } };
  for (const acc of list) {
    let r, text;
    try {
      r = await fetch(`${API}/shipments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${acc.key}`,
          ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
        },
        body: JSON.stringify({ account_id: acc.id, payment_id: id, tracking_number: tracking }),
      });
      text = await r.text();
    } catch (e) {
      return { ok: false, status: 0, data: { error: String(e.message || e).slice(0, 200) } };
    }
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    if (r.ok) return { ok: true, status: r.status, data };
    last = { ok: false, status: r.status, data };
    if (r.status !== 404) return last;
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
// accountId: which account the shopper's card form belonged to (the old one only during an account move)
export async function createPayment(body, idempotencyKey, accountId) {
  const acc = accounts().find((a) => a.id && a.id === accountId) || accounts()[0];
  const payload = { account_id: acc.id, ...body, ...(body.metadata && { metadata: packMeta(body.metadata) }) };
  if (payload.return_url) payload.return_url = clampReturnUrl(payload.return_url);
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

// Active promo codes, kept briefly so typing a code does not list them on every keystroke.
let promoCache = { at: 0, list: [] };
async function activePromos(force) {
  if (!force && promoCache.list && Date.now() - promoCache.at < 15000) return promoCache.list;
  const all = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ account_id: process.env.WHOP_COMPANY_ID, status: "active", first: "100", ...(after && { after }) });
    const r = await fetch(`${API}/promo_codes?${q}`, { headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}` } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Whop ${r.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    all.push(...(j.data || []));
    if (!j.page_info?.has_next_page || !j.page_info.end_cursor) break;
    after = j.page_info.end_cursor;
  }
  promoCache = { at: Date.now(), list: all };
  return all;
}

// Whop stores a percentage as a fraction (0.1 = 10%). Older replies use 10 for 10%.
function percentFraction(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return 0;
}

// The discount a Whop promo code takes off this checkout, in the same hundredths the session uses.
// Returns null when the code is not an active promo for this purchase. Throws if Whop cannot be asked.
export async function promoDiscount(code, totalCents, currency, shopTotalCents, shopCurrency) {
  if (!process.env.WHOP_API_KEY || !process.env.WHOP_COMPANY_ID) return null;
  const want = String(code || "").trim().toLowerCase();
  if (!want) return null;
  const hit = (list) => list.find((p) => String(p?.code || "").trim().toLowerCase() === want) || null;
  const warm = promoCache.at > 0 && Date.now() - promoCache.at < 15000;
  let promo;
  try {
    promo = hit(await activePromos(false));
    if (!promo && warm) promo = hit(await activePromos(true));
  } catch (e) {
    const hint = scopeProblem(String(e.message || e));
    console.error(hint ? `SETUP PROBLEM — ${hint}` : "whop_promos", e.message || e);
    if (/Whop 40[13]/.test(String(e.message || ""))) return null;
    throw e;
  }
  if (!promo) return null;
  if (promo.status && promo.status !== "active") return null;
  if (promo.expires_at && Date.parse(promo.expires_at) < Date.now()) return null;
  if (promo.existing_memberships_only || promo.churned_users_only) return null;
  if (promo.unlimited_stock === false && Number.isFinite(Number(promo.stock)) && Number(promo.uses || 0) >= Number(promo.stock)) return null;
  const scoped = promo.product?.id;
  if (scoped && process.env.WHOP_PRODUCT_ID && scoped !== process.env.WHOP_PRODUCT_ID) return null;

  const type = String(promo.promo_type || "");
  const pct = type === "percentage" || type === "percent";
  const flat = type === "flat_amount" || type === "flat";
  if (!pct && !flat) return null;
  const cur = String(currency || "").toLowerCase();
  const promoCur = String(promo.currency || promo.base_currency || "").toLowerCase().replace(/^whop_/, "");
  if (flat && promoCur && promoCur !== cur) return null;

  const off = pct ? Math.round(totalCents * percentFraction(promo.amount_off)) : Math.round(Number(promo.amount_off) * 100);
  if (off <= 0) return null;
  const shopOff = pct
    ? Math.round(shopTotalCents * percentFraction(promo.amount_off))
    : (String(shopCurrency || "").toLowerCase() === cur ? off
      : (totalCents > 0 ? Math.round(off * shopTotalCents / totalCents) : 0));
  if (shopOff <= 0) return null;
  if (off >= totalCents || shopOff >= shopTotalCents) return { unusable: true };
  return { code: String(promo.code).slice(0, 60), off, shopOff };
}
