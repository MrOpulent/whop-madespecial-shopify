// api/checkout-session.js — called by the store's cart drawer. Prices the cart with Shopify and returns the URL of
// the branded checkout page (public/index.html) carrying a signed session (no database).
// Env: lib/shopify.js vars, WHOP_API_KEY, ALLOWED_ORIGIN, optional CHECKOUT_URL / SESSION_SECRET
import { priceCart, orderAttributes } from "../lib/pricing.js";
import { createSession } from "../lib/session.js";
import { cors, baseUrl } from "../lib/http.js";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).end();
  try {
    const b = req.body || {};
    const p = await priceCart(b);
    const token = createSession({
      mk: p.market, cur: p.currency, tot: p.total, gross: p.gross,
      disp: p.display, title: p.title, desc: p.description,
      order: p.order, attrs: orderAttributes(b.attributes, b.tracking),
      it: p.items, ca: b.attributes || {}, // to re-price if the shopper ships to another country
    });
    return res.status(200).json({ url: `${baseUrl(req)}/?s=${token}` });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.code });
    console.error("checkout_session_error", e);
    return res.status(500).json({ error: "server_error" });
  }
}
