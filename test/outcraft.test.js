import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { buildCompleted, buildUpdated, recoverLink, sendOutcraft } from "../lib/outcraft.js";
import { createSession, readRecoverLink, readSession } from "../lib/session.js";

const URL_ = "https://app.outcraft.test/api/v1/trigger/test-trigger";

const session = {
  j: "j1abc", mk: "AU", cur: "AUD", tot: 12399, gross: 15400,
  it: [[111, 1, { __kaching_bundles: "x" }], [222, 2, {}]],
  order: { l: [[111, 1, 9999], [222, 2, 1200]], c: "AUD", nm: ["Rain Drum", "Mallets"] },
  disp: [{ title: "Rain Drum" }, { title: "Mallets" }],
  dc: ["SAVE10"], attrs: { __clickid: "rtk1", utm_source: "facebook", utm_campaign: "bf", note: "not tracking" },
};

describe("outcraft", { concurrency: false }, () => {
  const saved = { url: process.env.OUTCRAFT_TRIGGER_URL, secret: process.env.SESSION_SECRET };
  const realFetch = globalThis.fetch;
  process.env.SESSION_SECRET = "test-secret";
  afterEach(() => {
    if (saved.url === undefined) delete process.env.OUTCRAFT_TRIGGER_URL; else process.env.OUTCRAFT_TRIGGER_URL = saved.url;
    globalThis.fetch = realFetch;
  });

  test("checkout/updated carries the full cart, contact and a recovery link", () => {
    const link = recoverLink("https://checkout.example.test/", session);
    const p = buildUpdated(session, {
      email: "a@b.co", phone: "+61412345678", first_name: "Ann", last_name: "Lee",
      address1: "1 George St", city: "Sydney", province: "NSW", zip: "2000", country_code: "AU",
      language: "en", timezone: "Australia/Sydney",
    }, link);
    assert.equal(p.outcraft_event, "checkout/updated");
    assert.equal(p.unique_id, "j1abc");
    assert.equal(p.phone, "+61412345678");
    assert.equal(p.should_verify_phone_presence, undefined);
    assert.equal(p.final_price, "123.99");
    assert.equal(p.currency, "AUD");
    assert.deepEqual(p.items, [
      { id: "111", name: "Rain Drum", quantity: 1, price: "99.99" },
      { id: "222", name: "Mallets", quantity: 2, price: "12.00" },
    ]);
    assert.deepEqual(p.discount_codes, ["SAVE10"]);
    assert.equal(p.shipping_details.province_code, "NSW");
    assert.equal(p.shipping_details.country_code, "AU");
    assert.equal(p.shipping_details.phone, "+61412345678");
    assert.deepEqual(p.context, { market: "AU", utm_source: "facebook", utm_campaign: "bf" });
    assert.ok(p.cart_link.startsWith("https://checkout.example.test/api/recover?r="));
  });

  test("email only: sent without a phone and not held for one; nobody to contact: not sent", () => {
    const p = buildUpdated(session, { email: "a@b.co", phone: "0412" }, "https://x.test/r");
    assert.equal(p.phone, undefined);
    assert.equal(p.should_verify_phone_presence, false);
    assert.equal(buildUpdated(session, { email: "nope", phone: "" }, "https://x.test/r"), null);
  });

  test("recovery link holds the cart and tracking, and is not a checkout session", () => {
    const link = recoverLink("https://checkout.example.test", session);
    const r = new URL(link).searchParams.get("r");
    const p = readRecoverLink(r);
    assert.equal(p.j, "j1abc");
    assert.equal(p.mk, "AU");
    assert.deepEqual(p.it, [[111, 1, { __kaching_bundles: "x" }], [222, 2]]);
    assert.deepEqual(p.dc, ["SAVE10"]);
    assert.deepEqual(p.a, { __clickid: "rtk1", utm_source: "facebook", utm_campaign: "bf" });
    assert.throws(() => readSession(r), { code: "session_invalid" });
    assert.throws(() => readRecoverLink(createSession({ j: "x" })), { code: "link_invalid" });
    const [body, sig] = r.split(".");
    assert.throws(() => readRecoverLink(`${body}x.${sig}`), { code: "link_invalid" });
  });

  test("checkout/completed uses the same unique_id and the amount paid", () => {
    const p = buildCompleted({
      j: "j1abc", paidCents: 11159, o: { ...session.order, dc: "SAVE10, BUNDLE-UPSELL" }, attrs: session.attrs,
      email: "a@b.co", phone: "+61412345678", method: "Card",
      ship: { first: "Ann", last: "Lee", line1: "1 George St", city: "Sydney", state: "NSW", postal_code: "2000", country: "au" },
    });
    assert.equal(p.outcraft_event, "checkout/completed");
    assert.equal(p.unique_id, "j1abc");
    assert.equal(p.final_price, "111.59");
    assert.deepEqual(p.discount_codes, ["SAVE10"]);
    assert.equal(p.items.length, 2);
    assert.equal(p.shipping_details.country_code, "AU");
    assert.equal(p.context.payment_provider, "whop");
  });

  test("not configured: nothing is sent; a hanging endpoint gives up", async () => {
    delete process.env.OUTCRAFT_TRIGGER_URL;
    let calls = 0;
    globalThis.fetch = () => { calls++; return Promise.resolve({ ok: true, status: 200 }); };
    assert.deepEqual(await sendOutcraft({ outcraft_event: "checkout/updated" }), { skipped: "not_configured" });
    assert.equal(calls, 0);

    process.env.OUTCRAFT_TRIGGER_URL = URL_;
    globalThis.fetch = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" })), { once: true });
    });
    const err = console.error; console.error = () => {};
    const started = Date.now();
    try { assert.deepEqual(await sendOutcraft({ outcraft_event: "checkout/updated" }), { error: "request_failed" }); }
    finally { console.error = err; }
    assert.ok(Date.now() - started < 4000);
  });

  test("the Whop webhook sends checkout/completed after the order", async () => {
    const keys = ["SHOPIFY_STORE", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "REDTRACK_POSTBACK_URL", "SERVER_ADS_ENABLED", "SHIPPING_DAYS"];
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { SHOPIFY_STORE: "test.myshopify.com", SHOPIFY_CLIENT_ID: "cid", SHOPIFY_CLIENT_SECRET: "cs", REDTRACK_POSTBACK_URL: "https://trk.example.test/postback", OUTCRAFT_TRIGGER_URL: URL_ });
    delete process.env.SERVER_ADS_ENABLED; delete process.env.SHIPPING_DAYS;
    const sent = [];
    globalThis.fetch = (url, opts) => {
      const path = String(url).split("?")[0];
      const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      if (path.includes("/admin/oauth/access_token")) return ok({ access_token: "t", expires_in: 86400 });
      if (path.endsWith("/graphql.json")) {
        const q = JSON.parse(opts.body).query;
        if (q.includes("orders(first")) return ok({ data: { orders: { nodes: [] } } });
        if (q.includes("orderCreate")) return ok({ data: { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#1001" }, userErrors: [] } } });
        return ok({ data: { orderRiskAssessmentCreate: { userErrors: [] } } });
      }
      if (path.includes("/postback")) return ok({});
      if (String(url) === URL_) { sent.push(JSON.parse(opts.body)); return ok({}); }
      throw new Error("unexpected url " + path);
    };
    try {
      const { fulfil } = await import("../api/whop-webhook.js");
      const r = await fulfil({
        id: "pay_oc_1", paid_at: "2026-11-01T12:00:00.000Z", total: 49,
        metadata: {
          order: JSON.stringify({ l: [[111, 1, 4900]], c: "USD", t: 4900, sc: "USD", st: 4900, d: 0, nm: ["Rain Drum"] }),
          attrs: JSON.stringify({ utm_source: "facebook" }),
          ship: JSON.stringify({ v: 2, email: "buyer@example.com", phone: "+12133734253", s: { first_name: "A", last_name: "B", address1: "1 Main", city: "Austin", province: "TX", zip: "78701", country_code: "US" } }),
          j: "j-paid",
        },
      });
      assert.equal(r.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].outcraft_event, "checkout/completed");
      assert.equal(sent[0].unique_id, "j-paid");
      assert.equal(sent[0].final_price, "49.00");
      assert.equal(sent[0].email, "buyer@example.com");
      assert.equal(sent[0].shipping_details.zip, "78701");
    } finally {
      for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
    }
  });
});
