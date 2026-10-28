// Dry run: build a Snapchat PURCHASE payload from a sample Whop order and check hashing.
// Does not call Snapchat.   node scripts/snapchat-payload.js
import { readFileSync } from "node:fs";
import { buildSnapPurchase, hashEmail, hashPhone, hasSnapSignal, phoneDigits, sendSnapPurchase } from "../lib/snapchat.js";
import { orderAttributes } from "../lib/pricing.js";

let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error("FAIL", name); }
  else console.log("ok", name);
};

delete process.env.SNAP_PIXEL_ID;
delete process.env.SNAP_CAPI_TOKEN;
delete process.env.CHECKOUT_URL;

const EMAIL = "542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345";
const PHONE = "dc008fda46e2e64002cf2f82a4906236282d431c4f75e5b60bfe79fc48546383";

check("hash email vector", hashEmail(" Person@Example.com ") === EMAIL);
check("phone digits vector", phoneDigits("+44 844 412 4653") === "448444124653");
check("hash phone vector", hashPhone("+44 844 412 4653") === PHONE);
check("us phone digits", phoneDigits("+1 (415) 555-9317", "US") === "14155559317");
check("invalid phone omitted", hashPhone("123") === "");

const noise = {};
for (let i = 0; i < 30; i++) noise["noise_" + i] = "n".repeat(400);
const kept = orderAttributes({ ScCid: "click-1" }, { ...noise, _scid: "cookie-1", sub12: "snapchat" });
check("snap keys survive trim", kept.ScCid === "click-1" && kept._scid === "cookie-1" && kept.sub12 === "snapchat");
check("trim stays within cap", JSON.stringify(kept).length <= 1800);

const theme = readFileSync(new URL("../theme/whop-cart-checkout.liquid", import.meta.url), "utf8");
const trackLine = theme.split("\n").find((l) => l.includes("var TRACK"));
check("theme TRACK", /\^_ttp\$/.test(trackLine) && /\^sccid\$/.test(trackLine) && /\^_scid\$/.test(trackLine) && /\^_\?epik\$/.test(trackLine));

check("no signal", hasSnapSignal({ utm_source: "google", epik: "x" }) === false);
check("ScCid signal", hasSnapSignal({ ScCid: "abc" }) === true);
check("_scid signal", hasSnapSignal({ _scid: "cookie" }) === true);
check("empty click is not a signal", hasSnapSignal({ ScCid: " " }) === false);
check("utm signal", hasSnapSignal({ utm_source: "Snapchat" }) === true);
check("sub12 signal", hasSnapSignal({ sub12: "snapchat.com" }) === true);
check("exact snap", hasSnapSignal({ utm_source: "snap" }) === true);
check("snapshot is not snapchat", hasSnapSignal({ utm_source: "snapshot" }) === false);

const sample = {
  payId: "pay_example123",
  orderName: "#1001",
  attrs: { utm_source: "snapchat", ScCid: "7b3a7917-a82a-47e8-9728-e1b3b045abb2", _scid: "scid-cookie" },
  email: " Person@Example.com ",
  phone: "+44 844 412 4653",
  country: "GB",
  currency: "usd",
  totalCents: 7995,
  lines: [[123456789, 1, 8995], [222, 2, 1000]],
  ip: "172.59.8.172",
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
  paidAt: "2026-10-28T16:30:00.000Z",
};
const built = buildSnapPurchase(sample);
const ev = built.body.data[0];
const json = JSON.stringify(built.body);
check("one event", built.body.data.length === 1 && ev.event_name === "PURCHASE" && ev.action_source === "WEB");
check("time ms", ev.event_time === Date.parse("2026-10-28T16:30:00.000Z") && ev.event_time > 1e12);
check("event id", ev.event_id === "whop-pay_example123");
check("user", ev.user_data.em === EMAIL && ev.user_data.ph === PHONE && ev.user_data.sc_click_id === sample.attrs.ScCid && ev.user_data.sc_cookie1 === "scid-cookie");
check("ip ua", ev.user_data.client_ip_address === "172.59.8.172" && ev.user_data.client_user_agent.startsWith("Mozilla"));
check("page", ev.event_source_url === "https://checkout.madespecial.store/?return=1");
check("money", ev.custom_data.currency === "USD" && ev.custom_data.value === 79.95 && ev.custom_data.order_id === "#1001");
check("items", ev.custom_data.content_ids.join() === "123456789,222" && ev.custom_data.num_items === "3");
check("no plaintext", !json.includes("Example.com") && !json.includes("844") && !json.includes("412"));
check("dedupe override", buildSnapPurchase({ ...sample, dedupeId: "whop-pay_upsell" }).body.data[0].event_id === "whop-pay_upsell");
check("private ip dropped", buildSnapPurchase({ ...sample, ip: "10.0.0.8" }).body.data[0].user_data.client_ip_address === undefined);
const gbp = buildSnapPurchase({ currency: "gbp", totalCents: 6400, lines: [[9, 2, 4000]], payId: "pay_gbp", attrs: { _scid: "c" } });
check("presentment", gbp.body.data[0].custom_data.currency === "GBP" && gbp.body.data[0].custom_data.value === 64);

let fetched = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetched++; return { ok: true, status: 200, text: async () => "{}" }; };
const skipped = await sendSnapPurchase(sample);
check("unset token skips", skipped.skipped === "no_token" && fetched === 0);
check("no signal does not post", (await sendSnapPurchase({ ...sample, attrs: { utm_source: "google" } })).skipped === "no_signal" && fetched === 0);

process.env.SNAP_CAPI_TOKEN = "snap-secret-token";
const logs = [];
const origErr = console.error;
console.error = (...a) => { logs.push(a.map(String).join(" ")); };
globalThis.fetch = async () => { throw new Error("network down"); };
check("network error does not throw", (await sendSnapPurchase(sample)).error === "request_failed" && !logs.join(" ").includes("snap-secret-token"));

logs.length = 0;
globalThis.fetch = async (url, opts) => {
  const u = new URL(url);
  check("endpoint and token query", u.origin + u.pathname === "https://tr.snapchat.com/v3/72a34e54-4d52-4807-ad88-c1c97e4c40f1/events" && u.searchParams.get("access_token") === "snap-secret-token" && opts.headers.Authorization === undefined);
  return { ok: true, status: 200, text: async () => JSON.stringify({ status: "INVALID", reason: "snap-secret-token bad" }) };
};
const denied = await sendSnapPurchase(sample);
check("invalid status is not success", denied.snapStatus === "INVALID" && denied.status === 200);
check("error log redacts token", logs.some((l) => l.includes("INVALID") && l.includes("[redacted]") && !l.includes("snap-secret-token")));

logs.length = 0;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "VALID", reason: "Events have been processed successfully." }) });
const ok = await sendSnapPurchase(sample);
check("VALID succeeds", ok.snapStatus === "VALID" && ok.eventId === "whop-pay_example123" && logs.length === 0);

console.error = origErr;
globalThis.fetch = realFetch;
delete process.env.SNAP_CAPI_TOKEN;

console.log("\n--- TRACK line (paste into the live theme) ---");
console.log(trackLine.trim());
console.log("\n--- sample PURCHASE payload (not sent) ---");
console.log(JSON.stringify(built.body, null, 2));
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
