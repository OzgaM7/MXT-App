'use strict';
// Eksport do Excela (XLSX): arkusze z nagłówkiem, filtrem, zamrożonym pierwszym wierszem i formatami liczb.
// Dane pochodzą zawsze z bazy aplikacji – plik jest raportem, nie drugim miejscem wprowadzania danych.
const ExcelJS = require('exceljs');
const { plToday } = require('./dzis');

const FMT = {
  pln: '#,##0.00 "zł"',
  num: '#,##0.00',
  int: '0',
  pct: '0.0%',
  date: 'dd.mm.yyyy',
  datetime: 'dd.mm.yyyy hh:mm'
};

// Wartość z bazy → komórka Excela (daty jako prawdziwe daty, kwoty jako liczby).
function cell(v, type) {
  if (v == null || v === '') return null;
  if (type === 'date' || type === 'datetime') {
    if (v instanceof Date) return type === 'date' ? new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())) : v;
    const d = new Date(v);
    return isNaN(d) ? String(v) : d;
  }
  if (['pln', 'num', 'int', 'pct'].includes(type)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  // Tekst zapisywany jest jako komórka tekstowa – treść zaczynająca się od „=” nie staje się formułą (inaczej niż w CSV).
  return String(v);
}

/**
 * @param {{name:string, columns:{header:string,key:string,type?:string,width?:number}[], rows:object[]}[]} sheets
 * @param {{title?:string}} meta
 * @returns {Promise<Buffer>}
 */
async function build(sheets, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MXT'; wb.created = new Date(); wb.title = meta.title || 'Eksport MXT';
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = sh.columns.map(c => ({ header: c.header, key: c.key, width: c.width || Math.min(48, Math.max(10, c.header.length + 2)),
      style: FMT[c.type] ? { numFmt: FMT[c.type] } : {} }));
    for (const r of sh.rows) ws.addRow(Object.fromEntries(sh.columns.map(c => [c.key, cell(r[c.key], c.type)])));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
    head.alignment = { vertical: 'middle', wrapText: true };
    head.height = 30;
    if (sh.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sh.columns.length } };
    if (!sh.rows.length) ws.addRow([sh.empty || 'Brak danych dla wybranych filtrów.']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function send(res, buf, name) {
  const file = `MXT_${name}_${plToday()}.xlsx`.replace(/[^\w.-]+/g, '_');
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'private, no-store' });
  res.end(buf);
}

module.exports = { build, send, cell, FMT };
