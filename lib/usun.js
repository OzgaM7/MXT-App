'use strict';
// Wspólna zasada usuwania danych: wpis BEZ historii (dodany przez pomyłkę, duplikat, test) można usunąć;
// wpis Z historią się wyłącza / anuluje / archiwizuje – historia rozliczeń, dokumentów i pracy zostaje.
// Historia = (1) rekordy innych tabel wskazujące na ten wpis kluczem obcym bez kaskady i bez SET NULL,
// (2) dodatkowe powiązania podane przy rejestracji (np. related_type/related_id, zdjęcia, statusy).
// Każde usunięcie trafia do dziennika zdarzeń. Rejestracja: usun.register(router, '/sciezka', middleware, spec).
const { pool } = require('../db');
const { audit } = require('./audit');
const { wrap, bad, idParam } = require('../routes/_util');

const LABEL = {
  installations: 'montaże', service_orders: 'zlecenia serwisowe', finance: 'wpisy finansowe', readings: 'odczyty', device_readings: 'odczyty urządzeń',
  reading_schedules: 'harmonogramy odczytów', projects: 'kontrakty', time_entries: 'czas pracy', stock_docs: 'dokumenty magazynowe', stock_moves: 'ruchy magazynowe',
  stock_levels: 'stany magazynowe', stock_reservations: 'rezerwacje', part_order_lines: 'pozycje zamówień części', purchase_order_lines: 'pozycje zamówień zakupu',
  purchase_orders: 'zamówienia zakupu', part_orders: 'zamówienia części', part_returns: 'zwroty', complaints: 'reklamacje', sales_history: 'sprzedaż',
  export_documents: 'dokumenty eksportowe', phone_requests: 'zgłoszenia telefoniczne', devices: 'urządzenia', stock_items: 'pozycje magazynowe'
};
const fkCache = new Map();
async function foreignRefs(c, table) {
  if (!fkCache.has(table)) fkCache.set(table, (await c.query(`SELECT c.conrelid::regclass::text AS t, a.attname AS col FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.confrelid = $1::regclass AND c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.confdeltype NOT IN ('c', 'n') ORDER BY 1, 2`, [table])).rows);
  return fkCache.get(table);
}
/** Lista powiązań [[etykieta, liczba], …]; pusta = wpis bez historii. */
async function history(c, spec, row) {
  const skip = spec.skip || [];
  const refs = (await foreignRefs(c, spec.table)).filter(r => !skip.includes(r.t) && !skip.includes(r.t + '.' + r.col));
  const parts = [...refs.map(r => [LABEL[r.t] || r.t.replace(/_/g, ' '), `SELECT count(*)::int FROM ${r.t} WHERE ${r.col} = $1`]), ...(spec.extra || [])];
  const out = new Map();
  if (parts.length) {
    const n = (await c.query(`SELECT ${parts.map(([, sql], i) => `(${sql}) AS r${i}`).join(', ')}`, [row.id])).rows[0];
    parts.forEach(([l], i) => { if (n['r' + i] > 0) out.set(l, (out.get(l) || 0) + n['r' + i]); });
  }
  for (const l of (spec.blockers ? spec.blockers(row) : [])) out.set(l, 1);
  return [...out.entries()];
}
const listText = h => h.map(([l, n]) => n > 1 ? `${l}: ${n}` : l).join(', ');

function register(r, path, mw, spec) {
  const load = async (c, id, lock) => (await c.query(`SELECT * FROM ${spec.table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  r.get(path + '/:id/powiazania', idParam, mw, wrap(async (req, res) => {
    const row = await load(pool, req.params.id);
    if (!row) throw bad(404, 'Nie znaleziono.');
    res.json(await history(pool, spec, row));
  }));
  r.delete(path + '/:id', idParam, mw, wrap(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await load(client, req.params.id, true);
      if (!row) throw bad(404, 'Nie znaleziono.');
      const h = await history(client, spec, row);
      if (h.length) throw bad(409, `${spec.what(row)} ma historię (${listText(h)}) – nie można usunąć. ${spec.hint}`);
      if (spec.before) await spec.before(client, row, req);
      await client.query(`DELETE FROM ${spec.table} WHERE id = $1`, [row.id]);
      if (spec.after) await spec.after(client, row, req);
      await audit(req, spec.action, { resource: spec.table, resourceId: row.id, details: { nazwa: spec.what(row) }, client });
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));
}
module.exports = { register, history };
