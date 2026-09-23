/**
 * api/submit.js — Vercel Serverless Function
 *
 * Receives a JSON POST from consultation.html or apply.html, builds a styled
 * HTML email, and delivers it through Resend. Uploaded documents travel as
 * Vercel Blob links (see api/blob-upload.js), never as bytes through this
 * function — that's what lets a submission carry files of any real size.
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables).
 * Nothing here is hardcoded — set all three, then REDEPLOY, because saving env
 * vars alone does not update a live deployment:
 *
 *   RESEND_API_KEY   your Resend key (starts with "re_")
 *   TO_EMAIL         where submissions land, e.g. AprilHStonePA@gmail.com
 *   FROM_EMAIL       a sender on a domain VERIFIED IN RESEND. This cannot be a
 *                    gmail.com address. Before the domain is verified, use
 *                    onboarding@resend.dev for testing.
 *
 * Optional:
 *   ALLOWED_ORIGIN   locks CORS to one origin, e.g. https://aprilhstonepa.com
 *                    Falls back to DEFAULT_ORIGIN below.
 */

const BRAND = 'April H. Stone P.A.';
const SITE = 'aprilhstonepa.com';
const DEFAULT_ORIGIN = 'https://aprilhstonepa.com';

// Burst limiter. Warm serverless instances keep this Map between invocations,
// which is enough to blunt scripted floods. Not a distributed limiter — if
// abuse becomes a real problem, move this to Upstash/Redis.
const RATE = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 5;

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
    console.warn('Rate limited:', ip);
    return res.status(429).json({ error: 'Too many submissions. Please wait a minute and try again.' });
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

  // Honeypot: a real person never sees that field, so anything in it is a bot.
  // Return 200 so the bot believes it succeeded and does not retry.
  if (typeof data.website === 'string' && data.website.trim() !== '') {
    console.warn('Honeypot triggered from', ip);
    return res.status(200).json({ ok: true });
  }

  const isConsultation = data.formType === 'consultation';
  const formLabel = isConsultation ? 'Consultation Request' : 'Debt Restructuring Review';
  const bizName = clean(data.businessName) || 'Unknown Business';

  // Reply-To the submitter so hitting Reply writes straight back to them.
  const contactEmail = clean(data.email) || clean(data.own1Email);
  const contactName = clean(data.name) || clean(data.own1Name);
  const replyTo = buildReplyTo(contactName, contactEmail);

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${BRAND} <${FROM_EMAIL}>`,
        to: [TO_EMAIL],
        ...(copyList().length ? { bcc: copyList() } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject: `${formLabel}: ${bizName}`,
        html: isConsultation
          ? consultationEmail(data)
          : intakeEmail(data),
      }),
    });

    if (!resendRes.ok) {
      const detail = await resendRes.text();
      console.error('Resend error:', resendRes.status, detail);
      return res.status(502).json({ error: 'Email delivery failed. Please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error in /api/submit:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}

/* ─────────────────────────  sanitising  ───────────────────────── */

// Strip CR/LF so user input can never inject extra email headers, and cap length.
// Maintenance copies. COPY_EMAIL (comma-separated) gets a blind copy of each
// submission so delivery failures are visible without waiting for a report.
// Unset the variable in Vercel to switch the copies off.
function copyList() {
  return String(process.env.COPY_EMAIL || '')
    .split(',')
    .map((addr) => addr.trim())
    .filter(Boolean);
}

function clean(v, max = 300) {
  if (v == null) return '';
  return String(v).replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, max);
}

function buildReplyTo(name, email) {
  const e = clean(email, 200);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) return undefined;
  const n = clean(name, 100).replace(/[<>"]/g, '');
  return n ? `${n} <${e}>` : e;
}

/* ─────────────────────────  email building blocks  ───────────────────────── */

function row(label, value) {
  const v = clean(value, 2000);
  if (!v) return '';
  return `<tr>
    <td style="padding:7px 14px;color:#7c766a;font-size:12px;white-space:nowrap;vertical-align:top;width:38%;border-bottom:1px solid #efeae0">${esc(label)}</td>
    <td style="padding:7px 14px;color:#1c1a15;font-size:13px;font-weight:600;vertical-align:top;border-bottom:1px solid #efeae0">${esc(v)}</td>
  </tr>`;
}

function section(title, rows) {
  const body = rows.filter(Boolean).join('');
  if (!body) return '';
  return `
  <div style="margin-bottom:22px">
    <div style="background:#1c1a15;color:#bd9a52;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:8px 14px">${esc(title)}</div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4dfd3;border-top:none">${body}</table>
  </div>`;
}

function shell(heading, inner, replyName) {
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:#f0ebe3;font-family:Georgia,'Times New Roman',serif">
<div style="max-width:640px;margin:0 auto;background:#faf8f4;border:1px solid #d4cec5;border-radius:3px;overflow:hidden">

  <div style="background:#1c1a15;padding:22px 26px;border-bottom:2px solid #8a6c30">
    <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#bd9a52;margin-bottom:6px">${esc(BRAND)}</div>
    <div style="font-size:21px;color:#faf8f4;font-weight:400;margin-bottom:4px">${esc(heading)}</div>
    <div style="font-size:11px;color:#8a847a">${esc(now)}</div>
  </div>

  <div style="padding:24px 26px">
    ${inner}
  </div>

  <div style="background:#1c1a15;padding:12px 26px;font-size:11px;color:#8a847a;border-top:1px solid #2d2b27">
    Submitted through ${esc(SITE)}. <strong style="color:#bd9a52">Reply</strong> to this email to reach ${esc(replyName || 'the sender')}.
  </div>

</div>
</body>
</html>`;
}

/* ─────────────────────────  consultation template  ───────────────────────── */

function consultationEmail(data) {
  const msg = clean(data.message, 5000);
  const message = msg
    ? `<div style="margin-bottom:22px">
         <div style="background:#1c1a15;color:#bd9a52;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:8px 14px">Message</div>
         <div style="background:#fff;border:1px solid #e4dfd3;border-top:none;padding:14px;color:#1c1a15;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(String(data.message).slice(0, 5000))}</div>
       </div>`
    : '';

  const inner = section('Contact', [
    row('Name', data.name),
    row('Email', data.email),
    row('Phone', data.phone),
    row('Business', data.businessName),
  ]) + message;

  return shell('Consultation Request', inner, clean(data.name));
}

/* ─────────────────────────  intake template  ───────────────────────── */

function ownerSection(data, i) {
  const name = clean(data[`own${i}Name`]);
  if (!name) return '';
  const ordinals = ['First', 'Second', 'Third', 'Fourth'];
  const digits = String(data[`own${i}Ssn`] || '').replace(/\D/g, '');
  const masked = digits ? `•••-••-${digits.slice(-4)}` : '';
  const pct = clean(data[`own${i}Pct`]);

  return section(`${ordinals[i - 1]} Owner`, [
    row('Name', name),
    row('Ownership %', pct ? `${pct}%` : ''),
    row('Date of Birth', data[`own${i}Dob`]),
    row('SSN (last 4)', masked),
    row('Phone', data[`own${i}Phone`]),
    row('Home Address', data[`own${i}Address`]),
    row('Email', data[`own${i}Email`]),
  ]);
}

function debtTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const cols = [
    ['funder', 'Funder'], ['originalAmt', 'Original'], ['balance', 'Balance'],
    ['payment', 'Payment'], ['frequency', 'Frequency'], ['endDate', 'Ending'],
  ];
  const thead = cols
    .map(([, l]) => `<th style="padding:6px 10px;text-align:left;font-size:11px;border:1px solid #e4dfd3;color:#7c766a;background:#faf8f4;white-space:nowrap">${esc(l)}</th>`)
    .join('');
  const tbody = rows.slice(0, 40)
    .map((r) => `<tr>${cols.map(([k]) => `<td style="padding:6px 10px;font-size:12px;color:#1c1a15;border:1px solid #e4dfd3;white-space:nowrap">${esc(clean(r[k], 120) || '')}</td>`).join('')}</tr>`)
    .join('');

  return `
  <div style="margin-bottom:22px">
    <div style="background:#1c1a15;color:#bd9a52;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:8px 14px">Current Debt Obligations (${rows.length})</div>
    <div style="overflow-x:auto;border:1px solid #e4dfd3;border-top:none;background:#fff">
      <table style="width:100%;border-collapse:collapse;min-width:520px">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  </div>`;
}

// Only a genuine Vercel Blob public URL renders as a clickable link. Anything
// else — including a value a bad-faith client crafted by POSTing straight to
// this endpoint — falls back to plain escaped text, never a raw href.
const BLOB_URL_RE = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/[^\s"'<>]+$/i;

function documentBlock(data) {
  const listed = Array.isArray(data.documents) ? data.documents : [];
  if (!listed.length) return '';
  const label = (z) => (z === 'agreements' ? 'Advance agreement' : 'Bank statement');
  const ref = clean(data.ref, 20);
  // Uploaded to Blob → clickable link. Couldn't reach Blob, so apply.html
  // emailed it through api/relay-file.js → it's already in this inbox as its
  // own email(s), marked with the same reference. Anything else never arrived.
  const linked = (d) => !d.failed && d.via !== 'email' && isValidBlobUrl(d.url);
  const emailed = (d) => !d.failed && d.via === 'email';
  const emailedCount = listed.filter(emailed).length;
  const missingCount = listed.length - emailedCount - listed.filter(linked).length;

  const rows = listed.map((d) => {
    const name = clean(d.name, 160);
    const sizeTxt = d.size ? ` (${Math.round(d.size / 1024)} KB)` : '';
    if (emailed(d)) {
      const parts = Math.min(Math.max(parseInt(d.parts, 10) || 1, 1), 30);
      return row(label(d.zone), `${name}${sizeTxt}, sent by email` +
        (parts > 1 ? ` in ${parts} parts (rejoin at ${SITE}/rejoin.html)` : ''));
    }
    if (linked(d)) {
      return `<tr>
        <td style="padding:7px 14px;color:#7c766a;font-size:12px;white-space:nowrap;vertical-align:top;width:38%;border-bottom:1px solid #efeae0">${esc(label(d.zone))}</td>
        <td style="padding:7px 14px;font-size:13px;vertical-align:top;border-bottom:1px solid #efeae0">
          <a href="${esc(d.url)}" style="color:#8a6c30;font-weight:600;text-decoration:underline">${esc(name)}</a>${esc(sizeTxt)}
        </td>
      </tr>`;
    }
    return row(label(d.zone), `${name}${sizeTxt}, not received`);
  });

  const notes = [];
  if (emailedCount) {
    notes.push(`${emailedCount} file${emailedCount === 1 ? '' : 's'} arrived as separate emails. Search this inbox for ${ref || 'the business name'}.`);
  }
  if (missingCount) {
    notes.push(`${missingCount} of ${listed.length} file${listed.length === 1 ? '' : 's'} did not arrive. Check for a separate email${ref ? ` marked ${ref}` : ''} before following up with the applicant.`);
  }
  const status = notes.length
    ? `<div style="padding:12px 14px;background:#fff;border:1px solid #e4dfd3;border-left:3px solid #8a6c30;font-size:12px;color:#46423a;line-height:1.6">
         ${notes.map(esc).join('<br><br>')}
       </div>`
    : '';

  return section(`Documents (${listed.length})`, rows) + status;
}

function isValidBlobUrl(url) {
  return typeof url === 'string' && BLOB_URL_RE.test(url);
}

function intakeEmail(data) {
  const inner =
    section('Business Information', [
      row('Reference #', data.ref),
      row('Company Name', data.businessName),
      row('Entity Type', data.entityType),
      row('Industry', data.industry),
      row('Tax ID / EIN', data.ein),
      row('Annual Revenue', data.annualRevenue),
      row('Time in Business', data.timeInBusiness),
      row('Business Phone', data.bizPhone),
      row('Business Address', data.bizAddress),
    ]) +
    ownerSection(data, 1) + ownerSection(data, 2) +
    ownerSection(data, 3) + ownerSection(data, 4) +
    debtTable(data.debtRows) +
    documentBlock(data) +
    section('Consent & Signature', [
      row('Signed by', data.sigName),
      row('Date', data.sigDate),
      row('Consent', data.consent),
    ]);

  return shell('Debt Restructuring Review', inner,
    clean(data.own1Name) || clean(data.businessName));
}

/* ─────────────────────────  utilities  ───────────────────────── */

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
