'use strict';
// Wejście integracji (n8n, skrzynka pocztowa) – bez sesji, z tokenem Bearer o określonym zakresie.
// Treść przychodzących e-maili jest niezaufana: trafia do CRM jako dane, a agenci przetwarzają ją jako dane, nie polecenia.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const secrets = require('../lib/secrets');
const events = require('../lib/events');
const mail = require('../lib/mail');
const catalog = require('../lib/ai/catalog');
const { wrap, V, bad, UUID } = require('./_util');

const r = express.Router();
const hits = new Map();
setInterval(() => hits.clear(), 60e3).unref();

const token = scope => wrap(async (req, res, next) => {
  const m = /^Bearer\s+(mxt_[\w-]{20,})$/.exec(req.get('authorization') || '');
  const t = m && (await pool.query('SELECT * FROM integration_tokens WHERE token_hash = $1 AND is_active', [secrets.sha(m[1])])).rows[0];
  if (!t || !t.scopes.includes(scope)) {
    await audit({ ip: req.ip }, 'integracja.odmowa', { status: 'odmowa', resource: req.originalUrl, details: { zakres: scope } });
    return res.status(401).json({ error: 'Nieprawidłowy token integracji lub brak zakresu.' });
  }
  const n = (hits.get(t.id) || 0) + 1; hits.set(t.id, n);
  if (n > 120) return res.status(429).json({ error: 'Za dużo żądań – limit 120 na minutę.' });
  await pool.query('UPDATE integration_tokens SET last_used_at = now() WHERE id = $1', [t.id]);
  req.integration = { type: 'system', id: t.id, login: 'integracja: ' + t.name };
  next();
});

// Przychodzący e-mail (np. z n8n: IMAP Trigger → HTTP Request). Dopasowanie klienta po adresie nadawcy.
r.post('/poczta', token('poczta'), wrap(async (req, res) => {
  const b = req.body || {};
  const fromRaw = V.str(b.from, 300, true, 'Nadawca'), from = ((/<([^>]+)>/.exec(fromRaw) || [])[1] || fromRaw).trim().toLowerCase();
  if (!mail.EMAIL.test(from)) throw bad(400, 'Nieprawidłowy adres nadawcy.');
  const subject = V.str(b.subject, 300) || '(bez tematu)', text = V.str(b.text, 50000), msgId = V.str(b.message_id, 300) || null;
  if (msgId) { const d = (await pool.query('SELECT id FROM communications WHERE message_id = $1', [msgId])).rows[0]; if (d) return res.json({ id: d.id, duplikat: true }); }
  const c = (await pool.query(`SELECT id, name FROM customers WHERE lower(email) = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(contacts) x WHERE lower(x->>'email') = $1) LIMIT 1`, [from])).rows[0];
  const q = await pool.query(`INSERT INTO communications (customer_id, channel, direction, subject, body, email_from, email_to, message_id) VALUES ($1, 'email', 'przychodzaca', $2, $3, $4, $5, $6) RETURNING id`,
    [c ? c.id : null, subject, text, from, V.str(b.to, 300) || null, msgId]);
  await audit({ ip: req.ip }, 'poczta.przychodzaca', { actor: req.integration, resource: 'communications', resourceId: q.rows[0].id, details: { od: from, klient: c ? c.name : null } });
  events.emit('poczta.przychodzaca', { od: from, temat: subject, klient: c ? c.name : 'nieprzypisany' });
  res.status(201).json({ id: q.rows[0].id, klient: c ? c.name : null });
}));

// Zadanie utworzone przez n8n (np. z formularza, kalendarza, innego systemu).
r.post('/zadania', token('zadania'), wrap(async (req, res) => {
  const b = req.body || {}, assignee = b.assignee_id ? String(b.assignee_id) : null;
  if (assignee && !UUID.test(assignee) && !catalog.byId(assignee)) throw bad(400, 'Nieznana osoba lub agent.');
  const owner = (await pool.query(`SELECT created_by FROM integration_tokens WHERE id = $1`, [req.integration.id])).rows[0].created_by;
  const q = await pool.query(`INSERT INTO tasks (title, description, department_id, priority, assignee_type, assignee_id, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [V.str(b.title, 200, true, 'Tytuł'), V.str(b.description, 5000) + '\n\n(Utworzone przez integrację)', ['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport', 'ubezpieczenia'].includes(b.department_id) ? b.department_id : null,
      V.oneOf(b.priority, ['niski', 'normalny', 'wysoki', 'pilny'], 'Priorytet', 'normalny'), assignee ? (UUID.test(assignee) ? 'user' : 'agent') : null, assignee, V.date(b.due_date, 'Termin'), owner]);
  await audit({ ip: req.ip }, 'integracja.zadanie', { actor: req.integration, resource: 'tasks', resourceId: q.rows[0].id });
  res.status(201).json({ id: q.rows[0].id });
}));

module.exports = r;
