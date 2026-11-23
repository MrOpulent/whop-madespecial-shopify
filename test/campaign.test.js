import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { campaignTags } from "../lib/campaign.js";
import { journey } from "../lib/http.js";
import { retainCheckoutStart } from "../lib/checkout-log.js";

describe("checkout campaign log", () => {
  test("records the visit tags that are present and skips blanks", () => {
    const tags = campaignTags(
      { tw_source: "tiktok", TW_ADID: "ad-99", utm_campaign: "spring", cmpid: "c1", gclid: "", gbraid: "gb12345678", utm_content: "  " },
      { utm_source: "google", tw_source: "stale", wbraid: "wb12345678" },
    );
    assert.deepEqual(tags, {
      tw_source: "tiktok",
      tw_adid: "ad-99",
      utm_source: "google",
      utm_campaign: "spring",
      cmpid: "c1",
      gbraid: "gb12345678",
      wbraid: "wb12345678",
    });
  });

  test("checkout_started line keeps the campaign tags", () => {
    const lines = [];
    const real = console.log;
    console.log = (line) => lines.push(line);
    try {
      const tags = campaignTags({ utm_source: "snap", tw_campaign: "rain", cmpid: "44" });
      journey("abc123", "checkout_started", { total: 4900, currency: "USD", market: "US", items: 1, clickid: "rtk1", ...tags }, false, 4000);
    } finally {
      console.log = real;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^JOURNEY j=abc123 step=checkout_started /);
    const data = JSON.parse(lines[0].replace(/^JOURNEY j=\S+ step=\S+ /, ""));
    assert.equal(data.clickid, "rtk1");
    assert.equal(data.utm_source, "snap");
    assert.equal(data.tw_campaign, "rain");
    assert.equal(data.cmpid, "44");
    assert.equal(data.gclid, undefined);
  });

  test("retention is a no-op until a blob store is connected", async () => {
    delete process.env.BLOB_STORE_ID;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await retainCheckoutStart({ j: "abc", t: "2026-11-23T00:00:00.000Z" });
  });
});
