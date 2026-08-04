/**
 * api/submit.js — Vercel Serverless Function
 *
 * Receives a JSON POST from consultation.html or apply.html, builds a styled
 * HTML email, attaches any uploaded documents, and delivers it through Resend.
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
 *   ALLOWED_ORIGIN   locks CORS to one origin, e.g. https://aprilstonelaw.com
 *                    Falls back to DEFAULT_ORIGIN below.
 */

const BRAND = 'April H. Stone P.A.';
const SITE = 'aprilstonelaw.com';
const DEFAULT_ORIGIN = 'https://aprilstonelaw.com';

// Attachment ceiling. Vercel caps the request body around 4.5 MB and base64
// inflates by ~33%, so the browser is told to keep raw files under 3 MB.
const MAX_ATTACH_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

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

  // ---- attachments ----
  const attachments = [];
  let attachNote = '';
  if (Array.isArray(data.attachments) && data.attachments.length) {
    let total = 0;
    for (const a of data.attachments.slice(0, MAX_ATTACHMENTS)) {
      if (!a || typeof a.content !== 'string' || !a.filename) continue;
      const bytes = Math.floor((a.content.length * 3) / 4);
      if (total + bytes > MAX_ATTACH_BYTES) {
        attachNote = 'Some files exceeded the size limit and were not attached — reply to request them.';
        break;
      }
      total += bytes;
      attachments.push({ filename: safeFilename(a.filename), content: a.content });
    }
  }
  if (data.attachmentsOmitted) {
    attachNote = 'The applicant selected files too large to attach — follow up for them.';
  }

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
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject: `New ${formLabel} — ${bizName}`,
        html: isConsultation
          ? consultationEmail(data)
          : intakeEmail(data, attachments, attachNote),
        ...(attachments.length ? { attachments } : {}),
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
function clean(v, max = 300) {
  if (v == null) return '';
  return String(v).replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, max);
}

function safeFilename(name) {
  return clean(name, 120).replace(/[/\\]+/g, '-') || 'attachment';
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
    Submitted via ${esc(SITE)} &mdash; hit <strong style="color:#bd9a52">Reply</strong> to respond directly to ${esc(replyName || 'the sender')}.
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
         <div style="background:#1c1a15;color:#bd9a52;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:8px 14px">What's Going On</div>
         <div style="background:#fff;border:1px solid #e4dfd3;border-top:none;padding:14px;color:#1c1a15;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(String(data.message).slice(0, 5000))}</div>
       </div>`
    : '';

  const inner = section('Contact', [
    row('Name', data.name),
    row('Email', data.email),
    row('Phone', data.phone),
    row('Business', data.businessName),
  ]) + message;

  return shell('New Consultation Request', inner, clean(data.name));
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
    .map((r) => `<tr>${cols.map(([k]) => `<td style="padding:6px 10px;font-size:12px;color:#1c1a15;border:1px solid #e4dfd3;white-space:nowrap">${esc(clean(r[k], 120) || '—')}</td>`).join('')}</tr>`)
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

function documentBlock(data, attachments, note) {
  const listed = Array.isArray(data.documents) ? data.documents : [];
  if (!listed.length && !attachments.length) return '';
  const label = (z) => (z === 'agreements' ? 'Advance agreement' : 'Bank statement');
  const rows = listed.map((d) =>
    row(label(d.zone), clean(d.name, 160) + (d.size ? ` (${Math.round(d.size / 1024)} KB)` : ''))
  );
  const status = attachments.length
    ? `<div style="padding:12px 14px;background:#fff;border:1px solid #e4dfd3;border-left:3px solid #23402f;font-size:12px;color:#46423a;line-height:1.6">
         <strong>${attachments.length} file${attachments.length === 1 ? '' : 's'} attached to this email.</strong>${note ? ' ' + esc(note) : ''}
       </div>`
    : `<div style="padding:12px 14px;background:#fff;border:1px solid #e4dfd3;border-left:3px solid #8a6c30;font-size:12px;color:#46423a;line-height:1.6">
         ${esc(note || 'Files were listed by the applicant but not attached — reply to request them.')}
       </div>`;
  return section(`Documents (${listed.length || attachments.length})`, rows) + status;
}

function intakeEmail(data, attachments, note) {
  const inner =
    section('Business Information', [
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
    documentBlock(data, attachments, note) +
    section('Consent & Signature', [
      row('Signed by', data.sigName),
      row('Date', data.sigDate),
      row('Consent', data.consent),
    ]);

  return shell('New Debt Restructuring Review', inner,
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
