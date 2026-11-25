'use strict';
// Globalne wyszukiwanie: każdy moduł rejestruje dostawcę wyników z wymaganym uprawnieniem.
// Użytkownik dostaje wyniki wyłącznie z modułów, do których ma dostęp (sprawdzenie w backendzie, lib/rbac.js).
const { pool } = require('../db');
const { can } = require('./rbac');

const providers = [];
/** @param {{key:string,label:string,perm:string,order?:number,query:(term:string,like:string,user:object)=>Promise<{id:string,title:string,sub?:string,link:string}[]>}} p */
function register(p) { if (!providers.some(x => x.key === p.key)) providers.push(p); }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 6;

async function search(user, q) {
  const term = String(q || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (term.length < 2) return [];
  const like = '%' + term.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const groups = await Promise.all(providers.filter(p => can(user, p.perm)).map(async p => {
    try { return { key: p.key, label: p.label, order: p.order || 50, items: (await p.query(term, like, user)).slice(0, LIMIT) }; }
    catch (e) { console.error('wyszukiwanie', p.key, e.message); return null; }
  }));
  return groups.filter(g => g && g.items.length).sort((a, b) => a.order - b.order).map(({ order, ...g }) => g);
}

const D1 = '/dzial/podzielniki-i-montaze';
const rows = async (sql, params) => (await pool.query(sql, params)).rows;
const digits = s => s.replace(/\D/g, '');

// ---------- dostawcy wspólnego rdzenia i działu Ciepłomierze i podzielniki ----------
register({ key: 'klienci', label: 'Klienci', perm: 'tasks.use', order: 10, query: async (term, like) => {
  const ph = digits(term);
  return (await rows(`SELECT id, name, kind, phone, email, tax_id, address FROM customers
      WHERE archived_at IS NULL AND (name ILIKE $1 OR tax_id ILIKE $1 OR email ILIKE $1 OR address ILIKE $1 OR ($2 <> '' AND length($2) >= 3 AND regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $2 || '%')
        OR ($3::text IS NOT NULL AND id::text = $3))
      ORDER BY (name ILIKE $4) DESC, lower(name) LIMIT ${LIMIT}`, [like, ph, UUID.test(term) ? term.toLowerCase() : null, term.replace(/[\\%_]/g, m => '\\' + m) + '%']))
    .map(c => ({ id: c.id, title: c.name, sub: [c.phone, c.email, c.tax_id && 'NIP ' + c.tax_id, c.address].filter(Boolean).join(' · '), link: '/crm?klient=' + c.id }));
} });
register({ key: 'budynki', label: 'Budynki', perm: 'departments.view', order: 20, query: async (term, like) =>
  (await rows(`SELECT b.id, b.name, b.address, b.city, c.name AS customer FROM buildings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.archived_at IS NULL AND (b.name ILIKE $1 OR b.address ILIKE $1 OR b.city ILIKE $1) ORDER BY lower(b.name) LIMIT ${LIMIT}`, [like]))
    .map(b => ({ id: b.id, title: b.name, sub: [b.address + (b.city ? ', ' + b.city : ''), b.customer].filter(Boolean).join(' · '), link: `${D1}?tab=budynki&b=${b.id}` })) });
register({ key: 'montaze', label: 'Montaże', perm: 'departments.view', order: 30, query: async (term, like) =>
  (await rows(`SELECT x.id, x.number, x.planned_date, x.status, b.name AS building, b.address FROM installations x JOIN buildings b ON b.id = x.building_id
      WHERE x.number ILIKE $1 OR b.name ILIKE $1 OR b.address ILIKE $1 ORDER BY x.planned_date DESC LIMIT ${LIMIT}`, [like]))
    .map(x => ({ id: x.id, title: x.number + ' · ' + x.building, sub: x.planned_date + ' · ' + x.address, link: `${D1}?tab=harmonogram&m=${x.id}` })) });
register({ key: 'serwisy', label: 'Zlecenia serwisowe', perm: 'service.manage', order: 31, query: async (term, like) => {
  const ph = digits(term);
  return (await rows(`SELECT id, number, client_name, address, city, status, received_at FROM service_orders
      WHERE number ILIKE $1 OR client_name ILIKE $1 OR address ILIKE $1 OR description ILIKE $1 OR ($2 <> '' AND length($2) >= 3 AND regexp_replace(contact_phone, '\\D', '', 'g') LIKE '%' || $2 || '%')
      ORDER BY received_at DESC LIMIT ${LIMIT}`, [like, ph]))
    .map(o => ({ id: o.id, title: o.number + (o.client_name ? ' · ' + o.client_name : ''), sub: [o.address + (o.city ? ', ' + o.city : ''), 'przyjęte ' + o.received_at].filter(Boolean).join(' · '), link: `${D1}?tab=serwisy&z=${o.id}` }));
} });
register({ key: 'urzadzenia', label: 'Urządzenia', perm: 'departments.view', order: 40, query: async (term, like) =>
  (await rows(`SELECT d.id, d.serial_no, d.type, d.model, d.location, b.name AS building FROM devices d LEFT JOIN buildings b ON b.id = d.building_id
      WHERE d.serial_no ILIKE $1 OR d.model ILIKE $1 ORDER BY d.serial_no LIMIT ${LIMIT}`, [like]))
    .map(d => ({ id: d.id, title: d.serial_no, sub: [d.model, d.building, d.location].filter(Boolean).join(' · '), link: `${D1}?tab=urzadzenia&q=${encodeURIComponent(d.serial_no)}` })) });
register({ key: 'projekty', label: 'Projekty i kontrakty', perm: 'tasks.use', order: 25, query: async (term, like) =>
  (await rows(`SELECT p.id, p.number, p.title, p.department_id, c.name AS customer FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.number ILIKE $1 OR p.title ILIKE $1 OR c.name ILIKE $1 ORDER BY p.created_at DESC LIMIT ${LIMIT}`, [like]))
    .map(p => ({ id: p.id, title: p.number + ' · ' + p.title, sub: p.customer || '', link: `${D1}?tab=rozliczenia&k=${p.id}` })) });
register({ key: 'odczyty', label: 'Odczyty', perm: 'readings.manage', order: 45, query: async (term, like) =>
  (await rows(`SELECT s.id, s.next_due, b.name, b.address, b.city FROM reading_schedules s JOIN buildings b ON b.id = s.building_id
      WHERE s.is_active AND (b.name ILIKE $1 OR b.address ILIKE $1) ORDER BY s.next_due LIMIT ${LIMIT}`, [like]))
    .map(s => ({ id: s.id, title: s.name, sub: 'kolejny odczyt ' + s.next_due + ' · ' + s.address, link: `/odczyty?z=${s.id}` })) });
register({ key: 'oferty', label: 'Oferty', perm: 'tasks.use', order: 60, query: async (term, like) =>
  (await rows(`SELECT o.id, o.number, o.title, o.department_id, c.name AS customer FROM offers o JOIN customers c ON c.id = o.customer_id
      WHERE o.number ILIKE $1 OR o.title ILIKE $1 ORDER BY o.created_at DESC LIMIT ${LIMIT}`, [like]))
    .map(o => ({ id: o.id, title: o.number + ' · ' + o.title, sub: o.customer, link: `/dzial/${o.department_id}?tab=oferty` })) });
register({ key: 'pracownicy', label: 'Pracownicy', perm: 'employees.manage', order: 70, query: async (term, like) =>
  (await rows(`SELECT id, login, full_name, position, phone FROM users WHERE login ILIKE $1 OR full_name ILIKE $1 OR phone ILIKE $1 ORDER BY is_active DESC, login LIMIT ${LIMIT}`, [like]))
    .map(u => ({ id: u.id, title: u.full_name || u.login, sub: [u.login, u.position, u.phone].filter(Boolean).join(' · '), link: '/pracownicy?p=' + u.id })) });

register({ key: 'polisy', label: 'Polisy', perm: 'insurance.manage', order: 15, query: async (term, like) =>
  (await rows(`SELECT v.id, v.number, v.insurer, v.insurance_type, v.end_date, v.customer_name FROM policies_v v
      WHERE v.number ILIKE $1 OR v.customer_name ILIKE $1 OR v.insurer ILIKE $1 ORDER BY v.end_date DESC LIMIT ${LIMIT}`, [like]))
    .map(p => ({ id: p.id, title: p.number + ' · ' + p.customer_name, sub: `${p.insurer} · ${p.insurance_type} · do ${String(p.end_date).slice(0, 10)}`, link: '/dzial/ubezpieczenia?tab=polisy&p=' + p.id })) });

register({ key: 'czesci', label: 'Części (produkty)', perm: 'parts.sell', order: 16, query: async (term, like) =>
  (await rows(`SELECT i.id, i.sku, i.name, i.catalog_no, i.manufacturer FROM stock_items i WHERE i.is_active AND (i.sku ILIKE $1 OR i.name ILIKE $1 OR i.catalog_no ILIKE $1
      OR EXISTS (SELECT 1 FROM unnest(i.replacement_nos) z WHERE z ILIKE $1)) ORDER BY i.name LIMIT ${LIMIT}`, [like]))
    .map(i => ({ id: i.id, title: i.sku + ' · ' + i.name, sub: [i.manufacturer, i.catalog_no && 'nr kat. ' + i.catalog_no].filter(Boolean).join(' · '), link: '/magazyn?p=' + i.id })) });
register({ key: 'zamowienia_czesci', label: 'Zamówienia części', perm: 'parts.sell', order: 17, query: async (term, like) =>
  (await rows(`SELECT o.id, o.number, o.vehicle, o.invoice_no, c.name FROM part_orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.number ILIKE $1 OR o.invoice_no ILIKE $1 OR o.vehicle ILIKE $1 OR c.name ILIKE $1 ORDER BY o.created_at DESC LIMIT ${LIMIT}`, [like]))
    .map(o => ({ id: o.id, title: o.number + ' · ' + o.name, sub: [o.vehicle, o.invoice_no && 'FV ' + o.invoice_no].filter(Boolean).join(' · '), link: '/dzial/sprzedaz-czesci-i-eksport?tab=zamowienia&o=' + o.id })) });

module.exports = { register, search };
