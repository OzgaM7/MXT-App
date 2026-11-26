'use strict';
// Zlecenia serwisowe – API biura (/api/serwisy, uprawnienie service.manage) i serwisanta (/api/moje/serwisy, service.own).
// Serwisant widzi wyłącznie zlecenia przypisane do niego; cudze zlecenie zwraca 404 i trafia do rejestru jako odmowa.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/rbac');
const S = require('../lib/service');
const { wrap, idParam, V, bad, sendPdf, checkFresh } = require('./_util');
const usun = require('../lib/usun');
const { notify } = require('../lib/notify');

const office = express.Router(), own = express.Router();
const manage = requirePerm('service.manage'), approve = requirePerm('service.approve'), tech = requirePerm('service.own');
const PRIORITIES = Object.keys(S.PRIORITY);
const LIST = `SELECT o.id, o.number, o.received_at, o.assign_due, o.due_date, o.planned_date, o.priority, o.status, o.client_name, o.address, o.city, o.unit,
    o.contact_name, o.contact_phone, o.description, o.assigned_to, o.assigned_at, o.completed_at, o.approved_at, o.created_at, o.updated_at,
    o.building_id, o.customer_id, o.complaint_id, o.protocol_document_id, u.login AS assigned_login, u.full_name AS assigned_name, ${S.FLAGS}
  FROM service_orders o LEFT JOIN users u ON u.id = o.assigned_to`;

// Transakcja z blokadą zlecenia; `scope` (id serwisanta) ogranicza do zleceń przypisanych do tej osoby.
async function withOrder(req, id, scope, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query('SELECT * FROM service_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o || (scope && o.assigned_to !== scope)) {
      await client.query('ROLLBACK');
      if (o) await audit(req, 'odmowa_dostepu', { status: 'odmowa', resource: req.method + ' ' + req.baseUrl + '/:id', resourceId: id, details: { powod: 'zlecenie innego serwisanta' } });
      throw bad(404, 'Nie znaleziono zlecenia.');
    }
    const out = await fn(client, o);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
async function card(id, { forTech = false } = {}) {
  const o = (await pool.query(LIST + ' WHERE o.id = $1', [id])).rows[0];
  if (!o) return null;
  const [ev, ph] = await Promise.all([
    pool.query(`SELECT e.id, e.kind, e.from_status, e.to_status, e.note, e.data, e.created_at, u.login, u.full_name FROM service_events e LEFT JOIN users u ON u.id = e.created_by
      WHERE e.order_id = $1 ORDER BY e.id`, [id]),
    pool.query('SELECT id, mime, size, caption, created_at FROM service_photos WHERE order_id = $1 ORDER BY created_at', [id])
  ]);
  const extra = forTech ? {} : {
    complaint: o.complaint_id ? (await pool.query('SELECT id, number, title, status FROM complaints WHERE id = $1', [o.complaint_id])).rows[0] || null : null
  };
  return { ...o, events: ev.rows, photos: ph.rows, ...extra };
}
const strOpt = (v, max) => v === undefined ? undefined : V.str(v, max);

// Pola zlecenia z formularza (przyjęcie / edycja).
async function fields(b, partial, client) {
  const o = {}, set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set('client_name', v => V.str(v, 200)); set('address', v => V.str(v, 300)); set('city', v => V.str(v, 100)); set('unit', v => V.str(v, 40));
  set('contact_name', v => V.str(v, 120)); set('contact_phone', v => V.str(v, 40)); set('contact_email', v => V.str(v, 200));
  set('description', v => { const s = V.str(v, 4000, true, 'Opis usterki / zakres prac'); if (s.length < 3) throw bad(400, 'Opis usterki: co najmniej 3 znaki.'); return s; });
  set('priority', v => V.oneOf(v, PRIORITIES, 'Priorytet', 'normalny'));
  set('due_date', v => V.date(v, 'Termin realizacji'));
  set('customer_id', v => V.uuid(v, 'Klient')); set('building_id', v => V.uuid(v, 'Budynek')); set('complaint_id', v => V.uuid(v, 'Reklamacja'));
  if (!partial || b.received_at !== undefined) {
    o.received_at = V.date(b.received_at, 'Data otrzymania') || (await client.query(`SELECT to_char(${S.TODAY}, 'YYYY-MM-DD') d`)).rows[0].d;
    if (o.received_at > (await client.query(`SELECT to_char(${S.TODAY}, 'YYYY-MM-DD') d`)).rows[0].d) throw bad(400, 'Data otrzymania nie może być z przyszłości.');
    o.assign_due = await S.assignDue(o.received_at, client);
  }
  // Adres i klient z budynku / reklamacji, jeśli nie podano ręcznie.
  if (o.building_id && (!o.address || !o.client_name)) {
    const bd = (await client.query('SELECT b.name, b.address, b.city, b.customer_id, c.name AS customer FROM buildings b LEFT JOIN customers c ON c.id = b.customer_id WHERE b.id = $1', [o.building_id])).rows[0];
    if (!bd) throw bad(400, 'Nie znaleziono budynku.');
    if (!o.address) { o.address = bd.address; o.city = o.city || bd.city; }
    if (!o.client_name) o.client_name = bd.customer || bd.name;
    if (!o.customer_id && bd.customer_id) o.customer_id = bd.customer_id;
  }
  if (!partial && !o.address) throw bad(400, 'Podaj adres realizacji (albo wybierz budynek).');
  return o;
}

// =================== biuro ===================
office.get('/', manage, wrap(async (req, res) => {
  const p = [], w = [];
  const view = req.query.widok || 'aktywne';
  const VIEWS = {
    aktywne: `o.status NOT IN ('zatwierdzone','rozliczone','zamkniete','anulowane')`, nieprzypisane: `o.status IN ('nowe','oczekuje')`,
    po_terminie: `o.status NOT IN ('wykonane','zatwierdzone','rozliczone','zamkniete','anulowane') AND ((o.status IN ('nowe','oczekuje') AND o.assign_due < ${S.TODAY}) OR (o.due_date < ${S.TODAY}))`,
    w_realizacji: `o.status IN ('przypisane','zaplanowane','w_realizacji','ponowna_wizyta')`, do_zatwierdzenia: `o.status = 'wykonane'`,
    zakonczone: `o.status IN ('zatwierdzone','rozliczone','zamkniete')`, anulowane: `o.status = 'anulowane'`, wszystkie: 'true'
  };
  if (!VIEWS[view]) throw bad(400, 'Nieznany widok listy.');
  w.push(VIEWS[view]);
  if (req.query.serwisant) { p.push(V.uuid(req.query.serwisant)); w.push(`o.assigned_to = $${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(o.number ILIKE $${p.length} OR o.client_name ILIKE $${p.length} OR o.address ILIKE $${p.length} OR o.description ILIKE $${p.length} OR o.contact_phone ILIKE $${p.length})`); }
  const page = Math.max(1, parseInt(req.query.strona, 10) || 1), per = 50;
  const W = 'WHERE ' + w.join(' AND ');
  const [q, n] = await Promise.all([
    pool.query(`${LIST} ${W} ORDER BY (o.status IN ('nowe','oczekuje')) DESC, CASE o.priority WHEN 'pilny' THEN 0 WHEN 'wysoki' THEN 1 WHEN 'normalny' THEN 2 ELSE 3 END,
      coalesce(o.planned_date, o.due_date, o.assign_due), o.number LIMIT ${per} OFFSET ${(page - 1) * per}`, p),
    pool.query(`SELECT count(*)::int n FROM service_orders o ${W}`, p)
  ]);
  res.set('X-Total-Count', String(n.rows[0].n));
  res.json(q.rows);
}));
office.get('/podsumowanie', manage, wrap(async (req, res) => {
  const q = await pool.query(`SELECT
      count(*) FILTER (WHERE status IN ('nowe','oczekuje'))::int AS nieprzypisane,
      count(*) FILTER (WHERE status IN ('nowe','oczekuje') AND assign_due < ${S.TODAY})::int AS po_terminie_przydzialu,
      count(*) FILTER (WHERE status IN ('nowe','oczekuje') AND assign_due >= ${S.TODAY} AND assign_due - ${S.TODAY} <= 3)::int AS przydzial_wkrotce,
      count(*) FILTER (WHERE status IN ('przypisane','zaplanowane','w_realizacji','ponowna_wizyta'))::int AS w_realizacji,
      count(*) FILTER (WHERE status = 'ponowna_wizyta')::int AS ponowna_wizyta,
      count(*) FILTER (WHERE due_date < ${S.TODAY} AND status NOT IN ('wykonane','zatwierdzone','rozliczone','zamkniete','anulowane'))::int AS po_terminie_realizacji,
      count(*) FILTER (WHERE status = 'wykonane')::int AS do_zatwierdzenia
    FROM service_orders`);
  res.json({ ...q.rows[0], termin_przydzialu_dni: (await S.settings()).assign_days });
}));
office.get('/serwisanci', manage, wrap(async (req, res) => res.json(await S.technicians())));
office.get('/reklamacje', manage, wrap(async (req, res) => {
  const q = await pool.query(`SELECT k.id, k.number, k.title, k.building_id, k.customer_id, b.name AS building_name, c.name AS customer_name FROM complaints k
    LEFT JOIN buildings b ON b.id = k.building_id LEFT JOIN customers c ON c.id = k.customer_id
    WHERE k.department_id = 'podzielniki-i-montaze' AND k.status NOT IN ('rozwiazana','odrzucona') ORDER BY k.reported_at DESC LIMIT 200`);
  res.json(q.rows);
}));

office.post('/', manage, wrap(async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Zlecenie z reklamacji: budynek i klient z reklamacji, jeśli nie wskazano ich ręcznie.
    if (b.complaint_id) {
      const k = (await client.query('SELECT building_id, customer_id FROM complaints WHERE id = $1', [V.uuid(b.complaint_id, 'Reklamacja')])).rows[0];
      if (!k) throw bad(400, 'Nie znaleziono reklamacji.');
      if (!b.building_id && k.building_id) b.building_id = k.building_id;
      if (!b.customer_id && k.customer_id) b.customer_id = k.customer_id;
    }
    const f = await fields(b, false, client);
    const number = await require('../lib/docs').nextNumber(client, 'SR');
    const status = b.zweryfikowane === false ? 'nowe' : 'oczekuje';
    const keys = Object.keys(f);
    const o = (await client.query(`INSERT INTO service_orders (number, status, created_by, ${keys.join(', ')}) VALUES ($1, $2, $3, ${keys.map((k, i) => '$' + (i + 4)).join(', ')}) RETURNING *`,
      [number, status, req.user.id, ...keys.map(k => f[k])])).rows[0];
    await S.event(client, o.id, 'utworzenie', { to: status, note: o.description, data: { termin_przydzialu: o.assign_due }, userId: req.user.id });
    let x = o;
    if (b.assigned_to) x = await assign(client, o, b.assigned_to, b.planned_date, req.user);
    await audit(req, 'serwis.przyjecie', { resource: 'service_orders', resourceId: o.id, details: { numer: number, priorytet: o.priority, termin_przydzialu: o.assign_due }, client });
    await client.query('COMMIT');
    res.status(201).json(x);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));

office.get('/:id', idParam, manage, wrap(async (req, res) => {
  const c = await card(req.params.id);
  if (!c) throw bad(404, 'Nie znaleziono zlecenia.');
  res.json(c);
}));

office.patch('/:id', idParam, manage, wrap(async (req, res) => {
  const x = await withOrder(req, req.params.id, null, async (client, o) => {
    if (['zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'].includes(o.status)) throw bad(409, 'Zlecenie jest zamknięte – nie można go edytować.');
    checkFresh(o.updated_at, (req.body || {}).updated_at);
    const f = await fields(req.body || {}, true, client);
    const keys = Object.keys(f).filter(k => String(f[k] == null ? '' : f[k]) !== String(o[k] == null ? '' : o[k] instanceof Date ? o[k].toISOString().slice(0, 10) : o[k]));
    if (!keys.length) throw bad(400, 'Brak zmian.');
    const r = (await client.query(`UPDATE service_orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [o.id, ...keys.map(k => f[k])])).rows[0];
    await S.event(client, o.id, 'edycja', { data: Object.fromEntries(keys.map(k => [k, f[k]])), userId: req.user.id });
    await audit(req, 'serwis.zmiana', { resource: 'service_orders', resourceId: o.id, details: Object.fromEntries(keys.map(k => [k, f[k]])), client });
    // Istotne dla serwisanta: termin realizacji, priorytet pilny.
    if (keys.includes('due_date')) await S.toTech(client, r, 'serwis.zmiana_terminu', `Zmiana terminu realizacji: serwis ${o.number}`, `${S.where(r)} · nowy termin realizacji: ${S.plDate(r.due_date) || 'bez terminu'}`);
    if (keys.includes('priority') && r.priority === 'pilny') await S.toTech(client, r, 'serwis.pilne', `Pilne: serwis ${o.number}`, S.where(r));
    return r;
  });
  res.json(x);
}));

office.post('/:id/weryfikacja', idParam, manage, wrap(async (req, res) => {
  res.json(await withOrder(req, req.params.id, null, async (client, o) => {
    if (o.status !== 'nowe') throw bad(409, 'Weryfikuje się tylko nowe zgłoszenie.');
    return S.setStatus(client, o, 'oczekuje', { userId: req.user.id, note: V.str((req.body || {}).notatka, 500) });
  }));
}));

async function assign(client, o, userId, plannedDate, actor) {
  const to = V.uuid(userId, 'Serwisant', true), planned = V.date(plannedDate, 'Termin wizyty');
  if (!(await S.isTechnician(to, client))) throw bad(400, 'Wybierz aktywne konto z rolą Serwisant.');
  if (!['nowe', 'oczekuje', 'przypisane', 'zaplanowane', 'ponowna_wizyta'].includes(o.status)) throw bad(409, `Nie można zmienić serwisanta w stanie „${S.ST[o.status]}”.`);
  const prev = o.assigned_to;
  const status = planned ? 'zaplanowane' : ['ponowna_wizyta'].includes(o.status) ? o.status : 'przypisane';
  const x = await S.setStatus(client, o, status, { userId: actor.id, data: { serwisant: to, termin_wizyty: planned }, extra: { assigned_to: to, assigned_at: new Date(), ...(planned ? { planned_date: planned } : {}) } });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  await S.event(client, o.id, 'przydzial', { data: { serwisant: to, poprzedni: prev, w_terminie: String(o.assign_due) >= today }, userId: actor.id });
  if (prev && prev !== to) await S.toTech(client, { ...o, assigned_to: prev }, 'serwis.odwolanie', `Serwis ${o.number} przekazany innemu serwisantowi`, S.where(o));
  if (prev !== to) await S.toTech(client, x, 'serwis.przydzial', `Nowe zlecenie serwisowe ${o.number}`,
    `${S.where(x)} · ${x.description.slice(0, 160)}${planned ? ' · wizyta: ' + S.plDate(planned) : ''}${x.due_date ? ' · termin realizacji: ' + S.plDate(x.due_date) : ''}`);
  else if (planned && String(planned) !== String(o.planned_date)) await S.toTech(client, x, 'serwis.zmiana_terminu', `Zmiana terminu wizyty: serwis ${o.number}`, `${S.where(x)} · wizyta: ${S.plDate(planned)}`);
  return x;
}
office.post('/:id/przydziel', idParam, manage, wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await withOrder(req, req.params.id, null, async (client, o) => {
    const x = await assign(client, o, b.assigned_to, b.planned_date, req.user);
    await audit(req, 'serwis.przydzial', { resource: 'service_orders', resourceId: o.id, details: { numer: o.number, serwisant: x.assigned_to, termin_wizyty: x.planned_date }, client });
    return x;
  }));
}));
office.post('/:id/odbierz', idParam, manage, wrap(async (req, res) => {
  const reason = V.str((req.body || {}).powod, 500, true, 'Powód');
  res.json(await withOrder(req, req.params.id, null, async (client, o) => {
    if (!['przypisane', 'zaplanowane', 'ponowna_wizyta'].includes(o.status)) throw bad(409, 'Przydział odbiera się zleceniu przypisanemu lub zaplanowanemu.');
    const x = await S.setStatus(client, o, 'oczekuje', { userId: req.user.id, note: reason, extra: { assigned_to: null, assigned_at: null, planned_date: null } });
    await S.toTech(client, o, 'serwis.odwolanie', `Odebrano przydział: serwis ${o.number}`, `${S.where(o)} · ${reason}`);
    await audit(req, 'serwis.odebranie', { resource: 'service_orders', resourceId: o.id, details: { numer: o.number, powod: reason }, client });
    return x;
  }));
}));
// Zmiana terminu wizyty (i opcjonalnie realizacji) przez biuro.
office.post('/:id/termin', idParam, manage, wrap(async (req, res) => {
  const b = req.body || {}, planned = V.date(b.planned_date, 'Termin wizyty', true);
  res.json(await withOrder(req, req.params.id, null, async (client, o) => {
    if (!['przypisane', 'zaplanowane', 'ponowna_wizyta'].includes(o.status)) throw bad(409, 'Termin wizyty ustawia się po przydzieleniu serwisanta.');
    const x = await S.setStatus(client, o, 'zaplanowane', { userId: req.user.id, data: { termin_wizyty: planned }, extra: { planned_date: planned } });
    await S.toTech(client, x, 'serwis.zmiana_terminu', `Termin wizyty: serwis ${o.number}`, `${S.where(x)} · wizyta: ${S.plDate(planned)}`);
    return x;
  }));
}));
// Biuro: cofnięcie wykonanego zlecenia do poprawy (np. niepełny protokół).
office.post('/:id/do-poprawy', idParam, manage, wrap(async (req, res) => {
  const note = V.str((req.body || {}).powod, 1000, true, 'Powód');
  res.json(await withOrder(req, req.params.id, null, async (client, o) => {
    if (o.status !== 'wykonane') throw bad(409, 'Do poprawy cofa się zlecenie w stanie „Wykonane”.');
    const x = await S.setStatus(client, o, 'w_realizacji', { userId: req.user.id, note, extra: { completed_at: null } });
    await S.toTech(client, x, 'serwis.do_poprawy', `Do poprawy: serwis ${o.number}`, note);
    return x;
  }));
}));
office.post('/:id/zatwierdz', idParam, approve, wrap(async (req, res) => {
  res.json(await withOrder(req, req.params.id, null, async (client, o) => {
    if (o.status !== 'wykonane') throw bad(409, 'Zatwierdza się zlecenie wykonane (z protokołem).');
    const x = await S.setStatus(client, o, 'zatwierdzone', { userId: req.user.id, note: V.str((req.body || {}).notatka, 500), extra: { approved_at: new Date(), approved_by: req.user.id } });
    await audit(req, 'serwis.zatwierdzenie', { resource: 'service_orders', resourceId: o.id, details: { numer: o.number }, client });
    return x;
  }));
}));
office.post('/:id/anuluj', idParam, manage, wrap(async (req, res) => {
  const reason = V.str((req.body || {}).powod, 500, true, 'Powód anulowania');
  res.json(await withOrder(req, req.params.id, null, async (client, o) => {
    if (['zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'].includes(o.status)) throw bad(409, 'Zlecenie jest już zamknięte.');
    const x = await S.setStatus(client, o, 'anulowane', { userId: req.user.id, note: reason, extra: { cancel_reason: reason } });
    await S.toTech(client, o, 'serwis.anulowanie', `Anulowano serwis ${o.number}`, `${S.where(o)} · ${reason}`);
    await audit(req, 'serwis.anulowanie', { resource: 'service_orders', resourceId: o.id, details: { numer: o.number, powod: reason }, client });
    return x;
  }));
}));

// =================== wspólne: notatki, zdjęcia, protokół (biuro i serwisant) ===================
function shared(router, guard, scopeOf) {
  router.post('/:id/notatka', idParam, guard, wrap(async (req, res) => {
    const note = V.str((req.body || {}).notatka, 2000, true, 'Notatka');
    res.status(201).json(await withOrder(req, req.params.id, scopeOf(req), async (client, o) => {
      if (['zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'].includes(o.status)) throw bad(409, 'Zlecenie jest zamknięte.');
      await S.event(client, o.id, (req.body || {}).czynnosc ? 'czynnosc' : 'notatka', { note, userId: req.user.id });
      return { ok: true };
    }));
  }));
  router.post('/:id/zdjecia', idParam, guard, wrap(async (req, res) => {
    const b = req.body || {};
    res.status(201).json(await withOrder(req, req.params.id, scopeOf(req), (client, o) => S.addPhoto(client, o, b.data, b.podpis, req.user.id)));
  }));
  router.get('/:id/zdjecia/:pid', idParam, guard, wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.pid)) throw bad(404, 'Nie znaleziono zdjęcia.');
    const scope = scopeOf(req);
    const p = (await pool.query(`SELECT p.mime, p.data FROM service_photos p JOIN service_orders o ON o.id = p.order_id
      WHERE p.id = $1 AND p.order_id = $2 ${scope ? 'AND o.assigned_to = $3' : ''}`, scope ? [req.params.pid, req.params.id, scope] : [req.params.pid, req.params.id])).rows[0];
    if (!p) throw bad(404, 'Nie znaleziono zdjęcia.');
    res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'" });
    res.end(p.data);
  }));
  router.post('/:id/protokol', idParam, guard, wrap(async (req, res) => {
    const out = await withOrder(req, req.params.id, scopeOf(req), async (client, o) => {
      const r = await S.protocol(client, o, req.body, req.user);
      await audit(req, 'serwis.protokol', { resource: 'service_orders', resourceId: o.id, details: { numer: o.number, protokol: r.number, wersja: r.version }, client });
      return r;
    });
    res.status(201).json({ document_id: out.document_id, number: out.number, version: out.version, status: out.order.status });
  }));
}
shared(office, manage, () => null);

// =================== serwisant ===================
own.get('/', tech, wrap(async (req, res) => {
  const done = req.query.zakres === 'zakonczone';
  const q = await pool.query(`${LIST} WHERE o.assigned_to = $1 AND ${done
      ? `o.status IN ('wykonane','zatwierdzone','rozliczone','zamkniete') AND o.completed_at >= now() - interval '60 days'`
      : `o.status IN ('przypisane','zaplanowane','w_realizacji','ponowna_wizyta')`}
    ORDER BY ${done ? 'o.completed_at DESC' : `CASE o.priority WHEN 'pilny' THEN 0 WHEN 'wysoki' THEN 1 ELSE 2 END, coalesce(o.planned_date, o.due_date) NULLS LAST, o.number`} LIMIT 200`, [req.user.id]);
  res.json(q.rows);
}));
own.get('/:id', idParam, tech, wrap(async (req, res) => {
  const c = await card(req.params.id, { forTech: true });
  if (!c || c.assigned_to !== req.user.id) {
    if (c) await audit(req, 'odmowa_dostepu', { status: 'odmowa', resource: 'GET /api/moje/serwisy/:id', resourceId: req.params.id, details: { powod: 'zlecenie innego serwisanta' } });
    throw bad(404, 'Nie znaleziono zlecenia.');
  }
  res.json(c);
}));
own.post('/:id/status', idParam, tech, wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await withOrder(req, req.params.id, req.user.id, async (client, o) => {
    const to = String(b.status || '');
    if (!(S.TECH_FLOW[o.status] || []).includes(to)) throw bad(409, `Z „${S.ST[o.status]}” nie można przejść do „${S.ST[to] || to}”.`);
    const planned = V.date(b.planned_date, 'Termin wizyty'), note = V.str(b.notatka, 1000);
    if (to === 'zaplanowane' && !planned) throw bad(400, 'Podaj termin wizyty.');
    if (to === 'ponowna_wizyta' && note.length < 3) throw bad(400, 'Opisz, dlaczego potrzebna jest ponowna wizyta.');
    const x = await S.setStatus(client, o, to, { userId: req.user.id, note, data: planned ? { termin_wizyty: planned } : {}, extra: planned ? { planned_date: planned } : {} });
    if (to === 'ponowna_wizyta') await S.toManagers(client, x, 'serwis.ponowna_wizyta', `Ponowna wizyta: serwis ${o.number}`, `${S.where(x)} · ${note}${planned ? ' · proponowany termin: ' + S.plDate(planned) : ''}`);
    return x;
  }));
}));
own.get('/:id/protokol', idParam, tech, wrap(async (req, res) => {
  const o = (await pool.query('SELECT number, assigned_to, protocol_document_id FROM service_orders WHERE id = $1', [req.params.id])).rows[0];
  if (!o || o.assigned_to !== req.user.id || !o.protocol_document_id) throw bad(404, 'Nie znaleziono protokołu.');
  const v = await require('../lib/docs').getVersion(o.protocol_document_id);
  sendPdf(res, v.file_data, v.file_name || 'protokol.pdf', req.query.pobierz !== '1');
}));
shared(own, tech, req => req.user.id);

// Zlecenie serwisowe wpisane przez pomyłkę (duplikat, test) – usunięcie tylko przed rozpoczęciem prac i bez zdjęć, materiałów,
// czasu pracy, protokołu i finansów. Zgłoszenie telefoniczne, z którego powstało, zostaje (bez powiązania).
usun.register(office, '', manage, { table: 'service_orders', action: 'serwis.usuniecie', what: x => `Zlecenie ${x.number}`, skip: ['phone_requests'],
  extra: [['zdjęcia', 'SELECT count(*)::int FROM service_photos WHERE order_id = $1'],
    ['wydania materiałów', `SELECT count(*)::int FROM stock_docs WHERE related_type = 'service_order' AND related_id = $1 AND status = 'zatwierdzony'`],
    ['rezerwacje materiałów', `SELECT count(*)::int FROM stock_reservations WHERE related_type = 'service_order' AND related_id = $1 AND status = 'aktywna'`],
    ['czas pracy', `SELECT count(*)::int FROM time_entries WHERE related_type = 'service_order' AND related_id = $1`],
    ['dokumenty', `SELECT count(*)::int FROM documents WHERE related_type = 'service_order' AND related_id = $1`]],
  blockers: x => [...(['nowe', 'oczekuje', 'przypisane', 'zaplanowane', 'anulowane'].includes(x.status) ? [] : [`status „${x.status.replace('_', ' ')}”`]), ...(x.protocol_document_id ? ['protokół'] : [])],
  before: async (c, x) => {
    await c.query('UPDATE phone_requests SET service_order_id = NULL WHERE service_order_id = $1', [x.id]);
    if (x.assigned_to && x.status !== 'anulowane') await notify([x.assigned_to], { kind: 'serwis.anulowanie', title: `Usunięto zlecenie ${x.number}`, body: x.client_name || '', link: '/moje-serwisy', related_type: 'service_order', related_id: x.id }, { client: c });
  },
  hint: 'Anuluj zlecenie (z powodem) – historia zostanie.' });

module.exports = { office, own };
