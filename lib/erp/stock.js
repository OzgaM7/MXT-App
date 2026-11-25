'use strict';
// Magazyn: dokumenty ruchu w jednej transakcji z blokadą wierszy stanu (SELECT … FOR UPDATE w stałej kolejności),
// więc równoczesne wydania nie zejdą poniżej zera ani poniżej rezerwacji (dodatkowo CHECK w bazie).
// Wycena: średni ważony koszt zakupu (aktualizowany przy PZ), wydania i przesunięcia po bieżącym koszcie średnim.
const { pool } = require('../../db');
const docs = require('../docs');
const { bad } = require('../../routes/_util');

const KINDS = { PZ: 'Przyjęcie z zewnątrz', WZ: 'Wydanie na zewnątrz', RW: 'Wydanie na zlecenie', ZW: 'Zwrot ze zlecenia', MM: 'Przesunięcie międzymagazynowe', INW: 'Inwentaryzacja (korekta)' };
const IN = ['PZ', 'ZW'], OUT = ['WZ', 'RW'];
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const r4 = n => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

async function tx(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// Blokuje (i w razie potrzeby zakłada) wiersze stanu w stałej kolejności – bez zakleszczeń przy równoległych dokumentach.
async function lockLevels(client, pairs) {
  const uniq = [...new Map(pairs.map(p => [p.warehouse_id + ':' + p.item_id, p])).values()]
    .sort((a, b) => (a.warehouse_id + a.item_id).localeCompare(b.warehouse_id + b.item_id));
  const out = new Map();
  for (const p of uniq) {
    await client.query('INSERT INTO stock_levels (warehouse_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.warehouse_id, p.item_id]);
    const row = (await client.query('SELECT * FROM stock_levels WHERE warehouse_id = $1 AND item_id = $2 FOR UPDATE', [p.warehouse_id, p.item_id])).rows[0];
    out.set(p.warehouse_id + ':' + p.item_id, row);
  }
  return out;
}

/**
 * Tworzy i księguje dokument magazynowy.
 * @param {object} d kind, warehouse_id, to_warehouse_id (MM), lines [{item_id, qty, unit_cost (PZ), unit_price (WZ), counted (INW)}],
 *   supplier_id, customer_id, invoice_no, due_date, doc_date, project_id, related_type, related_id, note, userId, useReservation (RW/WZ z rezerwacji)
 */
async function post(client, d) {
  if (!KINDS[d.kind]) throw bad(400, 'Rodzaj dokumentu: nieprawidłowa wartość.');
  const lines = (Array.isArray(d.lines) ? d.lines : []).filter(l => l && l.item_id);
  if (!lines.length) throw bad(400, 'Dokument musi mieć co najmniej jedną pozycję.');
  if (lines.length > 200) throw bad(400, 'Maksymalnie 200 pozycji w dokumencie.');
  const wh = (await client.query('SELECT id, is_active FROM warehouses WHERE id = $1', [d.warehouse_id])).rows[0];
  if (!wh || !wh.is_active) throw bad(400, 'Magazyn: wybierz aktywny magazyn.');
  if (d.kind === 'MM') {
    const to = (await client.query('SELECT id, is_active FROM warehouses WHERE id = $1', [d.to_warehouse_id])).rows[0];
    if (!to || !to.is_active || to.id === wh.id) throw bad(400, 'Magazyn docelowy: wybierz inny aktywny magazyn.');
  }
  const ids = [...new Set(lines.map(l => l.item_id))];
  const items = new Map((await client.query('SELECT * FROM stock_items WHERE id = ANY($1::uuid[]) FOR UPDATE', [ids])).rows.map(i => [i.id, i]));
  for (const l of lines) {
    const it = items.get(l.item_id);
    if (!it) throw bad(400, 'Pozycja magazynowa nie istnieje.');
    if (!it.is_active && d.kind !== 'INW') throw bad(400, `Pozycja ${it.sku} jest wyłączona.`);
    if (d.kind === 'INW') {
      if (!(Number(l.counted) >= 0) || l.counted === '' || l.counted == null) throw bad(400, `${it.sku}: podaj stan policzony (0 lub więcej).`);
    } else if (!(Number(l.qty) > 0) || Number(l.qty) > 1e9) throw bad(400, `${it.sku}: ilość musi być większa od zera.`);
    if (d.kind === 'PZ' && !(Number(l.unit_cost) >= 0)) throw bad(400, `${it.sku}: podaj cenę zakupu netto.`);
  }
  const pairs = lines.map(l => ({ warehouse_id: wh.id, item_id: l.item_id }));
  if (d.kind === 'MM') lines.forEach(l => pairs.push({ warehouse_id: d.to_warehouse_id, item_id: l.item_id }));
  const levels = await lockLevels(client, pairs);
  // Stan łączny pozycji (wszystkie magazyny) – do średniej ważonej przy przyjęciu.
  const totals = new Map((await client.query('SELECT item_id, sum(qty)::float AS q FROM stock_levels WHERE item_id = ANY($1::uuid[]) GROUP BY item_id', [ids])).rows.map(r => [r.item_id, r.q]));

  const number = await docs.nextNumber(client, d.kind, d.doc_date ? new Date(d.doc_date + 'T12:00:00') : new Date());
  const doc = (await client.query(`INSERT INTO stock_docs (number, kind, doc_date, warehouse_id, to_warehouse_id, supplier_id, customer_id, invoice_no, due_date,
      project_id, related_type, related_id, note, created_by) VALUES ($1, $2, coalesce($3::date, current_date), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [number, d.kind, d.doc_date || null, wh.id, d.kind === 'MM' ? d.to_warehouse_id : null, d.kind === 'PZ' ? d.supplier_id || null : null, d.kind === 'WZ' ? d.customer_id || null : null,
      String(d.invoice_no || '').slice(0, 60), d.due_date || null, d.project_id || null, d.related_type || null, d.related_id || null, String(d.note || '').slice(0, 1000), d.userId || null])).rows[0];

  let total = 0;
  const move = async (itemId, whId, qty, unitCost, unitPrice = null) => {
    const value = r2(qty * unitCost);
    total += value;
    await client.query('INSERT INTO stock_moves (doc_id, item_id, warehouse_id, qty, unit_cost, value, unit_price) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [doc.id, itemId, whId, r3(qty), r4(unitCost), value, unitPrice]);
    const key = whId + ':' + itemId, lv = levels.get(key);
    const nq = r3(Number(lv.qty) + qty);
    if (nq < 0) throw bad(409, `Brak wystarczającego stanu: ${items.get(itemId).sku} (dostępne ${Number(lv.qty) - Number(lv.reserved)} ${items.get(itemId).unit}).`);
    lv.qty = nq;
  };
  for (const l of lines) {
    const it = items.get(l.item_id), key = wh.id + ':' + it.id, lv = levels.get(key);
    const qty = r3(Number(l.qty)), cost = Number(it.avg_cost);
    if (d.kind === 'PZ') {
      const price = r2(Number(l.unit_cost)), have = Math.max(0, totals.get(it.id) || 0);
      const avg = have + qty > 0 ? (have * cost + qty * price) / (have + qty) : price;
      await move(it.id, wh.id, qty, price);
      totals.set(it.id, have + qty);
      it.avg_cost = r4(avg);
      await client.query('UPDATE stock_items SET avg_cost = $2, purchase_price = $3, updated_at = now() WHERE id = $1', [it.id, it.avg_cost, price]);
    } else if (d.kind === 'ZW') {
      await move(it.id, wh.id, qty, cost);
    } else if (OUT.includes(d.kind)) {
      // Wydanie z rezerwacji zwalnia rezerwację; bez rezerwacji – tylko z wolnego stanu (stan − zarezerwowane).
      const free = Number(lv.qty) - Number(lv.reserved);
      const fromRes = d.useReservation ? Math.min(qty, Number(lv.reserved)) : 0;
      if (qty - fromRes > free + 1e-9) throw bad(409, `Brak wolnego stanu: ${it.sku} (wolne ${r3(free)} ${it.unit}, zarezerwowane ${r3(Number(lv.reserved))}).`);
      if (fromRes > 0) { lv.reserved = r3(Number(lv.reserved) - fromRes); await client.query('UPDATE stock_levels SET reserved = $3 WHERE warehouse_id = $1 AND item_id = $2', [wh.id, it.id, lv.reserved]); }
      await move(it.id, wh.id, -qty, cost, d.kind === 'WZ' && l.unit_price != null ? r2(Number(l.unit_price)) : null);
    } else if (d.kind === 'MM') {
      const free = Number(lv.qty) - Number(lv.reserved);
      if (qty > free + 1e-9) throw bad(409, `Brak wolnego stanu do przesunięcia: ${it.sku} (wolne ${r3(free)} ${it.unit}).`);
      await move(it.id, wh.id, -qty, cost);
      await move(it.id, d.to_warehouse_id, qty, cost);
    } else if (d.kind === 'INW') {
      const diff = r3(Number(l.counted) - Number(lv.qty));
      if (Number(l.counted) < Number(lv.reserved)) throw bad(409, `${it.sku}: stan policzony mniejszy niż rezerwacje (${r3(Number(lv.reserved))}) – najpierw zwolnij rezerwacje.`);
      if (diff !== 0) await move(it.id, wh.id, diff, cost);
    }
  }
  for (const [key, lv] of levels) {
    const [w, i] = key.split(':');
    await client.query('UPDATE stock_levels SET qty = $3 WHERE warehouse_id = $1 AND item_id = $2', [w, i, lv.qty]);
  }
  // Wartość dokumentu: dla rozchodów dodatnia (wartość wydanego towaru), dla MM – wartość przesunięta.
  const docValue = d.kind === 'MM' ? r2(total / 2 + Math.abs(total) / 2) : r2(Math.abs(total));
  const mmValue = d.kind === 'MM' ? r2((await client.query('SELECT coalesce(sum(value), 0)::float v FROM stock_moves WHERE doc_id = $1 AND qty > 0', [doc.id])).rows[0].v) : docValue;
  await client.query('UPDATE stock_docs SET total_value = $2 WHERE id = $1', [doc.id, d.kind === 'INW' ? r2(total) : mmValue]);
  return { ...doc, total_value: d.kind === 'INW' ? r2(total) : mmValue };
}

/**
 * Anulowanie dokumentu wpisanego przez pomyłkę: cofa jego ruchy na stanach (z blokadą wierszy stanu) i oznacza dokument
 * jako „anulowany” (z powodem, autorem i datą). Ruchy anulowanego dokumentu nie liczą się do historii, kosztów ani zobowiązań
 * (wszystkie zestawienia biorą tylko dokumenty „zatwierdzony”). Dokumenty z procesów (zamówienie zakupu, sprzedaż części, zwrot,
 * inwentaryzacja) koryguje się w tych procesach, nie tutaj.
 */
const CANCEL_BLOCK = { purchase_order: 'zamówieniu zakupu', part_order: 'zamówieniu części', part_return: 'zwrocie', sale: 'sprzedaży', inventory: 'inwentaryzacji' };
async function cancel(client, docId, { userId, reason }) {
  const doc = (await client.query('SELECT * FROM stock_docs WHERE id = $1 FOR UPDATE', [docId])).rows[0];
  if (!doc) throw bad(404, 'Nie znaleziono dokumentu.');
  if (doc.status === 'anulowany') throw bad(409, 'Dokument jest już anulowany.');
  if (doc.kind === 'INW') throw bad(409, 'Korektę inwentaryzacyjną poprawia się kolejną inwentaryzacją (policz stan ponownie).');
  if (CANCEL_BLOCK[doc.related_type]) throw bad(409, `Dokument powstał przy ${CANCEL_BLOCK[doc.related_type]} – popraw go w tym procesie (np. zwrot, anulowanie zamówienia).`);
  if (doc.kind === 'PZ' && doc.paid_at) throw bad(409, 'Przyjęcie jest już zapłacone – anulowanie wymaga korekty w finansach (najpierw cofnij zapłatę).');
  const moves = (await client.query('SELECT item_id, warehouse_id, qty::float AS qty, unit_cost::float AS unit_cost FROM stock_moves WHERE doc_id = $1', [doc.id])).rows;
  const levels = await lockLevels(client, moves.map(m => ({ warehouse_id: m.warehouse_id, item_id: m.item_id })));
  const items = new Map((await client.query('SELECT id, sku, unit, avg_cost::float AS avg_cost FROM stock_items WHERE id = ANY($1::uuid[]) FOR UPDATE', [[...new Set(moves.map(m => m.item_id))]])).rows.map(i => [i.id, i]));
  const totals = new Map((await client.query('SELECT item_id, sum(qty)::float AS q FROM stock_levels WHERE item_id = ANY($1::uuid[]) GROUP BY item_id', [[...items.keys()]])).rows.map(r => [r.item_id, r.q]));
  for (const m of moves) {
    const lv = levels.get(m.warehouse_id + ':' + m.item_id), it = items.get(m.item_id);
    const nq = r3(Number(lv.qty) - m.qty);
    // Cofnięcie przyjęcia zdejmuje towar ze stanu – tylko z wolnej ilości (nie wydanej i niezarezerwowanej).
    if (m.qty > 0 && nq < Number(lv.reserved) - 1e-9) throw bad(409, `Nie można anulować: ${it.sku} – towar z tego dokumentu został już wydany lub zarezerwowany (stan ${r3(Number(lv.qty))}, zarezerwowane ${r3(Number(lv.reserved))} ${it.unit}).`);
    lv.qty = nq;
    if (doc.kind === 'PZ' && m.qty > 0) {   // średni koszt bez tej dostawy
      const have = totals.get(it.id) || 0, rest = have - m.qty;
      const avg = rest > 1e-9 ? (have * it.avg_cost - m.qty * m.unit_cost) / rest : it.avg_cost;
      if (avg >= 0) { it.avg_cost = r4(avg); await client.query('UPDATE stock_items SET avg_cost = $2, updated_at = now() WHERE id = $1', [it.id, it.avg_cost]); }
      totals.set(it.id, rest);
    }
  }
  for (const [key, lv] of levels) {
    const [w, i] = key.split(':');
    await client.query('UPDATE stock_levels SET qty = $3 WHERE warehouse_id = $1 AND item_id = $2', [w, i, lv.qty]);
  }
  await client.query(`UPDATE stock_docs SET status = 'anulowany', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`, [doc.id, userId || null, String(reason || '').slice(0, 500)]);
  return { ...doc, status: 'anulowany' };
}

// Rezerwacja z wolnego stanu (ilość − zarezerwowane) – również z blokadą wiersza stanu.
async function reserve(client, { item_id, warehouse_id, qty, related_type, related_id, note, userId }) {
  qty = r3(Number(qty));
  if (!(qty > 0)) throw bad(400, 'Ilość rezerwacji musi być większa od zera.');
  const lv = (await lockLevels(client, [{ warehouse_id, item_id }])).get(warehouse_id + ':' + item_id);
  const free = Number(lv.qty) - Number(lv.reserved);
  if (qty > free + 1e-9) throw bad(409, `Brak wolnego stanu do rezerwacji (wolne ${r3(free)}).`);
  await client.query('UPDATE stock_levels SET reserved = reserved + $3 WHERE warehouse_id = $1 AND item_id = $2', [warehouse_id, item_id, qty]);
  return (await client.query(`INSERT INTO stock_reservations (item_id, warehouse_id, qty, related_type, related_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [item_id, warehouse_id, qty, related_type, related_id || null, String(note || '').slice(0, 500), userId || null])).rows[0];
}
async function release(client, reservationId, status = 'anulowana') {
  const r = (await client.query('SELECT * FROM stock_reservations WHERE id = $1 FOR UPDATE', [reservationId])).rows[0];
  if (!r) throw bad(404, 'Nie znaleziono rezerwacji.');
  if (r.status !== 'aktywna') throw bad(409, 'Rezerwacja nie jest aktywna.');
  await lockLevels(client, [{ warehouse_id: r.warehouse_id, item_id: r.item_id }]);
  if (status === 'anulowana') await client.query('UPDATE stock_levels SET reserved = greatest(reserved - $3, 0) WHERE warehouse_id = $1 AND item_id = $2', [r.warehouse_id, r.item_id, r.qty]);
  await client.query('UPDATE stock_reservations SET status = $2, closed_at = now() WHERE id = $1', [r.id, status]);
  return r;
}

const DOC_FOR = { installation: 'montażu', service_order: 'zlecenia serwisowego', reading: 'odczytu', project: 'projektu' };
module.exports = { KINDS, IN, OUT, post, cancel, reserve, release, tx, lockLevels, DOC_FOR, r2, r3 };
