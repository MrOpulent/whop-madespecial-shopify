// api/session.js — the checkout page reads its (signed) session: what to show and how much to charge.
// Env: WHOP_COMPANY_ID, optional STORE_NAME / STORE_URL / STORE_LOGO_URL / SHIPPING_TITLE
import { readSession } from "../lib/session.js";

// Shipping name shown on the checkout and on the Shopify order (Vercel: SHIPPING_TITLE)
export const SHIP_TITLE = () => process.env.SHIPPING_TITLE || "Tracked Shipping";
// Estimated delivery, from SHIPPING_DAYS = "min-max" business days (e.g. "7-12"). Not set = no estimate shown.
export function delivery(from = new Date()) {
  const m = String(process.env.SHIPPING_DAYS || "").match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
  if (!m) return null;
  const add = (n) => { const d = new Date(from); while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6) n--; } return d; };
  const min = add(+m[1]), max = add(+(m[2] || m[1]));
  const f = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return { min: min.toISOString().slice(0, 10), max: max.toISOString().slice(0, 10), text: +m[1] === +(m[2] || m[1]) ? f(min) : `${f(min)} – ${f(max)}` };
}

// What the checkout page needs (also returned by api/reprice.js)
export function view(s) {
  const store = (process.env.STORE_URL || "https://madespecial.store").replace(/\/$/, "");
  return {
    accountId: process.env.WHOP_COMPANY_ID,
    currency: s.cur, amount: s.tot, subtotal: s.gross, savings: Math.max(0, s.gross - s.tot),
    journey: s.j || null, market: s.mk,
    // Microsoft Clarity: same project as the store
    clarity: { id: process.env.CLARITY_PROJECT_ID ?? "z39mlpo7cz", consent: s.cs || null },
    lines: s.disp.map((d, i) => ({ ...d, lineTotal: s.order.l[i][1] * s.order.l[i][2] })),
    expiresAt: s.exp,
    shippingTitle: SHIP_TITLE(),
    delivery: delivery(),
    store: {
      name: process.env.STORE_NAME || "MadeSpecial.Store",
      url: store,
      logo: process.env.STORE_LOGO_URL || "https://madespecial.store/cdn/shop/files/5cef140f-9cc6-4a45-a33a-4101765340fd_1.png?v=1792153094&width=350",
      cart: `${store}/cart`,
      policies: {
        refund: `${store}/policies/refund-policy`,
        privacy: `${store}/policies/privacy-policy`,
        terms: `${store}/policies/terms-of-service`,
        shipping: `${store}/policies/shipping-policy`,
      },
    },
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).end();
  try {
    const s = readSession(String(req.query?.s || ""));
    return res.status(200).json(view(s));
  } catch (e) {
    if (e.code) return res.status(400).json({ error: e.code });
    console.error("session_error", e);
    return res.status(500).json({ error: "server_error" });
  }
}
