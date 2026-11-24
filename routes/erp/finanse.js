'use strict';
// Zakupy (zamówienia do dostawców, przyjęcia PZ częściowe, propozycje zamówień z minimów) i finanse firmy:
// należności (wiekowanie), zobowiązania (faktury dostawców z PZ i koszty z terminem), wyniki działów (przychody, koszty z księgi
// kosztów, wynik; Ubezpieczenia = zysk z polis, bez kwot polis), przepływy pieniężne, eksport dla księgowości, status integracji.
const express = require('express');
const { pool } = require('../../db');
const { audit } = require('../../lib/audit');
const { requirePerm } = require('../../lib/rbac');
const docs = require('../../lib/docs');
const xlsx = require('../../lib/xlsx');
const S = require('../../lib/erp/stock');
const { wrap, bad, idParam, V } = require('../_util');

const r = express.Router();
const buy = requirePerm('purchases.manage'), fin = requirePerm('finance.view');
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;
const { tx, r2, r3 } = S;
const DEPTS = { 'podzielniki-i-montaze': 'Ciepłomierze i podzielniki', 'sprzedaz-czesci-i-eksport': 'Sprzedaż części samochodowych', ubezpieczenia: 'Ubezpieczenia', '': 'Wspólne (ogólne)' };
const PO_ST = { szkic: 'Szkic', zamowione: 'Zamówione', czesciowo: 'Przyjęte częściowo', przyjete: 'Przyjęte', anulowane: 'Anulowane' };

// ======================= zakupy =======================
async function loadPo(c, id, lock) {
  const o = (await c.query(`SELECT o.*, o.total_net::float AS total_net, s.name AS supplier_name, s.payment_days, w.code AS warehouse FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
    JOIN warehouses w ON w.id = o.warehouse_id WHERE o.id = $1 ${lock ? 'FOR UPDATE OF o' : ''}`, [id])).rows[0];
  if (!o) throw bad(404, 'Nie znaleziono zamówienia zakupu.');
  o.lines = (await c.query(`SELECT l.id, l.item_id, l.qty::float AS qty, l.unit_price::float AS unit_price, l.received_qty::float AS received_qty, i.sku, i.name, i.unit
    FROM purchase_order_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.order_id = $1 ORDER BY i.name`, [id])).rows;
  o.receipts = (await c.query(`SELECT id, number, doc_date, invoice_no, total_value::float AS total_value, paid_at FROM stock_docs WHERE related_type = 'purchase_order' AND related_id = $1 ORDER BY created_at`, [id])).rows;
  return o;
}
async function poLines(c, list) {
  if (!Array.isArray(list) || !list.length) throw bad(400, 'Zamówienie musi mieć co najmniej jedną pozycję.');
  const out = [];
  for (const l of list.slice(0, 200)) {
    const it = (await c.query('SELECT id, sku, purchase_price FROM stock_items WHERE id = $1', [V.uuid(l.item_id, 'Pozycja', true)])).rows[0];
    if (!it) throw bad(400, 'Pozycja magazynowa nie istnieje.');
    const qty = r3(V.num(l.qty, 0.001, 1e9, it.sku + ': ilość'));
    out.push({ item_id: it.id, qty, unit_price: r2(l.unit_price === '' || l.unit_price == null ? Number(it.purchase_price) : V.num(l.unit_price, 0, 1e9, it.sku + ': cena')) });
  }
  return out;
}
const poTotal = (c, id) => c.query('UPDATE purchase_orders SET total_net = coalesce((SELECT sum(round(qty * unit_price, 2)) FROM purchase_order_lines WHERE order_id = $1), 0), updated_at = now() WHERE id = $1', [id]);
r.get('/zakupy', requirePerm('stock.view'), wrap(async (req, res) => {
  const st = Object.hasOwn(PO_ST, req.query.status) ? req.query.status : null;
  const w = st ? 'WHERE o.status = $1' : req.query.otwarte === '1' ? `WHERE o.status IN ('szkic', 'zamowione', 'czesciowo')` : '';
  res.json((await pool.query(`SELECT o.id, o.number, o.status, o.order_date, o.expected_date, o.total_net::float AS total_net, s.name AS supplier_name, w.code AS warehouse,
      (SELECT count(*)::int FROM purchase_order_lines l WHERE l.order_id = o.id) AS lines, (o.status IN ('zamowione', 'czesciowo') AND o.expected_date < ${TODAY}) AS late
    FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN warehouses w ON w.id = o.warehouse_id ${w} ORDER BY o.created_at DESC LIMIT 300`, st ? [st] : [])).rows.map(o => ({ ...o, status_label: PO_ST[o.status] })));
}));
r.get('/zakupy/:id', idParam, requirePerm('stock.view'), wrap(async (req, res) => { const o = await loadPo(pool, req.params.id); res.json({ ...o, status_label: PO_ST[o.status] }); }));
r.post('/zakupy', buy, wrap(async (req, res) => {
  const b = req.body || {};
  const o = await tx(async c => {
    const sup = V.uuid(b.supplier_id, 'Dostawca', true);
    if (!(await c.query('SELECT 1 FROM suppliers WHERE id = $1 AND is_active', [sup])).rows[0]) throw bad(400, 'Wybierz aktywnego dostawcę.');
    const wh = V.uuid(b.warehouse_id, 'Magazyn') || (await c.query(`SELECT id FROM warehouses WHERE code = 'MAG'`)).rows[0].id;
    const ls = await poLines(c, b.lines);
    const x = (await c.query(`INSERT INTO purchase_orders (number, supplier_id, warehouse_id, expected_date, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [await docs.nextNumber(c, 'ZZ'), sup, wh, V.date(b.expected_date, 'Planowana dostawa'), V.str(b.note, 1000), req.user.id])).rows[0];
    for (const l of ls) await c.query('INSERT INTO purchase_order_lines (order_id, item_id, qty, unit_price) VALUES ($1, $2, $3, $4)', [x.id, l.item_id, l.qty, l.unit_price]);
    await poTotal(c, x.id);
    return loadPo(c, x.id);
  });
  await audit(req, 'zakup.zamowienie', { resource: 'purchase_orders', resourceId: o.id, details: { numer: o.number, wartosc: o.total_net } });
  res.status(201).json(o);
}));
// Propozycje zamówień: pozycje poniżej minimum (wolny stan), ilość do 2 × minimum, pogrupowane po dostawcy – jako szkice do sprawdzenia.
r.post('/zakupy/propozycje', buy, wrap(async (req, res) => {
  const out = await tx(async c => {
    const items = (await c.query(`SELECT i.id, i.supplier_id, i.purchase_price, i.min_qty, coalesce(t.free, 0) AS free FROM stock_items i
      LEFT JOIN (SELECT item_id, sum(qty - reserved) free FROM stock_levels GROUP BY 1) t ON t.item_id = i.id
      WHERE i.is_active AND i.min_qty > 0 AND coalesce(t.free, 0) < i.min_qty AND i.supplier_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id WHERE l.item_id = i.id AND o.status IN ('szkic', 'zamowione', 'czesciowo'))`)).rows;
    const by = {}; for (const i of items) (by[i.supplier_id] = by[i.supplier_id] || []).push(i);
    const wh = (await c.query(`SELECT id FROM warehouses WHERE code = 'MAG'`)).rows[0].id, made = [];
    for (const [sup, list] of Object.entries(by)) {
      const x = (await c.query(`INSERT INTO purchase_orders (number, supplier_id, warehouse_id, note, created_by) VALUES ($1, $2, $3, 'Propozycja z minimów magazynowych', $4) RETURNING id, number`,
        [await docs.nextNumber(c, 'ZZ'), sup, wh, req.user.id])).rows[0];
      for (const i of list) await c.query('INSERT INTO purchase_order_lines (order_id, item_id, qty, unit_price) VALUES ($1, $2, $3, $4)', [x.id, i.id, r3(Number(i.min_qty) * 2 - Number(i.free)), i.purchase_price]);
      await poTotal(c, x.id); made.push(x.number);
    }
    return made;
  });
  await audit(req, 'zakup.propozycje', { resource: 'purchase_orders', details: { utworzono: out.length } });
  res.status(201).json({ created: out });
}));
r.put('/zakupy/:id', idParam, buy, wrap(async (req, res) => {
  const b = req.body || {};
  const o = await tx(async c => {
    const x = await loadPo(c, req.params.id, true);
    if (x.status !== 'szkic') throw bad(409, 'Edytować można tylko szkic zamówienia.');
    const ls = await poLines(c, b.lines);
    await c.query('DELETE FROM purchase_order_lines WHERE order_id = $1', [x.id]);
    for (const l of ls) await c.query('INSERT INTO purchase_order_lines (order_id, item_id, qty, unit_price) VALUES ($1, $2, $3, $4)', [x.id, l.item_id, l.qty, l.unit_price]);
    await c.query('UPDATE purchase_orders SET expected_date = $2, note = $3 WHERE id = $1', [x.id, V.date(b.expected_date, 'Planowana dostawa'), V.str(b.note, 1000)]);
    await poTotal(c, x.id);
    return loadPo(c, x.id);
  });
  res.json(o);
}));
r.post('/zakupy/:id/zamow', idParam, buy, wrap(async (req, res) => {
  const q = await pool.query(`UPDATE purchase_orders SET status = 'zamowione', order_date = current_date, updated_at = now() WHERE id = $1 AND status = 'szkic' RETURNING id`, [req.params.id]);
  if (!q.rows[0]) throw bad(409, 'Zamówić można szkic.');
  await audit(req, 'zakup.wyslanie', { resource: 'purchase_orders', resourceId: req.params.id });
  res.json(await loadPo(pool, req.params.id));
}));
r.post('/zakupy/:id/anuluj', idParam, buy, wrap(async (req, res) => {
  const q = await pool.query(`UPDATE purchase_orders SET status = 'anulowane', updated_at = now() WHERE id = $1 AND status IN ('szkic', 'zamowione') RETURNING id`, [req.params.id]);
  if (!q.rows[0]) throw bad(409, 'Anulować można zamówienie przed przyjęciem towaru.');
  res.json({ ok: true });
}));
// Przyjęcie dostawy (całość lub część): PZ z dostawcą i fakturą (zobowiązanie), aktualizacja ilości przyjętych i statusu.
r.post('/zakupy/:id/przyjmij', idParam, requirePerm('stock.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async c => {
    const x = await loadPo(c, req.params.id, true);
    if (!['zamowione', 'czesciowo'].includes(x.status)) throw bad(409, 'Przyjąć można zamówienie wysłane do dostawcy.');
    const lines = (Array.isArray(b.lines) ? b.lines : []).map(l => ({ line: x.lines.find(y => y.id === l.line_id), qty: r3(V.num(l.qty, 0, 1e9, 'Ilość przyjęta')), price: l.unit_price })).filter(l => l.qty > 0);
    if (!lines.length) throw bad(400, 'Podaj ilości przyjęte.');
    for (const l of lines) {
      if (!l.line) throw bad(400, 'Pozycja spoza zamówienia.');
      if (l.qty > l.line.qty - l.line.received_qty + 1e-9) throw bad(409, `${l.line.sku}: przyjęcie ponad zamówioną ilość (zostało ${r3(l.line.qty - l.line.received_qty)}).`);
    }
    const due = V.date(b.due_date, 'Termin płatności') || new Date(Date.now() + Number(x.payment_days || 14) * 864e5).toISOString().slice(0, 10);
    const doc = await S.post(c, { kind: 'PZ', warehouse_id: x.warehouse_id, supplier_id: x.supplier_id, invoice_no: V.str(b.invoice_no, 60), due_date: due,
      related_type: 'purchase_order', related_id: x.id, note: 'Dostawa do zamówienia ' + x.number,
      lines: lines.map(l => ({ item_id: l.line.item_id, qty: l.qty, unit_cost: l.price === undefined || l.price === '' ? l.line.unit_price : V.num(l.price, 0, 1e9, 'Cena') })), userId: req.user.id });
    for (const l of lines) await c.query('UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id = $1', [l.line.id, l.qty]);
    const left = (await c.query('SELECT count(*)::int n FROM purchase_order_lines WHERE order_id = $1 AND received_qty < qty', [x.id])).rows[0].n;
    await c.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [x.id, left ? 'czesciowo' : 'przyjete']);
    return { doc, status: left ? 'czesciowo' : 'przyjete' };
  });
  await audit(req, 'zakup.przyjecie', { resource: 'purchase_orders', resourceId: req.params.id, details: { pz: out.doc.number, wartosc: out.doc.total_value } });
  res.status(201).json(out);
}));

// ======================= finanse firmy =======================
const period = q => ({ od: V.date(q.od, 'Od') || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10), do: V.date(q.do, 'Do') || new Date().toISOString().slice(0, 10) });
// Należności: faktury sprzedaży bez zapłaty (wszystkie działy), wiekowanie po terminie płatności.
r.get('/finanse-erp/naleznosci', fin, wrap(async (req, res) => {
  const rows = (await pool.query(`SELECT f.id, f.department_id, f.description, f.invoice_no, f.entry_date, f.due_date, f.amount_pln::float AS amount, c.name AS customer_name, f.customer_id,
      (${TODAY} - f.due_date) AS days_overdue, f.part_order_id, f.project_id
    FROM finance f LEFT JOIN customers c ON c.id = f.customer_id WHERE f.kind = 'przychod' AND f.invoice_no <> '' AND f.paid_at IS NULL ORDER BY f.due_date NULLS LAST LIMIT 1000`)).rows;
  const b = { biezace: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
  for (const x of rows) { const d = x.days_overdue; b[d == null || d <= 0 ? 'biezace' : d <= 30 ? 'd1_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90'] += x.amount; }
  res.json({ rows, buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, r2(v)])), total: r2(rows.reduce((s, x) => s + x.amount, 0)), depts: DEPTS });
}));
// Zobowiązania: faktury dostawców (PZ z numerem faktury) i koszty z terminem płatności – bez zapłaty.
r.get('/finanse-erp/zobowiazania', fin, wrap(async (req, res) => {
  const [pz, fk] = await Promise.all([
    pool.query(`SELECT d.id, 'pz' AS source, d.number, d.invoice_no, d.doc_date AS entry_date, d.due_date, d.total_value::float AS amount, s.name AS counterparty, (${TODAY} - d.due_date) AS days_overdue
      FROM stock_docs d JOIN suppliers s ON s.id = d.supplier_id WHERE d.kind = 'PZ' AND d.status = 'zatwierdzony' AND d.paid_at IS NULL ORDER BY d.due_date NULLS LAST`),
    pool.query(`SELECT f.id, 'finanse' AS source, '' AS number, f.invoice_no, f.entry_date, f.due_date, f.amount_pln::float AS amount, coalesce(c.name, f.description) AS counterparty, (${TODAY} - f.due_date) AS days_overdue
      FROM finance f LEFT JOIN customers c ON c.id = f.customer_id WHERE f.kind = 'koszt' AND f.due_date IS NOT NULL AND f.paid_at IS NULL AND f.category <> 'zwroty_sprzedazy' ORDER BY f.due_date`)]);
  const rows = [...pz.rows, ...fk.rows].sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  res.json({ rows, total: r2(rows.reduce((s, x) => s + x.amount, 0)), overdue: r2(rows.filter(x => x.days_overdue > 0).reduce((s, x) => s + x.amount, 0)) });
}));
r.post('/finanse-erp/zaplata', fin, wrap(async (req, res) => {
  const b = req.body || {}, paid = V.date(b.paid_at, 'Data zapłaty') || new Date().toISOString().slice(0, 10), id = V.uuid(b.id, 'Dokument', true);
  const src = V.oneOf(b.source, ['pz', 'finanse'], 'Źródło');
  const q = src === 'pz' ? await pool.query(`UPDATE stock_docs SET paid_at = $2 WHERE id = $1 AND kind = 'PZ' AND paid_at IS NULL RETURNING id`, [id, paid])
    : await pool.query(`UPDATE finance SET paid_at = $2 WHERE id = $1 AND paid_at IS NULL RETURNING id, part_order_id`, [id, paid]);
  if (!q.rows[0]) throw bad(409, 'Dokument nie istnieje albo jest już zapłacony.');
  if (q.rows[0].part_order_id) await pool.query('UPDATE part_orders SET paid_at = $2 WHERE id = $1 AND paid_at IS NULL', [q.rows[0].part_order_id, paid]);
  await audit(req, 'finanse.zaplata', { resource: src === 'pz' ? 'stock_docs' : 'finance', resourceId: id, details: { data: paid } });
  res.json({ ok: true });
}));
// Wyniki działów w okresie: przychody (finanse; Ubezpieczenia – zysk z polis podpisanych w okresie), koszty (księga kosztów), wynik, marża.
async function results(od, dd) {
  const [rev, cost, pol] = await Promise.all([
    pool.query(`SELECT department_id AS d, sum(amount_pln)::float s FROM finance WHERE kind = 'przychod' AND entry_date BETWEEN $1 AND $2 GROUP BY 1`, [od, dd]),
    pool.query(`SELECT coalesce(department_id, '') AS d, sum(amount)::float s FROM cost_ledger WHERE cost_date BETWEEN $1 AND $2 GROUP BY 1`, [od, dd]),
    pool.query(`SELECT count(*)::int n, coalesce(sum(total_amount), 0)::float kwota, coalesce(sum(profit), 0)::float zysk FROM policies WHERE signed_at BETWEEN $1 AND $2`, [od, dd])]);
  const out = Object.keys(DEPTS).map(d => {
    const przychod = d === 'ubezpieczenia' ? pol.rows[0].zysk : (rev.rows.find(x => x.d === d) || { s: 0 }).s, koszt = (cost.rows.find(x => x.d === d) || { s: 0 }).s;
    return { department_id: d, name: DEPTS[d], przychod: r2(przychod), koszt: r2(koszt), wynik: r2(przychod - koszt), marza_pct: przychod > 0 ? r2((przychod - koszt) / przychod * 100) : null };
  });
  const tot = out.reduce((a, x) => ({ przychod: a.przychod + x.przychod, koszt: a.koszt + x.koszt }), { przychod: 0, koszt: 0 });
  return { od, do: dd, departments: out, total: { przychod: r2(tot.przychod), koszt: r2(tot.koszt), wynik: r2(tot.przychod - tot.koszt) },
    polisy: { ...pol.rows[0], uwaga: 'Kwota polis to wartość u towarzystw – nie wchodzi do przychodów. Przychód działu Ubezpieczenia = zysk z marży.' } };
}
r.get('/finanse-erp/wyniki', fin, wrap(async (req, res) => { const p = period(req.query); res.json(await results(p.od, p.do)); }));
r.get('/finanse-erp/przeplywy', fin, wrap(async (req, res) => {
  const p = period(req.query);
  const q = await pool.query(`SELECT m, sum(wplywy)::float wplywy, sum(wydatki)::float wydatki FROM (
      SELECT to_char(paid_at, 'YYYY-MM') m, amount_pln wplywy, 0 wydatki FROM finance WHERE kind = 'przychod' AND paid_at BETWEEN $1 AND $2
      UNION ALL SELECT to_char(paid_at, 'YYYY-MM'), 0, amount_pln FROM finance WHERE kind = 'koszt' AND paid_at BETWEEN $1 AND $2 AND category <> 'zwroty_sprzedazy'
      UNION ALL SELECT to_char(paid_at, 'YYYY-MM'), 0, total_value FROM stock_docs WHERE kind = 'PZ' AND status = 'zatwierdzony' AND paid_at BETWEEN $1 AND $2) x GROUP BY 1 ORDER BY 1`, [p.od, p.do]);
  const rows = q.rows.map(x => ({ ...x, saldo: r2(x.wplywy - x.wydatki) }));
  res.json({ ...p, rows, total: { wplywy: r2(rows.reduce((s, x) => s + x.wplywy, 0)), wydatki: r2(rows.reduce((s, x) => s + x.wydatki, 0)), saldo: r2(rows.reduce((s, x) => s + x.saldo, 0)) },
    uwaga: 'Przepływy z zarejestrowanych zapłat (data zapłaty). Zwroty sprzedaży i prowizje od towarzystw ubezpieczeniowych nie są tu ujmowane.' });
}));
// Eksport dla księgowości (XLSX): sprzedaż, zakupy, koszty, polisy (zysk osobno od kwoty polisy).
r.get('/finanse-erp/eksport', fin, wrap(async (req, res) => {
  const p = period(req.query);
  const [sp, zk, ko, po] = await Promise.all([
    pool.query(`SELECT f.entry_date, f.invoice_no, c.name AS customer, c.tax_id, f.department_id, f.category, f.description, f.amount_pln, f.due_date, f.paid_at
      FROM finance f LEFT JOIN customers c ON c.id = f.customer_id WHERE f.kind = 'przychod' AND f.entry_date BETWEEN $1 AND $2 ORDER BY f.entry_date`, [p.od, p.do]),
    pool.query(`SELECT d.doc_date, d.number, d.invoice_no, s.name AS supplier, s.tax_id, d.total_value, d.due_date, d.paid_at FROM stock_docs d JOIN suppliers s ON s.id = d.supplier_id
      WHERE d.kind = 'PZ' AND d.status = 'zatwierdzony' AND d.doc_date BETWEEN $1 AND $2 ORDER BY d.doc_date`, [p.od, p.do]),
    pool.query(`SELECT f.entry_date, f.invoice_no, f.department_id, f.category, f.description, f.amount_pln, f.due_date, f.paid_at FROM finance f
      WHERE f.kind = 'koszt' AND f.entry_date BETWEEN $1 AND $2 ORDER BY f.entry_date`, [p.od, p.do]),
    pool.query(`SELECT p.signed_at, p.number, p.insurer, p.insurance_type, c.name AS customer, p.total_amount, p.margin_pct, p.profit FROM policies p JOIN customers c ON c.id = p.customer_id
      WHERE p.signed_at BETWEEN $1 AND $2 ORDER BY p.signed_at`, [p.od, p.do])]);
  const D = d => DEPTS[d] || d;
  const buf = await xlsx.build([
    { name: 'Sprzedaż (przychody)', rows: sp.rows.map(x => ({ ...x, department_id: D(x.department_id) })), columns: [{ header: 'Data', key: 'entry_date', type: 'date' }, { header: 'Faktura', key: 'invoice_no' },
      { header: 'Kontrahent', key: 'customer', width: 30 }, { header: 'NIP', key: 'tax_id' }, { header: 'Dział', key: 'department_id', width: 26 }, { header: 'Kategoria', key: 'category' },
      { header: 'Opis', key: 'description', width: 40 }, { header: 'Kwota netto', key: 'amount_pln', type: 'pln' }, { header: 'Termin', key: 'due_date', type: 'date' }, { header: 'Zapłacono', key: 'paid_at', type: 'date' }] },
    { name: 'Zakupy (PZ)', rows: zk.rows, columns: [{ header: 'Data', key: 'doc_date', type: 'date' }, { header: 'PZ', key: 'number' }, { header: 'Faktura dostawcy', key: 'invoice_no' },
      { header: 'Dostawca', key: 'supplier', width: 30 }, { header: 'NIP', key: 'tax_id' }, { header: 'Wartość netto', key: 'total_value', type: 'pln' }, { header: 'Termin', key: 'due_date', type: 'date' }, { header: 'Zapłacono', key: 'paid_at', type: 'date' }] },
    { name: 'Koszty', rows: ko.rows.map(x => ({ ...x, department_id: D(x.department_id) })), columns: [{ header: 'Data', key: 'entry_date', type: 'date' }, { header: 'Faktura', key: 'invoice_no' },
      { header: 'Dział', key: 'department_id', width: 26 }, { header: 'Kategoria', key: 'category' }, { header: 'Opis', key: 'description', width: 40 }, { header: 'Kwota netto', key: 'amount_pln', type: 'pln' },
      { header: 'Termin', key: 'due_date', type: 'date' }, { header: 'Zapłacono', key: 'paid_at', type: 'date' }] },
    { name: 'Polisy (zysk MXT)', rows: po.rows.map(x => ({ ...x, margin_pct: Number(x.margin_pct) / 100 })), columns: [{ header: 'Podpisana', key: 'signed_at', type: 'date' }, { header: 'Numer', key: 'number' },
      { header: 'Towarzystwo', key: 'insurer' }, { header: 'Rodzaj', key: 'insurance_type' }, { header: 'Klient', key: 'customer', width: 30 },
      { header: 'Kwota polisy (nie przychód MXT)', key: 'total_amount', type: 'pln' }, { header: 'Marża', key: 'margin_pct', type: 'pct' }, { header: 'Zysk MXT', key: 'profit', type: 'pln' }] }
  ], { title: 'MXT – eksport dla księgowości' });
  await audit(req, 'finanse.eksport_ksiegowosc', { resource: 'finance', details: { od: p.od, do: p.do } });
  xlsx.send(res, buf, `ksiegowosc_${p.od}_${p.do}`);
}));
// Integracje: rzeczywisty stan – bez atrap. Wymagające kluczy oznaczone jako oczekujące na dane dostępowe.
r.get('/finanse-erp/integracje', fin, wrap(async (req, res) => {
  const env = k => !!process.env[k];
  res.json([
    { key: 'ksef', name: 'KSeF (Krajowy System e-Faktur)', status: env('KSEF_TOKEN') && env('KSEF_NIP') ? 'dane_dostepowe' : 'oczekuje', detail: 'Wymaga tokenu KSeF i NIP firmy (zmienne KSEF_TOKEN, KSEF_NIP) oraz walidacji z księgową przed włączeniem wysyłki. Faktury nie są wysyłane do KSeF.' },
    { key: 'ksiegowosc', name: 'Program księgowy', status: 'eksport', detail: 'Eksport XLSX (sprzedaż, zakupy, koszty, polisy) działa. Bezpośrednie API – oczekuje na wybór programu i dane dostępowe.' },
    { key: 'poczta', name: 'Poczta e-mail (SMTP)', status: env('SMTP_HOST') ? 'aktywna' : 'oczekuje', detail: env('SMTP_HOST') ? 'Kopie powiadomień e-mail wysyłane przez kolejkę.' : 'Brak SMTP_HOST – e-maile czekają w kolejce na konfigurację.' },
    { key: 'sms', name: 'SMS (przypomnienia, potwierdzenia)', status: 'oczekuje', detail: 'Kanał przewidziany w powiadomieniach; wymaga konta u operatora SMS i klucza API.' },
    { key: 'kalendarz', name: 'Kalendarze (Google)', status: 'oczekuje', detail: 'Bot telefoniczny ma obsługę Google Calendar – wymaga konta serwisowego Google.' },
    { key: 'mapy', name: 'Mapy i lokalizacja', status: 'oczekuje', detail: 'Adresy budynków i zleceń są w systemie; wyznaczanie tras wymaga klucza usługi map.' },
    { key: 'urzadzenia', name: 'Urządzenia pomiarowe (odczyty radiowe)', status: 'import', detail: 'Import odczytów z pliku czytnika (numer seryjny lub ID radiowe;wartość) działa. Bezpośrednie API producenta – oczekuje na dane dostępowe.' }
  ]);
}));

module.exports = { router: r, results };
