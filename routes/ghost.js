'use strict';
// Strefa GHOST. Kafelek widzą wszyscy zalogowani, ale wejście wymaga konta GHOST (powiązanego z kontem MXT)
// i osobnego hasła. Hasło ustawia właściciel konta przy pierwszym wejściu – nikt inny go nie zna.
// Odblokowanie trwa HOURS godzin i dotyczy tylko bieżącej sesji MXT (wylogowanie z MXT je kończy).
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { wrap, bad } = require('./_util');

const r = express.Router();
const HOURS = 12;
// Limit prób: 5 nieudanych w 15 minut na konto MXT.
const tries = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of tries) if (t - v.ts > 15 * 60e3) tries.delete(k); }, 60e3).unref();
const DUMMY_HASH = bcrypt.hashSync('ghost-brak-konta', 12);

const account = async id => (await pool.query('SELECT password_hash, is_active FROM ghost_accounts WHERE user_id = $1', [id])).rows[0] || null;
const unlockedUntil = async req => {
  const s = (await pool.query('SELECT ghost_until FROM sessions WHERE token_hash = $1 AND ghost_until > now()', [req.sessionHash])).rows[0];
  return s ? s.ghost_until : null;
};
const unlock = req => pool.query(`UPDATE sessions SET ghost_until = now() + make_interval(hours => $2) WHERE token_hash = $1`, [req.sessionHash, HOURS]);

// Czy GHOST jest odblokowany i czy trzeba najpierw ustawić hasło (tylko właściciel konta bez hasła).
r.get('/stan', wrap(async (req, res) => {
  const a = await account(req.user.id), ok = !!(a && a.is_active);
  res.json({ odblokowany: ok && !!a.password_hash && !!(await unlockedUntil(req)), ustaw_haslo: ok && !a.password_hash, login: req.user.login });
}));

// Pierwsze wejście właściciela konta: własne hasło do GHOST (inne niż do MXT).
r.post('/haslo', wrap(async (req, res) => {
  const b = req.body || {}, pass = String(b.nowe || '');
  const a = await account(req.user.id);
  if (!a || !a.is_active) throw bad(403, 'To konto nie ma dostępu do GHOST.');
  if (a.password_hash) throw bad(409, 'Hasło do GHOST jest już ustawione – zaloguj się.');
  const probs = require('../lib/password').problems(pass, { login: req.user.login });
  if (probs.length) throw bad(400, 'Hasło: ' + probs.join(', ') + '.');
  if (b.powtorz !== pass) throw bad(400, 'Powtórzone hasło nie zgadza się z nowym.');
  const mxt = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (await bcrypt.compare(pass, mxt.password_hash)) throw bad(400, 'Hasło do GHOST musi być inne niż hasło do MXT.');
  const u = await pool.query('UPDATE ghost_accounts SET password_hash = $2, password_set_at = now(), last_login_at = now() WHERE user_id = $1 AND password_hash IS NULL',
    [req.user.id, await bcrypt.hash(pass, 12)]);
  if (!u.rowCount) throw bad(409, 'Hasło do GHOST jest już ustawione – zaloguj się.');
  await unlock(req);
  await audit(req, 'ghost.haslo_ustawione', { resource: 'ghost_accounts', resourceId: req.user.id });
  res.status(201).json({ odblokowany: true });
}));

// Logowanie: login konta MXT, na którym jesteś, i hasło do GHOST. Odpowiedź nie zdradza, czy konto GHOST istnieje.
r.post('/login', wrap(async (req, res) => {
  const b = req.body || {}, login = String(b.login || '').trim().toLowerCase().slice(0, 100), pass = String(b.haslo || '').slice(0, 200);
  const t = tries.get(req.user.id) || { n: 0, ts: Date.now() };
  if (t.n >= 5) return res.status(429).json({ error: 'Zbyt wiele nieudanych prób. Spróbuj ponownie za kilka minut.' });
  const a = await account(req.user.id), usable = !!(a && a.is_active && a.password_hash);
  const passOk = await bcrypt.compare(pass, usable ? a.password_hash : DUMMY_HASH);
  if (!(usable && passOk && login === String(req.user.login).toLowerCase())) {
    t.n++; tries.set(req.user.id, t);
    await audit(req, 'ghost.logowanie', { status: 'odmowa', details: { login } });
    // 400, nie 401: 401 aplikacja traktuje jako wygaśnięcie sesji MXT i wylogowuje.
    return res.status(400).json({ error: 'Nieprawidłowy login lub hasło.' });
  }
  tries.delete(req.user.id);
  await unlock(req);
  await pool.query('UPDATE ghost_accounts SET last_login_at = now() WHERE user_id = $1', [req.user.id]);
  await audit(req, 'ghost.logowanie', { resource: 'ghost_accounts', resourceId: req.user.id });
  res.json({ odblokowany: true });
}));

r.post('/wyloguj', wrap(async (req, res) => {
  await pool.query('UPDATE sessions SET ghost_until = NULL WHERE token_hash = $1', [req.sessionHash]);
  await audit(req, 'ghost.wylogowanie');
  res.json({ odblokowany: false });
}));

// Zawartość panelu (na razie powitanie) – tylko po odblokowaniu.
r.get('/panel', wrap(async (req, res) => {
  const a = await account(req.user.id), until = a && a.is_active && a.password_hash ? await unlockedUntil(req) : null;
  if (!until) throw bad(403, 'Zaloguj się do GHOST.');
  res.json({ witaj: req.user.full_name || req.user.login, odblokowany_do: until });
}));

module.exports = r;
