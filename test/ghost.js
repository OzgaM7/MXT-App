// Testy strefy GHOST: konto startowe, pierwsze ustawienie osobnego hasła (zasady, inne niż do MXT), logowanie,
// limit prób, odblokowanie tylko w bieżącej sesji, wylogowanie z GHOST i z MXT, rejestr operacji.
// Konta robocze t9.* (z kontami GHOST) są sprzątane na końcu; konto GHOST m.ozga zostaje bez zmian.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed++; };

(async () => {
  const PORT = require('./_setup').testPort(6500, 200), base = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, WORKERS: '0' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const call = async (p, body, cookie, method) => {
    const r = await fetch(base + '/api/' + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})), c: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const t0 = (await pool.query('SELECT now() AS t')).rows[0].t;
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  const users = [];
  const MXT_PASS = 'Mxt-Konto-2026x', GHOST_PASS = 'Duch-Haslo-2026';
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const hash = await bcrypt.hash(MXT_PASS, 4);
    const mk = async (login, ghost) => {
      const id = (await pool.query(`INSERT INTO users (login, password_hash, role, full_name, must_change_password) VALUES ($1, $2, 'uzytkownik', $3, false) RETURNING id`,
        [login, hash, '[T9] ' + login])).rows[0].id;
      users.push(id);
      if (ghost) await pool.query('INSERT INTO ghost_accounts (user_id) VALUES ($1)', [id]);
      return { id, login, c: (await call('login', { login, password: MXT_PASS })).c };
    };

    // ---------- konto startowe ----------
    ok((await pool.query(`SELECT 1 FROM ghost_accounts g JOIN users u ON u.id = g.user_id WHERE u.login = 'm.ozga'`)).rows.length, 'konto GHOST m.ozga utworzone migracją');
    const G = await mk('t9.ghost', true), N = await mk('t9.zwykly', false), L = await mk('t9.limit', true);
    eq((await call('ghost/stan', null)).s, 401, 'bez sesji MXT – brak dostępu');

    // ---------- konto bez GHOST ----------
    let r = await call('ghost/stan', null, N.c);
    ok(r.s === 200 && r.j.odblokowany === false && r.j.ustaw_haslo === false, 'konto bez GHOST: zwykły panel logowania (bez zdradzania braku konta)');
    eq((await call('ghost/haslo', { nowe: GHOST_PASS, powtorz: GHOST_PASS }, N.c)).s, 403, 'konto bez GHOST nie ustawi hasła');
    r = await call('ghost/login', { login: N.login, haslo: GHOST_PASS }, N.c);
    ok(r.s === 400 && r.j.error === 'Nieprawidłowy login lub hasło.', 'konto bez GHOST: odmowa (400, nie 401 – bez wylogowania z MXT)');
    eq((await call('ghost/panel', null, N.c)).s, 403, 'panel zablokowany');
    eq((await call('me', null, N.c)).s, 200, 'sesja MXT po odmowie nadal ważna');

    // ---------- pierwsze wejście: ustawienie hasła ----------
    r = await call('ghost/stan', null, G.c); ok(r.j.ustaw_haslo === true && r.j.odblokowany === false, 'właściciel bez hasła: ustaw hasło');
    eq((await call('ghost/panel', null, G.c)).s, 403, 'bez hasła – panel zablokowany');
    eq((await call('ghost/login', { login: G.login, haslo: '' }, G.c)).s, 400, 'bez hasła nie da się zalogować');
    r = await call('ghost/haslo', { nowe: 'krotkie1', powtorz: 'krotkie1' }, G.c); ok(r.s === 400 && r.j.error.includes('10 znaków'), 'zasady hasła');
    r = await call('ghost/haslo', { nowe: GHOST_PASS, powtorz: GHOST_PASS + 'x' }, G.c); ok(r.s === 400 && r.j.error.includes('Powtórzone'), 'powtórzenie musi się zgadzać');
    r = await call('ghost/haslo', { nowe: MXT_PASS, powtorz: MXT_PASS }, G.c); ok(r.s === 400 && r.j.error.includes('inne niż hasło do MXT'), 'hasło inne niż do MXT');
    r = await call('ghost/haslo', { nowe: GHOST_PASS, powtorz: GHOST_PASS }, G.c); eq(r.s, 201, 'hasło ustawione'); eq(r.j.odblokowany, true);
    const row = (await pool.query('SELECT password_hash FROM ghost_accounts WHERE user_id = $1', [G.id])).rows[0];
    ok(row.password_hash.startsWith('$2') && await bcrypt.compare(GHOST_PASS, row.password_hash), 'hasło jako bcrypt');
    eq((await call('ghost/haslo', { nowe: 'Inne-Haslo-2027', powtorz: 'Inne-Haslo-2027' }, G.c)).s, 409, 'drugi raz hasła nie ustawia się tą drogą');
    r = await call('ghost/panel', null, G.c); ok(r.s === 200 && r.j.witaj === '[T9] t9.ghost' && new Date(r.j.odblokowany_do) > new Date(), 'panel po odblokowaniu');

    // ---------- odblokowanie tylko w bieżącej sesji ----------
    const G2 = (await call('login', { login: G.login, password: MXT_PASS })).c;
    eq((await call('ghost/stan', null, G2)).j.odblokowany, false, 'inna sesja tego konta – zablokowana');
    eq((await call('ghost/panel', null, G2)).s, 403, 'inna sesja – panel zablokowany');

    // ---------- blokada i logowanie ----------
    r = await call('ghost/wyloguj', {}, G.c); eq(r.j.odblokowany, false, 'Zablokuj GHOST');
    eq((await call('ghost/panel', null, G.c)).s, 403, 'po zablokowaniu panel zablokowany');
    eq((await call('ghost/login', { login: G.login, haslo: 'zle-haslo-99' }, G.c)).s, 400, 'złe hasło');
    eq((await call('ghost/login', { login: N.login, haslo: GHOST_PASS }, G.c)).s, 400, 'cudzy login z dobrym hasłem – odmowa');
    eq((await call('ghost/login', { login: G.login, haslo: MXT_PASS }, G.c)).s, 400, 'hasło do MXT nie otwiera GHOST');
    r = await call('ghost/login', { login: ' T9.Ghost ', haslo: GHOST_PASS }, G.c); ok(r.s === 200 && r.j.odblokowany, 'logowanie (login bez rozróżniania wielkości liter)');
    eq((await call('ghost/panel', null, G.c)).s, 200, 'panel po zalogowaniu');

    // ---------- limit prób ----------
    await call('ghost/haslo', { nowe: GHOST_PASS, powtorz: GHOST_PASS }, L.c);
    await call('ghost/wyloguj', {}, L.c);
    for (let i = 0; i < 5; i++) await call('ghost/login', { login: L.login, haslo: 'zle-' + i }, L.c);
    r = await call('ghost/login', { login: L.login, haslo: GHOST_PASS }, L.c); eq(r.s, 429, 'po 5 błędach blokada, nawet z dobrym hasłem');
    eq((await call('me', null, L.c)).s, 200, 'blokada GHOST nie wylogowuje z MXT');

    // ---------- konto wyłączone ----------
    await pool.query('UPDATE ghost_accounts SET is_active = false WHERE user_id = $1', [G.id]);
    eq((await call('ghost/panel', null, G.c)).s, 403, 'wyłączone konto GHOST – panel zablokowany mimo odblokowania');
    eq((await call('ghost/stan', null, G.c)).j.odblokowany, false, 'wyłączone konto – stan zablokowany');
    await pool.query('UPDATE ghost_accounts SET is_active = true WHERE user_id = $1', [G.id]);

    // ---------- wylogowanie z MXT kończy GHOST ----------
    await call('logout', {}, G.c);
    eq((await call('ghost/stan', null, G.c)).s, 401, 'po wylogowaniu z MXT – brak dostępu');
    eq((await pool.query('SELECT count(*)::int n FROM sessions WHERE user_id = $1 AND ghost_until > now()', [G.id])).rows[0].n, 0, 'żadna sesja nie ma odblokowanego GHOST');

    // ---------- rejestr operacji ----------
    const acts = (await pool.query(`SELECT action, status FROM audit_logs WHERE ts >= $1 AND action LIKE 'ghost.%'`, [t0])).rows;
    ok(acts.some(a => a.action === 'ghost.haslo_ustawione') && acts.some(a => a.action === 'ghost.logowanie' && a.status === 'ok')
      && acts.some(a => a.action === 'ghost.logowanie' && a.status === 'odmowa') && acts.some(a => a.action === 'ghost.wylogowanie'), 'GHOST w rejestrze operacji');

    console.log(`OK: testy strefy GHOST przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    const q = (s, p = []) => pool.query(s, p).catch(e => console.error('sprzątanie:', e.message));
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM ghost_accounts WHERE user_id = ANY($1::uuid[])`, [users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await restoreFlags();
    await pool.end(); srv.kill();
  }
})();
