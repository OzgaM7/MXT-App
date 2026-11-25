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
// Strefa czasowa sesji: Polska. Baza w chmurze działa w UTC, więc bez tego current_date między 0:00 a 1:00 (latem 2:00)
// czasu polskiego dawało wczorajszą datę (dokumenty, faktury, przyjęcia wystawione tuż po północy poza zestawieniem „dziś”).
// Znaczniki czasu (timestamptz) się nie zmieniają – to ta sama chwila, inna jest tylko data „dziś”.
// Parametr startowy połączenia (standard PostgreSQL). Za pulą połączeń, która go nie przyjmuje (np. pgbouncer w trybie
// transakcji), ustaw DB_TIMEZONE= (puste) i strefę bazy poleceniem ALTER DATABASE … SET timezone = 'Europe/Warsaw'.
const tz = process.env.DB_TIMEZONE === undefined ? 'Europe/Warsaw' : process.env.DB_TIMEZONE;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10, ...(tz ? { options: `-c timezone=${tz.replace(/[^\w/+-]/g, '')}` } : {}) });
// Zerwanie bezczynnego połączenia (restart lub konserwacja bazy, przerwa w sieci) emituje zdarzenie „error”.
// Bez obsługi Node zatrzymałby cały serwer; pula sama otworzy nowe połączenie przy następnym zapytaniu.
pool.on('error', err => console.error('Baza danych: zerwane połączenie w puli –', err.message));

module.exports = { pool };
