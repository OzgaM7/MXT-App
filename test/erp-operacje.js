// Testy ERP – etap 4: dział Ciepłomierze i podzielniki + rdzeń magazynu.
// Magazyn (PZ, średni koszt, RW/ZW na zlecenie, MM, INW, rezerwacje, równoczesne wydania bez ujemnych stanów),
// projekt (zespół, budżet, zlecenia, czas pracy, koszty i przychody, protokół miesięczny), wspólny rejestr zleceń,
// rozliczenie i zamknięcie zlecenia, lokale, kartoteka urządzenia z historią, odczyty per urządzenie (braki, podejrzane, import,
// protokół), plany miesięczne, pulpit działu, nieobecności, uprawnienia. Dane robocze [T-ERP4] są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const near = (a, b, m) => { assert.ok(Math.abs(Number(a) - Number(b)) < 0.011, `${m} (${a} ≠ ${b})`); passed++; };

(async () => {
  const PORT = 6900 + Math.floor(Math.random() * 200), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { s: r.status, j: ct.includes('json') ? await r.json().catch(() => ({})) : {}, c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [], PASS = 'Erp-Test-2026x';
  const T = { customers: [], buildings: [], items: [], warehouses: [], projects: [], orders: [], installations: [], schedules: [], docs: [] };
  const month = new Date().toISOString().slice(0, 7), today = new Date().toISOString().slice(0, 10);
  const planBefore = (await pool.query(`SELECT metric, target FROM monthly_plans WHERE month = $1::date`, [month + '-01'])).rows;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const hash = await bcrypt.hash(PASS, 4);
    const mk = async (login, role, extra = []) => {
      const id = (await pool.query(`INSERT INTO users (login, password_hash, role, extra_roles, full_name, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [login, hash, role, extra, '[T-ERP4] ' + login])).rows[0].id;
      users.push(id);
      return { id, c: (await call('login', { login, password: PASS })).c };
    };
    const BIU = await mk('terp4.biuro', 'uzytkownik'), KIE = await mk('terp4.kierownik', 'kierownik'), KS = await mk('terp4.ksiegowa', 'ksiegowosc');
    const MG = await mk('terp4.magazyn', 'magazynier'), SV = await mk('terp4.serwisant', 'serwisant'), OD = await mk('terp4.odczyty', 'odczyty');

    // ---------- magazyn: pozycja, przyjęcia, średni koszt ----------
    const W = (await call('magazyn/magazyny', null, MG.c)).j.find(w => w.code === 'MAG');
    ok(W && W.is_active, 'magazyn główny istnieje');
    let r = await call('magazyn/magazyny', { code: 'TERP4', name: '[T-ERP4] Samochód serwisowy', kind: 'samochod' }, MG.c); eq(r.s, 201, 'nowy magazyn (samochód)'); const CAR = r.j; T.warehouses.push(CAR.id);
    eq((await call('magazyn/magazyny', { code: 'TERP4X', name: 'x' }, BIU.c)).s, 403, 'magazyn zakłada tylko magazyn/kierownik/administrator');
    r = await call('magazyn/pozycje', { sku: 'TERP4-PODZ', name: '[T-ERP4] Podzielnik elektroniczny', kind: 'material', department_id: 'podzielniki-i-montaze', unit: 'szt.', min_qty: 50 }, MG.c);
    eq(r.s, 201, 'pozycja magazynowa'); const IT = r.j; T.items.push(IT.id);
    eq((await call('magazyn/pozycje', { sku: 'TERP4-PODZ', name: 'Duplikat' }, MG.c)).s, 409, 'indeks unikalny');
    r = await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, lines: [{ item_id: IT.id, qty: 100, unit_cost: 10 }], invoice_no: 'FV/T4/1' }, MG.c);
    eq(r.s, 201, 'PZ 100 szt. po 10 zł'); near(r.j.total_value, 1000, 'wartość PZ');
    r = await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, lines: [{ item_id: IT.id, qty: 100, unit_cost: 12 }] }, MG.c); eq(r.s, 201, 'PZ 100 szt. po 12 zł');
    let it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j;
    near(it.qty, 200, 'stan 200'); near(it.avg_cost, 11, 'średni ważony koszt 11 zł'); near(it.purchase_price, 12, 'ostatnia cena zakupu'); near(it.stock_value, 2200, 'wartość zapasu');
    eq((await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, lines: [{ item_id: IT.id, qty: -5, unit_cost: 1 }] }, MG.c)).s, 400, 'ilość ujemna odrzucona');
    eq((await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, lines: [] }, MG.c)).s, 400, 'dokument bez pozycji odrzucony');
    eq((await call('magazyn/dokumenty', { kind: 'PZ', warehouse_id: W.id, lines: [{ item_id: IT.id, qty: 1, unit_cost: 1 }] }, BIU.c)).s, 403, 'PZ tylko magazyn');

    // ---------- klient, budynek, projekt, zlecenia ----------
    const C = (await call('klienci', { kind: 'wspolnota', name: '[T-ERP4] Wspólnota Testowa 7' }, BIU.c)).j; T.customers.push(C.id);
    const B = (await call('d1/budynki', { customer_id: C.id, name: '[T-ERP4] Testowa 7', address: 'ul. Testowa 7', city: 'Zielona Góra', units_count: 5 }, BIU.c)).j; T.buildings.push(B.id);
    r = await call('d1/kontrakty', { customer_id: C.id, title: '[T-ERP4] Wymiana podzielników', value_net: 20000 }, BIU.c); eq(r.s, 201, 'projekt'); const P = r.j; T.projects.push(P.id);
    const X = (await call('d1/montaze', { building_id: B.id, project_id: P.id, planned_date: today, devices_planned: 5 }, BIU.c)).j; T.installations.push(X.id);
    const SO = (await call('serwisy', { customer_id: C.id, building_id: B.id, client_name: '[T-ERP4] Lokator', address: 'ul. Testowa 7', unit: '3', description: '[T-ERP4] Wymiana podzielnika' }, BIU.c)).j; T.orders.push(SO.id);
    ok(SO.number && SO.assign_due, 'zlecenie serwisowe z terminem przydziału');

    // ---------- RW/ZW na zlecenie, uprawnienia, równoczesne wydania ----------
    eq((await call('magazyn/dokumenty', { kind: 'RW', warehouse_id: W.id, related_type: 'installation', related_id: X.id, lines: [{ item_id: IT.id, qty: 5 }] }, KS.c)).s, 403, 'księgowość nie wydaje materiałów');
    r = await call('magazyn/dokumenty', { kind: 'RW', warehouse_id: W.id, related_type: 'installation', related_id: X.id, lines: [{ item_id: IT.id, qty: 20 }] }, BIU.c);
    eq(r.s, 201, 'RW na montaż (biuro)'); near(r.j.total_value, 220, 'RW wyceniony po średnim koszcie (20 × 11)'); eq(r.j.project_id, P.id, 'RW przypisany do projektu montażu');
    T.docs.push(r.j.id);
    const both = await Promise.all([1, 2].map(() => call('magazyn/dokumenty', { kind: 'RW', warehouse_id: W.id, related_type: 'service_order', related_id: SO.id, lines: [{ item_id: IT.id, qty: 100 }] }, MG.c)));
    ok(both.filter(x => x.s === 201).length === 1 && both.filter(x => x.s === 409).length === 1, 'dwa równoczesne wydania po 100 z 180: jedno przyjęte, drugie odrzucone (brak stanu)');
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; near(it.qty, 80, 'stan po wydaniach 80 (bez zejścia poniżej zera)');
    r = await call('magazyn/dokumenty', { kind: 'ZW', warehouse_id: W.id, related_type: 'service_order', related_id: SO.id, lines: [{ item_id: IT.id, qty: 10 }] }, BIU.c); eq(r.s, 201, 'zwrot ze zlecenia');
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; near(it.qty, 90, 'stan po zwrocie 90'); ok(it.below_min === false, 'powyżej minimum (50)');
    // rezerwacja i wolny stan
    r = await call('magazyn/rezerwacje', { item_id: IT.id, warehouse_id: W.id, qty: 60, related_type: 'project', related_id: P.id }, MG.c); eq(r.s, 201, 'rezerwacja 60'); const RES = r.j;
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; near(it.free, 30, 'wolne = 90 − 60'); ok(it.below_min === true, 'wolny stan poniżej minimum – alert');
    eq((await call('magazyn/dokumenty', { kind: 'RW', warehouse_id: W.id, related_type: 'project', related_id: P.id, lines: [{ item_id: IT.id, qty: 40 }] }, MG.c)).s, 409, 'wydanie ponad wolny stan odrzucone');
    eq((await call('magazyn/rezerwacje', { item_id: IT.id, warehouse_id: W.id, qty: 31, related_type: 'inne' }, MG.c)).s, 409, 'rezerwacja ponad wolny stan odrzucona');
    eq((await call('magazyn/dokumenty', { kind: 'MM', warehouse_id: W.id, to_warehouse_id: CAR.id, lines: [{ item_id: IT.id, qty: 40 }] }, MG.c)).s, 409, 'przesunięcie zarezerwowanego towaru odrzucone');
    eq((await call('magazyn/rezerwacje/' + RES.id + '/anuluj', {}, MG.c)).s, 200, 'anulowanie rezerwacji');
    r = await call('magazyn/dokumenty', { kind: 'MM', warehouse_id: W.id, to_warehouse_id: CAR.id, lines: [{ item_id: IT.id, qty: 40 }] }, MG.c); eq(r.s, 201, 'MM do samochodu');
    const levels = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j.levels;
    ok(levels.find(l => l.code === 'MAG').qty == 50 && levels.find(l => l.code === 'TERP4').qty == 40, 'stany po przesunięciu: 50 + 40');
    r = await call('magazyn/dokumenty', { kind: 'INW', warehouse_id: CAR.id, lines: [{ item_id: IT.id, counted: 38 }] }, MG.c); eq(r.s, 201, 'inwentaryzacja: korekta −2'); near(r.j.total_value, -22, 'wartość różnicy inwentaryzacyjnej');
    eq((await pool.query(`SELECT qty::float q FROM stock_levels WHERE warehouse_id = $1 AND item_id = $2`, [CAR.id, IT.id])).rows[0].q, 38, 'stan po inwentaryzacji');
    const neg = await pool.query(`UPDATE stock_levels SET qty = -1 WHERE warehouse_id = $1 AND item_id = $2`, [CAR.id, IT.id]).catch(e => e);
    eq(neg.code, '23514', 'baza odrzuca ujemny stan (CHECK)');

    // ---------- księga kosztów: zakup nie jest kosztem, wydanie na zlecenie jest ----------
    const ledger = (await pool.query(`SELECT source, sum(amount)::float s FROM cost_ledger WHERE project_id = $1 GROUP BY 1`, [P.id])).rows;
    near(ledger.find(x => x.source === 'magazyn').s, 220, 'koszt materiałów projektu = RW na montaż (PZ nie jest kosztem)');
    const svcCost = (await pool.query(`SELECT sum(amount)::float s FROM cost_ledger WHERE service_order_id = $1`, [SO.id])).rows[0].s;
    near(svcCost, 1100 - 110, 'koszt materiałów serwisu = RW 100 × 11 − ZW 10 × 11');

    // ---------- pracownicy: stawka, czas pracy, nieobecność ----------
    eq((await call('pracownicy/' + SV.id, { hourly_rate: 50, position: 'Serwisant' }, BIU.c, 'PATCH')).s, 403, 'kartoteka pracownika – tylko kierownik');
    eq((await call('pracownicy/' + SV.id, { hourly_rate: 50, position: 'Serwisant', employment: 'umowa_o_prace' }, KIE.c, 'PATCH')).s, 200, 'kierownik ustawia stawkę');
    r = await call('czas', { work_date: today, hours: 3, related_type: 'installation', related_id: X.id, note: '[T-ERP4]' }, SV.c); eq(r.s, 201, 'serwisant wpisuje czas na montaż'); eq(r.j.project_id, P.id, 'czas przypisany do projektu');
    eq((await call('czas', { work_date: today, hours: 22, related_type: 'inne' }, SV.c)).s, 400, 'suma godzin w dniu ≤ 24');
    eq((await call('czas', { work_date: '2099-01-01', hours: 1 }, SV.c)).s, 400, 'bez czasu w przyszłości');
    r = await call('czas', null, SV.c); ok(r.j.rows.every(x => x.user_id === SV.id) && r.j.rows[0].cost === undefined, 'serwisant widzi tylko własny czas, bez kosztów');
    r = await call('czas?osoba=' + SV.id, null, KIE.c); ok(r.j.team && r.j.total_cost === 150, 'kierownik widzi koszt robocizny (3 h × 50 zł)');
    eq((await call('nieobecnosci', { user_id: SV.id, kind: 'urlop', date_from: today, date_to: today }, KIE.c)).s, 201, 'nieobecność');
    eq((await call('nieobecnosci', { user_id: SV.id, kind: 'l4', date_from: today, date_to: today }, KIE.c)).s, 409, 'nakładające się nieobecności odrzucone');
    r = await call('pracownicy', null, KIE.c); ok(r.j.rows.find(x => x.id === SV.id).nieobecnosc.kind === 'urlop', 'obciążenie: nieobecność dziś widoczna');
    eq((await call('pracownicy', null, BIU.c)).s, 403, 'lista pracowników – tylko kierownik');

    // ---------- projekt: kierownik, zespół, budżet, zlecenie, karta ----------
    eq((await call('d1/projekty/' + P.id, { manager_id: KIE.id, billing: 'miesiecznie' }, BIU.c, 'PATCH')).s, 200, 'kierownik projektu i rozliczanie miesięczne');
    eq((await call('d1/projekty/' + P.id + '/zespol', { user_id: SV.id, role: 'serwisant' }, BIU.c)).s, 201, 'pracownik w zespole projektu');
    eq((await call('d1/projekty/' + P.id + '/budzet', { lines: [{ kind: 'przychod', category: 'montaz', amount: 20000 }, { kind: 'koszt', category: 'materialy', amount: 2000 }, { kind: 'koszt', category: 'robocizna', amount: 3000 }] }, BIU.c, 'PUT')).s, 403, 'budżet – rola finansowa');
    r = await call('d1/projekty/' + P.id + '/budzet', { lines: [{ kind: 'przychod', category: 'montaz', amount: 20000 }, { kind: 'koszt', category: 'materialy', amount: 2000 }, { kind: 'koszt', category: 'robocizna', amount: 3000 }] }, KIE.c, 'PUT');
    eq(r.s, 200, 'budżet projektu'); near(r.j.budzet_koszt, 5000, 'budżet kosztów'); near(r.j.budzet_przychod, 20000, 'budżet przychodów');
    eq((await call('d1/projekty/' + P.id + '/budzet', { lines: [{ kind: 'koszt', category: 'materialy', amount: 1 }, { kind: 'koszt', category: 'materialy', amount: 2 }] }, KIE.c, 'PUT')).s, 400, 'kategoria budżetu tylko raz');
    eq((await call('d1/zlecenia/projekt', { typ: 'serwis', id: SO.id, projekt: P.id }, BIU.c)).s, 200, 'serwis dodany do projektu');
    let card = (await call('d1/projekty/' + P.id, null, BIU.c)).j;
    ok(card.members.some(m => m.user_id === SV.id) && card.orders.some(o => o.id === SO.id) && card.orders.some(o => o.id === X.id), 'karta projektu: zespół i zlecenia (montaż + serwis)');
    near(card.money.cost.materialy, 220, 'karta: koszt materiałów z RW montażu (serwis podłączony później – jego RW bez projektu)');
    near(card.money.cost.robocizna, 150, 'karta: koszt robocizny z czasu pracy');
    ok(card.events.length >= 4, 'historia projektu');

    // ---------- wspólny rejestr zleceń ----------
    r = await call('d1/zlecenia?projekt=' + P.id, null, BIU.c);
    ok(r.j.rows.some(x => x.type === 'montaz' && x.id === X.id) && r.j.rows.some(x => x.type === 'serwis' && x.id === SO.id && x.status === 'do_przydzielenia'), 'rejestr: montaż i serwis projektu, wspólne statusy');
    near(new Date(r.j.rows.find(x => x.id === SO.id).due_date) - new Date(SO.assign_due), 0, 'termin nieprzydzielonego serwisu = termin przydziału (14 dni)');
    await pool.query(`UPDATE service_orders SET received_at = current_date - 20, assign_due = current_date - 6 WHERE id = $1`, [SO.id]);
    r = await call('d1/zlecenia?termin=po_terminie&typ=serwis', null, BIU.c); ok(r.j.rows.some(x => x.id === SO.id && x.overdue), 'serwis po terminie przydziału oznaczony');
    eq((await call('d1/zlecenia?typ=serwis', null, OD.c)).s, 403, 'rejestr zleceń – tylko biuro');

    // ---------- rozliczenie i zamknięcie ----------
    eq((await call('d1/zlecenia/rozlicz', { typ: 'serwis', id: SO.id, kwota: 300, faktura: 'FV/T4/S1' }, KS.c)).s, 409, 'nie rozlicza się niewykonanego serwisu');
    await pool.query(`UPDATE service_orders SET assigned_to = $2, assigned_at = now(), status = 'wykonane', completed_at = now() WHERE id = $1`, [SO.id, SV.id]);
    eq((await call('d1/zlecenia/rozlicz', { typ: 'serwis', id: SO.id, kwota: 300, faktura: 'FV/T4/S1' }, BIU.c)).s, 403, 'rozlicza rola finansowa');
    eq((await call('d1/zlecenia/rozlicz', { typ: 'serwis', id: SO.id, kwota: 300 }, KS.c)).s, 400, 'kwota bez faktury odrzucona');
    r = await call('d1/zlecenia/rozlicz', { typ: 'serwis', id: SO.id, kwota: 300, faktura: 'FV/T4/S1', data: today }, KS.c); eq(r.s, 200, 'serwis rozliczony');
    const fin = (await pool.query(`SELECT * FROM finance WHERE service_order_id = $1`, [SO.id])).rows;
    ok(fin.length === 1 && fin[0].kind === 'przychod' && Number(fin[0].amount_pln) === 300 && fin[0].project_id === P.id && fin[0].invoice_no === 'FV/T4/S1', 'przychód w finansach z fakturą i projektem');
    eq((await pool.query('SELECT status FROM service_orders WHERE id = $1', [SO.id])).rows[0].status, 'rozliczone', 'status serwisu: rozliczone');
    eq((await call('d1/zlecenia/rozlicz', { typ: 'serwis', id: SO.id, kwota: 300, faktura: 'FV/T4/S1' }, KS.c)).s, 409, 'drugie rozliczenie odrzucone');
    eq((await call('serwisy/' + SO.id, { description: 'zmiana po rozliczeniu' }, BIU.c, 'PATCH')).s, 409, 'rozliczonego serwisu nie można edytować');
    eq((await call('d1/zlecenia/zamknij', { id: SO.id }, KS.c)).s, 200, 'zamknięcie serwisu'); eq((await pool.query('SELECT status FROM service_orders WHERE id = $1', [SO.id])).rows[0].status, 'zamkniete');
    await call('d1/montaze/' + X.id, { status: 'wykonany' }, BIU.c, 'PATCH');
    r = await call('d1/zlecenia/rozlicz', { typ: 'montaz', id: X.id, kwota: 5000, faktura: 'FV/T4/M1' }, KS.c); eq(r.s, 200, 'montaż rozliczony');
    r = await call('d1/zlecenia?projekt=' + P.id, null, BIU.c); ok(r.j.rows.find(x => x.id === X.id).status === 'rozliczone', 'rejestr: montaż rozliczony');
    card = (await call('d1/projekty/' + P.id, null, BIU.c)).j;
    near(card.money.przychod, 5300, 'przychód projektu (montaż + serwis)');
    ok(card.money.marza === Math.round((card.money.przychod - card.money.koszt) * 100) / 100 && card.money.wykorzystanie_budzetu_pct > 0, 'marża i wykorzystanie budżetu');

    // ---------- lokale, urządzenia, historia ----------
    r = await call('d1/budynki/' + B.id + '/lokale', { seria: { od: 1, do: 5 } }, BIU.c); eq(r.j.added, 5, 'seria lokali 1–5');
    eq((await call('d1/budynki/' + B.id + '/lokale', { seria: { od: 1, do: 6 } }, BIU.c)).j.added, 1, 'seria pomija istniejące numery');
    const units = (await call('d1/budynki/' + B.id + '/lokale', null, BIU.c)).j; eq(units.length, 6, '6 lokali');
    await call('d1/urzadzenia', { building_id: B.id, installation_id: X.id, type: 'podzielnik', serials: 'T4P001\nT4P002\nT4P003\nT4P004\nT4P005', installed_at: today }, BIU.c);
    await call('d1/urzadzenia', { building_id: B.id, type: 'cieplomierz', serials: 'T4C001', installed_at: today }, BIU.c);
    const devs = (await pool.query(`SELECT id, serial_no FROM devices WHERE serial_no LIKE 'T4%' ORDER BY serial_no`)).rows;
    const dev = s => devs.find(d => d.serial_no === s).id;
    eq((await call('d1/urzadzenia/' + dev('T4P001'), { unit_id: units[0].id, manufacturer: 'Techem', radio_id: 'R-T4-1' }, BIU.c, 'PATCH')).s, 200, 'urządzenie: producent, lokal, ID radiowe');
    eq((await call('d1/urzadzenia/' + dev('T4P001'), { unit_id: '00000000-0000-4000-8000-000000000000' }, BIU.c, 'PATCH')).s, 400, 'lokal spoza budynku odrzucony');
    await call('d1/urzadzenia/' + dev('T4P005'), { status: 'wadliwe', powod: 'uszkodzony wyświetlacz' }, BIU.c, 'PATCH');
    await call('d1/urzadzenia/' + dev('T4P005'), { status: 'zamontowane' }, BIU.c, 'PATCH');
    await pool.query('UPDATE service_orders SET device_id = $2 WHERE id = $1', [SO.id, dev('T4P001')]);

    // ---------- odczyty per urządzenie ----------
    r = await call('odczyty', { building_id: B.id, scope: 'wszystkie', method: 'radiowy', cycle_months: 12, next_due: today, assigned_to: OD.id }, BIU.c); eq(r.s, 201, 'harmonogram odczytów budynku');
    const SCH = r.j; T.schedules.push(SCH.id);
    await pool.query('UPDATE reading_schedules SET project_id = $2 WHERE id = $1', [SCH.id, P.id]);
    r = await call(`d1/odczyty/${SCH.id}/urzadzenia?data=${today}`, null, OD.c); eq(r.j.devices.length, 6, 'urządzenia budynku w zakresie odczytu');
    const prev = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    eq((await call(`d1/odczyty/${SCH.id}/wartosci`, { read_at: prev, values: [{ device_id: dev('T4C001'), value: 120.5 }] }, OD.c)).s, 200, 'odczyt poprzedni ciepłomierza');
    r = await call(`d1/odczyty/${SCH.id}/wartosci`, { read_at: today, source: 'mobilny', values: [
      { device_id: dev('T4P001'), value: 100 }, { device_id: dev('T4P002'), value: 110 }, { device_id: dev('T4P003'), value: 95 }, { device_id: dev('T4P004'), value: '' , note: 'brak dostępu' },
      { device_id: dev('T4C001'), value: 100 }] }, OD.c);
    eq(r.s, 200, 'odczyty z telefonu'); eq(r.j.saved, 5);
    ok(r.j.control.missing.length === 2 && r.j.control.missing.some(m => m.reason === 'brak dostępu') && r.j.control.missing.some(m => m.reason === 'nie wpisano'), 'kontrola kompletności: brak dostępu + nie wpisano');
    ok(r.j.control.suspicious.some(s => s.id === dev('T4C001') && /spadek/.test(s.anomaly)), 'ciepłomierz: spadek wskazania = podejrzany');
    eq((await call(`d1/odczyty/${SCH.id}/wartosci`, { read_at: today, values: [{ device_id: dev('T4P001'), value: -3 }] }, OD.c)).s, 400, 'wartość ujemna odrzucona');
    eq((await call(`d1/odczyty/${SCH.id}/wartosci`, { read_at: today, values: [{ device_id: '00000000-0000-4000-8000-000000000000', value: 1 }] }, OD.c)).s, 400, 'urządzenie spoza budynku odrzucone');
    r = await call(`d1/odczyty/${SCH.id}/import`, { read_at: today, csv: 'numer;wartosc\nR-T4-1;101\nT4P005;5000\nNIEZNANY;5' }, OD.c);
    ok(r.s === 200 && r.j.saved === 2 && r.j.unknown.includes('NIEZNANY'), 'import z czytnika: po ID radiowym i numerze, nieznane zgłoszone');
    ok(r.j.control.suspicious.some(s => s.id === dev('T4P005') && /mediana/.test(s.anomaly)), 'podzielnik odbiegający od mediany budynku = podejrzany');
    eq((await call(`d1/odczyty/${SCH.id}/wartosci`, { read_at: today, values: [{ device_id: dev('T4P001'), value: 1 }] }, MG.c)).s, 403, 'odczyty – tylko obsługa odczytów i biuro');
    r = await call(`d1/odczyty/${SCH.id}/protokol`, { read_at: today }, OD.c); eq(r.s, 201, 'protokół odczytów (PDF)');
    const pr = (await pool.query(`SELECT v.file_data FROM document_versions v WHERE v.document_id = $1`, [r.j.document_id])).rows[0];
    ok(pr.file_data.subarray(0, 5).toString() === '%PDF-', 'protokół odczytów zapisany jako PDF');
    // historia urządzenia
    card = (await call('d1/urzadzenia/' + dev('T4P001'), null, BIU.c)).j;
    ok(card.manufacturer === 'Techem' && card.unit_number === '1' && card.timeline.some(t => t.kind === 'montaz') && card.timeline.some(t => t.kind === 'odczyt') && card.timeline.some(t => t.kind === 'serwis') && card.timeline.some(t => t.kind === 'przeniesienie'),
      'kartoteka urządzenia: montaż, odczyty, serwis, zmiana lokalu');
    card = (await call('d1/urzadzenia/' + dev('T4P005'), null, BIU.c)).j;
    ok(card.timeline.filter(t => t.kind === 'zmiana_statusu').length === 2 && card.timeline.some(t => /uszkodzony/.test(t.text)), 'historia zmian statusu z powodem');

    // ---------- protokół miesięczny projektu ----------
    r = await call('d1/projekty/' + P.id + '/protokol-miesieczny', { miesiac: month }, BIU.c); eq(r.s, 201, 'protokół miesięczny');
    const pm = (await pool.query(`SELECT d.related_type, d.related_id, v.file_data, v.content FROM documents d JOIN document_versions v ON v.document_id = d.id WHERE d.id = $1`, [r.j.document_id])).rows[0];
    ok(pm.related_id === P.id && pm.file_data.subarray(0, 5).toString() === '%PDF-' && JSON.parse(pm.content).montaze === 1 && JSON.parse(pm.content).serwisy === 1, 'protokół miesięczny: PDF przy projekcie, montaż i serwis z miesiąca');
    eq((await call('d1/projekty/' + P.id + '/protokol-miesieczny', { miesiac: '2026-13' }, BIU.c)).s, 400, 'miesiąc walidowany');

    // ---------- plany i pulpit ----------
    eq((await call('d1/plany', { miesiac: month, cele: { montaze: 10, serwisy: 20 } }, BIU.c, 'PUT')).s, 403, 'plany ustala kierownik');
    eq((await call('d1/plany', { miesiac: month, cele: { montaze: 10, serwisy: 20 } }, KIE.c, 'PUT')).s, 200, 'plan miesięczny');
    r = await call('d1/plany?miesiac=' + month, null, BIU.c);
    const pl = k => r.j.metrics.find(m => m.key === k); ok(pl('montaze').target === 10 && pl('montaze').actual >= 1 && pl('montaze').pct >= 10, 'wykonanie planu: montaże');
    r = await call('d1/pulpit?miesiac=' + month, null, BIU.c);
    ok(r.s === 200 && r.j.kpi.projekty_aktywne >= 1 && r.j.finance.przychod >= 5300 && r.j.materials.zuzycie >= 1210 && r.j.load.some(x => x.id === SV.id), 'pulpit działu z rzeczywistych danych');
    eq((await call('d1/pulpit', null, MG.c)).s, 403, 'pulpit działu – biuro');

    console.log(`OK: testy ERP – dział operacyjny i magazyn przeszły (${passed} sprawdzeń)`);
  } catch (e) {
    console.error('BŁĄD:', e.message); process.exitCode = 1;
  } finally {
    const q = (sql, p) => pool.query(sql, p).catch(e => console.error('sprzątanie:', e.message.slice(0, 160)));
    const P = T.projects, B = T.buildings;
    await q(`DELETE FROM device_readings WHERE device_id IN (SELECT id FROM devices WHERE serial_no LIKE 'T4%')`);
    await q(`DELETE FROM device_events WHERE device_id IN (SELECT id FROM devices WHERE serial_no LIKE 'T4%')`);
    await q(`UPDATE service_orders SET device_id = NULL WHERE id = ANY($1::uuid[])`, [T.orders]);
    await q(`DELETE FROM devices WHERE serial_no LIKE 'T4%'`);
    await q(`DELETE FROM units WHERE building_id = ANY($1::uuid[])`, [B]);
    await q(`DELETE FROM time_entries WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM absences WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM finance WHERE project_id = ANY($1::uuid[]) OR service_order_id = ANY($2::uuid[]) OR installation_id = ANY($3::uuid[])`, [P, T.orders, T.installations]);
    await q(`DELETE FROM stock_reservations WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_moves WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_docs d WHERE NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.doc_id = d.id) AND d.created_by = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM stock_levels WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_items WHERE id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM warehouses WHERE id = ANY($1::uuid[])`, [T.warehouses]);
    await q(`DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE related_id = ANY($1::uuid[]) OR related_id = ANY($2::uuid[]))`, [P, T.schedules]);
    await q(`DELETE FROM documents WHERE related_id = ANY($1::uuid[]) OR related_id = ANY($2::uuid[])`, [P, T.schedules]);
    await q(`DELETE FROM readings WHERE schedule_id = ANY($1::uuid[])`, [T.schedules]);
    await q(`DELETE FROM notifications WHERE related_id = ANY($1::uuid[]) OR related_id = ANY($2::uuid[]) OR related_id = ANY($3::uuid[])`, [T.schedules, T.orders, P]);
    await q(`DELETE FROM reading_schedules WHERE id = ANY($1::uuid[])`, [T.schedules]);
    await q(`DELETE FROM service_events WHERE order_id = ANY($1::uuid[])`, [T.orders]);
    await q(`DELETE FROM service_orders WHERE id = ANY($1::uuid[])`, [T.orders]);
    await q(`DELETE FROM installations WHERE id = ANY($1::uuid[])`, [T.installations]);
    await q(`DELETE FROM project_events WHERE project_id = ANY($1::uuid[])`, [P]);
    await q(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [P]);
    await q(`DELETE FROM buildings WHERE id = ANY($1::uuid[])`, [B]);
    await q(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [T.customers]);
    await q(`DELETE FROM monthly_plans WHERE month = $1::date`, [month + '-01']);
    for (const p of planBefore) await q(`INSERT INTO monthly_plans (month, metric, target) VALUES ($1::date, $2, $3)`, [month + '-01', p.metric, p.target]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    srv.kill(); await pool.end();
  }
})();
