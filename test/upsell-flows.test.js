// Several post-purchase flows in one UPSELL_OFFERS list: XL Pro (unchanged) + 6-inch L.
// Shopify pricing and Whop are fakes. Nothing real is called. Run: node --test --experimental-test-module-mocks
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test, mock } from "node:test";

process.env.WHOP_API_KEY = "test_key"; process.env.WHOP_COMPANY_ID = "biz_test"; process.env.SESSION_SECRET = "test_secret";
process.env.CHECKOUT_URL = "https://checkout.test";

const XL = [68105383870646, 68112843899062, 68114477449398, 68114477482166, 68114477514934], NINE = 67665328799926;
// Stand-in 6-inch variant ids (the real ones come from the 6-inch product once it exists)
const SIX = { "6INCH-PRODRUM-TEAL-Q1": 70000000000001, "6INCH-PRODRUM-BLACK-Q1": 70000000000002, "6INCH-PRODRUM-PURPLE-Q1": 70000000000003,
  "6INCH-PRODRUM-AQUA-Q1": 70000000000004, "6INCH-PRODRUM-GOLDEN-Q1": 70000000000005 };
const SIX_TEAL = SIX["6INCH-PRODRUM-TEAL-Q1"], SIX_BLACK = SIX["6INCH-PRODRUM-BLACK-Q1"];

// The XL flow as configured on production (v2 config, trimmed to the fields that drive behavior)
const XL_FLOW = [
  { variant_id: XL[0], if_any_variant: XL, price: { USD: 11999, GBP: 9299 }, title: "Second 10-Inch XL Pro Steel Drum" },
  { variant_id: NINE, quantity: 2, when: "declined", if_any_variant: XL, unless_any_variant: [NINE], price: { USD: 7499, GBP: 5799 }, msrp: { USD: 9998, GBP: 7798 } },
  { variant_id: NINE, when: "declined", if_any_variant: XL, unless_any_variant: [NINE], price: { USD: 2999, GBP: 2299 }, msrp: { USD: 4999, GBP: 3899 } },
];
const TEMPLATE = JSON.parse(fs.readFileSync(new URL("../config/upsell-6inch-L.template.json", import.meta.url), "utf8"));

const SHOP = { [XL[0]]: { USD: 17999, GBP: 13999, title: "XL Pro" }, [SIX_TEAL]: { USD: 9999, GBP: 7799, title: "6-Inch L" }, [NINE]: { USD: 2999, GBP: 2299, title: "9-note" } };
mock.module("../lib/pricing.js", { namedExports: {
  priceCart: async (b) => {
    const it = b.items[0], cur = b.market_country === "GB" ? "GBP" : "USD", u = SHOP[it.variant_id][cur], su = SHOP[it.variant_id].USD;
    return { currency: cur, shopCurrency: "USD", total: u * it.quantity, shopTotal: su * it.quantity, lines: [[it.variant_id, it.quantity, u, su]],
      display: [{ title: SHOP[it.variant_id].title, options: [], image: "", qty: it.quantity }] };
  },
} });
mock.module("../lib/shopify.js", { namedExports: { API: "test", adminToken: async () => "t", adminGql: async () => ({}), storefrontGql: async () => ({}) } });

const { fill, merge, placeholders } = await import("../scripts/upsell-offers.mjs");
const { selectOffers, default: upsell } = await import("../api/upsell.js");
const { createSession } = await import("../lib/session.js");

const SIX_FLOW = fill(TEMPLATE, SIX);
const ALL = merge(XL_FLOW, SIX_FLOW);

describe("flow selection (selectOffers)", () => {
  test("the 6-inch template fills to real ids with no placeholders left", () => {
    assert.deepEqual(placeholders(SIX_FLOW), []);
    assert.equal(SIX_FLOW[0].variant_id, SIX_TEAL);
    assert.deepEqual(SIX_FLOW[0].if_any_variant.sort(), Object.values(SIX).sort());
    assert.deepEqual(SIX_FLOW.map((o) => o.price.USD), [5999, 7499, 2999]);
    assert.deepEqual(SIX_FLOW.map((o) => o.when || "always"), ["always", "declined", "declined"]);
  });
  test("XL Pro checkouts get exactly the XL flow, unchanged, with the 6-inch offers in the list", () => {
    for (const v of XL) assert.deepEqual(selectOffers(ALL, [v]), selectOffers(XL_FLOW, [v]));
    assert.deepEqual(selectOffers(ALL, [XL[2]]).map((o) => o.price.USD), [11999, 7499, 2999]);
  });
  test("6-inch L checkouts (any color) get the 6-inch flow", () => {
    for (const v of Object.values(SIX)) {
      const s = selectOffers(ALL, [v]);
      assert.deepEqual(s.map((o) => o.flow), ["6inch-L", "6inch-L", "6inch-L"]);
      assert.deepEqual(s.map((o) => [o.variant_id, o.quantity || 1, o.price.USD]), [[SIX_TEAL, 1, 5999], [NINE, 2, 7499], [NINE, 1, 2999]]);
    }
  });
  test("a cart with both drums gets only the XL flow (flows never mix)", () => {
    assert.deepEqual(selectOffers(ALL, [SIX_BLACK, XL[0]]), selectOffers(XL_FLOW, [XL[0]]));
    assert.deepEqual(selectOffers(ALL, [SIX_BLACK, XL[0], NINE]).map((o) => o.variant_id), [XL[0]]);
  });
  test("6-inch + 9-note in the cart: only the second 6-inch offer (no 9-note offers)", () => {
    assert.deepEqual(selectOffers(ALL, [SIX_TEAL, NINE]).map((o) => o.variant_id), [SIX_TEAL]);
  });
  test("9-note-only checkouts get nothing", () => { assert.deepEqual(selectOffers(ALL, [NINE]), []); });
  test("an unfilled template is inert: 6-inch gets nothing and XL is unchanged", () => {
    const raw = [...XL_FLOW, ...TEMPLATE];
    assert.deepEqual(selectOffers(raw, [SIX_TEAL]), []);
    assert.deepEqual(selectOffers(raw, [XL[0]]), selectOffers(XL_FLOW, [XL[0]]));
  });
  test("merge replaces the 6-inch flow on a re-run and keeps the XL offers first, in order", () => {
    const again = merge(ALL, SIX_FLOW);
    assert.equal(again.length, 6); assert.deepEqual(again.slice(0, 3), XL_FLOW);
  });
  test("fill refuses a missing SKU", () => {
    assert.throws(() => fill(TEMPLATE, { "6INCH-PRODRUM-BLACK-Q1": 1 }), /no variant for sku:6INCH-PRODRUM-TEAL-Q1/);
  });
});

// ---------- the offer the page shows (GET /api/upsell) ----------
process.env.UPSELL_OFFERS = JSON.stringify(ALL);
const order = (cur) => ({ l: [[SIX_BLACK, 1, SHOP[SIX_TEAL][cur], 9999]], c: cur, t: SHOP[SIX_TEAL][cur] });
let ORDER;
globalThis.fetch = async (url) => {
  const p = new URL(String(url)).pathname;
  if (p.endsWith("/payments/pay_parent")) return new Response(JSON.stringify({ id: "pay_parent", status: "paid", paid_at: new Date().toISOString(),
    member_id: "mber_1", payment_method_id: "payt_1", metadata: { order: JSON.stringify(ORDER) } }), { status: 200, headers: { "Content-Type": "application/json" } });
  throw new Error(`unexpected fetch ${url}`);
};
const get = (q) => new Promise((ok) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { ok(o); return this; }, end() { ok(null); } };
  upsell({ method: "GET", query: q, headers: {} }, res);
});

describe("6-inch offer pages (GET /api/upsell)", () => {
  for (const [mk, cur, p0, cmp0, off0] of [["US", "USD", 5999, 9999, 40], ["GB", "GBP", 4699, 7799, 40]]) {
    test(`${cur}: step 0 second 6-inch, then 9-note pair, then one 9-note`, async () => {
      ORDER = order(cur);
      const s = createSession({ order: ORDER, mk, j: "jt" });
      const a = await get({ s, payment: "pay_parent", step: 0 });
      assert.equal(a.price, p0); assert.equal(a.compare, cmp0); assert.equal(a.discount, off0); assert.equal(a.qty, 1);
      assert.equal(a.title, "Second 6-Inch L Steel Drum"); assert.equal(a.hasAfterDecline, true); assert.equal(a.hasAfterAccept, false);
      assert.equal(a.rating, ""); assert.deepEqual(a.reviews, []); // no XL reviews on a new product
      const b = await get({ s, payment: "pay_parent", step: 1, declined: "0" });
      assert.equal(b.qty, 2); assert.equal(b.price, cur === "USD" ? 7499 : 5799);
      const c = await get({ s, payment: "pay_parent", step: 2, declined: "0,1" });
      assert.equal(c.qty, 1); assert.equal(c.price, cur === "USD" ? 2999 : 2299); assert.equal(c.last, true);
    });
  }
});
