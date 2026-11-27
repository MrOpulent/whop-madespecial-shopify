# Mobile screenshots of each offer step (390x844) against e2e/offer-server.mjs. No real payment is made.
# python3 e2e/offer_shots.py http://127.0.0.1:8787 <shots dir> <prefix>
import sys, json, urllib.request
from playwright.sync_api import sync_playwright
BASE, OUT, PRE = sys.argv[1], sys.argv[2], sys.argv[3]
ORDER = {"payment": "pay_parent", "email": "test@example.com", "ship": {"first_name": "Test", "last_name": "Buyer", "address1": "1 Main St", "city": "Chicago", "province": "IL", "zip": "60601", "country_code": "US"}}
tok = json.load(urllib.request.urlopen(f"{BASE}/__scenario?name=success"))["token"]
errs, seen = [], []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.add_init_script(f"if(!sessionStorage.getItem('e2e')){{sessionStorage.setItem('e2e','1');sessionStorage.setItem('ms-s', {json.dumps(tok)}); sessionStorage.setItem('ms-order', {json.dumps(json.dumps(ORDER))}); sessionStorage.removeItem('ms-ups');}}")
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE) or "madespecial.store/cdn" in r.request.url or "cdn.shopify.com" in r.request.url else r.abort())
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"{BASE}/?return=1&status=succeeded&payment=pay_parent", wait_until="domcontentloaded")
    for step in range(3):
        pg.wait_for_selector("#ups-yes", timeout=15000); pg.wait_for_timeout(1500)
        pg.screenshot(path=f"{OUT}/{PRE}_step{step}_atf.png")
        pg.screenshot(path=f"{OUT}/{PRE}_step{step}_full.png", full_page=True)
        seen.append({"step": step, "button": pg.inner_text("#ups-yes"), "text": pg.inner_text(".ppu")[:400] if pg.query_selector(".ppu") else ""})
        if step < 2:
            pg.click("#ups-no"); pg.wait_for_timeout(900)
    b.close()
print(json.dumps(seen, indent=1, ensure_ascii=False)); print("page errors:", errs)
sys.exit(1 if errs else 0)
