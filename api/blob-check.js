/**
 * api/blob-check.js — TEMPORARY diagnostic. Delete once uploads are working.
 *
 * Client uploads fail with "Access denied, please provide a valid token for
 * this resource." even though api/blob-upload.js issues a token successfully.
 * That narrows to the token itself rather than the upload code, but not to a
 * cause. This route exercises BLOB_READ_WRITE_TOKEN server-side and reports:
 *
 *   shape  — whether the stored value looks like a token at all (a paste that
 *            brought quotes, a "NAME=" prefix or a trailing newline along with
 *            it produces exactly this failure while still returning a token)
 *   read   — list(), the cheapest call that proves the token is accepted
 *   write  — put() then del(), which proves the token can actually store bytes
 *
 * Never returns the token's secret: only its length and the store id, which is
 * public anyway — it appears in the hostname of every public blob URL.
 *
 * Gated by ?key= so a passer-by can't enumerate the store's health.
 */

import { list, put, del } from '@vercel/blob';

const KEY = 'k9m2xq7';

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function describe(token) {
  // vercel_blob_rw_<storeId>_<secret>
  const parts = token.split('_');
  return {
    present: token.length > 0,
    length: token.length,
    prefixOk: token.startsWith('vercel_blob_rw_'),
    storeId: parts.length >= 4 ? parts[3] : null,
    underscoreSegments: parts.length,
    hasQuotes: /["']/.test(token),
    hasWhitespace: /\s/.test(token),
    hasVarNamePrefix: /BLOB_READ_WRITE_TOKEN/i.test(token),
  };
}

async function attempt(label, fn) {
  try {
    return { step: label, ok: true, detail: await fn() };
  } catch (err) {
    return { step: label, ok: false, error: (err && err.message) || String(err) };
  }
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get('key') !== KEY) {
    return json({ error: 'Not found.' }, 404);
  }

  const raw = process.env.BLOB_READ_WRITE_TOKEN || '';
  const shape = describe(raw);

  const read = await attempt('list', async () => {
    const res = await list({ limit: 1 });
    return { blobsFound: res.blobs.length };
  });

  const write = await attempt('put+del', async () => {
    const blob = await put('diagnostic/ping.txt', 'ok', {
      access: 'public',
      addRandomSuffix: true,
    });
    await del(blob.url); // leave the store exactly as we found it
    return { host: new URL(blob.url).host };
  });

  return json({ shape, read, write });
}
