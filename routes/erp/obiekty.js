'use strict';
// Ewidencja działu Ciepłomierze i podzielniki: lokale w budynkach, kartoteka urządzeń z pełną historią
// (montaż, serwisy, odczyty, zdarzenia, dokumenty) i odczyty per urządzenie z kontrolą kompletności i poprawności.
const express = require('express');
const { pool } = require('../../db');
const { audit } = require('../../lib/audit');
const { can, requirePerm } = require('../../lib/rbac');
const docs = require('../../lib/docs');
const pdf = require('../../lib/pdf');
const { tx } = require('../../lib/erp/stock');
const { wrap, bad, idParam, V } = require('../_util');
const { plToday } = require('../../lib/dzis');

const r = express.Router();
const anyOf = perms => async (req, res, next) => perms.some(p => can(req.user, p)) ? next() : requirePerm(perms[0])(req, res, next);
const view = anyOf(['departments.view', 'readings.manage']), edit = requirePerm('departments.view'), rd = requirePerm('readings.manage');
const DEP = 'podzielniki-i-montaze';
const DEV = { podzielnik: 'Podzielnik kosztów', wodomierz: 'Wodomierz', cieplomierz: 'Ciepłomierz', modul_radiowy: 'Moduł radiowy', inny: 'Inne' };
const COUNTERS = ['cieplomierz', 'wodomierz'];   // liczniki narastające: spadek wskazania = odczyt podejrzany

// ---------- lokale ----------
r.get('/budynki/:id/lokale', idParam, view, wrap(async (req, res) => {
  res.json((await pool.query(`SELECT u.*, (SELECT count(*)::int FROM devices d WHERE d.unit_id = u.id AND d.status = 'zamontowane') AS devices
    FROM units u WHERE u.building_id = $1 ORDER BY u.is_active DESC, length(u.number), u.number`, [req.params.id])).rows);
}));
const unitFields = b => ({ number: V.str(b.number, 40, true, 'Numer lokalu'), floor: V.str(b.floor, 20), occupant: V.str(b.occupant, 200), phone: V.str(b.phone, 50),
  area_m2: b.area_m2 === '' || b.area_m2 == null ? null : V.num(b.area_m2, 0, 100000, 'Powierzchnia'), notes: V.str(b.notes, 1000) });
r.post('/budynki/:id/lokale', idParam, edit, wrap(async (req, res) => {
  if (!(await pool.query('SELECT 1 FROM buildings WHERE id = $1', [req.params.id])).rows[0]) throw bad(404, 'Nie znaleziono budynku.');
  const b = req.body || {};
  if (b.seria) {
    // Szybkie dodanie serii lokali (np. 1–60), z pominięciem istniejących numerów.
    const from = Math.round(V.num(b.seria.od, 1, 10000, 'Od')), to = Math.round(V.num(b.seria.do, 1, 10000, 'Do')), pre = V.str(b.seria.prefiks, 10);
    if (to < from || to - from > 999) throw bad(400, 'Zakres: od ≤ do, maks. 1000 lokali naraz.');
    const q = await pool.query(`INSERT INTO units (building_id, number, created_by) SELECT $1, $2 || n, $5 FROM generate_series($3::int, $4::int) n
      ON CONFLICT (building_id, lower(number)) DO NOTHING RETURNING id`, [req.params.id, pre, from, to, req.user.id]);
    await audit(req, 'lokale.seria', { resource: 'buildings', resourceId: req.params.id, details: { dodano: q.rowCount } });
    return res.status(201).json({ added: q.rowCount });
  }
  const o = unitFields(b);
  const q = await pool.query(`INSERT INTO units (building_id, number, floor, occupant, phone, area_m2, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.params.id, o.number, o.floor, o.occupant, o.phone, o.area_m2, o.notes, req.user.id]);
  res.status(201).json(q.rows[0]);
}));
r.patch('/lokale/:id', idParam, edit, wrap(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM units WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw bad(404, 'Nie znaleziono lokalu.');
  const o = unitFields({ ...cur, ...(req.body || {}) });
  const active = typeof (req.body || {}).is_active === 'boolean' ? req.body.is_active : cur.is_active;
  const q = await pool.query(`UPDATE units SET number = $2, floor = $3, occupant = $4, phone = $5, area_m2 = $6, notes = $7, is_active = $8 WHERE id = $1 RETURNING *`,
    [req.params.id, o.number, o.floor, o.occupant, o.phone, o.area_m2, o.notes, active]);
  res.json(q.rows[0]);
}));

// ---------- kartoteka urządzenia: pełna historia ----------
r.get('/urzadzenia/:id', idParam, view, wrap(async (req, res) => {
  const id = req.params.id;
  const d = (await pool.query(`SELECT d.*, b.name AS building_name, b.address, b.city, u.number AS unit_number, x.number AS installation_number, x.planned_date AS installation_date, x.crew_id,
      cr.name AS crew_name FROM devices d LEFT JOIN buildings b ON b.id = d.building_id LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN installations x ON x.id = d.installation_id LEFT JOIN crews cr ON cr.id = x.crew_id WHERE d.id = $1`, [id])).rows[0];
  if (!d) throw bad(404, 'Nie znaleziono urządzenia.');
  const [ev, readings, services, documents] = await Promise.all([
    pool.query(`SELECT e.kind, e.event_date, e.description, e.related_type, e.related_id, e.created_at, us.login FROM device_events e LEFT JOIN users us ON us.id = e.created_by WHERE e.device_id = $1 ORDER BY e.event_date DESC, e.created_at DESC`, [id]),
    pool.query(`SELECT r.read_at, r.value::float AS value, r.status, r.anomaly, r.source, r.note, us.login FROM device_readings r LEFT JOIN users us ON us.id = r.read_by WHERE r.device_id = $1 ORDER BY r.read_at DESC LIMIT 200`, [id]),
    pool.query(`SELECT id, number, status, received_at, completed_at, description FROM service_orders WHERE device_id = $1 ORDER BY received_at DESC`, [id]),
    pool.query(`SELECT id, kind, title, created_at FROM documents WHERE related_type = 'device' AND related_id = $1 ORDER BY created_at DESC`, [id])
  ]);
  // Oś czasu: montaż (z karty montażu), zdarzenia, serwisy, odczyty – posortowane od najnowszych.
  const timeline = [
    ...(d.installed_at || d.installation_date ? [{ date: String(d.installed_at || d.installation_date).slice(0, 10), kind: 'montaz', text: `Montaż${d.installation_number ? ' – zlecenie ' + d.installation_number : ''}${d.crew_name ? ', ekipa ' + d.crew_name : ''}` }] : []),
    ...ev.rows.map(e => ({ date: String(e.event_date).slice(0, 10), kind: e.kind, text: e.description, by: e.login })),
    ...services.rows.map(s => ({ date: String(s.received_at).slice(0, 10), kind: 'serwis', text: `Serwis ${s.number}: ${s.description}`, ref: s.id })),
    ...readings.rows.map(x => ({ date: String(x.read_at).slice(0, 10), kind: 'odczyt', text: x.value == null ? 'Brak odczytu' + (x.note ? ': ' + x.note : '') : `Odczyt: ${x.value}${x.status === 'podejrzany' ? ' (podejrzany: ' + x.anomaly + ')' : ''}` }))
  ].sort((a, b) => b.date.localeCompare(a.date));
  res.json({ ...d, type_label: DEV[d.type], events: ev.rows, readings: readings.rows, services: services.rows, documents: documents.rows, timeline });
}));
r.patch('/urzadzenia/:id', idParam, edit, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async c => {
    const d = (await c.query('SELECT * FROM devices WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!d) throw bad(404, 'Nie znaleziono urządzenia.');
    const o = {};
    for (const [k, m] of [['manufacturer', 100], ['model', 100], ['location', 200], ['radio_id', 60], ['notes', 2000]]) if (b[k] !== undefined) o[k] = V.str(b[k], m);
    if (b.legalization_until !== undefined) o.legalization_until = V.date(b.legalization_until, 'Ważność legalizacji');
    if (b.unit_id !== undefined) {
      o.unit_id = V.uuid(b.unit_id, 'Lokal');
      if (o.unit_id && !(await c.query('SELECT 1 FROM units WHERE id = $1 AND building_id = $2', [o.unit_id, d.building_id])).rows[0]) throw bad(400, 'Lokal musi być w budynku urządzenia.');
    }
    if (b.status !== undefined) o.status = V.oneOf(b.status, ['magazyn', 'zamontowane', 'zdemontowane', 'wadliwe'], 'Status');
    const k = Object.keys(o);
    if (!k.length) throw bad(400, 'Brak zmian.');
    const x = (await c.query(`UPDATE devices SET ${k.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [d.id, ...k.map(f => o[f])])).rows[0];
    if (o.status && o.status !== d.status) await c.query(`INSERT INTO device_events (device_id, kind, description, created_by) VALUES ($1, $2, $3, $4)`,
      [d.id, o.status === 'zdemontowane' ? 'demontaz' : 'zmiana_statusu', `Status: ${d.status} → ${o.status}${b.powod ? ' – ' + V.str(b.powod, 300) : ''}`, req.user.id]);
    if (o.unit_id !== undefined && o.unit_id !== d.unit_id) await c.query(`INSERT INTO device_events (device_id, kind, description, created_by) VALUES ($1, 'przeniesienie', 'Zmiana lokalu', $2)`, [d.id, req.user.id]);
    if (o.legalization_until && String(o.legalization_until) !== String(d.legalization_until || '').slice(0, 10)) await c.query(`INSERT INTO device_events (device_id, kind, description, created_by) VALUES ($1, 'legalizacja', $2, $3)`, [d.id, 'Legalizacja ważna do ' + o.legalization_until, req.user.id]);
    return x;
  });
  await audit(req, 'urzadzenie.zmiana', { resource: 'devices', resourceId: req.params.id, details: { pola: Object.keys(b) } });
  res.json(out);
}));
r.post('/urzadzenia/:id/zdarzenia', idParam, edit, wrap(async (req, res) => {
  const b = req.body || {};
  if (!(await pool.query('SELECT 1 FROM devices WHERE id = $1', [req.params.id])).rows[0]) throw bad(404, 'Nie znaleziono urządzenia.');
  const q = await pool.query(`INSERT INTO device_events (device_id, kind, event_date, description, created_by) VALUES ($1, $2, coalesce($3::date, current_date), $4, $5) RETURNING *`,
    [req.params.id, V.oneOf(b.kind, ['montaz', 'demontaz', 'wymiana', 'serwis', 'legalizacja', 'przeniesienie', 'inne'], 'Rodzaj zdarzenia'), V.date(b.event_date, 'Data'), V.str(b.description, 1000, true, 'Opis'), req.user.id]);
  res.status(201).json(q.rows[0]);
}));

// ---------- odczyty per urządzenie ----------
async function scheduleOf(c, id) {
  const s = (await c.query('SELECT s.*, b.name AS building_name, b.address, b.city FROM reading_schedules s JOIN buildings b ON b.id = s.building_id WHERE s.id = $1', [id])).rows[0];
  if (!s) throw bad(404, 'Nie znaleziono harmonogramu odczytu.');
  return s;
}
// Urządzenia budynku objęte zakresem harmonogramu (podzielniki / wodomierze / ciepłomierze / wszystkie).
const SCOPE_TYPES = { podzielniki: ['podzielnik'], wodomierze: ['wodomierz'], cieplomierze: ['cieplomierz'], wszystkie: ['podzielnik', 'wodomierz', 'cieplomierz', 'modul_radiowy', 'inny'], inne: ['inny', 'modul_radiowy'] };
async function devicesFor(c, s, date) {
  return (await c.query(`SELECT d.id, d.serial_no, d.radio_id, d.type, d.model, d.location, u.number AS unit_number,
      cur.value::float AS value, cur.status, cur.anomaly, cur.note, cur.source,
      (SELECT pr.value::float FROM device_readings pr WHERE pr.device_id = d.id AND pr.read_at < $3 AND pr.value IS NOT NULL ORDER BY pr.read_at DESC LIMIT 1) AS prev_value,
      (SELECT pr.read_at FROM device_readings pr WHERE pr.device_id = d.id AND pr.read_at < $3 AND pr.value IS NOT NULL ORDER BY pr.read_at DESC LIMIT 1) AS prev_date
    FROM devices d LEFT JOIN units u ON u.id = d.unit_id LEFT JOIN device_readings cur ON cur.device_id = d.id AND cur.read_at = $3
    WHERE d.building_id = $1 AND d.status = 'zamontowane' AND d.type = ANY($2::text[]) ORDER BY u.number NULLS LAST, d.location, d.serial_no`, [s.building_id, SCOPE_TYPES[s.scope], date])).rows;
}
const dateParam = v => V.date(v || plToday(), 'Data odczytu', true);
r.get('/odczyty/:id/urzadzenia', idParam, rd, wrap(async (req, res) => {
  const s = await scheduleOf(pool, req.params.id), date = dateParam(req.query.data);
  res.json({ schedule: s, read_at: date, devices: await devicesFor(pool, s, date) });
}));
// Zapis wyników (także poprawki tego samego dnia): walidacja, wykrywanie podejrzanych wartości, brak odczytu z powodem.
async function saveValues(c, s, date, values, source, userId) {
  const devs = new Map((await devicesFor(c, s, date)).map(d => [d.id, d]));
  let saved = 0;
  for (const v of values) {
    const d = devs.get(v.device_id);
    if (!d) throw bad(400, 'Urządzenie spoza budynku lub zakresu odczytu.');
    let value = v.value === '' || v.value == null ? null : Number(String(v.value).replace(',', '.'));
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 1e12)) throw bad(400, `${d.serial_no}: nieprawidłowa wartość odczytu.`);
    let status = value == null ? 'brak' : 'ok', anomaly = '';
    if (value != null && COUNTERS.includes(d.type) && d.prev_value != null && value < d.prev_value) { status = 'podejrzany'; anomaly = `spadek wskazania (poprzednio ${d.prev_value})`; }
    await c.query(`INSERT INTO device_readings (device_id, schedule_id, read_at, value, status, anomaly, source, note, read_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (device_id, read_at) DO UPDATE SET value = excluded.value, status = excluded.status, anomaly = excluded.anomaly, source = excluded.source, note = excluded.note, read_by = excluded.read_by, schedule_id = excluded.schedule_id`,
      [d.id, s.id, date, value, status, anomaly, source, V.str(v.note, 300), userId]);
    saved++;
  }
  // Podzielniki: wartość wielokrotnie wyższa niż w pozostałych lokalach budynku (mediana) – do sprawdzenia.
  const hca = (await c.query(`SELECT r.id, r.value::float AS value FROM device_readings r JOIN devices d ON d.id = r.device_id
    WHERE r.schedule_id = $1 AND r.read_at = $2 AND d.type = 'podzielnik' AND r.value IS NOT NULL`, [s.id, date])).rows;
  if (hca.length >= 4) {   // porównanie ma sens od 4 lokali z odczytem
    const sorted = hca.map(x => x.value).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    for (const x of hca) {
      const odd = med > 0 && x.value > med * 5;
      await c.query(`UPDATE device_readings SET status = CASE WHEN $2 THEN 'podejrzany' WHEN status = 'podejrzany' AND anomaly LIKE 'wartość%' THEN 'ok' ELSE status END,
        anomaly = CASE WHEN $2 THEN $3 WHEN status = 'podejrzany' AND anomaly LIKE 'wartość%' THEN '' ELSE anomaly END WHERE id = $1`,
        [x.id, odd, `wartość ponad 5× wyższa niż mediana budynku (${med})`]);
    }
  }
  return saved;
}
async function control(c, s, date) {
  const devs = await devicesFor(c, s, date);
  const missing = devs.filter(d => d.status == null || d.status === 'brak'), suspicious = devs.filter(d => d.status === 'podejrzany');
  return { total: devs.length, read: devs.filter(d => d.status === 'ok').length, entered: devs.filter(d => d.status != null).length,
    missing: missing.map(d => ({ id: d.id, serial_no: d.serial_no, unit_number: d.unit_number, location: d.location, reason: d.status === 'brak' ? (d.note || 'brak odczytu') : 'nie wpisano' })),
    suspicious: suspicious.map(d => ({ id: d.id, serial_no: d.serial_no, unit_number: d.unit_number, value: d.value, anomaly: d.anomaly })),
    complete_pct: devs.length ? Math.round(devs.filter(d => d.status === 'ok').length / devs.length * 1000) / 10 : null };
}
r.post('/odczyty/:id/wartosci', idParam, rd, wrap(async (req, res) => {
  const b = req.body || {}, values = Array.isArray(b.values) ? b.values.slice(0, 5000) : null;
  if (!values || !values.length) throw bad(400, 'Brak wartości odczytu.');
  const date = dateParam(b.read_at), source = V.oneOf(b.source, ['reczny', 'mobilny', 'radiowy'], 'Źródło', 'reczny');
  const out = await tx(async c => { const s = await scheduleOf(c, req.params.id); const saved = await saveValues(c, s, date, values, source, req.user.id); return { saved, control: await control(c, s, date) }; });
  await audit(req, 'odczyt.wartosci', { resource: 'reading_schedules', resourceId: req.params.id, details: { data: date, zapisano: out.saved, braki: out.control.missing.length, podejrzane: out.control.suspicious.length } });
  res.json(out);
}));
r.get('/odczyty/:id/kontrola', idParam, rd, wrap(async (req, res) => {
  const s = await scheduleOf(pool, req.params.id);
  res.json(await control(pool, s, dateParam(req.query.data)));
}));
// Import z czytnika radiowego / pliku: wiersze „numer seryjny lub ID radiowe;wartość” (separator ; , lub tabulator).
r.post('/odczyty/:id/import', idParam, rd, wrap(async (req, res) => {
  const b = req.body || {}, date = dateParam(b.read_at), text = String(b.csv || '');
  if (!text.trim()) throw bad(400, 'Wklej dane z czytnika (numer;wartość).');
  if (text.length > 500000) throw bad(400, 'Plik za duży (maks. ok. 500 kB).');
  const out = await tx(async c => {
    const s = await scheduleOf(c, req.params.id), devs = await devicesFor(c, s, date);
    const bySerial = new Map(); devs.forEach(d => { bySerial.set(d.serial_no.toLowerCase(), d); if (d.radio_id) bySerial.set(d.radio_id.toLowerCase(), d); });
    const values = [], unknown = [];
    for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 5000)) {
      const parts = (/[;\t]/.test(line) ? line.split(/[;\t]/) : line.split(',')).map(x => (x || '').trim().replace(/^"|"$/g, ''));
      const [key, val] = parts;
      if (!key || /^(numer|serial|nr|id)/i.test(key)) continue;   // nagłówek
      const d = bySerial.get(key.toLowerCase());
      if (!d) { unknown.push(key); continue; }
      values.push({ device_id: d.id, value: val, note: '' });
    }
    if (!values.length) throw bad(400, `Nie dopasowano żadnego urządzenia budynku${unknown.length ? ' (nieznane numery: ' + unknown.slice(0, 5).join(', ') + ')' : ''}.`);
    const saved = await saveValues(c, s, date, values, 'import', req.user.id);
    return { saved, unknown, control: await control(c, s, date) };
  });
  await audit(req, 'odczyt.import', { resource: 'reading_schedules', resourceId: req.params.id, details: { data: date, zapisano: out.saved, nieznane: out.unknown.length } });
  res.json(out);
}));
// Protokół odczytów (PDF, dokument z wersjami powiązany z harmonogramem odczytu).
r.post('/odczyty/:id/protokol', idParam, rd, wrap(async (req, res) => {
  const date = dateParam((req.body || {}).read_at);
  const out = await tx(async c => {
    const s = await scheduleOf(c, req.params.id), devs = await devicesFor(c, s, date), k = await control(c, s, date);
    if (!k.entered) throw bad(409, 'Brak wpisanych odczytów z tego dnia.');
    const number = await docs.nextNumber(c, 'PR');
    const file = await pdf.report({ title: 'Protokół odczytów', number, date, dept: DEP,
      left: [['Budynek', `${s.building_name}\n${s.address}${s.city ? ', ' + s.city : ''}`]],
      right: [['Data odczytu', new Date(date + 'T12:00:00').toLocaleDateString('pl-PL')], ['Kompletność', `${k.read} z ${k.total} urządzeń (${k.complete_pct ?? 0}%), podejrzane: ${k.suspicious.length}`]],
      sections: [{ heading: 'Wyniki odczytów', cols: [{ t: 'Lokal', w: .12 }, { t: 'Urządzenie', w: .2 }, { t: 'Nr seryjny', w: .2 }, { t: 'Wartość', w: .16, align: 'right' }, { t: 'Uwagi', w: .32 }],
        rows: devs.map(d => [d.unit_number || '–', DEV[d.type], d.serial_no, d.value == null ? '–' : String(d.value).replace('.', ','),
          d.status === 'brak' ? 'brak odczytu' + (d.note ? ': ' + d.note : '') : d.status === 'podejrzany' ? 'do sprawdzenia: ' + d.anomaly : d.status == null ? 'nie odczytano' : (d.note || '')]) }],
      signatures: ['Wykonujący odczyt', 'Przedstawiciel zarządcy'] });
    const doc = await docs.createDocument(c, { kind: 'protokol', title: `Protokół odczytów ${number} – ${s.building_name}`, department_id: DEP, related_type: 'reading_schedule', related_id: s.id, userId: req.user.id });
    await docs.addVersion(c, doc.id, { content: { data: date, ...k, missing: undefined, suspicious: undefined }, file, fileName: number.replace(/\//g, '-') + '.pdf', mime: 'application/pdf', note: 'Protokół odczytów', userId: req.user.id });
    return { document_id: doc.id, number };
  });
  await audit(req, 'odczyt.protokol', { resource: 'reading_schedules', resourceId: req.params.id, details: { protokol: out.number, data: date } });
  res.status(201).json(out);
}));

module.exports = r;
