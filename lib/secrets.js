'use strict';
// Szyfrowanie sekretów integracji (np. klucz podpisu webhooków n8n) algorytmem AES-256-GCM.
// Klucz: MXT_SECRET_KEY (zalecane, 32+ znaki) albo – gdy brak – klucz wygenerowany i zapisany w system_settings.
const crypto = require('crypto');
const { pool } = require('../db');

let key = null;
async function getKey() {
  if (key) return key;
  if (process.env.MXT_SECRET_KEY && process.env.MXT_SECRET_KEY.length >= 32) return (key = crypto.createHash('sha256').update(process.env.MXT_SECRET_KEY).digest());
  const r = await pool.query(`SELECT value FROM system_settings WHERE key = 'secret_key'`);
  let k = r.rows[0] && r.rows[0].value.k;
  if (!k) {
    k = crypto.randomBytes(32).toString('base64');
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ('secret_key', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ k })]);
    k = (await pool.query(`SELECT value FROM system_settings WHERE key = 'secret_key'`)).rows[0].value.k;
  }
  return (key = Buffer.from(k, 'base64'));
}
async function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
async function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', await getKey(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');

module.exports = { encrypt, decrypt, sha };
