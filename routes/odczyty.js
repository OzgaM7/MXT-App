'use strict';
// Odczyty – API (/api/odczyty). Uprawnienie readings.manage: role biurowe i „Obsługa odczytów” (bez dostępu do finansów).
// Obiekty to budynki z ewidencji, klienci – z CRM (jedno źródło danych). „Wykonano” zapisuje odczyt i od razu ustawia kolejny termin.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/rbac');
const { notify } = require('../lib/notify');
const R = require('../lib/readings');
const xlsx = require('../lib/xlsx');
const { wrap, idParam, V, bad } = require('./_util');
const usun = require('../lib/usun');

const r = express.Router();
const use = requirePerm('readings.manage'), adm = requirePerm('readings.admin');
const DEP = 'podzielniki-i-montaze';
const CUST_KINDS = ['wspolnota', 'spoldzielnia', 'zarzadca', 'firma', 'klient_zagraniczny', 'inny'];
const READER_ROLES = 'administrator,uzytkownik,kierownik,rozliczajacy,odczyty';
const todayPl = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const DEV_TYPE = { podzielniki: ['podzielnik'], wodomierze: ['wodomierz'], cieplomierze: ['cieplomierz'], wszystkie: null, inne: null };

const LIST = `SELECT s.*, b.name AS building_name, b.address, b.city, b.postal_code, b.units_count, c.name AS customer_name, u.login AS assigned_login, u.full_name AS assigned_name,
    (SELECT count(*)::int FROM devices d WHERE d.building_id = s.building_id AND d.status = 'zamontowane'
      AND (s.scope IN ('wszystkie','inne') OR d.type = CASE s.scope WHEN 'podzielniki' THEN 'podzielnik' WHEN 'wodomierze' THEN 'wodomierz' WHEN 'cieplomierze' THEN 'cieplomierz' END)) AS devices,
    (SELECT json_build_object('result', x.result, 'missing_units', x.missing_units, 'done_by', coalesce(du.full_name, du.login))
      FROM readings x LEFT JOIN users du ON du.id = x.done_by WHERE x.schedule_id = s.id AND x.cancelled_at IS NULL ORDER BY x.done_at DESC, x.created_at DESC LIMIT 1) AS last_reading,
    ${R.FLAGS}
  FROM reading_schedules s JOIN buildings b ON b.id = s.building_id LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.assigned_to`;

async function canRead(userId, client = pool) {
  return !!(await client.query(`SELECT 1 FROM users u WHERE u.id = $1 AND u.is_active AND (u.role = ANY('{${READER_ROLES}}') OR u.extra_roles && '{${READER_ROLES}}')`, [userId])).rows[0];
}
async function personOf(v, client) {
  const id = V.uuid(v, 'Osoba odpowiedzialna');
  if (id && !(await canRead(id, client))) throw bad(400, 'Osoba odpowiedzialna: wybierz aktywne konto z dostępem do odczytów.');
  return id;
}
const remind = v => v === '' || v == null ? null : V.num(v, 0, 120, 'Wyprzedzenie przypomnienia (dni)');

// ---------- słowniki ----------
r.get('/osoby', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT u.id, u.login, u.full_name, (u.role = 'odczyty' OR 'odczyty' = ANY(u.extra_roles)) AS zespol_odczytow,
      (SELECT count(*)::int FROM reading_schedules s WHERE s.assigned_to = u.id AND s.is_active) AS obiekty
    FROM users u WHERE u.is_active AND (u.role = ANY('{${READER_ROLES}}') OR u.extra_roles && '{${READER_ROLES}}') ORDER BY zespol_odczytow DESC, u.full_name, u.login`);
  res.json(q.rows);
}));
r.get('/budynki', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(b.name ILIKE $1 OR b.address ILIKE $1 OR b.city ILIKE $1 OR c.name ILIKE $1)`); }
  const q = await pool.query(`SELECT b.id, b.name, b.address, b.city, b.units_count, b.customer_id, c.name AS customer_name,
      (SELECT array_agg(s.scope) FROM reading_schedules s WHERE s.building_id = b.id) AS scopes
    FROM buildings b LEFT JOIN customers c ON c.id = b.customer_id WHERE b.archived_at IS NULL ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY b.name LIMIT 500`, p);
  res.json(q.rows);
}));
r.get('/klienci', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT id, name, kind, phone, email FROM customers WHERE kind <> 'klient_zagraniczny' AND archived_at IS NULL ORDER BY name LIMIT 1000`);
  res.json(q.rows);
}));
// Nowy klient do odczytów (trafia do wspólnej ewidencji klientów CRM).
r.post('/klienci', use, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query(`INSERT INTO customers (kind, name, address, email, phone, departments, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, kind`,
    [V.oneOf(b.kind, CUST_KINDS, 'Rodzaj klienta', 'wspolnota'), V.str(b.name, 200, true, 'Nazwa klienta'), V.str(b.address, 400), V.str(b.email, 200), V.str(b.phone, 50), [DEP], req.user.id]);
  await audit(req, 'klient.utworzenie', { resource: 'customers', resourceId: q.rows[0].id, details: { nazwa: q.rows[0].name, zrodlo: 'odczyty' } });
  res.status(201).json(q.rows[0]);
}));

// ---------- lista i podsumowanie ----------
r.get('/', use, wrap(async (req, res) => {
  const st = await R.settings();
  const p = [st.remind_days], w = [];
  const view = req.query.widok || 'najblizsze';
  const horizon = Math.min(366, Math.max(1, parseInt(req.query.dni, 10) || 30));
  const VIEWS = {
    najblizsze: `s.is_active AND s.next_due <= ${R.TODAY} + ${horizon}`, po_terminie: `s.is_active AND s.next_due < ${R.TODAY}`,
    aktywne: 's.is_active', nieaktywne: 'NOT s.is_active', wszystkie: 'true'
  };
  if (!VIEWS[view]) throw bad(400, 'Nieznany widok listy.');
  w.push(VIEWS[view]);
  if (req.query.osoba === 'brak') w.push('s.assigned_to IS NULL');
  else if (req.query.osoba) { p.push(V.uuid(req.query.osoba)); w.push(`s.assigned_to = $${p.length}`); }
  if (R.SCOPE[req.query.zakres]) { p.push(req.query.zakres); w.push(`s.scope = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(b.name ILIKE $${p.length} OR b.address ILIKE $${p.length} OR b.city ILIKE $${p.length} OR c.name ILIKE $${p.length})`); }
  const page = Math.max(1, parseInt(req.query.strona, 10) || 1), per = 50, W = 'WHERE ' + w.join(' AND ');
  const [q, n] = await Promise.all([
    pool.query(`${LIST} ${W} ORDER BY s.is_active DESC, s.next_due, b.name LIMIT ${per} OFFSET ${(page - 1) * per}`, p),
    pool.query(`SELECT count(*)::int n FROM reading_schedules s JOIN buildings b ON b.id = s.building_id LEFT JOIN customers c ON c.id = s.customer_id ${W.replace(/\$(\d+)/g, (m, i) => '$' + (i - 1))}`, p.slice(1))
  ]);
  res.set('X-Total-Count', String(n.rows[0].n));
  res.json(q.rows);
}));
r.get('/podsumowanie', use, wrap(async (req, res) => {
  const st = await R.settings();
  const q = await pool.query(`SELECT
      count(*) FILTER (WHERE is_active)::int AS aktywne,
      count(*) FILTER (WHERE is_active AND next_due < ${R.TODAY})::int AS po_terminie,
      count(*) FILTER (WHERE is_active AND next_due >= ${R.TODAY} AND next_due <= ${R.TODAY} + 7)::int AS w_7_dni,
      count(*) FILTER (WHERE is_active AND next_due >= ${R.TODAY} AND next_due <= ${R.TODAY} + 30)::int AS w_30_dni,
      count(*) FILTER (WHERE is_active AND assigned_to IS NULL)::int AS bez_osoby,
      (SELECT count(*)::int FROM readings x WHERE x.cancelled_at IS NULL AND date_trunc('month', x.done_at) = date_trunc('month', ${R.TODAY})) AS wykonane_w_miesiacu
    FROM reading_schedules`);
  res.json({ ...q.rows[0], ...st });
}));

// ---------- ustawienia (domyślne wyprzedzenie i cykl) ----------
r.get('/ustawienia', use, wrap(async (req, res) => res.json(await R.settings())));
r.put('/ustawienia', adm, wrap(async (req, res) => {
  const b = req.body || {}, v = { remind_days: V.num(b.remind_days, 0, 120, 'Wyprzedzenie (dni)'), cycle_months: V.num(b.cycle_months, 1, 60, 'Cykl (miesiące)', 12) };
  if (!Number.isInteger(v.remind_days) || !Number.isInteger(v.cycle_months)) throw bad(400, 'Podaj liczby całkowite.');
  await pool.query(`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('readings', $1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [JSON.stringify(v), req.user.id]);
  await audit(req, 'odczyty.ustawienia', { resource: 'system_settings', resourceId: 'readings', details: v });
  res.json(v);
}));

// ---------- eksport do Excela (harmonogram + historia) ----------
r.get('/eksport', use, wrap(async (req, res) => {
  const st = await R.settings();
  const from = V.date(req.query.od, 'Od') || `${new Date().getFullYear() - 1}-01-01`;
  const [s, h] = await Promise.all([
    pool.query(`${LIST} ORDER BY s.is_active DESC, s.next_due, b.name LIMIT 50000`, [st.remind_days]),
    pool.query(`SELECT x.done_at, x.due_date, x.result, x.missing_units, x.note, x.next_due, x.cancelled_at, x.cancel_reason, b.name AS building_name, b.address, b.city,
        s.scope, coalesce(du.full_name, du.login) AS done_by
      FROM readings x JOIN reading_schedules s ON s.id = x.schedule_id JOIN buildings b ON b.id = s.building_id LEFT JOIN users du ON du.id = x.done_by
      WHERE x.done_at >= $1 ORDER BY x.done_at DESC LIMIT 50000`, [from])
  ]);
  const buf = await xlsx.build([
    { name: 'Odczyty', rows: s.rows.map(x => ({ ...x, scope: R.SCOPE[x.scope], method: R.METHOD[x.method], status: !x.is_active ? 'nieaktywny' : x.po_terminie ? 'po terminie' : x.wkrotce ? 'wkrótce' : 'zaplanowany',
        assigned: x.assigned_name || x.assigned_login || '', last_result: x.last_reading ? R.RESULT[x.last_reading.result] : '' })), columns: [
      { header: 'Budynek', key: 'building_name', width: 28 }, { header: 'Adres', key: 'address', width: 26 }, { header: 'Miasto', key: 'city', width: 14 },
      { header: 'Klient', key: 'customer_name', width: 26 }, { header: 'Zakres', key: 'scope', width: 14 }, { header: 'Sposób', key: 'method', width: 16 },
      { header: 'Cykl (mies.)', key: 'cycle_months', type: 'int' }, { header: 'Ostatni odczyt', key: 'last_done', type: 'date', width: 13 }, { header: 'Wynik', key: 'last_result', width: 10 },
      { header: 'Kolejny termin', key: 'next_due', type: 'date', width: 13 }, { header: 'Dni do terminu', key: 'dni_do_terminu', type: 'int' }, { header: 'Status', key: 'status', width: 12 },
      { header: 'Odpowiedzialny', key: 'assigned', width: 20 }, { header: 'Lokale', key: 'units_count', type: 'int' }, { header: 'Urządzenia', key: 'devices', type: 'int' },
      { header: 'Kontakt', key: 'contact', width: 24 }, { header: 'Dostęp', key: 'access_notes', width: 24 }, { header: 'Uwagi', key: 'notes', width: 30 }] },
    { name: 'Historia', rows: h.rows.map(x => ({ ...x, scope: R.SCOPE[x.scope], result: x.cancelled_at ? 'cofnięty: ' + x.cancel_reason : R.RESULT[x.result] })), columns: [
      { header: 'Data odczytu', key: 'done_at', type: 'date', width: 13 }, { header: 'Termin', key: 'due_date', type: 'date', width: 12 }, { header: 'Budynek', key: 'building_name', width: 28 },
      { header: 'Adres', key: 'address', width: 26 }, { header: 'Miasto', key: 'city', width: 14 }, { header: 'Zakres', key: 'scope', width: 14 }, { header: 'Wykonał', key: 'done_by', width: 20 },
      { header: 'Wynik', key: 'result', width: 16 }, { header: 'Lokale bez odczytu', key: 'missing_units', type: 'int' }, { header: 'Kolejny termin', key: 'next_due', type: 'date', width: 13 },
      { header: 'Uwagi', key: 'note', width: 36 }] }
  ], { title: 'MXT – odczyty' });
  await audit(req, 'eksport.xlsx', { resource: 'eksport/odczyty', details: { zestawienie: 'Odczyty', wiersze: s.rows.length + h.rows.length } });
  xlsx.send(res, buf, 'Odczyty');
}));

// ---------- obiekt do odczytów ----------
async function fields(b, partial, client) {
  const o = {}, set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set('scope', v => V.oneOf(v, Object.keys(R.SCOPE), 'Zakres', 'podzielniki'));
  set('method', v => V.oneOf(v, Object.keys(R.METHOD), 'Sposób odczytu', 'radiowy'));
  set('cycle_months', v => { const n = V.num(v, 1, 60, 'Cykl (miesiące)', (partial ? undefined : 12)); if (!Number.isInteger(n)) throw bad(400, 'Cykl: liczba pełnych miesięcy.'); return n; });
  set('next_due', v => V.date(v, 'Kolejny termin', true));
  set('remind_days', remind);
  set('contact', v => V.str(v, 300)); set('access_notes', v => V.str(v, 1000)); set('notes', v => V.str(v, 2000));
  set('customer_id', v => V.uuid(v, 'Klient'));
  if (b.assigned_to !== undefined || !partial) o.assigned_to = await personOf(b.assigned_to, client);
  if (b.is_active !== undefined) o.is_active = !!b.is_active;
  return o;
}
r.post('/', use, wrap(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let building = V.uuid(b.building_id, 'Budynek');
    // Nowy obiekt: budynek trafia do wspólnej ewidencji (ta sama tabela co montaże i serwisy).
    if (!building) {
      const nb = b.building || {};
      const q = await client.query(`INSERT INTO buildings (customer_id, name, address, city, postal_code, units_count, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name`,
        [V.uuid(nb.customer_id || b.customer_id, 'Klient'), V.str(nb.name, 200, true, 'Nazwa budynku'), V.str(nb.address, 300, true, 'Adres'), V.str(nb.city, 100), V.str(nb.postal_code, 10),
          V.num(nb.units_count, 0, 100000, 'Liczba lokali'), req.user.id]);
      building = q.rows[0].id;
      await audit(req, 'budynek.utworzenie', { resource: 'buildings', resourceId: building, details: { nazwa: q.rows[0].name, zrodlo: 'odczyty' }, client });
    }
    const bd = (await client.query('SELECT id, name, customer_id FROM buildings WHERE id = $1', [building])).rows[0];
    if (!bd) throw bad(400, 'Nie znaleziono budynku.');
    if (b.cycle_months == null || b.cycle_months === '') b.cycle_months = (await R.settings(client)).cycle_months;
    const f = await fields(b, false, client);
    if (!f.customer_id) f.customer_id = bd.customer_id;
    const last = V.date(b.last_done, 'Data ostatniego odczytu');
    if (last && last >= f.next_due) throw bad(400, 'Kolejny termin musi być późniejszy niż ostatni odczyt.');
    const keys = Object.keys(f);
    const s = (await client.query(`INSERT INTO reading_schedules (building_id, last_done, created_by, ${keys.join(', ')}) VALUES ($1, $2, $3, ${keys.map((k, i) => '$' + (i + 4)).join(', ')}) RETURNING *`,
      [building, last, req.user.id, ...keys.map(k => f[k])])).rows[0];
    await audit(req, 'odczyty.obiekt', { resource: 'reading_schedules', resourceId: s.id, details: { budynek: bd.name, zakres: s.scope, termin: s.next_due }, client });
    if (s.assigned_to && s.assigned_to !== req.user.id) await notify([s.assigned_to], { kind: 'odczyt.przydzial', title: `Nowy obiekt do odczytów: ${bd.name}`,
      body: `${R.SCOPE[s.scope]} · kolejny termin ${R.plDate(s.next_due)}`, link: '/odczyty?z=' + s.id, related_type: 'reading_schedule', related_id: s.id }, { client });
    await client.query('COMMIT');
    res.status(201).json(s);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw bad(409, 'Ten budynek ma już harmonogram odczytów dla tego zakresu.');
    throw e;
  } finally { client.release(); }
}));

r.get('/:id', idParam, use, wrap(async (req, res) => {
  const st = await R.settings();
  const s = (await pool.query(LIST + ' WHERE s.id = $2', [st.remind_days, req.params.id])).rows[0];
  if (!s) throw bad(404, 'Nie znaleziono obiektu.');
  const [h, dev] = await Promise.all([
    pool.query(`SELECT x.*, coalesce(du.full_name, du.login) AS done_by_name, coalesce(cu.full_name, cu.login) AS cancelled_by_name FROM readings x
      LEFT JOIN users du ON du.id = x.done_by LEFT JOIN users cu ON cu.id = x.cancelled_by WHERE x.schedule_id = $1 ORDER BY x.done_at DESC, x.created_at DESC LIMIT 100`, [s.id]),
    pool.query(`SELECT type, count(*)::int n FROM devices WHERE building_id = $1 AND status = 'zamontowane' GROUP BY type ORDER BY type`, [s.building_id])
  ]);
  res.json({ ...s, history: h.rows, devices_by_type: dev.rows });
}));

r.patch('/:id', idParam, use, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = (await client.query('SELECT * FROM reading_schedules WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!s) throw bad(404, 'Nie znaleziono obiektu.');
    const f = await fields(req.body || {}, true, client);
    if (f.next_due && s.last_done && f.next_due <= s.last_done) throw bad(400, 'Kolejny termin musi być późniejszy niż ostatni odczyt.');
    const keys = Object.keys(f);
    if (!keys.length) throw bad(400, 'Brak zmian.');
    const x = (await client.query(`UPDATE reading_schedules SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [s.id, ...keys.map(k => f[k])])).rows[0];
    await audit(req, 'odczyty.zmiana', { resource: 'reading_schedules', resourceId: s.id, details: f, client });
    if (f.assigned_to && f.assigned_to !== s.assigned_to && f.assigned_to !== req.user.id) {
      const bd = (await client.query('SELECT name FROM buildings WHERE id = $1', [s.building_id])).rows[0];
      await notify([f.assigned_to], { kind: 'odczyt.przydzial', title: `Przydzielono Ci odczyty: ${bd.name}`, body: `${R.SCOPE[x.scope]} · kolejny termin ${R.plDate(x.next_due)}`,
        link: '/odczyty?z=' + s.id, related_type: 'reading_schedule', related_id: s.id }, { client });
    }
    await client.query('COMMIT');
    res.json(x);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw bad(409, 'Ten budynek ma już harmonogram odczytów dla tego zakresu.');
    throw e;
  } finally { client.release(); }
}));

// Wykonanie odczytu jednym działaniem: zapis (kto, kiedy, pełny / częściowy) + kolejny termin (domyślnie data odczytu + cykl).
r.post('/:id/wykonano', idParam, use, wrap(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = (await client.query('SELECT * FROM reading_schedules WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!s) throw bad(404, 'Nie znaleziono obiektu.');
    if (!s.is_active) throw bad(409, 'Obiekt jest nieaktywny – najpierw go włącz.');
    const done = V.date(b.done_at, 'Data odczytu') || todayPl();
    if (done > todayPl()) throw bad(400, 'Data odczytu nie może być z przyszłości.');
    if (s.last_done && done < s.last_done) throw bad(400, `Data odczytu jest wcześniejsza niż poprzedni odczyt (${R.plDate(s.last_done)}).`);
    const next = V.date(b.next_due, 'Kolejny termin') ||
      (await client.query(`SELECT to_char(($1::date + make_interval(months => $2))::date, 'YYYY-MM-DD') d`, [done, s.cycle_months])).rows[0].d;
    if (next <= done) throw bad(400, 'Kolejny termin musi być późniejszy niż data odczytu.');
    const result = V.oneOf(b.result, Object.keys(R.RESULT), 'Wynik', 'pelny');
    const missing = result === 'czesciowy' ? V.num(b.missing_units, 0, 100000, 'Lokale bez odczytu') : 0;
    if (result === 'czesciowy' && !missing && !V.str(b.note, 1000)) throw bad(400, 'Odczyt częściowy: podaj liczbę lokali bez odczytu albo opis.');
    const doneBy = b.done_by ? await personOf(b.done_by, client) : req.user.id;
    const x = (await client.query(`INSERT INTO readings (schedule_id, due_date, done_at, done_by, result, missing_units, note, prev_next_due, prev_last_done, next_due, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [s.id, s.next_due, done, doneBy, result, missing, V.str(b.note, 1000), s.next_due, s.last_done, next, req.user.id])).rows[0];
    const upd = (await client.query(`UPDATE reading_schedules SET last_done = $2, next_due = $3, updated_at = now() WHERE id = $1 RETURNING *`, [s.id, done, next])).rows[0];
    await audit(req, 'odczyt.wykonanie', { resource: 'reading_schedules', resourceId: s.id, details: { data: done, termin: s.next_due, wynik: result, lokale_bez_odczytu: missing, kolejny_termin: next }, client });
    await client.query('COMMIT');
    res.status(201).json({ schedule: upd, reading: x });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

// Cofnięcie ostatniego odczytu (pomyłka): wpis zostaje w historii jako cofnięty, termin wraca do poprzedniego.
r.post('/:id/cofnij', idParam, adm, wrap(async (req, res) => {
  const reason = V.str((req.body || {}).powod, 500, true, 'Powód cofnięcia');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = (await client.query('SELECT * FROM reading_schedules WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!s) throw bad(404, 'Nie znaleziono obiektu.');
    const x = (await client.query(`SELECT * FROM readings WHERE schedule_id = $1 AND cancelled_at IS NULL ORDER BY done_at DESC, created_at DESC LIMIT 1`, [s.id])).rows[0];
    if (!x) throw bad(409, 'Brak odczytu do cofnięcia.');
    await client.query(`UPDATE readings SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`, [x.id, req.user.id, reason]);
    const upd = (await client.query(`UPDATE reading_schedules SET next_due = $2, last_done = $3, updated_at = now() WHERE id = $1 RETURNING *`, [s.id, x.prev_next_due, x.prev_last_done])).rows[0];
    await audit(req, 'odczyt.cofniecie', { resource: 'reading_schedules', resourceId: s.id, details: { odczyt: x.done_at, powod: reason }, client });
    await client.query('COMMIT');
    res.json(upd);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

// Harmonogram odczytów dodany przez pomyłkę – usunięcie tylko, gdy nie ma żadnego wykonanego odczytu.
usun.register(r, '', use, { table: 'reading_schedules', action: 'odczyt.harmonogram.usuniecie', what: () => 'Harmonogram odczytów',
  hint: 'Wyłącz harmonogram (odczyty przestaną być planowane, historia zostanie).' });

module.exports = r;
