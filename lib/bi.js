'use strict';
// Business Intelligence: trendy 12 miesięcy i wskaźniki z danych wszystkich modułów (bez danych osobowych klientów
// poza nazwą firmy/wspólnoty). Używane przez moduł BI, dzienny raport zarządu i narzędzie agentów.
const { pool } = require('../db');

function months12() {
  const out = [], now = new Date();
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); }
  return out;
}
const series = (months, rows, key) => months.map(m => { const x = rows.find(r => r.m === m); return x ? Number(x[key]) || 0 : 0; });
const FROM = `date_trunc('month', current_date) - interval '11 months'`;
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;

async function analytics() {
  const months = months12();
  const q = s => pool.query(s).then(r => r.rows);
  const [fin, off, offTot, inst, instTot, cpl, cplTot, top, country, tasks, tasksNow, train, quiz, agents, devices] = await Promise.all([
    q(`SELECT to_char(entry_date, 'YYYY-MM') m, coalesce(sum(amount_pln) FILTER (WHERE kind='przychod'),0)::float przychod, coalesce(sum(amount_pln) FILTER (WHERE kind='koszt'),0)::float koszt FROM finance WHERE entry_date >= ${FROM} GROUP BY 1`),
    q(`SELECT to_char(created_at, 'YYYY-MM') m, count(*)::int utworzone, count(*) FILTER (WHERE sent_at IS NOT NULL)::int wyslane, count(*) FILTER (WHERE status='przyjeta')::int przyjete FROM offers WHERE created_at >= ${FROM} GROUP BY 1`),
    q(`SELECT count(*) FILTER (WHERE status='przyjeta')::int przyjete, count(*) FILTER (WHERE status='odrzucona')::int odrzucone, count(*) FILTER (WHERE sent_at IS NOT NULL)::int wyslane,
       coalesce(avg(total_pln) FILTER (WHERE sent_at IS NOT NULL),0)::float srednia_pln FROM offers WHERE created_at >= ${FROM}`),
    q(`SELECT to_char(planned_date, 'YYYY-MM') m, count(*) FILTER (WHERE status <> 'anulowany')::int zaplanowane, count(*) FILTER (WHERE status = 'odebrany')::int odebrane FROM installations WHERE planned_date >= ${FROM} GROUP BY 1`),
    q(`SELECT count(*) FILTER (WHERE status='odebrany')::int odebrane, count(*) FILTER (WHERE status='odebrany' AND accepted_at::date <= coalesce(planned_end, planned_date) + 1)::int terminowo,
       count(*) FILTER (WHERE status IN ('zaplanowany','w_toku') AND coalesce(planned_end, planned_date) < current_date)::int opoznione FROM installations WHERE planned_date >= ${FROM}`),
    q(`SELECT to_char(reported_at, 'YYYY-MM') m, count(*)::int zgloszone, count(*) FILTER (WHERE resolved_at IS NOT NULL)::int rozwiazane FROM complaints WHERE reported_at >= ${FROM} GROUP BY 1`),
    q(`SELECT count(*) FILTER (WHERE status NOT IN ('rozwiazana','odrzucona'))::int otwarte, round(avg(resolved_at - reported_at) FILTER (WHERE resolved_at IS NOT NULL), 1)::float sredni_czas_dni,
       count(*) FILTER (WHERE department_id='podzielniki-i-montaze')::int dzial1, count(*) FILTER (WHERE department_id='sprzedaz-czesci-i-eksport')::int dzial2 FROM complaints WHERE reported_at >= ${FROM}`),
    q(`SELECT c.name klient, sum(f.amount_pln)::float przychod FROM finance f JOIN customers c ON c.id = f.customer_id WHERE f.kind='przychod' AND f.entry_date >= ${FROM} GROUP BY c.name ORDER BY 2 DESC LIMIT 10`),
    q(`SELECT c.country kraj, count(*)::int transakcje, sum(s.total_pln)::float sprzedaz FROM sales_history s JOIN customers c ON c.id = s.customer_id WHERE s.status <> 'anulowana' AND s.sale_date >= ${FROM} GROUP BY 1 ORDER BY 3 DESC`),
    q(`SELECT m, sum(u)::int utworzone, sum(z)::int zakonczone FROM (SELECT to_char(created_at, 'YYYY-MM') m, 1 u, 0 z FROM tasks WHERE created_at >= ${FROM}
       UNION ALL SELECT to_char(completed_at, 'YYYY-MM'), 0, 1 FROM tasks WHERE completed_at >= ${FROM}) x GROUP BY m`),
    q(`SELECT count(*) FILTER (WHERE status IN ('nowe','w_toku'))::int otwarte, count(*) FILTER (WHERE status IN ('nowe','w_toku') AND due_date < current_date)::int po_terminie,
       count(*) FILTER (WHERE status IN ('nowe','w_toku') AND assignee_type='agent')::int dla_agentow FROM tasks`),
    q(`SELECT (SELECT count(*)::int FROM users) uzytkownicy, (SELECT count(*)::int FROM courses WHERE is_published) kursy, (SELECT count(*)::int FROM certificates) zaswiadczenia`),
    q(`SELECT round(avg(score_pct))::int sredni_wynik, count(*)::int podejscia, count(*) FILTER (WHERE passed)::int zaliczone FROM quiz_results WHERE created_at >= ${FROM}`),
    q(`SELECT to_char(created_at, 'YYYY-MM') m, count(*) FILTER (WHERE kind <> 'test_promptu')::int uruchomienia, coalesce(sum(cost_usd),0)::float koszt FROM agent_runs WHERE created_at >= ${FROM} GROUP BY 1`),
    q(`SELECT to_char(created_at, 'YYYY-MM') m, count(*)::int dodane FROM devices WHERE created_at >= ${FROM} GROUP BY 1`)
  ]);
  const o = offTot[0], i = instTot[0], c = cplTot[0], t = train[0];
  return {
    months,
    finanse: { przychod: series(months, fin, 'przychod'), koszt: series(months, fin, 'koszt') },
    oferty: { utworzone: series(months, off, 'utworzone'), wyslane: series(months, off, 'wyslane'), przyjete: series(months, off, 'przyjete'),
      konwersja_pct: pct(o.przyjete, o.przyjete + o.odrzucone), wyslane_razem: o.wyslane, przyjete_razem: o.przyjete, odrzucone_razem: o.odrzucone, srednia_wartosc_pln: Math.round(o.srednia_pln) },
    montaze: { zaplanowane: series(months, inst, 'zaplanowane'), odebrane: series(months, inst, 'odebrane'), terminowosc_pct: pct(i.terminowo, i.odebrane), odebrane_razem: i.odebrane, opoznione: i.opoznione,
      urzadzenia_dodane: series(months, devices, 'dodane') },
    reklamacje: { zgloszone: series(months, cpl, 'zgloszone'), rozwiazane: series(months, cpl, 'rozwiazane'), otwarte: c.otwarte, sredni_czas_dni: c.sredni_czas_dni, dzial1: c.dzial1, dzial2: c.dzial2 },
    klienci_top: top, sprzedaz_kraje: country,
    zadania: { utworzone: series(months, tasks, 'utworzone'), zakonczone: series(months, tasks, 'zakonczone'), ...tasksNow[0] },
    szkolenia: { ...t, ...quiz[0], zaliczalnosc_pct: pct(quiz[0].zaliczone, quiz[0].podejscia) },
    agenci: { uruchomienia: series(months, agents, 'uruchomienia'), koszt_usd: series(months, agents, 'koszt') }
  };
}

// Zwięzłe wskaźniki: bieżący miesiąc vs poprzedni (do raportu dziennego i dla agentów).
async function summary() {
  const a = await analytics(), L = a.months.length - 1;
  const cmp = arr => ({ ten_miesiac: Math.round(arr[L] * 100) / 100, poprzedni: Math.round(arr[L - 1] * 100) / 100 });
  return {
    miesiac: a.months[L], przychody_pln: cmp(a.finanse.przychod), koszty_pln: cmp(a.finanse.koszt),
    oferty_wyslane: cmp(a.oferty.wyslane), konwersja_ofert_pct: a.oferty.konwersja_pct, montaze_odebrane: cmp(a.montaze.odebrane), terminowosc_montazy_pct: a.montaze.terminowosc_pct,
    montaze_opoznione: a.montaze.opoznione, reklamacje_otwarte: a.reklamacje.otwarte, sredni_czas_reklamacji_dni: a.reklamacje.sredni_czas_dni,
    zadania_po_terminie: a.zadania.po_terminie, zaliczalnosc_testow_pct: a.szkolenia.zaliczalnosc_pct
  };
}

module.exports = { analytics, summary };
