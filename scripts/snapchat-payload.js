// Dry run: build a Snapchat PURCHASE payload from a sample Whop order and check hashing.
// Does not call Snapchat.   node scripts/snapchat-payload.js
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildSnapPurchase, deviceModelFromUa, hashCity, hashCountry, hashEmail, hashExternalId, hashPhone, hashState, hashZip, hasSnapSignal, osVersionFromUa, phoneDigits, sendSnapPurchase, snapClickId } from "../lib/snapchat.js";
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
const JOHN = "96d9632f363564cc3032521409cf22a852f2032eec099ed5967c0d000cec607a";
const ANDREWS = "90aa2608758d2bc747d65079720aba7eef76ccb1b48166a3605908939aa835cd";
const CITY = "350c754ba4d38897693aa077ef43072a859d23f613443133fecbbd90a3512ca5";
const STATE = "6959097001d10501ac7d54c0bdb8db61420f658f2922cc26e46d536119a31126";
const ZIP = "1794327a4d443904421f5ca1f3d72d0a62ba2f0770d80755ec2220fc0efb052e";
const COUNTRY = "79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621";

check("hash email vector", hashEmail(" Person@Example.com ") === EMAIL);
check("phone digits vector", phoneDigits("+44 844 412 4653") === "448444124653");
check("hash phone vector", hashPhone("+44 844 412 4653") === PHONE);
check("us phone digits", phoneDigits("+1 (415) 555-9317", "US") === "14155559317");
check("invalid phone omitted", hashPhone("123") === "");

const noise = {};
for (let i = 0; i < 30; i++) noise["noise_" + i] = "n".repeat(400);
const kept = orderAttributes(
  { ScCid: "click-12345678" },
  { ...noise, _scid: "cookie-12345678", sc_click_id: "snake-click-id", sub12: "snapchat", client_user_agent: "Mozilla/5.0", os_version: "17.5.1" },
);
check("snap keys survive trim", kept.ScCid === "click-12345678" && kept._scid === "cookie-12345678" && kept.sc_click_id === "snake-click-id" && kept.sub12 === "snapchat" && kept.client_user_agent === "Mozilla/5.0" && kept.os_version === "17.5.1");
check("trim stays within cap", JSON.stringify(kept).length <= 1800);

const theme = readFileSync(new URL("../theme/whop-cart-checkout.liquid", import.meta.url), "utf8");
const trackLine = theme.split("\n").find((l) => l.includes("var TRACK"));
check("theme TRACK", /\^_ttp\$/.test(trackLine) && /\^sccid\$/.test(trackLine) && /\^sc_click_id\$/.test(trackLine) && /\^_scclid\$/.test(trackLine) && /\^_scid\$/.test(trackLine) && /\^os_version\$/.test(trackLine) && /\^_\?epik\$/.test(trackLine));
const clickJs = readFileSync(new URL("../theme/snap-click.js", import.meta.url), "utf8");
const head = readFileSync(new URL("../theme/snap-click-id.liquid", import.meta.url), "utf8");
const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
check("head snippet is the lander script", head.includes(clickJs.trim()));
check("click id kept 28 days", clickJs.includes("var DAYS = 28") && clickJs.includes("DAYS * 864e5") && clickJs.includes('persist("ScCid"') && /cookie1 !== click/.test(clickJs));
check("checkout pixel dedupes with capi", page.includes("client_dedup_id: id") && page.includes("var id = 'whop-' + paymentId") && page.includes("START_CHECKOUT") && page.includes("https://sc-static.net/scevent.min.js"));
check("theme does not print the capi token", !theme.includes("SNAP_CAPI_TOKEN") && !page.includes("SNAP_CAPI_TOKEN") && !clickJs.includes("SNAP_CAPI_TOKEN"));

check("no signal", hasSnapSignal({ utm_source: "google", epik: "x" }) === false);
check("ScCid signal", hasSnapSignal({ ScCid: "7b3a7917-a82a-47e8-9728-e1b3b045abb2" }) === true);
check("sc_click_id signal", hasSnapSignal({ sc_click_id: "7b3a7917-a82a-47e8-9728-e1b3b045abb2" }) === true);
check("_scid signal", hasSnapSignal({ _scid: "cookie-12345678" }) === true);
check("empty click is not a signal", hasSnapSignal({ ScCid: " " }) === false);
check("short click is not a signal", hasSnapSignal({ ScCid: "abc" }) === false);
check("macro is not a signal", hasSnapSignal({ ScCid: "{sub8}" }) === false);
check("os version alone is not a signal", hasSnapSignal({ os_version: "17.5", client_user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)" }) === false);
check("utm signal", hasSnapSignal({ utm_source: "Snapchat" }) === true);
check("sub12 signal", hasSnapSignal({ sub12: "snapchat.com" }) === true);
check("exact snap", hasSnapSignal({ utm_source: "snap" }) === true);
check("snapshot is not snapchat", hasSnapSignal({ utm_source: "snapshot" }) === false);
check("click id priority", snapClickId({ _scclid: "cookie-click-id", ScCid: "url-click-id-1", sc_click_id: "explicit-click-1" }) === "explicit-click-1");

check("hash name vectors", hashExternalId(" Person@Example.com ") === EMAIL);
check("hash address vectors", hashCity("New York") === CITY && hashState("CA", "US") === STATE && hashZip("94035", "US") === ZIP && hashCountry("US") === COUNTRY);
check("uk postcode sector", hashZip("SW1A 1AA", "GB") === hashZip("sw1a 1", "GB") && hashZip("SW1A 1AA", "GB") !== hashZip("SW1A 1AA", "US"));

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
check("ios version", osVersionFromUa(IPHONE) === "17.5" && osVersionFromUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X)") === "17.5.1");
check("ipad version", osVersionFromUa("Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X)") === "16.6" && deviceModelFromUa("Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X)") === "iPad");
check("android version", osVersionFromUa(ANDROID) === "14" && deviceModelFromUa(ANDROID) === "Pixel8");
check("desktop version", osVersionFromUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36") === "10.0" && osVersionFromUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15") === "10.15.7");
check("snap android model", deviceModelFromUa("Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36") === "SM-S918B");

const sample = {
  payId: "pay_example123",
  orderName: "#1001",
  attrs: { utm_source: "snapchat", ScCid: "7b3a7917-a82a-47e8-9728-e1b3b045abb2", _scid: "scid-cookie" },
  email: " Person@Example.com ",
  phone: "+44 844 412 4653",
  firstName: "John",
  lastName: "Andrews",
  city: "New York",
  state: "CA",
  zip: "94035",
  country: "US",
  externalId: " Person@Example.com ",
  currency: "usd",
  totalCents: 7995,
  lines: [[123456789, 1, 8995], [222, 2, 1000]],
  ip: "172.59.8.172",
  ua: IPHONE,
  paidAt: "2026-10-28T16:30:00.000Z",
};
const built = buildSnapPurchase(sample);
const ev = built.body.data[0];
const json = JSON.stringify(built.body);
check("one event", built.body.data.length === 1 && ev.event_name === "PURCHASE" && ev.action_source === "WEB");
check("time ms", ev.event_time === Date.parse("2026-10-28T16:30:00.000Z") && ev.event_time > 1e12);
check("event id", ev.event_id === "whop-pay_example123");
check("user", ev.user_data.em === EMAIL && ev.user_data.ph === PHONE && ev.user_data.external_id === EMAIL && ev.user_data.sc_click_id === sample.attrs.ScCid && ev.user_data.sc_cookie1 === "scid-cookie");
check("address", ev.user_data.fn === JOHN && ev.user_data.ln === ANDREWS && ev.user_data.ct === CITY && ev.user_data.st === STATE && ev.user_data.zp === ZIP && ev.user_data.country === COUNTRY);
check("ip ua", ev.user_data.client_ip_address === "172.59.8.172" && ev.user_data.client_user_agent.startsWith("Mozilla"));
check("os", ev.user_data.os_version === "17.5" && ev.user_data.device_model === "iPhone" && ev.custom_data.os_version === "17.5" && ev.custom_data.device_model === "iPhone");
check("page", ev.event_source_url === "https://checkout.madespecial.store/?return=1&ScCid=7b3a7917-a82a-47e8-9728-e1b3b045abb2");
check("money", ev.custom_data.currency === "USD" && ev.custom_data.value === 79.95 && ev.custom_data.order_id === "#1001");
check("items", ev.custom_data.content_ids.join() === "123456789,222" && ev.custom_data.num_items === "3");
check("no plaintext", !json.includes("Example.com") && !json.includes("844") && !json.includes("412") && !json.includes("John") && !json.includes("Andrews") && !json.includes("New York") && !json.includes("94035"));
check("explicit os wins", buildSnapPurchase({ ...sample, osVersion: "15.6.1", deviceModel: "Pixel 8" }).body.data[0].user_data.os_version === "15.6.1" && buildSnapPurchase({ ...sample, osVersion: "15.6.1", deviceModel: "Pixel 8" }).body.data[0].user_data.device_model === "Pixel8");
const fromAttrs = buildSnapPurchase({ ...sample, ua: "", ip: "", osVersion: "", attrs: { ...sample.attrs, client_user_agent: IPHONE, client_ip_address: "172.59.8.172" } });
check("ua ip from order attrs", fromAttrs.body.data[0].user_data.client_user_agent === IPHONE && fromAttrs.body.data[0].user_data.client_ip_address === "172.59.8.172" && fromAttrs.body.data[0].user_data.os_version === "17.5");
check("snake click id", buildSnapPurchase({ ...sample, attrs: { sc_click_id: "snake-click-id-9" } }).body.data[0].user_data.sc_click_id === "snake-click-id-9");
check("dedupe override", buildSnapPurchase({ ...sample, dedupeId: "whop-pay_upsell" }).body.data[0].event_id === "whop-pay_upsell");
check("private ip dropped", buildSnapPurchase({ ...sample, ip: "10.0.0.8" }).body.data[0].user_data.client_ip_address === undefined);
const gbp = buildSnapPurchase({ currency: "gbp", totalCents: 6400, lines: [[9, 2, 4000]], payId: "pay_gbp", attrs: { _scid: "c" } });
check("presentment", gbp.body.data[0].custom_data.currency === "GBP" && gbp.body.data[0].custom_data.value === 64);

function runClickScript(start) {
  let cookieStr = start.cookie || "";
  const local = new Map(Object.entries(start.local || {}));
  const boxed = (start.links || []).map((href) => {
    const box = { href };
    return {
      tagName: "A",
      get href() { return box.href; },
      set href(v) { box.href = v; },
      getAttribute: (k) => (k === "href" ? box.href : null),
      setAttribute: (k, v) => { if (k === "href") box.href = v; },
      box,
    };
  });
  const replaced = [];
  const document = {
    get cookie() { return cookieStr; },
    set cookie(v) {
      const part = String(v).split(";")[0];
      const i = part.indexOf("=");
      const name = part.slice(0, i);
      const bits = cookieStr.split(";").map((s) => s.trim()).filter((s) => s && s.slice(0, s.indexOf("=")) !== name);
      bits.push(part);
      cookieStr = bits.join("; ");
    },
    getElementsByTagName: () => boxed,
    addEventListener: () => {},
    readyState: "complete",
    referrer: start.referrer || "",
  };
  const location = new URL(start.href);
  const context = {
    URL, document, location, history: { replaceState: (_a, _b, next) => replaced.push(next) },
    localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) },
    console, decodeURIComponent, encodeURIComponent, Date, Number, String, RegExp,
  };
  vm.createContext(context);
  vm.runInContext(clickJs, context);
  return { cookie: cookieStr, local, links: boxed.map((a) => a.box.href), replaced };
}
const CLICK = "7b3a7917-a82a-47e8-9728-e1b3b045abb2";
const landed = runClickScript({
  href: `https://lp.lovethenew.me/lp1?ScCid=${CLICK}`,
  links: ["https://madespecial.store/products/rain-drum", "https://example.com/other"],
});
check("lander stores click id", landed.cookie.includes("ScCid=" + encodeURIComponent(CLICK)) && landed.local.get("ScCid") === CLICK && !/(?:^|; )_scid=/.test(landed.cookie));
check("lander decorates store links only", landed.links[0].includes("ScCid=" + CLICK) && !landed.links[1].includes("ScCid"));
const restored = runClickScript({
  href: "https://madespecial.store/products/rain-drum",
  cookie: "ScCid=" + CLICK + "; _scid=scid-cookie-1",
});
check("store puts click id back on the url", restored.replaced.some((u) => String(u).includes("ScCid=" + CLICK)) && !restored.replaced.some((u) => String(u).includes("_scid=")));

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
