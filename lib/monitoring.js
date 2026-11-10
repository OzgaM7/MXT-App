'use strict';
// Monitoring AI: każde uruchomienie agenta jest zapisane w agent_runs (tokeny, koszt, wersja promptu, czas, narzędzia).
// Opcjonalny eksport do Langfuse (LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY) przez API ingestion,
// wysyłany kolejką w tle – awaria Langfuse nie wpływa na pracę agentów. Treść zapytań nie jest wysyłana
// (tylko metadane), chyba że LANGFUSE_INCLUDE_CONTENT=1.
const { pool } = require('../db');
const jobs = require('./jobs');

const configured = () => !!(process.env.LANGFUSE_HOST && process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

async function track(run) {
  if (!configured() || !run) return;
  await jobs.enqueue('langfuse', { run_id: run.id }, { maxAttempts: 5 }).catch(() => {});
}

jobs.register('langfuse', async ({ run_id }) => {
  if (!configured()) return { pominieto: true };
  const r = (await pool.query('SELECT * FROM agent_runs WHERE id = $1', [run_id])).rows[0];
  if (!r) return { pominieto: true };
  const content = process.env.LANGFUSE_INCLUDE_CONTENT === '1';
  const ts = new Date(r.created_at).toISOString(), traceId = r.id;
  const batch = [
    { id: r.id + '-t', timestamp: ts, type: 'trace-create', body: { id: traceId, name: `mxt.${r.agent_id}.${r.kind}`, timestamp: ts,
      metadata: { agent: r.agent_id, rodzaj: r.kind, tryb: r.mode, status: r.status, wersja_promptu: r.prompt_version, narzedzia: r.tool_calls }, tags: ['mxt', r.agent_id, r.kind],
      ...(content ? { input: r.input_summary, output: r.output } : {}) } },
    { id: r.id + '-g', timestamp: ts, type: 'generation-create', body: { id: r.id + '-gen', traceId, name: r.agent_id, model: r.model, startTime: ts,
      endTime: new Date(new Date(r.created_at).getTime() + (r.duration_ms || 0)).toISOString(), usage: { input: r.input_tokens, output: r.output_tokens, unit: 'TOKENS' },
      level: r.status === 'ok' ? 'DEFAULT' : 'ERROR', statusMessage: r.error || undefined, metadata: { koszt_usd: Number(r.cost_usd) } } }
  ];
  const res = await fetch(process.env.LANGFUSE_HOST.replace(/\/$/, '') + '/api/public/ingestion', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(process.env.LANGFUSE_PUBLIC_KEY + ':' + process.env.LANGFUSE_SECRET_KEY).toString('base64') },
    body: JSON.stringify({ batch })
  });
  if (!res.ok && res.status !== 207) throw new Error('Langfuse odpowiedział kodem ' + res.status);
  return { status: res.status };
});

module.exports = { track, configured };
