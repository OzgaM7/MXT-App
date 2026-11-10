'use strict';
const { Pool, types } = require('pg');
// Kolumny typu date zwracane jako tekst RRRR-MM-DD (bez przesunięć strefy czasowej).
types.setTypeParser(1082, v => v);

if (!process.env.DATABASE_URL) {
  console.error('Brak DATABASE_URL. Skopiuj .env.example do .env i uzupełnij adres bazy.');
  process.exit(1);
}

// Supabase i większość chmurowych baz wymaga SSL; lokalny Postgres zwykle nie.
const ssl = process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });

module.exports = { pool };
