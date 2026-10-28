// api/pay.js — "Complete checkout": validates the buyer's details, then charges the Whop confirmation token
// (card / wallet collected by Whop's secure payment element) for the session's exact Shopify-priced total.
// The Shopify order is created by api/whop-webhook.js when Whop confirms the payment.
// Env: WHOP_API_KEY, WHOP_COMPANY_ID, optional WHOP_PRODUCT_ID / STORE_NAME
import crypto from "node:crypto";
import { readSession } from "../lib/session.js";
import { validateAddress, validateContact } from "../lib/validate.js";
import { createPayment, scopeProblem } from "../lib/whop.js";
import { baseUrl, journey } from "../lib/http.js";
import { clientContext } from "../lib/applovin.js";

const clean = (o, keys) => Object.fromEntries(keys.map((k) => [k, String(o?.[k] ?? "").trim().slice(0, 120)]));
const ADDR = ["country_code", "first_name", "last_name", "address1", "address2", "city", "province", "zip"];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  const b = req.body || {};
  let s;
  try { s = readSession(String(b.s || "")); }
  catch (e) { return res.status(400).json({ error: e.code || "session_invalid" }); }

  if (typeof b.confirmationToken !== "string" || !b.confirmationToken.startsWith("ctok_"))
    return res.status(400).json({ error: "payment_details_missing" });

  // Same rules as the page; the server never trusts the browser alone
  const contact = { ...clean(b.contact, ["email", "phone", "phone_country"]), marketing: !!b.contact?.marketing };
  const ship = clean(b.shipping, ADDR);
  ship.zip = ship.zip.toUpperCase();
  const billSame = b.billing_same !== false;
  const bill = billSame ? null : clean(b.billing, ADDR);
  if (bill) bill.zip = bill.zip.toUpperCase();
  const bad = [...validateContact(contact), ...validateAddress(ship), ...(bill ? validateAddress(bill, "billing_") : [])];
  if (bad.length) { journey(s.j, "pay_invalid_fields", { fields: bad }, true); return res.status(400).json({ error: "invalid_fields", fields: bad }); }

  try {
    const net = clientContext(req);
    const product = process.env.WHOP_PRODUCT_ID && b.account !== process.env.WHOP_COMPANY_ID_OLD
      ? { product_id: process.env.WHOP_PRODUCT_ID }
      : { product: { external_identifier: "madespecial-branded-checkout", title: `${process.env.STORE_NAME || "MadeSpecial"} order`, visibility: "hidden" } };
    const r = await createPayment({
      confirmation_token: b.confirmationToken,
      email: contact.email,
      plan: {
        ...product,
        currency: s.cur.toLowerCase(),
        plan_type: "one_time",
        initial_price: s.tot / 100,
        title: s.title,
        description: s.desc,
      },
      metadata: {
        order: JSON.stringify(s.order),
        attrs: JSON.stringify(s.attrs || {}),
        j: s.j || "",
        ship: JSON.stringify({ v: 2, email: contact.email, phone: contact.phone || "", marketing: contact.marketing, s: ship, b: bill }),
        // IP and user agent from checkout start (session), or from this request if the session predates them.
        cx: JSON.stringify({ ip: s.ip || net.ip || null, ua: s.ua || net.ua || null }),
      },
      return_url: `${baseUrl(req)}/?return=1`,
    }, crypto.createHash("sha256").update(b.confirmationToken).digest("hex"), typeof b.account === "string" ? b.account : undefined);

    if (!r.ok) {
      const msg = r.data?.error?.message || r.data?.message || "";
      const setup = scopeProblem(r.data);
      journey(s.j, setup ? "pay_setup_problem" : r.status < 500 ? "pay_declined" : "pay_whop_error", { status: r.status, message: msg.slice(0, 200), total: s.tot, currency: s.cur }, true);
      console.error(setup ? `SETUP PROBLEM — ${setup}` : "whop_create_payment", r.status, JSON.stringify(r.data).slice(0, 800));
      // Store set-up / server problems (401/403/5xx): nothing was charged; show a calm generic message.
      if (setup || r.status === 401 || r.status === 403 || r.status >= 500) return res.status(503).json({ error: "server_error" });
      // Card declines and validation problems are shown to the buyer
      return res.status(200).json({ error: "payment_failed", message: msg }); // 200: a decline is a normal outcome
    }
    const p = r.data;
    journey(s.j, "pay_created", { payment: p.id, status: p.status, needs_action: !!(p.client_secret && p.status !== "paid"), total: s.tot, currency: s.cur, country: ship.country_code });
    return res.status(200).json({ id: p.id, status: p.status, client_secret: p.client_secret || null });
  } catch (e) {
    console.error("pay_error", e); journey(s.j, "pay_server_error", { error: String(e.message).slice(0, 200) }, true);
    return res.status(500).json({ error: "server_error" });
  }
}
