'use strict';
// Konta pracowników (administrator): zakładanie, role, dane kontaktowe, powiązanie z instalatorem, dezaktywacja, reset hasła.
// Kont się nie usuwa – po odejściu pracownika konto jest wyłączane, a jego wpisy (montaże, rozliczenia, rejestr) zostają.
const express = require('express'), crypto = require('crypto'), bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm, ROLES, EXTRA_ROLES } = require('../lib/rbac');
const { wrap, bad, idParam, V } = require('./_util');

const r = express.Router();
const manage = requirePerm('users.manage');
const LOGIN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const EMAIL = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;

// Hasło tymczasowe: 12 znaków bez mylących (0/O, 1/l/I), co najmniej jedna cyfra i litera. Pokazywane raz.
function tempPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let t; do { t = Array.from(crypto.randomBytes(12), b => A[b % A.length]).join(''); } while (!/\d/.test(t) || !/[A-Za-z]/.test(t));
  return t;
}
const roleOf = v => V.oneOf(v, Object.keys(ROLES), 'Rola');
function extraRoles(v, main) {
  const list = [...new Set((Array.isArray(v) ? v : []).map(String))];
  for (const x of list) if (!EXTRA_ROLES.includes(x)) throw bad(400, 'Rola dodatkowa: nieprawidłowa wartość.');
  return list.filter(x => x !== main);
}
const email = v => { const e = V.str(v, 200); if (e && !EMAIL.test(e)) throw bad(400, 'Nieprawidłowy adres e-mail.'); return e; };

const LIST = `SELECT u.id, u.login, u.full_name, u.email, u.phone, u.role, u.extra_roles, u.is_active, u.notify_email, u.must_change_password, u.created_at,
    (SELECT max(ts) FROM audit_logs a WHERE a.actor_id = u.id::text AND a.action = 'logowanie' AND a.status = 'ok') AS last_login,
    (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions,
    (SELECT count(*)::int FROM push_subscriptions p WHERE p.user_id = u.id) AS push_devices,
    i.id AS installer_id, i.name AS installer_name, c.name AS crew_name
  FROM users u LEFT JOIN installers i ON i.user_id = u.id LEFT JOIN crews c ON c.id = i.crew_id`;

r.get('/', manage, wrap(async (req, res) => {
  res.json((await pool.query(LIST + ' ORDER BY u.is_active DESC, u.login')).rows);
}));

// Instalatorzy do powiązania z kontem (z informacją, czy mają już konto).
r.get('/instalatorzy', manage, wrap(async (req, res) => {
  const q = await pool.query(`SELECT i.id, i.name, i.user_id, i.is_active, c.name AS crew_name, u.login AS user_login
    FROM installers i LEFT JOIN crews c ON c.id = i.crew_id LEFT JOIN users u ON u.id = i.user_id ORDER BY i.is_active DESC, c.name NULLS LAST, i.name`);
  res.json(q.rows);
}));

async function linkInstaller(client, userId, installerId) {
  await client.query('UPDATE installers SET user_id = NULL WHERE user_id = $1', [userId]);
  if (!installerId) return null;
  const i = (await client.query('SELECT id, name, user_id FROM installers WHERE id = $1 FOR UPDATE', [installerId])).rows[0];
  if (!i) throw bad(400, 'Nie znaleziono instalatora.');
  if (i.user_id && i.user_id !== userId) throw bad(409, `Instalator ${i.name} ma już przypisane inne konto.`);
  await client.query('UPDATE installers SET user_id = $2 WHERE id = $1', [i.id, userId]);
  return i.name;
}
// Musi zostać co najmniej jedno aktywne konto administratora (inaczej nikt nie zarządzi systemem).
async function assertAdminLeft(client) {
  const n = (await client.query(`SELECT count(*)::int n FROM users WHERE role = 'administrator' AND is_active`)).rows[0].n;
  if (n < 1) throw bad(409, 'Musi zostać co najmniej jedno aktywne konto administratora.');
}

r.post('/', manage, wrap(async (req, res) => {
  const b = req.body || {};
  const login = V.str(b.login, 64, true, 'Login').toLowerCase();
  if (!LOGIN.test(login)) throw bad(400, 'Login: 3–64 znaki, małe litery, cyfry, kropka, myślnik lub podkreślenie (np. j.kowalski).');
  const role = roleOf(b.role || 'monter'), extra = extraRoles(b.extra_roles, role);
  const temp = tempPassword();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query(`INSERT INTO users (login, password_hash, must_change_password, role, extra_roles, full_name, email, phone, created_by)
      VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8) RETURNING id, login`,
      [login, await bcrypt.hash(temp, 12), role, extra, V.str(b.full_name, 120, true, 'Imię i nazwisko'), email(b.email), V.str(b.phone, 40), req.user.id])).rows[0];
    const inst = await linkInstaller(client, u.id, V.uuid(b.installer_id, 'Instalator'));
    await audit(req, 'konto.utworzenie', { resource: 'users', resourceId: u.id, details: { konto: login, rola: role, role_dodatkowe: extra, instalator: inst }, client });
    await client.query('COMMIT');
    res.status(201).json({ id: u.id, login, temporary_password: temp,
      info: 'Przekaż login i hasło tymczasowe pracownikowi bezpiecznym kanałem (osobiście lub SMS-em). Przy pierwszym logowaniu ustawi własne hasło.' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw bad(409, 'Konto o takim loginie już istnieje.');
    throw e;
  } finally { client.release(); }
}));

r.patch('/:id', idParam, manage, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!t) throw bad(404, 'Nie znaleziono konta.');
    const self = t.id === req.user.id;
    if (b.full_name !== undefined) f.full_name = V.str(b.full_name, 120, true, 'Imię i nazwisko');
    if (b.email !== undefined) f.email = email(b.email);
    if (b.phone !== undefined) f.phone = V.str(b.phone, 40);
    if (b.notify_email !== undefined) f.notify_email = !!b.notify_email;
    if (b.role !== undefined) {
      f.role = roleOf(b.role);
      if (self && f.role !== t.role) throw bad(400, 'Nie możesz zmienić własnej roli głównej.');
    }
    if (b.extra_roles !== undefined || f.role) f.extra_roles = extraRoles(b.extra_roles !== undefined ? b.extra_roles : t.extra_roles, f.role || t.role);
    if (b.is_active !== undefined) {
      f.is_active = !!b.is_active;
      if (self && !f.is_active) throw bad(400, 'Nie możesz wyłączyć własnego konta.');
    }
    const keys = Object.keys(f);
    if (keys.length) await client.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [t.id, ...keys.map(k => f[k])]);
    let inst;
    if (b.installer_id !== undefined) inst = await linkInstaller(client, t.id, V.uuid(b.installer_id, 'Instalator'));
    if (!keys.length && b.installer_id === undefined) throw bad(400, 'Brak zmian.');
    await assertAdminLeft(client);
    // Wyłączone konto: natychmiastowe wylogowanie ze wszystkich urządzeń i koniec powiadomień push.
    if (f.is_active === false) {
      await client.query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
      await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [t.id]);
    }
    const details = { konto: t.login, ...f, ...(b.installer_id !== undefined ? { instalator: inst || 'brak' } : {}) };
    await audit(req, f.is_active === false ? 'konto.wylaczenie' : f.is_active === true && !t.is_active ? 'konto.wlaczenie' : 'konto.zmiana',
      { resource: 'users', resourceId: t.id, details, client });
    await client.query('COMMIT');
    res.json((await pool.query(LIST + ' WHERE u.id = $1', [t.id])).rows[0]);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

// Reset hasła (np. gdy pracownik zapomniał hasła): hasło tymczasowe pokazywane raz, zmiana wymagana przy logowaniu.
r.post('/:id/reset-hasla', idParam, manage, wrap(async (req, res) => {
  const t = (await pool.query('SELECT id, login, is_active FROM users WHERE id = $1', [req.params.id])).rows[0];
  if (!t) throw bad(404, 'Nie znaleziono konta.');
  if (t.id === req.user.id) throw bad(400, 'Własne hasło zmieniasz w Menu → Zmień hasło.');
  if (!t.is_active) throw bad(409, 'Konto jest wyłączone. Najpierw je włącz.');
  const temp = tempPassword();
  await pool.query('UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1', [t.id, await bcrypt.hash(temp, 12)]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
  await audit(req, 'haslo.reset', { resource: 'users', resourceId: t.id, details: { konto: t.login } });
  res.json({ login: t.login, temporary_password: temp, info: 'Przekaż hasło tymczasowe pracownikowi bezpiecznym kanałem. Przy logowaniu ustawi własne hasło.' });
}));

module.exports = r;
