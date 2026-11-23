'use strict';
// Ubezpieczenia: rejestr podpisanych polis (wspólna kartoteka klientów), zysk z marży liczony przez bazę, historia zmian,
// odnowienia potwierdzane przez użytkownika, zakończenie, dokument polisy, lista „Polisy do odnowienia”, przypomnienia, pulpit.
const express = require('express');
const { pool } = require('../../db');
const { audit } = require('../../lib/audit');
const { requirePerm } = require('../../lib/rbac');
const docs = require('../../lib/docs');
const P = require('../../lib/erp/policies');
const { tx } = require('../../lib/erp/stock');
const { wrap, bad, idParam, V } = require('../_util');

const r = express.Router();
const use = requirePerm('insurance.manage');
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;
const FIELDS = { number: 'Numer polisy', insurer: 'Towarzystwo', insurance_type: 'Rodzaj ubezpieczenia', description: 'Opis polisy', signed_at: 'Data podpisania',
  start_date: 'Początek ochrony', end_date: 'Koniec ochrony', total_amount: 'Kwota polisy', margin_pct: 'Marża %', notes: 'Uwagi', customer_id: 'Klient' };
const like = s => '%' + String(s).trim().slice(0, 80).replace(/[\\%_]/g, m => '\\' + m) + '%';

function policyFields(b, partial) {
  const o = {}, set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set('number', v => V.str(v, 60, true, 'Numer polisy'));
  set('insurer', v => { const s = V.str(v, 120, true, 'Towarzystwo ubezpieczeniowe'); if (s.length < 2) throw bad(400, 'Towarzystwo: min. 2 znaki.'); return s; });
  set('insurance_type', v => { const s = V.str(v, 80, true, 'Rodzaj ubezpieczenia'); if (s.length < 2) throw bad(400, 'Rodzaj ubezpieczenia: min. 2 znaki.'); return s; });
  set('description', v => V.str(v, 4000));
  set('signed_at', v => V.date(v, 'Data podpisania', true));
  set('start_date', v => V.date(v, 'Data rozpoczęcia ochrony', true));
  set('end_date', v => V.date(v, 'Data zakończenia ochrony', true));
  // Kwoty z dokładnością do groszy, marża do 4 miejsc – walidacja i przeliczenie zysku w backendzie (lib/erp/policies.js).
  set('total_amount', v => { const n = P.toScaled(v, 2, 'Kwota całkowita polisy'); if (n > 99999999999999n) throw bad(400, 'Kwota polisy: za duża wartość.'); return (Number(n) / 100).toFixed(2); });
  set('margin_pct', v => { const n = P.toScaled(v, 4, 'Procent marży'); if (n > 1000000n) throw bad(400, 'Procent marży: od 0 do 100.'); return (Number(n) / 10000).toFixed(4); });
  set('notes', v => V.str(v, 4000));
  return o;
}
function checkDates(x) {
  if (x.end_date < x.start_date) throw bad(400, 'Koniec ochrony nie może być przed jej początkiem.');
  if (x.signed_at > x.end_date) throw bad(400, 'Data podpisania nie może być po końcu ochrony.');
}
// Klient z kartoteki albo nowy klient dodany w formularzu polisy (bez osobnej bazy klientów ubezpieczeniowych).
async function customerFor(c, b, userId) {
  if (b.customer_id) {
    const id = V.uuid(b.customer_id, 'Klient', true);
    if (!(await c.query('SELECT 1 FROM customers WHERE id = $1', [id])).rows[0]) throw bad(400, 'Nie znaleziono klienta.');
    return id;
  }
  const n = b.new_customer || {};
  const name = V.str(n.name, 200, true, 'Klient (imię i nazwisko lub nazwa firmy)');
  if (name.length < 2) throw bad(400, 'Klient: min. 2 znaki.');
  const email = V.str(n.email, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad(400, 'Nieprawidłowy adres e-mail klienta.');
  const q = await c.query(`INSERT INTO customers (kind, name, tax_id, address, email, phone, departments, created_by) VALUES ($1, $2, $3, $4, $5, $6, '{ubezpieczenia}', $7) RETURNING id`,
    [V.oneOf(n.kind, ['osoba_prywatna', 'firma'], 'Rodzaj klienta', 'osoba_prywatna'), name, V.str(n.tax_id, 30), V.str(n.address, 400), email, V.str(n.phone, 50), userId]);
  return q.rows[0].id;
}
const SELECT = `SELECT v.*, v.total_amount::float AS total_amount, v.margin_pct::float AS margin_pct, v.profit::float AS profit,
    nv.number AS renewed_by_number, pv.number AS previous_number, u.login AS created_by_login
  FROM policies_v v LEFT JOIN policies nv ON nv.id = v.renewed_by LEFT JOIN policies pv ON pv.id = v.previous_id LEFT JOIN users u ON u.id = v.created_by`;
const withLabel = x => ({ ...x, status_label: P.STATUS[x.status] });

// ---------- lista i wyszukiwanie ----------
function filters(q, p, w) {
  if (q.q) { p.push(like(q.q)); w.push(`(v.number ILIKE $${p.length} OR v.customer_name ILIKE $${p.length} OR v.insurer ILIKE $${p.length} OR v.description ILIKE $${p.length})`); }
  if (q.klient) { p.push(V.uuid(q.klient, 'Klient')); w.push(`v.customer_id = $${p.length}`); }
  if (q.towarzystwo) { p.push(String(q.towarzystwo).slice(0, 120)); w.push(`lower(v.insurer) = lower($${p.length})`); }
  if (q.rodzaj) { p.push(String(q.rodzaj).slice(0, 80)); w.push(`lower(v.insurance_type) = lower($${p.length})`); }
  if (q.od) { p.push(V.date(q.od, 'Od')); w.push(`v.signed_at >= $${p.length}`); }
  if (q.do) { p.push(V.date(q.do, 'Do')); w.push(`v.signed_at <= $${p.length}`); }
}
r.get('/polisy', use, wrap(async (req, res) => {
  const p = [], w = [], q = req.query;
  filters(q, p, w);
  if (P.STATUS[q.status]) { p.push(q.status); w.push(`v.status = $${p.length}`); }
  if (q.koniec_od) { p.push(V.date(q.koniec_od, 'Koniec od')); w.push(`v.end_date >= $${p.length}`); }
  if (q.koniec_do) { p.push(V.date(q.koniec_do, 'Koniec do')); w.push(`v.end_date <= $${p.length}`); }
  if (q.konczy_dni) { p.push(Math.round(V.num(q.konczy_dni, 0, 3660, 'Dni'))); w.push(`v.status = 'konczy_sie' AND v.days_left <= $${p.length}`); }
  const sort = { koniec: 'v.end_date', podpisanie: 'v.signed_at DESC', kwota: 'v.total_amount DESC', klient: 'lower(v.customer_name)' }[q.sort] || 'v.signed_at DESC';
  res.json((await pool.query(`${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${sort}, v.created_at DESC LIMIT 1000`, p)).rows.map(withLabel));
}));
r.get('/polisy/slowniki', use, wrap(async (req, res) => {
  const [i, t] = await Promise.all([
    pool.query('SELECT insurer AS v, count(*)::int n FROM policies GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100'),
    pool.query('SELECT insurance_type AS v, count(*)::int n FROM policies GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100')]);
  const defaults = ['OC/AC pojazdu', 'Mieszkanie / dom', 'Na życie', 'NNW', 'Firma / OC działalności', 'Podróżne', 'Zdrowotne'];
  res.json({ insurers: i.rows.map(x => x.v), types: [...new Set([...t.rows.map(x => x.v), ...defaults])], statuses: P.STATUS });
}));
// Polisy do odnowienia: kończące się w ciągu 30 dni oraz zakończone w ostatnich 30 dniach bez odnowienia (nieoznaczone ręcznie).
r.get('/polisy/do-odnowienia', use, wrap(async (req, res) => {
  const rows = (await pool.query(`${SELECT} WHERE v.renewed_by IS NULL AND v.closed_at IS NULL AND v.end_date <= ${TODAY} + ${P.REMIND_DAYS} AND v.end_date >= ${TODAY} - 30
    ORDER BY v.end_date`)).rows.map(withLabel);
  res.json(rows);
}));

// ---------- pulpit ----------
r.get('/polisy/podsumowanie', use, wrap(async (req, res) => {
  const p = [], w = [], q = req.query;
  filters(q, p, w);
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const [s, ins, typ, months, soon, rem] = await Promise.all([
    pool.query(`SELECT count(*)::int AS liczba, coalesce(sum(v.total_amount), 0)::float AS kwota, coalesce(sum(v.profit), 0)::float AS zysk,
        coalesce(avg(v.total_amount), 0)::float AS srednia_kwota, coalesce(avg(v.margin_pct), 0)::float AS srednia_marza,
        CASE WHEN sum(v.total_amount) > 0 THEN (sum(v.profit) / sum(v.total_amount) * 100)::float END AS marza_wazona,
        count(*) FILTER (WHERE v.status = 'konczy_sie')::int AS konczy_30,
        count(*) FILTER (WHERE v.status IN ('aktywna', 'konczy_sie'))::int AS aktywne
      FROM policies_v v ${where}`, p),
    pool.query(`SELECT v.insurer AS k, count(*)::int n, sum(v.total_amount)::float kwota, sum(v.profit)::float zysk FROM policies_v v ${where} GROUP BY 1 ORDER BY 4 DESC LIMIT 20`, p),
    pool.query(`SELECT v.insurance_type AS k, count(*)::int n, sum(v.total_amount)::float kwota, sum(v.profit)::float zysk FROM policies_v v ${where} GROUP BY 1 ORDER BY 4 DESC LIMIT 20`, p),
    pool.query(`SELECT to_char(date_trunc('month', v.signed_at), 'YYYY-MM') AS m, count(*)::int n, sum(v.total_amount)::float kwota, sum(v.profit)::float zysk
      FROM policies_v v ${where ? where + ' AND' : 'WHERE'} v.signed_at >= date_trunc('month', ${TODAY}) - interval '11 months' GROUP BY 1 ORDER BY 1`, p),
    pool.query(`SELECT count(*)::int n FROM policies_v v WHERE v.status = 'konczy_sie'`),
    pool.query(`SELECT count(*)::int AS nowe FROM policy_reminders WHERE handled_at IS NULL`)
  ]);
  res.json({ ...s.rows[0], konczy_30_wszystkie: soon.rows[0].n, do_odnowienia: soon.rows[0].n, przypomnienia_nowe: rem.rows[0].nowe,
    by_insurer: ins.rows, by_type: typ.rows, months: months.rows,
    uwaga: 'Kwota polisy to wartość składki u towarzystwa – nie jest przychodem MXT. Przychodem (wynikiem działu) jest zysk z marży.' });
}));

// ---------- przypomnienia ----------
r.get('/polisy/przypomnienia', use, wrap(async (req, res) => {
  const w = req.query.stan === 'nowe' ? 'WHERE r.handled_at IS NULL' : req.query.stan === 'obsluzone' ? 'WHERE r.handled_at IS NOT NULL' : '';
  res.json((await pool.query(`SELECT r.*, p.number, p.insurer, p.insurance_type, p.renewed_by, p.closed_at, c.name AS customer_name, coalesce(nullif(u.full_name, ''), u.login) AS handled_by_name
    FROM policy_reminders r JOIN policies p ON p.id = r.policy_id JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = r.handled_by
    ${w} ORDER BY r.handled_at IS NULL DESC, r.generated_at DESC LIMIT 500`)).rows);
}));
r.post('/polisy/przypomnienia/:id/obsluz', idParam, use, wrap(async (req, res) => {
  const note = V.str((req.body || {}).notatka, 500);
  const x = await tx(async c => {
    const rm = (await c.query('UPDATE policy_reminders SET handled_at = now(), handled_by = $2, handled_note = $3 WHERE id = $1 AND handled_at IS NULL RETURNING *', [req.params.id, req.user.id, note])).rows[0];
    if (!rm) throw bad(409, 'Przypomnienie nie istnieje albo jest już obsłużone.');
    await P.event(c, rm.policy_id, 'obsluga_przypomnienia', { note: note || 'Przypomnienie obsłużone', userId: req.user.id });
    // Powiadomienia o tej polisie oznaczone jako przeczytane u wszystkich odbiorców.
    await c.query(`UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE related_type = 'policy' AND related_id = $1 AND kind = 'polisa.koniec'`, [rm.policy_id]);
    return rm;
  });
  await audit(req, 'polisa.przypomnienie.obsluga', { resource: 'policy_reminders', resourceId: x.id });
  res.json(x);
}));
r.get('/polisy/ustawienia', use, wrap(async (req, res) => res.json(await P.settings())));
r.put('/polisy/ustawienia', requirePerm('users.manage'), wrap(async (req, res) => {
  const list = Array.isArray((req.body || {}).recipients) ? req.body.recipients.slice(0, 50).map(v => V.uuid(v, 'Odbiorca', true)) : [];
  await pool.query(`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('insurance', $1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [JSON.stringify({ recipients: list }), req.user.id]);
  await audit(req, 'polisy.ustawienia', { resource: 'system_settings', resourceId: 'insurance', details: { odbiorcy: list.length } });
  res.json({ recipients: list });
}));

// ---------- karta polisy ----------
r.get('/polisy/:id', idParam, use, wrap(async (req, res) => {
  const x = (await pool.query(SELECT + ' WHERE v.id = $1', [req.params.id])).rows[0];
  if (!x) throw bad(404, 'Nie znaleziono polisy.');
  const [ev, rm, other] = await Promise.all([
    pool.query(`SELECT e.kind, e.changes, e.note, e.created_at, u.login FROM policy_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.policy_id = $1 ORDER BY e.id DESC`, [x.id]),
    pool.query(`SELECT r.*, coalesce(nullif(u.full_name, ''), u.login) AS handled_by_name FROM policy_reminders r LEFT JOIN users u ON u.id = r.handled_by WHERE r.policy_id = $1 ORDER BY r.generated_at DESC`, [x.id]),
    pool.query(`SELECT id, number, insurer, insurance_type, start_date, end_date, status FROM policies_v WHERE customer_id = $1 AND id <> $2 ORDER BY end_date DESC`, [x.customer_id, x.id])
  ]);
  res.json({ ...withLabel(x), fields: FIELDS, events: ev.rows, reminders: rm.rows, customer_policies: other.rows.map(withLabel) });
}));

// ---------- rejestracja i edycja ----------
async function linkRenewal(c, oldId, neu, userId) {
  const old = (await c.query('SELECT * FROM policies WHERE id = $1 FOR UPDATE', [oldId])).rows[0];
  if (!old) throw bad(400, 'Nie znaleziono polisy odnawianej.');
  if (old.id === neu.id) throw bad(400, 'Polisa nie może odnawiać samej siebie.');
  if (old.customer_id !== neu.customer_id) throw bad(400, 'Odnowienie dotyczy polisy tego samego klienta.');
  if (old.renewed_by) throw bad(409, 'Ta polisa jest już oznaczona jako odnowiona.');
  if (neu.start_date < old.start_date) throw bad(400, 'Nowa polisa musi zaczynać się nie wcześniej niż poprzednia.');
  await c.query('UPDATE policies SET renewed_by = $2, renewed_at = now(), updated_at = now() WHERE id = $1', [old.id, neu.id]);
  await c.query('UPDATE policies SET previous_id = $2, updated_at = now() WHERE id = $1', [neu.id, old.id]);
  await P.event(c, old.id, 'odnowienie', { changes: { renewed_by: [null, neu.number] }, note: `Odnowiona polisą ${neu.number}`, userId });
  await P.event(c, neu.id, 'odnowienie', { changes: { previous: [null, old.number] }, note: `Zastępuje polisę ${old.number}`, userId });
  // Przypomnienia odnowionej polisy – obsłużone automatycznie.
  await c.query(`UPDATE policy_reminders SET handled_at = now(), handled_by = $2, handled_note = $3 WHERE policy_id = $1 AND handled_at IS NULL`, [old.id, userId, 'Polisa odnowiona: ' + neu.number]);
  return old;
}
r.post('/polisy', use, wrap(async (req, res) => {
  const b = req.body || {}, o = policyFields(b, false);
  checkDates(o);
  const x = await tx(async c => {
    const customer = await customerFor(c, b, req.user.id);
    const row = (await c.query(`INSERT INTO policies (number, customer_id, insurer, insurance_type, description, signed_at, start_date, end_date, total_amount, margin_pct, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [o.number, customer, o.insurer, o.insurance_type, o.description, o.signed_at, o.start_date, o.end_date, o.total_amount, o.margin_pct, o.notes, req.user.id])).rows[0];
    await c.query(`UPDATE customers SET departments = array_append(departments, 'ubezpieczenia') WHERE id = $1 AND NOT ('ubezpieczenia' = ANY(departments))`, [customer]);
    await P.event(c, row.id, 'utworzenie', { changes: { kwota: [null, o.total_amount], marza: [null, o.margin_pct], zysk: [null, String(row.profit)] }, userId: req.user.id });
    // Odnowienie tylko po potwierdzeniu użytkownika (wskazanie polisy, którą ta zastępuje).
    if (b.odnawia) await linkRenewal(c, V.uuid(b.odnawia, 'Polisa odnawiana', true), row, req.user.id);
    return row;
  }).catch(e => { if (e.code === '23505') throw bad(409, 'Polisa o tym numerze w tym towarzystwie jest już w rejestrze.'); throw e; });
  await audit(req, 'polisa.rejestracja', { resource: 'policies', resourceId: x.id, details: { numer: x.number, towarzystwo: x.insurer, kwota: Number(x.total_amount), marza: Number(x.margin_pct), zysk: Number(x.profit) } });
  res.status(201).json(withLabel((await pool.query(SELECT + ' WHERE v.id = $1', [x.id])).rows[0]));
}));
r.patch('/polisy/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, o = policyFields(b, true);
  if (b.customer_id !== undefined) o.customer_id = V.uuid(b.customer_id, 'Klient', true);
  const k = Object.keys(o);
  if (!k.length) throw bad(400, 'Brak zmian.');
  const x = await tx(async c => {
    const before = (await c.query('SELECT * FROM policies WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw bad(404, 'Nie znaleziono polisy.');
    if (o.customer_id && !(await c.query('SELECT 1 FROM customers WHERE id = $1', [o.customer_id])).rows[0]) throw bad(400, 'Nie znaleziono klienta.');
    const merged = { ...before, ...o };
    const str = v => v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v);
    checkDates({ start_date: str(merged.start_date), end_date: str(merged.end_date), signed_at: str(merged.signed_at) });
    const row = (await c.query(`UPDATE policies SET ${k.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [before.id, ...k.map(f => o[f])])).rows[0];
    // Historia: każda zmieniona wartość (przed → po); zmiana kwoty lub marży przelicza zysk (kolumna wyliczana w bazie).
    const changes = {};
    for (const f of k) {
      const a = ['total_amount', 'margin_pct'].includes(f) ? String(Number(before[f])) : str(before[f]), z = ['total_amount', 'margin_pct'].includes(f) ? String(Number(row[f])) : str(row[f]);
      if (a !== z) changes[f] = [a, z];
    }
    if (Number(before.profit) !== Number(row.profit)) changes.profit = [String(Number(before.profit)), String(Number(row.profit))];
    if (Object.keys(changes).length) await P.event(c, row.id, 'zmiana', { changes, note: V.str(b.powod_zmiany, 300), userId: req.user.id });
    return { row, changes };
  }).catch(e => { if (e.code === '23505') throw bad(409, 'Polisa o tym numerze w tym towarzystwie jest już w rejestrze.'); throw e; });
  await audit(req, 'polisa.zmiana', { resource: 'policies', resourceId: req.params.id, details: { pola: Object.keys(x.changes) } });
  res.json(withLabel((await pool.query(SELECT + ' WHERE v.id = $1', [req.params.id])).rows[0]));
}));
r.post('/polisy/:id/odnow', idParam, use, wrap(async (req, res) => {
  const newId = V.uuid((req.body || {}).nowa_polisa, 'Nowa polisa', true);
  await tx(async c => {
    const neu = (await c.query('SELECT * FROM policies WHERE id = $1 FOR UPDATE', [newId])).rows[0];
    if (!neu) throw bad(400, 'Nie znaleziono nowej polisy.');
    if (neu.previous_id) throw bad(409, 'Nowa polisa jest już powiązana z inną poprzednią polisą.');
    await linkRenewal(c, req.params.id, neu, req.user.id);
  });
  await audit(req, 'polisa.odnowienie', { resource: 'policies', resourceId: req.params.id, details: { nowa: newId } });
  res.json({ ok: true });
}));
r.post('/polisy/:id/zakoncz', idParam, use, wrap(async (req, res) => {
  const reason = V.str((req.body || {}).powod, 500, true, 'Powód zakończenia');
  await tx(async c => {
    const x = (await c.query('SELECT * FROM policies WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!x) throw bad(404, 'Nie znaleziono polisy.');
    if (x.closed_at || x.renewed_by) throw bad(409, 'Polisa jest już zakończona lub odnowiona.');
    await c.query('UPDATE policies SET closed_at = now(), close_reason = $2, updated_at = now() WHERE id = $1', [x.id, reason]);
    await c.query(`UPDATE policy_reminders SET handled_at = now(), handled_by = $2, handled_note = $3 WHERE policy_id = $1 AND handled_at IS NULL`, [x.id, req.user.id, 'Polisa zakończona: ' + reason]);
    await P.event(c, x.id, 'zakonczenie', { note: reason, userId: req.user.id });
  });
  await audit(req, 'polisa.zakonczenie', { resource: 'policies', resourceId: req.params.id, details: { powod: reason } });
  res.json({ ok: true });
}));
r.post('/polisy/:id/wznow', idParam, use, wrap(async (req, res) => {
  await tx(async c => {
    const x = (await c.query('UPDATE policies SET closed_at = NULL, close_reason = \'\', updated_at = now() WHERE id = $1 AND closed_at IS NOT NULL RETURNING id', [req.params.id])).rows[0];
    if (!x) throw bad(409, 'Polisa nie była oznaczona jako zakończona.');
    await P.event(c, x.id, 'wznowienie', { note: 'Cofnięto oznaczenie „zakończona”', userId: req.user.id });
  });
  res.json({ ok: true });
}));
// Dokument polisy: PDF albo skan (JPG/PNG) do 10 MB, z wersjami (każdy nowy plik = nowa wersja).
r.post('/polisy/:id/dokument', idParam, use, wrap(async (req, res) => {
  const b = req.body || {};
  const buf = Buffer.from(String(b.plik || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw bad(400, 'Wybierz plik polisy.');
  if (buf.length > 10 * 1024 * 1024) throw bad(400, 'Plik jest za duży (maks. 10 MB).');
  const mime = docs.isPdf(buf) ? 'application/pdf' : buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg' : buf.subarray(1, 4).toString('latin1') === 'PNG' ? 'image/png' : null;
  if (!mime) throw bad(400, 'Dozwolone pliki: PDF, JPG, PNG.');
  const name = V.str(b.nazwa, 200) || 'polisa.' + (mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg');
  const out = await tx(async c => {
    const x = (await c.query('SELECT * FROM policies WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!x) throw bad(404, 'Nie znaleziono polisy.');
    let docId = x.document_id;
    if (!docId) {
      docId = (await docs.createDocument(c, { kind: 'inny', title: `Polisa ${x.number} – ${x.insurer}`, department_id: 'ubezpieczenia', related_type: 'policy', related_id: x.id, userId: req.user.id })).id;
      await c.query('UPDATE policies SET document_id = $2, updated_at = now() WHERE id = $1', [x.id, docId]);
    }
    const v = await docs.addVersion(c, docId, { content: '', file: buf, fileName: name.replace(/[^\p{L}\d._ -]+/gu, '_'), mime, note: 'Dokument polisy', userId: req.user.id });
    await P.event(c, x.id, 'dokument', { note: `Dokument polisy (wersja ${v}): ${name}`, userId: req.user.id });
    return { document_id: docId, version: v };
  });
  await audit(req, 'polisa.dokument', { resource: 'policies', resourceId: req.params.id, details: { wersja: out.version, rozmiar: buf.length } });
  res.status(201).json(out);
}));

module.exports = r;
