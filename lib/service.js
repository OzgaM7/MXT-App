'use strict';
// Zlecenia serwisowe – wspólna logika dla biura i serwisanta: statusy i dozwolone przejścia, terminy, flagi „po terminie”,
// historia działań, powiadomienia, przypomnienia (z deduplikacją), zdjęcia i protokół serwisowy (PDF z podpisem).
// Status realizacji i przekroczenie terminu to dwie różne informacje: flagi są wyliczane, nie zapisywane w statusie.
const { pool } = require('../db');
const { notify } = require('./notify');
const docs = require('./docs');

const ST = {
  nowe: 'Nowe', oczekuje: 'Oczekuje na przydzielenie', przypisane: 'Przypisane', zaplanowane: 'Zaplanowane', w_realizacji: 'W realizacji',
  ponowna_wizyta: 'Wymaga ponownej wizyty', wykonane: 'Wykonane', zatwierdzone: 'Zatwierdzone', rozliczone: 'Rozliczone', zamkniete: 'Zamknięte', anulowane: 'Anulowane'
};
const PRIORITY = { niski: 'Niski', normalny: 'Normalny', wysoki: 'Wysoki', pilny: 'Pilny' };
const UNASSIGNED = ['nowe', 'oczekuje'];
const ACTIVE = ['przypisane', 'zaplanowane', 'w_realizacji', 'ponowna_wizyta'];
const CLOSED = ['wykonane', 'zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'];
// Przejścia dostępne serwisantowi (wykonanie tylko przez protokół).
const TECH_FLOW = {
  przypisane: ['zaplanowane', 'w_realizacji'],
  zaplanowane: ['zaplanowane', 'w_realizacji'],
  w_realizacji: ['ponowna_wizyta'],
  ponowna_wizyta: ['zaplanowane', 'w_realizacji']
};
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;
const FLAGS = `(o.status IN ('nowe','oczekuje')) AS nieprzypisane,
  (o.assign_due - ${TODAY}) AS dni_do_przydzialu,
  (o.status IN ('nowe','oczekuje') AND o.assign_due < ${TODAY}) AS po_terminie_przydzialu,
  (o.status IN ('nowe','oczekuje') AND o.assign_due >= ${TODAY} AND o.assign_due - ${TODAY} <= 3) AS przydzial_wkrotce,
  (o.due_date IS NOT NULL AND o.due_date < ${TODAY} AND o.status NOT IN ('wykonane','zatwierdzone','rozliczone','zamkniete','anulowane')) AS po_terminie_realizacji,
  (o.status NOT IN ('wykonane','zatwierdzone','rozliczone','zamkniete','anulowane') AND (o.priority = 'pilny' OR (o.status IN ('nowe','oczekuje') AND o.assign_due < ${TODAY})
    OR (o.due_date IS NOT NULL AND o.due_date < ${TODAY}))) AS pilne`;

const err = (status, message) => Object.assign(new Error(message), { status });
const plDate = v => {
  if (!v) return '';
  const s = v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
};
const where = o => [o.client_name, [o.address, o.unit ? 'lok. ' + o.unit : ''].filter(Boolean).join(' '), o.city].filter(Boolean).join(', ');
const officeLink = id => `/dzial/podzielniki-i-montaze?tab=serwisy&z=${id}`;
const techLink = id => `/moje-serwisy?z=${id}`;

async function settings(client = pool) {
  const r = await client.query(`SELECT value FROM system_settings WHERE key = 'service'`);
  const v = r.rows[0] ? r.rows[0].value : {};
  return { assign_days: Number.isInteger(v.assign_days) && v.assign_days > 0 ? v.assign_days : 14,
    remind_days: Array.isArray(v.remind_days) ? v.remind_days.filter(n => Number.isInteger(n) && n > 0) : [3, 1] };
}
// Termin graniczny przydzielenia: data otrzymania + N dni kalendarzowych.
async function assignDue(receivedAt, client = pool) {
  const s = await settings(client);
  return (await client.query(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [receivedAt, s.assign_days])).rows[0].d;
}

const ROLE_SQL = roles => `u.is_active AND (u.role = ANY('{${roles}}') OR u.extra_roles && '{${roles}}')`;
// Serwisanci (aktywne konta z rolą serwisant) z liczbą otwartych zleceń – do przydzielania i oceny obciążenia.
async function technicians(client = pool) {
  const q = await client.query(`SELECT u.id, u.login, u.full_name, u.phone,
      (SELECT count(*)::int FROM service_orders o WHERE o.assigned_to = u.id AND o.status IN ('przypisane','zaplanowane','w_realizacji','ponowna_wizyta')) AS otwarte
    FROM users u WHERE ${ROLE_SQL('serwisant')} ORDER BY u.full_name, u.login`);
  return q.rows;
}
async function isTechnician(userId, client = pool) {
  return !!(await client.query(`SELECT 1 FROM users u WHERE u.id = $1 AND ${ROLE_SQL('serwisant')}`, [userId])).rows[0];
}
// Osoby odpowiedzialne za przydziały i zatwierdzanie (administrator, kierownik) – odbiorcy przypomnień o terminach.
async function managers(client = pool) {
  return (await client.query(`SELECT u.id FROM users u WHERE ${ROLE_SQL('administrator,kierownik')}`)).rows.map(r => r.id);
}

async function event(client, orderId, kind, { from = null, to = null, note = '', data = {}, userId = null } = {}) {
  await client.query(`INSERT INTO service_events (order_id, kind, from_status, to_status, note, data, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orderId, kind, from, to, String(note || '').slice(0, 2000), JSON.stringify(data || {}), userId]);
}
async function setStatus(client, o, to, { userId, note = '', data = {}, extra = {} } = {}) {
  const keys = Object.keys(extra);
  const x = (await client.query(`UPDATE service_orders SET status = $2${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [o.id, to, ...keys.map(k => extra[k])])).rows[0];
  await event(client, o.id, 'status', { from: o.status, to, note, data, userId });
  return x;
}

// Powiadomienia: serwisant (przydział, terminy, anulowanie) i kierownictwo (ponowna wizyta, do zatwierdzenia, terminy).
const toTech = (client, o, kind, title, body) => o.assigned_to
  ? notify([o.assigned_to], { kind, title, body: body || where(o), link: techLink(o.id), related_type: 'service_order', related_id: o.id }, { client }) : 0;
async function toManagers(client, o, kind, title, body, dedup) {
  return notify(await managers(client), { kind, title, body: body || where(o), link: officeLink(o.id), related_type: 'service_order', related_id: o.id, dedup }, { client });
}

// ---------- zdjęcia ----------
const MAX_PHOTO = 2.5 * 1024 * 1024, MAX_PHOTOS = 30;
function imageOf(b64) {
  const s = String(b64 || '').replace(/^data:image\/[a-z]+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) throw err(400, 'Nieprawidłowe zdjęcie.');
  const buf = Buffer.from(s, 'base64');
  if (!buf.length || buf.length > MAX_PHOTO) throw err(400, 'Zdjęcie jest za duże (maks. 2,5 MB po zmniejszeniu).');
  const mime = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF ? 'image/jpeg'
    : buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) ? 'image/png'
    : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
  if (!mime) throw err(400, 'Dozwolone są zdjęcia JPEG, PNG lub WebP.');
  return { buf, mime };
}
async function addPhoto(client, o, b64, caption, userId) {
  if (['zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'].includes(o.status)) throw err(409, 'Zlecenie jest zamknięte – nie można dodawać zdjęć.');
  const n = (await client.query('SELECT count(*)::int n FROM service_photos WHERE order_id = $1', [o.id])).rows[0].n;
  if (n >= MAX_PHOTOS) throw err(409, `Najwyżej ${MAX_PHOTOS} zdjęć w jednym zleceniu.`);
  const { buf, mime } = imageOf(b64);
  const p = (await client.query(`INSERT INTO service_photos (order_id, mime, data, size, caption, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, mime, size, caption, created_at`,
    [o.id, mime, buf, buf.length, String(caption || '').slice(0, 200), userId])).rows[0];
  await event(client, o.id, 'zdjecie', { note: p.caption, data: { zdjecie: p.id, rozmiar: buf.length }, userId });
  return p;
}

// ---------- protokół serwisowy (PDF) ----------
function signatureOf(v) {
  if (!v) return null;
  const s = String(v);
  if (!s.startsWith('data:image/png;base64,')) throw err(400, 'Podpis: nieprawidłowy format.');
  const buf = Buffer.from(s.slice(22), 'base64');
  if (buf.length < 100 || buf.length > 400 * 1024 || !buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) throw err(400, 'Podpis: nieprawidłowy obraz.');
  return buf;
}
async function protocol(client, o, input, user) {
  if (!['przypisane', 'zaplanowane', 'w_realizacji', 'ponowna_wizyta'].includes(o.status)) throw err(409, 'Protokół sporządza się dla zlecenia w realizacji (albo przypisanego).');
  const b = input || {}, str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const works = str(b.czynnosci, 4000);
  if (works.length < 3) throw err(400, 'Opisz wykonane czynności.');
  const signature = signatureOf(b.podpis), confirmer = str(b.potwierdzajacy, 120);
  if (signature && !confirmer) throw err(400, 'Podaj imię i nazwisko osoby, która podpisała protokół.');
  const tech = (await client.query('SELECT login, full_name FROM users WHERE id = $1', [o.assigned_to || user.id])).rows[0] || {};
  const photos = (await client.query('SELECT count(*)::int n FROM service_photos WHERE order_id = $1', [o.id])).rows[0].n;
  let docId = o.protocol_document_id, number;
  if (!docId) {
    number = await docs.nextNumber(client, 'PS');
    docId = (await docs.createDocument(client, { kind: 'protokol', title: `Protokół serwisowy ${number}`, department_id: 'podzielniki-i-montaze', related_type: 'service_order', related_id: o.id, userId: user.id })).id;
  } else number = (await client.query('SELECT title FROM documents WHERE id = $1', [docId])).rows[0].title.replace('Protokół serwisowy ', '');
  const data = { number, order: o.number, date: new Date().toISOString().slice(0, 10), received_at: o.received_at, client: o.client_name || '–',
    address: [o.address, o.unit ? 'lok. ' + o.unit : '', o.city].filter(Boolean).join(', '), contact: [o.contact_name, o.contact_phone].filter(Boolean).join(', '),
    description: o.description, works, parts: str(b.uzyte, 2000), notes: str(b.uwagi, 2000), technician: tech.full_name || tech.login || '–', confirmer, photos };
  const file = await require('./pdf').serviceProtocol({ ...data, signature });
  const v = await docs.addVersion(client, docId, { content: data, file, fileName: number.replace(/\//g, '-') + '.pdf', mime: 'application/pdf', note: 'Protokół serwisowy', userId: user.id });
  const x = await setStatus(client, o, 'wykonane', { userId: user.id, note: works, data: { protokol: number, wersja: v, potwierdzil: confirmer || null },
    extra: { completed_at: new Date(), protocol_document_id: docId, signature_png: signature } });
  await toManagers(client, x, 'serwis.do_zatwierdzenia', `Do zatwierdzenia: serwis ${o.number}`, `${where(o)} · protokół ${number}${confirmer ? ', potwierdził: ' + confirmer : ''}`);
  return { order: x, document_id: docId, number, version: v };
}

// ---------- przypomnienia (harmonogram, co kilka minut; deduplikacja kluczem) ----------
async function reminders() {
  const s = await settings();
  let sent = 0;
  const mgr = await managers();
  const un = await pool.query(`SELECT o.*, (o.assign_due - ${TODAY}) AS left_days FROM service_orders o WHERE o.status IN ('nowe','oczekuje')`);
  for (const o of un.rows) {
    const d = o.left_days;
    let key, title;
    if (d < 0) { key = d <= -7 ? 'po7' : 'po'; title = `Po terminie przydziału: serwis ${o.number}`; }
    else if (d === 0) { key = '0'; title = `Dziś mija termin przydziału: serwis ${o.number}`; }
    else if (s.remind_days.includes(d)) { key = 'd' + d; title = `${d === 1 ? 'Jutro' : `Za ${d} dni`} mija termin przydziału: serwis ${o.number}`; }
    else continue;
    sent += await notify(mgr, { kind: 'serwis.termin_przydzialu', title, body: `${where(o)} · przydziel serwisanta do ${plDate(o.assign_due)} (otrzymano ${plDate(o.received_at)}).`,
      link: officeLink(o.id), related_type: 'service_order', related_id: o.id, dedup: `sr:${o.id}:przydzial:${key}` });
  }
  const due = await pool.query(`SELECT o.*, (o.due_date - ${TODAY}) AS left_days FROM service_orders o
    WHERE o.status IN ('przypisane','zaplanowane','w_realizacji','ponowna_wizyta') AND o.due_date IS NOT NULL AND o.due_date - ${TODAY} <= 1`);
  for (const o of due.rows) {
    const d = o.left_days;
    if (d >= 0) sent += await notify([o.assigned_to], { kind: 'serwis.termin_realizacji', title: `Termin realizacji ${d ? 'jutro' : 'dziś'}: serwis ${o.number}`,
      body: where(o), link: techLink(o.id), related_type: 'service_order', related_id: o.id, dedup: `sr:${o.id}:realizacja:${d}:${plDate(o.due_date)}` });
    else {
      const body = `${where(o)} · termin realizacji minął ${plDate(o.due_date)}.`;
      sent += await notify([o.assigned_to], { kind: 'serwis.po_terminie', title: `Po terminie realizacji: serwis ${o.number}`, body, link: techLink(o.id),
        related_type: 'service_order', related_id: o.id, dedup: `sr:${o.id}:realizacja:po:${plDate(o.due_date)}` });
      sent += await notify(mgr.filter(id => id !== o.assigned_to), { kind: 'serwis.po_terminie', title: `Po terminie realizacji: serwis ${o.number}`, body, link: officeLink(o.id),
        related_type: 'service_order', related_id: o.id, dedup: `sr:${o.id}:realizacja:po:${plDate(o.due_date)}` });
    }
  }
  return sent;
}

module.exports = { ST, PRIORITY, UNASSIGNED, ACTIVE, CLOSED, TECH_FLOW, TODAY, FLAGS, settings, assignDue, technicians, isTechnician, managers,
  event, setStatus, toTech, toManagers, addPhoto, protocol, reminders, plDate, where, officeLink, techLink, err };
