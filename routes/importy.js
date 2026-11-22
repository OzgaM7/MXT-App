'use strict';
// Harmonogram montaży – import z Excela (szablon, podgląd z walidacją, zapis) i wczytanie z umowy / harmonogramu (PDF, skan, zdjęcie).
// Montowane pod /api/d1/import (uprawnienie tasks.use – role biurowe). Dane z pliku są zawsze sprawdzane przed zapisem.
const express = require('express'), crypto = require('crypto');
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/rbac');
const docs = require('../lib/docs');
const xlsx = require('../lib/xlsx');
const docread = require('../lib/docread');
const { notify } = require('../lib/notify');
const { usersOfCrew } = require('../lib/scope');
const { wrap, idParam, V, bad, sendPdf } = require('./_util');

const r = express.Router();
const use = requirePerm('tasks.use');
const DEP = 'podzielniki-i-montaze';

// ---------- wspólne: plik z przeglądarki (base64) ----------
function fileOf(b, max) {
  const s = String((b || {}).plik || '').replace(/^data:[^;]+;base64,/, '');
  if (!s) throw bad(400, 'Wybierz plik.');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) throw bad(400, 'Nieprawidłowy plik.');
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) throw bad(400, 'Plik jest pusty.');
  if (buf.length > max) throw bad(413, `Plik jest za duży (maks. ${Math.round(max / 1024 / 1024)} MB).`);
  return buf;
}
const fileName = b => V.str((b || {}).nazwa, 200) || 'plik';

// Powiadomienie ekip o nowych montażach (jedno zbiorcze na ekipę, nie po jednym na montaż).
async function notifyCrews(client, created) {
  const byCrew = {};
  for (const x of created) if (x.crew_id) (byCrew[x.crew_id] = byCrew[x.crew_id] || []).push(x);
  for (const [crew, xs] of Object.entries(byCrew)) {
    const users = await usersOfCrew(crew, client);
    if (!users.length) continue;
    const dates = xs.map(x => x.planned_date).sort();
    await notify(users, { kind: 'montaz.przydzial', title: xs.length === 1 ? `Nowy montaż ${xs[0].number}` : `Nowe montaże w harmonogramie: ${xs.length}`,
      body: `${xs.slice(0, 3).map(x => x.number + ' – ' + x.building_name).join('; ')}${xs.length > 3 ? ` i ${xs.length - 3} więcej` : ''} · od ${dates[0].split('-').reverse().join('.')}`,
      link: xs.length === 1 ? '/moje-montaze?m=' + xs[0].id : '/moje-montaze', related_type: 'installation', related_id: xs[0].id }, { client });
  }
}

// =============== import z Excela ===============
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// Nazwy kolumn (bez wielkości liter i polskich znaków) – szablon MXT i typowe nagłówki z innych arkuszy.
const COLS = {
  name: ['budynek', 'nazwa budynku', 'obiekt', 'nazwa obiektu', 'nazwa', 'wspolnota'],
  address: ['adres', 'ulica', 'adres budynku', 'adres obiektu'],
  city: ['miasto', 'miejscowosc'],
  postal_code: ['kod', 'kod pocztowy'],
  units_count: ['lokale', 'liczba lokali', 'ilosc lokali'],
  planned_date: ['termin od', 'data od', 'od', 'data rozpoczecia', 'rozpoczecie', 'start', 'termin', 'data montazu', 'data'],
  planned_end: ['termin do', 'data do', 'do', 'data zakonczenia', 'zakonczenie', 'koniec'],
  crew: ['ekipa', 'brygada', 'zespol'],
  devices_planned: ['liczba urzadzen', 'urzadzenia', 'ilosc urzadzen', 'podzielniki', 'liczba podzielnikow', 'ilosc podzielnikow', 'ilosc', 'liczba'],
  scope: ['zakres', 'zakres prac', 'opis', 'opis prac', 'prace'],
  project: ['kontrakt', 'umowa', 'nr umowy', 'numer umowy', 'numer kontraktu'],
  materials: ['materialy', 'lista materialow', 'material'],
  notes: ['uwagi', 'notatki', 'komentarz']
};
const LABELS = { name: 'Budynek', address: 'Adres', city: 'Miasto', postal_code: 'Kod pocztowy', units_count: 'Liczba lokali', planned_date: 'Termin od', planned_end: 'Termin do',
  crew: 'Ekipa', devices_planned: 'Liczba urządzeń', scope: 'Zakres prac', project: 'Kontrakt', materials: 'Materiały', notes: 'Uwagi' };

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    return '';
  }
  return v;
}
// Data z komórki: data Excela, liczba seryjna, „DD.MM.RRRR”, „RRRR-MM-DD”, „DD/MM/RRRR”.
function dateOf(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return isNaN(v) ? undefined : `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) return dateOf(new Date(Math.round((v - 25569) * 864e5)));
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return valid(m[3], m[2], m[1]);
  return undefined;
}
function valid(y, mo, d) {
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d ? dt.toISOString().slice(0, 10) : undefined;
}
// CSV (separator ; lub ,; cudzysłowy), kodowanie UTF-8 albo Windows-1250 (Excel w polskiej wersji).
function csvRows(buf) {
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1250').decode(buf);
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function sheetRows(buf) {
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') return csvRows(buf);   // XLSX to archiwum ZIP
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { throw bad(400, 'Nie udało się odczytać pliku Excel. Zapisz go jako .xlsx albo .csv.'); }
  // Arkusz „Montaże” z szablonu albo pierwszy arkusz z danymi.
  const ws = wb.getWorksheet('Montaże') || wb.worksheets.find(w => w.rowCount > 1) || wb.worksheets[0];
  if (!ws) throw bad(400, 'Plik nie zawiera arkusza.');
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => { const vals = []; row.eachCell({ includeEmpty: true }, (c, i) => { vals[i - 1] = cellText(c.value); }); rows[n - 1] = vals; });
  return Array.from(rows, x => x || []);
}
function mapHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const map = {};
    (rows[i] || []).forEach((h, j) => { const n = norm(h instanceof Date ? '' : h); for (const [k, names] of Object.entries(COLS)) if (!(k in map) && names.includes(n)) map[k] = j; });
    if (Object.keys(map).length >= 2 && ('planned_date' in map) && ('name' in map || 'address' in map)) return { row: i, map };
  }
  return null;
}

async function analyse(buf) {
  const rows = await sheetRows(buf);
  const head = mapHeader(rows);
  if (!head) throw bad(400, 'Nie znaleziono nagłówków. Wymagane kolumny: „Budynek” lub „Adres” oraz „Termin od” – pobierz szablon i skopiuj do niego dane.');
  const data = rows.slice(head.row + 1).map((r, i) => ({ excelRow: head.row + i + 2, r })).filter(x => x.r.some(v => String(v == null ? '' : v).trim() !== ''));
  if (data.length > 2000) throw bad(400, 'Najwyżej 2000 wierszy w jednym imporcie.');
  const [bld, crews, prj] = await Promise.all([
    pool.query('SELECT id, name, address, city FROM buildings'), pool.query('SELECT id, name FROM crews WHERE is_active'),
    pool.query(`SELECT id, number, title FROM projects WHERE department_id = $1 AND status NOT IN ('anulowany','rozliczony')`, [DEP])
  ]);
  const get = (r, k) => head.map[k] === undefined ? '' : r[head.map[k]];
  const txt = (r, k, max) => { const v = get(r, k); return (v instanceof Date ? '' : String(v == null ? '' : v)).trim().slice(0, max); };
  const out = [];
  for (const { excelRow, r } of data) {
    const e = [], w = [];
    const row = { name: txt(r, 'name', 200), address: txt(r, 'address', 300), city: txt(r, 'city', 100), postal_code: txt(r, 'postal_code', 10), scope: txt(r, 'scope', 4000), notes: txt(r, 'notes', 4000) };
    const units = txt(r, 'units_count', 20), devs = txt(r, 'devices_planned', 20);
    row.units_count = units ? Number(units.replace(/\s/g, '').replace(',', '.')) : 0;
    row.devices_planned = devs ? Number(devs.replace(/\s/g, '').replace(',', '.')) : 0;
    if (!Number.isInteger(row.units_count) || row.units_count < 0) { e.push('liczba lokali musi być liczbą całkowitą'); row.units_count = 0; }
    if (!Number.isInteger(row.devices_planned) || row.devices_planned < 0) { e.push('liczba urządzeń musi być liczbą całkowitą'); row.devices_planned = 0; }
    row.planned_date = dateOf(get(r, 'planned_date')); row.planned_end = dateOf(get(r, 'planned_end'));
    if (!row.planned_date) e.push(row.planned_date === undefined ? 'nieprawidłowa data „Termin od” (użyj DD.MM.RRRR)' : 'brak daty „Termin od”');
    if (row.planned_end === undefined) e.push('nieprawidłowa data „Termin do”');
    if (row.planned_date && row.planned_end && row.planned_end < row.planned_date) e.push('„Termin do” jest wcześniejszy niż „Termin od”');
    row.materials = txt(r, 'materials', 2000).split(/[;\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 50).map(s => {
      const m = s.match(/^(.*?)[\s:–-]+(\d+(?:[.,]\d+)?)\s*([a-ząćęłńóśźż.]*)$/i);
      return m ? { nazwa: m[1].trim().slice(0, 200), ilosc: Number(m[2].replace(',', '.')), jm: m[3] || 'szt.' } : { nazwa: s.slice(0, 200), ilosc: 1, jm: 'szt.' };
    });
    // Budynek: istniejący (nazwa albo adres + miasto) albo nowy (jeden na całą listę, nawet gdy występuje w kilku wierszach).
    const b = bld.rows.find(x => row.name && norm(x.name) === norm(row.name)) || bld.rows.find(x => row.address && norm(x.address) === norm(row.address) && (!row.city || norm(x.city) === norm(row.city)));
    if (b) row.building = { mode: 'istniejacy', id: b.id, label: `${b.name}, ${b.address}` };
    else if (!row.address) e.push('brak adresu nowego budynku');
    else {
      const key = norm(row.name || row.address) + '|' + norm(row.address) + '|' + norm(row.city);
      row.building = { mode: 'nowy', key, label: `${row.name || row.address}, ${row.address}${row.city ? ', ' + row.city : ''}` };
    }
    const crewName = txt(r, 'crew', 100);
    if (crewName) {
      const c = crews.rows.find(x => norm(x.name) === norm(crewName));
      if (c) row.crew = { id: c.id, name: c.name }; else w.push(`ekipa „${crewName}” nie istnieje – montaż bez ekipy`);
    }
    const prjName = txt(r, 'project', 100);
    if (prjName) {
      const p = prj.rows.find(x => norm(x.number) === norm(prjName) || norm(x.title) === norm(prjName));
      if (p) row.project = { id: p.id, number: p.number }; else w.push(`kontrakt „${prjName}” nie znaleziony – montaż bez kontraktu`);
    }
    out.push({ row: excelRow, data: row, errors: e, warnings: w, status: e.length ? 'blad' : 'ok' });
  }
  // Możliwe duplikaty: ten sam budynek i ten sam termin już w harmonogramie (ponowny import tego samego pliku).
  const ex = await pool.query(`SELECT building_id, planned_date FROM installations WHERE status <> 'anulowany'`);
  const seen = new Set(ex.rows.map(x => x.building_id + '|' + x.planned_date));
  for (const o of out) if (o.status === 'ok' && o.data.building.mode === 'istniejacy' && seen.has(o.data.building.id + '|' + o.data.planned_date)) {
    o.status = 'duplikat'; o.warnings.push('ten budynek ma już montaż w tym terminie – wiersz zostanie pominięty');
  }
  return { rows: out, columns: Object.keys(head.map).map(k => LABELS[k]), missing: Object.keys(COLS).filter(k => !(k in head.map)).map(k => LABELS[k]),
    summary: { wiersze: out.length, ok: out.filter(o => o.status === 'ok').length, bledy: out.filter(o => o.status === 'blad').length,
      duplikaty: out.filter(o => o.status === 'duplikat').length,
      nowe_budynki: new Set(out.filter(o => o.status === 'ok' && o.data.building.mode === 'nowy').map(o => o.data.building.key)).size } };
}

// Czy automatyczny odczyt dokumentów jest włączony – okno „Wczytaj z umowy” mówi z góry, czy dane wypełnią się same.
r.get('/dokument/dostepnosc', use, wrap(async (req, res) => res.json(await docread.availability())));

r.get('/szablon', use, wrap(async (req, res) => {
  const ex = [{ name: 'SM Słoneczna, blok 7', address: 'ul. Słoneczna 7', city: 'Zielona Góra', postal_code: '65-001', units_count: 60, planned_date: '2026-12-01', planned_end: '2026-12-03',
    crew: 'Ekipa 1 – Warszawa', devices_planned: 240, scope: 'Wymiana podzielników na radiowe', project: '', materials: 'Plomby 260; Adaptery 20', notes: '' },
  { name: 'Wspólnota Lipowa 3', address: 'ul. Lipowa 3', city: 'Zielona Góra', postal_code: '', units_count: 24, planned_date: '2026-12-04', planned_end: '',
    crew: '', devices_planned: 96, scope: 'Montaż podzielników', project: '', materials: '', notes: 'Klucze u zarządcy' }];
  const cols = Object.keys(LABELS).map(k => ({ header: LABELS[k] + (['planned_date'].includes(k) ? ' *' : ''), key: k, type: ['planned_date', 'planned_end'].includes(k) ? 'date' : ['units_count', 'devices_planned'].includes(k) ? 'int' : undefined,
    width: { name: 26, address: 24, scope: 30, materials: 26, notes: 24, crew: 18 }[k] }));
  const buf = await xlsx.build([
    { name: 'Montaże', columns: cols, rows: ex },
    { name: 'Instrukcja', columns: [{ header: 'Jak wypełnić', key: 't', width: 110 }], rows: [
      'Jeden wiersz = jeden montaż. Przykładowe wiersze zastąp swoimi danymi (nie zmieniaj nagłówków).',
      'Wymagane: „Termin od” oraz „Budynek” lub „Adres”. Daty w formacie DD.MM.RRRR (albo jako daty Excela).',
      'Budynek: jeśli nazwa lub adres pasuje do budynku w ewidencji – montaż trafi do niego; jeśli nie – budynek zostanie dodany (wtedy podaj adres).',
      'Ekipa i Kontrakt: dokładnie jak w aplikacji (nazwa ekipy, numer kontraktu, np. KT/2026/001). Nieznane – montaż bez ekipy / kontraktu.',
      'Materiały: pozycje rozdzielone średnikiem, np. „Plomby 260; Adaptery 20”.',
      'Przed zapisem aplikacja pokaże podgląd: błędne wiersze i możliwe duplikaty (ten sam budynek i termin) nie zostaną zaimportowane.'
    ].map(t => ({ t })) }
  ], { title: 'MXT – szablon importu montaży' });
  xlsx.send(res, buf, 'szablon_importu_montazy');
}));

r.post('/excel', use, wrap(async (req, res) => {
  const b = req.body || {}, buf = fileOf(b, 5 * 1024 * 1024), name = fileName(b);
  const a = await analyse(buf);
  if (!b.zatwierdz) return res.json(a);
  const rows = a.rows.filter(o => o.status === 'ok');
  if (!rows.length) throw bad(400, 'Brak poprawnych wierszy do importu.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const built = new Map(), created = [];
    for (const o of rows) {
      const d = o.data;
      let building = d.building.id;
      if (d.building.mode === 'nowy') {
        building = built.get(d.building.key);
        if (!building) {
          building = (await client.query(`INSERT INTO buildings (name, address, city, postal_code, units_count, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [d.name || d.address, d.address, d.city, d.postal_code, d.units_count, req.user.id])).rows[0].id;
          built.set(d.building.key, building);
        }
      }
      const number = await docs.nextNumber(client, 'MZ');
      const x = (await client.query(`INSERT INTO installations (number, project_id, building_id, crew_id, planned_date, planned_end, scope, devices_planned, materials, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, number, crew_id, planned_date`,
        [number, d.project ? d.project.id : null, building, d.crew ? d.crew.id : null, d.planned_date, d.planned_end || null, d.scope, d.devices_planned, JSON.stringify(d.materials), d.notes, req.user.id])).rows[0];
      created.push({ ...x, building_name: d.name || d.address });
    }
    await audit(req, 'montaz.import_excel', { resource: 'installations', details: { plik: name, montaze: created.length, nowe_budynki: built.size,
      pominiete: a.summary.bledy + a.summary.duplikaty }, client });
    await notifyCrews(client, created);
    await client.query('COMMIT');
    res.status(201).json({ utworzono: created.length, nowe_budynki: built.size, pominieto: a.summary.bledy + a.summary.duplikaty, numery: created.map(x => x.number) });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

// =============== wczytanie z umowy / harmonogramu ===============
r.post('/dokument', use, wrap(async (req, res) => {
  const b = req.body || {}, buf = fileOf(b, docread.MAX_BYTES), name = fileName(b);
  const mime = docread.sniff(buf);
  if (!mime) throw bad(400, 'Obsługiwane pliki: PDF, JPG, PNG (np. skan albo zdjęcie umowy).');
  const pdfBuf = mime === 'application/pdf' ? buf : await docread.imageToPdf(buf);
  const av = await docread.availability();
  let extracted = null, model = null, usage = null, cost = null, note = av.powod || '';
  if (av.ai) {
    try { const x = await docread.readWithClaude(buf, mime); extracted = x.data; model = x.model; usage = x.usage; cost = x.cost; }
    catch (e) {
      note = 'Nie udało się odczytać dokumentu automatycznie: ' + docread.friendlyError(e).replace(/\.+$/, '') + '. Uzupełnij formularz ręcznie – dokument zostanie dołączony do kontraktu.';
      if (e.usage) { usage = e.usage; cost = e.cost; }
      console.error('odczyt dokumentu:', e.message);
    }
  }
  const imp = (await pool.query(`INSERT INTO doc_imports (file_name, mime, file_pdf, file_size, sha256, mode, extracted, ai_model, ai_usage, ai_cost_usd, ai_note, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [name, mime, pdfBuf, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), extracted ? 'ai' : 'reczny', extracted ? JSON.stringify(extracted) : null,
      model, usage ? JSON.stringify(usage) : null, cost, note, req.user.id])).rows[0];
  await audit(req, 'montaz.odczyt_dokumentu', { resource: 'doc_imports', resourceId: imp.id, details: { plik: name, tryb: extracted ? 'ai' : 'reczny', model,
    tokeny: usage, koszt_usd: cost == null ? null : Math.round(cost * 10000) / 10000 } });
  res.status(201).json({ id: imp.id, tryb: extracted ? 'ai' : 'reczny', uwaga: note, dane: extracted, propozycja: await docread.propose(extracted) });
}));
r.get('/dokument/:id/plik', idParam, use, wrap(async (req, res) => {
  const d = (await pool.query('SELECT file_name, file_pdf FROM doc_imports WHERE id = $1', [req.params.id])).rows[0];
  if (!d) throw bad(404, 'Nie znaleziono dokumentu.');
  sendPdf(res, d.file_pdf, d.file_name.replace(/\.[a-z0-9]+$/i, '') + '.pdf');
}));

// Zatwierdzenie: klient, inwestor, kontrakt, obiekty i montaże, dokument w kontrakcie – w jednej transakcji.
const CUST_KINDS = ['wspolnota', 'spoldzielnia', 'zarzadca', 'firma', 'inny'];
async function customer(client, c, kind, userId) {
  if (!c) return null;
  if (c.id) { const x = (await client.query('SELECT id FROM customers WHERE id = $1', [V.uuid(c.id, 'Klient')])).rows[0]; if (!x) throw bad(400, 'Nie znaleziono klienta.'); return x.id; }
  const name = V.str(c.name, 200);
  if (!name) return null;
  const nip = String(c.tax_id || '').replace(/\D/g, '');
  const found = (await client.query(`SELECT id FROM customers WHERE ($2 <> '' AND regexp_replace(tax_id, '\\D', '', 'g') = $2) OR lower(name) = lower($1) LIMIT 1`, [name, nip])).rows[0];
  if (found) return found.id;
  return (await client.query(`INSERT INTO customers (kind, name, tax_id, address, departments, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [V.oneOf(c.kind || kind, CUST_KINDS, 'Rodzaj klienta', kind), name, nip, V.str(c.address, 400), [DEP], userId])).rows[0].id;
}
r.post('/dokument/:id/zatwierdz', idParam, use, wrap(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const imp = (await client.query('SELECT * FROM doc_imports WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!imp) throw bad(404, 'Nie znaleziono wczytanego dokumentu.');
    if (imp.status === 'zatwierdzony') throw bad(409, 'Ten dokument został już zapisany.');
    const k = b.kontrakt || {}, objects = Array.isArray(b.obiekty) ? b.obiekty.slice(0, 200) : [];
    if (!objects.length && !k.utworz && !k.id) throw bad(400, 'Dodaj co najmniej jeden montaż albo utwórz kontrakt.');
    const clientId = await customer(client, b.klient, 'firma', req.user.id);
    const investorId = await customer(client, b.inwestor, 'spoldzielnia', req.user.id);
    let projectId = null, projectNumber = null;
    if (k.utworz) {
      projectNumber = await docs.nextNumber(client, 'KT');
      const start = V.date(k.start_date, 'Termin rozpoczęcia'), end = V.date(k.end_date, 'Termin zakończenia');
      if (start && end && end < start) throw bad(400, 'Kontrakt: termin zakończenia przed rozpoczęciem.');
      projectId = (await client.query(`INSERT INTO projects (number, department_id, customer_id, title, value_net, status, start_date, end_date, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,'w_realizacji',$6,$7,$8,$9) RETURNING id`, [projectNumber, DEP, clientId || investorId, V.str(k.title, 200, true, 'Nazwa kontraktu'),
        V.num(k.value_net, 0, 1e10, 'Wartość netto'), start, end, V.str(k.notes, 4000), req.user.id])).rows[0].id;
      await audit(req, 'kontrakt.utworzenie', { resource: 'projects', resourceId: projectId, details: { numer: projectNumber, zrodlo: 'dokument ' + imp.file_name }, client });
    } else if (k.id) {
      const p = (await client.query('SELECT id, number FROM projects WHERE id = $1 AND department_id = $2', [V.uuid(k.id, 'Kontrakt'), DEP])).rows[0];
      if (!p) throw bad(400, 'Nie znaleziono kontraktu.');
      projectId = p.id; projectNumber = p.number;
    }
    const created = [];
    for (const [i, o] of objects.entries()) {
      const label = `Montaż ${i + 1}: `;
      let building = V.uuid(o.building_id, label + 'budynek'), bname;
      if (building) { const x = (await client.query('SELECT name FROM buildings WHERE id = $1', [building])).rows[0]; if (!x) throw bad(400, label + 'nie znaleziono budynku.'); bname = x.name; }
      else {
        bname = V.str(o.name, 200, true, label + 'nazwa budynku / obiektu');
        building = (await client.query(`INSERT INTO buildings (customer_id, name, address, city, units_count, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [investorId || clientId, bname, V.str(o.address, 300, true, label + 'adres'), V.str(o.city, 100), V.num(o.units_count, 0, 100000, label + 'liczba lokali'), req.user.id])).rows[0].id;
      }
      const start = V.date(o.planned_date, label + 'termin rozpoczęcia', true), end = V.date(o.planned_end, label + 'termin zakończenia');
      if (end && end < start) throw bad(400, label + 'termin zakończenia przed rozpoczęciem.');
      const number = await docs.nextNumber(client, 'MZ');
      const x = (await client.query(`INSERT INTO installations (number, project_id, building_id, crew_id, planned_date, planned_end, scope, devices_planned, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, number, crew_id, planned_date`, [number, projectId, building, V.uuid(o.crew_id, label + 'ekipa'), start, end,
        V.str(o.scope, 4000), V.num(o.devices_planned, 0, 1000000, label + 'liczba urządzeń'), `Wczytano z dokumentu: ${imp.file_name}`, req.user.id])).rows[0];
      created.push({ ...x, building_name: bname });
    }
    // Dokument źródłowy w dokumentacji kontraktu (albo pierwszego montażu, gdy bez kontraktu).
    const doc = await docs.createDocument(client, { kind: 'inny', title: `Umowa / harmonogram: ${imp.file_name}`.slice(0, 300), department_id: DEP,
      related_type: projectId ? 'project' : 'installation', related_id: projectId || (created[0] && created[0].id), userId: req.user.id });
    await docs.addVersion(client, doc.id, { content: { odczyt: imp.mode, dane: imp.extracted }, file: imp.file_pdf, fileName: imp.file_name.replace(/\.[a-z0-9]+$/i, '') + '.pdf',
      mime: 'application/pdf', note: 'Dokument źródłowy montażu', userId: req.user.id });
    const result = { project_id: projectId, project_number: projectNumber, installations: created.map(x => x.number), document_id: doc.id };
    await client.query(`UPDATE doc_imports SET status = 'zatwierdzony', result = $2, confirmed_at = now() WHERE id = $1`, [imp.id, JSON.stringify(result)]);
    await audit(req, 'montaz.import_dokumentu', { resource: 'doc_imports', resourceId: imp.id, details: { plik: imp.file_name, kontrakt: projectNumber, montaze: result.installations }, client });
    await notifyCrews(client, created);
    await client.query('COMMIT');
    res.status(201).json(result);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

module.exports = r;
