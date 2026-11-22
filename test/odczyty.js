// Testy odczytów: rola „Obsługa odczytów” (bez finansów), obiekty z ewidencji budynków i klientów, terminy, „Wykonano” z kolejnym
// terminem jednym działaniem, odczyt częściowy, cofnięcie wpisu, przypomnienia z wyprzedzeniem (bez powtórzeń), ustawienia, eksport.
// Dane robocze z prefiksem [T7] i konta t7.* są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const R = require('../lib/readings');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const T = '[T7]';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const day = n => { const d = new Date(today() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const plusMonths = (s, m) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };

(async () => {
  const PORT = 6000 + Math.floor(Math.random() * 200), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.clone().json().catch(() => ({})), h: r.headers, buf: async () => Buffer.from(await r.arrayBuffer()), c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  const savedSettings = (await pool.query(`SELECT value FROM system_settings WHERE key = 'readings'`)).rows[0].value;
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [];
  const notes = async (uid, kind) => (await pool.query(`SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 AND created_at >= $3 ORDER BY id`, [uid, kind, t0])).rows;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const login = async (l, p = '1234') => call('login', { login: l, password: p });
    const A = (await login('m.ozga')).c, U = (await login('m.ozga1')).c;
    const mk = async (name, role) => {
      const r = await call('konta', { login: name, full_name: T + ' ' + name, role }, A);
      eq(r.s, 201, 'konto ' + name); users.push(r.j.id);
      await pool.query(`UPDATE users SET must_change_password = false, password_hash = (SELECT password_hash FROM users WHERE login = 'm.ozga') WHERE id = $1`, [r.j.id]);
      return { id: r.j.id, c: (await login(name)).c };
    };
    const O = await mk('t7.odczyty', 'odczyty'), SV = await mk('t7.serw', 'serwisant');
    const adminId = (await pool.query(`SELECT id FROM users WHERE login = 'm.ozga'`)).rows[0].id;

    // ---------- rola „Obsługa odczytów” ----------
    let r = await call('me', null, O.c);
    ok(r.j.permissions.includes('readings.manage') && !r.j.permissions.includes('departments.view') && !r.j.permissions.includes('export.xlsx') && !r.j.permissions.includes('readings.admin'),
      'obsługa odczytów: tylko odczyty');
    for (const p of ['d1/budynki', 'finanse', 'klienci', 'command-center', 'eksport/d1/budynki', 'serwisy'])
      eq((await call(p, null, O.c)).s, 403, `odczyty → /api/${p} = 403`);
    eq((await call('odczyty', null, SV.c)).s, 403, 'serwisant nie ma odczytów');
    eq((await call('odczyty', null, U)).s, 200, 'pracownik biura ma odczyty');

    // ---------- klient i obiekt (wspólna ewidencja) ----------
    r = await call('odczyty/klienci', { name: T + ' Wspólnota Brzozowa 1', kind: 'wspolnota', phone: '68 000 00 00' }, O.c); eq(r.s, 201);
    const cust = r.j;
    ok((await pool.query(`SELECT 1 FROM customers WHERE id = $1 AND 'podzielniki-i-montaze' = ANY(departments)`, [cust.id])).rows.length, 'klient w ewidencji CRM działu');
    eq((await call('odczyty', { building: { name: T + ' Brzozowa 1' }, next_due: day(10) }, O.c)).s, 400, 'nowy budynek wymaga adresu');
    eq((await call('odczyty', { building: { name: T + ' X', address: 'ul. X 1' }, next_due: day(10), assigned_to: SV.id }, O.c)).s, 400, 'odpowiedzialny tylko z dostępem do odczytów');
    eq((await call('odczyty', { building: { name: T + ' X', address: 'ul. X 1' }, next_due: day(-400), last_done: day(-300) }, O.c)).s, 400, 'termin po ostatnim odczycie');
    r = await call('odczyty', { building: { name: T + ' Brzozowa 1', address: 'ul. Brzozowa 1', city: 'Zielona Góra', units_count: 48, customer_id: cust.id },
      scope: 'podzielniki', method: 'radiowy', next_due: day(10), last_done: day(-355), assigned_to: O.id, contact: 'Zarządca: 600 000 000', access_notes: 'Klucze u gospodarza' }, A);
    eq(r.s, 201, 'obiekt z nowym budynkiem'); const s1 = r.j;
    eq(s1.cycle_months, 12, 'domyślny cykl 12 miesięcy'); eq(s1.customer_id, cust.id, 'klient z budynku');
    const bld = (await pool.query('SELECT * FROM buildings WHERE id = $1', [s1.building_id])).rows[0];
    ok(bld && bld.name === T + ' Brzozowa 1' && bld.units_count === 48, 'budynek w ewidencji (ta sama tabela co montaże i serwisy)');
    ok((await notes(O.id, 'odczyt.przydzial')).some(n => n.related_id === s1.id), 'powiadomienie o przydzieleniu obiektu');
    eq((await call('odczyty', { building_id: bld.id, scope: 'podzielniki', next_due: day(20) }, O.c)).s, 409, 'jeden harmonogram na zakres');
    r = await call('odczyty', { building_id: bld.id, scope: 'wodomierze', method: 'wizualny', cycle_months: 6, next_due: day(-3) }, O.c); eq(r.s, 201, 'drugi zakres w tym samym budynku');
    const s2 = r.j;
    r = await call('odczyty', { building_id: bld.id, scope: 'cieplomierze', next_due: day(10), remind_days: 5, assigned_to: O.id }, O.c); const s3 = r.j;
    ok((await call('odczyty/budynki?q=Brzozowa', null, O.c)).j.some(b => b.id === bld.id && b.scopes.length === 3), 'lista budynków z zakresami');

    // ---------- lista, flagi, podsumowanie ----------
    r = await call('odczyty?q=' + encodeURIComponent(T), null, O.c);
    const L1 = r.j.find(x => x.id === s1.id), L2 = r.j.find(x => x.id === s2.id), L3 = r.j.find(x => x.id === s3.id);
    ok(L1 && L1.dni_do_terminu === 10 && L1.wkrotce && !L1.po_terminie && L1.wyprzedzenie === 14, 'flaga: zbliża się termin (domyślne wyprzedzenie 14 dni)');
    ok(L2 && L2.po_terminie && L2.dni_do_terminu === -3, 'flaga: po terminie');
    ok(L3 && !L3.wkrotce && L3.wyprzedzenie === 5, 'własne wyprzedzenie obiektu');
    eq(r.h.get('x-total-count'), '3');
    ok((await call('odczyty?widok=po_terminie&q=' + encodeURIComponent(T), null, O.c)).j.length === 1, 'widok po terminie');
    ok((await call('odczyty?osoba=brak&q=' + encodeURIComponent(T), null, O.c)).j.every(x => !x.assigned_to), 'filtr: bez osoby');
    r = await call('odczyty/podsumowanie', null, O.c); ok(r.j.po_terminie >= 1 && r.j.w_30_dni >= 2 && r.j.remind_days === 14, 'podsumowanie');

    // ---------- przypomnienia ----------
    await R.reminders(); await R.reminders();
    let n = await notes(O.id, 'odczyt.termin');
    ok(n.filter(x => x.related_id === s1.id).length === 1 && n[0].title.includes('Za 10 dni') && n[0].link === '/odczyty?z=' + s1.id, 'przypomnienie z wyprzedzeniem, raz');
    ok(!n.some(x => x.related_id === s3.id), 'obiekt z krótszym wyprzedzeniem – jeszcze bez przypomnienia');
    ok((await notes(O.id, 'odczyt.po_terminie')).filter(x => x.related_id === s2.id).length === 1, 'po terminie: zespół odczytów (obiekt bez osoby)');
    ok((await notes(adminId, 'odczyt.po_terminie')).filter(x => x.related_id === s2.id).length === 1, 'po terminie: także kierownictwo');

    // ---------- „Wykonano” jednym działaniem ----------
    eq((await call(`odczyty/${s1.id}/wykonano`, { done_at: day(1) }, O.c)).s, 400, 'data odczytu nie z przyszłości');
    eq((await call(`odczyty/${s1.id}/wykonano`, { done_at: day(-400) }, O.c)).s, 400, 'nie wcześniej niż poprzedni odczyt');
    eq((await call(`odczyty/${s1.id}/wykonano`, { next_due: day(0) }, O.c)).s, 400, 'kolejny termin po dacie odczytu');
    eq((await call(`odczyty/${s1.id}/wykonano`, { done_by: SV.id }, O.c)).s, 400, 'wykonujący z dostępem do odczytów');
    r = await call(`odczyty/${s1.id}/wykonano`, {}, O.c); eq(r.s, 201);
    eq(r.j.schedule.last_done, today(), 'ostatni odczyt = dziś'); eq(r.j.schedule.next_due, plusMonths(today(), 12), 'kolejny termin = dziś + cykl');
    ok(r.j.reading.due_date === day(10) && r.j.reading.done_by === O.id && r.j.reading.result === 'pelny', 'wpis: termin, kto, wynik');
    ok(!(await call('odczyty?q=' + encodeURIComponent(T), null, O.c)).j.some(x => x.id === s1.id), 'po wykonaniu znika z najbliższych');
    eq((await call(`odczyty/${s2.id}/wykonano`, { result: 'czesciowy' }, O.c)).s, 400, 'częściowy wymaga liczby lokali lub opisu');
    r = await call(`odczyty/${s2.id}/wykonano`, { result: 'czesciowy', missing_units: 3, note: 'Brak dostępu do lok. 4, 12, 31', next_due: day(30) }, O.c);
    ok(r.s === 201 && r.j.schedule.next_due === day(30) && r.j.reading.missing_units === 3, 'odczyt częściowy z ręcznym terminem');

    // ---------- cofnięcie wpisu ----------
    eq((await call(`odczyty/${s1.id}/cofnij`, { powod: 'pomyłka' }, O.c)).s, 403, 'cofanie: tylko administrator / kierownik');
    eq((await call(`odczyty/${s1.id}/cofnij`, {}, A)).s, 400, 'powód wymagany');
    r = await call(`odczyty/${s1.id}/cofnij`, { powod: 'Odczyt wpisany do złego budynku' }, A);
    ok(r.s === 200 && r.j.next_due === day(10) && r.j.last_done === day(-355), 'termin i ostatni odczyt przywrócone');
    r = await call('odczyty/' + s1.id, null, O.c);
    ok(r.j.history.length === 1 && r.j.history[0].cancelled_at && r.j.history[0].cancel_reason.includes('złego budynku'), 'wpis zostaje w historii jako cofnięty');
    eq((await call(`odczyty/${s1.id}/cofnij`, { powod: 'x' }, A)).s, 409, 'nic więcej do cofnięcia');

    // ---------- zmiana, wyłączenie ----------
    r = await call('odczyty/' + s3.id, { assigned_to: adminId, cycle_months: 24 }, O.c, 'PATCH'); eq(r.s, 200); eq(r.j.cycle_months, 24);
    ok((await notes(adminId, 'odczyt.przydzial')).some(x => x.related_id === s3.id), 'zmiana osoby → powiadomienie');
    eq((await call('odczyty/' + s3.id, { next_due: day(-400) }, O.c, 'PATCH')).s, 200, 'zmiana terminu (brak wcześniejszego odczytu)');
    await call('odczyty/' + s3.id, { is_active: false }, O.c, 'PATCH');
    eq((await call(`odczyty/${s3.id}/wykonano`, {}, O.c)).s, 409, 'nieaktywny obiekt');
    const before = (await pool.query(`SELECT count(*)::int n FROM notifications WHERE related_id = $1`, [s3.id])).rows[0].n;
    await R.reminders();
    eq((await pool.query(`SELECT count(*)::int n FROM notifications WHERE related_id = $1`, [s3.id])).rows[0].n, before, 'nieaktywny – bez przypomnień');

    // ---------- ustawienia ----------
    eq((await call('odczyty/ustawienia', { remind_days: 30, cycle_months: 12 }, O.c, 'PUT')).s, 403, 'ustawienia: administrator / kierownik');
    r = await call('odczyty/ustawienia', { remind_days: 30, cycle_months: 12 }, A, 'PUT'); eq(r.s, 200);
    eq((await call('odczyty/podsumowanie', null, O.c)).j.remind_days, 30, 'nowe domyślne wyprzedzenie');

    // ---------- karta i eksport ----------
    r = await call('odczyty/' + s2.id, null, O.c);
    ok(r.j.building_name === T + ' Brzozowa 1' && Array.isArray(r.j.devices_by_type) && r.j.history[0].done_by_name.includes('t7.odczyty') && r.j.history[0].result === 'czesciowy', 'karta obiektu z historią');
    ok((await call('odczyty/' + s1.id, null, O.c)).j.access_notes === 'Klucze u gospodarza', 'karta: dostęp do budynku');
    r = await call('odczyty/eksport', null, O.c); eq(r.s, 200, 'eksport dla obsługi odczytów');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await r.buf());
    const ws = wb.getWorksheet('Odczyty'), hs = wb.getWorksheet('Historia');
    ok(ws && hs && ws.getRow(1).values.includes('Kolejny termin') && hs.getRows(2, hs.rowCount - 1).some(x => String(x.getCell(3).value).includes('Brzozowa')), 'arkusze: harmonogram i historia');
    ok((await pool.query(`SELECT 1 FROM audit_logs WHERE ts >= $1 AND action = 'odczyt.wykonanie'`, [t0])).rows.length, 'wykonanie w rejestrze');

    console.log(`OK: testy odczytów przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    const q = (s, p = []) => pool.query(s, p).catch(e => console.error('sprzątanie:', e.message));
    await q(`UPDATE system_settings SET value = $1 WHERE key = 'readings'`, [JSON.stringify(savedSettings)]);
    const sch = (await pool.query(`SELECT s.id FROM reading_schedules s JOIN buildings b ON b.id = s.building_id WHERE b.name LIKE $1`, [T + '%'])).rows.map(x => x.id);
    await q(`DELETE FROM notifications WHERE created_at >= $1 AND (related_id = ANY($2::uuid[]) OR user_id = ANY($3::uuid[]))`, [t0, sch, users]);
    await q(`DELETE FROM readings WHERE schedule_id = ANY($1::uuid[])`, [sch]);
    await q(`DELETE FROM reading_schedules WHERE id = ANY($1::uuid[])`, [sch]);
    await q(`DELETE FROM buildings WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM customers WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM jobs WHERE kind = 'powiadomienie' AND created_at >= $1 AND status <> 'w_toku'`, [t0]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[]) OR created_at >= $2`, [users, t0]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    await pool.end(); srv.kill();
  }
})();
