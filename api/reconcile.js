// api/reconcile.js — safety net: finds paid Whop payments from the last few days that have no Shopify order
// (e.g. the webhook was down or misconfigured) and creates them. Safe to run any time: existing orders are skipped.
// Runs by itself via the cron in vercel.json; run by hand: /api/reconcile?key=<SETUP_KEY>   (&days=7 to look further back)
// Env: same as the webhook + SETUP_KEY (manual runs). Vercel sends CRON_SECRET automatically for its cron.
import { listPaidPayments } from "../lib/whop.js";
import { fulfil } from "./whop-webhook.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const auth = req.headers?.authorization || "";
  const ok = (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) ||
             (process.env.SETUP_KEY && req.query?.key === process.env.SETUP_KEY);
  if (!ok) return res.status(403).json({ error: "add ?key=<SETUP_KEY>" });

  const days = Math.min(Math.max(Number(req.query?.days) || 3, 1), 30);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const settle = Date.now() - 10 * 60e3; // leave the last 10 minutes to the webhook (no double orders)
  const result = { checked: 0, created: [], existing: 0, skipped: 0, failed: [] };
  try {
    for (const p of await listPaidPayments(since)) {
      if (!p.metadata?.order) { result.skipped++; continue; }                 // not from this checkout
      if (Date.parse(p.paid_at || p.created_at) > settle) { result.skipped++; continue; }
      result.checked++;
      try {
        const r = await fulfil(p);
        if (r.body.order) result.created.push({ payment: p.id, order: r.body.order });
        else if (r.body.duplicate) result.existing++;
        else result.failed.push({ payment: p.id, err: r.body.err || r.body.error });
      } catch (e) { result.failed.push({ payment: p.id, err: String(e.message).slice(0, 300) }); }
    }
  } catch (e) {
    console.error("reconcile", e);
    return res.status(502).json({ ...result, error: String(e.message).slice(0, 400) });
  }
  if (result.created.length) console.error("RECONCILE created missing orders:", JSON.stringify(result.created));
  if (result.failed.length) console.error("RECONCILE failed:", JSON.stringify(result.failed));
  return res.status(result.failed.length ? 500 : 200).json(result);
}
