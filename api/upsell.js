// api/upsell.js — post-purchase one-click upsell & decline-only downsell on the thank-you page (replaces Zipify OCU,
// which only runs inside Shopify's own checkout). Offers come from UPSELL_OFFERS, priced by Shopify in the shopper's
// currency. The saved card from the order is charged again with one click; if Whop has no saved card for it,
// the shopper enters a card. The webhook then adds the item to the same Shopify order.
//   GET  /api/upsell?s=<session>&payment=<pay_…>&step=0&declined=   -> the offer (or { done: true })
//   POST /api/upsell { s, payment, step, confirmationToken? } -> { id, status, client_secret } | { error }
//        status: "paid" | "failed" (a definite decline only) | "requires_action" (+ client_secret) | "pending"
//        The charge is checked with Whop for up to ~7s; "pending" means keep polling the status call below.
//   GET  /api/upsell?status=1&s=&payment=&step=&id=   -> { id, status, client_secret? }  (id optional: found by order + step)
// UPSELL_OFFERS (JSON), e.g.:
//   [{"variant_id":68105383870646,"if_any_variant":[...],"price":{"USD":11999,"GBP":9299},"headline":"..."},
//    {"variant_id":67665328799926,"quantity":2,"when":"declined","if_any_variant":[...],"unless_any_variant":[67665328799926],
//     "price":{"USD":7499,"GBP":5799},"msrp":{"USD":9998,"GBP":7798},...},
//    {"variant_id":67665328799926,"when":"declined",...,"price":{"USD":2999,"GBP":2299},"msrp":{"USD":4999,"GBP":3899},...}]
// Several flows can share the list: see config/upsell-6inch-L.template.json and scripts/upsell-offers.mjs.
// Optional per offer: "flow" (a label, e.g. "6inch-L"; not shown); "quantity" (default 1, max 10); "if_any_variant": [ids]; "unless_any_variant": [ids];
// "when": "always" | "declined" | "accepted" (conditions on the previous eligible offer);
// "price": {"USD":11999,"GBP":9299}; "msrp": {"USD":9998,"GBP":7798} (compare-at used for strikethrough and discount %);
// display: "eyebrow", "headline" ({name}/{save}/{price}; <b>/<em>/<br> allowed), "text", "badge", "sticker": ["50%","off 2nd"],
// "bullets", "why", "chip", "rating", "media" [{type:"video"|"img",src,poster,thumb}], "quote" {text,author}, "reviews" [{text,author}],
// "gifts" [{image,title,text}], "note", "button", "decline", "close", "title", "image". Reviews must be real Judge.me reviews.
import crypto from "node:crypto";
import { readSession } from "../lib/session.js";
import { priceCart } from "../lib/pricing.js";
import { getPayment, createPayment, getPaymentStatus, listRecentPayments, classifyPayment } from "../lib/whop.js";
import { baseUrl, journey } from "../lib/http.js";

const WINDOW_MIN = Math.min(Math.max(Number(process.env.UPSELL_MINUTES) || 15, 2), 60); // offer valid this long after payment (UPSELL_MINUTES)

// The offers a checkout gets, in step order: each flow (XL Pro, 6-inch L, ...) is keyed by the variants in the order
// (if_any_variant / unless_any_variant), so one UPSELL_OFFERS list can hold several flows without them mixing.
// An offer whose ids are still placeholders (e.g. "sku:6INCH-PRODRUM-TEAL-Q1") never matches, so it is skipped.
export function selectOffers(all, variantIds) {
  const have = new Set((variantIds || []).map(Number));
  const any = (ids) => (Array.isArray(ids) ? ids : [ids]).some((id) => have.has(Number(id)));
  return (Array.isArray(all) ? all : [all]).filter((x) => Number(x?.variant_id) > 0)
    .filter((x) => !x.if_any_variant || any(x.if_any_variant))
    .filter((x) => !x.unless_any_variant || !any(x.unless_any_variant))
    .slice(0, 3);
}

function offers(s) {
  try {
    return selectOffers(JSON.parse(process.env.UPSELL_OFFERS || "[]"), ((s && s.order && s.order.l) || []).map((l) => l[0]));
  } catch (e) { console.error("UPSELL_OFFERS is not valid JSON", e.message); return []; }
}

function stepAllowed(cfg, step, declinedSet, acceptedSet) {
  if (!cfg) return false;
  if (cfg.when === "declined") return step > 0 && declinedSet.has(step - 1);
  if (cfg.when === "accepted") return step > 0 && acceptedSet.has(step - 1);
  return true;
}

function hiResImage(url) {
  if (!url) return "";
  return String(url).replace(/([?&](?:width|height)=)\d+/g, "$1800");
}

// Checks the order really was paid in this checkout, then prices the offer with Shopify
async function load(sTok, paymentId, step, declinedSet, acceptedSet) {
  const s = readSession(String(sTok || ""));
  const list = offers(s), cfg = list[step];
  if (!cfg || !stepAllowed(cfg, step, declinedSet, acceptedSet)) return { done: true };
  if (!/^pay_[A-Za-z0-9]+$/.test(String(paymentId || ""))) return { done: true };
  const parent = await getPayment(paymentId);
  if (parent.status !== "paid" || parent.metadata?.order !== JSON.stringify(s.order)) return { done: true };
  const paidAt = Date.parse(parent.paid_at || parent.created_at || 0);
  if (!paidAt || Date.now() - paidAt > WINDOW_MIN * 60e3) return { done: true };

  const qty = Math.min(Math.max(1, Number(cfg.quantity) || 1), 10);
  const pct = Math.min(Math.max(0, Number(cfg.discount) || 0), 90);
  const p = await priceCart({ items: [{ variant_id: Number(cfg.variant_id), quantity: qty }], market_country: s.mk, ship_country: s.mk }, { checkDrawer: false });
  const [v, q, u, su] = p.lines[0];
  let t = Math.round(p.total * (100 - pct) / 100), st = Math.round(p.shopTotal * (100 - pct) / 100), off = pct;
  const msrp = Math.round(Number(cfg.msrp?.[p.currency]) || 0);
  const fixed = Math.round(Number(cfg.price?.[p.currency]) || 0);
  // advertised compare-at (msrp) is the ceiling when it is higher than Shopify's current selling total
  const ceiling = msrp > p.total ? msrp : p.total;
  if (fixed > 0 && fixed < ceiling) { // fixed price in the checkout currency; never above the advertised compare
    t = fixed; st = p.currency === p.shopCurrency ? fixed : Math.round((p.shopTotal || p.total) * fixed / (p.total || fixed));
    off = Math.round((1 - fixed / ceiling) * 100);
  }
  const compare = msrp > t ? msrp : p.total;
  const next = list[step + 1];
  const hasAfterAccept = !!(next && (!next.when || next.when === "always" || next.when === "accepted"));
  const hasAfterDecline = !!(next && (!next.when || next.when === "always" || next.when === "declined"));
  return {
    s, parent, cfg, step, last: !hasAfterAccept && !hasAfterDecline, hasAfterAccept, hasAfterDecline,
    pct: off, p, compare, msrp, line: { v, q, u, su, t, st, c: p.currency, sc: p.shopCurrency }, expiresAt: paidAt + WINDOW_MIN * 60e3,
  };
}


const POLL_MS = Math.min(Math.max(Number(process.env.UPSELL_POLL_MS) || 7000, 0), 9000); // server-side wait for Whop's outcome
const POLL_EVERY = 600;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const upsellMeta = (p) => { try { return JSON.parse(p?.metadata?.upsell || "{}"); } catch { return {}; } };
const isOfferPayment = (p, parentId, step) => p && p.metadata?.upsell_of === parentId && Number(upsellMeta(p).step) === Number(step);

// Current outcome of one payment. Never throws: if Whop can't be asked, the answer is "pending" (never a false decline).
export async function paymentOutcome(id, clientSecret) {
  let st = null, pay = null;
  try { st = await getPaymentStatus(id); } catch (e) { console.error("upsell_status", id, e.message); }
  if (!st || st.status !== "succeeded") { try { pay = await getPayment(id); } catch (e) { console.error("upsell_getpayment", id, e.message); } }
  let c = st ? classifyPayment(st, null) : { state: "pending" };
  if (c.state === "pending" && pay) { const c2 = classifyPayment(null, pay); if (c2.state !== "pending") c = c2; }
  const secret = clientSecret || pay?.client_secret || null;
  if (c.state === "requires_action" && !secret && !c.next_action) c = { state: "pending" };
  return { id, status: c.state, ...(c.message && { message: c.message }), ...(c.state === "requires_action" && { client_secret: secret, next_action: c.next_action || null }) };
}

// Wait (up to budget) until the payment is paid / failed / needs the buyer; otherwise "pending"
export async function pollOutcome(id, clientSecret, budget = POLL_MS, every = POLL_EVERY) {
  const end = Date.now() + budget;
  let o = await paymentOutcome(id, clientSecret);
  while (o.status === "pending" && Date.now() + every < end) { await sleep(every); o = await paymentOutcome(id, clientSecret); }
  return o;
}

// A charge that already exists for this order + offer step (double tap, retry, lost response). Newest first.
async function existingOfferPayments(parent, step) {
  const since = new Date(Date.parse(parent.paid_at || parent.created_at || Date.now()) - 60e3).toISOString();
  let hits = parent.member_id ? (await listRecentPayments(since, { member_id: parent.member_id })).filter((p) => isOfferPayment(p, parent.id, step)) : [];
  if (!hits.length) hits = (await listRecentPayments(since)).filter((p) => isOfferPayment(p, parent.id, step)); // a newly entered card can be a new member
  return hits;
}
const live = (o) => o.status !== "failed";

// Status call for the thank-you page while a charge is being confirmed. Only answers for the buyer's own order.
async function offerStatus(b, step) {
  const s = readSession(String(b.s || ""));
  if (!/^pay_[A-Za-z0-9]+$/.test(String(b.payment || ""))) return { error: "not_found" };
  const parent = await getPayment(b.payment);
  if (parent.status !== "paid" || parent.metadata?.order !== JSON.stringify(s.order)) return { error: "not_found" };
  let ids;
  if (/^pay_[A-Za-z0-9]+$/.test(String(b.id || ""))) {
    const p = await getPayment(b.id);
    if (!isOfferPayment(p, parent.id, step)) return { error: "not_found" };
    ids = [p.id];
  } else {
    ids = (await existingOfferPayments(parent, step)).slice(0, 3).map((p) => p.id);
    if (!ids.length) return { status: "pending" }; // the charge may not be listed yet
  }
  const outs = [];
  for (const id of ids) outs.push(await pollOutcome(id, null, 2500));
  return outs.find((o) => o.status === "paid") || outs.find((o) => o.status === "requires_action") || outs.find((o) => o.status === "pending") || outs[0];
}

const idSet = (v) => new Set(String(v || "").split(",").map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0));

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const b = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const step = Math.max(0, Math.floor(Number(b.step) || 0));
  const declinedSet = idSet(b.declined);
  const acceptedSet = idSet(b.accepted);
  if (req.method === "GET" && b.status) {
    try { return res.status(200).json(await offerStatus(b, step)); }
    catch (e) {
      if (e.code) return res.status(200).json({ error: "not_found" }); // bad or expired checkout session
      console.error("upsell_status_call", e.message); return res.status(200).json({ status: "pending" }); // unknown is never a decline
    }
  }
  let x;
  try { x = await load(b.s, b.payment, step, declinedSet, acceptedSet); }
  catch (e) { if (!e.code) console.error("upsell_load", e.message); return res.status(200).json({ done: true }); } // never break the thank-you page
  if (x.done) return res.status(200).json({ done: true });

  if (req.method === "GET") {
    const d = x.p.display[0];
    return res.status(200).json({
      step, last: x.last, hasAfterAccept: x.hasAfterAccept, hasAfterDecline: x.hasAfterDecline,
      when: x.cfg.when || "always", accountId: process.env.WHOP_COMPANY_ID,
      eyebrow: x.cfg.eyebrow || (x.cfg.when === "declined" ? "Final Offer Before Packing" : "Private Second-Item Offer"),
      headline: x.cfg.headline || "Wait! Special one-time offer", text: x.cfg.text || "",
      badge: x.cfg.badge || "", bullets: Array.isArray(x.cfg.bullets) ? x.cfg.bullets.slice(0, 4) : [],
      quote: x.cfg.quote || null, note: x.cfg.note || "", why: x.cfg.why || "", chip: x.cfg.chip || "", rating: x.cfg.rating || "",
      media: Array.isArray(x.cfg.media) ? x.cfg.media.slice(0, 4) : [], reviews: Array.isArray(x.cfg.reviews) ? x.cfg.reviews.slice(0, 3) : [],
      gifts: Array.isArray(x.cfg.gifts) ? x.cfg.gifts.slice(0, 3) : [],
      button: x.cfg.button || "Yes, Add to My Order",
      decline: x.cfg.decline || "No thanks, take me to my order confirmation",
      title: x.cfg.title || d.title, options: Array.isArray(x.cfg.options) && x.cfg.options.length ? x.cfg.options.slice(0, 4) : d.options, image: x.cfg.image || hiResImage(d.image), qty: x.line.q,
      currency: x.line.c, compare: x.compare, msrp: x.msrp || 0,
      sticker: Array.isArray(x.cfg.sticker) ? x.cfg.sticker.slice(0, 2) : [],
      close: x.cfg.close || "",
      price: x.line.t, discount: x.pct,
      oneClick: !!(x.parent.member_id && x.parent.payment_method_id && !x.parent._old), expiresAt: x.expiresAt,
    });
  }
  if (req.method !== "POST") return res.status(405).end();

  // Charge: saved card (one click) or a card the shopper just entered
  const ctok = typeof b.confirmationToken === "string" && b.confirmationToken.startsWith("ctok_") ? b.confirmationToken : null;
  const saved = x.parent.member_id && x.parent.payment_method_id && !x.parent._old; // saved cards belong to one Whop account
  if (!ctok && !saved) return res.status(200).json({ error: "needs_card" });
  let ship = {}; try { ship = JSON.parse(x.parent.metadata?.ship || "{}"); } catch {}
  const product = process.env.WHOP_PRODUCT_ID
    ? { product_id: process.env.WHOP_PRODUCT_ID }
    : { product: { external_identifier: "madespecial-branded-checkout", title: `${process.env.STORE_NAME || "MadeSpecial"} order`, visibility: "hidden" } };
  const d = x.p.display[0];
  const send = (o, extra = {}) => res.status(200).json({ ...o, ...extra });

  // 1. A charge for this order + offer already exists (double tap, retry, lost response): report it, never charge again
  try {
    for (const p of (await existingOfferPayments(x.parent, step)).slice(0, 3)) {
      const o = await paymentOutcome(p.id, null);
      if (!live(o)) continue;
      journey(x.s.j, "upsell_repeat_blocked", { step, payment: p.id, status: o.status });
      return send(o.status === "pending" ? await pollOutcome(p.id, null) : o);
    }
  } catch (e) { console.error("upsell_existing", e.message); } // the idempotency key below still prevents a second charge

  const body = {
    ...(ctok ? { confirmation_token: ctok, ...(ship.email && { email: ship.email }) } : { member_id: x.parent.member_id, payment_method_id: x.parent.payment_method_id }),
    plan: { ...product, currency: x.line.c.toLowerCase(), plan_type: "one_time", initial_price: x.line.t / 100,
      title: `Add-on: ${d.title}`.slice(0, 30), description: `${x.line.q}× ${d.title} (post-purchase offer)`.slice(0, 250) },
    metadata: {
      upsell_of: x.parent.id, j: x.s.j || "",
      upsell: JSON.stringify({ ...x.line, pct: x.pct, step, ...(d.title && { n: String(d.title).slice(0, 120) }) }),
      attrs: x.parent.metadata?.attrs || "{}",
      ship: x.parent.metadata?.ship || "",
      cx: x.parent.metadata?.cx || "",
    },
    return_url: `${baseUrl(req)}/?return=1&upsell=1`,
  };
  const key = crypto.createHash("sha256").update(`upsell:${x.parent.id}:${step}:${ctok || "saved"}`).digest("hex"); // same tap => same key => one charge

  let r;
  try {
    r = await createPayment(body, key);
    if (r.status === 409) { await sleep(1200); r = await createPayment(body, key); } // first request still running: Whop replays it when done
  } catch (e) {
    // Outcome unknown (network): the charge may exist. Never say declined; the page polls the status call.
    console.error("upsell_create_unknown", e.message);
    journey(x.s.j, "upsell_unknown", { step, message: String(e.message).slice(0, 200) }, true);
    return send({ status: "pending" });
  }

  try {
    if (!r.ok) {
      const msg = r.data?.error?.message || r.data?.message || "";
      const code = r.data?.error?.code || "";
      console.error("upsell_payment", r.status, JSON.stringify(r.data).slice(0, 600));
      if (r.status === 409 || code === "idempotency_request_in_progress" || code === "idempotency_key_mismatch") {
        journey(x.s.j, "upsell_in_progress", { step, status: r.status, code });
        return send({ status: "pending" }); // a charge for this tap is already on its way
      }
      journey(x.s.j, "upsell_declined_or_error", { step, status: r.status, message: msg.slice(0, 200), saved_card: !ctok }, true);
      if (r.status >= 500) return send({ status: "pending" }); // Whop's side failed mid-request: outcome unknown, so check instead of guessing
      if (r.status === 401 || r.status === 403) return send({ error: "server_error" }); // refused before charging
      return send({ error: "payment_failed", message: msg, needsCard: !ctok }); // Whop refused to create the charge: nothing was taken
    }
    const o = r.data.status === "paid" ? { id: r.data.id, status: "paid" } : await pollOutcome(r.data.id, r.data.client_secret || null);
    journey(x.s.j, "upsell_charged", { step, payment: r.data.id, created_status: r.data.status, outcome: o.status, total: x.line.t, currency: x.line.c, saved_card: !ctok }, o.status === "failed");
    if (o.status === "failed") return send(o, { needsCard: !ctok });
    return send(o);
  } catch (e) {
    console.error("upsell_error", e);
    return send({ id: r?.data?.id, status: "pending" }); // the charge exists; let the page keep checking
  }
}
