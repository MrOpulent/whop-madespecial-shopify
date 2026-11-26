// api/abandon.js — the checkout page reports what the shopper has filled in so far (debounced), and this sends
// OutcraftAI's checkout/updated with the full cart from the signed session. Outcraft treats the checkout as
// abandoned 30 minutes after the last update; the Whop webhook sends checkout/completed when it is paid.
// Env: OUTCRAFT_TRIGGER_URL. Not set = this answers 204 and sends nothing.
import { readSession } from "../lib/session.js";
import { baseUrl } from "../lib/http.js";
import { buildUpdated, outcraftUrl, recoverLink, sendOutcraft } from "../lib/outcraft.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  if (!outcraftUrl()) return res.status(204).end();
  const b = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  let s;
  try { s = readSession(String(b.s || "")); } catch { return res.status(204).end(); } // expired or not ours: nothing to send
  if (!s.j || !Array.isArray(s.it)) return res.status(204).end();
  const payload = buildUpdated(s, b.c, recoverLink(baseUrl(req), s));
  if (!payload) return res.status(204).end(); // no phone or email yet
  const r = await sendOutcraft(payload);
  return res.status(200).json({ ok: !!r.status && r.status < 300 });
}
