'use strict';
// ERP – Finanse firmy (wyniki działów, należności z wiekowaniem, zobowiązania, przepływy, eksport dla księgowości, stan integracji)
// oraz Pulpit właściciela (cała firma w wybranym okresie, alerty). Kwota polis NIGDY nie jest przychodem MXT – tylko zysk z marży.
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b), has = p => U().has(p);
  const fd = v => U().fd(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => n == null ? '–' : U().money(n, 'PLN');
  const pct = v => v == null ? '–' : String(v).replace('.', ',') + '%';
  const td = (label, html, cls) => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;
  const ctable = (head, rows, empty, foot) => rows.length ? `<div class="table-wrap"><table class="table table-cards"><thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.t || h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody>${foot || ''}</table></div>` : `<p class="empty-inline">${esc(empty)}</p>`;
  const tile = (l, v, f, tone) => `<div class="hk${tone ? ' hk-' + tone : ''}"><span class="hk-l">${esc(l)}</span><span class="hk-v">${esc(v)}</span>${f ? `<span class="hk-f">${esc(f)}</span>` : ''}</div>`;
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => iso(new Date());
  const DEPT = { 'podzielniki-i-montaze': 'Ciepłomierze i podzielniki', 'sprzedaz-czesci-i-eksport': 'Sprzedaż części', ubezpieczenia: 'Ubezpieczenia', '': 'Wspólne' };

  // Zakresy dat: ten miesiąc, poprzedni, kwartał, rok, własny.
  function presets() {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth(), q = Math.floor(m / 3) * 3;
    return { miesiac: ['Ten miesiąc', iso(new Date(y, m, 1)), today()], poprzedni: ['Poprzedni miesiąc', iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
      kwartal: ['Ten kwartał', iso(new Date(y, q, 1)), today()], rok: ['Ten rok', iso(new Date(y, 0, 1)), today()] };
  }
  function periodBar(per, onChange) {
    const P = presets(), active = Object.keys(P).find(k => P[k][1] === per.od && P[k][2] === per.do) || '';
    const html = `<form class="toolbar per-bar" data-per><div class="seg" role="group" aria-label="Okres">${Object.entries(P).map(([k, v]) => `<button type="button" class="seg-b${k === active ? ' seg-on' : ''}" data-pp="${k}"${k === active ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${esc(v[0])}</button>`).join('')}</div>
      <span class="per-f"><label class="small muted" for="per-od">Od</label><input id="per-od" name="od" type="date" class="select-sm" value="${esc(per.od)}" required></span>
      <span class="per-f"><label class="small muted" for="per-do">do</label><input id="per-do" name="do" type="date" class="select-sm" value="${esc(per.do)}" required></span><button type="submit" class="btn btn-secondary btn-sm">Pokaż</button></form>`;
    const bind = root => {
      const f = root.querySelector('[data-per]');
      f.querySelectorAll('[data-pp]').forEach(b => b.addEventListener('click', () => { const p = P[b.dataset.pp]; per.od = p[1]; per.do = p[2]; onChange(); }));
      f.addEventListener('submit', e => { e.preventDefault(); const od = val(f, 'od'), dd = val(f, 'do'); if (od > dd) { toast('Data „od” jest późniejsza niż „do”.'); return; } per.od = od; per.do = dd; onChange(); });
    };
    return { html, bind };
  }
  const deptBars = deps => {
    const max = Math.max(1, ...deps.map(d => Math.abs(d.wynik)));
    return `<div class="hbars">${deps.map(d => `<div class="hb"><span class="hb-l">${esc(d.name)}</span><span class="hb-bar"><i class="${d.wynik < 0 ? 'neg' : ''}" data-w="${Math.round(Math.abs(d.wynik) / max * 100)}"></i></span><span class="hb-v">${esc(pln(d.wynik))}</span></div>`).join('')}</div>`;
  };
  const deptTable = r => ctable(['Dział', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Wynik', num: 1 }, { t: 'Marża', num: 1 }], r.departments.map(d => `<tr>
      ${td('Dział', esc(d.name) + (d.department_id === 'ubezpieczenia' ? '<div class="muted small">przychód = zysk z marży polis</div>' : ''))}${td('Przychody', esc(pln(d.przychod)), 'num')}${td('Koszty', esc(pln(d.koszt)), 'num')}
      ${td('Wynik', `<b class="${d.wynik < 0 ? 'txt-danger' : ''}">${esc(pln(d.wynik))}</b>`, 'num')}${td('Marża', esc(pct(d.marza_pct)), 'num')}</tr>`), 'Brak danych.',
    `<tfoot><tr class="tr-total">${td('Dział', '<b>Razem firma</b>')}${td('Przychody', `<b>${esc(pln(r.total.przychod))}</b>`, 'num')}${td('Koszty', `<b>${esc(pln(r.total.koszt))}</b>`, 'num')}${td('Wynik', `<b>${esc(pln(r.total.wynik))}</b>`, 'num')}<td></td></tr></tfoot>`);
  const policyNote = p => `<p class="fin-note">${U().icon('polisy', 'ic ic-sm')}<span>Polisy podpisane w okresie: <b>${p.n}</b> · zysk MXT <b>${esc(pln(p.zysk))}</b> (wliczony do przychodów) · kwota polis <b>${esc(pln(p.kwota))}</b> – wartość u towarzystw, <b>nie jest przychodem MXT</b>.</span></p>`;

  // ======================= Finanse firmy =======================
  const FTABS = [['wyniki', 'Wyniki działów', '', 'Wyniki'], ['naleznosci', 'Należności', '', 'Należności'], ['zobowiazania', 'Zobowiązania', '', 'Zobow.'],
    ['przeplywy', 'Przepływy pieniężne', '', 'Przepływy'], ['eksport', 'Eksport i integracje', '', 'Eksport']];
  let ftab = 'wyniki';
  const per = { od: presets().rok[1], do: today() };

  async function finPage(root, path, alive) {
    const sp = new URLSearchParams(location.search);
    if (sp.get('tab') && FTABS.some(t => t[0] === sp.get('tab'))) ftab = sp.get('tab');
    const body = U().deptFrame(root, 'Finanse firmy', FTABS, ftab, t => { ftab = t; reload(); });
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await ({ wyniki, naleznosci, zobowiazania, przeplywy, eksport }[ftab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel); U().wsHoist(root);
    if (location.search) history.replaceState({}, '', location.pathname);
    api('finanse-erp/naleznosci').then(d => U().wsBadge(root, 'naleznosci', d.rows.filter(x => x.days_overdue > 0).length, 'warn')).catch(() => {});
  }
  async function wyniki(body, reload, alive) {
    const r = await api('finanse-erp/wyniki?' + new URLSearchParams(per));
    if (!alive()) return;
    const pb = periodBar(per, reload);
    body.innerHTML = `<p data-ws-sub>${esc(fd(r.od))} – ${esc(fd(r.do))} · przychody wg dat wpisów, koszty z księgi kosztów (materiały, robocizna, koszty sprzedanych części)</p>${pb.html}
      <section class="fin-kpis">${tile('Przychody', pln(r.total.przychod), 'bez kwot polis')}${tile('Koszty', pln(r.total.koszt))}${tile('Wynik', pln(r.total.wynik), r.total.przychod > 0 ? 'marża ' + pct(Math.round(r.total.wynik / r.total.przychod * 10000) / 100) : '', r.total.wynik < 0 ? 'danger' : '')}</section>
      ${policyNote(r.polisy)}
      <div class="pu-grid"><section class="panel"><h2 class="panel-title">Wyniki działów</h2>${deptTable(r)}</section>
        <section class="panel"><h2 class="panel-title">Wynik według działu</h2>${deptBars(r.departments)}</section></div>`;
    pb.bind(body);
  }
  async function naleznosci(body, reload, alive) {
    const d = await api('finanse-erp/naleznosci');
    if (!alive()) return;
    const B = d.buckets, overdue = d.rows.filter(x => x.days_overdue > 0);
    body.innerHTML = `<p data-ws-sub>${d.rows.length} nieopłaconych faktur sprzedaży na ${esc(pln(d.total))}${overdue.length ? ` · po terminie ${overdue.length}` : ''}</p>
      <section class="fin-kpis">${tile('Bieżące', pln(B.biezace), 'przed terminem')}${tile('1–30 dni', pln(B.d1_30), 'po terminie', B.d1_30 ? 'warn' : '')}${tile('31–60 dni', pln(B.d31_60), '', B.d31_60 ? 'warn' : '')}
        ${tile('61–90 dni', pln(B.d61_90), '', B.d61_90 ? 'danger' : '')}${tile('Ponad 90 dni', pln(B.d90), '', B.d90 ? 'danger' : '')}</section>
      <section class="panel">${ctable(['Faktura', 'Klient', 'Dział', 'Termin', { t: 'Kwota', num: 1 }, ''], d.rows.map(x => `<tr class="${x.days_overdue > 0 ? 'row-deny' : ''}">
        ${td('Faktura', `<b>${esc(x.invoice_no)}</b><div class="muted small">${esc(fd(x.entry_date))} · ${esc(x.description || '')}</div>`)}${td('Klient', esc(x.customer_name || '–'))}${td('Dział', esc(DEPT[x.department_id || ''] || x.department_id))}
        ${td('Termin', x.due_date ? `${esc(fd(x.due_date))}${x.days_overdue > 0 ? `<div class="small txt-danger">${x.days_overdue} dni po terminie</div>` : ''}` : '–')}${td('Kwota', esc(pln(x.amount)), 'num')}
        ${td('', `<button type="button" class="btn btn-secondary btn-sm" data-pay="${esc(x.id)}">Zapłacono</button>`)}</tr>`), 'Brak nieopłaconych faktur sprzedaży.')}</section>`;
    body.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => payForm('finanse', b.dataset.pay, d.rows.find(x => x.id === b.dataset.pay), reload)));
  }
  async function zobowiazania(body, reload, alive) {
    const d = await api('finanse-erp/zobowiazania');
    if (!alive()) return;
    body.innerHTML = `<p data-ws-sub>${d.rows.length} nieopłaconych na ${esc(pln(d.total))}${d.overdue ? ` · po terminie ${esc(pln(d.overdue))}` : ''}</p>
      <section class="panel">${ctable(['Dokument', 'Kontrahent', 'Termin', { t: 'Kwota', num: 1 }, ''], d.rows.map(x => `<tr class="${x.days_overdue > 0 ? 'row-deny' : ''}">
        ${td('Dokument', `<b>${esc(x.invoice_no || x.number || '–')}</b><div class="muted small">${x.source === 'pz' ? 'dostawa ' + esc(x.number) : 'koszt'} · ${esc(fd(x.entry_date))}</div>`)}${td('Kontrahent', esc(x.counterparty || '–'))}
        ${td('Termin', x.due_date ? `${esc(fd(x.due_date))}${x.days_overdue > 0 ? `<div class="small txt-danger">${x.days_overdue} dni po terminie</div>` : ''}` : '<span class="muted">bez terminu</span>')}${td('Kwota', esc(pln(x.amount)), 'num')}
        ${td('', `<button type="button" class="btn btn-secondary btn-sm" data-pay="${esc(x.id)}" data-src="${esc(x.source)}">Zapłacono</button>`)}</tr>`), 'Brak nieopłaconych zobowiązań.')}</section>
      <p class="muted small">Zobowiązania to faktury dostawców z przyjęć (PZ) oraz koszty z terminem płatności. Korekty zwrotów sprzedaży są rozliczane z klientem osobno.</p>`;
    body.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => payForm(b.dataset.src, b.dataset.pay, d.rows.find(x => x.id === b.dataset.pay), reload)));
  }
  function payForm(source, id, x, after) {
    modal('Zapłata – ' + (x.invoice_no || x.number || ''), `<p>${esc(x.customer_name || x.counterparty || '')} · <b>${esc(pln(x.amount))}</b></p>${field('pay-d', 'Data zapłaty', `<input id="pay-d" name="d" type="date" value="${today()}" required>`)}`,
      { submit: 'Zapisz zapłatę', onSubmit: async f => { await api('finanse-erp/zaplata', { source, id, paid_at: val(f, 'd') }); toast('Zapłata zapisana.'); after(); } });
  }
  async function przeplywy(body, reload, alive) {
    const d = await api('finanse-erp/przeplywy?' + new URLSearchParams(per));
    if (!alive()) return;
    const pb = periodBar(per, reload), max = Math.max(1, ...d.rows.map(r => Math.max(r.wplywy, r.wydatki)));
    body.innerHTML = `<p data-ws-sub>${esc(fd(d.od))} – ${esc(fd(d.do))} · wg dat zapłaty</p>${pb.html}
      <section class="fin-kpis">${tile('Wpływy', pln(d.total.wplywy))}${tile('Wydatki', pln(d.total.wydatki))}${tile('Saldo', pln(d.total.saldo), '', d.total.saldo < 0 ? 'danger' : '')}</section>
      <section class="panel">${ctable(['Miesiąc', 'Wpływy / wydatki', { t: 'Wpływy', num: 1 }, { t: 'Wydatki', num: 1 }, { t: 'Saldo', num: 1 }], d.rows.map(r => `<tr>${td('Miesiąc', esc(r.m))}
        ${td('Wpływy / wydatki', `<span class="cf-bars"><span class="hb-bar"><i data-w="${Math.round(r.wplywy / max * 100)}"></i></span><span class="hb-bar"><i class="neg" data-w="${Math.round(r.wydatki / max * 100)}"></i></span></span>`)}
        ${td('Wpływy', esc(pln(r.wplywy)), 'num')}${td('Wydatki', esc(pln(r.wydatki)), 'num')}${td('Saldo', `<b class="${r.saldo < 0 ? 'txt-danger' : ''}">${esc(pln(r.saldo))}</b>`, 'num')}</tr>`), 'Brak zarejestrowanych zapłat w okresie.')}</section>
      <p class="muted small">${esc(d.uwaga)}</p>`;
    pb.bind(body);
  }
  const IST = { dane_dostepowe: ['ok', 'Dane dostępowe wpisane'], aktywna: ['ok', 'Działa'], eksport: ['w_toku', 'Eksport plików'], import: ['w_toku', 'Import plików'], oczekuje: ['warn', 'Oczekuje na dane dostępowe'] };
  async function eksport(body, reload, alive) {
    const list = await api('finanse-erp/integracje');
    if (!alive()) return;
    const pb = periodBar(per, reload);
    body.innerHTML = `<p data-ws-sub>Eksport dla księgowości i stan połączeń z systemami zewnętrznymi</p>
      <section class="panel"><h2 class="panel-title">Eksport dla księgowości (XLSX)</h2>${pb.html}
        <p>Arkusze: sprzedaż (przychody), zakupy (PZ), koszty, polisy (zysk MXT osobno od kwoty polisy) za ${esc(fd(per.od))} – ${esc(fd(per.do))}.</p>
        <a class="btn btn-primary" href="/api/finanse-erp/eksport?${new URLSearchParams(per)}" download>${U().icon('down', 'ic ic-sm')}Pobierz plik dla księgowości</a></section>
      <section class="panel"><h2 class="panel-title">Integracje</h2><ul class="int-list">${list.map(i => `<li><div><b>${esc(i.name)}</b><p class="muted small">${esc(i.detail)}</p></div>${chip(IST[i.status][0], IST[i.status][1])}</li>`).join('')}</ul>
        <p class="muted small">Żadna integracja nie jest symulowana. Pozycje „oczekuje” zaczną działać po wpisaniu danych dostępowych w ustawieniach serwera.</p></section>`;
    pb.bind(body);
  }

  // ======================= Pulpit właściciela =======================
  const own = { od: presets().miesiac[1], do: today() };
  const ALV = { krytyczny: ['deny', 'Pilne'], ostrzezenie: ['warn', 'Uwaga'], info: ['teal', 'Informacja'] };
  async function ownerPage(root, path, alive) {
    const body = U().deptFrame(root, 'Pulpit właściciela', [['pulpit', 'Pulpit właściciela']], 'pulpit', () => {});
    const reload = () => U().render(path, root);
    const d = await api('wlasciciel?' + new URLSearchParams(own));
    if (!alive()) return;
    const pb = periodBar(own, reload), f = d.finance, o = d.ops, rc = d.receivables, py = d.payables, p = d.policies;
    const panel = document.createElement('div'); panel.className = 'mod-body';
    const stat = (label, n, link, tone) => `<li><button type="button" class="ow-stat${n && tone ? ' ow-' + tone : ''}" data-go="${esc(link)}"><span>${esc(label)}</span><b>${esc(n)}</b></button></li>`;
    panel.innerHTML = `<p data-ws-sub>Cała firma · ${esc(fd(d.od))} – ${esc(fd(d.do))}</p>${pb.html}
      ${d.alerts.length ? `<section class="panel ow-alerts"><h2 class="panel-title">Wymaga uwagi</h2><ul>${d.alerts.map(a => `<li>${chip(ALV[a.level][0], ALV[a.level][1])}<span>${esc(a.text)}</span><button type="button" class="btn btn-ghost btn-sm" data-go="${esc(a.link)}">Przejdź</button></li>`).join('')}</ul></section>`
        : '<section class="panel"><p class="txt-ok">Brak pilnych spraw – nic nie jest po terminie.</p></section>'}
      <section class="fin-kpis">${tile('Przychody', pln(f.total.przychod), 'bez kwot polis')}${tile('Koszty', pln(f.total.koszt))}${tile('Wynik', pln(f.total.wynik), '', f.total.wynik < 0 ? 'danger' : '')}
        ${tile('Należności', pln(rc.razem), rc.po_terminie ? 'po terminie ' + pln(rc.po_terminie) : `${rc.faktury} faktur`, rc.po_terminie ? 'warn' : '')}${tile('Zobowiązania', pln(py.razem), py.po_terminie ? 'po terminie ' + pln(py.po_terminie) : '', py.po_terminie ? 'warn' : '')}
        ${tile('Wartość magazynu', pln(d.stock.wartosc), `${d.stock.pozycje} pozycji${d.stock.ponizej_minimum ? ' · ' + d.stock.ponizej_minimum + ' poniżej min.' : ''}`)}</section>
      ${policyNote(f.polisy)}
      <div class="pu-grid"><section class="panel"><h2 class="panel-title">Wyniki działów</h2>${deptTable(f)}${deptBars(f.departments)}</section>
        <section class="panel"><h2 class="panel-title">Operacje</h2><ul class="ow-stats">
          ${stat('Projekty w realizacji', o.projekty_aktywne, '/dzial/podzielniki-i-montaze?tab=rozliczenia')}${stat('Zlecenia otwarte', o.zlecenia_otwarte, '/dzial/podzielniki-i-montaze?tab=zlecenia')}
          ${stat('Zlecenia po terminie', o.zlecenia_po_terminie, '/dzial/podzielniki-i-montaze?tab=zlecenia', 'danger')}${stat('Termin w ciągu 3 dni', o.zlecenia_zagrozone, '/dzial/podzielniki-i-montaze?tab=zlecenia', 'warn')}
          ${stat('Bez przydziału', o.bez_przydzialu, '/dzial/podzielniki-i-montaze?tab=zlecenia', 'warn')}${stat('Serwisy bez przydziału > 14 dni', o.serwisy_po_terminie_przydzialu, '/dzial/podzielniki-i-montaze?tab=serwisy', 'danger')}
          ${stat('Wykonane do rozliczenia', o.do_rozliczenia, '/dzial/podzielniki-i-montaze?tab=zlecenia')}${stat('Zadania po terminie', d.tasks.po_terminie, '/zadania', 'warn')}</ul></section></div>
      <div class="pu-grid"><section class="panel"><h2 class="panel-title">Ubezpieczenia</h2><ul class="ow-stats">
          ${stat('Polisy podpisane w okresie', p.podpisane, '/dzial/ubezpieczenia?tab=polisy')}${stat('Zysk MXT z polis', pln(p.zysk), '/dzial/ubezpieczenia?tab=pulpit')}
          ${stat('Polisy aktywne', p.aktywne, '/dzial/ubezpieczenia?tab=polisy')}${stat('Kończą się w 30 dni', p.konczy_30, '/dzial/ubezpieczenia?tab=odnowienia', 'warn')}
          ${stat('Przypomnienia do obsłużenia', p.przypomnienia_nowe, '/dzial/ubezpieczenia?tab=przypomnienia', 'warn')}</ul>
          <p class="muted small">Kwota podpisanych polis ${esc(pln(p.kwota))} – informacyjnie, nie jest przychodem MXT.</p></section>
        <section class="panel"><h2 class="panel-title">Sprzedaż części</h2><ul class="ow-stats">
          ${stat('Zafakturowane zamówienia', d.parts.n, '/dzial/sprzedaz-czesci-i-eksport?tab=analityka')}${stat('Przychód ze sprzedaży części', pln(d.parts.przychod), '/dzial/sprzedaz-czesci-i-eksport?tab=analityka')}
          ${stat('Zamówienia w toku', o.zamowienia_czesci_otwarte, '/dzial/sprzedaz-czesci-i-eksport?tab=zamowienia')}${stat('Pozycje poniżej minimum', d.stock.ponizej_minimum, '/magazyn?tab=stany', 'warn')}</ul></section></div>
      <section class="panel"><h2 class="panel-title">Obciążenie zespołu terenowego</h2>${ctable(['Pracownik', { t: 'Otwarte zlecenia', num: 1 }, { t: 'Godziny w okresie', num: 1 }, 'Dziś'], d.load.map(u => `<tr>
        ${td('Pracownik', esc(u.name))}${td('Otwarte zlecenia', esc(u.zlecenia), 'num')}${td('Godziny', esc(String(u.godziny).replace('.', ',')), 'num')}${td('Dziś', u.nieobecny ? chip('warn', 'Nieobecny') : chip('ok', 'Dostępny'))}</tr>`), 'Brak pracowników terenowych.')}</section>`;
    body.replaceChildren(panel); U().wsHoist(root);
    pb.bind(panel);
    panel.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => U().go(b.dataset.go)));
  }

  window.MXT_MODULES.register('/finanse-firmy', { title: 'Finanse firmy', perm: 'finance.view', render: finPage, ws: true }, { menu: true });
  window.MXT_MODULES.register('/pulpit-wlasciciela', { title: 'Pulpit właściciela', perm: 'owner.dashboard', render: ownerPage, ws: true }, { menu: true });
})();
