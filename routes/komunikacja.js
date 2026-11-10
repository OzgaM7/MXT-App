'use strict';
// Communication Hub: korespondencja z klientami (skrzynka, wysyłka e-mail z kolejką), szkice odpowiedzi przygotowane
// przez agentów (wysyła zawsze człowiek) i rozmowy agentów (wyniki pracy, posiedzenia zarządu).
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/rbac');
const mail = require('../lib/mail');
const runner = require('../lib/ai/runner');
const { wrap, idParam, V, bad } = require('./_util');

const r = express.Router();
const use = requirePerm('tasks.use');

r.get('/', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (['przychodzaca', 'wychodzaca', 'wewnetrzna'].includes(req.query.kierunek)) { p.push(req.query.kierunek); w.push(`m.direction = $${p.length}`); }
  if (['email', 'telefon', 'spotkanie', 'notatka', 'system'].includes(req.query.kanal)) { p.push(req.query.kanal); w.push(`m.channel = $${p.length}`); }
  if (req.query.nieprzypisane === '1') w.push('m.customer_id IS NULL');
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(m.subject ILIKE $${p.length} OR m.body ILIKE $${p.length} OR c.name ILIKE $${p.length} OR m.email_from ILIKE $${p.length})`); }
  const q = await pool.query(`SELECT m.*, c.name AS customer_name, c.kind AS customer_kind, c.language AS customer_language, u.login AS created_by_login,
      (SELECT o.status FROM mail_outbox o WHERE o.communication_id = m.id ORDER BY o.created_at DESC LIMIT 1) AS mail_status
    FROM communications m LEFT JOIN customers c ON c.id = m.customer_id LEFT JOIN users u ON u.id = m.created_by
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT 200`, p);
  res.json(q.rows);
}));
r.get('/wysylka', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT o.id, o.to_addr, o.subject, o.status, o.error, o.created_at, o.sent_at, o.related_type, jsonb_array_length(o.attachments) AS attachments,
      c.name AS customer_name, u.login AS created_by_login FROM mail_outbox o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.created_by ORDER BY o.created_at DESC LIMIT 200`);
  res.json({ configured: mail.configured(), items: q.rows });
}));
// Wiadomość e-mail do klienta, napisana i wysłana przez człowieka (zapis w CRM + kolejka wysyłki).
r.post('/email', use, wrap(async (req, res) => {
  const b = req.body || {};
  const c = (await pool.query('SELECT * FROM customers WHERE id = $1', [V.uuid(b.customer_id, 'Klient', true)])).rows[0];
  if (!c) throw bad(404, 'Nie znaleziono klienta.');
  const to = V.str(b.to || c.email, 200, true, 'Adres e-mail');
  if (!mail.EMAIL.test(to)) throw bad(400, 'Nieprawidłowy adres e-mail.');
  const attachments = [];
  if (b.document_id) {
    const d = (await pool.query('SELECT id, kind, current_version FROM documents WHERE id = $1', [V.uuid(b.document_id)])).rows[0];
    if (!d) throw bad(400, 'Nie znaleziono dokumentu do załączenia.');
    if (d.kind === 'oferta') throw bad(400, 'Oferty wysyła się z modułu Oferty po akceptacji administratora.');
    attachments.push({ document_id: d.id, version: d.current_version });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cm = (await client.query(`INSERT INTO communications (customer_id, channel, direction, subject, body, created_by, email_to, related_type, related_id)
      VALUES ($1, 'email', 'wychodzaca', $2, $3, $4, $5, $6, $7) RETURNING *`, [c.id, V.str(b.subject, 300, true, 'Temat'), V.str(b.body, 20000, true, 'Treść'), req.user.id, to,
      b.reply_to ? 'reply' : null, b.reply_to ? V.uuid(b.reply_to) : null])).rows[0];
    await mail.queue({ to, subject: cm.subject, text: cm.body, attachments, customer_id: c.id, communication_id: cm.id, related_type: 'communication', related_id: cm.id, created_by: req.user.id }, client);
    await audit(req, 'poczta.wyslanie', { resource: 'communications', resourceId: cm.id, details: { do: to, zalaczniki: attachments.length }, client });
    await client.query('COMMIT');
    res.status(201).json({ id: cm.id, configured: mail.configured() });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.post('/:id/przypisz', idParam, use, wrap(async (req, res) => {
  const q = await pool.query('UPDATE communications SET customer_id = $2 WHERE id = $1 RETURNING id', [req.params.id, V.uuid((req.body || {}).customer_id, 'Klient', true)]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono wiadomości.');
  await audit(req, 'komunikacja.przypisanie', { resource: 'communications', resourceId: req.params.id });
  res.json({ ok: true });
}));
// Szkic odpowiedzi przygotowany przez agenta (bez narzędzi zapisu). Wysyła człowiek – po przeczytaniu i poprawieniu.
r.post('/:id/szkic-odpowiedzi', idParam, use, wrap(async (req, res) => {
  const m = (await pool.query(`SELECT m.*, c.name AS customer_name, c.kind, c.language, c.departments FROM communications m LEFT JOIN customers c ON c.id = m.customer_id WHERE m.id = $1`, [req.params.id])).rows[0];
  if (!m) throw bad(404, 'Nie znaleziono wiadomości.');
  if (m.direction !== 'przychodzaca') throw bad(400, 'Szkic odpowiedzi przygotowuje się dla wiadomości przychodzącej.');
  const agentId = V.oneOf((req.body || {}).agent_id || (m.kind === 'klient_zagraniczny' ? 'eksport' : ['wspolnota', 'spoldzielnia', 'zarzadca'].includes(m.kind) ? 'handlowiec' : 'kierownik_sprzedazy'),
    ['eksport', 'handlowiec', 'kierownik_sprzedazy', 'technik', 'rozliczenia'], 'Agent');
  const out = await runner.run(agentId, { kind: 'zadanie', user: req.user, topic: `Szkic odpowiedzi na e-mail: ${m.subject}`, noTools: true,
    context: `Wiadomość od klienta (${m.customer_name || m.email_from}, język: ${m.language || 'pl'}).\nTemat: ${m.subject}\n\n${m.body}\n\n` +
      `Przygotuj wyłącznie treść odpowiedzi e-mail w języku klienta. Nie składaj wiążących obietnic cenowych ani terminów – oznacz je do potwierdzenia przez pracownika.` });
  res.json({ agent_id: agentId, draft: out.text, mode: out.run.mode, run_id: out.run.id, subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, to: m.email_from, customer_id: m.customer_id });
}));
// Rozmowy agentów: ostatnie wyniki pracy agentów i posiedzenia zarządu.
r.get('/agenci', use, wrap(async (req, res) => {
  const [runs, meetings] = await Promise.all([
    pool.query(`SELECT r.id, r.agent_id, s.display_name, s.avatar, s.avatar_color, r.kind, r.mode, r.status, r.input_summary, left(r.output, 1500) AS output, r.created_at, u.login AS user_login,
        (SELECT rating FROM agent_feedback f WHERE f.run_id = r.id AND f.user_id = $1) AS my_rating
      FROM agent_runs r JOIN agent_settings s ON s.agent_id = r.agent_id LEFT JOIN users u ON u.id = r.user_id WHERE r.kind IN ('zadanie', 'raport') AND r.status = 'ok' ORDER BY r.created_at DESC LIMIT 30`, [req.user.id]),
    pool.query(`SELECT id, topic, status, created_at FROM board_meetings ORDER BY created_at DESC LIMIT 10`)
  ]);
  res.json({ runs: runs.rows, meetings: meetings.rows });
}));

module.exports = r;
