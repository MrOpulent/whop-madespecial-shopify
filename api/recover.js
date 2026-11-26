// api/recover.js — OutcraftAI's cart_link. Rebuilds the abandoned cart from a signed recovery link, prices it
// again with Shopify (today's prices, same market) and opens a fresh checkout with the SAME journey id, so the
// Whop webhook's checkout/completed matches the checkout Outcraft is chasing and stops the outreach.
// Optional ?discount=CODE (e.g. the campaign's offer code): a Shopify code, or else a Whop promo code.
// Anything wrong (expired link, product gone) goes to the store's cart instead of an error page.
import { createSession, readRecoverLink } from "../lib/session.js";
import { priceCart } from "../lib/pricing.js";
import { checkoutToken } from "../lib/discount.js";
import { baseUrl, journey } from "../lib/http.js";
import { clickIdFrom } from "../lib/ads.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
  const store = (process.env.STORE_URL || "https://madespecial.store").replace(/\/$/, "");
  const go = (url) => { res.statusCode = 302; res.setHeader("Location", url); return res.end(); };
  let link;
  try { link = readRecoverLink(String(req.query?.r || "")); }
  catch (e) { journey("-", "recover_link_bad", { error: e.code }, true); return go(`${store}/cart`); }

  const offer = String(req.query?.discount || "").trim().slice(0, 60);
  try {
    const items = (link.it || []).map(([variant_id, quantity, properties]) => ({ variant_id, quantity, properties: properties || {} }));
    const codes = [...new Set([...(link.dc || []), ...(offer ? [offer] : [])])];
    const p = await priceCart({ items, attributes: {}, discount_codes: codes, market_country: link.mk, ship_country: link.mk }, { checkDrawer: false });
    const attrs = { ...(link.a || {}), recovered_via: "outcraft" };
    const base = {
      mk: p.market, cur: p.currency, tot: p.total, gross: p.gross,
      disp: p.display, title: p.title, desc: p.description,
      order: p.order, attrs, j: link.j, cs: null, it: p.items,
      ...(p.codes.length && { dc: p.codes }), coff: p.codeOff || 0, ca: {},
    };
    // A code Shopify did not take may be a Whop promo code (the old checkout's, or the offer).
    const promo = [offer, link.wp].find((c) => c && !p.codes.includes(c)) || null;
    let token;
    if (promo) {
      try { token = await checkoutToken(base, p, promo); }
      catch { token = null; }
    }
    if (!token) token = createSession(base);
    journey(link.j, "checkout_recovered", { total: p.total, currency: p.currency, market: p.market, codes: [...p.codes, ...(promo ? [promo] : [])] });
    const click = clickIdFrom(attrs);
    return go(`${baseUrl(req)}/?s=${token}` + (click ? `&clickid=${encodeURIComponent(click)}` : ""));
  } catch (e) {
    journey(link.j, "recover_failed", { error: e.code || e.message }, true);
    return go(`${store}/cart`);
  }
}
