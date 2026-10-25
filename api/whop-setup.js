// api/whop-setup.js — ONE-TIME: creates the Whop product that collects a shipping address at checkout.
// Open https://<project>.vercel.app/api/whop-setup?key=<SETUP_KEY> once, copy the product id into
// the Vercel variable WHOP_PRODUCT_ID, redeploy. Running it again creates another product (harmless, but unneeded).
// Env: WHOP_API_KEY, WHOP_COMPANY_ID, SETUP_KEY
import { createShippingProduct } from "../lib/whop.js";

export default async function handler(req, res) {
  if (!process.env.SETUP_KEY || req.query?.key !== process.env.SETUP_KEY) return res.status(403).json({ error: "add ?key=<SETUP_KEY>" });
  if (process.env.WHOP_PRODUCT_ID) return res.status(200).json({ already_set: process.env.WHOP_PRODUCT_ID });
  try {
    const p = await createShippingProduct(req.query.title || "MadeSpecial order");
    return res.status(200).json({
      WHOP_PRODUCT_ID: p.id,
      collect_shipping_address: p.collect_shipping_address ?? "(not returned — confirm on a test checkout)",
      next: "Add WHOP_PRODUCT_ID in Vercel → Settings → Environment Variables, then Redeploy.",
    });
  } catch (e) {
    console.error("whop_setup", e);
    return res.status(500).json({ error: String(e.message).slice(0, 400) });
  }
}
