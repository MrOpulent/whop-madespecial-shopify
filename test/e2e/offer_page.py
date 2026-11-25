# Browser test of the real thank-you offer page (public/index.html) against test/e2e/offer-server.mjs (fake Whop).
# python3 test/e2e/offer_page.py http://127.0.0.1:8787 <shots dir>
import sys, json, urllib.request
from playwright.sync_api import sync_playwright
BASE, OUT = sys.argv[1], sys.argv[2]
ORDER = {"payment": "pay_parent", "email": "test@example.com", "ship": {"first_name": "Test", "last_name": "Buyer", "address1": "221 Crow Lane", "city": "Romford", "province": "", "zip": "RM7 0HA", "country_code": "GB"}}
results, errs = [], []
def scen(name):
    return json.load(urllib.request.urlopen(f"{BASE}/__scenario?name={name}"))["token"]
def creates():
    return json.load(urllib.request.urlopen(f"{BASE}/__creates"))["creates"]
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    def run(name, final_offer, expect):
        tok = scen(name)
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.add_init_script(f"sessionStorage.setItem('ms-s', {json.dumps(tok)}); sessionStorage.setItem('ms-order', {json.dumps(json.dumps(ORDER))}); sessionStorage.removeItem('ms-ups');")
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE) or "madespecial.store/cdn" in r.request.url else r.abort())
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(f"{name}: {e}"))
        pg.goto(f"{BASE}/?return=1&status=succeeded&payment=pay_parent", wait_until="domcontentloaded")
        pg.wait_for_selector("#ups-yes", timeout=15000)
        if final_offer:
            pg.click("#ups-no"); pg.wait_for_timeout(600); pg.wait_for_selector("#ups-yes", timeout=15000)
            pg.click("#ups-no"); pg.wait_for_timeout(600); pg.wait_for_selector("text=FINAL OFFER", timeout=15000)
        pg.click("#ups-yes")
        seen_confirming = False
        for _ in range(60):
            pg.wait_for_timeout(500)
            body = pg.inner_text("body")
            if "Confirming your payment" in body:
                if not seen_confirming: pg.screenshot(path=f"{OUT}/{name}_confirming.png")
                seen_confirming = True
            ok = pg.query_selector(".ups-ok"); err = (pg.inner_text("#ups-err") if pg.query_selector("#ups-err") else "")
            if ok or err.strip(): break
        okt = pg.inner_text(".ups-ok") if pg.query_selector(".ups-ok") else ""
        errt = pg.inner_text("#ups-err") if pg.query_selector("#ups-err") else ""
        pg.screenshot(path=f"{OUT}/{name}{'_final' if final_offer else ''}_result.png", full_page=False)
        r = {"scenario": name, "final_offer": final_offer, "success_msg": okt, "error_msg": errt, "saw_confirming": seen_confirming, "whop_creates": creates()}
        r["pass"] = expect(r); results.append(r); ctx.close()
    run("success", True, lambda r: "was added to your order" in r["success_msg"] and not r["error_msg"] and r["whop_creates"] == 1)
    run("success", False, lambda r: "was added to your order" in r["success_msg"] and not r["error_msg"] and r["whop_creates"] == 1)
    run("pending", False, lambda r: r["saw_confirming"] and "was added to your order" in r["success_msg"] and "declined" not in r["error_msg"] and r["whop_creates"] == 1)
    run("decline", False, lambda r: "declined" in r["error_msg"].lower() and not r["success_msg"])
    b.close()
print(json.dumps(results, indent=1)); print("page errors:", errs)
sys.exit(0 if all(r["pass"] for r in results) and not errs else 1)
