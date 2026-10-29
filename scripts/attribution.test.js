import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orderAttributes, protectedAttr } from "../lib/pricing.js";
import { checkoutReturnUrl, minimalReturnUrl, returnUrlTooLong } from "../lib/return-url.js";
import { httpUrl, orderWebFields, stripRejectedWebFields } from "../lib/attribution.js";
import { decideClaim, finishClaim, parseClaims, releaseClaim } from "../lib/order-lock.js";
import { adsFor, clickIdFrom, isTestPayment, postInitiateCheckouts, purchaseEventId, redtrackResultLine, refundShopSum } from "../lib/ads.js";

test("trimming never drops network click ids, landing, or the test flag", () => {
  const logs = [];
  const orig = console.error;
  console.error = (line) => logs.push(String(line));
  try {
    const tracking = {
      __clickid: "rt-click",
      ttclid: "tt-1",
      _ttp: "ttp-1",
      ScCid: "snap-1",
      _scid: "scid-1",
      sc_click_id: "snap-click",
      epik: "pin-1",
      _fbp: "fb.1.1",
      _fbc: "fb.1.2",
      aleid: "ax-1",
      alart: "ax-art",
      axwrt: "ax-wrt",
      _ax_test: "ax-extra",
      tw_source: "meta",
      tw_campaign: "camp",
      tw_adsetid: "adset",
      tw_adid: "ad",
      cmpid: "cmp-1",
      ref_id: "ref-1",
      utm_source: "facebook",
      utm_campaign: "spring",
      sub1: "s1",
      landing_site: "https://madespecial.store/products/drum?utm_source=facebook",
      referring_site: "https://instagram.com/p/1",
      test_order: "1",
      junk: "x".repeat(300),
      note: "y".repeat(300),
      blob0: "a".repeat(300),
      blob1: "b".repeat(300),
      blob2: "c".repeat(300),
      blob3: "d".repeat(300),
    };
    const out = orderAttributes({}, tracking);
    for (const k of Object.keys(tracking)) {
      if (/^(junk|note|blob)/.test(k)) continue;
      assert.equal(out[k], tracking[k], k);
      assert.equal(protectedAttr(k), true, k);
    }
    assert.equal(out.__clickid, "rt-click");
    assert.match(logs.join("\n"), /order_attrs_trimmed dropped=/);
    const dropped = logs.join("\n").match(/dropped=([^\s]+)/)[1].split(",");
    for (const k of dropped) assert.equal(protectedAttr(k), false, k);
    assert.ok(JSON.stringify(out).length <= 1800);
    assert.doesNotMatch(logs.join("\n"), /rt-click|snap-click|facebook/);
  } finally {
    console.error = orig;
  }
});

test("a snap click id is not used as the RedTrack click", () => {
  const out = orderAttributes({}, { sc_click_id: "snap-only", __clickid: "rt-1" });
  assert.equal(out.__clickid, "rt-1");
  assert.equal(out.sc_click_id, "snap-only");
  assert.equal(clickIdFrom(out), "rt-1");
  assert.equal(clickIdFrom({ sc_click_id: "snap-only" }), "");
});

test("tw and cmpid from the cart are kept when the tracking bag is empty", () => {
  const cart = { tw_source: "tiktok", cmpid: "99" };
  for (let i = 0; i < 6; i++) cart[`blob${i}`] = "z".repeat(400);
  const out = orderAttributes(cart, {});
  assert.equal(out.tw_source, "tiktok");
  assert.equal(out.cmpid, "99");
  assert.equal(out.blob0, undefined);
});

test("return url is the short journey form and the retry drops the journey", () => {
  const url = checkoutReturnUrl("https://checkout.madespecial.store/", { journey: "ab12ef" });
  assert.equal(url, "https://checkout.madespecial.store/?return=1&j=ab12ef");
  assert.equal(minimalReturnUrl(url), "https://checkout.madespecial.store/?return=1");
  assert.equal(minimalReturnUrl(minimalReturnUrl(url)), minimalReturnUrl(url));
  const upsell = checkoutReturnUrl("https://checkout.madespecial.store", { journey: "ab", upsell: true });
  assert.equal(minimalReturnUrl(upsell), "https://checkout.madespecial.store/?return=1&upsell=1");
  assert.equal(returnUrlTooLong({ error: { message: "return_url is too long" } }), true);
  assert.equal(returnUrlTooLong({ error: { message: "card declined" } }), false);
});

test("web fields use a landing url and referrer, and a rejected source is removed", () => {
  const fields = orderWebFields({
    landing_page: "https://madespecial.store/pages/offer?utm_source=meta",
    referrer: "https://m.facebook.com/",
  });
  assert.equal(fields.sourceName, "web");
  assert.equal(fields.sourceUrl, "https://madespecial.store/pages/offer?utm_source=meta");
  assert.equal(fields.referringSite, "https://m.facebook.com/");
  assert.equal(httpUrl("javascript:alert(1)"), "");
  const order = { ...fields, test: true };
  assert.equal(stripRejectedWebFields(order, [{ field: ["sourceName"], message: "Invalid attribution handle" }]), true);
  assert.equal(order.sourceName, undefined);
  assert.equal(order.sourceUrl.includes("utm_source"), true);
  assert.equal(stripRejectedWebFields(order, [{ field: "test", message: "is invalid" }]), true);
  assert.equal(order.test, undefined);
});

test("payment lock: one winner, a waiter, then the order name blocks a second create", () => {
  const now = 1_000_000;
  let map = parseClaims("{}");
  const a = decideClaim(map, "pay_aaa", now, "tok-a");
  assert.equal(a.action, "claim");
  map = a.map;
  const b = decideClaim(map, "pay_aaa", now + 10, "tok-b");
  assert.equal(b.action, "wait");
  map = finishClaim(map, "pay_aaa", "#1042", now + 20);
  const c = decideClaim(map, "pay_aaa", now + 30, "tok-c");
  assert.deepEqual(c, { action: "duplicate", order: "#1042" });
  const released = releaseClaim(map, "pay_aaa", "tok-a", now + 40);
  assert.equal(released.pay_aaa.order, "#1042");
});

test("a stale claim can be taken over and a finished claim is not released", () => {
  const now = 5_000_000;
  const pending = { pay_bbb: { token: "old", at: now - 120_000 } };
  const next = decideClaim(pending, "pay_bbb", now, "new");
  assert.equal(next.action, "claim");
  assert.equal(next.map.pay_bbb.token, "new");
});

test("test payments skip the purchase, and refunds reuse the purchase event id", () => {
  assert.equal(isTestPayment({ metadata: { test_order: "1" } }, {}), true);
  assert.equal(isTestPayment({ livemode: false }, {}), true);
  assert.equal(isTestPayment({ mode: "sandbox" }, {}), true);
  assert.equal(isTestPayment({}, { test: "true" }), true);
  assert.equal(isTestPayment({ metadata: { test: "0" } }, { utm_source: "test-campaign" }), false);
  assert.equal(purchaseEventId({ journey: "abc", paymentId: "pay_1" }), "abc");
  assert.equal(purchaseEventId({ journey: "abc", paymentId: "pay_9", upsell: true }), "upsell-pay_9");
  const sum = refundShopSum({
    totalReceivedSet: {
      presentmentMoney: { amount: "80.00", currencyCode: "GBP" },
      shopMoney: { amount: "100.00", currencyCode: "USD" },
    },
  }, 4000);
  assert.equal(sum.currency, "USD");
  assert.equal(sum.sum, -50);
  assert.equal(redtrackResultLine("ok", 200, "Refund", "#1042", "abc"), "redtrack_postback ok 200 Refund #1042 abc");
});

const session = (attrs, marketing = 1) => ({ j: "abc", cur: "USD", tot: 2500, cs: { m: marketing }, attrs, order: { sc: "USD", st: 2500, l: [] } });

test("a test session turns browser tracking off and a real order leaves it on", () => {
  for (const attrs of [{ test_order: "1" }, { test_order: "true" }, { test_order: "yes" }, { test: "1" }, { _test: "TRUE" }]) {
    const ads = adsFor(session(attrs));
    assert.equal(ads.track, false, JSON.stringify(attrs));
    assert.equal(ads.test, true, JSON.stringify(attrs));
  }
  const real = adsFor(session({ utm_source: "meta", test_order: "0" }));
  assert.equal(real.track, true);
  assert.equal(real.test, false);
  const quiet = adsFor(session({}, 0));
  assert.equal(quiet.track, false);
  assert.equal(quiet.test, false);
});

test("InitiateCheckout is skipped once for a test cart and both spellings still send for a real cart", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  const logs = [];
  const origLog = console.log;
  globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200 }; };
  console.log = (line) => logs.push(String(line));
  try {
    const skipped = await postInitiateCheckouts({ clickid: "click", journey: "j1", sum: 12.5, currency: "USD", attrs: { test_order: "1" } });
    assert.deepEqual(skipped, { skipped: "test" });
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ["redtrack_skipped_test initiatecheckout"]);
    logs.length = 0;
    const sent = await postInitiateCheckouts({ clickid: "click", journey: "j1", sum: 12.5, currency: "USD", attrs: {} });
    assert.equal(sent.length, 2);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /type=InitiateCheckout/);
    assert.match(calls[0], /eventid=j1%3AInitiateCheckout/);
    assert.match(calls[1], /type=initiatecheckout/);
    assert.match(calls[1], /eventid=j1%3Ainitiatecheckout/);
    assert.equal(logs.some((l) => l.startsWith("redtrack_skipped_test")), false);
  } finally {
    globalThis.fetch = origFetch;
    console.log = origLog;
  }
});

test("the thank-you page does not post Purchase, Upsell, or InitiateCheckout for a test session", () => {
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(page, /ADS\.test && \/\^\(purchase\|upsell\|initiatecheckout\)\$\/i\.test/);
  assert.match(page, /if \(!cfg \|\| cfg\.test\) return/);
});

test("the theme collects the same protected keys the server refuses to trim", () => {
  const theme = readFileSync(new URL("../theme/whop-cart-checkout.liquid", import.meta.url), "utf8");
  const m = theme.match(/var TRACK = (\/.*\/i);/);
  assert.ok(m, "theme TRACK regex");
  const track = new RegExp(m[1].slice(1, -2), "i");
  for (const k of ["__clickid", "ttclid", "_ttp", "ScCid", "_scid", "sc_click_id", "epik", "_fbp", "_fbc", "aleid", "alart", "axwrt", "_axfoo", "tw_source", "tw_campaign", "tw_adsetid", "tw_adid", "cmpid", "ref_id", "utm_source", "sub2", "landing_site", "referring_site"]) {
    assert.equal(track.test(k), true, k);
    assert.equal(protectedAttr(k), true, k);
  }
});
