// api/track.js — the checkout page reports each step of the shopper's journey here; it lands in Vercel Logs.
// Vercel > Logs: search  j=<journey id>  (shown on the Shopify order as "checkout_journey_id") or  JOURNEY.
import { readSession } from "../lib/session.js";
import { journey } from "../lib/http.js";

const PROBLEMS = /error|fail|declin|invalid|expired|blocked|timeout|not_loaded/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  let b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } } // sendBeacon sends text
  let j = "-";
  try { j = readSession(String(b.s || "")).j || "-"; } catch { j = "nosession"; }
  const step = String(b.step || "").replace(/[^\w:-]/g, "").slice(0, 40);
  if (!step) return res.status(204).end();
  const data = b.data && typeof b.data === "object" ? b.data : {};
  journey(j, step, { ...data, ua: String(req.headers?.["user-agent"] || "").slice(0, 120) }, PROBLEMS.test(step) || !!b.problem);
  return res.status(204).end();
}
