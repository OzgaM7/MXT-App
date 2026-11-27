'use strict';
// Wspólne narzędzia tras: obsługa błędów, walidacja pól, odpowiedź PDF.
const ops = require('../lib/operations');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (s, m) => new ops.PolicyError(s, m);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e instanceof ops.PolicyError || (e && e.status && e.status < 500 && e.message)) return res.status(e.status).json({ error: e.message });
  if (e && e.code === '22P02') return res.status(400).json({ error: 'Nieprawidłowe dane lub identyfikator.' });
  // Dane spoza zakresu bazy (za długi tekst, liczba lub data poza zakresem, niedozwolony znak) – błąd danych, nie serwera.
  if (e && ['22001', '22003', '22007', '22008', '22021', '22004'].includes(e.code)) return res.status(400).json({ error: 'Nieprawidłowe dane (za długi tekst, liczba lub data poza zakresem).' });
  // Konflikt równoczesnej edycji / zakleszczenie – można bezpiecznie ponowić.
  if (e && ['40001', '40P01'].includes(e.code)) return res.status(409).json({ error: 'Ktoś w tej chwili zmienia te same dane. Odśwież i spróbuj ponownie.' });
  if (e && e.code === '23505') return res.status(409).json({ error: 'Taki wpis już istnieje (np. numer seryjny lub nazwa).' });
  if (e && e.code === '23503') return res.status(400).json({ error: 'Nieprawidłowe powiązanie z innym rekordem.' });
  if (e && e.code === '23514') return res.status(400).json({ error: 'Nieprawidłowe dane.' });
  next(e);
});
const idParam = (req, res, next) => UUID.test(req.params.id) ? next() : res.status(404).json({ error: 'Nie znaleziono.' });

// Pola: str(v, max, required?), num(v, min, max), date(v), oneOf(v, list), uuid(v)
const V = {
  str(v, max = 500, req = false, name = 'Pole') { const s = v == null ? '' : String(v).trim().slice(0, max); if (req && !s) throw bad(400, `${name}: pole wymagane.`); return s; },
  num(v, min = 0, max = 1e12, name = 'Liczba', def = 0) { if (v === '' || v == null) return def; const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw bad(400, `${name}: nieprawidłowa wartość.`); return n; },
  date(v, name = 'Data', req = false) { if (!v) { if (req) throw bad(400, `${name}: podaj datę.`); return null; } if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v + 'T00:00:00Z').getUTCDate() !== Number(v.slice(8))) throw bad(400, `${name}: nieprawidłowa data.`); return v; },
  oneOf(v, list, name = 'Wartość', def) { if ((v === undefined || v === '') && def !== undefined) return def; if (!list.includes(v)) throw bad(400, `${name}: nieprawidłowa wartość.`); return v; },
  uuid(v, name = 'Powiązanie', req = false) { if (!v) { if (req) throw bad(400, `${name}: wybierz z listy.`); return null; } if (!UUID.test(v)) throw bad(400, `${name}: nieprawidłowy identyfikator.`); return v; }
};

// Częściowa aktualizacja: tylko przekazane pola, tylko z listy dozwolonych (bez wstrzyknięć nazw kolumn).
function patchSql(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) throw bad(400, 'Brak zmian.');
  return { sql: `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}${['customers', 'buildings', 'projects', 'installations', 'complaints', 'courses'].includes(table) ? ', updated_at = now()' : ''} WHERE id = $1 RETURNING *`, params: [id, ...keys.map(k => fields[k])] };
}

// Ochrona przed nadpisaniem cudzych zmian (dwie osoby edytują ten sam rekord): formularz odsyła updated_at z chwili otwarcia,
// inna wartość w bazie oznacza, że ktoś zapisał w międzyczasie – 409 zamiast cichego nadpisania. Bez updated_at (np. szybkie
// zmiany statusu) – bez sprawdzania.
function checkFresh(current, seen) {
  if (!seen || !current) return;
  const t = new Date(seen).getTime();
  if (Number.isNaN(t)) return;
  if (Math.abs(new Date(current).getTime() - t) >= 1) throw bad(409, 'Ktoś inny zmienił te dane po otwarciu formularza. Zamknij okno, odśwież i wprowadź zmiany ponownie.');
}
// Middleware dla tras edycji: wersja z formularza (updated_at) musi się zgadzać z bazą – inaczej 409 zamiast nadpisania.
const fresh = table => wrap(async (req, res, next) => { await assertFresh(require('../db').pool, table, req.params.id, (req.body || {}).updated_at); next(); });
async function assertFresh(db, table, id, seen) {
  if (!seen) return;
  const row = (await db.query(`SELECT updated_at FROM ${table} WHERE id = $1`, [id])).rows[0];
  if (row) checkFresh(row.updated_at, seen);
}

// Długie listy: domyślna porcja, „Pokaż więcej” w interfejsie prosi o większą (?limit=, z górną granicą). Kolumna total_count
// (liczba wszystkich pasujących wierszy, liczona przed LIMIT) pozwala pokazać „Pokazano X z Y” zamiast cichego ucięcia listy.
const listLimit = (req, def, max = 20000) => { const n = parseInt(req.query.limit, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def; };
const withTotal = sql => sql.replace(/^\s*SELECT /, 'SELECT count(*) OVER()::int AS total_count, ');

function sendPdf(res, buf, filename, inline = true) {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.-]+/g, '_')}"`,
    'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'" });
  res.end(buf);
}

module.exports = { UUID, bad, wrap, idParam, V, patchSql, sendPdf, checkFresh, assertFresh, fresh, listLimit, withTotal };
