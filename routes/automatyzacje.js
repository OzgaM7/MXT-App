'use strict';
// Workflow Engine – automatyzacje (tylko administratorzy): dzienny raport zarządu, reguły zdarzenie → działanie,
// tokeny integracji (n8n, skrzynka pocztowa), stan poczty i kolejki zadań w tle.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/rbac');
const scheduler = require('../lib/scheduler');
const events = require('../lib/events');
const jobs = require('../lib/jobs');
const mail = require('../lib/mail');
const secrets = require('../lib/secrets');
const monitoring = require('../lib/monitoring');
const catalog = require('../lib/ai/catalog');
const { wrap, idParam, V, bad, UUID } = require('./_util');

const r = express.Router();
const admin = requirePerm('automations.manage');
const SCOPES = { poczta: 'Przyjmowanie e-maili od klientów (skrzynka → MXT)', zadania: 'Tworzenie zadań z n8n' };

r.get('/', admin, wrap(async (req, res) => {
  const [rules, tokens, runs, queue, outbox] = await Promise.all([
    pool.query(`SELECT a.id, a.name, a.event, a.action, a.params, a.is_active, a.runs, a.last_run_at, a.last_error, a.created_at, u.login AS created_by_login FROM automations a JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC`),
    pool.query(`SELECT t.id, t.name, t.token_hint, t.scopes, t.is_active, t.last_used_at, t.created_at, u.login AS created_by_login FROM integration_tokens t JOIN users u ON u.id = t.created_by ORDER BY t.created_at DESC`),
    pool.query(`SELECT s.run_date, s.created_at, j.status, j.last_error, j.result, j.finished_at FROM scheduled_runs s LEFT JOIN jobs j ON j.id = s.job_id WHERE s.job = 'raport_dzienny' ORDER BY s.run_date DESC LIMIT 10`),
    pool.query(`SELECT id, kind, status, attempts, max_attempts, last_error, run_at, created_at, finished_at FROM jobs ORDER BY id DESC LIMIT 30`),
    pool.query(`SELECT count(*) FILTER (WHERE status = 'wyslany')::int wyslane, count(*) FILTER (WHERE status = 'symulowany')::int symulowane, count(*) FILTER (WHERE status = 'blad')::int bledy, count(*) FILTER (WHERE status = 'do_wyslania')::int w_kolejce FROM mail_outbox`)
  ]);
  const ag = await pool.query(`SELECT a.id, s.display_name FROM agents a JOIN agent_settings s ON s.agent_id = a.id ORDER BY a.sort_order`);
  res.json({
    daily: await scheduler.settings(), daily_runs: runs.rows, now: scheduler.localNow((await scheduler.settings()).timezone),
    events: events.EVENTS, rules: rules.rows, tokens: tokens.rows, scopes: SCOPES, queue: queue.rows,
    mail: { configured: mail.configured(), ...outbox.rows[0], from: process.env.SMTP_FROM || null },
    langfuse: monitoring.configured(), n8n_allowed_hosts: process.env.N8N_ALLOWED_HOSTS || '', agents: ag.rows,
    app_url: process.env.APP_URL || null
  });
}));

// ---------- dzienny raport zarządu ----------
r.put('/raport-dzienny', admin, wrap(async (req, res) => {
  const b = req.body || {};
  const time = V.str(b.time, 5, true, 'Godzina');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad(400, 'Godzina w formacie GG:MM, np. 07:30.');
  const tz = V.str(b.timezone || 'Europe/Warsaw', 60);
  try { new Intl.DateTimeFormat('pl-PL', { timeZone: tz }); } catch (e) { throw bad(400, 'Nieznana strefa czasowa.'); }
  const recipients = [...new Set((Array.isArray(b.recipients) ? b.recipients : String(b.recipients || '').split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean))];
  if (recipients.length > 20) throw bad(400, 'Najwyżej 20 odbiorców.');
  const badMail = recipients.find(x => !mail.EMAIL.test(x)); if (badMail) throw bad(400, 'Nieprawidłowy adres e-mail: ' + badMail);
  const v = { enabled: b.enabled === true, time, timezone: tz, recipients };
  await pool.query(`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('daily_report', $1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [JSON.stringify(v), req.user.id]);
  await audit(req, 'automatyzacje.raport_dzienny', { resource: 'system_settings', resourceId: 'daily_report', details: { wlaczony: v.enabled, godzina: time, strefa: tz, odbiorcy: recipients.length } });
  res.json(v);
}));
r.post('/raport-dzienny/uruchom', admin, wrap(async (req, res) => {
  const id = await jobs.enqueue('raport_dzienny', { date: new Date().toISOString().slice(0, 10), trigger: 'reczne', user_id: req.user.id }, { maxAttempts: 1 });
  await audit(req, 'automatyzacje.raport_dzienny_reczny', { resource: 'jobs', resourceId: id });
  const j = await jobs.runNow(id);
  if (j.status === 'blad') throw bad(409, 'Raport nie powstał: ' + j.last_error);
  res.json({ job_id: id, ...j });
}));

// ---------- reguły automatyzacji ----------
async function ruleParams(action, p) {
  if (action === 'zadanie') {
    const assignee = p.assignee_id ? String(p.assignee_id) : null;
    if (assignee && !UUID.test(assignee) && !catalog.byId(assignee)) throw bad(400, 'Nieznana osoba lub agent.');
    return { title: V.str(p.title, 200, true, 'Tytuł zadania'), description: V.str(p.description, 2000), department_id: p.department_id || null,
      priority: V.oneOf(p.priority, ['niski', 'normalny', 'wysoki', 'pilny'], 'Priorytet', 'normalny'), assignee_id: assignee, due_days: V.num(p.due_days, 0, 365, 'Termin (dni)') };
  }
  if (action === 'email') {
    const rec = [...new Set((Array.isArray(p.recipients) ? p.recipients : String(p.recipients || '').split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean))].slice(0, 10);
    if (!rec.length) throw bad(400, 'Podaj co najmniej jednego odbiorcę.');
    const b = rec.find(x => !mail.EMAIL.test(x)); if (b) throw bad(400, 'Nieprawidłowy adres e-mail: ' + b);
    return { recipients: rec, subject: V.str(p.subject, 200), body: V.str(p.body, 4000) };
  }
  return { url: events.checkUrl(V.str(p.url, 500, true, 'Adres webhooka')) };
}
r.post('/reguly', admin, wrap(async (req, res) => {
  const b = req.body || {}, event = V.oneOf(b.event, Object.keys(events.EVENTS), 'Zdarzenie'), action = V.oneOf(b.action, ['zadanie', 'email', 'webhook'], 'Działanie');
  const params = await ruleParams(action, b.params || {});
  const secret = action === 'webhook' ? crypto.randomBytes(24).toString('base64url') : null;
  const q = await pool.query(`INSERT INTO automations (name, event, action, params, secret_hash, secret_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, event, action, params, is_active`,
    [V.str(b.name, 120, true, 'Nazwa reguły'), event, action, JSON.stringify(params), secret ? secrets.sha(secret) : null, secret ? await secrets.encrypt(secret) : null, req.user.id]);
  await audit(req, 'automatyzacje.regula_utworzenie', { resource: 'automations', resourceId: q.rows[0].id, details: { zdarzenie: event, dzialanie: action } });
  res.status(201).json({ ...q.rows[0], ...(secret ? { secret, info: 'Sekret podpisu (HMAC-SHA256 w nagłówku X-MXT-Signature) jest pokazywany tylko raz.' } : {}) });
}));
r.patch('/reguly/:id', idParam, admin, wrap(async (req, res) => {
  const q = await pool.query('UPDATE automations SET is_active = $2 WHERE id = $1 RETURNING id, is_active', [req.params.id, (req.body || {}).is_active === true]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono reguły.');
  await audit(req, 'automatyzacje.regula_zmiana', { resource: 'automations', resourceId: req.params.id, details: { aktywna: q.rows[0].is_active } });
  res.json(q.rows[0]);
}));
r.delete('/reguly/:id', idParam, admin, wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM automations WHERE id = $1 RETURNING name', [req.params.id]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono reguły.');
  await audit(req, 'automatyzacje.regula_usuniecie', { resource: 'automations', resourceId: req.params.id, details: { nazwa: q.rows[0].name } });
  res.json({ ok: true });
}));

// ---------- tokeny integracji (n8n, skrzynka pocztowa) ----------
r.post('/tokeny', admin, wrap(async (req, res) => {
  const b = req.body || {}, scopes = (Array.isArray(b.scopes) ? b.scopes : []).filter(s => SCOPES[s]);
  if (!scopes.length) throw bad(400, 'Wybierz zakres tokenu.');
  const token = 'mxt_' + crypto.randomBytes(24).toString('base64url');
  const q = await pool.query(`INSERT INTO integration_tokens (name, token_hash, token_hint, scopes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, scopes, token_hint`,
    [V.str(b.name, 100, true, 'Nazwa'), secrets.sha(token), token.slice(0, 8) + '…' + token.slice(-4), scopes, req.user.id]);
  await audit(req, 'integracje.token_utworzenie', { resource: 'integration_tokens', resourceId: q.rows[0].id, details: { zakresy: scopes } });
  res.status(201).json({ ...q.rows[0], token, info: 'Token jest pokazywany tylko raz. W bazie zapisany jest wyłącznie jego skrót.' });
}));
r.post('/tokeny/:id/uniewaznij', idParam, admin, wrap(async (req, res) => {
  const q = await pool.query('UPDATE integration_tokens SET is_active = false WHERE id = $1 RETURNING id', [req.params.id]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono tokenu.');
  await audit(req, 'integracje.token_uniewaznienie', { resource: 'integration_tokens', resourceId: req.params.id });
  res.json({ ok: true });
}));

// ---------- poczta i kolejka ----------
r.post('/test-poczty', admin, wrap(async (req, res) => {
  const to = V.str((req.body || {}).to, 200, true, 'Adres');
  const id = await mail.queue({ to, subject: '[MXT] Test poczty', text: 'Wiadomość testowa z MXT Business OS.', related_type: 'test', created_by: req.user.id });
  const job = (await pool.query(`SELECT id FROM jobs WHERE kind = 'mail' AND payload->>'outbox_id' = $1`, [id])).rows[0];
  await jobs.runNow(job.id, 30000);
  const m = (await pool.query('SELECT status, error FROM mail_outbox WHERE id = $1', [id])).rows[0];
  await audit(req, 'poczta.test', { details: { status: m.status } });
  res.json({ ...m, verify: await mail.verify() });
}));
r.post('/kolejka/:id/ponow', admin, wrap(async (req, res) => {
  const q = await pool.query(`UPDATE jobs SET status = 'oczekuje', run_at = now(), attempts = 0, last_error = NULL WHERE id = $1 AND status = 'blad' RETURNING id, kind`, [parseInt(req.params.id, 10) || 0]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono zadania z błędem.');
  if (q.rows[0].kind === 'mail') await pool.query(`UPDATE mail_outbox SET status = 'do_wyslania' WHERE id = (SELECT (payload->>'outbox_id')::uuid FROM jobs WHERE id = $1) AND status = 'blad'`, [q.rows[0].id]);
  await audit(req, 'kolejka.ponowienie', { resource: 'jobs', resourceId: q.rows[0].id });
  res.json({ ok: true });
}));

module.exports = r;
