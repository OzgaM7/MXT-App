// Tworzy tabele (db/*.sql, w kolejności nazw) i zakłada konta startowe.
'use strict';
const fs = require('fs'), path = require('path');
const { pool } = require('../db');

(async () => {
  const dir = path.join(__dirname, '..', 'db');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log('Wykonano', f);
  }
  const r = await pool.query('SELECT login, must_change_password FROM users ORDER BY login');
  console.table(r.rows);
  await pool.end();
})().catch(async e => { console.error('Błąd migracji:', e.message); await pool.end().catch(() => {}); process.exit(1); });
