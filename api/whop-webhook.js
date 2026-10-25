// api/whop-webhook.js — Whop "payment succeeded" -> paid Shopify order (logic in lib/order.js).
// Env: lib/shopify.js vars + WHOP_API_KEY, WHOP_WEBHOOK_SECRET
import { verifyWebhook } from "../lib/whop.js";
import { fulfil } from "../lib/order.js";

export const config = { api: { bodyParser: false } }; // raw body for signature check

const rawBody = (req) => new Promise((ok, fail) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); req.on("error", fail);
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  let evt;
  try { evt = verifyWebhook(await rawBody(req), req.headers); }
  catch (e) { console.error("webhook_verify", e.message); return res.status(401).json({ error: "bad_signature" }); }

  const type = evt.type || evt.action;
  if (!["payment.succeeded", "payment_succeeded"].includes(type)) return res.status(200).json({ skipped: type });
  try {
    const r = await fulfil(evt.data);
    return res.status(r.status).json(r.body);
  } catch (e) {
    console.error("webhook_error", e);
    return res.status(500).json({ error: "server_error" }); // 500 => Whop retries
  }
}
