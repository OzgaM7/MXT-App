// Testy harmonogramu montaży: podsumowanie działu, import z Excela (szablon, podgląd z błędami i duplikatami, zapis, CSV),
// wczytanie z umowy / harmonogramu: tryb ręczny (bez AI), zapis kontraktu, obiektów, montaży i dokumentu, odczyt przez Claude
// (atrapa API: postać zapytania, propozycja, koszt), wyłącznik AI, odmowa modelu. Dane robocze z prefiksem [T8] są sprzątane na końcu.
'use strict';
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), assert = require('assert/strict'), path = require('path');
const ExcelJS = require('exceljs'), PDFDocument = require('pdfkit');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };
const T = '[T8]';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const day = n => { const d = new Date(today() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const pl = s => s.split('-').reverse().join('.');

// Odczyt przykładowego harmonogramu (zadanie nr 8 do umowy 244/2025) – tak, jak zwróciłby go model.
const EXTRACTED = { document_type: 'harmonogram', contract_number: '244/2025', task_number: '8', contract_date: '2025-06-30',
  client: { name: T + ' Apator POWOGAZ S.A.', tax_id: '7810020601', address: 'Jaryszki 1C, 62-023 Żerniki' },
  end_client: { name: T + ' Kujawska SM', city: 'Inowrocław' }, title: 'Wymiana podzielników kosztów – Kujawska SM, Inowrocław',
  scope: 'Wymiana podzielników kosztów zużycia ciepła w zasobach Kujawskiej SM w Inowrocławiu.', device_type: 'podzielnik', devices_total: 15000,
  units_residential: 15000, units_commercial: 0, start_date: '2026-11-05', end_date: '2027-01-30',
  rates: [{ description: 'lokal mieszkalny', unit_price_net: 8, unit: 'szt.', vat_pct: 8 }, { description: 'lokal użytkowy, garaż', unit_price_net: 8, unit: 'szt.', vat_pct: 23 }],
  value_net: 120000, locations: [], penalties: '20% wartości netto za odstąpienie; limit kar 40% wartości brutto.',
  obligations: 'Odpowiedzialność za dostarczone podzielniki do protokołu końcowego; rozliczenie wszystkich urządzeń; list przewozowy zwrotów.', notes: '', uncertain: '' };
let mockMode = 'ok';
const seen = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const body = JSON.parse(b || '{}'); seen.push({ headers: req.headers, body, url: req.url });
    const content = mockMode === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(EXTRACTED) }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_doc', type: 'message', role: 'assistant', model: body.model, content, stop_reason: mockMode === 'refusal' ? 'refusal' : 'end_turn',
      stop_details: mockMode === 'refusal' ? { type: 'refusal', category: null, explanation: 'test' } : null, usage: { input_tokens: 3000, output_tokens: 900 } }));
  });
});
const pdfBuf = () => new Promise(res => { const d = new PDFDocument(); const c = []; d.on('data', x => c.push(x)); d.on('end', () => res(Buffer.concat(c))); d.text('HARMONOGRAM DLA ZADANIA NR 8'); d.end(); });

(async () => {
  await new Promise(r => mock.listen(0, r));
  const P1 = 6300 + Math.floor(Math.random() * 100), P2 = P1 + 150;
  const start = (port, env) => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: port, WORKERS: '0', ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  const s1 = start(P1, { AI_MODE: 'test', ANTHROPIC_API_KEY: '', DOC_AI: '' });
  const s2 = start(P2, { AI_MODE: 'test', DOC_AI: 'live', ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'http://localhost:' + mock.address().port });
  const mk = base => async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.clone().json().catch(() => ({})), h: r.headers, buf: async () => Buffer.from(await r.arrayBuffer()), c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const call = mk('http://localhost:' + P1), live = mk('http://localhost:' + P2);
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [];
  try {
    for (const p of [P1, P2]) for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${p}/api/health`); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const A = (await call('login', { login: 'm.ozga', password: '1234' })).c, AL = (await live('login', { login: 'm.ozga', password: '1234' })).c;

    // ---------- podsumowanie działu (ekran startowy harmonogramu) ----------
    let r = await call('d1/podsumowanie', null, A);
    ok(Number.isInteger(r.j.trwajace) && Number.isInteger(r.j.bez_ekipy) && Number.isInteger(r.j.montaze_14d), 'kafelki: trwające, bez ekipy, 14 dni');

    // ---------- przygotowanie: ekipa z kontem montera, istniejący budynek i montaż ----------
    const crew = (await call('d1/ekipy', { name: T + ' Ekipa Import' }, A)).j;
    const inst = (await call('d1/instalatorzy', { name: T + ' Adam', crew_id: crew.id }, A)).j;
    const acc = (await call('konta', { login: 't8.monter', full_name: T + ' Adam', role: 'monter', installer_id: inst.id }, A)).j; users.push(acc.id);
    await pool.query(`UPDATE users SET must_change_password = false, password_hash = (SELECT password_hash FROM users WHERE login = 'm.ozga') WHERE id = $1`, [acc.id]);
    const M = (await call('login', { login: 't8.monter', password: '1234' })).c;
    const bOld = (await call('d1/budynki', { name: T + ' Blok Stary', address: 'ul. Stara 1', city: 'Toruń' }, A)).j;
    await call('d1/montaze', { building_id: bOld.id, planned_date: day(20) }, A);

    // ---------- szablon ----------
    r = await call('d1/import/szablon', null, A); eq(r.s, 200);
    let wb = new ExcelJS.Workbook(); await wb.xlsx.load(await r.buf());
    ok(wb.getWorksheet('Montaże').getRow(1).values.includes('Budynek') && wb.getWorksheet('Instrukcja'), 'szablon z arkuszem instrukcji');

    // ---------- import z Excela: podgląd ----------
    wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Lista');
    ws.addRow(['Harmonogram wymian – grudzień']);                                    // tytuł nad tabelą (nagłówki niżej)
    ws.addRow(['Nazwa budynku', 'Adres', 'Miasto', 'Data od', 'Data do', 'Ekipa', 'Liczba urządzeń', 'Zakres prac', 'Materiały']);
    ws.addRow([T + ' Blok Nowy A', 'ul. Nowa 5', 'Toruń', new Date(Date.UTC(2026, 11, 1)), new Date(Date.UTC(2026, 11, 2)), T + ' Ekipa Import', 120, 'Wymiana podzielników', 'Plomby 130; Adaptery 4']);
    ws.addRow([T + ' Blok Nowy A', 'ul. Nowa 5', 'Toruń', '03.12.2026', '', T + ' Ekipa Import', 40, 'Dokończenie klatki C', '']);
    ws.addRow([T + ' Blok Stary', '', '', day(20).split('-').reverse().join('.'), '', '', 10, '', '']);  // duplikat istniejącego montażu
    ws.addRow([T + ' Bez daty', 'ul. X 1', 'Toruń', '', '', '', 5, '', '']);
    ws.addRow([T + ' Zła data', 'ul. Y 2', 'Toruń', '31.02.2026', '', '', 5, '', '']);
    ws.addRow([T + ' Odwrotne', 'ul. Z 3', 'Toruń', '10.12.2026', '05.12.2026', '', 5, '', '']);
    ws.addRow([T + ' Obca ekipa', 'ul. W 4', 'Toruń', '11.12.2026', '', 'Nieznana ekipa', 'dużo', '', '']);
    ws.addRow([]);
    const xbuf = Buffer.from(await wb.xlsx.writeBuffer()), plik = xbuf.toString('base64');
    const before = (await pool.query('SELECT count(*)::int n FROM installations')).rows[0].n;
    r = await call('d1/import/excel', { plik, nazwa: 'harmonogram.xlsx' }, A); eq(r.s, 200);
    const rows = r.j.rows, st = n => rows.find(o => o.row === n);
    ok(r.j.columns.includes('Budynek') && r.j.columns.includes('Termin od') && r.j.columns.includes('Materiały'), 'rozpoznane nagłówki (synonimy, polskie znaki, wiersz tytułu)');
    ok(st(3).status === 'ok' && st(3).data.building.mode === 'nowy' && st(3).data.crew.name === T + ' Ekipa Import' && st(3).data.planned_date === '2026-12-01', 'wiersz z datą Excela');
    ok(st(3).data.materials.length === 2 && st(3).data.materials[0].ilosc === 130, 'materiały z tekstu');
    ok(st(4).status === 'ok' && st(4).data.planned_date === '2026-12-03', 'data DD.MM.RRRR');
    ok(st(5).status === 'duplikat', 'duplikat istniejącego montażu pominięty');
    ok(st(6).status === 'blad' && st(6).errors[0].includes('brak daty'), 'brak daty – błąd');
    ok(st(7).status === 'blad' && st(7).errors.some(e => e.includes('nieprawidłowa data')), 'nieistniejąca data – błąd');
    ok(st(8).status === 'blad' && st(8).errors.some(e => e.includes('wcześniejszy')), 'termin do przed terminem od – błąd');
    ok(st(9).status === 'blad' && st(9).errors.some(e => e.includes('liczba urządzeń')) && st(9).warnings.some(w => w.includes('nie istnieje')), 'błąd liczby i ostrzeżenie o ekipie');
    eq(r.j.summary.ok, 2); eq(r.j.summary.nowe_budynki, 1, 'jeden nowy budynek dla dwóch wierszy');
    eq((await pool.query('SELECT count(*)::int n FROM installations')).rows[0].n, before, 'podgląd niczego nie zapisuje');
    eq((await call('d1/import/excel', { plik, nazwa: 'x.xlsx' }, M)).s, 403, 'monter nie importuje');
    eq((await call('d1/import/excel', { plik: Buffer.from('a;b\n1;2').toString('base64'), nazwa: 'x.csv' }, A)).s, 400, 'bez wymaganych kolumn – 400');

    // ---------- import z Excela: zapis ----------
    r = await call('d1/import/excel', { plik, nazwa: 'harmonogram.xlsx', zatwierdz: true }, A);
    ok(r.s === 201 && r.j.utworzono === 2 && r.j.nowe_budynki === 1 && r.j.pominieto === 5, 'zapis: 2 montaże, 1 budynek, 5 pominiętych');
    const imported = (await pool.query(`SELECT i.*, b.name FROM installations i JOIN buildings b ON b.id = i.building_id WHERE b.name = $1 ORDER BY i.planned_date`, [T + ' Blok Nowy A'])).rows;
    ok(imported.length === 2 && imported[0].crew_id === crew.id && imported[0].devices_planned === 120 && imported[0].materials.length === 2, 'montaże w harmonogramie z ekipą i materiałami');
    const nn = (await pool.query(`SELECT * FROM notifications WHERE user_id = $1 AND created_at >= $2`, [acc.id, t0])).rows;
    ok(nn.length === 1 && nn[0].title === 'Nowe montaże w harmonogramie: 2', 'jedno zbiorcze powiadomienie dla ekipy');
    ok((await pool.query(`SELECT 1 FROM audit_logs WHERE ts >= $1 AND action = 'montaz.import_excel'`, [t0])).rows.length, 'import w rejestrze');
    eq((await call('d1/import/excel', { plik, nazwa: 'harmonogram.xlsx', zatwierdz: true }, A)).s, 400, 'ponowny import tego samego pliku – same duplikaty');
    // CSV (średnik, UTF-8 z BOM)
    const csv = '﻿Budynek;Adres;Miasto;Termin od;Liczba urządzeń\n"' + T + ' Blok CSV";"ul. Lipowa 3";Toruń;15.12.2026;24\n';
    r = await call('d1/import/excel', { plik: Buffer.from(csv).toString('base64'), nazwa: 'lista.csv' }, A);
    ok(r.s === 200 && r.j.summary.ok === 1 && r.j.rows[0].data.devices_planned === 24, 'CSV ze średnikiem');

    // ---------- umowa / harmonogram: tryb ręczny (bez AI) ----------
    const pdf = await pdfBuf();
    eq((await call('d1/import/dokument', { plik: Buffer.from('to nie jest dokument').toString('base64'), nazwa: 'x.txt' }, A)).s, 400, 'tylko PDF, JPG, PNG');
    r = await call('d1/import/dokument', { plik: pdf.toString('base64'), nazwa: 'harmonogram zadanie 8.pdf' }, A);
    ok(r.s === 201 && r.j.tryb === 'reczny' && r.j.uwaga.includes('DOC_AI') && r.j.propozycja === null, 'bez AI: formularz ręczny z wyjaśnieniem');
    const imp1 = r.j.id;
    const av = await call('d1/import/dokument/dostepnosc', null, A); ok(av.s === 200 && av.j.ai === false && av.j.powod.includes('ANTHROPIC_API_KEY'), 'dostępność: odczyt automatyczny wyłączony (okno mówi to z góry)');
    r = await call(`d1/import/dokument/${imp1}/plik`, null, A); ok((await r.buf()).subarray(0, 5).toString() === '%PDF-', 'podgląd dokumentu');
    const png = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon-192.png'));
    r = await call('d1/import/dokument', { plik: png.toString('base64'), nazwa: 'zdjecie umowy.png' }, A);
    ok(r.s === 201 && (await (await call(`d1/import/dokument/${r.j.id}/plik`, null, A)).buf()).subarray(0, 5).toString() === '%PDF-', 'zdjęcie zapisane jako PDF');
    eq((await call(`d1/import/dokument/${imp1}/zatwierdz`, {}, A)).s, 400, 'trzeba dodać montaż albo kontrakt');
    r = await call(`d1/import/dokument/${imp1}/zatwierdz`, {
      klient: { name: T + ' Apator POWOGAZ S.A.', tax_id: '781-002-06-01', address: 'Jaryszki 1C, 62-023 Żerniki' }, inwestor: { name: T + ' Kujawska SM', kind: 'spoldzielnia' },
      kontrakt: { utworz: true, title: T + ' Zadanie 8 – Kujawska SM', value_net: 120000, start_date: '2026-11-05', end_date: '2027-01-30', notes: 'Umowa nr 244/2025; stawka 8 zł netto/szt.' },
      obiekty: [{ name: T + ' Kujawska SM – zasoby', address: 'zasoby spółdzielni', city: 'Inowrocław', planned_date: '2026-11-05', planned_end: '2027-01-30', devices_planned: 15000, crew_id: crew.id, scope: 'Wymiana podzielników' }]
    }, A);
    eq(r.s, 201, 'zapis kontraktu i montażu'); const res1 = r.j;
    ok(/^KT\//.test(res1.project_number) && res1.installations.length === 1 && res1.document_id, 'kontrakt, montaż i dokument');
    const prj = (await pool.query(`SELECT p.*, c.name AS cname, c.tax_id FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.id = $1`, [res1.project_id])).rows[0];
    ok(prj.cname === T + ' Apator POWOGAZ S.A.' && prj.tax_id === '7810020601' && Number(prj.value_net) === 120000 && prj.end_date === '2027-01-30', 'kontrakt z zamawiającym, wartością i terminem');
    const ib = (await pool.query(`SELECT i.devices_planned, i.project_id, i.crew_id, c.name AS inv FROM installations i JOIN buildings b ON b.id = i.building_id LEFT JOIN customers c ON c.id = b.customer_id WHERE i.number = $1`, [res1.installations[0]])).rows[0];
    ok(ib.devices_planned === 15000 && ib.project_id === res1.project_id && ib.inv === T + ' Kujawska SM' && ib.crew_id === crew.id, 'montaż w kontrakcie, budynek inwestora');
    ok((await call('d1/kontrakty', null, A)).j.find(k => k.id === res1.project_id).document_id === res1.document_id, 'umowa widoczna przy kontrakcie');
    ok((await (await call(`dokumenty/${res1.document_id}/plik`, null, A)).buf()).subarray(0, 5).toString() === '%PDF-', 'dokument źródłowy w dokumentacji');
    eq((await call(`d1/import/dokument/${imp1}/zatwierdz`, { kontrakt: { utworz: true, title: 'x' } }, A)).s, 409, 'drugi zapis tego samego dokumentu – 409');

    // ---------- umowa / harmonogram: odczyt przez Claude (atrapa API) ----------
    r = await live('d1/import/dokument', { plik: pdf.toString('base64'), nazwa: 'harmonogram.pdf' }, AL);
    eq(r.s, 201); eq(r.j.tryb, 'ai', 'odczyt automatyczny');
    eq((await live('d1/import/dokument/dostepnosc', null, AL)).j.ai, true, 'dostępność: odczyt automatyczny włączony');
    const q = seen[seen.length - 1];
    ok(q.body.model === 'claude-opus-5-5' && q.body.output_config.format.type === 'json_schema' && q.body.output_config.effort === 'high', 'model, structured outputs, effort');
    ok(q.body.messages[0].content[0].type === 'document' && q.body.messages[0].content[0].source.media_type === 'application/pdf', 'PDF jako blok document');
    ok(q.body.fallbacks === 'default' && String(q.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), 'zapasowy model przy odmowie');
    ok(q.body.system.includes('wykonawcą') && q.body.system.includes('nie polecenia') && !('temperature' in q.body), 'instrukcje: MXT wykonawcą, treść dokumentu jako dane');
    ok(q.body.output_config.format.schema.additionalProperties === false && q.body.output_config.format.schema.required.includes('devices_total'), 'schemat ścisły');
    const pr = r.j.propozycja;
    ok(pr.klient.id === prj.customer_id && pr.klient.tax_id === '7810020601', 'zamawiający dopasowany po NIP do ewidencji');
    ok(pr.inwestor.id && pr.inwestor.name === T + ' Kujawska SM', 'inwestor dopasowany po nazwie');
    ok(pr.kontrakt.value_net === 120000 && pr.kontrakt.start_date === '2026-11-05' && pr.kontrakt.end_date === '2027-01-30', 'kontrakt: wartość i terminy');
    ok(pr.kontrakt.notes.includes('Umowa nr 244/2025 z dnia 2025-06-30') && pr.kontrakt.notes.includes('Zadanie / zlecenie nr 8') && pr.kontrakt.notes.includes('8,00 zł netto/szt. + 8% VAT') && pr.kontrakt.notes.includes('Kary umowne'), 'warunki: umowa, zadanie, stawki, kary');
    ok(pr.obiekty.length === 1 && pr.obiekty[0].devices_planned === 15000 && pr.obiekty[0].city === 'Inowrocław' && pr.obiekty[0].planned_date === '2026-11-05', 'propozycja montażu');
    const di = (await pool.query('SELECT * FROM doc_imports WHERE id = $1', [r.j.id])).rows[0];
    ok(di.mode === 'ai' && di.ai_usage.input_tokens === 3000 && Number(di.ai_cost_usd) > 0 && di.extracted.contract_number === '244/2025', 'zapisany odczyt, tokeny i koszt');
    r = await live('d1/import/dokument', { plik: png.toString('base64'), nazwa: 'zdjecie.png' }, AL);
    ok(r.j.tryb === 'ai' && seen[seen.length - 1].body.messages[0].content[0].type === 'image', 'zdjęcie jako blok image');
    // wyłącznik AI i odmowa modelu → formularz ręczny
    await pool.query(`UPDATE system_settings SET value = '{"stopped": true}' WHERE key = 'agents_stopped'`);
    const n0 = seen.length;
    r = await live('d1/import/dokument', { plik: pdf.toString('base64'), nazwa: 'a.pdf' }, AL);
    ok(r.j.tryb === 'reczny' && r.j.uwaga.includes('wyłącznikiem') && seen.length === n0, 'wyłącznik AI – bez wywołania modelu');
    eq((await live('d1/import/dokument/dostepnosc', null, AL)).j.ai, false, 'dostępność: wyłącznik AI');
    await pool.query(`UPDATE system_settings SET value = '{"stopped": false}' WHERE key = 'agents_stopped'`);
    mockMode = 'refusal';
    r = await live('d1/import/dokument', { plik: pdf.toString('base64'), nazwa: 'b.pdf' }, AL);
    ok(r.s === 201 && r.j.tryb === 'reczny' && r.j.uwaga.includes('odmówił'), 'odmowa modelu – formularz ręczny');
    mockMode = 'ok';

    console.log(`OK: testy harmonogramu i importów przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    const q = (s, p = []) => pool.query(s, p).catch(e => console.error('sprzątanie:', e.message));
    await q(`UPDATE system_settings SET value = '{"stopped": false}' WHERE key = 'agents_stopped'`);
    const blds = (await pool.query(`SELECT id FROM buildings WHERE name LIKE $1`, [T + '%'])).rows.map(x => x.id);
    const prjs = (await pool.query(`SELECT id FROM projects WHERE title LIKE $1`, [T + '%'])).rows.map(x => x.id);
    const insts = (await pool.query(`SELECT id FROM installations WHERE building_id = ANY($1::uuid[]) OR project_id = ANY($2::uuid[])`, [blds, prjs])).rows.map(x => x.id);
    await q(`DELETE FROM notifications WHERE created_at >= $1 AND (related_id = ANY($2::uuid[]) OR user_id = ANY($3::uuid[]))`, [t0, insts, users]);
    await q(`DELETE FROM documents WHERE (related_type = 'project' AND related_id = ANY($1::uuid[])) OR (related_type = 'installation' AND related_id = ANY($2::uuid[]))`, [prjs, insts]);
    await q(`DELETE FROM installations WHERE id = ANY($1::uuid[])`, [insts]);
    await q(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [prjs]);
    await q(`DELETE FROM buildings WHERE id = ANY($1::uuid[])`, [blds]);
    await q(`DELETE FROM customers WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM doc_imports WHERE created_at >= $1`, [t0]);
    await q(`DELETE FROM installers WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM crews WHERE name LIKE $1`, [T + '%']);
    await q(`DELETE FROM jobs WHERE kind = 'powiadomienie' AND created_at >= $1 AND status <> 'w_toku'`, [t0]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[]) OR created_at >= $2`, [users, t0]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    await pool.end(); s1.kill(); s2.kill(); mock.close();
  }
})();
