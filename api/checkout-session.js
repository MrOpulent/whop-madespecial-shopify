// api/checkout-session.js — called by the store's cart drawer. Prices the cart with Shopify and returns the URL of
// the branded checkout page (public/index.html) carrying a signed session (no database).
// Env: lib/shopify.js vars, WHOP_API_KEY, ALLOWED_ORIGIN, optional CHECKOUT_URL / SESSION_SECRET
import { priceCart, orderAttributes } from "../lib/pricing.js";
import { createSession } from "../lib/session.js";
import { cors, baseUrl, journey } from "../lib/http.js";
import { clickIdFrom, postInitiateCheckouts } from "../lib/ads.js";
import crypto from "node:crypto";

// The shopper's cookie choice on the store (Shopify consent), so the checkout respects it for Clarity
const consent = (c) => (c && typeof c === "object" ? { a: c.analytics === true ? 1 : c.analytics === false ? 0 : null, m: c.marketing === true ? 1 : c.marketing === false ? 0 : null } : null);
// Clarity user + session cookies from the store, restored on checkout before the tag loads.
const clarityCookies = (c) => {
  if (!c || typeof c !== "object") return null;
  const clip = (v) => { const s = String(v ?? "").trim().slice(0, 300); return s && !/[\r\n;]/.test(s) ? s : ""; };
  const clck = clip(c.clck), clsk = clip(c.clsk);
  if (!clck && !clsk) return null;
  return { ...(clck && { clck }), ...(clsk && { clsk }) };
};

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
    const cl = clarityCookies(b.clarity);
    const token = createSession({
      mk: p.market, cur: p.currency, tot: p.total, gross: p.gross,
      disp: p.display, title: p.title, desc: p.description,
      order: p.order, attrs: at,
      j, cs: consent(b.consent), it: p.items, ...(p.codes.length && { dc: p.codes }), ca: b.attributes || {}, // to re-price if the shopper ships to another country
      ...(cl && { cl }),
    });
    const click = clickIdFrom(at);
    journey(j, "checkout_started", { total: p.total, currency: p.currency, market: p.market, items: p.qty, clickid: click || null });
    // Same event id the checkout page sends, so a closed tab still records the step once.
    // p.total is integer cents in the currency the shopper saw (presentment), not shop-base dollars.
    // 4999 cents -> 49.99. Math.round only removes a fractional cent; it does not round the dollar amount.
    await postInitiateCheckouts({ clickid: click, journey: j, sum: Math.round(Number(p.total) || 0) / 100, currency: p.currency, attrs: at });
    const url = `${baseUrl(req)}/?s=${token}` + (click ? `&clickid=${encodeURIComponent(click)}` : "");
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
