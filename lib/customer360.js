'use strict';
// Karta klienta 360°: moduły dopisują swoje sekcje (zlecenia, odczyty, polisy, zamówienia…) – jedna kartoteka klientów dla całej firmy.
const { pool } = require('../db');
const { can } = require('./rbac');

const sections = [];
/** @param {{key:string,perm:string,query:(customerId:string)=>Promise<any[]>}} s */
function register(s) { if (!sections.some(x => x.key === s.key)) sections.push(s); }
async function load(user, customerId) {
  const out = {};
  await Promise.all(sections.filter(s => can(user, s.perm)).map(async s => { out[s.key] = await s.query(customerId); }));
  return out;
}
const rows = async (sql, p) => (await pool.query(sql, p)).rows;

register({ key: 'service_orders', perm: 'service.manage', query: id => rows(`SELECT id, number, status, received_at, due_date, assign_due, description, address, unit
  FROM service_orders WHERE customer_id = $1 OR building_id IN (SELECT id FROM buildings WHERE customer_id = $1) ORDER BY received_at DESC LIMIT 100`, [id]) });
register({ key: 'installations', perm: 'departments.view', query: id => rows(`SELECT x.id, x.number, x.status, x.planned_date, x.planned_end, x.devices_planned, b.name AS building_name
  FROM installations x JOIN buildings b ON b.id = x.building_id WHERE b.customer_id = $1 ORDER BY x.planned_date DESC LIMIT 100`, [id]) });
register({ key: 'reading_schedules', perm: 'readings.manage', query: id => rows(`SELECT s.id, s.next_due, s.last_done, s.scope, s.is_active, b.name AS building_name
  FROM reading_schedules s JOIN buildings b ON b.id = s.building_id WHERE s.customer_id = $1 OR b.customer_id = $1 ORDER BY s.next_due LIMIT 100`, [id]) });
register({ key: 'documents', perm: 'tasks.use', query: id => rows(`SELECT id, kind, title, current_version, created_at FROM documents
  WHERE related_type = 'customer' AND related_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]) });

register({ key: 'policies', perm: 'insurance.manage', query: async id => (await rows(`SELECT id, number, insurer, insurance_type, start_date, end_date,
  total_amount::float AS total_amount, profit::float AS profit, status FROM policies_v WHERE customer_id = $1 ORDER BY end_date DESC LIMIT 200`, [id]))
  .map(p => ({ ...p, status_label: { aktywna: 'Aktywna', konczy_sie: 'Zbliża się koniec', zakonczona: 'Zakończona', odnowiona: 'Odnowiona' }[p.status] })) });

module.exports = { register, load };
