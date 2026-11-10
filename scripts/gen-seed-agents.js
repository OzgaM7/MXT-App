// Generuje db/005_seed_agenci.sql z katalogu agentów (lib/ai/catalog.js): agenci, ustawienia, domyślne prompty (wersja 1).
// Uruchom po zmianie domyślnych promptów: node scripts/gen-seed-agents.js
'use strict';
const fs = require('fs'), path = require('path');
const { AGENTS, DEFAULT_MODEL } = require('../lib/ai/catalog');

const q = s => s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const dq = s => { if (s.includes('$mxt$')) throw new Error('prompt zawiera $mxt$'); return '$mxt$' + s + '$mxt$'; };

let sql = `-- MXT Business OS – seed 9 agentów AI: stanowiska, ustawienia startowe i domyślne prompty systemowe (wersja 1).
-- WYGENEROWANE przez scripts/gen-seed-agents.js z lib/ai/catalog.js – nie edytuj ręcznie.
-- ON CONFLICT DO NOTHING: ponowne uruchomienie nie nadpisuje ustawień ani promptów zmienionych przez administratorów.

`;
for (const a of AGENTS) {
  sql += `INSERT INTO agents (id, name, title, agent_group, department_id, sort_order) VALUES (${q(a.id)}, ${q(a.name)}, ${q(a.title)}, ${q(a.group)}, ${q(a.department)}, ${a.order})
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, title = excluded.title, agent_group = excluded.agent_group, department_id = excluded.department_id, sort_order = excluded.sort_order;
INSERT INTO agent_settings (agent_id, display_name, avatar, avatar_color, model, temperature, effort, cost_limit, is_active)
  VALUES (${q(a.id)}, ${q(a.name)}, ${q(a.avatar)}, ${q(a.color)}, ${q(DEFAULT_MODEL)}, 0.30, 'medium', ${a.group === 'zarzad' ? 50 : 30}, true)
  ON CONFLICT (agent_id) DO NOTHING;
INSERT INTO agent_prompt_versions (agent_id, prompt_text, version, author_user_id, is_default, is_current)
  SELECT ${q(a.id)}, ${dq(a.prompt)}, 1, NULL, true, true
  WHERE NOT EXISTS (SELECT 1 FROM agent_prompt_versions WHERE agent_id = ${q(a.id)});

`;
}
fs.writeFileSync(path.join(__dirname, '..', 'db', '005_seed_agenci.sql'), sql);
console.log('Zapisano db/005_seed_agenci.sql (' + AGENTS.length + ' agentów)');
