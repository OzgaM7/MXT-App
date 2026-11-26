'use strict';
// Magazyn (wspólny dla działów): pozycje, stany, dokumenty PZ/WZ/RW/ZW/MM/INW, rezerwacje, dostawcy, stany poniżej minimum.
const express = require('express');
const { pool } = require('../../db');
const { audit } = require('../../lib/audit');
const { can, requirePerm } = require('../../lib/rbac');
const S = require('../../lib/erp/stock');
const { wrap, bad, idParam, V, listLimit, withTotal } = require('../_util');
const usun = require('../../lib/usun');

const r = express.Router();
const anyOf = perms => async (req, res, next) => perms.some(p => can(req.user, p)) ? next() : requirePerm(perms[0])(req, res, next);
const view = anyOf(['stock.view', 'tasks.use', 'parts.sell']);
const manage = requirePerm('stock.manage');
const items = anyOf(['stock.manage', 'purchases.manage']);
const ITEM_KINDS = ['material', 'czesc', 'urzadzenie', 'inne'];
const DEPTS = ['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport'];

// ---------- magazyny ----------
r.get('/magazyny', view, wrap(async (req, res) => {
  res.json((await pool.query(`SELECT w.*, (SELECT coalesce(sum(l.qty * i.avg_cost), 0)::float FROM stock_levels l JOIN stock_items i ON i.id = l.item_id WHERE l.warehouse_id = w.id) AS value
    FROM warehouses w ORDER BY w.is_active DESC, w.kind = 'glowny' DESC, w.code`)).rows);
}));
r.post('/magazyny', manage, wrap(async (req, res) => {
  const b = req.body || {};
  const code = V.str(b.code, 12, true, 'Kod').toUpperCase();
  if (!/^[A-Z0-9-]{1,12}$/.test(code)) throw bad(400, 'Kod: litery, cyfry i „-”, do 12 znaków.');
  const q = await pool.query('INSERT INTO warehouses (code, name, kind) VALUES ($1, $2, $3) RETURNING *', [code, V.str(b.name, 100, true, 'Nazwa'), V.oneOf(b.kind, ['glowny', 'samochod', 'punkt', 'inny'], 'Rodzaj', 'inny')]);
  await audit(req, 'magazyn.utworzenie', { resource: 'warehouses', resourceId: q.rows[0].id, details: { kod: code } });
  res.status(201).json(q.rows[0]);
}));
r.patch('/magazyny/:id', idParam, manage, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query('UPDATE warehouses SET name = coalesce($2, name), is_active = coalesce($3, is_active) WHERE id = $1 RETURNING *',
    [req.params.id, b.name !== undefined ? V.str(b.name, 100, true, 'Nazwa') : null, typeof b.is_active === 'boolean' ? b.is_active : null]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono magazynu.');
  res.json(q.rows[0]);
}));

// ---------- pozycje magazynowe (materiały, części) ----------
function itemFields(b, partial) {
  const o = {}, set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set('sku', v => { const s = V.str(v, 60, true, 'Indeks'); if (!/^[\p{L}\d._\/-]+$/u.test(s)) throw bad(400, 'Indeks: litery, cyfry, „.”, „-”, „/”, „_”.'); return s; });
  set('name', v => { const s = V.str(v, 200, true, 'Nazwa'); if (s.length < 2) throw bad(400, 'Nazwa: min. 2 znaki.'); return s; });
  set('kind', v => V.oneOf(v, ITEM_KINDS, 'Rodzaj', 'material'));
  set('department_id', v => v ? V.oneOf(v, DEPTS, 'Dział') : null);
  set('unit', v => V.str(v, 10) || 'szt.');
  for (const [k, m] of [['category', 100], ['manufacturer', 100], ['catalog_no', 60], ['description', 2000], ['location', 60]]) set(k, v => V.str(v, m));
  set('replacement_nos', v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map(x => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 50));
  set('vehicle_type', v => V.oneOf(v || '', ['', 'osobowe', 'ciezarowe', 'uniwersalne'], 'Rodzaj pojazdu'));
  set('purchase_price', v => S.r2(V.num(v, 0, 1e9, 'Cena zakupu')));
  set('sale_price', v => S.r2(V.num(v, 0, 1e9, 'Cena sprzedaży')));
  set('min_qty', v => S.r3(V.num(v, 0, 1e9, 'Stan minimalny')));
  set('supplier_id', v => V.uuid(v, 'Dostawca'));
  set('is_active', v => v !== false);
  return o;
}
const ITEM_SELECT = `SELECT i.*, s.name AS supplier_name,
    coalesce(t.qty, 0)::float AS qty, coalesce(t.reserved, 0)::float AS reserved, (coalesce(t.qty, 0) - coalesce(t.reserved, 0))::float AS free,
    round(coalesce(t.qty, 0) * i.avg_cost, 2)::float AS stock_value, (i.min_qty > 0 AND coalesce(t.qty, 0) - coalesce(t.reserved, 0) < i.min_qty) AS below_min,
    CASE WHEN i.sale_price > 0 THEN round((i.sale_price - i.purchase_price) / i.sale_price * 100, 2)::float END AS margin_pct
  FROM stock_items i LEFT JOIN suppliers s ON s.id = i.supplier_id
  LEFT JOIN (SELECT item_id, sum(qty) qty, sum(reserved) reserved FROM stock_levels GROUP BY item_id) t ON t.item_id = i.id`;
r.get('/pozycje', view, wrap(async (req, res) => {
  const p = [], w = [];
  if (req.query.q) {
    p.push('%' + String(req.query.q).trim().slice(0, 80).replace(/[\\%_]/g, m => '\\' + m) + '%');
    w.push(`(i.sku ILIKE $${p.length} OR i.name ILIKE $${p.length} OR i.catalog_no ILIKE $${p.length} OR i.manufacturer ILIKE $${p.length}
      OR EXISTS (SELECT 1 FROM unnest(i.replacement_nos) z WHERE z ILIKE $${p.length}))`);
  }
  if (ITEM_KINDS.includes(req.query.rodzaj)) { p.push(req.query.rodzaj); w.push(`i.kind = $${p.length}`); }
  if (DEPTS.includes(req.query.dzial)) { p.push(req.query.dzial); w.push(`(i.department_id = $${p.length} OR i.department_id IS NULL)`); }
  if (req.query.aktywne !== '0') w.push('i.is_active');
  if (req.query.ponizej === '1') w.push('i.min_qty > 0 AND coalesce(t.qty, 0) - coalesce(t.reserved, 0) < i.min_qty');
  res.json((await pool.query(`${withTotal(ITEM_SELECT)} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY lower(i.name) LIMIT ${listLimit(req, 1000)}`, p)).rows);
}));
r.get('/pozycje/:id', idParam, view, wrap(async (req, res) => {
  const it = (await pool.query(ITEM_SELECT + ' WHERE i.id = $1', [req.params.id])).rows[0];
  if (!it) throw bad(404, 'Nie znaleziono pozycji.');
  const [lv, mv, rs] = await Promise.all([
    pool.query(`SELECT l.*, w.code, w.name AS warehouse_name FROM stock_levels l JOIN warehouses w ON w.id = l.warehouse_id WHERE l.item_id = $1 AND (l.qty <> 0 OR l.reserved <> 0) ORDER BY w.code`, [req.params.id]),
    pool.query(`SELECT m.qty, m.unit_cost, m.value, m.unit_price, d.id AS doc_id, d.number, d.kind, d.doc_date, d.related_type, d.related_id, w.code AS warehouse
      FROM stock_moves m JOIN stock_docs d ON d.id = m.doc_id JOIN warehouses w ON w.id = m.warehouse_id WHERE m.item_id = $1 AND d.status = 'zatwierdzony' ORDER BY m.created_at DESC LIMIT 100`, [req.params.id]),
    pool.query(`SELECT r.*, w.code AS warehouse FROM stock_reservations r JOIN warehouses w ON w.id = r.warehouse_id WHERE r.item_id = $1 AND r.status = 'aktywna' ORDER BY r.created_at`, [req.params.id])
  ]);
  res.json({ ...it, levels: lv.rows, moves: mv.rows, reservations: rs.rows });
}));
r.post('/pozycje', items, wrap(async (req, res) => {
  const o = itemFields(req.body || {}, false), k = Object.keys(o);
  const q = await pool.query(`INSERT INTO stock_items (${k.join(', ')}, created_by) VALUES (${k.map((_, i) => '$' + (i + 1)).join(', ')}, $${k.length + 1}) RETURNING *`, [...k.map(x => o[x]), req.user.id]);
  await audit(req, 'magazyn.pozycja', { resource: 'stock_items', resourceId: q.rows[0].id, details: { indeks: o.sku, nazwa: o.name } });
  res.status(201).json(q.rows[0]);
}));
r.patch('/pozycje/:id', idParam, items, wrap(async (req, res) => {
  const o = itemFields(req.body || {}, true), k = Object.keys(o);
  if (!k.length) throw bad(400, 'Brak zmian.');
  const before = (await pool.query('SELECT purchase_price, sale_price FROM stock_items WHERE id = $1', [req.params.id])).rows[0];
  if (!before) throw bad(404, 'Nie znaleziono pozycji.');
  const q = await pool.query(`UPDATE stock_items SET ${k.map((x, i) => `${x} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, ...k.map(x => o[x])]);
  const priceChange = ['purchase_price', 'sale_price'].filter(x => o[x] !== undefined && Number(o[x]) !== Number(before[x]));
  await audit(req, 'magazyn.pozycja.zmiana', { resource: 'stock_items', resourceId: req.params.id, details: priceChange.length ? Object.fromEntries(priceChange.map(x => [x, [Number(before[x]), o[x]]])) : { pola: k } });
  res.json(q.rows[0]);
}));

// ---------- stany ----------
r.get('/stany', view, wrap(async (req, res) => {
  const p = [], w = ['(l.qty <> 0 OR l.reserved <> 0)'];
  if (req.query.magazyn) { p.push(V.uuid(req.query.magazyn)); w.push(`l.warehouse_id = $${p.length}`); }
  res.json((await pool.query(`SELECT l.*, l.qty::float AS qty, l.reserved::float AS reserved, i.sku, i.name, i.unit, i.kind, i.avg_cost::float AS avg_cost, round(l.qty * i.avg_cost, 2)::float AS value, w.code AS warehouse
    FROM stock_levels l JOIN stock_items i ON i.id = l.item_id JOIN warehouses w ON w.id = l.warehouse_id WHERE ${w.join(' AND ')} ORDER BY w.code, lower(i.name) LIMIT 2000`, p)).rows);
}));

// ---------- dokumenty ----------
const DOC_SELECT = `SELECT d.*, d.total_value::float AS total_value, w.code AS warehouse, w2.code AS to_warehouse, s.name AS supplier_name, c.name AS customer_name, p.number AS project_number,
    u.login AS created_by_login, (SELECT count(*)::int FROM stock_moves m WHERE m.doc_id = d.id) AS lines
  FROM stock_docs d JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN warehouses w2 ON w2.id = d.to_warehouse_id LEFT JOIN suppliers s ON s.id = d.supplier_id
  LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN users u ON u.id = d.created_by`;
r.get('/dokumenty', view, wrap(async (req, res) => {
  const p = [], w = [];
  if (S.KINDS[req.query.rodzaj]) { p.push(req.query.rodzaj); w.push(`d.kind = $${p.length}`); }
  if (req.query.od) { p.push(V.date(req.query.od)); w.push(`d.doc_date >= $${p.length}`); }
  if (req.query.do) { p.push(V.date(req.query.do)); w.push(`d.doc_date <= $${p.length}`); }
  if (req.query.powiazanie && req.query.id) { p.push(String(req.query.powiazanie), V.uuid(req.query.id)); w.push(`d.related_type = $${p.length - 1} AND d.related_id = $${p.length}`); }
  if (req.query.projekt) { p.push(V.uuid(req.query.projekt)); w.push(`d.project_id = $${p.length}`); }
  res.json((await pool.query(`${withTotal(DOC_SELECT)} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY d.created_at DESC LIMIT ${listLimit(req, 300)}`, p)).rows);
}));
r.get('/dokumenty/:id', idParam, view, wrap(async (req, res) => {
  const d = (await pool.query(DOC_SELECT + ' WHERE d.id = $1', [req.params.id])).rows[0];
  if (!d) throw bad(404, 'Nie znaleziono dokumentu.');
  d.moves = (await pool.query(`SELECT m.*, m.qty::float AS qty, m.unit_cost::float AS unit_cost, m.value::float AS value, i.sku, i.name, i.unit, w.code AS warehouse
    FROM stock_moves m JOIN stock_items i ON i.id = m.item_id JOIN warehouses w ON w.id = m.warehouse_id WHERE m.doc_id = $1 ORDER BY m.created_at`, [d.id])).rows;
  res.json(d);
}));
// Wydanie i zwrot materiałów na zlecenie mogą zapisywać też role biurowe rozliczające zlecenia; pozostałe dokumenty – magazyn.
const ORDER_TYPES = { installation: 'installations', service_order: 'service_orders', reading: 'readings', project: 'projects' };
r.post('/dokumenty', wrap(async (req, res) => {
  const b = req.body || {}, kind = String(b.kind || '');
  const allowed = can(req.user, 'stock.manage') || (['RW', 'ZW'].includes(kind) && can(req.user, 'service.manage'));
  if (!allowed) return requirePerm('stock.manage')(req, res, () => {});
  const doc = await S.tx(async client => {
    let projectId = V.uuid(b.project_id, 'Projekt'), relType = null, relId = null;
    if (['RW', 'ZW'].includes(kind)) {
      relType = V.oneOf(b.related_type, Object.keys(ORDER_TYPES), 'Zlecenie');
      relId = V.uuid(b.related_id, 'Zlecenie', true);
      const row = (await client.query(`SELECT * FROM ${ORDER_TYPES[relType]} WHERE id = $1`, [relId])).rows[0];
      if (!row) throw bad(400, 'Nie znaleziono zlecenia.');
      if (relType === 'project') projectId = row.id;
      else if (relType === 'reading') projectId = projectId || (await client.query('SELECT project_id FROM reading_schedules WHERE id = $1', [row.schedule_id])).rows[0].project_id;
      else projectId = projectId || row.project_id || null;
    }
    const d = await S.post(client, { kind, warehouse_id: V.uuid(b.warehouse_id, 'Magazyn', true), to_warehouse_id: V.uuid(b.to_warehouse_id, 'Magazyn docelowy'),
      lines: b.lines, supplier_id: V.uuid(b.supplier_id, 'Dostawca'), customer_id: V.uuid(b.customer_id, 'Klient'), invoice_no: V.str(b.invoice_no, 60),
      due_date: V.date(b.due_date, 'Termin płatności'), doc_date: V.date(b.doc_date, 'Data dokumentu'), project_id: projectId, related_type: relType, related_id: relId,
      note: V.str(b.note, 1000), userId: req.user.id });
    if (projectId) await client.query(`INSERT INTO project_events (project_id, kind, text, created_by) VALUES ($1, 'material', $2, $3)`,
      [projectId, `${d.number}: ${kind === 'RW' ? 'wydanie' : kind === 'ZW' ? 'zwrot' : S.KINDS[kind].toLowerCase()} materiałów, wartość ${Number(d.total_value).toFixed(2)} zł`, req.user.id]);
    return d;
  });
  await audit(req, 'magazyn.dokument', { resource: 'stock_docs', resourceId: doc.id, details: { numer: doc.number, rodzaj: doc.kind, wartosc: doc.total_value } });
  res.status(201).json(doc);
}));

// Anulowanie dokumentu wpisanego przez pomyłkę – cofa stany; wydanie/zwrot na zlecenie może anulować także rozliczający zlecenia.
r.post('/dokumenty/:id/anuluj', idParam, anyOf(['stock.manage', 'service.manage']), wrap(async (req, res) => {
  const reason = V.str((req.body || {}).powod, 500, true, 'Powód anulowania');
  if (reason.length < 3) throw bad(400, 'Powód anulowania: podaj co najmniej 3 znaki.');
  const kind = ((await pool.query('SELECT kind FROM stock_docs WHERE id = $1', [req.params.id])).rows[0] || {}).kind;
  if (!kind) throw bad(404, 'Nie znaleziono dokumentu.');
  if (!(can(req.user, 'stock.manage') || (['RW', 'ZW'].includes(kind) && can(req.user, 'service.manage')))) return requirePerm('stock.manage')(req, res, () => {});
  const doc = await S.tx(async client => {
    const d = await S.cancel(client, req.params.id, { userId: req.user.id, reason });
    if (d.project_id) await client.query(`INSERT INTO project_events (project_id, kind, text, created_by) VALUES ($1, 'material', $2, $3)`,
      [d.project_id, `${d.number}: dokument anulowany (${reason}) – materiały wróciły na stan`, req.user.id]);
    return d;
  });
  await audit(req, 'magazyn.dokument.anulowanie', { resource: 'stock_docs', resourceId: doc.id, details: { numer: doc.number, rodzaj: doc.kind, wartosc: Number(doc.total_value), powod: reason } });
  res.json((await pool.query(DOC_SELECT + ' WHERE d.id = $1', [doc.id])).rows[0]);
}));

// ---------- rezerwacje ----------
r.post('/rezerwacje', anyOf(['stock.manage', 'parts.sell']), wrap(async (req, res) => {
  const b = req.body || {};
  const x = await S.tx(c => S.reserve(c, { item_id: V.uuid(b.item_id, 'Pozycja', true), warehouse_id: V.uuid(b.warehouse_id, 'Magazyn', true), qty: b.qty,
    related_type: V.oneOf(b.related_type, ['installation', 'service_order', 'project', 'part_order', 'inne'], 'Powiązanie', 'inne'), related_id: V.uuid(b.related_id), note: V.str(b.note, 500), userId: req.user.id }));
  await audit(req, 'magazyn.rezerwacja', { resource: 'stock_reservations', resourceId: x.id, details: { ilosc: Number(x.qty) } });
  res.status(201).json(x);
}));
r.post('/rezerwacje/:id/anuluj', idParam, anyOf(['stock.manage', 'parts.sell']), wrap(async (req, res) => {
  await S.tx(c => S.release(c, req.params.id, 'anulowana'));
  await audit(req, 'magazyn.rezerwacja.anulowanie', { resource: 'stock_reservations', resourceId: req.params.id });
  res.json({ ok: true });
}));

// ---------- dostawcy ----------
const supplierFields = b => ({ name: (() => { const s = V.str(b.name, 200, true, 'Nazwa'); if (s.length < 2) throw bad(400, 'Nazwa: min. 2 znaki.'); return s; })(),
  tax_id: V.str(b.tax_id, 30), email: V.str(b.email, 200), phone: V.str(b.phone, 50), address: V.str(b.address, 300), contact: V.str(b.contact, 200),
  payment_days: Math.round(V.num(b.payment_days, 0, 365, 'Termin płatności', 14)), notes: V.str(b.notes, 2000) });
r.get('/dostawcy', view, wrap(async (req, res) => {
  res.json((await pool.query(`SELECT s.*, (SELECT count(*)::int FROM stock_items i WHERE i.supplier_id = s.id) AS items,
    (SELECT coalesce(sum(total_value), 0)::float FROM stock_docs d WHERE d.supplier_id = s.id AND d.kind = 'PZ' AND d.status = 'zatwierdzony' AND d.paid_at IS NULL) AS unpaid
    FROM suppliers s ORDER BY s.is_active DESC, lower(s.name)`)).rows);
}));
r.post('/dostawcy', requirePerm('purchases.manage'), wrap(async (req, res) => {
  const o = supplierFields(req.body || {}), k = Object.keys(o);
  const q = await pool.query(`INSERT INTO suppliers (${k.join(', ')}, created_by) VALUES (${k.map((_, i) => '$' + (i + 1)).join(', ')}, $${k.length + 1}) RETURNING *`, [...k.map(x => o[x]), req.user.id]);
  await audit(req, 'dostawca.utworzenie', { resource: 'suppliers', resourceId: q.rows[0].id, details: { nazwa: o.name } });
  res.status(201).json(q.rows[0]);
}));
r.patch('/dostawcy/:id', idParam, requirePerm('purchases.manage'), wrap(async (req, res) => {
  const b = req.body || {}, o = supplierFields({ ...(await pool.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id])).rows[0], ...b });
  if (typeof b.is_active === 'boolean') o.is_active = b.is_active;
  const k = Object.keys(o);
  const q = await pool.query(`UPDATE suppliers SET ${k.map((x, i) => `${x} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...k.map(x => o[x])]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono dostawcy.');
  res.json(q.rows[0]);
}));

// ---------- usuwanie wpisów bez historii (lib/usun.js); z historią – wyłączenie ----------
const zeroLevels = (col) => ({ skip: ['stock_levels'], extra: [['stan magazynowy', `SELECT count(*)::int FROM stock_levels WHERE ${col} = $1 AND (qty <> 0 OR reserved <> 0)`]],
  before: async (c, x) => { await c.query(`DELETE FROM stock_levels WHERE ${col} = $1`, [x.id]); } });   // puste wiersze stanu zakładane automatycznie
usun.register(r, '/pozycje', items, { table: 'stock_items', action: 'magazyn.pozycja.usuniecie', what: x => `Pozycja ${x.sku}`, ...zeroLevels('item_id'),
  hint: 'Wyłącz pozycję (nieaktywna) – historia ruchów zostanie.' });
usun.register(r, '/dostawcy', requirePerm('purchases.manage'), { table: 'suppliers', action: 'magazyn.dostawca.usuniecie', what: x => `Dostawca ${x.name}`, skip: ['stock_items'],
  before: async (c, x) => { await c.query('UPDATE stock_items SET supplier_id = NULL WHERE supplier_id = $1', [x.id]); },   // domyślny dostawca pozycji – nie historia
  hint: 'Wyłącz dostawcę – dokumenty i zamówienia zostaną.' });
usun.register(r, '/magazyny', manage, { table: 'warehouses', action: 'magazyn.magazyn.usuniecie', what: x => `Magazyn ${x.code}`, ...zeroLevels('warehouse_id'),
  blockers: x => x.code === 'MAG' ? ['magazyn główny (używany domyślnie)'] : [],
  hint: 'Wyłącz magazyn – historia dokumentów zostanie.' });

module.exports = r;
