'use strict';
// Zdarzenia systemu → reguły automatyzacji (zadanie, powiadomienie e-mail, webhook n8n). Działania wykonuje kolejka.
// Automatyzacje wykonują wyłącznie czynności niewiążące (tworzą zadania, wysyłają powiadomienia wewnętrzne, przekazują
// zdarzenia do n8n) – nie zatwierdzają operacji i nie wysyłają ofert.
const crypto = require('crypto');
const { pool } = require('../db');
const jobs = require('./jobs');
const secrets = require('./secrets');
const { audit } = require('./audit');

const EVENTS = {
  'reklamacja.zgloszona': { label: 'Zgłoszono reklamację', fields: ['numer', 'tytul', 'dzial', 'klient', 'budynek'] },
  'oferta.do_akceptacji': { label: 'Oferta czeka na akceptację', fields: ['numer', 'klient', 'kwota', 'waluta'] },
  'oferta.wyslana': { label: 'Oferta wysłana do klienta', fields: ['numer', 'klient', 'kwota', 'waluta', 'email'] },
  'oferta.przyjeta': { label: 'Klient przyjął ofertę', fields: ['numer', 'klient', 'kwota', 'waluta', 'sprzedaz'] },
  'operacja.decyzja': { label: 'Decyzja w Approval Center', fields: ['tytul', 'typ', 'status', 'administrator'] },
  'montaz.odebrany': { label: 'Odebrano montaż (protokół)', fields: ['numer', 'budynek', 'protokol'] },
  'poczta.przychodzaca': { label: 'Nowa wiadomość e-mail od klienta', fields: ['od', 'temat', 'klient'] },
  'raport.dzienny': { label: 'Wygenerowano dzienny raport zarządu', fields: ['tytul', 'data'] },
  'zadanie.utworzone': { label: 'Utworzono zadanie', fields: ['tytul', 'dzial', 'priorytet'] }
};

async function emit(event, data = {}) {
  if (!EVENTS[event]) return;
  try {
    const rules = (await pool.query(`SELECT id FROM automations WHERE is_active AND event = $1`, [event])).rows;
    for (const r of rules) await jobs.enqueue('automatyzacja', { automation_id: r.id, event, data, at: new Date().toISOString() }, { maxAttempts: 4 });
  } catch (e) { console.error('zdarzenie', event, e.message); }
}

const fill = (tpl, data) => String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => data[k] == null ? '' : String(data[k])).slice(0, 2000);

// Webhook: dozwolony https; http wyłącznie dla hostów z N8N_ALLOWED_HOSTS (np. n8n w sieci wewnętrznej).
function checkUrl(u) {
  let x; try { x = new URL(u); } catch (e) { throw Object.assign(new Error('Nieprawidłowy adres webhooka.'), { status: 400 }); }
  const allowed = String(process.env.N8N_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(x.hostname)) throw Object.assign(new Error('Host webhooka spoza listy N8N_ALLOWED_HOSTS.'), { status: 400 });
  if (x.protocol !== 'https:' && !(x.protocol === 'http:' && allowed.includes(x.hostname))) throw Object.assign(new Error('Webhook musi używać https:// (http tylko dla hostów z N8N_ALLOWED_HOSTS).'), { status: 400 });
  if (!allowed.length && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.)/.test(x.hostname)) throw Object.assign(new Error('Adresy wewnętrzne wymagają wpisania hosta do N8N_ALLOWED_HOSTS.'), { status: 400 });
  return x.toString();
}

jobs.register('automatyzacja', async ({ automation_id, event, data, at }) => {
  const a = (await pool.query('SELECT * FROM automations WHERE id = $1', [automation_id])).rows[0];
  if (!a || !a.is_active) return { pominieto: true };
  const p = a.params || {};
  try {
    if (a.action === 'zadanie') {
      const UUID = /^[0-9a-f-]{36}$/i, assignee = p.assignee_id || null;
      const t = (await pool.query(`INSERT INTO tasks (title, description, department_id, priority, assignee_type, assignee_id, due_date, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int > 0 THEN current_date + $7::int END, $8) RETURNING id`,
        [fill(p.title, data).slice(0, 200) || EVENTS[event].label, fill(p.description, data) + `\n\n(Utworzone automatycznie: ${a.name})`, p.department_id || null, p.priority || 'normalny',
          assignee ? (UUID.test(assignee) ? 'user' : 'agent') : null, assignee, +p.due_days || 0, a.created_by])).rows[0];
      await audit({ user: null }, 'automatyzacja.zadanie', { actor: { type: 'system', id: a.id, login: 'automatyzacja: ' + a.name }, resource: 'tasks', resourceId: t.id, details: { zdarzenie: event } });
    } else if (a.action === 'email') {
      const mail = require('./mail');
      for (const to of (p.recipients || []).slice(0, 10)) await mail.queue({ to, subject: fill(p.subject || `[MXT] ${EVENTS[event].label}`, data), related_type: 'automation', related_id: a.id,
        text: fill(p.body || EVENTS[event].label + '\n\n' + Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n'), data) });
    } else if (a.action === 'webhook') {
      const body = JSON.stringify({ event, at, data, automation: a.name });
      const secret = a.secret_enc ? await secrets.decrypt(a.secret_enc) : '';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
      const res = await fetch(checkUrl(p.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MXT-Event': event, 'X-MXT-Signature': 'sha256=' + sig }, body, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('Webhook odpowiedział kodem ' + res.status);
    }
    await pool.query(`UPDATE automations SET runs = runs + 1, last_run_at = now(), last_error = NULL WHERE id = $1`, [a.id]);
    return { ok: true };
  } catch (e) {
    await pool.query(`UPDATE automations SET last_error = $2, last_run_at = now() WHERE id = $1`, [a.id, String(e.message).slice(0, 500)]);
    throw e;
  }
});

module.exports = { EVENTS, emit, checkUrl, fill };
