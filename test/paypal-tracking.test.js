import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createShipment } from "../lib/whop.js";
import { paypalTrackingJob, sendPaypalTracking, trackingNumbers } from "../api/shopify-webhook.js";

const order = (method, payment = "pay_UEhHhXnbPu2lJW") => ({
  customAttributes: [
    ...(method ? [{ key: "Payment method", value: method }] : []),
    { key: "whop_payment_id", value: payment },
    { key: "Payment id", value: payment },
  ],
  tags: [`whop-${payment}`],
});

describe("paypal tracking", () => {
  const saved = {
    WHOP_API_KEY: process.env.WHOP_API_KEY,
    WHOP_COMPANY_ID: process.env.WHOP_COMPANY_ID,
    WHOP_API_KEY_OLD: process.env.WHOP_API_KEY_OLD,
    WHOP_COMPANY_ID_OLD: process.env.WHOP_COMPANY_ID_OLD,
  };
  const realFetch = globalThis.fetch;

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
  });

  test("reads the carrier numbers Shopify sends", () => {
    assert.deepEqual(trackingNumbers({ tracking_number: " 1Z1 ", tracking_numbers: ["1Z1", "", "1Z2"] }), ["1Z1", "1Z2"]);
  });

  test("a card order is not sent", async () => {
    assert.equal(paypalTrackingJob(order("Visa •••• 4242"), { status: "success", tracking_number: "1Z1" }).skip, "not_paypal");
    globalThis.fetch = () => { throw new Error("should not call Whop"); };
    const r = await sendPaypalTracking(order("Visa •••• 4242"), { id: 9, status: "success", tracking_number: "1Z1" });
    assert.equal(r.skip, "not_paypal");
  });

  test("a PayPal order sends the Whop payment id and the tracking number", async () => {
    process.env.WHOP_API_KEY = "key";
    process.env.WHOP_COMPANY_ID = "biz_test";
    delete process.env.WHOP_API_KEY_OLD;
    delete process.env.WHOP_COMPANY_ID_OLD;
    const calls = [];
    globalThis.fetch = async (url, opt) => {
      calls.push({ url, opt, body: JSON.parse(opt.body) });
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: "ship_1" }) };
    };
    const r = await sendPaypalTracking(order("PayPal"), {
      id: 42, status: "success", tracking_number: "1Z999AA10123456784", tracking_numbers: ["1Z999AA10123456784", "1ZSECOND"],
    });
    assert.deepEqual(r.sent, ["1Z999AA10123456784", "1ZSECOND"]);
    assert.equal(r.paymentId, "pay_UEhHhXnbPu2lJW");
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.url, "https://api.whop.com/api/v1/shipments");
      assert.deepEqual(Object.keys(c.body).sort(), ["account_id", "payment_id", "tracking_number"]);
      assert.equal(c.body.payment_id, "pay_UEhHhXnbPu2lJW");
      assert.equal(c.body.account_id, "biz_test");
      assert.equal(c.opt.headers.Authorization, "Bearer key");
      assert.match(c.opt.headers["Idempotency-Key"], /^shopify-track-[a-f0-9]{32}$/);
    }
    assert.notEqual(calls[0].opt.headers["Idempotency-Key"], calls[1].opt.headers["Idempotency-Key"]);
  });

  test("no tracking number and a cancelled fulfillment are skipped", async () => {
    assert.equal(paypalTrackingJob(order("PayPal"), { status: "success" }).skip, "no_tracking");
    assert.equal(paypalTrackingJob(order("PayPal"), { status: "cancelled", tracking_number: "1Z1" }).skip, "fulfillment_not_active");
  });

  test("an order saved before the PayPal label is checked on the Whop payment", async () => {
    process.env.WHOP_API_KEY = "key";
    process.env.WHOP_COMPANY_ID = "biz_test";
    delete process.env.WHOP_API_KEY_OLD;
    const calls = [];
    globalThis.fetch = async (url, opt) => {
      calls.push(JSON.parse(opt.body));
      return { ok: true, status: 201, text: async () => "{}" };
    };
    const card = await sendPaypalTracking(order(""), { id: 1, tracking_number: "1Z1" }, async () => ({ payment_method_type: "card" }));
    assert.equal(card.skip, "not_paypal");
    assert.equal(calls.length, 0);
    const paypal = await sendPaypalTracking(order(""), { id: 1, tracking_number: "1Z1" }, async () => ({ payment_method_type: "paypal" }));
    assert.deepEqual(paypal.sent, ["1Z1"]);
    assert.equal(calls[0].payment_id, "pay_UEhHhXnbPu2lJW");
  });

  test("Whop already having the shipment is success, and a Whop outage is retried", async () => {
    process.env.WHOP_API_KEY = "key";
    process.env.WHOP_COMPANY_ID = "biz_test";
    delete process.env.WHOP_API_KEY_OLD;
    globalThis.fetch = async () => ({ ok: false, status: 409, text: async () => "{}" });
    const dup = await sendPaypalTracking(order("PayPal"), { id: 1, tracking_number: "1Z1" });
    assert.deepEqual(dup.sent, ["1Z1"]);
    assert.equal(dup.retry, undefined);

    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "{}" });
    const down = await sendPaypalTracking(order("PayPal"), { id: 1, tracking_number: "1Z1" });
    assert.equal(down.retry, true);
  });

  test("a payment on the previous Whop account is tried after a 404", async () => {
    process.env.WHOP_API_KEY = "new";
    process.env.WHOP_COMPANY_ID = "biz_new";
    process.env.WHOP_API_KEY_OLD = "old";
    process.env.WHOP_COMPANY_ID_OLD = "biz_old";
    const seen = [];
    globalThis.fetch = async (url, opt) => {
      seen.push(opt.headers.Authorization);
      if (opt.headers.Authorization === "Bearer new") return { ok: false, status: 404, text: async () => "{}" };
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: "ship_old" }) };
    };
    const r = await createShipment("pay_abc", "1Z1", "shopify-track-test");
    assert.equal(r.ok, true);
    assert.deepEqual(seen, ["Bearer new", "Bearer old"]);
  });
});
