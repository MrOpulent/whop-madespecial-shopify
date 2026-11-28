// Post-purchase offers for buyers outside USD/GBP (AUD, CAD, EUR, INR, JPY...): the offer must be the same discount off the
// buyer's converted regular price, rounded to .99 (whole units for JPY), never the full price with 0% off.
// Regression for order #7517 (AUD): the 6-inch add-on was charged A$152.64 (full converted $99.99) with pct 0.
// Shopify pricing and Whop are fakes. Run: node --test --experimental-test-module-mocks
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test, mock } from "node:test";

process.env.WHOP_API_KEY = "test_key"; process.env.WHOP_COMPANY_ID = "biz_test"; process.env.SESSION_SECRET = "test_secret";
process.env.CHECKOUT_URL = "https://checkout.test";

const XL = [68105383870646, 68112843899062, 68114477449398, 68114477482166, 68114477514934], NINE = 67665328799926;
const SIX = JSON.parse(fs.readFileSync(new URL("../config/6inch-L-variants.json", import.meta.url), "utf8"));
const SIX_TEAL = SIX["6INCH-PRODRUM-TEAL-Q1"], SIX_BLACK = SIX["6INCH-PRODRUM-BLACK-Q1"];
const XL_FLOW = [
  { variant_id: XL[0], if_any_variant: XL, price: { USD: 11999, GBP: 9299 }, title: "Second 10-Inch XL Pro Steel Drum" },
  { variant_id: NINE, quantity: 2, when: "declined", if_any_variant: XL, unless_any_variant: [NINE], price: { USD: 7499, GBP: 5799 }, msrp: { USD: 9998, GBP: 7798 } },
  { variant_id: NINE, when: "declined", if_any_variant: XL, unless_any_variant: [NINE], price: { USD: 2999, GBP: 2299 }, msrp: { USD: 4999, GBP: 3899 } },
];
const SIX_FLOW = JSON.parse(fs.readFileSync(new URL("../config/upsell-6inch-L.json", import.meta.url), "utf8"));
process.env.UPSELL_OFFERS = JSON.stringify([...XL_FLOW, ...SIX_FLOW]);

// USD cents per variant; buyer currency by market country with a made-up conversion rate (what Shopify Markets returns)
const USD = { [XL[0]]: 17999, [SIX_TEAL]: 9999, [SIX_BLACK]: 9999, [NINE]: 2999 };
const MARKET = { US: ["USD", 1], AU: ["AUD", 1.52655], CA: ["CAD", 1.4013], DE: ["EUR", 0.8651], IN: ["INR", 94.37], JP: ["JPY", 156.2], NZ: ["NZD", 1.7402], GB: ["GBP", 0.7732] };
mock.module("../lib/pricing.js", { namedExports: { priceCart: async (b) => {
  const it = b.items[0], [cur, r] = MARKET[b.market_country], su = USD[it.variant_id] * it.quantity;
  const total = cur === "JPY" ? Math.round(su * r / 100) * 100 : Math.round(su * r);
  return { currency: cur, shopCurrency: "USD", total, shopTotal: su, lines: [[it.variant_id, it.quantity, Math.round(total / it.quantity), USD[it.variant_id]]],
    display: [{ title: "Drum", options: [], image: "", qty: it.quantity }] };
} } });
mock.module("../lib/shopify.js", { namedExports: { API: "test", adminToken: async () => "t", adminGql: async () => ({}), storefrontGql: async () => ({}) } });

const { createSession } = await import("../lib/session.js");
const { default: upsell, roundStorefront } = await import("../api/upsell.js");

let ORDER;
globalThis.fetch = async (url) => {
  if (new URL(String(url)).pathname.endsWith("/payments/pay_parent")) return new Response(JSON.stringify({ id: "pay_parent", status: "paid", paid_at: new Date().toISOString(),
    member_id: "mber_1", payment_method_id: "payt_1", metadata: { order: JSON.stringify(ORDER) } }), { status: 200, headers: { "Content-Type": "application/json" } });
  throw new Error(`unexpected fetch ${url}`);
};
const get = (q) => new Promise((ok) => upsell({ method: "GET", query: q, headers: {} }, { setHeader() {}, status() { return this; }, json: ok, end: () => ok(null) }));
const offer = async (variant, mk, step) => {
  ORDER = { l: [[variant, 1, 1, 1]], c: MARKET[mk][0], t: 1 };
  return get({ s: createSession({ order: ORDER, mk, j: "jt" }), payment: "pay_parent", step, declined: step ? Array.from({ length: step }, (_, i) => i).join(",") : "" });
};
const regular = (variant, mk, qty = 1) => { const [cur, r] = MARKET[mk]; const su = USD[variant] * qty; return cur === "JPY" ? Math.round(su * r / 100) * 100 : Math.round(su * r); };

describe("roundStorefront", () => {
  test("nearest .99, never below 0.99; whole units for JPY", () => {
    assert.equal(roundStorefront(9158, "AUD"), 9199); assert.equal(roundStorefront(9100, "AUD"), 9099); assert.equal(roundStorefront(40, "AUD"), 99);
    assert.equal(roundStorefront(937213, "JPY"), 937200);
  });
});

describe("6-inch L, step 0 (+1 drum, 40% off the regular price) in every currency", () => {
  for (const mk of ["US", "AU", "CA", "DE", "IN", "JP", "NZ"]) {
    test(`${MARKET[mk][0]}: about 40% off the converted $99.99, rounded to .99`, async () => {
      const a = await offer(SIX_BLACK, mk, 0), reg = regular(SIX_TEAL, mk);
      assert.equal(a.currency, MARKET[mk][0]); assert.equal(a.compare, reg);
      assert.ok(a.discount >= 39 && a.discount <= 41, `discount ${a.discount}`);
      assert.ok(a.price < reg * 0.62 && a.price > reg * 0.58, `price ${a.price} vs regular ${reg}`);
      if (mk !== "US") assert.equal(a.price % 100, MARKET[mk][0] === "JPY" ? 0 : 99);
    });
  }
  test("order #7517 (AUD): was A$152.64 at 0%, now A$91.99 at 40%", async () => {
    const a = await offer(SIX_BLACK, "AU", 0);
    assert.equal(a.compare, 15264); assert.equal(a.price, 9199); assert.equal(a.discount, 40);
  });
  test("USD is exactly as before", async () => { const a = await offer(SIX_BLACK, "US", 0); assert.equal(a.price, 5999); assert.equal(a.compare, 9999); assert.equal(a.discount, 40); });
  test("GBP still uses the fixed GBP price", async () => { const a = await offer(SIX_BLACK, "GB", 0); assert.equal(a.price, 4799); });
});

describe("9-note downsells and the XL flow for a non-USD buyer", () => {
  for (const mk of ["AU", "CA", "DE", "IN", "JP"]) {
    test(`${MARKET[mk][0]}: 6-inch step 1 is the 2-pack price ($74.99 converted), step 2 is $29.99 converted with its strikethrough`, async () => {
      const b = await offer(SIX_BLACK, mk, 1), c = await offer(SIX_BLACK, mk, 2), r = MARKET[mk][1];
      assert.equal(b.qty, 2); assert.ok(Math.abs(b.price - 7499 * r) < 0.012 * 7499 * r + 100, `step1 ${b.price}`);
      assert.ok(b.compare > b.price && b.discount >= 24 && b.discount <= 26, `step1 compare ${b.compare} off ${b.discount}`);
      assert.equal(c.qty, 1); assert.ok(Math.abs(c.price - 2999 * r) < 0.012 * 2999 * r + 100, `step2 ${c.price}`);
      assert.ok(c.compare > c.price && c.discount >= 39 && c.discount <= 41, `step2 compare ${c.compare} off ${c.discount}`);
    });
    test(`${MARKET[mk][0]}: XL step 0 is $119.99 converted (about 33% off $179.99), not full price`, async () => {
      const a = await offer(XL[0], mk, 0), reg = regular(XL[0], mk);
      assert.equal(a.compare, reg); assert.ok(a.discount >= 32 && a.discount <= 35, `off ${a.discount}`);
      assert.ok(Math.abs(a.price - 11999 * MARKET[mk][1]) < 0.012 * 11999 * MARKET[mk][1] + 100, `xl ${a.price}`);
    });
  }
  test("USD 9-note steps unchanged (2x $74.99 vs $99.98; 1x $29.99 vs $49.99)", async () => {
    const b = await offer(SIX_BLACK, "US", 1), c = await offer(SIX_BLACK, "US", 2);
    assert.deepEqual([b.price, b.compare, b.discount, c.price, c.compare, c.discount], [7499, 9998, 25, 2999, 4999, 40]);
  });
});
