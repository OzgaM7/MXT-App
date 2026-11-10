'use strict';
// Moduły biznesowe (etap 3): CRM, komunikacja, Finance Intelligence, Knowledge Base i pliki, kursy walut,
// oferty, historia sprzedaży, reklamacje, dokumenty eksportowe. Praca z modułami: uprawnienie tasks.use (obie role);
// usuwanie danych finansowych, ręczne kursy i edycja dokumentów wiedzy dla agentów – administratorzy.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm, can } = require('../lib/rbac');
const docs = require('../lib/docs');
const nbp = require('../lib/nbp');
const pdf = require('../lib/pdf');
const offers = require('../lib/offers');
const { wrap, idParam, V, bad, patchSql, sendPdf } = require('./_util');

const r = express.Router();
const use = requirePerm('tasks.use'), admin = requirePerm('approvals.decide');
const DEPTS = ['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport', 'ubezpieczenia'];
const CUSTOMER_KINDS = ['wspolnota', 'spoldzielnia', 'zarzadca', 'firma', 'klient_zagraniczny', 'inny'];

// ======================= CRM =======================
function customerFields(b, partial) {
  const o = {};
  const set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set('kind', v => V.oneOf(v, CUSTOMER_KINDS, 'Rodzaj klienta'));
  set('name', v => { const s = V.str(v, 200, true, 'Nazwa'); if (s.length < 2) throw bad(400, 'Nazwa: min. 2 znaki.'); return s; });
  for (const [k, m] of [['tax_id', 30], ['address', 400], ['email', 200], ['phone', 50], ['notes', 4000]]) set(k, v => V.str(v, m));
  set('country', v => (V.str(v, 2) || 'PL').toUpperCase());
  set('language', v => V.oneOf(v || 'pl', ['pl', 'en', 'de', 'fr', 'es', 'it', 'cs', 'uk', 'lt'], 'Język'));
  set('departments', v => (Array.isArray(v) ? v : []).filter(d => DEPTS.includes(d)));
  set('contacts', v => JSON.stringify((Array.isArray(v) ? v : []).slice(0, 30).map(c => ({ imie: V.str(c.imie, 120), funkcja: V.str(c.funkcja, 120), email: V.str(c.email, 200), telefon: V.str(c.telefon, 50) })).filter(c => c.imie || c.email || c.telefon)));
  if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw bad(400, 'Nieprawidłowy adres e-mail.');
  return o;
}
r.get('/klienci', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(name ILIKE $${p.length} OR tax_id ILIKE $${p.length} OR address ILIKE $${p.length} OR email ILIKE $${p.length})`); }
  if (DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`$${p.length} = ANY(departments)`); }
  if (CUSTOMER_KINDS.includes(req.query.rodzaj)) { p.push(req.query.rodzaj); w.push(`kind = $${p.length}`); }
  const q = await pool.query(`SELECT c.*, (SELECT count(*)::int FROM buildings b WHERE b.customer_id = c.id) AS buildings,
      (SELECT count(*)::int FROM offers o WHERE o.customer_id = c.id) AS offers, (SELECT count(*)::int FROM complaints x WHERE x.customer_id = c.id AND x.status NOT IN ('rozwiazana','odrzucona')) AS open_complaints
    FROM customers c ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY lower(name) LIMIT 300`, p);
  res.json(q.rows);
}));
r.post('/klienci', use, wrap(async (req, res) => {
  const o = customerFields(req.body || {}, false);
  const q = await pool.query(`INSERT INTO customers (kind, name, tax_id, country, address, email, phone, language, contacts, departments, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [o.kind, o.name, o.tax_id, o.country, o.address, o.email, o.phone, o.language, o.contacts, o.departments, o.notes, req.user.id]);
  await audit(req, 'klient.utworzenie', { resource: 'customers', resourceId: q.rows[0].id, details: { nazwa: o.name } });
  res.status(201).json(q.rows[0]);
}));
r.patch('/klienci/:id', idParam, use, wrap(async (req, res) => {
  const { sql, params } = patchSql('customers', req.params.id, customerFields(req.body || {}, true));
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono klienta.');
  await audit(req, 'klient.zmiana', { resource: 'customers', resourceId: req.params.id });
  res.json(q.rows[0]);
}));
// Karta klienta: kontakty i pełna historia współpracy.
r.get('/klienci/:id', idParam, use, wrap(async (req, res) => {
  const id = req.params.id;
  const c = (await pool.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
  if (!c) throw bad(404, 'Nie znaleziono klienta.');
  const [b, pr, of, sa, co, cm, fi] = await Promise.all([
    pool.query('SELECT id, name, address, city, units_count FROM buildings WHERE customer_id = $1 ORDER BY name', [id]),
    pool.query('SELECT id, number, title, status, value_net, currency, start_date, end_date FROM projects WHERE customer_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT id, number, title, status, total, currency, version, created_at, sent_at FROM offers WHERE customer_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT id, number, sale_date, total, currency, total_pln, status FROM sales_history WHERE customer_id = $1 ORDER BY sale_date DESC', [id]),
    pool.query('SELECT id, number, title, status, reported_at, department_id FROM complaints WHERE customer_id = $1 ORDER BY reported_at DESC', [id]),
    pool.query(`SELECT m.*, u.login AS created_by_login FROM communications m LEFT JOIN users u ON u.id = m.created_by WHERE m.customer_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [id]),
    pool.query(`SELECT coalesce(sum(amount_pln) FILTER (WHERE kind = 'przychod'), 0)::float AS przychod, coalesce(sum(amount_pln) FILTER (WHERE kind = 'koszt'), 0)::float AS koszt,
      coalesce(sum(amount_pln) FILTER (WHERE kind = 'przychod' AND paid_at IS NULL AND invoice_no <> ''), 0)::float AS nieoplacone FROM finance WHERE customer_id = $1`, [id])
  ]);
  res.json({ ...c, buildings: b.rows, projects: pr.rows, offers: of.rows, sales: sa.rows, complaints: co.rows, communications: cm.rows, finance: fi.rows[0] });
}));
r.post('/klienci/:id/komunikacja', idParam, use, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query(`INSERT INTO communications (customer_id, channel, direction, subject, body, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.params.id, V.oneOf(b.channel, ['email', 'telefon', 'spotkanie', 'notatka'], 'Kanał'), V.oneOf(b.direction, ['przychodzaca', 'wychodzaca', 'wewnetrzna'], 'Kierunek', 'wewnetrzna'),
      V.str(b.subject, 300, true, 'Temat'), V.str(b.body, 10000), req.user.id]);
  await audit(req, 'komunikacja.wpis', { resource: 'communications', resourceId: q.rows[0].id });
  res.status(201).json(q.rows[0]);
}));

// ======================= kontrakty (projects) – wspólne dla działu 1 =======================
// (trasy w routes/dzial1.js)

// ======================= Finance Intelligence (działy 1 i 2) =======================
const FIN_DEPTS = ['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport'];
r.get('/finanse', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (FIN_DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`f.department_id = $${p.length}`); }
  if (['przychod', 'koszt'].includes(req.query.rodzaj)) { p.push(req.query.rodzaj); w.push(`f.kind = $${p.length}`); }
  if (req.query.status === 'nieoplacone') w.push(`f.kind = 'przychod' AND f.invoice_no <> '' AND f.paid_at IS NULL`);
  if (req.query.status === 'po_terminie') w.push(`f.kind = 'przychod' AND f.paid_at IS NULL AND f.due_date < current_date`);
  for (const k of ['building_id', 'project_id', 'installation_id', 'customer_id']) if (req.query[k]) { p.push(V.uuid(req.query[k])); w.push(`f.${k} = $${p.length}`); }
  const q = await pool.query(`SELECT f.*, f.amount::float AS amount, f.amount_pln::float AS amount_pln, c.name AS customer_name, b.name AS building_name, pr.number AS project_number, i.number AS installation_number
    FROM finance f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN buildings b ON b.id = f.building_id LEFT JOIN projects pr ON pr.id = f.project_id
    LEFT JOIN installations i ON i.id = f.installation_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY f.entry_date DESC, f.created_at DESC LIMIT 300`, p);
  res.json(q.rows);
}));
r.post('/finanse', use, wrap(async (req, res) => {
  const b = req.body || {};
  const dep = V.oneOf(b.department_id, FIN_DEPTS, 'Dział'), kind = V.oneOf(b.kind, ['przychod', 'koszt'], 'Rodzaj');
  const amount = V.num(b.amount, 0.01, 1e10, 'Kwota'), currency = (V.str(b.currency, 3) || 'PLN').toUpperCase(), date = V.date(b.entry_date) || new Date().toISOString().slice(0, 10);
  let rate; try { rate = await nbp.rateFor(currency, date); } catch (e) { throw bad(e.status || 409, e.message); }
  const q = await pool.query(`INSERT INTO finance (department_id, kind, category, description, amount, currency, rate_pln, amount_pln, entry_date, invoice_no, due_date, paid_at,
      customer_id, project_id, building_id, installation_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [dep, kind, V.str(b.category, 60), V.str(b.description, 500), amount, currency, rate.rate_pln, Math.round(amount * rate.rate_pln * 100) / 100, date, V.str(b.invoice_no, 60),
      V.date(b.due_date, 'Termin płatności'), V.date(b.paid_at, 'Data zapłaty'), V.uuid(b.customer_id), V.uuid(b.project_id), V.uuid(b.building_id), V.uuid(b.installation_id), req.user.id]);
  await audit(req, 'finanse.wpis', { resource: 'finance', resourceId: q.rows[0].id, details: { rodzaj: kind, kwota: amount, waluta: currency } });
  res.status(201).json(q.rows[0]);
}));
r.post('/finanse/:id/zaplacono', idParam, use, wrap(async (req, res) => {
  const q = await pool.query(`UPDATE finance SET paid_at = coalesce($2::date, current_date) WHERE id = $1 RETURNING *`, [req.params.id, V.date((req.body || {}).paid_at)]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono wpisu.');
  await audit(req, 'finanse.zaplata', { resource: 'finance', resourceId: req.params.id });
  res.json(q.rows[0]);
}));
r.delete('/finanse/:id', idParam, admin, wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM finance WHERE id = $1 RETURNING *', [req.params.id]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono wpisu.');
  await audit(req, 'finanse.usuniecie', { resource: 'finance', resourceId: req.params.id, details: { kwota: q.rows[0].amount, opis: q.rows[0].description } });
  res.json({ ok: true });
}));
// Podsumowanie: przychody, koszty, marże miesięcznie (12 mies.), należności, prognoza (średnia z 3 pełnych miesięcy).
r.get('/finanse/podsumowanie', use, wrap(async (req, res) => res.json(await financeSummary())));
async function financeSummary() {
  const [m, t, inv] = await Promise.all([
    pool.query(`SELECT to_char(date_trunc('month', entry_date), 'YYYY-MM') AS miesiac, department_id,
      coalesce(sum(amount_pln) FILTER (WHERE kind = 'przychod'), 0)::float AS przychod, coalesce(sum(amount_pln) FILTER (WHERE kind = 'koszt'), 0)::float AS koszt
      FROM finance WHERE entry_date >= date_trunc('month', current_date) - interval '11 months' GROUP BY 1, 2 ORDER BY 1`),
    pool.query(`SELECT department_id, coalesce(sum(amount_pln) FILTER (WHERE kind = 'przychod'), 0)::float AS przychod, coalesce(sum(amount_pln) FILTER (WHERE kind = 'koszt'), 0)::float AS koszt
      FROM finance WHERE entry_date >= date_trunc('year', current_date) GROUP BY 1`),
    pool.query(`SELECT count(*) FILTER (WHERE paid_at IS NULL)::int AS nieoplacone, coalesce(sum(amount_pln) FILTER (WHERE paid_at IS NULL), 0)::float AS kwota_nieoplacona,
      count(*) FILTER (WHERE paid_at IS NULL AND due_date < current_date)::int AS po_terminie, coalesce(sum(amount_pln) FILTER (WHERE paid_at IS NULL AND due_date < current_date), 0)::float AS kwota_po_terminie
      FROM finance WHERE kind = 'przychod' AND invoice_no <> ''`)
  ]);
  const months = []; const now = new Date();
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); }
  const series = FIN_DEPTS.map(dep => ({ department_id: dep, months: months.map(mm => { const x = m.rows.find(y => y.miesiac === mm && y.department_id === dep); return { miesiac: mm, przychod: x ? x.przychod : 0, koszt: x ? x.koszt : 0 }; }) }));
  const forecast = series.map(s => {
    const full = s.months.slice(-4, -1), avg = k => full.reduce((a, x) => a + x[k], 0) / 3;
    return { department_id: s.department_id, metoda: 'średnia z 3 ostatnich pełnych miesięcy', przychod_mies: Math.round(avg('przychod')), koszt_mies: Math.round(avg('koszt')) };
  });
  return { months, series, ytd: FIN_DEPTS.map(dep => { const x = t.rows.find(y => y.department_id === dep) || { przychod: 0, koszt: 0 }; return { department_id: dep, ...x, marza: x.przychod - x.koszt, marza_pct: x.przychod ? Math.round((x.przychod - x.koszt) / x.przychod * 1000) / 10 : 0 }; }), invoices: inv.rows[0], forecast };
}

// ======================= kursy walut =======================
r.get('/kursy', use, wrap(async (req, res) => res.json(await nbp.latest())));
r.post('/kursy/pobierz', use, wrap(async (req, res) => {
  let out; try { out = await nbp.fetchTableA(); } catch (e) { throw bad(502, 'Nie udało się pobrać kursów z NBP: ' + e.message); }
  await audit(req, 'kursy.pobranie_nbp', { resource: 'currency_rates', details: out });
  res.json(out);
}));
r.post('/kursy/reczny', admin, wrap(async (req, res) => {
  const b = req.body || {}, code = V.str(b.code, 3, true, 'Waluta').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || code === 'PLN') throw bad(400, 'Podaj kod waluty (np. EUR).');
  const q = await pool.query(`INSERT INTO currency_rates (code, rate_pln, effective_date, table_no, source) VALUES ($1, $2, $3, '', $4)
    ON CONFLICT (code, effective_date, source) DO UPDATE SET rate_pln = excluded.rate_pln, fetched_at = now() RETURNING *`,
    [code, V.num(b.rate_pln, 0.000001, 100000, 'Kurs'), V.date(b.effective_date, 'Data kursu', true), 'ręcznie: ' + req.user.login]);
  await audit(req, 'kursy.wpis_reczny', { resource: 'currency_rates', resourceId: q.rows[0].id, details: { waluta: code, kurs: b.rate_pln } });
  res.status(201).json(q.rows[0]);
}));
// Kalkulacja wielowalutowa: kwota z waluty A do B przez kurs NBP (z datą), z opcjonalną marżą.
r.post('/kursy/przelicz', use, wrap(async (req, res) => {
  const b = req.body || {}, amount = V.num(b.amount, 0, 1e12, 'Kwota'), margin = V.num(b.margin_pct, -50, 500, 'Marża');
  let from, to; try { from = await nbp.rateFor(b.from, V.date(b.date)); to = await nbp.rateFor(b.to, V.date(b.date)); } catch (e) { throw bad(e.status || 409, e.message); }
  const pln = amount * from.rate_pln, result = pln / to.rate_pln, withMargin = result * (1 + margin / 100);
  res.json({ amount, from, to, pln: Math.round(pln * 100) / 100, result: Math.round(result * 100) / 100, margin_pct: margin, with_margin: Math.round(withMargin * 100) / 100,
    cross_rate: Math.round(from.rate_pln / to.rate_pln * 1e6) / 1e6 });
}));

// ======================= oferty (działy 1 i 2) =======================
const OFFER_SELECT = `SELECT o.*, o.total::float AS total, o.total_pln::float AS total_pln, o.cost_pln::float AS cost_pln, o.rate_pln::float AS rate_pln,
  c.name AS customer_name, c.country AS customer_country, u.login AS created_by_login, a.status AS approval_status, a.version AS approval_version
  FROM offers o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.created_by LEFT JOIN approvals a ON a.id = o.approval_id`;
r.get('/oferty', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (offers.DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`o.department_id = $${p.length}`); }
  if (req.query.status) { p.push(String(req.query.status)); w.push(`o.status = $${p.length}`); }
  const q = await pool.query(OFFER_SELECT + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY o.created_at DESC LIMIT 200', p);
  res.json(q.rows);
}));
r.get('/oferty/:id', idParam, use, wrap(async (req, res) => {
  const o = (await pool.query(OFFER_SELECT + ' WHERE o.id = $1', [req.params.id])).rows[0];
  if (!o) throw bad(404, 'Nie znaleziono oferty.');
  const v = await pool.query(`SELECT v.version, v.note, v.created_at, coalesce(u.login, v.created_by_agent, 'system') AS author FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
    WHERE v.document_id = $1 ORDER BY v.version DESC`, [o.document_id]);
  res.json({ ...o, versions: v.rows, margin_pln: Math.round((o.total_pln - o.cost_pln) * 100) / 100 });
}));
r.post('/oferty/kalkulacja', use, wrap(async (req, res) => res.json(await offers.calculate(req.body || {}))));
r.post('/oferty', use, wrap(async (req, res) => res.status(201).json(await offers.create(req.body || {}, { user: req.user, req }))));
r.patch('/oferty/:id', idParam, use, wrap(async (req, res) => res.json(await offers.update(req.params.id, req.body || {}, { user: req.user, req }))));
r.post('/oferty/:id/wyslij', idParam, use, wrap(async (req, res) => res.status(201).json(await offers.requestSend(req.params.id, req.user, req))));
r.post('/oferty/:id/wynik', idParam, use, wrap(async (req, res) => res.json(await offers.outcome(req.params.id, (req.body || {}).przyjeta === true, { user: req.user, req }))));
r.get('/oferty/:id/pdf', idParam, use, wrap(async (req, res) => {
  const o = (await pool.query('SELECT document_id, number FROM offers WHERE id = $1', [req.params.id])).rows[0];
  if (!o) throw bad(404, 'Nie znaleziono oferty.');
  const v = await docs.getVersion(o.document_id, parseInt(req.query.v, 10) || null);
  if (!v) throw bad(404, 'Nie znaleziono wersji.');
  sendPdf(res, await pdf.offer(JSON.parse(v.content)), `Oferta_${o.number}_v${v.version}.pdf`);
}));

// ======================= historia sprzedaży =======================
r.get('/sprzedaz', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT s.*, s.total::float AS total, s.total_pln::float AS total_pln, s.cost_pln::float AS cost_pln, c.name AS customer_name, c.country, o.number AS offer_number,
      (SELECT count(*)::int FROM complaints x WHERE x.sale_id = s.id) AS complaints, (SELECT count(*)::int FROM export_documents e WHERE e.sale_id = s.id) AS export_docs
    FROM sales_history s JOIN customers c ON c.id = s.customer_id LEFT JOIN offers o ON o.id = s.offer_id ORDER BY s.sale_date DESC, s.created_at DESC LIMIT 300`);
  res.json(q.rows);
}));
r.patch('/sprzedaz/:id', idParam, use, wrap(async (req, res) => {
  const q = await pool.query('UPDATE sales_history SET status = $2 WHERE id = $1 RETURNING *', [req.params.id, V.oneOf((req.body || {}).status, ['w_realizacji', 'zrealizowana', 'anulowana'], 'Status')]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono sprzedaży.');
  await audit(req, 'sprzedaz.zmiana', { resource: 'sales_history', resourceId: req.params.id, details: { status: q.rows[0].status } });
  res.json(q.rows[0]);
}));

// ======================= reklamacje (oba działy) =======================
const CPL_ST = ['zgloszona', 'w_analizie', 'w_naprawie', 'rozwiazana', 'odrzucona'];
r.get('/reklamacje', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`x.department_id = $${p.length}`); }
  if (req.query.otwarte === '1') w.push(`x.status NOT IN ('rozwiazana','odrzucona')`);
  const q = await pool.query(`SELECT x.*, c.name AS customer_name, b.name AS building_name, d.serial_no, i.number AS installation_number, s.number AS sale_number, u.login AS created_by_login
    FROM complaints x LEFT JOIN customers c ON c.id = x.customer_id LEFT JOIN buildings b ON b.id = x.building_id LEFT JOIN devices d ON d.id = x.device_id
    LEFT JOIN installations i ON i.id = x.installation_id LEFT JOIN sales_history s ON s.id = x.sale_id LEFT JOIN users u ON u.id = x.created_by
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY (x.status IN ('rozwiazana','odrzucona')), x.reported_at DESC LIMIT 300`, p);
  res.json(q.rows);
}));
r.post('/reklamacje', use, wrap(async (req, res) => {
  const b = req.body || {}, dep = V.oneOf(b.department_id, FIN_DEPTS, 'Dział');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let device = V.uuid(b.device_id), building = V.uuid(b.building_id), customer = V.uuid(b.customer_id), sale = V.uuid(b.sale_id);
    if (b.serial_no && !device) { const d = (await client.query('SELECT id, building_id FROM devices WHERE serial_no = $1', [String(b.serial_no).trim()])).rows[0]; if (!d) throw bad(400, 'Nie znaleziono urządzenia o tym numerze seryjnym.'); device = d.id; building = building || d.building_id; }
    if (building && !customer) customer = ((await client.query('SELECT customer_id FROM buildings WHERE id = $1', [building])).rows[0] || {}).customer_id || null;
    if (sale && !customer) customer = ((await client.query('SELECT customer_id FROM sales_history WHERE id = $1', [sale])).rows[0] || {}).customer_id || null;
    const number = await docs.nextNumber(client, 'RK');
    const q = await client.query(`INSERT INTO complaints (number, department_id, customer_id, building_id, device_id, installation_id, sale_id, title, description, reported_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::date, current_date),$11) RETURNING *`,
      [number, dep, customer, building, device, V.uuid(b.installation_id), sale, V.str(b.title, 200, true, 'Tytuł'), V.str(b.description, 5000), V.date(b.reported_at), req.user.id]);
    if (device && b.mark_faulty) await client.query(`UPDATE devices SET status = 'wadliwe' WHERE id = $1`, [device]);
    await audit(req, 'reklamacja.zgloszenie', { resource: 'complaints', resourceId: q.rows[0].id, details: { numer: number }, client });
    await client.query('COMMIT');
    const ctx = (await pool.query(`SELECT c.name AS klient, b.name AS budynek FROM complaints x LEFT JOIN customers c ON c.id = x.customer_id LEFT JOIN buildings b ON b.id = x.building_id WHERE x.id = $1`, [q.rows[0].id])).rows[0] || {};
    require('../lib/events').emit('reklamacja.zgloszona', { numer: number, tytul: q.rows[0].title, dzial: dep, klient: ctx.klient || '', budynek: ctx.budynek || '' });
    res.status(201).json(q.rows[0]);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.patch('/reklamacje/:id', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.status !== undefined) { f.status = V.oneOf(b.status, CPL_ST, 'Status'); f.resolved_at = ['rozwiazana', 'odrzucona'].includes(f.status) ? new Date().toISOString().slice(0, 10) : null; }
  if (b.resolution !== undefined) f.resolution = V.str(b.resolution, 5000);
  if (b.description !== undefined) f.description = V.str(b.description, 5000);
  const { sql, params } = patchSql('complaints', req.params.id, f);
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono reklamacji.');
  await audit(req, 'reklamacja.zmiana', { resource: 'complaints', resourceId: req.params.id, details: { status: q.rows[0].status } });
  res.json(q.rows[0]);
}));

// ======================= dokumenty eksportowe i celne =======================
r.get('/eksport', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT e.id, e.number, e.kind, e.incoterms, e.destination_country, e.created_at, e.document_id, c.name AS customer_name, s.number AS sale_number,
      o.number AS offer_number, d.current_version, u.login AS created_by_login FROM export_documents e JOIN customers c ON c.id = e.customer_id
    LEFT JOIN sales_history s ON s.id = e.sale_id LEFT JOIN offers o ON o.id = e.offer_id JOIN documents d ON d.id = e.document_id LEFT JOIN users u ON u.id = e.created_by
    ORDER BY e.created_at DESC LIMIT 200`);
  res.json(q.rows);
}));
r.post('/eksport', use, wrap(async (req, res) => {
  const b = req.body || {}, kind = V.oneOf(b.kind, Object.keys(pdf.EXPORT_TITLES), 'Rodzaj dokumentu');
  const saleId = V.uuid(b.sale_id), offerId = V.uuid(b.offer_id);
  if (!saleId && !offerId) throw bad(400, 'Wybierz sprzedaż lub ofertę, z której powstanie dokument.');
  const src = saleId
    ? (await pool.query(`SELECT s.id AS sale_id, s.offer_id, s.number AS ref, s.items, s.total::float AS total, s.currency, s.customer_id FROM sales_history s WHERE s.id = $1`, [saleId])).rows[0]
    : (await pool.query(`SELECT NULL::uuid AS sale_id, o.id AS offer_id, o.number AS ref, o.items, o.total::float AS total, o.currency, o.customer_id FROM offers o WHERE o.id = $1`, [offerId])).rows[0];
  if (!src) throw bad(404, 'Nie znaleziono dokumentu źródłowego.');
  const c = (await pool.query('SELECT * FROM customers WHERE id = $1', [src.customer_id])).rows[0];
  const incoterms = V.oneOf(b.incoterms || 'EXW', ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'], 'Incoterms');
  const dest = (V.str(b.destination_country, 2) || c.country || '').toUpperCase();
  if (kind === 'dane_celne' && src.items.some(x => !x.kod_hs)) throw bad(400, 'Dane celne wymagają kodów HS przy wszystkich pozycjach. Uzupełnij je w ofercie.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await docs.nextNumber(client, { faktura_eksportowa: 'FE', specyfikacja_wysylkowa: 'PL', dane_celne: 'DC' }[kind]);
    const data = { kind, number, date: new Date().toISOString().slice(0, 10), customer: c.name, customer_address: c.address, customer_tax: c.tax_id, destination_country: dest, incoterms,
      reference: src.ref, items: src.items, total: src.total, currency: src.currency, notes: V.str(b.notes, 2000) };
    const file = await pdf.exportDoc(data);
    const doc = await docs.createDocument(client, { kind: 'eksport', title: `${pdf.EXPORT_TITLES[kind]} ${number}`, department_id: 'sprzedaz-czesci-i-eksport', related_type: 'export', userId: req.user.id });
    await docs.addVersion(client, doc.id, { content: data, file, fileName: number.replace(/\//g, '-') + '.pdf', mime: 'application/pdf', note: 'Wygenerowano', userId: req.user.id });
    const e = (await client.query(`INSERT INTO export_documents (number, kind, sale_id, offer_id, customer_id, document_id, incoterms, destination_country, data, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [number, kind, src.sale_id, src.offer_id, c.id, doc.id, incoterms, dest, JSON.stringify(data), req.user.id])).rows[0];
    await client.query('UPDATE documents SET related_id = $2 WHERE id = $1', [doc.id, e.id]);
    await audit(req, 'eksport.dokument', { resource: 'export_documents', resourceId: e.id, details: { numer: number, rodzaj: kind }, client });
    await client.query('COMMIT');
    res.status(201).json(e);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

// ======================= Knowledge Base i pliki =======================
r.get('/wiedza', use, wrap(async (req, res) => {
  const p = [], w = [`d.kind IN ('wiedza', 'procedura')`];
  if (req.query.q) { p.push(String(req.query.q).slice(0, 100)); w.push(`(d.title ILIKE '%' || $${p.length} || '%' OR to_tsvector('simple', v.content) @@ plainto_tsquery('simple', $${p.length}))`); }
  if (DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`d.department_id = $${p.length}`); }
  const q = await pool.query(`SELECT d.id, d.kind, d.title, d.department_id, d.current_version, d.tags, d.for_agents, d.updated_at, left(v.content, 300) AS excerpt, v.file_name, u.login AS updated_by
    FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version LEFT JOIN users u ON u.id = v.created_by
    WHERE ${w.join(' AND ')} ORDER BY d.updated_at DESC LIMIT 200`, p);
  res.json(q.rows);
}));
r.get('/wiedza/:id', idParam, use, wrap(async (req, res) => {
  const d = (await pool.query('SELECT * FROM documents WHERE id = $1', [req.params.id])).rows[0];
  if (!d) throw bad(404, 'Nie znaleziono dokumentu.');
  const v = await pool.query(`SELECT v.version, v.content, v.file_name, v.file_size, v.note, v.created_at, coalesce(u.login, v.created_by_agent, 'system') AS author
    FROM document_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.document_id = $1 ORDER BY v.version DESC`, [d.id]);
  res.json({ ...d, versions: v.rows });
}));
async function kbSave(req, docId) {
  const b = req.body || {};
  if (b.for_agents && !can(req.user, 'approvals.decide')) throw bad(403, 'Dokumenty dostępne dla agentów AI publikuje administrator.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let id = docId;
    if (!id) id = (await docs.createDocument(client, { kind: V.oneOf(b.kind || 'wiedza', ['wiedza', 'procedura'], 'Rodzaj'), title: V.str(b.title, 300, true, 'Tytuł'),
      department_id: b.department_id && DEPTS.includes(b.department_id) ? b.department_id : null, for_agents: !!b.for_agents,
      tags: (Array.isArray(b.tags) ? b.tags : []).map(t => V.str(t, 40)).filter(Boolean).slice(0, 10), userId: req.user.id })).id;
    else {
      const d = (await client.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!d || !['wiedza', 'procedura'].includes(d.kind)) throw bad(404, 'Nie znaleziono dokumentu.');
      if (d.for_agents && !can(req.user, 'approvals.decide')) throw bad(403, 'Dokument dostępny dla agentów AI zmienia administrator.');
      if (b.title !== undefined) await client.query('UPDATE documents SET title = $2 WHERE id = $1', [id, V.str(b.title, 300, true, 'Tytuł')]);
      if (b.for_agents !== undefined) await client.query('UPDATE documents SET for_agents = $2 WHERE id = $1', [id, !!b.for_agents]);
    }
    let file = null;
    if (b.file_base64) { file = Buffer.from(String(b.file_base64), 'base64'); if (!docs.isPdf(file)) throw bad(400, 'Załącznik musi być plikiem PDF.'); }
    const v = await docs.addVersion(client, id, { content: V.str(b.content, 200000), file, fileName: file ? V.str(b.file_name, 200) || 'dokument.pdf' : null, mime: file ? 'application/pdf' : null, note: V.str(b.note, 300), userId: req.user.id });
    await audit(req, docId ? 'wiedza.nowa_wersja' : 'wiedza.utworzenie', { resource: 'documents', resourceId: id, details: { wersja: v }, client });
    await client.query('COMMIT');
    return { id, version: v };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}
r.post('/wiedza', use, wrap(async (req, res) => res.status(201).json(await kbSave(req, null))));
r.post('/wiedza/:id/wersja', idParam, use, wrap(async (req, res) => res.status(201).json(await kbSave(req, req.params.id))));

// Plik dowolnego dokumentu (PDF) – podgląd w przeglądarce.
r.get('/dokumenty/:id/plik', idParam, use, wrap(async (req, res) => {
  const v = await docs.getVersion(req.params.id, parseInt(req.query.v, 10) || null);
  if (!v || !v.file_data) throw bad(404, 'Ten dokument nie ma pliku PDF.');
  sendPdf(res, v.file_data, v.file_name || 'dokument.pdf', req.query.pobierz !== '1');
}));

module.exports = { router: r, financeSummary };
