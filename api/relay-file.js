/**
 * api/relay-file.js — Vercel Serverless Function
 *
 * Backup delivery for intake documents. apply.html sends every document to
 * Vercel Blob first (see api/blob-upload.js), retrying a few times. Only if a
 * file still can't get there — Blob store not connected, Hobby storage quota
 * used up, an outage, the applicant's network blocking Blob — does the browser
 * send that file here instead, and it's emailed straight to TO_EMAIL.
 *
 * Vercel caps a request body at ~4.5 MB, so the browser sends each file in
 * pieces of at most 3 MB (~4 MB once base64-encoded), one request and one
 * email per piece:
 *   - a file of 3 MB or less arrives as one normal attachment;
 *   - a bigger file arrives as several emails with attachments named
 *     "statement.pdf.part01-of-04" etc. Save them all and open /rejoin.html
 *     to put the original file back together (entirely in the browser).
 *
 * Uses the same RESEND_API_KEY / TO_EMAIL / FROM_EMAIL as api/submit.js.
 * Each piece is one email, and Resend's free plan allows 100 emails a day.
 *
 * Security: this is a public endpoint that emails attachments to the firm, so
 * it only accepts the document extensions the form offers, validates every
 * piece's size and numbering, rate-limits by IP, and never lets user input
 * reach an email header without clean().
 */

const BRAND = 'April H. Stone P.A.';
const SITE = 'aprilhstonepa.com';
const DEFAULT_ORIGIN = 'https://aprilhstonepa.com';

// Keep in step with PART_BYTES / MAX_PARTS in apply.html and rejoin.html.
const PART_BYTES = 3000000;
const MAX_PARTS = 30;

const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'csv'];

// Burst limiter — see api/submit.js. Higher ceiling than submit.js because a
// single large file legitimately takes one request per piece.
const RATE = new Map();
const RATE_WINDOW_MS = 60 * 1000;
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

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown';

  if (rateLimited(ip)) {
    console.warn('relay-file rate limited:', ip);
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }

  const { RESEND_API_KEY, TO_EMAIL, FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !TO_EMAIL || !FROM_EMAIL) {
    console.error('Missing environment variables:', {
      RESEND_API_KEY: !!RESEND_API_KEY,
      TO_EMAIL: !!TO_EMAIL,
      FROM_EMAIL: !!FROM_EMAIL,
    });
    return res.status(500).json({
      error: 'The form is not configured yet. Please call the firm directly.',
    });
  }

  const data = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  const ref = String(data.ref || '');
  const fid = String(data.fid || '');
  const part = Number(data.part);
  const parts = Number(data.parts);
  const name = safeFilename(data.name);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const content = typeof data.content === 'string' ? data.content : '';
  const bytes = base64Bytes(content);

  const problem =
    !/^AHS-[A-Z0-9]{6}$/.test(ref) ? 'ref'
    : !/^[a-z0-9]{8}$/.test(fid) ? 'fid'
    : !Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS ? 'parts'
    : !Number.isInteger(part) || part < 1 || part > parts ? 'part'
    : !ALLOWED_EXT.includes(ext) ? 'file type'
    : content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content) ? 'encoding'
    : bytes < 1 || bytes > PART_BYTES || (part < parts && bytes !== PART_BYTES) ? 'piece size'
    : '';
  if (problem) {
    console.warn('relay-file rejected (' + problem + ') from', ip);
    return res.status(400).json({ error: 'Invalid file piece.' });
  }

  const bizName = clean(data.businessName) || 'Unknown Business';
  const split = parts > 1;
  const attachName = split ? `${name}.part${pad(part)}-of-${pad(parts)}` : name;
  const contactName = clean(data.contactName);
  const replyTo = buildReplyTo(contactName, data.contactEmail);

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
        // A retried piece (e.g. the browser never saw our response) reuses the
        // key, so Resend sends it once instead of emailing a duplicate.
        'Idempotency-Key': `relay-${ref}-${fid}-${part}`,
      },
      body: JSON.stringify({
        from: `${BRAND} <${FROM_EMAIL}>`,
        to: [TO_EMAIL],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject: `Document for ${bizName} — ${name}${split ? ` (part ${part} of ${parts})` : ''} [${ref}]`,
        html: relayEmail({
          bizName, ref, name, part, parts, contactName,
          size: Number(data.size) || 0,
          zone: data.zone === 'agreements' ? 'Advance agreement' : 'Bank statement',
        }),
        attachments: [{ filename: attachName, content }],
      }),
    });

    if (!resendRes.ok) {
      const detail = await resendRes.text();
      console.error('Resend error (relay-file):', resendRes.status, detail);
      return res.status(502).json({ error: 'Email delivery failed. Please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error in /api/relay-file:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}

/* ─────────────────────────  email  ───────────────────────── */

function relayEmail({ bizName, ref, name, size, zone, part, parts, contactName }) {
  const split = parts > 1;
  const sizeTxt = size ? `${(size / 1048576).toFixed(1)} MB` : '';
  const how = split
    ? `This file was too large for one email, so it was split into <strong>${parts} emails</strong>
       (this is part ${part}). Once all ${parts} have arrived, download every attachment ending in
       <em>-of-${pad(parts)}</em>, open <a href="https://${SITE}/rejoin.html" style="color:#8a6c30;font-weight:600">${SITE}/rejoin.html</a>,
       and select them together &mdash; it rebuilds the original file on your computer.`
    : 'The original file is attached to this email.';

  const r = (label, value) => value
    ? `<tr>
        <td style="padding:7px 14px;color:#7c766a;font-size:12px;white-space:nowrap;vertical-align:top;width:38%;border-bottom:1px solid #efeae0">${esc(label)}</td>
        <td style="padding:7px 14px;color:#1c1a15;font-size:13px;font-weight:600;vertical-align:top;border-bottom:1px solid #efeae0">${esc(value)}</td>
      </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:#f0ebe3;font-family:Georgia,'Times New Roman',serif">
<div style="max-width:640px;margin:0 auto;background:#faf8f4;border:1px solid #d4cec5;border-radius:3px;overflow:hidden">

  <div style="background:#1c1a15;padding:22px 26px;border-bottom:2px solid #8a6c30">
    <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#bd9a52;margin-bottom:6px">${esc(BRAND)}</div>
    <div style="font-size:21px;color:#faf8f4;font-weight:400;margin-bottom:4px">Intake Document${split ? ` &mdash; Part ${part} of ${parts}` : ''}</div>
    <div style="font-size:11px;color:#8a847a">Reference ${esc(ref)}</div>
  </div>

  <div style="padding:24px 26px">
    <div style="margin-bottom:22px">
      <div style="background:#1c1a15;color:#bd9a52;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:8px 14px">Document</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4dfd3;border-top:none">
        ${r('Business', bizName)}${r('Contact', contactName)}${r('Type', zone)}${r('File', name)}${r('Full size', sizeTxt)}${r('Reference', ref)}
      </table>
    </div>
    <div style="padding:12px 14px;background:#fff;border:1px solid #e4dfd3;border-left:3px solid #8a6c30;font-size:13px;color:#46423a;line-height:1.6">
      ${how}
    </div>
    <p style="font-size:12px;color:#7c766a;line-height:1.6;margin:16px 0 0">
      Sent automatically because this document couldn't reach the firm's document storage when the
      applicant uploaded it. Their intake form, once submitted, arrives as its own email with the same reference.
    </p>
  </div>

</div>
</body>
</html>`;
}

/* ─────────────────────────  utilities  ───────────────────────── */

// Strip CR/LF so user input can never inject extra email headers, and cap length.
function clean(v, max = 300) {
  if (v == null) return '';
  return String(v).replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, max);
}

function safeFilename(name) {
  return clean(name, 120).replace(/[\u0000-\u001f/\\"]+/g, '-') || 'document';
}

function buildReplyTo(name, email) {
  const e = clean(email, 200);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) return undefined;
  const n = clean(name, 100).replace(/[<>"]/g, '');
  return n ? `${n} <${e}>` : e;
}

function base64Bytes(s) {
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
