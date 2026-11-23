// Campaign tags from the visit, copied onto the checkout_started log only.
// Earlier bags win, so the current tracking payload beats older cart attributes.
const KEYS = [
  "tw_source", "tw_adid", "tw_campaign",
  "utm_source", "utm_medium", "utm_campaign", "utm_content",
  "cmpid", "gclid", "gbraid", "wbraid",
];

function value(bag, key) {
  if (!bag || typeof bag !== "object") return "";
  let raw = bag[key];
  if (raw == null || String(raw).trim() === "") {
    const found = Object.keys(bag).find((k) => k.toLowerCase() === key);
    raw = found == null ? "" : bag[found];
  }
  const v = String(raw ?? "").trim();
  if (!v || v.length > 500) return "";
  if (/^(undefined|null|none|n\/a)$/i.test(v)) return "";
  if (/[\u0000-\u001f\u007f]/.test(v)) return "";
  return v.slice(0, 300);
}

export function campaignTags(...bags) {
  const out = {};
  for (const key of KEYS) {
    for (const bag of bags) {
      const v = value(bag, key);
      if (v) { out[key] = v; break; }
    }
  }
  return out;
}
