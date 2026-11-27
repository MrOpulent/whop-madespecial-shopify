// Local server for the offer-page browser test: serves public/ and runs the real api/upsell.js against a fake Whop
// and mocked Shopify pricing. No real payment or Shopify call is made. Scenario: POST /__scenario {name}
// Run: node --experimental-test-module-mocks e2e/offer-server.mjs <port> <offers.json> [xl|6inch]  (which drum the test order holds)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

const PORT = Number(process.argv[2] || 8787);
process.env.WHOP_API_KEY = "test_key"; process.env.WHOP_COMPANY_ID = "biz_test"; process.env.SESSION_SECRET = "e2e_secret";
process.env.UPSELL_POLL_MS = "2000"; process.env.CHECKOUT_URL = `http://127.0.0.1:${PORT}`;
process.env.UPSELL_OFFERS = fs.readFileSync(process.argv[3], "utf8");
const XL = 68105383870646, NINE = 67665328799926;
const SIX = Number(process.env.E2E_SIX_VARIANT || 70000000000001); // stand-in 6-inch L variant id (see config/upsell-6inch-L.template.json)
const DRUM = process.argv[4] === "6inch" ? "6inch" : "xl";
// The 6-inch has no product photos yet: the test uses a Rainsong photo as a stand-in for the variant image Shopify will return.
const SHOP = { [XL]: { GBP: 13999, USD: 17999, title: "Margaret’s Hand-Tuned Steel Drum’s (10 Inches + 11 Tones)" }, [NINE]: { GBP: 2299, USD: 2999, title: "Add 1 More Rain Drum" },
  [SIX]: { GBP: 7799, USD: 9999, title: "Hand-Tuned Rain Drum (6 Inch - L)", options: ["Color: Teal"], image: "https://madespecial.store/cdn/shop/files/rainsong-hero-xmas.jpg?v=1795555539&width=1000" } };
mock.module("../lib/pricing.js", { exports: { priceCart: async (b) => {
  const it = b.items[0], cur = b.market_country === "GB" ? "GBP" : "USD", u = SHOP[it.variant_id][cur];
  return { currency: cur, shopCurrency: "USD", total: u * it.quantity, shopTotal: SHOP[it.variant_id].USD * it.quantity, lines: [[it.variant_id, it.quantity, u, SHOP[it.variant_id].USD]],
    display: [{ title: SHOP[it.variant_id].title, options: SHOP[it.variant_id].options || [], image: SHOP[it.variant_id].image || "", qty: it.quantity }] };
} } });
const { createSession } = await import("../lib/session.js");
const { default: upsell } = await import("../api/upsell.js");

let scenario = "success", payments = {}, keys = {}, creates = 0;
const MK = process.env.E2E_MARKET === "US" ? "US" : "GB", CUR = MK === "US" ? "USD" : "GBP";
const D = DRUM === "6inch" ? SIX : XL;
const order = { l: [[D, 1, SHOP[D][CUR], SHOP[D].USD]], c: CUR, t: SHOP[D][CUR] };
const reset = () => { payments = { pay_parent: { id: "pay_parent", status: "paid", paid_at: new Date().toISOString(), member_id: "mber_1", payment_method_id: "payt_1", metadata: { order: JSON.stringify(order) } } }; keys = {}; creates = 0; };
reset();
const statusOf = (p) => {
  const age = Date.now() - p.created;
  if (scenario === "success") return age > 900 ? { status: "succeeded" } : { status: "confirming" };
  if (scenario === "pending") return age > 7000 ? { status: "succeeded" } : { status: "processing" };
  if (scenario === "decline") return age > 400 ? { status: "requires_confirmation", last_payment_error: { message: "Your card was declined." } } : { status: "confirming" };
  return { status: "processing" };
};
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), p = u.pathname.replace("/api/v1", ""), m = init.method || "GET";
  if (!u.host.endsWith("whop.com")) throw new Error(`blocked ${url}`);
  if (m === "POST" && p === "/payments") {
    const k = init.headers["Idempotency-Key"]; if (keys[k]) return j(keys[k], 201);
    const id = `pay_e2e${++creates}`; payments[id] = { id, status: "open", created: Date.now(), metadata: JSON.parse(init.body).metadata };
    keys[k] = { id, status: "open", client_secret: null }; return j(keys[k], 201);
  }
  if (m === "GET" && p === "/payments") return j({ data: Object.values(payments).filter((x) => x.id !== "pay_parent"), page_info: {} });
  let r = p.match(/^\/payments\/(pay_\w+)\/status$/); if (r) return payments[r[1]] ? j({ id: r[1], ...statusOf(payments[r[1]]) }) : j({}, 404);
  r = p.match(/^\/payments\/(pay_\w+)$/); if (r) { const x = payments[r[1]]; if (!x) return j({}, 404); return j(x.id === "pay_parent" ? x : { ...x, ...(statusOf(x).status === "succeeded" && { status: "paid" }) }); }
  throw new Error(`unexpected ${m} ${url}`);
};

const PUB = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../public");
http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === "/__scenario") { scenario = u.searchParams.get("name"); reset();
    res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ scenario, token: createSession({ order, mk: MK, j: "e2e" }) })); }
  if (u.pathname === "/__creates") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ creates })); }
  if (u.pathname === "/api/upsell") {
    let body = ""; for await (const c of req) body += c;
    const r2 = { code: 200, setHeader: (k, v) => res.setHeader(k, v), status(c) { this.code = c; return this; }, json(o) { res.statusCode = this.code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); }, end() { res.end(); } };
    return upsell({ method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : {} }, r2);
  }
  if (u.pathname.startsWith("/api/")) { res.statusCode = 204; return res.end(); } // tracking etc.
  const f = path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader("Content-Type", f.endsWith(".html") ? "text/html" : f.endsWith(".jpg") ? "image/jpeg" : f.endsWith(".mp4") ? "video/mp4" : "application/octet-stream");
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`offer e2e server on ${PORT}`));
