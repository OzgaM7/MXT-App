'use strict';
// Sprzedaż części samochodowych (osobowe i ciężarowe): zamówienie → potwierdzenie (rezerwacja stanu) → wydanie (WZ, koszt
// sprzedanych części po średnim koszcie) → faktura (przychód działu, należność) → płatność; zwroty (na stan albo wadliwe,
// korekta sprzedaży), reklamacje, należności i analityka (przychody, koszt zakupu, marża, najlepsze i zalegające produkty).
const express = require('express');
const { pool } = require('../../db');
const { audit } = require('../../lib/audit');
const { requirePerm } = require('../../lib/rbac');
const docs = require('../../lib/docs');
const S = require('../../lib/erp/stock');
const { wrap, bad, idParam, V, listLimit, fresh } = require('../_util');
const { plToday } = require('../../lib/dzis');
const usun = require('../../lib/usun');

const r = express.Router();
const use = requirePerm('parts.sell');
const DEP = 'sprzedaz-czesci-i-eksport';
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;
const ST = { nowe: 'Nowe', potwierdzone: 'Potwierdzone (zarezerwowane)', wydane: 'Wydane', zafakturowane: 'Zafakturowane', anulowane: 'Anulowane' };
const { tx, r2 } = S;

async function load(c, id, lock) {
  const o = (await c.query(`SELECT o.*, c.name AS customer_name, w.code AS warehouse FROM part_orders o JOIN customers c ON c.id = o.customer_id JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = $1 ${lock ? 'FOR UPDATE OF o' : ''}`, [id])).rows[0];
  if (!o) throw bad(404, 'Nie znaleziono zamówienia.');
  o.lines = (await c.query(`SELECT l.*, l.qty::float AS qty, l.unit_price::float AS unit_price, l.discount_pct::float AS discount_pct, l.line_net::float AS line_net,
      l.unit_cost::float AS unit_cost, l.returned_qty::float AS returned_qty, i.sku, i.name, i.unit, i.catalog_no, i.manufacturer
    FROM part_order_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.order_id = $1 ORDER BY i.name`, [id])).rows;
  return o;
}
async function lines(c, list) {
  if (!Array.isArray(list) || !list.length) throw bad(400, 'Zamówienie musi mieć co najmniej jedną pozycję.');
  if (list.length > 100) throw bad(400, 'Maksymalnie 100 pozycji.');
  const out = [];
  for (const [i, l] of list.entries()) {
    const it = (await c.query('SELECT id, sku, sale_price, is_active FROM stock_items WHERE id = $1', [V.uuid(l.item_id, `Pozycja ${i + 1}`, true)])).rows[0];
    if (!it || !it.is_active) throw bad(400, `Pozycja ${i + 1}: produkt nie istnieje lub jest wyłączony.`);
    const qty = S.r3(V.num(l.qty, 0.001, 1e7, `Pozycja ${it.sku}: ilość`));
    if (!(qty > 0)) throw bad(400, `Pozycja ${it.sku}: ilość musi być większa od zera.`);
    out.push({ item_id: it.id, qty, unit_price: r2(l.unit_price === '' || l.unit_price == null ? Number(it.sale_price) : V.num(l.unit_price, 0, 1e9, `${it.sku}: cena`)),
      discount_pct: r2(V.num(l.discount_pct, 0, 100, `${it.sku}: rabat`)) });
  }
  return out;
}
const recalc = (c, id) => c.query(`UPDATE part_orders SET total_net = coalesce((SELECT sum(line_net) FROM part_order_lines WHERE order_id = $1), 0), updated_at = now() WHERE id = $1`, [id]);

// ---------- lista, karta ----------
r.get('/czesci/zamowienia', use, wrap(async (req, res) => {
  const p = [], w = [];
  if (ST[req.query.status]) { p.push(req.query.status); w.push(`o.status = $${p.length}`); }
  if (req.query.klient) { p.push(V.uuid(req.query.klient)); w.push(`o.customer_id = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).trim().slice(0, 80).replace(/[\\%_]/g, m => '\\' + m) + '%'); w.push(`(o.number ILIKE $${p.length} OR c.name ILIKE $${p.length} OR o.vehicle ILIKE $${p.length} OR o.invoice_no ILIKE $${p.length})`); }
  if (req.query.naleznosci === '1') w.push(`o.status = 'zafakturowane' AND o.paid_at IS NULL`);
  res.json((await pool.query(`SELECT count(*) OVER()::int AS total_count, o.id, o.number, o.status, o.order_date, o.vehicle, o.total_net::float AS total_net, o.total_cost::float AS total_cost, o.invoice_no, o.invoice_date, o.due_date, o.paid_at,
      c.name AS customer_name, o.customer_id, (o.status = 'zafakturowane' AND o.paid_at IS NULL AND o.due_date < ${TODAY}) AS overdue,
      (SELECT count(*)::int FROM part_order_lines l WHERE l.order_id = o.id) AS lines
    FROM part_orders o JOIN customers c ON c.id = o.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY o.created_at DESC LIMIT ${listLimit(req, 500)}`, p)).rows.map(o => ({ ...o, status_label: ST[o.status] })));
}));
r.get('/czesci/zamowienia/:id', idParam, use, wrap(async (req, res) => {
  const o = await load(pool, req.params.id);
  const [ret, cpl] = await Promise.all([
    pool.query(`SELECT x.*, x.refund_net::float AS refund_net, u.login FROM part_returns x LEFT JOIN users u ON u.id = x.created_by WHERE x.order_id = $1 ORDER BY x.created_at`, [o.id]),
    pool.query(`SELECT id, number, title, status, reported_at FROM complaints WHERE part_order_id = $1 ORDER BY reported_at DESC`, [o.id])]);
  o.total_net = Number(o.total_net); o.total_cost = Number(o.total_cost);
  res.json({ ...o, status_label: ST[o.status], margin: o.total_cost > 0 || ['wydane', 'zafakturowane'].includes(o.status) ? r2(Number(o.total_net) - Number(o.total_cost)) : null, returns: ret.rows, complaints: cpl.rows });
}));

// ---------- tworzenie i edycja (tylko „nowe”) ----------
r.post('/czesci/zamowienia', use, wrap(async (req, res) => {
  const b = req.body || {};
  const o = await tx(async c => {
    const cust = V.uuid(b.customer_id, 'Klient', true);
    if (!(await c.query('SELECT 1 FROM customers WHERE id = $1', [cust])).rows[0]) throw bad(400, 'Nie znaleziono klienta.');
    const wh = V.uuid(b.warehouse_id, 'Magazyn') || (await c.query(`SELECT id FROM warehouses WHERE code = 'MAG'`)).rows[0].id;
    const ls = await lines(c, b.lines);
    const number = await docs.nextNumber(c, 'ZS');
    const x = (await c.query(`INSERT INTO part_orders (number, customer_id, warehouse_id, offer_id, vehicle, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [number, cust, wh, V.uuid(b.offer_id, 'Oferta'), V.str(b.vehicle, 300), V.str(b.note, 2000), req.user.id])).rows[0];
    for (const l of ls) await c.query('INSERT INTO part_order_lines (order_id, item_id, qty, unit_price, discount_pct) VALUES ($1, $2, $3, $4, $5)', [x.id, l.item_id, l.qty, l.unit_price, l.discount_pct]);
    await recalc(c, x.id);
    await c.query(`UPDATE customers SET departments = array_append(departments, $2) WHERE id = $1 AND NOT ($2 = ANY(departments))`, [cust, DEP]);
    return load(c, x.id);
  });
  await audit(req, 'czesci.zamowienie', { resource: 'part_orders', resourceId: o.id, details: { numer: o.number, wartosc: Number(o.total_net) } });
  res.status(201).json(o);
}));
r.put('/czesci/zamowienia/:id', idParam, use, fresh('part_orders'), wrap(async (req, res) => {
  const b = req.body || {};
  const o = await tx(async c => {
    const cur = await load(c, req.params.id, true);
    if (cur.status !== 'nowe') throw bad(409, 'Edytować można tylko zamówienie „nowe” (przed rezerwacją).');
    const ls = await lines(c, b.lines);
    await c.query('DELETE FROM part_order_lines WHERE order_id = $1', [cur.id]);
    for (const l of ls) await c.query('INSERT INTO part_order_lines (order_id, item_id, qty, unit_price, discount_pct) VALUES ($1, $2, $3, $4, $5)', [cur.id, l.item_id, l.qty, l.unit_price, l.discount_pct]);
    await c.query('UPDATE part_orders SET vehicle = $2, note = $3 WHERE id = $1', [cur.id, V.str(b.vehicle, 300), V.str(b.note, 2000)]);
    await recalc(c, cur.id);
    return load(c, cur.id);
  });
  res.json(o);
}));

// ---------- potwierdzenie: rezerwacja stanu (wszystko albo nic) ----------
r.post('/czesci/zamowienia/:id/potwierdz', idParam, use, wrap(async (req, res) => {
  const o = await tx(async c => {
    const x = await load(c, req.params.id, true);
    if (x.status !== 'nowe') throw bad(409, 'Potwierdzić można zamówienie „nowe”.');
    for (const l of x.lines) {
      const rs = await S.reserve(c, { item_id: l.item_id, warehouse_id: x.warehouse_id, qty: l.qty, related_type: 'part_order', related_id: x.id, note: x.number, userId: req.user.id })
        .catch(e => { throw e.status === 409 ? bad(409, `Brak wolnego stanu: ${l.sku} ${l.name} (potrzeba ${l.qty} ${l.unit}).`) : e; });
      await c.query('UPDATE part_order_lines SET reservation_id = $2 WHERE id = $1', [l.id, rs.id]);
    }
    await c.query(`UPDATE part_orders SET status = 'potwierdzone', updated_at = now() WHERE id = $1`, [x.id]);
    return load(c, x.id);
  });
  await audit(req, 'czesci.potwierdzenie', { resource: 'part_orders', resourceId: o.id, details: { numer: o.number } });
  res.json(o);
}));
// ---------- wydanie: WZ z rezerwacji, koszt sprzedanych części ----------
r.post('/czesci/zamowienia/:id/wydaj', idParam, use, wrap(async (req, res) => {
  const o = await tx(async c => {
    const x = await load(c, req.params.id, true);
    if (x.status !== 'potwierdzone') throw bad(409, 'Wydać można zamówienie potwierdzone (z rezerwacją).');
    const doc = await S.post(c, { kind: 'WZ', warehouse_id: x.warehouse_id, customer_id: x.customer_id, related_type: 'part_order', related_id: x.id, useReservation: true,
      lines: x.lines.map(l => ({ item_id: l.item_id, qty: l.qty, unit_price: r2(l.line_net / l.qty) })), note: `Zamówienie ${x.number}`, userId: req.user.id });
    const moves = (await c.query('SELECT item_id, qty::float AS qty, unit_cost::float AS unit_cost FROM stock_moves WHERE doc_id = $1', [doc.id])).rows;
    for (const l of x.lines) {
      const m = moves.find(mv => mv.item_id === l.item_id);
      await c.query('UPDATE part_order_lines SET unit_cost = $2 WHERE id = $1', [l.id, m ? m.unit_cost : 0]);
      if (l.reservation_id) await c.query(`UPDATE stock_reservations SET status = 'wydana', closed_at = now() WHERE id = $1 AND status = 'aktywna'`, [l.reservation_id]);
    }
    await c.query(`UPDATE part_orders SET status = 'wydane', wz_doc_id = $2, total_cost = $3, updated_at = now() WHERE id = $1`, [x.id, doc.id, doc.total_value]);
    return load(c, x.id);
  });
  await audit(req, 'czesci.wydanie', { resource: 'part_orders', resourceId: o.id, details: { numer: o.number, koszt: Number(o.total_cost) } });
  res.json(o);
}));
// ---------- faktura: przychód działu (należność) + wpis do historii sprzedaży ----------
r.post('/czesci/zamowienia/:id/faktura', idParam, requirePerm('parts.sell'), wrap(async (req, res) => {
  const b = req.body || {}, invoice = V.str(b.invoice_no, 60, true, 'Numer faktury');
  const date = V.date(b.invoice_date, 'Data faktury') || plToday();
  const due = V.date(b.due_date, 'Termin płatności') || plToday(14);
  if (due < date) throw bad(400, 'Termin płatności przed datą faktury.');
  const o = await tx(async c => {
    const x = await load(c, req.params.id, true);
    if (x.status !== 'wydane') throw bad(409, 'Fakturę wystawia się po wydaniu towaru.');
    const fin = (await c.query(`INSERT INTO finance (department_id, kind, category, description, amount, currency, rate_pln, amount_pln, entry_date, invoice_no, due_date, customer_id, part_order_id, created_by)
      VALUES ($1, 'przychod', 'sprzedaz_czesci', $2, $3, 'PLN', 1, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [DEP, `Sprzedaż części – zamówienie ${x.number}`, x.total_net, date, invoice, due, x.customer_id, x.id, req.user.id])).rows[0];
    const sale = (await c.query(`INSERT INTO sales_history (number, customer_id, sale_date, currency, rate_pln, total, total_pln, cost_pln, items, status, created_by)
      VALUES ($1, $2, $3, 'PLN', 1, $4, $4, $5, $6, 'zrealizowana', $7) RETURNING id`,
      [x.number, x.customer_id, date, x.total_net, x.total_cost, JSON.stringify(x.lines.map(l => ({ nazwa: l.name, indeks: l.sku, ilosc: l.qty, cena: l.unit_price, rabat: l.discount_pct, wartosc: l.line_net }))), req.user.id])).rows[0];
    await c.query(`UPDATE part_orders SET status = 'zafakturowane', invoice_no = $2, invoice_date = $3, due_date = $4, finance_id = $5, sale_id = $6, updated_at = now() WHERE id = $1`,
      [x.id, invoice, date, due, fin.id, sale.id]);
    return load(c, x.id);
  }).catch(e => { if (e.code === '23505') throw bad(409, 'Numer w historii sprzedaży już istnieje.'); throw e; });
  await audit(req, 'czesci.faktura', { resource: 'part_orders', resourceId: o.id, details: { numer: o.number, faktura: invoice, kwota: Number(o.total_net) } });
  res.json(o);
}));
r.post('/czesci/zamowienia/:id/zaplata', idParam, use, wrap(async (req, res) => {
  const paid = V.date((req.body || {}).paid_at, 'Data zapłaty') || plToday();
  const o = await tx(async c => {
    const x = await load(c, req.params.id, true);
    if (x.status !== 'zafakturowane') throw bad(409, 'Zapłatę rejestruje się dla zafakturowanego zamówienia.');
    if (x.paid_at) throw bad(409, 'Zapłata jest już zarejestrowana.');
    await c.query('UPDATE part_orders SET paid_at = $2, updated_at = now() WHERE id = $1', [x.id, paid]);
    if (x.finance_id) await c.query('UPDATE finance SET paid_at = $2 WHERE id = $1', [x.finance_id, paid]);
    return load(c, x.id);
  });
  await audit(req, 'czesci.zaplata', { resource: 'part_orders', resourceId: o.id, details: { data: paid } });
  res.json(o);
}));
r.post('/czesci/zamowienia/:id/anuluj', idParam, use, wrap(async (req, res) => {
  const reason = V.str((req.body || {}).powod, 500, true, 'Powód anulowania');
  const o = await tx(async c => {
    const x = await load(c, req.params.id, true);
    if (!['nowe', 'potwierdzone'].includes(x.status)) throw bad(409, 'Anulować można zamówienie przed wydaniem towaru (później – zwrot).');
    for (const l of x.lines) if (l.reservation_id) await S.release(c, l.reservation_id, 'anulowana').catch(() => {});
    await c.query(`UPDATE part_orders SET status = 'anulowane', cancel_reason = $2, updated_at = now() WHERE id = $1`, [x.id, reason]);
    return load(c, x.id);
  });
  await audit(req, 'czesci.anulowanie', { resource: 'part_orders', resourceId: o.id, details: { powod: reason } });
  res.json(o);
}));
// ---------- zwrot od klienta: na stan (ZW, korekta kosztu) albo wadliwy; korekta sprzedaży jako koszt „zwroty sprzedaży” ----------
r.post('/czesci/zamowienia/:id/zwrot', idParam, use, wrap(async (req, res) => {
  const b = req.body || {}, reason = V.str(b.powod, 1000, true, 'Powód zwrotu'), restock = b.na_stan !== false;
  const out = await tx(async c => {
    const x = await load(c, req.params.id, true);
    if (!['wydane', 'zafakturowane'].includes(x.status)) throw bad(409, 'Zwrot dotyczy wydanego towaru.');
    const want = (Array.isArray(b.lines) ? b.lines : []).map(l => ({ line: x.lines.find(y => y.id === l.line_id), qty: S.r3(V.num(l.qty, 0, 1e7, 'Ilość zwrotu')) })).filter(l => l.qty > 0);
    if (!want.length) throw bad(400, 'Podaj ilość zwracanych pozycji.');
    for (const w of want) {
      if (!w.line) throw bad(400, 'Pozycja spoza zamówienia.');
      if (w.qty > w.line.qty - w.line.returned_qty + 1e-9) throw bad(409, `${w.line.sku}: można zwrócić najwyżej ${S.r3(w.line.qty - w.line.returned_qty)} ${w.line.unit}.`);
    }
    const number = await docs.nextNumber(c, 'ZK');
    let doc = null;
    if (restock) doc = await S.post(c, { kind: 'ZW', warehouse_id: x.warehouse_id, related_type: 'part_return', related_id: x.id, note: `Zwrot ${number} do zamówienia ${x.number}`,
      lines: want.map(w => ({ item_id: w.line.item_id, qty: w.qty })), userId: req.user.id });
    const refund = r2(want.reduce((s, w) => s + w.qty * (w.line.line_net / w.line.qty), 0));
    for (const w of want) await c.query('UPDATE part_order_lines SET returned_qty = returned_qty + $2 WHERE id = $1', [w.line.id, w.qty]);
    let fin = null;
    if (refund > 0 && x.status === 'zafakturowane') fin = (await c.query(`INSERT INTO finance (department_id, kind, category, description, amount, currency, rate_pln, amount_pln, entry_date, customer_id, part_order_id, created_by)
      VALUES ($1, 'koszt', 'zwroty_sprzedazy', $2, $3, 'PLN', 1, $3, current_date, $4, $5, $6) RETURNING id`, [DEP, `Korekta sprzedaży – zwrot ${number} (${x.invoice_no})`, refund, x.customer_id, x.id, req.user.id])).rows[0];
    const ret = (await c.query(`INSERT INTO part_returns (number, order_id, reason, restock, refund_net, lines, stock_doc_id, finance_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [number, x.id, reason, restock, refund, JSON.stringify(want.map(w => ({ line_id: w.line.id, item_id: w.line.item_id, sku: w.line.sku, qty: w.qty, unit_price: r2(w.line.line_net / w.line.qty), unit_cost: w.line.unit_cost }))),
        doc && doc.id, fin && fin.id, req.user.id])).rows[0];
    return ret;
  });
  await audit(req, 'czesci.zwrot', { resource: 'part_returns', resourceId: out.id, details: { numer: out.number, na_stan: restock, korekta: Number(out.refund_net) } });
  res.status(201).json(out);
}));
r.post('/czesci/zamowienia/:id/reklamacja', idParam, use, wrap(async (req, res) => {
  const b = req.body || {};
  const x = await tx(async c => {
    const o = await load(c, req.params.id);
    const number = await docs.nextNumber(c, 'RK');
    return (await c.query(`INSERT INTO complaints (number, department_id, customer_id, sale_id, part_order_id, title, description, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [number, DEP, o.customer_id, o.sale_id, o.id, V.str(b.title, 200, true, 'Tytuł reklamacji'), V.str(b.description, 5000), req.user.id])).rows[0];
  });
  await audit(req, 'czesci.reklamacja', { resource: 'complaints', resourceId: x.id, details: { numer: x.number } });
  res.status(201).json(x);
}));

// ---------- analityka sprzedaży ----------
r.get('/czesci/analityka', use, wrap(async (req, res) => {
  const od = V.date(req.query.od, 'Od') || plToday(-365), dd = V.date(req.query.do, 'Do') || '2999-12-31';
  const stale = Math.round(V.num(req.query.zalegajace_dni, 30, 3650, 'Dni', 180));
  const [sum, months, top, slow, customers, rec] = await Promise.all([
    pool.query(`SELECT count(*)::int AS zamowienia, coalesce(sum(total_net), 0)::float AS przychod, coalesce(sum(total_cost), 0)::float AS koszt
      FROM part_orders WHERE status = 'zafakturowane' AND invoice_date BETWEEN $1 AND $2`, [od, dd]),
    pool.query(`SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM') AS m, count(*)::int n, sum(total_net)::float przychod, sum(total_cost)::float koszt
      FROM part_orders WHERE status = 'zafakturowane' AND invoice_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [od, dd]),
    pool.query(`SELECT i.id, i.sku, i.name, i.manufacturer, sum(l.qty - l.returned_qty)::float AS qty, sum(l.line_net * (l.qty - l.returned_qty) / l.qty)::float AS przychod,
        sum(coalesce(l.unit_cost, 0) * (l.qty - l.returned_qty))::float AS koszt
      FROM part_order_lines l JOIN part_orders o ON o.id = l.order_id JOIN stock_items i ON i.id = l.item_id
      WHERE o.status = 'zafakturowane' AND o.invoice_date BETWEEN $1 AND $2 GROUP BY 1, 2, 3, 4 ORDER BY przychod DESC LIMIT 20`, [od, dd]),
    pool.query(`SELECT i.id, i.sku, i.name, t.qty::float AS qty, round(t.qty * i.avg_cost, 2)::float AS value,
        (SELECT max(d.doc_date) FROM stock_moves m JOIN stock_docs d ON d.id = m.doc_id WHERE m.item_id = i.id AND m.qty < 0 AND d.kind IN ('WZ', 'RW')) AS last_out
      FROM stock_items i JOIN (SELECT item_id, sum(qty) qty FROM stock_levels GROUP BY 1) t ON t.item_id = i.id
      WHERE t.qty > 0 AND (i.department_id = $1 OR i.kind = 'czesc') AND NOT EXISTS (SELECT 1 FROM stock_moves m JOIN stock_docs d ON d.id = m.doc_id
        WHERE m.item_id = i.id AND m.qty < 0 AND d.kind IN ('WZ', 'RW') AND d.doc_date >= ${TODAY} - $2::int) ORDER BY value DESC LIMIT 50`, [DEP, stale]),
    pool.query(`SELECT c.id, c.name, count(*)::int n, sum(o.total_net)::float przychod, sum(o.total_net - o.total_cost)::float marza FROM part_orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.status = 'zafakturowane' AND o.invoice_date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 10`, [od, dd]),
    pool.query(`SELECT count(*)::int n, coalesce(sum(total_net), 0)::float s, count(*) FILTER (WHERE due_date < ${TODAY})::int po_terminie,
        coalesce(sum(total_net) FILTER (WHERE due_date < ${TODAY}), 0)::float s_po_terminie FROM part_orders WHERE status = 'zafakturowane' AND paid_at IS NULL`)
  ]);
  const ret = (await pool.query(`SELECT coalesce(sum(x.refund_net), 0)::float s, coalesce(sum((SELECT sum((l->>'qty')::numeric * coalesce((l->>'unit_cost')::numeric, 0)) FROM jsonb_array_elements(x.lines) l) ) FILTER (WHERE x.restock), 0)::float koszt_zwrocony
    FROM part_returns x WHERE x.return_date BETWEEN $1 AND $2`, [od, dd])).rows[0];
  const s = sum.rows[0], przychod = r2(s.przychod - ret.s), koszt = r2(s.koszt - ret.koszt_zwrocony);
  res.json({ od, do: dd, zamowienia: s.zamowienia, przychod, koszt, zwroty: ret.s, marza: r2(przychod - koszt), marza_pct: przychod > 0 ? r2((przychod - koszt) / przychod * 100) : null,
    months: months.rows, top: top.rows.map(t => ({ ...t, marza: r2(t.przychod - t.koszt), marza_pct: t.przychod > 0 ? r2((t.przychod - t.koszt) / t.przychod * 100) : null })),
    slow: slow.rows, slow_days: stale, customers: customers.rows, naleznosci: rec.rows[0] });
}));

// Zamówienie części: usunięcie tylko nowego albo anulowanego, nigdy niewydanego i niezafakturowanego.
usun.register(r, '/czesci/zamowienia', use, { table: 'part_orders', action: 'czesci.zamowienie.usuniecie', what: x => `Zamówienie ${x.number}`,
  blockers: x => [...(['nowe', 'anulowane'].includes(x.status) ? [] : [`status „${x.status}”`]), ...(x.wz_doc_id ? ['wydanie WZ'] : []), ...(x.finance_id ? ['faktura'] : []), ...(x.sale_id ? ['sprzedaż'] : [])],
  before: async (c, x) => { await c.query(`UPDATE stock_reservations SET status = 'anulowana' WHERE related_type = 'part_order' AND related_id = $1 AND status = 'aktywna'`, [x.id]); },
  hint: 'Anuluj zamówienie (z powodem) – historia zostanie.' });

module.exports = r;
