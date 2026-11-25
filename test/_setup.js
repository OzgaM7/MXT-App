// Wspólne przygotowanie testów: konta startowe mają must_change_password = true, co blokuje moduły do czasu zmiany hasła.
// Testy modułów zdejmują flagę na czas działania i przywracają ją na końcu (hasła pozostają bez zmian).
'use strict';
async function relaxPasswordFlags(pool) {
  const saved = (await pool.query('SELECT id, must_change_password FROM users')).rows;
  await pool.query('UPDATE users SET must_change_password = false');
  return async () => { for (const u of saved) await pool.query('UPDATE users SET must_change_password = $2 WHERE id = $1', [u.id, u.must_change_password]).catch(() => {}); };
}
// Porty zablokowane przez fetch (standard WHATWG „bad ports”, np. 6000 X11, 6665–6669 IRC) – losowy port testu nie może na nie trafić.
const BAD_PORTS = new Set([4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
function testPort(base, span) { let p; do { p = base + Math.floor(Math.random() * span); } while (BAD_PORTS.has(p)); return p; }
// Data „dziś + n dni” wg czasu polskiego (jak w aplikacji). Data UTC różni się od polskiej między 23:00 a 1:00 UTC – testy oparte na niej
// losowo nie przechodziły tuż po północy.
const warsawDay = (n = 0) => { const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
module.exports = { relaxPasswordFlags, testPort, BAD_PORTS, warsawDay };
