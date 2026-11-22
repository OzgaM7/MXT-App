'use strict';
// Odczyty (dział Podzielniki i Montaże): terminy i wykonanie odczytów obiektów, przypomnienia z wyprzedzeniem.
// Wartości odczytów nie są przechowywane – tylko kto, kiedy i czy odczyt był pełny (decyzja MXT).
const { pool } = require('../db');
const { notify } = require('./notify');

const SCOPE = { podzielniki: 'Podzielniki', wodomierze: 'Wodomierze', cieplomierze: 'Ciepłomierze', wszystkie: 'Wszystkie urządzenia', inne: 'Inne' };
const METHOD = { radiowy: 'Radiowy', wizualny: 'Wizualny (w lokalach)', zdalny: 'Zdalny (system)', inny: 'Inny' };
const RESULT = { pelny: 'Pełny', czesciowy: 'Częściowy' };
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;

async function settings(client = pool) {
  const r = await client.query(`SELECT value FROM system_settings WHERE key = 'readings'`);
  const v = r.rows[0] ? r.rows[0].value : {};
  return { remind_days: Number.isInteger(v.remind_days) && v.remind_days >= 0 ? v.remind_days : 14,
    cycle_months: Number.isInteger(v.cycle_months) && v.cycle_months > 0 ? v.cycle_months : 12 };
}
// Wyliczane oznaczenia (alias s – harmonogram); $1 = domyślne wyprzedzenie przypomnień.
const FLAGS = `(s.next_due - ${TODAY}) AS dni_do_terminu, coalesce(s.remind_days, $1::int) AS wyprzedzenie,
  (s.is_active AND s.next_due < ${TODAY}) AS po_terminie,
  (s.is_active AND s.next_due >= ${TODAY} AND s.next_due - ${TODAY} <= coalesce(s.remind_days, $1::int)) AS wkrotce`;

const ROLE_SQL = roles => `u.is_active AND (u.role = ANY('{${roles}}') OR u.extra_roles && '{${roles}}')`;
const usersWith = async (roles, client = pool) => (await client.query(`SELECT u.id FROM users u WHERE ${ROLE_SQL(roles)}`)).rows.map(r => r.id);
// Odbiorcy przypomnienia: osoba przypisana do obiektu; bez przypisania – zespół odczytów, a gdy go nie ma – kierownictwo.
async function recipients(s, client = pool) {
  if (s.assigned_to) {
    const ok = (await client.query('SELECT is_active FROM users WHERE id = $1', [s.assigned_to])).rows[0];
    if (ok && ok.is_active) return [s.assigned_to];
  }
  const team = await usersWith('odczyty', client);
  return team.length ? team : usersWith('administrator,kierownik', client);
}

const plDate = v => { const m = String(v || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const days = n => Math.abs(n) === 1 ? '1 dzień' : Math.abs(n) + ' dni';

// Przypomnienia (harmonogram co kilka minut). Klucz deduplikacji zawiera termin – po wykonaniu i ustawieniu nowego terminu cykl zaczyna się od nowa.
async function reminders() {
  const st = await settings();
  const q = await pool.query(`SELECT s.*, b.name AS building_name, b.address, b.city, (s.next_due - ${TODAY}) AS left_days FROM reading_schedules s
    JOIN buildings b ON b.id = s.building_id WHERE s.is_active AND s.next_due - ${TODAY} <= coalesce(s.remind_days, $1::int)`, [st.remind_days]);
  let sent = 0;
  const managers = await usersWith('administrator,kierownik');
  for (const s of q.rows) {
    const d = s.left_days, where = `${s.building_name}, ${s.address}${s.city ? ', ' + s.city : ''} · ${SCOPE[s.scope].toLowerCase()}`;
    const base = { kind: 'odczyt.termin', link: '/odczyty?z=' + s.id, related_type: 'reading_schedule', related_id: s.id };
    const who = await recipients(s);
    if (d > 0) sent += await notify(who, { ...base, title: `Za ${days(d)} odczyt: ${s.building_name}`, body: `${where} · termin ${plDate(s.next_due)}`, dedup: `odc:${s.id}:${s.next_due}:przed` });
    else if (d === 0) sent += await notify(who, { ...base, title: `Dziś termin odczytu: ${s.building_name}`, body: where, dedup: `odc:${s.id}:${s.next_due}:dzis` });
    else {
      const key = d <= -14 ? 'po14' : 'po';
      sent += await notify([...new Set([...who, ...managers])], { ...base, kind: 'odczyt.po_terminie', title: `Odczyt po terminie: ${s.building_name}`,
        body: `${where} · termin minął ${plDate(s.next_due)} (${days(d)} temu)`, dedup: `odc:${s.id}:${s.next_due}:${key}` });
    }
  }
  return sent;
}

module.exports = { SCOPE, METHOD, RESULT, TODAY, FLAGS, settings, recipients, reminders, usersWith, plDate };
