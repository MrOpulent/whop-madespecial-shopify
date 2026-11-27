# 6-inch L post-purchase flow (branch `cro/6inch-upsell`, based on main `ed6faea`)

For Dishant. The checkout already supports several post-purchase flows in one `UPSELL_OFFERS` list; each flow is
picked by the drum in the order (`if_any_variant` / `unless_any_variant`). This branch adds the 6-inch L flow as
config plus a small helper, with tests. **The XL Pro flow is unchanged** (tested: an XL order gets the exact same 3 offers).

Nothing is live. Production env was not touched. Turning it on needs the owner's approval (see "Go live").

## The 6-inch L flow (US / UK prices)
| Step | Shows when | Offer | Price | Compare (struck through) |
|---|---|---|---|---|
| 0 | any 6-inch L order | 1 more 6-inch L (Teal) | $59.99 / £47.99 | Shopify price of the 6-inch ($99.99 / £79.99) |
| 1 | step 0 declined, no 9-note in the order | 2x 9-note, second 50% off | $74.99 / £57.99 | $99.98 / £77.98 |
| 2 | step 1 declined, no 9-note in the order | 1x 9-note | $29.99 / £22.99 | $49.99 / £38.99 |

$59.99 / £47.99 is the second drum's price in the 2-pack ($159.99 - $99.99; UK £127.99 - £79.99 = £48.00). Accepting any step ends the flow (same as XL).
Step 0 has no reviews, rating or lifestyle gallery: the 6-inch is a new product, so it shows Shopify's variant image
only. Add real 6-inch photos to `media` once they exist. The 9-note steps are copied from the XL flow.
If a cart has both an XL Pro and a 6-inch, only the XL flow shows (the flows never mix).

## Files
- `api/upsell.js`: the variant filter moved into an exported `selectOffers(list, variantIds)` (same logic, now testable);
  doc lines for the optional `flow` label. No behavior change.
- `config/6inch-L-variants.json` (SKU -> variant id) and `config/upsell-6inch-L.json` (filled flow).
- `config/upsell-6inch-L.template.json`: the 3 offers, keyed by SKU placeholders
  (`"sku:6INCH-PRODRUM-TEAL-Q1"`, `"sku-prefix:6INCH-PRODRUM-"`). Unfilled placeholders never match, so the template is inert.
- `scripts/upsell-offers.mjs`: `fill` (placeholders -> variant ids), `merge` (add/replace one flow, keep the rest),
  `remove` (drop one flow), `check` (print the steps a cart gets). Prints JSON only; changes nothing.
- `test/upsell-flows.test.js`: flow selection, XL unchanged, template inert, merge/fill, and the 6-inch offer pages (USD + GBP).
- `e2e/offer-server.mjs`: optional 3rd arg `6inch` and `E2E_MARKET=US`; `e2e/offer_shots.py`: mobile shots of each step.

## Tests
`npm test` (node --test --experimental-test-module-mocks): 60/60 pass (48 existing + 12 new), with the real 6-inch ids.
Browser e2e (`e2e/offer_page.py`, fake Whop, run on the merged production value): XL 4/4 and 6-inch 4/4 (success after the final offer, success, pending -> paid, decline). One Whop charge per accept.

## Go live (after the owner approves)
The 6-inch L product exists (DRAFT): product 15516011856054, handle `steel-tongue-rain-drum`, $99.99. UK: fixed £79.99 on all 5 variants in the
"UK Pricing" price list (PriceList/30934368438), same method as the XL (£139.99). It applies once the product is in the UK market catalog (see 1).
Variant ids are in `config/6inch-L-variants.json`; `config/upsell-6inch-L.json` is the template filled with them.
1. Owner approves; the product is set ACTIVE and published to the Online Store (a draft can't be bought, so the flow can't trigger before that).
   Publish it to the Online Store, the Made Special.Store Headless channel (the XL is on both; the checkout most likely prices carts through Headless) and the
   UK market catalog (Publication/224563200182, like the XL). Until it is in the UK catalog Shopify converts it to £77.32.
   Kaching: the XL uses a separate UK-only deal with fixed GBP pack prices (9fbN); the 6-inch needs one too:
   1 £79.99, 2 £127.99, 3 £177.99, 4 £223.99 (US deal: $99.99 / $159.99 / $221.99 / $279.99, UK excluded).
2. The new value is ready: `UPSELL_OFFERS.new-production.json` (sha256 9e866695…4b7035) = the current production value
   (unchanged since 25 Nov, sha256 3698165d…5ee68c) + the 3 `6inch-L` offers. The XL offers are byte-for-byte the same.
   To rebuild it yourself: `node scripts/upsell-offers.mjs merge <current.json> config/upsell-6inch-L.json > new.json`
   Check: `node scripts/upsell-offers.mjs check new.json 68183895998646` -> 3 `[6inch-L]` steps;
   `... check new.json 68105383870646` -> the XL steps, unchanged.
3. Set Production `UPSELL_OFFERS` to that file's contents (Vercel > Settings > Environment Variables, or
   `vc env rm UPSELL_OFFERS production` + `vc env add UPSELL_OFFERS production < new.json`) and redeploy production (env changes need a new deployment).
   This branch's code change is not required for the flow to work; merging it only adds the helper, tests and config.

## Rollback
`node scripts/upsell-offers.mjs remove /tmp/new.json 6inch-L > /tmp/back.json`, set `UPSELL_OFFERS` to it and redeploy.

## Noticed, not changed
`idSet("")` in `api/upsell.js` reads an empty `declined=` as step 0, so the server alone would let a shopper who
accepted step 0 load step 1 (the page never asks, because it checks `hasAfterAccept`). Harmless today; worth a one-line fix.
