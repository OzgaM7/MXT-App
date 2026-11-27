'use strict';
// Dział Ciepłomierze i podzielniki: wspólny rejestr zleceń (montaż, serwis, odczyt), rozliczanie po zleceniu,
// projekty (budżet, zespół, historia, koszty i przychody, protokół miesięczny), plany miesięczne i pulpit działu.
const express = require('express');
const { pool } = require('../../db');
const { audit } = require('../../lib/audit');
const { requirePerm } = require('../../lib/rbac');
const docs = require('../../lib/docs');
const pdf = require('../../lib/pdf');
const { tx, r2 } = require('../../lib/erp/stock');
const { wrap, bad, idParam, V, sendPdf, fresh } = require('../_util');
const { plToday } = require('../../lib/dzis');

const r = express.Router();
const view = requirePerm('departments.view'), money = requirePerm('finance.view'), mgr = requirePerm('employees.manage');
const DEP = 'podzielniki-i-montaze';
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;
const TYPES = { montaz: 'Montaż', serwis: 'Serwis', odczyt: 'Odczyt' };
const STATUSES = { nowe: 'Nowe', do_przydzielenia: 'Do przydzielenia', przydzielone: 'Przydzielone', zaplanowane: 'Zaplanowane', w_realizacji: 'W realizacji',
  wykonane: 'Wykonane', rozliczone: 'Rozliczone', zamkniete: 'Zamknięte', anulowane: 'Anulowane' };
const OPEN = `status NOT IN ('wykonane','rozliczone','zamkniete','anulowane')`;
const projEvent = (c, projectId, kind, text, userId) => projectId ? c.query('INSERT INTO project_events (project_id, kind, text, created_by) VALUES ($1, $2, $3, $4)', [projectId, kind, text, userId]) : null;

// ---------- wspólny rejestr zleceń ----------
r.get('/zlecenia', view, wrap(async (req, res) => {
  const p = [], w = [];
  const q = req.query;
  if (TYPES[q.typ]) { p.push(q.typ); w.push(`type = $${p.length}`); }
  if (STATUSES[q.status]) { p.push(q.status); w.push(`status = $${p.length}`); }
  else if (q.status === 'otwarte') w.push(OPEN);
  if (q.termin === 'po_terminie') w.push(`${OPEN} AND due_date < ${TODAY}`);
  else if (q.termin === '7dni') w.push(`${OPEN} AND due_date BETWEEN ${TODAY} AND ${TODAY} + 7`);
  else if (q.termin === 'miesiac') w.push(`date_trunc('month', coalesce(planned_date, due_date)) = date_trunc('month', ${TODAY}::timestamp)`);
  if (q.osoba) { p.push(V.uuid(q.osoba)); w.push(`(assignee_id = $${p.length} OR crew_id = $${p.length})`); }
  if (q.projekt) { p.push(V.uuid(q.projekt)); w.push(`project_id = $${p.length}`); }
  if (q.rozliczenie === 'do_rozliczenia') w.push(`status = 'wykonane'`);
  else if (q.rozliczenie === 'rozliczone') w.push(`settled_at IS NOT NULL`);
  if (q.q) { p.push('%' + String(q.q).trim().slice(0, 80).replace(/[\\%_]/g, m => '\\' + m) + '%'); w.push(`(number ILIKE $${p.length} OR object_name ILIKE $${p.length} OR address ILIKE $${p.length})`); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const [rows, sum] = await Promise.all([
    pool.query(`SELECT x.*, p.number AS project_number FROM (SELECT *, (${OPEN} AND due_date < ${TODAY}) AS overdue, (${OPEN}) AS is_open FROM work_orders ${where}) x
      LEFT JOIN projects p ON p.id = x.project_id ORDER BY x.is_open DESC, x.due_date NULLS LAST, x.number LIMIT 500`, p),
    pool.query(`SELECT type, status, count(*)::int n, count(*) FILTER (WHERE ${OPEN} AND due_date < ${TODAY})::int overdue FROM work_orders GROUP BY 1, 2`)
  ]);
  res.json({ rows: rows.rows, summary: sum.rows, types: TYPES, statuses: STATUSES });
}));

// Rozliczenie pojedynczego zlecenia: przychód w finansach (z fakturą) + oznaczenie zlecenia jako rozliczonego (serwis: status „rozliczone”).
const SETTLE = {
  montaz: { table: 'installations', ok: x => ['wykonany', 'odebrany'].includes(x.status), msg: 'Rozliczyć można montaż wykonany lub odebrany.', cat: 'montaz', fin: 'installation_id' },
  serwis: { table: 'service_orders', ok: x => ['wykonane', 'zatwierdzone'].includes(x.status), msg: 'Rozliczyć można serwis wykonany lub zatwierdzony.', cat: 'serwis', fin: 'service_order_id' },
  odczyt: { table: 'readings', ok: x => !x.cancelled_at, msg: 'Odczyt został cofnięty.', cat: 'odczyty', fin: 'reading_id' }
};
r.post('/zlecenia/rozlicz', money, wrap(async (req, res) => {
  const b = req.body || {}, t = SETTLE[b.typ];
  if (!t) throw bad(400, 'Typ zlecenia: nieprawidłowa wartość.');
  const id = V.uuid(b.id, 'Zlecenie', true), amount = r2(V.num(b.kwota, 0, 1e9, 'Kwota netto')), invoice = V.str(b.faktura, 60);
  const date = V.date(b.data, 'Data rozliczenia') || plToday();
  if (amount > 0 && !invoice) throw bad(400, 'Podaj numer faktury (albo kwotę 0 – zlecenie bez opłaty).');
  const out = await tx(async c => {
    const x = (await c.query(`SELECT * FROM ${t.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!x) throw bad(404, 'Nie znaleziono zlecenia.');
    if (x.settled_at) throw bad(409, 'Zlecenie jest już rozliczone.');
    if (!t.ok(x)) throw bad(409, t.msg);
    // Kontekst: projekt, klient, budynek (odczyt – z harmonogramu odczytów).
    let projectId = x.project_id || null, customerId = x.customer_id || null, buildingId = x.building_id || null, number = x.number;
    if (b.typ === 'montaz') customerId = (await c.query('SELECT customer_id FROM buildings WHERE id = $1', [buildingId])).rows[0].customer_id;
    if (b.typ === 'odczyt') {
      const s = (await c.query('SELECT s.*, b.customer_id AS bc FROM reading_schedules s JOIN buildings b ON b.id = s.building_id WHERE s.id = $1', [x.schedule_id])).rows[0];
      projectId = s.project_id; customerId = s.customer_id || s.bc; buildingId = s.building_id; number = 'odczyt ' + String(x.done_at).slice(0, 10);
    }
    let fin = null;
    if (amount > 0) {
      fin = (await c.query(`INSERT INTO finance (department_id, kind, category, description, amount, currency, rate_pln, amount_pln, entry_date, invoice_no, due_date,
          customer_id, project_id, building_id, ${t.fin}, created_by) VALUES ($1, 'przychod', $2, $3, $4, 'PLN', 1, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [DEP, t.cat, V.str(b.opis, 300) || `Rozliczenie: ${TYPES[b.typ].toLowerCase()} ${number}`, amount, date, invoice, V.date(b.termin_platnosci, 'Termin płatności'),
          customerId, projectId, buildingId, id, req.user.id])).rows[0];
    }
    await c.query(`UPDATE ${t.table} SET settled_at = now(), invoice_no = $2 WHERE id = $1`, [id, invoice]);
    if (b.typ === 'serwis') {
      await c.query(`UPDATE service_orders SET status = 'rozliczone', updated_at = now() WHERE id = $1`, [id]);
      await c.query(`INSERT INTO service_events (order_id, kind, from_status, to_status, note, created_by) VALUES ($1, 'status', $2, 'rozliczone', $3, $4)`,
        [id, x.status, amount > 0 ? `Faktura ${invoice}, ${amount.toFixed(2)} zł netto` : 'Bez opłaty', req.user.id]);
    }
    await projEvent(c, projectId, 'rozliczenie', `Rozliczono ${TYPES[b.typ].toLowerCase()} ${number}: ${amount.toFixed(2)} zł netto${invoice ? ', faktura ' + invoice : ''}`, req.user.id);
    return { id, finance_id: fin && fin.id, amount, invoice_no: invoice, number };
  });
  await audit(req, 'zlecenie.rozliczenie', { resource: SETTLE[b.typ].table, resourceId: id, details: { typ: b.typ, kwota: amount, faktura: invoice } });
  res.json(out);
}));
// Zamknięcie zlecenia serwisowego po rozliczeniu (albo bez opłaty po zatwierdzeniu) – koniec procesu.
r.post('/zlecenia/zamknij', money, wrap(async (req, res) => {
  const id = V.uuid((req.body || {}).id, 'Zlecenie', true);
  await tx(async c => {
    const o = (await c.query('SELECT * FROM service_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o) throw bad(404, 'Nie znaleziono zlecenia.');
    if (o.status !== 'rozliczone') throw bad(409, 'Zamknąć można zlecenie rozliczone.');
    await c.query(`UPDATE service_orders SET status = 'zamkniete', closed_at = now(), updated_at = now() WHERE id = $1`, [id]);
    await c.query(`INSERT INTO service_events (order_id, kind, from_status, to_status, created_by) VALUES ($1, 'status', 'rozliczone', 'zamkniete', $2)`, [id, req.user.id]);
  });
  await audit(req, 'serwis.zamkniecie', { resource: 'service_orders', resourceId: id });
  res.json({ ok: true });
}));
// Powiązanie zlecenia z projektem (serwis, montaż, harmonogram odczytów).
r.post('/zlecenia/projekt', view, wrap(async (req, res) => {
  const b = req.body || {}, table = { montaz: 'installations', serwis: 'service_orders', odczyt: 'reading_schedules' }[b.typ];
  if (!table) throw bad(400, 'Typ zlecenia: nieprawidłowa wartość.');
  const id = V.uuid(b.id, 'Zlecenie', true), pid = V.uuid(b.projekt, 'Projekt');
  await tx(async c => {
    if (pid && !(await c.query('SELECT 1 FROM projects WHERE id = $1', [pid])).rows[0]) throw bad(400, 'Nie znaleziono projektu.');
    const x = (await c.query(`UPDATE ${table} SET project_id = $2 WHERE id = $1 RETURNING *`, [id, pid])).rows[0];
    if (!x) throw bad(404, 'Nie znaleziono zlecenia.');
    await projEvent(c, pid, 'zlecenie', `Dodano ${TYPES[b.typ].toLowerCase()} ${x.number || ''} do projektu`, req.user.id);
  });
  await audit(req, 'zlecenie.projekt', { resource: table, resourceId: id, details: { projekt: pid } });
  res.json({ ok: true });
}));

// ---------- projekty ----------
const BUDGET_CATS = ['montaz', 'serwis', 'odczyty', 'materialy', 'robocizna', 'transport', 'podwykonawcy', 'inne'];
// Koszty i przychody projektu: przychody z finansów, koszty z księgi kosztów (finanse + materiały RW/ZW + robocizna).
async function projectMoney(c, ids) {
  const [rev, cost, bud] = await Promise.all([
    c.query(`SELECT project_id, category, sum(amount_pln)::float s FROM finance WHERE kind = 'przychod' AND project_id = ANY($1::uuid[]) GROUP BY 1, 2`, [ids]),
    c.query(`SELECT project_id, source, category, sum(amount)::float s FROM cost_ledger WHERE project_id = ANY($1::uuid[]) GROUP BY 1, 2, 3`, [ids]),
    c.query(`SELECT project_id, kind, category, amount::float a FROM project_budget WHERE project_id = ANY($1::uuid[])`, [ids])
  ]);
  const out = Object.fromEntries(ids.map(id => [id, { przychod: 0, koszt: 0, budzet_przychod: 0, budzet_koszt: 0, rev: {}, cost: {}, plan: {} }]));
  // Kategorie wpisów finansowych są tekstem dowolnym (np. „materiały”, „faktura”) – sprowadzone do kategorii budżetu, reszta = „inne”.
  const cat = c => { const s = String(c || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); return BUDGET_CATS.includes(s) ? s : 'inne'; };
  for (const x of rev.rows) { const o = out[x.project_id], k = cat(x.category); o.przychod += x.s; o.rev[k] = r2((o.rev[k] || 0) + x.s); }
  for (const x of cost.rows) {
    const o = out[x.project_id], k = x.source === 'magazyn' ? 'materialy' : x.source === 'czas' ? 'robocizna' : cat(x.category);
    o.koszt += x.s; o.cost[k] = r2((o.cost[k] || 0) + x.s);
  }
  for (const x of bud.rows) { const o = out[x.project_id]; if (x.kind === 'przychod') o.budzet_przychod += x.a; else o.budzet_koszt += x.a; o.plan[x.kind + ':' + x.category] = x.a; }
  for (const o of Object.values(out)) {
    o.przychod = r2(o.przychod); o.koszt = r2(o.koszt); o.marza = r2(o.przychod - o.koszt);
    o.marza_pct = o.przychod > 0 ? r2(o.marza / o.przychod * 100) : null;
    o.budzet_przychod = r2(o.budzet_przychod); o.budzet_koszt = r2(o.budzet_koszt);
    o.wykorzystanie_budzetu_pct = o.budzet_koszt > 0 ? r2(o.koszt / o.budzet_koszt * 100) : null;
  }
  return out;
}
r.get('/projekty', view, wrap(async (req, res) => {
  const p = [], w = [`p.department_id = '${DEP}'`];
  if (['oferta', 'w_realizacji', 'zakonczony', 'rozliczony', 'anulowany'].includes(req.query.status)) { p.push(req.query.status); w.push(`p.status = $${p.length}`); }
  const rows = (await pool.query(`SELECT p.*, c.name AS customer_name, u.login AS manager_login, coalesce(nullif(u.full_name, ''), u.login) AS manager_name,
      (SELECT count(*)::int FROM work_orders wo WHERE wo.project_id = p.id) AS orders,
      (SELECT count(*)::int FROM work_orders wo WHERE wo.project_id = p.id AND wo.status NOT IN ('wykonane','rozliczone','zamkniete','anulowane')) AS orders_open,
      (SELECT count(*)::int FROM project_members m WHERE m.project_id = p.id) AS members
    FROM projects p LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.manager_id WHERE ${w.join(' AND ')} ORDER BY p.status = 'w_realizacji' DESC, p.created_at DESC LIMIT 300`, p)).rows;
  const m = await projectMoney(pool, rows.map(x => x.id));
  res.json(rows.map(x => ({ ...x, money: m[x.id] })));
}));
r.get('/projekty/:id', idParam, view, wrap(async (req, res) => {
  const id = req.params.id;
  const p = (await pool.query(`SELECT p.*, c.name AS customer_name, coalesce(nullif(u.full_name, ''), u.login) AS manager_name FROM projects p
    LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.manager_id WHERE p.id = $1`, [id])).rows[0];
  if (!p) throw bad(404, 'Nie znaleziono projektu.');
  const [budget, members, events, orders, mats, time, fin, documents] = await Promise.all([
    pool.query('SELECT kind, category, amount::float AS amount, note FROM project_budget WHERE project_id = $1 ORDER BY kind, category', [id]),
    pool.query(`SELECT m.user_id, m.role, m.added_at, u.login, u.full_name, u.position, u.phone FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY u.full_name, u.login`, [id]),
    pool.query(`SELECT e.kind, e.text, e.created_at, u.login FROM project_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.project_id = $1 ORDER BY e.id DESC LIMIT 200`, [id]),
    pool.query(`SELECT * FROM work_orders WHERE project_id = $1 ORDER BY coalesce(planned_date, due_date) NULLS LAST LIMIT 500`, [id]),
    pool.query(`SELECT d.id, d.number, d.kind, d.doc_date, d.total_value::float AS total_value, d.related_type, d.related_id FROM stock_docs d
      WHERE d.project_id = $1 AND d.kind IN ('RW', 'ZW') AND d.status = 'zatwierdzony' ORDER BY d.doc_date DESC, d.created_at DESC`, [id]),
    pool.query(`SELECT t.user_id, coalesce(nullif(u.full_name, ''), u.login) AS name, sum(t.hours)::float AS hours, sum(t.cost)::float AS cost FROM time_entries t JOIN users u ON u.id = t.user_id
      WHERE t.project_id = $1 GROUP BY 1, 2 ORDER BY 3 DESC`, [id]),
    pool.query(`SELECT id, kind, category, description, amount_pln::float AS amount, entry_date, invoice_no, due_date, paid_at FROM finance WHERE project_id = $1 ORDER BY entry_date DESC LIMIT 300`, [id]),
    pool.query(`SELECT id, kind, title, current_version, created_at FROM documents WHERE related_type = 'project' AND related_id = $1 ORDER BY created_at DESC`, [id])
  ]);
  res.json({ ...p, money: (await projectMoney(pool, [id]))[id], budget: budget.rows, members: members.rows, events: events.rows, orders: orders.rows,
    materials: mats.rows, time: time.rows, finance: fin.rows, documents: documents.rows });
}));
r.patch('/projekty/:id', idParam, view, fresh('projects'), wrap(async (req, res) => {
  const b = req.body || {}, o = {};
  if (b.manager_id !== undefined) o.manager_id = V.uuid(b.manager_id, 'Kierownik projektu');
  if (b.billing !== undefined) o.billing = V.oneOf(b.billing, ['po_zleceniu', 'miesiecznie', 'ryczalt'], 'Sposób rozliczania');
  if (b.status !== undefined) o.status = V.oneOf(b.status, ['oferta', 'w_realizacji', 'zakonczony', 'rozliczony', 'anulowany'], 'Status');
  if (b.start_date !== undefined) o.start_date = V.date(b.start_date, 'Początek');
  if (b.end_date !== undefined) o.end_date = V.date(b.end_date, 'Koniec');
  if (b.value_net !== undefined) o.value_net = r2(V.num(b.value_net, 0, 1e10, 'Wartość netto'));
  if (b.title !== undefined) o.title = V.str(b.title, 200, true, 'Nazwa');
  const k = Object.keys(o);
  if (!k.length) throw bad(400, 'Brak zmian.');
  const x = await tx(async c => {
    const before = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw bad(404, 'Nie znaleziono projektu.');
    const row = (await c.query(`UPDATE projects SET ${k.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, ...k.map(f => o[f])])).rows[0];
    const changes = k.filter(f => String(before[f] ?? '') !== String(row[f] ?? '')).map(f => f === 'status' ? `status: ${before.status} → ${row.status}` : f === 'manager_id' ? 'zmiana kierownika projektu' : `${f}`);
    if (changes.length) await projEvent(c, row.id, 'zmiana', 'Zmiana danych projektu: ' + changes.join(', '), req.user.id);
    return row;
  });
  await audit(req, 'projekt.zmiana', { resource: 'projects', resourceId: x.id, details: { pola: k } });
  res.json(x);
}));
r.put('/projekty/:id/budzet', idParam, money, wrap(async (req, res) => {
  const lines = Array.isArray((req.body || {}).lines) ? req.body.lines.slice(0, 40) : null;
  if (!lines) throw bad(400, 'Brak pozycji budżetu.');
  const clean = lines.map(l => ({ kind: V.oneOf(l.kind, ['przychod', 'koszt'], 'Rodzaj'), category: V.oneOf(l.category, BUDGET_CATS, 'Kategoria'), amount: r2(V.num(l.amount, 0, 1e10, 'Kwota')), note: V.str(l.note, 300) }));
  const seen = new Set(); for (const l of clean) { const k = l.kind + l.category; if (seen.has(k)) throw bad(400, 'Każda kategoria budżetu tylko raz.'); seen.add(k); }
  await tx(async c => {
    if (!(await c.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0]) throw bad(404, 'Nie znaleziono projektu.');
    await c.query('DELETE FROM project_budget WHERE project_id = $1', [req.params.id]);
    for (const l of clean.filter(l => l.amount > 0)) await c.query('INSERT INTO project_budget (project_id, kind, category, amount, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [req.params.id, l.kind, l.category, l.amount, l.note, req.user.id]);
    const sum = k => r2(clean.filter(l => l.kind === k).reduce((s, l) => s + l.amount, 0));
    await projEvent(c, req.params.id, 'budzet', `Budżet: przychody ${sum('przychod').toFixed(2)} zł, koszty ${sum('koszt').toFixed(2)} zł`, req.user.id);
  });
  await audit(req, 'projekt.budzet', { resource: 'projects', resourceId: req.params.id });
  res.json((await projectMoney(pool, [req.params.id]))[req.params.id]);
}));
r.post('/projekty/:id/zespol', idParam, view, wrap(async (req, res) => {
  const b = req.body || {}, uid = V.uuid(b.user_id, 'Pracownik', true), role = V.str(b.role, 100);
  await tx(async c => {
    const u = (await c.query('SELECT login, full_name, is_active FROM users WHERE id = $1', [uid])).rows[0];
    if (!u || !u.is_active) throw bad(400, 'Wybierz aktywne konto pracownika.');
    if (!(await c.query('SELECT 1 FROM projects WHERE id = $1', [req.params.id])).rows[0]) throw bad(404, 'Nie znaleziono projektu.');
    await c.query(`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`, [req.params.id, uid, role, req.user.id]);
    await projEvent(c, req.params.id, 'zespol', `Zespół: ${u.full_name || u.login}${role ? ' – ' + role : ''}`, req.user.id);
  });
  await require('../../lib/notify').notify([uid], { kind: 'projekt', title: 'Przydzielono Cię do projektu', body: role || '', link: `/dzial/${DEP}?tab=projekty&k=${req.params.id}`, related_type: 'project', related_id: req.params.id, dedup: 'projekt-zespol:' + req.params.id + ':' + uid });
  await audit(req, 'projekt.zespol', { resource: 'projects', resourceId: req.params.id, details: { pracownik: uid } });
  res.status(201).json({ ok: true });
}));
r.delete('/projekty/:id/zespol/:uid', idParam, view, wrap(async (req, res) => {
  const uid = V.uuid(req.params.uid, 'Pracownik', true);
  await tx(async c => {
    const q = await c.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING user_id', [req.params.id, uid]);
    if (!q.rows[0]) throw bad(404, 'Pracownik nie jest w zespole projektu.');
    const u = (await c.query('SELECT login, full_name FROM users WHERE id = $1', [uid])).rows[0];
    await projEvent(c, req.params.id, 'zespol', `Usunięto z zespołu: ${u.full_name || u.login}`, req.user.id);
  });
  res.json({ ok: true });
}));
r.post('/projekty/:id/notatka', idParam, view, wrap(async (req, res) => {
  const text = V.str((req.body || {}).text, 2000, true, 'Treść');
  if (!(await pool.query('SELECT 1 FROM projects WHERE id = $1', [req.params.id])).rows[0]) throw bad(404, 'Nie znaleziono projektu.');
  await projEvent(pool, req.params.id, 'notatka', text, req.user.id);
  res.status(201).json({ ok: true });
}));

// Protokół miesięczny wykonanych prac w projekcie (PDF zapisany jako dokument projektu z wersjami).
r.post('/projekty/:id/protokol-miesieczny', idParam, view, wrap(async (req, res) => {
  const m = String((req.body || {}).miesiac || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad(400, 'Miesiąc: format RRRR-MM.');
  const from = m + '-01';
  const out = await tx(async c => {
    const p = (await c.query(`SELECT p.*, c.name AS customer_name, c.address AS customer_address FROM projects p LEFT JOIN customers c ON c.id = p.customer_id WHERE p.id = $1 FOR UPDATE OF p`, [req.params.id])).rows[0];
    if (!p) throw bad(404, 'Nie znaleziono projektu.');
    const range = [from, `(date '${from}' + interval '1 month')::date`];
    const inst = (await c.query(`SELECT x.number, x.planned_date, coalesce(x.planned_end, x.planned_date) AS end_date, x.status, coalesce(nullif(x.site_name, ''), b.name) AS name, coalesce(nullif(replace(x.addresses, E'\n', '; '), ''), b.address) AS address,
        (SELECT count(*)::int FROM devices d WHERE d.installation_id = x.id) AS devices FROM installations x LEFT JOIN buildings b ON b.id = x.building_id
      WHERE x.project_id = $1 AND x.status IN ('wykonany', 'odebrany') AND coalesce(x.accepted_at::date, x.planned_end, x.planned_date) >= $2::date
        AND coalesce(x.accepted_at::date, x.planned_end, x.planned_date) < ${range[1]} ORDER BY x.planned_date`, [p.id, from])).rows;
    const srv = (await c.query(`SELECT o.number, o.completed_at::date AS done, o.address, o.unit, o.description FROM service_orders o
      WHERE o.project_id = $1 AND o.status IN ('wykonane', 'zatwierdzone', 'rozliczone', 'zamkniete') AND o.completed_at >= $2::date AND o.completed_at < ${range[1]} ORDER BY o.completed_at`, [p.id, from])).rows;
    const rd = (await c.query(`SELECT r.done_at, r.result, r.missing_units, b.name FROM readings r JOIN reading_schedules s ON s.id = r.schedule_id JOIN buildings b ON b.id = s.building_id
      WHERE s.project_id = $1 AND r.cancelled_at IS NULL AND r.done_at >= $2::date AND r.done_at < ${range[1]} ORDER BY r.done_at`, [p.id, from])).rows;
    const mats = (await c.query(`SELECT i.name, i.unit, sum(-m.qty)::float AS qty, sum(-m.value)::float AS value FROM stock_moves m JOIN stock_docs d ON d.id = m.doc_id JOIN stock_items i ON i.id = m.item_id
      WHERE d.project_id = $1 AND d.kind IN ('RW', 'ZW') AND d.status = 'zatwierdzony' AND d.doc_date >= $2::date AND d.doc_date < ${range[1]} GROUP BY 1, 2 HAVING sum(-m.qty) <> 0 ORDER BY 1`, [p.id, from])).rows;
    const hours = (await c.query(`SELECT coalesce(sum(hours), 0)::float h FROM time_entries WHERE project_id = $1 AND work_date >= $2::date AND work_date < ${range[1]}`, [p.id, from])).rows[0].h;
    const number = await docs.nextNumber(c, 'PM');
    const MON = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
    const label = MON[Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4);
    const d = (s) => s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('pl-PL') : '–';
    const file = await pdf.report({ title: 'Protokół miesięczny wykonanych prac', number, date: plToday(), dept: DEP,
      left: [['Zleceniodawca', `${p.customer_name || '–'}${p.customer_address ? '\n' + p.customer_address : ''}`], ['Projekt', `${p.number} – ${p.title}`]],
      right: [['Okres', label], ['Podsumowanie', `montaże: ${inst.length}, urządzenia: ${inst.reduce((s, x) => s + x.devices, 0)}, serwisy: ${srv.length}, odczyty: ${rd.length}, godziny pracy: ${hours}`]],
      sections: [
        { heading: `Montaże wykonane (${inst.length})`, cols: [{ t: 'Zlecenie', w: .18 }, { t: 'Budynek', w: .37 }, { t: 'Termin', w: .25 }, { t: 'Urządzenia', w: .2, align: 'right' }],
          rows: inst.map(x => [x.number, `${x.name}\n${x.address}`, `${d(x.planned_date)} – ${d(x.end_date)}`, x.devices]), empty: 'Brak montaży w okresie.' },
        { heading: `Serwisy wykonane (${srv.length})`, cols: [{ t: 'Zlecenie', w: .18 }, { t: 'Data', w: .14 }, { t: 'Adres', w: .3 }, { t: 'Opis', w: .38 }],
          rows: srv.map(x => [x.number, d(x.done), x.address + (x.unit ? ' lok. ' + x.unit : ''), x.description]), empty: 'Brak serwisów w okresie.' },
        { heading: `Odczyty wykonane (${rd.length})`, cols: [{ t: 'Budynek', w: .45 }, { t: 'Data', w: .2 }, { t: 'Wynik', w: .35 }],
          rows: rd.map(x => [x.name, d(x.done_at), x.result === 'pelny' ? 'pełny' : `częściowy (bez odczytu: ${x.missing_units} lok.)`]), empty: 'Brak odczytów w okresie.' },
        { heading: 'Zużyte materiały', cols: [{ t: 'Materiał', w: .6 }, { t: 'Ilość', w: .2, align: 'right' }, { t: 'J.m.', w: .2 }], rows: mats.map(x => [x.name, String(x.qty).replace('.', ','), x.unit]), empty: 'Brak wydań materiałów.' }
      ],
      signatures: ['Przedstawiciel MXT', 'Przedstawiciel zleceniodawcy'] });
    const doc = await docs.createDocument(c, { kind: 'protokol', title: `Protokół miesięczny ${number} – ${p.number} – ${label}`, department_id: DEP, related_type: 'project', related_id: p.id, userId: req.user.id });
    await docs.addVersion(c, doc.id, { content: { miesiac: m, montaze: inst.length, serwisy: srv.length, odczyty: rd.length }, file, fileName: number.replace(/\//g, '-') + '.pdf', mime: 'application/pdf', note: 'Protokół miesięczny', userId: req.user.id });
    await projEvent(c, p.id, 'protokol', `Protokół miesięczny ${number} (${label})`, req.user.id);
    return { document_id: doc.id, number };
  });
  await audit(req, 'projekt.protokol_miesieczny', { resource: 'projects', resourceId: req.params.id, details: { miesiac: m, protokol: out.number } });
  res.status(201).json(out);
}));

// ---------- plany miesięczne ----------
const METRICS = { montaze: 'Montaże wykonane', urzadzenia: 'Urządzenia zamontowane', serwisy: 'Serwisy wykonane', odczyty: 'Odczyty wykonane', przychod: 'Przychód działu (zł netto)' };
const monthOf = v => { const s = String(v || '').slice(0, 7); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw bad(400, 'Miesiąc: format RRRR-MM.'); return s + '-01'; };
async function actuals(month) {
  const q = await pool.query(`WITH m AS (SELECT $1::date AS a, ($1::date + interval '1 month')::date AS b) SELECT
      (SELECT count(*)::int FROM installations x, m WHERE x.status IN ('wykonany','odebrany') AND coalesce(x.accepted_at::date, x.planned_end, x.planned_date) >= m.a AND coalesce(x.accepted_at::date, x.planned_end, x.planned_date) < m.b) AS montaze,
      (SELECT count(*)::int FROM devices d, m WHERE d.installed_at >= m.a AND d.installed_at < m.b) AS urzadzenia,
      (SELECT count(*)::int FROM service_orders o, m WHERE o.status IN ('wykonane','zatwierdzone','rozliczone','zamkniete') AND o.completed_at >= m.a AND o.completed_at < m.b) AS serwisy,
      (SELECT count(*)::int FROM readings r, m WHERE r.cancelled_at IS NULL AND r.done_at >= m.a AND r.done_at < m.b) AS odczyty,
      (SELECT coalesce(sum(amount_pln), 0)::float FROM finance f, m WHERE f.department_id = '${DEP}' AND f.kind = 'przychod' AND f.entry_date >= m.a AND f.entry_date < m.b) AS przychod`, [month]);
  return q.rows[0];
}
r.get('/plany', view, wrap(async (req, res) => {
  const month = monthOf(req.query.miesiac || new Date().toISOString().slice(0, 7));
  const [t, a] = await Promise.all([pool.query('SELECT metric, target::float AS target FROM monthly_plans WHERE month = $1', [month]), actuals(month)]);
  const targets = Object.fromEntries(t.rows.map(x => [x.metric, x.target]));
  res.json({ month, metrics: Object.entries(METRICS).map(([k, label]) => ({ key: k, label, target: targets[k] ?? null, actual: a[k],
    pct: targets[k] > 0 ? r2(a[k] / targets[k] * 100) : null })) });
}));
r.put('/plany', mgr, wrap(async (req, res) => {
  const b = req.body || {}, month = monthOf(b.miesiac), t = b.cele && typeof b.cele === 'object' ? b.cele : {};
  await tx(async c => {
    for (const k of Object.keys(METRICS)) {
      if (t[k] === undefined) continue;
      if (t[k] === null || t[k] === '') await c.query('DELETE FROM monthly_plans WHERE month = $1 AND metric = $2', [month, k]);
      else await c.query(`INSERT INTO monthly_plans (month, metric, target, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT (month, metric) DO UPDATE SET target = excluded.target, updated_by = excluded.updated_by, updated_at = now()`,
        [month, k, r2(V.num(t[k], 0, 1e10, METRICS[k])), req.user.id]);
    }
  });
  await audit(req, 'plan.miesieczny', { resource: 'monthly_plans', details: { miesiac: month } });
  res.json({ ok: true });
}));

// ---------- pulpit działu: wartości wyłącznie z danych systemu ----------
r.get('/pulpit', view, wrap(async (req, res) => {
  const month = monthOf(req.query.miesiac || new Date().toISOString().slice(0, 7));
  const [k, load, mat, fin, top, plan] = await Promise.all([
    pool.query(`SELECT
        (SELECT count(*)::int FROM projects WHERE department_id = '${DEP}' AND status = 'w_realizacji') AS projekty_aktywne,
        (SELECT count(*)::int FROM service_orders WHERE status NOT IN ('wykonane','zatwierdzone','rozliczone','zamkniete','anulowane')) AS serwisy_otwarte,
        (SELECT count(*)::int FROM reading_schedules WHERE is_active AND next_due >= $1::date AND next_due < ($1::date + interval '1 month')) AS odczyty_zaplanowane,
        (SELECT count(*)::int FROM readings WHERE cancelled_at IS NULL AND done_at >= $1::date AND done_at < ($1::date + interval '1 month')) AS odczyty_wykonane,
        (SELECT count(*)::int FROM work_orders WHERE ${OPEN} AND due_date < ${TODAY}) AS po_terminie,
        (SELECT count(*)::int FROM work_orders WHERE ${OPEN} AND due_date BETWEEN ${TODAY} AND ${TODAY} + 3) AS zagrozone,
        (SELECT count(*)::int FROM work_orders WHERE ${OPEN} AND status IN ('nowe','do_przydzielenia')) AS bez_przydzialu,
        (SELECT count(*)::int FROM work_orders WHERE status = 'wykonane') AS do_rozliczenia`, [month]),
    pool.query(`SELECT coalesce(nullif(u.full_name, ''), u.login) AS name, u.id,
        (SELECT count(*)::int FROM service_orders o WHERE o.assigned_to = u.id AND o.status IN ('przypisane','zaplanowane','w_realizacji','ponowna_wizyta')) AS serwisy,
        (SELECT count(*)::int FROM reading_schedules s WHERE s.assigned_to = u.id AND s.is_active AND s.next_due < $1::date + interval '1 month') AS odczyty,
        (SELECT coalesce(sum(hours), 0)::float FROM time_entries t WHERE t.user_id = u.id AND t.work_date >= $1::date AND t.work_date < $1::date + interval '1 month') AS godziny,
        EXISTS (SELECT 1 FROM absences a WHERE a.user_id = u.id AND ${TODAY} BETWEEN a.date_from AND a.date_to) AS nieobecny
      FROM users u WHERE u.is_active AND (u.role IN ('serwisant','monter','odczyty','kierownik') OR u.extra_roles && '{serwisant,monter,odczyty}') ORDER BY 3 DESC, 4 DESC, 1 LIMIT 30`, [month]),
    pool.query(`SELECT coalesce(sum(-m.value) FILTER (WHERE d.kind IN ('RW','ZW')), 0)::float AS zuzycie, count(DISTINCT d.id) FILTER (WHERE d.kind = 'RW')::int AS wydania
      FROM stock_moves m JOIN stock_docs d ON d.id = m.doc_id WHERE d.status = 'zatwierdzony' AND d.doc_date >= $1::date AND d.doc_date < $1::date + interval '1 month'`, [month]),
    pool.query(`SELECT (SELECT coalesce(sum(amount_pln), 0)::float FROM finance WHERE department_id = '${DEP}' AND kind = 'przychod' AND entry_date >= $1::date AND entry_date < $1::date + interval '1 month') AS przychod,
        (SELECT coalesce(sum(amount), 0)::float FROM cost_ledger WHERE department_id = '${DEP}' AND cost_date >= $1::date AND cost_date < $1::date + interval '1 month') AS koszt`, [month]),
    pool.query(`SELECT id, number, title FROM projects WHERE department_id = '${DEP}' AND status IN ('w_realizacji','zakonczony','rozliczony') ORDER BY created_at DESC LIMIT 50`),
    actuals(month)
  ]);
  const money = await projectMoney(pool, top.rows.map(x => x.id));
  const projects = top.rows.map(x => ({ ...x, ...money[x.id] })).sort((a, b) => b.przychod + b.koszt - (a.przychod + a.koszt)).slice(0, 8);
  const targets = Object.fromEntries((await pool.query('SELECT metric, target::float t FROM monthly_plans WHERE month = $1', [month])).rows.map(x => [x.metric, x.t]));
  const f = fin.rows[0];
  res.json({ month, kpi: k.rows[0], load: load.rows, materials: mat.rows[0], finance: { ...f, wynik: r2(f.przychod - f.koszt), marza_pct: f.przychod > 0 ? r2((f.przychod - f.koszt) / f.przychod * 100) : null },
    projects, plan: Object.entries(METRICS).map(([key, label]) => ({ key, label, target: targets[key] ?? null, actual: plan[key], pct: targets[key] > 0 ? r2(plan[key] / targets[key] * 100) : null })) });
}));

module.exports = r;
