'use strict';
// Globalne wyszukiwanie (lib/search.js) i zapisane widoki list (filtry użytkownika, tylko własne).
const express = require('express');
const { pool } = require('../db');
const { requirePerm } = require('../lib/rbac');
const { search } = require('../lib/search');
const { wrap, bad, idParam, V } = require('./_util');

const r = express.Router();

r.get('/szukaj', requirePerm('search.global'), wrap(async (req, res) => {
  res.json({ q: String(req.query.q || '').slice(0, 80), groups: await search(req.user, req.query.q) });
}));

// ---------- zapisane widoki ----------
const MODULE = /^[a-z0-9_.-]{2,60}$/;
r.get('/widoki', wrap(async (req, res) => {
  const m = String(req.query.modul || '');
  if (!MODULE.test(m)) throw bad(400, 'Moduł: nieprawidłowa wartość.');
  res.json((await pool.query('SELECT id, name, params, created_at FROM user_views WHERE user_id = $1 AND module = $2 ORDER BY lower(name)', [req.user.id, m])).rows);
}));
r.post('/widoki', wrap(async (req, res) => {
  const b = req.body || {};
  const m = String(b.modul || ''), name = V.str(b.nazwa, 80, true, 'Nazwa widoku');
  if (!MODULE.test(m)) throw bad(400, 'Moduł: nieprawidłowa wartość.');
  const params = b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? b.params : null;
  if (!params) throw bad(400, 'Brak ustawień widoku.');
  const json = JSON.stringify(params);
  if (json.length > 4000) throw bad(400, 'Za dużo ustawień w widoku.');
  if ((await pool.query('SELECT count(*)::int n FROM user_views WHERE user_id = $1 AND module = $2', [req.user.id, m])).rows[0].n >= 30 &&
      !(await pool.query('SELECT 1 FROM user_views WHERE user_id = $1 AND module = $2 AND name = $3', [req.user.id, m, name])).rows[0]) throw bad(409, 'Limit 30 zapisanych widoków w jednym module.');
  // Ta sama nazwa nadpisuje ustawienia widoku (zapis „pod tą samą nazwą”).
  const q = await pool.query(`INSERT INTO user_views (user_id, module, name, params) VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, module, name) DO UPDATE SET params = excluded.params RETURNING id, name, params, created_at`, [req.user.id, m, name, json]);
  res.status(201).json(q.rows[0]);
}));
r.delete('/widoki/:id', idParam, wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM user_views WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono widoku.');
  res.json({ ok: true });
}));

module.exports = r;
