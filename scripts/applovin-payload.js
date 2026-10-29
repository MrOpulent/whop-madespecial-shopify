// Dry run: build an AppLovin purchase payload from a sample Whop order and check hashing.
// Does not call AppLovin.   node scripts/applovin-payload.js
import { buildAxonPurchase, clientContext, hashEmail, hashPhone, hashPhoneLast10, hasApplovinSignal, sendAxonPurchase } from "../lib/applovin.js";
import { orderAttributes } from "../lib/pricing.js";

let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error("FAIL", name); }
  else console.log("ok", name);
};

check("hash alice", hashEmail("Alice@Example.COM") === "ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976");
check("hash gmail", hashEmail("  J..A.NE+work.more+extra@GMAIL.COM  ") === "988b074286b20c503e3015c2076533f3bf4ce5ca6f8a507ab52c2e0f98d620b7");
check("hash googlemail", hashEmail("Jane.Doe+Work@GoogleMail.com") === "338abf9ef1c8793cadc7bcf51ed595338eb727ed9e06ce3d91d566d60b975937");
check("hash bad email", hashEmail("not-an-email") === "");
check("hash phone last10", hashPhoneLast10("+1 (415) 555-9317") === "bc633bcb99fe8415d14840249611c33c26f2b3236061399774c71a80650e63c1");
check("hash phone e164 matches formatted", hashPhone("+14155559317") === hashPhone("+1 (415) 555-9317"));
check("hash phone last10 e164", hashPhoneLast10("+14155559317") === hashPhoneLast10("+1 (415) 555-9317"));
check("phone and last10 differ", hashPhone("+14155559317") !== hashPhoneLast10("+14155559317"));
check("letter phone omits last10", hashPhoneLast10("1-800-FLOWERS") === "");

const noise = {};
for (let i = 0; i < 30; i++) noise["noise_" + i] = "n".repeat(400);
const kept = orderAttributes(
  { _axon_event_id: "evt-1", longnote: "x".repeat(500) },
  { ...noise, aleid: "from-query", alart: "from-query-art", _axeid: "from-cookie", _axart: "from-cookie-art", _axwrt: "visitor", utm_source: "applovin" },
);
check("axon keys survive trim", kept._axon_event_id === "evt-1" && kept._axeid === "from-cookie" && kept._axwrt === "visitor" && kept.aleid === "from-query" && kept.utm_source === "applovin");
check("trim stays within cap", JSON.stringify(kept).length <= 1800 && Object.keys(kept).filter((k) => k.startsWith("noise_")).length < 30);

check("no signal", hasApplovinSignal({ utm_source: "google", _fbp: "fb.1" }) === false);
check("utm signal", hasApplovinSignal({ utm_source: "AppLovin" }) === true);
check("cookie signal", hasApplovinSignal({ _axwrt: "abc" }) === true);
check("empty axon is not a signal", hasApplovinSignal({ _axon_event_id: "" }) === false);

check("public ip skips private", clientContext({ headers: { "x-forwarded-for": "127.0.0.1, 172.59.8.172", "user-agent": "Test/1.0" } }).ip === "172.59.8.172");
check("drops rfc1918", clientContext({ headers: { "x-real-ip": "10.1.2.3", "user-agent": "Test/1.0" } }).ip === null);
check("ua sliced", clientContext({ headers: { "user-agent": "U".repeat(500) } }).ua.length === 300);

const sample = {
  payId: "pay_example123",
  orderName: "#1001",
  attrs: {
    utm_source: "applovin",
    utm_campaign: "drums",
    _axon_event_id: "axon-evt-9f3a",
    aleid: "from-query",
    _axeid: "from-cookie",
    _axart: "from-cookie-art",
    _axwrt: "axwrt-visitor",
  },
  email: "  J..A.NE+work.more+extra@GMAIL.COM  ",
  phone: "+1 (415) 555-9317",
  country: "US",
  zip: "94107-1234",
  currency: "USD",
  totalCents: 7995,
  lines: [[123456789, 1, 8995]],
  ip: "172.59.8.172",
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
  paidAt: "2026-10-28T16:30:00.000Z",
};
const built = buildAxonPurchase(sample);
const ev = built.body.events[0];
const json = JSON.stringify(built.body);
check("one event", built.body.events.length === 1 && ev.name === "purchase");
check("time", ev.event_time === Date.parse("2026-10-28T16:30:00.000Z"));
check("source", ev.event_source_url === "https://checkout.madespecial.store/?return=1");
check("dedupe axon id", ev.dedupe_id === "axon-evt-9f3a");
check("charged value", ev.data.currency === "USD" && ev.data.value === 79.95 && ev.data.shipping === 0 && ev.data.tax === 0);
check("transaction", ev.data.transaction_id === "#1001");
check("discounted unit", ev.data.items[0].price === 79.95 && ev.data.items[0].discount === 10 && ev.data.items[0].quantity === 1 && ev.data.items[0].item_variant_id === "123456789");
check("user ids from cookies", ev.user_data.aleid === "from-cookie" && ev.user_data.alart === "from-cookie-art" && ev.user_data.axwrt === "axwrt-visitor" && ev.user_data.esi === "web");
check("hashed email", ev.user_data.email === "988b074286b20c503e3015c2076533f3bf4ce5ca6f8a507ab52c2e0f98d620b7");
check("hashed phone", ev.user_data.phone === hashPhone("+1 (415) 555-9317") && ev.user_data.phone_last10_hashed === "bc633bcb99fe8415d14840249611c33c26f2b3236061399774c71a80650e63c1");
check("zip country", ev.user_data.zip === "94107" && ev.user_data.country_code === "US" && ev.user_data.client_ip_address === "172.59.8.172");
check("no plaintext", !json.includes("@") && !json.includes("555-9317") && !json.includes("GMAIL"));

const fallback = buildAxonPurchase({ ...sample, attrs: { utm_source: "applovin" } });
check("dedupe falls back to payment", fallback.body.events[0].dedupe_id === "whop-pay_example123");
const upsell = buildAxonPurchase({ ...sample, dedupeId: "whop-pay_upsell" });
check("explicit dedupe wins", upsell.body.events[0].dedupe_id === "whop-pay_upsell");

const gbp = buildAxonPurchase({ currency: "gbp", totalCents: 6400, lines: [[9, 2, 4000]], payId: "pay_gbp", orderName: "#1002", attrs: { aleid: "a" } });
check("presentment currency", gbp.body.events[0].data.currency === "GBP" && gbp.body.events[0].data.value === 64 && gbp.body.events[0].data.items[0].price === 32);

delete process.env.APPLOVIN_CAPI_KEY;
const skipped = await sendAxonPurchase({ payId: "pay_example123", currency: "USD", totalCents: 100, lines: [[1, 1, 100]] });
check("unset key skips", skipped.skipped === "no_key");

process.env.APPLOVIN_CAPI_KEY = "test-key";
const realFetch = globalThis.fetch;
const purchase = { payId: "pay_example123", currency: "USD", totalCents: 100, lines: [[1, 1, 100]], orderName: "#1", email: "a@b.co" };
globalThis.fetch = async () => { throw new Error("network down"); };
const down = await sendAxonPurchase(purchase);
check("network error does not throw", down.error === "request_failed");
globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
const denied = await sendAxonPurchase(purchase);
check("http error does not throw", denied.status === 401);
globalThis.fetch = realFetch;
delete process.env.APPLOVIN_CAPI_KEY;

console.log("\n--- sample purchase payload (not sent) ---");
console.log(JSON.stringify(built.body, null, 2));
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
