// api/checkout-session.js — called by the store's cart drawer. Prices the cart with Shopify and returns the URL of
// the branded checkout page (public/index.html) carrying a signed session (no database).
// Env: lib/shopify.js vars, WHOP_API_KEY, ALLOWED_ORIGIN, optional CHECKOUT_URL / SESSION_SECRET
import { priceCart, orderAttributes } from "../lib/pricing.js";
import { createSession } from "../lib/session.js";
import { cors, baseUrl, journey } from "../lib/http.js";
import crypto from "node:crypto";

// The shopper's cookie choice on the store (Shopify consent), so the checkout respects it for Clarity
const consent = (c) => (c && typeof c === "object" ? { a: c.analytics === true ? 1 : c.analytics === false ? 0 : null, m: c.marketing === true ? 1 : c.marketing === false ? 0 : null } : null);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).end();
  try {
    const b = req.body || {};
    const j = crypto.randomBytes(5).toString("hex");
    let p;
    try { p = await priceCart(b); }
    catch (e) { journey("-", "cart_rejected", { error: e.code || e.message, total: b.total_price, currency: b.currency, country: b.market_country }, true); throw e; }
    const token = createSession({
      mk: p.market, cur: p.currency, tot: p.total, gross: p.gross,
      disp: p.display, title: p.title, desc: p.description,
      order: p.order, attrs: orderAttributes(b.attributes, b.tracking),
      j, cs: consent(b.consent), it: p.items, ...(p.codes.length && { dc: p.codes }), ca: b.attributes || {}, // to re-price if the shopper ships to another country
    });
    const at = orderAttributes(b.attributes, b.tracking);
    journey(j, "checkout_started", { total: p.total, currency: p.currency, market: p.market, items: p.qty, clickid: Object.entries(at).find(([k]) => /clickid/i.test(k))?.[1] || null });
    return res.status(200).json({ journey: j, url: `${baseUrl(req)}/?s=${token}` });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.code });
    console.error("checkout_session_error", e);
    return res.status(500).json({ error: "server_error" });
  }
}
