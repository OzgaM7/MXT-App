'use strict';
// Data „dziś” (+/− n dni) wg czasu polskiego, w formacie RRRR-MM-DD – tak samo jak w bazie (strefa sesji Europe/Warsaw).
// new Date().toISOString() daje datę UTC, która między 0:00 a 1:00 (latem 2:00) czasu polskiego jest jeszcze wczorajsza:
// faktury, terminy płatności i dokumenty wystawione tuż po północy dostawały wtedy datę z poprzedniego dnia.
const TZ = 'Europe/Warsaw';
function plToday(n = 0) {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }) + 'T12:00:00Z');
  if (n) d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
module.exports = { plToday, TZ };
