// Testy ERP – etap 7 i 5: sprzedaż części samochodowych, zakupy, finanse firmy.
// Produkt (zamienniki, ceny, marża), zakup (zamówienie → przyjęcie częściowe PZ → zobowiązanie → zapłata), sprzedaż
// (zamówienie → rezerwacja → wydanie WZ → faktura → należność → zapłata), zwrot na stan i wadliwy, reklamacja, stany,
// marża i raport sprzedaży, propozycje zamówień z minimów, wyniki działów (Ubezpieczenia = zysk, nie kwota polis),
// przepływy, eksport dla księgowości, integracje bez atrap, uprawnienia. Dane robocze [T-ERP7] są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const near = (a, b, m) => { assert.ok(Math.abs(Number(a) - Number(b)) < 0.011, `${m} (${a} ≠ ${b})`); passed++; };

(async () => {
  const PORT = 7300 + Math.floor(Math.random() * 200), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { s: r.status, ct, j: ct.includes('json') ? await r.json().catch(() => ({})) : {} };
  };
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [], PASS = 'Erp-Test-2026x', T = { items: [], suppliers: [], customers: [], orders: [], pos: [], policies: [] };
  const today = new Date().toISOString().slice(0, 10);
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const hash = await bcrypt.hash(PASS, 4);
    const mk = async (login, role) => {
      const id = (await pool.query(`INSERT INTO users (login, password_hash, role, full_name, must_change_password) VALUES ($1, $2, $3, $4, false) RETURNING id`, [login, hash, role, '[T-ERP7] ' + login])).rows[0].id;
      users.push(id);
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: PASS }) });
      return { id, c: (r.headers.get('set-cookie') || '').split(';')[0] };
    };
    const SP = await mk('terp7.sprzedawca', 'uzytkownik'), MG = await mk('terp7.magazyn', 'magazynier'), KS = await mk('terp7.ksiegowa', 'ksiegowosc'), MON = await mk('terp7.monter', 'monter');
    const W = (await call('magazyn/magazyny', null, MG.c)).j.find(w => w.code === 'MAG');
    // Stan analityki przed testem – porównujemy przyrost, żeby inne dane z dzisiaj nie wpływały na wynik.
    const AN0 = (await call(`czesci/analityka?od=${today}&do=${today}`, null, SP.c)).j;

    // ---------- kartoteka produktu i dostawca ----------
    let r = await call('magazyn/dostawcy', { name: '[T7] Hurtownia Moto', tax_id: '1234567890', payment_days: 21 }, MG.c); eq(r.s, 201, 'dostawca'); const SUP = r.j; T.suppliers.push(SUP.id);
    r = await call('magazyn/pozycje', { sku: 'T7-KLOCKI-1', name: '[T7] Klocki hamulcowe przód', kind: 'czesc', department_id: 'sprzedaz-czesci-i-eksport', manufacturer: 'Bosch', catalog_no: '0 986 494 123',
      replacement_nos: 'TRW GDB1234, ATE 13.0460', category: 'hamulce', vehicle_type: 'osobowe', sale_price: 180, purchase_price: 100, min_qty: 5, supplier_id: SUP.id, location: 'R1-P2' }, MG.c);
    eq(r.s, 201, 'produkt z zamiennikami'); const IT = r.j; T.items.push(IT.id);
    r = await call('magazyn/pozycje', { sku: 'T7-FILTR-1', name: '[T7] Filtr oleju ciężarowy', kind: 'czesc', department_id: 'sprzedaz-czesci-i-eksport', sale_price: 95.5, purchase_price: 60, min_qty: 10, supplier_id: SUP.id, vehicle_type: 'ciezarowe' }, MG.c);
    const IT2 = r.j; T.items.push(IT2.id);
    r = await call('magazyn/pozycje?q=GDB1234', null, SP.c); ok(r.j.some(i => i.id === IT.id), 'wyszukiwanie po numerze zamiennika');
    ok(r.j.find(i => i.id === IT.id).margin_pct === 44.44, 'marża produktu z cen zakupu i sprzedaży (44,44%)');
    ok((await call('szukaj?q=' + encodeURIComponent('0 986 494'), null, SP.c)).j.groups.some(g => g.key === 'czesci'), 'globalne wyszukiwanie po numerze katalogowym');

    // ---------- zakup: zamówienie, przyjęcie częściowe, zobowiązanie ----------
    eq((await call('zakupy', { supplier_id: SUP.id, lines: [{ item_id: IT.id, qty: 10 }] }, SP.c)).s, 403, 'zamówienia zakupu – magazyn/kierownik');
    r = await call('zakupy', { supplier_id: SUP.id, lines: [{ item_id: IT.id, qty: 10, unit_price: 100 }, { item_id: IT2.id, qty: 20, unit_price: 60 }], expected_date: today }, MG.c);
    eq(r.s, 201, 'zamówienie zakupu'); const PO = r.j; T.pos.push(PO.id); near(PO.total_net, 2200, 'wartość zamówienia zakupu');
    eq((await call('zakupy/' + PO.id + '/przyjmij', { lines: [{ line_id: PO.lines[0].id, qty: 1 }] }, MG.c)).s, 409, 'przyjęcie przed wysłaniem zamówienia odrzucone');
    eq((await call('zakupy/' + PO.id + '/zamow', {}, MG.c)).s, 200, 'zamówienie wysłane');
    const L1 = PO.lines.find(l => l.item_id === IT.id), L2 = PO.lines.find(l => l.item_id === IT2.id);
    r = await call('zakupy/' + PO.id + '/przyjmij', { invoice_no: 'FZ/T7/1', lines: [{ line_id: L1.id, qty: 10 }, { line_id: L2.id, qty: 12 }] }, MG.c);
    ok(r.s === 201 && r.j.status === 'czesciowo' && r.j.doc.kind === 'PZ', 'przyjęcie częściowe (PZ)'); near(r.j.doc.total_value, 1720, 'wartość PZ 10 × 100 + 12 × 60');
    const PZ1 = r.j.doc;
    eq((await call('zakupy/' + PO.id + '/przyjmij', { lines: [{ line_id: L2.id, qty: 9 }] }, MG.c)).s, 409, 'przyjęcie ponad zamówioną ilość odrzucone');
    r = await call('zakupy/' + PO.id + '/przyjmij', { invoice_no: 'FZ/T7/2', lines: [{ line_id: L2.id, qty: 8, unit_price: 62 }] }, MG.c); eq(r.j.status, 'przyjete', 'dostawa kompletna');
    let it = (await call('magazyn/pozycje/' + IT2.id, null, MG.c)).j; near(it.qty, 20, 'stan filtrów 20'); near(it.avg_cost, 60.8, 'średni koszt (12 × 60 + 8 × 62) / 20');
    r = await call('finanse-erp/zobowiazania', null, KS.c);
    const due = r.j.rows.find(x => x.id === PZ1.id); ok(due && due.invoice_no === 'FZ/T7/1' && due.counterparty === '[T7] Hurtownia Moto', 'zobowiązanie wobec dostawcy z faktury PZ');
    ok(String(due.due_date).slice(0, 10) === new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10), 'termin płatności z warunków dostawcy (21 dni)');
    eq((await call('finanse-erp/zaplata', { source: 'pz', id: PZ1.id, paid_at: today }, KS.c)).s, 200, 'zapłata faktury dostawcy');
    ok(!(await call('finanse-erp/zobowiazania', null, KS.c)).j.rows.some(x => x.id === PZ1.id), 'zapłacone zobowiązanie znika z listy');
    eq((await call('finanse-erp/zaplata', { source: 'pz', id: PZ1.id }, KS.c)).s, 409, 'druga zapłata odrzucona');

    // ---------- sprzedaż: zamówienie, rezerwacja, wydanie, faktura, należność ----------
    const C = (await call('klienci', { kind: 'firma', name: '[T7] Warsztat Auto-Serwis', phone: '600 100 200', tax_id: '9876543210' }, SP.c)).j; T.customers.push(C.id);
    eq((await call('czesci/zamowienia', { customer_id: C.id, lines: [{ item_id: IT.id, qty: 1 }] }, MON.c)).s, 403, 'monter nie sprzedaje części');
    r = await call('czesci/zamowienia', { customer_id: C.id, vehicle: 'VW Golf VII, VIN WVWZZZ1KZ', lines: [{ item_id: IT.id, qty: 4 }, { item_id: IT2.id, qty: 2, unit_price: 100, discount_pct: 10 }] }, SP.c);
    eq(r.s, 201, 'zamówienie części'); const O = r.j; T.orders.push(O.id);
    near(O.total_net, 4 * 180 + 180, 'wartość: cena z kartoteki + cena ręczna z rabatem 10% (720 + 180)');
    r = await call('czesci/zamowienia/' + O.id + '/potwierdz', {}, SP.c); eq(r.j.status, 'potwierdzone', 'potwierdzenie z rezerwacją');
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; ok(it.reserved == 4 && it.free == 6, 'rezerwacja: zarezerwowane 4, wolne 6');
    const O2 = (await call('czesci/zamowienia', { customer_id: C.id, lines: [{ item_id: IT.id, qty: 7 }] }, SP.c)).j; T.orders.push(O2.id);
    r = await call('czesci/zamowienia/' + O2.id + '/potwierdz', {}, SP.c); ok(r.s === 409 && /Brak wolnego stanu/.test(r.j.error), 'drugie zamówienie ponad wolny stan odrzucone (rezerwacja chroni towar)');
    eq((await call('czesci/zamowienia/' + O2.id + '/anuluj', { powod: 'brak towaru' }, SP.c)).j.status, 'anulowane', 'anulowanie zamówienia');
    // równoczesne potwierdzenie dwóch zamówień na ten sam wolny stan (6 szt.): przechodzi dokładnie jedno
    const O3 = (await call('czesci/zamowienia', { customer_id: C.id, lines: [{ item_id: IT.id, qty: 6 }] }, SP.c)).j; T.orders.push(O3.id);
    const O4 = (await call('czesci/zamowienia', { customer_id: C.id, lines: [{ item_id: IT.id, qty: 6 }] }, SP.c)).j; T.orders.push(O4.id);
    const both = await Promise.all([O3, O4].map(o => call('czesci/zamowienia/' + o.id + '/potwierdz', {}, SP.c)));
    ok(both.filter(x => x.s === 200).length === 1 && both.filter(x => x.s === 409).length === 1, 'równoczesne rezerwacje: jedna przyjęta, druga odrzucona (' + both.map(x => x.s) + ')');
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; ok(it.reserved == 10 && it.free == 0, 'po równoczesnych rezerwacjach: zarezerwowane 10, wolne 0 (bez zejścia poniżej zera)');
    for (const o of [O3, O4]) await call('czesci/zamowienia/' + o.id + '/anuluj', { powod: 'test równoczesności' }, SP.c);
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; ok(it.reserved == 4 && it.free == 6, 'anulowanie zwalnia rezerwację');
    eq((await call('czesci/zamowienia/' + O.id + '/faktura', { invoice_no: 'FV/T7/1' }, SP.c)).s, 409, 'faktura przed wydaniem odrzucona');
    r = await call('czesci/zamowienia/' + O.id + '/wydaj', {}, SP.c); eq(r.j.status, 'wydane', 'wydanie (WZ)');
    near(r.j.total_cost, 4 * 100 + 2 * 60.8, 'koszt sprzedanych części po średnim koszcie');
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; ok(it.qty == 6 && it.reserved == 0, 'stan po wydaniu 6, rezerwacja zużyta');
    r = await call('czesci/zamowienia/' + O.id + '/faktura', { invoice_no: 'FV/T7/1', invoice_date: today, due_date: new Date(Date.now() - 864e5 * 0).toISOString().slice(0, 10) }, SP.c);
    eq(r.j.status, 'zafakturowane', 'faktura'); const finRow = (await pool.query('SELECT * FROM finance WHERE part_order_id = $1', [O.id])).rows[0];
    ok(finRow.kind === 'przychod' && Number(finRow.amount_pln) === 900 && finRow.department_id === 'sprzedaz-czesci-i-eksport' && finRow.invoice_no === 'FV/T7/1', 'przychód działu sprzedaży części z fakturą');
    ok((await pool.query('SELECT 1 FROM sales_history WHERE number = $1', [O.number])).rows[0], 'wpis w historii sprzedaży');
    r = await call('finanse-erp/naleznosci', null, KS.c); ok(r.j.rows.some(x => x.id === finRow.id), 'należność na liście');
    eq((await call('finanse-erp/naleznosci', null, SP.c)).s, 403, 'należności firmy – rola finansowa');
    // zwrot na stan i wadliwy, reklamacja
    eq((await call('czesci/zamowienia/' + O.id + '/zwrot', { powod: 'za dużo', lines: [{ line_id: O.lines.find(l => l.item_id === IT.id).id, qty: 5 }] }, SP.c)).s, 409, 'zwrot ponad sprzedaną ilość odrzucony');
    r = await call('czesci/zamowienia/' + O.id + '/zwrot', { powod: 'pomyłka w zamówieniu', na_stan: true, lines: [{ line_id: O.lines.find(l => l.item_id === IT.id).id, qty: 1 }] }, SP.c);
    ok(r.s === 201 && Number(r.j.refund_net) === 180, 'zwrot na stan: korekta 180 zł');
    it = (await call('magazyn/pozycje/' + IT.id, null, MG.c)).j; near(it.qty, 7, 'zwrot wraca na stan');
    r = await call('czesci/zamowienia/' + O.id + '/zwrot', { powod: 'uszkodzony', na_stan: false, lines: [{ line_id: O.lines.find(l => l.item_id === IT2.id).id, qty: 1 }] }, SP.c);
    ok(r.s === 201 && Number(r.j.refund_net) === 90, 'zwrot wadliwego: korekta 90 zł (z rabatem)'); near((await call('magazyn/pozycje/' + IT2.id, null, MG.c)).j.qty, 18, 'wadliwy nie wraca na stan');
    r = await call('czesci/zamowienia/' + O.id + '/reklamacja', { title: '[T7] Piszczą klocki', description: 'po 2 tygodniach' }, SP.c); eq(r.s, 201, 'reklamacja do zamówienia');
    const card = (await call('czesci/zamowienia/' + O.id, null, SP.c)).j;
    ok(card.returns.length === 2 && card.complaints.length === 1 && card.margin === Math.round((900 - card.total_cost) * 100) / 100, 'karta zamówienia: zwroty, reklamacja, marża');
    // zapłata należności
    eq((await call('czesci/zamowienia/' + O.id + '/zaplata', { paid_at: today }, SP.c)).j.paid_at.slice(0, 10), today, 'zapłata klienta');
    ok(!(await call('finanse-erp/naleznosci', null, KS.c)).j.rows.some(x => x.id === finRow.id), 'zapłacona należność znika z listy');

    // ---------- analityka sprzedaży ----------
    r = await call(`czesci/analityka?od=${today}&do=${today}`, null, SP.c);
    near(r.j.przychod - AN0.przychod, 900 - 270, 'przychód po korektach zwrotów'); near(r.j.koszt - AN0.koszt, (400 + 121.6) - 100, 'koszt zakupu po zwrocie na stan');
    ok(r.j.marza === Math.round((r.j.przychod - r.j.koszt) * 100) / 100 && r.j.marza_pct > 0, 'marża i marża %');
    ok(r.j.top.some(t => t.id === IT.id && t.qty === 3), 'najlepiej sprzedające się produkty (po zwrotach)');
    ok(Array.isArray(r.j.slow) && r.j.months.length >= 1 && r.j.customers.some(c => c.id === C.id), 'zalegające produkty, miesiące, klienci');

    // ---------- propozycje zamówień z minimów ----------
    await pool.query('UPDATE stock_items SET min_qty = 50 WHERE id = $1', [IT.id]);
    r = await call('zakupy/propozycje', {}, MG.c); ok(r.s === 201 && r.j.created.length >= 1, 'propozycja zamówienia dla pozycji poniżej minimum');
    const prop = (await pool.query(`SELECT o.id, l.qty::float q FROM purchase_orders o JOIN purchase_order_lines l ON l.order_id = o.id WHERE l.item_id = $1 AND o.status = 'szkic'`, [IT.id])).rows[0];
    ok(prop && prop.q === 100 - 7, 'ilość w propozycji: 2 × minimum − wolne'); T.pos.push(prop.id);
    eq((await call('zakupy/propozycje', {}, MG.c)).j.created.length, 0, 'bez duplikatu propozycji przy otwartym zamówieniu');

    // ---------- wyniki działów, polisy, przepływy, eksport, integracje ----------
    const pc = (await call('klienci', { kind: 'osoba_prywatna', name: '[T7] Klient polisy' }, SP.c)).j; T.customers.push(pc.id);
    const pol = (await call('polisy', { customer_id: pc.id, number: 'T7/POL', insurer: '[T7] Warta', insurance_type: 'NNW', signed_at: today, start_date: today, end_date: '2099-01-01', total_amount: '10000', margin_pct: '12' }, SP.c)).j; T.policies.push(pol.id);
    r = await call(`finanse-erp/wyniki?od=${today}&do=${today}`, null, KS.c);
    const d = k => r.j.departments.find(x => x.department_id === k);
    ok(d('sprzedaz-czesci-i-eksport').przychod >= 900 && d('sprzedaz-czesci-i-eksport').koszt >= 270, 'wynik działu części: przychody i koszty (z kosztem sprzedanych części i korektami)');
    ok(d('ubezpieczenia').przychod >= 1200 && d('ubezpieczenia').przychod < 10000, 'Ubezpieczenia: przychód = zysk z polis (1200 zł), bez kwoty polisy (10 000 zł)');
    ok(r.j.polisy.kwota >= 10000 && /nie wchodzi do przychodów/.test(r.j.polisy.uwaga), 'kwota polis pokazana osobno');
    near(r.j.total.wynik, r.j.total.przychod - r.j.total.koszt, 'wynik firmy = przychody − koszty');
    r = await call(`finanse-erp/przeplywy?od=${today}&do=${today}`, null, KS.c); ok(r.j.total.wplywy >= 900 && r.j.total.wydatki >= 1720, 'przepływy: wpływy (zapłata klienta) i wydatki (zapłata dostawcy)');
    const xl = await fetch(`${base}/api/finanse-erp/eksport?od=${today}&do=${today}`, { headers: { Cookie: KS.c } });
    ok(xl.status === 200 && (xl.headers.get('content-type') || '').includes('spreadsheetml') && (await xl.arrayBuffer()).byteLength > 3000, 'eksport dla księgowości (XLSX)');
    r = await call('finanse-erp/integracje', null, KS.c);
    ok(r.j.find(i => i.key === 'ksef').status === 'oczekuje' && /nie są wysyłane/.test(r.j.find(i => i.key === 'ksef').detail), 'KSeF: oczekuje na dane dostępowe (bez atrapy)');
    eq((await call('finanse-erp/wyniki', null, MG.c)).s, 403, 'wyniki firmy – nie dla magazyniera');

    // ---------- pulpit właściciela ----------
    const OW = await mk('terp7.wlasciciel', 'wlasciciel');
    r = await call(`wlasciciel?od=${today}&do=${today}`, null, OW.c); eq(r.s, 200, 'pulpit właściciela');
    const W8 = r.j, fw = (await call(`finanse-erp/wyniki?od=${today}&do=${today}`, null, KS.c)).j;
    near(W8.finance.total.przychod, fw.total.przychod, 'pulpit: przychody = wyniki działów z modułu finansów');
    near(W8.finance.departments.find(x => x.department_id === 'ubezpieczenia').przychod, W8.policies.zysk, 'pulpit: przychód Ubezpieczeń = zysk z polis, nie kwota');
    ok(W8.policies.kwota >= 10000 && W8.policies.podpisane >= 1, 'pulpit: kwota polis tylko informacyjnie');
    near(W8.finance.total.przychod, W8.finance.departments.reduce((a, x) => a + x.przychod, 0), 'pulpit: suma działów = przychód firmy');
    ok(W8.parts.n >= 1 && W8.parts.przychod >= 900, 'pulpit: sprzedaż części w okresie');
    ok(W8.stock.wartosc >= 0 && typeof W8.ops.zlecenia_otwarte === 'number' && Array.isArray(W8.load), 'pulpit: magazyn, operacje, obciążenie');
    ok(Array.isArray(W8.alerts) && W8.alerts.every(a => ['krytyczny', 'ostrzezenie', 'info'].includes(a.level) && a.link.startsWith('/')), 'pulpit: alerty z poziomem i linkiem');
    ok(W8.alerts.some(a => /Pozycje magazynowe poniżej minimum/.test(a.text)) === (W8.stock.ponizej_minimum > 0), 'pulpit: alert o minimach zgodny ze stanem');
    eq((await call('wlasciciel', null, KS.c)).s, 403, 'pulpit właściciela – nie dla księgowości');
    eq((await call('wlasciciel', null, MG.c)).s, 403, 'pulpit właściciela – nie dla magazyniera');
    eq((await call('wlasciciel?od=2026-13-45', null, OW.c)).s, 400, 'pulpit: błędna data → 400');

    console.log(`OK: testy ERP – części, zakupy i finanse przeszły (${passed} sprawdzeń)`);
  } catch (e) {
    console.error('BŁĄD:', e.message); process.exitCode = 1;
  } finally {
    const q = (sql, p) => pool.query(sql, p).catch(e => console.error('sprzątanie:', e.message.slice(0, 160)));
    const orders = T.orders;
    await q(`DELETE FROM complaints WHERE part_order_id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM part_returns WHERE order_id = ANY($1::uuid[])`, [orders]);
    await q(`UPDATE part_orders SET finance_id = NULL, sale_id = NULL, wz_doc_id = NULL WHERE id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM finance WHERE part_order_id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM sales_history WHERE number IN (SELECT number FROM part_orders WHERE id = ANY($1::uuid[]))`, [orders]);
    await q(`UPDATE part_order_lines SET reservation_id = NULL WHERE order_id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM part_orders WHERE id = ANY($1::uuid[])`, [orders]);
    await q(`DELETE FROM purchase_orders WHERE id = ANY($1::uuid[]) OR supplier_id = ANY($2::uuid[])`, [T.pos, T.suppliers]);
    await q(`DELETE FROM stock_reservations WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_moves WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_docs d WHERE NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.doc_id = d.id) AND d.created_by = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM stock_levels WHERE item_id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM stock_items WHERE id = ANY($1::uuid[])`, [T.items]);
    await q(`DELETE FROM suppliers WHERE id = ANY($1::uuid[])`, [T.suppliers]);
    await q(`DELETE FROM policies WHERE id = ANY($1::uuid[])`, [T.policies]);
    await q(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [T.customers]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    srv.kill(); await pool.end();
  }
})();
