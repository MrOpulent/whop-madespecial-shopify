// lib/session.js — the checkout session lives in a signed token in the checkout URL (no database needed).
// Signed with HMAC-SHA256 so nobody can change prices or items; expires after SESSION_HOURS (default 3).
// Secret: SESSION_SECRET if set, otherwise derived from WHOP_API_KEY (never exposed).
import crypto from "node:crypto";

const secret = () => process.env.SESSION_SECRET
  || crypto.createHash("sha256").update(`madespecial-checkout:${process.env.WHOP_API_KEY || ""}`).digest("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (data) => b64u(crypto.createHmac("sha256", secret()).update(data).digest());

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
  const want = Buffer.from(sign(body)), got = Buffer.from(sig || "");
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw err("session_invalid");
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw err("session_invalid"); }
  if (!p || p.v !== 1) throw err("session_invalid");
  if (Date.now() > p.exp) throw err("session_expired");
  return p;
}
