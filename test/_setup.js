// Wspólne przygotowanie testów: konta startowe mają must_change_password = true, co blokuje moduły do czasu zmiany hasła.
// Testy modułów zdejmują flagę na czas działania i przywracają ją na końcu (hasła pozostają bez zmian).
'use strict';
async function relaxPasswordFlags(pool) {
  const saved = (await pool.query('SELECT id, must_change_password FROM users')).rows;
  await pool.query('UPDATE users SET must_change_password = false');
  return async () => { for (const u of saved) await pool.query('UPDATE users SET must_change_password = $2 WHERE id = $1', [u.id, u.must_change_password]).catch(() => {}); };
}
module.exports = { relaxPasswordFlags };
