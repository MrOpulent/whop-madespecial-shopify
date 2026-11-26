# Patch notes: post-purchase offer fixes (branch `cro/rainsong-upsell`)

For Dishant. Production is running this branch now, deployed by CLI (see "Deployments"). **Please merge `cro/rainsong-upsell` into `main` before you deploy main again.** Production has `UPSELL_OFFERS` set, so deploying main without this branch would show the old offer UI with both bugs below.

## Commits on top of `main` (e3deac7)
1. `11b25f3` is a snapshot of what was live as `dpl_CA8yRddDpKQitUTvCFXeQZSvEwN7`: the upsell plus 2 downsells UI and the offer media.
2. The fix (this patch), plus one small follow-up commit.

## Bug 1: false "declined" message after a successful one-click charge
What went wrong: the add-on payment `pay_EZfvEcvr4awa8Q` (£22.99 + £1.38 tax) was created with status `open` and paid 898 ms later. `api/upsell.js` returned `open` immediately with no `client_secret`, and the page showed "Your payment was declined. You have not been charged." The buyer was told they were declined, but they had been charged.

Fix:
- **`api/upsell.js` (POST):** after the charge is created, the server polls Whop's `GET /payments/{id}/status` for up to 7 s (`UPSELL_POLL_MS`), falling back to `GET /payments/{id}`. It returns exactly one of these:
  - `paid`
  - `failed`, only on a definite failure: `canceled`, `requires_confirmation` with a `last_payment_error`, or payment `void`/`uncollectible` or substatus `failed`/`blocked`/…
  - `requires_action`, with the `client_secret` for 3DS
  - `pending`
  
  If Whop's outcome is unknown (network error, Whop 5xx, idempotency 409), the answer is `pending`, never a decline.
- **No double charge:**
  - Before charging, it lists the account's payments since the parent order and looks for one with `metadata.upsell_of = parent` and the same `step`. If a paid, pending or action-needed charge exists, it returns that charge instead of charging again. Only a confirmed-failed earlier attempt (for example, retrying with a new card) allows a new charge.
  - On top of that, the deterministic `Idempotency-Key` (`sha256(upsell:<parent>:<step>:<ctok|saved>)`) makes Whop replay the first request. Whop keeps the key for 24 h, and a 409 means "in progress", so it is retried once and then treated as `pending`.
- **New status call:** `GET /api/upsell?status=1&s=&payment=&step=[&id=]`. It only answers for the buyer's own order (checked through the session and the parent payment's `metadata.order`). It refuses any payment that isn't an add-on of that order.
- **`public/index.html`:**
  - A `pending` answer shows "Confirming your payment…" on the button, and the page polls the status call for about 60 s.
  - Paid shows the usual success state. A confirmed failure shows the decline. If it is still pending after 60 s, the page shows a calm note ("still being confirmed… you won't be charged twice"), and no further offer is shown.
  - 3DS uses `handleNextAction` as before. If 3DS doesn't finish, the page asks the server before saying anything.
  - On a bank-redirect return without a final status, it re-checks with the server.
  - The offer timer no longer closes the offer during a payment.
- **`lib/whop.js`:** added `getPaymentStatus`, `listRecentPayments` and `classifyPayment`.
- **`vercel.json`:** set `maxDuration: 30` for `api/upsell.js`, so the polling can't hit the function time limit.

## Bug 2: wrong price on the Shopify line
What went wrong: `fulfilUpsell` applied the offer's display "% off" (41%) to the Shopify variant price. The variant was already £22.99, so #7216 recorded £13.57.

Fix (`api/whop-webhook.js` `priceOfferLine`):
- It still adds the **real variant** (`orderEditAddVariant`), so SKU, inventory and fulfillment stay correct. It then reads that line's real price in the order's presentment currency and makes the line total exactly the amount charged before tax (`u.t` in `u.c`):
  - **Variant above the charge:** a discount for the difference. One unit gets an exact `fixedValue`. Several units get a precise `percentValue`, because a fixed amount may apply per unit. The result is read back from the discount allocations.
  - **Variant below the charge:** this happens with the 2 × 9-note pair at £57.99/$74.99, while Shopify's variant is £22.99/$29.99 each. It adds a custom line, "Post-purchase offer price adjustment", for the difference (£12.01/$15.01), with `requiresShipping: false` and `taxable: false`.
- Any mismatch is logged as `upsell_price_mismatch` and noted in the staff note.
- The staff note now reads "… <amount> <cur> before tax".
- The separate-order fallback now handles an offer priced above the variant (no negative discount).
- The offer amounts this produces:

  | Offer | GBP | USD |
  |---|---|---|
  | Final offer (one 9-note) | £22.99 (no discount) | $29.99 (no discount) |
  | Second XL Pro | £92.99 (£47.00 off £139.99) | $119.99 ($60.00 off $179.99) |
  | Pair of 9-notes | £45.98 + £12.01 adjustment | $59.98 + $15.01 adjustment |

- **Duplicates:** only the webhook (and the daily reconcile, which calls the same `fulfil`) adds the item. The thank-you page never writes to Shopify. Both paths check the tag `whop-<add-on pay id>` first, and the tag is added right after the edit is committed.
  - Remaining risk: two deliveries of the same webhook at exactly the same moment could both pass the tag check. That needs a lock, and is not addressed here.

## Tests (no real charge, no Shopify write)
- `npm test` runs `node --test --experimental-test-module-mocks`. All 42 tests pass: 20 new in `test/upsell.test.js` plus the existing ones. They use a fake Whop (global fetch) and mocked Shopify, and cover:
  - Charge outcomes:
    - open→paid after 900 ms reports paid (the real case)
    - immediate paid
    - definite decline
    - requires_action returns the client_secret
    - timeout returns pending, then the status call reports paid (with and without an id)
  - No double charge:
    - a simultaneous double tap creates one charge
    - a retry after paid charges nothing
    - a new card after a confirmed decline is allowed
  - Whop 5xx or network error returns pending
  - The status call refuses another order's payment
  - Offers still only show on XL Pro orders
  - The exact Shopify line price for £22.99, £92.99, $119.99, £57.99, $74.99, and several units
  - A webhook retry doesn't add the item twice
- **Browser test** (`e2e/offer-server.mjs` + `e2e/offer_page.py`): the real `public/index.html` plus the real `api/upsell.js` against a fake Whop, at 390 px mobile. All 4 scenarios pass:
  - final-offer success
  - upsell success
  - pending → "Confirming your payment…" → success
  - real decline
  
  To run it: `node --experimental-test-module-mocks e2e/offer-server.mjs 8787 <offers.json>`, then `python3 e2e/offer_page.py http://127.0.0.1:8787 <shots dir>`.

## Deployments (2026-11-26, Asia/Dubai UTC+4)
- **Preview:** `dpl_CR72xXB7U7GRJjULnbB2XhCDCM3q`, https://whop-madespecial-shopify-r6d82s8o6-black-inc.vercel.app. The first preview was `dpl_87zdq7rfYYDTUu9UfaqjoipywgGR`.
- **Production:** `dpl_3CFYmSAQwp6Yqs6ohaaJFf1j1eCb`, https://whop-madespecial-shopify-lcljaw5py-black-inc.vercel.app, aliased to https://checkout.madespecial.store. Created 00:26 Nov 26.
- **Env:** unchanged. `UPSELL_OFFERS` and `UPSELL_MINUTES=15` are still set on production. An optional new `UPSELL_POLL_MS` defaults to 7000.

## Rollback
Back to the previous live build (offers on, with the old bugs):
```bash
vc rollback dpl_CA8yRddDpKQitUTvCFXeQZSvEwN7 --scope black-inc --yes
```
Back to before the offers existed:
```bash
vc rollback dpl_GizgSUQ7XLtQhbHak56MkUFLv74H --scope black-inc --yes
vc env rm UPSELL_OFFERS production --scope black-inc --yes
vc env rm UPSELL_MINUTES production --scope black-inc --yes
```
(Run these from a directory linked to `whop-madespecial-shopify`, or add `--cwd`.) After a Vercel rollback, new production deploys don't take the domain automatically until you run `vc promote`.
