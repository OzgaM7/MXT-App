'use strict';
// Pracownicy terenowi – „Moje montaże” (rola monter, uprawnienie field.own).
// Monter widzi wyłącznie montaże ekipy, do której jest przypisany (lib/scope.js), i tylko dane potrzebne do pracy:
// termin, adres, zakres, urządzenia, materiały, skład ekipy. Bez finansów, wartości kontraktów i danych innych ekip.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/rbac');
const { crewsOfUser } = require('../lib/scope');
const { wrap, idParam, bad } = require('./_util');

const r = express.Router();
const field = requirePerm('field.own');
const DEV_LABEL = { podzielnik: 'Podzielnik kosztów', wodomierz: 'Wodomierz', cieplomierz: 'Ciepłomierz', modul_radiowy: 'Moduł radiowy', inny: 'Inne' };

// Tylko pola potrzebne monterowi (świadomie bez kolumn finansowych i bez project.value_net).
const FIELDS = `x.id, x.number, x.status, x.planned_date, x.planned_end, x.scope, x.devices_planned, x.materials, x.notes, x.accepted_at,
  b.name AS building_name, b.address, b.city, b.postal_code, b.units_count, b.heating_type, c.name AS customer_name, cr.name AS crew_name,
  (SELECT count(*)::int FROM devices d WHERE d.installation_id = x.id) AS devices_installed`;
const FROM = `FROM installations x JOIN buildings b ON b.id = x.building_id LEFT JOIN customers c ON c.id = b.customer_id LEFT JOIN crews cr ON cr.id = x.crew_id`;

// Profil: z jakim instalatorem i ekipą powiązane jest konto.
r.get('/', field, wrap(async (req, res) => {
  const q = await pool.query(`SELECT i.id, i.name, i.phone, i.crew_id, c.name AS crew_name, c.leader, c.phone AS crew_phone
    FROM installers i LEFT JOIN crews c ON c.id = i.crew_id WHERE i.user_id = $1 AND i.is_active`, [req.user.id]);
  const me = q.rows[0] || null;
  const team = me && me.crew_id ? (await pool.query('SELECT name, phone FROM installers WHERE crew_id = $1 AND is_active ORDER BY name', [me.crew_id])).rows : [];
  res.json({ installer: me, team });
}));

// Lista: nadchodzące i trwające (domyślnie) albo ostatnie 90 dni + przyszłe (zakres=wszystkie).
r.get('/montaze', field, wrap(async (req, res) => {
  const crews = await crewsOfUser(req.user.id);
  if (!crews.length) return res.json([]);
  const all = req.query.zakres === 'wszystkie';
  const q = await pool.query(`SELECT ${FIELDS} ${FROM} WHERE x.crew_id = ANY($1::uuid[]) AND ${all
      ? `x.planned_date >= current_date - 90`
      : `x.status IN ('zaplanowany', 'w_toku') AND coalesce(x.planned_end, x.planned_date) >= current_date - 7`}
    ORDER BY x.planned_date ${all ? 'DESC' : 'ASC'}, x.number LIMIT 200`, [crews]);
  res.json(q.rows);
}));

r.get('/montaze/:id', idParam, field, wrap(async (req, res) => {
  const crews = await crewsOfUser(req.user.id);
  const x = (await pool.query(`SELECT ${FIELDS}, x.crew_id ${FROM} WHERE x.id = $1`, [req.params.id])).rows[0];
  // Cudzy montaż: ta sama odpowiedź co dla nieistniejącego (nie zdradza, że istnieje) + wpis w rejestrze.
  if (!x || !crews.includes(x.crew_id)) {
    if (x) await audit(req, 'odmowa_dostepu', { status: 'odmowa', resource: 'GET /api/moje/montaze/:id', resourceId: req.params.id, details: { powod: 'montaż innej ekipy' } });
    throw bad(404, 'Nie znaleziono montażu.');
  }
  const [team, dev] = await Promise.all([
    pool.query('SELECT name, phone FROM installers WHERE crew_id = $1 AND is_active ORDER BY name', [x.crew_id]),
    pool.query('SELECT type, serial_no, model, location, status FROM devices WHERE installation_id = $1 ORDER BY location, serial_no', [x.id])
  ]);
  delete x.crew_id;
  res.json({ ...x, team: team.rows, devices: dev.rows.map(d => ({ ...d, type_label: DEV_LABEL[d.type] || d.type })) });
}));

module.exports = r;
