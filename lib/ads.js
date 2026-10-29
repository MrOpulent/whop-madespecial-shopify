// Ad pixels for the checkout domain. Shopify's Meta, TikTok, Pinterest, Snapchat and AppLovin
// pixels only run on the store, so the checkout domain reports "pixel not found" and never
// receives checkout events. The store already copies click IDs into the session; this turns
// those IDs into what the checkout page needs to load the same pixels and keep RedTrack's click.
// Pixel IDs are the ones installed on madespecial.store. Override any of them with env vars.

const PIXEL = {
  meta: process.env.META_PIXEL_ID || "1735745454866548",
  tiktok: process.env.TIKTOK_PIXEL_ID || "DB9H2D3C77U0NJ5DOPB0",
  pinterest: process.env.PINTEREST_TAG_ID || "2613242346032",
  snap: process.env.SNAP_PIXEL_ID || "72a34e54-4d52-4807-ad88-c1c97e4c40f1",
  axon: process.env.AXON_EVENT_KEY || "39e4030b-05d4-4ccf-a868-d6a93ec89d02",
};

const money = (cents) => Math.round(Number(cents) || 0) / 100;

export function adsFor(s) {
  const attrs = s?.attrs && typeof s.attrs === "object" ? s.attrs : {};
  const map = new Map();
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === "") continue;
    map.set(String(k).toLowerCase(), String(v).slice(0, 300));
  }
  const get = (...keys) => {
    for (const k of keys) {
      const v = map.get(k.toLowerCase());
      if (v) return v;
    }
    return "";
  };
  const clickid = get("__clickid", "rtkclickid-store", "rtkclickid", "clickid", "rtkcid", "cid")
    || [...map.entries()].find(([k]) => k.includes("clickid"))?.[1]
    || "";
  const lines = Array.isArray(s?.order?.l) ? s.order.l : [];
  const disp = Array.isArray(s?.disp) ? s.disp : [];
  const contents = lines.map((l, i) => ({
    id: String(l[0]),
    qty: l[1],
    price: money(l[2]),
    name: String(disp[i]?.title || "").slice(0, 120),
  }));
  return {
    // Marketing cookies were refused on the store. null means the store never asked (US), which still tracks.
    ok: s?.cs?.m !== 0,
    clickid,
    redtrack: String(process.env.REDTRACK_TRACKING_ORIGIN || "https://trk.madespecial.store").replace(/\/$/, ""),
    eventId: String(s?.j || ""),
    currency: s?.cur || "USD",
    value: money(s?.tot),
    shopCurrency: s?.order?.sc || s?.cur || "USD",
    shopValue: money(s?.order?.st ?? s?.tot),
    numItems: contents.reduce((n, c) => n + (Number(c.qty) || 0), 0),
    contents,
    pixels: { ...PIXEL },
    ids: {
      fbclid: get("fbclid"),
      fbp: get("_fbp"),
      fbc: get("_fbc"),
      ttclid: get("ttclid"),
      ttp: get("_ttp"),
      sccid: get("sccid", "sc_click_id"),
      scid: get("_scid"),
      epik: get("epik", "_epik"),
      aleid: get("aleid", "_axeid"),
      alart: get("alart", "_axart"),
      axwrt: get("_axwrt"),
    },
  };
}
