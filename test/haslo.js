// Testy wymuszonej zmiany hasła przy pierwszym logowaniu i resetu hasła przez administratora (npm test).
// Hasła i flagi kont są zapisywane na początku i przywracane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };

(async () => {
  const PORT = 5600 + Math.floor(Math.random() * 300), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => { const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})), c: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  const saved = (await pool.query('SELECT id, password_hash, must_change_password FROM users')).rows;
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  try {
    await pool.query(`UPDATE users SET must_change_password = true WHERE login IN ('m.ozga', 'm.ozga1')`);
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const login = async (l, p = '1234') => call('login', { login: l, password: p });

    // --- pierwsze logowanie: dostęp tylko do zmiany hasła ---
    let r = await login('m.ozga1'); eq(r.s, 200); eq(r.j.mustChangePassword, true, 'flaga w odpowiedzi logowania');
    const U = r.c, U2 = (await login('m.ozga1')).c;            // druga sesja (inne urządzenie)
    eq((await call('me', null, U)).j.mustChangePassword, true);
    for (const p of ['command-center', 'meta', 'tasks', 'ai/agenci', 'd1/budynki', 'szkolenia/kursy', 'bi']) {
      r = await call(p, null, U); eq(r.s, 403, `/api/${p} zablokowane przed zmianą hasła`); eq(r.j.code, 'must_change_password');
    }
    eq((await call('tasks', { title: 'x' }, U)).s, 403, 'zapis też zablokowany');

    // --- polityka haseł (serwer) ---
    eq((await call('haslo', { obecne: 'zle', nowe: 'Zielona-Gora27' }, U)).s, 400, 'błędne obecne hasło');
    for (const [p, why] of [['krotkie1', 'za krótkie'], ['bezcyfrhaslo', 'bez cyfry'], ['1234567890', 'popularne'], ['qwerty12345', 'popularne'], ['Mozga1-tajne99', 'zawiera login'], ['98765432101!', 'bez liter']]) {
      r = await call('haslo', { obecne: '1234', nowe: p }, U); eq(r.s, 400, `${p}: ${why}`); ok(r.j.problems && r.j.problems.length, 'lista niespełnionych wymagań');
    }
    eq((await call('haslo', { obecne: '1234', nowe: 'Zielona-Gora27', powtorz: 'Zielona-Gora28' }, U)).s, 400, 'powtórzenie musi się zgadzać');
    r = await call('haslo', { obecne: '1234', nowe: 'Zielona-Gora27', powtorz: 'Zielona-Gora27' }, U);
    eq(r.s, 200); eq(r.j.mustChangePassword, false);
    eq((await call('command-center', null, U)).s, 200, 'po zmianie dostęp do modułów');
    eq((await call('me', null, U2)).s, 401, 'pozostałe sesje wylogowane');
    eq((await login('m.ozga1')).s, 401, 'stare hasło nie działa');
    r = await login('m.ozga1', 'Zielona-Gora27'); eq(r.s, 200); eq(r.j.mustChangePassword, false, 'kolejne logowanie bez wymuszenia');
    const hash = (await pool.query(`SELECT password_hash FROM users WHERE login = 'm.ozga1'`)).rows[0].password_hash;
    ok(hash.startsWith('$2') && !hash.includes('Zielona'), 'hasło zapisane jako hash bcrypt');
    // dobrowolna zmiana: nowe musi różnić się od obecnego
    eq((await call('haslo', { obecne: 'Zielona-Gora27', nowe: 'Zielona-Gora27' }, r.c)).s, 400, 'nowe = obecne');

    // --- limit błędnych prób ---
    const K = (await login('k.kretkowska')).c;
    for (let i = 0; i < 5; i++) await call('haslo', { obecne: 'zle' + i, nowe: 'Bezpieczne-Haslo77' }, K);
    eq((await call('haslo', { obecne: '1234', nowe: 'Bezpieczne-Haslo77' }, K)).s, 429, 'limit prób zmiany hasła');

    // --- reset hasła przez administratora ---
    let A = (await login('m.ozga')).c;
    eq((await call('konta', null, A)).s, 403, 'administrator też najpierw zmienia hasło startowe');
    eq((await call('haslo', { obecne: '1234', nowe: 'Admin-Mxt-2026x' }, A)).s, 200);
    eq((await call('konta', null, A)).s, 200);
    eq((await call('konta/' + saved[0].id + '/reset-hasla', {}, K)).s, 403, 'użytkownik nie resetuje haseł (zablokowany flagą)');
    const uid = (await pool.query(`SELECT id FROM users WHERE login = 'm.ozga1'`)).rows[0].id;
    const Uok = (await login('m.ozga1', 'Zielona-Gora27')).c;
    r = await call(`konta/${uid}/reset-hasla`, {}, A); eq(r.s, 200); const temp = r.j.temporary_password;
    ok(temp.length === 12 && /\d/.test(temp) && /[A-Za-z]/.test(temp), 'hasło tymczasowe');
    eq((await call('me', null, Uok)).s, 401, 'reset wylogowuje konto');
    r = await login('m.ozga1', temp); eq(r.s, 200); eq(r.j.mustChangePassword, true, 'po resecie wymuszona zmiana');
    eq((await call('tasks', null, r.c)).s, 403);
    eq((await call('haslo', { obecne: temp, nowe: 'Nowe-Haslo-2027' }, r.c)).s, 200);
    const self = (await pool.query(`SELECT id FROM users WHERE login = 'm.ozga'`)).rows[0].id;
    eq((await call(`konta/${self}/reset-hasla`, {}, A)).s, 400, 'własnego hasła nie resetuje się tą drogą');
    await pool.query(`UPDATE users SET must_change_password = false WHERE login = 'k.kretkowska'`);
    const K2 = (await login('k.kretkowska')).c;
    eq((await call(`konta/${uid}/reset-hasla`, {}, K2)).s, 403, 'użytkownik bez uprawnień – 403');
    const au = await pool.query(`SELECT action, status FROM audit_logs WHERE ts >= $1 AND action IN ('haslo.zmiana', 'haslo.reset')`, [t0]);
    ok(au.rows.some(x => x.action === 'haslo.reset') && au.rows.some(x => x.action === 'haslo.zmiana' && x.status === 'odmowa') && au.rows.filter(x => x.action === 'haslo.zmiana' && x.status === 'ok').length >= 3, 'zmiany i resety w rejestrze');
    console.log(`OK: testy zmiany hasła przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    for (const u of saved) await pool.query('UPDATE users SET password_hash = $2, must_change_password = $3 WHERE id = $1', [u.id, u.password_hash, u.must_change_password]).catch(() => {});
    await pool.query(`DELETE FROM sessions WHERE created_at >= $1`, [t0]).catch(() => {});
    await pool.end(); srv.kill();
  }
})();
