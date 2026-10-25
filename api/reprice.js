// api/reprice.js — the shopper changed the delivery country: re-price the same cart (same Kaching offers/upsell
// discounts) in that country's Shopify market currency, using Shopify's own prices and conversion.
// Returns a new signed checkout session. Env: same as api/checkout-session.js
import { priceCart } from "../lib/pricing.js";
import { createSession, readSession } from "../lib/session.js";
import { view } from "./session.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  const b = req.body || {};
  let s;
  try { s = readSession(String(b.s || "")); } catch (e) { return res.status(400).json({ error: e.code || "session_invalid" }); }
  const country = String(b.country || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ error: "bad_country" });
  if (!Array.isArray(s.it)) return res.status(200).json({ unchanged: true }); // session made before this feature

  try {
    const p = await priceCart({
      items: s.it.map(([variant_id, quantity, properties]) => ({ variant_id, quantity, properties })),
      attributes: s.ca, market_country: country, ship_country: country,
    }, { checkDrawer: false });
    if (p.market === s.mk) return res.status(200).json({ unchanged: true });
    // Same products and quantities as the original cart, or refuse
    const same = p.lines.length === s.order.l.length && p.lines.every((l, i) => l[0] === s.order.l[i][0] && l[1] === s.order.l[i][1]);
    if (!same) return res.status(200).json({ unchanged: true });
    const { exp: _e, v: _v, ...keep } = s;
    const token = createSession({ ...keep, mk: p.market, cur: p.currency, tot: p.total, gross: p.gross,
      disp: p.display, title: p.title, desc: p.description, order: p.order });
    const next = readSession(token);
    return res.status(200).json({ s: token, session: view(next) });
  } catch (e) {
    console.error("reprice_error", e.code || e);
    return res.status(200).json({ unchanged: true }); // keep the current price; checkout still works
  }
}
