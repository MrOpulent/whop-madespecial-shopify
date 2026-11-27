# layout/theme.liquid: 6-inch ?v= guard (t146u)

Live theme 189208658102 layout/theme.liquid went from md5 3d024dd2723c8c36780f56a8327971f0
to d5b57f4072a1b96b44cc87a4e3fdb5f6 (uploaded via the admin code editor, 27 Nov 2026).

Why: the theme's inline script turns `?v=X` into `?view=X` on every product page, which
rendered the old default product template on the 6-inch page (`/products/steel-tongue-rain-drum`).

Change (see `layout-theme-liquid-6inch-v-guard.diff`, a plain `diff old new`):
- the existing `?v=` script is wrapped in `{%- unless product.id == 15516011856054 -%}`, so the 6-inch product never swaps;
- a small guard strips a foreign `?view=` on that product only and reloads its own template, keeping `v` and all other params.

Every other product (XL, 9-note, Maria `?v=y`) keeps the old behavior; the script text is unchanged.
