// Testy zleceń serwisowych: rola serwisanta, termin przydzielenia 14 dni (flagi oddzielne od statusu), przydział i powiadomienia,
// zasięg danych serwisanta, przejścia statusów, zdjęcia, protokół PDF z podpisem, zatwierdzanie, anulowanie, przypomnienia
// bez powtórzeń, zlecenie z reklamacji, eksport do Excela. Dane robocze z prefiksem [T6] i konta t6.* są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), fs = require('fs'), assert = require('assert/strict'), path = require('path');
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const S = require('../lib/service');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const T = '[T6]';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const day = n => { const d = new Date(today() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  const PORT = 5960 + Math.floor(Math.random() * 30), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.clone().json().catch(() => ({})), h: r.headers, buf: async () => Buffer.from(await r.arrayBuffer()), c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [], orders = [];
  const notes = async (uid, kind) => (await pool.query(`SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 AND created_at >= $3 ORDER BY id`, [uid, kind, t0])).rows;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const login = async (l, p = '1234') => call('login', { login: l, password: p });
    const A = (await login('m.ozga')).c, U = (await login('m.ozga1')).c;
    const uid = async l => (await pool.query('SELECT id FROM users WHERE login = $1', [l])).rows[0].id;
    // Konta: dwóch serwisantów i kierownik (hasło jak konta startowe, bez wymuszonej zmiany – tylko na czas testu).
    const mk = async (name, role, extra = []) => {
      const r = await call('konta', { login: name, full_name: T + ' ' + name, role, extra_roles: extra }, A);
      eq(r.s, 201, 'konto ' + name); users.push(r.j.id);
      await pool.query(`UPDATE users SET must_change_password = false, password_hash = (SELECT password_hash FROM users WHERE login = 'm.ozga') WHERE id = $1`, [r.j.id]);
      return { id: r.j.id, c: (await login(name)).c };
    };
    const s1 = await mk('t6.serw1', 'serwisant'), s2 = await mk('t6.serw2', 'serwisant'), K = await mk('t6.kier', 'kierownik');
    let r = await call('me', null, s1.c);
    ok(r.j.permissions.includes('service.own') && !r.j.permissions.includes('departments.view') && !r.j.permissions.includes('service.manage'), 'serwisant: tylko własne zlecenia');
    ok((await call('me', null, K.c)).j.permissions.includes('service.approve'), 'kierownik zatwierdza serwisy');

    // ---------- przyjęcie zlecenia, termin 14 dni ----------
    const base1 = { client_name: T + ' Anna Kowalska', address: 'ul. Lipowa 5', unit: '12', city: 'Zielona Góra', contact_name: 'Anna Kowalska', contact_phone: '600 200 300',
      description: 'Podzielnik w kuchni nie wyświetla odczytu.', due_date: day(10) };
    eq((await call('serwisy', { ...base1, description: '' }, A)).s, 400, 'opis wymagany');
    eq((await call('serwisy', { ...base1, address: '' }, A)).s, 400, 'adres wymagany');
    eq((await call('serwisy', { ...base1, received_at: day(2) }, A)).s, 400, 'data otrzymania nie z przyszłości');
    eq((await call('serwisy', base1, s1.c)).s, 403, 'serwisant nie przyjmuje zleceń');
    r = await call('serwisy', { ...base1, received_at: day(-11) }, U); eq(r.s, 201, 'pracownik biura przyjmuje zlecenie');
    const o1 = r.j; orders.push(o1.id);
    ok(/^SR\/\d{4}\/\d{3,}$/.test(o1.number), 'numer SR/rok/nr'); eq(o1.status, 'oczekuje');
    eq(o1.assign_due, day(3), 'termin przydziału = otrzymano + 14 dni kalendarzowych'); eq(o1.due_date, day(10), 'termin realizacji osobno');
    r = await call('serwisy', { ...base1, client_name: T + ' Po terminie', received_at: day(-20), priority: 'wysoki', zweryfikowane: false }, A); eq(r.s, 201);
    const o2 = r.j; orders.push(o2.id); eq(o2.status, 'nowe', 'zgłoszenie do weryfikacji');
    let list = (await call('serwisy?widok=nieprzypisane', null, A)).j;
    const L1 = list.find(x => x.id === o1.id), L2 = list.find(x => x.id === o2.id);
    ok(L1 && L1.dni_do_przydzialu === 3 && L1.przydzial_wkrotce && !L1.po_terminie_przydzialu, 'flaga: zbliża się termin przydziału');
    ok(L2 && L2.po_terminie_przydzialu && L2.pilne && L2.status === 'nowe', 'po terminie przydziału – flaga, status bez zmian');
    ok((await call('serwisy?widok=po_terminie', null, A)).j.some(x => x.id === o2.id) && !(await call('serwisy?widok=po_terminie', null, A)).j.some(x => x.id === o1.id), 'widok „po terminie”');
    r = await call('serwisy/podsumowanie', null, A); ok(r.j.nieprzypisane >= 2 && r.j.po_terminie_przydzialu >= 1 && r.j.termin_przydzialu_dni === 14, 'podsumowanie');
    eq((await call(`serwisy/${o2.id}/weryfikacja`, {}, A)).j.status, 'oczekuje', 'weryfikacja zgłoszenia');

    // ---------- przypomnienia o terminie przydziału (bez powtórzeń) ----------
    await S.reminders();
    let kr = (await notes(K.id, 'serwis.termin_przydzialu')).filter(n => [o1.id, o2.id].includes(n.related_id));
    ok(kr.length === 2 && kr.some(n => n.title.includes('Za 3 dni') && n.related_id === o1.id) && kr.some(n => n.title.startsWith('Po terminie przydziału') && n.related_id === o2.id), 'przypomnienia do kierownika');
    ok(kr[0].link.startsWith('/dzial/podzielniki-i-montaze?tab=serwisy&z='), 'link do karty w dziale');
    ok((await notes(s1.id, 'serwis.termin_przydzialu')).length === 0, 'serwisant nie dostaje przypomnień o przydziale');
    await S.reminders();
    eq((await notes(K.id, 'serwis.termin_przydzialu')).filter(n => [o1.id, o2.id].includes(n.related_id)).length, 2, 'ponowne uruchomienie – bez duplikatów');

    // ---------- przydział i powiadomienia ----------
    eq((await call(`serwisy/${o1.id}/przydziel`, { assigned_to: await uid('m.ozga1') }, A)).s, 400, 'przydział tylko do serwisanta');
    r = await call(`serwisy/${o1.id}/przydziel`, { assigned_to: s1.id }, A); eq(r.s, 200); eq(r.j.status, 'przypisane');
    let n1 = await notes(s1.id, 'serwis.przydzial');
    ok(n1.length === 1 && n1[0].title.includes(o1.number) && n1[0].body.includes('Lipowa 5') && n1[0].link === '/moje-serwisy?z=' + o1.id, 'serwisant: powiadomienie o przydziale');
    r = await call(`serwisy/${o1.id}/przydziel`, { assigned_to: s2.id, planned_date: day(1) }, A); eq(r.j.status, 'zaplanowane', 'przydział z terminem wizyty');
    ok((await notes(s1.id, 'serwis.odwolanie')).length === 1 && (await notes(s2.id, 'serwis.przydzial')).length === 1, 'przekazanie innemu serwisantowi');
    await call(`serwisy/${o1.id}/przydziel`, { assigned_to: s1.id }, A);
    const ev = (await pool.query(`SELECT data FROM service_events WHERE order_id = $1 AND kind = 'przydzial' ORDER BY id LIMIT 1`, [o1.id])).rows[0];
    eq(ev.data.w_terminie, true, 'historia: przydział w terminie');

    // ---------- zasięg danych serwisanta ----------
    ok((await call('moje/serwisy', null, s1.c)).j.some(x => x.id === o1.id) && !(await call('moje/serwisy', null, s2.c)).j.some(x => x.id === o1.id), 'serwisant widzi tylko swoje zlecenia');
    eq((await call('moje/serwisy/' + o1.id, null, s2.c)).s, 404, 'cudze zlecenie – 404');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'w_realizacji' }, s2.c)).s, 404, 'cudze zlecenie – bez zmian statusu');
    ok((await pool.query(`SELECT 1 FROM audit_logs WHERE ts >= $1 AND action = 'odmowa_dostepu' AND resource_id = $2`, [t0, o1.id])).rows.length, 'próba w rejestrze');
    r = await call('moje/serwisy/' + o1.id, null, s1.c); eq(r.s, 200); ok(r.j.contact_phone === '600 200 300' && Array.isArray(r.j.events) && !('signature_png' in r.j), 'karta serwisanta: kontakt, historia');
    for (const p of ['serwisy', 'serwisy/podsumowanie', 'd1/budynki', 'finanse', 'konta', 'eksport/d1/serwisy', 'moje/montaze'])
      eq((await call(p, null, s1.c)).s, 403, `serwisant → /api/${p} = 403`);

    // ---------- przejścia statusów (serwisant) ----------
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'zatwierdzone' }, s1.c)).s, 409, 'serwisant nie zatwierdza');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'anulowane' }, s1.c)).s, 409, 'serwisant nie anuluje');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'zaplanowane' }, s1.c)).s, 400, 'termin wizyty wymagany');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'zaplanowane', planned_date: day(2) }, s1.c)).j.status, 'zaplanowane');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'w_realizacji' }, s1.c)).j.status, 'w_realizacji');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'ponowna_wizyta' }, s1.c)).s, 400, 'ponowna wizyta wymaga opisu');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'ponowna_wizyta', notatka: 'Brak dostępu do lokalu', planned_date: day(4) }, s1.c)).j.status, 'ponowna_wizyta');
    ok((await notes(K.id, 'serwis.ponowna_wizyta')).some(n => n.body.includes('Brak dostępu')), 'kierownik wie o ponownej wizycie');
    eq((await call(`moje/serwisy/${o1.id}/status`, { status: 'w_realizacji' }, s1.c)).j.status, 'w_realizacji');
    eq((await call(`moje/serwisy/${o1.id}/notatka`, { notatka: 'Wymieniono baterię', czynnosc: true }, s1.c)).s, 201, 'czynność w historii');

    // ---------- zdjęcia ----------
    const png = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon-192.png'));
    eq((await call(`moje/serwisy/${o1.id}/zdjecia`, { data: Buffer.from('to nie jest obraz').toString('base64') }, s1.c)).s, 400, 'tylko obrazy');
    r = await call(`moje/serwisy/${o1.id}/zdjecia`, { data: 'data:image/png;base64,' + png.toString('base64'), podpis: 'Podzielnik przed wymianą' }, s1.c);
    eq(r.s, 201); const pid = r.j.id; eq(r.j.mime, 'image/png');
    r = await call(`moje/serwisy/${o1.id}/zdjecia/${pid}`, null, s1.c); eq(r.s, 200); ok((await r.buf()).equals(png), 'zdjęcie bez zmian');
    eq((await call(`moje/serwisy/${o1.id}/zdjecia/${pid}`, null, s2.c)).s, 404, 'cudze zdjęcie – 404');
    eq((await call(`serwisy/${o1.id}/zdjecia/${pid}`, null, A)).s, 200, 'biuro widzi zdjęcia');

    // ---------- protokół z podpisem ----------
    eq((await call(`moje/serwisy/${o1.id}/protokol`, { czynnosci: '' }, s1.c)).s, 400, 'czynności wymagane');
    eq((await call(`moje/serwisy/${o1.id}/protokol`, { czynnosci: 'Wymiana', podpis: 'data:image/png;base64,AAAA', potwierdzajacy: 'X' }, s1.c)).s, 400, 'podpis – walidacja');
    eq((await call(`moje/serwisy/${o1.id}/protokol`, { czynnosci: 'Wymiana', podpis: 'data:image/png;base64,' + png.toString('base64') }, s1.c)).s, 400, 'podpis wymaga nazwiska');
    r = await call(`moje/serwisy/${o1.id}/protokol`, { czynnosci: 'Wymieniono baterię i plombę podzielnika, sprawdzono odczyt.', uzyte: 'Bateria 3,6 V – 1 szt.', uwagi: 'Lokator obecny',
      potwierdzajacy: 'Anna Kowalska', podpis: 'data:image/png;base64,' + png.toString('base64') }, s1.c);
    eq(r.s, 201); eq(r.j.status, 'wykonane'); ok(/^PS\//.test(r.j.number), 'numer protokołu PS/…');
    r = await call(`moje/serwisy/${o1.id}/protokol`, null, s1.c); eq(r.s, 200); ok((await r.buf()).subarray(0, 5).toString() === '%PDF-', 'protokół PDF');
    const doc = (await pool.query(`SELECT d.kind, d.department_id, v.file_size FROM service_orders o JOIN documents d ON d.id = o.protocol_document_id
      JOIN document_versions v ON v.document_id = d.id WHERE o.id = $1`, [o1.id])).rows[0];
    ok(doc && doc.kind === 'protokol' && doc.department_id === 'podzielniki-i-montaze' && doc.file_size > 1000, 'protokół w dokumentach działu');
    ok((await notes(K.id, 'serwis.do_zatwierdzenia')).some(n => n.related_id === o1.id && n.body.includes('Anna Kowalska')), 'kierownik: do zatwierdzenia');
    ok(!(await call('moje/serwisy', null, s1.c)).j.some(x => x.id === o1.id) && (await call('moje/serwisy?zakres=zakonczone', null, s1.c)).j.some(x => x.id === o1.id), 'wykonane w zakładce zakończonych');

    // ---------- zatwierdzenie i zamknięcie ----------
    eq((await call(`serwisy/${o1.id}/zatwierdz`, {}, U)).s, 403, 'pracownik biura nie zatwierdza');
    r = await call(`serwisy/${o1.id}/zatwierdz`, {}, K.c); eq(r.s, 200); eq(r.j.status, 'zatwierdzone');
    eq((await call('serwisy/' + o1.id, { description: 'zmiana po zatwierdzeniu' }, A, 'PATCH')).s, 409, 'zatwierdzone – bez edycji');
    eq((await call(`serwisy/${o1.id}/anuluj`, { powod: 'x' }, A)).s, 409, 'zatwierdzonego nie anuluje się');
    r = await call('serwisy/' + o1.id, null, A);
    ok(r.j.events.map(e => e.to_status).filter(Boolean).join(',').includes('przypisane') && r.j.events.some(e => e.kind === 'protokol' || e.to_status === 'wykonane') && r.j.photos.length === 1, 'pełna historia w karcie');

    // ---------- anulowanie ----------
    await call(`serwisy/${o2.id}/przydziel`, { assigned_to: s2.id }, A);
    eq((await call(`serwisy/${o2.id}/anuluj`, {}, A)).s, 400, 'powód anulowania wymagany');
    r = await call(`serwisy/${o2.id}/anuluj`, { powod: 'Klient wycofał zgłoszenie' }, A); eq(r.j.status, 'anulowane');
    ok((await notes(s2.id, 'serwis.anulowanie')).some(n => n.related_id === o2.id), 'serwisant wie o anulowaniu');

    // ---------- termin realizacji: przypomnienia ----------
    r = await call('serwisy', { ...base1, client_name: T + ' Termin', due_date: day(1), assigned_to: s1.id }, A); const o3 = r.j; orders.push(o3.id);
    eq(o3.status, 'przypisane', 'przyjęcie z od razu przydzielonym serwisantem');
    await S.reminders(); await S.reminders();
    eq((await notes(s1.id, 'serwis.termin_realizacji')).filter(n => n.related_id === o3.id).length, 1, 'przypomnienie o terminie realizacji (raz)');
    await pool.query('UPDATE service_orders SET due_date = $2 WHERE id = $1', [o3.id, day(-1)]);
    await S.reminders(); await S.reminders();
    ok((await notes(s1.id, 'serwis.po_terminie')).filter(n => n.related_id === o3.id).length === 1 && (await notes(K.id, 'serwis.po_terminie')).filter(n => n.related_id === o3.id).length === 1, 'po terminie realizacji: serwisant i kierownik, bez powtórzeń');
    r = (await call('serwisy?widok=po_terminie', null, A)).j.find(x => x.id === o3.id); ok(r && r.po_terminie_realizacji && r.status === 'przypisane', 'przekroczenie terminu nie zmienia statusu');
    r = await call(`serwisy/${o3.id}/termin`, { planned_date: day(0) }, A); eq(r.j.status, 'zaplanowane');
    ok((await notes(s1.id, 'serwis.zmiana_terminu')).some(n => n.related_id === o3.id), 'zmiana terminu wizyty → powiadomienie');
    await call(`moje/serwisy/${o3.id}/status`, { status: 'w_realizacji' }, s1.c);
    await call(`moje/serwisy/${o3.id}/protokol`, { czynnosci: 'Kontrola' }, s1.c);
    r = await call(`serwisy/${o3.id}/do-poprawy`, { powod: 'Uzupełnij numer podzielnika' }, A); eq(r.j.status, 'w_realizacji', 'cofnięcie do poprawy');
    ok((await notes(s1.id, 'serwis.do_poprawy')).length === 1, 'serwisant wie o poprawce');

    // ---------- zlecenie z reklamacji ----------
    const bld = (await call('d1/budynki', { name: T + ' Blok', address: 'ul. Klonowa 9', city: 'Nowa Sól', potwierdz_duplikat: true }, A)).j;
    const cpl = (await call('reklamacje', { department_id: 'podzielniki-i-montaze', title: T + ' Zawyżone odczyty', building_id: bld.id }, A)).j;
    ok((await call('serwisy/reklamacje', null, A)).j.some(k => k.id === cpl.id), 'otwarte reklamacje do powiązania');
    r = await call('serwisy', { complaint_id: cpl.id, description: 'Sprawdzić podzielniki w lokalu 4', unit: '4' }, A);
    eq(r.s, 201); orders.push(r.j.id); ok(r.j.address === 'ul. Klonowa 9' && r.j.city === 'Nowa Sól' && r.j.building_id === bld.id, 'adres z budynku reklamacji');
    ok((await call('serwisy/' + r.j.id, null, A)).j.complaint.number === cpl.number, 'karta pokazuje reklamację');

    // ---------- eksport do Excela ----------
    r = await call('eksport/d1/serwisy?od=' + day(-30), null, A); eq(r.s, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await r.buf());
    const ws = wb.getWorksheet('Serwisy'), head = ws.getRow(1).values;
    const row = ws.getRows(2, ws.rowCount - 1).find(x => x.getCell(1).value === o1.number);
    ok(head.includes('Termin przydziału') && head.includes('Przydział w terminie') && row && row.getCell(5).value === 'tak' && row.getCell(11).value === 'Zatwierdzone', 'eksport serwisów');

    console.log(`OK: testy zleceń serwisowych przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    const q = (s, p = []) => pool.query(s, p).catch(e => console.error('sprzątanie:', e.message));
    const ids = (await pool.query(`SELECT id, protocol_document_id FROM service_orders WHERE client_name LIKE $1 OR id = ANY($2::uuid[])`, [T + '%', orders])).rows;
    await q(`DELETE FROM notifications WHERE created_at >= $1 AND (related_id = ANY($2::uuid[]) OR user_id = ANY($3::uuid[]))`, [t0, ids.map(x => x.id), users]);
    await q(`DELETE FROM service_orders WHERE id = ANY($1::uuid[])`, [ids.map(x => x.id)]);
    await q(`DELETE FROM documents WHERE id = ANY($1::uuid[])`, [ids.map(x => x.protocol_document_id).filter(Boolean)]);
    await q(`DELETE FROM complaints WHERE title LIKE $1`, [T + '%']);
    await q(`DELETE FROM buildings WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM jobs WHERE kind = 'powiadomienie' AND created_at >= $1 AND status <> 'w_toku'`, [t0]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[]) OR created_at >= $2`, [users, t0]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    await pool.end(); srv.kill();
  }
})();
