// Testy działu Asystent telefoniczny: klucz webhooka, przyjęcie rozmowy od bota (bez duplikatów), wizyta → zlecenie serwisowe,
// zgłoszenia i powiadomienia, walidacja, wskaźniki z planu, przegląd transkrypcji, uprawnienia, RODO (usuwanie transkrypcji),
// eksport, rejestr i limit prób. Rozmowy robocze mają call_sid z prefiksem T10- i są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const ExcelJS = require('exceljs'), bcrypt = require('bcryptjs');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const iso = (minAgo = 0) => new Date(Date.now() - minAgo * 60000).toISOString();
const plusDays = n => { const d = new Date(Date.now() + n * 864e5); d.setUTCHours(9, 0, 0, 0); return d.toISOString(); };
const warsawDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date(t));

(async () => {
  const PORT = 6800 + Math.floor(Math.random() * 150), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method, headers = {}) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.clone().json().catch(() => ({})), h: r.headers, buf: async () => Buffer.from(await r.arrayBuffer()), c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const savedSettings = (await pool.query(`SELECT value FROM system_settings WHERE key = 'asystent'`)).rows[0];
  const users = [], orders = [];
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const login = async (l, p = '1234') => (await call('login', { login: l, password: p })).c;
    const A = await login('m.ozga'), U = await login('m.ozga1');
    const adminId = (await pool.query(`SELECT id FROM users WHERE login = 'm.ozga'`)).rows[0].id;
    const mid = (await pool.query(`INSERT INTO users (login, password_hash, role, full_name, must_change_password) VALUES ('t10.monter', $1, 'monter', '[T10] Monter', false) RETURNING id`,
      [await bcrypt.hash('Monter-Test-2026', 4)])).rows[0].id;
    users.push(mid);
    const M = await login('t10.monter', 'Monter-Test-2026');
    const hook = (body, key) => call('asystent/webhook', body, null, 'POST', key === undefined ? {} : { Authorization: 'Bearer ' + key });
    const notes = async kind => (await pool.query(`SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 AND created_at >= $3 ORDER BY id`, [adminId, kind, t0])).rows;
    let n = 0;
    const sid = () => 'T10-' + Date.now() + '-' + (++n);

    // ---------- klucz webhooka ----------
    await pool.query(`UPDATE system_settings SET value = value - 'key_hash' WHERE key = 'asystent'`);
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5) }, 'mxt_tel_cokolwiek_dlugiego_123')).s, 401, 'bez ustawionego klucza – odmowa');
    eq((await call('asystent/integracja/klucz', {}, U)).s, 403, 'pracownik biura nie generuje klucza');
    let r = await call('asystent/integracja/klucz', {}, A); eq(r.s, 201, 'administrator generuje klucz');
    const KEY = r.j.klucz; ok(/^mxt_tel_[\w-]{30,}$/.test(KEY), 'format klucza');
    r = await call('asystent/integracja', null, U);
    ok(r.s === 200 && r.j.adres.endsWith('/api/asystent/webhook') && r.j.klucz.ustawiony && r.j.klucz.koncowka === KEY.slice(-4) && !JSON.stringify(r.j).includes('key_hash') && !JSON.stringify(r.j).includes(KEY),
      'integracja: adres, stan klucza, bez klucza i skrótu w odpowiedzi');
    eq(r.j.moze_zmieniac, false, 'pracownik biura bez zmian integracji');
    const stored = (await pool.query(`SELECT value FROM system_settings WHERE key = 'asystent'`)).rows[0].value;
    ok(stored.key_hash && stored.key_hash.length === 64 && !JSON.stringify(stored).includes(KEY), 'w bazie tylko skrót klucza');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5) })).s, 401, 'brak nagłówka – odmowa');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5) }, KEY + 'x')).s, 401, 'zły klucz – odmowa');
    eq((await call('asystent/rozmowy', null, null)).s, 401, 'panel bez sesji – odmowa');

    // ---------- walidacja ----------
    eq((await hook({ rozpoczeta: iso(5) }, KEY)).s, 400, 'call_sid wymagany');
    eq((await hook({ call_sid: sid(), rozpoczeta: 'wczoraj' }, KEY)).s, 400, 'data ISO');
    eq((await hook({ call_sid: sid(), rozpoczeta: plusDays(2) }, KEY)).s, 400, 'rozpoczęcie z przyszłości');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5), zakonczona: iso(10) }, KEY)).s, 400, 'koniec przed początkiem');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5), dzial: 'kosmos' }, KEY)).s, 400, 'nieznany dział');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5), zgloszenia: [{ rodzaj: 'pizza' }] }, KEY)).s, 400, 'nieznany rodzaj zgłoszenia');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5), transkrypcja: [{ rola: 'hacker', tekst: 'x' }] }, KEY)).s, 400, 'rola w transkrypcji');
    eq((await pool.query(`SELECT count(*)::int n FROM phone_calls WHERE call_sid LIKE 'T10-%'`)).rows[0].n, 0, 'odrzucone rozmowy nic nie zapisały');

    // ---------- rozmowa z wizytą serwisową → zlecenie ----------
    const sum0 = (await call('asystent/podsumowanie?dni=14', null, U)).j;
    const slot = plusDays(3), SID1 = sid();
    const visit = { call_sid: SID1, rozpoczeta: iso(8), zakonczona: iso(5), telefon: '+48 600 111 222', dzial: 'podzielniki', wynik: 'rezerwacja',
      sredni_czas_odpowiedzi_ms: 1100, podsumowanie: 'Podzielnik nie działa, umówiona wizyta.',
      transkrypcja: [{ rola: 'asystent', tekst: 'Dzień dobry, tu Ola, wirtualna asystentka AI firmy MXT.', czas: iso(8) }, { rola: 'klient', tekst: 'Podzielnik nie działa.' }],
      zgloszenia: [{ rodzaj: 'wizyta_serwisowa', imie_nazwisko: '[T10] Jan Nowak', adres: 'ul. Testowa 10', lokal: '4', miasto: 'Zielona Góra', opis: 'Podzielnik nie wyświetla odczytu.',
        termin: slot, czas_min: 60, pilne: true, dane: { numer_podzielnika: 'A-123' } }] };
    r = await hook(visit, KEY); eq(r.s, 201, 'rozmowa przyjęta');
    const callId = r.j.rozmowa_id, nr = r.j.zgloszenia[0].zlecenie_serwisowe;
    ok(/^SR\/\d{4}\/\d+$/.test(nr), 'wizyta → zlecenie serwisowe ' + nr);
    const so = (await pool.query('SELECT * FROM service_orders WHERE number = $1', [nr])).rows[0]; orders.push(so.id);
    ok(so.status === 'nowe' && so.priority === 'pilny' && so.contact_phone === '+48 600 111 222' && so.client_name === '[T10] Jan Nowak' && so.unit === '4'
      && so.address === 'ul. Testowa 10' && so.due_date === warsawDate(slot) && so.description.includes('Termin uzgodniony z klientem przez telefon') && so.description.includes('numer_podzielnika: A-123'),
      'zlecenie: do weryfikacji, pilne, kontakt, adres, termin uzgodniony w opisie i jako termin realizacji');
    ok((await pool.query(`SELECT 1 FROM service_events WHERE order_id = $1 AND kind = 'utworzenie' AND data->>'zrodlo' = 'asystent_telefoniczny'`, [so.id])).rows.length, 'historia zlecenia: źródło asystent');
    ok((await notes('serwis.z_telefonu')).some(x => x.related_id === so.id && x.title.startsWith('PILNE: ')), 'kierownictwo: powiadomienie o pilnym zleceniu z telefonu');
    const rq1 = (await pool.query('SELECT * FROM phone_requests WHERE call_id = $1', [callId])).rows[0];
    ok(rq1.status === 'zalatwione' && rq1.note.includes(nr) && rq1.service_order_id === so.id, 'zgłoszenie przekazane do Serwisów – poza kolejką');

    // ---------- ta sama rozmowa drugi raz ----------
    r = await hook(visit, KEY);
    ok(r.s === 200 && r.j.ponownie && r.j.rozmowa_id === callId && r.j.zgloszenia[0].zlecenie_serwisowe === nr, 'ponowne wysłanie – te same identyfikatory');
    eq((await pool.query(`SELECT count(*)::int n FROM service_orders WHERE contact_phone = '+48 600 111 222'`)).rows[0].n, 1, 'bez drugiego zlecenia');
    eq((await pool.query('SELECT count(*)::int n FROM phone_calls WHERE call_sid = $1', [SID1])).rows[0].n, 1, 'bez drugiej rozmowy');

    // ---------- zgłoszenia bez zlecenia ----------
    r = await hook({ call_sid: sid(), rozpoczeta: iso(30), zakonczona: iso(28), telefon: '+48 601 000 001', dzial: 'czesci', wynik: 'oddzwonienie', przekazana: false,
      zgloszenia: [{ rodzaj: 'zapytanie_czesci', imie_nazwisko: '[T10] Piotr', opis: 'Klocki hamulcowe', dane: { pojazd: 'MAN TGX', VIN: 'WMA06XZZ1234' }, pilne: true }] }, KEY);
    eq(r.s, 201); const rqP = r.j.zgloszenia[0].id; eq(r.j.zgloszenia[0].zlecenie_serwisowe, null, 'części: bez zlecenia serwisowego');
    ok((await notes('asystent.zgloszenie')).some(x => x.related_id === rqP && x.title.startsWith('PILNE: Zapytanie o części') && x.link === `/dzial/asystent-telefoniczny?tab=zgloszenia&z=${rqP}`),
      'kierownictwo: powiadomienie z linkiem do zgłoszenia');
    r = await hook({ call_sid: sid(), rozpoczeta: iso(40), dzial: 'podzielniki', wynik: 'zgloszenie', zgloszenia: [{ rodzaj: 'wizyta_serwisowa', imie_nazwisko: '[T10] Bez adresu', opis: 'Brak adresu' }] }, KEY);
    const rqNoAddr = r.j.zgloszenia[0];
    ok(r.s === 201 && rqNoAddr.zlecenie_serwisowe === null, 'wizyta bez adresu – zgłoszenie do uzupełnienia, bez zlecenia');
    r = await hook({ call_sid: sid(), rozpoczeta: iso(50), zakonczona: iso(49), dzial: 'ubezpieczenia', wynik: 'przekazanie', sredni_czas_odpowiedzi_ms: 2100 }, KEY); eq(r.s, 201, 'rozmowa przekazana, bez zgłoszeń');
    r = await hook({ call_sid: sid(), rozpoczeta: iso(60), dzial: 'inne', wynik: 'przerwana' }, KEY); eq(r.s, 201, 'rozmowa przerwana');

    // ---------- rozmowa testowa ----------
    const nb = (await pool.query(`SELECT count(*)::int n FROM notifications WHERE created_at >= $1`, [t0])).rows[0].n;
    r = await hook({ ...visit, call_sid: sid(), test: true }, KEY);
    ok(r.s === 201 && r.j.zgloszenia[0].zlecenie_serwisowe === null, 'rozmowa testowa (test: true) – bez zlecenia');
    eq((await pool.query(`SELECT count(*)::int n FROM notifications WHERE created_at >= $1`, [t0])).rows[0].n, nb, 'rozmowa testowa – bez powiadomień');
    eq((await call('asystent/integracja/test', {}, U)).s, 403, 'rozmowę testową z panelu wysyła administrator');
    r = await call('asystent/integracja/test', {}, A); ok(r.s === 201 && r.j.rozmowa_id, 'rozmowa testowa z panelu');
    const testCall = r.j.rozmowa_id;

    // ---------- wskaźniki ----------
    const sum1 = (await call('asystent/podsumowanie?dni=14', null, U)).j;
    ok(sum1.rozmowy - sum0.rozmowy === 5 && sum1.skuteczne - sum0.skuteczne === 3 && sum1.przekazane - sum0.przekazane === 1, 'wskaźniki: 5 rozmów, 3 skuteczne, 1 przekazana (bez testowych)');
    eq(sum1.skutecznosc_pct, Math.round(sum1.skuteczne * 1000 / sum1.rozmowy) / 10, 'skuteczność w %');
    ok(sum1.otwarte - sum0.otwarte === 2 && sum1.pilne_otwarte - sum0.pilne_otwarte === 1, 'otwarte zgłoszenia (2, w tym 1 pilne)');
    ok(sum1.cele.skutecznosc_pct === 70 && sum1.cele.przekazania_pct === 20 && sum1.cele.bledy_pct === 2 && sum1.cele.czas_odpowiedzi_ms === 1500, 'cele z planu');
    ok(sum1.dzialy.some(d => d.dzial === 'czesci'), 'podział na działy');

    // ---------- lista, karta, przegląd ----------
    r = await call('asystent/rozmowy?dzial=podzielniki&wynik=rezerwacja&q=111', null, U);
    ok(r.s === 200 && r.j.some(x => x.id === callId) && +r.h.get('x-total-count') >= 1 && r.j.every(x => x.department === 'podzielniki'), 'lista z filtrami');
    r = await call('asystent/rozmowy/' + callId, null, U);
    ok(r.j.transcript.length === 2 && r.j.requests[0].order_number === nr && r.j.ma_transkrypcje, 'karta: transkrypcja i zgłoszenie ze zleceniem');
    eq((await call(`asystent/rozmowy/${callId}/ocena`, { status: 'blad_danych' }, U)).s, 400, 'błąd w danych wymaga opisu');
    r = await call(`asystent/rozmowy/${callId}/ocena`, { status: 'blad_danych', uwaga: 'Lokal 4 zamiast 14' }, U); eq(r.j.review_status, 'blad_danych', 'przegląd zapisany');
    await call(`asystent/rozmowy/${testCall}/ocena`, { status: 'blad_danych', uwaga: 'test' }, U);
    const sum2 = (await call('asystent/podsumowanie?dni=14', null, U)).j;
    ok(sum2.bledy - sum1.bledy === 1 && sum2.sprawdzone - sum1.sprawdzone === 1 && sum2.do_przejrzenia - sum1.do_przejrzenia === -1, 'wskaźnik pomyłek: tylko rozmowy nietestowe');
    ok((await call('asystent/rozmowy?przeglad=blad_danych', null, U)).j.some(x => x.id === callId), 'filtr przeglądu');

    // ---------- kolejka zgłoszeń ----------
    r = await call('asystent/zgloszenia', null, U);
    ok(r.j.some(x => x.id === rqP) && !r.j.some(x => x.id === rq1.id) && r.j.findIndex(x => x.id === rqP) < r.j.findIndex(x => x.id === rqNoAddr.id), 'do załatwienia: pilne na górze, przekazane do Serwisów poza listą');
    ok(r.j.find(x => x.id === rqP).details.VIN === 'WMA06XZZ1234', 'szczegóły zgłoszenia (VIN)');
    r = await call('asystent/zgloszenia/' + rqP, { status: 'w_toku' }, U, 'PATCH'); ok(r.s === 200 && r.j.status === 'w_toku' && r.j.handled_by, 'Biorę');
    eq((await call('asystent/zgloszenia/' + rqP, { status: 'anulowane' }, U, 'PATCH')).s, 400, 'anulowanie wymaga powodu');
    r = await call('asystent/zgloszenia/' + rqP, { status: 'zalatwione', notatka: 'Oddzwoniono, wycena wysłana' }, U, 'PATCH'); ok(r.j.status === 'zalatwione' && r.j.note.includes('wycena'), 'załatwione z notatką');
    ok(!(await call('asystent/zgloszenia', null, U)).j.some(x => x.id === rqP) && (await call('asystent/zgloszenia?status=zalatwione', null, U)).j.some(x => x.id === rqP), 'widoki kolejki');

    // ---------- uprawnienia ----------
    for (const p of ['asystent/rozmowy', 'asystent/zgloszenia', 'asystent/podsumowanie', 'asystent/integracja']) eq((await call(p, null, M)).s, 403, `monter → /api/${p} = 403`);
    eq((await call('asystent/integracja/ustawienia', { retencja_dni: 30 }, U, 'PUT')).s, 403, 'ustawienia: tylko administrator');

    // ---------- RODO: usuwanie transkrypcji ----------
    r = await hook({ call_sid: sid(), rozpoczeta: iso(10 * 1440), dzial: 'inne', wynik: 'informacja', transkrypcja: [{ rola: 'klient', tekst: 'stara rozmowa' }] }, KEY);
    const old = r.j.rozmowa_id;
    eq((await call('asystent/integracja/ustawienia', { retencja_dni: 3 }, A, 'PUT')).s, 400, 'okres przechowywania co najmniej 7 dni');
    r = await call('asystent/integracja/ustawienia', { retencja_dni: 7 }, A, 'PUT'); ok(r.s === 200 && r.j.usunieto >= 1, 'krótszy okres – stare transkrypcje usunięte');
    r = await call('asystent/rozmowy/' + old, null, U); ok(r.j.transcript === null && r.j.transcript_deleted_at && r.j.outcome === 'informacja', 'stara rozmowa: bez treści, wynik zostaje');
    ok((await call('asystent/rozmowy/' + callId, null, U)).j.transcript.length === 2, 'nowe transkrypcje zostają');

    // ---------- eksport ----------
    r = await call('asystent/eksport', null, U); eq(r.s, 200, 'eksport do Excela');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await r.buf());
    ok(wb.getWorksheet('Rozmowy') && wb.getWorksheet('Zgłoszenia') && wb.getWorksheet('Zgłoszenia').getRows(2, 400).some(x => x.getCell(13).value === nr), 'arkusze Rozmowy i Zgłoszenia (z numerem zlecenia)');
    eq((await call('asystent/eksport', null, M)).s, 403, 'monter bez eksportu');

    // ---------- zmiana klucza i rejestr ----------
    const KEY2 = (await call('asystent/integracja/klucz', {}, A)).j.klucz;
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5) }, KEY)).s, 401, 'stary klucz po zmianie – odmowa');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5) }, KEY2)).s, 201, 'nowy klucz działa');
    ok((await call('asystent/integracja', null, A)).j.klucz.ostatnie_uzycie, 'ostatnie użycie klucza');
    const acts = (await pool.query(`SELECT action, status, actor_type FROM audit_logs WHERE ts >= $1 AND action LIKE 'asystent.%'`, [t0])).rows;
    ok(acts.some(a => a.action === 'asystent.rozmowa' && a.actor_type === 'system') && acts.some(a => a.action === 'asystent.klucz') && acts.some(a => a.action === 'asystent.webhook' && a.status === 'odmowa')
      && acts.some(a => a.action === 'asystent.ocena') && acts.some(a => a.action === 'asystent.zgloszenie'), 'rejestr operacji');

    // ---------- limit nieudanych prób ----------
    let s429 = 0;
    for (let i = 0; i < 25 && !s429; i++) if ((await hook({ call_sid: sid(), rozpoczeta: iso(5) }, 'mxt_tel_zly_klucz_' + i + '_xxxxxxxxxx')).s === 429) s429 = 1;
    ok(s429, 'po 20 nieudanych próbach – blokada 429');
    eq((await hook({ call_sid: sid(), rozpoczeta: iso(5) }, KEY2)).s, 429, 'blokada adresu IP obejmuje też dobry klucz');

    console.log(`OK: testy asystenta telefonicznego przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    const q = (s, p = []) => pool.query(s, p).catch(e => console.error('sprzątanie:', e.message));
    const so = (await pool.query(`SELECT r.service_order_id AS id FROM phone_requests r JOIN phone_calls c ON c.id = r.call_id WHERE c.call_sid LIKE 'T10-%' AND r.service_order_id IS NOT NULL`)).rows.map(x => x.id);
    const all = [...new Set([...orders, ...so])];
    await q(`DELETE FROM phone_calls WHERE call_sid LIKE 'T10-%' OR (call_sid LIKE 'TEST-%' AND created_at >= $1)`, [t0]);
    await q(`DELETE FROM notifications WHERE created_at >= $1 AND (related_id = ANY($2::uuid[]) OR kind IN ('asystent.zgloszenie', 'serwis.z_telefonu'))`, [t0, all]);
    await q(`DELETE FROM service_events WHERE order_id = ANY($1::uuid[])`, [all]);
    await q(`DELETE FROM service_orders WHERE id = ANY($1::uuid[])`, [all]);
    await q(`DELETE FROM jobs WHERE kind = 'powiadomienie' AND created_at >= $1 AND status <> 'w_toku'`, [t0]);
    if (savedSettings) await q(`UPDATE system_settings SET value = $1 WHERE key = 'asystent'`, [savedSettings.value]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    await pool.end(); srv.kill();
  }
})();
