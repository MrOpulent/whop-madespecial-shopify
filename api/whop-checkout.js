// api/whop-checkout.js — prices the cart with Shopify, then creates a Whop checkout for that exact total.
// Kaching tiers/variant offers and Essential Cart upsell discounts are Shopify discounts, so Shopify
// applies them here exactly as on its own checkout. Nothing is priced by the browser or hard-coded.
// Env: lib/shopify.js vars + WHOP_API_KEY, WHOP_COMPANY_ID (biz_...), ALLOWED_ORIGIN, THANK_YOU_URL
import { storefrontGql } from "../lib/shopify.js";
import { validateShipping, ISO } from "../lib/validate.js";
import { createCheckout } from "../lib/whop.js";

// Shop's base market (its own currency, e.g. USD). Each checkout is charged in the SHOPPER's market currency
// (GBP for a UK shopper, EUR for Germany...) at Shopify's own Markets price, so Whop never converts it.
const SHOP_COUNTRY = process.env.SHOP_COUNTRY || "US";

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
// Whop plan titles max 30 chars: "Margaret's Hand-Tuned Rain Drum" + " ×3" -> "Margaret's Hand-Tuned Rain… ×3"
const planTitle = (name, qty) => {
  const suffix = qty > 1 ? ` ×${qty}` : "", room = 30 - suffix.length;
  return (name.length > room ? name.slice(0, room - 1).trimEnd() + "…" : name) + suffix;
};
// Shopify countries and the currency each one is sold in (Markets). Cached for 10 minutes.
let countriesCache = { at: 0, list: [] };
async function marketCountries() {
  if (Date.now() - countriesCache.at < 600000 && countriesCache.list.length) return countriesCache.list;
  const d = await storefrontGql(`{ localization { availableCountries { isoCode currency { isoCode } } } }`);
  countriesCache = { at: Date.now(), list: d.localization.availableCountries };
  return countriesCache.list;
}
// The market to price in = one whose currency is the drawer's currency (GBP drawer -> a GBP market).
// Prefers the market the page reported, then the shipping country, then any country in that currency.
async function pickMarket(pageCountry, shipCountry, drawerCurrency) {
  const want = String(drawerCurrency || "").toUpperCase();
  const list = await marketCountries();
  const cur = (c) => list.find((x) => x.isoCode === c)?.currency.isoCode;
  for (const c of [pageCountry, shipCountry]) if (c && cur(c) === want) return c;
  return list.find((x) => x.currency.isoCode === want)?.isoCode || (ISO.includes(pageCountry) ? pageCountry : SHOP_COUNTRY);
}
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

    // 1) Shopify prices the cart twice: in the shopper's market currency (what Whop charges)
    //    and in the shop's base currency (for the Shopify order's accounting). Same lines, properties, attributes.
    const market = await pickMarket(b.market_country, ship.country_code, b.currency);
    const input = (countryCode) => ({ input: {
      lines: items.map((i) => ({
        merchandiseId: `gid://shopify/ProductVariant/${Number(i.variant_id)}`,
        quantity: Math.min(Number(i.quantity), 20),
        attributes: attrs(i.properties),
      })),
      attributes: attrs(b.attributes),
      buyerIdentity: { countryCode },
    }});
    const [pm, sm] = await Promise.all([
      storefrontGql(CART_CREATE, input(market)),
      market === SHOP_COUNTRY ? null : storefrontGql(CART_CREATE, input(SHOP_COUNTRY)),
    ]);
    const out = pm.cartCreate, base = sm ? sm.cartCreate : out;
    if (!out.cart || out.userErrors.length || !base.cart || base.userErrors.length) {
      console.error("cartCreate", JSON.stringify([out.userErrors, base.userErrors]));
      return res.status(400).json({ error: "cart_invalid" });
    }

    const currency = out.cart.cost.totalAmount.currencyCode;         // what the shopper pays in
    const total = cents(out.cart.cost.totalAmount.amount);
    const shopCurrency = base.cart.cost.totalAmount.currencyCode;    // shop's base currency
    const shopTotal = cents(base.cart.cost.totalAmount.amount);
    const nodes = out.cart.lines.nodes, baseNodes = base.cart.lines.nodes;
    if (nodes.length !== baseNodes.length || nodes.some((n, i) => n.merchandise.id !== baseNodes[i].merchandise.id)) {
      console.error("cart line mismatch between markets");
      return res.status(400).json({ error: "cart_invalid" });
    }
    // [variantId, qty, unit price in shopper currency, unit price in shop currency]
    const lines = nodes.map((n, i) => [
      Number(n.merchandise.id.split("/").pop()), n.quantity,
      cents(n.cost.amountPerQuantity.amount), cents(baseNodes[i].cost.amountPerQuantity.amount),
    ]);
    const gross = lines.reduce((sum, [, q, u]) => sum + q * u, 0);
    const shopGross = lines.reduce((sum, [, q, , su]) => sum + q * su, 0);
    if (total <= 0) return res.status(400).json({ error: "zero_total" });

    // 2) Safety check: Shopify's total must equal what the drawer showed
    if (b.currency !== currency || Math.abs(total - Number(b.total_price)) > 1) {
      console.error("PRICE_MISMATCH", JSON.stringify({ shopify: [total, currency], drawer: [b.total_price, b.currency], market, items }));
      return res.status(409).json({ error: "price_mismatch" });
    }

    // 3) Whop checkout for that exact amount; order details ride along in metadata
    const qty = lines.reduce((sum, [, q]) => sum + q, 0);
    const cfg = await createCheckout({
      plan: {
        currency: currency.toLowerCase(),
        plan_type: "one_time",
        initial_price: total / 100,
        title: planTitle(nodes[0].merchandise.product.title, qty), // Whop limit: 30 characters
        description: nodes.map((n) => `${n.quantity}× ${n.merchandise.product.title}${
          n.merchandise.title && n.merchandise.title !== "Default Title" ? ` (${n.merchandise.title})` : ""}`).join(", ").slice(0, 250),
      },
      metadata: {
        order: JSON.stringify({ l: lines, c: currency, t: total, d: gross - total, sc: shopCurrency, st: shopTotal, sd: shopGross - shopTotal }),
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
