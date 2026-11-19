'use strict';
// Oferty (działy 1 i 2): automatyczna kalkulacja z danych klienta i pozycji, waluta z kursem NBP i datą kursu, marża,
// wersjonowanie (każda zmiana = nowa wersja dokumentu), wysyłka wyłącznie po akceptacji administratora tej wersji.
const { pool } = require('../db');
const { audit } = require('./audit');
const ops = require('./operations');
const docs = require('./docs');
const nbp = require('./nbp');
const mail = require('./mail');
const events = require('./events');

// Treść e-maila z ofertą w języku klienta (pl / en / de; pozostałe – en).
const MAIL_TPL = {
  pl: (o, c) => ({ subject: `Oferta ${o.number} – ${o.title}`, text: `Dzień dobry,\n\nw załączniku przesyłamy ofertę ${o.number} „${o.title}” na kwotę ${Number(o.total).toFixed(2)} ${o.currency} netto${o.valid_until ? `, ważną do ${String(o.valid_until).slice(0, 10)}` : ''}.\n\nW razie pytań prosimy o odpowiedź na tę wiadomość.\n\nZ poważaniem\nMXT` }),
  en: (o, c) => ({ subject: `Offer ${o.number} – ${o.title}`, text: `Dear Sir or Madam,\n\nplease find attached our offer ${o.number} "${o.title}" for ${Number(o.total).toFixed(2)} ${o.currency} net${o.valid_until ? `, valid until ${String(o.valid_until).slice(0, 10)}` : ''}.\n\nShould you have any questions, simply reply to this e-mail.\n\nKind regards\nMXT` }),
  de: (o, c) => ({ subject: `Angebot ${o.number} – ${o.title}`, text: `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unser Angebot ${o.number} „${o.title}“ über ${Number(o.total).toFixed(2)} ${o.currency} netto${o.valid_until ? `, gültig bis ${String(o.valid_until).slice(0, 10)}` : ''}.\n\nBei Fragen antworten Sie einfach auf diese E-Mail.\n\nMit freundlichen Grüßen\nMXT` })
};

const err = (s, m) => new ops.PolicyError(s, m);
const r2 = n => Math.round(Number(n) * 100) / 100;
const DEPTS = ['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport'];

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw err(400, 'Dodaj co najmniej jedną pozycję oferty.');
  if (items.length > 200) throw err(400, 'Najwyżej 200 pozycji.');
  return items.map((x, i) => {
    const o = { nazwa: String(x.nazwa || '').trim().slice(0, 300), ilosc: Number(x.ilosc), jm: String(x.jm || 'szt.').slice(0, 10),
      koszt_pln: Number(x.koszt_pln || 0), cena: x.cena === '' || x.cena == null ? null : Number(x.cena),
      kod_hs: String(x.kod_hs || '').replace(/\s/g, '').slice(0, 10), waga_kg: Number(x.waga_kg || 0), pochodzenie: String(x.pochodzenie || 'PL').toUpperCase().slice(0, 2) };
    if (!o.nazwa) throw err(400, `Pozycja ${i + 1}: podaj nazwę.`);
    if (!(o.ilosc > 0 && o.ilosc <= 1e6)) throw err(400, `Pozycja ${i + 1}: nieprawidłowa ilość.`);
    if (!(o.koszt_pln >= 0)) throw err(400, `Pozycja ${i + 1}: nieprawidłowy koszt.`);
    if (o.cena != null && !(o.cena >= 0)) throw err(400, `Pozycja ${i + 1}: nieprawidłowa cena.`);
    if (o.kod_hs && !/^\d{4,10}$/.test(o.kod_hs)) throw err(400, `Pozycja ${i + 1}: kod HS to 4–10 cyfr.`);
    if (!(o.waga_kg >= 0)) throw err(400, `Pozycja ${i + 1}: nieprawidłowa waga.`);
    return o;
  });
}

// Kalkulacja: cena = koszt × (1 + marża) / kurs, gdy cena nie jest podana. Kurs wyłącznie z bazy (NBP).
async function calculate({ currency, margin_pct, discount_pct, items, rate_date }) {
  currency = String(currency || 'PLN').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw err(400, 'Nieprawidłowa waluta.');
  const margin = Number(margin_pct || 0), disc = Number(discount_pct || 0);
  if (!(margin >= -50 && margin <= 500)) throw err(400, 'Marża: od −50% do 500%.');
  if (!(disc >= 0 && disc <= 90)) throw err(400, 'Rabat: od 0% do 90%.');
  let rate;
  try { rate = await nbp.rateFor(currency, rate_date); } catch (e) { throw err(e.status || 409, e.message); }
  const its = cleanItems(items).map(x => ({ ...x, cena: x.cena == null ? r2(x.koszt_pln * (1 + margin / 100) / rate.rate_pln) : r2(x.cena) }));
  const subtotal = r2(its.reduce((s, x) => s + x.cena * x.ilosc, 0));
  const total = r2(subtotal * (1 - disc / 100));
  const total_pln = r2(total * rate.rate_pln), cost_pln = r2(its.reduce((s, x) => s + x.koszt_pln * x.ilosc, 0));
  return { currency, rate_pln: rate.rate_pln, rate_date: rate.effective_date, rate_source: rate.source + (rate.table_no ? ' nr ' + rate.table_no : ''),
    margin_pct: margin, discount_pct: disc, items: its, subtotal, total, total_pln, cost_pln, margin_pln: r2(total_pln - cost_pln),
    margin_real_pct: total_pln ? r2((total_pln - cost_pln) / total_pln * 100) : 0 };
}

const snapshot = (o, c) => ({ number: o.number, version: o.version, department_id: o.department_id, title: o.title, customer: c.name, customer_address: c.address, customer_tax: c.tax_id,
  language: c.language, currency: o.currency, rate_pln: Number(o.rate_pln), rate_date: o.rate_date, rate_source: o.rate_source, margin_pct: Number(o.margin_pct),
  discount_pct: Number(o.discount_pct), items: o.items, subtotal: r2(o.items.reduce((s, x) => s + x.cena * x.ilosc, 0)), total: Number(o.total), total_pln: Number(o.total_pln),
  cost_pln: Number(o.cost_pln), valid_until: o.valid_until, terms: o.terms, date: new Date().toISOString().slice(0, 10) });

async function customerOf(client, id) {
  const c = (await client.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
  if (!c) throw err(400, 'Wybierz klienta z CRM.');
  return c;
}

async function create(input, { user = null, agent = null, req = null } = {}) {
  const dep = DEPTS.includes(input.department_id) ? input.department_id : 'sprzedaz-czesci-i-eksport';
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) throw err(400, 'Podaj temat oferty.');
  if (input.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(input.valid_until)) throw err(400, 'Nieprawidłowa data ważności.');
  const calc = await calculate(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await customerOf(client, input.customer_id);
    const number = await docs.nextNumber(client, 'OF');
    const doc = await docs.createDocument(client, { kind: 'oferta', title: `Oferta ${number} – ${title}`, department_id: dep, related_type: 'offer', userId: user && user.id });
    const o = (await client.query(`INSERT INTO offers (number, department_id, customer_id, title, currency, rate_pln, rate_date, rate_source, margin_pct, discount_pct,
        items, total, total_pln, cost_pln, valid_until, terms, document_id, created_by, created_by_agent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [number, dep, c.id, title, calc.currency, calc.rate_pln, calc.rate_date, calc.rate_source, calc.margin_pct, calc.discount_pct, JSON.stringify(calc.items),
        calc.total, calc.total_pln, calc.cost_pln, input.valid_until || null, String(input.terms || '').slice(0, 3000), doc.id, user && user.id, agent || null])).rows[0];
    await client.query('UPDATE documents SET related_id = $2 WHERE id = $1', [doc.id, o.id]);
    await docs.addVersion(client, doc.id, { content: snapshot(o, c), note: 'Utworzenie oferty', userId: user && user.id, agentId: agent });
    await audit(req || { user }, 'oferta.utworzenie', { actor: agent ? { type: 'agent', id: agent, name: agent } : null, resource: 'offers', resourceId: o.id, details: { numer: number, kwota: calc.total, waluta: calc.currency }, client });
    await client.query('COMMIT');
    return o;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

async function update(id, input, { user, req }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query('SELECT * FROM offers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o) throw err(404, 'Nie znaleziono oferty.');
    if (o.status !== 'szkic') throw err(409, o.status === 'do_akceptacji' ? 'Oferta czeka na akceptację. Wycofaj wniosek, aby ją zmienić.' : 'Ofertę wysłaną lub zamkniętą można tylko skopiować do nowej.');
    const calc = await calculate({ currency: input.currency || o.currency, margin_pct: input.margin_pct ?? o.margin_pct, discount_pct: input.discount_pct ?? o.discount_pct, items: input.items || o.items });
    const c = await customerOf(client, input.customer_id || o.customer_id);
    const n = (await client.query(`UPDATE offers SET customer_id=$2, title=$3, currency=$4, rate_pln=$5, rate_date=$6, rate_source=$7, margin_pct=$8, discount_pct=$9, items=$10,
        total=$11, total_pln=$12, cost_pln=$13, valid_until=$14, terms=$15, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, c.id, String(input.title ?? o.title).trim().slice(0, 200) || o.title, calc.currency, calc.rate_pln, calc.rate_date, calc.rate_source, calc.margin_pct, calc.discount_pct,
        JSON.stringify(calc.items), calc.total, calc.total_pln, calc.cost_pln, input.valid_until === undefined ? o.valid_until : input.valid_until || null,
        input.terms === undefined ? o.terms : String(input.terms).slice(0, 3000)])).rows[0];
    await docs.addVersion(client, o.document_id, { content: snapshot(n, c), note: 'Zmiana oferty', userId: user.id });
    await audit(req, 'oferta.zmiana', { resource: 'offers', resourceId: id, details: { wersja: n.version }, client });
    await client.query('COMMIT');
    return n;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// Wniosek o wysyłkę: operacja poziomu 2 przypięta do dokumentu oferty i jej wersji.
async function requestSend(id, actor, req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query('SELECT o.*, c.name AS customer_name FROM offers o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1 FOR UPDATE OF o', [id])).rows[0];
    if (!o) throw err(404, 'Nie znaleziono oferty.');
    if (o.status !== 'szkic') throw err(409, 'Do wysyłki można zgłosić tylko ofertę w stanie „szkic”.');
    const ap = await ops.requestOperation(actor, {
      operation_type: 'oferta.wyslij', title: `Wysyłka oferty ${o.number} do: ${o.customer_name}`, description: `${o.title}\nWersja ${o.version}, ${o.items.length} poz.`,
      amount: Number(o.total), currency: o.currency, department_id: o.department_id, document_id: o.document_id, document_version: o.version,
      payload: { offer_id: o.id, number: o.number, version: o.version }
    }, req, { client, module: true });
    await client.query(`UPDATE offers SET status = 'do_akceptacji', approval_id = $2, updated_at = now() WHERE id = $1`, [id, ap.id]);
    await client.query('COMMIT');
    events.emit('oferta.do_akceptacji', { numer: o.number, klient: o.customer_name, kwota: Number(o.total), waluta: o.currency });
    return ap;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

const offerOf = async (client, ap) => {
  const id = ap.payload && ap.payload.offer_id;
  return id ? (await client.query('SELECT * FROM offers WHERE id = $1 FOR UPDATE', [id])).rows[0] : null;
};
ops.onExecute('oferta.wyslij', async (client, ap, actor) => {
  const o = await offerOf(client, ap);
  if (!o) throw err(409, 'Wniosek nie jest powiązany z ofertą z modułu Oferty.');
  if (o.version !== ap.document_version || o.document_id !== ap.document_id) throw err(409, `Oferta zmieniła się (wersja ${o.version}, zatwierdzono ${ap.document_version}). Wysyłka zablokowana.`);
  if (o.status !== 'do_akceptacji') throw err(409, 'Oferta nie czeka na wysyłkę.');
  await client.query(`UPDATE offers SET status = 'wyslana', sent_at = now(), updated_at = now() WHERE id = $1`, [o.id]);
  const c = (await client.query('SELECT name, email, language FROM customers WHERE id = $1', [o.customer_id])).rows[0];
  const hasMail = c && mail.EMAIL.test(c.email || '');
  const cm = (await client.query(`INSERT INTO communications (customer_id, channel, direction, subject, body, related_type, related_id, created_by, email_to)
    VALUES ($1, $2, 'wychodzaca', $3, $4, 'offer', $5, $6, $7) RETURNING id`, [o.customer_id, hasMail ? 'email' : 'system', `Oferta ${o.number} (wersja ${o.version})`,
    hasMail ? `Oferta zatwierdzona przez administratora (wersja ${o.version}) – e-mail z PDF w kolejce wysyłki.` : 'Oferta zatwierdzona przez administratora i zwolniona. Klient nie ma adresu e-mail w CRM – przekaż PDF ręcznie.',
    o.id, actor.type === 'agent' ? null : actor.id, hasMail ? c.email : null])).rows[0];
  if (hasMail) {
    const t = (MAIL_TPL[c.language] || MAIL_TPL.en)(o, c);
    await mail.queue({ to: c.email, subject: t.subject, text: t.text, attachments: [{ kind: 'offer', offer_id: o.id, version: o.version }], customer_id: o.customer_id,
      communication_id: cm.id, related_type: 'offer', related_id: o.id, created_by: actor.type === 'agent' ? null : actor.id }, client);
  }
  setImmediate(() => events.emit('oferta.wyslana', { numer: o.number, klient: c && c.name, kwota: Number(o.total), waluta: o.currency, email: hasMail ? c.email : '' }));
});
const back = async (client, ap) => { const o = await offerOf(client, ap); if (o && o.status === 'do_akceptacji') await client.query(`UPDATE offers SET status = 'szkic', updated_at = now() WHERE id = $1`, [o.id]); };
ops.onDecision('oferta.wyslij', async (client, ap) => { if (ap.status === 'odrzucona') await back(client, ap); });
ops.onWithdraw('oferta.wyslij', back);

// Wynik u klienta: przyjęta → sprzedaż + przychód i koszt w Finance Intelligence.
async function outcome(id, accepted, { user, req }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query('SELECT * FROM offers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o) throw err(404, 'Nie znaleziono oferty.');
    if (o.status !== 'wyslana') throw err(409, 'Wynik można zapisać tylko dla wysłanej oferty.');
    await client.query(`UPDATE offers SET status = $2, updated_at = now() WHERE id = $1`, [id, accepted ? 'przyjeta' : 'odrzucona']);
    let sale = null;
    if (accepted) {
      const number = await docs.nextNumber(client, 'SP');
      sale = (await client.query(`INSERT INTO sales_history (number, customer_id, offer_id, currency, rate_pln, total, total_pln, cost_pln, items, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [number, o.customer_id, o.id, o.currency, o.rate_pln, o.total, o.total_pln, o.cost_pln, JSON.stringify(o.items), user.id])).rows[0];
      await client.query(`INSERT INTO finance (department_id, kind, category, description, amount, currency, rate_pln, amount_pln, customer_id, offer_id, sale_id, created_by)
        VALUES ($1, 'przychod', 'sprzedaż', $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [o.department_id, `Sprzedaż ${number} (oferta ${o.number})`, o.total, o.currency, o.rate_pln, o.total_pln, o.customer_id, o.id, sale.id, user.id]);
      if (Number(o.cost_pln) > 0) await client.query(`INSERT INTO finance (department_id, kind, category, description, amount, currency, rate_pln, amount_pln, customer_id, offer_id, sale_id, created_by)
        VALUES ($1, 'koszt', 'koszt towaru', $2, $3, 'PLN', 1, $3, $4, $5, $6, $7)`, [o.department_id, `Koszt sprzedaży ${number}`, o.cost_pln, o.customer_id, o.id, sale.id, user.id]);
    }
    await audit(req, accepted ? 'oferta.przyjeta' : 'oferta.odrzucona_przez_klienta', { resource: 'offers', resourceId: id, details: { sprzedaz: sale && sale.number }, client });
    await client.query('COMMIT');
    if (accepted) events.emit('oferta.przyjeta', { numer: o.number, kwota: Number(o.total), waluta: o.currency, sprzedaz: sale.number });
    return { offer_id: id, sale };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

module.exports = { calculate, create, update, requestSend, outcome, snapshot, DEPTS };
