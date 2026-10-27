// lib/session.js — the checkout session lives in a signed token in the checkout URL (no database needed).
// Signed with HMAC-SHA256 so nobody can change prices or items; expires after SESSION_HOURS (default 3).
// Secret: SESSION_SECRET if set, otherwise derived from WHOP_API_KEY (never exposed).
import crypto from "node:crypto";

const derive = (key) => crypto.createHash("sha256").update(`madespecial-checkout:${key || ""}`).digest("hex");
const secret = () => process.env.SESSION_SECRET || derive(process.env.WHOP_API_KEY);
// While moving Whop accounts, checkout links signed before the switch stay valid
const oldSecrets = () => [process.env.SESSION_SECRET_OLD, process.env.WHOP_API_KEY_OLD && derive(process.env.WHOP_API_KEY_OLD), process.env.SESSION_SECRET && derive(process.env.WHOP_API_KEY)].filter(Boolean);
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (data, key = secret()) => b64u(crypto.createHmac("sha256", key).update(data).digest());

export function createSession(payload) {
  const hours = Number(process.env.SESSION_HOURS) || 3;
  const body = b64u(JSON.stringify({ ...payload, v: 1, exp: Date.now() + hours * 3600_000 }));
  return `${body}.${sign(body)}`;
}

// Returns the payload, or throws { code: "session_invalid" | "session_expired" }
export function readSession(token) {
  const err = (code) => Object.assign(new Error(code), { code, status: 400 });
  if (typeof token !== "string" || token.length > 12000 || !token.includes(".")) throw err("session_invalid");
  const [body, sig] = token.split(".");
  const got = Buffer.from(sig || "");
  const ok = [secret(), ...oldSecrets()].some((k) => { const want = Buffer.from(sign(body, k)); return want.length === got.length && crypto.timingSafeEqual(want, got); });
  if (!ok) throw err("session_invalid");
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw err("session_invalid"); }
  if (!p || p.v !== 1) throw err("session_invalid");
  if (Date.now() > p.exp) throw err("session_expired");
  return p;
}
