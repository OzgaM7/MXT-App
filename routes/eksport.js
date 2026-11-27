'use strict';
// Eksport do Excela – dział Podzielniki i Montaże (uprawnienie export.xlsx; monter nie eksportuje).
// Każdy eksport jest zapisywany w rejestrze operacji (dane opuszczają system).
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm, can } = require('../lib/rbac');
const xlsx = require('../lib/xlsx');
const { wrap, bad, V } = require('./_util');

const r = express.Router();
const exp = requirePerm('export.xlsx');
const DEP = 'podzielniki-i-montaze';
const MAX = 50000;
const DEV = { podzielnik: 'Podzielnik kosztów', wodomierz: 'Wodomierz', cieplomierz: 'Ciepłomierz', modul_radiowy: 'Moduł radiowy', inny: 'Inne' };
const DEV_ST = { magazyn: 'Magazyn', zamontowane: 'Zamontowane', zdemontowane: 'Zdemontowane', wadliwe: 'Wadliwe' };
const INST_ST = { zaplanowany: 'Zaplanowany', w_toku: 'W toku', wykonany: 'Wykonany', odebrany: 'Odebrany', anulowany: 'Anulowany' };
const PRJ_ST = { oferta: 'Oferta', w_realizacji: 'W realizacji', zakonczony: 'Zakończony', rozliczony: 'Rozliczony', anulowany: 'Anulowany' };
const { PROFIT } = require('../lib/erp/profit');   // te same przychody i koszty co zakładka „Rentowność”
const margin = rows => rows.map(x => ({ ...x, marza: Math.round((x.przychod - x.koszt) * 100) / 100, marza_pct: x.przychod ? (x.przychod - x.koszt) / x.przychod : null }));
const MONEY = [{ header: 'Przychody', key: 'przychod', type: 'pln', width: 14 }, { header: 'Koszty', key: 'koszt', type: 'pln', width: 14 },
  { header: 'Marża', key: 'marza', type: 'pln', width: 14 }, { header: 'Marża %', key: 'marza_pct', type: 'pct', width: 10 }];

// Filtry jak na listach w aplikacji (te same nazwy parametrów).
// fixed: warunki stałe z parametrami `base` ($1…), dalej filtry z adresu. „?” w warunku = wartość filtra.
function where(req, map, fixed = [], base = []) {
  const p = [...base], w = [...fixed];
  for (const [param, sql, conv] of map) {
    const v = req.query[param];
    if (v === undefined || v === '') continue;
    p.push(conv ? conv(v) : v); w.push(sql.split('?').join('$' + p.length));
  }
  return { p, w: w.length ? 'WHERE ' + w.join(' AND ') : '' };
}

const LISTS = {
  async budynki() {
    const q = await pool.query(`SELECT x.name, x.address, x.city, x.postal_code, c.name AS customer, x.units_count, x.heating_type, x.notes,
        (SELECT count(*)::int FROM devices d WHERE d.building_id = x.id) AS devices,
        (SELECT count(*)::int FROM installations i WHERE i.building_id = x.id) AS installations,
        (SELECT count(*)::int FROM complaints k WHERE k.building_id = x.id AND k.status NOT IN ('rozwiazana','odrzucona')) AS open_complaints, ${PROFIT('building_id')}
      FROM buildings x LEFT JOIN customers c ON c.id = x.customer_id ORDER BY x.name LIMIT ${MAX}`);
    return [{ name: 'Budynki', rows: margin(q.rows), columns: [
      { header: 'Budynek', key: 'name', width: 28 }, { header: 'Adres', key: 'address', width: 30 }, { header: 'Miasto', key: 'city', width: 16 },
      { header: 'Kod', key: 'postal_code', width: 8 }, { header: 'Wspólnota / klient', key: 'customer', width: 28 }, { header: 'Lokale', key: 'units_count', type: 'int' },
      { header: 'Ogrzewanie', key: 'heating_type', width: 14 }, { header: 'Urządzenia', key: 'devices', type: 'int' }, { header: 'Montaże', key: 'installations', type: 'int' },
      { header: 'Otwarte reklamacje', key: 'open_complaints', type: 'int' }, ...MONEY, { header: 'Uwagi', key: 'notes', width: 40 }] }];
  },
  async urzadzenia(req) {
    const f = where(req, [['building_id', 'd.building_id = ?', v => V.uuid(v)], ['typ', 'd.type = ?', v => V.oneOf(v, Object.keys(DEV), 'Typ')],
      ['status', 'd.status = ?', v => V.oneOf(v, Object.keys(DEV_ST), 'Status')],
      ['q', '(d.serial_no ILIKE ? OR d.model ILIKE ? OR d.location ILIKE ?)', v => '%' + String(v).slice(0, 60) + '%']]);
    const q = await pool.query(`SELECT d.serial_no, d.type, d.model, d.location, d.status, d.installed_at, d.notes, b.name AS building, b.address, i.number AS installation
      FROM devices d LEFT JOIN buildings b ON b.id = d.building_id LEFT JOIN installations i ON i.id = d.installation_id ${f.w}
      ORDER BY b.name NULLS LAST, d.location, d.serial_no LIMIT ${MAX}`, f.p);
    return [{ name: 'Urządzenia', rows: q.rows.map(d => ({ ...d, type: DEV[d.type], status: DEV_ST[d.status] })), columns: [
      { header: 'Numer seryjny', key: 'serial_no', width: 18 }, { header: 'Typ', key: 'type', width: 18 }, { header: 'Model', key: 'model', width: 16 },
      { header: 'Budynek', key: 'building', width: 26 }, { header: 'Adres', key: 'address', width: 28 }, { header: 'Lokalizacja', key: 'location', width: 22 },
      { header: 'Status', key: 'status', width: 13 }, { header: 'Data montażu', key: 'installed_at', type: 'date', width: 13 }, { header: 'Montaż', key: 'installation', width: 14 },
      { header: 'Uwagi', key: 'notes', width: 30 }] }];
  },
  async montaze(req) {
    const f = where(req, [['od', 'x.planned_date >= ?', v => V.date(v)], ['do', 'x.planned_date <= ?', v => V.date(v)], ['crew_id', 'x.crew_id = ?', v => V.uuid(v)],
      ['pracownik', 'EXISTS (SELECT 1 FROM installation_workers iw WHERE iw.installation_id = x.id AND iw.installer_id = ?)', v => V.uuid(v)], ['status', 'x.status = ?', v => V.oneOf(v, Object.keys(INST_ST), 'Status')]]);
    const q = await pool.query(`SELECT x.number, p.number AS project, coalesce(nullif(x.site_name, ''), b.name) AS building, coalesce(nullif(replace(x.addresses, E'\n', '; '), ''), b.address) AS address,
        CASE WHEN x.site_name <> '' OR x.addresses <> '' THEN '' ELSE b.city END AS city, x.buildings_count, coalesce(cx.name, c.name) AS customer,
        coalesce((SELECT string_agg(i.name, ', ' ORDER BY i.name) FROM installation_workers w JOIN installers i ON i.id = w.installer_id WHERE w.installation_id = x.id), cr.name) AS crew, x.planned_date, x.planned_end,
        x.status, x.devices_planned, (SELECT count(*)::int FROM devices d WHERE d.installation_id = x.id) AS devices_installed, x.scope, x.accepted_by, x.accepted_at, x.notes,
        ${PROFIT('installation_id')}
      FROM installations x LEFT JOIN buildings b ON b.id = x.building_id LEFT JOIN customers cx ON cx.id = x.customer_id LEFT JOIN customers c ON c.id = b.customer_id LEFT JOIN crews cr ON cr.id = x.crew_id
      LEFT JOIN projects p ON p.id = x.project_id ${f.w} ORDER BY x.planned_date, x.number LIMIT ${MAX}`, f.p);
    return [{ name: 'Montaże', rows: margin(q.rows).map(x => ({ ...x, status: INST_ST[x.status] })), columns: [
      { header: 'Numer', key: 'number', width: 14 }, { header: 'Kontrakt', key: 'project', width: 14 }, { header: 'Osiedle / budynek', key: 'building', width: 26 },
      { header: 'Adresy', key: 'address', width: 36 }, { header: 'Miasto', key: 'city', width: 14 }, { header: 'Liczba budynków', key: 'buildings_count', type: 'int' }, { header: 'Firma zlecająca', key: 'customer', width: 26 },
      { header: 'Pracownicy', key: 'crew', width: 24 }, { header: 'Termin od', key: 'planned_date', type: 'date', width: 12 }, { header: 'Termin do', key: 'planned_end', type: 'date', width: 12 },
      { header: 'Status', key: 'status', width: 12 }, { header: 'Urządzenia – plan', key: 'devices_planned', type: 'int' },
      { header: 'Urządzenia – zamontowane', key: 'devices_installed', type: 'int' }, { header: 'Zakres prac', key: 'scope', width: 40 },
      { header: 'Odebrał', key: 'accepted_by', width: 20 }, { header: 'Data odbioru', key: 'accepted_at', type: 'datetime', width: 16 }, ...MONEY,
      { header: 'Uwagi', key: 'notes', width: 30 }] }];
  },
  async kontrakty() {
    const q = await pool.query(`SELECT x.number, x.title, c.name AS customer, x.status, x.start_date, x.end_date, x.value_net::float AS value_net,
        coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'przychod' AND f.invoice_no <> ''), 0)::float AS zafakturowano,
        coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'przychod' AND f.paid_at IS NOT NULL), 0)::float AS zaplacono,
        coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'koszt'), 0)::float AS koszt,
        (SELECT count(*)::int FROM installations i WHERE i.project_id = x.id) AS installations,
        (SELECT count(*)::int FROM installations i WHERE i.project_id = x.id AND i.status = 'odebrany') AS installations_done
      FROM projects x LEFT JOIN customers c ON c.id = x.customer_id WHERE x.department_id = $1 ORDER BY x.created_at DESC LIMIT ${MAX}`, [DEP]);
    const rows = q.rows.map(x => ({ ...x, status: PRJ_ST[x.status], do_zafakturowania: Math.max(0, Math.round((x.value_net - x.zafakturowano) * 100) / 100),
      marza: Math.round((x.zafakturowano - x.koszt) * 100) / 100 }));
    return [{ name: 'Kontrakty', rows, columns: [
      { header: 'Numer', key: 'number', width: 12 }, { header: 'Nazwa', key: 'title', width: 30 }, { header: 'Klient', key: 'customer', width: 26 },
      { header: 'Status', key: 'status', width: 13 }, { header: 'Start', key: 'start_date', type: 'date', width: 12 }, { header: 'Koniec', key: 'end_date', type: 'date', width: 12 },
      { header: 'Wartość netto', key: 'value_net', type: 'pln', width: 15 }, { header: 'Zafakturowano', key: 'zafakturowano', type: 'pln', width: 15 },
      { header: 'Zapłacono', key: 'zaplacono', type: 'pln', width: 15 }, { header: 'Do zafakturowania', key: 'do_zafakturowania', type: 'pln', width: 15 },
      { header: 'Koszty', key: 'koszt', type: 'pln', width: 14 }, { header: 'Marża (zafakturowane − koszty)', key: 'marza', type: 'pln', width: 16 },
      { header: 'Montaże', key: 'installations', type: 'int' }, { header: 'Odebrane', key: 'installations_done', type: 'int' }] }];
  },
  async rentownosc() {
    const [b, i, k] = await Promise.all([
      pool.query(`SELECT x.name, x.address, x.city, ${PROFIT('building_id')} FROM buildings x ORDER BY x.name LIMIT ${MAX}`),
      pool.query(`SELECT x.number, coalesce(nullif(x.site_name, ''), b.name) AS building, x.planned_date, x.status, ${PROFIT('installation_id')} FROM installations x LEFT JOIN buildings b ON b.id = x.building_id
        ORDER BY x.planned_date DESC LIMIT ${MAX}`),
      pool.query(`SELECT x.number, x.title, x.status, x.value_net::float AS value_net, ${PROFIT('project_id')} FROM projects x WHERE x.department_id = $1 ORDER BY x.created_at DESC`, [DEP])
    ]);
    return [
      { name: 'Budynki', rows: margin(b.rows), columns: [{ header: 'Budynek', key: 'name', width: 28 }, { header: 'Adres', key: 'address', width: 30 }, { header: 'Miasto', key: 'city', width: 14 }, ...MONEY] },
      { name: 'Montaże', rows: margin(i.rows).map(x => ({ ...x, status: INST_ST[x.status] })), columns: [{ header: 'Montaż', key: 'number', width: 14 }, { header: 'Budynek', key: 'building', width: 28 },
        { header: 'Termin', key: 'planned_date', type: 'date', width: 12 }, { header: 'Status', key: 'status', width: 12 }, ...MONEY] },
      { name: 'Kontrakty', rows: margin(k.rows).map(x => ({ ...x, status: PRJ_ST[x.status] })), columns: [{ header: 'Kontrakt', key: 'number', width: 12 }, { header: 'Nazwa', key: 'title', width: 30 },
        { header: 'Status', key: 'status', width: 13 }, { header: 'Wartość netto', key: 'value_net', type: 'pln', width: 15 }, ...MONEY] }
    ];
  },
  async serwisy(req) {
    const S = require('../lib/service');
    const f = where(req, [['od', 'o.received_at >= ?', v => V.date(v)], ['do', 'o.received_at <= ?', v => V.date(v)],
      ['status', 'o.status = ?', v => V.oneOf(v, Object.keys(S.ST), 'Status')], ['serwisant', 'o.assigned_to = ?', v => V.uuid(v)]]);
    const q = await pool.query(`SELECT o.number, o.received_at, o.assign_due, o.assigned_at, o.planned_date, o.due_date, o.completed_at, o.approved_at, o.priority, o.status,
        o.client_name, o.address, o.unit, o.city, o.contact_name, o.contact_phone, o.description, o.cancel_reason, u.full_name AS assigned_name, u.login AS assigned_login,
        k.number AS complaint, ${S.FLAGS},
        (SELECT count(*)::int FROM service_photos p WHERE p.order_id = o.id) AS photos,
        (o.assigned_at IS NOT NULL AND (o.assigned_at AT TIME ZONE 'Europe/Warsaw')::date <= o.assign_due) AS assigned_on_time
      FROM service_orders o LEFT JOIN users u ON u.id = o.assigned_to LEFT JOIN complaints k ON k.id = o.complaint_id ${f.w}
      ORDER BY o.received_at DESC, o.number LIMIT ${MAX}`, f.p);
    const yn = v => v ? 'tak' : 'nie';
    return [{ name: 'Serwisy', rows: q.rows.map(o => ({ ...o, status: S.ST[o.status], priority: S.PRIORITY[o.priority], assigned: o.assigned_name || o.assigned_login || '',
      po_przydzial: yn(o.po_terminie_przydzialu), po_realizacja: yn(o.po_terminie_realizacji), w_terminie: o.assigned_at ? yn(o.assigned_on_time) : '' })), columns: [
      { header: 'Numer', key: 'number', width: 13 }, { header: 'Otrzymano', key: 'received_at', type: 'date', width: 11 }, { header: 'Termin przydziału', key: 'assign_due', type: 'date', width: 12 },
      { header: 'Przydzielono', key: 'assigned_at', type: 'datetime', width: 15 }, { header: 'Przydział w terminie', key: 'w_terminie', width: 11 },
      { header: 'Serwisant', key: 'assigned', width: 20 }, { header: 'Wizyta', key: 'planned_date', type: 'date', width: 11 }, { header: 'Termin realizacji', key: 'due_date', type: 'date', width: 12 },
      { header: 'Wykonano', key: 'completed_at', type: 'datetime', width: 15 }, { header: 'Zatwierdzono', key: 'approved_at', type: 'datetime', width: 15 },
      { header: 'Status', key: 'status', width: 16 }, { header: 'Priorytet', key: 'priority', width: 10 },
      { header: 'Po terminie przydziału', key: 'po_przydzial', width: 11 }, { header: 'Po terminie realizacji', key: 'po_realizacja', width: 11 },
      { header: 'Klient', key: 'client_name', width: 24 }, { header: 'Adres', key: 'address', width: 26 }, { header: 'Lokal', key: 'unit', width: 8 }, { header: 'Miasto', key: 'city', width: 14 },
      { header: 'Kontakt', key: 'contact_name', width: 18 }, { header: 'Telefon', key: 'contact_phone', width: 14 }, { header: 'Opis', key: 'description', width: 40 },
      { header: 'Reklamacja', key: 'complaint', width: 13 }, { header: 'Zdjęcia', key: 'photos', type: 'int' }, { header: 'Powód anulowania', key: 'cancel_reason', width: 24 }] }];
  },
  async finanse(req) {
    const f = where(req, [['od', 'f.entry_date >= ?', v => V.date(v)], ['do', 'f.entry_date <= ?', v => V.date(v)],
      ['rodzaj', 'f.kind = ?', v => V.oneOf(v, ['przychod', 'koszt'], 'Rodzaj')]], ['f.department_id = $1'], [DEP]);
    const q = await pool.query(`SELECT f.entry_date, f.kind, f.category, f.description, f.invoice_no, f.due_date, f.paid_at, f.amount::float AS amount, f.currency,
        f.rate_pln::float AS rate_pln, f.amount_pln::float AS amount_pln, c.name AS customer, b.name AS building, pr.number AS project, i.number AS installation
      FROM finance f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN buildings b ON b.id = f.building_id LEFT JOIN projects pr ON pr.id = f.project_id
      LEFT JOIN installations i ON i.id = f.installation_id ${f.w} ORDER BY f.entry_date DESC, f.created_at DESC LIMIT ${MAX}`, f.p);
    return [{ name: 'Finanse', rows: q.rows.map(x => ({ ...x, kind: x.kind === 'przychod' ? 'Przychód' : 'Koszt' })), columns: [
      { header: 'Data', key: 'entry_date', type: 'date', width: 12 }, { header: 'Rodzaj', key: 'kind', width: 10 }, { header: 'Kategoria', key: 'category', width: 16 },
      { header: 'Opis', key: 'description', width: 36 }, { header: 'Faktura', key: 'invoice_no', width: 16 }, { header: 'Termin płatności', key: 'due_date', type: 'date', width: 14 },
      { header: 'Zapłacono', key: 'paid_at', type: 'date', width: 12 }, { header: 'Kwota', key: 'amount', type: 'num', width: 14 }, { header: 'Waluta', key: 'currency', width: 8 },
      { header: 'Kurs NBP', key: 'rate_pln', type: 'num', width: 10 }, { header: 'Kwota PLN', key: 'amount_pln', type: 'pln', width: 15 },
      { header: 'Klient', key: 'customer', width: 24 }, { header: 'Budynek', key: 'building', width: 24 }, { header: 'Kontrakt', key: 'project', width: 12 },
      { header: 'Montaż', key: 'installation', width: 14 }] }];
  }
};
const TITLES = { budynki: 'Budynki', urzadzenia: 'Urządzenia', montaze: 'Harmonogram montaży', kontrakty: 'Kontrakty i rozliczenia', rentownosc: 'Rentowność',
  finanse: 'Finanse działu', serwisy: 'Zlecenia serwisowe' };

r.get('/d1/:lista', exp, wrap(async (req, res) => {
  const name = req.params.lista;
  if (!Object.prototype.hasOwnProperty.call(LISTS, name)) throw bad(404, 'Nie ma takiego zestawienia.');
  // Zestawienia finansowe (rejestr finansów, ranking rentowności) – tak jak w aplikacji, tylko dla ról finansowych.
  if (['finanse', 'rentownosc'].includes(name) && !can(req.user, 'finance.view')) throw bad(403, 'Brak uprawnień do zestawień finansowych.');
  const sheets = await LISTS[name](req);
  const buf = await xlsx.build(sheets, { title: 'MXT – Podzielniki i Montaże – ' + TITLES[name] });
  await audit(req, 'eksport.xlsx', { resource: 'eksport/d1/' + name, details: { zestawienie: TITLES[name], wiersze: sheets.reduce((s, x) => s + x.rows.length, 0),
    filtry: Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v).slice(0, 60)])) } });
  xlsx.send(res, buf, 'Podzielniki_' + name);
}));

module.exports = r;
