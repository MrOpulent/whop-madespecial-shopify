// Re-price a checkout session after a discount code or a delivery-country change.
// Shopify codes are applied by Shopify. A code Shopify does not know is a Whop promo code.
import { priceCart } from "./pricing.js";
import { createSession } from "./session.js";
import { promoDiscount } from "./whop.js";

const fail = (code) => Object.assign(new Error(code), { code });

export async function loadCheckoutPrice(s, country, codes) {
  if (!Array.isArray(s.it)) throw fail("no_items");
  const p = await priceCart({
    items: s.it.map(([variant_id, quantity, properties]) => ({ variant_id, quantity, properties })),
    attributes: s.ca,
    discount_codes: codes,
    market_country: country,
    ship_country: country,
  }, { checkDrawer: false });
  const prev = s.order?.l;
  const same = Array.isArray(prev) && p.lines.length === prev.length && p.lines.every((l, i) => l[0] === prev[i][0] && l[1] === prev[i][1]);
  if (!same) throw fail("cart_changed");
  return p;
}

// Signed session for this price. promoCode, when set, must be a usable Whop promo or this throws invalid_code.
export async function checkoutToken(s, p, promoCode) {
  let whop = null;
  if (promoCode) {
    whop = await promoDiscount(promoCode, p.total, p.currency, p.shopTotal, p.shopCurrency);
    if (!whop) throw fail("invalid_code");
    if (whop.unusable) throw fail("discount_unusable");
  }
  const { exp: _e, v: _v, ...keep } = s;
  const order = { ...p.order };
  let tot = p.total;
  if (whop) {
    tot = p.total - whop.off;
    const st = p.shopTotal - whop.shopOff;
    order.t = tot;
    order.st = st;
    order.d = Math.max(0, p.gross - tot);
    order.sd = Math.max(0, p.shopGross - st);
    order.dc = [...p.codes, whop.code].join(", ").slice(0, 60);
  }
  const next = {
    ...keep,
    mk: p.market, cur: p.currency, tot, gross: p.gross,
    disp: p.display, title: p.title, desc: p.description, order,
    dc: p.codes, coff: p.codeOff || 0,
  };
  delete next.wp; delete next.wbase; delete next.wshop;
  if (whop) { next.wp = whop.code; next.wbase = p.total; next.wshop = p.shopTotal; }
  return createSession(next);
}
