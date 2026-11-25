'use strict';
// Dashboard właściciela: cała firma w wybranym okresie – wyniki działów (Ubezpieczenia: zysk, kwota polis osobno), projekty,
// zlecenia (otwarte, zagrożone, bez przydziału), obciążenie, magazyn, należności i zobowiązania, zadania, polisy, alerty.
// Wyłącznie dane z systemu (bez wartości przykładowych).
const express = require('express');
const { pool } = require('../../db');
const { requirePerm } = require('../../lib/rbac');
const { results } = require('./finanse');
const { wrap, V } = require('../_util');
const { plToday } = require('../../lib/dzis');

const r = express.Router();
const TODAY = `(now() AT TIME ZONE 'Europe/Warsaw')::date`;
const OPEN = `status NOT IN ('wykonane','rozliczone','zamkniete','anulowane')`;
const zl = n => Number(n).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';

r.get('/wlasciciel', requirePerm('owner.dashboard'), wrap(async (req, res) => {
  const od = V.date(req.query.od, 'Od') || plToday().slice(0, 8) + '01';
  const dd = V.date(req.query.do, 'Do') || plToday();
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const [fin, ops, load, stock, rec, pay, tasks, pol, rem, sales] = await Promise.all([
    results(od, dd),
    one(`SELECT (SELECT count(*)::int FROM projects WHERE status = 'w_realizacji') AS projekty_aktywne,
        (SELECT count(*)::int FROM work_orders WHERE ${OPEN}) AS zlecenia_otwarte,
        (SELECT count(*)::int FROM work_orders WHERE ${OPEN} AND due_date < ${TODAY}) AS zlecenia_po_terminie,
        (SELECT count(*)::int FROM work_orders WHERE ${OPEN} AND due_date BETWEEN ${TODAY} AND ${TODAY} + 3) AS zlecenia_zagrozone,
        (SELECT count(*)::int FROM work_orders WHERE ${OPEN} AND status IN ('nowe','do_przydzielenia')) AS bez_przydzialu,
        (SELECT count(*)::int FROM work_orders WHERE status = 'wykonane') AS do_rozliczenia,
        (SELECT count(*)::int FROM service_orders WHERE status IN ('nowe','oczekuje') AND assign_due < ${TODAY}) AS serwisy_po_terminie_przydzialu,
        (SELECT count(*)::int FROM part_orders WHERE status IN ('nowe','potwierdzone','wydane')) AS zamowienia_czesci_otwarte`),
    pool.query(`SELECT coalesce(nullif(u.full_name, ''), u.login) AS name,
        (SELECT count(*)::int FROM work_orders wo WHERE wo.assignee_id = u.id AND wo.${OPEN}) AS zlecenia,
        (SELECT coalesce(sum(hours), 0)::float FROM time_entries t WHERE t.user_id = u.id AND t.work_date BETWEEN $1 AND $2) AS godziny,
        EXISTS (SELECT 1 FROM absences a WHERE a.user_id = u.id AND ${TODAY} BETWEEN a.date_from AND a.date_to) AS nieobecny
      FROM users u WHERE u.is_active AND (u.role IN ('serwisant','monter','odczyty','kierownik') OR u.extra_roles && '{serwisant,monter,odczyty}')
      ORDER BY 2 DESC, 3 DESC LIMIT 8`, [od, dd]),
    one(`SELECT coalesce(sum(l.qty * i.avg_cost), 0)::float AS wartosc, count(DISTINCT i.id) FILTER (WHERE l.qty > 0)::int AS pozycje,
        (SELECT count(*)::int FROM stock_items i2 LEFT JOIN (SELECT item_id, sum(qty - reserved) f FROM stock_levels GROUP BY 1) t ON t.item_id = i2.id
          WHERE i2.is_active AND i2.min_qty > 0 AND coalesce(t.f, 0) < i2.min_qty) AS ponizej_minimum
      FROM stock_levels l JOIN stock_items i ON i.id = l.item_id`),
    one(`SELECT coalesce(sum(amount_pln), 0)::float AS razem, coalesce(sum(amount_pln) FILTER (WHERE due_date < ${TODAY}), 0)::float AS po_terminie, count(*)::int AS faktury
      FROM finance WHERE kind = 'przychod' AND invoice_no <> '' AND paid_at IS NULL`),
    one(`SELECT coalesce(sum(v), 0)::float AS razem, coalesce(sum(v) FILTER (WHERE d < ${TODAY}), 0)::float AS po_terminie FROM (
        SELECT total_value v, due_date d FROM stock_docs WHERE kind = 'PZ' AND status = 'zatwierdzony' AND paid_at IS NULL
        UNION ALL SELECT amount_pln, due_date FROM finance WHERE kind = 'koszt' AND due_date IS NOT NULL AND paid_at IS NULL AND category <> 'zwroty_sprzedazy') x`),
    one(`SELECT count(*) FILTER (WHERE status IN ('nowe','w_toku'))::int AS otwarte, count(*) FILTER (WHERE status IN ('nowe','w_toku') AND due_date < ${TODAY})::int AS po_terminie FROM tasks`),
    one(`SELECT count(*) FILTER (WHERE signed_at BETWEEN $1 AND $2)::int AS podpisane, coalesce(sum(total_amount) FILTER (WHERE signed_at BETWEEN $1 AND $2), 0)::float AS kwota,
        coalesce(sum(profit) FILTER (WHERE signed_at BETWEEN $1 AND $2), 0)::float AS zysk, count(*) FILTER (WHERE status = 'konczy_sie')::int AS konczy_30,
        count(*) FILTER (WHERE status IN ('aktywna', 'konczy_sie'))::int AS aktywne FROM policies_v WHERE cancelled_at IS NULL`, [od, dd]),
    one(`SELECT count(*)::int AS nowe FROM policy_reminders WHERE handled_at IS NULL`),
    one(`SELECT count(*)::int AS n, coalesce(sum(total_net), 0)::float AS przychod FROM part_orders WHERE status = 'zafakturowane' AND invoice_date BETWEEN $1 AND $2`, [od, dd])
  ]);
  // Najważniejsze alerty (z linkiem do miejsca, gdzie się je załatwia).
  const alerts = [], add = (level, text, link) => alerts.push({ level, text, link });
  if (ops.zlecenia_po_terminie) add('krytyczny', `Zlecenia po terminie: ${ops.zlecenia_po_terminie}`, '/dzial/podzielniki-i-montaze?tab=zlecenia');
  if (ops.serwisy_po_terminie_przydzialu) add('krytyczny', `Serwisy bez przydziału po 14 dniach: ${ops.serwisy_po_terminie_przydzialu}`, '/dzial/podzielniki-i-montaze?tab=serwisy');
  if (rec.po_terminie) add('ostrzezenie', `Należności po terminie: ${zl(rec.po_terminie)}`, '/finanse-firmy?tab=naleznosci');
  if (pay.po_terminie) add('ostrzezenie', `Zobowiązania po terminie: ${zl(pay.po_terminie)}`, '/finanse-firmy?tab=zobowiazania');
  if (pol.konczy_30) add('info', `Polisy kończące się w 30 dni: ${pol.konczy_30}${rem.nowe ? ` (przypomnienia do obsłużenia: ${rem.nowe})` : ''}`, '/dzial/ubezpieczenia?tab=odnowienia');
  if (stock.ponizej_minimum) add('info', `Pozycje magazynowe poniżej minimum: ${stock.ponizej_minimum}`, '/magazyn');
  if (ops.do_rozliczenia) add('info', `Zlecenia wykonane do rozliczenia: ${ops.do_rozliczenia}`, '/dzial/podzielniki-i-montaze?tab=zlecenia');
  if (tasks.po_terminie) add('ostrzezenie', `Zadania po terminie: ${tasks.po_terminie}`, '/zadania');
  res.json({ od, do: dd, finance: fin, ops, load: load.rows, stock, receivables: rec, payables: pay, tasks, policies: { ...pol, przypomnienia_nowe: rem.nowe }, parts: sales, alerts });
}));

module.exports = r;
