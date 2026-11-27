# 6-inch L Rain Drum page (Shopify theme files)

Product: `gid://shopify/Product/15516011856054`, template suffix `rainsong-6inch`.
Live URL: https://madespecial.store/products/steel-tongue-rain-drum
(The handle was `6-inch-l-pro-drum` until 27 Nov 2026. No theme file hardcodes the handle. The upsell config matches on product and variant IDs, so the rename needs no code change.)

These files mirror the Shopify theme layout (`assets/`, `sections/`, `snippets/`, `templates/`) of the live theme "MadeSpecial – AR (Final)" (189208658102). Shopify is the source of truth: upload through the admin code editor. Don't push this folder over the live theme with a CLI sync, because the live theme has other files that aren't in this repo.

| File | md5 | Status (27 Nov 2026) |
|---|---|---|
| assets/rainsong6.js | 6e1055faf551959147410388180883c3 | live: $150/£120 RRP safety net + % off rounded to nearest |
| assets/rainsong6-addons.js | f7c44daa47fef9e0b2afe51693f0cb1a | live (6-inch drawer title: "9-Note Mini Drum: the perfect stocking filler for Christmas!") |
| sections/rainsong6-page.liquid | f2087e36ff02848c07e718f9c0c98ab3 | live: RRP safety net + rounding (has Dishant's unboxing video) |
| snippets/rainsong6-gallery.liquid | 6ab2f0cfa644f1a990078e64efb6cfab | live |
| snippets/rainsong6-info.liquid | 917b6fc8e679270f8a90762119f7efec | pending upload: on-page title "Margaret’s Hand Tuned Rain Drum" (t144u) + RRP + rounding + overflow fix + "Selling FAST" |
| templates/product.rainsong-6inch.json | 8ac167ec32fc72db68ae39148a13a6b3 | live |
| assets/rainsong.css | 9d31f4c23e5526e4fa25d5ab94bddb57 | live. Shared by the XL and 6-inch pages; it's the live file (6563dda5) with the mobile overflow fix appended at the end |

## Mobile overflow fix
The Judge.me review carousel (`.jdgm-cards-carousel .jdgm-videos-container`, about 28 cards) slides its card strip with a CSS transform, and no ancestor clipped it. On phones the page measured about 5,900px wide, so mobile browsers laid it out at 1,560px. The cart drawer and the sticky add-to-cart bar then sat off screen to the right. The fix clips the reviews section with `overflow-x: clip` (falling back to `hidden`), and also clips `html` and `body` on the rainsong pages as a safety net. `clip` doesn't create a scroll container, so sticky elements keep working.

The XL page has the matching eyebrow text change in `snippets/rainsong-info.liquid`; see `theme/patches/xl-rainsong-info-selling-fast.md`.

## $150 RRP (owner t141u–t143u, 27 Nov 2026)
Product compare-at is $150.00 on all 5 variants, and £120.00 in the UK price list (PriceList/30934368438). Prices are unchanged at $99.99 / £79.99.
The "was" prices are $150 / $300 / $450 / $600 (UK £120 / £240 / £360 / £480). Rounded to the nearest whole number, like Kaching, the % off is 33 / 47 / 56 / 58, and the banner reads "up to 58% OFF".
The theme also has an RRP safety net, so the page stays on the RRP even if the compare-at changes: `rs_rrp` in both Liquid files and `RS_RRP` in rainsong6.js. To remove it, delete the marked block or set `RS_RRP={}`.

## On-page title (owner t144u, 27 Nov 2026)
The page's H1 reads "Margaret’s Hand Tuned Rain Drum" (`rs6_title` in rainsong6-info.liquid), with the italic line "A gift that plays itself when it rains." under it.
The Shopify product name is still "*NEW* Hand Tuned Rain Drum (6 inch - L)", so cart, checkout, Whop, meta tags and JSON-LD are unchanged.
The countdown bar's "up to 58% OFF" on this page comes from `swapCountdownOff()` in rainsong6.js. The Essential app's text is unchanged store-wide.
