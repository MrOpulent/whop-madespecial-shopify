// api/whop-webhook.js — Whop payment succeeded -> paid Shopify order (same prices + discount as the cart).
// Env: lib/shopify.js vars + WHOP_API_KEY, WHOP_WEBHOOK_SECRET
import { adminGql } from "../lib/shopify.js";
import { verifyWebhook, getPayment } from "../lib/whop.js";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

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
  let o, attrs = {};
  try { o = JSON.parse(d.metadata?.order); attrs = JSON.parse(d.metadata?.attrs || "{}"); }
  catch { return res.status(200).json({ error: "no_order_metadata" }); } // e.g. dashboard test event

  try {
    // Whop retries webhooks: never create the same order twice
    const tag = `whop-${d.id}`;
    const found = await adminGql(FIND, { q: `tag:'${tag}'` });
    if (found.orders.nodes.length) return res.status(200).json({ duplicate: found.orders.nodes[0].name });

    const sc = o.sc || o.c; // shop currency
    const paid = Math.round(Number(d.presentment_total ?? d.total ?? d.final_amount ?? d.subtotal ?? o.t / 100) * 100);
    // Branded checkout (api/pay.js) sends the buyer's details in metadata.ship (v2). Otherwise (Whop-hosted
    // checkout) they come from Whop's payment; if the webhook lacks them, read the payment.
    let form = null; try { const x = JSON.parse(d.metadata?.ship || "null"); if (x && x.v === 2 && x.s) form = x; } catch {}
    let p = d;
    if (!form && (!p.shipping_address || !(p.customer_email || p.user?.email))) {
      try { p = { ...d, ...(await getPayment(d.id)) }; } catch (e) { console.error("getPayment", e.message); }
    }
    const fromForm = (a) => a && { name: `${a.first_name} ${a.last_name}`.trim(), first: a.first_name, last: a.last_name,
      line1: a.address1, line2: a.address2, city: a.city, state: a.province, postal_code: a.zip, country: a.country_code };
    const sa = form ? fromForm(form.s) : (p.shipping_address || p.billing_address || {});
    const ba = form ? (fromForm(form.b) || sa) : sa;
    const email = (form && form.email) || p.customer_email || p.user?.email || p.email || null;
    const rawPhone = (form && form.phone) || p.customer_phone || p.member?.phone || p.membership?.phone_number || null;
    // Shopify only accepts valid international numbers (+447911123456). Fix the format, or keep the raw number in the note.
    const phone = (() => {
      if (!rawPhone) return null;
      const s = String(rawPhone).trim(), cc = sa.country ? String(sa.country).toUpperCase() : undefined;
      const n = parsePhoneNumberFromString(s, cc) || parsePhoneNumberFromString(s.startsWith("+") ? s : `+${s.replace(/\D/g, "")}`);
      return n && n.isValid() ? n.number : null;
    })();
    const phoneNote = rawPhone && !phone ? ` — phone (not valid for Shopify): ${rawPhone}` : "";
    const toAddr = (x) => {
      const [first, ...rest] = String(x.name || p.user?.name || "").trim().split(/\s+/);
      return {
        firstName: x.first || first || null, lastName: x.last || rest.join(" ") || first || null, phone,
        address1: x.line1 || null, address2: x.line2 || null, city: x.city || null,
        provinceCode: x.state || null, zip: x.postal_code ? String(x.postal_code).toUpperCase() : null,
        countryCode: x.country ? String(x.country).toUpperCase() : null,
      };
    };
    const addr = toAddr(sa), billAddr = toAddr(ba);
    const noAddress = !form && !p.shipping_address;

    const order = {
      email,
      ...(phone && { phone }),
      currency: sc,
      ...(o.c !== sc && { presentmentCurrency: o.c }),
      lineItems: o.l.map(([v, q, u, su]) => ({
        variantId: `gid://shopify/ProductVariant/${v}`, quantity: q, priceSet: bag(su ?? u, sc, u, o.c),
        requiresShipping: true, // physical product: shows as needing delivery
      })),
      // Delivery method shown on the order (free worldwide shipping). Rename via SHIPPING_TITLE if you like.
      shippingLines: [{ title: process.env.SHIPPING_TITLE || "Standard", code: "STANDARD", source: "whop", priceSet: bag(0, sc, 0, o.c) }],
      ...(o.d > 0 && { discountCode: { itemFixedDiscountCode: { code: "BUNDLE-UPSELL", amountSet: bag(o.sd ?? o.d, sc, o.d, o.c) } } }),
      // Tracking (RedTrack click ID, UTMs, ad IDs) + cart attributes -> order "Additional details"
      customAttributes: [...Object.entries(attrs).map(([key, value]) => ({ key, value: String(value) })), { key: "whop_payment_id", value: String(d.id) }],
      financialStatus: "PAID",
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "Whop", amountSet: bag(o.st ?? o.t, sc, o.t, o.c) }],
      ...(addr.address1 && { shippingAddress: addr, billingAddress: billAddr.address1 ? billAddr : addr }),
      tags: ["whop", tag, ...(form?.marketing ? ["accepts-marketing"] : []), ...(Math.abs(paid - o.t) > 1 ? ["whop-amount-check"] : []), ...(noAddress ? ["whop-no-shipping-address"] : [])],
      note: `Whop payment ${d.id}${noAddress ? " — no shipping address from Whop, used billing address; confirm with the customer" : ""}${phoneNote}`,
    };
    const options = { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: true };
    const noRegion = (a, src) => ({ ...a, provinceCode: null, address2: [a.address2, src.state].filter(Boolean).join(", ") || null });
    // Try the full order; if Shopify rejects a detail (region code, phone format, address), retry with less
    // so a paid order is never lost. Each fallback is noted on the order.
    const attempts = [
      ["full", order],
      ["no region code", { ...order, ...(addr.address1 && { shippingAddress: noRegion(addr, sa), billingAddress: noRegion(billAddr.address1 ? billAddr : addr, billAddr.address1 ? ba : sa) }) }],
      ["no phone", (() => { const { phone: _p, ...rest } = order;
                            return { ...rest, ...(addr.address1 && { shippingAddress: { ...noRegion(addr, sa), phone: null },
                                                                     billingAddress: { ...noRegion(billAddr.address1 ? billAddr : addr, billAddr.address1 ? ba : sa), phone: null } }) }; })()],
      ["no address", (() => { const { phone: _p, shippingAddress: _s, billingAddress: _b, ...rest } = order;
                              return { ...rest, note: `${order.note} — Shopify rejected the address; Whop address: ${JSON.stringify(sa)} phone: ${rawPhone || "-"}` }; })()],
      // Last resort: no customer details at all, everything kept in the note. A paid order must always exist.
      ["minimal", (() => { const { phone: _p, email: _e, shippingAddress: _s, billingAddress: _b, ...rest } = order;
                           return { ...rest, note: `${order.note} — details rejected by Shopify; email: ${email || "-"} phone: ${rawPhone || "-"} address: ${JSON.stringify(sa)}` }; })()],
    ];
    let r, used;
    for (const [label, ord] of attempts) {
      r = await adminGql(CREATE, { order: label === "full" ? ord : { ...ord, tags: [...ord.tags, `whop-fallback-${label.replace(/ /g, "-")}`] }, options });
      used = label;
      if (!r.orderCreate.userErrors.length) break;
      console.error(`orderCreate (${label})`, JSON.stringify(r.orderCreate.userErrors));
    }
    if (used !== "full") console.error("order created with fallback:", used);

    // Optional: report the sale to RedTrack directly (only if its Shopify integration doesn't pick these orders up)
    const clickid = Object.entries(attrs).find(([k]) => /clickid/i.test(k))?.[1];
    if (process.env.REDTRACK_POSTBACK_URL && clickid && !r.orderCreate.userErrors.length) {
      const u = new URL(process.env.REDTRACK_POSTBACK_URL);
      u.searchParams.set("clickid", clickid);
      u.searchParams.set("sum", amt(o.st ?? o.t));
      u.searchParams.set("type", process.env.REDTRACK_EVENT || "Purchase");
      try { await fetch(u); } catch (e) { console.error("redtrack_postback", e.message); }
    }

    const err = r.orderCreate.userErrors;
    if (err.length) { console.error("orderCreate", JSON.stringify(err)); return res.status(500).json({ err }); }
    return res.status(200).json({ order: r.orderCreate.order.name });
  } catch (e) {
    console.error("webhook_error", e);
    return res.status(500).json({ error: "server_error" }); // 500 => Whop retries
  }
}
