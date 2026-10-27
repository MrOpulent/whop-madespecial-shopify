// api/whop-setup.js — one-time helpers, protected by SETUP_KEY.
//  • Apple Pay on your checkout domain:  /api/whop-setup?key=<SETUP_KEY>&domain=checkout.madespecial.store
//    (needs the API key permissions domain:read + domain:manage). Run again later to see the status.
//  • Shopify refunds/cancellations -> Whop refunds:  /api/whop-setup?key=<SETUP_KEY>&shopify_webhooks=1
//  • (Legacy Whop-hosted flow only) product with shipping address:  /api/whop-setup?key=<SETUP_KEY>&product=1
// Env: WHOP_API_KEY, WHOP_COMPANY_ID, SETUP_KEY
import { createShippingProduct, registerApplePayDomain, scopeProblem } from "../lib/whop.js";
import { adminGql } from "../lib/shopify.js";
import { baseUrl } from "../lib/http.js";

const SUBS = `query { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`;
const SUBS_OLD = `query { webhookSubscriptions(first: 100) { nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } } }`;
const SUB_CREATE = `mutation($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) { webhookSubscription { id topic uri } userErrors { field message } } }`;
const SUB_CREATE_OLD = `mutation($topic: WebhookSubscriptionTopic!, $uri: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $uri, format: JSON }) { webhookSubscription { id topic } userErrors { field message } } }`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.SETUP_KEY || req.query?.key !== process.env.SETUP_KEY) return res.status(403).json({ error: "add ?key=<SETUP_KEY>" });
  try {
    if (req.query.domain) {
      const domain = String(req.query.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const r = await registerApplePayDomain(domain);
      return res.status(r.ok ? 200 : 502).json({
        domain,
        apple_pay: r.data?.apple_pay ?? null,
        issues: r.data?.issues ?? null,
        whop_reply: r.ok ? undefined : r.data,
        fix: r.ok ? undefined : scopeProblem(r.data) || undefined,
        next: "apple_pay.state 'pending' = wait a few minutes and open this link again; 'ready' = done; 'action_required' = see issues.",
      });
    }
    if (req.query.shopify_webhooks) {
      const uri = `${baseUrl(req)}/api/shopify-webhook`;
      let have, legacy = false; // newer Shopify API: "uri"; older: "callbackUrl"
      try { have = (await adminGql(SUBS)).webhookSubscriptions.nodes; }
      catch { legacy = true; have = (await adminGql(SUBS_OLD)).webhookSubscriptions.nodes.map((w) => ({ ...w, uri: w.endpoint?.callbackUrl })); }
      const result = {};
      for (const topic of ["REFUNDS_CREATE", "ORDERS_CANCELLED"]) {
        if (have.some((w) => w.topic === topic && w.uri === uri)) { result[topic] = "already registered"; continue; }
        const r = await adminGql(legacy ? SUB_CREATE_OLD : SUB_CREATE, { topic, uri });
        const e = r.webhookSubscriptionCreate.userErrors;
        result[topic] = e.length ? { error: e } : "registered";
      }
      return res.status(200).json({ uri, result, next: "Refund or cancel a test order in Shopify and check Vercel Logs for step=refund_sent_to_whop" });
    }
    if (req.query.product) {
      if (process.env.WHOP_PRODUCT_ID) return res.status(200).json({ already_set: process.env.WHOP_PRODUCT_ID });
      const p = await createShippingProduct(req.query.title || "MadeSpecial order");
      return res.status(200).json({ WHOP_PRODUCT_ID: p.id, collect_shipping_address: p.collect_shipping_address ?? null });
    }
    return res.status(400).json({ error: "add &domain=checkout.yourstore.com (Apple Pay) or &product=1" });
  } catch (e) {
    console.error("whop_setup", e);
    return res.status(500).json({ error: String(e.message).slice(0, 400) });
  }
}
