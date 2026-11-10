'use strict';
// Poczta wychodząca: każda wiadomość trafia najpierw do mail_outbox, a wysyła ją kolejka (z ponawianiem).
// SMTP z konfiguracji serwera (SMTP_HOST …). Bez konfiguracji: tryb testowy – wiadomość zapisana jako „symulowany”, nic nie wychodzi.
const { pool } = require('../db');
const jobs = require('./jobs');
const docs = require('./docs');
const pdf = require('./pdf');

const configured = () => !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
let transport = null;
function smtp() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
      tls: process.env.SMTP_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : undefined
    });
  }
  return transport;
}
const EMAIL = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;

// Dodaje wiadomość do kolejki (w transakcji wywołującego, jeśli podano client).
async function queue(m, client = pool) {
  const to = String(m.to || '').trim();
  if (!EMAIL.test(to)) { const e = new Error('Nieprawidłowy adres e-mail odbiorcy.'); e.status = 400; throw e; }
  const r = await client.query(`INSERT INTO mail_outbox (to_addr, subject, body_text, attachments, customer_id, communication_id, related_type, related_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [to, String(m.subject).slice(0, 300), String(m.text).slice(0, 50000), JSON.stringify(m.attachments || []),
    m.customer_id || null, m.communication_id || null, m.related_type || null, m.related_id || null, m.created_by || null]);
  await jobs.enqueue('mail', { outbox_id: r.rows[0].id }, { client, maxAttempts: 6 });
  return r.rows[0].id;
}

async function attachmentsOf(list) {
  const out = [];
  for (const a of list || []) {
    if (a.kind === 'offer') {
      const o = (await pool.query('SELECT document_id, number FROM offers WHERE id = $1', [a.offer_id])).rows[0];
      const v = o && await docs.getVersion(o.document_id, a.version);
      if (!v) throw Object.assign(new Error('Brak wersji oferty do załączenia.'), { permanent: true });
      out.push({ filename: `Oferta_${o.number.replace(/\//g, '-')}_v${v.version}.pdf`, content: await pdf.offer(JSON.parse(v.content)), contentType: 'application/pdf' });
    } else if (a.document_id) {
      const v = await docs.getVersion(a.document_id, a.version || null);
      if (!v || !v.file_data) throw Object.assign(new Error('Brak pliku dokumentu do załączenia.'), { permanent: true });
      out.push({ filename: v.file_name || 'dokument.pdf', content: v.file_data, contentType: v.mime_type || 'application/pdf' });
    }
  }
  return out;
}

jobs.register('mail', async ({ outbox_id }) => {
  const m = (await pool.query('SELECT * FROM mail_outbox WHERE id = $1', [outbox_id])).rows[0];
  if (!m || m.status === 'wyslany' || m.status === 'symulowany') return { pominieto: true };
  const files = await attachmentsOf(m.attachments);
  let status = 'symulowany', messageId = null;
  if (configured()) {
    try {
      const info = await smtp().sendMail({ from: process.env.SMTP_FROM, to: m.to_addr, subject: m.subject, text: m.body_text, attachments: files });
      status = 'wyslany'; messageId = info.messageId || null;
    } catch (e) { await pool.query(`UPDATE mail_outbox SET status = 'blad', error = $2 WHERE id = $1`, [m.id, e.message]); throw e; }
  }
  await pool.query(`UPDATE mail_outbox SET status = $2, sent_at = now(), message_id = $3, error = NULL WHERE id = $1`, [m.id, status, messageId]);
  if (m.communication_id) await pool.query(`UPDATE communications SET body = body || $2, message_id = coalesce(message_id, $3) WHERE id = $1`,
    [m.communication_id, status === 'wyslany' ? `\n\nWysłano e-mail na adres ${m.to_addr}.` : `\n\n[Tryb testowy poczty] Wiadomość do ${m.to_addr} zapisana, nie wysłana (brak konfiguracji SMTP).`, messageId]);
  return { status, zalaczniki: files.length };
});

async function verify() {
  if (!configured()) return { configured: false };
  try { await smtp().verify(); return { configured: true, ok: true }; } catch (e) { return { configured: true, ok: false, error: e.message }; }
}

module.exports = { queue, configured, verify, EMAIL };
