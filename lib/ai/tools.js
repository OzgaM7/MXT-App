'use strict';
// Narzędzia agentów. Agent może użyć wyłącznie narzędzi przypisanych do jego stanowiska w lib/ai/catalog.js
// (sprawdzane tutaj, przy każdym wywołaniu). Żadne narzędzie nie zatwierdza operacji ani nie zmienia ustawień agentów.
const { pool } = require('../../db');
const ops = require('../operations');
const { TOOL_LABELS } = require('./catalog');

const schema = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const DEFS = {
  dane_firmy: { description: 'Zwraca bieżące wskaźniki firmy MXT: zadania (otwarte, po terminie, pilne, zakończone w 7 dni) w podziale na działy oraz wnioski w Approval Center (liczby i kwoty).', input_schema: schema({}) },
  lista_zadan: { description: 'Zwraca do 50 otwartych zadań (tytuł, dział, priorytet, termin, status, przypisanie). Opcjonalnie filtr działu.', input_schema: schema({ dzial: { type: 'string', description: 'Identyfikator działu: podzielniki-i-montaze, sprzedaz-czesci-i-eksport, ubezpieczenia' } }) },
  lista_wnioskow: { description: 'Zwraca do 50 ostatnich wniosków z Approval Center (typ, tytuł, kwota, waluta, status, poziom).', input_schema: schema({ status: { type: 'string', enum: ['oczekuje', 'zatwierdzona', 'odrzucona', 'wykonana', 'wycofana'] } }) },
  pamiec_szukaj: { description: 'Przeszukuje pamięć agenta: osobistą, działową i korporacyjną. Zwraca do 10 wpisów.', input_schema: schema({ zapytanie: { type: 'string' } }, ['zapytanie']) },
  pamiec_zapisz: { description: 'Zapisuje krótką notatkę w pamięci osobistej agenta (fakty do wykorzystania w przyszłości).', input_schema: schema({ tresc: { type: 'string', maxLength: 2000 } }, ['tresc']) },
  zglos_operacje: { description: 'Zgłasza operację do Approval Center. Operacje wiążące (poziom 2) czekają na decyzję administratora – agent nie może ich zatwierdzić ani wykonać bez zgody.', input_schema: schema({
    typ: { type: 'string', description: 'Typ operacji dozwolony dla tego stanowiska' }, tytul: { type: 'string' }, opis: { type: 'string' },
    kwota: { type: 'number' }, waluta: { type: 'string' } }, ['typ', 'tytul', 'opis']) },
  baza_wiedzy: { description: 'Przeszukuje Knowledge Base MXT (dokumenty i procedury udostępnione agentom przez administratora). Zwraca do 5 dokumentów z fragmentami treści.', input_schema: schema({ zapytanie: { type: 'string' } }, ['zapytanie']) },
  finanse_podsumowanie: { description: 'Zwraca przychody, koszty i marże działów 1 i 2 (od początku roku i miesięcznie), należności oraz prognozę.', input_schema: schema({}) },
  rentownosc: { description: 'Zwraca rentowność (przychód, koszt, marża) budynków, zleceń montażowych i kontraktów działu Podzielniki i Montaże.', input_schema: schema({}) },
  kursy_walut: { description: 'Zwraca aktualne kursy walut z bazy MXT (źródło NBP, z datą kursu).', input_schema: schema({}) },
  montaze: { description: 'Zwraca harmonogram montaży (do 50), opcjonalnie od wskazanej daty.', input_schema: schema({ od: { type: 'string', description: 'RRRR-MM-DD' } }) },
  reklamacje: { description: 'Zwraca do 50 reklamacji (otwarte najpierw), opcjonalnie dla działu.', input_schema: schema({ dzial: { type: 'string' } }) },
  postep_szkolen: { description: 'Zwraca postęp pracowników w kursach platformy szkoleniowej (dział Ubezpieczenia).', input_schema: schema({}) },
  klienci: { description: 'Wyszukuje klientów w CRM (nazwa, rodzaj, kraj, kontakt).', input_schema: schema({ szukaj: { type: 'string' } }) },
  historia_sprzedazy: { description: 'Zwraca do 50 ostatnich sprzedaży (klient, data, kwota, waluta, status).', input_schema: schema({}) },
  oferty: { description: 'Zwraca do 50 ostatnich ofert (numer, klient, kwota, waluta, status, wersja).', input_schema: schema({ status: { type: 'string' } }) },
  budynki: { description: 'Zwraca budynki i wspólnoty (adres, liczba lokali, urządzenia, otwarte reklamacje).', input_schema: schema({ szukaj: { type: 'string' } }) },
  urzadzenia: { description: 'Wyszukuje urządzenia po numerze seryjnym lub budynku.', input_schema: schema({ numer_seryjny: { type: 'string' } }) },
  ekipy: { description: 'Zwraca ekipy montażowe, instalatorów i liczbę zaplanowanych montaży.', input_schema: schema({}) },
  kontrakty: { description: 'Zwraca kontrakty działu 1 z wartością, zafakturowaniem, płatnościami i kosztami.', input_schema: schema({}) },
  dokumenty_eksportowe: { description: 'Zwraca dokumenty eksportowe i celne (numer, rodzaj, klient, kraj, Incoterms).', input_schema: schema({}) },
  przygotuj_oferte: { description: 'Przygotowuje SZKIC oferty dla klienta z CRM: ceny liczone z kosztu i marży, kurs waluty z bazy (NBP). Szkic nie jest wysyłany.', input_schema: schema({
    klient_id: { type: 'string', description: 'Identyfikator klienta z narzędzia klienci' }, temat: { type: 'string' }, waluta: { type: 'string' }, marza_pct: { type: 'number' },
    pozycje: { type: 'array', items: schema({ nazwa: { type: 'string' }, ilosc: { type: 'number' }, jm: { type: 'string' }, koszt_pln: { type: 'number' }, kod_hs: { type: 'string' }, waga_kg: { type: 'number' } }, ['nazwa', 'ilosc', 'koszt_pln']) } },
    ['klient_id', 'temat', 'waluta', 'pozycje']) },
  analityka: { description: 'Zwraca wskaźniki Business Intelligence: przychody i koszty, oferty i konwersję, montaże i terminowość, reklamacje, zadania, szkolenia (trendy 12 miesięcy).', input_schema: schema({}) },
  zglos_wysylke_oferty: { description: 'Zgłasza wysyłkę szkicu oferty do Approval Center. Oferta zostanie wysłana dopiero po zatwierdzeniu tej wersji przez administratora.', input_schema: schema({ oferta_id: { type: 'string' } }, ['oferta_id']) }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wejście narzędzi walidowane w execute() (typy i zakresy), więc bez trybu strict.
const forAgent = agent => agent.tools.map(name => ({ name, ...DEFS[name] }));

async function snapshot() {
  const [t, byDep, ap] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE status IN ('nowe','w_toku'))::int AS otwarte,
      count(*) FILTER (WHERE status IN ('nowe','w_toku') AND due_date < current_date)::int AS po_terminie,
      count(*) FILTER (WHERE status IN ('nowe','w_toku') AND priority = 'pilny')::int AS pilne,
      count(*) FILTER (WHERE status = 'zakonczone' AND completed_at >= now() - interval '7 days')::int AS zakonczone_7d FROM tasks`),
    pool.query(`SELECT coalesce(d.name, 'bez działu') AS dzial, count(*)::int AS otwarte,
      count(*) FILTER (WHERE t.due_date < current_date)::int AS po_terminie FROM tasks t LEFT JOIN departments d ON d.id = t.department_id
      WHERE t.status IN ('nowe','w_toku') GROUP BY 1 ORDER BY 1`),
    pool.query(`SELECT status, count(*)::int AS liczba, coalesce(currency, '-') AS waluta, coalesce(sum(amount), 0)::float AS kwota
      FROM approvals GROUP BY status, currency ORDER BY status`)
  ]);
  const d = (await pool.query(`SELECT (SELECT count(*)::int FROM buildings) AS budynki, (SELECT count(*)::int FROM devices WHERE status = 'zamontowane') AS urzadzenia,
    (SELECT count(*)::int FROM installations WHERE status IN ('zaplanowany','w_toku') AND planned_date BETWEEN current_date AND current_date + 14) AS montaze_14d,
    (SELECT count(*)::int FROM complaints WHERE status NOT IN ('rozwiazana','odrzucona')) AS reklamacje_otwarte,
    (SELECT count(*)::int FROM offers WHERE status IN ('szkic','do_akceptacji')) AS oferty_w_toku,
    (SELECT coalesce(sum(amount_pln) FILTER (WHERE kind = 'przychod'), 0)::float FROM finance WHERE entry_date >= date_trunc('year', current_date)) AS przychod_rok,
    (SELECT coalesce(sum(amount_pln) FILTER (WHERE kind = 'koszt'), 0)::float FROM finance WHERE entry_date >= date_trunc('year', current_date)) AS koszt_rok`).catch(() => ({ rows: [{}] }))).rows[0];
  return { dzis: new Date().toISOString().slice(0, 10), zadania: t.rows[0], zadania_wg_dzialow: byDep.rows, wnioski: ap.rows, dzialy: d };
}

async function memoryFor(agent, query) {
  const p = [agent.id, agent.department];
  let where = `(scope = 'korporacyjna' OR (scope = 'osobista' AND agent_id = $1) OR (scope = 'dzialowa' AND department_id = $2))`;
  if (query) { p.push(query); where += ` AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $3)`; }
  const r = await pool.query(`SELECT scope, content, source, created_at FROM agent_memory WHERE ${where} ORDER BY created_at DESC LIMIT 10`, p);
  return r.rows;
}

async function execute(agent, name, input, ctx) {
  if (!agent.tools.includes(name) || !DEFS[name]) throw new Error('Narzędzie „' + name + '” nie jest przypisane do stanowiska ' + agent.name + '.');
  if (ctx && ctx.noTools) throw new Error('W teście promptu narzędzia są wyłączone.');
  if (await ops.agentsStopped()) throw new Error('Agenci są zatrzymani wyłącznikiem bezpieczeństwa.');
  switch (name) {
    case 'dane_firmy': return snapshot();
    case 'lista_zadan': {
      const p = [], w = [`t.status IN ('nowe','w_toku')`];
      if (input.dzial) { p.push(String(input.dzial)); w.push(`t.department_id = $1`); }
      const r = await pool.query(`SELECT t.title AS tytul, coalesce(d.name, '') AS dzial, t.priority AS priorytet, t.due_date AS termin, t.status,
        coalesce(u.login, t.assignee_id, '') AS przypisane FROM tasks t LEFT JOIN departments d ON d.id = t.department_id
        LEFT JOIN users u ON t.assignee_type = 'user' AND u.id::text = t.assignee_id WHERE ${w.join(' AND ')} ORDER BY t.due_date NULLS LAST LIMIT 50`, p);
      return r.rows;
    }
    case 'lista_wnioskow': {
      const st = ['oczekuje', 'zatwierdzona', 'odrzucona', 'wykonana', 'wycofana'].includes(input.status) ? input.status : null;
      const r = await pool.query(`SELECT operation_type AS typ, title AS tytul, amount::float AS kwota, currency AS waluta, status, level AS poziom, created_at AS zgloszono
        FROM approvals ${st ? 'WHERE status = $1' : ''} ORDER BY created_at DESC LIMIT 50`, st ? [st] : []);
      return r.rows;
    }
    case 'pamiec_szukaj': return memoryFor(agent, String(input.zapytanie || '').slice(0, 200));
    case 'pamiec_zapisz': {
      const t = String(input.tresc || '').trim().slice(0, 2000);
      if (!t) throw new Error('Pusta notatka.');
      await pool.query(`INSERT INTO agent_memory (scope, agent_id, content, source, created_by) VALUES ('osobista', $1, $2, $3, $1)`, [agent.id, t, ctx && ctx.source || '']);
      return { zapisano: true };
    }
    case 'zglos_operacje': {
      if (!agent.operations.includes(input.typ)) throw new Error('Stanowisko ' + agent.name + ' nie może zgłaszać operacji typu „' + input.typ + '”.');
      const a = await ops.requestOperation({ type: 'agent', id: agent.id, name: agent.name },
        { operation_type: input.typ, title: input.tytul, description: input.opis, amount: input.kwota, currency: input.waluta, department_id: agent.department });
      return { id: a.id, status: a.status, poziom: a.level, informacja: a.status === 'oczekuje' ? 'Czeka na decyzję administratora.' : 'Zarejestrowano.' };
    }
    case 'baza_wiedzy': {
      const q = String(input.zapytanie || '').slice(0, 200);
      const r = await pool.query(`SELECT d.title AS tytul, d.kind AS rodzaj, left(v.content, 1500) AS fragment FROM documents d
        JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version WHERE d.for_agents AND d.kind IN ('wiedza','procedura')
        AND (d.title ILIKE '%' || $1 || '%' OR to_tsvector('simple', v.content) @@ plainto_tsquery('simple', $1)) ORDER BY d.updated_at DESC LIMIT 5`, [q]);
      return r.rows;
    }
    case 'finanse_podsumowanie': { const s = await require('../../routes/biznes').financeSummary(); return { od_poczatku_roku: s.ytd, naleznosci: s.invoices, prognoza: s.forecast }; }
    case 'rentownosc': {
      const P = c => `coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.${c} = x.id AND f.kind = 'przychod'), 0)::float AS przychod, coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.${c} = x.id AND f.kind = 'koszt'), 0)::float AS koszt`;
      const [b, k] = await Promise.all([pool.query(`SELECT x.name AS budynek, x.address AS adres, ${P('building_id')} FROM buildings x LIMIT 50`), pool.query(`SELECT x.number AS kontrakt, x.title AS nazwa, x.value_net::float AS wartosc, ${P('project_id')} FROM projects x LIMIT 50`)]);
      return { budynki: b.rows, kontrakty: k.rows };
    }
    case 'kursy_walut': return require('../nbp').latest();
    case 'montaze': return (await pool.query(`SELECT x.number AS numer, x.planned_date AS termin, x.status, b.name AS budynek, b.address AS adres, cr.name AS ekipa, x.devices_planned AS urzadzenia_plan
      FROM installations x JOIN buildings b ON b.id = x.building_id LEFT JOIN crews cr ON cr.id = x.crew_id WHERE x.planned_date >= coalesce($1::date, current_date - 30) ORDER BY x.planned_date LIMIT 50`,
      [/^\d{4}-\d{2}-\d{2}$/.test(input.od || '') ? input.od : null])).rows;
    case 'reklamacje': return (await pool.query(`SELECT x.number AS numer, x.department_id AS dzial, x.title AS tytul, left(x.description, 500) AS opis, x.status, x.reported_at AS zgloszono,
      c.name AS klient, b.name AS budynek FROM complaints x LEFT JOIN customers c ON c.id = x.customer_id LEFT JOIN buildings b ON b.id = x.building_id
      WHERE ($1::text IS NULL OR x.department_id = $1) ORDER BY (x.status IN ('rozwiazana','odrzucona')), x.reported_at DESC LIMIT 50`, [input.dzial ? String(input.dzial) : null])).rows;
    case 'postep_szkolen': { const p = await require('../../routes/szkolenia').allProgress(); return p.users.map(u => ({ pracownik: u.login, kursy: u.courses.map(c => ({ kurs: c.title, postep_pct: c.pct, ukonczony: c.complete })) })); }
    case 'klienci': return (await pool.query(`SELECT id, name AS nazwa, kind AS rodzaj, country AS kraj, language AS jezyk, email, phone AS telefon FROM customers
      WHERE ($1 = '' OR name ILIKE '%' || $1 || '%') ORDER BY name LIMIT 50`, [String(input.szukaj || '').slice(0, 80)])).rows;
    case 'historia_sprzedazy': return (await pool.query(`SELECT s.number AS numer, c.name AS klient, s.sale_date AS data, s.total::float AS kwota, s.currency AS waluta, s.total_pln::float AS kwota_pln, s.status
      FROM sales_history s JOIN customers c ON c.id = s.customer_id ORDER BY s.sale_date DESC LIMIT 50`)).rows;
    case 'oferty': return (await pool.query(`SELECT o.id, o.number AS numer, c.name AS klient, o.title AS temat, o.total::float AS kwota, o.currency AS waluta, o.status, o.version AS wersja, o.department_id AS dzial
      FROM offers o JOIN customers c ON c.id = o.customer_id WHERE ($1::text IS NULL OR o.status = $1) ORDER BY o.created_at DESC LIMIT 50`, [input.status ? String(input.status) : null])).rows;
    case 'budynki': return (await pool.query(`SELECT x.name AS nazwa, x.address AS adres, x.city AS miasto, x.units_count AS lokale, c.name AS wspolnota,
      (SELECT count(*)::int FROM devices d WHERE d.building_id = x.id AND d.status = 'zamontowane') AS urzadzenia,
      (SELECT count(*)::int FROM complaints k WHERE k.building_id = x.id AND k.status NOT IN ('rozwiazana','odrzucona')) AS reklamacje_otwarte
      FROM buildings x LEFT JOIN customers c ON c.id = x.customer_id WHERE ($1 = '' OR x.name ILIKE '%' || $1 || '%' OR x.address ILIKE '%' || $1 || '%') ORDER BY x.name LIMIT 50`, [String(input.szukaj || '').slice(0, 80)])).rows;
    case 'urzadzenia': return (await pool.query(`SELECT d.serial_no AS numer_seryjny, d.type AS typ, d.model, d.location AS lokalizacja, d.status, d.installed_at AS zamontowano, b.name AS budynek
      FROM devices d LEFT JOIN buildings b ON b.id = d.building_id WHERE ($1 = '' OR d.serial_no ILIKE '%' || $1 || '%') ORDER BY d.created_at DESC LIMIT 50`, [String(input.numer_seryjny || '').slice(0, 60)])).rows;
    case 'ekipy': return (await pool.query(`SELECT c.name AS ekipa, c.leader AS brygadzista, c.is_active AS aktywna, (SELECT string_agg(i.name, ', ') FROM installers i WHERE i.crew_id = c.id AND i.is_active) AS instalatorzy,
      (SELECT count(*)::int FROM installations x WHERE x.crew_id = c.id AND x.status IN ('zaplanowany','w_toku') AND x.planned_date >= current_date) AS zaplanowane FROM crews c ORDER BY c.name`)).rows;
    case 'kontrakty': return (await pool.query(`SELECT x.number AS numer, x.title AS nazwa, c.name AS klient, x.status, x.value_net::float AS wartosc_netto,
      coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'przychod' AND f.invoice_no <> ''), 0)::float AS zafakturowano,
      coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'przychod' AND f.paid_at IS NOT NULL), 0)::float AS zaplacono,
      coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.project_id = x.id AND f.kind = 'koszt'), 0)::float AS koszt FROM projects x LEFT JOIN customers c ON c.id = x.customer_id ORDER BY x.created_at DESC LIMIT 50`)).rows;
    case 'dokumenty_eksportowe': return (await pool.query(`SELECT e.number AS numer, e.kind AS rodzaj, c.name AS klient, e.destination_country AS kraj, e.incoterms, e.created_at AS utworzono
      FROM export_documents e JOIN customers c ON c.id = e.customer_id ORDER BY e.created_at DESC LIMIT 50`)).rows;
    case 'przygotuj_oferte': {
      if (!UUID.test(String(input.klient_id || ''))) throw new Error('Podaj identyfikator klienta z narzędzia klienci.');
      const o = await require('../offers').create({ customer_id: input.klient_id, title: input.temat, currency: input.waluta || 'PLN', margin_pct: input.marza_pct || 0,
        department_id: agent.department, items: (input.pozycje || []).map(x => ({ ...x })) }, { agent: agent.id });
      await ops.requestOperation({ type: 'agent', id: agent.id, name: agent.name }, { operation_type: 'dokument.przygotuj', title: `Szkic oferty ${o.number}`, description: o.title, department_id: agent.department });
      return { oferta_id: o.id, numer: o.number, status: o.status, kwota: Number(o.total), waluta: o.currency, kurs: Number(o.rate_pln), data_kursu: o.rate_date, informacja: 'Szkic zapisany. Wysyłka wymaga zgody administratora.' };
    }
    case 'analityka': return require('../bi').analytics();
    case 'zglos_wysylke_oferty': {
      if (!UUID.test(String(input.oferta_id || ''))) throw new Error('Nieprawidłowy identyfikator oferty.');
      const ap = await require('../offers').requestSend(input.oferta_id, { type: 'agent', id: agent.id, name: agent.name });
      return { wniosek_id: ap.id, status: ap.status, informacja: 'Wysyłka czeka na decyzję administratora w Approval Center.' };
    }
  }
}

const toolList = agent => agent.tools.map(t => ({ id: t, label: TOOL_LABELS[t] || t }));

module.exports = { forAgent, execute, snapshot, memoryFor, toolList };
