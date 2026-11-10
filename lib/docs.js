'use strict';
// Dokumenty z wersjami i numeracja. Pliki (PDF) przechowywane w bazie (document_versions.file_data) –
// warstwa jest wydzielona tak, by w kolejnym kroku przenieść pliki do S3/MinIO bez zmian w modułach.
const crypto = require('crypto');
const { pool } = require('../db');

async function nextNumber(client, prefix, date = new Date()) {
  const y = date.getFullYear(), k = prefix + '/' + y;
  const r = await client.query(`INSERT INTO doc_counters (k, n) VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET n = doc_counters.n + 1 RETURNING n`, [k]);
  return `${prefix}/${y}/${String(r.rows[0].n).padStart(3, '0')}`;
}

async function createDocument(client, { kind, title, department_id = null, related_type = null, related_id = null, for_agents = false, tags = [], userId = null }) {
  const r = await client.query(`INSERT INTO documents (kind, title, department_id, related_type, related_id, for_agents, tags, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [kind, String(title).slice(0, 300), department_id, related_type, related_id, !!for_agents, tags, userId]);
  return r.rows[0];
}

async function addVersion(client, documentId, { content = '', file = null, fileName = null, mime = null, note = '', userId = null, agentId = null }) {
  const d = (await client.query('SELECT current_version FROM documents WHERE id = $1 FOR UPDATE', [documentId])).rows[0];
  if (!d) throw new Error('Nie znaleziono dokumentu.');
  const v = d.current_version + 1;
  await client.query(`INSERT INTO document_versions (document_id, version, content, file_data, file_name, mime_type, file_size, sha256, note, created_by, created_by_agent)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [documentId, v, typeof content === 'string' ? content : JSON.stringify(content), file, fileName, mime, file ? file.length : null,
      file ? crypto.createHash('sha256').update(file).digest('hex') : null, String(note || '').slice(0, 500), userId, agentId]);
  await client.query('UPDATE documents SET current_version = $2, updated_at = now() WHERE id = $1', [documentId, v]);
  return v;
}

async function getVersion(documentId, version) {
  const r = await pool.query(`SELECT v.*, d.title, d.kind, d.current_version FROM document_versions v JOIN documents d ON d.id = v.document_id
    WHERE v.document_id = $1 AND v.version = coalesce($2, d.current_version)`, [documentId, version || null]);
  return r.rows[0] || null;
}

const isPdf = buf => Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

module.exports = { nextNumber, createDocument, addVersion, getVersion, isPdf };
