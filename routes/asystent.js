'use strict';
// Asystent telefoniczny: webhook dla bota (klucz zamiast sesji) i API panelu w dziale „Asystent telefoniczny”.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/rbac');
const P = require('../lib/phone');
const xlsx = require('../lib/xlsx');
const { wrap, idParam, V, bad } = require('./_util');

// =============== webhook: POST /api/asystent/webhook (montowany w server.js przed sprawdzaniem sesji) ===============
// Nagłówek: Authorization: Bearer <klucz z zakładki Integracja>. Limit: 20 nieudanych prób w 15 minut na adres IP.
const webhook = express.Router();
const fails = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of fails) if (t - v.ts > 15 * 60e3) fails.delete(k); }, 60e3).unref();
webhook.post('/', wrap(async (req, res) => {
  const f = fails.get(req.ip) || { n: 0, ts: Date.now() };
  if (f.n >= 20) return res.status(429).json({ error: 'Zbyt wiele nieudanych prób. Spróbuj ponownie za kilka minut.' });
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!m || !(await P.checkKey(m[1]))) {
    f.n++; fails.set(req.ip, f);
    await audit({ ip: req.ip }, 'asystent.webhook', { status: 'odmowa', details: { powod: m ? 'nieprawidłowy klucz' : 'brak klucza' } });
    return res.status(401).json({ error: 'Nieprawidłowy albo brakujący klucz (nagłówek Authorization: Bearer …).' });
  }
  const r = await P.ingest(req.body, { ip: req.ip });
  await P.saveSettings({ last_used_at: new Date().toISOString() });
  res.status(r.status).json(r.body);
}));

// =============== panel (sesja MXT) ===============
const r = express.Router();
const use = requirePerm('departments.view'), admin = requirePerm('ai.settings');

r.get('/podsumowanie', use, wrap(async (req, res) => {
  const days = [7, 14, 30, 90].includes(+req.query.dni) ? +req.query.dni : 14;
  res.json(await P.summary(days));
}));

const CALL_COLS = `c.id, c.call_sid, c.started_at, c.ended_at, c.duration_s, c.caller_phone, c.department, c.outcome, c.transferred, c.summary,
  c.avg_response_ms, c.is_test, c.review_status, c.review_note, c.reviewed_at, (c.transcript IS NOT NULL) AS ma_transkrypcje, c.transcript_deleted_at,
  (SELECT count(*)::int FROM phone_requests q WHERE q.call_id = c.id) AS zgloszenia`;
r.get('/rozmowy', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (P.DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`c.department = $${p.length}`); }
  if (P.OUTCOMES.includes(req.query.wynik)) { p.push(req.query.wynik); w.push(`c.outcome = $${p.length}`); }
  if (['nowa', 'sprawdzona', 'blad_danych'].includes(req.query.przeglad)) { p.push(req.query.przeglad); w.push(`c.review_status = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(c.caller_phone ILIKE $${p.length} OR c.summary ILIKE $${p.length})`); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const page = Math.max(1, parseInt(req.query.strona, 10) || 1);
  const total = (await pool.query(`SELECT count(*)::int n FROM phone_calls c ${where}`, p)).rows[0].n;
  const q = await pool.query(`SELECT ${CALL_COLS} FROM phone_calls c ${where} ORDER BY c.started_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`, p);
  res.set('X-Total-Count', String(total)).json(q.rows);
}));
r.get('/rozmowy/:id', idParam, use, wrap(async (req, res) => {
  const c = (await pool.query(`SELECT ${CALL_COLS}, c.transcript, u.full_name AS reviewed_by_name, u.login AS reviewed_by_login
    FROM phone_calls c LEFT JOIN users u ON u.id = c.reviewed_by WHERE c.id = $1`, [req.params.id])).rows[0];
  if (!c) throw bad(404, 'Nie znaleziono rozmowy.');
  c.requests = (await pool.query(`SELECT q.*, o.number AS order_number, o.status AS order_status FROM phone_requests q
    LEFT JOIN service_orders o ON o.id = q.service_order_id WHERE q.call_id = $1 ORDER BY q.created_at, q.id`, [c.id])).rows;
  res.json(c);
}));
// Przegląd transkrypcji (plan: codziennie przez pierwsze 2 tygodnie) – podstawa wskaźnika „pomyłki w danych”.
r.post('/rozmowy/:id/ocena', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, status = V.oneOf(b.status, ['nowa', 'sprawdzona', 'blad_danych'], 'Ocena'), note = V.str(b.uwaga, 1000);
  if (status === 'blad_danych' && !note) throw bad(400, 'Opisz, co asystentka zapisała błędnie.');
  const q = await pool.query(`UPDATE phone_calls SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = CASE WHEN $2 = 'nowa' THEN NULL ELSE now() END
    WHERE id = $1 RETURNING id, review_status, review_note, reviewed_at`, [req.params.id, status, note, status === 'nowa' ? null : req.user.id]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono rozmowy.');
  await audit(req, 'asystent.ocena', { resource: 'phone_calls', resourceId: req.params.id, details: { ocena: status, uwaga: note } });
  res.json(q.rows[0]);
}));

r.get('/zgloszenia', use, wrap(async (req, res) => {
  const p = [], w = [];
  const st = req.query.status || 'otwarte';
  if (st === 'otwarte') w.push(`q.status IN ('nowe','w_toku')`);
  else if (P.REQ_STATUS.includes(st)) { p.push(st); w.push(`q.status = $${p.length}`); }
  if (P.DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`q.department = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(q.caller_name ILIKE $${p.length} OR q.phone ILIKE $${p.length} OR q.address ILIKE $${p.length} OR q.description ILIKE $${p.length})`); }
  const q = await pool.query(`SELECT q.*, c.started_at AS call_started_at, c.is_test, o.number AS order_number, o.status AS order_status,
      u.full_name AS handled_by_name, u.login AS handled_by_login
    FROM phone_requests q JOIN phone_calls c ON c.id = q.call_id LEFT JOIN service_orders o ON o.id = q.service_order_id LEFT JOIN users u ON u.id = q.handled_by
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY (q.status IN ('nowe','w_toku') AND q.urgent) DESC, q.created_at DESC LIMIT 200`, p);
  res.json(q.rows);
}));
r.patch('/zgloszenia/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, status = V.oneOf(b.status, P.REQ_STATUS, 'Status'), note = b.notatka === undefined ? null : V.str(b.notatka, 2000);
  const cur = (await pool.query('SELECT status FROM phone_requests WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw bad(404, 'Nie znaleziono zgłoszenia.');
  if (status === 'anulowane' && !note) throw bad(400, 'Podaj powód anulowania.');
  const q = await pool.query(`UPDATE phone_requests SET status = $2, note = COALESCE($3, note), handled_by = $4, handled_at = now(), updated_at = now()
    WHERE id = $1 RETURNING *`, [req.params.id, status, note, req.user.id]);
  await audit(req, 'asystent.zgloszenie', { resource: 'phone_requests', resourceId: req.params.id, details: { z: cur.status, na: status, notatka: note } });
  res.json(q.rows[0]);
}));

// ---------- integracja z botem ----------
const origin = req => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
r.get('/integracja', use, wrap(async (req, res) => {
  const s = await P.settings();
  res.json({ adres: origin(req) + '/api/asystent/webhook', retencja_dni: s.retention_days,
    klucz: { ustawiony: !!s.key_hash, koncowka: s.key_hint || '', utworzony: s.key_created_at || null, ostatnie_uzycie: s.last_used_at || null },
    przyklad: P.sample(false), moze_zmieniac: req.user && require('../lib/rbac').can(req.user, 'ai.settings') });
}));
r.post('/integracja/klucz', admin, wrap(async (req, res) => {
  const key = await P.newKey(req.user.id);
  await audit(req, 'asystent.klucz', { details: { koncowka: key.slice(-4) } });
  res.status(201).json({ klucz: key, info: 'Klucz pokazujemy tylko raz. Wpisz go w ustawieniach bota (MXT_APP_WEBHOOK_TOKEN). Poprzedni klucz przestał działać.' });
}));
r.put('/integracja/ustawienia', admin, wrap(async (req, res) => {
  const days = Math.round(V.num((req.body || {}).retencja_dni, 7, 3650, 'Okres przechowywania transkrypcji'));
  await P.saveSettings({ retention_days: days }, req.user.id);
  await audit(req, 'asystent.ustawienia', { details: { retencja_dni: days } });
  res.json({ retencja_dni: days, usunieto: await P.purgeTranscripts() });
}));
// Rozmowa testowa: ta sama ścieżka zapisu co z bota, oznaczona jako test (bez zleceń, powiadomień i statystyk).
r.post('/integracja/test', admin, wrap(async (req, res) => {
  const out = await P.ingest(P.sample(true), { ip: req.ip });
  await audit(req, 'asystent.test', { resource: 'phone_calls', resourceId: out.body.rozmowa_id });
  res.status(201).json(out.body);
}));

// ---------- eksport ----------
r.get('/eksport', use, requirePerm('export.xlsx'), wrap(async (req, res) => {
  const tz = col => `to_char(${col} AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI')`;
  const calls = (await pool.query(`SELECT ${tz('c.started_at')} AS kiedy, c.caller_phone, c.department, c.outcome, CASE WHEN c.transferred THEN 'tak' ELSE 'nie' END AS transferred, c.duration_s, c.avg_response_ms,
      c.summary, c.review_status, c.review_note, CASE WHEN c.is_test THEN 'tak' ELSE 'nie' END AS is_test FROM phone_calls c ORDER BY c.started_at DESC LIMIT 20000`)).rows;
  const reqs = (await pool.query(`SELECT ${tz('q.created_at')} AS kiedy, q.kind, q.department, q.caller_name, q.phone, q.address, q.city, q.description,
      CASE WHEN q.urgent THEN 'tak' ELSE 'nie' END AS urgent, ${tz('q.slot_at')} AS termin, q.status, q.note, o.number AS zlecenie, CASE WHEN c.is_test THEN 'tak' ELSE 'nie' END AS is_test FROM phone_requests q JOIN phone_calls c ON c.id = q.call_id
      LEFT JOIN service_orders o ON o.id = q.service_order_id ORDER BY q.created_at DESC LIMIT 20000`)).rows.map(x => ({ ...x, kind: P.KIND_LABEL[x.kind] || x.kind }));
  const buf = await xlsx.build([
    { name: 'Rozmowy', rows: calls, columns: [{ header: 'Rozpoczęcie', key: 'kiedy', width: 17 }, { header: 'Telefon', key: 'caller_phone', width: 16 },
      { header: 'Dział', key: 'department', width: 14 }, { header: 'Wynik', key: 'outcome', width: 14 }, { header: 'Przekazana', key: 'transferred' },
      { header: 'Czas (s)', key: 'duration_s', type: 'int' }, { header: 'Śr. odpowiedź (ms)', key: 'avg_response_ms', type: 'int' },
      { header: 'Podsumowanie', key: 'summary', width: 48 }, { header: 'Przegląd', key: 'review_status', width: 14 }, { header: 'Uwaga z przeglądu', key: 'review_note', width: 30 },
      { header: 'Test', key: 'is_test' }] },
    { name: 'Zgłoszenia', rows: reqs, columns: [{ header: 'Przyjęto', key: 'kiedy', width: 17 }, { header: 'Rodzaj', key: 'kind', width: 22 },
      { header: 'Dział', key: 'department', width: 14 }, { header: 'Klient', key: 'caller_name', width: 22 }, { header: 'Telefon', key: 'phone', width: 16 },
      { header: 'Adres', key: 'address', width: 24 }, { header: 'Miasto', key: 'city', width: 16 }, { header: 'Opis', key: 'description', width: 40 },
      { header: 'Pilne', key: 'urgent' }, { header: 'Termin uzgodniony', key: 'termin', width: 17 }, { header: 'Status', key: 'status', width: 12 },
      { header: 'Notatka', key: 'note', width: 30 }, { header: 'Zlecenie serwisowe', key: 'zlecenie', width: 16 }, { header: 'Test', key: 'is_test' }] }
  ], { title: 'Asystent telefoniczny' });
  await audit(req, 'eksport.xlsx', { resource: 'asystent/eksport', details: { rozmowy: calls.length, zgloszenia: reqs.length } });
  xlsx.send(res, buf, 'Asystent_telefoniczny');
}));

module.exports = { webhook, office: r };
