/**
 * api/blob-upload.js — Vercel Edge Function
 *
 * Authorizes CLIENT uploads to Vercel Blob. The browser talks to Blob storage
 * directly for the actual file bytes — this route only ever exchanges one
 * small JSON message (a token request). That's what lets a file bypass
 * Vercel's ~4.5 MB serverless request-body cap: the bytes never pass through
 * one of our functions at all.
 *
 * Requires a Blob store connected to this project (Vercel dashboard → Storage
 * → Create Database → Blob). Vercel auto-injects BLOB_READ_WRITE_TOKEN once
 * that store is connected — nothing to copy in manually.
 *
 * If this route or Blob itself fails (store not connected, Hobby storage quota
 * used up, an outage), apply.html retries and then falls back to emailing the
 * file through api/relay-file.js — an applicant's documents are never dropped
 * just because Blob is unavailable.
 *
 * Runs on the Edge runtime (not the classic req/res Node style used by
 * api/submit.js) because @vercel/blob's client-upload handshake is built
 * around the standard Fetch Request/Response objects.
 */

import { handleUpload } from '@vercel/blob/client';

export const config = { runtime: 'edge' };

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

function corsHeaders(origin) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default async function handler(request) {
  const origin = (typeof process !== 'undefined' && process.env && process.env.ALLOWED_ORIGIN) || DEFAULT_ORIGIN;
  const headers = corsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers });
  }

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    console.warn('blob-upload rate limited:', ip);
    return new Response(JSON.stringify({ error: 'Too many uploads. Please wait a few minutes.' }), { status: 429, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), { status: 400, headers });
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
    return new Response(JSON.stringify(jsonResponse), { status: 200, headers });
  } catch (err) {
    console.error('blob-upload error:', err);
    return new Response(
      JSON.stringify({ error: (err && err.message) || 'Upload authorization failed.' }),
      { status: 400, headers }
    );
  }
}
