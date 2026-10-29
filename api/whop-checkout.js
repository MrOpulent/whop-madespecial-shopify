// api/whop-checkout.js — LEGACY / fallback flow: sends the shopper to Whop's hosted checkout (whop.com).
// The branded checkout (api/checkout-session.js + public/index.html) replaces it; kept so old theme code keeps working.
// Env: lib/shopify.js vars + WHOP_API_KEY, WHOP_COMPANY_ID (biz_...), WHOP_PRODUCT_ID, ALLOWED_ORIGIN, THANK_YOU_URL
import { priceCart, orderAttributes } from "../lib/pricing.js";
import { createCheckout } from "../lib/whop.js";
import { cors } from "../lib/http.js";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).end();
  try {
    if (!process.env.WHOP_PRODUCT_ID) {
      console.error("WHOP_PRODUCT_ID missing: run /api/whop-setup once");
      return res.status(500).json({ error: "server_error" });
    }
    const b = req.body || {};
    const p = await priceCart(b);
    const cfg = await createCheckout({
      plan: {
        product_id: process.env.WHOP_PRODUCT_ID,
        currency: p.currency.toLowerCase(),
        plan_type: "one_time",
        initial_price: p.total / 100,
        title: p.title,
        description: p.description,
      },
      metadata: { order: JSON.stringify(p.order), attrs: JSON.stringify(orderAttributes(b.attributes, b.tracking)) },
      redirect_url: process.env.THANK_YOU_URL || "https://madespecial.store/pages/thank-you",
    });
    return res.status(200).json({ url: cfg.purchase_url });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.code });
    console.error("checkout_error", e);
    return res.status(500).json({ error: "server_error" });
  }
}
