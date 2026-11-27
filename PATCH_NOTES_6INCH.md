# 6-inch L post-purchase flow (branch `cro/6inch-upsell`, based on main `ed6faea`)

For Dishant. The checkout already supports several post-purchase flows in one `UPSELL_OFFERS` list; each flow is
picked by the drum in the order (`if_any_variant` / `unless_any_variant`). This branch adds the 6-inch L flow as
config plus a small helper, with tests. **The XL Pro flow is unchanged** (tested: an XL order gets the exact same 3 offers).

Nothing is live. Production env was not touched. Turning it on needs the owner's approval (see "Go live").

## The 6-inch L flow (US / UK prices)
| Step | Shows when | Offer | Price | Compare (struck through) |
|---|---|---|---|---|
| 0 | any 6-inch L order | 1 more 6-inch L (Teal) | $59.99 / £46.99 | Shopify price of the 6-inch ($99.99) |
| 1 | step 0 declined, no 9-note in the order | 2x 9-note, second 50% off | $74.99 / £57.99 | $99.98 / £77.98 |
| 2 | step 1 declined, no 9-note in the order | 1x 9-note | $29.99 / £22.99 | $49.99 / £38.99 |

$59.99 is the same per-drum price the 2-pack gives ($159.99 - $99.99). Accepting any step ends the flow (same as XL).
Step 0 has no reviews, rating or lifestyle gallery: the 6-inch is a new product, so it shows Shopify's variant image
only. Add real 6-inch photos to `media` once they exist. The 9-note steps are copied from the XL flow.
If a cart has both an XL Pro and a 6-inch, only the XL flow shows (the flows never mix).

## Files
- `api/upsell.js`: the variant filter moved into an exported `selectOffers(list, variantIds)` (same logic, now testable);
  doc lines for the optional `flow` label. No behavior change.
- `config/upsell-6inch-L.template.json`: the 3 offers, keyed by SKU placeholders
  (`"sku:6INCH-PRODRUM-TEAL-Q1"`, `"sku-prefix:6INCH-PRODRUM-"`). Unfilled placeholders never match, so the template is inert.
- `scripts/upsell-offers.mjs`: `fill` (placeholders -> variant ids), `merge` (add/replace one flow, keep the rest),
  `remove` (drop one flow), `check` (print the steps a cart gets). Prints JSON only; changes nothing.
- `test/upsell-flows.test.js`: flow selection, XL unchanged, template inert, merge/fill, and the 6-inch offer pages (USD + GBP).
- `e2e/offer-server.mjs`: optional 3rd arg `6inch` and `E2E_MARKET=US`; `e2e/offer_shots.py`: mobile shots of each step.

## Tests
`npm test` (node --test --experimental-test-module-mocks): 59/59 pass (48 existing + 11 new).
Browser e2e (`e2e/offer_page.py`, fake Whop): XL 4/4 and 6-inch 4/4 (success after the final offer, success, pending -> paid, decline). One Whop charge per accept.

## Go live (after the owner approves)
1. The 6-inch product exists with SKUs `6INCH-PRODRUM-<COLOR>-Q1` (Teal must exist; step 0 offers Teal).
   Set its UK market price; if it is not £77.99, adjust the GBP prices in the template (keep step 0 at about 60% of it).
2. Build the new value (needs the SHOPIFY_* env for `--shopify`, or pass `--ids map.json` of {"SKU": variantId}):
   ```bash
   node scripts/upsell-offers.mjs fill config/upsell-6inch-L.template.json --shopify > /tmp/six.json
   # current production value saved to /tmp/current.json (Vercel dashboard > Settings > Environment Variables > UPSELL_OFFERS)
   node scripts/upsell-offers.mjs merge /tmp/current.json /tmp/six.json > /tmp/new.json
   node scripts/upsell-offers.mjs check /tmp/new.json <a 6-inch variant id>     # expect 3 [6inch-L] steps
   node scripts/upsell-offers.mjs check /tmp/new.json 68105383870646            # expect the XL steps, unchanged
   ```
3. Replace `UPSELL_OFFERS` on Production with `/tmp/new.json` and redeploy (env changes need a new deployment).
   This branch's code change is not required for the flow to work: the current production code already handles it.
   Merging the branch only adds the helper, tests and template.

## Rollback
`node scripts/upsell-offers.mjs remove /tmp/new.json 6inch-L > /tmp/back.json`, set `UPSELL_OFFERS` to it and redeploy.

## Noticed, not changed
`idSet("")` in `api/upsell.js` reads an empty `declined=` as step 0, so the server alone would let a shopper who
accepted step 0 load step 1 (the page never asks, because it checks `hasAfterAccept`). Harmless today; worth a one-line fix.
