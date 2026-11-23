// Testy ERP – etap 6: Ubezpieczenia (rejestr podpisanych polis).
// Dodawanie i edycja polisy, przypisanie do klienta, zysk = kwota × marża / 100 (backend i baza, zaokrąglenia), historia zmian,
// filtrowanie, przypomnienie dokładnie 30 dni przed końcem (strefa Europe/Warsaw, przełom roku, nadrabianie po przerwie),
// brak duplikatów, brak przypomnień dla polis odnowionych i zakończonych, historia i obsługa przypomnień, widoczność
// w głównym panelu i dzwonku, dokument polisy, oddzielenie kwoty polisy od przychodów MXT, uprawnienia.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const P = require('../lib/erp/policies');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };

(async () => {
  const PORT = 7100 + Math.floor(Math.random() * 200), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { s: r.status, ct, j: ct.includes('json') ? await r.json().catch(() => ({})) : {}, c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [], PASS = 'Erp-Test-2026x', customers = [], policies = [];
  const day = (n, from = new Date()) => { const d = new Date(P.fmtDate(from) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const at = s => new Date(s + 'T10:00:00Z');   // „teraz” w symulacji: dany dzień, 11:00/12:00 w Warszawie
  const D = v => v instanceof Date ? P.fmtDate(v) : String(v).slice(0, 10);   // data z bazy (tekst RRRR-MM-DD)
  const settingsBefore = (await pool.query(`SELECT value FROM system_settings WHERE key = 'insurance'`)).rows[0];
  const finBefore = (await pool.query('SELECT count(*)::int n, coalesce(sum(amount_pln), 0)::float s FROM finance')).rows[0];
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const hash = await bcrypt.hash(PASS, 4);
    const mk = async (login, role) => {
      const id = (await pool.query(`INSERT INTO users (login, password_hash, role, full_name, must_change_password) VALUES ($1, $2, $3, $4, false) RETURNING id`, [login, hash, role, '[T-ERP6] ' + login])).rows[0].id;
      users.push(id);
      return { id, c: (await call('login', { login, password: PASS })).c };
    };
    const AG = await mk('terp6.agent', 'uzytkownik'), SZ = await mk('terp6.szef', 'kierownik'), MG = await mk('terp6.magazyn', 'magazynier'), KS = await mk('terp6.ksiegowa', 'ksiegowosc');
    // Odbiorcy przypomnień na czas testu: kierownik (+ zawsze osoba rejestrująca polisę).
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ('insurance', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [JSON.stringify({ recipients: [SZ.id] })]);

    // ---------- uprawnienia ----------
    eq((await call('polisy', null, MG.c)).s, 403, 'magazynier: brak dostępu do polis');
    eq((await call('polisy', null, KS.c)).s, 403, 'księgowość: brak dostępu do rejestru polis');

    // ---------- dodanie polisy z nowym klientem (wspólna kartoteka) ----------
    const t0 = day(0);
    const base1 = { number: 'T6/0001', insurer: '[T6] PZU', insurance_type: 'OC/AC pojazdu', description: 'Skoda Octavia ZG 12345, OC + AC + NNW', signed_at: t0, start_date: t0, end_date: day(364), total_amount: '3000', margin_pct: '15' };
    let r = await call('polisy', { ...base1, new_customer: { kind: 'osoba_prywatna', name: '[T6] Anna Nowak', phone: '+48 601 222 333', email: 'anna.t6@example.com', address: 'ul. Polna 1, Zielona Góra' } }, AG.c);
    eq(r.s, 201, 'polisa zarejestrowana z nowym klientem'); const A = r.j; policies.push(A.id); customers.push(A.customer_id);
    eq(A.profit, 450, 'zysk 3000 zł × 15% = 450 zł'); eq(A.total_amount, 3000); eq(A.status, 'aktywna', 'status: aktywna');
    const cust = (await pool.query('SELECT kind, departments FROM customers WHERE id = $1', [A.customer_id])).rows[0];
    ok(cust.kind === 'osoba_prywatna' && cust.departments.includes('ubezpieczenia'), 'klient w kartotece CRM (osoba prywatna, dział Ubezpieczenia)');
    eq(Number((await pool.query('SELECT profit FROM policies WHERE id = $1', [A.id])).rows[0].profit), 450, 'zysk zapisany w bazie');

    // ---------- walidacja ----------
    eq((await call('polisy', { ...base1, number: 'T6/X1', customer_id: A.customer_id, margin_pct: '101' }, AG.c)).s, 400, 'marża > 100% odrzucona');
    eq((await call('polisy', { ...base1, number: 'T6/X2', customer_id: A.customer_id, total_amount: '-5' }, AG.c)).s, 400, 'ujemna kwota odrzucona');
    eq((await call('polisy', { ...base1, number: 'T6/X3', customer_id: A.customer_id, total_amount: '10,123' }, AG.c)).s, 400, 'kwota z 3 miejscami po przecinku odrzucona');
    eq((await call('polisy', { ...base1, number: 'T6/X4', customer_id: A.customer_id, end_date: day(-1) }, AG.c)).s, 400, 'koniec przed początkiem odrzucony');
    eq((await call('polisy', { ...base1, customer_id: A.customer_id }, AG.c)).s, 409, 'ten sam numer w tym samym towarzystwie odrzucony');
    eq((await call('polisy', { ...base1, number: '', customer_id: A.customer_id }, AG.c)).s, 400, 'numer polisy wymagany');
    r = await call('polisy', { ...base1, insurer: '[T6] Warta', customer_id: A.customer_id }, AG.c); eq(r.s, 201, 'ten sam numer w innym towarzystwie dozwolony'); policies.push(r.j.id);

    // ---------- zaokrąglenia: backend (lib) i baza dają ten sam wynik ----------
    const cases = [['1234,56', '12,5', 154.32], ['0.01', '50', 0.01], ['100', '33.3333', 33.33], ['999.99', '0.0001', 0], ['19999.99', '7.25', 1450], ['0.05', '10', 0.01], ['2500.5', '13.13', 328.32]];
    let n = 0;
    for (const [amount, margin, exp] of cases) {
      r = await call('polisy', { ...base1, number: 'T6/R' + (++n), customer_id: A.customer_id, total_amount: amount, margin_pct: margin }, AG.c);
      policies.push(r.j.id);
      ok(r.s === 201 && r.j.profit === exp && P.profit(amount, margin) === exp, `zaokrąglenie: ${amount} × ${margin}% = ${exp} (baza i backend)`);
    }

    // ---------- edycja: kwota i marża przeliczają zysk, historia zmian ----------
    r = await call('polisy/' + A.id, { margin_pct: '20' }, AG.c, 'PATCH'); eq(r.j.profit, 600, 'zmiana marży na 20% → zysk 600 zł');
    r = await call('polisy/' + A.id, { total_amount: '3500,50' }, AG.c, 'PATCH'); eq(r.j.profit, 700.1, 'zmiana kwoty na 3500,50 → zysk 700,10 zł');
    r = await call('polisy/' + A.id, { description: 'Skoda Octavia ZG 12345, OC + AC + NNW + assistance', powod_zmiany: 'rozszerzenie zakresu' }, AG.c, 'PATCH'); eq(r.s, 200, 'edycja opisu');
    let card = (await call('polisy/' + A.id, null, AG.c)).j;
    const ch = card.events.filter(e => e.kind === 'zmiana');
    ok(ch.length === 3 && ch.some(e => e.changes.margin_pct && e.changes.profit && e.changes.profit[1] === '600') && ch.some(e => e.changes.total_amount && e.changes.total_amount[1] === '3500.5'), 'historia zmian: wartości przed i po, przeliczony zysk');
    ok(ch.some(e => e.note === 'rozszerzenie zakresu'), 'historia: powód zmiany');
    eq((await call('polisy/' + A.id, { margin_pct: 'abc' }, AG.c, 'PATCH')).s, 400, 'nieprawidłowa marża w edycji odrzucona');
    eq((await call('polisy/' + A.id, { end_date: day(-10) }, AG.c, 'PATCH')).s, 400, 'edycja nie przestawi końca przed początek');

    // ---------- przypisanie polisy do innego klienta ----------
    const C2 = (await call('klienci', { kind: 'firma', name: '[T6] Transport Kowalski Sp. z o.o.', phone: '68 444 55 66' }, AG.c)).j; customers.push(C2.id);
    r = await call('polisy', { ...base1, number: 'T6/F1', insurance_type: 'Firma / OC działalności', customer_id: C2.id, total_amount: '12000', margin_pct: '10' }, AG.c); policies.push(r.j.id); const F = r.j;
    r = await call('polisy/' + F.id, { customer_id: A.customer_id }, AG.c, 'PATCH'); eq(r.j.customer_id, A.customer_id, 'polisa przepisana na innego klienta');
    r = await call('polisy/' + F.id, { customer_id: C2.id }, AG.c, 'PATCH'); eq(r.j.customer_name, '[T6] Transport Kowalski Sp. z o.o.', 'i z powrotem');
    const kc = (await call('klienci/' + C2.id, null, AG.c)).j; ok(kc.policies.some(p => p.id === F.id && p.profit === 1200), 'karta klienta CRM: polisy z kwotą i zyskiem');

    // ---------- filtrowanie i wyszukiwanie ----------
    const ids = l => l.map(x => x.id);
    ok(ids((await call('polisy?q=T6/F1', null, AG.c)).j).includes(F.id), 'szukaj po numerze polisy');
    ok((await call('polisy?klient=' + C2.id, null, AG.c)).j.every(p => p.customer_id === C2.id), 'filtr: klient');
    ok((await call('polisy?towarzystwo=' + encodeURIComponent('[T6] warta'), null, AG.c)).j.every(p => p.insurer === '[T6] Warta'), 'filtr: towarzystwo (bez względu na wielkość liter)');
    ok((await call('polisy?rodzaj=' + encodeURIComponent('Firma / OC działalności'), null, AG.c)).j.some(p => p.id === F.id), 'filtr: rodzaj ubezpieczenia');
    ok(!ids((await call(`polisy?od=${day(1)}&q=T6`, null, AG.c)).j).includes(A.id) && ids((await call(`polisy?od=${t0}&do=${t0}&q=T6`, null, AG.c)).j).includes(A.id), 'filtr: data podpisania od–do');
    ok(ids((await call(`polisy?koniec_od=${day(300)}&koniec_do=${day(400)}&q=T6`, null, AG.c)).j).includes(A.id), 'filtr: termin zakończenia');
    ok((await call('szukaj?q=T6/F1', null, AG.c)).j.groups.some(g => g.key === 'polisy'), 'globalne wyszukiwanie: polisy');
    ok((await call('polisy/slowniki', null, AG.c)).j.insurers.includes('[T6] PZU'), 'słownik towarzystw z rejestru');

    // ---------- przypomnienie dokładnie 30 dni przed końcem ----------
    const mkP = async (num, end, extra = {}) => { const x = (await call('polisy', { ...base1, number: num, customer_id: A.customer_id, end_date: end, ...extra }, AG.c)).j; policies.push(x.id); return x; };
    const R = id => pool.query('SELECT * FROM policy_reminders WHERE policy_id = $1 ORDER BY generated_at', [id]).then(q => q.rows);
    const E31 = await mkP('T6/E31', day(31));
    await P.tick(at(day(0)));
    eq((await R(E31.id)).length, 0, '31 dni przed końcem: brak przypomnienia');
    await P.tick(at(day(1)));
    let rem = await R(E31.id);
    ok(rem.length === 1 && rem[0].days_left === 30 && D(rem[0].due_date) === day(1) && D(rem[0].generated_on) === day(1), 'dokładnie 30 dni przed końcem: przypomnienie z liczbą dni i dniem wygenerowania');
    await P.tick(at(day(1))); await P.tick(at(day(2)));
    eq((await R(E31.id)).length, 1, 'kolejne sprawdzenia: bez duplikatu');
    const notes = (await pool.query(`SELECT user_id, title, body FROM notifications WHERE related_id = $1 AND kind = 'polisa.koniec'`, [E31.id])).rows;
    ok(notes.length === 2 && notes.some(x => x.user_id === SZ.id) && notes.some(x => x.user_id === AG.id), 'powiadomienie: kierownik (ustawienia) i osoba rejestrująca – po jednym');
    ok(/za 30 dni: \[T6\] Anna Nowak/.test(notes[0].title) && notes[0].body.includes('T6/E31') && notes[0].body.includes('[T6] PZU') && notes[0].body.includes('OC/AC pojazdu') && notes[0].body.includes('zostało 30 dni'), 'treść: klient, numer, towarzystwo, rodzaj, data końca, ile dni zostało');
    // polisa odnowiona przed terminem przypomnienia – bez przypomnienia
    const RN = await mkP('T6/RN', day(25));
    const RN2 = await mkP('T6/RN-2', day(25 + 365), { start_date: day(26) });
    r = await call('polisy/' + RN.id + '/odnow', { nowa_polisa: RN2.id }, AG.c); eq(r.s, 200, 'odnowienie potwierdzone przez użytkownika');
    await P.tick(at(day(0)));
    eq((await R(RN.id)).length, 0, 'polisa odnowiona: brak przypomnienia');
    card = (await call('polisy/' + RN.id, null, AG.c)).j; ok(card.status === 'odnowiona' && card.renewed_by_number === 'T6/RN-2', 'status: odnowiona, z numerem nowej polisy');
    ok((await call('polisy/' + RN2.id, null, AG.c)).j.previous_number === 'T6/RN', 'nowa polisa wskazuje poprzednią');
    eq((await call('polisy/' + RN.id + '/odnow', { nowa_polisa: RN2.id }, AG.c)).s, 409, 'drugie odnowienie tej samej polisy odrzucone');
    const other = await mkP('T6/INNA', day(20), { customer_id: C2.id });
    eq((await call('polisy/' + other.id + '/odnow', { nowa_polisa: (await mkP('T6/INNA-2', day(400), { start_date: day(21) })).id }, AG.c)).s, 400, 'odnowienie polisą innego klienta odrzucone (klient ma inną polisę – nie wystarczy)');
    // polisa zakończona ręcznie i polisa po terminie – bez przypomnień
    const CL = await mkP('T6/CL', day(10));
    eq((await call('polisy/' + CL.id + '/zakoncz', {}, AG.c)).s, 400, 'zakończenie wymaga powodu');
    eq((await call('polisy/' + CL.id + '/zakoncz', { powod: 'klient sprzedał pojazd' }, AG.c)).s, 200, 'oznaczenie jako zakończona');
    const PAST = await mkP('T6/PAST', day(-1), { start_date: day(-365), signed_at: day(-365) });
    await P.tick(at(day(0)));
    ok((await R(CL.id)).length === 0 && (await R(PAST.id)).length === 0, 'zakończona i po terminie: brak przypomnień');
    ok((await call('polisy/' + CL.id, null, AG.c)).j.status === 'zakonczona' && (await call('polisy/' + PAST.id, null, AG.c)).j.status === 'zakonczona', 'status: zakończona (ręcznie i po dacie końca)');
    // nadrabianie po przerwie: termin przypomnienia minął 10 dni temu, ochrona trwa
    const LATE = await mkP('T6/LATE', day(20));
    await P.tick(at(day(0)));
    rem = await R(LATE.id); ok(rem.length === 1 && rem[0].days_left === 20 && D(rem[0].due_date) === day(-10), 'nadrobione po przerwie: przypomnienie z prawdziwą liczbą dni');
    // zmiana daty końca: nowe przypomnienie dla nowej daty, stare zostaje w historii
    await call('polisy/' + LATE.id, { end_date: day(25) }, AG.c, 'PATCH');
    await P.tick(at(day(0)));
    rem = await R(LATE.id); ok(rem.length === 2 && rem.some(x => x.days_left === 25), 'zmiana daty końca: przypomnienie dla nowej daty');
    // strefa czasowa i przełom roku
    eq(P.fmtDate(new Date('2026-03-29T22:30:00Z')), '2026-03-30', 'Europe/Warsaw: 22:30 UTC w czasie letnim to już następny dzień');
    eq(P.fmtDate(new Date('2026-12-31T23:30:00Z')), '2027-01-01', 'Europe/Warsaw: przełom roku');
    eq(P.fmtDate(new Date('2026-12-31T22:30:00Z')), '2026-12-31', 'Europe/Warsaw: przed północą lokalną');
    const YR = await mkP('T6/YEAR', '2031-01-15', { start_date: '2030-01-16', signed_at: '2030-01-10' });
    await P.tick(new Date('2030-12-15T22:59:00Z'));
    eq((await R(YR.id)).length, 0, 'przełom roku: 15.12 23:59 w Warszawie – jeszcze 31 dni, brak przypomnienia');
    await P.tick(new Date('2030-12-15T23:01:00Z'));
    rem = await R(YR.id); ok(rem.length === 1 && rem[0].days_left === 30 && D(rem[0].generated_on) === '2030-12-16', 'przełom roku: 16.12 00:01 w Warszawie – przypomnienie 30 dni przed 15.01');

    // ---------- lista do odnowienia, przypomnienia, pulpit, główny panel, dzwonek ----------
    r = await call('polisy/do-odnowienia', null, AG.c);
    ok(ids(r.j).includes(E31.id) === false && ids(r.j).includes(LATE.id) && ids(r.j).includes(PAST.id) && !ids(r.j).includes(RN.id) && !ids(r.j).includes(CL.id), 'do odnowienia: kończące się i świeżo zakończone bez odnowienia (bez odnowionych i zamkniętych ręcznie)');
    r = await call('polisy?konczy_dni=30', null, AG.c); ok(ids(r.j).includes(LATE.id) && r.j.every(p => p.status === 'konczy_sie'), 'filtr: kończące się w ciągu 30 dni');
    r = await call('polisy/przypomnienia?stan=nowe', null, SZ.c);
    const myRem = r.j.find(x => x.policy_id === E31.id); ok(myRem && myRem.customer_name === '[T6] Anna Nowak' && myRem.days_left === 30, 'historia przypomnień z danymi polisy');
    const bellBefore = (await call('powiadomienia/licznik', null, SZ.c)).j.nieprzeczytane;
    ok(bellBefore >= 1, 'dzwonek: licznik nieprzeczytanych u odbiorcy');
    r = await call('polisy/przypomnienia/' + myRem.id + '/obsluz', { notatka: 'klient umówiony na 5.12' }, SZ.c); eq(r.s, 200, 'przypomnienie obsłużone');
    eq((await call('polisy/przypomnienia/' + myRem.id + '/obsluz', {}, SZ.c)).s, 409, 'drugie oznaczenie odrzucone');
    ok((await call('powiadomienia/licznik', null, SZ.c)).j.nieprzeczytane < bellBefore, 'obsłużenie oznacza powiadomienie jako przeczytane');
    ok((await call('polisy/' + E31.id, null, AG.c)).j.events.some(e => e.kind === 'obsluga_przypomnienia' && e.note === 'klient umówiony na 5.12'), 'historia polisy: obsługa przypomnienia');
    r = await call('polisy/podsumowanie?towarzystwo=' + encodeURIComponent('[T6] PZU'), null, AG.c);
    ok(r.j.liczba >= 10 && r.j.kwota > r.j.zysk && r.j.konczy_30 >= 2 && r.j.srednia_kwota > 0 && r.j.srednia_marza > 0 && /nie jest przychodem MXT/.test(r.j.uwaga), 'pulpit: liczba, kwota, zysk, średnie, kończące się w 30 dni, uwaga o przychodzie');
    r = await call(`polisy/podsumowanie?od=${t0}&do=${t0}&rodzaj=` + encodeURIComponent('Firma / OC działalności'), null, AG.c);
    ok(r.j.liczba === 1 && r.j.kwota === 12000 && r.j.zysk === 1200, 'pulpit: filtr okresu i rodzaju');
    r = await call('command-center', null, AG.c); ok(r.j.alerts.some(a => /Polisy kończące się w ciągu 30 dni/.test(a.text)), 'główny panel: alert o kończących się polisach');

    // ---------- dokument polisy ----------
    const pdfB64 = Buffer.from('%PDF-1.4\n%T6\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
    r = await call('polisy/' + A.id + '/dokument', { plik: pdfB64, nazwa: 'polisa T6.pdf' }, AG.c); eq(r.s, 201, 'dokument polisy (PDF)');
    const dl = await fetch(`${base}/api/dokumenty/${r.j.document_id}/plik`, { headers: { Cookie: AG.c } });
    ok(dl.status === 200 && dl.headers.get('content-type') === 'application/pdf', 'pobranie dokumentu polisy');
    r = await call('polisy/' + A.id + '/dokument', { plik: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]).toString('base64'), nazwa: 'skan.jpg' }, AG.c); eq(r.j.version, 2, 'skan JPG jako nowa wersja');
    const dl2 = await fetch(`${base}/api/dokumenty/${r.j.document_id}/plik`, { headers: { Cookie: AG.c } });
    eq(dl2.headers.get('content-type'), 'image/jpeg', 'skan zwracany jako obraz');
    eq((await call('polisy/' + A.id + '/dokument', { plik: Buffer.from('<script>').toString('base64') }, AG.c)).s, 400, 'niedozwolony typ pliku odrzucony');

    // ---------- finanse: kwota polisy nie jest przychodem MXT ----------
    const finAfter = (await pool.query('SELECT count(*)::int n, coalesce(sum(amount_pln), 0)::float s FROM finance')).rows[0];
    ok(finAfter.n === finBefore.n && finAfter.s === finBefore.s, 'rejestracja polis nie tworzy przychodów w finansach (bez podwójnego liczenia)');
    const bad = await pool.query(`INSERT INTO finance (department_id, kind, amount, amount_pln) VALUES ('ubezpieczenia', 'przychod', 1, 1)`).catch(e => e);
    eq(bad.code, '23514', 'baza odrzuca wpis przychodu działu Ubezpieczenia w finansach');
    eq((await pool.query(`UPDATE policies SET profit = 1 WHERE id = $1`, [A.id]).catch(e => e)).code, '428C9', 'zysku nie da się nadpisać ręcznie (kolumna wyliczana)');

    console.log(`OK: testy ERP – ubezpieczenia przeszły (${passed} sprawdzeń)`);
  } catch (e) {
    console.error('BŁĄD:', e.message); process.exitCode = 1;
  } finally {
    const q = (sql, p) => pool.query(sql, p).catch(e => console.error('sprzątanie:', e.message.slice(0, 160)));
    await q(`UPDATE policies SET renewed_by = NULL, previous_id = NULL WHERE id = ANY($1::uuid[])`, [policies]);
    await q(`DELETE FROM notifications WHERE related_id = ANY($1::uuid[])`, [policies]);
    const docIds = (await pool.query(`SELECT document_id FROM policies WHERE id = ANY($1::uuid[]) AND document_id IS NOT NULL`, [policies]).catch(() => ({ rows: [] }))).rows.map(x => x.document_id);
    await q(`DELETE FROM policies WHERE id = ANY($1::uuid[])`, [policies]);
    await q(`DELETE FROM document_versions WHERE document_id = ANY($1::uuid[])`, [docIds]);
    await q(`DELETE FROM documents WHERE id = ANY($1::uuid[])`, [docIds]);
    await q(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [customers]);
    await q(`DELETE FROM scheduled_runs WHERE job = 'polisy_przypomnienia' AND run_date <> (now() AT TIME ZONE 'Europe/Warsaw')::date`);
    if (settingsBefore) await q(`UPDATE system_settings SET value = $1 WHERE key = 'insurance'`, [JSON.stringify(settingsBefore.value)]); else await q(`DELETE FROM system_settings WHERE key = 'insurance'`);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    srv.kill(); await pool.end();
  }
})();
