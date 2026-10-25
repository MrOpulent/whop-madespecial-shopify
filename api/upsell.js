// api/upsell.js — post-purchase one-click upsell on the thank-you page (replaces Zipify OCU, which only runs
// inside Shopify's own checkout). Offers come from the UPSELL_OFFERS setting, priced by Shopify in the shopper's
// currency. The saved card from the order is charged again with one click; if Whop has no saved card for it,
// the shopper enters a card. The webhook then adds the item to the same Shopify order.
//   GET  /api/upsell?s=<session>&payment=<pay_…>&step=0   -> the offer (or { done: true })
//   POST /api/upsell { s, payment, step, confirmationToken? } -> { id, status, client_secret } | { error }
// UPSELL_OFFERS (JSON), e.g.:
//   [{"variant_id":123,"discount":30,"headline":"Wait! Add a second drum for a friend","text":"One click, no extra shipping.","button":"Yes, add to my order"}]
// Optional per offer: "quantity" (default 1). Up to 3 offers, shown one after another.
import crypto from "node:crypto";
import { readSession } from "../lib/session.js";
import { priceCart } from "../lib/pricing.js";
import { getPayment, createPayment } from "../lib/whop.js";
import { baseUrl } from "../lib/http.js";

const WINDOW_MIN = Math.min(Math.max(Number(process.env.UPSELL_MINUTES) || 15, 2), 60); // offer valid this long after payment (UPSELL_MINUTES)

function offers() {
  try {
    const a = JSON.parse(process.env.UPSELL_OFFERS || "[]");
    return (Array.isArray(a) ? a : [a]).filter((x) => Number(x?.variant_id) > 0).slice(0, 3);
  } catch (e) { console.error("UPSELL_OFFERS is not valid JSON", e.message); return []; }
}

// Checks the order really was paid in this checkout, then prices the offer with Shopify
async function load(sTok, paymentId, step) {
  const s = readSession(String(sTok || ""));
  const list = offers(), cfg = list[step];
  if (!cfg) return { done: true };
  if (!/^pay_[A-Za-z0-9]+$/.test(String(paymentId || ""))) return { done: true };
  const parent = await getPayment(paymentId);
  if (parent.status !== "paid" || parent.metadata?.order !== JSON.stringify(s.order)) return { done: true };
  const paidAt = Date.parse(parent.paid_at || parent.created_at || 0);
  if (!paidAt || Date.now() - paidAt > WINDOW_MIN * 60e3) return { done: true };

  const qty = Math.min(Math.max(1, Number(cfg.quantity) || 1), 10);
  const pct = Math.min(Math.max(0, Number(cfg.discount) || 0), 90);
  const p = await priceCart({ items: [{ variant_id: Number(cfg.variant_id), quantity: qty }], market_country: s.mk, ship_country: s.mk }, { checkDrawer: false });
  const [v, q, u, su] = p.lines[0];
  const t = Math.round(p.total * (100 - pct) / 100), st = Math.round(p.shopTotal * (100 - pct) / 100);
  return { s, parent, cfg, step, last: step >= list.length - 1, pct, p, line: { v, q, u, su, t, st, c: p.currency, sc: p.shopCurrency }, expiresAt: paidAt + WINDOW_MIN * 60e3 };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const b = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const step = Math.max(0, Math.floor(Number(b.step) || 0));
  let x;
  try { x = await load(b.s, b.payment, step); }
  catch (e) { if (!e.code) console.error("upsell_load", e.message); return res.status(200).json({ done: true }); } // never break the thank-you page
  if (x.done) return res.status(200).json({ done: true });

  if (req.method === "GET") {
    const d = x.p.display[0];
    return res.status(200).json({
      step, last: x.last, accountId: process.env.WHOP_COMPANY_ID,
      headline: x.cfg.headline || "Wait! Special one-time offer", text: x.cfg.text || "", button: x.cfg.button || "Yes, add to my order",
      title: d.title, options: d.options, image: d.image, qty: x.line.q,
      currency: x.line.c, compare: x.p.total, price: x.line.t, discount: x.pct,
      oneClick: !!(x.parent.member_id && x.parent.payment_method_id), expiresAt: x.expiresAt,
    });
  }
  if (req.method !== "POST") return res.status(405).end();

  // Charge: saved card (one click) or a card the shopper just entered
  const ctok = typeof b.confirmationToken === "string" && b.confirmationToken.startsWith("ctok_") ? b.confirmationToken : null;
  const saved = x.parent.member_id && x.parent.payment_method_id;
  if (!ctok && !saved) return res.status(200).json({ error: "needs_card" });
  let ship = {}; try { ship = JSON.parse(x.parent.metadata?.ship || "{}"); } catch {}
  const product = process.env.WHOP_PRODUCT_ID
    ? { product_id: process.env.WHOP_PRODUCT_ID }
    : { product: { external_identifier: "madespecial-branded-checkout", title: `${process.env.STORE_NAME || "MadeSpecial"} order`, visibility: "hidden" } };
  const d = x.p.display[0];
  try {
    const r = await createPayment({
      ...(ctok ? { confirmation_token: ctok, ...(ship.email && { email: ship.email }) } : { member_id: x.parent.member_id, payment_method_id: x.parent.payment_method_id }),
      plan: { ...product, currency: x.line.c.toLowerCase(), plan_type: "one_time", initial_price: x.line.t / 100,
        title: `Add-on: ${d.title}`.slice(0, 30), description: `${x.line.q}× ${d.title} (post-purchase offer)`.slice(0, 250) },
      metadata: {
        upsell_of: x.parent.id,
        upsell: JSON.stringify({ ...x.line, pct: x.pct, step }),
        attrs: x.parent.metadata?.attrs || "{}",
        ship: x.parent.metadata?.ship || "",
      },
      return_url: `${baseUrl(req)}/?return=1&upsell=1`,
    }, crypto.createHash("sha256").update(`upsell:${x.parent.id}:${step}:${ctok || "saved"}`).digest("hex")); // a double click never charges twice

    if (!r.ok) {
      const msg = r.data?.error?.message || r.data?.message || "";
      console.error("upsell_payment", r.status, JSON.stringify(r.data).slice(0, 600));
      if (r.status === 401 || r.status === 403 || r.status >= 500) return res.status(200).json({ error: "server_error" });
      return res.status(200).json({ error: "payment_failed", message: msg, needsCard: !ctok });
    }
    return res.status(200).json({ id: r.data.id, status: r.data.status, client_secret: r.data.client_secret || null });
  } catch (e) {
    console.error("upsell_error", e);
    return res.status(200).json({ error: "server_error" });
  }
}
