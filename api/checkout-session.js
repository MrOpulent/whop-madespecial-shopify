// api/checkout-session.js — called by the store's cart drawer. Prices the cart with Shopify and returns the URL of
// the branded checkout page (public/index.html) carrying a signed session (no database).
// Env: lib/shopify.js vars, WHOP_API_KEY, ALLOWED_ORIGIN, optional CHECKOUT_URL / SESSION_SECRET
import { priceCart, orderAttributes } from "../lib/pricing.js";
import { createSession } from "../lib/session.js";
import { cors, baseUrl, journey } from "../lib/http.js";
import { clientContext } from "../lib/applovin.js";
import crypto from "node:crypto";

// The shopper's cookie choice on the store (Shopify consent), so the checkout respects it for Clarity
const consent = (c) => (c && typeof c === "object" ? { a: c.analytics === true ? 1 : c.analytics === false ? 0 : null, m: c.marketing === true ? 1 : c.marketing === false ? 0 : null } : null);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).end();
  // Fast path: the store submits the cart as a normal form post (no CORS pre-check, and the browser is already
  // navigating). Answer with a redirect straight to the checkout page; problems go back to the cart with a message.
  const form = typeof req.body?.payload === "string";
  const store = (process.env.STORE_URL || "https://madespecial.store").replace(/\/$/, "");
  const back = (code) => { res.statusCode = 303; res.setHeader("Location", `${store}/cart?checkout_error=${encodeURIComponent(code)}`); res.setHeader("Cache-Control", "no-store"); return res.end(); };
  try {
    let b = req.body || {};
    if (form) { try { b = JSON.parse(req.body.payload); } catch { return back("server_error"); } }
    // Fired by the store before the shopper clicks, so the connection and the function are already warm.
    // Not a checkout: nothing is priced and nothing is logged.
    if (b.warmup) return res.status(204).end();
    const j = crypto.randomBytes(5).toString("hex");
    let p;
    try { p = await priceCart(b); }
    catch (e) { journey("-", "cart_rejected", { error: e.code || e.message, total: b.total_price, currency: b.currency, country: b.market_country }, true); throw e; }
    const at = orderAttributes(b.attributes, b.tracking);
    const net = clientContext(req); // carried on the session, then onto the Whop payment, for the AppLovin Conversion API
    const token = createSession({
      mk: p.market, cur: p.currency, tot: p.total, gross: p.gross,
      disp: p.display, title: p.title, desc: p.description,
      order: p.order, attrs: at,
      j, cs: consent(b.consent), it: p.items, ...(p.codes.length && { dc: p.codes }), ca: b.attributes || {}, // to re-price if the shopper ships to another country
      ...(net.ip && { ip: net.ip }), ...(net.ua && { ua: net.ua }),
    });
    journey(j, "checkout_started", { total: p.total, currency: p.currency, market: p.market, items: p.qty, clickid: Object.entries(at).find(([k]) => /clickid/i.test(k))?.[1] || null });
    const url = `${baseUrl(req)}/?s=${token}`;
    if (form) {
      const x = String(req.query?.x || "").replace(/[^a-z_]/g, "").slice(0, 20); // express wallet chosen in the drawer
      res.statusCode = 303; res.setHeader("Location", url + (x ? `&x=${x}` : "")); res.setHeader("Cache-Control", "no-store");
      return res.end();
    }
    return res.status(200).json({ journey: j, url });
  } catch (e) {
    if (e.status) return form ? back(e.code) : res.status(e.status).json({ error: e.code });
    console.error("checkout_session_error", e);
    if (form) return back("server_error");
    return res.status(500).json({ error: "server_error" });
  }
}
