// The Whop return URL only brings the shopper back after 3-D Secure or a wallet redirect.
// Attribution stays on the checkout session and the payment metadata, so this URL stays short.
// Whop rejects long return URLs ("return_url is too long") before the card is charged.

export function checkoutReturnUrl(origin, { journey, upsell } = {}) {
  const base = String(origin || "").replace(/\/$/, "");
  const q = new URLSearchParams();
  q.set("return", "1");
  if (upsell) q.set("upsell", "1");
  const j = String(journey || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  if (j) q.set("j", j);
  return `${base}/?${q.toString()}`;
}

// Same path with the journey id removed. Used once, only after Whop says the URL is too long.
export function minimalReturnUrl(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return ""; }
  const upsell = u.searchParams.get("upsell") === "1";
  u.hash = "";
  u.username = "";
  u.password = "";
  const q = new URLSearchParams();
  q.set("return", "1");
  if (upsell) q.set("upsell", "1");
  u.search = q.toString();
  return u.toString();
}

export function returnUrlTooLong(data) {
  const msg = typeof data === "string" ? data : data?.error?.message || data?.message || "";
  return /return_url is too long/i.test(String(msg));
}
