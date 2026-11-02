// api/discount.js — the discount field on the checkout page.
// A code Shopify accepts is priced by Shopify. Anything else is tried as a Whop promo code.
// Returns a new signed session. Env: same as api/checkout-session.js, plus promo_code:basic:read on the Whop key.
import { readSession } from "../lib/session.js";
import { loadCheckoutPrice, checkoutToken } from "../lib/discount.js";
import { view } from "./session.js";
import { journey } from "../lib/http.js";

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  const b = req.body || {};
  let s;
  try { s = readSession(String(b.s || "")); }
  catch (e) { return res.status(400).json({ error: e.code || "session_invalid" }); }
  const code = String(b.code || "").trim();
  if (!CODE.test(code)) return res.status(400).json({ error: "invalid_code" });

  const remove = b.remove === true;
  const had = Array.isArray(s.dc) ? s.dc : [];
  const drop = (list) => list.filter((c) => !same(c, code));
  if (remove) {
    const known = had.some((c) => same(c, code)) || (s.wp && same(s.wp, code));
    if (!known) return res.status(200).json({ s: String(b.s), session: view(s) });
  } else if (had.some((c) => same(c, code)) || (s.wp && same(s.wp, code))) {
    return res.status(200).json({ s: String(b.s), session: view(s) });
  }

  const country = String(s.mk || "").toUpperCase();
  const promoLeft = s.wp && same(s.wp, code) ? null : (s.wp || null);
  try {
    let token;
    if (remove) {
      const p = await loadCheckoutPrice(s, country, drop(had));
      token = await checkoutToken(s, p, promoLeft);
    } else {
      let p;
      try { p = await loadCheckoutPrice(s, country, [...had, code].slice(0, 5)); }
      catch (e) {
        if (e.code === "zero_total") return res.status(400).json({ error: "discount_unusable" });
        if (e.code !== "cart_invalid") throw e;
        p = await loadCheckoutPrice(s, country, had);
      }
      const took = (p.codes || []).some((c) => same(c, code));
      if (took) {
        try { token = await checkoutToken(s, p, promoLeft); }
        catch (e) {
          if (e.code !== "invalid_code" || !promoLeft) throw e;
          token = await checkoutToken(s, p, null);
        }
      } else {
        token = await checkoutToken(s, p, code);
      }
    }
    const next = readSession(token);
    journey(s.j, remove ? "discount_removed" : "discount_applied", { code, total: next.tot, currency: next.cur, whop: next.wp || null });
    return res.status(200).json({ s: token, session: view(next) });
  } catch (e) {
    const known = e.code === "invalid_code" || e.code === "zero_total" || e.code === "discount_unusable";
    if (known || e.code === "cart_changed" || e.code === "no_items") {
      journey(s.j, "discount_rejected", { code, error: e.code === "zero_total" ? "discount_unusable" : e.code }, true);
      return res.status(400).json({ error: e.code === "zero_total" ? "discount_unusable" : e.code === "invalid_code" ? "invalid_code" : "discount_unusable" });
    }
    console.error("discount_error", e);
    journey(s.j, "discount_error", { code, error: String(e.message || e).slice(0, 200) }, true);
    return res.status(500).json({ error: "server_error" });
  }
}
