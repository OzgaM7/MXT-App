// Testy API: npm test (wymaga DATABASE_URL i wykonanej migracji). Uruchamia serwer na wolnym porcie.
// Dane testowe (zadania, wnioski, reguły) są oznaczone prefiksem [TEST] i usuwane na końcu.
'use strict';
const { spawn } = require('child_process'), assert = require('assert/strict'), path = require('path');
const PORT = 3900 + Math.floor(Math.random() * 90), URL = 'http://localhost:' + PORT;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); passed++; };

async function call(p, body, cookie, method) {
  const r = await fetch(URL + '/api/' + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { s: r.status, j: await r.json().catch(() => ({})), c: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async l => { const r = await call('login', { login: l, password: '1234' }); eq(r.s, 200, 'logowanie ' + l); return { cookie: r.c, user: r.j }; };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: ['ignore', 'ignore', 'inherit'] });
  const { pool } = require('../db');
  const restoreFlags = await require('./_setup').relaxPasswordFlags(pool);
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(URL + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

    // --- 1. logowanie (bez zmian względem etapu 0) ---
    eq((await call('me')).s, 401, 'bez sesji 401');
    let r = await call('login', { login: 'm.ozga', password: 'zle' });
    eq(r.s, 401); eq(r.j.error, 'Nieprawidłowy login lub hasło');
    r = await call('login', { login: 'nieznany', password: '1234' });
    eq(r.s, 401); eq(r.j.error, 'Nieprawidłowy login lub hasło');
    const S = {};
    for (const l of ['m.ozga', 'p.krajewski', 'm.ozga1', 'k.kretkowska']) S[l] = await login(l);
    eq(S['m.ozga'].user.role, 'administrator'); eq(S['p.krajewski'].user.role, 'administrator');
    eq(S['m.ozga1'].user.role, 'uzytkownik'); eq(S['k.kretkowska'].user.role, 'uzytkownik');
    r = await call('me', null, S['k.kretkowska'].cookie); eq(r.s, 200); eq(r.j.login, 'k.kretkowska');

    // --- 2. RBAC: użytkownicy bez dostępu do Ustawień AI, Approval Center, Security & Audit (bezpośrednie API) ---
    const ADMIN_ONLY = [['ai-settings'], ['approvals'], ['approvals?status=oczekuje'], ['approval-rules'], ['audit'], ['security/agents-stop'],
      ['security/agents-stop', { stopped: true, reason: 'x' }], ['approval-rules', { operation_type: 'cena.zmiana', max_amount: 1, max_per_day: 1, valid_until: '2099-01-01' }]];
    for (const l of ['m.ozga1', 'k.kretkowska']) {
      for (const [p, b] of ADMIN_ONLY) eq((await call(p, b, S[l].cookie)).s, 403, `${l} → ${b ? 'POST' : 'GET'} /api/${p} = 403`);
      ok(!S[l].user.permissions.includes('approvals.decide') && !S[l].user.permissions.includes('ai.settings'), l + ': brak uprawnień admina w sesji');
    }
    for (const l of ['m.ozga', 'p.krajewski']) {
      eq((await call('ai-settings', null, S[l].cookie)).s, 200, l + ' → Ustawienia AI');
      eq((await call('approvals', null, S[l].cookie)).s, 200, l + ' → Approval Center');
      eq((await call('audit', null, S[l].cookie)).s, 200, l + ' → Security & Audit');
    }
    const denied = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE status = 'odmowa' AND action = 'odmowa_dostepu'
      AND actor_label IN ('m.ozga1','k.kretkowska') AND ts > now() - interval '1 minute'`);
    ok(denied.rows[0].n >= ADMIN_ONLY.length * 2, 'odmowy zapisane w audit_logs');
    eq((await call('command-center', null, S['m.ozga1'].cookie)).s, 200, 'użytkownik widzi Command Center');
    eq((await fetch(URL + '/api/tasks', { method: 'POST', headers: { Cookie: S['m.ozga1'].cookie, 'Content-Type': 'text/plain' }, body: 'x' })).status, 415, 'CSRF: tylko JSON');

    // --- 3. zadania ---
    const U = S['m.ozga1'], K = S['k.kretkowska'], A = S['m.ozga'];
    r = await call('tasks', { title: '[TEST] Zadanie', department_id: 'podzielniki-i-montaze', priority: 'pilny', assignee_id: K.user.id, due_date: '2020-01-01' }, U.cookie);
    eq(r.s, 201); const task = r.j; ok(task.overdue, 'po terminie');
    eq((await call('tasks/' + task.id, { status: 'w_toku' }, K.cookie, 'PATCH')).s, 200, 'osoba przypisana zmienia status');
    eq((await call('tasks/' + task.id, null, K.cookie, 'DELETE')).s, 403, 'osoba przypisana nie usuwa');
    r = await call('tasks', { title: '[TEST] Prywatne' }, A.cookie);
    eq((await call('tasks/' + r.j.id, { title: 'zmiana' }, U.cookie, 'PATCH')).s, 403, 'cudze zadanie – 403');
    eq((await call('tasks/' + r.j.id, null, A.cookie, 'DELETE')).s, 200);

    // --- 4. Approval Center: poziom 2 ---
    r = await call('approvals', { operation_type: 'wydatek', title: '[TEST] Zakup narzędzi', amount: 1200, currency: 'PLN' }, U.cookie);
    eq(r.s, 201); const ap = r.j; eq(ap.status, 'oczekuje'); eq(ap.level, 2);
    eq((await call('approvals', { operation_type: 'analiza.raport', title: '[TEST] x' }, U.cookie)).s, 400, 'użytkownik nie zgłasza operacji agentów');
    eq((await call(`approvals/${ap.id}/wykonaj`, {}, U.cookie)).s, 409, 'wykonanie bez zgody zablokowane');
    eq((await call(`approvals/${ap.id}/decyzja`, { decision: 'zatwierdz', version: 1 }, U.cookie)).s, 403, 'użytkownik nie zatwierdza');
    eq((await call(`approvals/${ap.id}/decyzja`, { decision: 'zatwierdz', version: 1 }, K.cookie)).s, 403, 'inny użytkownik nie zatwierdza');
    eq((await call(`approvals/${ap.id}`, { amount: 1500 }, U.cookie, 'PATCH')).j.version, 2, 'zmiana treści = nowa wersja');
    eq((await call(`approvals/${ap.id}/decyzja`, { decision: 'zatwierdz', version: 1 }, A.cookie)).s, 409, 'decyzja na starej wersji zablokowana');
    r = await call(`approvals/${ap.id}/decyzja`, { decision: 'zatwierdz', version: 2, note: 'OK' }, A.cookie);
    eq(r.s, 200); eq(r.j.status, 'zatwierdzona'); eq(r.j.decided_by, A.user.id); eq(r.j.decided_version, 2);
    eq((await call(`approvals/${ap.id}`, { amount: 99999 }, U.cookie, 'PATCH')).s, 409, 'po zatwierdzeniu treści nie można zmienić');
    await pool.query(`UPDATE approvals SET amount = 99999 WHERE id = $1`, [ap.id]);       // manipulacja bezpośrednio w bazie
    eq((await call(`approvals/${ap.id}/wykonaj`, {}, U.cookie)).s, 409, 'zmieniona treść – wykonanie zablokowane');
    await pool.query(`UPDATE approvals SET amount = 1500 WHERE id = $1`, [ap.id]);
    r = await call(`approvals/${ap.id}/wykonaj`, {}, U.cookie); eq(r.s, 200); eq(r.j.status, 'wykonana');
    eq((await call(`approvals/${ap.id}/wykonaj`, {}, U.cookie)).s, 409, 'nie wykona się drugi raz');
    const hist = (await call('approvals?status=historia', null, A.cookie)).j.find(x => x.id === ap.id).history.map(e => e.event);
    eq(hist.join(','), 'utworzenie,zmiana,zatwierdzenie,wykonanie', 'historia akceptacji');

    // --- 5. poziom 3: reguła tylko dla operacji odwracalnych, w limitach ---
    eq((await call('approval-rules', { operation_type: 'wydatek', max_amount: 100, max_per_day: 1, valid_until: '2099-01-01' }, A.cookie)).s, 400, 'wydatek nieodwracalny – brak poziomu 3');
    const until = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    r = await call('approval-rules', { operation_type: 'rabat.udziel', description: '[TEST] reguła', max_amount: 200, currency: 'PLN', max_per_day: 1, valid_until: until }, A.cookie);
    eq(r.s, 201); const rule = r.j;
    r = await call('approvals', { operation_type: 'rabat.udziel', title: '[TEST] Rabat 150', amount: 150 }, U.cookie);
    eq(r.j.level, 3); eq(r.j.status, 'zatwierdzona', 'auto-zatwierdzenie w limicie');
    r = await call('approvals', { operation_type: 'rabat.udziel', title: '[TEST] Rabat 100', amount: 100 }, U.cookie);
    eq(r.j.status, 'oczekuje', 'limit dzienny przekroczony – ręczna decyzja');
    r = await call('approvals', { operation_type: 'rabat.udziel', title: '[TEST] Rabat 500', amount: 500 }, U.cookie);
    eq(r.j.status, 'oczekuje', 'powyżej limitu kwoty – ręczna decyzja');
    eq((await call(`approval-rules/${rule.id}/wylacz`, {}, A.cookie)).s, 200);

    // --- 6. twarde reguły w kodzie: agent nie zatwierdza; wyłącznik zatrzymuje agentów ---
    const ops = require('../lib/operations');
    const agent = { type: 'agent', id: 'ceo', name: 'CEO', role: 'administrator' };   // nawet z rolą „administrator”
    await assert.rejects(ops.decide(agent, ap.id, { decision: 'zatwierdz', version: 2 }), e => e.status === 403); passed++;
    const ag = await ops.requestOperation(agent, { operation_type: 'dokument.przygotuj', title: '[TEST] szkic oferty' });
    eq(ag.status, 'wykonana', 'poziom 1 – agent samodzielnie');
    await assert.rejects(ops.requestOperation(agent, { operation_type: 'oferta.wyslij', title: '[TEST] wysyłka bez oferty' }), e => e.status === 400); passed++;
    const ag2 = await ops.requestOperation(agent, { operation_type: 'wydatek', title: '[TEST] wydatek agenta', amount: 50 });
    eq(ag2.status, 'oczekuje', 'poziom 2 od agenta czeka na administratora');
    await assert.rejects(ops.execute(agent, ag2.id), e => e.status === 409); passed++;
    eq((await call('security/agents-stop', { stopped: true, reason: '[TEST]' }, A.cookie)).s, 200);
    await assert.rejects(ops.requestOperation(agent, { operation_type: 'analiza.raport', title: '[TEST] x' }), e => e.status === 423); passed++;
    eq((await call('security/agents-stop', { stopped: false, reason: '[TEST]' }, A.cookie)).s, 200);
    eq((await call('command-center', null, A.cookie)).j.kpi.agenci_zatrzymani, false);

    // --- 7. wylogowanie ---
    eq((await call('logout', {}, K.cookie)).s, 200);
    eq((await call('me', null, K.cookie)).s, 401);
    console.log(`OK: wszystkie testy przeszły (${passed} sprawdzeń)`);
  } catch (e) { console.error('BŁĄD', e); process.exitCode = 1; }
  finally {
    await pool.query(`DELETE FROM tasks WHERE title LIKE '[TEST]%'`).catch(() => {});
    await pool.query(`DELETE FROM approvals WHERE title LIKE '[TEST]%'`).catch(() => {});
    await pool.query(`DELETE FROM approval_rules WHERE description LIKE '[TEST]%'`).catch(() => {});
    await restoreFlags(); await pool.end(); srv.kill();
  }
})();
