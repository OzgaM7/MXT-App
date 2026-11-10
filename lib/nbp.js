'use strict';
// Kursy walut wyłącznie z autoryzowanego źródła: API NBP (tabela A, kursy średnie) z datą i numerem tabeli.
// Wpis ręczny jest możliwy tylko dla administratora i jest oznaczany źródłem „ręcznie: <login>”.
const { pool } = require('../db');

const BASE = () => (process.env.NBP_API_URL || 'https://api.nbp.pl/api').replace(/\/$/, '');
const SOURCE = 'NBP tabela A';

async function fetchTableA() {
  const res = await fetch(BASE() + '/exchangerates/tables/A/?format=json', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('NBP odpowiedziało kodem ' + res.status);
  const [t] = await res.json();
  if (!t || !Array.isArray(t.rates) || !/^\d{4}-\d{2}-\d{2}$/.test(t.effectiveDate || '')) throw new Error('Nieoczekiwany format odpowiedzi NBP');
  let n = 0;
  for (const r of t.rates) {
    if (!/^[A-Z]{3}$/.test(r.code || '') || !(Number(r.mid) > 0)) continue;
    await pool.query(`INSERT INTO currency_rates (code, rate_pln, effective_date, table_no, source) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (code, effective_date, source) DO UPDATE SET rate_pln = excluded.rate_pln, table_no = excluded.table_no, fetched_at = now()`,
      [r.code, r.mid, t.effectiveDate, String(t.no || ''), SOURCE]);
    n++;
  }
  return { table: t.no, date: t.effectiveDate, count: n };
}

// Kurs obowiązujący na dzień (ostatni opublikowany nie później niż `date`). PLN = 1.
async function rateFor(code, date) {
  code = String(code || '').toUpperCase();
  if (code === 'PLN') return { code, rate_pln: 1, effective_date: date || new Date().toISOString().slice(0, 10), source: 'PLN', table_no: '' };
  const r = await pool.query(`SELECT code, rate_pln::float AS rate_pln, effective_date, source, table_no FROM currency_rates
    WHERE code = $1 AND effective_date <= coalesce($2::date, current_date)
    ORDER BY effective_date DESC, (source = $3) DESC, fetched_at DESC LIMIT 1`, [code, date || null, SOURCE]);
  if (!r.rows[0]) { const e = new Error(`Brak kursu ${code} w bazie. Pobierz kursy NBP w zakładce Kursy walut.`); e.status = 409; throw e; }
  return r.rows[0];
}

async function latest() {
  const r = await pool.query(`SELECT DISTINCT ON (code) code, rate_pln::float AS rate_pln, effective_date, source, table_no, fetched_at
    FROM currency_rates ORDER BY code, effective_date DESC, (source = $1) DESC, fetched_at DESC`, [SOURCE]);
  return r.rows;
}

module.exports = { fetchTableA, rateFor, latest, SOURCE };
