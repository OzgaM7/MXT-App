'use strict';
// Pracownicy: kartoteka (stanowisko, stawka, forma zatrudnienia), dostępność (nieobecności), obciążenie (zlecenia, godziny),
// ewidencja czasu pracy (własna – każdy pracownik; zespołu – kierownik). Koszt robocizny = godziny × stawka z chwili wpisu.
const express = require('express');
const { pool } = require('../../db');
const { audit } = require('../../lib/audit');
const { can, requirePerm, ROLES } = require('../../lib/rbac');
const { tx, r2 } = require('../../lib/erp/stock');
const { wrap, bad, idParam, V } = require('../_util');
const { plToday } = require('../../lib/dzis');

const r = express.Router();
const mgr = requirePerm('employees.manage'), own = requirePerm('time.own');
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;
const REL = { installation: 'installations', service_order: 'service_orders', reading: 'readings', project: 'projects' };

r.get('/pracownicy', mgr, wrap(async (req, res) => {
  const from = V.date(req.query.od, 'Od') || plToday(-30);
  const q = await pool.query(`SELECT u.id, u.login, u.full_name, u.email, u.phone, u.role, u.extra_roles, u.is_active, u.position, u.hourly_rate::float AS hourly_rate, u.employment, u.hired_at, u.hr_notes,
      (SELECT count(*)::int FROM service_orders o WHERE o.assigned_to = u.id AND o.status IN ('przypisane','zaplanowane','w_realizacji','ponowna_wizyta')) AS serwisy_otwarte,
      (SELECT count(*)::int FROM reading_schedules s WHERE s.assigned_to = u.id AND s.is_active AND s.next_due <= ${TODAY} + 30) AS odczyty_30d,
      (SELECT count(*)::int FROM installations x JOIN installers i ON i.crew_id = x.crew_id WHERE i.user_id = u.id AND x.status IN ('zaplanowany','w_toku') AND x.planned_date <= ${TODAY} + 14) AS montaze_14d,
      (SELECT coalesce(sum(t.hours), 0)::float FROM time_entries t WHERE t.user_id = u.id AND t.work_date >= $1) AS godziny,
      (SELECT json_build_object('kind', a.kind, 'date_to', a.date_to) FROM absences a WHERE a.user_id = u.id AND ${TODAY} BETWEEN a.date_from AND a.date_to LIMIT 1) AS nieobecnosc
    FROM users u ORDER BY u.is_active DESC, coalesce(nullif(u.full_name, ''), u.login)`, [from]);
  res.json({ from, roles: ROLES, rows: q.rows });
}));
r.patch('/pracownicy/:id', idParam, mgr, wrap(async (req, res) => {
  const b = req.body || {}, o = {};
  if (b.position !== undefined) o.position = V.str(b.position, 100);
  if (b.hourly_rate !== undefined) o.hourly_rate = b.hourly_rate === '' || b.hourly_rate == null ? null : r2(V.num(b.hourly_rate, 0, 100000, 'Stawka godzinowa'));
  if (b.employment !== undefined) o.employment = V.oneOf(b.employment, ['', 'umowa_o_prace', 'zlecenie', 'b2b', 'inne'], 'Forma zatrudnienia');
  if (b.hired_at !== undefined) o.hired_at = V.date(b.hired_at, 'Data zatrudnienia');
  if (b.hr_notes !== undefined) o.hr_notes = V.str(b.hr_notes, 2000);
  const k = Object.keys(o);
  if (!k.length) throw bad(400, 'Brak zmian.');
  const q = await pool.query(`UPDATE users SET ${k.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING id, login, position, hourly_rate, employment, hired_at`, [req.params.id, ...k.map(f => o[f])]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono pracownika.');
  // Stawka jest daną płacową – zapis w rejestrze bez wartości.
  await audit(req, 'pracownik.kartoteka', { resource: 'users', resourceId: req.params.id, details: { pola: k } });
  res.json(q.rows[0]);
}));

// ---------- nieobecności (dostępność w kalendarzu) ----------
r.get('/nieobecnosci', mgr, wrap(async (req, res) => {
  const from = V.date(req.query.od, 'Od') || plToday();
  res.json((await pool.query(`SELECT a.*, coalesce(nullif(u.full_name, ''), u.login) AS name FROM absences a JOIN users u ON u.id = a.user_id WHERE a.date_to >= $1 ORDER BY a.date_from LIMIT 500`, [from])).rows);
}));
r.post('/nieobecnosci', mgr, wrap(async (req, res) => {
  const b = req.body || {};
  const from = V.date(b.date_from, 'Od', true), to = V.date(b.date_to, 'Do', true);
  if (to < from) throw bad(400, 'Data końca przed datą początku.');
  const uid = V.uuid(b.user_id, 'Pracownik', true);
  const clash = (await pool.query('SELECT 1 FROM absences WHERE user_id = $1 AND date_from <= $3 AND date_to >= $2', [uid, from, to])).rows[0];
  if (clash) throw bad(409, 'Pracownik ma już nieobecność w tym okresie.');
  const q = await pool.query(`INSERT INTO absences (user_id, kind, date_from, date_to, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [uid, V.oneOf(b.kind, ['urlop', 'l4', 'szkolenie', 'delegacja', 'inne'], 'Rodzaj'), from, to, V.str(b.note, 500), req.user.id]);
  await audit(req, 'pracownik.nieobecnosc', { resource: 'absences', resourceId: q.rows[0].id });
  res.status(201).json(q.rows[0]);
}));
r.delete('/nieobecnosci/:id', idParam, mgr, wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM absences WHERE id = $1 RETURNING id', [req.params.id]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono nieobecności.');
  await audit(req, 'pracownik.nieobecnosc.usuniecie', { resource: 'absences', resourceId: req.params.id });
  res.json({ ok: true });
}));

// ---------- czas pracy ----------
r.get('/czas', own, wrap(async (req, res) => {
  const from = V.date(req.query.od, 'Od') || plToday(-30), to = V.date(req.query.do, 'Do') || '2999-12-31';
  const team = can(req.user, 'employees.manage');
  const p = [from, to], w = ['t.work_date >= $1', 't.work_date <= $2'];
  if (!team) { p.push(req.user.id); w.push(`t.user_id = $${p.length}`); }
  else if (req.query.osoba) { p.push(V.uuid(req.query.osoba)); w.push(`t.user_id = $${p.length}`); }
  if (req.query.projekt) { p.push(V.uuid(req.query.projekt)); w.push(`t.project_id = $${p.length}`); }
  const rows = (await pool.query(`SELECT t.id, t.user_id, t.work_date, t.hours::float AS hours, t.related_type, t.related_id, t.project_id, t.note, t.created_at,
      ${team ? 't.cost::float AS cost, t.rate::float AS rate,' : ''} coalesce(nullif(u.full_name, ''), u.login) AS name, p.number AS project_number,
      coalesce(x.number, o.number, CASE WHEN t.related_type = 'reading' THEN 'odczyt' END) AS related_number
    FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN installations x ON t.related_type = 'installation' AND x.id = t.related_id LEFT JOIN service_orders o ON t.related_type = 'service_order' AND o.id = t.related_id
    WHERE ${w.join(' AND ')} ORDER BY t.work_date DESC, t.created_at DESC LIMIT 1000`, p)).rows;
  res.json({ team, rows, total_hours: r2(rows.reduce((s, x) => s + x.hours, 0)), total_cost: team ? r2(rows.reduce((s, x) => s + (x.cost || 0), 0)) : undefined });
}));
r.post('/czas', own, wrap(async (req, res) => {
  const b = req.body || {}, team = can(req.user, 'employees.manage');
  const uid = b.user_id && team ? V.uuid(b.user_id, 'Pracownik') : req.user.id;
  const date = V.date(b.work_date, 'Data', true), hours = r2(V.num(b.hours, 0.25, 24, 'Liczba godzin'));
  if (date > plToday(1)) throw bad(400, 'Nie można wpisać czasu pracy w przyszłości.');
  const relType = V.oneOf(b.related_type || 'inne', ['installation', 'service_order', 'reading', 'project', 'inne'], 'Czego dotyczy');
  const out = await tx(async c => {
    let relId = null, projectId = V.uuid(b.project_id, 'Projekt');
    if (relType !== 'inne') {
      relId = V.uuid(b.related_id, 'Zlecenie', true);
      const row = (await c.query(`SELECT * FROM ${REL[relType]} WHERE id = $1`, [relId])).rows[0];
      if (!row) throw bad(400, 'Nie znaleziono zlecenia.');
      if (relType === 'project') projectId = row.id;
      else if (relType === 'reading') projectId = projectId || (await c.query('SELECT project_id FROM reading_schedules WHERE id = $1', [row.schedule_id])).rows[0].project_id;
      else projectId = projectId || row.project_id || null;
    }
    const day = (await c.query('SELECT coalesce(sum(hours), 0)::float h FROM time_entries WHERE user_id = $1 AND work_date = $2', [uid, date])).rows[0].h;
    if (day + hours > 24) throw bad(400, `Suma godzin w dniu przekroczyłaby 24 h (już wpisano ${day} h).`);
    const u = (await c.query('SELECT hourly_rate, is_active FROM users WHERE id = $1', [uid])).rows[0];
    if (!u || !u.is_active) throw bad(400, 'Nieaktywne konto pracownika.');
    const rate = Number(u.hourly_rate || 0);
    const row = (await c.query(`INSERT INTO time_entries (user_id, work_date, hours, related_type, related_id, project_id, rate, cost, note, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, work_date, hours::float AS hours, related_type, related_id, project_id`,
      [uid, date, hours, relType, relId, projectId, rate, r2(hours * rate), V.str(b.note, 500), req.user.id])).rows[0];
    if (projectId) await c.query(`INSERT INTO project_events (project_id, kind, text, created_by) VALUES ($1, 'czas', $2, $3)`, [projectId, `Czas pracy: ${hours} h (${date})`, req.user.id]);
    return row;
  });
  await audit(req, 'czas.wpis', { resource: 'time_entries', resourceId: out.id, details: { godziny: hours, data: date, pracownik: uid } });
  res.status(201).json(out);
}));
// Usunięcie wpisu: własny w ciągu 7 dni od wpisania, kierownik – każdy.
r.delete('/czas/:id', idParam, own, wrap(async (req, res) => {
  const t = (await pool.query('SELECT * FROM time_entries WHERE id = $1', [req.params.id])).rows[0];
  if (!t) throw bad(404, 'Nie znaleziono wpisu.');
  const mine = t.user_id === req.user.id && Date.now() - new Date(t.created_at).getTime() < 7 * 864e5;
  if (!mine && !can(req.user, 'employees.manage')) throw bad(403, 'Możesz usunąć tylko własny wpis do 7 dni od jego dodania.');
  await pool.query('DELETE FROM time_entries WHERE id = $1', [t.id]);
  await audit(req, 'czas.usuniecie', { resource: 'time_entries', resourceId: t.id, details: { godziny: Number(t.hours), data: String(t.work_date).slice(0, 10) } });
  res.json({ ok: true });
}));

module.exports = r;
