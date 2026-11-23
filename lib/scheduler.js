'use strict';
// Harmonogram: dzienny raport Zarządu AI o godzinie ustawionej przez administratora (strefa czasowa z ustawień).
// Jedno uruchomienie na dzień gwarantuje tabela scheduled_runs (także przy kilku instancjach serwera).
const { pool } = require('../db');
const jobs = require('./jobs');
const { audit } = require('./audit');
const events = require('./events');

const DEFAULTS = { enabled: false, time: '07:30', timezone: 'Europe/Warsaw', recipients: [] };

async function settings() {
  const r = await pool.query(`SELECT value, updated_at FROM system_settings WHERE key = 'daily_report'`);
  return { ...DEFAULTS, ...(r.rows[0] ? r.rows[0].value : {}), updated_at: r.rows[0] && r.rows[0].updated_at };
}

// Lokalna data i godzina w strefie raportu.
function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function tick(now = new Date()) {
  const s = await settings();
  if (!s.enabled) return null;
  const l = localNow(s.timezone, now);
  if (l.time < s.time) return null;
  const ins = await pool.query(`INSERT INTO scheduled_runs (job, run_date) VALUES ('raport_dzienny', $1) ON CONFLICT DO NOTHING RETURNING run_date`, [l.date]);
  if (!ins.rows[0]) return null;
  const id = await jobs.enqueue('raport_dzienny', { date: l.date, trigger: 'harmonogram' }, { maxAttempts: 3 });
  await pool.query(`UPDATE scheduled_runs SET job_id = $2 WHERE job = 'raport_dzienny' AND run_date = $1`, [l.date, id]);
  return id;
}

jobs.register('raport_dzienny', async ({ date, trigger, user_id }) => {
  const board = require('./ai/board');
  const user = user_id ? (await pool.query('SELECT id, login, role FROM users WHERE id = $1', [user_id])).rows[0] : null;
  let rep;
  try { rep = await board.report(user ? { ...user, type: 'user' } : null, { ip: null, user }, { daily: true }); }
  catch (e) {
    await audit({ user: null }, 'raport_dzienny', { actor: { type: 'system', id: 'harmonogram', login: 'harmonogram' }, status: 'blad', details: { blad: e.message, data: date } });
    if (e.status && e.status < 500) throw Object.assign(e, { permanent: true });   // np. agenci zatrzymani – bez ponawiania
    throw e;
  }
  const s = await settings(), mail = require('./mail');
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  for (const to of s.recipients || []) {
    await mail.queue({ to, subject: `[MXT] ${rep.title}`, related_type: 'board_report', related_id: rep.id,
      text: `${rep.content}\n\n—\nDzienny raport Zarządu AI (${trigger === 'reczne' ? 'uruchomiony ręcznie' : 'harmonogram ' + s.time + ' ' + s.timezone}).${base ? '\nAI Board: ' + base + '/ai-board' : ''}` });
  }
  await audit({ user: null }, 'raport_dzienny', { actor: { type: 'system', id: 'harmonogram', login: 'harmonogram' }, resource: 'board_reports', resourceId: rep.id, details: { data: date, odbiorcy: (s.recipients || []).length, tryb: trigger } });
  await events.emit('raport.dzienny', { tytul: rep.title, data: date });
  return { report_id: rep.id, recipients: (s.recipients || []).length };
});

let timer = null, svcTimer = null;
function start(intervalMs = +process.env.SCHEDULER_TICK_MS || 30000) {
  if (timer) return;
  timer = setInterval(() => tick().catch(e => console.error('harmonogram:', e.message)), intervalMs);
  timer.unref();
  // Przypomnienia o terminach zleceń serwisowych (przydział 14 dni, realizacja) – co kilka minut, bez powtórzeń (klucze deduplikacji).
  // Ten sam rytm obsługuje przypomnienia o odczytach (wyprzedzenie ustawiane per obiekt lub domyślnie).
  const svc = () => Promise.all([
    require('./service').reminders().catch(e => console.error('przypomnienia serwisowe:', e.message)),
    require('./readings').reminders().catch(e => console.error('przypomnienia o odczytach:', e.message)),
    // Ubezpieczenia: przypomnienie 30 dni przed końcem ochrony (jedno na polisę i datę końca, nadrabiane po przerwie).
    require('./erp/policies').tick().catch(e => console.error('przypomnienia o polisach:', e.message)),
    // RODO: transkrypcje rozmów asystenta telefonicznego tylko przez ustawiony okres (domyślnie 90 dni).
    require('./phone').purgeTranscripts().catch(e => console.error('transkrypcje asystenta:', e.message))
  ]);
  setTimeout(svc, 15000).unref();
  svcTimer = setInterval(svc, +process.env.SERVICE_REMINDERS_MS || 5 * 60000);
  svcTimer.unref();
}

module.exports = { settings, tick, start, localNow, DEFAULTS };
