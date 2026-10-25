// api/whop-checkout.js — prices the cart with Shopify, then creates a Whop checkout for that exact total.
// Kaching tiers/variant offers and Essential Cart upsell discounts are Shopify discounts, so Shopify
// applies them here exactly as on its own checkout. Nothing is priced by the browser or hard-coded.
// Env: lib/shopify.js vars + WHOP_API_KEY, WHOP_COMPANY_ID (biz_...), ALLOWED_ORIGIN, THANK_YOU_URL
import { storefrontGql } from "../lib/shopify.js";
import { validateShipping } from "../lib/validate.js";
import { createCheckout } from "../lib/whop.js";

const PRICE_COUNTRY = "US"; // Whop charges in this market's currency (USD)

const CART_CREATE = `mutation($input: CartInput!) {
  cartCreate(input: $input) {
    cart {
      cost { totalAmount { amount currencyCode } }
      lines(first: 50) { nodes {
        quantity
        merchandise { ... on ProductVariant { id title product { title } } }
        cost { amountPerQuantity { amount } }
      } }
    }
    userErrors { field message }
  }
}`;

const cents = (x) => Math.round(Number(x) * 100);
const attrs = (o) => Object.entries(o || {})
  .filter(([, v]) => v !== null && v !== undefined && v !== "")
  .map(([key, v]) => ({ key, value: typeof v === "string" ? v : JSON.stringify(v) }));

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "https://madespecial.store");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const b = req.body || {};
    const items = (b.items || []).filter((i) => Number(i.quantity) > 0).slice(0, 30);
    if (!items.length) return res.status(400).json({ error: "empty_cart" });

    const ship = Object.fromEntries(["email","first_name","last_name","phone","address1","address2","city","province","province_name","zip","country_code"]
      .map((k) => [k, String(b.shipping?.[k] || "").trim().slice(0, 120)]));
    ship.name = `${ship.first_name} ${ship.last_name}`.trim();
    const bad = validateShipping(ship);
    if (bad.length) return res.status(400).json({ error: "invalid_shipping", fields: bad });

    // 1) Shopify prices the cart (same lines + properties + attributes as the drawer)
    const data = await storefrontGql(CART_CREATE, { input: {
      lines: items.map((i) => ({
        merchandiseId: `gid://shopify/ProductVariant/${Number(i.variant_id)}`,
        quantity: Math.min(Number(i.quantity), 20),
        attributes: attrs(i.properties),
      })),
      attributes: attrs(b.attributes),
      buyerIdentity: { countryCode: PRICE_COUNTRY },
    }});
    const out = data.cartCreate;
    if (!out.cart || out.userErrors.length) {
      console.error("cartCreate", JSON.stringify(out.userErrors));
      return res.status(400).json({ error: "cart_invalid" });
    }

    const currency = out.cart.cost.totalAmount.currencyCode;
    const total = cents(out.cart.cost.totalAmount.amount);
    const lines = out.cart.lines.nodes.map((n) => [
      Number(n.merchandise.id.split("/").pop()), n.quantity, cents(n.cost.amountPerQuantity.amount),
    ]);
    const gross = lines.reduce((sum, [, q, u]) => sum + q * u, 0);
    if (total <= 0) return res.status(400).json({ error: "zero_total" });

    // 2) Safety check: Shopify's total must equal what the drawer showed
    if (b.currency === currency && Math.abs(total - Number(b.total_price)) > 1) {
      console.error("PRICE_MISMATCH", JSON.stringify({ shopify: total, drawer: b.total_price, items }));
      return res.status(409).json({ error: "price_mismatch" });
    }

    // 3) Whop checkout for that exact amount; order details ride along in metadata
    const qty = lines.reduce((sum, [, q]) => sum + q, 0);
    const cfg = await createCheckout({
      plan: {
        currency: currency.toLowerCase(),
        plan_type: "one_time",
        initial_price: total / 100,
        title: `${out.cart.lines.nodes[0].merchandise.product.title}${qty > 1 ? ` (${qty} items)` : ""}`.slice(0, 80),
      },
      metadata: {
        order: JSON.stringify({ l: lines, d: gross - total, t: total, c: currency }),
        ship: JSON.stringify(ship),
      },
      redirect_url: process.env.THANK_YOU_URL || "https://madespecial.store/pages/thank-you",
    });

    return res.status(200).json({ url: cfg.purchase_url });
  } catch (e) {
    console.error("checkout_error", e);
    return res.status(500).json({ error: "server_error" });
  }
}
