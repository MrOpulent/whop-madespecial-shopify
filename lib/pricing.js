// lib/pricing.js — Shopify prices the cart (variant prices, Kaching offers, Essential upsell discounts are all
// Shopify discounts), in the shopper's market currency and in the shop's base currency.
// Shared by the branded checkout (api/checkout-session.js) and the legacy Whop-hosted flow (api/whop-checkout.js).
import { storefrontGql } from "./shopify.js";
import { ISO } from "./validate.js";

export const SHOP_COUNTRY = process.env.SHOP_COUNTRY || "US";

const CART_CREATE = `mutation($input: CartInput!) {
  cartCreate(input: $input) {
    cart {
      cost { totalAmount { amount currencyCode } }
      lines(first: 50) { nodes {
        quantity
        merchandise { ... on ProductVariant {
          id title requiresShipping
          image { url(transform: { maxWidth: 160, maxHeight: 160 }) altText }
          selectedOptions { name value }
          product { title featuredImage { url(transform: { maxWidth: 160, maxHeight: 160 }) } }
        } }
        cost { amountPerQuantity { amount } }
      } }
    }
    userErrors { field message }
  }
}`;

export const cents = (x) => Math.round(Number(x) * 100);

// Whop plan titles max 30 chars: "Margaret's Hand-Tuned Rain Drum" + " ×3" -> "Margaret's Hand-Tuned Rain… ×3"
export const planTitle = (name, qty) => {
  const suffix = qty > 1 ? ` ×${qty}` : "", room = 30 - suffix.length;
  return (name.length > room ? name.slice(0, room - 1).trimEnd() + "…" : name) + suffix;
};

// Shopify countries and the currency each one is sold in (Markets). Cached for 10 minutes.
let countriesCache = { at: 0, list: [] };
async function marketCountries() {
  if (Date.now() - countriesCache.at < 600000 && countriesCache.list.length) return countriesCache.list;
  const d = await storefrontGql(`{ localization { availableCountries { isoCode currency { isoCode } } } }`);
  countriesCache = { at: Date.now(), list: d.localization.availableCountries };
  return countriesCache.list;
}
// The market to price in = one whose currency is the drawer's currency (GBP drawer -> a GBP market).
// Prefers the market the page reported, then the shipping country, then any country in that currency.
export async function pickMarket(pageCountry, shipCountry, drawerCurrency) {
  const want = String(drawerCurrency || "").toUpperCase();
  const list = await marketCountries();
  // No drawer currency (delivery country changed on the checkout page): that country's market, if it sells there
  if (!want) return list.some((x) => x.isoCode === pageCountry) ? pageCountry : SHOP_COUNTRY;
  const cur = (c) => list.find((x) => x.isoCode === c)?.currency.isoCode;
  for (const c of [pageCountry, shipCountry]) if (c && cur(c) === want) return c;
  return list.find((x) => x.currency.isoCode === want)?.isoCode || (ISO.includes(pageCountry) ? pageCountry : SHOP_COUNTRY);
}

// Note attributes for the Shopify order: the cart's own attributes (as your tracking scripts saved them) plus
// tracking values from the browser. Exactly ONE click-ID field, as RedTrack requires.
const CLICKID_KEY = process.env.REDTRACK_CLICKID_KEY || "__clickid";
const CLICKID_SOURCES = ["__clickid", "rtkclickid-store", "rtkclickid", "clickid", "rtkcid", "cid"];
export function orderAttributes(cartAttrs, tracking) {
  const out = {};
  for (const [k, v] of Object.entries(cartAttrs || {})) if (v !== null && v !== undefined && v !== "") out[k] = String(v).slice(0, 500);
  const t = tracking && typeof tracking === "object" ? tracking : {};
  const hasClickId = Object.keys(out).some((k) => /clickid/i.test(k));
  if (!hasClickId) {
    const src = CLICKID_SOURCES.find((k) => t[k]) || Object.keys(t).find((k) => /clickid/i.test(k));
    if (src) out[CLICKID_KEY] = String(t[src]).slice(0, 200);
  }
  for (const [k, v] of Object.entries(t)) {
    if (/clickid|^rtk/i.test(k) || k in out) continue; // never a second click-ID field
    if (/ref_?id/i.test(k) && !/^_*ref_id$/i.test(k)) continue; // e.g. another app's "refId" storage, not tracking
    if (/^data:|^[\[{]/.test(String(v)) || /[\u0000-\u001f\u007f]/.test(String(v))) continue; // data blobs / JSON / binary
    out[k] = String(v).slice(0, 300);
  }
  let json = JSON.stringify(out); // keep metadata small: drop the longest values first if needed
  // Click IDs and the ad-platform browser IDs have to survive the hop onto the checkout domain.
  const keep = (k) => /clickid|ref_?id|^utm_|^_fbp$|^_fbc$|^fbclid$|^_ttp$|^ttclid$|^_scid$|^sccid$|^sc_click_id$|^_scclid$|^_?epik$|^aleid$|^alart$|^_axeid$|^_axart$|^_axwrt$/i.test(k);
  while (json.length > 1800) {
    const longest = Object.keys(out).filter((k) => !keep(k)).sort((a, b) => out[b].length - out[a].length)[0];
    if (!longest) break;
    delete out[longest]; json = JSON.stringify(out);
  }
  return out;
}

const toAttrs = (o) => Object.entries(o || {})
  .filter(([, v]) => v !== null && v !== undefined && v !== "")
  .map(([key, v]) => ({ key, value: typeof v === "string" ? v : JSON.stringify(v) }));

// Line item properties (e.g. Kaching's __kaching_bundles) to copy onto the Shopify order, kept small for Whop metadata
function lineProps(items) {
  const clean = (lim) => items.map((i) => Object.fromEntries(Object.entries(i.properties || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [String(k).slice(0, 60), (typeof v === "string" ? v : JSON.stringify(v)).slice(0, lim)])));
  if (!items.some((i) => Object.keys(i.properties || {}).length)) return {};
  for (const lim of [300, 120, 40]) { const p = clean(lim); if (JSON.stringify(p).length <= 900) return { p }; }
  return { p: items.map((i) => Object.fromEntries(Object.keys(i.properties || {}).slice(0, 5).map((k) => [k.slice(0, 60), "1"]))) };
}

// Prices the drawer's cart. Throws { status, code } errors the endpoints turn into JSON replies.
export async function priceCart(b, { checkDrawer = true } = {}) {
  const fail = (status, code, log) => { if (log) console.error(code, JSON.stringify(log)); const e = new Error(code); e.status = status; e.code = code; throw e; };
  const items = (Array.isArray(b?.items) ? b.items : []).filter((i) => Number(i.quantity) > 0).slice(0, 30);
  if (!items.length) fail(400, "empty_cart");

  const codes = (Array.isArray(b.discount_codes) ? b.discount_codes : []).map((c) => String(c?.code ?? c).trim()).filter((c) => c && c.length <= 60).slice(0, 5);
  const input = (countryCode) => ({ input: {
    lines: items.map((i) => ({
      merchandiseId: `gid://shopify/ProductVariant/${Number(i.variant_id)}`,
      quantity: Math.min(Math.max(1, Math.floor(Number(i.quantity))), 20),
      attributes: toAttrs(i.properties),
    })),
    attributes: toAttrs(b.attributes),
    ...(codes.length && { discountCodes: codes }), // codes entered in the cart drawer
    buyerIdentity: { countryCode },
  }});
  // Which market to price in, without making the shopper wait on an extra Shopify call when we already know.
  const want = String(b.currency || "").toUpperCase();
  const page = String(b.market_country || "").toUpperCase();
  const shopCur = String(process.env.SHOP_CURRENCY || "USD").toUpperCase();
  let market, pmP, smP;
  if (page === SHOP_COUNTRY && want === shopCur) {
    // The usual click: the cart is already in the shop's own currency. One Shopify call, same prices as before.
    market = SHOP_COUNTRY;
    pmP = storefrontGql(CART_CREATE, input(market));
    smP = null;
  } else if (page && ISO.includes(page) && want) {
    // Another currency: confirm the market, but start pricing the page's country (and the shop's) at the same time.
    const early = storefrontGql(CART_CREATE, input(page));
    const shopEarly = page === SHOP_COUNTRY ? null : storefrontGql(CART_CREATE, input(SHOP_COUNTRY));
    market = await pickMarket(b.market_country, b.ship_country, b.currency);
    pmP = market === page ? early : (market === SHOP_COUNTRY && shopEarly) ? shopEarly : storefrontGql(CART_CREATE, input(market));
    smP = market === SHOP_COUNTRY ? null : (shopEarly || storefrontGql(CART_CREATE, input(SHOP_COUNTRY)));
  } else {
    market = await pickMarket(b.market_country, b.ship_country, b.currency);
    pmP = storefrontGql(CART_CREATE, input(market));
    smP = market === SHOP_COUNTRY ? null : storefrontGql(CART_CREATE, input(SHOP_COUNTRY));
  }
  const [pm, sm] = await Promise.all([pmP, smP]);
  const out = pm.cartCreate, base = sm ? sm.cartCreate : out;
  if (!out.cart || out.userErrors.length || !base.cart || base.userErrors.length)
    fail(400, "cart_invalid", [out.userErrors, base.userErrors]);

  const currency = out.cart.cost.totalAmount.currencyCode;
  const total = cents(out.cart.cost.totalAmount.amount);
  const shopCurrency = base.cart.cost.totalAmount.currencyCode;
  const shopTotal = cents(base.cart.cost.totalAmount.amount);
  const nodes = out.cart.lines.nodes, baseNodes = base.cart.lines.nodes;
  if (!nodes.length || nodes.length !== baseNodes.length || nodes.some((n, i) => n.merchandise.id !== baseNodes[i].merchandise.id))
    fail(400, "cart_invalid", "cart line mismatch between markets");
  if (total <= 0) fail(400, "zero_total");

  // [variantId, qty, unit price in shopper currency, unit price in shop currency, 1 if it doesn't ship (e.g. shipping protection)]
  const lines = nodes.map((n, i) => [
    Number(n.merchandise.id.split("/").pop()), n.quantity,
    cents(n.cost.amountPerQuantity.amount), cents(baseNodes[i].cost.amountPerQuantity.amount),
    ...(n.merchandise.requiresShipping === false ? [1] : []),
  ]);
  const gross = lines.reduce((s, [, q, u]) => s + q * u, 0);
  const shopGross = lines.reduce((s, [, q, , su]) => s + q * su, 0);

  // Safety check: Shopify's total must equal what the drawer showed
  if (checkDrawer && (b.currency !== currency || Math.abs(total - Number(b.total_price)) > 1))
    fail(409, "price_mismatch", { shopify: [total, currency], drawer: [b.total_price, b.currency], market, items });

  // What the checkout page shows for each line
  const display = nodes.map((n) => {
    const m = n.merchandise;
    return {
      title: m.product.title,
      options: (m.selectedOptions || []).filter((o) => o.value !== "Default Title").map((o) => `${o.name}: ${o.value}`),
      image: m.image?.url || m.product.featuredImage?.url || "",
      qty: n.quantity,
    };
  });
  const qty = lines.reduce((s, [, q]) => s + q, 0);
  const description = display.map((d) => `${d.qty}× ${d.title}${d.options.length ? ` (${d.options.map((o) => o.split(": ")[1]).join(", ")})` : ""}`).join(", ").slice(0, 250);

  return {
    items: items.map((i) => [Number(i.variant_id), Number(i.quantity), i.properties || {}]), codes,
    market, currency, total, gross, shopCurrency, shopTotal, shopGross, lines, display, qty, description,
    title: planTitle(display[0].title, qty),
    order: { l: lines, c: currency, t: total, d: gross - total, sc: shopCurrency, st: shopTotal, sd: shopGross - shopTotal, ...lineProps(items), ...(codes.length && { dc: codes.join(", ").slice(0, 60) }) },
  };
}
