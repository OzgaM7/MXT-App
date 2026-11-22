'use strict';
// Powiadomienia zalogowanego pracownika (każda rola): lista, licznik nieprzeczytanych, odczyt, push na urządzenia, kopia e-mail.
// Każde zapytanie dotyczy wyłącznie powiadomień i urządzeń bieżącego konta (user_id = req.user.id).
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { notify, vapidKeys } = require('../lib/notify');
const { wrap, bad } = require('./_util');

const r = express.Router();
const B64URL = /^[A-Za-z0-9_-]+=*$/;

r.get('/', wrap(async (req, res) => {
  const p = [req.user.id], w = ['user_id = $1'];
  if (req.query.nowe === '1') w.push('read_at IS NULL');
  const before = parseInt(req.query.przed, 10);
  if (before > 0) { p.push(before); w.push(`id < $${p.length}`); }
  const q = await pool.query(`SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT 50`, p);
  res.json(q.rows);
}));
r.get('/licznik', wrap(async (req, res) => {
  const q = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ nieprzeczytane: q.rows[0].n });
}));
r.post('/przeczytane', wrap(async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(n => n > 0).slice(0, 200) : null;
  const q = ids
    ? await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [req.user.id, ids])
    : await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ oznaczono: q.rowCount });
}));

// ---------- ustawienia: kopia e-mail, urządzenia z push ----------
r.get('/ustawienia', wrap(async (req, res) => {
  const [u, d] = await Promise.all([
    pool.query('SELECT email, notify_email FROM users WHERE id = $1', [req.user.id]),
    pool.query('SELECT id, user_agent, created_at, last_ok_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at', [req.user.id])
  ]);
  res.json({ email: u.rows[0].email, notify_email: u.rows[0].notify_email, devices: d.rows, vapid_public_key: (await vapidKeys()).publicKey });
}));
r.put('/ustawienia', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.notify_email !== 'boolean') throw bad(400, 'Brak ustawienia kopii e-mail.');
  const u = (await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (b.notify_email && !u.email) throw bad(400, 'Twoje konto nie ma adresu e-mail. Poproś administratora o jego dodanie.');
  await pool.query('UPDATE users SET notify_email = $2, updated_at = now() WHERE id = $1', [req.user.id, b.notify_email]);
  res.json({ notify_email: b.notify_email });
}));
// Rejestracja urządzenia do powiadomień push (subskrypcja z przeglądarki / aplikacji na ekranie głównym).
r.post('/push', wrap(async (req, res) => {
  const b = req.body || {}, keys = b.keys || {};
  const endpoint = String(b.endpoint || '');
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint)) throw bad(400, 'Nieprawidłowa subskrypcja push.');
  if (!B64URL.test(keys.p256dh || '') || !B64URL.test(keys.auth || '') || keys.p256dh.length > 200 || keys.auth.length > 100) throw bad(400, 'Nieprawidłowe klucze subskrypcji push.');
  // To samo urządzenie po zalogowaniu na inne konto przechodzi do nowego konta.
  await pool.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [req.user.id, endpoint, keys.p256dh, keys.auth, String(req.get('user-agent') || '').slice(0, 300)]);
  await audit(req, 'push.wlaczenie', { resource: 'push_subscriptions' });
  res.status(201).json({ ok: true });
}));
// Wyłączenie push na urządzeniu (po endpoint z przeglądarki albo po id z listy urządzeń).
r.delete('/push', wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND (endpoint = $2 OR id::text = $3)', [req.user.id, String(b.endpoint || ''), String(b.id || '')]);
  res.json({ usunieto: q.rowCount });
}));
// Powiadomienie próbne do siebie – sprawdzenie, czy push dochodzi na telefon.
r.post('/test', wrap(async (req, res) => {
  const n = await notify([req.user.id], { kind: 'test', title: 'Powiadomienie próbne MXT', body: 'Jeśli to widzisz na telefonie, powiadomienia działają.', link: '/powiadomienia' });
  res.status(201).json({ utworzono: n });
}));

module.exports = r;
