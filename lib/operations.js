'use strict';
// Katalog operacji i twarde reguły Approval Center. Reguły są w kodzie (nie w promptach agentów):
//  - zatwierdza wyłącznie administrator (człowiek); agent nie zatwierdza ani własnych, ani cudzych operacji,
//  - operacja poziomu 2 nie wykona się bez zatwierdzenia tej samej wersji treści (porównanie skrótu SHA-256),
//  - poziom 3 tylko dla operacji odwracalnych, w granicach reguły ustanowionej wcześniej przez administratora,
//  - gdy włączony jest wyłącznik agentów, żadna operacja zgłoszona przez agenta nie zostanie przyjęta ani wykonana.
const crypto = require('crypto');
const { pool } = require('../db');
const { audit } = require('./audit');

const LEVELS = {
  0: 'Analiza – AI samodzielnie',
  1: 'Przygotowanie dokumentów i ofert – AI samodzielnie',
  2: 'Wykonanie po zgodzie administratora',
  3: 'Automatycznie – w granicach wcześniejszej zgody administratora'
};

// level: poziom domyślny; reversible: czy operację można cofnąć (warunek dla poziomu 3);
// module: gdzie zostanie podłączony skutek operacji.
const OPERATIONS = {
  'analiza.raport':      { label: 'Analiza / raport', level: 0, reversible: true, module: 'Business Intelligence' },
  'dokument.przygotuj':  { label: 'Przygotowanie dokumentu lub oferty (szkic)', level: 1, reversible: true, module: 'Knowledge Base / oferty' },
  'oferta.wyslij':       { label: 'Wysłanie oferty do klienta', level: 2, reversible: false, module: 'Oferty (działy 1 i 2)' },
  'cena.zmiana':         { label: 'Zmiana ceny', level: 2, reversible: true, module: 'Rejestr decyzji – bez automatycznego skutku (system nie prowadzi cenników)' },
  'rabat.udziel':        { label: 'Udzielenie rabatu', level: 2, reversible: true, module: 'Rejestr decyzji – rabat wprowadza się w ofercie (nowa wersja do akceptacji)' },
  'wydatek':             { label: 'Wydatek / zakup', level: 2, reversible: false, module: 'Rejestr decyzji – po wykonaniu koszt wpisuje się w Finance Intelligence' },
  'umowa':               { label: 'Zawarcie lub zmiana umowy', level: 2, reversible: false, module: 'Rejestr decyzji – dokument umowy w Knowledge Base, kontrakt w dziale' },
  'zarzad.rekomendacja': { label: 'Rekomendacja Zarządu AI', level: 2, reversible: false, module: 'AI Board' }
};
// Typy zgłaszane wyłącznie przez agentów (np. rekomendacja zarządu) nie są dostępne w formularzu użytkownika.
const AGENT_ONLY = ['zarzad.rekomendacja'];
// Wysyłka oferty jest zawsze powiązana z konkretną ofertą i jej wersją – zgłaszana wyłącznie z modułu Oferty.
const MODULE_ONLY = ['oferta.wyslij'];
const REQUESTABLE_BY_USER = Object.keys(OPERATIONS).filter(k => OPERATIONS[k].level === 2 && !AGENT_ONLY.includes(k) && !MODULE_ONLY.includes(k));

// Reakcje modułów na decyzję administratora (np. AI Board zapisuje decyzję w protokole).
const decisionHooks = {}, executeHooks = {}, withdrawHooks = {};
const onDecision = (type, fn) => { (decisionHooks[type] = decisionHooks[type] || []).push(fn); };
// Skutek wykonania (np. wysyłka oferty). Hook działa w tej samej transakcji i może zablokować wykonanie (PolicyError).
const onExecute = (type, fn) => { (executeHooks[type] = executeHooks[type] || []).push(fn); };
const onWithdraw = (type, fn) => { (withdrawHooks[type] = withdrawHooks[type] || []).push(fn); };

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const hashOf = a => crypto.createHash('sha256').update(canonical({
  operation_type: a.operation_type, title: a.title, description: a.description || '', amount: a.amount == null ? null : Number(a.amount),
  currency: a.currency || null, payload: a.payload || {}, document_id: a.document_id || null, document_version: a.document_version || null, version: a.version
})).digest('hex');

class PolicyError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function agentsStopped(client = pool) {
  const r = await client.query(`SELECT value FROM system_settings WHERE key = 'agents_stopped'`);
  return !!(r.rows[0] && r.rows[0].value && r.rows[0].value.stopped);
}

// Tylko administrator-człowiek może decydować. Agent nigdy – niezależnie od roli zapisanej gdziekolwiek.
function assertHumanAdmin(actor) {
  if (!actor || actor.type === 'agent') throw new PolicyError(403, 'Agent AI nie może zatwierdzać ani odrzucać operacji. Decyzję podejmuje administrator.');
  if (actor.role !== 'administrator') throw new PolicyError(403, 'Decyzje w Approval Center podejmuje wyłącznie administrator.');
}

const actorRef = a => a.type === 'agent' ? { type: 'agent', id: String(a.id), label: a.name || String(a.id) }
  : a.type === 'system' ? { type: 'system', id: String(a.id), label: a.login || 'system' }
  : { type: 'user', id: String(a.id), label: a.login };

async function event(client, ap, actor, ev, note) {
  const r = actorRef(actor);
  await client.query(
    `INSERT INTO approval_events (approval_id, actor_type, actor_id, actor_label, event, version, payload_hash, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [ap.id, r.type, r.id, r.label, ev, ap.version, ap.payload_hash, note || null]);
}

async function findRule(client, op, amount, currency) {
  const r = await client.query(
    `SELECT * FROM approval_rules WHERE is_active AND operation_type = $1 AND valid_until >= current_date
       AND currency = $2 AND max_amount >= $3 ORDER BY max_amount ASC`, [op, currency || 'PLN', amount == null ? 0 : amount]);
  for (const rule of r.rows) {
    const used = await client.query(`SELECT count(*)::int AS n FROM approvals WHERE auto_rule_id = $1 AND created_at >= date_trunc('day', now())`, [rule.id]);
    if (used.rows[0].n < rule.max_per_day) return rule;
  }
  return null;
}

// Zgłoszenie operacji. Poziomy 0–1: wykonanie od razu. Poziom 2: czeka na decyzję.
// Poziom 3: od razu, jeśli pasuje aktywna reguła; w przeciwnym razie zwykła ścieżka poziomu 2.
// opts.module = zgłoszenie z modułu (np. Oferty), który sam przygotował dane operacji i dokument.
async function requestOperation(actor, input, req, { client: outer, module: fromModule = false } = {}) {
  const def = OPERATIONS[input.operation_type];
  if (!def) throw new PolicyError(400, 'Nieznany typ operacji.');
  if (actor.type === 'agent' && await agentsStopped()) throw new PolicyError(423, 'Agenci AI są zatrzymani wyłącznikiem bezpieczeństwa.');
  if (actor.type !== 'agent' && !fromModule && !REQUESTABLE_BY_USER.includes(input.operation_type))
    throw new PolicyError(400, MODULE_ONLY.includes(input.operation_type) ? 'Tę operację zgłasza się z modułu Oferty.' : 'Ten typ operacji zgłaszają agenci AI.');
  if (MODULE_ONLY.includes(input.operation_type) && !fromModule) throw new PolicyError(400, 'Tę operację zgłasza się z modułu Oferty.');
  const amount = input.amount == null || input.amount === '' ? null : Number(input.amount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 1e10)) throw new PolicyError(400, 'Nieprawidłowa kwota.');
  const ap = {
    operation_type: input.operation_type, title: String(input.title || '').trim().slice(0, 200), description: String(input.description || '').slice(0, 5000),
    amount, currency: amount == null ? null : String(input.currency || 'PLN').toUpperCase().slice(0, 3),
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    document_id: input.document_id || null, document_version: input.document_version || null, version: 1,
    department_id: input.department_id || null
  };
  if (!ap.title) throw new PolicyError(400, 'Podaj tytuł operacji.');
  ap.payload_hash = hashOf(ap);
  const ref = actorRef(actor);

  const client = outer || await pool.connect();
  try {
    if (!outer) await client.query('BEGIN');
    let level = def.level, status = 'oczekuje', rule = null;
    if (level <= 1) status = 'wykonana';
    else if (def.reversible && amount != null) {
      rule = await findRule(client, ap.operation_type, amount, ap.currency);
      if (rule) { level = 3; status = 'zatwierdzona'; }
    }
    const ins = await client.query(
      `INSERT INTO approvals (operation_type, level, title, description, department_id, amount, currency, payload, document_id, document_version,
         version, payload_hash, requested_by_type, requested_by, status, decided_by, decided_at, decided_version, decided_hash, decision_note, auto_rule_id,
         executed_at, executed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [ap.operation_type, level, ap.title, ap.description, ap.department_id, ap.amount, ap.currency, JSON.stringify(ap.payload), ap.document_id, ap.document_version,
        ap.payload_hash, ref.type, ref.id, status,
        rule ? rule.created_by : null, rule ? new Date() : null, rule ? 1 : null, rule ? ap.payload_hash : null,
        rule ? 'Zatwierdzone automatycznie na podstawie reguły poziomu 3' : null, rule ? rule.id : null,
        level <= 1 ? new Date() : null, level <= 1 ? ref.label : null]);
    const row = ins.rows[0];
    await event(client, row, actor, 'utworzenie');
    if (rule) await event(client, row, { type: 'system', id: rule.id, login: 'reguła poziomu 3' }, 'zatwierdzenie', 'Reguła ' + rule.id.slice(0, 8) + ' (do ' + rule.max_amount + ' ' + rule.currency + ', ' + rule.max_per_day + '/dzień)');
    await audit(req || {}, 'operacja.zgloszenie', { actor, resource: 'approvals', resourceId: row.id, details: { typ: row.operation_type, poziom: level, status }, client });
    if (!outer) await client.query('COMMIT');
    return row;
  } catch (e) { if (!outer) await client.query('ROLLBACK').catch(() => {}); throw e; } finally { if (!outer) client.release(); }
}

async function lockApproval(client, id) {
  const r = await client.query('SELECT * FROM approvals WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rows[0]) throw new PolicyError(404, 'Nie znaleziono operacji.');
  return r.rows[0];
}

// Zmiana treści oczekującej operacji tworzy nową wersję; decyzja dotyczy zawsze konkretnej wersji.
async function updateOperation(actor, id, input, req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ap = await lockApproval(client, id);
    if (ap.status !== 'oczekuje') throw new PolicyError(409, 'Można zmieniać tylko operacje oczekujące na decyzję.');
    if (actor.type === 'agent' ? !(ap.requested_by_type === 'agent' && ap.requested_by === String(actor.id))
      : !(ap.requested_by_type === 'user' && ap.requested_by === String(actor.id)) && actor.role !== 'administrator')
      throw new PolicyError(403, 'Możesz zmieniać tylko własne wnioski.');
    const n = { ...ap };
    if (input.title !== undefined) n.title = String(input.title).trim().slice(0, 200);
    if (input.description !== undefined) n.description = String(input.description).slice(0, 5000);
    if (input.amount !== undefined) { n.amount = input.amount === '' || input.amount == null ? null : Number(input.amount); if (n.amount != null && (!Number.isFinite(n.amount) || n.amount < 0)) throw new PolicyError(400, 'Nieprawidłowa kwota.'); }
    if (input.currency !== undefined) n.currency = n.amount == null ? null : String(input.currency || 'PLN').toUpperCase().slice(0, 3);
    if (!n.title) throw new PolicyError(400, 'Podaj tytuł operacji.');
    n.version = ap.version + 1;
    n.payload_hash = hashOf(n);
    const r = await client.query(
      `UPDATE approvals SET title=$2, description=$3, amount=$4, currency=$5, version=$6, payload_hash=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, n.title, n.description, n.amount, n.currency, n.version, n.payload_hash]);
    await event(client, r.rows[0], actor, 'zmiana', 'Nowa wersja ' + n.version);
    await audit(req || {}, 'operacja.zmiana', { actor, resource: 'approvals', resourceId: id, details: { wersja: n.version }, client });
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

async function decide(actor, id, { decision, version, note }, req) {
  assertHumanAdmin(actor);
  if (!['zatwierdz', 'odrzuc'].includes(decision)) throw new PolicyError(400, 'Nieznana decyzja.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ap = await lockApproval(client, id);
    if (ap.status !== 'oczekuje') throw new PolicyError(409, 'Ta operacja ma już decyzję.');
    if (Number(version) !== ap.version) throw new PolicyError(409, 'Treść operacji zmieniła się (wersja ' + ap.version + '). Sprawdź ją ponownie przed decyzją.');
    if (hashOf(ap) !== ap.payload_hash) throw new PolicyError(409, 'Treść operacji nie zgadza się z zapisanym skrótem. Decyzja zablokowana.');
    const status = decision === 'zatwierdz' ? 'zatwierdzona' : 'odrzucona';
    const r = await client.query(
      `UPDATE approvals SET status=$2, decided_by=$3, decided_at=now(), decided_version=version, decided_hash=payload_hash, decision_note=$4, updated_at=now()
       WHERE id=$1 RETURNING *`, [id, status, actor.id, String(note || '').slice(0, 2000) || null]);
    await event(client, r.rows[0], actor, decision === 'zatwierdz' ? 'zatwierdzenie' : 'odrzucenie', note);
    await audit(req || {}, decision === 'zatwierdz' ? 'operacja.zatwierdzenie' : 'operacja.odrzucenie', { actor, resource: 'approvals', resourceId: id, details: { wersja: ap.version, skrot: ap.payload_hash.slice(0, 16) }, client });
    for (const fn of decisionHooks[ap.operation_type] || []) await fn(client, r.rows[0], actor);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// Wykonanie: tylko zatwierdzona operacja, w niezmienionej wersji. Skutek biznesowy podłączą moduły z etapu 3.
async function execute(actor, id, req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ap = await lockApproval(client, id);
    if (actor.type === 'agent' && await agentsStopped(client)) throw new PolicyError(423, 'Agenci AI są zatrzymani wyłącznikiem bezpieczeństwa.');
    const own = ap.requested_by_type === (actor.type === 'agent' ? 'agent' : 'user') && ap.requested_by === String(actor.id);
    if (!own && actor.role !== 'administrator') throw new PolicyError(403, 'Operację wykonuje zgłaszający albo administrator.');
    if (ap.status === 'wykonana') throw new PolicyError(409, 'Operacja została już wykonana.');
    if (ap.status !== 'zatwierdzona') throw new PolicyError(409, 'Operacja nie ma zgody administratora. Wykonanie zablokowane.');
    if (ap.decided_version !== ap.version || ap.decided_hash !== ap.payload_hash || hashOf(ap) !== ap.decided_hash)
      throw new PolicyError(409, 'Treść operacji różni się od zatwierdzonej wersji. Wykonanie zablokowane.');
    for (const fn of executeHooks[ap.operation_type] || []) await fn(client, ap, actor);
    const r = await client.query(`UPDATE approvals SET status='wykonana', executed_at=now(), executed_by=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, actorRef(actor).label]);
    await event(client, r.rows[0], actor, 'wykonanie');
    await audit(req || {}, 'operacja.wykonanie', { actor, resource: 'approvals', resourceId: id, details: { typ: ap.operation_type, wersja: ap.version }, client });
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

async function withdraw(actor, id, req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ap = await lockApproval(client, id);
    const own = ap.requested_by_type === 'user' && ap.requested_by === String(actor.id);
    if (!own && actor.role !== 'administrator') throw new PolicyError(403, 'Możesz wycofać tylko własny wniosek.');
    if (!['oczekuje', 'zatwierdzona'].includes(ap.status)) throw new PolicyError(409, 'Tej operacji nie można już wycofać.');
    const r = await client.query(`UPDATE approvals SET status='wycofana', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    await event(client, r.rows[0], actor, 'wycofanie');
    for (const fn of withdrawHooks[ap.operation_type] || []) await fn(client, r.rows[0], actor);
    await audit(req || {}, 'operacja.wycofanie', { actor, resource: 'approvals', resourceId: id, client });
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

module.exports = { LEVELS, OPERATIONS, REQUESTABLE_BY_USER, onDecision, onExecute, onWithdraw, PolicyError, hashOf, agentsStopped, assertHumanAdmin, requestOperation, updateOperation, decide, execute, withdraw };
