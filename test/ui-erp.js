// Test interfejsu ERP w przeglądarce (Playwright): uruchamia serwer na losowym porcie, zakłada własne konta i dane [T-UI],
// przechodzi przez procesy z formularzy (zamówienie części → rezerwacja → WZ → faktura → zwrot → zapłata; propozycja zakupu
// → zamówienie → przyjęcie PZ → zapłata zobowiązania; eksport XLSX; pulpit właściciela), klika wszystkie zakładki modułów ERP
// (bez błędów JS i odpowiedzi 5xx), sprawdza widok telefonu (bez przewijania w bok) i ograniczenia ról. Na końcu sprząta dane.
// Uruchomienie: npm run test:ui (wymaga Playwright z przeglądarką Chromium; bez niego test jest pomijany).
'use strict';
const { spawn } = require('child_process'), path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('POMINIĘTO: brak modułu playwright (test interfejsu wymaga Playwright i Chromium).'); process.exit(0); }

let passed = 0;
const fails = [], errs = [];
const ok = (c, m) => { if (c) passed++; else fails.push(m); };

(async () => {
  const PORT = require('./_setup').testPort(7600, 300), BASE = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(BASE + '/api/' + p, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 400) throw new Error(`${p}: ${r.status} ${j.error || ''}`);
    return j;
  };
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [], PASS = 'Ui-Test-2026x', tag = Date.now().toString().slice(-6), T = { items: [], suppliers: [], customers: [], buildings: [], crews: [] };
  let browser;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const hash = await bcrypt.hash(PASS, 4);
    const mk = async (login, role) => {
      users.push((await pool.query(`INSERT INTO users (login, password_hash, role, full_name, must_change_password) VALUES ($1, $2, $3, $4, false) RETURNING id`, [login, hash, role, '[T-UI] ' + login])).rows[0].id);
      const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: PASS }) });
      return (r.headers.get('set-cookie') || '').split(';')[0];
    };
    const AC = await mk('tui.admin' + tag, 'administrator');
    await mk('tui.magazyn' + tag, 'magazynier');
    await mk('tui.prac' + tag, 'monter');   // pracownik do edycji i wyłączenia z interfejsu

    // ---------- dane robocze przez API ----------
    const W = (await call('magazyn/magazyny', null, AC)).find(w => w.code === 'MAG');
    const SUP = await call('magazyn/dostawcy', { name: '[T-UI] Hurtownia ' + tag, payment_days: 14 }, AC); T.suppliers.push(SUP.id);
    const I1 = await call('magazyn/pozycje', { sku: 'TUI-KL-' + tag, name: '[T-UI] Klocki hamulcowe', kind: 'czesc', department_id: 'sprzedaz-czesci-i-eksport', manufacturer: 'Bosch',
      catalog_no: 'TUI ' + tag, replacement_nos: 'ZAM' + tag, sale_price: 180, purchase_price: 100, min_qty: 3, supplier_id: SUP.id }, AC); T.items.push(I1.id);
    const I2 = await call('magazyn/pozycje', { sku: 'TUI-FO-' + tag, name: '[T-UI] Filtr oleju', kind: 'czesc', department_id: 'sprzedaz-czesci-i-eksport', sale_price: 45, purchase_price: 25, min_qty: 20, supplier_id: SUP.id }, AC); T.items.push(I2.id);
    await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, supplier_id: SUP.id, lines: [{ item_id: I1.id, qty: 10, unit_cost: 100 }, { item_id: I2.id, qty: 5, unit_cost: 25 }] }, AC);
    const CUST = await call('klienci', { kind: 'firma', name: '[T-UI] Warsztat ' + tag }, AC); T.customers.push(CUST.id);

    browser = await chromium.launch();
    const watch = (pg, who) => {
      pg.on('pageerror', e => errs.push(`${who}: ${e.message}`));
      pg.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) errs.push(`${who}: HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
    };
    // Po zalogowaniu czekamy na pasek użytkownika (przycisk Menu) – zmiana adresu w aplikacji jednostronicowej bywa wcześniejsza niż oczekiwanie.
    const login = async (pg, l) => {
      await pg.goto(BASE + '/'); await pg.waitForSelector('#login-submit');
      await pg.fill('#login', l); await pg.fill('#password', PASS); await pg.click('#login-submit');
      await pg.waitForSelector('#menu-toggle', { state: 'visible', timeout: 20000 });
    };
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true })).newPage();
    watch(p, 'komputer'); await login(p, 'tui.admin' + tag);
    const modal = () => p.textContent('#modal-box');
    const flat = s => (s || '').replace(/\s/g, '');

    // ---------- sprzedaż części: pełny proces z formularzy ----------
    await p.goto(BASE + '/dzial/sprzedaz-czesci-i-eksport'); await p.waitForSelector('#zf');
    await p.click('#zo-new'); await p.waitForSelector('#oc-q');
    await p.fill('#oc-q', 'Warsztat ' + tag); await p.waitForSelector('#oc-res [data-cid]'); await p.click('#oc-res [data-cid]');
    await p.selectOption('#ol-i0', I1.id); await p.fill('#ol-q0', '2'); await p.fill('#ol-d0', '10');
    await p.selectOption('#ol-i1', I2.id); await p.fill('#ol-q1', '3');
    ok(flat(await p.textContent('#oc-sum')) === '459,00zł', 'suma zamówienia w formularzu: 2 × 180 − 10% + 3 × 45 = 459 zł');
    await p.click('#modal-box [type=submit]'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.fill('#zq', 'Warsztat ' + tag); await p.click('#zf [type=submit]'); await p.waitForSelector('tbody [data-o]');
    await p.click('tbody [data-o]'); await p.waitForSelector('[data-a="confirm"]');
    await p.click('[data-a="confirm"]'); await p.waitForSelector('[data-a="issue"]');
    ok((await call('magazyn/pozycje/' + I1.id, null, AC)).reserved == 2, 'potwierdzenie rezerwuje towar');
    await p.click('[data-a="issue"]'); await p.waitForSelector('[data-a="invoice"]');
    ok(flat(await modal()).includes('275,00zł') && flat(await modal()).includes('184,00zł'), 'po wydaniu: koszt 275 zł, marża 184 zł');
    await p.click('[data-a="invoice"]'); await p.waitForSelector('#iv-n'); await p.fill('#iv-n', 'FV/TUI/' + tag); await p.click('#modal-box [type=submit]'); await p.waitForSelector('[data-a="paid"]');
    ok((await modal()).includes('nieopłacona'), 'faktura zapisana jako nieopłacona');
    await p.click('[data-a="return"]'); await p.waitForSelector('#rt-r');
    await p.fill('#modal-box input[name^="q:"] >> nth=0', '1'); await p.fill('#rt-r', 'Za dużo zamówione'); await p.click('#modal-box [type=submit]');
    await p.waitForSelector('#modal-box h3:has-text("Zwroty")');
    ok(true, 'zwrot przyjęty');
    await p.click('[data-a="paid"]'); await p.waitForSelector('#pd-d'); await p.click('#modal-box [type=submit]'); await p.waitForSelector('#modal-box :text("zapłacona")');
    ok(true, 'zapłata zapisana');
    await p.keyboard.press('Escape');

    // ---------- produkty, analityka, wyszukiwanie ----------
    await p.goto(BASE + '/dzial/sprzedaz-czesci-i-eksport?tab=produkty'); await p.waitForSelector('#prf');
    await p.fill('#prq', 'ZAM' + tag); await p.click('#prf [type=submit]'); await p.waitForLoadState('networkidle');
    ok((await p.textContent('.mod-body')).includes('44,44%'), 'produkty: wyszukiwanie po zamienniku i marża 44,44%');
    await p.goto(BASE + '/dzial/sprzedaz-czesci-i-eksport?tab=analityka'); await p.waitForSelector('#anf'); await p.waitForLoadState('networkidle');
    ok((await p.textContent('.mod-body')).includes('[T-UI] Klocki'), 'analityka: produkt wśród najlepiej sprzedających się');

    // ---------- zakupy: propozycja z minimów → zamówienie → przyjęcie ----------
    await p.goto(BASE + '/magazyn?tab=zakupy'); await p.waitForSelector('#po-prop');
    await p.click('#po-prop'); await p.waitForSelector(`tbody tr:has-text("Hurtownia ${tag}") [data-po]`);
    await p.click(`tbody tr:has-text("Hurtownia ${tag}") [data-po]`); await p.waitForSelector('[data-a="order"]');
    await p.click('[data-a="order"]'); await p.waitForSelector('[data-a="receive"]');
    await p.click('[data-a="receive"]'); await p.waitForSelector('#rc-f'); await p.fill('#rc-f', 'FV/TUI/Z/' + tag); await p.click('#modal-box [type=submit]');
    await p.waitForSelector('#modal-box h3:has-text("Przyjęcia (PZ)")');
    ok(true, 'propozycja, zamówienie i przyjęcie dostawy');
    await p.keyboard.press('Escape');

    // ---------- finanse firmy ----------
    await p.goto(BASE + '/finanse-firmy?tab=zobowiazania'); await p.waitForSelector(`tbody tr:has-text("FV/TUI/Z/${tag}") [data-pay]`);
    await p.click(`tbody tr:has-text("FV/TUI/Z/${tag}") [data-pay]`); await p.waitForSelector('#pay-d'); await p.click('#modal-box [type=submit]');
    await p.waitForSelector(`tbody tr:has-text("FV/TUI/Z/${tag}")`, { state: 'detached' });
    ok(true, 'zapłata zobowiązania znika z listy');
    await p.goto(BASE + '/finanse-firmy'); await p.waitForSelector('.fin-note');
    ok((await p.textContent('.fin-note')).includes('nie jest przychodem MXT'), 'wyniki: kwota polis oznaczona jako nie-przychód');
    await p.goto(BASE + '/finanse-firmy?tab=eksport'); await p.waitForSelector('a[href^="/api/finanse-erp/eksport"]');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('a[href^="/api/finanse-erp/eksport"]')]);
    ok(/\.xlsx$/.test(dl.suggestedFilename()), 'eksport dla księgowości: plik XLSX');

    // ---------- pulpit właściciela ----------
    await p.goto(BASE + '/pulpit-wlasciciela'); await p.waitForSelector('.ow-stat');
    ok((await p.$$('.ow-stat')).length >= 15, 'pulpit właściciela: kafelki operacji, polis i części');
    await p.click('[data-pp="rok"]'); await p.waitForSelector('[data-pp="rok"][aria-pressed="true"]'); ok(true, 'filtr okresu');

    // ---------- CRM: edycja z listy, archiwum, usuwanie (zgłoszenie: „nie mogę edytować i kasować klientów”) ----------
    const C0 = await call('klienci', { kind: 'firma', name: '[T-UI] Do usunięcia ' + tag }, AC); T.customers.push(C0.id);
    await p.goto(BASE + '/crm'); await p.waitForSelector('#crm-f');
    await p.fill('#crm-f input[name=q]', tag); await p.click('#crm-f [type=submit]'); await p.waitForSelector(`tbody tr:has-text("Warsztat ${tag}") [data-cedit]`);
    await p.click(`tbody tr:has-text("Warsztat ${tag}") [data-cedit]`); await p.waitForSelector('#c-name');
    await p.fill('#c-name', '[T-UI] Warsztat ' + tag + ' – edycja'); await p.click('#modal-box [type=submit]'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.waitForSelector(`tbody :text("Warsztat ${tag} – edycja")`);
    ok(true, 'CRM: „Edytuj” w wierszu listy zapisuje zmianę klienta');
    await p.click('table.table thead th:has-text("Klient")');
    ok(await p.getAttribute('table.table thead th:has-text("Klient")', 'aria-sort') === 'ascending', 'tabela sortuje się po kliknięciu nagłówka');
    await p.click(`tbody tr:has-text("Warsztat ${tag}") [data-cust] >> nth=0`); await p.waitForSelector('#cc-del');
    ok(!!(await p.$('#cc-arch')) && !!(await p.$('#cc-anon')), 'karta klienta: Archiwizuj, Usuń, Anonimizuj');
    await p.click('#cc-del'); await p.waitForSelector('#toast:has-text("ma historię")');
    ok(true, 'klient z historią (zamówienia): komunikat zamiast usunięcia');
    await p.keyboard.press('Escape'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.click(`tbody tr:has-text("Do usunięcia ${tag}") [data-cust] >> nth=0`); await p.waitForSelector('#cc-del');
    await p.click('#cc-del'); await p.waitForSelector('#modal-box .btn-danger'); await p.click('#modal-box .btn-danger'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.waitForSelector(`tbody tr:has-text("Do usunięcia ${tag}")`, { state: 'detached' });
    ok(!(await pool.query('SELECT 1 FROM customers WHERE id = $1', [C0.id])).rows.length, 'klient bez historii usunięty z interfejsu');

    // ---------- Pracownicy: edycja konta, wyłączenie, usunięcie (zgłoszenie: „nie mogę edytować i kasować pracowników”) ----------
    await p.goto(BASE + '/pracownicy'); await p.waitForSelector(`tbody tr:has-text("tui.prac${tag}")`);
    await p.click(`tbody tr:has-text("tui.prac${tag}") td.td-actions [data-e]`); await p.waitForSelector('#e-acc');
    await p.click('#e-acc'); await p.waitForSelector('#a-name');
    await p.fill('#a-name', '[T-UI] Jan Edytowany ' + tag); await p.click('#modal-box [type=submit]'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.waitForSelector(`tbody :text("Jan Edytowany ${tag}")`);
    ok(true, 'Pracownicy: „Edytuj konto” zmienia imię i nazwisko');
    await p.click(`tbody tr:has-text("Jan Edytowany ${tag}") td.td-actions [data-e]`); await p.waitForSelector('#e-tog');
    await p.click('#e-tog'); await p.waitForSelector('#modal-box .btn-danger'); await p.click('#modal-box .btn-danger'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.waitForSelector(`tbody tr:has-text("Jan Edytowany ${tag}")`, { state: 'detached' });
    ok(true, 'wyłączone konto znika z listy (domyślnie tylko aktywne)');
    await p.check('#e-off'); await p.waitForSelector(`tbody tr.row-off:has-text("Jan Edytowany ${tag}")`);
    ok(true, '„Pokaż wyłączone konta” pokazuje wyłączonego pracownika');
    await p.click(`tbody tr:has-text("Jan Edytowany ${tag}") td.td-actions [data-e]`); await p.waitForSelector('#e-del');
    await p.click('#e-del'); await p.waitForSelector('#modal-box .btn-danger'); await p.click('#modal-box .btn-danger'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.waitForSelector(`tbody tr:has-text("Jan Edytowany ${tag}")`, { state: 'detached' });
    ok(!(await pool.query('SELECT 1 FROM users WHERE login = $1', ['tui.prac' + tag])).rows.length, 'konto bez historii usunięte z interfejsu');
    await p.uncheck('#e-off').catch(() => {});

    // ---------- Harmonogram: usuwanie montażu wpisanego przez pomyłkę (zgłoszenie: „nie mogę usunąć montażu”) ----------
    const BLD = await call('d1/budynki', { name: '[T-UI] Blok ' + tag, address: 'ul. Interfejsowa ' + tag, city: 'Test', potwierdz_duplikat: true }, AC); T.buildings.push(BLD.id);
    const MON = await call('d1/montaze', { building_id: BLD.id, planned_date: require('./_setup').warsawDay(2) }, AC);
    await p.goto(BASE + '/dzial/podzielniki-i-montaze'); await p.waitForSelector(`[data-idel="${MON.id}"]`);
    await p.click(`[data-idel="${MON.id}"]`); await p.waitForSelector('#modal-box .btn-danger'); await p.click('#modal-box .btn-danger'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.waitForSelector(`[data-idel="${MON.id}"]`, { state: 'detached' });
    ok(!(await pool.query('SELECT 1 FROM installations WHERE id = $1', [MON.id])).rows.length, 'harmonogram: kosz w wierszu usuwa montaż bez historii');
    const MON2 = await call('d1/montaze', { building_id: BLD.id, planned_date: require('./_setup').warsawDay(3) }, AC);
    await p.goto(BASE + '/dzial/podzielniki-i-montaze'); await p.waitForSelector(`[data-ie="${MON2.id}"].hm-edit`);
    await p.click(`[data-ie="${MON2.id}"].hm-edit`); await p.waitForSelector('#i-del'); await p.click('#i-del');
    await p.waitForSelector('#modal-box .btn-danger'); await p.click('#modal-box .btn-danger'); await p.waitForSelector('#modal', { state: 'hidden' });
    ok(!(await pool.query('SELECT 1 FROM installations WHERE id = $1', [MON2.id])).rows.length, 'okno edycji montażu: „Usuń montaż”');

    // ---------- Ekipy: edycja instalatora i wspólny przycisk „Usuń” (sprawdzenie historii, potwierdzenie, odświeżenie) ----------
    const CRW = await call('d1/ekipy', { name: '[T-UI] Ekipa ' + tag }, AC); T.crews.push(CRW.id);
    const INS = await call('d1/instalatorzy', { name: '[T-UI] Instalator ' + tag, crew_id: CRW.id }, AC);
    await p.goto(BASE + '/dzial/podzielniki-i-montaze?tab=ekipy'); await p.waitForSelector(`[data-inst="${INS.id}"]`);
    await p.click(`[data-inst="${INS.id}"]`); await p.waitForSelector('#ie-n'); await p.fill('#ie-n', '[T-UI] Instalator zmieniony ' + tag);
    await p.click('#modal-box [type=submit]'); await p.waitForSelector(`text=Instalator zmieniony ${tag}`);
    ok(true, 'ekipy: edycja instalatora z listy');
    await p.click(`[data-inst="${INS.id}"]`); await p.waitForSelector(`#modal-box [data-usun="d1/instalatorzy/${INS.id}"]`);
    await p.click(`#modal-box [data-usun="d1/instalatorzy/${INS.id}"]`); await p.waitForSelector('#modal-box .btn-danger'); await p.click('#modal-box .btn-danger');
    await p.waitForSelector(`[data-inst="${INS.id}"]`, { state: 'detached' });
    await p.click(`.wf-grid [data-usun="d1/ekipy/${CRW.id}"]`); await p.waitForSelector('#modal-box .btn-danger'); await p.click('#modal-box .btn-danger');
    await p.waitForSelector(`[data-usun="d1/ekipy/${CRW.id}"]`, { state: 'detached' });
    ok(!(await pool.query('SELECT 1 FROM crews WHERE id = $1', [CRW.id])).rows.length, 'ekipy: usunięcie instalatora i pustej ekipy przyciskiem „Usuń”');

    // ---------- Wszystkie zlecenia: „Dodaj zlecenie” – montaż, serwis albo odczyt z jednego miejsca ----------
    await p.goto(BASE + '/dzial/podzielniki-i-montaze?tab=zlecenia'); await p.waitForSelector('#zl-new');
    await p.click('#zl-new'); await p.waitForSelector('[data-new="serwis"]');
    ok((await p.$$eval('[data-new]', x => x.map(y => y.dataset.new).join(','))) === 'montaz,serwis,odczyt', 'Dodaj zlecenie: wybór montaż / serwis / odczyt');
    await p.click('[data-new="montaz"]'); await p.waitForSelector('#i-b'); ok(true, 'Dodaj zlecenie → formularz montażu');
    await p.keyboard.press('Escape'); await p.click('#zl-new'); await p.click('[data-new="odczyt"]'); await p.waitForSelector('#modal-box #o-b'); ok(true, 'Dodaj zlecenie → formularz obiektu odczytów');
    await p.keyboard.press('Escape'); await p.click('#zl-new'); await p.click('[data-new="serwis"]'); await p.waitForSelector('#o-cl');
    await p.fill('#o-cl', '[T-UI] Klient serwisu ' + tag); await p.fill('#o-a', 'ul. Serwisowa ' + tag); await p.fill('#o-d', '[T-UI] Wymiana podzielnika ' + tag);
    await p.click('#modal-box [type=submit]'); await p.waitForSelector('#modal', { state: 'hidden' });
    await p.waitForSelector(`text=ul. Serwisowa ${tag}`);
    ok(true, 'Dodaj zlecenie → serwis zapisany i widoczny w rejestrze');

    // ---------- wszystkie zakładki modułów ERP: bez błędów JS i 5xx ----------
    const pages = ['/dzial/podzielniki-i-montaze', '/dzial/sprzedaz-czesci-i-eksport', '/dzial/ubezpieczenia', '/magazyn', '/finanse-firmy', '/pracownicy', '/moj-czas', '/szkolenia', '/pulpit-wlasciciela', '/crm', '/konta'];
    let tabs = 0;
    for (const url of pages) {
      await p.goto(BASE + url); await p.waitForSelector('.mod-body'); await p.waitForLoadState('networkidle');
      ok(!(await p.$('.mod-body > p.loading:only-child')), `${url}: strona wczytana`);
      const keys = await p.$$eval('.ws-side [data-dtab]', b => b.map(x => x.dataset.dtab));
      for (const k of keys) {
        // pozycja wspólnego menu może prowadzić do modułu z własnymi zakładkami – wtedy wracamy na stronę wyjściową
        if (!(await p.$(`.ws-side [data-dtab="${k}"]`))) { await p.goto(BASE + url); await p.waitForSelector('.mod-body'); await p.waitForLoadState('networkidle'); }
        await p.click(`.ws-side [data-dtab="${k}"]`); await p.waitForLoadState('networkidle');
        if (await p.isVisible('#modal:not([hidden])')) await p.keyboard.press('Escape');
        tabs++;
      }
    }
    ok(tabs >= 30, `przejście przez zakładki modułów ERP (${tabs})`);

    // ---------- telefon ----------
    const m = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage(); watch(m, 'telefon');
    await login(m, 'tui.admin' + tag);
    for (const url of ['/pulpit-wlasciciela', '/dzial/sprzedaz-czesci-i-eksport', '/finanse-firmy', '/finanse-firmy?tab=naleznosci', '/magazyn?tab=zakupy', '/dzial/ubezpieczenia', '/dzial/podzielniki-i-montaze?tab=zlecenia']) {
      await m.goto(BASE + url); await m.waitForSelector('.ws-title'); await m.waitForLoadState('networkidle');
      ok((await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `telefon ${url}: bez przewijania w bok`);
    }

    // ---------- ograniczenia ról: magazynier ----------
    const g = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(g, 'magazynier');
    await login(g, 'tui.magazyn' + tag);
    await g.click('#menu-toggle'); await g.waitForSelector('#menu:not([hidden])');
    const menu = await g.textContent('#menu');
    ok(menu.includes('Magazyn') && !menu.includes('Finanse firmy') && !menu.includes('Pulpit właściciela') && !menu.includes('Pracownicy'), 'menu magazyniera: magazyn tak, finanse/pulpit/pracownicy nie');
    const st = await g.evaluate(async () => Promise.all(['wlasciciel', 'finanse-erp/wyniki', 'polisy', 'pracownicy'].map(u => fetch('/api/' + u).then(r => r.status))));
    ok(st.every(s => s === 403), 'magazynier: API pulpitu, finansów, polis i pracowników → 403 (' + st + ')');

    ok(!errs.length, 'brak błędów JS i odpowiedzi 5xx: ' + errs.join(' | '));
    if (fails.length) { console.error('BŁĄD:', fails.join('\n  ')); process.exitCode = 1; }
    else console.log(`OK: test interfejsu ERP przeszedł (${passed} sprawdzeń, ${tabs} zakładek)`);
  } catch (e) {
    console.error('BŁĄD:', e.message, fails.length ? '\n  ' + fails.join('\n  ') : '', errs.length ? '\n  ' + errs.join('\n  ') : ''); process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    const q = (sql, p) => pool.query(sql, p).catch(e => console.error('sprzątanie:', e.message.slice(0, 160)));
    const orders = (await pool.query('SELECT id FROM part_orders WHERE customer_id = ANY($1::uuid[])', [T.customers]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await q(`DELETE FROM complaints WHERE part_order_id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM part_returns WHERE order_id = ANY($1::uuid[])`, [orders]);
    await q(`UPDATE part_orders SET finance_id = NULL, sale_id = NULL, wz_doc_id = NULL WHERE id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM finance WHERE part_order_id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM sales_history WHERE number IN (SELECT number FROM part_orders WHERE id = ANY($1::uuid[]))`, [orders]);
    await q(`UPDATE part_order_lines SET reservation_id = NULL WHERE order_id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM part_orders WHERE id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM purchase_orders WHERE supplier_id = ANY($1::uuid[])`, [T.suppliers]);
    await q(`DELETE FROM stock_reservations WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_moves WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_docs d WHERE NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.doc_id = d.id) AND d.created_by = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM stock_levels WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_items WHERE id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM suppliers WHERE id = ANY($1::uuid[])`, [T.suppliers]);
    await q(`DELETE FROM installations WHERE building_id = ANY($1::uuid[])`, [T.buildings]);
    await q(`DELETE FROM service_events WHERE order_id IN (SELECT id FROM service_orders WHERE created_by = ANY($1::uuid[]))`, [users]);
    await q(`DELETE FROM service_orders WHERE created_by = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM installers WHERE crew_id = ANY($1::uuid[])`, [T.crews]);
    await q(`DELETE FROM crews WHERE id = ANY($1::uuid[])`, [T.crews]);
    await q(`DELETE FROM buildings WHERE id = ANY($1::uuid[])`, [T.buildings]);
    await q(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [T.customers]);
    await q(`DELETE FROM user_views WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    srv.kill(); await pool.end();
  }
})();
