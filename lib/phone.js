'use strict';
// Asystent telefoniczny (MXT Recepcja AI): przyjęcie rozmowy od bota, zgłoszenia z telefonu, wskaźniki, klucz webhooka.
// Bot (Pipecat/Twilio) wysyła po każdej rozmowie jedno zdarzenie. Wizyta serwisowa staje się od razu zleceniem
// w module Serwisy (status „Nowe” – do weryfikacji przez biuro), pozostałe sprawy trafiają do kolejki zgłoszeń.
const crypto = require('crypto');
const { pool } = require('../db');
const { notify } = require('./notify');
const { audit } = require('./audit');
const S = require('./service');
const docs = require('./docs');
const { V, bad } = require('../routes/_util');

// MXT nie prowadzi działalności taksówkowej: starsza wartość „taxi” od bota jest przyjmowana jako „inne” (dane historyczne bez zmian).
const DEPTS = ['podzielniki', 'ubezpieczenia', 'czesci', 'inne'];
const legacy = v => v === 'taxi' ? 'inne' : v;
const OUTCOMES = ['rezerwacja', 'zgloszenie', 'przekazanie', 'oddzwonienie', 'informacja', 'przerwana'];
const KINDS = ['wizyta_serwisowa', 'rozmowa_agent', 'zapytanie_czesci', 'oddzwonienie', 'inne'];
const REQ_STATUS = ['nowe', 'w_toku', 'zalatwione', 'anulowane'];
const SUCCESS = ['rezerwacja', 'zgloszenie', 'oddzwonienie'];   // KPI planu: rozmowa zakończona rezerwacją lub zgłoszeniem
const KIND_LABEL = { wizyta_serwisowa: 'Wizyta serwisowa', rozmowa_agent: 'Rozmowa z agentem', zapytanie_czesci: 'Zapytanie o części',
  oddzwonienie: 'Prośba o oddzwonienie', inne: 'Inna sprawa' };
const SYSTEM = { type: 'system', id: 'asystent-telefoniczny', login: 'asystent telefoniczny' };
const fmt = d => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---------- ustawienia i klucz webhooka (w bazie tylko skrót klucza) ----------
async function settings(client = pool) {
  const v = ((await client.query(`SELECT value FROM system_settings WHERE key = 'asystent'`)).rows[0] || {}).value || {};
  return { ...v, retention_days: Number.isInteger(v.retention_days) && v.retention_days >= 7 ? v.retention_days : 90 };
}
async function saveSettings(patch, userId, client = pool) {
  await client.query(`INSERT INTO system_settings (key, value, updated_by) VALUES ('asystent', $1, $2)
    ON CONFLICT (key) DO UPDATE SET value = system_settings.value || $1, updated_by = $2, updated_at = now()`, [JSON.stringify(patch), userId || null]);
}
async function newKey(userId) {
  const key = 'mxt_tel_' + crypto.randomBytes(24).toString('base64url');
  await saveSettings({ key_hash: sha(key), key_hint: key.slice(-4), key_created_at: new Date().toISOString(), key_created_by: userId, last_used_at: null }, userId);
  return key;
}
// Porównanie w stałym czasie; brak ustawionego klucza = każda próba odrzucona.
async function checkKey(token) {
  const s = await settings();
  if (!s.key_hash || typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const a = Buffer.from(sha(token), 'hex'), b = Buffer.from(s.key_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- walidacja danych od bota ----------
function ts(v, name, req = false) {
  if (v == null || v === '') { if (req) throw bad(400, `${name}: pole wymagane.`); return null; }
  const d = new Date(v);
  if (typeof v !== 'string' || isNaN(d) || d.getFullYear() < 2020 || d.getFullYear() > 2100) throw bad(400, `${name}: nieprawidłowa data i godzina (ISO 8601).`);
  return d.toISOString();
}
function details(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).slice(0, 20).filter(([k]) => /^[\p{L}\d_ -]{1,40}$/u.test(k))
    .map(([k, x]) => [k, V.str(typeof x === 'object' ? JSON.stringify(x) : x, 500)]));
}
function parse(b) {
  if (!b || typeof b !== 'object') throw bad(400, 'Brak danych rozmowy (JSON).');
  const started = ts(b.rozpoczeta, 'rozpoczeta', true), ended = ts(b.zakonczona, 'zakonczona');
  if (new Date(started) > new Date(Date.now() + 10 * 60000)) throw bad(400, 'rozpoczeta: data z przyszłości.');
  if (ended && ended < started) throw bad(400, 'zakonczona: wcześniej niż rozpoczęcie.');
  const dept = V.oneOf(legacy(b.dzial), DEPTS, 'dzial', 'inne'), outcome = V.oneOf(b.wynik, OUTCOMES, 'wynik', 'informacja'), phone = V.str(b.telefon, 40);
  const transcript = Array.isArray(b.transkrypcja) ? b.transkrypcja.slice(0, 2000).map((t, i) => {
    if (!t || typeof t !== 'object') throw bad(400, `transkrypcja[${i}]: nieprawidłowy wpis.`);
    const x = { rola: V.oneOf(t.rola, ['asystent', 'klient', 'system'], `transkrypcja[${i}].rola`), tekst: V.str(t.tekst, 4000) };
    if (t.czas) x.czas = ts(t.czas, `transkrypcja[${i}].czas`);
    return x;
  }) : null;
  const requests = (Array.isArray(b.zgloszenia) ? b.zgloszenia : []).slice(0, 20).map((z, i) => {
    if (!z || typeof z !== 'object') throw bad(400, `zgloszenia[${i}]: nieprawidłowy wpis.`);
    const n = `zgloszenia[${i}]`;
    return { kind: V.oneOf(legacy(z.rodzaj), KINDS, n + '.rodzaj'), department: V.oneOf(legacy(z.dzial), DEPTS, n + '.dzial', dept),
      caller_name: V.str(z.imie_nazwisko, 200), phone: V.str(z.telefon, 40) || phone, address: V.str(z.adres, 300), city: V.str(z.miasto, 100),
      unit: V.str(z.lokal, 40), description: V.str(z.opis, 4000), details: details(z.dane), urgent: z.pilne === true,
      slot_at: ts(z.termin, n + '.termin'), slot_minutes: z.czas_min == null ? null : Math.round(V.num(z.czas_min, 5, 480, n + '.czas_min')) };
  });
  return {
    call_sid: V.str(b.call_sid, 100, true, 'call_sid'), started_at: started, ended_at: ended,
    duration_s: ended ? Math.round((new Date(ended) - new Date(started)) / 1000) : (b.czas_s == null ? null : Math.round(V.num(b.czas_s, 0, 86400, 'czas_s'))),
    caller_phone: phone, department: dept, outcome, transferred: b.przekazana === true || outcome === 'przekazanie',
    summary: V.str(b.podsumowanie, 2000), transcript,
    avg_response_ms: b.sredni_czas_odpowiedzi_ms == null ? null : Math.round(V.num(b.sredni_czas_odpowiedzi_ms, 0, 600000, 'sredni_czas_odpowiedzi_ms')),
    is_test: b.test === true, requests
  };
}

// ---------- przyjęcie rozmowy (jedna transakcja, ten sam call_sid drugi raz nic nie dubluje) ----------
async function existing(callSid, client = pool) {
  const c = (await client.query('SELECT id FROM phone_calls WHERE call_sid = $1', [callSid])).rows[0];
  if (!c) return null;
  const rq = (await client.query(`SELECT r.id, r.kind, o.number FROM phone_requests r LEFT JOIN service_orders o ON o.id = r.service_order_id
    WHERE r.call_id = $1 ORDER BY r.created_at, r.id`, [c.id])).rows;
  return { rozmowa_id: c.id, ponownie: true, zgloszenia: rq.map(r => ({ id: r.id, rodzaj: r.kind, zlecenie_serwisowe: r.number || null })) };
}

async function serviceOrder(client, call, r) {
  const received = (await client.query(`SELECT to_char(($1::timestamptz AT TIME ZONE 'Europe/Warsaw')::date, 'YYYY-MM-DD') d`, [call.started_at])).rows[0].d;
  const due = r.slot_at ? (await client.query(`SELECT to_char(($1::timestamptz AT TIME ZONE 'Europe/Warsaw')::date, 'YYYY-MM-DD') d`, [r.slot_at])).rows[0].d : null;
  const extra = Object.entries(r.details).map(([k, v]) => `${k}: ${v}`).join('; ');
  const description = [r.description || 'Wizyta serwisowa umówiona przez asystenta telefonicznego.',
    r.slot_at ? `Termin uzgodniony z klientem przez telefon: ${fmt(r.slot_at)} (${r.slot_minutes || 60} min).` : '',
    extra, `Źródło: asystent telefoniczny, rozmowa ${fmt(call.started_at)}${call.caller_phone ? ' z ' + call.caller_phone : ''}.`].filter(Boolean).join('\n').slice(0, 4000);
  const number = await docs.nextNumber(client, 'SR');
  const o = (await client.query(`INSERT INTO service_orders (number, status, received_at, assign_due, due_date, priority, client_name, address, city, unit,
      contact_name, contact_phone, description) VALUES ($1, 'nowe', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [number, received, await S.assignDue(received, client), due && due >= received ? due : null, r.urgent ? 'pilny' : 'normalny',
      r.caller_name, r.address, r.city, r.unit, r.caller_name, r.phone, description])).rows[0];
  await S.event(client, o.id, 'utworzenie', { to: 'nowe', note: 'Zgłoszenie z asystenta telefonicznego – do weryfikacji.',
    data: { zrodlo: 'asystent_telefoniczny', rozmowa: call.id, termin_uzgodniony: r.slot_at } });
  await S.toManagers(client, o, 'serwis.z_telefonu', `${r.urgent ? 'PILNE: ' : ''}Nowe zlecenie z telefonu ${number}`,
    `${[r.address, r.city].filter(Boolean).join(', ')}${r.slot_at ? ' · termin uzgodniony ' + fmt(r.slot_at) : ''}`, 'tel-so:' + o.id);
  return o;
}

async function ingest(body, { ip } = {}) {
  const d = parse(body);
  const dup = await existing(d.call_sid);
  if (dup) return { status: 200, body: dup };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const call = (await client.query(`INSERT INTO phone_calls (call_sid, started_at, ended_at, duration_s, caller_phone, department, outcome, transferred,
        summary, transcript, avg_response_ms, is_test) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (call_sid) DO NOTHING RETURNING *`,
      [d.call_sid, d.started_at, d.ended_at, d.duration_s, d.caller_phone, d.department, d.outcome, d.transferred, d.summary,
        d.transcript ? JSON.stringify(d.transcript) : null, d.avg_response_ms, d.is_test])).rows[0];
    if (!call) { await client.query('ROLLBACK'); return { status: 200, body: await existing(d.call_sid) }; }   // równoległe drugie wysłanie
    const out = [], managers = d.is_test ? [] : await S.managers(client);
    for (const r of d.requests) {
      const order = !d.is_test && r.kind === 'wizyta_serwisowa' && r.address ? await serviceOrder(client, call, r) : null;
      // Wizyta ze zleceniem serwisowym jest prowadzona w module Serwisy, a rozmowa testowa niczego nie zleca – obie od razu „załatwione”.
      const q = (await client.query(`INSERT INTO phone_requests (call_id, kind, department, caller_name, phone, address, city, unit, description, details, urgent,
          slot_at, slot_minutes, service_order_id, status, note, handled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [call.id, r.kind, r.department, r.caller_name, r.phone, r.address, r.city, r.unit, r.description, JSON.stringify(r.details), r.urgent,
          r.slot_at, r.slot_minutes, order ? order.id : null, order || d.is_test ? 'zalatwione' : 'nowe',
          order ? `Przekazano do modułu Serwisy jako zlecenie ${order.number}.` : d.is_test ? 'Rozmowa testowa – bez zlecenia i powiadomień.' : '',
          order || d.is_test ? new Date().toISOString() : null])).rows[0];
      // Sprawy bez zlecenia serwisowego: powiadomienie kierownictwa z linkiem do kolejki zgłoszeń.
      if (!order && managers.length) await notify(managers, { kind: 'asystent.zgloszenie',
        title: `${r.urgent ? 'PILNE: ' : ''}${KIND_LABEL[r.kind]} z telefonu${r.caller_name ? ' – ' + r.caller_name : ''}`,
        body: [r.phone, r.slot_at ? 'termin ' + fmt(r.slot_at) : '', r.description].filter(Boolean).join(' · ').slice(0, 300),
        link: `/dzial/asystent-telefoniczny?tab=zgloszenia&z=${q.id}`, related_type: 'phone_request', related_id: q.id, dedup: 'tel-rq:' + q.id }, { client });
      out.push({ id: q.id, rodzaj: r.kind, zlecenie_serwisowe: order ? order.number : null });
    }
    await audit({ user: SYSTEM, ip }, 'asystent.rozmowa', { resource: 'phone_calls', resourceId: call.id, client,
      details: { call_sid: d.call_sid, dzial: d.department, wynik: d.outcome, zgloszenia: out.length, zlecenia: out.filter(x => x.zlecenie_serwisowe).map(x => x.zlecenie_serwisowe), test: d.is_test } });
    await client.query('COMMIT');
    return { status: 201, body: { rozmowa_id: call.id, zgloszenia: out } };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// ---------- wskaźniki z planu (bez rozmów testowych) ----------
async function summary(days = 14) {
  const p = [days];
  const c = (await pool.query(`SELECT count(*)::int AS rozmowy,
      count(*) FILTER (WHERE outcome = ANY($2))::int AS skuteczne,
      count(*) FILTER (WHERE transferred)::int AS przekazane,
      count(*) FILTER (WHERE review_status = 'blad_danych')::int AS bledy,
      count(*) FILTER (WHERE review_status <> 'nowa')::int AS sprawdzone,
      count(*) FILTER (WHERE review_status = 'nowa')::int AS do_przejrzenia,
      round(avg(avg_response_ms))::int AS czas_odpowiedzi_ms,
      round(avg(duration_s))::int AS sredni_czas_s
    FROM phone_calls WHERE NOT is_test AND started_at >= now() - make_interval(days => $1)`, [...p, SUCCESS])).rows[0];
  const byDept = (await pool.query(`SELECT department AS dzial, count(*)::int AS rozmowy, count(*) FILTER (WHERE outcome = ANY($2))::int AS skuteczne
    FROM phone_calls WHERE NOT is_test AND started_at >= now() - make_interval(days => $1) GROUP BY 1 ORDER BY 2 DESC`, [...p, SUCCESS])).rows;
  const rq = (await pool.query(`SELECT count(*) FILTER (WHERE r.status IN ('nowe','w_toku'))::int AS otwarte,
      count(*) FILTER (WHERE r.status IN ('nowe','w_toku') AND r.urgent)::int AS pilne_otwarte
    FROM phone_requests r JOIN phone_calls c ON c.id = r.call_id WHERE NOT c.is_test`)).rows[0];
  const pct = (a, b) => b ? Math.round(a * 1000 / b) / 10 : null;
  return { dni: days, ...c, ...rq, skutecznosc_pct: pct(c.skuteczne, c.rozmowy), przekazania_pct: pct(c.przekazane, c.rozmowy),
    bledy_pct: pct(c.bledy, c.sprawdzone), dzialy: byDept, cele: { skutecznosc_pct: 70, przekazania_pct: 20, bledy_pct: 2, czas_odpowiedzi_ms: 1500 } };
}

// ---------- RODO: transkrypcje przechowywane przez ustawioną liczbę dni (domyślnie 90) ----------
async function purgeTranscripts() {
  const { retention_days } = await settings();
  const r = await pool.query(`UPDATE phone_calls SET transcript = NULL, transcript_deleted_at = now()
    WHERE transcript IS NOT NULL AND started_at < now() - make_interval(days => $1)`, [retention_days]);
  return r.rowCount;
}

// Przykładowa rozmowa (do testu integracji i jako wzór dla bota).
function sample(test = true) {
  const t0 = new Date(Date.now() - 4 * 60000), slot = new Date(Date.now() + 2 * 864e5);
  slot.setUTCHours(8, 0, 0, 0);
  const at = s => new Date(t0.getTime() + s * 1000).toISOString();
  return { call_sid: (test ? 'TEST-' : 'CA') + crypto.randomBytes(8).toString('hex'), test, rozpoczeta: at(0), zakonczona: at(172), telefon: '+48600100200',
    dzial: 'podzielniki', wynik: 'rezerwacja', przekazana: false, sredni_czas_odpowiedzi_ms: 1180,
    podsumowanie: 'Podzielnik w kuchni nie pokazuje odczytu. Umówiona wizyta serwisowa.',
    transkrypcja: [
      { rola: 'asystent', tekst: 'Dzień dobry, tu Ola, wirtualna asystentka AI firmy MXT. W czym mogę pomóc?', czas: at(1) },
      { rola: 'klient', tekst: 'Dzień dobry, podzielnik w kuchni nic nie wyświetla.', czas: at(7) },
      { rola: 'asystent', tekst: 'Rozumiem. Umówię wizytę serwisanta. Proszę podać adres.', czas: at(9) },
      { rola: 'klient', tekst: 'Zielona Góra, Lipowa 5, mieszkanie 12. Anna Kowalska.', czas: at(18) },
      { rola: 'asystent', tekst: `Powtarzam: ulica Lipowa 5, mieszkanie 12, Zielona Góra. Wolny termin: ${fmt(slot)}. Czy pasuje?`, czas: at(21) },
      { rola: 'klient', tekst: 'Tak, pasuje.', czas: at(30) },
      { rola: 'asystent', tekst: 'Wizyta zarezerwowana. Dziękuję i do widzenia.', czas: at(33) }],
    zgloszenia: [{ rodzaj: 'wizyta_serwisowa', imie_nazwisko: 'Anna Kowalska', telefon: '+48600100200', adres: 'ul. Lipowa 5', lokal: '12', miasto: 'Zielona Góra',
      opis: 'Podzielnik w kuchni nie wyświetla odczytu.', termin: slot.toISOString(), czas_min: 60, pilne: false }] };
}

module.exports = { DEPTS, OUTCOMES, KINDS, REQ_STATUS, KIND_LABEL, settings, saveSettings, newKey, checkKey, parse, ingest, summary, purgeTranscripts, sample };
