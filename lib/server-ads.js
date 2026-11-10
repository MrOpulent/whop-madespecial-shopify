// Server-side Purchase events for TikTok, Snapchat, and Pinterest.
// Called only after a Shopify order exists. Never throws. Does nothing unless SERVER_ADS_ENABLED is on.
// One order is sent to at most one network, and only when that network's own click id
// (ttclid, ScCid, epik) or utm_source / tw_source names it. The _ttp and _scid cookies are not
// evidence: almost every visitor has them. AppLovin-attributed orders are not sent.
//
// Env (all optional; a missing pixel id or token skips that network):
//   SERVER_ADS_ENABLED=true          master switch, default off
//   TIKTOK_EVENTS_TOKEN              Access-Token for Events API
//   TIKTOK_PIXEL_CODE                pixel code (known value: DB9H2D3C77U0NJ5DOPB0)
//   TIKTOK_TEST_EVENT_CODE           Events Manager test code; omit in production
//   SNAP_CAPI_TOKEN
//   SNAP_PIXEL_ID
//   SNAP_CAPI_VALIDATE=true          POST /events/validate instead of /events
//   PINTEREST_CAPI_TOKEN
//   PINTEREST_AD_ACCOUNT_ID          known account: 549770381859
//   PINTEREST_CAPI_TEST=true         adds ?test=true (not recorded)

import crypto from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export const SERVER_ADS_TIMEOUT_MS = 2500;

const TIKTOK_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const CHECKOUT_URL = () => String(process.env.CHECKOUT_URL || "https://checkout.madespecial.store").replace(/\/$/, "");

const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

export function serverAdsEnabled(env = process.env) {
  return on(env.SERVER_ADS_ENABLED);
}

export function eventIdFor(payId) {
  const id = String(payId ?? "").trim();
  return id ? `whop-${id}`.slice(0, 200) : "";
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function usableClickId(v) {
  const s = String(v ?? "").trim();
  if (s.length < 2 || s.length > 500) return "";
  if (/[\s{}<>]/.test(s)) return "";
  if (/^(undefined|null|none|n\/a|macro)$/i.test(s)) return "";
  return s;
}

// "tiktok", "TikTok Ads", "snap", "snapchat.com", "pinterest", "pin", "applovin", "axon".
// A whole token only, so "snapshot" and "shopping" do not match.
export function namedNetwork(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...names) => names.some((n) => tokens.includes(n));
  if (has("applovin", "axon")) return "applovin";
  if (has("tiktok")) return "tiktok";
  if (has("snap", "snapchat")) return "snap";
  if (has("pinterest", "pin")) return "pinterest";
  if (has("facebook", "meta", "instagram", "fb", "ig")) return "meta";
  return raw ? "other" : "";
}

function attrMap(attrs) {
  const map = new Map();
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || s === "undefined") continue;
    map.set(String(k).trim().toLowerCase(), s.slice(0, 2000));
  }
  return map;
}

function queryBags(map) {
  const bags = [];
  for (const v of map.values()) {
    if (!v.includes("?")) continue;
    try { bags.push(new URL(v, "https://madespecial.store").searchParams); }
    catch { /* not a url */ }
  }
  return bags;
}

function firstKey(map, re) {
  for (const [k, v] of map) if (re.test(k) && usableClickId(v)) return usableClickId(v);
  return "";
}

function firstQuery(bags, re) {
  for (const bag of bags) {
    for (const [k, v] of bag) {
      const id = usableClickId(v);
      if (re.test(k) && id) return id;
    }
  }
  return "";
}

function firstSource(map, bags, key) {
  const direct = map.get(key);
  if (direct) return direct.slice(0, 300);
  for (const bag of bags) {
    for (const [k, v] of bag) {
      if (k.toLowerCase() === key && String(v).trim()) return String(v).trim().slice(0, 300);
    }
  }
  return "";
}

// At most one of tiktok | snap | pinterest. "" means send nothing.
// tw_source wins over utm_source when both are present (Triple Whale's attribution).
// A click id and a source that name two different networks is a conflict: send nothing.
// AppLovin as the chosen source vetoes the other networks, including a stray click id.
export function selectNetwork(attrs) {
  const map = attrMap(attrs);
  const bags = queryBags(map);
  const click = new Set();
  if (firstKey(map, /^ttclid$/i) || firstQuery(bags, /^ttclid$/i)) click.add("tiktok");
  if (firstKey(map, /^(?:sccid|sc_click_id|_scclid)$/i) || firstQuery(bags, /^(?:sccid|sc_click_id|_scclid)$/i)) click.add("snap");
  if (firstKey(map, /^epik$/i) || firstQuery(bags, /^epik$/i)) click.add("pinterest");

  const tw = firstSource(map, bags, "tw_source");
  const utm = firstSource(map, bags, "utm_source");
  const chosen = tw || utm;
  const named = chosen ? namedNetwork(chosen) : "";
  if (named === "applovin") return "";

  const sourceHit = named === "tiktok" || named === "snap" || named === "pinterest" ? named : "";
  if (click.size > 1) return sourceHit && click.has(sourceHit) ? sourceHit : "";
  if (click.size === 1) {
    const only = [...click][0];
    if (sourceHit && sourceHit !== only) return "";
    return only;
  }
  return sourceHit;
}

// Which browser pixel may fire on this checkout. At most one.
// AppLovin orders fire none here: RedTrack already reports that purchase, and a browser Purchase
// would also be claimed by Meta, TikTok, Snapchat and Pinterest. Cookies (_fbp, _ttp, _scid) are not a click.
export function pixelNetwork(attrs) {
  const map = attrMap(attrs);
  const bags = queryBags(map);
  const named = namedNetwork(firstSource(map, bags, "tw_source") || firstSource(map, bags, "utm_source"));
  if (named === "applovin") return "applovin";
  const selected = selectNetwork(attrs);
  if (selected) return selected;
  if (firstKey(map, /^(?:aleid|_axeid)$/i) || firstQuery(bags, /^(?:aleid|_axeid)$/i)) return "applovin";
  if (named === "meta" || firstKey(map, /^fbclid$/i) || firstQuery(bags, /^fbclid$/i)) return "meta";
  return "";
}

function clickId(attrs, network) {
  const map = attrMap(attrs);
  const bags = queryBags(map);
  if (network === "tiktok") return firstKey(map, /^ttclid$/i) || firstQuery(bags, /^ttclid$/i);
  if (network === "snap") return firstKey(map, /^(?:sccid|sc_click_id|_scclid)$/i) || firstQuery(bags, /^(?:sccid|sc_click_id|_scclid)$/i);
  if (network === "pinterest") return (firstKey(map, /^epik$/i) || firstQuery(bags, /^epik$/i) || firstKey(map, /^_epik$/i)).slice(0, 500);
  return "";
}

function cookie(attrs, re) {
  const map = attrMap(attrs);
  for (const [k, v] of map) if (re.test(k)) return v.slice(0, 500);
  return "";
}

function rejectedSourceHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "admin.shopify.com" || host.endsWith(".myshopify.com");
}

function httpUrl(v) {
  const s = String(v || "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    if (rejectedSourceHost(u.hostname)) return "";
    return u.toString().slice(0, 1000);
  } catch { return ""; }
}

function landingUrl(attrs) {
  const map = attrMap(attrs);
  for (const key of ["landing_site", "landing_page", "landing_url", "page_url", "first_url"]) {
    const v = map.get(key);
    const abs = httpUrl(v);
    if (abs) return abs;
    if (v && v.startsWith("/")) {
      try { return new URL(v, "https://madespecial.store").toString().slice(0, 1000); }
      catch { /* skip */ }
    }
  }
  for (const v of map.values()) {
    const abs = httpUrl(v);
    if (abs && /[?&](ttclid|sccid|epik|utm_source)=/i.test(abs)) return abs;
  }
  return "";
}

function publicIp(raw) {
  let ip = String(raw || "").trim();
  if (!ip) return "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return "";
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return "";
    if (a === 169 && b === 254) return "";
    if (a === 172 && b >= 16 && b <= 31) return "";
    if (a === 192 && b === 168) return "";
    if (a === 100 && b >= 64 && b <= 127) return "";
    return ip;
  }
  if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return "";
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low)) return "";
  return ip;
}

export function hashEmail(email) {
  const trimmed = String(email ?? "").trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return "";
  return sha256(trimmed);
}

// TikTok wants E.164 including the leading plus, then SHA-256.
export function hashPhoneE164(raw, country) {
  const phone = e164(raw, country);
  return phone ? sha256(phone) : "";
}

// Snap and Pinterest want digits only, country code included, no plus, no leading zeros.
export function hashPhoneDigits(raw, country) {
  const phone = e164(raw, country);
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 8 ? sha256(digits) : "";
}

function e164(raw, country) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cc = country && /^[A-Za-z]{2}$/.test(String(country)) ? String(country).toUpperCase() : undefined;
  const n = parsePhoneNumberFromString(s, cc) || parsePhoneNumberFromString(s.startsWith("+") ? s : `+${s.replace(/\D/g, "")}`);
  return n && n.isValid() ? n.number : "";
}

function money(cents) {
  const n = Math.round(Number(cents));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n / 100).toFixed(2));
}

function eventTimeSec(paidAt) {
  const now = Math.floor(Date.now() / 1000);
  if (paidAt == null || paidAt === "") return now;
  if (typeof paidAt === "number" && Number.isFinite(paidAt)) {
    const sec = paidAt > 1e12 ? Math.floor(paidAt / 1000) : Math.floor(paidAt);
    return sec > 0 ? sec : now;
  }
  const t = Date.parse(String(paidAt));
  return Number.isFinite(t) ? Math.floor(t / 1000) : now;
}

function contents(lines, totalCents, names) {
  const parsed = (lines || []).map((l, i) => ({
    id: String(l?.[0] ?? ""),
    q: Math.max(1, Number(l?.[1]) || 1),
    u: Math.max(0, Math.round(Number(l?.[2]) || 0)),
    name: names && names[i] != null ? String(names[i]).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) : "",
  })).filter((l) => /^\d+$/.test(l.id));
  const gross = parsed.reduce((s, l) => s + l.q * l.u, 0);
  const due = Math.max(0, Math.round(Number(totalCents) || 0));
  return parsed.map((l) => {
    const paidUnit = gross > 0 ? Math.round((l.u * due) / gross) : l.u;
    return { id: l.id, quantity: l.q, price: Number((paidUnit / 100).toFixed(2)), ...(l.name && { name: l.name }) };
  });
}

function pageUrl(attrs, network, id) {
  const landing = landingUrl(attrs);
  const base = landing || `${CHECKOUT_URL()}/`;
  if (!id) return base;
  try {
    const u = new URL(base);
    const key = network === "tiktok" ? "ttclid" : network === "snap" ? "ScCid" : "epik";
    let has = false;
    for (const [k, v] of u.searchParams) if (k.toLowerCase() === key.toLowerCase() && usableClickId(v)) has = true;
    if (!has) u.searchParams.set(key, id);
    return u.toString().slice(0, 1000);
  } catch {
    return base;
  }
}

function missingConfig(network, env) {
  if (network === "tiktok") {
    if (!String(env.TIKTOK_EVENTS_TOKEN || "").trim()) return "no_token";
    if (!String(env.TIKTOK_PIXEL_CODE || "").trim()) return "no_pixel";
  }
  if (network === "snap") {
    if (!String(env.SNAP_CAPI_TOKEN || "").trim()) return "no_token";
    if (!String(env.SNAP_PIXEL_ID || "").trim()) return "no_pixel";
  }
  if (network === "pinterest") {
    if (!String(env.PINTEREST_CAPI_TOKEN || "").trim()) return "no_token";
    if (!String(env.PINTEREST_AD_ACCOUNT_ID || "").trim()) return "no_account";
  }
  return "";
}

function client(info) {
  const map = attrMap(info.attrs);
  const ip = publicIp(info.ip || map.get("client_ip_address") || map.get("ip_address") || map.get("ip") || "");
  const ua = String(info.ua || map.get("client_user_agent") || map.get("user_agent") || map.get("ua") || "")
    .replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300);
  return { ip, ua };
}

// Builds the request. Does not send. Returns { skipped } when the order should not be sent
// or the network is not configured. eventId is stable for a given Whop payment id.
export function buildServerAds(info, env = process.env) {
  const network = selectNetwork(info?.attrs);
  const eventId = eventIdFor(info?.payId);
  if (!network) return { network: "", eventId, skipped: "no_network" };
  if (!eventId) return { network, eventId: "", skipped: "no_payment_id" };
  const missing = missingConfig(network, env);
  if (missing) return { network, eventId, skipped: missing };
  const currency = String(info.currency || "").trim().toUpperCase();
  const value = money(info.totalCents);
  if (!/^[A-Z]{3}$/.test(currency) || value == null) return { network, eventId, skipped: "bad_money" };

  const email = hashEmail(info.email);
  const { ip, ua } = client(info);
  const id = clickId(info.attrs, network).slice(0, 500);
  const url = pageUrl(info.attrs, network, id);
  const orderId = String(info.orderName || info.payId || eventId).slice(0, 120);
  const items = contents(info.lines, info.totalCents, info.names);
  const when = eventTimeSec(info.paidAt);

  if (network === "tiktok") {
    const phone = hashPhoneE164(info.phone, info.country);
    const ttp = cookie(info.attrs, /^_ttp$/);
    const test = String(env.TIKTOK_TEST_EVENT_CODE || "").trim();
    const user = {
      ...(id && { ttclid: id }),
      ...(ttp && { ttp }),
      ...(email && { email }),
      ...(phone && { phone }),
      ...(ip && { ip }),
      ...(ua && { user_agent: ua }),
    };
    const body = {
      event_source: "web",
      event_source_id: String(env.TIKTOK_PIXEL_CODE).trim(),
      ...(test && { test_event_code: test }),
      data: [{
        event: "Purchase",
        event_time: when,
        event_id: eventId,
        user,
        page: { url },
        properties: {
          currency,
          value,
          order_id: orderId,
          ...(items.length && {
            content_type: "product",
            contents: items.map((item) => ({
              content_id: item.id,
              quantity: item.quantity,
              price: item.price,
              ...(item.name && { content_name: item.name }),
            })),
          }),
        },
      }],
    };
    return {
      network, eventId, body,
      url: TIKTOK_URL,
      headers: { "Content-Type": "application/json", "Access-Token": String(env.TIKTOK_EVENTS_TOKEN).trim() },
    };
  }

  if (network === "snap") {
    const phone = hashPhoneDigits(info.phone, info.country);
    const scCookie = cookie(info.attrs, /^_scid$/);
    const pixel = String(env.SNAP_PIXEL_ID).trim();
    const token = String(env.SNAP_CAPI_TOKEN).trim();
    const path = on(env.SNAP_CAPI_VALIDATE) ? "events/validate" : "events";
    const user_data = {
      ...(email && { em: [email] }),
      ...(phone && { ph: [phone] }),
      ...(ip && { client_ip_address: ip }),
      ...(ua && { client_user_agent: ua }),
      ...(id && { sc_click_id: id }),
      ...(scCookie && { sc_cookie1: scCookie }),
    };
    const body = {
      data: [{
        event_name: "PURCHASE",
        action_source: "WEB",
        event_time: when * 1000,
        event_id: eventId,
        event_source_url: url,
        user_data,
        custom_data: {
          currency,
          value,
          order_id: orderId,
          ...(items.length && { content_ids: items.map((item) => item.id), num_items: String(items.reduce((s, item) => s + item.quantity, 0)) }),
        },
      }],
    };
    return {
      network, eventId, body,
      url: `https://tr.snapchat.com/v3/${encodeURIComponent(pixel)}/${path}?access_token=${encodeURIComponent(token)}`,
      headers: { "Content-Type": "application/json" },
    };
  }

  const phone = hashPhoneDigits(info.phone, info.country);
  const account = String(env.PINTEREST_AD_ACCOUNT_ID).trim();
  const token = String(env.PINTEREST_CAPI_TOKEN).trim().replace(/^Bearer\s+/i, "");
  const test = on(env.PINTEREST_CAPI_TEST);
  const user_data = {
    ...(email && { em: [email] }),
    ...(phone && { ph: [phone] }),
    ...(ip && { client_ip_address: ip }),
    ...(ua && { client_user_agent: ua }),
    ...(id && { click_id: id }),
  };
  const body = {
    data: [{
      event_name: "checkout",
      action_source: "web",
      event_time: when,
      event_id: eventId,
      event_source_url: url,
      user_data,
      custom_data: {
        currency,
        value: value.toFixed(2),
        order_id: orderId,
        ...(items.length && { content_ids: items.map((item) => item.id), num_items: items.reduce((s, item) => s + item.quantity, 0) }),
      },
    }],
  };
  return {
    network, eventId, body,
    url: `https://api.pinterest.com/v5/ad_accounts/${encodeURIComponent(account)}/events${test ? "?test=true" : ""}`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  };
}

function shortError(text, secrets) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret && String(secret).length > 3) s = s.split(String(secret)).join("[redacted]");
  }
  s = s.replace(/access_token=[^&\s]+/gi, "access_token=[redacted]");
  s = s.replace(/bearer\s+\S+/gi, "Bearer [redacted]");
  return (s || "-").slice(0, 140);
}

function logSend(network, eventId, status, error) {
  console.log(`server_ads network=${network || "-"} event_id=${eventId || "-"} status=${status ?? "-"} error=${error || "-"}`);
}

function secretsOf(env) {
  return [env.TIKTOK_EVENTS_TOKEN, env.SNAP_CAPI_TOKEN, env.PINTEREST_CAPI_TOKEN, env.TIKTOK_TEST_EVENT_CODE]
    .map((v) => String(v || "").trim()).filter((v) => v.length > 3);
}

async function postJson(url, headers, body, ms) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      reject(e);
      ctrl.abort();
    }, ms);
  });
  const req = fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  // A late abort rejection must not surface as an unhandled rejection after the timeout wins.
  req.then(() => {}, () => {});
  try {
    return await Promise.race([req, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Never throws. Flag off, no matching network, and a missing pixel all return without a network call
// (a missing pixel is logged). A timeout or HTTP error is logged and swallowed.
export async function reportServerAds(info, env = process.env) {
  const secrets = secretsOf(env);
  try {
    if (!serverAdsEnabled(env)) return { skipped: "disabled" };
    let built;
    try { built = buildServerAds(info || {}, env); }
    catch (e) {
      logSend("-", eventIdFor(info?.payId), "-", shortError(e.message, secrets));
      return { error: "build_failed" };
    }
    if (!built.url) {
      if (built.skipped && built.skipped !== "no_network" && built.network) {
        logSend(built.network, built.eventId, "-", built.skipped);
      }
      return built;
    }
    const r = await postJson(built.url, built.headers, built.body, SERVER_ADS_TIMEOUT_MS);
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    let error = "-";
    if (built.network === "tiktok") {
      const code = parsed && typeof parsed === "object" ? parsed.code : undefined;
      if (!r.ok || code !== 0) error = shortError(parsed?.message || text || `http_${r.status}`, secrets);
    } else if (built.network === "snap") {
      const status = parsed && typeof parsed === "object" ? String(parsed.status || "") : "";
      if (!r.ok || (status && status !== "VALID" && status !== "VALID_WITH_WARNINGS")) {
        error = shortError(parsed?.reason || status || text || `http_${r.status}`, secrets);
      }
    } else {
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      const failed = events.filter((e) => e && e.status === "failed");
      if (!r.ok || failed.length) {
        error = shortError(failed.map((e) => e.error_message).filter(Boolean).join("; ") || parsed?.message || text || `http_${r.status}`, secrets);
      }
    }
    logSend(built.network, built.eventId, r.status, error);
    return { network: built.network, eventId: built.eventId, status: r.status, error: error === "-" ? "" : error };
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    const eventId = eventIdFor(info?.payId);
    const network = selectNetwork(info?.attrs);
    logSend(network, eventId, "-", timeout ? "timeout" : shortError(e?.message, secrets));
    return { network, eventId, error: timeout ? "timeout" : "request_failed" };
  }
}
