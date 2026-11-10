'use strict';
// AI Board: posiedzenie prowadzone przez CEO → stanowiska CFO, COO, CSO → rekomendacja CEO → decyzja administratora.
// Przebieg to stały graf kroków (orkiestracja w kodzie). Rekomendacja trafia do Approval Center jako operacja poziomu 2
// zgłoszona przez agenta CEO – zatwierdza ją lub odrzuca wyłącznie administrator. Protokół zapisywany w bazie.
const { pool } = require('../../db');
const { audit } = require('../audit');
const ops = require('../operations');
const runner = require('./runner');
const provider = require('./provider');

const MEMBERS = ['cfo', 'coo', 'cso'];
const running = new Map();       // meetingId -> Promise (do testów i podglądu)

async function addContribution(meetingId, seq, agentId, stage, content, r) {
  await pool.query(`INSERT INTO board_contributions (meeting_id, seq, agent_id, stage, content, prompt_version, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [meetingId, seq, agentId, stage, content, r && typeof r.promptVersion === 'number' ? r.promptVersion : null, r ? r.run.id : null]);
}

async function convene(user, { topic, context }, req) {
  topic = String(topic || '').trim().slice(0, 300); context = String(context || '').trim().slice(0, 4000);
  if (topic.length < 3) throw new runner.AgentError(400, 'Podaj temat posiedzenia (min. 3 znaki).');
  if (await ops.agentsStopped()) throw new runner.AgentError(423, 'Agenci AI są zatrzymani wyłącznikiem bezpieczeństwa.');
  const ceo = await runner.loadAgent('ceo');
  if (!ceo.settings.is_active) throw new runner.AgentError(409, 'CEO jest wyłączony w Ustawieniach AI – posiedzenie nie może się odbyć.');
  const m = (await pool.query(`INSERT INTO board_meetings (topic, context, convened_by, mode) VALUES ($1, $2, $3, $4) RETURNING *`,
    [topic, context, user.id, provider.mode()])).rows[0];
  await audit(req, 'zarzad.zwolanie_posiedzenia', { resource: 'board_meetings', resourceId: m.id, details: { temat: topic, tryb: m.mode } });
  const p = conduct(m, user).catch(e => console.error('posiedzenie', e)).finally(() => running.delete(m.id));
  running.set(m.id, p);
  return m;
}

async function conduct(m, user) {
  const base = { kind: 'posiedzenie', user, topic: m.topic, context: m.context, meetingId: m.id };
  try {
    const open = await runner.run('ceo', { ...base, stage: 'otwarcie' });
    await addContribution(m.id, 1, 'ceo', 'otwarcie', open.text, open);
    const positions = await Promise.all(MEMBERS.map(async (id, i) => {
      const a = await runner.loadAgent(id);
      if (!a.settings.is_active) {
        const note = `${a.settings.display_name} jest wyłączony w Ustawieniach AI – brak stanowiska.`;
        await addContribution(m.id, 2 + i, id, 'pominiete', note, null);
        return null;
      }
      try {
        const r = await runner.run(id, { ...base, stage: 'stanowisko', prior: [{ agent: 'CEO – otwarcie', content: open.text }] });
        await addContribution(m.id, 2 + i, id, 'stanowisko', r.text, r);
        return { agent: a.settings.display_name, content: r.text };
      } catch (e) {
        await addContribution(m.id, 2 + i, id, 'pominiete', `${a.settings.display_name}: ${e.message}`, null);
        return null;
      }
    }));
    const prior = [{ agent: 'CEO – otwarcie', content: open.text }, ...positions.filter(Boolean)];
    const rec = await runner.run('ceo', { ...base, stage: 'rekomendacja', prior });
    await addContribution(m.id, 5, 'ceo', 'rekomendacja', rec.text, rec);
    const ap = await ops.requestOperation({ type: 'agent', id: 'ceo', name: 'CEO' }, {
      operation_type: 'zarzad.rekomendacja', title: 'Rekomendacja Zarządu AI: ' + m.topic, description: rec.text, payload: { meeting_id: m.id }
    });
    await pool.query(`UPDATE board_meetings SET status = 'oczekuje_decyzji', recommendation = $2, approval_id = $3, finished_at = now() WHERE id = $1`, [m.id, rec.text, ap.id]);
  } catch (e) {
    await pool.query(`UPDATE board_meetings SET status = 'blad', error = $2, finished_at = now() WHERE id = $1`, [m.id, e.message]);
  }
}

// Decyzja administratora w Approval Center zamyka posiedzenie i trafia do pamięci korporacyjnej.
ops.onDecision('zarzad.rekomendacja', async (client, ap, actor) => {
  const meetingId = ap.payload && ap.payload.meeting_id;
  const m = meetingId ? (await client.query('SELECT * FROM board_meetings WHERE id = $1', [meetingId])).rows[0] : null;
  const ok = ap.status === 'zatwierdzona';
  await client.query(`INSERT INTO decisions (meeting_id, approval_id, title, status, decided_by, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [m ? m.id : null, ap.id, ap.title, ap.status, actor.id, ap.decision_note]);
  if (m) await client.query(`UPDATE board_meetings SET status = 'zakonczone' WHERE id = $1`, [m.id]);
  await client.query(`INSERT INTO agent_memory (scope, content, source, created_by) VALUES ('korporacyjna', $1, 'decyzja_zarzadu', $2)`,
    [`Decyzja administratora ${actor.login} (${new Date().toISOString().slice(0, 10)}): rekomendacja „${(m ? m.topic : ap.title).slice(0, 200)}” – ${ok ? 'ZATWIERDZONA' : 'ODRZUCONA'}.` +
      (ap.decision_note ? ` Uzasadnienie: ${ap.decision_note.slice(0, 500)}` : ''), actor.login]);
});

// Raport CEO dla administratorów – na żądanie albo dzienny (harmonogram, bez zalogowanego użytkownika).
async function report(user, req, { daily = false } = {}) {
  const bi = await require('../bi').summary();
  const r = await runner.run('ceo', { kind: 'raport', user, topic: daily ? 'Dzienny raport Zarządu AI' : 'Raport Zarządu AI', context: 'Wskaźniki Business Intelligence (JSON): ' + JSON.stringify(bi) });
  const title = (daily ? 'Dzienny raport Zarządu AI – ' : 'Raport Zarządu AI – ') + new Date().toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' });
  const row = (await pool.query(`INSERT INTO board_reports (title, content, agent_id, mode, run_id, created_by) VALUES ($1, $2, 'ceo', $3, $4, $5) RETURNING *`,
    [title, r.text, r.run.mode, r.run.id, user ? user.id : null])).rows[0];
  await audit(req || {}, daily ? 'zarzad.raport_dzienny' : 'zarzad.raport', { actor: user ? null : { type: 'system', id: 'harmonogram', login: 'harmonogram' }, resource: 'board_reports', resourceId: row.id });
  return row;
}

module.exports = { convene, report, running };
