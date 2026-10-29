// One Shopify order per Whop payment id.
// Tag search lags behind orderCreate, so two webhook deliveries can both miss the order and both create one.
// orderCreate is not in Shopify's @idempotent mutation list. A unique id metafield is not safe either:
// orderCreate can drop a duplicate id and still create the order.
// The lock is a shop metafield updated with compareDigest (compare-and-swap). The payment id is the key.
import crypto from "node:crypto";
import { adminGql } from "./shopify.js";

const KEEP_MS = 48 * 3600 * 1000;
const PENDING_MS = 90 * 1000;
const MAX = 200;
const READ = `query { shop { id m: metafield(namespace: "whop", key: "order_claims") { value compareDigest } } }`;
const WRITE = `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message code } } }`;

let shopId = "";
let disabled = false;

export function parseClaims(raw) {
  try {
    const o = JSON.parse(raw || "{}");
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (!/^pay_[A-Za-z0-9]+$/.test(k) || !v || typeof v !== "object") continue;
      const at = Number(v.at) || 0;
      const order = typeof v.order === "string" ? v.order.slice(0, 40) : "";
      const token = typeof v.token === "string" ? v.token.slice(0, 40) : "";
      if (order) out[k] = { order, at };
      else if (token) out[k] = { token, at };
    }
    return out;
  } catch { return {}; }
}

export function pruneClaims(map, now) {
  const entries = Object.entries(map || {}).filter(([, v]) => v && now - (v.at || 0) < KEEP_MS);
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  return Object.fromEntries(entries.slice(0, MAX));
}

// duplicate: this payment already has an order name.
// wait: another delivery is creating it.
// claim: this delivery should write `map` with compare-and-swap, then create the order.
export function decideClaim(map, paymentId, now, token) {
  const cur = map?.[paymentId];
  if (cur?.order) return { action: "duplicate", order: cur.order };
  if (cur?.token && cur.token !== token && now - (cur.at || 0) < PENDING_MS) return { action: "wait" };
  return { action: "claim", map: pruneClaims({ ...map, [paymentId]: { token, at: now } }, now) };
}

export function finishClaim(map, paymentId, order, now) {
  return pruneClaims({ ...map, [paymentId]: { order: String(order).slice(0, 40), at: now } }, now);
}

export function releaseClaim(map, paymentId, token, now) {
  const cur = map?.[paymentId];
  if (!cur || cur.order || cur.token !== token) return pruneClaims(map, now);
  const next = { ...map };
  delete next[paymentId];
  return pruneClaims(next, now);
}

async function readClaims() {
  const d = await adminGql(READ);
  shopId = d.shop.id;
  return { map: parseClaims(d.shop.m?.value), digest: d.shop.m ? d.shop.m.compareDigest : null };
}

async function writeClaims(map, digest) {
  const d = await adminGql(WRITE, { m: [{
    ownerId: shopId, namespace: "whop", key: "order_claims", type: "json",
    value: JSON.stringify(map), compareDigest: digest,
  }] });
  const err = d.metafieldsSet?.userErrors || [];
  if (!err.length) return { ok: true };
  const msg = err.map((e) => `${e.code || ""} ${e.message}`).join(" ").slice(0, 240);
  // A digest mismatch is a lost race: retry. Anything else (permissions, a null digest, a bad type) disables the lock.
  const mismatch = /digest|stale|conflict/i.test(msg) && !/null|access denied|not authorized|invalid type/i.test(msg);
  return { ok: false, fatal: !mismatch, msg };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function commit(paymentId, token, orderName) {
  for (let i = 0; i < 4; i++) {
    try {
      const cur = await readClaims();
      const map = orderName
        ? finishClaim(cur.map, paymentId, orderName, Date.now())
        : releaseClaim(cur.map, paymentId, token, Date.now());
      const w = await writeClaims(map, cur.digest);
      if (w.ok || w.fatal) return;
    } catch { return; }
  }
}

// Runs fn once this payment id is claimed. fn returns the fulfil() result ({ status, body }).
// If the lock cannot be used, fn still runs and the tag search inside it is the only guard.
export async function withPaymentLock(paymentId, fn) {
  const id = String(paymentId || "");
  if (disabled || !/^pay_[A-Za-z0-9]+$/.test(id)) return fn();
  const token = crypto.randomBytes(8).toString("hex");
  let held = false;
  let blocked = false;
  try {
    for (let i = 0; i < 8; i++) {
      let cur;
      try { cur = await readClaims(); }
      catch {
        console.error(`order_lock_unavailable payment=${id} reason=read`);
        return fn();
      }
      const d = decideClaim(cur.map, id, Date.now(), token);
      if (d.action === "duplicate") return { status: 200, body: { duplicate: d.order } };
      if (d.action === "wait") { blocked = true; await sleep(300 * (i + 1)); continue; }
      const w = await writeClaims(d.map, cur.digest);
      if (!w.ok) {
        if (w.fatal) {
          disabled = true;
          console.error(`order_lock_unavailable payment=${id} reason=write`);
          return fn();
        }
        await sleep(100 * (i + 1));
        continue;
      }
      const check = await readClaims();
      if (check.map[id]?.order) return { status: 200, body: { duplicate: check.map[id].order } };
      if (check.map[id]?.token === token) { held = true; break; }
    }
    if (!held && blocked) {
      console.error(`order_lock_busy payment=${id}`);
      return { status: 500, body: { error: "order_in_progress" } };
    }
    if (!held) console.error(`order_lock_unavailable payment=${id} reason=contended`);
    const result = await fn();
    if (held) {
      const name = result?.body?.order || result?.body?.duplicate || "";
      await commit(id, token, name);
    }
    return result;
  } catch (e) {
    if (held) await commit(id, token, "");
    throw e;
  }
}
