/**
 * api/blob-upload.js — Vercel Function (Node.js runtime, Web handler style)
 *
 * Authorizes CLIENT uploads to Vercel Blob. The browser talks to Blob storage
 * directly for the actual file bytes — this route only ever exchanges one
 * small JSON message (a token request). That's what lets a file bypass
 * Vercel's ~4.5 MB serverless request-body cap: the bytes never pass through
 * one of our functions at all.
 *
 * Requires a Blob store connected to this project (Vercel dashboard → Storage
 * → Create Database → Blob, access "Public"). Vercel auto-injects
 * BLOB_READ_WRITE_TOKEN once that store is connected — nothing to copy in.
 *
 * If this route or Blob itself fails (store not connected, Hobby storage quota
 * used up, an outage), apply.html retries and then falls back to emailing the
 * file through api/relay-file.js — an applicant's documents are never dropped
 * just because Blob is unavailable.
 *
 * Why named POST/OPTIONS exports instead of api/submit.js's req/res style:
 * @vercel/blob's handleUpload() is built around standard Fetch
 * Request/Response objects, and Vercel's Node runtime passes exactly those to
 * named HTTP-method exports. Do NOT move this to the Edge runtime
 * (`export const config = { runtime: 'edge' }`): @vercel/blob 2.x imports
 * Node-only modules (crypto, undici) and the deployment fails to build.
 */

import { handleUpload } from '@vercel/blob/client';

const DEFAULT_ORIGIN = 'https://aprilhstonepa.com';

// The browser SDK derives each upload's content type from the file extension,
// so these line up with the extensions apply.html's file pickers accept.
const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
];

// 500 MB per file. Blob itself accepts up to 5 TB; this is only a sanity cap.
// apply.html switches to multipart (chunked, per-part retried) uploads for
// anything over 8 MB, so large scans upload reliably.
const MAX_FILE_BYTES = 500 * 1024 * 1024;

// Burst limiter, same idea as api/submit.js: blunts a script trying to fill
// the Blob store (on the Hobby plan a full store locks Blob for 30 days).
// Generous enough for a real applicant's files plus apply.html's retries.
const RATE = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 60;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (RATE.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  RATE.set(ip, hits);
  if (RATE.size > 5000) {
    for (const [k, v] of RATE) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) RATE.delete(k);
    }
  }
  return hits.length > RATE_MAX;
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || DEFAULT_ORIGIN,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

export function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders() });
}

export function GET() {
  return json({ error: 'Method not allowed.' }, 405);
}

export async function POST(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    console.warn('blob-upload rate limited:', ip);
    return json({ error: 'Too many uploads. Please wait a few minutes.' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  try {
    // No onUploadCompleted: the browser gets blob.url back directly and
    // carries it into the form submission, so there's nothing to record
    // server-side — and no completion webhook that could fail on its own.
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_TYPES,
        addRandomSuffix: true, // unguessable URL suffix, since the resulting link doubles as the file's access control
        maximumSizeInBytes: MAX_FILE_BYTES,
      }),
    });
    return json(jsonResponse, 200);
  } catch (err) {
    console.error('blob-upload error:', err);
    return json({ error: (err && err.message) || 'Upload authorization failed.' }, 400);
  }
}
