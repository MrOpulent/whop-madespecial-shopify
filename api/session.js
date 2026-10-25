// api/session.js — the checkout page reads its (signed) session: what to show and how much to charge.
// Env: WHOP_COMPANY_ID, optional STORE_NAME / STORE_URL / STORE_LOGO_URL / SHIPPING_TITLE
import { readSession } from "../lib/session.js";

// What the checkout page needs (also returned by api/reprice.js)
export function view(s) {
  const store = (process.env.STORE_URL || "https://madespecial.store").replace(/\/$/, "");
  return {
    accountId: process.env.WHOP_COMPANY_ID,
    currency: s.cur, amount: s.tot, subtotal: s.gross, savings: Math.max(0, s.gross - s.tot),
    market: s.mk, lines: s.disp.map((d, i) => ({ ...d, lineTotal: s.order.l[i][1] * s.order.l[i][2] })),
    expiresAt: s.exp,
    shippingTitle: process.env.SHIPPING_TITLE || "Free Standard Shipping",
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
