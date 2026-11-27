#!/usr/bin/env node
// Builds and checks the UPSELL_OFFERS value (a JSON list that can hold several flows: XL Pro, 6-inch L, ...).
// Nothing here changes Vercel or Shopify; it only prints JSON.
//
//   node scripts/upsell-offers.mjs fill  <template.json> --ids <sku-to-variant.json>   # or --shopify (Admin API, needs SHOPIFY_* env)
//   node scripts/upsell-offers.mjs merge <current.json|-> <flow.json>                  # replace that flow's offers, keep every other offer as is
//   node scripts/upsell-offers.mjs remove <current.json|-> <flow label>                # drop one flow (rollback), keep the rest
//   node scripts/upsell-offers.mjs check <offers.json> <variantId,variantId,...>        # the steps a checkout with those variants gets
//
// Placeholders in a template: "sku:<SKU>" (one variant) and "sku-prefix:<PREFIX>" (every variant whose SKU starts with PREFIX).
import fs from "node:fs";
import { selectOffers } from "../api/upsell.js";

const [cmd, a, b, c] = process.argv.slice(2);
const read = (f) => JSON.parse(f === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(f, "utf8"));
const die = (m) => { console.error(m); process.exit(1); };

export function placeholders(list) {
  const out = new Set();
  const walk = (v) => { if (typeof v === "string" && /^sku(-prefix)?:/.test(v)) out.add(v); else if (Array.isArray(v)) v.forEach(walk); };
  for (const o of list) for (const k of ["variant_id", "if_any_variant", "unless_any_variant"]) walk(o[k]);
  return [...out];
}

// map: { "<SKU>": <variant id> }
export function fill(list, map) {
  const skus = Object.keys(map);
  const one = (v) => {
    if (typeof v !== "string") return [v];
    if (v.startsWith("sku:")) { const id = map[v.slice(4)]; if (!id) throw new Error(`no variant for ${v}`); return [Number(id)]; }
    if (v.startsWith("sku-prefix:")) { const ids = skus.filter((s) => s.startsWith(v.slice(11))).map((s) => Number(map[s])); if (!ids.length) throw new Error(`no variants for ${v}`); return ids; }
    return [v];
  };
  return list.map((o) => {
    const x = { ...o };
    if (x.variant_id != null) { const r = one(x.variant_id); if (r.length !== 1) throw new Error("variant_id must be one variant"); x.variant_id = r[0]; }
    for (const k of ["if_any_variant", "unless_any_variant"]) if (x[k] != null) x[k] = [...new Set((Array.isArray(x[k]) ? x[k] : [x[k]]).flatMap(one))];
    return x;
  });
}

export function merge(current, flow) {
  const names = new Set(flow.map((o) => o.flow).filter(Boolean));
  if (!names.size) throw new Error("the flow file's offers need a \"flow\" label");
  return [...(Array.isArray(current) ? current : [current]).filter((o) => !names.has(o?.flow)), ...flow];
}

async function shopifyMap(prefixes) {
  const { adminGql } = await import("../lib/shopify.js");
  const map = {};
  for (const p of prefixes) {
    const d = await adminGql(`query($q:String!){ productVariants(first: 100, query: $q) { nodes { id sku } } }`, { q: `sku:${p}*` });
    for (const n of d.productVariants.nodes) if (n.sku && n.sku.startsWith(p)) map[n.sku] = Number(n.id.split("/").pop());
  }
  return map;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "fill") {
    const t = read(a);
    const ph = placeholders(t);
    const map = b === "--ids" ? read(c) : b === "--shopify" ? await shopifyMap([...new Set(ph.map((p) => p.replace(/^sku(-prefix)?:/, "").replace(/[^-]*$/, "")))]) : die("fill needs --ids <file> or --shopify");
    const out = fill(t, map);
    if (placeholders(out).length) die(`unresolved: ${placeholders(out).join(", ")}`);
    console.log(JSON.stringify(out));
  } else if (cmd === "merge") {
    const out = merge(read(a), read(b));
    if (placeholders(out).length) die(`unresolved placeholders, run fill first: ${placeholders(out).join(", ")}`);
    console.log(JSON.stringify(out));
  } else if (cmd === "remove") {
    if (!b) die("remove needs a flow label, e.g. 6inch-L");
    console.log(JSON.stringify(read(a).filter((o) => o?.flow !== b)));
  } else if (cmd === "check") {
    const list = read(a), ids = String(b || "").split(",").map(Number).filter(Boolean);
    const ph = placeholders(list); if (ph.length) console.error(`warning: still placeholders (those offers never show): ${ph.join(", ")}`);
    selectOffers(list, ids).forEach((o, i) => console.log(`step ${i} [${o.flow || "-"}] ${o.when || "always"} -> ${o.quantity || 1}x ${o.variant_id} at ${JSON.stringify(o.price || {})}  ${String(o.title || "").slice(0, 50)}`));
  } else die("usage: fill | merge | check (see the top of this file)");
}
