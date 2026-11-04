import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { orderAttributes } from "../lib/pricing.js";
import {
  buildServerAds,
  eventIdFor,
  hashEmail,
  hashPhoneDigits,
  hashPhoneE164,
  reportServerAds,
  selectNetwork,
  SERVER_ADS_TIMEOUT_MS,
} from "../lib/server-ads.js";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

describe("server ads", { concurrency: false }, () => {
  const envKeys = [
    "SERVER_ADS_ENABLED", "TIKTOK_EVENTS_TOKEN", "TIKTOK_PIXEL_CODE", "TIKTOK_TEST_EVENT_CODE",
    "SNAP_CAPI_TOKEN", "SNAP_PIXEL_ID", "SNAP_CAPI_VALIDATE",
    "PINTEREST_CAPI_TOKEN", "PINTEREST_AD_ACCOUNT_ID", "PINTEREST_CAPI_TEST",
    "SHOPIFY_STORE", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "REDTRACK_POSTBACK_URL",
    "CHECKOUT_URL", "SHIPPING_DAYS",
  ];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const logs = [];
  const realLog = console.log;

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    globalThis.fetch = realFetch;
    console.log = realLog;
    logs.length = 0;
  });

  function spyLog() {
    console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  }

  function adsEnv(extra = {}) {
    process.env.SERVER_ADS_ENABLED = "true";
    process.env.TIKTOK_EVENTS_TOKEN = "tiktok-secret-token";
    process.env.TIKTOK_PIXEL_CODE = "DB9H2D3C77U0NJ5DOPB0";
    process.env.SNAP_CAPI_TOKEN = "snap-secret-token";
    process.env.SNAP_PIXEL_ID = "pixel-snap-1";
    process.env.PINTEREST_CAPI_TOKEN = "pin-secret-token";
    process.env.PINTEREST_AD_ACCOUNT_ID = "549770381859";
    delete process.env.TIKTOK_TEST_EVENT_CODE;
    delete process.env.SNAP_CAPI_VALIDATE;
    delete process.env.PINTEREST_CAPI_TEST;
    Object.assign(process.env, extra);
  }

  test("selects at most one network, and ignores cookies and AppLovin", () => {
    assert.equal(selectNetwork({ ttclid: "CLICK123" }), "tiktok");
    assert.equal(selectNetwork({ utm_source: "tiktok" }), "tiktok");
    assert.equal(selectNetwork({ tw_source: "TikTok Ads" }), "tiktok");
    assert.equal(selectNetwork({ landing_site: "https://madespecial.store/a?utm_source=tiktok&ttclid=TEST123" }), "tiktok");
    assert.equal(selectNetwork({ landing_site: "/products/drum?ttclid=FROMURL" }), "tiktok");

    assert.equal(selectNetwork({ ScCid: "snap-click-1" }), "snap");
    assert.equal(selectNetwork({ sc_click_id: "snap-click-2" }), "snap");
    assert.equal(selectNetwork({ utm_source: "snap" }), "snap");
    assert.equal(selectNetwork({ utm_source: "snapchat" }), "snap");
    assert.equal(selectNetwork({ tw_source: "snapchat.com" }), "snap");
    assert.equal(selectNetwork({ landing_site: "/pages/lp?ScCid=HELLO12345" }), "snap");

    assert.equal(selectNetwork({ epik: "pin-click-1" }), "pinterest");
    assert.equal(selectNetwork({ utm_source: "pinterest" }), "pinterest");
    assert.equal(selectNetwork({ tw_source: "pin" }), "pinterest");
    assert.equal(selectNetwork({ landing_site: "https://madespecial.store/?epik=PINURL1" }), "pinterest");

    assert.equal(selectNetwork({ _ttp: "everyone-has-this", _scid: "and-this", _epik: "cookie", _fbp: "meta" }), "");
    assert.equal(selectNetwork({}), "");
    assert.equal(selectNetwork({ utm_source: "google" }), "");
    assert.equal(selectNetwork({ utm_source: "facebook", _ttp: "x" }), "");
    assert.equal(selectNetwork({ utm_source: "applovin", _ttp: "everyone-has-this", _scid: "and-this" }), "");
    assert.equal(selectNetwork({ tw_source: "axon", ttclid: "CLICK123" }), "");
    assert.equal(selectNetwork({ utm_source: "applovin", ttclid: "CLICK123" }), "");
    assert.equal(selectNetwork({ aleid: "axon-click" }), "");

    assert.equal(selectNetwork({ ttclid: "CLICK123", ScCid: "snap-click-1" }), "");
    assert.equal(selectNetwork({ ttclid: "CLICK123", utm_source: "snapchat" }), "");
    assert.equal(selectNetwork({ ttclid: "CLICK123", ScCid: "snap-click-1", utm_source: "tiktok" }), "tiktok");
    assert.equal(selectNetwork({ tw_source: "tiktok", utm_source: "applovin" }), "tiktok");
    assert.equal(selectNetwork({ tw_source: "google", utm_source: "tiktok" }), "");
    assert.equal(selectNetwork({ utm_source: "snapshot" }), "");
    assert.equal(selectNetwork({ TTCLID: "CLICK123" }), "tiktok");
  });

  test("event id is the Whop payment id and does not change between builds", () => {
    assert.equal(eventIdFor("pay_abc"), "whop-pay_abc");
    assert.equal(eventIdFor("pay_abc"), eventIdFor("pay_abc"));
    assert.notEqual(eventIdFor("pay_abc"), eventIdFor("pay_def"));
    adsEnv();
    const info = purchase({ ttclid: "CLICK123" }, { payId: "pay_stable" });
    const a = buildServerAds(info);
    const b = buildServerAds(info);
    assert.equal(a.eventId, "whop-pay_stable");
    assert.equal(b.eventId, a.eventId);
    assert.equal(a.body.data[0].event_id, "whop-pay_stable");
    assert.equal(b.body.data[0].event_id, a.body.data[0].event_id);
    assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
  });

  test("hashes email and phone, leaves ip and user agent plain, and adds test modes", () => {
    assert.equal(hashEmail(" ALICE_abc@gmail.com "), "848a771458438fc2ec420560d769fb9b9b86851ee338ec56517baabd79d3bb4f");
    assert.equal(hashPhoneE164("(+1)2133734253", "US"), "9f7ec22d72092cd3c0b58726ed9c2d91b92e51a3f29837508fb2948bb22dd2fd");
    assert.equal(hashPhoneDigits("+12133734253", "US"), sha("12133734253"));

    adsEnv({ TIKTOK_TEST_EVENT_CODE: "TESTCODE99" });
    const tiktok = buildServerAds(purchase({ ttclid: "CLICK123" }));
    const raw = JSON.stringify(tiktok.body);
    assert.equal(tiktok.body.test_event_code, "TESTCODE99");
    assert.equal(tiktok.body.event_source_id, "DB9H2D3C77U0NJ5DOPB0");
    assert.equal(tiktok.body.data[0].event, "Purchase");
    assert.equal(tiktok.body.data[0].properties.currency, "USD");
    assert.equal(tiktok.body.data[0].properties.value, 49);
    assert.equal(tiktok.body.data[0].properties.order_id, "#1001");
    assert.equal(tiktok.body.data[0].user.email, hashEmail("Buyer@Example.com"));
    assert.equal(tiktok.body.data[0].user.phone, hashPhoneE164("+12133734253", "US"));
    assert.equal(tiktok.body.data[0].user.ip, "203.0.113.10");
    assert.equal(tiktok.body.data[0].user.user_agent, "TestAgent/1.0");
    assert.equal(tiktok.body.data[0].user.ttclid, "CLICK123");
    assert.equal(raw.includes("Buyer@Example.com"), false);
    assert.equal(raw.includes("2133734253"), false);
    assert.equal(tiktok.headers["Access-Token"], "tiktok-secret-token");

    adsEnv({ SNAP_CAPI_VALIDATE: "true" });
    const snap = buildServerAds(purchase({ ScCid: "snap-click-1", _scid: "cookie-not-a-selector" }));
    assert.match(snap.url, /\/events\/validate\?/);
    assert.equal(snap.body.data[0].event_name, "PURCHASE");
    assert.equal(snap.body.data[0].event_id, "whop-pay_test_1");
    assert.deepEqual(snap.body.data[0].user_data.em, [hashEmail("Buyer@Example.com")]);
    assert.deepEqual(snap.body.data[0].user_data.ph, [hashPhoneDigits("+12133734253", "US")]);
    assert.equal(snap.body.data[0].user_data.client_ip_address, "203.0.113.10");
    assert.equal(snap.body.data[0].user_data.sc_click_id, "snap-click-1");
    assert.equal(snap.url.includes("snap-secret-token"), true);

    adsEnv({ PINTEREST_CAPI_TEST: "1" });
    const pin = buildServerAds(purchase({ epik: "pin-click-1" }));
    assert.match(pin.url, /ad_accounts\/549770381859\/events\?test=true$/);
    assert.equal(pin.body.data[0].event_name, "checkout");
    assert.equal(pin.body.data[0].custom_data.value, "49.00");
    assert.equal(pin.body.data[0].custom_data.order_id, "#1001");
    assert.deepEqual(pin.body.data[0].user_data.em, [hashEmail("Buyer@Example.com")]);
    assert.equal(pin.body.data[0].user_data.click_id, "pin-click-1");
    assert.equal(pin.headers.Authorization, "Bearer pin-secret-token");
  });

  test("flag off and a missing pixel make no network call", async () => {
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "{}" }; };
    spyLog();
    adsEnv();
    delete process.env.SERVER_ADS_ENABLED;
    const off = await reportServerAds(purchase({ ttclid: "CLICK123" }));
    assert.equal(off.skipped, "disabled");
    assert.equal(calls.length, 0);
    assert.equal(logs.some((l) => l.startsWith("server_ads")), false);

    process.env.SERVER_ADS_ENABLED = "false";
    await reportServerAds(purchase({ ScCid: "snap-click-1" }));
    assert.equal(calls.length, 0);

    process.env.SERVER_ADS_ENABLED = "true";
    delete process.env.TIKTOK_PIXEL_CODE;
    const skipped = await reportServerAds(purchase({ ttclid: "CLICK123" }));
    assert.equal(skipped.skipped, "no_pixel");
    assert.equal(calls.length, 0);
    assert.match(logs.at(-1), /network=tiktok event_id=whop-pay_test_1 status=- error=no_pixel/);
    assert.equal(logs.some((l) => l.includes("tiktok-secret-token")), false);

    delete process.env.SNAP_PIXEL_ID;
    logs.length = 0;
    await reportServerAds(purchase({ utm_source: "snapchat" }));
    assert.equal(calls.length, 0);
    assert.match(logs[0], /network=snap .*error=no_pixel/);

    delete process.env.PINTEREST_AD_ACCOUNT_ID;
    logs.length = 0;
    await reportServerAds(purchase({ epik: "pin-click-1" }));
    assert.equal(calls.length, 0);
    assert.match(logs[0], /network=pinterest .*error=no_account/);
  });

  test("a successful send posts one event and logs status without the token", async () => {
    adsEnv();
    spyLog();
    let posted = null;
    globalThis.fetch = async (url, opts) => {
      posted = { url: String(url), body: JSON.parse(opts.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, message: "OK" }) };
    };
    const r = await reportServerAds(purchase({ ttclid: "CLICK123", _ttp: "not-used-to-select" }));
    assert.equal(r.status, 200);
    assert.equal(r.error, "");
    assert.equal(posted.body.data[0].event_id, "whop-pay_test_1");
    assert.equal(posted.body.data[0].user.ttp, "not-used-to-select");
    assert.equal(posted.url.includes("tiktok-secret-token"), false);
    assert.match(logs[0], /network=tiktok event_id=whop-pay_test_1 status=200 error=-/);
  });

  test("a network timeout or HTTP error is logged and does not reject", async () => {
    assert.equal(SERVER_ADS_TIMEOUT_MS, 2500);
    adsEnv();
    spyLog();
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (opts?.signal?.aborted) return fail();
      opts?.signal?.addEventListener("abort", fail, { once: true });
    });
    const started = Date.now();
    const timed = await reportServerAds(purchase({ ttclid: "CLICK123" }));
    const elapsed = Date.now() - started;
    assert.equal(timed.error, "timeout");
    assert.ok(elapsed >= 2000 && elapsed < 5000, `elapsed ${elapsed}`);
    assert.match(logs.at(-1), /network=tiktok event_id=whop-pay_test_1 status=- error=timeout/);
    assert.equal(logs.some((l) => /tiktok-secret-token|snap-secret-token|pin-secret-token/.test(l)), false);

    logs.length = 0;
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ message: "nope tiktok-secret-token" }) });
    const failed = await reportServerAds(purchase({ ttclid: "CLICK123" }));
    assert.equal(failed.status, 500);
    assert.match(logs.at(-1), /network=tiktok event_id=whop-pay_test_1 status=500 error=/);
    assert.equal(logs.at(-1).includes("tiktok-secret-token"), false);
    assert.match(logs.at(-1), /\[redacted\]/);
  });

  test("click ids survive the attribute trim; the pixel cookies are not required", () => {
    const tracking = { ttclid: "KEEPME", ScCid: "SNAPID", epik: "PINID", utm_source: "tiktok", tw_source: "tiktok" };
    for (let i = 0; i < 20; i++) tracking["blob" + i] = "z".repeat(300);
    const out = orderAttributes({}, tracking);
    assert.equal(out.ttclid, "KEEPME");
    assert.equal(out.ScCid, "SNAPID");
    assert.equal(out.epik, "PINID");
    assert.equal(out.utm_source, "tiktok");
    assert.equal(out.tw_source, "tiktok");
    assert.equal(out.blob0, undefined);
  });

  test("webhook still creates the order and posts RedTrack when ads time out or error", async () => {
    process.env.SHOPIFY_STORE = "test.myshopify.com";
    process.env.SHOPIFY_CLIENT_ID = "cid";
    process.env.SHOPIFY_CLIENT_SECRET = "csecret";
    process.env.REDTRACK_POSTBACK_URL = "https://trk.example.test/postback";
    delete process.env.SHIPPING_DAYS;
    adsEnv();
    const { fulfil } = await import("../api/whop-webhook.js");

    const seen = [];
    let adsMode = "throw";
    globalThis.fetch = (url, opts) => {
      const u = String(url);
      const path = u.split("?")[0];
      seen.push(path);
      if (path.includes("/admin/oauth/access_token")) return json({ access_token: "shop-token", expires_in: 86400 });
      if (path.endsWith("/graphql.json")) {
        const body = JSON.parse(opts.body);
        const q = body.query;
        if (q.includes("orders(first")) return json({ data: { orders: { nodes: [] } } });
        if (q.includes("orderCreate")) {
          assert.equal(body.variables.order.financialStatus, "PAID");
          assert.equal(body.variables.order.transactions[0].gateway, "Whop");
          return json({ data: { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#1001" }, userErrors: [] } } });
        }
        if (q.includes("orderRiskAssessmentCreate")) return json({ data: { orderRiskAssessmentCreate: { userErrors: [] } } });
        throw new Error("unexpected query");
      }
      if (path.includes("business-api.tiktok.com")) {
        if (adsMode === "throw") return Promise.reject(new Error("network down"));
        return new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (opts?.signal?.aborted) return fail();
          opts?.signal?.addEventListener("abort", fail, { once: true });
        });
      }
      if (path.includes("/postback")) return json({ ok: true });
      throw new Error("unexpected url " + path);
    };

    const failed = await fulfil(payment({ utm_source: "tiktok", ttclid: "TEST123", __clickid: "rtk1" }));
    assert.equal(failed.status, 200);
    assert.equal(failed.body.order, "#1001");
    assert.equal(failed.body.fallback, undefined);
    assert.equal(seen.some((p) => p.includes("order") || p.endsWith("/graphql.json")), true);
    assert.equal(seen.filter((p) => p.endsWith("/graphql.json")).length >= 2, true);
    assert.equal(seen.some((p) => p.includes("/postback")), true);
    assert.equal(seen.some((p) => p.includes("business-api.tiktok.com")), true);
    assert.equal(seen.some((p) => p.includes("tr.snapchat.com") || p.includes("api.pinterest.com")), false);

    seen.length = 0;
    adsMode = "hang";
    const started = Date.now();
    const hung = await fulfil(payment({ utm_source: "tiktok", ttclid: "TEST123", __clickid: "rtk1" }, "pay_hang"));
    assert.equal(hung.status, 200);
    assert.equal(hung.body.order, "#1001");
    assert.ok(Date.now() - started < 6000);
    assert.equal(seen.some((p) => p.includes("/postback")), true);
  });

  test("flag off, a failed order, and a duplicate webhook do not call an ad network", async () => {
    process.env.SHOPIFY_STORE = "test.myshopify.com";
    process.env.SHOPIFY_CLIENT_ID = "cid";
    process.env.SHOPIFY_CLIENT_SECRET = "csecret";
    process.env.REDTRACK_POSTBACK_URL = "https://trk.example.test/postback";
    delete process.env.SERVER_ADS_ENABLED;
    delete process.env.SHIPPING_DAYS;
    const { fulfil } = await import("../api/whop-webhook.js");
    const seen = [];
    let nodes = [];
    let failOrder = false;
    globalThis.fetch = (url, opts) => {
      const path = String(url).split("?")[0];
      seen.push(path);
      if (path.includes("/admin/oauth/access_token")) return json({ access_token: "shop-token", expires_in: 86400 });
      if (path.endsWith("/graphql.json")) {
        const q = JSON.parse(opts.body).query;
        if (q.includes("orders(first")) return json({ data: { orders: { nodes } } });
        if (q.includes("orderCreate")) {
          if (failOrder) return json({ data: { orderCreate: { order: null, userErrors: [{ field: null, message: "no" }] } } });
          return json({ data: { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#1001" }, userErrors: [] } } });
        }
        if (q.includes("orderRiskAssessmentCreate")) return json({ data: { orderRiskAssessmentCreate: { userErrors: [] } } });
      }
      if (path.includes("/postback")) return json({ ok: true });
      if (/tiktok|snapchat|pinterest/.test(path)) throw new Error("ad network was called");
      throw new Error("unexpected url " + path);
    };

    const off = await fulfil(payment({ ttclid: "TEST123", __clickid: "rtk1" }, "pay_off"));
    assert.equal(off.status, 200);
    assert.equal(off.body.order, "#1001");
    assert.equal(seen.some((p) => /tiktok|snapchat|pinterest/.test(p)), false);
    assert.equal(seen.some((p) => p.includes("/postback")), true);

    seen.length = 0;
    process.env.SERVER_ADS_ENABLED = "true";
    process.env.TIKTOK_EVENTS_TOKEN = "tiktok-secret-token";
    process.env.TIKTOK_PIXEL_CODE = "DB9H2D3C77U0NJ5DOPB0";
    nodes = [{ id: "gid://shopify/Order/9", name: "#1009" }];
    const dup = await fulfil(payment({ ttclid: "TEST123" }, "pay_dup"));
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, "#1009");
    assert.equal(seen.some((p) => /tiktok|snapchat|pinterest/.test(p)), false);
    assert.equal(seen.some((p) => p.includes("/postback")), false);

    seen.length = 0;
    nodes = [];
    failOrder = true;
    const bad = await fulfil(payment({ ttclid: "TEST123", __clickid: "rtk1" }, "pay_bad"));
    assert.equal(bad.status, 500);
    assert.equal(seen.some((p) => /tiktok|snapchat|pinterest/.test(p)), false);
  });
});

function purchase(attrs, extra = {}) {
  return {
    payId: "pay_test_1",
    orderName: "#1001",
    attrs,
    email: "Buyer@Example.com",
    phone: "+12133734253",
    country: "US",
    currency: "USD",
    totalCents: 4900,
    lines: [[111, 1, 4900]],
    names: ["Rain Drum"],
    ip: "203.0.113.10",
    ua: "TestAgent/1.0",
    paidAt: "2026-11-01T12:00:00.000Z",
    ...extra,
  };
}

function payment(attrs, id = "pay_test_1") {
  return {
    id,
    paid_at: "2026-11-01T12:00:00.000Z",
    risk_score: 5,
    verification_checks: {},
    ip_address: "203.0.113.10",
    metadata: {
      order: JSON.stringify({ l: [[111, 1, 4900]], c: "USD", t: 4900, sc: "USD", st: 4900, d: 0, nm: ["Rain Drum"] }),
      attrs: JSON.stringify(attrs),
      ship: JSON.stringify({
        v: 2, email: "buyer@example.com", phone: "+12133734253", marketing: false,
        s: { first_name: "A", last_name: "B", address1: "1 Main", city: "Austin", province: "TX", zip: "78701", country_code: "US" },
      }),
      j: "abc123",
    },
  };
}

function json(body, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}
