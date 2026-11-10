'use strict';
// API warstwy AI (etap 2): Ustawienia AI (tylko administratorzy), AI Board, AI Workforce, uruchamianie agentów.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm, can } = require('../lib/rbac');
const ops = require('../lib/operations');
const catalog = require('../lib/ai/catalog');
const runner = require('../lib/ai/runner');
const board = require('../lib/ai/board');
const tools = require('../lib/ai/tools');
const provider = require('../lib/ai/provider');

const r = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e instanceof runner.AgentError || e instanceof ops.PolicyError) return res.status(e.status).json({ error: e.message });
  if (e && e.code === '22P02') return res.status(404).json({ error: 'Nie znaleziono.' });
  next(e);
});
const agentParam = (req, res, next) => catalog.byId(req.params.id) ? next() : res.status(404).json({ error: 'Nieznany agent.' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- status warstwy AI ----------
r.get('/status', requirePerm('command.view'), wrap(async (req, res) => {
  res.json({ mode: provider.mode(), stopped: await ops.agentsStopped(), liveConfigured: !!process.env.ANTHROPIC_API_KEY });
}));

// ---------- agenci (profile – podgląd dla wszystkich ról) ----------
async function agentRows() {
  const q = await pool.query(`SELECT a.id, a.name, a.title, a.agent_group, a.department_id, d.name AS department_name, a.sort_order,
      s.display_name, s.avatar, s.avatar_color, s.model, s.temperature, s.effort, s.cost_limit::float AS cost_limit, s.is_active, s.updated_at,
      v.version AS prompt_version,
      coalesce((SELECT sum(cost_usd) FROM agent_runs r WHERE r.agent_id = a.id AND r.created_at >= date_trunc('month', now())), 0)::float AS month_cost,
      (SELECT count(*)::int FROM agent_runs r WHERE r.agent_id = a.id AND r.kind <> 'test_promptu') AS runs_total,
      (SELECT count(*)::int FROM agent_runs r WHERE r.agent_id = a.id AND r.kind <> 'test_promptu' AND r.status = 'ok') AS runs_ok,
      (SELECT max(created_at) FROM agent_runs r WHERE r.agent_id = a.id) AS last_run,
      (SELECT count(*)::int FROM tasks t WHERE t.assignee_type = 'agent' AND t.assignee_id = a.id AND t.status IN ('nowe','w_toku')) AS open_tasks
    FROM agents a JOIN agent_settings s ON s.agent_id = a.id LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN agent_prompt_versions v ON v.agent_id = a.id AND v.is_current ORDER BY a.sort_order`);
  const stopped = await ops.agentsStopped();
  return q.rows.map(a => {
    const c = catalog.byId(a.id);
    return { ...a, tools: tools.toolList(c), operations: c.operations.map(o => ({ id: o, label: (ops.OPERATIONS[o] || {}).label || o })),
      status: stopped ? 'zatrzymany' : a.is_active ? 'aktywny' : 'wylaczony' };
  });
}
r.get('/agenci', requirePerm('command.view'), wrap(async (req, res) => {
  res.json({ mode: provider.mode(), stopped: await ops.agentsStopped(), agents: await agentRows() });
}));
r.get('/agenci/:id', agentParam, requirePerm('command.view'), wrap(async (req, res) => {
  const a = (await agentRows()).find(x => x.id === req.params.id);
  const runs = await pool.query(`SELECT r.id, r.kind, r.mode, r.model, r.prompt_version, r.status, r.input_tokens, r.output_tokens, r.cost_usd::float AS cost_usd,
      r.input_summary, r.error, r.duration_ms, r.created_at, r.task_id, r.meeting_id, u.login AS user_login, left(r.output, 600) AS output_preview
    FROM agent_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.agent_id = $1 ORDER BY r.created_at DESC LIMIT 30`, [req.params.id]);
  const tasks = await pool.query(`SELECT id, title, status, priority, due_date FROM tasks WHERE assignee_type = 'agent' AND assignee_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.params.id]);
  const memory = await pool.query(`SELECT scope, content, source, created_at FROM agent_memory WHERE (scope = 'osobista' AND agent_id = $1)
    OR (scope = 'dzialowa' AND department_id = $2) OR scope = 'korporacyjna' ORDER BY created_at DESC LIMIT 20`, [a.id, a.department_id]);
  res.json({ agent: a, runs: runs.rows, tasks: tasks.rows, memory: memory.rows });
}));

// ---------- Ustawienia AI (tylko administratorzy) ----------
r.get('/ustawienia', requirePerm('ai.settings'), wrap(async (req, res) => {
  const agents = await agentRows();
  const prompts = await pool.query(`SELECT agent_id, prompt_text FROM agent_prompt_versions WHERE is_current`);
  const pm = Object.fromEntries(prompts.rows.map(p => [p.agent_id, p.prompt_text]));
  res.json({
    mode: provider.mode(), models: catalog.MODELS, efforts: catalog.EFFORTS,
    agents: agents.map(a => ({ ...a, prompt_text: pm[a.id] || '' }))
  });
}));
r.get('/ustawienia/:id/wersje', agentParam, requirePerm('ai.settings'), wrap(async (req, res) => {
  const q = await pool.query(`SELECT v.id, v.version, v.prompt_text, v.created_at, v.is_default, v.is_current, v.restored_from, coalesce(u.login, 'system') AS author
    FROM agent_prompt_versions v LEFT JOIN users u ON u.id = v.author_user_id WHERE v.agent_id = $1 ORDER BY v.version DESC`, [req.params.id]);
  res.json(q.rows);
}));

async function newVersion(client, agentId, text, user, restoredFrom) {
  const cur = (await client.query(`SELECT max(version)::int AS v FROM agent_prompt_versions WHERE agent_id = $1`, [agentId])).rows[0].v || 0;
  await client.query(`UPDATE agent_prompt_versions SET is_current = false WHERE agent_id = $1 AND is_current`, [agentId]);
  const row = (await client.query(`INSERT INTO agent_prompt_versions (agent_id, prompt_text, version, author_user_id, is_current, restored_from)
    VALUES ($1, $2, $3, $4, true, $5) RETURNING version`, [agentId, text, cur + 1, user.id, restoredFrom || null])).rows[0];
  return row.version;
}
const validPrompt = t => { t = String(t == null ? '' : t); if (!t.trim()) throw new ops.PolicyError(400, 'Prompt systemowy nie może być pusty.'); if (t.length > 20000) throw new ops.PolicyError(400, 'Prompt może mieć najwyżej 20 000 znaków.'); return t; };

r.put('/ustawienia/:id', agentParam, requirePerm('ai.settings'), wrap(async (req, res) => {
  const b = req.body || {}, id = req.params.id;
  const s = (await pool.query('SELECT * FROM agent_settings WHERE agent_id = $1', [id])).rows[0];
  const n = {
    display_name: b.display_name !== undefined ? String(b.display_name).trim().slice(0, 60) : s.display_name,
    avatar: b.avatar !== undefined ? String(b.avatar).trim().toUpperCase().slice(0, 4) : s.avatar,
    avatar_color: b.avatar_color !== undefined ? String(b.avatar_color) : s.avatar_color,
    model: b.model !== undefined ? String(b.model) : s.model,
    temperature: b.temperature !== undefined ? Number(b.temperature) : Number(s.temperature),
    effort: b.effort !== undefined ? String(b.effort) : s.effort,
    cost_limit: b.cost_limit !== undefined ? Number(b.cost_limit) : Number(s.cost_limit),
    is_active: b.is_active !== undefined ? b.is_active === true : s.is_active
  };
  if (!n.display_name) throw new ops.PolicyError(400, 'Podaj nazwę wyświetlaną.');
  if (!n.avatar) throw new ops.PolicyError(400, 'Podaj skrót awatara (1–4 znaki).');
  if (!/^#[0-9a-f]{6}$/i.test(n.avatar_color)) throw new ops.PolicyError(400, 'Nieprawidłowy kolor awatara.');
  if (!catalog.MODELS[n.model]) throw new ops.PolicyError(400, 'Wybierz model z listy.');
  if (!(n.temperature >= 0 && n.temperature <= 1)) throw new ops.PolicyError(400, 'Temperatura: od 0 do 1.');
  if (!catalog.EFFORTS[n.effort]) throw new ops.PolicyError(400, 'Nieznany poziom wysiłku.');
  if (!(n.cost_limit >= 0 && n.cost_limit <= 100000)) throw new ops.PolicyError(400, 'Limit kosztów: od 0 do 100 000 USD.');
  const changed = Object.keys(n).filter(k => String(n[k]) !== String(k === 'temperature' || k === 'cost_limit' ? Number(s[k]) : s[k]));
  const client = await pool.connect();
  let version = null;
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE agent_settings SET display_name=$2, avatar=$3, avatar_color=$4, model=$5, temperature=$6, effort=$7, cost_limit=$8, is_active=$9,
      updated_by=$10, updated_at=now() WHERE agent_id=$1`, [id, n.display_name, n.avatar, n.avatar_color, n.model, n.temperature, n.effort, n.cost_limit, n.is_active, req.user.id]);
    if (b.prompt_text !== undefined) {
      const text = validPrompt(b.prompt_text);
      const cur = (await client.query(`SELECT prompt_text FROM agent_prompt_versions WHERE agent_id = $1 AND is_current`, [id])).rows[0];
      if (!cur || cur.prompt_text !== text) { version = await newVersion(client, id, text, req.user); changed.push('prompt'); }
    }
    await audit(req, 'ai.ustawienia.zmiana', { resource: 'agents', resourceId: id, details: { zmienione: changed, wersja_promptu: version, przed: pick(s, changed), po: pick(n, changed) }, client });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.json({ ok: true, changed, prompt_version: version });
}));
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k !== 'prompt' && o[k] !== undefined).map(k => [k, o[k]]));

async function restore(req, res, which) {
  const id = req.params.id;
  const src = which === 'default'
    ? (await pool.query(`SELECT * FROM agent_prompt_versions WHERE agent_id = $1 AND is_default`, [id])).rows[0]
    : (await pool.query(`SELECT * FROM agent_prompt_versions WHERE agent_id = $1 AND version = $2`, [id, parseInt((req.body || {}).version, 10) || 0])).rows[0];
  if (!src) throw new ops.PolicyError(404, 'Nie znaleziono wersji promptu.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await newVersion(client, id, src.prompt_text, req.user, src.version);
    await audit(req, which === 'default' ? 'ai.prompt.przywrocenie_domyslnego' : 'ai.prompt.przywrocenie_wersji', { resource: 'agents', resourceId: id, details: { z_wersji: src.version, nowa_wersja: v }, client });
    await client.query('COMMIT');
    res.json({ ok: true, prompt_version: v, restored_from: src.version });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}
r.post('/ustawienia/:id/przywroc', agentParam, requirePerm('ai.settings'), wrap((req, res) => restore(req, res, 'version')));
r.post('/ustawienia/:id/domyslny', agentParam, requirePerm('ai.settings'), wrap((req, res) => restore(req, res, 'default')));

// Test promptu: robocza (niezapisana) treść, bez narzędzi – nie wykonuje żadnych operacji w systemie.
r.post('/ustawienia/:id/test', agentParam, requirePerm('ai.settings'), wrap(async (req, res) => {
  const b = req.body || {}, msg = String(b.message || '').trim().slice(0, 4000);
  if (!msg) throw new ops.PolicyError(400, 'Wpisz wiadomość testową.');
  const out = await runner.run(req.params.id, { kind: 'test_promptu', user: req.user, message: msg, promptOverride: validPrompt(b.prompt_text), noTools: true });
  res.json({ text: out.text, status: out.status, mode: out.run.mode, cost_usd: Number(out.run.cost_usd), tokens: { input: out.run.input_tokens, output: out.run.output_tokens } });
}));

// ---------- AI Board ----------
r.get('/posiedzenia', requirePerm('command.view'), wrap(async (req, res) => {
  const q = await pool.query(`SELECT m.id, m.topic, m.status, m.mode, m.created_at, m.finished_at, u.login AS convened_by_login, a.status AS approval_status,
      d.status AS decision, du.login AS decided_by_login FROM board_meetings m JOIN users u ON u.id = m.convened_by
    LEFT JOIN approvals a ON a.id = m.approval_id LEFT JOIN decisions d ON d.approval_id = m.approval_id LEFT JOIN users du ON du.id = d.decided_by
    ORDER BY m.created_at DESC LIMIT 50`);
  res.json(q.rows);
}));
r.get('/posiedzenia/:id', requirePerm('command.view'), wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ops.PolicyError(404, 'Nie znaleziono posiedzenia.');
  const m = (await pool.query(`SELECT m.*, u.login AS convened_by_login FROM board_meetings m JOIN users u ON u.id = m.convened_by WHERE m.id = $1`, [req.params.id])).rows[0];
  if (!m) throw new ops.PolicyError(404, 'Nie znaleziono posiedzenia.');
  const c = await pool.query(`SELECT c.seq, c.agent_id, c.stage, c.content, c.prompt_version, c.created_at, c.run_id, s.display_name, s.avatar, s.avatar_color, a.title,
      (SELECT rating FROM agent_feedback f WHERE f.run_id = c.run_id AND f.user_id = $2) AS my_rating
    FROM board_contributions c JOIN agents a ON a.id = c.agent_id JOIN agent_settings s ON s.agent_id = c.agent_id WHERE c.meeting_id = $1 ORDER BY c.seq`, [m.id, req.user.id]);
  const ap = m.approval_id ? (await pool.query(`SELECT a.id, a.status, a.version, a.payload_hash, a.decided_at, a.decision_note, u.login AS decided_by_login
    FROM approvals a LEFT JOIN users u ON u.id = a.decided_by WHERE a.id = $1`, [m.approval_id])).rows[0] : null;
  res.json({ ...m, contributions: c.rows, approval: ap, canDecide: can(req.user, 'approvals.decide') });
}));
r.post('/posiedzenia', requirePerm('board.convene'), wrap(async (req, res) => {
  res.status(202).json(await board.convene(req.user, req.body || {}, req));
}));
r.get('/raporty', requirePerm('command.view'), wrap(async (req, res) => {
  const q = await pool.query(`SELECT b.id, b.title, b.content, b.mode, b.created_at, b.run_id, u.login AS created_by_login,
      (SELECT rating FROM agent_feedback f WHERE f.run_id = b.run_id AND f.user_id = $1) AS my_rating FROM board_reports b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC LIMIT 20`, [req.user.id]);
  res.json(q.rows);
}));
r.post('/raporty', requirePerm('board.convene'), wrap(async (req, res) => {
  res.status(201).json(await board.report(req.user, req));
}));

// ---------- zadanie przydzielone agentowi ----------
r.post('/zadania/:id/uruchom', requirePerm('tasks.use'), wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ops.PolicyError(404, 'Nie znaleziono zadania.');
  const t = (await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
  if (!t) throw new ops.PolicyError(404, 'Nie znaleziono zadania.');
  if (t.assignee_type !== 'agent') throw new ops.PolicyError(400, 'To zadanie nie jest przydzielone agentowi AI.');
  if (String(t.created_by) !== String(req.user.id) && req.user.role !== 'administrator') {
    await audit(req, 'odmowa_dostepu', { status: 'odmowa', resource: 'tasks', resourceId: t.id, details: { operacja: 'uruchomienie_agenta' } });
    throw new ops.PolicyError(403, 'Agenta uruchamia autor zadania albo administrator.');
  }
  const out = await runner.run(t.assignee_id, { kind: 'zadanie', user: req.user, topic: t.title, context: t.description, taskId: t.id });
  if (t.status === 'nowe') await pool.query(`UPDATE tasks SET status = 'w_toku', updated_at = now() WHERE id = $1`, [t.id]);
  res.json({ text: out.text, status: out.status, run_id: out.run.id, mode: out.run.mode });
}));
r.get('/zadania/:id/wyniki', requirePerm('tasks.use'), wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ops.PolicyError(404, 'Nie znaleziono zadania.');
  const q = await pool.query(`SELECT r.id, r.agent_id, r.status, r.mode, r.output, r.created_at, r.error, u.login AS user_login,
      (SELECT rating FROM agent_feedback f WHERE f.run_id = r.id AND f.user_id = $2) AS my_rating FROM agent_runs r
    LEFT JOIN users u ON u.id = r.user_id WHERE r.task_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [req.params.id, req.user.id]);
  res.json(q.rows);
}));

// ---------- karta wyników agentów (etap 4) ----------
// Uruchomienia zablokowane przez system (wyłącznik, limit kosztów, wyłączony agent) nie obniżają skuteczności.
// Wynik (0–100) = 40% skuteczność uruchomień + 30% odsetek zatwierdzonych operacji + 30% oceny ludzi.
// Składnik bez danych jest pomijany (wagi pozostałych się skalują); bez żadnych danych – brak wyniku.
r.get('/karta-wynikow', requirePerm('command.view'), wrap(async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.dni, 10) || 30));
  const q = await pool.query(`SELECT a.id, s.display_name, s.avatar, s.avatar_color, a.title, a.agent_group, a.department_id, s.cost_limit::float AS cost_limit,
      count(r.id) FILTER (WHERE r.kind <> 'test_promptu' AND r.status <> 'zablokowane')::int AS runs,
      count(r.id) FILTER (WHERE r.kind <> 'test_promptu' AND r.status = 'ok')::int AS ok,
      count(r.id) FILTER (WHERE r.status = 'blad')::int AS errors,
      count(r.id) FILTER (WHERE r.status = 'zablokowane')::int AS blocked,
      count(r.id) FILTER (WHERE r.status = 'odmowa')::int AS refused,
      coalesce(round(avg(r.duration_ms) FILTER (WHERE r.status = 'ok')), 0)::int AS avg_ms,
      coalesce(sum(r.input_tokens + r.output_tokens), 0)::int AS tokens,
      coalesce(sum(r.cost_usd), 0)::float AS cost,
      (SELECT coalesce(sum(cost_usd), 0)::float FROM agent_runs x WHERE x.agent_id = a.id AND x.created_at >= date_trunc('month', now())) AS month_cost,
      (SELECT count(*)::int FROM tasks t WHERE t.assignee_type = 'agent' AND t.assignee_id = a.id AND t.created_at >= now() - make_interval(days => $1)) AS tasks,
      (SELECT count(*)::int FROM tasks t WHERE t.assignee_type = 'agent' AND t.assignee_id = a.id AND t.status = 'zakonczone' AND t.created_at >= now() - make_interval(days => $1)) AS tasks_done,
      (SELECT count(*)::int FROM approvals p WHERE p.requested_by_type = 'agent' AND p.requested_by = a.id AND p.level >= 2 AND p.created_at >= now() - make_interval(days => $1)) AS ops,
      (SELECT count(*)::int FROM approvals p WHERE p.requested_by_type = 'agent' AND p.requested_by = a.id AND p.level >= 2 AND p.status IN ('zatwierdzona','wykonana') AND p.created_at >= now() - make_interval(days => $1)) AS ops_ok,
      (SELECT count(*)::int FROM approvals p WHERE p.requested_by_type = 'agent' AND p.requested_by = a.id AND p.level >= 2 AND p.status = 'odrzucona' AND p.created_at >= now() - make_interval(days => $1)) AS ops_rejected,
      (SELECT count(*)::int FROM agent_feedback f JOIN agent_runs x ON x.id = f.run_id WHERE x.agent_id = a.id AND f.rating = 1 AND f.created_at >= now() - make_interval(days => $1)) AS fb_up,
      (SELECT count(*)::int FROM agent_feedback f JOIN agent_runs x ON x.id = f.run_id WHERE x.agent_id = a.id AND f.rating = -1 AND f.created_at >= now() - make_interval(days => $1)) AS fb_down
    FROM agents a JOIN agent_settings s ON s.agent_id = a.id LEFT JOIN agent_runs r ON r.agent_id = a.id AND r.created_at >= now() - make_interval(days => $1)
    GROUP BY a.id, s.display_name, s.avatar, s.avatar_color, a.title, a.agent_group, a.department_id, s.cost_limit, a.sort_order ORDER BY a.sort_order`, [days]);
  res.json({ days, agents: q.rows.map(a => {
    const parts = [];
    if (a.runs) parts.push([0.4, a.ok / a.runs]);
    if (a.ops_ok + a.ops_rejected) parts.push([0.3, a.ops_ok / (a.ops_ok + a.ops_rejected)]);
    if (a.fb_up + a.fb_down) parts.push([0.3, a.fb_up / (a.fb_up + a.fb_down)]);
    const w = parts.reduce((s, x) => s + x[0], 0);
    return { ...a, success_pct: a.runs ? Math.round(a.ok / a.runs * 100) : null, approval_pct: a.ops_ok + a.ops_rejected ? Math.round(a.ops_ok / (a.ops_ok + a.ops_rejected) * 100) : null,
      feedback_pct: a.fb_up + a.fb_down ? Math.round(a.fb_up / (a.fb_up + a.fb_down) * 100) : null, score: w ? Math.round(parts.reduce((s, x) => s + x[0] * x[1], 0) / w * 100) : null };
  }) });
}));
// Ocena wyniku pracy agenta (👍/👎) – jedna na osobę i uruchomienie, można zmienić.
r.post('/uruchomienia/:id/ocena', requirePerm('command.view'), wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ops.PolicyError(404, 'Nie znaleziono.');
  const b = req.body || {}, rating = Number(b.rating);
  if (![1, -1].includes(rating)) throw new ops.PolicyError(400, 'Ocena: 1 albo -1.');
  const run = (await pool.query(`SELECT id, agent_id, kind FROM agent_runs WHERE id = $1 AND status = 'ok'`, [req.params.id])).rows[0];
  if (!run || run.kind === 'test_promptu') throw new ops.PolicyError(404, 'Nie znaleziono wyniku pracy agenta.');
  await pool.query(`INSERT INTO agent_feedback (run_id, user_id, rating, comment) VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = now()`,
    [run.id, req.user.id, rating, String(b.comment || '').slice(0, 500)]);
  await audit(req, 'agent.ocena', { resource: 'agent_runs', resourceId: run.id, details: { agent: run.agent_id, ocena: rating } });
  res.json({ ok: true, rating });
}));

module.exports = r;
