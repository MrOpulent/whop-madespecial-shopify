// checkout_started records kept for 30 days.
// Vercel runtime logs expire in about a day, so the same line is also stored as a private blob.
// No blob store connected: this does nothing and checkout continues as before.
// Connect a private Vercel Blob store (BLOB_STORE_ID, or BLOB_READ_WRITE_TOKEN) to the checkout project.
const PREFIX = "checkout-starts/";
const KEEP_DAYS = 30;

function configured() {
  return !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

export async function retainCheckoutStart(record) {
  if (!configured()) return;
  const write = (async () => {
    const { put } = await import("@vercel/blob");
    const day = String(record.t || new Date().toISOString()).slice(0, 10);
    const id = String(record.j || "unknown").replace(/[^\w-]/g, "").slice(0, 16) || "unknown";
    await put(`${PREFIX}${day}/${id}.json`, JSON.stringify(record), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  })().catch((e) => {
    console.error("checkout_log_retain", String(e?.message || e).slice(0, 200));
  });
  await Promise.race([write, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

// Drops checkout_started blobs older than 30 days. Called from the daily reconcile cron.
export async function pruneCheckoutStarts() {
  if (!configured()) return { skipped: true };
  const { list, del } = await import("@vercel/blob");
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  let cursor, removed = 0;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    const old = [];
    for (const b of page.blobs || []) {
      const m = String(b.pathname || "").match(/^checkout-starts\/(\d{4}-\d{2}-\d{2})\//);
      if (m && m[1] < cutoff) old.push(b.url);
    }
    if (old.length) { await del(old); removed += old.length; }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { removed };
}
