'use strict';
// Dział 2 – Sprzedaż części i eksport: TYLKO 4 funkcje – oferty, kalkulacje wielowalutowe, dokumenty eksportowe i celne,
// historia sprzedaży i reklamacji.
(() => {
  const U = () => window.MXT_UI, B = () => window.MXT_BIZ;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a), money = (a, c) => U().money(a, c);
  const pln = n => B().pln(n), table = (...a) => B().table(...a), opts = (...a) => B().opts(...a);
  const DEP = 'sprzedaz-czesci-i-eksport', PATH = '/dzial/' + DEP;
  const TABS = [['oferty', 'Oferty'], ['kalkulacje', 'Kalkulacje wielowalutowe', '', 'Kalkulacje'], ['eksport', 'Dokumenty eksportowe i celne', '', 'Eksport'], ['historia', 'Historia sprzedaży i reklamacji', '', 'Historia']];
  const EXP = { faktura_eksportowa: 'Faktura eksportowa (commercial invoice)', specyfikacja_wysylkowa: 'Specyfikacja wysyłkowa (packing list)', dane_celne: 'Dane do zgłoszenia celnego' };
  const INCO = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
  const SALE_ST = { w_realizacji: 'W realizacji', zrealizowana: 'Zrealizowana', anulowana: 'Anulowana' };
  let tab = 'oferty', lastCalc = null;

  async function page(root, path, alive) {
    const body = U().deptFrame(root, 'Sprzedaż części i eksport', TABS, tab, t => { tab = t; reload(); });
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await ({ oferty, kalkulacje, eksport, historia }[tab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel);
    if (tab === 'oferty') await B().agentsStrip(panel, DEP);
  }

  async function oferty(body, reload) { await B().offersPanel(body, DEP, reload); }

  // ---------- kalkulacje wielowalutowe i kursy ----------
  async function kalkulacje(body, reload, alive) {
    const rates = await api('kursy');
    if (!alive()) return;
    const curs = ['PLN', ...rates.map(r => r.code)];
    const newest = rates.reduce((m, r) => r.effective_date > m ? r.effective_date : m, '');
    body.innerHTML = `<div class="cols cols-even">
      <section class="panel"><h2 class="panel-title">Kalkulator</h2>
        <form class="calc-form" id="cf">
          <div class="field-row">${field('cf-a', 'Kwota', `<input id="cf-a" name="amount" type="number" min="0" step="0.01" required value="${esc(lastCalc ? lastCalc.amount : 1000)}">`)}
            ${field('cf-f', 'Z waluty', `<select id="cf-f" name="from">${curs.map(c => `<option${(lastCalc ? lastCalc.from : 'EUR') === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`)}
            ${field('cf-t', 'Na walutę', `<select id="cf-t" name="to">${curs.map(c => `<option${(lastCalc ? lastCalc.to : 'PLN') === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`)}</div>
          <div class="field-row">${field('cf-m', 'Marża %', `<input id="cf-m" name="margin_pct" type="number" step="0.1" value="${esc(lastCalc ? lastCalc.margin_pct : 0)}">`)}
            ${field('cf-d', 'Kurs na dzień (opcjonalnie)', '<input id="cf-d" name="date" type="date">')}</div>
          <button type="submit" class="btn btn-primary">Przelicz</button></form>
        <div id="cf-out" class="calc"></div></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Kursy walut NBP</h2><button type="button" class="btn btn-secondary btn-sm" id="nbp">Pobierz aktualne kursy NBP</button></div>
        <p class="muted small">Tabela A kursów średnich NBP${newest ? ' · ostatnia data kursu: <b>' + esc(fd(newest)) + '</b>' : ''}. Kursy w ofertach i kalkulacjach pochodzą wyłącznie z tej tabeli.</p>
        ${table(['Waluta', { t: 'Kurs PLN', num: 1 }, 'Data kursu', 'Źródło'], rates.map(r => `<tr><td><b>${esc(r.code)}</b></td><td class="num">${esc(r.rate_pln.toFixed(4))}</td><td>${esc(fd(r.effective_date))}</td><td class="small">${esc(r.source)}${r.table_no ? ' nr ' + esc(r.table_no) : ''}</td></tr>`), 'Brak kursów. Pobierz je z NBP.')}
        ${U().has('approvals.decide') ? '<button type="button" class="btn btn-ghost btn-sm" id="manual">Wpisz kurs ręcznie (administrator)</button>' : ''}</section></div>`;
    const out = body.querySelector('#cf-out');
    body.querySelector('#cf').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      lastCalc = { amount: val(f, 'amount'), from: val(f, 'from'), to: val(f, 'to'), margin_pct: val(f, 'margin_pct'), date: val(f, 'date') || null };
      try {
        const r = await api('kursy/przelicz', lastCalc);
        const rateLine = x => x.code === 'PLN' ? 'PLN' : `1 ${esc(x.code)} = ${esc(x.rate_pln)} PLN (${esc(fd(x.effective_date))}, ${esc(x.source)})`;
        out.innerHTML = `<p class="calc-res">${esc(money(r.amount, r.from.code))} = <b>${esc(money(r.result, r.to.code))}</b></p>
          ${Number(r.margin_pct) ? `<p>Z marżą ${esc(r.margin_pct)}%: <b>${esc(money(r.with_margin, r.to.code))}</b></p>` : ''}
          <p class="small">Równowartość w PLN: ${esc(pln(r.pln))} · kurs krzyżowy ${esc(r.cross_rate)}</p><p class="muted small">${rateLine(r.from)}<br>${rateLine(r.to)}</p>`;
      } catch (x) { out.innerHTML = `<p class="txt-danger small">${esc(x.message)}</p>`; }
    });
    body.querySelector('#nbp').addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true;
      try { const r = await api('kursy/pobierz', {}); toast(`Pobrano ${r.count} kursów, tabela ${r.table} z ${fd(r.date)}.`); reload(); } catch (x) { toast(x.message); b.disabled = false; }
    });
    const m = body.querySelector('#manual');
    if (m) m.addEventListener('click', () => modal('Kurs ręczny', `<p class="muted">Używaj tylko, gdy NBP jest niedostępne. Kurs zostanie oznaczony jako wpis ręczny z Twoim loginem.</p>
      <div class="field-row">${field('m-c', 'Waluta', '<input id="m-c" name="code" maxlength="3" required placeholder="EUR">')}${field('m-r', 'Kurs (PLN za 1 jednostkę)', '<input id="m-r" name="rate_pln" type="number" step="0.000001" min="0" required>')}${field('m-d', 'Data kursu', `<input id="m-d" name="effective_date" type="date" required value="${U().today()}">`)}</div>`,
      { submit: 'Zapisz kurs', onSubmit: async f => { await api('kursy/reczny', { code: val(f, 'code'), rate_pln: val(f, 'rate_pln'), effective_date: val(f, 'effective_date') }); toast('Kurs zapisany.'); reload(); } }));
  }

  // ---------- dokumenty eksportowe i celne ----------
  async function eksport(body, reload, alive) {
    const [docs, sales, offers] = await Promise.all([api('eksport'), api('sprzedaz'), api('oferty?dzial=' + DEP)]);
    if (!alive()) return;
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="e-new">Nowy dokument</button><span class="muted small">Dokumenty powstają z danych sprzedaży lub oferty i są przechowywane w wersjach.</span></div>
      <section class="panel">${table(['Numer', 'Rodzaj', 'Klient', 'Kraj', 'Incoterms', 'Źródło', 'Utworzono', ''], docs.map(d => `<tr><td class="nowrap"><b>${esc(d.number)}</b></td><td>${esc(EXP[d.kind])}</td><td>${esc(d.customer_name)}</td>
        <td>${esc(d.destination_country || '–')}</td><td>${esc(d.incoterms)}</td><td class="small">${esc(d.sale_number || d.offer_number || '–')}</td><td class="nowrap">${esc(fdt(d.created_at))} · ${esc(d.created_by_login || '')}</td>
        <td>${B().pdfLink('/api/dokumenty/' + d.document_id + '/plik', 'PDF')}</td></tr>`), 'Brak dokumentów eksportowych.')}</section>`;
    body.querySelector('#e-new').addEventListener('click', () => modal('Nowy dokument eksportowy', `
      ${field('e-k', 'Rodzaj dokumentu', `<select id="e-k" name="kind">${Object.entries(EXP).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>`)}
      <div class="field-row">${field('e-s', 'Ze sprzedaży', `<select id="e-s" name="sale_id">${opts(sales, null, x => x.number + ' – ' + x.customer_name + ' (' + money(x.total, x.currency) + ')', x => x.id, '– wybierz –')}</select>`)}
        ${field('e-o', 'albo z oferty', `<select id="e-o" name="offer_id">${opts(offers, null, x => x.number + ' – ' + x.customer_name, x => x.id, '– wybierz –')}</select>`)}</div>
      <div class="field-row">${field('e-i', 'Incoterms 2020', `<select id="e-i" name="incoterms">${INCO.map(i => `<option${i === 'DAP' ? ' selected' : ''}>${i}</option>`).join('')}</select>`)}
        ${field('e-c', 'Kraj przeznaczenia (kod)', '<input id="e-c" name="destination_country" maxlength="2" placeholder="z danych klienta">')}</div>
      ${field('e-n', 'Uwagi', '<textarea id="e-n" name="notes" rows="2"></textarea>')}
      <p class="muted small">Dane do zgłoszenia celnego wymagają kodów HS przy wszystkich pozycjach. Przed przekazaniem agencji celnej zweryfikuj dokument.</p>`,
    { submit: 'Generuj PDF', wide: true, onSubmit: async f => {
      const r = await api('eksport', { kind: val(f, 'kind'), sale_id: val(f, 'sale_id') || null, offer_id: val(f, 'sale_id') ? null : val(f, 'offer_id') || null, incoterms: val(f, 'incoterms'), destination_country: val(f, 'destination_country'), notes: val(f, 'notes') });
      toast('Dokument ' + r.number + ' gotowy.'); reload();
    } }));
  }

  // ---------- historia sprzedaży i reklamacji ----------
  async function historia(body, reload, alive) {
    const sales = await api('sprzedaz');
    if (!alive()) return;
    const total = sales.filter(s => s.status !== 'anulowana').reduce((a, s) => a + s.total_pln, 0), cost = sales.filter(s => s.status !== 'anulowana').reduce((a, s) => a + s.cost_pln, 0);
    body.innerHTML = `<section class="kpis kpis-3"><div class="kpi kpi-blue"><span class="kpi-v">${esc(sales.length)}</span><span class="kpi-l">Transakcje</span></div>
        <div class="kpi kpi-teal"><span class="kpi-v">${esc(pln(total))}</span><span class="kpi-l">Sprzedaż (PLN)</span></div><div class="kpi kpi-ok"><span class="kpi-v">${esc(pln(total - cost))}</span><span class="kpi-l">Marża (PLN)</span></div></section>
      <section class="panel"><h2 class="panel-title">Historia sprzedaży</h2>${table(['Numer', 'Data', 'Klient', { t: 'Kwota', num: 1 }, { t: 'PLN', num: 1 }, { t: 'Marża', num: 1 }, 'Oferta', 'Dok. eksp.', 'Reklamacje', 'Status'], sales.map(s => `<tr>
        <td class="nowrap"><b>${esc(s.number)}</b></td><td class="nowrap">${esc(fd(s.sale_date))}</td><td>${esc(s.customer_name)} <span class="muted small">${esc(s.country)}</span></td>
        <td class="num">${esc(money(s.total, s.currency))}</td><td class="num">${esc(pln(s.total_pln))}</td><td class="num">${esc(pln(s.total_pln - s.cost_pln))}</td><td class="small">${esc(s.offer_number || '–')}</td>
        <td class="num">${esc(s.export_docs)}</td><td>${s.complaints ? chip('warn', s.complaints) : '<span class="muted">–</span>'}</td>
        <td><label class="visually-hidden" for="ss-${s.id}">Status</label><select class="status-select" id="ss-${s.id}" data-ss="${s.id}">${Object.entries(SALE_ST).map(([k, v]) => `<option value="${k}"${k === s.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td></tr>`),
        'Brak sprzedaży. Sprzedaż powstaje, gdy klient przyjmie wysłaną ofertę.')}</section>`;
    body.querySelectorAll('[data-ss]').forEach(x => x.addEventListener('change', async () => { try { await api('sprzedaz/' + x.dataset.ss, { status: x.value }, 'PATCH'); toast('Status sprzedaży zmieniony.'); } catch (e) { toast(e.message); reload(); } }));
    await B().complaintsPanel(body, DEP, reload, { sales });
  }

  window.MXT_MODULES.register(PATH, { title: 'Sprzedaż części i eksport', perm: 'departments.view', render: page });
})();
