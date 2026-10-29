// Dry run: build a TikTok Purchase payload from a sample Whop order and check hashing.
// Does not call TikTok.   node scripts/tiktok-payload.js
import { readFileSync } from "node:fs";
import { buildTikTokPurchase, e164, hashEmail, hashExternalId, hashPhone, hasTikTokSignal, PURCHASE_EVENT, sendTikTokPurchase } from "../lib/tiktok.js";
import { orderAttributes } from "../lib/pricing.js";

let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error("FAIL", name); }
  else console.log("ok", name);
};

delete process.env.TIKTOK_PIXEL_CODE;
delete process.env.TIKTOK_EVENTS_TOKEN;
delete process.env.CHECKOUT_URL;

const EMAIL = "848a771458438fc2ec420560d769fb9b9b86851ee338ec56517baabd79d3bb4f";
const PHONE = "9f7ec22d72092cd3c0b58726ed9c2d91b92e51a3f29837508fb2948bb22dd2fd";
const EXT = "80fba0ae1c48e3978e43e4efc365e14e12ea0c830ba8ba5b9a2dafc7e3f2ab8b";

check("hash email vector", hashEmail(" ALICE_abc@gmail.com ") === EMAIL);
check("hash email keeps plus and dots", hashEmail("J..A.NE+work@GMAIL.COM") === hashEmail("j..a.ne+work@gmail.com"));
check("hash bad email", hashEmail("not-an-email") === "");
check("e164 formatted", e164("(+1)2133734253") === "+12133734253");
check("e164 national with country", e164("(415) 555-9317", "US") === "+14155559317");
check("hash phone vector", hashPhone("(+1)2133734253") === PHONE);
check("hash phone matches e164", hashPhone("+1 (213) 373-4253") === PHONE);
check("invalid phone omitted", hashPhone("123") === "");
check("external id vector", hashExternalId("user_123") === EXT);
check("external email lowercased", hashExternalId("  User@Example.com ") === hashEmail("user@example.com"));
check("external id not lowercased", hashExternalId("mber_AbC") === hashExternalId("mber_AbC") && hashExternalId("mber_AbC") !== hashExternalId("mber_abc"));

const noise = {};
for (let i = 0; i < 30; i++) noise["noise_" + i] = "n".repeat(400);
const kept = orderAttributes(
  { ttclid: "click-from-cart", longnote: "x".repeat(500) },
  { ...noise, _ttp: "ttp-cookie", sub12: "tiktok", utm_source: "tiktok" },
);
check("tiktok keys survive trim", kept.ttclid === "click-from-cart" && kept._ttp === "ttp-cookie" && kept.sub12 === "tiktok" && kept.utm_source === "tiktok");
check("trim stays within cap", JSON.stringify(kept).length <= 1800 && Object.keys(kept).filter((k) => k.startsWith("noise_")).length < 30);

const theme = readFileSync(new URL("../theme/whop-cart-checkout.liquid", import.meta.url), "utf8");
const trackLine = theme.split("\n").find((l) => l.includes("var TRACK"));
check("theme TRACK keeps ttclid and _ttp", /ttclid/.test(trackLine) && /\^_ttp\$/.test(trackLine));

check("no signal", hasTikTokSignal({ utm_source: "google", _fbp: "fb.1" }) === false);
check("empty ttclid is not a signal", hasTikTokSignal({ ttclid: "  " }) === false);
check("ttclid signal", hasTikTokSignal({ ttclid: "E.C.P.123" }) === true);
check("TTCLID case", buildTikTokPurchase({ currency: "USD", totalCents: 100, lines: [[1, 1, 100]], payId: "pay_case", attrs: { TTCLID: "AbC", _TTP: "Cookie" } }).body.data[0].user.ttclid === "AbC" && buildTikTokPurchase({ currency: "USD", totalCents: 100, lines: [[1, 1, 100]], payId: "pay_case", attrs: { TTCLID: "AbC", _TTP: "Cookie" } }).body.data[0].user.ttp === "Cookie");
check("_ttclid signal", hasTikTokSignal({ _ttclid: "abc" }) === true);
check("_ttp signal", hasTikTokSignal({ _ttp: "cookie" }) === true);
check("ttp without underscore is not a key signal", hasTikTokSignal({ ttp: "cookie" }) === false);
check("utm signal", hasTikTokSignal({ utm_source: "TikTok" }) === true);
check("utm medium signal", hasTikTokSignal({ utm_medium: "tiktok_ads" }) === true);
check("sub12 signal", hasTikTokSignal({ sub12: "tiktok.com" }) === true);
check("sub12 other network", hasTikTokSignal({ sub12: "facebook" }) === false);
check("campaign mention is not a signal", hasTikTokSignal({ utm_campaign: "tiktok-lookalike" }) === false);

const sample = {
  payId: "pay_example123",
  orderName: "#1001",
  attrs: {
    utm_source: "tiktok",
    utm_campaign: "drums",
    ttclid: "E.C.P.ttclid-example",
    _ttp: "ttp.cookie.example",
    referrer: "https://madespecial.store/products/rain-drum?ttclid=E.C.P.ttclid-example",
  },
  email: " ALICE_abc@gmail.com ",
  phone: "(+1)2133734253",
  country: "US",
  externalId: "user_123",
  currency: "usd",
  totalCents: 7995,
  lines: [[123456789, 1, 8995]],
  names: ["Margaret's Hand-Tuned Rain Drum"],
  ip: "172.59.8.172",
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
  paidAt: "2026-10-28T16:30:00.000Z",
};
const built = buildTikTokPurchase(sample);
const ev = built.body.data[0];
const json = JSON.stringify(built.body);
check("shape", built.body.event_source === "web" && built.body.event_source_id === "DB9H2D3C77U0NJ5DOPB0" && built.body.data.length === 1);
check("event name", ev.event === PURCHASE_EVENT && ev.event === "Purchase");
check("time seconds", ev.event_time === Math.floor(Date.parse("2026-10-28T16:30:00.000Z") / 1000) && Number.isInteger(ev.event_time));
check("event id", ev.event_id === "whop-pay_example123" && built.eventId === ev.event_id);
check("user", ev.user.ttclid === "E.C.P.ttclid-example" && ev.user.ttp === "ttp.cookie.example" && ev.user.email === EMAIL && ev.user.phone === PHONE && ev.user.external_id === EXT);
check("ip ua", ev.user.ip === "172.59.8.172" && ev.user.user_agent.startsWith("Mozilla/5.0"));
check("private ip dropped", buildTikTokPurchase({ ...sample, ip: "10.1.2.3" }).body.data[0].user.ip === undefined);
check("page", ev.page.url === "https://checkout.madespecial.store/?return=1" && ev.page.referrer.startsWith("https://madespecial.store/"));
check("money", ev.properties.currency === "USD" && ev.properties.value === 79.95 && ev.properties.content_type === "product" && ev.properties.order_id === "#1001");
check("contents", ev.properties.contents[0].content_id === "123456789" && ev.properties.contents[0].content_name === "Margaret's Hand-Tuned Rain Drum" && ev.properties.contents[0].quantity === 1 && ev.properties.contents[0].price === 79.95);
check("content ids", ev.properties.content_ids[0] === "123456789" && ev.properties.num_items === 1);
check("no plaintext", !json.includes("ALICE") && !json.includes("gmail.com") && !json.includes("2133734253") && !json.includes("user_123"));

const explicit = buildTikTokPurchase({ ...sample, dedupeId: "whop-pay_upsell" });
check("dedupe override", explicit.body.data[0].event_id === "whop-pay_upsell");

const gbp = buildTikTokPurchase({ currency: "gbp", totalCents: 6400, lines: [[9, 2, 4000]], payId: "pay_gbp", orderName: "#1002", attrs: { _ttp: "t" }, names: ["Drum"] });
check("presentment currency", gbp.body.data[0].properties.currency === "GBP" && gbp.body.data[0].properties.value === 64 && gbp.body.data[0].properties.contents[0].price === 32 && gbp.body.data[0].properties.contents[0].quantity === 2);

const bad = buildTikTokPurchase({ currency: "US", totalCents: 100, lines: [[1, 1, 100]], attrs: { ttclid: "x" } });
check("bad currency skipped", bad.skipped === "bad_money" && !bad.body);

const realFetch = globalThis.fetch;
let fetched = 0;
globalThis.fetch = async () => { fetched++; return { ok: true, status: 200, text: async () => "{}" }; };
const skipped = await sendTikTokPurchase(sample);
check("unset token skips", skipped.skipped === "no_token" && fetched === 0);
const quiet = await sendTikTokPurchase({ ...sample, attrs: { utm_source: "google" } });
check("no signal does not post", quiet.skipped === "no_signal" && fetched === 0);

process.env.TIKTOK_EVENTS_TOKEN = "secret-token-xyz";
const logs = [];
const origErr = console.error;
console.error = (...a) => { logs.push(a.map(String).join(" ")); };
globalThis.fetch = async () => { throw Object.assign(new Error("network down"), { name: "TypeError" }); };
const down = await sendTikTokPurchase(sample);
check("network error does not throw", down.error === "request_failed" && !logs.join(" ").includes("secret-token-xyz"));

logs.length = 0;
globalThis.fetch = async (url, opts) => {
  check("endpoint and token header", url === "https://business-api.tiktok.com/open_api/v1.3/event/track/" && opts.headers["Access-Token"] === "secret-token-xyz" && opts.headers.Authorization === undefined);
  return { ok: true, status: 200, text: async () => JSON.stringify({ code: 40002, message: "secret-token-xyz bad pixel", request_id: "req_1" }) };
};
const denied = await sendTikTokPurchase(sample);
check("nonzero code is not success", denied.code === 40002 && denied.status === 200);
check("error log redacts token", logs.some((l) => l.includes("40002") && l.includes("req_1") && l.includes("[redacted]") && !l.includes("secret-token-xyz")));

logs.length = 0;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, message: "OK", request_id: "req_ok" }) });
const ok = await sendTikTokPurchase(sample);
check("code 0 succeeds", ok.code === 0 && ok.eventId === "whop-pay_example123" && logs.length === 0);

console.error = origErr;
globalThis.fetch = realFetch;
delete process.env.TIKTOK_EVENTS_TOKEN;

console.log("\n--- TRACK line (paste into the live theme) ---");
console.log(trackLine.trim());
console.log("\n--- sample Purchase payload (not sent) ---");
console.log(JSON.stringify(built.body, null, 2));
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
