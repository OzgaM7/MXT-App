'use strict';
// Dostawca modelu dla agentów MXT.
//  - tryb testowy (domyślny, AI_MODE != 'live'): odpowiedzi symulowane z danych systemu, bez wywołań API i bez kosztów,
//  - tryb rzeczywisty (AI_MODE=live + ANTHROPIC_API_KEY): Claude przez oficjalne SDK @anthropic-ai/sdk.
const { MODELS } = require('./catalog');

const mode = () => (process.env.AI_MODE === 'live' && process.env.ANTHROPIC_API_KEY) ? 'live' : 'test';
let client = null;
function anthropic() {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic.default({ maxRetries: 2, timeout: 5 * 60 * 1000 });   // klucz z ANTHROPIC_API_KEY
  }
  return client;
}

const costOf = (model, usage) => {
  const m = MODELS[model] || MODELS['claude-opus-5-5'];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * m.inUsd + (usage.output_tokens || 0) * m.outUsd) / 1e6;
};

// Wywołanie Claude z pętlą narzędzi. executeTool sprawdza uprawnienia agenta (lib/ai/tools.js).
// Uwaga: modele Claude 5.x nie przyjmują parametru temperature – głębię odpowiedzi steruje `effort`.
async function callClaude({ model, effort, system, userText, tools, executeTool }) {
  const messages = [{ role: 'user', content: userText }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const calls = [];
  for (let round = 0; round < 6; round++) {
    const params = {
      model, max_tokens: 16000, system, messages,
      output_config: { effort },
      ...(tools && tools.length ? { tools } : {})
    };
    if (MODELS[model] && MODELS[model].fallbacks) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const res = await anthropic().beta.messages.create(params);
    for (const k of Object.keys(usage)) usage[k] += (res.usage && res.usage[k]) || 0;
    if (res.stop_reason === 'refusal') {
      return { status: 'odmowa', text: 'Model odmówił odpowiedzi' + (res.stop_details && res.stop_details.category ? ' (kategoria: ' + res.stop_details.category + ')' : '') + '.', usage, calls, servedBy: res.model };
    }
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (res.stop_reason !== 'tool_use') return { status: 'ok', text: text || '(brak treści odpowiedzi)', usage, calls, servedBy: res.model, truncated: res.stop_reason === 'max_tokens' };
    messages.push({ role: 'assistant', content: res.content });          // pełna treść, łącznie z blokami thinking
    const results = [];
    for (const b of res.content.filter(x => x.type === 'tool_use')) {
      try {
        const out = await executeTool(b.name, b.input || {});
        calls.push({ tool: b.name, ok: true });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 20000) });
      } catch (e) {
        calls.push({ tool: b.name, ok: false, error: e.message });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: 'Błąd: ' + e.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { status: 'ok', text: 'Agent przekroczył limit kroków narzędzi i przerwał pracę.', usage, calls };
}

module.exports = { mode, callClaude, costOf, anthropic };
