// Testy ERP – etap 3 (fundamenty): nowe role i uprawnienia w backendzie, klient „osoba prywatna”, wyszukiwanie klienta
// po telefonie/e-mailu/identyfikatorze, karta klienta 360°, globalne wyszukiwanie z filtrem uprawnień, zapisane widoki,
// asystent telefoniczny bez działalności taxi. Dane robocze [T-ERP3] są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };

(async () => {
  const PORT = 6700 + Math.floor(Math.random() * 200), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})), c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [], PASS = 'Erp-Test-2026x';
  const ids = { customers: [], buildings: [], orders: [], installations: [] };
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const hash = await bcrypt.hash(PASS, 4);
    const mk = async (login, role, extra = []) => {
      const id = (await pool.query(`INSERT INTO users (login, password_hash, role, extra_roles, full_name, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [login, hash, role, extra, '[T-ERP3] ' + login])).rows[0].id;
      users.push(id);
      const c = (await call('login', { login, password: PASS })).c;
      return { id, c, me: (await call('me', null, c)).j };
    };

    // ---------- role ----------
    const OW = await mk('terp3.wlasciciel', 'wlasciciel'), MG = await mk('terp3.magazyn', 'magazynier'), KS = await mk('terp3.ksiegowa', 'ksiegowosc');
    const LIM = await mk('terp3.ograniczony', 'ograniczony'), BIU = await mk('terp3.biuro', 'uzytkownik'), MON = await mk('terp3.monter', 'monter');
    const p = u => u.me.permissions || [];
    ok(p(OW).includes('owner.dashboard') && p(OW).includes('finance.view') && p(OW).includes('departments.view'), 'właściciel: dashboard, finanse, działy');
    ok(!p(OW).includes('users.manage'), 'właściciel nie zarządza kontami (to administrator)');
    ok(p(MG).includes('stock.manage') && p(MG).includes('purchases.manage') && !p(MG).includes('departments.view') && !p(MG).includes('finance.view'), 'magazynier: magazyn i zakupy, bez działów i finansów');
    ok(p(KS).includes('finance.view') && !p(KS).includes('service.manage') && !p(KS).includes('stock.manage'), 'księgowość: finanse, bez zleceń i ruchów magazynu');
    ok(!p(LIM).some(x => ['departments.view', 'tasks.use', 'search.global', 'finance.view', 'time.own'].includes(x)), 'dostęp ograniczony: brak modułów firmy');
    ok(p(BIU).includes('insurance.manage') && !p(BIU).includes('owner.dashboard'), 'biuro: polisy, bez dashboardu właściciela');
    eq((await call('klienci', null, LIM.c)).s, 403, 'ograniczony: klienci zablokowani w backendzie');
    eq((await call('szukaj?q=test', null, LIM.c)).s, 403, 'ograniczony: wyszukiwanie zablokowane');
    eq((await call('klienci', null, MG.c)).s, 403, 'magazynier: klienci zablokowani');
    eq((await call('klienci', null, KS.c)).s, 200, 'księgowość: klienci dostępni');
    eq((await pool.query(`INSERT INTO users (login, password_hash, role, extra_roles) VALUES ('terp3.zla', 'x', 'ograniczony', '{administrator}') RETURNING id`).catch(e => ({ e }))).e?.code, '23514', 'administrator nie może być rolą dodatkową (CHECK)');
    const bad = await pool.query(`INSERT INTO users (login, password_hash, role) VALUES ('terp3.zla2', 'x', 'szef') RETURNING id`).catch(e => ({ e }));
    eq(bad.e && bad.e.code, '23514', 'nieznana rola odrzucona przez bazę');
    const adm = (await pool.query(`SELECT id FROM users WHERE role = 'administrator' AND is_active ORDER BY created_at LIMIT 1`)).rows[0];
    let r = await call('konta', { login: 'terp3.nowy', full_name: 'Nowy Magazynier', role: 'magazynier', extra_roles: ['ksiegowosc'] }, BIU.c);
    eq(r.s, 403, 'konto zakłada tylko administrator');

    // ---------- klienci: osoba prywatna, wyszukiwanie ----------
    r = await call('klienci', { kind: 'osoba_prywatna', name: '[T-ERP3] Jan Kowalski', phone: '+48 600-123-456', email: 'jan.kowalski.terp3@example.com', address: 'ul. Testowa 5, Zielona Góra' }, BIU.c);
    eq(r.s, 201, 'osoba prywatna dodana'); eq(r.j.kind, 'osoba_prywatna'); const JAN = r.j.id; ids.customers.push(JAN);
    r = await call('klienci', { kind: 'firma', name: '[T-ERP3] Firma 100% Testa% Test_', phone: '68 111 22 33' }, BIU.c); ids.customers.push(r.j.id);
    eq((await call('klienci', { kind: 'kosmita', name: '[T-ERP3] X' }, BIU.c)).s, 400, 'nieznany rodzaj klienta odrzucony');
    r = await call('klienci?q=600123456', null, BIU.c); ok(r.j.some(c => c.id === JAN), 'wyszukiwanie po telefonie (same cyfry)');
    r = await call('klienci?q=' + encodeURIComponent('600 123'), null, BIU.c); ok(r.j.some(c => c.id === JAN), 'wyszukiwanie po fragmencie telefonu ze spacją');
    r = await call('klienci?q=jan.kowalski.terp3', null, BIU.c); ok(r.j.some(c => c.id === JAN), 'wyszukiwanie po e-mailu');
    r = await call('klienci?q=' + JAN, null, BIU.c); ok(r.j.length === 1 && r.j[0].id === JAN, 'wyszukiwanie po identyfikatorze');
    r = await call('klienci?q=' + encodeURIComponent('a%'), null, BIU.c); ok(r.j.length >= 1 && r.j.every(c => [c.name, c.address, c.email, c.tax_id].some(v => String(v).toLowerCase().includes('a%'))), '„%” wyszukiwane dosłownie (bez dopasowania wszystkiego)');
    r = await call('klienci?q=' + encodeURIComponent('100%'), null, BIU.c); ok(r.j.some(c => c.name.includes('100%')), 'nazwa z „%” znaleziona');
    r = await call('klienci?q=' + encodeURIComponent('Test_'), null, BIU.c); ok(r.j.every(c => c.name.includes('Test_')), '„_” wyszukiwane dosłownie');

    // ---------- karta klienta 360° ----------
    const b = (await call('d1/budynki', { customer_id: JAN, name: '[T-ERP3] Dom Kowalskich', address: 'ul. Testowa 5', city: 'Zielona Góra', units_count: 1, potwierdz_duplikat: true }, BIU.c)).j; ids.buildings.push(b.id);
    const inst = (await call('d1/montaze', { building_id: b.id, planned_date: '2031-05-04', devices_planned: 6 }, BIU.c)).j; ids.installations.push(inst.id);
    ok(inst.number, 'montaż u klienta');
    const so = (await call('serwisy', { customer_id: JAN, building_id: b.id, client_name: '[T-ERP3] Jan Kowalski', address: 'ul. Testowa 5', city: 'Zielona Góra',
      contact_phone: '+48 600 123 456', description: '[T-ERP3] Podzielnik nie pokazuje odczytu' }, BIU.c));
    eq(so.s, 201, 'zlecenie serwisowe u klienta'); ids.orders.push(so.j.id);
    r = await call('klienci/' + JAN, null, BIU.c);
    ok(r.j.service_orders.some(x => x.id === so.j.id) && r.j.installations.some(x => x.id === inst.id) && Array.isArray(r.j.reading_schedules) && Array.isArray(r.j.documents), 'karta 360°: serwisy, montaże, odczyty, dokumenty');
    r = await call('klienci/' + JAN, null, KS.c);
    ok(r.s === 200 && r.j.service_orders === undefined && Array.isArray(r.j.installations), 'karta 360°: sekcje tylko z uprawnieniami (księgowość bez zleceń serwisowych)');

    // ---------- globalne wyszukiwanie ----------
    r = await call('szukaj?q=' + encodeURIComponent('[T-ERP3] Jan'), null, BIU.c);
    const g = k => (r.j.groups.find(x => x.key === k) || { items: [] }).items;
    ok(g('klienci').some(x => x.id === JAN && x.link === '/crm?klient=' + JAN), 'szukaj: klient z linkiem do karty');
    ok(g('serwisy').some(x => x.id === so.j.id && x.link.includes('tab=serwisy&z=' + so.j.id)), 'szukaj: zlecenie serwisowe po nazwisku klienta');
    r = await call('szukaj?q=' + encodeURIComponent(so.j.number), null, BIU.c); ok(r.j.groups.some(x => x.key === 'serwisy'), 'szukaj: numer zlecenia');
    r = await call('szukaj?q=' + encodeURIComponent(inst.number), null, BIU.c); ok(g('montaze').some(x => x.id === inst.id && x.link.endsWith('m=' + inst.id)), 'szukaj: numer montażu');
    r = await call('szukaj?q=Dom Kowalskich', null, BIU.c); ok(g('budynki').some(x => x.id === b.id), 'szukaj: budynek');
    r = await call('szukaj?q=600-123-456', null, BIU.c); ok(g('klienci').some(x => x.id === JAN), 'szukaj: telefon w innym zapisie');
    r = await call('szukaj?q=' + encodeURIComponent('[T-ERP3] Jan'), null, MON.c); eq(r.s, 403, 'monter: bez globalnego wyszukiwania');
    r = await call('szukaj?q=' + encodeURIComponent('[T-ERP3] Jan'), null, MG.c);
    ok(r.s === 200 && !r.j.groups.some(x => ['klienci', 'serwisy', 'budynki'].includes(x.key)), 'magazynier: wyniki bez klientów i zleceń (brak uprawnień)');
    r = await call('szukaj?q=' + encodeURIComponent('[T-ERP3] Jan'), null, KS.c);
    ok(r.j.groups.some(x => x.key === 'klienci') && !r.j.groups.some(x => x.key === 'serwisy'), 'księgowość: klienci tak, zlecenia serwisowe nie');
    r = await call('szukaj?q=a', null, BIU.c); ok(r.s === 200 && r.j.groups.length === 0, 'min. 2 znaki');
    r = await call('szukaj?q=' + encodeURIComponent('%%'), null, BIU.c); ok(!r.j.groups.some(x => x.items.length >= 6 && x.key === 'klienci' && !x.items.every(i => i.title.includes('%%'))), '„%%” nie zwraca wszystkiego');

    // ---------- zapisane widoki ----------
    r = await call('widoki', { modul: 'harmonogram', nazwa: 'Ekipa 1', params: { widok: 'tydzien', ekipa: 'x' } }, BIU.c); eq(r.s, 201, 'widok zapisany');
    const V1 = r.j.id;
    r = await call('widoki', { modul: 'harmonogram', nazwa: 'Ekipa 1', params: { widok: 'miesiac' } }, BIU.c); eq(r.j.id, V1, 'ta sama nazwa nadpisuje widok');
    r = await call('widoki?modul=harmonogram', null, BIU.c); ok(r.j.length === 1 && r.j[0].params.widok === 'miesiac', 'lista widoków z nowymi ustawieniami');
    r = await call('widoki?modul=harmonogram', null, OW.c); eq(r.j.length, 0, 'widoki innej osoby niewidoczne');
    eq((await call('widoki/' + V1, null, OW.c, 'DELETE')).s, 404, 'nie można usunąć cudzego widoku');
    eq((await call('widoki', { modul: 'Zły moduł!', nazwa: 'x', params: {} }, BIU.c)).s, 400, 'nazwa modułu walidowana');
    eq((await call('widoki', { modul: 'harmonogram', nazwa: 'Duży', params: { x: 'a'.repeat(5000) } }, BIU.c)).s, 400, 'limit rozmiaru ustawień');
    eq((await call('widoki', { modul: 'harmonogram', nazwa: 'Bez', params: [1] }, BIU.c)).s, 400, 'ustawienia muszą być obiektem');
    eq((await call('widoki/' + V1, null, BIU.c, 'DELETE')).s, 200, 'usunięcie własnego widoku');
    eq((await call('widoki?modul=harmonogram', null, BIU.c)).j.length, 0, 'widok usunięty');

    // ---------- asystent telefoniczny bez taxi ----------
    const phone = require('../lib/phone');
    ok(!phone.DEPTS.includes('taxi') && !phone.KINDS.includes('taxi'), 'taxi usunięte z działów i rodzajów zgłoszeń');
    const parsed = phone.parse({ call_sid: 'T-ERP3-1', rozpoczeta: new Date().toISOString(), dzial: 'taxi', zgloszenia: [{ rodzaj: 'taxi', opis: 'x' }] });
    ok(parsed.department === 'inne' && parsed.requests[0].kind === 'inne' && parsed.requests[0].department === 'inne', 'starsza wartość „taxi” od bota przyjmowana jako „inne”');

    // ---------- nazwy działów ----------
    const d = (await pool.query(`SELECT id, name FROM departments ORDER BY sort_order`)).rows;
    ok(d.find(x => x.id === 'podzielniki-i-montaze').name === 'Ciepłomierze i podzielniki' && d.find(x => x.id === 'sprzedaz-czesci-i-eksport').name === 'Sprzedaż części samochodowych', 'nazwy działów zgodne ze strukturą firmy');
    void adm;
    console.log(`OK: testy ERP – fundamenty przeszły (${passed} sprawdzeń)`);
  } catch (e) {
    console.error('BŁĄD:', e.message); process.exitCode = 1;
  } finally {
    await pool.query('DELETE FROM service_events WHERE order_id = ANY($1::uuid[])', [ids.orders]).catch(e => console.error(e.message));
    await pool.query('DELETE FROM notifications WHERE related_id = ANY($1::uuid[])', [ids.orders]).catch(() => {});
    await pool.query('DELETE FROM service_orders WHERE id = ANY($1::uuid[])', [ids.orders]).catch(e => console.error(e.message));
    await pool.query('DELETE FROM installations WHERE id = ANY($1::uuid[])', [ids.installations]).catch(e => console.error(e.message));
    await pool.query('DELETE FROM buildings WHERE id = ANY($1::uuid[])', [ids.buildings]).catch(e => console.error(e.message));
    await pool.query('DELETE FROM customers WHERE id = ANY($1::uuid[])', [ids.customers]).catch(e => console.error(e.message));
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]).catch(() => {});
    await pool.query(`DELETE FROM user_views WHERE user_id = ANY($1::uuid[])`, [users]).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [users]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[]) OR login LIKE 'terp3.%'`, [users]).catch(e => console.error('sprzątanie kont:', e.message));
    await restoreFlags();
    srv.kill(); await pool.end();
  }
})();
