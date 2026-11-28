# Live theme snapshot — 27 Nov 2026 (Asia/Dubai, UTC+4)

This folder is a md5-verified export of the **live** MadeSpecial Shopify theme.

| | |
|---|---|
| Store | madespecial.store (`0muhvz-sr`) |
| Theme name | 6-inch L preview (copy of AR Final, 27 Nov) |
| Theme ID | 190039490742 |
| Role | MAIN (published ~9:47 PM Dubai on 27 Nov 2026) |
| Theme `updatedAt` when exported | 27 Nov 2026, 10:10 PM Dubai (2026-11-27T18:10:04Z) |
| Exported | 27 Nov 2026, late evening Dubai |

This snapshot includes today's live edits: the green #0E2A1B redesign (home, collection `?view=ms`, Pocket / Pro / Plus PDPs), `ms-pdp-compare`, `ms-pdp-names`, `ms-promo` (65% banner override and Pocket $99 strikethrough), and the homepage video swap.

It does **not** change Shopify. It is a read-only copy for GitHub.

## File counts

The live theme has **451** files. This branch has **409** of them, each checked against an md5 taken from the live theme at export time.

| Folder | In this snapshot | Still missing |
|---|---:|---:|
| assets | 119 (complete) | 0 |
| config | 3 (complete) | 0 |
| layout | 2 (complete, including `theme.liquid`) | 0 |
| locales | 31 (all storefront locale JSON, including `en.default.json` and `id.json`) | 21 theme-editor `*.schema.json` files |
| sections | 92 | 5 |
| snippets | 119 (complete) | 0 |
| templates | 43 (including `product.rainsong-4inch.json`, `product.rainsong.json`, `collection.json`) | 16 legacy / alternate product JSON templates |
| **Total** | **409** | **42** |

The 42 missing files are listed in `MISSING-FILES.txt`. They were too large for the Shopify connector's payload limit in this pass:

- 21 locale schema files used by the theme editor (not the customer-facing storefront strings).
- 5 large sections: `blocky-main-product.liquid`, `blocky-testimonials.liquid`, `bky-video-testimonials.liquid`, `featured-product.liquid`, `main-product.liquid`.
- 16 older or alternate product JSON templates (Margaret / Evelyn / Maria / XL-pro variants). Live Pocket, Pro, and Plus templates **are** included, as are `sections/rainsong4-page.liquid` and `sections/rainsong-page.liquid`.

They can be filled in from a Shopify admin **Download theme file** zip of theme 190039490742, or a follow-up export.

Unchanged repo extras kept alongside this snapshot:

- `theme/README-6INCH.md`
- `theme/patches/`
- `theme/whop-cart-checkout.liquid`

Stock Dawn 15.x / 16.x files that matched the live md5 were taken from the official Shopify Dawn GitHub tags; every other file was pulled from the live theme. Custom and modified files were not substituted from Dawn.

Videos live on the Shopify CDN, not inside this theme: they are referenced by URL, not stored as theme assets. The only binary assets in the theme are `assets/blocky-placeholder.jpg` and `assets/sparkle.gif`, both included.

## Secret scan

The exported tree was scanned before commit for Shopify Admin API tokens (`shpat_` / `shpca_` / `shpss_`), PEM private keys, and AWS access keys. None were found. Nothing was excluded for secrecy. Locale UI strings such as `"password": "Password"` are copy, not secrets.

## Rollback (Shopify, not this PR)

This PR only adds theme source to GitHub. Rolling back the **live store**:

1. In Shopify admin (admin.shopify.com/store/0muhvz-sr) → Online Store → Themes, publish **MadeSpecial – AR (Final)** (theme 189208658102) or **BACKUP pre-redesign 27 Nov 2026** (theme 190046208182).
2. Set the 4-inch Pocket product (15423518245046, handle `steel-tongue-rain-drum-4-inch`) back to the `margar-47657-template` product template.

Do not publish old connector commit `f860704`. Do not re-save `base.css`, `collection.json`, `product.rainsong.json`, `product.xxl-premium.json`, or `rainsong-info.liquid` from a stale connector view.

## What is on the live site (for context)

- Home, collection (`/collections/all?view=ms`), Pocket (`product.rainsong-4inch`), Pro, and Plus pages in green #0E2A1B.
- New menu `main-menu-ms`: Home, Shop All Drums, Contact, Track Your Order.
- Cookie banner buttons were changed in the privacy settings UI (not a theme file).
