'use strict';
// Dokumenty PDF MXT (pdfkit + czcionka DejaVu z polskimi znakami): protokół odbioru, oferta,
// dokumenty eksportowe i zaświadczenie o ukończeniu kursu.
const PDFDocument = require('pdfkit');
const path = require('path');

const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
// Logo w nagłówku: dokument działu ma logo tego działu, pozostałe – wspólne logo MXT.
const PUB = path.join(__dirname, '..', 'public');
const LOGOS = {
  mxt: path.join(PUB, 'logo.png'),
  'podzielniki-i-montaze': path.join(PUB, 'logos', 'podzielniki.png'),
  'sprzedaz-czesci-i-eksport': path.join(PUB, 'logos', 'express-parts.png'),
  ubezpieczenia: path.join(PUB, 'logos', 'ubezpieczenia.png')
};
// Kolory z logo MXT: czerń liter, złoto MXT Ubezpieczenia (zaświadczenia ze szkoleń działu Ubezpieczenia).
const INK = '#1a1a1a', MUTED = '#5f5f5b', LINE = '#dcdcd8', HEAD_BG = '#f0f0ee', GOLD = '#b59542', GOLD_TEXT = '#7d6424';
const fmt = (n, cur) => new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0) + (cur ? ' ' + cur : '');
const dpl = d => d ? new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('pl-PL') : '–';

function make(meta, build, { landscape = false } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 48, info: { Title: meta.title, Author: 'MXT', Creator: 'MXT Business OS' } });
    doc.registerFont('r', FONT); doc.registerFont('b', BOLD); doc.font('r').fillColor(INK);
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    try { build(doc); doc.end(); } catch (e) { reject(e); }
  });
}

function header(doc, title, number, date, dept) {
  try { doc.image(LOGOS[dept] || LOGOS.mxt, 48, 36, { fit: [124, 50], valign: 'center' }); } catch (e) { doc.font('b').fontSize(20).text('MXT', 48, 44); }
  const tw = doc.page.width - 228;
  doc.font('b').fontSize(15).fillColor(INK).text(title, 180, 42, { width: tw, align: 'right' });
  doc.font('r').fontSize(9.5).fillColor(MUTED).text(`${number ? 'Nr ' + number + '   ' : ''}Data: ${dpl(date)}`, 180, doc.y + 2, { width: tw, align: 'right' });
  const ly = Math.max(98, doc.y + 8);
  doc.moveTo(48, ly).lineTo(doc.page.width - 48, ly).strokeColor(LINE).lineWidth(1).stroke();
  doc.fillColor(INK).fontSize(10); doc.y = ly + 14; doc.x = 48;
}
const label = (doc, t) => doc.font('b').fontSize(8.5).fillColor(MUTED).text(t.toUpperCase(), { characterSpacing: 0.6 }).moveDown(0.15);
const para = (doc, t) => doc.font('r').fontSize(10).fillColor(INK).text(t || '–').moveDown(0.6);

function twoCols(doc, left, right) {
  const y = doc.y, w = (doc.page.width - 96 - 20) / 2;
  const col = (x, items) => { doc.y = y; for (const [l, v] of items) { doc.x = x; doc.font('b').fontSize(8.5).fillColor(MUTED).text(l.toUpperCase(), x, doc.y, { width: w }); doc.font('r').fontSize(10).fillColor(INK).text(v || '–', x, doc.y, { width: w }).moveDown(0.5); } return doc.y; };
  const a = col(48, left), b = col(48 + w + 20, right);
  doc.x = 48; doc.y = Math.max(a, b) + 6;
}

function table(doc, cols, rows, { totals } = {}) {
  const W = doc.page.width - 96, x0 = 48;
  const widths = cols.map(c => c.w * W);
  const draw = (cells, bold, fill) => {
    const h = Math.max(...cells.map((c, i) => doc.font(bold ? 'b' : 'r').fontSize(9).heightOfString(String(c), { width: widths[i] - 8 }))) + 8;
    if (doc.y + h > doc.page.height - 70) doc.addPage();
    const y = doc.y;
    if (fill) doc.rect(x0, y, W, h).fill(fill);
    let x = x0;
    cells.forEach((c, i) => { doc.font(bold ? 'b' : 'r').fontSize(9).fillColor(INK).text(String(c), x + 4, y + 4, { width: widths[i] - 8, align: cols[i].align || 'left' }); x += widths[i]; });
    doc.moveTo(x0, y + h).lineTo(x0 + W, y + h).strokeColor(LINE).lineWidth(0.6).stroke();
    doc.y = y + h; doc.x = x0;
  };
  draw(cols.map(c => c.t), true, HEAD_BG);
  rows.forEach(r => draw(r, false));
  if (totals) totals.forEach(t => draw(t, true));
  doc.moveDown(0.8);
}

function signatures(doc, left, right) {
  if (doc.y > doc.page.height - 150) doc.addPage();
  const y = Math.max(doc.y + 40, doc.page.height - 150), w = 200;
  doc.moveTo(48, y).lineTo(48 + w, y).strokeColor(INK).lineWidth(0.6).stroke();
  doc.moveTo(doc.page.width - 48 - w, y).lineTo(doc.page.width - 48, y).stroke();
  doc.font('r').fontSize(8.5).fillColor(MUTED).text(left, 48, y + 4, { width: w, align: 'center' }).text(right, doc.page.width - 48 - w, y + 4, { width: w, align: 'center' });
}
function footer(doc, text) {
  const range = doc.bufferedPageRange ? doc.bufferedPageRange() : null;
  doc.font('r').fontSize(7.5).fillColor(MUTED).text(text, 48, doc.page.height - 40, { width: doc.page.width - 96, align: 'center', lineBreak: false });
}

// ---------- protokół odbioru montażu ----------
const protocol = d => make({ title: 'Protokół odbioru ' + d.number }, doc => {
  header(doc, 'Protokół odbioru montażu', d.number, d.date, 'podzielniki-i-montaze');
  twoCols(doc, [['Zleceniodawca', d.customer], ['Budynek', `${d.building}\n${d.address}`]],
    [['Zlecenie montażowe', d.installation], ['Ekipa montażowa', d.crew], ['Termin wykonania', `${dpl(d.planned_date)}${d.planned_end ? ' – ' + dpl(d.planned_end) : ''}`]]);
  label(doc, 'Zakres prac'); para(doc, d.scope);
  label(doc, 'Zamontowane urządzenia (' + d.devices.length + ')');
  table(doc, [{ t: 'Lp.', w: .07 }, { t: 'Typ', w: .2 }, { t: 'Numer seryjny', w: .28 }, { t: 'Model', w: .2 }, { t: 'Lokalizacja', w: .25 }],
    d.devices.length ? d.devices.map((x, i) => [i + 1, x.type, x.serial_no, x.model || '–', x.location || '–']) : [['–', 'Brak urządzeń przypisanych do zlecenia', '', '', '']]);
  if (d.materials && d.materials.length) { label(doc, 'Zużyte materiały'); table(doc, [{ t: 'Materiał', w: .6 }, { t: 'Ilość', w: .2, align: 'right' }, { t: 'J.m.', w: .2 }], d.materials.map(m => [m.nazwa, m.ilosc, m.jm || 'szt.'])); }
  label(doc, 'Uwagi'); para(doc, d.notes);
  label(doc, 'Odbiór'); para(doc, `Prace zostały wykonane zgodnie z zakresem i przyjęte bez zastrzeżeń${d.accepted_by ? ' przez: ' + d.accepted_by : ''}.`);
  signatures(doc, 'Przedstawiciel MXT (ekipa)', 'Przedstawiciel zleceniodawcy' + (d.accepted_by ? `\n${d.accepted_by}` : ''));
  footer(doc, `MXT · Protokół ${d.number} · wygenerowano ${new Date().toLocaleString('pl-PL')}`);
});

// ---------- oferta ----------
const offer = d => make({ title: 'Oferta ' + d.number }, doc => {
  header(doc, d.language === 'en' ? 'Offer' : 'Oferta handlowa', d.number + ` (v${d.version})`, d.date, d.department_id);
  twoCols(doc, [['Odbiorca', `${d.customer}${d.customer_address ? '\n' + d.customer_address : ''}${d.customer_tax ? '\nNIP/VAT: ' + d.customer_tax : ''}`], ['Temat', d.title]],
    [['Waluta', d.currency + (d.currency !== 'PLN' ? `  (kurs ${d.rate_pln} PLN z ${dpl(d.rate_date)}, ${d.rate_source})` : '')], ['Ważna do', dpl(d.valid_until)]]);
  table(doc, [{ t: 'Lp.', w: .06 }, { t: 'Pozycja', w: .44 }, { t: 'Ilość', w: .1, align: 'right' }, { t: 'J.m.', w: .08 }, { t: 'Cena jedn.', w: .16, align: 'right' }, { t: 'Wartość', w: .16, align: 'right' }],
    d.items.map((x, i) => [i + 1, x.nazwa, x.ilosc, x.jm || 'szt.', fmt(x.cena), fmt(x.cena * x.ilosc)]),
    { totals: [...(Number(d.discount_pct) ? [['', `Rabat ${d.discount_pct}%`, '', '', '', '−' + fmt(d.subtotal - d.total)]] : []), ['', 'Razem netto', '', '', '', fmt(d.total, d.currency)]] });
  if (d.terms) { label(doc, 'Warunki'); para(doc, d.terms); }
  para(doc, 'Ceny netto. Oferta przygotowana w systemie MXT; obowiązuje po potwierdzeniu przez MXT.');
  footer(doc, `MXT · Oferta ${d.number} · wersja ${d.version}`);
});

// ---------- dokumenty eksportowe ----------
const EXPORT_TITLES = { faktura_eksportowa: 'Faktura eksportowa / Commercial invoice', specyfikacja_wysylkowa: 'Specyfikacja wysyłkowa / Packing list', dane_celne: 'Dane do zgłoszenia celnego / Customs data' };
const exportDoc = d => make({ title: EXPORT_TITLES[d.kind] + ' ' + d.number }, doc => {
  header(doc, EXPORT_TITLES[d.kind], d.number, d.date, 'sprzedaz-czesci-i-eksport');
  twoCols(doc, [['Eksporter / Exporter', 'MXT'], ['Odbiorca / Consignee', `${d.customer}${d.customer_address ? '\n' + d.customer_address : ''}${d.customer_tax ? '\nVAT: ' + d.customer_tax : ''}`]],
    [['Kraj przeznaczenia / Destination', d.destination_country], ['Incoterms 2020', d.incoterms], ['Dokument źródłowy / Reference', d.reference]]);
  if (d.kind === 'specyfikacja_wysylkowa') {
    table(doc, [{ t: 'Lp.', w: .06 }, { t: 'Opis / Description', w: .5 }, { t: 'Ilość / Qty', w: .14, align: 'right' }, { t: 'Waga kg / Weight', w: .15, align: 'right' }, { t: 'Paczki / Pkgs', w: .15, align: 'right' }],
      d.items.map((x, i) => [i + 1, x.nazwa, x.ilosc, fmt((x.waga_kg || 0) * x.ilosc), x.paczki || '–']),
      { totals: [['', 'Razem / Total', d.items.reduce((s, x) => s + Number(x.ilosc), 0), fmt(d.items.reduce((s, x) => s + (x.waga_kg || 0) * x.ilosc, 0)), '']] });
  } else {
    table(doc, [{ t: 'Lp.', w: .05 }, { t: 'Opis / Description', w: .31 }, { t: 'Kod HS', w: .12 }, { t: 'Kraj poch.', w: .11 }, { t: 'Ilość', w: .09, align: 'right' }, { t: 'Cena', w: .15, align: 'right' }, { t: 'Wartość', w: .17, align: 'right' }],
      d.items.map((x, i) => [i + 1, x.nazwa, x.kod_hs || '–', x.pochodzenie || 'PL', x.ilosc, fmt(x.cena), fmt(x.cena * x.ilosc)]),
      { totals: [['', 'Wartość razem / Total value', '', '', '', '', fmt(d.total, d.currency)]] });
  }
  if (d.kind === 'dane_celne') { label(doc, 'Masa brutto / Gross weight'); para(doc, fmt(d.items.reduce((s, x) => s + (x.waga_kg || 0) * x.ilosc, 0)) + ' kg'); }
  if (d.notes) { label(doc, 'Uwagi / Remarks'); para(doc, d.notes); }
  para(doc, 'Dane pochodzą z systemu MXT. Przed przekazaniem do agencji celnej zweryfikuj kody HS i wartości.');
  signatures(doc, 'Wystawił / Issued by', 'Podpis / Signature');
  footer(doc, `MXT · ${d.number}`);
});

// ---------- zaświadczenie ----------
const certificate = d => make({ title: 'Zaświadczenie ' + d.number }, doc => {
  const W = doc.page.width, H = doc.page.height;
  doc.rect(28, 28, W - 56, H - 56).strokeColor(GOLD).lineWidth(2).stroke();
  try { doc.image(LOGOS.ubezpieczenia, W / 2 - 90, 62, { fit: [180, 80], align: 'center', valign: 'center' }); } catch (e) { }
  doc.font('b').fontSize(28).fillColor(INK).text('ZAŚWIADCZENIE', 48, 160, { width: W - 96, align: 'center' });
  doc.font('r').fontSize(13).fillColor(MUTED).text('o ukończeniu szkolenia', { width: W - 96, align: 'center' }).moveDown(2);
  doc.font('r').fontSize(12).fillColor(INK).text('Niniejszym zaświadcza się, że', { width: W - 96, align: 'center' }).moveDown(0.6);
  doc.font('b').fontSize(22).fillColor(GOLD_TEXT).text(d.person, { width: W - 96, align: 'center' }).moveDown(0.6);
  doc.font('r').fontSize(12).fillColor(INK).text('ukończył(a) z wynikiem pozytywnym szkolenie', { width: W - 96, align: 'center' }).moveDown(0.6);
  doc.font('b').fontSize(17).fillColor(INK).text(d.course, { width: W - 96, align: 'center' }).moveDown(1.4);
  doc.font('r').fontSize(11).fillColor(MUTED).text(`Dział Ubezpieczenia · ${d.lessons} lekcji · testy: ${d.quizSummary}`, { width: W - 96, align: 'center' });
  doc.text(`Data ukończenia: ${dpl(d.date)}`, { width: W - 96, align: 'center' });
  signatures(doc, 'Data i miejsce', 'Za MXT – administrator platformy');
  footer(doc, `Numer zaświadczenia: ${d.number} · MXT Business OS`);
}, { landscape: false });

module.exports = { protocol, offer, exportDoc, certificate, EXPORT_TITLES };
