// Dry run: build a Pinterest checkout payload from a sample Whop order and check hashing.
// Does not call Pinterest.   node scripts/pinterest-payload.js
import { readFileSync } from "node:fs";
import { buildPinterestCheckout, hashEmail, hashPhone, hasPinterestSignal, sendPinterestCheckout } from "../lib/pinterest.js";
import { orderAttributes } from "../lib/pricing.js";

let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error("FAIL", name); }
  else console.log("ok", name);
};

delete process.env.PINTEREST_CAPI_TOKEN;
delete process.env.PINTEREST_AD_ACCOUNT_ID;
delete process.env.CHECKOUT_URL;

check("hash email", hashEmail(" Person@Example.com ") === "542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345");
check("hash phone digits", hashPhone("+1 (415) 555-9317", "US") === hashPhone("14155559317"));
check("invalid phone omitted", hashPhone("12") === "");

const noise = {};
for (let i = 0; i < 30; i++) noise["noise_" + i] = "n".repeat(400);
const kept = orderAttributes({ epik: "from-url" }, { ...noise, _epik: "from-cookie", utm_source: "pinterest" });
check("pinterest keys survive trim", kept.epik === "from-url" && kept._epik === "from-cookie" && kept.utm_source === "pinterest");
check("trim stays within cap", JSON.stringify(kept).length <= 1800);

const theme = readFileSync(new URL("../theme/whop-cart-checkout.liquid", import.meta.url), "utf8");
const trackLine = theme.split("\n").find((l) => l.includes("var TRACK"));
check("theme TRACK", /\^_ttp\$/.test(trackLine) && /\^_\?epik\$/.test(trackLine));

check("no signal", hasPinterestSignal({ utm_source: "snapchat", ScCid: "x" }) === false);
check("epik signal", hasPinterestSignal({ epik: "abc" }) === true);
check("_epik signal", hasPinterestSignal({ _epik: "cookie" }) === true);
check("utm signal", hasPinterestSignal({ utm_source: "Pinterest" }) === true);
check("sub12 signal", hasPinterestSignal({ sub12: "pinterest.com" }) === true);
check("pin is not pinterest", hasPinterestSignal({ utm_source: "pin" }) === false);

const sample = {
  payId: "pay_example123",
  orderName: "#1001",
  attrs: { utm_source: "pinterest", epik: "from-url", _epik: "from-cookie" },
  email: " Person@Example.com ",
  phone: "+1 (415) 555-9317",
  country: "US",
  currency: "usd",
  totalCents: 7995,
  lines: [[123456789, 1, 8995]],
  ip: "172.59.8.172",
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
  paidAt: "2026-10-28T16:30:00.000Z",
};
const built = buildPinterestCheckout(sample);
const ev = built.body.data[0];
const json = JSON.stringify(built.body);
check("one event", built.body.data.length === 1 && ev.event_name === "checkout" && ev.action_source === "web");
check("time seconds", ev.event_time === Math.floor(Date.parse("2026-10-28T16:30:00.000Z") / 1000) && ev.event_time < 1e12);
check("event id", ev.event_id === "whop-pay_example123");
check("user arrays", Array.isArray(ev.user_data.em) && ev.user_data.em.length === 1 && Array.isArray(ev.user_data.ph) && ev.user_data.ph[0] === hashPhone("+14155559317"));
check("cookie click id wins", ev.user_data.click_id === "from-cookie");
check("url click id fallback", buildPinterestCheckout({ ...sample, attrs: { epik: "from-url" } }).body.data[0].user_data.click_id === "from-url");
check("ip ua", ev.user_data.client_ip_address === "172.59.8.172" && ev.user_data.client_user_agent.startsWith("Mozilla"));
check("page", ev.event_source_url === "https://checkout.madespecial.store/?return=1");
check("money", ev.custom_data.currency === "USD" && ev.custom_data.value === "79.95" && ev.custom_data.order_id === "#1001");
check("items", ev.custom_data.content_ids[0] === "123456789" && ev.custom_data.num_items === 1);
check("no plaintext", !json.includes("Example.com") && !json.includes("555"));
check("dedupe override", buildPinterestCheckout({ ...sample, dedupeId: "whop-pay_upsell" }).body.data[0].event_id === "whop-pay_upsell");
const gbp = buildPinterestCheckout({ currency: "gbp", totalCents: 6400, lines: [[9, 2, 4000]], payId: "pay_gbp", attrs: { _epik: "c" } });
check("presentment", gbp.body.data[0].custom_data.currency === "GBP" && gbp.body.data[0].custom_data.value === "64.00" && gbp.body.data[0].custom_data.num_items === 2);

let fetched = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetched++; return { ok: true, status: 200, text: async () => "{}" }; };
check("unset token skips", (await sendPinterestCheckout(sample)).skipped === "no_token" && fetched === 0);
process.env.PINTEREST_CAPI_TOKEN = "pin-secret-token";
check("unset account skips", (await sendPinterestCheckout(sample)).skipped === "no_account" && fetched === 0);
check("no signal does not post", (await sendPinterestCheckout({ ...sample, attrs: {} })).skipped === "no_signal" && fetched === 0);

process.env.PINTEREST_AD_ACCOUNT_ID = "549768257474";
const logs = [];
const origErr = console.error;
console.error = (...a) => { logs.push(a.map(String).join(" ")); };
globalThis.fetch = async () => { throw new Error("network down"); };
check("network error does not throw", (await sendPinterestCheckout(sample)).error === "request_failed" && !logs.join(" ").includes("pin-secret-token"));

logs.length = 0;
globalThis.fetch = async (url, opts) => {
  check("endpoint and bearer", url === "https://api.pinterest.com/v5/ad_accounts/549768257474/events" && opts.headers.Authorization === "Bearer pin-secret-token");
  return { ok: true, status: 200, text: async () => JSON.stringify({ num_events_received: 1, num_events_processed: 0, events: [{ status: "failed", error_message: "pin-secret-token bad" }] }) };
};
const denied = await sendPinterestCheckout(sample);
check("failed event is not success", denied.processed === 0 && denied.status === 200);
check("error log redacts token", logs.some((l) => l.includes("[redacted]") && !l.includes("pin-secret-token")));

logs.length = 0;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ num_events_received: 1, num_events_processed: 1, events: [{ status: "processed", error_message: null }] }) });
const ok = await sendPinterestCheckout(sample);
check("processed succeeds", ok.processed === 1 && ok.eventId === "whop-pay_example123" && logs.length === 0);

console.error = origErr;
globalThis.fetch = realFetch;
delete process.env.PINTEREST_CAPI_TOKEN;
delete process.env.PINTEREST_AD_ACCOUNT_ID;

console.log("\n--- sample checkout payload (not sent) ---");
console.log(JSON.stringify(built.body, null, 2));
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
