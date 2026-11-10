// Testy etapu 3: działy (Podzielniki i Montaże, Sprzedaż części i eksport), CRM, finanse, Knowledge Base,
// Platforma Szkoleniowa, narzędzia agentów działowych. API NBP zastępuje lokalna atrapa w formacie NBP (tabela A).
'use strict';
const { spawn } = require('child_process'), http = require('http'), assert = require('assert/strict'), path = require('path');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = '[T3]';

const nbpDate = new Date().toISOString().slice(0, 10);
const nbp = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify([{ table: 'A', no: '218/A/NBP/2026', effectiveDate: nbpDate, rates: [
    { currency: 'euro', code: 'EUR', mid: 4.25 }, { currency: 'dolar amerykański', code: 'USD', mid: 4.0 }, { currency: 'korona czeska', code: 'CZK', mid: 0.17 }] }]));
});
const PDF_MIN = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

(async () => {
  await new Promise(r => nbp.listen(0, r));
  const PORT = 4700 + Math.floor(Math.random() * 200), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, AI_MODE: 'test', NBP_API_URL: 'http://localhost:' + nbp.address().port + '/api' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const raw = async (p, body, cookie, method) => fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const call = async (...a) => { const r = await raw(...a); return { s: r.status, j: await r.json().catch(() => ({})), c: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  const pdfOf = async (p, cookie) => { const r = await raw(p, null, cookie); const b = Buffer.from(await r.arrayBuffer()); return { s: r.status, type: r.headers.get('content-type'), pdf: b.subarray(0, 5).toString() === '%PDF-', size: b.length }; };
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await sleep(100); } }
    const login = async l => (await call('login', { login: l, password: '1234' })).c;
    const A = await login('m.ozga'), U = await login('m.ozga1'), K = await login('k.kretkowska');

    // --- CRM ---
    let r = await call('klienci', { kind: 'wspolnota', name: T + ' Wspólnota Mieszkaniowa Słoneczna 12', tax_id: '5251234567', address: 'ul. Słoneczna 12, 00-001 Warszawa', email: 'zarzad@slonczna.pl',
      contacts: [{ imie: 'Anna Nowak', funkcja: 'Zarząd', telefon: '600100200' }], departments: ['podzielniki-i-montaze'] }, U);
    eq(r.s, 201, 'klient (wspólnota)'); const wsp = r.j;
    eq((await call('klienci', { kind: 'firma', name: 'X', email: 'zly' }, U)).s, 400, 'walidacja klienta');
    r = await call('klienci', { kind: 'klient_zagraniczny', name: T + ' Autoteile Müller GmbH', country: 'DE', language: 'de', tax_id: 'DE123456789', address: 'Hauptstr. 5, 10115 Berlin' }, U);
    const de = r.j; eq(r.s, 201);
    eq((await call('klienci?q=' + encodeURIComponent('Słoneczna'), null, K)).j.length >= 1, true, 'wyszukiwanie w CRM');

    // --- dział 1: budynki, urządzenia, ekipy, montaże, protokół ---
    r = await call('d1/budynki', { customer_id: wsp.id, name: T + ' Słoneczna 12', address: 'ul. Słoneczna 12', city: 'Warszawa', units_count: 48 }, U);
    eq(r.s, 201); const bud = r.j;
    r = await call('d1/ekipy', { name: T + ' Ekipa A', leader: 'Jan Kowalski', phone: '600000001' }, U); const crew = r.j;
    eq((await call('d1/instalatorzy', { crew_id: crew.id, name: 'Piotr Zieliński', qualifications: 'SEP do 1 kV' }, U)).s, 201);
    r = await call('d1/kontrakty', { customer_id: wsp.id, title: T + ' Wymiana podzielników 2026', value_net: 24000 }, U); eq(r.s, 201); const kt = r.j;
    r = await call('d1/montaze', { building_id: bud.id, crew_id: crew.id, project_id: kt.id, planned_date: '2026-12-01', planned_end: '2026-12-02', devices_planned: 3, scope: 'Montaż podzielników elektronicznych', materials: [{ nazwa: 'Plomby', ilosc: 3, jm: 'szt.' }] }, U);
    eq(r.s, 201); const mz = r.j; ok(/^MZ\/\d{4}\/\d{3}$/.test(mz.number), 'numer montażu');
    eq((await call('d1/montaze', { building_id: bud.id, crew_id: crew.id, planned_date: '2026-12-02' }, U)).s, 409, 'kolizja terminu ekipy');
    const sn = 'T3-' + Date.now();
    r = await call('d1/urzadzenia', { building_id: bud.id, installation_id: mz.id, type: 'podzielnik', model: 'Caloric E', serials: `${sn}-1\n${sn}-2\n${sn}-3` }, U); eq(r.j.added, 3, '3 urządzenia');
    eq((await call('d1/urzadzenia', { building_id: bud.id, type: 'podzielnik', serials: `${sn}-1` }, U)).s, 409, 'duplikat numeru seryjnego');
    eq((await call('d1/urzadzenia?q=' + sn, null, K)).j.length, 3, 'wyszukiwanie po numerze seryjnym');
    eq((await call(`d1/montaze/${mz.id}/protokol`, { accepted_by: 'Anna Nowak' }, U)).s, 409, 'protokół tylko po wykonaniu');
    eq((await call(`d1/montaze/${mz.id}`, { status: 'wykonany' }, U, 'PATCH')).s, 200);
    r = await call(`d1/montaze/${mz.id}/protokol`, { accepted_by: 'Anna Nowak' }, U); eq(r.s, 201); ok(/^PO\//.test(r.j.number), 'numer protokołu');
    let f = await pdfOf(`dokumenty/${r.j.document_id}/plik`, K); eq(f.s, 200); ok(f.pdf && f.size > 5000, 'protokół odbioru PDF'); eq(f.type, 'application/pdf');
    eq((await call(`d1/montaze/${mz.id}`, null, U)).j.status, 'odebrany');
    // reklamacja po numerze seryjnym
    r = await call('reklamacje', { department_id: 'podzielniki-i-montaze', serial_no: `${sn}-2`, title: T + ' Podzielnik nie wyświetla odczytu', mark_faulty: true }, K);
    eq(r.s, 201); eq(r.j.building_id, bud.id, 'reklamacja powiązana z budynkiem'); eq(r.j.customer_id, wsp.id, '… i klientem');
    eq((await call(`reklamacje/${r.j.id}`, { status: 'rozwiazana', resolution: 'Wymiana baterii' }, K, 'PATCH')).j.status, 'rozwiazana');
    // finanse i rentowność
    eq((await call('finanse', { department_id: 'podzielniki-i-montaze', kind: 'przychod', category: 'faktura', amount: 12000, invoice_no: 'FV/1/2026', due_date: '2026-01-01', project_id: kt.id, building_id: bud.id, customer_id: wsp.id }, U)).s, 201);
    eq((await call('finanse', { department_id: 'podzielniki-i-montaze', kind: 'koszt', category: 'materiały', amount: 4000, building_id: bud.id, installation_id: mz.id, project_id: kt.id }, U)).s, 201);
    eq((await call('finanse', { department_id: 'ubezpieczenia', kind: 'koszt', amount: 1 }, U)).s, 400, 'brak finansów działu 3');
    const rent = (await call('d1/rentownosc', null, K)).j;
    const rb = rent.buildings.find(x => x.id === bud.id); eq(rb.marza, 8000, 'rentowność budynku'); eq(rb.marza_pct, 66.7);
    const kk = (await call('d1/kontrakty', null, K)).j.find(x => x.id === kt.id); eq(kk.zafakturowano, 12000); eq(kk.do_zafakturowania, 12000); eq(kk.zaplacono, 0);
    const fs1 = (await call('finanse/podsumowanie', null, K)).j; ok(fs1.invoices.po_terminie >= 1, 'faktura po terminie'); eq(fs1.months.length, 12);
    const fin = (await call('finanse?building_id=' + bud.id, null, U)).j;
    eq((await call('finanse/' + fin[0].id, null, U, 'DELETE')).s, 403, 'usuwanie finansów tylko admin');

    // --- kursy walut (NBP) ---
    eq((await call('kursy/reczny', { code: 'EUR', rate_pln: 4, effective_date: nbpDate }, U)).s, 403, 'kurs ręczny tylko admin');
    r = await call('kursy/pobierz', {}, U); eq(r.s, 200); eq(r.j.count, 3); eq(r.j.table, '218/A/NBP/2026');
    const eur = (await call('kursy', null, U)).j.find(x => x.code === 'EUR'); eq(eur.rate_pln, 4.25); eq(eur.source, 'NBP tabela A');
    r = await call('kursy/przelicz', { amount: 1000, from: 'EUR', to: 'USD', margin_pct: 10 }, U);
    eq(r.j.pln, 4250); eq(r.j.result, 1062.5); eq(r.j.with_margin, 1168.75, 'kalkulacja wielowalutowa z marżą'); eq(r.j.from.effective_date, nbpDate, 'data kursu');
    eq((await call('kursy/przelicz', { amount: 1, from: 'JPY', to: 'PLN' }, U)).s, 409, 'brak kursu – błąd zamiast zgadywania');

    // --- oferty: automatyczna kalkulacja, wersje, wysyłka po akceptacji ---
    const items = [{ nazwa: 'Pompa wody', ilosc: 10, koszt_pln: 425, kod_hs: '84133080', waga_kg: 2.5 }, { nazwa: 'Uszczelka', ilosc: 100, koszt_pln: 8.5, kod_hs: '40169300', waga_kg: 0.01 }];
    r = await call('oferty', { customer_id: de.id, title: T + ' Części do pomp', currency: 'EUR', margin_pct: 20, items }, U);
    eq(r.s, 201); let of = r.j;
    eq(Number(of.items[0].cena), 120, 'cena = 425 × 1,2 / 4,25'); eq(Number(of.total), 1440); eq(Number(of.total_pln), 6120); eq(Number(of.cost_pln), 5100); eq(of.version, 1); eq(of.status, 'szkic');
    ok(of.rate_source.startsWith('NBP tabela A'), 'źródło kursu w ofercie');
    r = await call('oferty/' + of.id, { discount_pct: 5, items }, U, 'PATCH'); eq(r.j.version, 2, 'zmiana = nowa wersja'); eq(Number(r.j.total), 1368);
    eq((await call('oferty/' + of.id, null, U)).j.versions.length, 2, 'historia wersji oferty');
    f = await pdfOf(`oferty/${of.id}/pdf?v=1`, K); ok(f.pdf, 'PDF wersji 1');
    r = await call(`oferty/${of.id}/wyslij`, {}, U); eq(r.s, 201); const apo = r.j;
    eq(apo.document_version, 2, 'akceptacja przypięta do wersji 2'); eq(apo.operation_type, 'oferta.wyslij'); eq(apo.status, 'oczekuje');
    eq((await call('oferty/' + of.id, { discount_pct: 0 }, U, 'PATCH')).s, 409, 'nie zmienisz oferty w akceptacji');
    eq((await call('approvals', { operation_type: 'oferta.wyslij', title: 'x' }, U)).s, 400, 'wysyłka tylko z modułu Oferty');
    eq((await call(`approvals/${apo.id}/wykonaj`, {}, U)).s, 409, 'bez zgody – brak wysyłki');
    eq((await call(`approvals/${apo.id}/decyzja`, { decision: 'zatwierdz', version: 1 }, U)).s, 403, 'użytkownik nie zatwierdza');
    eq((await call(`approvals/${apo.id}/decyzja`, { decision: 'zatwierdz', version: 1 }, A)).s, 200);
    await pool.query('UPDATE offers SET version = 3 WHERE id = $1', [of.id]);                       // manipulacja wersją oferty
    eq((await call(`approvals/${apo.id}/wykonaj`, {}, U)).s, 409, 'zmieniona wersja oferty – wysyłka zablokowana');
    await pool.query('UPDATE offers SET version = 2 WHERE id = $1', [of.id]);
    eq((await call(`approvals/${apo.id}/wykonaj`, {}, U)).s, 200);
    of = (await call('oferty/' + of.id, null, U)).j; eq(of.status, 'wyslana'); ok(of.sent_at, 'data wysyłki');
    const card = (await call('klienci/' + de.id, null, K)).j;
    ok(card.communications.some(x => x.subject.includes(of.number)), 'wysyłka w historii komunikacji klienta');
    // odrzucenie przez administratora → szkic
    r = await call('oferty', { customer_id: wsp.id, department_id: 'podzielniki-i-montaze', title: T + ' Oferta dla wspólnoty', currency: 'PLN', margin_pct: 30, items: [{ nazwa: 'Podzielnik z montażem', ilosc: 48, koszt_pln: 90 }] }, U);
    const of2 = r.j; const ap2 = (await call(`oferty/${of2.id}/wyslij`, {}, U)).j;
    eq((await call(`approvals/${ap2.id}/decyzja`, { decision: 'odrzuc', version: 1, note: 'za niska marża' }, A)).s, 200);
    eq((await call('oferty/' + of2.id, null, U)).j.status, 'szkic', 'odrzucona wysyłka – oferta wraca do szkicu');
    // wynik u klienta → sprzedaż + finanse
    r = await call(`oferty/${of.id}/wynik`, { przyjeta: true }, U); eq(r.s, 200); const sale = r.j.sale; ok(/^SP\//.test(sale.number));
    ok((await call('sprzedaz', null, K)).j.some(x => x.id === sale.id), 'historia sprzedaży');
    // dokumenty eksportowe
    r = await call('eksport', { kind: 'dane_celne', sale_id: sale.id, incoterms: 'DAP', destination_country: 'DE' }, U); eq(r.s, 201); ok(/^DC\//.test(r.j.number));
    f = await pdfOf(`dokumenty/${r.j.document_id}/plik`, K); ok(f.pdf, 'dane celne PDF');
    eq((await call('eksport', { kind: 'faktura_eksportowa', sale_id: sale.id, incoterms: 'XYZ' }, U)).s, 400, 'Incoterms z listy');
    eq((await call('eksport', { kind: 'dane_celne', offer_id: of2.id }, U)).s, 400, 'dane celne wymagają kodów HS');
    eq((await call('eksport', { kind: 'specyfikacja_wysylkowa', sale_id: sale.id }, U)).s, 201);
    eq((await call('reklamacje', { department_id: 'sprzedaz-czesci-i-eksport', sale_id: sale.id, title: T + ' Uszkodzona pompa' }, K)).j.customer_id, de.id, 'reklamacja sprzedaży');

    // --- Knowledge Base ---
    eq((await call('wiedza', { title: T + ' Procedura', content: 'x', for_agents: true }, U)).s, 403, 'dokument dla agentów publikuje admin');
    r = await call('wiedza', { kind: 'procedura', title: T + ' Procedura montażu podzielników', content: 'Podzielniki montujemy na 3/4 wysokości grzejnika. Plombowanie obowiązkowe.', for_agents: true, department_id: 'podzielniki-i-montaze' }, A);
    eq(r.s, 201); const kb = r.j;
    eq((await call(`wiedza/${kb.id}/wersja`, { content: 'Podzielniki montujemy na 3/4 wysokości grzejnika. Plombowanie i zdjęcie obowiązkowe.', note: 'zdjęcie' }, U)).s, 403, 'dokument agentów zmienia admin');
    eq((await call(`wiedza/${kb.id}/wersja`, { content: 'Podzielniki montujemy na 3/4 wysokości grzejnika. Plombowanie i zdjęcie obowiązkowe.', note: 'zdjęcie' }, A)).j.version, 2);
    eq((await call('wiedza', { title: T + ' Instrukcja PDF', content: 'opis', file_base64: Buffer.from('nie pdf').toString('base64') }, U)).s, 400, 'tylko PDF');
    r = await call('wiedza', { title: T + ' Instrukcja PDF', content: 'opis', file_base64: PDF_MIN, file_name: 'instrukcja.pdf' }, U); eq(r.s, 201);
    f = await pdfOf(`dokumenty/${r.j.id}/plik`, K); ok(f.pdf, 'PDF z Knowledge Base');
    ok((await call('wiedza?q=plombowanie', null, K)).j.some(x => x.id === kb.id), 'wyszukiwanie w KB');

    // --- narzędzia agentów działowych ---
    const tools = require('../lib/ai/tools'), catalog = require('../lib/ai/catalog');
    const kbHit = await tools.execute(catalog.byId('technik'), 'baza_wiedzy', { zapytanie: 'plombowanie' });
    ok(kbHit.length === 1 && kbHit[0].fragment.includes('zdjęcie'), 'agent czyta aktualną wersję KB');
    await assert.rejects(tools.execute(catalog.byId('technik'), 'kontrakty', {}), /nie jest przypisane/); passed++;
    const ag = await tools.execute(catalog.byId('kierownik_sprzedazy'), 'przygotuj_oferte', { klient_id: de.id, temat: T + ' Oferta agenta', waluta: 'USD', marza_pct: 25, pozycje: [{ nazwa: 'Filtr', ilosc: 5, koszt_pln: 40 }] });
    eq(ag.status, 'szkic'); eq(ag.kurs, 4); eq(ag.kwota, 62.5, 'agent: kalkulacja z kursem NBP');
    const ags = await tools.execute(catalog.byId('kierownik_sprzedazy'), 'zglos_wysylke_oferty', { oferta_id: ag.oferta_id });
    eq(ags.status, 'oczekuje', 'wysyłka oferty agenta czeka na administratora');
    eq((await pool.query('SELECT requested_by_type, requested_by FROM approvals WHERE id = $1', [ags.wniosek_id])).rows[0].requested_by, 'kierownik_sprzedazy');
    ok((await tools.execute(catalog.byId('technik'), 'montaze', {})).some(x => x.numer === mz.number), 'technik widzi harmonogram');
    ok((await tools.execute(catalog.byId('cfo'), 'finanse_podsumowanie', {})).od_poczatku_roku.length === 2, 'CFO: finanse działów 1 i 2');

    // --- Platforma Szkoleniowa ---
    eq((await call('szkolenia/admin/kursy', { title: 'x' }, U)).s, 403, 'panel szkoleń tylko admin');
    eq((await call('szkolenia/admin/postep', null, K)).s, 403);
    r = await call('szkolenia/admin/kursy', { title: T + ' Podstawy ubezpieczeń komunikacyjnych', description: 'OC, AC, NNW' }, A); const course = r.j;
    const mod = (await call('szkolenia/admin/moduly', { course_id: course.id, title: 'Moduł 1: OC i AC' }, A)).j;
    const l1 = (await call('szkolenia/admin/lekcje', { module_id: mod.id, title: 'Czym jest OC', kind: 'tekst', content: 'Obowiązkowe ubezpieczenie OC...' }, A)).j;
    eq((await call('szkolenia/admin/lekcje', { module_id: mod.id, title: 'Wideo', kind: 'wideo', video_url: 'http://example.com/a.mp4' }, A)).s, 400, 'wideo tylko https');
    const l2 = (await call('szkolenia/admin/lekcje', { module_id: mod.id, title: 'Film: likwidacja szkody', kind: 'wideo', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, A)).j;
    const l3 = (await call('szkolenia/admin/lekcje', { module_id: mod.id, title: 'OWU (PDF)', kind: 'pdf', file_base64: PDF_MIN, file_name: 'owu.pdf' }, A)).j;
    ok(l3.document_id, 'lekcja PDF');
    eq((await call('szkolenia/admin/testy', { course_id: course.id, module_id: mod.id, title: 'Test 1', pass_pct: 60, questions: [{ pytanie: 'OC jest', odpowiedzi: ['obowiązkowe'], poprawna: 0 }] }, A)).s, 400, 'min. 2 odpowiedzi');
    const quiz = (await call('szkolenia/admin/testy', { course_id: course.id, module_id: mod.id, title: 'Test 1', pass_pct: 60, questions: [
      { pytanie: 'OC posiadacza pojazdu jest', odpowiedzi: ['dobrowolne', 'obowiązkowe'], poprawna: 1 },
      { pytanie: 'AC chroni', odpowiedzi: ['własny pojazd', 'osoby trzecie'], poprawna: 0 }] }, A)).j;
    eq((await call('szkolenia/kursy', null, U)).j.some(x => x.id === course.id), false, 'nieopublikowany kurs niewidoczny');
    eq((await call('szkolenia/admin/kursy/' + course.id, { is_published: true }, A, 'PATCH')).s, 200);
    const cv = (await call('szkolenia/kursy/' + course.id, null, U)).j;
    eq(cv.modules[0].lessons.length, 3); eq(cv.modules[0].quizzes.length, 1);
    ok(cv.modules[0].quizzes[0].questions.every(q => q.poprawna === undefined), 'poprawne odpowiedzi nie trafiają do uczestnika');
    eq(cv.modules[0].lessons.find(x => x.id === l2.id).embed.src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'osadzenie YouTube');
    eq((await raw(`szkolenia/kursy/${course.id}/zaswiadczenie`, null, U)).status, 409, 'zaświadczenie dopiero po ukończeniu');
    for (const l of [l1, l2, l3]) eq((await call(`szkolenia/lekcje/${l.id}/ukonczona`, {}, U)).s, 200);
    r = await call(`szkolenia/testy/${quiz.id}/podejscie`, { answers: [0, 1] }, U); eq(r.j.score_pct, 0); eq(r.j.passed, false, 'test niezaliczony');
    r = await call(`szkolenia/testy/${quiz.id}/podejscie`, { answers: [1, 0] }, U); eq(r.j.score_pct, 100); eq(r.j.passed, true, 'test zaliczony');
    eq((await call('szkolenia/kursy', null, U)).j.find(x => x.id === course.id).progress.pct, 100, 'postęp 100%');
    f = await pdfOf(`szkolenia/kursy/${course.id}/zaswiadczenie`, U); eq(f.s, 200); ok(f.pdf, 'zaświadczenie PDF');
    const cert1 = (await pool.query('SELECT number FROM certificates WHERE course_id = $1', [course.id])).rows[0].number;
    await pdfOf(`szkolenia/kursy/${course.id}/zaswiadczenie`, U);
    eq((await pool.query('SELECT number FROM certificates WHERE course_id = $1', [course.id])).rows[0].number, cert1, 'ten sam numer przy ponownym pobraniu');
    const prog = (await call('szkolenia/admin/postep', null, A)).j;
    eq(prog.users.find(x => x.login === 'm.ozga1').courses.find(c => c.course_id === course.id).complete, true, 'postęp w panelu administratora');
    ok((await tools.execute(catalog.byId('coo'), 'postep_szkolen', {})).length >= 4, 'COO widzi postęp szkoleń');

    // --- logowanie, wybór działu nadal działają ---
    eq((await call('me', null, U)).j.login, 'm.ozga1');
    eq((await call('meta', null, U)).j.departments.length, 3);
    console.log(`OK: testy etapu 3 przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    const q = (s, p = []) => pool.query(s, p).catch(e => console.error('sprzątanie:', e.message));
    await q(`DELETE FROM courses WHERE title LIKE $1`, [T + '%']);
    const offs = (await pool.query(`SELECT id, document_id FROM offers WHERE title LIKE $1`, [T + '%'])).rows;
    const custs = (await pool.query(`SELECT id FROM customers WHERE name LIKE $1`, [T + '%'])).rows.map(x => x.id);
    await q(`DELETE FROM export_documents WHERE customer_id = ANY($1)`, [custs]);
    await q(`DELETE FROM complaints WHERE customer_id = ANY($1) OR title LIKE $2`, [custs, T + '%']);
    await q(`DELETE FROM finance WHERE customer_id = ANY($1) OR building_id IN (SELECT id FROM buildings WHERE name LIKE $2) OR project_id IN (SELECT id FROM projects WHERE title LIKE $2)`, [custs, T + '%']);
    await q(`DELETE FROM sales_history WHERE customer_id = ANY($1)`, [custs]);
    await q(`UPDATE offers SET approval_id = NULL WHERE id = ANY($1)`, [offs.map(x => x.id)]);
    await q(`DELETE FROM approval_events WHERE approval_id IN (SELECT id FROM approvals WHERE (payload->>'offer_id') = ANY($1) OR title LIKE '%' || $2 || '%')`, [offs.map(x => x.id), T]);
    await q(`DELETE FROM approvals WHERE (payload->>'offer_id') = ANY($1) OR title LIKE '%' || $2 || '%'`, [offs.map(x => x.id), T]);
    await q(`DELETE FROM offers WHERE id = ANY($1)`, [offs.map(x => x.id)]);
    await q(`DELETE FROM communications WHERE customer_id = ANY($1)`, [custs]);
    await q(`DELETE FROM devices WHERE serial_no LIKE 'T3-%'`);
    await q(`UPDATE installations SET protocol_document_id = NULL WHERE building_id IN (SELECT id FROM buildings WHERE name LIKE $1)`, [T + '%']);
    await q(`DELETE FROM installations WHERE building_id IN (SELECT id FROM buildings WHERE name LIKE $1)`, [T + '%']);
    await q(`DELETE FROM projects WHERE title LIKE $1`, [T + '%']);
    await q(`DELETE FROM buildings WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM installers WHERE crew_id IN (SELECT id FROM crews WHERE name LIKE $1)`, [T + '%']);
    await q(`DELETE FROM crews WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM customers WHERE id = ANY($1)`, [custs]);
    await q(`DELETE FROM documents WHERE created_at >= $1 AND (title LIKE '%' || $2 || '%' OR kind IN ('protokol','eksport','oferta','szkolenie'))`, [t0, T]);
    await q(`DELETE FROM currency_rates WHERE table_no = '218/A/NBP/2026'`);
    await q(`DELETE FROM agent_runs WHERE created_at >= $1`, [t0]);
    await restoreFlags(); await pool.end(); srv.kill(); nbp.close();
  }
})();
