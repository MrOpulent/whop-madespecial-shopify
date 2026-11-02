// api/reprice.js — the shopper changed the delivery country: re-price the same cart (same Kaching offers/upsell
// discounts) in that country's Shopify market currency, using Shopify's own prices and conversion.
// Returns a new signed checkout session. Env: same as api/checkout-session.js
import { readSession } from "../lib/session.js";
import { loadCheckoutPrice, checkoutToken } from "../lib/discount.js";
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
    const p = await loadCheckoutPrice(s, country, s.dc || []);
    if (p.market === s.mk) return res.status(200).json({ unchanged: true });
    let token;
    try { token = await checkoutToken(s, p, s.wp || null); }
    catch (e) {
      if (!s.wp || (e.code !== "invalid_code" && e.code !== "discount_unusable")) throw e;
      token = await checkoutToken(s, p, null); // a fixed Whop amount that does not fit this currency
    }
    const next = readSession(token);
    return res.status(200).json({ s: token, session: view(next) });
  } catch (e) {
    console.error("reprice_error", e.code || e);
    return res.status(200).json({ unchanged: true }); // keep the current price; checkout still works
  }
}
