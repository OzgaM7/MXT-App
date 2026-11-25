// Testy regresyjne poprawek po audycie produkcyjnym (24.11.2026).
// N1 serwer przeżywa zerwanie połączeń z bazą; N2 finanse: uprawnienia, podwójny przychód, zaokrąglenia;
// N3 klienci: NIP, duplikaty, archiwum, usuwanie bez historii, anonimizacja RODO;
// N4 pracownicy, budynki, polisy, dokumenty magazynowe, zamówienia zakupu; N5 błędy 400/413, HSTS, dokumenty polis,
// konflikty równoczesnej edycji; N6 stronicowanie list. Dane robocze [T-AUD] są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };

// Poprawne NIP-y (suma kontrolna) – wyłącznie do testów.
const NIP = ['7110079199', '7110158384', '7110316765', '7110395954'];

(async () => {
  const PORT = require('./_setup').testPort(7600, 300);
  const base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0', PGAPPNAME: 'mxt-test-audyt-' + PORT }, stdio: ['ignore', 'ignore', 'inherit'] });
  const raw = (p, opt = {}) => fetch(base + '/api/' + p, opt);
  const call = async (p, body, cookie, method) => {
    const r = await raw(p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { s: r.status, h: r.headers, j: ct.includes('json') ? await r.json().catch(() => ({})) : {} };
  };
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [], PASS = 'Audyt-Test-2026x', T = { customers: [], finance: [], buildings: [], policies: [], items: [], docs: [], pos: [], suppliers: [] };
  const { warsawDay } = require('./_setup'), today = warsawDay();
  try {
    for (let i = 0; i < 60; i++) { try { await raw('health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const hash = await bcrypt.hash(PASS, 4);
    const mk = async (login, role) => {
      const id = (await pool.query(`INSERT INTO users (login, password_hash, role, full_name, must_change_password) VALUES ($1, $2, $3, $4, false) RETURNING id`, [login, hash, role, '[T-AUD] ' + login])).rows[0].id;
      users.push(id);
      const r = await raw('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: PASS }) });
      return { id, c: (r.headers.get('set-cookie') || '').split(';')[0] };
    };
    const AD = await mk('taud.admin', 'administrator'), KR = await mk('taud.kierownik', 'kierownik'), UZ = await mk('taud.biuro', 'uzytkownik'),
      KS = await mk('taud.ksiegowa', 'ksiegowosc'), MG = await mk('taud.magazyn', 'magazynier'), RZ = await mk('taud.rozlicza', 'rozliczajacy');

    // ---------- N1: zerwanie połączeń z bazą nie zatrzymuje serwera ----------
    ok(pool.listenerCount('error') > 0, 'pula połączeń ma obsługę zdarzenia „error”');
    await call('klienci?q=x', null, UZ.c);   // serwer ma otwarte połączenia w puli
    // tylko połączenia serwera tego testu (application_name) – inne procesy na tej bazie nie są ruszane
    const killed = (await pool.query(`SELECT count(pg_terminate_backend(pid))::int n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1`, ['mxt-test-audyt-' + PORT])).rows[0].n;
    ok(killed > 0, 'zerwano połączenia serwera testowego (' + killed + ')');
    await new Promise(r => setTimeout(r, 400));
    let r = await call('klienci?q=x', null, UZ.c);
    eq(r.s, 200, 'po zerwaniu połączeń serwer działa i odpowiada z bazy');

    // ---------- N2: finanse – uprawnienia, podwójny przychód, zaokrąglenia ----------
    for (const p of ['finanse', 'finanse/podsumowanie', 'bi', 'd1/rentownosc', 'eksport/d1/finanse', 'eksport/d1/rentownosc']) eq((await call(p, null, UZ.c)).s, 403, 'biuro bez finance.view: ' + p);
    eq((await call('finanse', { department_id: 'podzielniki-i-montaze', kind: 'koszt', amount: 1 }, UZ.c)).s, 403, 'biuro nie dodaje wpisów finansowych');
    eq((await call('finanse', null, KS.c)).s, 200, 'księgowość widzi finanse');
    const inv = 'FV/T-AUD/' + Date.now();
    const fin = { department_id: 'podzielniki-i-montaze', kind: 'przychod', amount: 33.335, currency: 'PLN', description: '[T-AUD] przychód', invoice_no: inv };
    r = await call('finanse', fin, KS.c); eq(r.s, 201, 'przychód zapisany'); T.finance.push(r.j.id);
    eq(Number(r.j.amount), 33.34, 'kwota zaokrąglona do grosza'); eq(Number(r.j.amount_pln), 33.34, 'kwota PLN spójna z kwotą');
    r = await call('finanse', { ...fin, invoice_no: ' ' + inv.toLowerCase() + ' ' }, KS.c);
    ok(r.s === 409 && r.j.duplikat, 'ta sama faktura drugi raz – ostrzeżenie o duplikacie (409)');
    r = await call('finanse', { ...fin, potwierdz_duplikat: true }, KS.c); eq(r.s, 201, 'świadome potwierdzenie zapisuje drugi wpis'); T.finance.push(r.j.id);
    r = await call('finanse', { ...fin, kind: 'koszt', invoice_no: inv }, KS.c); eq(r.s, 201, 'koszt z tym numerem faktury nie jest blokowany'); T.finance.push(r.j.id);

    // ---------- N3: klienci ----------
    eq((await call('klienci', { kind: 'firma', name: '[T-AUD] Zły NIP', tax_id: '1234567890' }, UZ.c)).s, 400, 'NIP z błędną sumą kontrolną odrzucony');
    r = await call('klienci', { kind: 'firma', name: '[T-AUD] Firma NIP', tax_id: 'PL ' + NIP[0].replace(/(\d{3})(\d{3})(\d{2})(\d{2})/, '$1-$2-$3-$4') }, UZ.c);
    eq(r.s, 201, 'poprawny NIP z prefiksem i myślnikami przyjęty'); const C1 = r.j; T.customers.push(C1.id);
    eq((await call('klienci', { kind: 'klient_zagraniczny', country: 'DE', name: '[T-AUD] GmbH', tax_id: 'DE123456789' }, UZ.c)).s, 201, 'zagraniczny VAT ID bez kontroli sumy');
    T.customers.push((await pool.query(`SELECT id FROM customers WHERE name = '[T-AUD] GmbH'`)).rows[0].id);
    r = await call('klienci', { kind: 'firma', name: '[T-AUD] Inna nazwa', tax_id: NIP[0] }, UZ.c);
    ok(r.s === 409 && r.j.duplikat && r.j.istniejacy.id === C1.id, 'ten sam NIP – ostrzeżenie o istniejącym kliencie');
    const P = { kind: 'osoba_prywatna', name: '[T-AUD] Jan Odświeżony', phone: '601 222 333' };
    r = await call('klienci', P, UZ.c); eq(r.s, 201, 'klient prywatny'); const C2 = r.j; T.customers.push(C2.id);
    r = await call('klienci', { ...P, phone: '+48 601-222-333' }, UZ.c); ok(r.s === 409 && r.j.duplikat, 'ponowny zapis po odświeżeniu strony – ostrzeżenie zamiast duplikatu');
    r = await call('klienci', { ...P, potwierdz_duplikat: true }, UZ.c); eq(r.s, 201, 'potwierdzony duplikat (np. imiennik) zapisany'); const C3 = r.j; T.customers.push(C3.id);
    eq((await call('klienci/' + C1.id, { name: '[T-AUD] Firma NIP – zmiana' }, UZ.c, 'PATCH')).s, 200, 'edycja klienta przez biuro');

    // usuwanie: klient bez historii (kierownik), klient z historią – 409, biuro – 403
    eq((await call('klienci/' + C3.id, null, UZ.c, 'DELETE')).s, 403, 'biuro nie usuwa klientów');
    eq((await call('klienci/' + C3.id + '/powiazania', null, UZ.c)).j.length, 0, 'klient bez historii – brak powiązań');
    eq((await call('klienci/' + C3.id, null, KR.c, 'DELETE')).s, 200, 'kierownik usuwa klienta bez historii');
    eq((await pool.query('SELECT count(*)::int n FROM customers WHERE id = $1', [C3.id])).rows[0].n, 0, 'klient usunięty z bazy');
    r = await call('d1/budynki', { name: '[T-AUD] Blok klienta', address: 'ul. Audytowa 1', city: 'Testowo', customer_id: C1.id }, AD.c); eq(r.s, 201, 'budynek klienta'); T.buildings.push(r.j.id);
    const B1 = r.j;
    r = await call('klienci/' + C1.id, null, KR.c, 'DELETE'); ok(r.s === 409 && /budynki: 1/.test(r.j.error), 'klient z historią nie jest kasowany (409, lista powiązań)');

    // archiwum: znika z listy i wyszukiwarki, wraca po przywróceniu
    eq((await call('klienci/' + C2.id + '/archiwizuj', { powod: 'nieaktywny' }, UZ.c)).s, 200, 'archiwizacja przez biuro');
    ok(!(await call('klienci?q=' + encodeURIComponent('Jan Odświeżony'), null, UZ.c)).j.some(c => c.id === C2.id), 'zarchiwizowany klient nie jest na liście');
    ok((await call('klienci?archiwum=1&q=' + encodeURIComponent('Jan Odświeżony'), null, UZ.c)).j.some(c => c.id === C2.id), 'zarchiwizowany klient jest w archiwum');
    const g = (await call('szukaj?q=' + encodeURIComponent('Jan Odświeżony'), null, UZ.c)).j.groups || [];
    ok(!g.some(x => (x.items || []).some(i => String(i.url || i.href || '').includes(C2.id) || i.id === C2.id)), 'zarchiwizowany klient nie jest w wyszukiwarce');
    eq((await call('klienci/' + C2.id + '/archiwizuj', {}, UZ.c)).s, 409, 'ponowna archiwizacja – 409 (już w archiwum)');
    eq((await call('klienci/' + C2.id + '/przywroc', {}, UZ.c)).s, 200, 'przywrócenie z archiwum');
    ok((await call('klienci?q=' + encodeURIComponent('Jan Odświeżony'), null, UZ.c)).j.some(c => c.id === C2.id), 'przywrócony klient wraca na listę');

    // anonimizacja RODO: dane osobowe usunięte, dokumenty zostają
    await pool.query(`INSERT INTO communications (customer_id, channel, subject, body, created_by) VALUES ($1, 'notatka', '[T-AUD]', 'rozmowa z klientem', $2)`, [C1.id, AD.id]);
    eq((await call('klienci/' + C1.id + '/anonimizuj', { powod: 'x' }, UZ.c)).s, 403, 'biuro nie anonimizuje');
    eq((await call('klienci/' + C1.id + '/anonimizuj', {}, KR.c)).s, 400, 'anonimizacja wymaga podstawy');
    eq((await call('klienci/' + C1.id + '/anonimizuj', { powod: 'żądanie klienta' }, KR.c)).s, 200, 'anonimizacja przez kierownika');
    const an = (await pool.query('SELECT * FROM customers WHERE id = $1', [C1.id])).rows[0];
    ok(/^Klient zanonimizowany /.test(an.name) && an.tax_id === '' && an.phone === '' && an.email === '' && an.address === '' && an.anonymized_at && an.archived_at, 'dane osobowe usunięte, klient w archiwum');
    eq((await pool.query('SELECT count(*)::int n FROM communications WHERE customer_id = $1', [C1.id])).rows[0].n, 0, 'historia kontaktów usunięta');
    eq((await pool.query('SELECT count(*)::int n FROM buildings WHERE id = $1 AND customer_id = $2', [B1.id, C1.id])).rows[0].n, 1, 'budynek i powiązania zostają');
    eq((await call('klienci/' + C1.id + '/przywroc', {}, KR.c)).s, 409, 'zanonimizowanego klienta nie można przywrócić');
    ok((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action = 'klient.anonimizacja' AND resource_id = $1`, [String(C1.id)])).rows[0].n === 1, 'anonimizacja w dzienniku zdarzeń');

    // ---------- N4a: pracownicy – konto bez historii można usunąć, z historią tylko wyłączyć ----------
    r = await call('konta', { login: 'taud.pomylka', full_name: '[T-AUD] Pomyłka', role: 'monter' }, AD.c); eq(r.s, 201, 'konto założone'); const ACC = r.j.id; users.push(ACC);
    eq((await call('konta/' + ACC, null, KR.c, 'DELETE')).s, 403, 'kierownik nie usuwa kont');
    eq((await call('konta/' + ACC + '/historia', null, AD.c)).j.length, 0, 'nowe konto bez historii');
    eq((await call('konta/' + ACC, null, AD.c, 'DELETE')).s, 200, 'administrator usuwa konto bez historii');
    eq((await pool.query('SELECT count(*)::int n FROM users WHERE id = $1', [ACC])).rows[0].n, 0, 'konto usunięte z bazy');
    eq((await call('konta/' + AD.id, null, AD.c, 'DELETE')).s, 400, 'nie można usunąć własnego konta');
    r = await call('konta/' + UZ.id, null, AD.c, 'DELETE'); ok(r.s === 409 && /klienci/.test(r.j.error), 'konto z historią (założeni klienci) – 409 z listą, zamiast usunięcia');
    r = await call('konta/' + KS.id, { is_active: false }, AD.c, 'PATCH'); eq(r.s, 200, 'wyłączenie konta'); ok(r.j.is_active === false, 'konto wyłączone');
    eq((await call('finanse', null, KS.c)).s, 401, 'wyłączone konto zostało wylogowane');
    ok((await call('pracownicy', null, KR.c)).j.rows.some(x => x.id === KS.id && !x.is_active), 'kartoteka pokazuje wyłączone konto (filtr w interfejsie)');

    // ---------- N4b: budynki – duplikat adresu, archiwum, usuwanie bez historii, finanse tylko z uprawnieniem ----------
    const BD = { name: '[T-AUD] Blok A', address: 'ul. Kontrolna 7', city: 'Testowo' };
    r = await call('d1/budynki', BD, UZ.c); eq(r.s, 201, 'budynek'); const B2 = r.j; T.buildings.push(B2.id);
    r = await call('d1/budynki', { ...BD, name: '[T-AUD] Blok A2', address: 'UL. KONTROLNA 7.' }, UZ.c); ok(r.s === 409 && r.j.duplikat && r.j.istniejacy.id === B2.id, 'ten sam adres – ostrzeżenie o duplikacie');
    r = await call('d1/budynki', { ...BD, name: '[T-AUD] Blok A – klatka B', potwierdz_duplikat: true }, UZ.c); eq(r.s, 201, 'potwierdzony drugi budynek pod tym adresem'); const B3 = r.j; T.buildings.push(B3.id);
    ok(!('przychod' in ((await call('d1/budynki?q=' + encodeURIComponent('[T-AUD] Blok A'), null, UZ.c)).j[0] || {})), 'biuro bez finance.view – lista budynków bez przychodów i kosztów');
    r = await call('d1/budynki/' + B1.id, null, UZ.c); ok(!('przychod' in r.j) && r.j.finance.length === 0, 'karta budynku bez finansów dla biura');
    ok('przychod' in (await call('d1/budynki/' + B1.id, null, KR.c)).j, 'kierownik widzi finanse budynku');
    eq((await call('d1/budynki/' + B3.id, null, UZ.c, 'DELETE')).s, 200, 'budynek bez historii usunięty');
    await pool.query(`INSERT INTO units (building_id, number, created_by) VALUES ($1, '1', $2)`, [B2.id, AD.id]);
    r = await call('d1/budynki/' + B2.id, null, UZ.c, 'DELETE'); ok(r.s === 409 && /lokale: 1/.test(r.j.error), 'budynek z lokalami – 409');
    eq((await call('d1/budynki/' + B2.id + '/archiwizuj', {}, UZ.c)).s, 200, 'archiwizacja budynku');
    ok(!(await call('d1/budynki?q=Kontrolna', null, UZ.c)).j.some(b => b.id === B2.id), 'zarchiwizowany budynek nie jest na liście');
    ok((await call('d1/budynki?archiwum=1&q=Kontrolna', null, UZ.c)).j.some(b => b.id === B2.id), 'zarchiwizowany budynek w archiwum');
    ok(!((await call('szukaj?q=Kontrolna', null, UZ.c)).j.groups || []).some(g => g.key === 'budynki' && g.items.some(i => i.id === B2.id)), 'zarchiwizowany budynek nie jest w wyszukiwarce');
    eq((await call('d1/budynki/' + B2.id + '/przywroc', {}, UZ.c)).s, 200, 'przywrócenie budynku');

    // ---------- N4c: polisy – anulowanie błędnego wpisu (poza sumami, wynikami i przypomnieniami) ----------
    const PCUST = (await call('klienci', { kind: 'osoba_prywatna', name: '[T-AUD] Ubezpieczony', phone: '600 700 800' }, UZ.c)).j; T.customers.push(PCUST.id);
    const inDays = n => warsawDay(n);
    const pol = (number, extra = {}) => call('polisy', { number, customer_id: PCUST.id, insurer: '[T-AUD] TU', insurance_type: 'Mieszkanie / dom', signed_at: today, start_date: today, end_date: inDays(20), total_amount: '1000.00', margin_pct: '10', ...extra }, UZ.c);
    const sum0 = (await call('polisy/podsumowanie?towarzystwo=' + encodeURIComponent('[T-AUD] TU'), null, UZ.c)).j;
    r = await pol('T-AUD/1'); eq(r.s, 201, 'polisa 1'); const P1 = r.j; T.policies.push(P1.id);
    r = await pol('T-AUD/2', { odnawia: P1.id, start_date: inDays(20), end_date: inDays(385) }); eq(r.s, 201, 'polisa 2 odnawia polisę 1'); const P2 = r.j; T.policies.push(P2.id);
    r = await pol('T-AUD/3'); const P3 = r.j; T.policies.push(P3.id);
    let sum = (await call('polisy/podsumowanie?towarzystwo=' + encodeURIComponent('[T-AUD] TU'), null, UZ.c)).j;
    eq(sum.liczba - (sum0.liczba || 0), 3, 'trzy polisy w podsumowaniu');
    eq((await call('polisy/' + P1.id + '/anuluj', { powod: 'pomyłka' }, UZ.c)).s, 409, 'polisy z odnowieniem nie anuluje się przed anulowaniem odnowienia');
    eq((await call('polisy/' + P3.id + '/anuluj', { powod: 'x' }, UZ.c)).s, 400, 'anulowanie wymaga powodu (min. 3 znaki)');
    eq((await call('polisy/' + P3.id + '/anuluj', { powod: 'wpisana dwa razy' }, UZ.c)).s, 200, 'polisa 3 anulowana');
    eq((await call('polisy/' + P2.id + '/anuluj', { powod: 'odnowienie nie doszło do skutku' }, UZ.c)).s, 200, 'odnowienie (polisa 2) anulowane');
    sum = (await call('polisy/podsumowanie?towarzystwo=' + encodeURIComponent('[T-AUD] TU'), null, UZ.c)).j;
    eq(sum.liczba - (sum0.liczba || 0), 1, 'anulowane polisy nie wchodzą do sum'); eq(Math.round((sum.zysk - (sum0.zysk || 0)) * 100) / 100, 100, 'zysk tylko z polisy 1 (10% z 1000 zł)');
    r = await call('polisy/' + P1.id, null, UZ.c); ok(!r.j.renewed_by && r.j.status === 'konczy_sie', 'polisa 1 znów czeka na odnowienie');
    ok((await call('polisy/do-odnowienia', null, UZ.c)).j.some(x => x.id === P1.id) && !(await call('polisy/do-odnowienia', null, UZ.c)).j.some(x => x.id === P3.id), 'lista do odnowienia: polisa 1 tak, anulowana 3 nie');
    ok(!(await call('polisy?q=T-AUD', null, UZ.c)).j.some(x => x.id === P3.id), 'anulowana polisa nie jest na domyślnej liście');
    ok((await call('polisy?status=anulowana&q=T-AUD', null, UZ.c)).j.some(x => x.id === P3.id && x.status === 'anulowana'), 'anulowana polisa w filtrze „Anulowana”');
    eq((await call('polisy/' + P3.id, { notes: 'x' }, UZ.c, 'PATCH')).s, 409, 'anulowanej polisy nie edytuje się');
    await require('../lib/erp/policies').tick(new Date());
    eq((await pool.query(`SELECT count(*)::int n FROM policy_reminders WHERE policy_id = ANY($1::uuid[])`, [[P2.id, P3.id]])).rows[0].n, 0, 'brak przypomnień o anulowanych polisach');
    ok((await pool.query(`SELECT count(*)::int n FROM policy_reminders WHERE policy_id = $1`, [P1.id])).rows[0].n === 1, 'przypomnienie o polisie 1 (koniec za 20 dni)');
    r = await call('finanse-erp/wyniki?od=' + today + '&do=' + today, null, KR.c);
    ok(r.s === 200, 'wyniki działów liczą się bez anulowanych polis');
    eq((await call('polisy/' + P2.id + '/przywroc', {}, UZ.c)).s, 200, 'cofnięcie anulowania polisy 2');
    r = await call('polisy/' + P1.id, null, UZ.c); eq(r.j.renewed_by, P2.id, 'po przywróceniu polisa 2 znów odnawia polisę 1');

    // ---------- N4d: dokumenty magazynowe – anulowanie z cofnięciem stanów; N4e: edycja szkicu zamówienia zakupu ----------
    const W = (await call('magazyn/magazyny', null, MG.c)).j.find(w => w.code === 'MAG');
    r = await call('magazyn/pozycje', { sku: 'T-AUD-1', name: '[T-AUD] Kabel', kind: 'material', department_id: 'podzielniki-i-montaze', purchase_price: 10 }, MG.c); eq(r.s, 201, 'pozycja magazynowa'); const IT = r.j; T.items.push(IT.id);
    const lvl = async () => (await pool.query('SELECT qty::float q FROM stock_levels WHERE item_id = $1 AND warehouse_id = $2', [IT.id, W.id])).rows[0].q;
    const avg = async () => (await pool.query('SELECT avg_cost::float a FROM stock_items WHERE id = $1', [IT.id])).rows[0].a;
    r = await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, lines: [{ item_id: IT.id, qty: 10, unit_cost: 10 }] }, MG.c); eq(r.s, 201, 'PZ 10 × 10 zł'); const PZ1 = r.j;
    r = await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, lines: [{ item_id: IT.id, qty: 10, unit_cost: 20 }] }, MG.c); const PZ2 = r.j;
    eq(await lvl(), 20, 'stan 20'); eq(await avg(), 15, 'średni koszt 15 zł');
    eq((await call('magazyn/dokumenty/' + PZ2.id + '/anuluj', { powod: 'zła cena' }, UZ.c)).s, 403, 'biuro nie anuluje PZ');
    r = await call('magazyn/dokumenty/' + PZ2.id + '/anuluj', { powod: 'pomyłka w cenie' }, MG.c); ok(r.s === 200 && r.j.status === 'anulowany', 'PZ anulowany');
    eq(await lvl(), 10, 'stan wrócił do 10'); eq(await avg(), 10, 'średni koszt bez anulowanej dostawy (10 zł)');
    eq((await call('magazyn/dokumenty/' + PZ2.id + '/anuluj', { powod: 'drugi raz' }, MG.c)).s, 409, 'drugie anulowanie – 409');
    r = await call('magazyn/dokumenty', { kind: 'WZ', warehouse_id: W.id, lines: [{ item_id: IT.id, qty: 8 }] }, MG.c); eq(r.s, 201, 'wydanie 8 szt.'); const WZ1 = r.j;
    r = await call('magazyn/dokumenty/' + PZ1.id + '/anuluj', { powod: 'pomyłka' }, MG.c); ok(r.s === 409 && /wydany/.test(r.j.error), 'PZ z towarem już wydanym nie anuluje się (stan nie spadnie poniżej zera)');
    eq(await lvl(), 2, 'stan bez zmian po odrzuconym anulowaniu');
    eq((await call('magazyn/dokumenty/' + WZ1.id + '/anuluj', { powod: 'wydanie wpisane omyłkowo' }, MG.c)).s, 200, 'WZ anulowany');
    eq(await lvl(), 10, 'towar wrócił na stan');
    eq((await pool.query(`SELECT count(*)::int n FROM cost_ledger WHERE description LIKE $1`, [WZ1.number + ' ·%'])).rows[0].n, 0, 'anulowane wydanie nie liczy się do kosztów');
    r = await call('magazyn/pozycje/' + IT.id, null, MG.c); ok(!r.j.moves || !r.j.moves.some(m => m.number === PZ2.number), 'historia ruchów bez anulowanego dokumentu');
    r = await call('magazyn/dostawcy', { name: '[T-AUD] Hurtownia', payment_days: 14 }, MG.c); const SUP = r.j; T.suppliers.push(SUP.id);
    r = await call('zakupy', { supplier_id: SUP.id, lines: [{ item_id: IT.id, qty: 5, unit_price: 10 }] }, MG.c); eq(r.s, 201, 'szkic zamówienia zakupu'); const PO = r.j; T.pos.push(PO.id);
    r = await call('zakupy/' + PO.id, { lines: [{ item_id: IT.id, qty: 7, unit_price: 11 }], note: 'poprawione', expected_date: inDays(7) }, MG.c, 'PUT');
    ok(r.s === 200 && r.j.lines[0].qty === 7 && Number(r.j.total_net) === 77 && r.j.note === 'poprawione', 'edycja szkicu: ilość, cena, uwagi, suma');
    await call('zakupy/' + PO.id + '/zamow', {}, MG.c);
    eq((await call('zakupy/' + PO.id, { lines: [{ item_id: IT.id, qty: 1, unit_price: 1 }] }, MG.c, 'PUT')).s, 409, 'wysłanego zamówienia nie edytuje się');


    // ---------- N5: błędy klienta 400/413 zamiast 500, HSTS, dokumenty polis, konflikty równoczesnej edycji ----------
    const post = (p, body, cookie) => raw(p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body });
    eq((await post('klienci', '{"name": "x",', UZ.c)).status, 400, 'uszkodzony JSON – 400');
    eq((await post('klienci', JSON.stringify({ kind: 'firma', name: 'x'.repeat(300000) }), UZ.c)).status, 413, 'za duże dane – 413');
    eq((await post('klienci', JSON.stringify({ kind: 'firma', name: '[T-AUD] N\u0000UL' }), UZ.c)).status, 400, 'znak NUL – 400');
    r = await call('klienci?q=x', null, UZ.c); ok(r.s === 200, 'serwer działa po błędnych żądaniach');
    const hs = await raw('health', { headers: { 'X-Forwarded-Proto': 'https' } });
    ok(/max-age=31536000/.test(hs.headers.get('strict-transport-security') || ''), 'HSTS na połączeniu HTTPS');
    ok(!(await raw('health')).headers.get('strict-transport-security') || process.env.COOKIE_SECURE === '1', 'bez HSTS na zwykłym HTTP (lokalnie)');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
    r = await call('polisy/' + P1.id + '/dokument', { plik: pdf, nazwa: 'polisa.pdf' }, UZ.c); eq(r.s, 201, 'dokument polisy załączony'); const PDOC = r.j.document_id;
    eq((await raw('dokumenty/' + PDOC + '/plik', { headers: { Cookie: UZ.c } })).status, 200, 'dział ubezpieczeń otwiera dokument polisy');
    eq((await raw('dokumenty/' + PDOC + '/plik', { headers: { Cookie: RZ.c } })).status, 403, 'rozliczający (bez Ubezpieczeń) nie otworzy dokumentu polisy po identyfikatorze');
    // konflikt: formularz otwarty przed zmianą zapisaną przez inną osobę
    for (const [label, url, get] of [['klient', 'klienci/' + C2.id, 'klienci/' + C2.id], ['budynek', 'd1/budynki/' + B2.id, 'd1/budynki/' + B2.id], ['polisa', 'polisy/' + P1.id, 'polisy/' + P1.id]]) {
      const seen = (await call(get, null, KR.c)).j.updated_at;
      eq((await call(url, { notes: 'zmiana kolegi', updated_at: seen }, KR.c, 'PATCH')).s, 200, label + ': pierwszy zapis z aktualnej wersji');
      r = await call(url, { notes: 'moja zmiana', updated_at: seen }, UZ.c, 'PATCH'); ok(r.s === 409 && /zmienił/.test(r.j.error), label + ': zapis ze starej wersji – 409 zamiast nadpisania');
      const now = (await call(get, null, UZ.c)).j;
      eq(now.notes, 'zmiana kolegi', label + ': zmiana kolegi nie została nadpisana');
      eq((await call(url, { notes: 'moja zmiana', updated_at: now.updated_at }, UZ.c, 'PATCH')).s, 200, label + ': zapis po odświeżeniu');
    }

    // ---------- N6: długie listy – „Pokazano X z Y” (total_count) i większa porcja na żądanie ----------
    for (const u of ['klienci', 'd1/budynki', 'polisy', 'magazyn/dokumenty', 'magazyn/pozycje', 'zakupy', 'tasks', 'czesci/zamowienia']) {
      const who = ['polisy', 'czesci/zamowienia', 'klienci', 'd1/budynki', 'tasks'].includes(u) ? AD.c : MG.c;
      const one = await call(u + '?limit=1', null, who);
      ok(one.s === 200 && one.j.length <= 1 && (one.j.length === 0 || Number.isInteger(one.j[0].total_count)), u + ': porcja z limitem i liczbą wszystkich wyników');
    }
    r = await call('klienci?limit=1', null, AD.c); ok(r.j[0].total_count >= 2, 'CRM: lista wie, że wyników jest więcej niż pokazano');
    r = await call('finanse?limit=1', null, KR.c); ok(r.s === 200 && r.j.length === 1 && r.j[0].total_count >= 3, 'Finance Intelligence: porcja i suma wyników');
    eq((await call('klienci?limit=999999', null, AD.c)).s, 200, 'limit z górną granicą (bez błędu)');

    console.log(`OK – testy poprawek po audycie: ${passed} sprawdzeń.`);
  } catch (e) { console.error('BŁĄD:', e.message); console.error(e.stack.split('\n').slice(1, 3).join('\n')); process.exitCode = 1; }
  finally {
    // sprzątanie danych roboczych (kolejność: zależne rekordy najpierw)
    const q = (sql, p) => pool.query(sql, p).catch(e => console.error('sprzątanie:', e.message));
    await q('DELETE FROM finance WHERE id = ANY($1::uuid[])', [T.finance]);
    await q('DELETE FROM purchase_orders WHERE id = ANY($1::uuid[]) OR supplier_id = ANY($2::uuid[])', [T.pos, T.suppliers]);
    await q('DELETE FROM stock_reservations WHERE item_id = ANY($1::uuid[])', [T.items]);
    await q('DELETE FROM stock_moves WHERE item_id = ANY($1::uuid[])', [T.items]);
    await q('DELETE FROM stock_docs d WHERE NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.doc_id = d.id) AND d.created_by = ANY($1::uuid[])', [users]);
    await q('DELETE FROM stock_levels WHERE item_id = ANY($1::uuid[])', [T.items]);
    await q('DELETE FROM stock_items WHERE id = ANY($1::uuid[])', [T.items]);
    await q('DELETE FROM suppliers WHERE id = ANY($1::uuid[])', [T.suppliers]);
    await q('DELETE FROM notifications WHERE related_type = $1 AND related_id = ANY($2::uuid[])', ['policy', T.policies]);
    await q('UPDATE policies SET renewed_by = NULL, previous_id = NULL WHERE id = ANY($1::uuid[])', [T.policies]);
    await q('DELETE FROM policies WHERE id = ANY($1::uuid[])', [T.policies]);
    await q(`DELETE FROM documents WHERE related_type = 'policy' AND related_id = ANY($1::uuid[])`, [T.policies]);
    await q('DELETE FROM units WHERE building_id = ANY($1::uuid[])', [T.buildings]);
    await q('DELETE FROM buildings WHERE id = ANY($1::uuid[])', [T.buildings]);
    await q('DELETE FROM customers WHERE id = ANY($1::uuid[]) OR created_by = ANY($2::uuid[])', [T.customers, users]);
    await q('DELETE FROM notifications WHERE user_id = ANY($1::uuid[])', [users]);
    await q('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [users]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await restoreFlags();
    srv.kill(); await pool.end();
  }
})();
