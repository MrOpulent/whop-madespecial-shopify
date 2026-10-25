// api/whop-webhook.js — Whop payment succeeded -> paid Shopify order (same prices + discount as the cart).
// Env: lib/shopify.js vars + WHOP_WEBHOOK_SECRET
import { adminGql } from "../lib/shopify.js";
import { verifyWebhook } from "../lib/whop.js";

export const config = { api: { bodyParser: false } }; // raw body for signature check

const rawBody = (req) => new Promise((ok, fail) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); req.on("error", fail);
});
const amt = (c) => (c / 100).toFixed(2);
// Shop currency + the currency the shopper actually paid in (e.g. USD shop, GBP shopper)
const bag = (shopC, shopCur, payC, payCur) => ({
  shopMoney: { amount: amt(shopC), currencyCode: shopCur },
  ...(payCur && payCur !== shopCur && { presentmentMoney: { amount: amt(payC), currencyCode: payCur } }),
});

const FIND = `query($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }`;
const CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } }
}`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let evt;
  try { evt = verifyWebhook(await rawBody(req), req.headers); }
  catch (e) { console.error("webhook_verify", e.message); return res.status(401).json({ error: "bad_signature" }); }

  const type = evt.type || evt.action;
  if (!["payment.succeeded", "payment_succeeded"].includes(type)) return res.status(200).json({ skipped: type });

  const d = evt.data || {};
  let o, s;
  try { o = JSON.parse(d.metadata?.order); s = JSON.parse(d.metadata?.ship || "{}"); }
  catch { return res.status(200).json({ error: "no_order_metadata" }); } // e.g. dashboard test event

  try {
    // Whop retries webhooks: never create the same order twice
    const tag = `whop-${d.id}`;
    const found = await adminGql(FIND, { q: `tag:'${tag}'` });
    if (found.orders.nodes.length) return res.status(200).json({ duplicate: found.orders.nodes[0].name });

    const sc = o.sc || o.c; // shop currency
    const paid = Math.round(Number(d.presentment_total ?? d.total ?? d.final_amount ?? d.subtotal ?? o.t / 100) * 100);
    const [first, ...rest] = (s.name || "").split(" ");
    const addr = {
      firstName: s.first_name || first, lastName: s.last_name || rest.join(" ") || first, phone: s.phone || null,
      address1: s.address1, address2: s.address2 || null, city: s.city,
      provinceCode: s.province || s.province_name || null, zip: (s.zip || "").toUpperCase() || null, countryCode: s.country_code,
    };

    const order = {
      email: s.email || d.user?.email,
      currency: sc,
      ...(o.c !== sc && { presentmentCurrency: o.c }),
      lineItems: o.l.map(([v, q, u, su]) => ({
        variantId: `gid://shopify/ProductVariant/${v}`, quantity: q, priceSet: bag(su ?? u, sc, u, o.c),
      })),
      ...(o.d > 0 && { discountCode: { itemFixedDiscountCode: { code: "BUNDLE-UPSELL", amountSet: bag(o.sd ?? o.d, sc, o.d, o.c) } } }),
      financialStatus: "PAID",
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "Whop", amountSet: bag(o.st ?? o.t, sc, o.t, o.c) }],
      shippingAddress: addr, billingAddress: addr,
      tags: ["whop", tag, ...(Math.abs(paid - o.t) > 1 ? ["whop-amount-check"] : [])],
      note: `Whop payment ${d.id}`,
    };
    const options = { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: true };
    let r = await adminGql(CREATE, { order, options });

    // A region Shopify doesn't know as a province code: keep it in the address text instead and retry once
    if (r.orderCreate.userErrors.length && addr.provinceCode) {
      const a2 = { ...addr, provinceCode: null, address2: [addr.address2, s.province_name || s.province].filter(Boolean).join(", ") };
      r = await adminGql(CREATE, { order: { ...order, shippingAddress: a2, billingAddress: a2 }, options });
    }

    const err = r.orderCreate.userErrors;
    if (err.length) { console.error("orderCreate", JSON.stringify(err)); return res.status(500).json({ err }); }
    return res.status(200).json({ order: r.orderCreate.order.name });
  } catch (e) {
    console.error("webhook_error", e);
    return res.status(500).json({ error: "server_error" }); // 500 => Whop retries
  }
}
