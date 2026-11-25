// Post-purchase offer: charge outcome (no false declines), no double charge, and the Shopify line price.
// Whop is a fake (global fetch); Shopify pricing and Admin GraphQL are module mocks. Nothing real is called.
// Run: node --test --experimental-test-module-mocks
import assert from "node:assert/strict";
import { describe, test, mock, beforeEach } from "node:test";

process.env.WHOP_API_KEY = "test_key";
process.env.WHOP_COMPANY_ID = "biz_test";
process.env.SESSION_SECRET = "test_secret";
process.env.UPSELL_POLL_MS = "2000";
process.env.CHECKOUT_URL = "https://checkout.test";
const XL = 68105383870646, NINE = 67665328799926;
process.env.UPSELL_OFFERS = JSON.stringify([
  { variant_id: XL, if_any_variant: [XL], price: { USD: 11999, GBP: 9299 } },
  { variant_id: NINE, quantity: 2, when: "declined", if_any_variant: [XL], unless_any_variant: [NINE], price: { USD: 7499, GBP: 5799 }, msrp: { USD: 9998, GBP: 7798 } },
  { variant_id: NINE, when: "declined", if_any_variant: [XL], unless_any_variant: [NINE], price: { USD: 2999, GBP: 2299 }, msrp: { USD: 4999, GBP: 3899 } },
]);

// Shopify prices (GBP market): XL Pro £139.99, 9-note £22.99
const SHOP = { [XL]: { GBP: 13999, USD: 17999, title: "XL Pro" }, [NINE]: { GBP: 2299, USD: 2999, title: "9-note" } };
mock.module("../lib/pricing.js", { exports: {
  priceCart: async (b) => {
    const it = b.items[0], cur = b.market_country === "GB" ? "GBP" : "USD", u = SHOP[it.variant_id][cur], su = SHOP[it.variant_id].USD;
    return { currency: cur, shopCurrency: "USD", total: u * it.quantity, shopTotal: su * it.quantity, lines: [[it.variant_id, it.quantity, u, su]],
      display: [{ title: SHOP[it.variant_id].title, options: [], image: "", qty: it.quantity }] };
  },
} });
const gql = [];
let gqlHandler = () => ({});
mock.module("../lib/shopify.js", { exports: {
  API: "test", adminToken: async () => "t",
  adminGql: async (q, v) => { gql.push({ q, v }); return gqlHandler(q, v); },
  storefrontGql: async () => ({}),
} });

const { createSession } = await import("../lib/session.js");
const { classifyPayment } = await import("../lib/whop.js");
const { default: upsell } = await import("../api/upsell.js");
const { priceOfferLine, fulfil } = await import("../api/whop-webhook.js");

// ---------- fake Whop ----------
let W;
function resetWhop(order) {
  W = { payments: {}, creates: 0, keys: {}, inflight: {}, statusOf: () => ({ status: "processing" }), createReply: null, createDelay: 0, order,
    listCalls: 0, failCreate: null };
  W.payments.pay_parent = { id: "pay_parent", status: "paid", paid_at: new Date().toISOString(), member_id: "mber_1", payment_method_id: "payt_1",
    metadata: { order: JSON.stringify(order), ship: JSON.stringify({ email: "a@b.c" }) } };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), path = u.pathname.replace("/api/v1", ""), method = init.method || "GET";
  if (method === "POST" && path === "/payments") {
    if (W.failCreate === "network") throw new Error("socket hang up");
    if (W.failCreate === 502) return json({ error: { message: "bad gateway" } }, 502);
    const key = init.headers["Idempotency-Key"];
    if (W.keys[key]) return json(W.keys[key].body, W.keys[key].status); // replay
    if (W.inflight[key]) return json({ error: { code: "idempotency_request_in_progress" } }, 409);
    W.inflight[key] = true;
    await new Promise((ok) => setTimeout(ok, W.createDelay));
    W.creates++;
    const id = `pay_up${W.creates}`, body = JSON.parse(init.body);
    const reply = { id, status: "open", client_secret: null, ...(W.createReply || {}) };
    W.payments[id] = { id, status: reply.status, created: Date.now(), metadata: body.metadata, client_secret: reply.client_secret, member_id: "mber_1" };
    W.keys[key] = { body: reply, status: 201 }; delete W.inflight[key];
    return json(reply, 201);
  }
  if (method === "GET" && path === "/payments") {
    W.listCalls++;
    const list = Object.values(W.payments).filter((p) => p.id !== "pay_parent").map((p) => ({ ...p, ...(W.statusOf(p).status === "succeeded" && { status: "paid" }) }));
    return json({ data: list.reverse(), page_info: {} });
  }
  let m = path.match(/^\/payments\/(pay_\w+)\/status$/);
  if (m) { const p = W.payments[m[1]]; if (!p) return json({}, 404); return json({ id: p.id, object: "payment_status", ...W.statusOf(p) }); }
  m = path.match(/^\/payments\/(pay_\w+)$/);
  if (m) { const p = W.payments[m[1]]; if (!p) return json({}, 404);
    const st = p.id === "pay_parent" ? null : W.statusOf(p);
    return json({ ...p, ...(st?.status === "succeeded" && { status: "paid" }), ...(st?.status === "canceled" && { status: "void" }) }); }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

// ---------- helpers ----------
const ORDER_XL = { l: [[XL, 1, 13999, 17999]], c: "GBP", t: 13999 };
const ORDER_NO_XL = { l: [[NINE, 1, 2299, 2999]], c: "GBP", t: 2299 };
const tok = (order) => createSession({ order, mk: "GB", j: "jtest" });
function call(method, body) {
  return new Promise((ok) => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { ok({ code: this.code, body: o }); return this; }, end() { ok({ code: this.code }); } };
    upsell(method === "POST" ? { method, body, headers: {} } : { method, query: body, headers: {} }, res);
  });
}
const accept = (order, step = 0, extra = {}) => call("POST", { s: tok(order), payment: "pay_parent", step, declined: step ? Array.from({ length: step }, (_, i) => i).join(",") : "", ...extra });
const after = (ms, then, before = { status: "confirming" }) => (p) => (Date.now() - p.created >= ms ? then : before);

describe("charge outcome (api/upsell.js POST)", () => {
  beforeEach(() => { resetWhop(ORDER_XL); });

  test("open -> paid after 900ms is reported as paid, not declined (the pay_EZfvEcvr4awa8Q case)", async () => {
    W.statusOf = after(900, { status: "succeeded" });
    const r = await accept(ORDER_XL, 2);
    assert.equal(r.body.status, "paid"); assert.equal(r.body.id, "pay_up1"); assert.equal(W.creates, 1);
  });
  test("immediately paid", async () => {
    W.createReply = { status: "paid" }; W.statusOf = () => ({ status: "succeeded" });
    const r = await accept(ORDER_XL);
    assert.equal(r.body.status, "paid"); assert.equal(W.creates, 1);
  });
  test("definite decline -> failed with Whop's message", async () => {
    W.statusOf = after(300, { status: "requires_confirmation", last_payment_error: { code: "card_declined", message: "Your card was declined." } }, { status: "confirming" });
    const r = await accept(ORDER_XL);
    assert.equal(r.body.status, "failed"); assert.equal(r.body.message, "Your card was declined."); assert.equal(r.body.needsCard, true);
  });
  test("requires_action returns the client_secret for 3-D Secure", async () => {
    W.createReply = { client_secret: "pay_up1_secret" }; W.statusOf = () => ({ status: "requires_action", next_action: { type: "redirect", data: { url: "https://bank.test" } } });
    const r = await accept(ORDER_XL);
    assert.equal(r.body.status, "requires_action"); assert.equal(r.body.client_secret, "pay_up1_secret");
  });
  test("no answer within the window -> pending (never a decline), then the status call reports paid", async () => {
    let done = false; W.statusOf = () => (done ? { status: "succeeded" } : { status: "processing" });
    const t0 = Date.now(); const r = await accept(ORDER_XL);
    assert.equal(r.body.status, "pending"); assert.equal(r.body.id, "pay_up1"); assert.ok(Date.now() - t0 < 4000);
    const s1 = await call("GET", { status: 1, s: tok(ORDER_XL), payment: "pay_parent", step: 0, id: "pay_up1" });
    assert.equal(s1.body.status, "pending");
    done = true;
    const s2 = await call("GET", { status: 1, s: tok(ORDER_XL), payment: "pay_parent", step: 0, id: "pay_up1" });
    assert.equal(s2.body.status, "paid");
    const s3 = await call("GET", { status: 1, s: tok(ORDER_XL), payment: "pay_parent", step: 0 }); // found by order + step without an id
    assert.equal(s3.body.status, "paid"); assert.equal(s3.body.id, "pay_up1");
  });
  test("double tap at the same time charges once", async () => {
    W.createDelay = 400; W.statusOf = after(600, { status: "succeeded" });
    const [a, b] = await Promise.all([accept(ORDER_XL), accept(ORDER_XL)]);
    assert.equal(W.creates, 1);
    assert.equal(a.body.status, "paid"); assert.ok(["paid", "pending"].includes(b.body.status));
    assert.ok(!b.body.id || b.body.id === "pay_up1");
  });
  test("retry after a paid charge returns the same payment and charges nothing", async () => {
    W.statusOf = () => ({ status: "succeeded" });
    const a = await accept(ORDER_XL); const b = await accept(ORDER_XL);
    assert.equal(W.creates, 1); assert.equal(b.body.status, "paid"); assert.equal(b.body.id, a.body.id);
  });
  test("a retry with a new card after a confirmed decline is allowed", async () => {
    W.statusOf = () => ({ status: "canceled", last_payment_error: { message: "Declined" } });
    const a = await accept(ORDER_XL); assert.equal(a.body.status, "failed");
    W.statusOf = (p) => (p.id === "pay_up1" ? { status: "canceled" } : { status: "succeeded" });
    const b = await accept(ORDER_XL, 0, { confirmationToken: "ctok_new" });
    assert.equal(W.creates, 2); assert.equal(b.body.status, "paid");
  });
  test("Whop 5xx or network error on create -> pending, not declined", async () => {
    W.failCreate = 502; assert.equal((await accept(ORDER_XL)).body.status, "pending");
    W.failCreate = "network"; assert.equal((await accept(ORDER_XL)).body.status, "pending");
  });
  test("status call refuses a payment from another order", async () => {
    W.payments.pay_other = { id: "pay_other", status: "paid", metadata: { upsell_of: "pay_someone_else", upsell: JSON.stringify({ step: 0 }) } };
    const r = await call("GET", { status: 1, s: tok(ORDER_XL), payment: "pay_parent", step: 0, id: "pay_other" });
    assert.equal(r.body.error, "not_found");
  });
  test("offers still only show on XL Pro orders; the charge records the exact offer price", async () => {
    const g = await call("GET", { s: tok(ORDER_XL), payment: "pay_parent", step: 0 });
    assert.equal(g.body.price, 9299); assert.equal(g.body.currency, "GBP");
    resetWhop(ORDER_NO_XL);
    const n = await call("GET", { s: tok(ORDER_NO_XL), payment: "pay_parent", step: 0 });
    assert.equal(n.body.done, true);
    resetWhop(ORDER_XL); W.statusOf = () => ({ status: "succeeded" });
    await accept(ORDER_XL, 2);
    const meta = JSON.parse(W.payments.pay_up1.metadata.upsell);
    assert.equal(meta.t, 2299); assert.equal(meta.c, "GBP"); assert.equal(meta.q, 1);
  });
});

describe("classifyPayment", () => {
  test("only definite failures are failures", () => {
    assert.equal(classifyPayment({ status: "succeeded" }).state, "paid");
    for (const s of ["requires_confirmation", "confirming", "processing", "requires_capture"]) assert.equal(classifyPayment({ status: s }).state, "pending");
    assert.equal(classifyPayment({ status: "requires_confirmation", last_payment_error: { message: "x" } }).state, "failed");
    assert.equal(classifyPayment({ status: "canceled" }).state, "failed");
    assert.equal(classifyPayment(null, { status: "open" }).state, "pending");
    assert.equal(classifyPayment(null, { status: "paid" }).state, "paid");
    assert.equal(classifyPayment(null, { status: "open", substatus: "failed" }).state, "failed");
  });
});

// ---------- Shopify line price (api/whop-webhook.js) ----------
function shopifyFake(unitPresent, cur, { shopUnit, shopCur = "USD", discountMode = "total" } = {}) {
  gql.length = 0;
  gqlHandler = (q, v) => {
    if (q.includes("orderEditAddVariant")) return { orderEditAddVariant: { calculatedLineItem: { id: "cli_1", originalUnitPriceSet: {
      presentmentMoney: { amount: (unitPresent / 100).toFixed(2), currencyCode: cur }, shopMoney: { amount: ((shopUnit ?? unitPresent) / 100).toFixed(2), currencyCode: shopCur } } }, userErrors: [] } };
    if (q.includes("orderEditAddLineItemDiscount")) {
      const d = v.discount, qty = v._qty || 1;
      let off;
      if (d.fixedValue) off = Math.round(Number(d.fixedValue.amount) * 100) * (discountMode === "per_unit" ? qty : 1);
      else off = Math.round(unitPresent * qty * d.percentValue / 100);
      return { orderEditAddLineItemDiscount: { calculatedLineItem: { id: "cli_1", calculatedDiscountAllocations: [{ allocatedAmountSet: { presentmentMoney: { amount: (off / 100).toFixed(2), currencyCode: cur }, shopMoney: { amount: (off / 100).toFixed(2), currencyCode: shopCur } } }] }, userErrors: [] } };
    }
    if (q.includes("orderEditAddCustomItem")) return { orderEditAddCustomItem: { calculatedLineItem: { id: "cli_2" }, userErrors: [] } };
    return {};
  };
}
const muts = (name) => gql.filter((g) => g.q.includes(name));
const line = { id: "cli_1" };
async function price(unit, cur, u, opts) {
  shopifyFake(unit, cur, opts);
  const li = (await gqlHandler("orderEditAddVariant", {})).orderEditAddVariant.calculatedLineItem; gql.length = 0;
  const origDisc = gqlHandler; gqlHandler = (q, v) => origDisc(q, { ...v, _qty: u.q });
  return priceOfferLine("calc_1", li, u);
}

describe("Shopify line records exactly what was charged (before tax)", () => {
  test("£22.99 final offer on a £22.99 variant: no discount (was 41% off -> £13.57 on #7216)", async () => {
    const r = await price(2299, "GBP", { v: NINE, q: 1, t: 2299, c: "GBP", st: 3014, sc: "USD", pct: 41 });
    assert.equal(r.got, 2299); assert.equal(muts("orderEditAddLineItemDiscount").length, 0); assert.equal(muts("orderEditAddCustomItem").length, 0);
  });
  test("£92.99 second XL Pro on a £139.99 variant: fixed £47.00 off", async () => {
    const r = await price(13999, "GBP", { v: XL, q: 1, t: 9299, c: "GBP", pct: 34 });
    assert.equal(r.got, 9299); assert.deepEqual(muts("orderEditAddLineItemDiscount")[0].v.discount.fixedValue, { amount: "47.00", currencyCode: "GBP" });
  });
  test("$119.99 second XL Pro on a $179.99 variant", async () => {
    const r = await price(17999, "USD", { v: XL, q: 1, t: 11999, c: "USD", pct: 33 });
    assert.equal(r.got, 11999);
  });
  test("£57.99 pair above Shopify's 2 × £22.99: variant line + £12.01 non-shipping adjustment", async () => {
    const r = await price(2299, "GBP", { v: NINE, q: 2, t: 5799, c: "GBP", pct: 26 });
    assert.equal(r.got, 5799); const c = muts("orderEditAddCustomItem")[0].v;
    assert.deepEqual(c.price, { amount: "12.01", currencyCode: "GBP" }); assert.equal(c.quantity, 1);
    assert.match(gql.find((g) => g.q.includes("orderEditAddCustomItem")).q, /requiresShipping: false, taxable: false/);
  });
  test("$74.99 pair: $15.01 adjustment", async () => {
    const r = await price(2999, "USD", { v: NINE, q: 2, t: 7499, c: "USD", pct: 25 });
    assert.equal(r.got, 7499); assert.deepEqual(muts("orderEditAddCustomItem")[0].v.price, { amount: "15.01", currencyCode: "USD" });
  });
  test("several units below the variant price: precise percentage hits the target", async () => {
    const r = await price(13999, "GBP", { v: XL, q: 2, t: 18598, c: "GBP" });
    assert.equal(r.got, 18598); assert.ok(muts("orderEditAddLineItemDiscount")[0].v.discount.percentValue);
  });
});

describe("webhook adds the offer once", () => {
  test("a repeated payment.succeeded does not add the item again", async () => {
    gql.length = 0;
    gqlHandler = (q, v) => (q.includes("orders(first: 1") ? { orders: { nodes: v.q.includes("pay_up9") ? [{ id: "gid://shopify/Order/1", name: "#7300" }] : [] } } : {});
    const r = await fulfil({ id: "pay_up9", metadata: { upsell_of: "pay_parent", upsell: JSON.stringify({ v: NINE, q: 1, t: 2299, c: "GBP" }) } });
    assert.equal(r.body.duplicate, "#7300"); assert.equal(muts("orderEditBegin").length, 0);
  });
  test("first delivery: one variant line, priced to the charge, committed once", async () => {
    gql.length = 0; let tagged = false;
    gqlHandler = (q, v) => {
      if (q.includes("orders(first: 1")) return { orders: { nodes: v.q.includes("pay_parent") ? [{ id: "gid://shopify/Order/1", name: "#7216" }] : (tagged ? [{ name: "#7216" }] : []) } };
      if (q.includes("orderEditBegin")) return { orderEditBegin: { calculatedOrder: { id: "calc_1" }, userErrors: [] } };
      if (q.includes("orderEditAddVariant")) return { orderEditAddVariant: { calculatedLineItem: { id: "cli_1", originalUnitPriceSet: { presentmentMoney: { amount: "22.99", currencyCode: "GBP" }, shopMoney: { amount: "30.14", currencyCode: "USD" } } }, userErrors: [] } };
      if (q.includes("orderEditCommit")) return { orderEditCommit: { order: { id: "gid://shopify/Order/1", name: "#7216" }, userErrors: [] } };
      if (q.includes("tagsAdd")) { tagged = true; return { tagsAdd: { userErrors: [] } }; }
      if (q.includes("orderCreateManualPayment")) return { orderCreateManualPayment: { userErrors: [] } };
      return {};
    };
    const d = { id: "pay_up10", metadata: { upsell_of: "pay_parent", upsell: JSON.stringify({ v: NINE, q: 1, u: 2299, t: 2299, c: "GBP", st: 3014, sc: "USD", pct: 41, step: 2 }) } };
    const r = await fulfil(d);
    assert.equal(r.body.upsell, "added_to_order");
    assert.equal(muts("orderEditAddVariant").length, 1); assert.equal(muts("orderEditAddLineItemDiscount").length, 0); assert.equal(muts("orderEditCommit").length, 1);
    assert.match(muts("orderEditCommit")[0].v.staffNote, /22\.99 GBP before tax/);
    const again = await fulfil(d);
    assert.ok(again.body.duplicate); assert.equal(muts("orderEditAddVariant").length, 1);
  });
});
