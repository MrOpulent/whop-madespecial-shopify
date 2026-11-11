// api/shopify-webhook.js — refunds kept in step between Shopify and Whop, both ways.
//
// Shopify -> Whop (this endpoint, Shopify notifications):
//  • refunds/create: a refund made in Shopify (Refund button, or "Refund payment" when cancelling) is refunded in Whop
//    to the shopper's original payment method, for the same amount, in the currency they paid.
//  • orders/cancelled: an order cancelled WITHOUT refunding gets whatever is still unrefunded refunded in Whop,
//    and the refund is recorded on the Shopify order (turn off with REFUND_ON_CANCEL=false).
//  • fulfillments/create and fulfillments/update: when a vendor adds a carrier tracking number, and the order's
//    Payment method is PayPal, that number is sent to Whop (POST /shipments) on the Whop payment. Card orders
//    are left alone. Whop already holds the PayPal charge, so this does not call PayPal.
//  An order can hold several Whop payments (original + post-purchase upsell): the original is refunded first.
//  Tracking is attached to the original payment only (the one stored as whop_payment_id).
//
// Whop -> Shopify (whopRefundToShopify, called by api/whop-webhook.js on refund.created / refund.updated):
//  • a refund made in Whop (dashboard, dispute, etc.) is recorded on the Shopify order; once the order is fully
//    refunded it is cancelled (items restocked, no second refund, customer not emailed).
//
// No loops, no double refunds: Whop refunds started here carry metadata source=shopify (ignored on the way back);
// Shopify refunds recorded here have a note starting with [whop] (ignored on the way back); every Whop refund has an
// idempotency key, and every Whop refund is recorded on Shopify only once (its rf_ id is in the note).
//
// Register the Shopify notifications once: /api/whop-setup?key=<SETUP_KEY>&shopify_webhooks=1
// Env: SHOPIFY_CLIENT_SECRET (app webhooks) and/or SHOPIFY_WEBHOOK_SECRET (webhooks made in Shopify admin), REFUND_ON_CANCEL
import crypto from "node:crypto";
import { adminGql } from "../lib/shopify.js";
import { createShipment, getPayment, refundPayment, scopeProblem } from "../lib/whop.js";
import { journey } from "../lib/http.js";

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const rawBody = (req) => new Promise((ok, fail) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); req.on("error", fail); });

function verified(raw, hmac) {
  if (!hmac) return false;
  const got = Buffer.from(String(hmac), "base64");
  return [process.env.SHOPIFY_CLIENT_SECRET, process.env.SHOPIFY_WEBHOOK_SECRET].filter(Boolean).some((secret) => {
    const want = crypto.createHmac("sha256", secret).update(raw, "utf8").digest();
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  });
}

const ORDER_FIELDS = `id name tags cancelledAt
  customAttributes { key value }
  totalReceivedSet { presentmentMoney { amount currencyCode } }
  totalRefundedSet { presentmentMoney { amount currencyCode } }
  transactions(first: 50) { id kind status gateway amountSet { presentmentMoney { amount currencyCode } } }
  refunds(first: 100) { id createdAt note totalRefundedSet { presentmentMoney { amount currencyCode } } }`;
const ORDER = `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;
const FIND = `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`;
const REFUND_CREATE = `mutation($input: RefundInput!) { refundCreate(input: $input) { refund { id } userErrors { field message } } }`;
const TAGS_ADD = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`;
// Shopify renamed the cancel option "refund" to "refundMethod"; both forms are tried
const CANCEL = `mutation($id: ID!, $note: String) { orderCancel(orderId: $id, reason: CUSTOMER, restock: true, notifyCustomer: false, staffNote: $note,
  refundMethod: { originalPaymentMethodsRefund: false }) { job { id } orderCancelUserErrors { field message code } } }`;
const CANCEL_OLD = `mutation($id: ID!, $note: String) { orderCancel(orderId: $id, reason: CUSTOMER, restock: true, notifyCustomer: false, staffNote: $note,
  refund: false) { job { id } orderCancelUserErrors { field message code } } }`;
const MARK = "[whop]"; // notes on refunds recorded by this code, so they are never refunded a second time
const cents = (x) => Math.round(Number(x) * 100);
const jid = (order) => order.customAttributes.find((a) => a.key === "checkout_journey_id")?.value;
const attr = (order, key) => order.customAttributes?.find((a) => a.key === key)?.value || "";
const DEAD_FULFILLMENT = new Set(["cancelled", "canceled", "failure", "error"]);

// Carrier numbers from a Shopify fulfillment notification. Blank entries are dropped.
export function trackingNumbers(body) {
  const list = [];
  const add = (v) => {
    const s = String(v ?? "").trim().slice(0, 128);
    if (s && !list.includes(s)) list.push(s);
  };
  if (Array.isArray(body?.tracking_numbers)) for (const n of body.tracking_numbers) add(n);
  add(body?.tracking_number);
  if (Array.isArray(body?.tracking_info)) for (const t of body.tracking_info) add(t?.number);
  return list;
}

function whopPaymentId(order) {
  const fromAttr = String(attr(order, "whop_payment_id") || attr(order, "Payment id") || "").trim();
  if (/^pay_[A-Za-z0-9]+$/.test(fromAttr)) return fromAttr;
  for (const t of order?.tags || []) {
    const m = String(t).match(/^whop-(pay_[A-Za-z0-9]+)$/);
    if (m) return m[1];
  }
  return "";
}

// What to send for this fulfillment. method_unknown means the order was created before Payment method was stored;
// the caller reads the Whop payment and continues only when that payment is PayPal.
export function paypalTrackingJob(order, body) {
  const status = String(body?.status || "").toLowerCase();
  if (DEAD_FULFILLMENT.has(status)) return { skip: "fulfillment_not_active" };
  const numbers = trackingNumbers(body);
  if (!numbers.length) return { skip: "no_tracking" };
  const method = String(attr(order, "Payment method")).trim();
  const paymentId = whopPaymentId(order);
  if (method && !/^paypal$/i.test(method)) return { skip: "not_paypal" };
  if (!method) return { skip: "method_unknown", paymentId, numbers };
  if (!paymentId) return { skip: "no_payment_id" };
  return { paymentId, numbers };
}

function trackKey(fulfillmentId, tracking) {
  const h = crypto.createHash("sha256").update(`${fulfillmentId}\n${tracking}`).digest("hex").slice(0, 32);
  return `shopify-track-${h}`;
}

function isPaypalPayment(p) {
  const type = String(p?.payment_method_type || p?.payment_instrument?.payment_method_type || "").trim().toLowerCase();
  const shown = String(p?.payment_instrument?.display_name || "");
  return type === "paypal" || /\bpaypal\b/i.test(shown);
}

// Send each carrier number to Whop. 409 means Whop already has it (a retry, or a second number on one payment).
export async function sendPaypalTracking(order, body, lookup = getPayment) {
  let job = paypalTrackingJob(order, body);
  if (job.skip === "method_unknown") {
    if (!job.paymentId) return { skip: "no_payment_id" };
    let p;
    try { p = await lookup(job.paymentId); }
    catch (e) {
      if (/Whop 404/.test(String(e.message || ""))) return { skip: "payment_not_found" };
      throw e;
    }
    if (!isPaypalPayment(p)) return { skip: "not_paypal" };
    job = { paymentId: job.paymentId, numbers: job.numbers };
  }
  if (job.skip) return { skip: job.skip };
  const sent = [], failed = [];
  for (const tracking of job.numbers) {
    const r = await createShipment(job.paymentId, tracking, trackKey(body?.id, tracking));
    if (r.ok || r.status === 409) { sent.push(tracking); continue; }
    const hint = scopeProblem(r.data);
    if (hint) console.error(`SETUP PROBLEM — ${hint}`);
    failed.push({ tracking, status: r.status || 0 });
    if (!r.status || r.status >= 500) return { paymentId: job.paymentId, sent, failed, retry: true };
  }
  return { paymentId: job.paymentId, sent, ...(failed.length && { failed }) };
}

// One Shopify fulfillment, in the same shape the fulfillment webhook sends.
export function fulfillmentNotices(order) {
  const list = Array.isArray(order?.fulfillments) ? order.fulfillments : (order?.fulfillments?.nodes || []);
  return list.map((f) => {
    const info = Array.isArray(f?.trackingInfo) ? f.trackingInfo : (f?.trackingInfo?.nodes || []);
    return { id: f?.id, status: String(f?.status || "").toLowerCase(), tracking_numbers: info.map((t) => t?.number) };
  });
}

const TRACKED_ORDERS = `query($n: Int!, $cursor: String) {
  orders(first: $n, after: $cursor, query: "tag:whop AND (fulfillment_status:shipped OR fulfillment_status:partial)") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name tags
      customAttributes { key value }
      fulfillments { id status trackingInfo(first: 10) { number } }
    }
  }
}`;

// Send tracking numbers already stored on shipped PayPal orders. One page per call; pass next_cursor for the rest.
// Card orders are skipped. A Whop outage keeps the same cursor so the page can be run again.
export async function syncPaypalTracking(gql, { cursor = null, pageSize = 15 } = {}) {
  const n = Math.min(Math.max(Number(pageSize) || 15, 1), 40);
  const data = await gql(TRACKED_ORDERS, { n, cursor: cursor || null });
  const conn = data.orders;
  const result = { checked: 0, sent: [], skipped: {}, failed: [], next_cursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null };
  const skip = (k) => { result.skipped[k] = (result.skipped[k] || 0) + 1; };
  let retry = false;
  for (const order of conn.nodes) {
    result.checked++;
    if ((order.tags || []).includes("whop-paypal-tracking")) { skip("already_sent"); continue; }
    const sent = [];
    let skipReason = "";
    for (const body of fulfillmentNotices(order)) {
      const r = await sendPaypalTracking(order, body);
      if (r.skip === "not_paypal" || r.skip === "no_payment_id" || r.skip === "payment_not_found") { skipReason = r.skip; break; }
      if (r.skip) continue;
      if (r.sent?.length) sent.push(...r.sent);
      if (r.retry || r.failed?.length) {
        if (r.retry) retry = true;
        result.failed.push({ order: order.name, payment: r.paymentId, failed: r.failed });
      }
    }
    const unique = [...new Set(sent)];
    const orderFailed = result.failed.some((f) => f.order === order.name);
    if (!unique.length && !orderFailed) { if (skipReason) skip(skipReason); else skip("no_tracking"); continue; }
    if (unique.length && !orderFailed) {
      try { await gql(TAGS_ADD, { id: order.id, tags: ["whop-paypal-tracking"] }); } catch { /* the number is already at Whop; the tag is only a skip marker */ }
      result.sent.push({ order: order.name, tracking: unique });
    }
  }
  if (retry) {
    result.retry = true;
    result.next_cursor = cursor || null;
  }
  return result;
}

// The order's Whop payments, original first, each with how much was paid (in the shopper's currency)
async function orderPayments(order) {
  const ids = [];
  const parent = order.customAttributes.find((a) => a.key === "whop_payment_id")?.value;
  if (parent) ids.push(parent);
  for (const t of order.tags) { const m = t.match(/^whop-(pay_[A-Za-z0-9]+)$/); if (m && !ids.includes(m[1])) ids.push(m[1]); }
  const out = [];
  for (const id of ids) {
    const p = await getPayment(id);
    const money = p.presentment_total || p.total;
    out.push({ id, total: cents(money?.amount || 0), currency: String(money?.currency || p.currency || "").toLowerCase() });
  }
  return out;
}

// Refund the part [from, from + amount) of the order's money in Whop, spread over its payments in order
async function refundRange(order, pays, from, amount, currency, keyPrefix, j) {
  const done = [];
  let start = 0;
  for (const p of pays) {
    const end = start + p.total;
    const part = Math.max(0, Math.min(end, from + amount) - Math.max(start, from));
    start = end;
    if (!part) continue;
    if (p.currency && p.currency !== currency) throw Object.assign(new Error(`currency mismatch: Shopify ${currency} vs Whop ${p.currency} on ${p.id}`), { permanent: true });
    const r = await refundPayment(p.id, part / 100, `${keyPrefix}-${p.id}-${part}`, { source: "shopify", shopify_order: order.name });
    if (!r.ok) {
      const setup = scopeProblem(r.data);
      journey(j, "refund_failed", { order: order.name, payment: p.id, amount: part, status: r.status, message: setup || JSON.stringify(r.data).slice(0, 200) }, true);
      throw Object.assign(new Error(`Whop refund ${r.status}`), { permanent: r.status === 400 || r.status === 422 });
    }
    done.push({ payment: p.id, amount: part / 100 });
  }
  if (from + amount > start) journey(j, "refund_more_than_paid", { order: order.name, asked: (from + amount) / 100, paid_in_whop: start / 100 }, true);
  return done;
}

// Record a refund on the Shopify order without moving money (the money already moved in Whop)
async function recordRefund(order, amountCents, note) {
  const sale = order.transactions.find((t) => t.kind === "SALE" && t.status === "SUCCESS");
  const cur = order.totalReceivedSet.presentmentMoney.currencyCode;
  const r = await adminGql(REFUND_CREATE, { input: { orderId: order.id, notify: false, currency: cur, note: `${MARK} ${note}`,
    transactions: [{ orderId: order.id, ...(sale && { parentId: sale.id }), gateway: "Whop", kind: "REFUND", amount: (amountCents / 100).toFixed(2) }] } });
  const e = r.refundCreate.userErrors;
  if (e.length) throw new Error(`refundCreate: ${JSON.stringify(e).slice(0, 300)}`);
}

async function cancelOrder(order, note) {
  let r;
  try { r = await adminGql(CANCEL, { id: order.id, note }); }
  catch { r = await adminGql(CANCEL_OLD, { id: order.id, note }); }
  const e = r.orderCancel.orderCancelUserErrors || [];
  if (e.length) throw new Error(`orderCancel: ${JSON.stringify(e).slice(0, 300)}`);
}

// ---------------- Whop -> Shopify ----------------
// refund = Whop refund object from the refund.created / refund.updated webhook
export async function whopRefundToShopify(refund) {
  if (!refund?.id || !refund.payment_id) return { status: 200, body: { skipped: "no_refund" } };
  if (refund.status !== "succeeded") return { status: 200, body: { skipped: `refund_${refund.status}` } }; // acted on once it succeeds
  if (refund.metadata?.source === "shopify") return { status: 200, body: { skipped: "started_in_shopify" } }; // already in Shopify

  const order = (await adminGql(FIND, { q: `tag:'whop-${refund.payment_id}'` })).orders.nodes[0];
  if (!order) return { status: 200, body: { skipped: "no_shopify_order" } };
  const j = jid(order);
  if (order.refunds.some((r) => (r.note || "").includes(refund.id))) return { status: 200, body: { skipped: "already_recorded", order: order.name } };

  const received = cents(order.totalReceivedSet.presentmentMoney.amount);
  const refunded = cents(order.totalRefundedSet.presentmentMoney.amount);
  const cur = order.totalReceivedSet.presentmentMoney.currencyCode.toLowerCase();
  // Amount in the shopper's currency: from the refund itself, or (full refund in another currency) from the payment
  let amount = null;
  const orig = refund.original_amount;
  if (orig && String(orig.currency).toLowerCase() === cur) amount = cents(orig.amount);
  else {
    const p = await getPayment(refund.payment_id);
    const pt = p.presentment_total || p.total;
    if (p.refundable === false && pt && String(pt.currency).toLowerCase() === cur) amount = cents(pt.amount);
  }
  if (!amount) {
    journey(j, "whop_refund_not_mapped", { order: order.name, refund: refund.id, original: orig || null }, true);
    return { status: 200, body: { error: "currency_not_mapped" } };
  }
  amount = Math.min(amount, Math.max(0, received - refunded)); // never record more than is left on the order
  if (amount > 0) await recordRefund(order, amount, `Refunded in Whop (${refund.id})`);
  await adminGql(TAGS_ADD, { id: order.id, tags: ["whop-refunded", "whop-refunded-in-whop"] }).catch(() => {});

  const fully = refunded + amount >= received;
  if (fully && !order.cancelledAt) await cancelOrder(order, `Cancelled automatically: refunded in Whop (${refund.id})`);
  journey(j, fully ? "whop_refund_order_cancelled" : "whop_refund_recorded", { order: order.name, refund: refund.id, amount: amount / 100, currency: cur });
  return { status: 200, body: { order: order.name, recorded: amount / 100, cancelled: fully && !order.cancelledAt } };
}

// ---------------- Shopify -> Whop ----------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const raw = await rawBody(req);
  if (!verified(raw, req.headers["x-shopify-hmac-sha256"])) { console.error("shopify_webhook bad signature"); return res.status(401).json({ error: "bad_signature" }); }
  const topic = String(req.headers["x-shopify-topic"] || "");
  let body; try { body = JSON.parse(raw); } catch { return res.status(200).json({ skipped: "bad_json" }); }

  try {
    const orderGid = `gid://shopify/Order/${topic === "refunds/create" || topic.startsWith("fulfillments/") ? body.order_id : body.id}`;
    const { order } = await adminGql(ORDER, { id: orderGid });
    if (!order) return res.status(200).json({ skipped: "order_not_found" });
    if (!order.tags.some((t) => /^whop-pay_/.test(t))) return res.status(200).json({ skipped: "not_a_whop_order" });
    const j = jid(order);

    if (topic === "fulfillments/create" || topic === "fulfillments/update") {
      const result = await sendPaypalTracking(order, body);
      if (result.retry) {
        journey(j, "paypal_tracking_failed", { order: order.name, failed: result.failed }, true);
        return res.status(500).json({ error: "whop_shipment_retry" });
      }
      if (result.sent?.length) {
        await adminGql(TAGS_ADD, { id: order.id, tags: ["whop-paypal-tracking"] }).catch(() => {});
        journey(j, "paypal_tracking_sent", { order: order.name, payment: result.paymentId, tracking: result.sent });
      } else if (result.failed?.length) {
        journey(j, "paypal_tracking_failed", { order: order.name, failed: result.failed }, true);
      }
      return res.status(200).json(result);
    }

    const received = order.totalReceivedSet.presentmentMoney, refunded = order.totalRefundedSet.presentmentMoney;
    const currency = received.currencyCode.toLowerCase();

    if (topic === "refunds/create") {
      if (String(body.note || "").startsWith(MARK)) return res.status(200).json({ skipped: "recorded_by_us" });
      const gid = `gid://shopify/Refund/${body.id}`;
      const all = [...order.refunds].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
      const refund = all.find((r) => r.id === gid);
      if (!refund) return res.status(500).json({ error: "refund_not_visible_yet" }); // Shopify retries shortly
      if (refund.note?.startsWith(MARK)) return res.status(200).json({ skipped: "recorded_by_us" });
      const amount = cents(refund.totalRefundedSet?.presentmentMoney?.amount || 0);
      if (!amount) return res.status(200).json({ skipped: "no_money_refunded" }); // e.g. restock only
      // Where this refund starts: everything refunded on the order before it
      const from = all.slice(0, all.indexOf(refund)).reduce((t, r) => t + cents(r.totalRefundedSet?.presentmentMoney?.amount || 0), 0);
      const pays = await orderPayments(order);
      const done = await refundRange(order, pays, from, amount, currency, `shopify-refund-${body.id}`, j);
      await adminGql(TAGS_ADD, { id: order.id, tags: ["whop-refunded"] }).catch(() => {});
      journey(j, "refund_sent_to_whop", { order: order.name, amount: amount / 100, currency, done });
      return res.status(200).json({ refunded: done });
    }

    if (topic === "orders/cancelled") {
      if (String(process.env.REFUND_ON_CANCEL).toLowerCase() === "false") return res.status(200).json({ skipped: "refund_on_cancel_off" });
      if (order.tags.includes("whop-refunded-in-whop") && cents(refunded.amount) >= cents(received.amount)) return res.status(200).json({ skipped: "cancelled_because_refunded_in_whop" });
      const left = cents(received.amount) - cents(refunded.amount);
      if (left <= 0) return res.status(200).json({ skipped: "already_refunded" }); // cancelled with "Refund payment" ticked
      const pays = await orderPayments(order);
      const done = await refundRange(order, pays, cents(refunded.amount), left, currency, `shopify-cancel-${order.id.split("/").pop()}`, j);
      try { await recordRefund(order, left, "Refunded in Whop automatically because the order was cancelled"); }
      catch (e) { console.error("refund_record", e.message); }
      await adminGql(TAGS_ADD, { id: order.id, tags: ["whop-refunded", "whop-refunded-on-cancel"] }).catch(() => {});
      journey(j, "cancel_refunded_in_whop", { order: order.name, amount: left / 100, currency, done });
      return res.status(200).json({ refunded: done });
    }
    return res.status(200).json({ skipped: topic });
  } catch (e) {
    console.error("shopify_webhook", e.message);
    // A problem that won't fix itself (e.g. currency mismatch) is logged once; anything else -> Shopify retries
    return res.status(e.permanent ? 200 : 500).json({ error: String(e.message).slice(0, 200) });
  }
}
