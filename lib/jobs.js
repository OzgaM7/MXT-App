'use strict';
// Kolejka zadań w tle na PostgreSQL (FOR UPDATE SKIP LOCKED): wysyłka poczty, automatyzacje, raport dzienny,
// eksport monitoringu AI. Ponawianie z rosnącym odstępem (1, 2, 4, 8 … min), maks. `max_attempts` prób.
// Odpowiednik kolejki Redis zgodny z obecną architekturą (jedna baza, bez dodatkowej usługi).
const { pool } = require('../db');

const handlers = {};
const register = (kind, fn) => { handlers[kind] = fn; };

async function enqueue(kind, payload = {}, { runAt = null, maxAttempts = 5, client = pool } = {}) {
  const r = await client.query(`INSERT INTO jobs (kind, payload, run_at, max_attempts) VALUES ($1, $2, coalesce($3, now()), $4) RETURNING id`,
    [kind, JSON.stringify(payload), runAt, maxAttempts]);
  return r.rows[0].id;
}

async function runOne(onlyId = null) {
  const client = await pool.connect();
  let job;
  try {
    await client.query('BEGIN');
    job = (await client.query(onlyId
      ? `SELECT * FROM jobs WHERE id = $1 AND status = 'oczekuje' FOR UPDATE SKIP LOCKED`
      : `SELECT * FROM jobs WHERE status = 'oczekuje' AND run_at <= now() ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1`, onlyId ? [onlyId] : [])).rows[0];
    if (job) await client.query(`UPDATE jobs SET status = 'w_toku', locked_at = now(), attempts = attempts + 1 WHERE id = $1`, [job.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  if (!job) return false;
  const fn = handlers[job.kind];
  try {
    if (!fn) throw new Error('Brak obsługi zadania typu ' + job.kind);
    const result = await fn(job.payload, job);
    await pool.query(`UPDATE jobs SET status = 'ok', result = $2, finished_at = now(), last_error = NULL WHERE id = $1`, [job.id, JSON.stringify(result == null ? {} : result)]);
  } catch (e) {
    const attempts = job.attempts + 1, final = attempts >= job.max_attempts || e.permanent;
    await pool.query(`UPDATE jobs SET status = $2, last_error = $3, run_at = now() + make_interval(mins => $4), finished_at = CASE WHEN $2 = 'blad' THEN now() END WHERE id = $1`,
      [job.id, final ? 'blad' : 'oczekuje', String(e.message || e).slice(0, 2000), 2 ** (attempts - 1)]);
    if (final && handlers['_failed']) await handlers['_failed'](job, e).catch(() => {});
  }
  return true;
}

// Zadania „w toku” dłużej niż 10 min (np. po restarcie serwera) wracają do kolejki.
const recover = () => pool.query(`UPDATE jobs SET status = 'oczekuje' WHERE status = 'w_toku' AND locked_at < now() - interval '10 minutes'`).catch(() => {});

let timer = null, busy = false;
function start(intervalMs = +process.env.JOBS_POLL_MS || 3000) {
  if (timer) return;
  recover();
  timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { for (let i = 0; i < 20 && await runOne(); i++); } catch (e) { console.error('kolejka:', e.message); } finally { busy = false; }
  }, intervalMs);
  timer.unref();
}
// Do testów i przycisku „Przetwórz teraz”: przetwarza wszystkie gotowe zadania.
async function drain(max = 50) { let n = 0; while (n < max && await runOne()) n++; return n; }
// Wykonuje od razu wskazane zadanie (jeśli nie przejęła go już inna instancja) i czeka na jego wynik.
async function runNow(id, waitMs = 60000) {
  await runOne(id);
  const end = Date.now() + waitMs;
  for (;;) {
    const j = (await pool.query('SELECT status, last_error, result FROM jobs WHERE id = $1', [id])).rows[0];
    if (!j || ['ok', 'blad'].includes(j.status) || Date.now() > end) return j;
    await new Promise(r => setTimeout(r, 200));
  }
}

module.exports = { register, enqueue, start, drain, runOne, runNow };
