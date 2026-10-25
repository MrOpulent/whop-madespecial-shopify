// lib/shopify.js — Admin token (Dev Dashboard client credentials, auto-refresh) + GraphQL helpers.
// Env: SHOPIFY_STORE (xxx.myshopify.com), SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STOREFRONT_TOKEN
export const API = "2026-04";
const STORE = () => process.env.SHOPIFY_STORE;
let cache = { token: null, exp: 0 };

export async function adminToken() {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const r = await fetch(`https://${STORE()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`Shopify token ${r.status}: ${await r.text()}`);
  const j = await r.json();
  cache = { token: j.access_token, exp: Date.now() + ((j.expires_in || 86400) - 300) * 1000 };
  return cache.token;
}

export async function adminGql(query, variables) {
  const r = await fetch(`https://${STORE()}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await adminToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

export async function storefrontGql(query, variables) {
  const r = await fetch(`https://${STORE()}/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Shopify-Storefront-Private-Token": process.env.SHOPIFY_STOREFRONT_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
