'use strict';
// Ubezpieczenia – rejestr podpisanych polis: zysk z marży, statusy, historia zmian, przypomnienia 30 dni przed końcem ochrony.
// Przypomnienie: dzień = koniec ochrony − 30 dni (Europe/Warsaw). Sprawdzanie co kilka minut (harmonogram w tle, także bez
// zalogowanych użytkowników); gdy serwer nie działał w tym dniu albo polisę dodano później, przypomnienie powstaje przy
// pierwszym sprawdzeniu, jeśli ochrona jeszcze trwa. Jedno przypomnienie na polisę i datę końca (UNIQUE w bazie).
// Bez przypomnień dla polis odnowionych i zakończonych.
const { pool } = require('../../db');
const { notify } = require('../notify');

const STATUS = { aktywna: 'Aktywna', konczy_sie: 'Zbliża się koniec', zakonczona: 'Zakończona', odnowiona: 'Odnowiona', anulowana: 'Anulowana (błędny wpis)' };
const REMIND_DAYS = 30;
const TZ = 'Europe/Warsaw';

// Zysk = kwota × marża % / 100, zaokrąglenie do groszy „połowa w górę” – arytmetyka całkowita (bez błędów zmiennoprzecinkowych),
// identyczna z kolumną wyliczaną w bazie (round(numeric, 2)).
function toScaled(v, scale, name) {
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) throw Object.assign(new Error(`${name}: podaj liczbę (np. 3000 lub 15,5).`), { status: 400 });
  const [i, f = ''] = s.split('.');
  if (f.length > scale && /[1-9]/.test(f.slice(scale))) throw Object.assign(new Error(`${name}: najwyżej ${scale} miejsc po przecinku.`), { status: 400 });
  return BigInt(i) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale) || '0');
}
function profit(amount, marginPct) {
  const a = toScaled(amount, 2, 'Kwota polisy'), m = toScaled(marginPct, 4, 'Marża');   // grosze, marża × 10 000
  const num = a * m, den = 1000000n;                                                        // grosze × marża% / 100
  const cents = (num + den / 2n) / den;
  return Number(cents) / 100;
}
const fmtDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const plDate = s => { const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
const daysWord = n => n === 1 ? 'dzień' : 'dni';

async function event(client, policyId, kind, { changes = {}, note = '', userId = null } = {}) {
  await client.query('INSERT INTO policy_events (policy_id, kind, changes, note, created_by) VALUES ($1, $2, $3, $4, $5)', [policyId, kind, JSON.stringify(changes), String(note).slice(0, 1000), userId]);
}

// Odbiorcy: lista z ustawień działu (jeśli ustawiona) albo administratorzy, właściciele i kierownicy; zawsze także osoba, która zarejestrowała polisę.
async function settings(client = pool) {
  const r = (await client.query(`SELECT value FROM system_settings WHERE key = 'insurance'`)).rows[0];
  const v = r ? r.value : {};
  return { recipients: Array.isArray(v.recipients) ? v.recipients : [] };
}
async function recipients(client, policy) {
  const s = await settings(client);
  const base = s.recipients.length ? s.recipients
    : (await client.query(`SELECT id FROM users WHERE is_active AND (role IN ('administrator', 'wlasciciel', 'kierownik') OR extra_roles && '{wlasciciel,kierownik}')`)).rows.map(x => x.id);
  return [...new Set([...base, policy.created_by].filter(Boolean))];
}

/** Sprawdza polisy i generuje przypomnienia. now – do testów (symulacja daty). Zwraca liczbę nowych przypomnień. */
async function tick(now = new Date()) {
  const today = fmtDate(now);
  const due = (await pool.query(`SELECT p.*, c.name AS customer_name FROM policies p JOIN customers c ON c.id = p.customer_id
    WHERE p.renewed_by IS NULL AND p.closed_at IS NULL AND p.cancelled_at IS NULL AND p.end_date >= $1::date AND p.end_date - ${REMIND_DAYS} <= $1::date
      AND NOT EXISTS (SELECT 1 FROM policy_reminders r WHERE r.policy_id = p.id AND r.kind = '30_dni' AND r.end_date = p.end_date)
    ORDER BY p.end_date LIMIT 500`, [today])).rows;
  let created = 0;
  for (const p of due) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const daysLeft = Math.round((new Date(String(p.end_date).slice(0, 10) + 'T12:00:00Z') - new Date(today + 'T12:00:00Z')) / 864e5);
      const ins = await client.query(`INSERT INTO policy_reminders (policy_id, kind, end_date, due_date, generated_on, days_left)
        VALUES ($1, '30_dni', $2, $2::date - ${REMIND_DAYS}, $3, $4) ON CONFLICT (policy_id, kind, end_date) DO NOTHING RETURNING id`, [p.id, p.end_date, today, daysLeft]);
      if (!ins.rows[0]) { await client.query('ROLLBACK'); continue; }   // inna instancja zdążyła wcześniej – bez duplikatu
      const to = await recipients(client, p);
      const title = `Polisa kończy się za ${daysLeft} ${daysWord(daysLeft)}: ${p.customer_name}`.slice(0, 200);
      const body = `Polisa ${p.number} · ${p.insurer} · ${p.insurance_type} · koniec ochrony ${plDate(p.end_date)} (zostało ${daysLeft} ${daysWord(daysLeft)}).`;
      const n = await notify(to, { kind: 'polisa.koniec', title, body, link: `/dzial/ubezpieczenia?tab=odnowienia&p=${p.id}`, related_type: 'policy', related_id: p.id, dedup: `polisa:${p.id}:${String(p.end_date).slice(0, 10)}` }, { client });
      await client.query('UPDATE policy_reminders SET recipients = $2 WHERE id = $1', [ins.rows[0].id, n]);
      await event(client, p.id, 'przypomnienie', { note: `Przypomnienie: koniec ochrony za ${daysLeft} ${daysWord(daysLeft)} (${n} odbiorców).` });
      await client.query('COMMIT');
      created++;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('przypomnienie o polisie', p.id, e.message); }
    finally { client.release(); }
  }
  // Ślad dziennego sprawdzenia (jeden wpis na dzień).
  await pool.query(`INSERT INTO scheduled_runs (job, run_date) VALUES ('polisy_przypomnienia', $1) ON CONFLICT DO NOTHING`, [today]).catch(() => {});
  return created;
}

module.exports = { STATUS, REMIND_DAYS, profit, toScaled, event, settings, recipients, tick, fmtDate };
