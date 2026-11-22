'use strict';
// API modułów MXT Business OS (etap 1). req.user jest ustawiony przez server.js; uprawnienia – requirePerm().
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm, can, PERMISSIONS, ROLES } = require('../lib/rbac');
const ops = require('../lib/operations');
const catalog = require('../lib/ai/catalog');

const r = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e instanceof ops.PolicyError) return res.status(e.status).json({ error: e.message });
  if (e && e.code === '22P02') return res.status(400).json({ error: 'Nieprawidłowy identyfikator.' });
  if (e && e.code === '23514') return res.status(400).json({ error: 'Nieprawidłowe dane.' });
  if (e && e.code === '23503') return res.status(400).json({ error: 'Nieprawidłowe powiązanie (np. dział).' });
  next(e);
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (req, res, next) => UUID.test(req.params.id) ? next() : res.status(404).json({ error: 'Nie znaleziono.' });

// ---------- słowniki ----------
r.get('/meta', requirePerm('departments.view'), wrap(async (req, res) => {
  const [d, u, ag] = await Promise.all([
    pool.query('SELECT id, name FROM departments ORDER BY sort_order'),
    pool.query('SELECT id, login, full_name, role, extra_roles, is_active FROM users ORDER BY is_active DESC, login'),
    pool.query(`SELECT a.id, s.display_name, a.title, a.department_id, s.is_active FROM agents a JOIN agent_settings s ON s.agent_id = a.id ORDER BY a.sort_order`).catch(() => ({ rows: [] }))
  ]);
  res.json({
    departments: d.rows, users: u.rows, roles: ROLES, agents: ag.rows,
    permissions: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, { label: v.label, roles: v.roles }])),
    levels: ops.LEVELS,
    operations: Object.fromEntries(Object.entries(ops.OPERATIONS).map(([k, v]) => [k, { ...v, requestable: ops.REQUESTABLE_BY_USER.includes(k) }]))
  });
}));

// ---------- zadania ----------
const TASK_STATUS = ['nowe', 'w_toku', 'zakonczone', 'anulowane'], PRIORITY = ['niski', 'normalny', 'wysoki', 'pilny'];
function taskInput(b, partial) {
  const o = {};
  if (!partial || b.title !== undefined) { o.title = String(b.title || '').trim().slice(0, 200); if (!o.title) throw new ops.PolicyError(400, 'Podaj tytuł zadania.'); }
  if (b.description !== undefined) o.description = String(b.description || '').slice(0, 5000);
  if (b.department_id !== undefined) o.department_id = b.department_id || null;
  if (b.status !== undefined) { if (!TASK_STATUS.includes(b.status)) throw new ops.PolicyError(400, 'Nieznany status.'); o.status = b.status; }
  if (b.priority !== undefined) { if (!PRIORITY.includes(b.priority)) throw new ops.PolicyError(400, 'Nieznany priorytet.'); o.priority = b.priority; }
  if (b.due_date !== undefined) { if (b.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) throw new ops.PolicyError(400, 'Nieprawidłowy termin.'); o.due_date = b.due_date || null; }
  if (b.assignee_id !== undefined) {
    const v = b.assignee_id ? String(b.assignee_id) : null;
    if (v && !UUID.test(v) && !catalog.byId(v)) throw new ops.PolicyError(400, 'Nieznana osoba lub agent.');
    o.assignee_type = v ? (UUID.test(v) ? 'user' : 'agent') : null; o.assignee_id = v;
  }
  return o;
}
const TASK_SELECT = `SELECT t.*, d.name AS department_name, cu.login AS created_by_login, coalesce(au.login, ags.display_name) AS assignee_login,
  (t.due_date < current_date AND t.status IN ('nowe','w_toku')) AS overdue
  FROM tasks t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users au ON t.assignee_type = 'user' AND au.id::text = t.assignee_id
  LEFT JOIN agent_settings ags ON t.assignee_type = 'agent' AND ags.agent_id = t.assignee_id`;

r.get('/tasks', requirePerm('tasks.use'), wrap(async (req, res) => {
  const w = [], p = [];
  if (req.query.scope === 'moje') { p.push(String(req.user.id)); w.push(`(t.assignee_id = $${p.length} OR t.created_by::text = $${p.length})`); }
  if (TASK_STATUS.includes(req.query.status)) { p.push(req.query.status); w.push(`t.status = $${p.length}`); }
  else if (req.query.status === 'otwarte') w.push(`t.status IN ('nowe','w_toku')`);
  if (req.query.department) { p.push(String(req.query.department)); w.push(`t.department_id = $${p.length}`); }
  const q = await pool.query(TASK_SELECT + (w.length ? ' WHERE ' + w.join(' AND ') : '') +
    ` ORDER BY (t.status IN ('zakonczone','anulowane')), t.due_date NULLS LAST, array_position(ARRAY['pilny','wysoki','normalny','niski'], t.priority), t.created_at DESC LIMIT 300`, p);
  res.json(q.rows);
}));

r.post('/tasks', requirePerm('tasks.use'), wrap(async (req, res) => {
  const o = taskInput(req.body || {}, false);
  const q = await pool.query(
    `INSERT INTO tasks (title, description, department_id, status, priority, due_date, assignee_type, assignee_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [o.title, o.description || '', o.department_id || null, o.status || 'nowe', o.priority || 'normalny', o.due_date || null, o.assignee_type || null, o.assignee_id || null, req.user.id]);
  await audit(req, 'zadanie.utworzenie', { resource: 'tasks', resourceId: q.rows[0].id, details: { tytul: o.title } });
  require('../lib/events').emit('zadanie.utworzone', { tytul: o.title, dzial: o.department_id || '', priorytet: o.priority || 'normalny' });
  res.status(201).json((await pool.query(TASK_SELECT + ' WHERE t.id = $1', [q.rows[0].id])).rows[0]);
}));

async function loadTaskFor(req, mode) {
  const t = (await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
  if (!t) throw new ops.PolicyError(404, 'Nie znaleziono zadania.');
  const mine = String(t.created_by) === String(req.user.id) || t.assignee_id === String(req.user.id);
  const allowed = req.user.role === 'administrator' || (mode === 'edit' ? mine : String(t.created_by) === String(req.user.id));
  if (!allowed) {
    await audit(req, 'odmowa_dostepu', { status: 'odmowa', resource: 'tasks', resourceId: t.id, details: { operacja: mode } });
    throw new ops.PolicyError(403, mode === 'edit' ? 'Zadanie może zmienić autor, osoba przypisana albo administrator.' : 'Zadanie może usunąć autor albo administrator.');
  }
  return t;
}

r.patch('/tasks/:id', idParam, requirePerm('tasks.use'), wrap(async (req, res) => {
  await loadTaskFor(req, 'edit');
  const o = taskInput(req.body || {}, true), keys = Object.keys(o);
  if (!keys.length) throw new ops.PolicyError(400, 'Brak zmian.');
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (o.status) sets.push(`completed_at = ${o.status === 'zakonczone' ? 'now()' : 'NULL'}`);
  await pool.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [req.params.id, ...keys.map(k => o[k])]);
  await audit(req, 'zadanie.zmiana', { resource: 'tasks', resourceId: req.params.id, details: o });
  res.json((await pool.query(TASK_SELECT + ' WHERE t.id = $1', [req.params.id])).rows[0]);
}));

r.delete('/tasks/:id', idParam, requirePerm('tasks.use'), wrap(async (req, res) => {
  const t = await loadTaskFor(req, 'delete');
  await pool.query('DELETE FROM tasks WHERE id = $1', [t.id]);
  await audit(req, 'zadanie.usuniecie', { resource: 'tasks', resourceId: t.id, details: { tytul: t.title } });
  res.json({ ok: true });
}));

// ---------- Approval Center ----------
const AP_SELECT = `SELECT a.*, d.name AS department_name, du.login AS decided_by_login,
  CASE WHEN a.requested_by_type = 'user' THEN ru.login ELSE a.requested_by END AS requested_by_label
  FROM approvals a LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN users du ON du.id = a.decided_by
  LEFT JOIN users ru ON a.requested_by_type = 'user' AND ru.id::text = a.requested_by`;
const withHistory = async rows => {
  if (!rows.length) return rows;
  const ev = await pool.query('SELECT * FROM approval_events WHERE approval_id = ANY($1) ORDER BY ts, id', [rows.map(x => x.id)]);
  return rows.map(a => ({ ...a, history: ev.rows.filter(e => e.approval_id === a.id) }));
};

// Wnioski zgłoszone przez zalogowanego użytkownika (dostępne dla wszystkich ról).
r.get('/approvals/moje', requirePerm('approvals.request'), wrap(async (req, res) => {
  const q = await pool.query(AP_SELECT + ` WHERE a.requested_by_type = 'user' AND a.requested_by = $1 ORDER BY a.created_at DESC LIMIT 100`, [String(req.user.id)]);
  res.json(await withHistory(q.rows));
}));
r.post('/approvals', requirePerm('approvals.request'), wrap(async (req, res) => {
  const a = await ops.requestOperation(req.user, req.body || {}, req);
  res.status(201).json(a);
}));
r.patch('/approvals/:id', idParam, requirePerm('approvals.request'), wrap(async (req, res) => {
  res.json(await ops.updateOperation(req.user, req.params.id, req.body || {}, req));
}));
r.post('/approvals/:id/wycofaj', idParam, requirePerm('approvals.request'), wrap(async (req, res) => {
  res.json(await ops.withdraw(req.user, req.params.id, req));
}));
r.post('/approvals/:id/wykonaj', idParam, requirePerm('approvals.request'), wrap(async (req, res) => {
  res.json(await ops.execute(req.user, req.params.id, req));
}));

// Pełne Approval Center – tylko administratorzy.
r.get('/approvals', requirePerm('approvals.decide'), wrap(async (req, res) => {
  const st = ['oczekuje', 'zatwierdzona', 'odrzucona', 'wykonana', 'wycofana'];
  const q = st.includes(req.query.status)
    ? await pool.query(AP_SELECT + ' WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT 200', [req.query.status])
    : req.query.status === 'historia'
      ? await pool.query(AP_SELECT + ` WHERE a.status <> 'oczekuje' ORDER BY a.updated_at DESC LIMIT 200`)
      : await pool.query(AP_SELECT + ' ORDER BY a.created_at DESC LIMIT 200');
  res.json(await withHistory(q.rows));
}));
r.post('/approvals/:id/decyzja', idParam, requirePerm('approvals.decide'), wrap(async (req, res) => {
  const a = await ops.decide(req.user, req.params.id, req.body || {}, req);
  require('../lib/events').emit('operacja.decyzja', { tytul: a.title, typ: a.operation_type, status: a.status, administrator: req.user.login });
  res.json(a);
}));

r.get('/approval-rules', requirePerm('approvals.decide'), wrap(async (req, res) => {
  const q = await pool.query(`SELECT r.*, u.login AS created_by_login,
    (SELECT count(*)::int FROM approvals a WHERE a.auto_rule_id = r.id) AS used_total,
    (SELECT count(*)::int FROM approvals a WHERE a.auto_rule_id = r.id AND a.created_at >= date_trunc('day', now())) AS used_today
    FROM approval_rules r JOIN users u ON u.id = r.created_by ORDER BY r.is_active DESC, r.created_at DESC`);
  res.json(q.rows);
}));
r.post('/approval-rules', requirePerm('approvals.decide'), wrap(async (req, res) => {
  ops.assertHumanAdmin(req.user);
  const b = req.body || {}, def = ops.OPERATIONS[b.operation_type];
  if (!def || def.level < 2) throw new ops.PolicyError(400, 'Wybierz typ operacji wymagającej zgody.');
  if (!def.reversible) throw new ops.PolicyError(400, 'Poziom 3 jest dostępny tylko dla operacji odwracalnych.');
  const max = Number(b.max_amount), perDay = parseInt(b.max_per_day, 10);
  if (!(max > 0 && max <= 1e8)) throw new ops.PolicyError(400, 'Podaj limit kwoty większy od zera.');
  if (!(perDay >= 1 && perDay <= 100)) throw new ops.PolicyError(400, 'Limit dzienny: od 1 do 100 operacji.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.valid_until || '')) throw new ops.PolicyError(400, 'Podaj datę ważności reguły.');
  const days = (new Date(b.valid_until) - new Date()) / 864e5;
  if (days < 0 || days > 366) throw new ops.PolicyError(400, 'Reguła może obowiązywać najwyżej rok od dziś.');
  const q = await pool.query(`INSERT INTO approval_rules (operation_type, description, max_amount, currency, max_per_day, valid_until, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [b.operation_type, String(b.description || '').slice(0, 500), max, String(b.currency || 'PLN').toUpperCase().slice(0, 3), perDay, b.valid_until, req.user.id]);
  await audit(req, 'regula_poziomu3.utworzenie', { resource: 'approval_rules', resourceId: q.rows[0].id, details: { typ: b.operation_type, max, perDay, do: b.valid_until } });
  res.status(201).json(q.rows[0]);
}));
r.post('/approval-rules/:id/wylacz', idParam, requirePerm('approvals.decide'), wrap(async (req, res) => {
  const q = await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1 RETURNING *', [req.params.id]);
  if (!q.rows[0]) throw new ops.PolicyError(404, 'Nie znaleziono reguły.');
  await audit(req, 'regula_poziomu3.wylaczenie', { resource: 'approval_rules', resourceId: req.params.id });
  res.json(q.rows[0]);
}));

// ---------- Command Center ----------
r.get('/command-center', requirePerm('command.view'), wrap(async (req, res) => {
  const admin = can(req.user, 'approvals.decide'), uid = String(req.user.id);
  const [t, mine, pend, stopped, denied, recentTasks, pendList, decided] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE status IN ('nowe','w_toku'))::int AS otwarte,
      count(*) FILTER (WHERE status IN ('nowe','w_toku') AND due_date < current_date)::int AS po_terminie,
      count(*) FILTER (WHERE status = 'zakonczone' AND completed_at >= now() - interval '7 days')::int AS zakonczone_7d,
      count(*) FILTER (WHERE status IN ('nowe','w_toku') AND priority = 'pilny')::int AS pilne FROM tasks`),
    pool.query(`SELECT count(*)::int AS n FROM tasks WHERE status IN ('nowe','w_toku') AND assignee_id = $1`, [uid]),
    admin ? pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE created_at < now() - interval '24 hours')::int AS stare FROM approvals WHERE status = 'oczekuje'`)
      : pool.query(`SELECT count(*)::int AS n, 0 AS stare FROM approvals WHERE status = 'oczekuje' AND requested_by_type = 'user' AND requested_by = $1`, [uid]),
    ops.agentsStopped(),
    admin ? pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE status = 'odmowa' AND ts >= now() - interval '24 hours'`) : Promise.resolve({ rows: [{ n: null }] }),
    pool.query(TASK_SELECT + ` WHERE t.status IN ('nowe','w_toku') AND (t.assignee_id = $1 OR t.created_by::text = $1)
      ORDER BY t.due_date NULLS LAST, array_position(ARRAY['pilny','wysoki','normalny','niski'], t.priority) LIMIT 6`, [uid]),
    admin ? pool.query(AP_SELECT + ` WHERE a.status = 'oczekuje' ORDER BY a.created_at LIMIT 6`)
      : pool.query(AP_SELECT + ` WHERE a.requested_by_type = 'user' AND a.requested_by = $1 AND a.status IN ('oczekuje','zatwierdzona') ORDER BY a.created_at DESC LIMIT 6`, [uid]),
    admin ? pool.query(`SELECT count(*)::int AS n FROM approvals WHERE decided_at >= now() - interval '7 days'`) : Promise.resolve({ rows: [{ n: null }] })
  ]);
  const k = t.rows[0], alerts = [];
  if (stopped) alerts.push({ level: 'krytyczny', text: 'Wszyscy agenci AI są zatrzymani wyłącznikiem bezpieczeństwa.', link: admin ? '/bezpieczenstwo' : null });
  if (k.po_terminie) alerts.push({ level: 'ostrzezenie', text: `Zadania po terminie: ${k.po_terminie}.`, link: '/zadania' });
  if (k.pilne) alerts.push({ level: 'info', text: `Otwarte zadania pilne: ${k.pilne}.`, link: '/zadania' });
  if (admin && pend.rows[0].stare) alerts.push({ level: 'ostrzezenie', text: `Decyzje czekające ponad 24 godziny: ${pend.rows[0].stare}.`, link: '/akceptacje' });
  const d3 = (await pool.query(`SELECT
      (SELECT count(*)::int FROM finance WHERE kind = 'przychod' AND invoice_no <> '' AND paid_at IS NULL AND due_date < current_date) AS faktury_po_terminie,
      (SELECT count(*)::int FROM complaints WHERE status NOT IN ('rozwiazana','odrzucona')) AS reklamacje,
      (SELECT count(*)::int FROM installations WHERE status = 'wykonany') AS do_odbioru,
      (SELECT count(*)::int FROM installations WHERE status IN ('zaplanowany','w_toku') AND planned_date = current_date) AS montaze_dzis`).catch(() => ({ rows: [{}] }))).rows[0];
  if (d3.faktury_po_terminie) alerts.push({ level: 'ostrzezenie', text: `Faktury po terminie płatności: ${d3.faktury_po_terminie}.`, link: '/finanse' });
  if (d3.reklamacje) alerts.push({ level: 'info', text: `Otwarte reklamacje: ${d3.reklamacje}.`, link: '/dzial/podzielniki-i-montaze' });
  if (d3.do_odbioru) alerts.push({ level: 'info', text: `Montaże wykonane, czekają na protokół odbioru: ${d3.do_odbioru}.`, link: '/dzial/podzielniki-i-montaze' });
  if (d3.montaze_dzis) alerts.push({ level: 'info', text: `Montaże zaplanowane na dziś: ${d3.montaze_dzis}.`, link: '/dzial/podzielniki-i-montaze' });
  if (admin && denied.rows[0].n) alerts.push({ level: 'info', text: `Odmowy dostępu w ostatnich 24 godzinach: ${denied.rows[0].n}.`, link: '/bezpieczenstwo' });
  res.json({
    admin, kpi: { ...k, moje: mine.rows[0].n, oczekujace: pend.rows[0].n, decyzje_7d: decided.rows[0].n, odmowy_24h: denied.rows[0].n, agenci_zatrzymani: stopped },
    alerts, tasks: recentTasks.rows, pending: pendList.rows
  });
}));

// ---------- Security & Audit ----------
r.get('/audit', requirePerm('security.audit'), wrap(async (req, res) => {
  const w = [], p = [];
  if (['ok', 'odmowa', 'blad'].includes(req.query.status)) { p.push(req.query.status); w.push(`status = $${p.length}`); }
  if (['user', 'agent', 'system', 'anonim'].includes(req.query.actor_type)) { p.push(req.query.actor_type); w.push(`actor_type = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(action ILIKE $${p.length} OR actor_label ILIKE $${p.length} OR resource ILIKE $${p.length})`); }
  const before = parseInt(req.query.przed, 10);
  if (before > 0) { p.push(before); w.push(`id < $${p.length}`); }
  const q = await pool.query(`SELECT * FROM audit_logs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`, p);
  res.json(q.rows);
}));
// Konta pracowników i reset hasła: routes/konta.js (uprawnienie users.manage).
r.use('/konta', require('./konta'));
// Powiadomienia (każde konto, tylko własne) i widok pracowników terenowych (monter: tylko montaże własnej ekipy).
r.use('/powiadomienia', require('./powiadomienia'));
// Zlecenia serwisowe: biuro (service.manage) i serwisant (service.own – tylko zlecenia przypisane do niego).
r.use('/serwisy', require('./serwisy').office);
r.use('/moje/serwisy', require('./serwisy').own);
r.use('/moje', require('./teren'));
// Odczyty: terminy i wykonanie (role biurowe i „Obsługa odczytów”).
r.use('/odczyty', require('./odczyty'));
// Eksport do Excela (XLSX) – zestawienia działu Podzielniki i Montaże.
r.use('/eksport', require('./eksport'));

r.get('/security/agents-stop', requirePerm('security.audit'), wrap(async (req, res) => {
  const q = await pool.query(`SELECT s.value, s.updated_at, u.login AS updated_by_login FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE key = 'agents_stopped'`);
  const row = q.rows[0] || { value: { stopped: false } };
  res.json({ stopped: !!row.value.stopped, reason: row.value.reason || '', updated_at: row.updated_at || null, updated_by: row.updated_by_login || null });
}));
r.post('/security/agents-stop', requirePerm('security.audit'), wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.stopped !== 'boolean') throw new ops.PolicyError(400, 'Brak decyzji o zatrzymaniu.');
  const reason = String(b.reason || '').slice(0, 500);
  await pool.query(`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('agents_stopped', $1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify({ stopped: b.stopped, reason }), req.user.id]);
  await audit(req, b.stopped ? 'agenci.zatrzymanie' : 'agenci.wznowienie', { resource: 'system_settings', resourceId: 'agents_stopped', details: { powod: reason } });
  res.json({ stopped: b.stopped, reason });
}));

// ---------- warstwa AI (etap 2): routes/ai.js ----------
// Zgodność z etapem 1: /api/ai-settings = skrót Ustawień AI (tylko administratorzy).
r.get('/ai-settings', requirePerm('ai.settings'), wrap(async (req, res) => {
  const q = await pool.query(`SELECT a.id, s.display_name, s.model, s.is_active FROM agents a JOIN agent_settings s ON s.agent_id = a.id ORDER BY a.sort_order`);
  res.json({ agents: q.rows });
}));
r.use('/ai', require('./ai'));

// ---------- etap 3: działy, CRM, finanse, Knowledge Base, platforma szkoleniowa ----------
r.use('/d1', require('./dzial1'));

// ---------- etap 4: automatyzacje, Communication Hub, Business Intelligence ----------
r.use('/automatyzacje', require('./automatyzacje'));
r.use('/komunikacja', require('./komunikacja'));
r.get('/bi', requirePerm('tasks.use'), wrap(async (req, res) => res.json(await require('../lib/bi').analytics())));
r.use('/szkolenia', require('./szkolenia').router);
r.use('/', require('./biznes').router);

module.exports = r;
