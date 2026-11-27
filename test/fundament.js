// Testy rozbudowy działu Podzielniki i Montaże – etap 1 (fundament): konta i role, zasięg danych montera,
// powiadomienia (w aplikacji, push, kopia e-mail), anulowanie wpisów finansowych, eksport do Excela, stronicowanie.
// Dane robocze z prefiksem [T5] i konta t5.* są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), crypto = require('crypto'), assert = require('assert/strict'), path = require('path');
const ExcelJS = require('exceljs');
const webpush = require('web-push');
const { pool } = require('../db');
const jobs = require('../lib/jobs');
const { notify } = require('../lib/notify');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const T = '[T5]', DEP = 'podzielniki-i-montaze';
const day = n => require('./_setup').warsawDay(n);   // jak aplikacja: data wg czasu polskiego

(async () => {
  const PORT = 5700 + Math.floor(Math.random() * 250), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0', AI_MODE: 'test' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.clone().json().catch(() => ({})), h: r.headers, buf: () => r.arrayBuffer(), c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const created = { users: [], crews: [], installers: [], buildings: [], installations: [] };
  const unread = async (c, kind) => (await call('powiadomienia?nowe=1', null, c)).j.filter(n => !kind || n.kind === kind);
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const login = async (l, p = '1234') => call('login', { login: l, password: p });
    const A = (await login('m.ozga')).c, U = (await login('m.ozga1')).c;

    // ---------- konta i role ----------
    eq((await call('konta', { login: 't5.x', full_name: 'X', role: 'monter' }, U)).s, 403, 'pracownik biura nie zakłada kont');
    eq((await call('konta', { login: 'Zły Login', full_name: 'X', role: 'monter' }, A)).s, 400, 'walidacja loginu');
    eq((await call('konta', { login: 't5.x', full_name: 'X', role: 'monter', extra_roles: ['administrator'] }, A)).s, 400, 'administrator nie jest rolą dodatkową');
    let r = await call('konta', { login: 't5.monter1', full_name: 'Jan Testowy', role: 'monter', phone: '600 100 200' }, A);
    eq(r.s, 201, 'utworzenie konta montera'); const m1 = r.j; created.users.push(m1.id);
    ok(m1.temporary_password && m1.temporary_password.length === 12, 'hasło tymczasowe');
    eq((await call('konta', { login: 't5.monter1', full_name: 'Dubel', role: 'monter' }, A)).s, 409, 'login musi być unikalny');
    const hash = (await pool.query('SELECT password_hash, must_change_password FROM users WHERE id = $1', [m1.id])).rows[0];
    ok(hash.password_hash.startsWith('$2') && hash.must_change_password, 'hasło jako bcrypt, wymuszona zmiana');
    r = await login('t5.monter1', m1.temporary_password); eq(r.s, 200); eq(r.j.mustChangePassword, true, 'pierwsze logowanie – zmiana hasła');
    eq((await call('moje', null, r.c)).s, 403, 'przed zmianą hasła brak dostępu');
    r = await call('haslo', { obecne: m1.temporary_password, nowe: 'Montaz-Testowy-77', powtorz: 'Montaz-Testowy-77' }, r.c); eq(r.s, 200);
    let M1 = (await login('t5.monter1', 'Montaz-Testowy-77')).c;
    r = await call('me', null, M1);
    ok(r.j.permissions.includes('field.own') && !r.j.permissions.includes('departments.view') && !r.j.permissions.includes('export.xlsx'), 'monter: tylko własne montaże');
    eq(r.j.roleLabels[0], 'Monter');

    // ---------- ekipy, instalatorzy, powiązanie kont ----------
    const crewA = (await call('d1/ekipy', { name: T + ' Ekipa A' }, A)).j, crewB = (await call('d1/ekipy', { name: T + ' Ekipa B' }, A)).j;
    created.crews.push(crewA.id, crewB.id);
    const instA = (await call('d1/instalatorzy', { name: T + ' Jan', crew_id: crewA.id, phone: '600100200' }, A)).j;
    const instB = (await call('d1/instalatorzy', { name: T + ' Piotr', crew_id: crewB.id }, A)).j;
    created.installers.push(instA.id, instB.id);
    r = await call('konta/' + m1.id, { installer_id: instA.id }, A, 'PATCH'); eq(r.s, 200, 'powiązanie konta z instalatorem'); eq(r.j.crew_name, T + ' Ekipa A');
    r = await call('konta', { login: 't5.monter2', full_name: 'Piotr Testowy', role: 'monter', installer_id: instA.id }, A);
    eq(r.s, 409, 'instalator może mieć tylko jedno konto');
    r = await call('konta', { login: 't5.monter2', full_name: 'Piotr Testowy', role: 'monter', installer_id: instB.id }, A); eq(r.s, 201);
    const m2 = r.j; created.users.push(m2.id);
    await pool.query('UPDATE users SET must_change_password = false WHERE id = $1', [m2.id]);
    await pool.query('UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE login = $2) WHERE id = $1', [m2.id, 't5.monter1']);
    const M2 = (await login('t5.monter2', 'Montaz-Testowy-77')).c;
    ok((await call('konta/instalatorzy', null, A)).j.some(i => i.id === instA.id && i.user_login === 't5.monter1'), 'lista instalatorów z kontem');
    ok((await call('d1/ekipy', null, A)).j.find(c => c.id === crewA.id).installers.some(i => i.user_login === 't5.monter1'), 'ekipa pokazuje konto instalatora');

    // ---------- montaże i powiadomienia o przydziałach ----------
    const bld = (await call('d1/budynki', { name: T + ' Blok', address: 'Testowa 1', city: 'Zielona Góra', units_count: 40, potwierdz_duplikat: true }, A)).j; created.buildings.push(bld.id);
    r = await call('d1/montaze', { building_id: bld.id, crew_id: crewA.id, planned_date: day(3), scope: 'Montaż podzielników', devices_planned: 120, materials: [{ nazwa: 'Plomby', ilosc: 150, jm: 'szt.' }] }, A);
    eq(r.s, 201); const iA = r.j; created.installations.push(iA.id);
    const iB = (await call('d1/montaze', { building_id: bld.id, crew_id: crewB.id, planned_date: day(5) }, A)).j; created.installations.push(iB.id);
    let n1 = await unread(M1, 'montaz.przydzial');
    ok(n1.length === 1 && n1[0].title.includes(iA.number) && n1[0].link === '/moje-montaze?m=' + iA.id && n1[0].body.includes('Testowa 1'), 'monter A: powiadomienie o przydziale z adresem i linkiem');
    ok((await unread(M2, 'montaz.przydzial')).every(n => !n.title.includes(iA.number)), 'monter B nie dostaje przydziału ekipy A');
    eq((await call('powiadomienia/licznik', null, M1)).j.nieprzeczytane, 1, 'licznik na dzwonku');

    // ---------- zasięg danych montera ----------
    r = await call('moje', null, M1); eq(r.j.installer.crew_name, T + ' Ekipa A'); ok(r.j.team.some(t => t.name === T + ' Jan'), 'skład ekipy');
    r = await call('moje/montaze', null, M1);
    ok(r.j.some(x => x.id === iA.id) && !r.j.some(x => x.id === iB.id), 'monter widzi tylko montaże swojej ekipy');
    r = await call('moje/montaze/' + iA.id, null, M1); eq(r.s, 200);
    ok(!['przychod', 'koszt', 'value_net', 'marza', 'crew_id'].some(k => k in r.j) && r.j.materials[0].nazwa === 'Plomby' && r.j.address === 'Testowa 1', 'karta montażu bez finansów, z materiałami i adresem');
    eq((await call('moje/montaze/' + iB.id, null, M1)).s, 404, 'cudzy montaż – 404');
    ok((await pool.query(`SELECT 1 FROM audit_logs WHERE ts >= $1 AND action = 'odmowa_dostepu' AND resource_id = $2`, [t0, iB.id])).rows.length, 'próba w rejestrze');
    for (const p of ['d1/budynki', 'd1/montaze', 'finanse', 'command-center', 'meta', 'konta', 'eksport/d1/budynki', 'bi', 'klienci'])
      eq((await call(p, null, M1)).s, 403, `monter → /api/${p} = 403`);
    eq((await call('moje/montaze', null, U)).s, 403, 'pracownik biura bez roli monter nie ma „Moich montaży”');

    // ---------- zmiany harmonogramu → powiadomienia ----------
    await call('d1/montaze/' + iA.id, { planned_date: day(4) }, A, 'PATCH');
    ok((await unread(M1, 'montaz.zmiana_terminu')).length === 1, 'zmiana terminu → powiadomienie');
    await call('d1/montaze/' + iA.id, { notes: 'bez wpływu na ekipę' }, A, 'PATCH');
    eq((await unread(M1, 'montaz.zmiana_terminu')).length, 1, 'zmiana uwag nie wysyła powiadomienia');
    await call('d1/montaze/' + iA.id, { crew_id: crewB.id }, A, 'PATCH');
    ok((await unread(M1, 'montaz.odwolanie')).length === 1 && (await unread(M2, 'montaz.przydzial')).some(n => n.title.includes(iA.number)), 'przekazanie innej ekipie');
    ok(!(await call('moje/montaze', null, M1)).j.some(x => x.id === iA.id) && (await call('moje/montaze', null, M2)).j.some(x => x.id === iA.id), 'zasięg po zmianie ekipy');
    await call('d1/montaze/' + iA.id, { status: 'anulowany' }, A, 'PATCH');
    ok((await unread(M2, 'montaz.anulowanie')).length === 1, 'anulowanie → powiadomienie');
    await call('d1/instalatorzy/' + instA.id, { crew_id: crewB.id }, A, 'PATCH');
    ok((await unread(M1, 'ekipa.przydzial')).length === 1 && (await call('moje', null, M1)).j.installer.crew_name === T + ' Ekipa B', 'przeniesienie do innej ekipy');

    // ---------- odczyt powiadomień, izolacja ----------
    const mine = (await call('powiadomienia', null, M1)).j;
    eq((await call('powiadomienia/przeczytane', { ids: [mine[0].id] }, M2)).j.oznaczono, 0, 'nie można oznaczyć cudzego powiadomienia');
    eq((await call('powiadomienia/przeczytane', { ids: [mine[0].id] }, M1)).j.oznaczono, 1);
    await call('powiadomienia/przeczytane', {}, M1);
    eq((await call('powiadomienia/licznik', null, M1)).j.nieprzeczytane, 0, 'wszystkie przeczytane');
    ok(!(await call('powiadomienia', null, M2)).j.some(n => mine.some(x => x.id === n.id)), 'lista tylko własnych powiadomień');
    eq(await notify([m1.id], { kind: 'test', title: 'Przypomnienie', dedup: 't5-dedup' }), 1, 'deduplikacja: pierwsze');
    eq(await notify([m1.id], { kind: 'test', title: 'Przypomnienie', dedup: 't5-dedup' }), 0, 'deduplikacja: drugie pominięte');

    // ---------- push ----------
    eq((await call('powiadomienia/push', { endpoint: 'http://zly.example/x', keys: { p256dh: 'a', auth: 'b' } }, M1)).s, 400, 'subskrypcja tylko https');
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
    eq((await call('powiadomienia/push', { endpoint: 'https://push.example.test/t5-ok', keys }, M1)).s, 201);
    eq((await call('powiadomienia/push', { endpoint: 'https://push.example.test/t5-gone', keys }, M1)).s, 201);
    r = await call('powiadomienia/ustawienia', null, M1); eq(r.j.devices.length, 2); ok(r.j.vapid_public_key.length > 80, 'klucz VAPID');
    // Szyfrowanie treści i podpis VAPID (bez wysyłki): poprawne nagłówki żądania do usługi push.
    const vk = (await pool.query(`SELECT value FROM system_settings WHERE key = 'vapid'`)).rows[0].value;
    const det = webpush.generateRequestDetails({ endpoint: 'https://push.example.test/t5-ok', keys }, '{"title":"x"}',
      { vapidDetails: { subject: 'mailto:test@example.com', publicKey: vk.publicKey, privateKey: vk.privateKey } });
    ok(/^vapid t=.+, k=/.test(det.headers.Authorization) && det.headers['Content-Encoding'] === 'aes128gcm' && det.body.length > 0, 'zaszyfrowana treść i podpis VAPID');
    // Dostawa: usługa push przyjmuje jedno urządzenie, drugie zwraca 410 (wypisane) – subskrypcja jest usuwana.
    const sent = [], orig = webpush.sendNotification;
    webpush.sendNotification = async (sub, payload) => { sent.push({ sub, payload: JSON.parse(payload) }); if (sub.endpoint.endsWith('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 }); return { statusCode: 201 }; };
    await pool.query('UPDATE users SET email = $2 WHERE id = $1', [m1.id, 't5.monter1@example.test']);
    eq((await call('powiadomienia/ustawienia', { notify_email: true }, M1, 'PUT')).s, 200, 'kopia e-mail włączona');
    eq((await call('powiadomienia/ustawienia', { notify_email: true }, M2, 'PUT')).s, 400, 'bez adresu e-mail – 400');
    eq((await call('powiadomienia/test', {}, M1)).s, 201);
    const nid = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1 AND kind = 'test' ORDER BY id DESC LIMIT 1`, [m1.id])).rows[0].id;
    const job = (await pool.query(`SELECT id FROM jobs WHERE kind = 'powiadomienie' AND payload->>'id' = $1`, [String(nid)])).rows[0];
    const done = await jobs.runNow(job.id);
    webpush.sendNotification = orig;
    eq(done.status, 'ok', 'zadanie dostawy wykonane');
    ok(sent.length === 2 && sent[0].payload.title === 'Powiadomienie próbne MXT' && sent[0].payload.url === '/powiadomienia', 'push do obu urządzeń z tytułem i adresem');
    const subs = (await pool.query('SELECT endpoint, last_ok_at FROM push_subscriptions WHERE user_id = $1', [m1.id])).rows;
    ok(subs.length === 1 && subs[0].endpoint.endsWith('t5-ok') && subs[0].last_ok_at, 'wypisane urządzenie usunięte, działające oznaczone');
    ok((await pool.query(`SELECT 1 FROM mail_outbox WHERE to_addr = 't5.monter1@example.test' AND created_at >= $1`, [t0])).rows.length, 'kopia powiadomienia na e-mail w kolejce');
    eq((await call('powiadomienia/push', { id: (await call('powiadomienia/ustawienia', null, M1)).j.devices[0].id }, M1, 'DELETE')).j.usunieto, 1, 'wyłączenie push na urządzeniu');

    // ---------- role dodatkowe, wyłączanie konta ----------
    r = await call('konta/' + m1.id, { extra_roles: ['rozliczajacy'] }, A, 'PATCH'); eq(r.s, 200);
    r = await call('me', null, M1);
    ok(r.j.permissions.includes('field.own') && r.j.permissions.includes('departments.view') && r.j.roles.length === 2, 'role sumują uprawnienia');
    await call('konta/' + m1.id, { extra_roles: [] }, A, 'PATCH');
    const self = (await pool.query(`SELECT id FROM users WHERE login = 'm.ozga'`)).rows[0].id;
    eq((await call('konta/' + self, { is_active: false }, A, 'PATCH')).s, 400, 'nie można wyłączyć własnego konta');
    eq((await call('konta/' + self, { role: 'monter' }, A, 'PATCH')).s, 400, 'nie można zmienić własnej roli');
    r = await call('konta/' + m2.id, { is_active: false }, A, 'PATCH'); eq(r.s, 200); eq(r.j.is_active, false);
    eq((await call('me', null, M2)).s, 401, 'wyłączone konto wylogowane');
    r = await login('t5.monter2', 'Montaz-Testowy-77'); eq(r.s, 403, 'wyłączone konto nie loguje się'); ok(/wyłączone/.test(r.j.error));
    eq(await notify([m2.id], { kind: 'test', title: 'x' }), 0, 'wyłączone konto nie dostaje powiadomień');
    ok((await pool.query(`SELECT 1 FROM audit_logs WHERE ts >= $1 AND action = 'konto.wylaczenie'`, [t0])).rows.length, 'wyłączenie w rejestrze');
    await call('konta/' + m2.id, { is_active: true }, A, 'PATCH');
    eq((await login('t5.monter2', 'Montaz-Testowy-77')).s, 200, 'ponownie włączone konto loguje się');
    r = await call('konta/' + m2.id + '/reset-hasla', {}, A); eq(r.s, 200); eq((await login('t5.monter2', r.j.temporary_password)).j.mustChangePassword, true, 'reset hasła z nowego modułu');

    // ---------- finanse: anulowanie zamiast usuwania ----------
    const fin = (await call('finanse', { department_id: DEP, kind: 'koszt', amount: 123.45, description: T + ' koszt testowy', building_id: bld.id }, A)).j;
    eq((await call('finanse/' + fin.id + '/anuluj', { powod: 'test' }, U)).s, 403, 'anulowanie tylko administrator');
    eq((await call('finanse/' + fin.id + '/anuluj', {}, A)).s, 400, 'powód wymagany');
    eq((await call('finanse/' + fin.id, null, A, 'DELETE')).s, 404, 'brak twardego usuwania');
    eq((await call('finanse/' + fin.id + '/anuluj', { powod: 'Dubel faktury' }, A)).s, 200);
    eq((await pool.query('SELECT count(*)::int n FROM finance WHERE id = $1', [fin.id])).rows[0].n, 0, 'wpis zniknął z sum');
    r = await call('finanse/anulowane', null, A);
    ok(r.j.some(x => x.id === fin.id && x.reason === 'Dubel faktury' && x.data.description === T + ' koszt testowy' && x.cancelled_by_login === 'm.ozga'), 'pełna kopia w archiwum z powodem');

    // ---------- eksport do Excela, stronicowanie ----------
    eq((await call('d1/urzadzenia', { serials: 'T5-0001\nT5-0002\nT5-0003', type: 'podzielnik', building_id: bld.id, location: '' }, A)).s, 201);
    r = await call('d1/urzadzenia?strona=1&building_id=' + bld.id, null, A); eq(r.h.get('x-total-count'), '3', 'łączna liczba w nagłówku'); eq(r.j.length, 3);
    const wbOf = async res => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.buf())); return wb; };
    r = await call('eksport/d1/urzadzenia?building_id=' + bld.id, null, A);
    eq(r.s, 200); ok(r.h.get('content-type').includes('spreadsheetml') && /attachment; filename="MXT_Podzielniki_urzadzenia_/.test(r.h.get('content-disposition')), 'plik XLSX');
    let ws = (await wbOf(r)).getWorksheet('Urządzenia');
    eq(ws.getRow(1).getCell(1).value, 'Numer seryjny'); eq(ws.rowCount, 4, 'nagłówek + 3 urządzenia');
    ok(ws.getRow(2).getCell(2).value === 'Podzielnik kosztów' && ws.autoFilter, 'czytelne nazwy i filtr');
    r = await call('eksport/d1/urzadzenia?typ=wodomierz&building_id=' + bld.id, null, A);
    eq((await wbOf(r)).getWorksheet('Urządzenia').getRow(2).getCell(1).value, 'Brak danych dla wybranych filtrów.', 'filtry działają');
    r = await call('eksport/d1/montaze?od=' + day(0), null, A); ws = (await wbOf(r)).getWorksheet('Montaże');
    const row = ws.getRows(2, ws.rowCount - 1).find(x => x.getCell(1).value === iB.number);
    ok(row && row.getCell(9).value instanceof Date && row.getCell(8).value === T + ' Ekipa B', 'montaże: daty jako daty Excela');
    for (const l of ['budynki', 'kontrakty']) eq((await call('eksport/d1/' + l, null, U)).s, 200, `eksport ${l} (pracownik biura)`);
    for (const l of ['rentownosc', 'finanse']) eq((await call('eksport/d1/' + l, null, U)).s, 403, `eksport ${l} – tylko role finansowe (pracownik biura 403)`);
    eq((await wbOf(await call('eksport/d1/rentownosc', null, A))).worksheets.length, 3, 'rentowność: 3 arkusze');
    eq((await call('eksport/d1/nieistniejace', null, A)).s, 404);
    eq((await call('eksport/d1/__proto__', null, A)).s, 404, 'nazwy zestawień tylko z listy');
    ok((await pool.query(`SELECT 1 FROM audit_logs WHERE ts >= $1 AND action = 'eksport.xlsx' AND resource = 'eksport/d1/urzadzenia'`, [t0])).rows.length, 'eksport w rejestrze');

    console.log(`OK: testy fundamentu działu 1 przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    const q = (s, p = []) => pool.query(s, p).catch(e => console.error('sprzątanie:', e.message));
    await q(`DELETE FROM devices WHERE serial_no LIKE 'T5-%'`);
    await q(`DELETE FROM finance WHERE description LIKE $1`, [T + '%']);
    await q(`DELETE FROM finance_cancelled WHERE data->>'description' LIKE $1`, [T + '%']);
    await q(`DELETE FROM notifications WHERE created_at >= $1 AND (related_id = ANY($2::uuid[]) OR user_id = ANY($3::uuid[]))`, [t0, created.installations, created.users]);
    await q(`DELETE FROM installations WHERE id = ANY($1::uuid[])`, [created.installations]);
    await q(`DELETE FROM buildings WHERE id = ANY($1::uuid[])`, [created.buildings]);
    await q(`DELETE FROM installers WHERE id = ANY($1::uuid[])`, [created.installers]);
    await q(`DELETE FROM crews WHERE id = ANY($1::uuid[])`, [created.crews]);
    await q(`DELETE FROM mail_outbox WHERE to_addr LIKE 't5.%' AND created_at >= $1`, [t0]);
    await q(`DELETE FROM jobs WHERE kind = 'powiadomienie' AND created_at >= $1 AND status <> 'w_toku'`, [t0]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[]) OR created_at >= $2`, [created.users, t0]);
    await q(`DELETE FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`, [created.users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.users]);
    await restoreFlags();
    await pool.end(); srv.kill();
  }
})();
