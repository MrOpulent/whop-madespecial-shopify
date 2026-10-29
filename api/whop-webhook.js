// api/whop-webhook.js — Whop "payment succeeded" -> paid Shopify order (same prices + discount as the cart).
// Self-contained on purpose (only needs lib/shopify.js + lib/whop.js). api/reconcile.js reuses fulfil().
// Env: lib/shopify.js vars + WHOP_API_KEY, WHOP_WEBHOOK_SECRET, optional APPLOVIN_CAPI_KEY / APPLOVIN_EVENT_KEY, TIKTOK_EVENTS_TOKEN / TIKTOK_PIXEL_CODE, SNAP_CAPI_TOKEN / SNAP_PIXEL_ID, PINTEREST_CAPI_TOKEN / PINTEREST_AD_ACCOUNT_ID
import { adminGql } from "../lib/shopify.js";
import { getPayment, verifyWebhook, unpackMeta } from "../lib/whop.js";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { SHIP_TITLE, delivery } from "./session.js";
import { journey } from "../lib/http.js";
import { whopRefundToShopify } from "./shopify-webhook.js";
import { hasApplovinSignal, sendAxonPurchase } from "../lib/applovin.js";
import { hasTikTokSignal, sendTikTokPurchase } from "../lib/tiktok.js";
import { hasSnapSignal, sendSnapPurchase } from "../lib/snapchat.js";
import { hasPinterestSignal, sendPinterestCheckout } from "../lib/pinterest.js";

const amt = (c) => (c / 100).toFixed(2);

function checkoutClient(d) {
  try {
    const cx = JSON.parse(d?.metadata?.cx || "{}");
    return cx && typeof cx === "object" ? cx : {};
  } catch { return {}; }
}

// E.164 when the number is valid, otherwise the raw value so AppLovin can still hash it.
function capiPhone(raw, country) {
  if (!raw) return null;
  const s = String(raw).trim();
  const cc = country ? String(country).toUpperCase() : undefined;
  const n = parsePhoneNumberFromString(s, cc) || parsePhoneNumberFromString(s.startsWith("+") ? s : `+${s.replace(/\D/g, "")}`);
  return (n && n.isValid() ? n.number : s) || null;
}

// AppLovin Conversion API. Only called once the Shopify order (or upsell edit) has just been created,
// so webhook retries and /api/reconcile — which return at the duplicate check — do not send again.
// A failure here is logged and swallowed; it must not fail the webhook.
async function reportApplovinPurchase(d, info) {
  if (!hasApplovinSignal(info.attrs)) return;
  const cx = checkoutClient(d);
  try {
    await sendAxonPurchase({
      ...info,
      payId: d.id,
      paidAt: d.paid_at,
      ip: cx.ip || info.ip || d.ip_address || null,
      ua: cx.ua || info.ua || null,
    });
  } catch (e) { console.error("applovin_capi", e.message); }
}

// TikTok Events API. Same moment as AppLovin: only after the Shopify order exists, so a webhook
// retry or /api/reconcile (both return at the duplicate check) does not send a second Purchase.
// A failure is logged and swallowed; it must not fail the webhook.
async function reportTikTokPurchase(d, info) {
  if (!hasTikTokSignal(info.attrs)) return;
  const cx = checkoutClient(d);
  try {
    await sendTikTokPurchase({
      ...info,
      payId: d.id,
      paidAt: d.paid_at,
      ip: cx.ip || info.ip || d.ip_address || null,
      ua: cx.ua || info.ua || null,
      externalId: info.externalId || d.member_id || d.user?.id || info.email || null,
    });
  } catch (e) { console.error("tiktok_events", e.message); }
}

// Snapchat Conversions API. Same moment as the other purchase reports.
async function reportSnapPurchase(d, info) {
  if (!hasSnapSignal(info.attrs)) return;
  const cx = checkoutClient(d);
  try {
    await sendSnapPurchase({
      ...info,
      payId: d.id,
      paidAt: d.paid_at,
      ip: cx.ip || info.ip || d.ip_address || null,
      ua: cx.ua || info.ua || null,
      osVersion: cx.os || null,
      deviceModel: cx.model || null,
      externalId: info.externalId || d.member_id || d.user?.id || info.email || null,
    });
  } catch (e) { console.error("snap_capi", e.message); }
}

// Pinterest Conversions API (event name checkout). Same moment as the other purchase reports.
async function reportPinterestPurchase(d, info) {
  if (!hasPinterestSignal(info.attrs)) return;
  const cx = checkoutClient(d);
  try {
    await sendPinterestCheckout({
      ...info,
      payId: d.id,
      paidAt: d.paid_at,
      ip: cx.ip || info.ip || d.ip_address || null,
      ua: cx.ua || info.ua || null,
    });
  } catch (e) { console.error("pinterest_capi", e.message); }
}

// Shop currency + the currency the shopper actually paid in (e.g. USD shop, GBP shopper)
const bag = (shopC, shopCur, payC, payCur) => ({
  shopMoney: { amount: amt(shopC), currencyCode: shopCur },
  ...(payCur && payCur !== shopCur && { presentmentMoney: { amount: amt(payC), currencyCode: payCur } }),
});

const FIND = `query($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }`;
const CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } }
}`;

export async function fulfil(d) {
  d = d || {};
  if (d.metadata) d = { ...d, metadata: unpackMeta(d.metadata) }; // long values arrive split (500-character limit)
  if (d.metadata?.upsell_of) return fulfilUpsell(d); // post-purchase upsell -> add to the original order
  let o, attrs = {};
  try { o = JSON.parse(d.metadata?.order); attrs = JSON.parse(d.metadata?.attrs || "{}"); }
  catch { return { status: 200, body: { error: "no_order_metadata" } }; } // not a store order (e.g. dashboard test event)

  {
    // Whop retries webhooks: never create the same order twice
    const tag = `whop-${d.id}`;
    const found = await adminGql(FIND, { q: `tag:'${tag}'` });
    if (found.orders.nodes.length) return { status: 200, body: { duplicate: found.orders.nodes[0].name } };

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

    const eta = delivery(d.paid_at ? new Date(d.paid_at) : new Date());
    const order = {
      email,
      ...(phone && { phone }),
      currency: sc,
      ...(o.c !== sc && { presentmentCurrency: o.c }),
      lineItems: o.l.map(([v, q, u, su, ns], i) => ({
        variantId: `gid://shopify/ProductVariant/${v}`, quantity: q, priceSet: bag(su ?? u, sc, u, o.c),
        requiresShipping: !ns, // the drum ships; shipping protection doesn't
        // Kaching bundle details etc. (line item properties from the cart)
        ...(o.p?.[i] && Object.keys(o.p[i]).length && { properties: Object.entries(o.p[i]).map(([name, value]) => ({ name, value: String(value) })) }),
      })),
      // Delivery method shown on the order (free worldwide shipping). Rename via SHIPPING_TITLE if you like.
      shippingLines: [{ title: SHIP_TITLE(), code: "TRACKED", source: "whop", priceSet: bag(0, sc, 0, o.c) }],
      ...(o.d > 0 && { discountCode: { itemFixedDiscountCode: { code: o.dc || "BUNDLE-UPSELL", amountSet: bag(o.sd ?? o.d, sc, o.d, o.c) } } }),
      // Tracking (RedTrack click ID, UTMs, ad IDs) + cart attributes -> order "Additional details"
      customAttributes: [...Object.entries(attrs).map(([key, value]) => ({ key, value: String(value) })), { key: "whop_payment_id", value: String(d.id) },
        ...(d.metadata?.j ? [{ key: "checkout_journey_id", value: String(d.metadata.j) }] : []),
        ...(eta ? [{ key: "Estimated delivery", value: eta.text }] : [])],
      financialStatus: "PAID",
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "Whop", amountSet: bag(o.st ?? o.t, sc, o.t, o.c) }],
      ...(addr.address1 && { shippingAddress: addr, billingAddress: billAddr.address1 ? billAddr : addr }),
      tags: ["whop", tag, ...appTags(o, attrs), ...(d._tags || []), ...(form?.marketing ? ["accepts-marketing"] : []), ...(Math.abs(paid - o.t) > 1 ? ["whop-amount-check"] : []), ...(noAddress ? ["whop-no-shipping-address"] : [])],
      note: `${d._note ? d._note + " — " : ""}Whop payment ${d.id}${noAddress ? " — no shipping address from Whop, used billing address; confirm with the customer" : ""}${phoneNote}`,
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
    // Same order without line item properties, in case Shopify refuses one of them
    attempts.splice(1, 0, ["no line properties", { ...order, lineItems: order.lineItems.map(({ properties: _x, ...li }) => li) }]);
    for (const [label, ord] of attempts) {
      try { r = await adminGql(CREATE, { order: label === "full" ? ord : { ...ord, tags: [...ord.tags, `whop-fallback-${label.replace(/ /g, "-")}`] }, options }); }
      catch (e) { r = { orderCreate: { order: null, userErrors: [{ field: null, message: String(e.message).slice(0, 300) }] } }; } // keep trying
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
      // Same id the checkout page sends, so RedTrack counts one purchase when both arrive.
      if (d.metadata?.j) u.searchParams.set("eventid", String(d.metadata.j));
      try { await fetch(u); } catch (e) { console.error("redtrack_postback", e.message); }
    }

    // AppLovin, TikTok, Snapchat, and Pinterest purchases (presentment amount Whop charged: o.t cents
    // of o.c, not shop USD) and the Shopify risk card. All run after the order exists; none may fail
    // the webhook. In parallel so a slow events call does not stack on top of the risk request.
    // A separate upsell order must not reuse the parent checkout's _axon_event_id. The other event ids
    // are whop-<this payment id> either way (dedupeId overrides them for the upsell payment).
    if (!r.orderCreate.userErrors.length && r.orderCreate.order?.id) {
      const separateUpsell = (d._tags || []).includes("upsell-separate-order");
      const purchase = {
        orderName: r.orderCreate.order.name || d.id,
        attrs, email, phone: capiPhone(rawPhone, sa.country) || phone,
        country: sa.country, zip: sa.postal_code,
        firstName: sa.first || addr.firstName, lastName: sa.last || addr.lastName, city: sa.city, state: sa.state,
        currency: o.c, totalCents: o.t, lines: (o.l || []).map(([v, q, u]) => [v, q, u]),
        names: Array.isArray(o.nm) ? o.nm : undefined,
        ip: p.ip_address || null,
        ...(separateUpsell && { dedupeId: `whop-${d.id}` }),
      };
      await Promise.all([
        reportApplovinPurchase(d, purchase),
        reportTikTokPurchase(d, purchase),
        reportSnapPurchase(d, purchase),
        reportPinterestPurchase(d, purchase),
        addRisk(r.orderCreate.order.id, d, sa, ba).catch((e) => console.error("order_risk", e.message)),
      ]);
    }

    const err = r.orderCreate.userErrors;
    if (err.length) { console.error("orderCreate", JSON.stringify(err)); journey(d.metadata?.j, "order_failed", { payment: d.id, err: err.slice(0, 3) }, true); return { status: 500, body: { err } }; }
    journey(d.metadata?.j, "order_created", { payment: d.id, order: r.orderCreate.order.name, fallback: used === "full" ? null : used }, used !== "full");
    return { status: 200, body: { order: r.orderCreate.order.name, fallback: used === "full" ? undefined : used } };
  }
}

// Tags your apps normally add: Kaching Bundles (KACHING_TAG) and the post-purchase upsell (UPSELL_TAG)
const KACHING_TAG = () => process.env.KACHING_TAG || "Kaching Bundles";
export const UPSELL_TAG = () => process.env.UPSELL_TAG || "OCU Zipify Post-Purchase Upsell Bought";
function appTags(o, attrs) {
  const kaching = (o.p || []).some((p) => Object.keys(p || {}).some((k) => /kaching/i.test(k))) || Object.keys(attrs || {}).some((k) => /kaching/i.test(k));
  return kaching ? KACHING_TAG().split(",").map((t) => t.trim()).filter(Boolean) : [];
}

const EDIT_BEGIN = `mutation($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } } }`;
const EDIT_ADD = `mutation($id: ID!, $variantId: ID!, $quantity: Int!) {
  orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) { calculatedLineItem { id } userErrors { field message } } }`;
const EDIT_DISC = `mutation($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
  orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) { userErrors { field message } } }`;
const EDIT_COMMIT = `mutation($id: ID!, $staffNote: String) {
  orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) { order { id name } userErrors { field message } } }`;
const TAGS_ADD = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;
const MANUAL_PAY = `mutation($id: ID!, $name: String) { orderCreateManualPayment(id: $id, paymentMethodName: $name) { userErrors { field message } } }`;
const MARK_PAID = `mutation($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { userErrors { field message } } }`;
const ue = (x) => Object.values(x || {})[0]?.userErrors || [];

// Post-purchase upsell paid on the thank-you page: add it to the original Shopify order (like Zipify OCU does).
// If the original order can't be edited, create a separate paid order linked to it. Never both, never twice.
async function fulfilUpsell(d) {
  let u, parentPay = d.metadata.upsell_of;
  try { u = JSON.parse(d.metadata.upsell); } catch { return { status: 200, body: { error: "bad_upsell_metadata" } }; }
  const tag = `whop-${d.id}`;
  const dup = await adminGql(FIND, { q: `tag:'${tag}'` });
  if (dup.orders.nodes.length) return { status: 200, body: { duplicate: dup.orders.nodes[0].name } };

  let parent = (await adminGql(FIND, { q: `tag:'whop-${parentPay}'` })).orders.nodes[0];
  if (!parent) { await new Promise((ok) => setTimeout(ok, 8000)); parent = (await adminGql(FIND, { q: `tag:'whop-${parentPay}'` })).orders.nodes[0]; }

  if (parent) {
    let committed = false;
    try {
      const b = await adminGql(EDIT_BEGIN, { id: parent.id });
      if (ue(b).length) throw new Error(JSON.stringify(ue(b)));
      const calc = b.orderEditBegin.calculatedOrder.id;
      const a = await adminGql(EDIT_ADD, { id: calc, variantId: `gid://shopify/ProductVariant/${u.v}`, quantity: u.q });
      if (ue(a).length) throw new Error(JSON.stringify(ue(a)));
      if (u.pct > 0) {
        const x = await adminGql(EDIT_DISC, { id: calc, lineItemId: a.orderEditAddVariant.calculatedLineItem.id, discount: { percentValue: u.pct, description: "Post-purchase offer" } });
        if (ue(x).length) throw new Error(JSON.stringify(ue(x)));
      }
      const c = await adminGql(EDIT_COMMIT, { id: calc, staffNote: `Post-purchase upsell paid with Whop payment ${d.id}: ${(u.t / 100).toFixed(2)} ${u.c}` });
      if (ue(c).length) throw new Error(JSON.stringify(ue(c)));
      committed = true;
    } catch (e) { console.error("upsell_order_edit", e.message); }

    if (committed) {
      // Mark it as ours first (prevents a second add on retries), then record the payment
      try { const t = await adminGql(TAGS_ADD, { id: parent.id, tags: [tag, ...UPSELL_TAG().split(",").map((x) => x.trim()).filter(Boolean)] }); if (ue(t).length) console.error("upsell_tags", JSON.stringify(ue(t))); }
      catch (e) { console.error("upsell_tags", e.message); }
      try {
        const m = await adminGql(MANUAL_PAY, { id: parent.id, name: "Whop" });
        if (ue(m).length) { const m2 = await adminGql(MARK_PAID, { input: { id: parent.id } }); if (ue(m2).length) console.error("upsell_paid", JSON.stringify(ue(m2))); }
      } catch (e) {
        try { await adminGql(MARK_PAID, { input: { id: parent.id } }); } catch (e2) { console.error("upsell_paid", e2.message); }
      }
      let upAttrs = {}, ship = {};
      try { upAttrs = JSON.parse(d.metadata?.attrs || "{}"); } catch { /* attrs stay empty */ }
      try { ship = JSON.parse(d.metadata?.ship || "{}"); } catch { /* ship stays empty */ }
      // After the payment is recorded. dedupe is the upsell payment id, not the parent's event id.
      const purchase = {
        orderName: `${parent.name}:${d.id}`,
        attrs: upAttrs, email: ship.email || null, phone: capiPhone(ship.phone, ship.s?.country_code),
        country: ship.s?.country_code, zip: ship.s?.zip,
        firstName: ship.s?.first_name, lastName: ship.s?.last_name, city: ship.s?.city, state: ship.s?.province,
        externalId: ship.email || null,
        currency: u.c, totalCents: u.t, lines: [[u.v, u.q, u.u]],
        names: u.n ? [u.n] : undefined,
        dedupeId: `whop-${d.id}`,
      };
      await Promise.all([
        reportApplovinPurchase(d, purchase),
        reportTikTokPurchase(d, purchase),
        reportSnapPurchase(d, purchase),
        reportPinterestPurchase(d, purchase),
      ]);
      journey(d.metadata?.j, "upsell_added_to_order", { payment: d.id, order: parent.name });
      return { status: 200, body: { order: parent.name, upsell: "added_to_order" } };
    }
  }
  // Fallback: separate paid order with the same customer, address and tracking
  const o = { l: [[u.v, u.q, u.u, u.su]], c: u.c, t: u.t, d: u.q * u.u - u.t, sc: u.sc, st: u.st, sd: u.q * u.su - u.st, dc: "POST-PURCHASE", ...(u.n && { nm: [String(u.n).slice(0, 120)] }) };
  return fulfil({ ...d, metadata: { order: JSON.stringify(o), attrs: d.metadata.attrs, ship: d.metadata.ship, j: d.metadata.j, cx: d.metadata.cx },
    _tags: [...UPSELL_TAG().split(",").map((x) => x.trim()).filter(Boolean), "upsell-separate-order"],
    _note: `Post-purchase upsell for ${parent ? parent.name : `Whop payment ${parentPay}`} (could not be added to that order)` });
}

const RISK = `mutation($i: OrderRiskAssessmentCreateInput!) {
  orderRiskAssessmentCreate(orderRiskAssessmentInput: $i) { userErrors { field message } }
}`;
// Whop's risk score, 3-D Secure, CVC/AVS checks and IP -> Shopify "Order risk" (High / Medium / Low)
async function addRisk(orderId, d, sa, ba) {
  let p = d;
  if (p.risk_score === undefined || p.verification_checks === undefined) {
    try { p = { ...d, ...(await getPayment(d.id)) }; } catch (e) { console.error("risk getPayment", e.message); }
  }
  const facts = [], add = (description, sentiment) => facts.push({ description: description.slice(0, 256), sentiment });
  const score = typeof p.risk_score === "number" ? p.risk_score : null;
  let level = score === null ? "LOW" : score >= 75 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW";
  if (score !== null) add(`Whop risk score ${score}/100`, score >= 75 ? "NEGATIVE" : score >= 40 ? "NEUTRAL" : "POSITIVE");
  if (p.three_ds_verified === true) add("Card verified with 3-D Secure", "POSITIVE");
  const v = p.verification_checks || {}, bad = [];
  const chk = (val, label) => {
    if (!val) return;
    const x = String(val).toLowerCase();
    if (/^(pass|match|y|yes|true)/.test(x)) add(`${label} matched`, "POSITIVE");
    else if (/^(fail|mismatch|no_match|n|no|false)/.test(x)) { add(`${label} did not match`, "NEGATIVE"); bad.push(label); }
    else add(`${label}: ${val}`, "NEUTRAL");
  };
  chk(v.card_security_code, "Card security code (CVC)");
  chk(v.address_line1, "Billing street address (AVS)");
  chk(v.zip_code, "Billing postal code (AVS)");
  chk(v.card_holder_name, "Cardholder name");
  if (bad.includes("Card security code (CVC)") || bad.length >= 2) level = level === "HIGH" ? "HIGH" : "MEDIUM";
  if (sa.country && ba.country && String(sa.country).toUpperCase() !== String(ba.country).toUpperCase())
    add(`Billing country (${ba.country}) differs from shipping country (${sa.country})`, "NEUTRAL");
  const card = p.payment_instrument?.card;
  if (p.payment_instrument) add(`Paid with ${p.payment_instrument.display_name || p.payment_instrument.payment_method_type}${card?.last4 ? ` •••• ${card.last4}` : ""}`, "NEUTRAL");
  if (p.ip_address) add(`Customer IP address ${p.ip_address}`, "NEUTRAL");
  if (!facts.length) add("Paid through Whop (no risk details returned)", "NEUTRAL");
  const r = await adminGql(RISK, { i: { orderId, riskLevel: level, facts: facts.slice(0, 20) } });
  if (r.orderRiskAssessmentCreate.userErrors.length) console.error("order_risk", JSON.stringify(r.orderRiskAssessmentCreate.userErrors));
}

export const config = { api: { bodyParser: false } }; // raw body for signature check

const rawBody = (req) => new Promise((ok, fail) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); req.on("error", fail);
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  let evt;
  try { evt = verifyWebhook(await rawBody(req), req.headers); }
  catch (e) { console.error("webhook_verify", e.message); return res.status(401).json({ error: "bad_signature" }); }

  const type = evt.type || evt.action;
  // A refund made in Whop (dashboard, dispute...) -> recorded on the Shopify order, which is cancelled once fully refunded
  if (["refund.created", "refund.updated"].includes(type)) {
    try { const r = await whopRefundToShopify(evt.data); return res.status(r.status).json(r.body); }
    catch (e) { console.error("whop_refund_to_shopify", e.message); return res.status(500).json({ error: "server_error" }); } // Whop retries
  }
  if (!["payment.succeeded", "payment_succeeded"].includes(type)) return res.status(200).json({ skipped: type });
  try {
    const r = await fulfil(evt.data);
    return res.status(r.status).json(r.body);
  } catch (e) {
    console.error("webhook_error", e);
    return res.status(500).json({ error: "server_error" }); // 500 => Whop retries
  }
}
