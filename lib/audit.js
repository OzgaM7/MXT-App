'use strict';
const { pool } = require('../db');

// Zapis do rejestru operacji. `req` może być żądaniem HTTP (z req.user) albo obiektem { user, ip }.
async function audit(req, action, { status = 'ok', resource = null, resourceId = null, details = {}, actor = null, client = pool } = {}) {
  const u = actor || (req && req.user) || null;
  const actorType = u ? (u.type === 'agent' ? 'agent' : u.type === 'system' ? 'system' : 'user') : 'anonim';
  await client.query(
    `INSERT INTO audit_logs (actor_type, actor_id, actor_label, action, resource, resource_id, status, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actorType, u ? String(u.id) : null, u ? (u.login || u.name || null) : null, action, resource,
      resourceId == null ? null : String(resourceId), status, (req && req.ip) || null, JSON.stringify(details || {})]);
}

module.exports = { audit };
