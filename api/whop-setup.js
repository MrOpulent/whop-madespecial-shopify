// api/whop-setup.js — one-time helpers, protected by SETUP_KEY.
//  • Apple Pay on your checkout domain:  /api/whop-setup?key=<SETUP_KEY>&domain=checkout.madespecial.store
//    (needs the API key permissions domain:read + domain:manage). Run again later to see the status.
//  • Shopify refunds, cancellations, and tracking -> Whop:  /api/whop-setup?key=<SETUP_KEY>&shopify_webhooks=1
//  • Tracking already on old PayPal orders -> Whop:  /api/whop-setup?key=<SETUP_KEY>&paypal_tracking=1
//    Repeat with &cursor=<next_cursor> until next_cursor is null.
//  • Check one payment's shipment:  /api/whop-setup?key=<SETUP_KEY>&check_shipment=pay_…
//  • (Legacy Whop-hosted flow only) product with shipping address:  /api/whop-setup?key=<SETUP_KEY>&product=1
// Env: WHOP_API_KEY, WHOP_COMPANY_ID, SETUP_KEY
import { createShippingProduct, getPayment, getShipment, registerApplePayDomain, scopeProblem } from "../lib/whop.js";
import { adminGql } from "../lib/shopify.js";
import { baseUrl } from "../lib/http.js";
import { syncPaypalTracking } from "./shopify-webhook.js";

export const config = { maxDuration: 60 };

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
      for (const topic of ["REFUNDS_CREATE", "ORDERS_CANCELLED", "FULFILLMENTS_CREATE", "FULFILLMENTS_UPDATE"]) {
        if (have.some((w) => w.topic === topic && w.uri === uri)) { result[topic] = "already registered"; continue; }
        const r = await adminGql(legacy ? SUB_CREATE_OLD : SUB_CREATE, { topic, uri });
        const e = r.webhookSubscriptionCreate.userErrors;
        result[topic] = e.length ? { error: e } : "registered";
      }
      return res.status(200).json({ uri, result, next: "Refunds and cancels log step=refund_sent_to_whop. A PayPal order with a tracking number logs step=paypal_tracking_sent." });
    }
    if (req.query.check_shipment) {
      const id = String(req.query.check_shipment).trim();
      if (!/^pay_[A-Za-z0-9]+$|^ship_[A-Za-z0-9]+$/.test(id)) {
        return res.status(400).json({ error: "check_shipment must be a pay_… or ship_… id from the Shopify order" });
      }
      let shipment = null, payment = null;
      try { shipment = await getShipment(id); }
      catch (e) {
        if (!/Whop 404/.test(String(e.message || ""))) throw e;
      }
      if (id.startsWith("pay_")) {
        try {
          payment = await getPayment(id);
          payment = {
            id: payment.id,
            status: payment.status,
            payment_method_type: payment.payment_method_type || payment.payment_instrument?.payment_method_type || null,
            missing_tracking: payment.missing_tracking,
            needs_tracking: payment.needs_tracking,
            holds: payment.holds || [],
          };
        } catch (e) {
          if (!/Whop 404/.test(String(e.message || ""))) throw e;
        }
      }
      const found = !!(shipment && shipment.id);
      return res.status(found || payment ? 200 : 404).json({
        found,
        shipment: found ? {
          id: shipment.id,
          payment_id: shipment.payment_id,
          tracking_number: shipment.tracking_number,
          tracking_url: shipment.tracking_url,
          carrier: shipment.carrier,
          status: shipment.status,
        } : null,
        payment,
        next: found
          ? "Whop has this shipment. The payment page may not show a Shipments panel; this API reply is the source of truth."
          : "No shipment on Whop for this id. Re-run paypal_tracking for that order, or confirm the Shopify whop_payment_id matches the Whop payment you opened.",
      });
    }
    if (req.query.paypal_tracking) {
      const cursor = String(req.query.cursor || "").slice(0, 2000) || null;
      const result = await syncPaypalTracking(adminGql, { cursor });
      return res.status(result.retry ? 500 : 200).json({
        ...result,
        next: result.retry
          ? "Whop did not accept every order on this page. Open this same link again."
          : result.next_cursor
            ? "Open this same link again with &cursor= set to next_cursor. Repeat until next_cursor is null."
            : "Done. Shipped PayPal orders from this pass are now on their Whop payments.",
      });
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
