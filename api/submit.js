/**
 * api/submit.js — Vercel Serverless Function
 *
 * Receives a JSON POST from consultation.html or apply.html, builds a styled
 * HTML email, and delivers it through Resend.
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables).
 * Nothing here is hardcoded — set all three before deploying:
 *
 *   RESEND_API_KEY   your Resend key (starts with "re_")
 *   TO_EMAIL         PLACEHOLDER — where submissions land, e.g. contact@example.com
 *   FROM_EMAIL       a sender on a domain VERIFIED IN RESEND. This cannot be a
 *                    gmail.com address. Until the firm's domain exists, use
 *                    onboarding@resend.dev for testing.
 *
 * PLACEHOLDER in this file: example.com in the footer line of each template.
 */

const BRAND = 'April H. Stone P.A.';
const SITE  = 'example.com';  // PLACEHOLDER: swap for the real domain once it exists

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

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

  const isConsultation = data.formType === 'consultation';
  const formLabel = isConsultation ? 'Consultation Request' : 'Debt Restructuring Review';
  const bizName = data.businessName || 'Unknown Business';

  // Reply-To the submitter, so hitting Reply in the inbox writes straight back to them.
  // Consultation form sends name/email; the intake form sends own1Name/own1Email.
  const contactEmail = data.email || data.own1Email;
  const contactName = data.name || data.own1Name;
  const replyTo = contactEmail
    ? (contactName ? `${contactName} <${contactEmail}>` : contactEmail)
    : undefined;

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
        reply_to: replyTo,
        subject: `New ${formLabel} — ${bizName}`,
        html: isConsultation ? consultationEmail(data) : intakeEmail(data),
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

/* ─────────────────────────  email building blocks  ───────────────────────── */

function row(label, value) {
  if (!value) return '';
  return `<tr>
    <td style="padding:7px 14px;color:#7c766a;font-size:12px;white-space:nowrap;vertical-align:top;width:38%;border-bottom:1px solid #efeae0">${esc(label)}</td>
    <td style="padding:7px 14px;color:#1c1a15;font-size:13px;font-weight:600;vertical-align:top;border-bottom:1px solid #efeae0">${esc(value)}</td>
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
  const message = data.message
    ? `<div style="margin-bottom:22px">
         <div style="background:#1c1a15;color:#bd9a52;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:8px 14px">What's Going On</div>
         <div style="background:#fff;border:1px solid #e4dfd3;border-top:none;padding:14px;color:#1c1a15;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(data.message)}</div>
       </div>`
    : '';

  const inner = section('Contact', [
    row('Name', data.name),
    row('Email', data.email),
    row('Phone', data.phone),
    row('Business', data.businessName),
  ]) + message;

  return shell('New Consultation Request', inner, data.name);
}

/* ─────────────────────────  intake template  ───────────────────────── */

function ownerSection(data, i) {
  const name = data[`own${i}Name`];
  if (!name) return '';
  const ordinals = ['First', 'Second', 'Third', 'Fourth'];
  const ssn = data[`own${i}Ssn`];
  const digits = ssn ? String(ssn).replace(/\D/g, '') : '';
  const masked = digits ? `•••-••-${digits.slice(-4)}` : '';
  const pct = data[`own${i}Pct`];

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
    ['funder', 'Funder'],
    ['originalAmt', 'Original'],
    ['balance', 'Balance'],
    ['payment', 'Payment'],
    ['frequency', 'Frequency'],
    ['endDate', 'Ending'],
  ];
  const thead = cols
    .map(([, label]) => `<th style="padding:6px 10px;text-align:left;font-size:11px;border:1px solid #e4dfd3;color:#7c766a;background:#faf8f4;white-space:nowrap">${esc(label)}</th>`)
    .join('');
  const tbody = rows
    .map((r) => {
      const cells = cols
        .map(([key]) => `<td style="padding:6px 10px;font-size:12px;color:#1c1a15;border:1px solid #e4dfd3;white-space:nowrap">${esc(r[key] || '—')}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
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

function documentList(docs) {
  if (!Array.isArray(docs) || !docs.length) return '';
  const label = (z) => (z === 'agreements' ? 'Advance agreement' : 'Bank statement');
  return section(
    `Documents Attached by the Applicant (${docs.length})`,
    docs.map((d) => row(label(d.zone), d.name))
  );
}

function intakeEmail(data) {
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
    ownerSection(data, 1) +
    ownerSection(data, 2) +
    ownerSection(data, 3) +
    ownerSection(data, 4) +
    debtTable(data.debtRows) +
    documentList(data.documents) +
    section('Consent & Signature', [
      row('Signed by', data.sigName),
      row('Date', data.sigDate),
      row('Consent', data.consent),
    ]) +
    `<div style="padding:12px 14px;background:#fff;border:1px solid #e4dfd3;border-left:3px solid #8a6c30;font-size:12px;color:#46423a;line-height:1.6">
       Files the applicant selected are listed above by name only. They are not attached to this email — request them by replying, or wire the upload step to storage.
     </div>`;

  return shell('New Debt Restructuring Review', inner, data.own1Name || data.businessName);
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
