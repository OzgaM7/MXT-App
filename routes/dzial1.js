'use strict';
// Dział 1 – Podzielniki i Montaże: budynki i wspólnoty, urządzenia i numery seryjne, harmonogram montaży, ekipy
// i instalatorzy, protokół odbioru (PDF), kontrakty i rozliczenia, rentowność na budynek i zlecenie.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm, can } = require('../lib/rbac');
const docs = require('../lib/docs');
const pdf = require('../lib/pdf');
const { wrap, idParam, V, bad, patchSql, sendPdf, checkFresh, assertFresh, listLimit } = require('./_util');
const { notify } = require('../lib/notify');
const { usersOfCrew } = require('../lib/scope');

const r = express.Router();
const use = requirePerm('tasks.use');
const DEP = 'podzielniki-i-montaze';
const DEV_TYPES = ['podzielnik', 'wodomierz', 'cieplomierz', 'modul_radiowy', 'inny'];
const DEV_LABEL = { podzielnik: 'Podzielnik kosztów', wodomierz: 'Wodomierz', cieplomierz: 'Ciepłomierz', modul_radiowy: 'Moduł radiowy', inny: 'Inne' };
const INST_ST = ['zaplanowany', 'w_toku', 'wykonany', 'odebrany', 'anulowany'];

// rentowność: przychody − koszty (PLN) z Finance Intelligence
const { PROFIT } = require('../lib/erp/profit');   // przychody z finansów, koszty z księgi kosztów (materiały, robocizna)
const { plToday } = require('../lib/dzis');

// ---------- budynki ----------
const noMoney = ({ przychod, koszt, ...rest }) => rest;   // bez finance.view: bez przychodów i kosztów
function buildingFields(b, partial) {
  const o = {}, set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set('customer_id', v => V.uuid(v, 'Wspólnota / spółdzielnia'));
  set('name', v => V.str(v, 200, true, 'Nazwa budynku'));
  set('address', v => V.str(v, 300, true, 'Adres'));
  set('city', v => V.str(v, 100)); set('postal_code', v => V.str(v, 10));
  set('units_count', v => V.num(v, 0, 100000, 'Liczba lokali'));
  set('heating_type', v => V.str(v, 100)); set('notes', v => V.str(v, 4000));
  return o;
}
r.get('/budynki', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(x.name ILIKE $1 OR x.address ILIKE $1 OR x.city ILIKE $1 OR c.name ILIKE $1)`); }
  w.push(req.query.archiwum === '1' ? 'x.archived_at IS NOT NULL' : 'x.archived_at IS NULL');   // archiwum osobno, domyślnie aktywne
  const q = await pool.query(`SELECT count(*) OVER()::int AS total_count, x.*, c.name AS customer_name,
      (SELECT count(*)::int FROM devices d WHERE d.building_id = x.id AND d.status = 'zamontowane') AS devices,
      (SELECT count(*)::int FROM installations i WHERE i.building_id = x.id) AS installations,
      (SELECT count(*)::int FROM complaints k WHERE k.building_id = x.id AND k.status NOT IN ('rozwiazana','odrzucona')) AS open_complaints, ${PROFIT('building_id')}
    FROM buildings x LEFT JOIN customers c ON c.id = x.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY x.city, x.name LIMIT ${listLimit(req, 500)}`, p);
  res.json(can(req.user, 'finance.view') ? q.rows : q.rows.map(noMoney));
}));
// Ten sam adres (bez wielkości liter, spacji i znaków interpunkcyjnych) w tym samym mieście – prawdopodobny duplikat.
const normAddr = `regexp_replace(lower(coalesce(%s, '')), '[^[:alnum:]]', '', 'g')`;
async function findBuildingDuplicate(o, exceptId) {
  const q = await pool.query(`SELECT id, name, address, city, archived_at FROM buildings WHERE ($3::uuid IS NULL OR id <> $3)
      AND ${normAddr.replace('%s', 'address')} = ${normAddr.replace('%s', '$1')} AND ${normAddr.replace('%s', 'city')} = ${normAddr.replace('%s', '$2')} LIMIT 1`,
    [o.address, o.city || '', exceptId || null]);
  return q.rows[0] || null;
}
r.post('/budynki', use, wrap(async (req, res) => {
  const o = buildingFields(req.body || {}, false);
  if (!(req.body || {}).potwierdz_duplikat) {
    const d = await findBuildingDuplicate(o);
    if (d) return res.status(409).json({ error: `Budynek pod tym adresem już jest: „${d.name}”, ${d.address}${d.city ? ', ' + d.city : ''}${d.archived_at ? ' (w archiwum)' : ''}. Otwórz istniejący albo potwierdź dodanie nowego (np. osobna klatka).`,
      duplikat: true, istniejacy: { id: d.id, name: d.name, archiwum: !!d.archived_at } });
  }
  const q = await pool.query(`INSERT INTO buildings (customer_id, name, address, city, postal_code, units_count, heating_type, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [o.customer_id, o.name, o.address, o.city, o.postal_code, o.units_count, o.heating_type, o.notes, req.user.id]);
  if (o.customer_id) await pool.query(`UPDATE customers SET departments = array_append(departments, $2) WHERE id = $1 AND NOT ($2 = ANY(departments))`, [o.customer_id, DEP]);
  await audit(req, 'budynek.utworzenie', { resource: 'buildings', resourceId: q.rows[0].id, details: { nazwa: o.name } });
  res.status(201).json(q.rows[0]);
}));
r.patch('/budynki/:id', idParam, use, wrap(async (req, res) => {
  await assertFresh(pool, 'buildings', req.params.id, (req.body || {}).updated_at);
  const { sql, params } = patchSql('buildings', req.params.id, buildingFields(req.body || {}, true));
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono budynku.');
  await audit(req, 'budynek.zmiana', { resource: 'buildings', resourceId: req.params.id });
  res.json(q.rows[0]);
}));
// Usuwanie budynku: tylko bez historii (montaże, urządzenia, lokale, serwisy, odczyty, reklamacje, finanse). Z historią – archiwum.
const BREL = [['installations', 'montaże'], ['devices', 'urządzenia'], ['units', 'lokale'], ['service_orders', 'zlecenia serwisowe'], ['reading_schedules', 'harmonogramy odczytów'],
  ['complaints', 'reklamacje'], ['finance', 'wpisy finansowe']];
async function buildingRelations(c, id) {
  const r = (await c.query(`SELECT ${BREL.map(([t], i) => `(SELECT count(*)::int FROM ${t} WHERE building_id = $1) AS r${i}`).join(', ')}`, [id])).rows[0];
  return BREL.map(([, l], i) => [l, r['r' + i]]).filter(([, n]) => n > 0);
}
r.get('/budynki/:id/powiazania', idParam, use, wrap(async (req, res) => res.json(await buildingRelations(pool, req.params.id))));
r.delete('/budynki/:id', idParam, use, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = (await client.query('SELECT id, name, address FROM buildings WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!b) throw bad(404, 'Nie znaleziono budynku.');
    const rel = await buildingRelations(client, b.id);
    if (rel.length) throw bad(409, `Budynek ma historię (${rel.map(([l, n]) => `${l}: ${n}`).join(', ')}) – nie można go usunąć. Przenieś go do archiwum.`);
    await client.query('DELETE FROM buildings WHERE id = $1', [b.id]);
    await audit(req, 'budynek.usuniecie', { resource: 'buildings', resourceId: b.id, details: { nazwa: b.name, adres: b.address }, client });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.post('/budynki/:id/archiwizuj', idParam, use, wrap(async (req, res) => {
  const q = await pool.query(`UPDATE buildings SET archived_at = now(), archived_by = $2, updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING name`, [req.params.id, req.user.id]);
  if (!q.rows[0]) throw bad(409, 'Budynek nie istnieje albo jest już w archiwum.');
  await audit(req, 'budynek.archiwizacja', { resource: 'buildings', resourceId: req.params.id, details: { nazwa: q.rows[0].name } });
  res.json({ ok: true });
}));
r.post('/budynki/:id/przywroc', idParam, use, wrap(async (req, res) => {
  const q = await pool.query(`UPDATE buildings SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL RETURNING id`, [req.params.id]);
  if (!q.rows[0]) throw bad(409, 'Budynek nie jest w archiwum.');
  await audit(req, 'budynek.przywrocenie', { resource: 'buildings', resourceId: req.params.id });
  res.json({ ok: true });
}));
r.get('/budynki/:id', idParam, use, wrap(async (req, res) => {
  const id = req.params.id;
  const b = (await pool.query(`SELECT x.*, c.name AS customer_name, ${PROFIT('building_id')} FROM buildings x LEFT JOIN customers c ON c.id = x.customer_id WHERE x.id = $1`, [id])).rows[0];
  if (!b) throw bad(404, 'Nie znaleziono budynku.');
  const [d, i, k, f] = await Promise.all([
    pool.query(`SELECT d.*, i.number AS installation_number FROM devices d LEFT JOIN installations i ON i.id = d.installation_id WHERE d.building_id = $1 ORDER BY d.location, d.serial_no`, [id]),
    pool.query(`SELECT i.id, i.number, i.planned_date, i.status, cr.name AS crew_name, i.protocol_document_id FROM installations i LEFT JOIN crews cr ON cr.id = i.crew_id WHERE i.building_id = $1 ORDER BY i.planned_date DESC`, [id]),
    pool.query(`SELECT id, number, title, status, reported_at FROM complaints WHERE building_id = $1 ORDER BY reported_at DESC`, [id]),
    pool.query(`SELECT id, kind, category, description, amount_pln::float AS amount_pln, entry_date, invoice_no, paid_at FROM finance WHERE building_id = $1 ORDER BY entry_date DESC`, [id])
  ]);
  const finOk = can(req.user, 'finance.view');   // przychody, koszty i faktury budynku – tylko z dostępem do finansów
  res.json({ ...(finOk ? b : noMoney(b)), devices: d.rows, installations: i.rows, complaints: k.rows, finance: finOk ? f.rows : [] });
}));

// ---------- urządzenia ----------
r.get('/urzadzenia', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (req.query.building_id) { p.push(V.uuid(req.query.building_id)); w.push(`d.building_id = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 60) + '%'); w.push(`(d.serial_no ILIKE $${p.length} OR d.model ILIKE $${p.length} OR d.location ILIKE $${p.length})`); }
  if (DEV_TYPES.includes(req.query.typ)) { p.push(req.query.typ); w.push(`d.type = $${p.length}`); }
  if (['magazyn', 'zamontowane', 'zdemontowane', 'wadliwe'].includes(req.query.status)) { p.push(req.query.status); w.push(`d.status = $${p.length}`); }
  const W = w.length ? 'WHERE ' + w.join(' AND ') : '';
  // Stronicowanie (projekty z tysiącami podzielników): ?strona=N po 100 pozycji, łączna liczba w nagłówku X-Total-Count.
  // Bez parametru strona – jak dotąd 500 ostatnich.
  const page = Math.max(0, parseInt(req.query.strona, 10) || 0), per = 100;
  const q = await pool.query(`SELECT d.*, b.name AS building_name, b.address, i.number AS installation_number FROM devices d LEFT JOIN buildings b ON b.id = d.building_id
    LEFT JOIN installations i ON i.id = d.installation_id ${W} ORDER BY d.created_at DESC, d.serial_no LIMIT ${page ? per : 500} OFFSET ${page ? (page - 1) * per : 0}`, p);
  if (page) res.set('X-Total-Count', String((await pool.query(`SELECT count(*)::int n FROM devices d ${W}`, p)).rows[0].n));
  res.json(q.rows);
}));
// Dodanie jednego lub wielu urządzeń (lista numerów seryjnych – jeden na linię).
r.post('/urzadzenia', use, wrap(async (req, res) => {
  const b = req.body || {};
  const serials = [...new Set((Array.isArray(b.serials) ? b.serials : String(b.serials || b.serial_no || '').split(/[\n,;]+/)).map(s => String(s).trim()).filter(Boolean))];
  if (!serials.length) throw bad(400, 'Podaj numer seryjny (lub listę numerów, jeden na linię).');
  if (serials.length > 1000) throw bad(400, 'Najwyżej 1000 urządzeń naraz.');
  if (serials.some(s => !/^[A-Za-z0-9._\-/]{3,40}$/.test(s))) throw bad(400, 'Numer seryjny: 3–40 znaków (litery, cyfry, . _ - /).');
  const type = V.oneOf(b.type, DEV_TYPES, 'Typ urządzenia'), building = V.uuid(b.building_id, 'Budynek', true), inst = V.uuid(b.installation_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT serial_no FROM devices WHERE serial_no = ANY($1)', [serials]);
    if (dup.rows.length) throw bad(409, 'Numery seryjne już istnieją w bazie: ' + dup.rows.map(x => x.serial_no).slice(0, 10).join(', '));
    for (const s of serials) await client.query(`INSERT INTO devices (building_id, installation_id, type, serial_no, model, location, status, installed_at, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [building, inst, type, s, V.str(b.model, 100), serials.length === 1 ? V.str(b.location, 200) : '', V.oneOf(b.status, ['magazyn', 'zamontowane'], 'Status', 'zamontowane'),
      V.date(b.installed_at), V.str(b.notes, 1000), req.user.id]);
    await audit(req, 'urzadzenia.dodanie', { resource: 'devices', details: { liczba: serials.length, typ: type, budynek: building }, client });
    await client.query('COMMIT');
    res.status(201).json({ added: serials.length });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.patch('/urzadzenia/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.status !== undefined) f.status = V.oneOf(b.status, ['magazyn', 'zamontowane', 'zdemontowane', 'wadliwe'], 'Status');
  if (b.location !== undefined) f.location = V.str(b.location, 200);
  if (b.model !== undefined) f.model = V.str(b.model, 100);
  if (b.notes !== undefined) f.notes = V.str(b.notes, 1000);
  if (b.installation_id !== undefined) f.installation_id = V.uuid(b.installation_id);
  const { sql, params } = patchSql('devices', req.params.id, f);
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono urządzenia.');
  await audit(req, 'urzadzenie.zmiana', { resource: 'devices', resourceId: req.params.id, details: f });
  res.json(q.rows[0]);
}));

// ---------- ekipy i instalatorzy ----------
r.get('/ekipy', use, wrap(async (req, res) => {
  const [c, i] = await Promise.all([
    pool.query(`SELECT c.*, (SELECT count(*)::int FROM installations x WHERE x.crew_id = c.id AND x.status IN ('zaplanowany','w_toku') AND x.planned_date >= current_date) AS upcoming
      FROM crews c ORDER BY c.is_active DESC, c.name`),
    pool.query('SELECT i.*, u.login AS user_login FROM installers i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.is_active DESC, i.name')
  ]);
  res.json(c.rows.map(x => ({ ...x, installers: i.rows.filter(y => y.crew_id === x.id) })).concat([{ id: null, name: 'Bez ekipy', installers: i.rows.filter(y => !y.crew_id), virtual: true }]));
}));
r.post('/ekipy', use, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query('INSERT INTO crews (name, leader, phone) VALUES ($1, $2, $3) RETURNING *', [V.str(b.name, 100, true, 'Nazwa ekipy'), V.str(b.leader, 100), V.str(b.phone, 50)]);
  await audit(req, 'ekipa.utworzenie', { resource: 'crews', resourceId: q.rows[0].id });
  res.status(201).json(q.rows[0]);
}));
r.patch('/ekipy/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  for (const [k, m] of [['name', 100], ['leader', 100], ['phone', 50]]) if (b[k] !== undefined) f[k] = V.str(b[k], m, k === 'name', 'Nazwa ekipy');
  if (b.is_active !== undefined) f.is_active = !!b.is_active;
  const { sql, params } = patchSql('crews', req.params.id, f);
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono ekipy.');
  await audit(req, 'ekipa.zmiana', { resource: 'crews', resourceId: req.params.id });
  res.json(q.rows[0]);
}));
r.post('/instalatorzy', use, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query('INSERT INTO installers (crew_id, name, phone, qualifications) VALUES ($1, $2, $3, $4) RETURNING *',
    [V.uuid(b.crew_id), V.str(b.name, 120, true, 'Imię i nazwisko'), V.str(b.phone, 50), V.str(b.qualifications, 500)]);
  await audit(req, 'instalator.dodanie', { resource: 'installers', resourceId: q.rows[0].id });
  res.status(201).json(q.rows[0]);
}));
r.patch('/instalatorzy/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.crew_id !== undefined) f.crew_id = V.uuid(b.crew_id);
  for (const [k, m] of [['name', 120], ['phone', 50], ['qualifications', 500]]) if (b[k] !== undefined) f[k] = V.str(b[k], m, k === 'name', 'Imię i nazwisko');
  if (b.is_active !== undefined) f.is_active = !!b.is_active;
  const before = (await pool.query('SELECT crew_id FROM installers WHERE id = $1', [req.params.id])).rows[0];
  const { sql, params } = patchSql('installers', req.params.id, f);
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono instalatora.');
  await audit(req, 'instalator.zmiana', { resource: 'installers', resourceId: req.params.id });
  const i = q.rows[0];
  if (i.user_id && f.crew_id !== undefined && before && before.crew_id !== i.crew_id) {
    const crew = i.crew_id ? (await pool.query('SELECT name FROM crews WHERE id = $1', [i.crew_id])).rows[0] : null;
    await notify([i.user_id], { kind: 'ekipa.przydzial', title: crew ? `Przydział do ekipy ${crew.name}` : 'Odłączono Cię od ekipy',
      body: crew ? 'W „Moje montaże” widzisz teraz montaże tej ekipy.' : 'Nie widzisz już montaży poprzedniej ekipy.', link: '/moje-montaze' });
  }
  res.json(q.rows[0]);
}));

// ---------- harmonogram montaży ----------
const INST_SELECT = `SELECT x.*, b.name AS building_name, b.address, b.city, c.name AS customer_name, cr.name AS crew_name, p.number AS project_number,
  (SELECT count(*)::int FROM devices d WHERE d.installation_id = x.id) AS devices_installed, ${PROFIT('installation_id')}
  FROM installations x JOIN buildings b ON b.id = x.building_id LEFT JOIN customers c ON c.id = b.customer_id LEFT JOIN crews cr ON cr.id = x.crew_id LEFT JOIN projects p ON p.id = x.project_id`;
r.get('/montaze', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (req.query.od) { p.push(V.date(req.query.od)); w.push(`x.planned_date >= $${p.length}`); }
  if (req.query.do) { p.push(V.date(req.query.do)); w.push(`x.planned_date <= $${p.length}`); }
  if (req.query.crew_id) { p.push(V.uuid(req.query.crew_id)); w.push(`x.crew_id = $${p.length}`); }
  if (INST_ST.includes(req.query.status)) { p.push(req.query.status); w.push(`x.status = $${p.length}`); }
  const q = await pool.query(INST_SELECT + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY x.planned_date, x.number LIMIT 500', p);
  res.json(can(req.user, 'finance.view') ? q.rows : q.rows.map(noMoney));
}));
function materials(v) {
  return JSON.stringify((Array.isArray(v) ? v : []).slice(0, 100).map(m => ({ nazwa: V.str(m.nazwa, 200), ilosc: V.num(m.ilosc, 0, 1e6, 'Ilość materiału'), jm: V.str(m.jm, 10) || 'szt.' })).filter(m => m.nazwa));
}
r.post('/montaze', use, wrap(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const building = V.uuid(b.building_id, 'Budynek', true), crew = V.uuid(b.crew_id), date = V.date(b.planned_date, 'Termin', true), end = V.date(b.planned_end, 'Termin zakończenia');
    if (end && end < date) throw bad(400, 'Termin zakończenia nie może być wcześniejszy niż rozpoczęcia.');
    if (crew) {
      const clash = await client.query(`SELECT number FROM installations WHERE crew_id = $1 AND status IN ('zaplanowany','w_toku')
        AND daterange(planned_date, coalesce(planned_end, planned_date), '[]') && daterange($2::date, coalesce($3::date, $2::date), '[]')`, [crew, date, end]);
      if (clash.rows.length && !b.allow_clash) throw bad(409, `Ekipa ma już montaż w tym terminie (${clash.rows.map(x => x.number).join(', ')}). Zmień termin lub zaznacz zgodę na nakładanie.`);
    }
    const number = await docs.nextNumber(client, 'MZ');
    const q = await client.query(`INSERT INTO installations (number, project_id, building_id, crew_id, planned_date, planned_end, scope, devices_planned, materials, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [number, V.uuid(b.project_id), building, crew, date, end, V.str(b.scope, 4000), V.num(b.devices_planned, 0, 100000, 'Liczba urządzeń'),
      materials(b.materials), V.str(b.notes, 4000), req.user.id]);
    await audit(req, 'montaz.zaplanowanie', { resource: 'installations', resourceId: q.rows[0].id, details: { numer: number, termin: date }, client });
    if (crew) await notifyCrew(client, crew, q.rows[0], 'montaz.przydzial', `Nowy montaż ${number}`);
    await client.query('COMMIT');
    res.status(201).json(q.rows[0]);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.get('/montaze/:id', idParam, use, wrap(async (req, res) => {
  const x = (await pool.query(INST_SELECT + ' WHERE x.id = $1', [req.params.id])).rows[0];
  if (!x) throw bad(404, 'Nie znaleziono montażu.');
  const d = await pool.query('SELECT * FROM devices WHERE installation_id = $1 ORDER BY location, serial_no', [x.id]);
  const inst = x.crew_id ? (await pool.query('SELECT name, phone FROM installers WHERE crew_id = $1 AND is_active ORDER BY name', [x.crew_id])).rows : [];
  res.json({ ...(can(req.user, 'finance.view') ? x : noMoney(x)), devices: d.rows, installers: inst });
}));
r.patch('/montaze/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.status !== undefined) { f.status = V.oneOf(b.status, INST_ST, 'Status'); if (f.status === 'odebrany') throw bad(400, 'Odbiór zapisuje się przez wygenerowanie protokołu odbioru.'); }
  if (b.crew_id !== undefined) f.crew_id = V.uuid(b.crew_id);
  if (b.planned_date !== undefined) f.planned_date = V.date(b.planned_date, 'Termin', true);
  if (b.planned_end !== undefined) f.planned_end = V.date(b.planned_end, 'Termin zakończenia');
  if (b.scope !== undefined) f.scope = V.str(b.scope, 4000);
  if (b.notes !== undefined) f.notes = V.str(b.notes, 4000);
  if (b.devices_planned !== undefined) f.devices_planned = V.num(b.devices_planned, 0, 100000, 'Liczba urządzeń');
  if (b.materials !== undefined) f.materials = materials(b.materials);
  if (b.project_id !== undefined) f.project_id = V.uuid(b.project_id);
  const { sql, params } = patchSql('installations', req.params.id, f);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query('SELECT * FROM installations WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (old) checkFresh(old.updated_at, b.updated_at);
    if (!old) throw bad(404, 'Nie znaleziono montażu.');
    const x = (await client.query(sql, params)).rows[0];
    await audit(req, 'montaz.zmiana', { resource: 'installations', resourceId: req.params.id, details: f, client });
    // Powiadomienia tylko dla zmian istotnych dla ekipy (przydział, termin, anulowanie).
    const dateChanged = String(old.planned_date) !== String(x.planned_date) || String(old.planned_end) !== String(x.planned_end);
    if (old.crew_id !== x.crew_id) {
      if (old.crew_id) await notifyCrew(client, old.crew_id, x, 'montaz.odwolanie', `Montaż ${x.number} przekazany innej ekipie`);
      if (x.crew_id && x.status !== 'anulowany') await notifyCrew(client, x.crew_id, x, 'montaz.przydzial', `Nowy montaż ${x.number}`);
    } else if (x.crew_id && x.status === 'anulowany' && old.status !== 'anulowany') {
      await notifyCrew(client, x.crew_id, x, 'montaz.anulowanie', `Anulowano montaż ${x.number}`);
    } else if (x.crew_id && dateChanged && x.status !== 'anulowany') {
      await notifyCrew(client, x.crew_id, x, 'montaz.zmiana_terminu', `Zmiana terminu montażu ${x.number}`);
    }
    await client.query('COMMIT');
    res.json(x);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
// Powiadomienie kont instalatorów ekipy o montażu (adres i termin w treści, link do „Moje montaże”).
async function notifyCrew(client, crewId, x, kind, title) {
  const users = await usersOfCrew(crewId, client);
  if (!users.length) return 0;
  const b = (await client.query('SELECT name, address, city FROM buildings WHERE id = $1', [x.building_id])).rows[0] || {};
  // Data w formacie polskim (DD.MM.RRRR) – kolumny date przychodzą jako tekst RRRR-MM-DD albo Date.
  const d = v => {
    if (!v) return '';
    const s = v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
  };
  const when = d(x.planned_date) + (x.planned_end && String(x.planned_end) !== String(x.planned_date) ? ' – ' + d(x.planned_end) : '');
  return notify(users, { kind, title, body: `${b.name || ''}, ${b.address || ''}${b.city ? ', ' + b.city : ''} · termin: ${when}`,
    link: '/moje-montaze?m=' + x.id, related_type: 'installation', related_id: x.id }, { client });
}

// Protokół odbioru (PDF): zapisywany jako dokument z wersjami; montaż przechodzi w stan „odebrany”.
r.post('/montaze/:id/protokol', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, accepted = V.str(b.accepted_by, 200, true, 'Osoba odbierająca (przedstawiciel zleceniodawcy)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const x = (await client.query(`SELECT x.*, b.name AS building_name, b.address, b.city, c.name AS customer_name, cr.name AS crew_name FROM installations x JOIN buildings b ON b.id = x.building_id
      LEFT JOIN customers c ON c.id = b.customer_id LEFT JOIN crews cr ON cr.id = x.crew_id WHERE x.id = $1 FOR UPDATE OF x`, [req.params.id])).rows[0];
    if (!x) throw bad(404, 'Nie znaleziono montażu.');
    if (!['wykonany', 'odebrany'].includes(x.status)) throw bad(409, 'Protokół odbioru generuje się dla montażu w stanie „wykonany”.');
    const devices = (await client.query('SELECT type, serial_no, model, location FROM devices WHERE installation_id = $1 ORDER BY location, serial_no', [x.id])).rows.map(d => ({ ...d, type: DEV_LABEL[d.type] }));
    let docId = x.protocol_document_id, number;
    if (!docId) { number = await docs.nextNumber(client, 'PO'); docId = (await docs.createDocument(client, { kind: 'protokol', title: `Protokół odbioru ${number}`, department_id: DEP, related_type: 'installation', related_id: x.id, userId: req.user.id })).id; }
    else number = (await client.query('SELECT title FROM documents WHERE id = $1', [docId])).rows[0].title.replace('Protokół odbioru ', '');
    const data = { number, date: plToday(), customer: x.customer_name || '–', building: x.building_name, address: `${x.address}${x.city ? ', ' + x.city : ''}`,
      installation: x.number, crew: x.crew_name || '–', planned_date: x.planned_date, planned_end: x.planned_end, scope: x.scope, devices, materials: x.materials, notes: V.str(b.notes, 2000) || x.notes, accepted_by: accepted };
    const file = await pdf.protocol(data);
    const v = await docs.addVersion(client, docId, { content: data, file, fileName: number.replace(/\//g, '-') + '.pdf', mime: 'application/pdf', note: 'Protokół odbioru', userId: req.user.id });
    await client.query(`UPDATE installations SET status = 'odebrany', protocol_document_id = $2, accepted_by = $3, accepted_at = now(), updated_at = now() WHERE id = $1`, [x.id, docId, accepted]);
    await audit(req, 'montaz.protokol_odbioru', { resource: 'installations', resourceId: x.id, details: { protokol: number, wersja: v, urzadzenia: devices.length }, client });
    await client.query('COMMIT');
    require('../lib/events').emit('montaz.odebrany', { numer: x.number, budynek: x.building_name, protokol: number });
    res.status(201).json({ document_id: docId, version: v, number });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

// ---------- kontrakty i rozliczenia ----------
r.get('/kontrakty', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT x.*, x.value_net::float AS value_net, c.name AS customer_name,
      coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'przychod' AND f.invoice_no <> ''), 0)::float AS zafakturowano,
      coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'przychod' AND f.paid_at IS NOT NULL), 0)::float AS zaplacono,
      coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'koszt'), 0)::float AS koszt,
      (SELECT count(*)::int FROM installations i WHERE i.project_id = x.id) AS installations,
      (SELECT count(*)::int FROM installations i WHERE i.project_id = x.id AND i.status = 'odebrany') AS installations_done,
      (SELECT d.id FROM documents d WHERE d.related_type = 'project' AND d.related_id = x.id AND d.kind = 'inny' ORDER BY d.created_at LIMIT 1) AS document_id
    FROM projects x LEFT JOIN customers c ON c.id = x.customer_id WHERE x.department_id = $1 ORDER BY x.created_at DESC LIMIT 300`, [DEP]);
  res.json(q.rows.map(x => ({ ...x, do_zafakturowania: Math.max(0, Math.round((x.value_net - x.zafakturowano) * 100) / 100), marza: Math.round((x.zafakturowano - x.koszt) * 100) / 100 })));
}));
r.post('/kontrakty', use, wrap(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await docs.nextNumber(client, 'KT');
    const q = await client.query(`INSERT INTO projects (number, department_id, customer_id, title, value_net, status, start_date, end_date, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [number, DEP, V.uuid(b.customer_id, 'Klient', true), V.str(b.title, 200, true, 'Nazwa kontraktu'),
      V.num(b.value_net, 0, 1e10, 'Wartość netto'), V.oneOf(b.status, ['oferta', 'w_realizacji'], 'Status', 'w_realizacji'), V.date(b.start_date), V.date(b.end_date), V.str(b.notes, 4000), req.user.id]);
    await audit(req, 'kontrakt.utworzenie', { resource: 'projects', resourceId: q.rows[0].id, details: { numer: number }, client });
    await client.query('COMMIT');
    res.status(201).json(q.rows[0]);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.patch('/kontrakty/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.status !== undefined) f.status = V.oneOf(b.status, ['oferta', 'w_realizacji', 'zakonczony', 'rozliczony', 'anulowany'], 'Status');
  if (b.title !== undefined) f.title = V.str(b.title, 200, true, 'Nazwa kontraktu');
  if (b.value_net !== undefined) f.value_net = V.num(b.value_net, 0, 1e10, 'Wartość netto');
  if (b.end_date !== undefined) f.end_date = V.date(b.end_date);
  if (b.notes !== undefined) f.notes = V.str(b.notes, 4000);
  const { sql, params } = patchSql('projects', req.params.id, f);
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono kontraktu.');
  await audit(req, 'kontrakt.zmiana', { resource: 'projects', resourceId: req.params.id, details: f });
  res.json(q.rows[0]);
}));

// ---------- rentowność ----------
r.get('/rentownosc', requirePerm('finance.view'), wrap(async (req, res) => {
  const [b, i, k] = await Promise.all([
    pool.query(`SELECT x.id, x.name, x.address, x.city, x.units_count, ${PROFIT('building_id')} FROM buildings x ORDER BY x.name`),
    pool.query(`SELECT x.id, x.number, x.planned_date, x.status, b.name AS building_name, ${PROFIT('installation_id')} FROM installations x JOIN buildings b ON b.id = x.building_id ORDER BY x.planned_date DESC LIMIT 200`),
    pool.query(`SELECT x.id, x.number, x.title, x.status, x.value_net::float AS value_net, ${PROFIT('project_id')} FROM projects x WHERE x.department_id = $1 ORDER BY x.created_at DESC`, [DEP])
  ]);
  const m = rows => rows.map(x => ({ ...x, marza: Math.round((x.przychod - x.koszt) * 100) / 100, marza_pct: x.przychod ? Math.round((x.przychod - x.koszt) / x.przychod * 1000) / 10 : null }));
  res.json({ buildings: m(b.rows), installations: m(i.rows), projects: m(k.rows) });
}));

r.get('/podsumowanie', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT (SELECT count(*)::int FROM buildings) AS budynki, (SELECT coalesce(sum(units_count), 0)::int FROM buildings) AS lokale,
    (SELECT count(*)::int FROM devices WHERE status = 'zamontowane') AS urzadzenia,
    (SELECT count(*)::int FROM installations WHERE status IN ('zaplanowany','w_toku') AND planned_date BETWEEN current_date AND current_date + 14) AS montaze_14d,
    (SELECT count(*)::int FROM installations WHERE status = 'wykonany') AS do_odbioru,
    (SELECT count(*)::int FROM installations WHERE status IN ('zaplanowany','w_toku') AND planned_date <= current_date AND coalesce(planned_end, planned_date) >= current_date) AS trwajace,
    (SELECT count(*)::int FROM installations WHERE status IN ('zaplanowany','w_toku') AND crew_id IS NULL AND coalesce(planned_end, planned_date) >= current_date) AS bez_ekipy,
    (SELECT count(*)::int FROM complaints WHERE department_id = $1 AND status NOT IN ('rozwiazana','odrzucona')) AS reklamacje_otwarte,
    (SELECT count(*)::int FROM crews WHERE is_active) AS ekipy`, [DEP]);
  res.json(q.rows[0]);
}));

module.exports = r;
