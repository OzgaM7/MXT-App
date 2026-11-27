'use strict';
// Dział 1 – Podzielniki i Montaże (pełny zakres).
(() => {
  const U = () => window.MXT_UI, B = () => window.MXT_BIZ;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => B().pln(n), table = (...a) => B().table(...a), opts = (...a) => B().opts(...a);
  const DEP = 'podzielniki-i-montaze', PATH = '/dzial/' + DEP;
  // Menu działu w trzech grupach: planowanie (harmonogram – ekran startowy, serwisy, odczyty), rozliczenia i ewidencja.
  // Czwarty element: krótka nazwa w menu dolnym na telefonie (4 pierwsze pozycje + „Więcej”).
  const TABS = [['harmonogram', 'Harmonogram montaży', 'Planowanie', 'Harmonogram'], ['zlecenia', 'Wszystkie zlecenia', 'Planowanie', 'Zlecenia'], ['serwisy', 'Serwisy', 'Planowanie'],
    ['odczyty', 'Odczyty', 'Planowanie'], ['pulpit', 'Pulpit działu', 'Planowanie', 'Pulpit'],
    ['rozliczenia', 'Projekty i rozliczenia', 'Rozliczenia', 'Projekty'], ['oferty', 'Oferty', 'Rozliczenia'], ['rentownosc', 'Rentowność', 'Rozliczenia'],
    ['ekipy', 'Pracownicy', 'Ewidencja', 'Pracownicy'], ['budynki', 'Budynki i lokale', 'Ewidencja', 'Budynki'], ['urzadzenia', 'Urządzenia', 'Ewidencja'], ['reklamacje', 'Reklamacje', 'Ewidencja']];
  const DEV = { podzielnik: 'Podzielnik kosztów', wodomierz: 'Wodomierz', cieplomierz: 'Ciepłomierz', modul_radiowy: 'Moduł radiowy', inny: 'Inne' };
  const DEV_ST = { magazyn: 'Magazyn', zamontowane: 'Zamontowane', zdemontowane: 'Zdemontowane', wadliwe: 'Wadliwe' };
  const INST_ST = { zaplanowany: 'Zaplanowany', w_toku: 'W toku', wykonany: 'Wykonany', odebrany: 'Odebrany (protokół)', anulowany: 'Anulowany' };
  const KT_ST = { oferta: 'Oferta', w_realizacji: 'W realizacji', zakonczony: 'Zakończony', rozliczony: 'Rozliczony', anulowany: 'Anulowany' };
  let tab = 'harmonogram', S = null;
  const st = { q: '', barch: '', devQ: '', devTyp: '', devSt: '', devPage: 1 };
  // Przycisk eksportu do Excela (te same filtry co na ekranie); tylko dla ról z uprawnieniem export.xlsx.
  const xl = (list, params = {}) => U().has('export.xlsx')
    ? `<a class="btn btn-secondary btn-sm btn-xl" href="/api/eksport/d1/${list}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v))}" download>Eksport do Excela</a>` : '';

  async function page(root, path, alive) {
    // Link z powiadomienia lub wyszukiwania może wskazać zakładkę i rekord:
    // ?tab=serwisy&z=<zlecenie>, ?tab=budynki&b=<budynek>, ?tab=harmonogram&m=<montaż>, ?tab=urzadzenia&q=<numer seryjny>.
    const sp = U().urlParams(), want = sp.get('tab');
    // Ranking rentowności to dane finansowe firmy – tylko dla ról finansowych.
    const tabs = TABS.filter(t => t[0] !== 'rentownosc' || U().has('finance.view'));
    if (want && tabs.some(([k]) => k === want)) tab = want;
    if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
    if (tab === 'urzadzenia' && sp.get('q')) { st.devQ = sp.get('q').slice(0, 80); st.devTyp = ''; st.devSt = ''; st.devPage = 1; }
    const body = U().deptFrame(root, 'Ciepłomierze i podzielniki', tabs, tab, t => { tab = t; reload(); });
    const reload = () => U().render(path, root);
    // Liczby działu: KPI harmonogramu i liczniki w menu (serwisy do przydzielenia, odczyty po terminie, otwarte reklamacje).
    S = Promise.all([api('d1/podsumowanie'), api('serwisy/podsumowanie').catch(() => null), api('odczyty/podsumowanie').catch(() => null)]);
    S.then(([d, srv, odc]) => {
      if (!alive()) return;
      if (srv) U().wsBadge(root, 'serwisy', srv.nieprzypisane, srv.po_terminie_przydzialu ? 'danger' : 'warn');
      if (odc) U().wsBadge(root, 'odczyty', odc.po_terminie, 'danger');
      U().wsBadge(root, 'reklamacje', d.reklamacje_otwarte, 'warn');
    }).catch(() => {});
    const panel = document.createElement('div'); panel.className = 'mod-body';
    const serwisy = (...a) => window.MXT_SERWIS.officeTab(...a), odczyty = (...a) => window.MXT_ODCZYTY.tab(...a);
    const ctx = { goTab: t => { tab = t; reload(); } };
    const pulpit = (p, rl, al) => window.MXT_ERP.pulpit(p, rl, al, ctx), zlecenia = (p, rl, al) => window.MXT_ERP.zlecenia(p, rl, al, ctx);
    await ({ budynki, urzadzenia, harmonogram, serwisy, odczyty, ekipy, reklamacje, rozliczenia, rentownosc, oferty, pulpit, zlecenia }[tab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel);
    U().wsHoist(root);
    // Parametry z linku działają raz (kolejne przełączenia zakładek nie wracają do zakładki z adresu).
    if (location.search) history.replaceState({}, '', location.pathname);
    const ub = sp.get('b'), um = sp.get('m'), uk = sp.get('k');
    if (ub && tab === 'budynki') buildingCard(ub, reload).catch(e => toast(e.message));
    if (um && tab === 'harmonogram') api('d1/montaze/' + um).then(x => installationForm(x, reload)).catch(e => toast(e.message));
    if (uk && tab === 'rozliczenia' && window.MXT_PROJEKT) window.MXT_PROJEKT.open(uk, reload);
    // Agenci AI działu pod harmonogramem i ewidencją budynków – najważniejsze dane działu zostają na górze.
    if (['budynki', 'harmonogram'].includes(tab)) await B().agentsStrip(panel, DEP, 'beforeend');
  }

  // ---------- budynki ----------
  async function buildingForm(b, reload) {
    const cust = (await api('klienci')).filter(c => ['wspolnota', 'spoldzielnia', 'zarzadca'].includes(c.kind));
    const box = modal(b ? 'Edytuj budynek' : 'Nowy budynek', `
      <div class="field-row">${field('b-cust', 'Wspólnota / spółdzielnia / zarządca', `<select id="b-cust" name="customer_id">${opts(cust, b && b.customer_id, c => c.name, c => c.id, '– wybierz z CRM –')}</select>`)}
        <div class="field"><span class="flabel">&nbsp;</span><button type="button" class="btn btn-ghost btn-sm" id="b-newc">Nowa wspólnota w CRM</button></div></div>
      ${field('b-name', 'Nazwa budynku', `<input id="b-name" name="name" required maxlength="200" value="${esc(b ? b.name : '')}" placeholder="np. Słoneczna 12, klatki A–C">`)}
      <div class="field-row">${field('b-addr', 'Adres', `<input id="b-addr" name="address" required maxlength="300" value="${esc(b ? b.address : '')}">`)}
        ${field('b-city', 'Miejscowość', `<input id="b-city" name="city" maxlength="100" value="${esc(b ? b.city : '')}">`)}${field('b-pc', 'Kod', `<input id="b-pc" name="postal_code" maxlength="10" value="${esc(b ? b.postal_code : '')}">`)}</div>
      <div class="field-row">${field('b-units', 'Liczba lokali', `<input id="b-units" name="units_count" type="number" min="0" value="${esc(b ? b.units_count : '')}">`)}
        ${field('b-heat', 'Ogrzewanie', `<input id="b-heat" name="heating_type" maxlength="100" value="${esc(b ? b.heating_type : '')}" placeholder="np. węzeł MPEC, grzejniki płytowe">`)}</div>
      ${field('b-notes', 'Notatki', `<textarea id="b-notes" name="notes" rows="2">${esc(b ? b.notes : '')}</textarea>`)}`,
    { submit: b ? 'Zapisz' : 'Dodaj budynek', wide: true, onSubmit: async f => {
      const d = { customer_id: val(f, 'customer_id') || null, name: val(f, 'name'), address: val(f, 'address'), city: val(f, 'city'), postal_code: val(f, 'postal_code'), units_count: val(f, 'units_count'), heating_type: val(f, 'heating_type'), notes: val(f, 'notes') };
      if (b) await api('d1/budynki/' + b.id, { ...d, updated_at: b.updated_at }, 'PATCH');
      else {
        try { await api('d1/budynki', d); }
        catch (e) {
          if (!(e.data && e.data.duplikat)) throw e;
          if (!window.confirm(e.data.error + '\n\nOK – dodaj nowy budynek mimo to.\nAnuluj – wróć do formularza.')) throw new Error('Nie dodano – budynek „' + e.data.istniejacy.name + '” już jest w ewidencji.');
          await api('d1/budynki', { ...d, potwierdz_duplikat: true });
        }
      }
      toast('Budynek zapisany.'); reload();
    } });
    box.querySelector('#b-newc').addEventListener('click', () => B().customerForm(null, () => buildingForm(b, reload), { kind: 'wspolnota', departments: [DEP] }));
  }
  async function buildingCard(id, reload) {
    const b = await api('d1/budynki/' + id), finOk = U().has('finance.view');
    const box = modal(b.name, `<p class="muted">${esc(b.address)}${b.city ? ', ' + esc(b.city) : ''} · ${esc(b.customer_name || 'bez przypisanej wspólnoty')} · ${esc(b.units_count)} lokali${b.heating_type ? ' · ' + esc(b.heating_type) : ''}</p>
      ${b.archived_at ? `<p class="notice">Budynek w archiwum od ${esc(fd(b.archived_at))} – nie pojawia się na listach, w wyszukiwarce ani przy planowaniu montaży.</p>` : ''}
      ${finOk ? `<div class="kpis kpis-3"><div class="kpi kpi-blue"><span class="kpi-v">${esc(pln(b.przychod))}</span><span class="kpi-l">Przychody</span></div><div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(b.koszt))}</span><span class="kpi-l">Koszty</span></div>
        <div class="kpi ${b.przychod - b.koszt >= 0 ? 'kpi-ok' : 'kpi-danger'}"><span class="kpi-v">${esc(pln(b.przychod - b.koszt))}</span><span class="kpi-l">Marża budynku</span></div></div>` : ''}
      <div id="bc-units"><p class="muted small">Wczytywanie lokali…</p></div>
      <h3 class="panel-sub">Urządzenia (${b.devices.length})</h3>${table(['Numer seryjny', 'Typ', 'Lokalizacja', 'Status', 'Montaż'], b.devices.map(d => `<tr><td><button type="button" class="linkish mono-ink" data-dev="${d.id}">${esc(d.serial_no)}</button></td><td>${esc(DEV[d.type])}</td><td>${esc(d.location || '–')}</td><td>${chip(d.status === 'wadliwe' ? 'deny' : d.status === 'zamontowane' ? 'ok' : 'off', DEV_ST[d.status])}</td><td class="small">${esc(d.installation_number || '–')}</td></tr>`), 'Brak urządzeń.')}
      <h3 class="panel-sub">Montaże</h3>${table(['Numer', 'Termin', 'Ekipa', 'Status', ''], b.installations.map(i => `<tr><td>${esc(i.number)}</td><td>${esc(fd(i.planned_date))}</td><td>${esc(i.crew_name || '–')}</td><td>${chip(i.status, INST_ST[i.status])}</td><td>${i.protocol_document_id ? B().pdfLink('/api/dokumenty/' + i.protocol_document_id + '/plik', 'Protokół') : ''}</td></tr>`), 'Brak montaży.')}
      <h3 class="panel-sub">Reklamacje</h3>${table(['Numer', 'Tytuł', 'Status', 'Zgłoszono'], b.complaints.map(x => `<tr><td>${esc(x.number)}</td><td>${esc(x.title)}</td><td>${chip(x.status, B().CPL_ST[x.status])}</td><td>${esc(fd(x.reported_at))}</td></tr>`), 'Brak reklamacji.')}
      ${finOk ? `<h3 class="panel-sub">Rozliczenia</h3>${table(['Data', 'Rodzaj', 'Opis', 'Faktura', { t: 'PLN', num: 1 }], (b.finance || []).map(x => `<tr><td>${esc(fd(x.entry_date))}</td><td>${esc(x.kind === 'przychod' ? 'Przychód' : 'Koszt')}</td><td>${esc(x.description || x.category)}</td><td>${esc(x.invoice_no || '–')}</td><td class="num">${esc(pln(x.amount_pln))}</td></tr>`), 'Brak wpisów.')}` : ''}
      <div class="ap-actions"><button type="button" class="btn btn-secondary btn-sm" id="bc-edit">Edytuj budynek</button><button type="button" class="btn btn-secondary btn-sm" id="bc-dev">Dodaj urządzenia</button>${finOk ? '<button type="button" class="btn btn-secondary btn-sm" id="bc-fin">Dodaj fakturę / koszt</button>' : ''}
        ${b.archived_at ? '<button type="button" class="btn btn-secondary btn-sm" id="bc-restore">Przywróć z archiwum</button>' : '<button type="button" class="btn btn-ghost btn-sm" id="bc-arch">Archiwizuj</button>'}<button type="button" class="btn btn-ghost btn-sm" id="bc-del">Usuń budynek</button></div>`, { wide: true });
    box.querySelector('#bc-edit').addEventListener('click', () => buildingForm(b, reload));
    const on = (sel, fn) => { const el = box.querySelector(sel); if (el) el.addEventListener('click', () => fn().catch(e => toast(e.message))); };
    on('#bc-arch', async () => modal('Archiwizować budynek ' + b.name + '?', '<p>Budynek zniknie z list, wyszukiwarki i wyboru przy planowaniu montaży. Historia (montaże, urządzenia, rozliczenia) zostaje, a budynek można przywrócić z archiwum.</p>',
      { submit: 'Archiwizuj', onSubmit: async () => { await api('d1/budynki/' + b.id + '/archiwizuj', {}); toast('Budynek przeniesiony do archiwum.'); reload(); } }));
    on('#bc-restore', async () => { await api('d1/budynki/' + b.id + '/przywroc', {}); document.getElementById('modal').hidden = true; toast('Budynek przywrócony.'); reload(); });
    on('#bc-del', async () => {
      const rel = await api('d1/budynki/' + b.id + '/powiazania');
      if (rel.length) { toast('Budynek ma historię (' + rel.map(([l, n]) => l + ': ' + n).join(', ') + ') – nie można go usunąć. Użyj „Archiwizuj”.'); return; }
      modal('Usunąć budynek ' + b.name + '?', `<p>Budynek <b>${esc(b.name)}</b> nie ma montaży, urządzeń, lokali, serwisów, odczytów ani rozliczeń. Usunięcie jest nieodwracalne.</p>`,
        { submit: 'Usuń budynek', danger: true, onSubmit: async () => { await api('d1/budynki/' + b.id, null, 'DELETE'); toast('Budynek usunięty.'); reload(); } });
    });
    box.querySelectorAll('[data-dev]').forEach(x => x.addEventListener('click', () => window.MXT_ERP.deviceCard(x.dataset.dev, () => buildingCard(id, reload))));
    window.MXT_ERP.unitsSection(box.querySelector('#bc-units'), b.id).catch(e => { box.querySelector('#bc-units').innerHTML = `<p class="small txt-danger">${esc(e.message)}</p>`; });
    box.querySelector('#bc-dev').addEventListener('click', () => deviceForm(b.id, reload));
    on('#bc-fin', async () => B().financeForm({ department_id: DEP, building_id: b.id }, reload));
  }
  async function budynki(body, reload, alive) {
    const [sum, list] = await Promise.all([api('d1/podsumowanie'), api('d1/budynki?' + new URLSearchParams({ ...(st.q ? { q: st.q } : {}), ...(st.barch ? { archiwum: '1' } : {}), ...(st.blim ? { limit: st.blim } : {}) }))]);
    if (!alive()) return;
    const finOk = U().has('finance.view');
    body.innerHTML = `<section class="kpis">
        <div class="kpi kpi-blue"><span class="kpi-v">${esc(sum.budynki)}</span><span class="kpi-l">Budynki (${esc(sum.lokale)} lokali)</span></div>
        <div class="kpi kpi-teal"><span class="kpi-v">${esc(sum.urzadzenia)}</span><span class="kpi-l">Zamontowane urządzenia</span></div>
        <div class="kpi kpi-violet"><span class="kpi-v">${esc(sum.montaze_14d)}</span><span class="kpi-l">Montaże w 14 dni</span></div>
        <div class="kpi ${sum.do_odbioru ? 'kpi-warn' : 'kpi-neutral'}"><span class="kpi-v">${esc(sum.do_odbioru)}</span><span class="kpi-l">Czekają na protokół</span></div>
        <div class="kpi ${sum.reklamacje_otwarte ? 'kpi-warn' : 'kpi-neutral'}"><span class="kpi-v">${esc(sum.reklamacje_otwarte)}</span><span class="kpi-l">Otwarte reklamacje</span></div>
        <div class="kpi kpi-neutral"><span class="kpi-v">${esc(sum.ekipy)}</span><span class="kpi-l">Pracownicy</span></div></section>
      <form class="toolbar" id="bf"><label class="visually-hidden" for="bq">Szukaj</label><input id="bq" name="q" class="select-sm" placeholder="Szukaj: nazwa, adres, miasto, wspólnota" value="${esc(st.q)}">
        <label class="visually-hidden" for="b-arch">Archiwum</label><select id="b-arch" name="arch" class="select-sm"><option value="">Aktywne</option><option value="1"${st.barch ? ' selected' : ''}>Archiwum</option></select>
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button><button type="button" class="btn btn-primary btn-sm" id="b-new">Nowy budynek</button>${xl('budynki')}</form>
      <section class="panel">${table(['Budynek', 'Wspólnota', { t: 'Lokale', num: 1 }, { t: 'Urządzenia', num: 1 }, { t: 'Montaże', num: 1 }, 'Reklamacje', ...(finOk ? [{ t: 'Marża', num: 1 }] : []), ''], list.map(b => `<tr>
        <td><button type="button" class="linkish" data-b="${b.id}">${esc(b.name)}</button><div class="muted small">${esc(b.address)}${b.city ? ', ' + esc(b.city) : ''}</div></td><td>${esc(b.customer_name || '–')}</td>
        <td class="num">${esc(b.units_count)}</td><td class="num">${esc(b.devices)}</td><td class="num">${esc(b.installations)}</td><td>${b.open_complaints ? chip('warn', b.open_complaints + ' otwarte') : '<span class="muted">–</span>'}</td>
        ${finOk ? `<td class="num">${esc(pln(b.przychod - b.koszt))}</td>` : ''}<td class="nowrap"><button type="button" class="btn btn-ghost btn-sm" data-bedit="${b.id}">Edytuj</button></td></tr>`),
        st.barch ? 'Archiwum jest puste.' : 'Brak budynków. Dodaj pierwszy budynek przyciskiem „Nowy budynek”.')}</section>`;
    body.querySelector('#bf').addEventListener('submit', e => { e.preventDefault(); st.q = val(e.target, 'q').trim(); st.barch = val(e.target, 'arch'); st.blim = ''; reload(); });
    U().moreBar(body, list, n => { st.blim = n; reload(); });
    body.querySelectorAll('[data-bedit]').forEach(x => x.addEventListener('click', () => buildingForm(list.find(b => b.id === x.dataset.bedit), reload)));
    body.querySelector('#b-new').addEventListener('click', () => buildingForm(null, reload));
    body.querySelectorAll('[data-b]').forEach(x => x.addEventListener('click', () => buildingCard(x.dataset.b, reload)));
  }

  // ---------- urządzenia ----------
  async function deviceForm(buildingId, reload) {
    const [bs, inst] = await Promise.all([api('d1/budynki'), api('d1/montaze')]);
    modal('Dodaj urządzenia', `
      <div class="field-row">${field('d-b', 'Budynek', `<select id="d-b" name="building_id" required>${opts(bs, buildingId, b => b.name + ', ' + b.address, b => b.id, '– wybierz –')}</select>`)}
        ${field('d-i', 'Zlecenie montażowe (opcjonalnie)', `<select id="d-i" name="installation_id">${opts(inst.filter(i => i.status !== 'anulowany'), null, i => i.number + ' · ' + i.building_name + ' · ' + fd(i.planned_date), i => i.id, '– brak –')}</select>`)}</div>
      <div class="field-row">${field('d-t', 'Typ', `<select id="d-t" name="type">${Object.entries(DEV).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`)}
        ${field('d-m', 'Model', '<input id="d-m" name="model" maxlength="100">')}${field('d-date', 'Data montażu', `<input id="d-date" name="installed_at" type="date" value="${U().today()}">`)}</div>
      ${field('d-s', 'Numery seryjne (jeden na linię – możesz wkleić z czytnika lub arkusza)', '<textarea id="d-s" name="serials" rows="6" required></textarea>')}
      ${field('d-l', 'Lokalizacja (dla pojedynczego urządzenia)', '<input id="d-l" name="location" maxlength="200" placeholder="np. lokal 12, pokój, grzejnik 2">')}`,
    { submit: 'Dodaj urządzenia', wide: true, onSubmit: async f => {
      const r = await api('d1/urzadzenia', { building_id: val(f, 'building_id'), installation_id: val(f, 'installation_id') || null, type: val(f, 'type'), model: val(f, 'model'), installed_at: val(f, 'installed_at'), serials: val(f, 'serials'), location: val(f, 'location') });
      toast('Dodano urządzeń: ' + r.added + '.'); reload();
    } });
  }
  async function urzadzenia(body, reload, alive) {
    // Lista stronicowana po 100 (projekty z tysiącami podzielników); łączna liczba z nagłówka X-Total-Count.
    const filters = { q: st.devQ, typ: st.devTyp, status: st.devSt };
    const qs = new URLSearchParams(Object.entries({ ...filters, strona: st.devPage }).filter(([, v]) => v));
    const resp = await fetch('/api/d1/urzadzenia?' + qs, { credentials: 'same-origin', cache: 'no-store' });
    if (!resp.ok) { const e = new Error((await resp.json().catch(() => ({}))).error || 'Nie udało się wczytać urządzeń.'); e.status = resp.status; throw e; }
    const list = await resp.json(), total = +resp.headers.get('X-Total-Count') || list.length, pages = Math.max(1, Math.ceil(total / 100));
    if (!alive()) return;
    if (st.devPage > pages) { st.devPage = pages; return reload(); }
    const filtered = !!(st.devQ || st.devTyp || st.devSt);
    body.innerHTML = `<form class="toolbar" id="df"><label class="visually-hidden" for="dq">Numer seryjny</label><input id="dq" name="q" class="select-sm" placeholder="Szukaj po numerze seryjnym, modelu, lokalizacji" value="${esc(st.devQ)}">
        <label class="visually-hidden" for="dt">Typ</label><select id="dt" name="typ" class="select-sm"><option value="">Każdy typ</option>${Object.entries(DEV).map(([k, v]) => `<option value="${k}"${st.devTyp === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <label class="visually-hidden" for="dst">Status</label><select id="dst" name="status" class="select-sm"><option value="">Każdy status</option>${Object.entries(DEV_ST).map(([k, v]) => `<option value="${k}"${st.devSt === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button><button type="button" class="btn btn-primary btn-sm" id="d-new">Dodaj urządzenia</button>${xl('urzadzenia', filters)}</form>
      <p class="muted small list-count">${filtered ? 'Znaleziono' : 'Razem'}: <b>${esc(total)}</b> ${total === 1 ? 'urządzenie' : total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 12 || total % 100 > 14) ? 'urządzenia' : 'urządzeń'}${pages > 1 ? ` · strona ${st.devPage} z ${pages}` : ''}</p>
      <section class="panel">${table(['Numer seryjny', 'Typ', 'Model', 'Budynek', 'Lokalizacja', 'Montaż', 'Status'], list.map(d => `<tr>
        <td><button type="button" class="linkish mono-ink" data-devc="${d.id}">${esc(d.serial_no)}</button></td><td>${esc(DEV[d.type])}</td><td>${esc(d.model || '–')}</td><td>${esc(d.building_name || '–')}</td><td>${esc(d.location || '–')}</td>
        <td class="small">${esc(d.installation_number || '–')}${d.installed_at ? '<div class="muted">' + esc(fd(d.installed_at)) + '</div>' : ''}</td>
        <td><label class="visually-hidden" for="ds-${d.id}">Status</label><select class="status-select" id="ds-${d.id}" data-dev="${d.id}">${Object.entries(DEV_ST).map(([k, v]) => `<option value="${k}"${k === d.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td></tr>`),
        filtered ? 'Brak urządzeń dla tego wyszukiwania.' : 'Brak urządzeń. Dodaj je przyciskiem „Dodaj urządzenia” (możesz wkleić listę numerów seryjnych).')}
        ${pages > 1 ? `<nav class="pager" aria-label="Strony listy urządzeń"><button type="button" class="btn btn-secondary btn-sm" data-pg="-1"${st.devPage <= 1 ? ' disabled' : ''}>← Poprzednia</button>
          <span class="small">Strona ${st.devPage} z ${pages}</span><button type="button" class="btn btn-secondary btn-sm" data-pg="1"${st.devPage >= pages ? ' disabled' : ''}>Następna →</button></nav>` : ''}</section>`;
    body.querySelector('#df').addEventListener('submit', e => { e.preventDefault(); st.devQ = val(e.target, 'q').trim(); st.devTyp = val(e.target, 'typ'); st.devSt = val(e.target, 'status'); st.devPage = 1; reload(); });
    body.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => { st.devPage += Number(b.dataset.pg); reload(); }));
    body.querySelector('#d-new').addEventListener('click', () => deviceForm(null, reload));
    body.querySelectorAll('[data-devc]').forEach(b => b.addEventListener('click', () => window.MXT_ERP.deviceCard(b.dataset.devc, reload)));
    body.querySelectorAll('[data-dev]').forEach(s => s.addEventListener('change', async () => { try { await api('d1/urzadzenia/' + s.dataset.dev, { status: s.value }, 'PATCH'); toast('Status urządzenia zmieniony.'); } catch (e) { toast(e.message); reload(); } }));
  }

  // ---------- harmonogram montaży ----------
  const matText = m => (m || []).map(x => `${x.nazwa}; ${x.ilosc}; ${x.jm}`).join('\n');
  const matParse = t => String(t || '').split('\n').map(l => l.split(';').map(s => s.trim())).filter(a => a[0]).map(([nazwa, ilosc, jm]) => ({ nazwa, ilosc: Number(ilosc || 1), jm: jm || 'szt.' }));
  // Dodaj nowy montaż / Edytuj montaż. Montaż obejmuje osiedle: firma zlecająca z CRM, nazwa osiedla, adresy (jeden na linię)
  // i liczba budynków. Wykonawców wybiera się z listy pracowników (Ewidencja → Pracownicy); dostają powiadomienie i widzą montaż w „Moje montaże”.
  const workersBox = (ws, chosen) => ws.length
    ? `<div class="wk-pick">${ws.map(w => `<label class="toggle wk-item"><input type="checkbox" name="worker" value="${w.id}"${chosen.includes(w.id) ? ' checked' : ''}> <span>${esc(w.name)}${w.position ? ' <small class="muted">· ' + esc(w.position) + '</small>' : ''}${w.user_login ? '' : ' <small class="muted">(bez konta)</small>'}</span></label>`).join('')}</div>`
    : '<p class="muted small">Brak pracowników. Dodaj ich w zakładce Ewidencja → Pracownicy.</p>';
  const pickedWorkers = f => [...f.querySelectorAll('[name=worker]:checked')].map(i => i.value);
  async function installationForm(x, reload, draft) {
    const [cust, ws] = await Promise.all([api('klienci'), api('d1/pracownicy-dzialu')]);
    const d0 = draft || (x ? { customer_id: x.customer_ref, site_name: x.site_name || (x.building_id ? '' : x.building_name), addresses: x.addresses, buildings_count: x.buildings_count,
      planned_date: x.planned_date, planned_end: x.planned_end, scope: x.scope, devices_planned: x.devices_planned, materials: matText(x.materials), notes: x.notes, worker_ids: (x.workers || []).map(w => w.id) } : {});
    const chosen = d0.worker_ids || [];
    const active = ws.filter(w => w.is_active || chosen.includes(w.id));
    const legacy = x && x.building_id && !x.site_name;   // montaż sprzed zmiany – przypisany do budynku z ewidencji
    const read = f => ({ customer_id: val(f, 'customer_id') || null, site_name: val(f, 'site_name'), addresses: val(f, 'addresses'), buildings_count: val(f, 'buildings_count'),
      planned_date: val(f, 'planned_date'), planned_end: val(f, 'planned_end') || null, scope: val(f, 'scope'), devices_planned: val(f, 'devices_planned'), materials: val(f, 'materials'),
      notes: val(f, 'notes'), worker_ids: pickedWorkers(f) });
    const submit = async (d, allow) => {
      if (!x && !d.customer_id) throw new Error('Wybierz firmę zlecającą albo dodaj nową w CRM.');
      const b = { ...d, materials: matParse(d.materials), allow_clash: allow };
      if (x) await api('d1/montaze/' + x.id, { ...b, updated_at: x.updated_at }, 'PATCH'); else await api('d1/montaze', b);
      toast(x ? 'Zapisano zmiany montażu.' : 'Dodano montaż do harmonogramu.'); reload();
    };
    modal(x ? 'Edytuj montaż ' + x.number : 'Dodaj nowy montaż', `
      <div class="field-row">${field('i-cust', 'Firma zlecająca', `<select id="i-cust" name="customer_id"${x ? '' : ' required'}>${opts(cust, d0.customer_id, c => c.name, c => c.id, '– wybierz z CRM –')}</select>`)}
        <div class="field"><span class="flabel">&nbsp;</span><button type="button" class="btn btn-ghost btn-sm" id="i-newc">Nowa firma w CRM</button></div></div>
      ${legacy ? `<p class="muted small">Budynek z ewidencji: <b>${esc(x.building_name)}</b>${x.address ? ', ' + esc(x.address) : ''}. Możesz wpisać osiedle i adresy – zastąpią go w harmonogramie.</p>` : ''}
      <div class="field-row">${field('i-site', 'Osiedle / lokalizacja', `<input id="i-site" name="site_name" maxlength="200"${legacy ? '' : ' required'} value="${esc(d0.site_name || '')}" placeholder="np. Osiedle Słoneczne, Kraków">`)}
        ${field('i-bc', 'Liczba budynków', `<input id="i-bc" name="buildings_count" type="number" min="0" inputmode="numeric" value="${esc(d0.buildings_count ?? '')}">`)}</div>
      ${field('i-addr', 'Adresy (jeden na linię)', `<textarea id="i-addr" name="addresses" rows="3" placeholder="Słoneczna 1–15&#10;Leśna 2, 4, 6">${esc(d0.addresses || '')}</textarea>`)}
      <div class="field-row">${field('i-d', 'Termin rozpoczęcia', `<input id="i-d" name="planned_date" type="date" required value="${esc(d0.planned_date || '')}">`)}${field('i-e', 'Termin zakończenia', `<input id="i-e" name="planned_end" type="date" value="${esc(d0.planned_end || '')}">`)}</div>
      ${field('i-s', 'Zakres prac', `<textarea id="i-s" name="scope" rows="2">${esc(d0.scope || '')}</textarea>`)}
      <div class="field-row">${field('i-n', 'Liczba urządzeń do montażu', `<input id="i-n" name="devices_planned" type="number" min="0" value="${esc(d0.devices_planned ?? '')}">`)}</div>
      ${field('i-m', 'Lista materiałowa (jedna pozycja na linię: nazwa; ilość; jm)', `<textarea id="i-m" name="materials" rows="3" placeholder="Podzielnik elektroniczny; 48; szt.&#10;Plomba; 48; szt.">${esc(d0.materials || '')}</textarea>`)}
      ${field('i-notes', 'Uwagi', `<textarea id="i-notes" name="notes" rows="2">${esc(d0.notes || '')}</textarea>`)}
      <fieldset class="checks"><legend class="flabel">Pracownicy (opcjonalnie – można przydzielić później)</legend>${workersBox(active, chosen)}</fieldset>
      ${x ? `<div class="ap-actions"><button type="button" class="btn btn-secondary btn-sm" id="i-mat">Wydaj materiał z magazynu</button><button type="button" class="btn btn-secondary btn-sm" id="i-time">Czas pracy</button>${['wykonany', 'odebrany'].includes(x.status) ? '' : '<button type="button" class="btn btn-ghost btn-sm" id="i-del">Usuń montaż</button>'}</div>` : ''}`,
    { submit: x ? 'Zapisz zmiany' : 'Dodaj montaż', wide: true, onSubmit: async f => {
      const d = read(f);
      try { await submit(d, false); }
      catch (e) { if (/nakładanie/.test(e.message)) { modal('Kolizja terminu pracowników', `<p>${esc(e.message)}</p>`, { submit: x ? 'Zapisz mimo to' : 'Dodaj mimo to', onSubmit: () => submit(d, true) }); return; } throw e; }
    } });
    const box = document.querySelector('#modal-box');
    // Nowa firma w CRM: po dodaniu wraca do formularza montażu z wpisanymi danymi i wybraną firmą.
    box.querySelector('#i-newc').addEventListener('click', () => {
      const d = read(box.querySelector('form'));
      B().customerForm(null, r => installationForm(x, reload, { ...d, customer_id: r && r.id }), { kind: 'firma', departments: [DEP] });
    });
    const im = box.querySelector('#i-mat'), it = box.querySelector('#i-time');
    if (im) im.addEventListener('click', () => window.MXT_ERP.issueForm({ related_type: 'installation', related_id: x.id, title: x.number }, reload));
    if (it) it.addEventListener('click', () => window.MXT_ERP.timeForm({ related_type: 'installation', related_id: x.id, title: x.number }, reload));
    const idel = box.querySelector('#i-del');
    if (idel) idel.addEventListener('click', () => deleteInstallation(x, reload).catch(e => toast(e.message)));
  }
  // Przydział pracowników z harmonogramu (bez otwierania całego formularza).
  async function assignWorkers(x, reload) {
    const ws = await api('d1/pracownicy-dzialu'), chosen = (x.workers || []).map(w => w.id);
    const save = async (ids, allow) => {
      await api('d1/montaze/' + x.id, { worker_ids: ids, allow_clash: allow, updated_at: x.updated_at }, 'PATCH');
      toast(ids.length ? 'Przydzielono pracowników – dostaną powiadomienie.' : 'Usunięto przydział pracowników.'); reload();
    };
    modal('Przydziel pracowników – ' + x.number, `<p class="muted small">${esc(x.building_name || '')}${x.planned_date ? ' · ' + esc(fd(x.planned_date)) : ''}${x.planned_end && x.planned_end !== x.planned_date ? ' – ' + esc(fd(x.planned_end)) : ''}</p>
      ${workersBox(ws.filter(w => w.is_active || chosen.includes(w.id)), chosen)}`,
    { submit: 'Zapisz przydział', onSubmit: async f => {
      const ids = pickedWorkers(f);
      try { await save(ids, false); }
      catch (e) { if (/nakładanie/.test(e.message)) { modal('Kolizja terminu pracowników', `<p>${esc(e.message)}</p>`, { submit: 'Przydziel mimo to', onSubmit: () => save(ids, true) }); return; } throw e; }
    } });
  }
  // Usunięcie montażu: tylko bez historii; z historią – komunikat z listą powiązań i podpowiedź „Anulowany”.
  async function deleteInstallation(x, reload) {
    const h = await api('d1/montaze/' + x.id + '/powiazania');
    if (h.length) { toast(`Montaż ${x.number} ma historię (${h.map(([l, n]) => n > 1 ? l + ': ' + n : l).join(', ')}) – nie można go usunąć. Zmień status na „Anulowany”.`); return; }
    modal('Usunąć montaż ' + x.number + '?', `<p>Montaż <b>${esc(x.building_name || '')}</b>${x.planned_date ? ' (' + esc(fd(x.planned_date)) + ')' : ''} zniknie z harmonogramu i rejestru zleceń. Nie ma zamontowanych urządzeń, materiałów, czasu pracy, faktur ani protokołu.${x.crew_id && x.status !== 'anulowany' ? ' Ekipa dostanie powiadomienie.' : ''} Usunięcia nie można cofnąć.</p>`,
      { submit: 'Usuń montaż', danger: true, cancel: 'Wróć', onSubmit: async () => { await api('d1/montaze/' + x.id, null, 'DELETE'); toast('Montaż ' + x.number + ' usunięty.'); reload(); } });
  }
  async function protocolForm(x, reload) {
    const d = await api('d1/montaze/' + x.id);
    modal('Protokół odbioru – ' + x.number, `<p>${esc(d.building_name)}, ${esc(d.address)} · ekipa ${esc(d.crew_name || '–')} · urządzeń w zleceniu: <b>${esc(d.devices.length)}</b>${d.devices_planned ? ' z ' + esc(d.devices_planned) + ' planowanych' : ''}</p>
      ${d.devices.length < d.devices_planned ? '<p class="notice">Liczba urządzeń przypisanych do zlecenia jest mniejsza niż planowana. Dodaj brakujące numery seryjne w zakładce Urządzenia albo kontynuuj.</p>' : ''}
      ${field('p-acc', 'Odbierający (przedstawiciel wspólnoty / zarządcy)', `<input id="p-acc" name="accepted_by" required maxlength="200" value="${esc(d.accepted_by || '')}">`)}
      ${field('p-notes', 'Uwagi do protokołu', `<textarea id="p-notes" name="notes" rows="3">${esc(d.notes || '')}</textarea>`)}
      <p class="muted small">Protokół PDF zostanie zapisany jako dokument z wersjami, a montaż oznaczony jako odebrany.</p>`,
    { submit: 'Generuj protokół PDF', onSubmit: async f => {
      const r = await api('d1/montaze/' + x.id + '/protokol', { accepted_by: val(f, 'accepted_by'), notes: val(f, 'notes') });
      toast('Protokół ' + r.number + ' (wersja ' + r.version + ') gotowy – link „Protokół PDF” przy montażu.'); reload();
    } });
  }
  // Harmonogram: lista po dniach, tydzień albo miesiąc; filtry pracownika i statusu. Zmiana widoku przerysowuje się lokalnie,
  // a gdy potrzebne są wcześniejsze dane niż pobrane – strona pobiera je od nowa.
  const hst = { widok: 'lista', zakres: 'biezace', ekipa: '', status: '', kursor: '' };
  let H = null;   // { list, crews, od } – ostatnio pobrane montaże i ekipy
  const ACTIVE = ['zaplanowany', 'w_toku'];
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const D = s => new Date(s + 'T12:00:00');
  const addDays = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
  const todayL = () => iso(new Date());
  const from14 = () => addDays(todayL(), -14);
  const weekStart = s => { const d = D(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); };
  const monthStart = s => s.slice(0, 8) + '01';
  const monthEnd = s => { const d = D(monthStart(s)); d.setMonth(d.getMonth() + 1, 0); return iso(d); };
  const isoWeek = s => {
    const d = D(s); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const w1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - w1) / 864e5 - 3 + (w1.getDay() + 6) % 7) / 7);
  };
  const MON = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  const MON1 = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
  const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  const WD3 = ['pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.', 'niedz.'];
  const dm = s => { const d = D(s); return d.getDate() + ' ' + MON[d.getMonth()]; };
  const ddmm = s => s.slice(8) + '.' + s.slice(5, 7);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, a, b, c) => n === 1 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? b : c;
  const nMont = n => n + ' ' + plural(n, 'montaż', 'montaże', 'montaży');
  const rel = s => { const t = todayL(); return s === t ? 'dziś' : s === addDays(t, 1) ? 'jutro' : s === addDays(t, -1) ? 'wczoraj' : dm(s); };
  function dayLabel(s) {
    const t = todayL(), d = D(s), base = WD[d.getDay()] + ', ' + dm(s) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
    return s === t ? 'Dziś · ' + base : s === addDays(t, 1) ? 'Jutro · ' + base : s === addDays(t, -1) ? 'Wczoraj · ' + base : cap(base);
  }
  function weekLabel(ws) {
    const we = addDays(ws, 6), a = D(ws), b = D(we);
    const r = a.getMonth() === b.getMonth() ? a.getDate() + '–' + b.getDate() + ' ' + MON[b.getMonth()] + ' ' + b.getFullYear()
      : a.getFullYear() === b.getFullYear() ? dm(ws) + ' – ' + dm(we) + ' ' + b.getFullYear() : dm(ws) + ' ' + a.getFullYear() + ' – ' + dm(we) + ' ' + b.getFullYear();
    return 'Tydzień ' + isoWeek(ws) + ' · ' + r;
  }
  const monthLabel = s => MON1[D(s).getMonth()] + ' ' + D(s).getFullYear();
  // Montaż wielodniowy trwa od planned_date do planned_end.
  const span = x => [x.planned_date, x.planned_end && x.planned_end > x.planned_date ? x.planned_end : x.planned_date];
  const covers = (x, s) => { const [a, b] = span(x); return a <= s && s <= b; };
  const days = (a, b) => Math.round((D(b) - D(a)) / 864e5) + 1;
  function durText(x) {
    const [a, b] = span(x); if (a === b) return '';
    const n = days(a, b), t = todayL();
    return n + ' dni · do ' + ddmm(b) + (a <= t && t <= b && ACTIVE.includes(x.status) ? ' · dzień ' + days(a, t) + ' z ' + n : '');
  }
  const initials = n => { const w = (String(n || '').replace(/\[[^\]]*\]/g, '').match(/[\p{L}\d]+/gu) || ['?']); return (w.length > 1 ? w[0][0] + (/^\d+$/.test(w[1]) ? w[1] : w[1][0]) : w[0].slice(0, 2)).toUpperCase().slice(0, 3); };
  const crewAv = (id, name) => `<span class="crew-av crew-av-${Math.max(0, H.workers.findIndex(c => c.id === id)) % 5}" aria-hidden="true">${esc(initials(name))}</span>`;
  // Wykonawcy montażu: przydzieleni pracownicy (dawniej ekipa – starsze montaże).
  const wks = x => x.workers || [];
  const assigned = x => !!(x.crew_id || wks(x).length);
  const whoText = x => wks(x).length ? wks(x).map(w => w.name).join(', ') : x.crew_name || '';
  const ic = (k, c) => U().icon(k, c);
  const cursor = () => hst.kursor || todayL();
  // Zakres dat widoku; '' = bez dolnej granicy (lista „Wszystkie terminy”).
  const viewRange = () => hst.widok === 'tydzien' ? [weekStart(cursor()), addDays(weekStart(cursor()), 6)]
    : hst.widok === 'miesiac' ? [weekStart(monthStart(cursor())), addDays(weekStart(monthEnd(cursor())), 6)] : [hst.zakres === 'biezace' ? from14() : '', ''];
  // Pobieramy 31 dni wcześniej, żeby złapać montaże wielodniowe rozpoczęte przed zakresem.
  const fetchFrom = () => { const a = viewRange()[0]; return a === '' ? '' : addDays(a < from14() ? a : from14(), -31); };
  const pass = x => (!hst.ekipa || (hst.ekipa === '__brak' ? !assigned(x) : wks(x).some(w => w.id === hst.ekipa)))
    && (!hst.status || (hst.status === 'aktywne' ? [...ACTIVE, 'wykonany'].includes(x.status) : x.status === hst.status));

  function row(x) {
    const ws = wks(x), canAssign = ACTIVE.includes(x.status);
    const crew = ws.length ? `<${canAssign ? `button type="button" data-iw="${x.id}" title="Zmień przydział pracowników"` : 'span'} class="crew-chip wk-chips">${ws.slice(0, 3).map(w => crewAv(w.id, w.name)).join('')}<span>${esc(ws.length > 2 ? ws[0].name + ' +' + (ws.length - 1) : ws.map(w => w.name).join(', '))}</span></${canAssign ? 'button' : 'span'}>`
      : x.crew_id ? `<span class="crew-chip"><span class="crew-av" aria-hidden="true">${esc(initials(x.crew_name))}</span><span>${esc(x.crew_name)}</span></span>${canAssign ? ` <button type="button" class="hm-assign" data-iw="${x.id}">Przydziel pracowników</button>` : ''}`
      : canAssign ? `<button type="button" class="hm-assign" data-iw="${x.id}">Przydziel pracowników</button>` : '<span class="muted">–</span>';
    const st = x.status === 'odebrany' ? `<span class="hm-done">${chip('odebrany', 'Odebrany')}${x.protocol_document_id ? B().pdfLink('/api/dokumenty/' + x.protocol_document_id + '/plik', 'Protokół PDF') : ''}</span>`
      : `<label class="visually-hidden" for="is-${x.id}">Status montażu ${esc(x.number)}</label><select class="status-select hm-ss st-${esc(x.status)}" id="is-${x.id}" data-is="${x.id}">${Object.entries(INST_ST).filter(([k]) => k !== 'odebrany').map(([k, v]) => `<option value="${k}"${k === x.status ? ' selected' : ''}>${v}</option>`).join('')}</select>${x.status === 'wykonany' ? `<button type="button" class="btn btn-primary btn-sm" data-ip="${x.id}">Protokół odbioru</button>` : ''}`;
    const meta = [durText(x), x.buildings_count ? esc(x.buildings_count + ' bud.') : '', x.customer_name && esc(x.customer_name), x.project_number && esc(x.project_number)].filter(Boolean).join(' · ');
    return `<article class="hm-row hm-${esc(x.status)}">
      <div class="hm-obj"><button type="button" class="hm-name" data-ie="${x.id}">${esc(x.building_name)}</button> <span class="hm-no">${esc(x.number)}</span>
        <span class="hm-addr">${esc(x.address)}${x.city ? ', ' + esc(x.city) : ''}</span>${meta ? `<span class="hm-meta">${meta}</span>` : ''}</div>
      <div class="hm-crew">${crew}</div>
      <div class="hm-dev" title="Urządzenia zamontowane / planowane"><b>${esc(x.devices_installed)}/${esc(x.devices_planned || 0)}</b> urz.</div>
      <div class="hm-st">${st}</div>
      <div class="hm-act"><button type="button" class="hm-edit" data-ie="${x.id}" aria-label="Edytuj montaż ${esc(x.number)}" title="Edytuj">${ic('edit')}</button>${['wykonany', 'odebrany'].includes(x.status) ? '' : `<button type="button" class="hm-edit hm-del" data-idel="${x.id}" aria-label="Usuń montaż ${esc(x.number)}" title="Usuń">${ic('kosz')}</button>`}</div>
    </article>`;
  }
  const dayGroup = (d, xs) => `<section class="hm-day${d === todayL() ? ' hm-today' : ''}"><h3 class="hm-dh"><span>${esc(dayLabel(d))}</span><span class="hm-dn">${nMont(xs.length)}</span></h3>${xs.map(row).join('')}</section>`;
  function listHtml(xs) {
    // Montaż trwający dziś (rozpoczęty wcześniej) pokazujemy pod „Dziś”; przeszłe – w zwijanej sekcji na końcu.
    const t = todayL(), up = {}, past = {};
    for (const x of xs) {
      const [a, b] = span(x), key = a < t && b >= t ? t : a;
      ((key >= t ? up : past)[key] = (key >= t ? up : past)[key] || []).push(x);
    }
    const u = Object.keys(up).sort(), p = Object.keys(past).sort().reverse(), nPast = p.reduce((s, d) => s + past[d].length, 0);
    if (!u.length && !p.length) return `<p class="hm-empty">${hst.ekipa || hst.status ? 'Brak montaży dla wybranych filtrów.' : 'Brak montaży w tym zakresie. Dodaj montaż, zaimportuj listę z Excela albo wczytaj umowę lub harmonogram.'}</p>`;
    return (u.length ? u.map(d => dayGroup(d, up[d])).join('') : '<p class="hm-empty">Brak zaplanowanych montaży od dziś.</p>')
      + (p.length ? `<details class="hm-past"${!u.length || hst.status === 'wykonany' ? ' open' : ''}><summary>Wcześniejsze montaże (${nPast})</summary>${p.map(d => dayGroup(d, past[d])).join('')}</details>` : '');
  }
  const card = x => `<button type="button" class="hm-card hm-${esc(x.status)}" data-ie="${x.id}"><span class="hm-card-n">${esc(x.building_name)}</span><span class="hm-card-s">${assigned(x) ? esc(whoText(x)) : '<b>bez pracowników</b>'} · ${esc(x.devices_planned || 0)} urz.</span></button>`;
  function weekHtml(xs) {
    const ws = weekStart(cursor()), t = todayL();
    return `<div class="hm-week">${[0, 1, 2, 3, 4, 5, 6].map(i => {
      const d = addDays(ws, i), its = xs.filter(x => covers(x, d));
      return `<section class="hm-wd${d === t ? ' hm-today' : ''}${i > 4 ? ' hm-we' : ''}" aria-label="${esc(dayLabel(d))}"><div class="hm-wdh"><span>${WD3[i]}</span><b>${D(d).getDate()}</b>${its.length ? `<span class="hm-wdc">${its.length}</span>` : ''}</div>
        <div class="hm-wdb">${its.map(card).join('') || '<span class="hm-free">brak montaży</span>'}</div></section>`;
    }).join('')}</div>`;
  }
  function monthHtml(xs) {
    const k = cursor(), [gs, ge] = viewRange(), t = todayL();
    let cells = '';
    for (let d = gs; d <= ge; d = addDays(d, 1)) {
      const its = xs.filter(x => covers(x, d)), out = d.slice(0, 7) !== k.slice(0, 7);
      cells += `<div class="hm-md${out ? ' hm-out' : ''}${d === t ? ' hm-today' : ''}${its.length ? ' hm-has' : ''}"><button type="button" class="hm-mdn" data-day="${d}" aria-label="${esc(dayLabel(d))}: ${esc(nMont(its.length))}. Pokaż tydzień">${D(d).getDate()}</button>
        ${its.slice(0, 3).map(x => `<button type="button" class="hm-me hm-${esc(x.status)}" data-ie="${x.id}" title="${esc(x.number + ' · ' + x.building_name + (assigned(x) ? ' · ' + whoText(x) : ' · bez pracowników'))}">${esc(x.building_name)}</button>`).join('')}
        ${its.length > 3 ? `<button type="button" class="hm-more" data-day="${d}">+${its.length - 3} więcej</button>` : ''}</div>`;
    }
    return `<div class="hm-month"><div class="hm-mh" aria-hidden="true">${WD3.map(w => `<span>${w}</span>`).join('')}</div><div class="hm-mg">${cells}</div></div>`;
  }

  async function harmonogram(body, reload, alive) {
    const od = fetchFrom();
    const [list, workers, [sum, srv, odc]] = await Promise.all([api('d1/montaze' + (od ? '?od=' + od : '')), api('d1/pracownicy-dzialu'), S]);
    if (!alive()) return;
    H = { list, workers: workers.filter(w => w.is_active), od };
    const t = todayL(), act = list.filter(x => ACTIVE.includes(x.status));
    const today = act.filter(x => covers(x, t)), d14 = act.filter(x => x.planned_date >= t && x.planned_date <= addDays(t, 14));
    const crewToday = [...new Set(today.flatMap(x => wks(x).length ? wks(x).map(w => w.name) : x.crew_name ? [x.crew_name] : []))];
    const tag = (txt, tone) => `<span class="hk-tag hk-${tone}">${esc(txt)}</span>`;
    const kpi = (label, v, foot, act2) => `<${act2 ? `button type="button" class="hk hk-btn" ${act2}` : 'div class="hk"'}><span class="hk-l">${esc(label)}</span><span class="hk-v${v ? '' : ' hk-zero'}">${esc(v)}</span>${foot || ''}</${act2 ? 'button' : 'div'}>`;
    const kpis = [
      kpi('Montaże dziś', sum.trwajace, `<span class="hk-f">${crewToday.length ? esc(crewToday.join(' · ')) : 'brak montaży'}</span>`),
      kpi('Najbliższe 14 dni', sum.montaze_14d, `<span class="hk-f">${esc(d14.reduce((s, x) => s + (x.devices_planned || 0), 0).toLocaleString('pl-PL'))} urządzeń</span>`),
      kpi('Bez pracowników', sum.bez_ekipy, sum.bez_ekipy ? tag('do przydzielenia', 'warn') : tag('wszystkie przydzielone', 'ok'), sum.bez_ekipy ? 'data-filter="bez"' : ''),
      kpi('Czekają na protokół', sum.do_odbioru, sum.do_odbioru ? tag('do odbioru', 'warn') : '', sum.do_odbioru ? 'data-filter="protokol"' : ''),
      srv ? kpi('Serwisy do przydziału', srv.nieprzypisane, srv.po_terminie_przydzialu ? tag(srv.po_terminie_przydzialu + ' po terminie', 'danger') : srv.nieprzypisane ? tag('czekają', 'warn') : '', 'data-gotab="serwisy"') : '',
      odc ? kpi('Odczyty po terminie', odc.po_terminie, odc.po_terminie ? tag('zaległe', 'danger') : tag('wszystko w terminie', 'ok'), 'data-gotab="odczyty"') : ''
    ].join('');
    // Wymaga uwagi: tylko sprawy, które czekają na reakcję.
    const unassigned = act.filter(x => !assigned(x) && span(x)[1] >= t).sort((a, b) => a.planned_date < b.planned_date ? -1 : 1)[0];
    const oldest = list.filter(x => x.status === 'wykonany').sort((a, b) => a.planned_date < b.planned_date ? -1 : 1)[0];
    const attn = [];
    const ai = (n, tone, title, sub, a) => attn.push(`<li><button type="button" class="attn-i" ${a}><span class="attn-n attn-${tone}">${esc(n)}</span><span class="attn-t">${esc(title)}<small>${esc(sub)}</small></span>${ic('right', 'ic ic-sm')}</button></li>`);
    if (sum.bez_ekipy) ai(sum.bez_ekipy, 'warn', 'Montaże bez pracowników', unassigned ? 'najbliższy: ' + rel(unassigned.planned_date) : 'przydziel pracowników', 'data-filter="bez"');
    if (srv && srv.po_terminie_przydzialu) ai(srv.po_terminie_przydzialu, 'danger', 'Serwisy po terminie przydziału', 'przydziel serwisanta', 'data-gotab="serwisy"');
    else if (srv && srv.nieprzypisane) ai(srv.nieprzypisane, 'warn', 'Serwisy do przydzielenia', 'czekają na serwisanta', 'data-gotab="serwisy"');
    if (sum.do_odbioru) ai(sum.do_odbioru, 'warn', 'Montaże do protokołu odbioru', oldest ? 'najstarszy: ' + rel(oldest.planned_date) : 'wykonane, bez protokołu', 'data-filter="protokol"');
    if (odc && odc.po_terminie) ai(odc.po_terminie, 'danger', 'Odczyty po terminie', 'zaplanuj odczyt', 'data-gotab="odczyty"');
    if (sum.reklamacje_otwarte) ai(sum.reklamacje_otwarte, 'warn', 'Otwarte reklamacje', 'do rozpatrzenia', 'data-gotab="reklamacje"');
    const okLine = `<p class="attn-fine"><span class="attn-n attn-ok">${ic('ok', 'ic ic-sm')}</span>${attn.length ? 'Pozostałe sprawy w terminie' : 'Wszystko w terminie – nic nie czeka na reakcję'}</p>`;
    // Pracownicy dziś: na montażu (montaż obejmuje dzisiejszy dzień) albo wolny z najbliższym montażem.
    const mine = (x, w) => wks(x).some(v => v.id === w.id);
    const crewRows = H.workers.map(c => {
      const job = today.find(x => mine(x, c)), next = act.filter(x => mine(x, c) && x.planned_date > t).sort((a, b) => a.planned_date < b.planned_date ? -1 : 1)[0];
      return `<li class="crew-r">${crewAv(c.id, c.name)}<span class="crew-t">${esc(c.name)}<small>${job ? esc(job.building_name + (job.city ? ', ' + job.city : '')) : next ? 'następny montaż: ' + esc(rel(next.planned_date)) : 'brak zaplanowanych montaży'}</small></span>${job ? chip('teal', 'na montażu') : chip('ok', 'wolny')}</li>`;
    }).join('');
    const xlOn = U().has('export.xlsx');
    body.innerHTML = `<p data-ws-sub></p>
      <div data-ws-actions hidden>
        <div class="seg hm-views" role="group" aria-label="Widok harmonogramu">${[['lista', 'Lista'], ['tydzien', 'Tydzień'], ['miesiac', 'Miesiąc']].map(([k, v]) => `<button type="button" class="seg-b" data-v="${k}">${v}</button>`).join('')}</div>
        <div class="dd"><button type="button" class="btn btn-secondary" data-pop aria-haspopup="true" aria-expanded="false">${ic('up')}Importuj${ic('chev', 'ic ic-sm')}</button>
          <div class="pop dd-menu" hidden><button type="button" class="pop-i" id="i-xls"><b>Z Excela</b><span>lista montaży z szablonu .xlsx</span></button>
            <button type="button" class="pop-i" id="i-doc"><b>Z umowy lub harmonogramu</b><span>PDF albo skan – odczyt przez AI</span></button></div></div>
        ${xlOn ? `<a class="btn btn-secondary btn-icon" id="hm-xl" href="#" download aria-label="Eksport widocznych montaży do Excela" title="Eksport do Excela">${ic('down')}</a>` : ''}
        <button type="button" class="btn btn-primary ws-fab" id="i-new">${ic('plus')}Dodaj montaż</button>
      </div>
      <section class="hm-kpis" aria-label="Podsumowanie działu">${kpis}</section>
      <div class="hm-grid">
        <section class="panel hm-attn" aria-labelledby="hm-attn-t"><h2 class="panel-title" id="hm-attn-t">Wymaga uwagi</h2>${attn.length ? `<ul class="attn">${attn.join('')}</ul>` : ''}${okLine}</section>
        <section class="panel hm-main" aria-label="Montaże"><div id="hm-view"></div>
          <p class="hm-note">Kolizje terminów pracowników są wykrywane automatycznie. Pracownicy z kontem w aplikacji dostają powiadomienie o przydziale i zmianie terminu, a montaż widzą w „Moje montaże”.</p></section>
        <section class="panel hm-crews" aria-labelledby="hm-crews-t"><h2 class="panel-title" id="hm-crews-t">Pracownicy dziś</h2>
          ${crewRows ? `<ul class="crew-list">${crewRows}</ul>` : '<p class="empty-inline">Brak pracowników. <button type="button" class="linkish" data-gotab="ekipy">Dodaj pracownika</button></p>'}</section>
      </div>`;
    const views = [...body.querySelectorAll('[data-v]')], xlA = body.querySelector('#hm-xl'), view = body.querySelector('#hm-view'), grid = body.querySelector('.hm-grid');
    const setSub = txt => { const el = body.querySelector('[data-ws-sub]') || (body.closest('.ws') || document).querySelector('.ws-sub'); if (el) { el.textContent = txt; el.hidden = false; } };
    // Zmiana widoku lub filtrów: lokalnie, jeśli pobrane dane obejmują nowy zakres; inaczej pobranie od nowa.
    const apply = ch => {
      Object.assign(hst, ch);
      const need = fetchFrom();
      if (H.od === '' || (need !== '' && need >= H.od)) paint(); else reload();
    };
    function paint() {
      const [a, b] = viewRange(), xs = list.filter(x => pass(x) && (!a || span(x)[1] >= a) && (!b || x.planned_date <= b));
      const nav = what => `<div class="hm-nav"><button type="button" class="btn btn-secondary btn-icon" data-nav="-1" aria-label="${what === 'w' ? 'Poprzedni tydzień' : 'Poprzedni miesiąc'}">${ic('left')}</button>
        <button type="button" class="btn btn-secondary" data-nav="0">Dziś</button><button type="button" class="btn btn-secondary btn-icon" data-nav="1" aria-label="${what === 'w' ? 'Następny tydzień' : 'Następny miesiąc'}">${ic('right')}</button>
        <b class="hm-navl">${esc(what === 'w' ? weekLabel(weekStart(cursor())) : monthLabel(cursor()))}</b></div>`;
      const sel = (id, f, label, o) => `<label class="visually-hidden" for="${id}">${label}</label><select id="${id}" class="select-sm" data-f="${f}">${o.map(([k, v]) => `<option value="${esc(k)}"${hst[f] === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
      const filters = sel('hf-c', 'ekipa', 'Pracownik', [['', 'Wszyscy pracownicy'], ...H.workers.map(c => [c.id, c.name]), ['__brak', 'Bez pracowników']])
        + sel('hf-s', 'status', 'Status', [['', 'Wszystkie statusy'], ['aktywne', 'Aktywne (bez odebranych)'], ...Object.entries(INST_ST)])
        + (hst.widok === 'lista' ? sel('hf-z', 'zakres', 'Zakres', [['biezace', 'Od ' + fd(from14())], ['wszystkie', 'Wszystkie terminy']]) : '');
      const n = xs.length;
      view.innerHTML = `${hst.widok !== 'lista' ? nav(hst.widok === 'tydzien' ? 'w' : 'm') : ''}<div class="hm-bar">${filters}<div class="hm-sv"></div><span class="hm-count">${esc(nMont(n))}</span></div>
        ${hst.widok === 'lista' ? listHtml(xs) : hst.widok === 'tydzien' ? weekHtml(xs) : monthHtml(xs)}
        ${hst.widok !== 'lista' && !n ? `<p class="hm-empty">${hst.ekipa || hst.status ? 'Brak montaży dla wybranych filtrów.' : 'W tym okresie nie ma montaży.'}</p>` : ''}`;
      grid.classList.toggle('hm-wide', hst.widok !== 'lista');   // tydzień i miesiąc na całą szerokość
      // Zapisane widoki: widok kalendarza i filtry (ekipa, status, zakres) – własne dla każdego użytkownika.
      U().savedViews(view.querySelector('.hm-sv'), 'harmonogram', () => ({ widok: hst.widok, zakres: hst.zakres, ekipa: hst.ekipa, status: hst.status }),
        p => apply({ widok: ['lista', 'tydzien', 'miesiac'].includes(p.widok) ? p.widok : 'lista', zakres: p.zakres === 'wszystkie' ? 'wszystkie' : 'biezace',
          ekipa: typeof p.ekipa === 'string' && (p.ekipa === '__brak' || H.workers.some(w => w.id === p.ekipa)) ? p.ekipa : '', status: typeof p.status === 'string' ? p.status : '' }));
      views.forEach(v => { const o = v.dataset.v === hst.widok; v.classList.toggle('seg-on', o); v.setAttribute('aria-pressed', String(o)); });
      setSub(hst.widok === 'tydzien' ? weekLabel(weekStart(cursor())) : hst.widok === 'miesiac' ? monthLabel(cursor())
        : hst.zakres === 'biezace' ? 'Od dziś i ostatnie 14 dni · ' + nMont(n) : 'Wszystkie terminy · ' + nMont(n));
      if (xlA) {
        const p = {};
        if (a && hst.widok !== 'lista') { p.od = a; p.do = b; } else if (a) p.od = a;
        if (hst.ekipa && hst.ekipa !== '__brak') p.pracownik = hst.ekipa;
        if (INST_ST[hst.status]) p.status = hst.status;
        xlA.href = '/api/eksport/d1/montaze?' + new URLSearchParams(p);
      }
    }
    views.forEach(v => v.addEventListener('click', () => apply({ widok: v.dataset.v })));
    body.querySelector('#i-new').addEventListener('click', () => installationForm(null, reload));
    body.querySelector('#i-xls').addEventListener('click', () => window.MXT_IMPORT.excel(reload));
    body.querySelector('#i-doc').addEventListener('click', () => window.MXT_IMPORT.document(reload));
    body.addEventListener('click', async e => {
      const el = e.target.closest('[data-ie],[data-iw],[data-idel],[data-ip],[data-nav],[data-day],[data-filter],[data-gotab]'); if (!el) return;
      const ds = el.dataset;
      if (ds.iw) return assignWorkers(list.find(x => x.id === ds.iw) || await api('d1/montaze/' + ds.iw), reload).catch(err => toast(err.message));
      if (ds.idel) return deleteInstallation(list.find(x => x.id === ds.idel) || await api('d1/montaze/' + ds.idel), reload).catch(err => toast(err.message));
      if (ds.ie) return installationForm(await api('d1/montaze/' + ds.ie), reload);
      if (ds.ip) return protocolForm(list.find(x => x.id === ds.ip), reload);
      if (ds.gotab) { tab = ds.gotab; return reload(); }
      if (ds.day) return apply({ widok: 'tydzien', kursor: ds.day });
      if (ds.filter === 'bez') return apply({ widok: 'lista', zakres: 'biezace', ekipa: '__brak', status: 'aktywne' });
      if (ds.filter === 'protokol') return apply({ widok: 'lista', zakres: 'wszystkie', ekipa: '', status: 'wykonany' });
      if (ds.nav != null) {
        const n = Number(ds.nav);
        if (!n) return apply({ kursor: '' });
        if (hst.widok === 'tydzien') return apply({ kursor: addDays(cursor(), 7 * n) });
        const d = D(monthStart(cursor())); d.setMonth(d.getMonth() + n); return apply({ kursor: iso(d) });
      }
    });
    body.addEventListener('change', async e => {
      const s = e.target;
      if (s.dataset.f) return apply({ [s.dataset.f]: s.value });
      if (s.dataset.is) { try { await api('d1/montaze/' + s.dataset.is, { status: s.value }, 'PATCH'); toast('Status montażu zmieniony.'); reload(); } catch (x) { toast(x.message); reload(); } }
    });
    paint();
  }

  // ---------- pracownicy (zakładka „ekipy” – adres bez zmian dla zapisanych linków) ----------
  // Pracownik: imię i nazwisko, dział, stanowisko, telefon, e-mail. Przydzielany do montaży w harmonogramie.
  const WDEPT = { 'podzielniki-i-montaze': 'Ciepłomierze i podzielniki', 'sprzedaz-czesci-i-eksport': 'Sprzedaż części samochodowych', ubezpieczenia: 'Ubezpieczenia', biuro: 'Biuro' };
  function workerForm(w, reload) {
    const v = w || { department_id: DEP };
    modal(w ? 'Pracownik ' + w.name : 'Dodaj pracownika', `${field('w-n', 'Imię i nazwisko', `<input id="w-n" name="name" required maxlength="120" value="${esc(v.name || '')}">`)}
      <div class="field-row">${field('w-d', 'Dział', `<select id="w-d" name="department_id">${Object.entries(WDEPT).map(([k, t]) => `<option value="${k}"${(v.department_id || DEP) === k ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`)}
        ${field('w-s', 'Stanowisko', `<input id="w-s" name="position" maxlength="120" value="${esc(v.position || '')}" placeholder="np. Monter instalacji">`)}</div>
      <div class="field-row">${field('w-p', 'Numer telefonu', `<input id="w-p" name="phone" type="tel" maxlength="50" value="${esc(v.phone || '')}">`)}
        ${field('w-e', 'Adres e-mail', `<input id="w-e" name="email" type="email" maxlength="200" value="${esc(v.email || '')}">`)}</div>
      ${w ? `<label class="toggle"><input type="checkbox" name="active"${w.is_active ? ' checked' : ''}> Pracownik aktywny</label>
        <p class="muted small">${w.user_login ? 'Konto w aplikacji: ' + esc(w.user_login) + ' – powiadomienia o montażach i „Moje montaże”.' : 'Bez konta w aplikacji – konto i powiązanie z pracownikiem zakłada administrator w module „Konta i role”.'}</p>
        <div class="ap-actions">${U().delBtn('d1/instalatorzy/' + w.id, 'Pracownik ' + w.name, 'Odznacz „Pracownik aktywny” – przydziały zostaną w historii.', 'Usuń pracownika')}</div>` : ''}`,
    { submit: w ? 'Zapisz' : 'Dodaj pracownika', onSubmit: async f => {
      const d = { name: val(f, 'name'), department_id: val(f, 'department_id'), position: val(f, 'position'), phone: val(f, 'phone'), email: val(f, 'email') };
      if (w) await api('d1/instalatorzy/' + w.id, { ...d, is_active: f.elements.active.checked, updated_at: w.updated_at }, 'PATCH'); else await api('d1/instalatorzy', d);
      toast(w ? 'Pracownik zapisany.' : 'Pracownik dodany.'); reload();
    } });
  }
  async function ekipy(body, reload, alive) {
    const ws = await api('d1/pracownicy-dzialu');
    if (!alive()) return;
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="w-new">${U().icon('plus')}Dodaj pracownika</button></div>
      <section class="panel">${ws.length ? table(['Imię i nazwisko', 'Dział', 'Stanowisko', 'Telefon', 'E-mail', 'Montaże', ''], ws.map(w => `<tr${w.is_active ? '' : ' class="row-off"'}>
        <td><button type="button" class="linkish" data-wk="${w.id}"><b>${esc(w.name)}</b></button>${w.is_active ? '' : ' ' + chip('off', 'nieaktywny')}${w.user_login ? `<div class="muted small">konto: ${esc(w.user_login)}</div>` : ''}</td>
        <td>${esc(WDEPT[w.department_id] || w.department_id)}</td><td>${esc(w.position || '–')}</td>
        <td>${w.phone ? `<a href="tel:${esc(w.phone.replace(/\s/g, ''))}">${esc(w.phone)}</a>` : '–'}</td><td>${w.email ? `<a href="mailto:${esc(w.email)}">${esc(w.email)}</a>` : '–'}</td>
        <td class="num">${esc(w.upcoming)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-wk="${w.id}">Edytuj</button></td></tr>`))
        : '<p class="empty-inline">Brak pracowników. Dodaj pierwszego pracownika – potem przydzielisz go do montażu w harmonogramie.</p>'}</section>
      <p class="muted small">„Montaże” – liczba nadchodzących montaży, do których pracownik jest przydzielony. Kliknij nazwisko, aby edytować dane lub usunąć pracownika.</p>`;
    body.querySelector('#w-new').addEventListener('click', () => workerForm(null, reload));
    body.querySelectorAll('[data-wk]').forEach(b => b.addEventListener('click', () => workerForm(ws.find(x => x.id === b.dataset.wk), reload)));
  }

  // ---------- reklamacje ----------
  async function reklamacje(body, reload) { body.innerHTML = ''; await B().complaintsPanel(body, DEP, reload); }

  // ---------- rozliczenia kontraktów ----------
  async function rozliczenia(body, reload, alive) {
    // Rejestr faktur i kosztów działu widzą role finansowe; pozostali – kontrakty i ich rozliczenie.
    const finOk = U().has('finance.view');
    const [kt, fin] = await Promise.all([api('d1/kontrakty'), finOk ? api('finanse?dzial=' + DEP) : Promise.resolve([])]);
    if (!alive()) return;
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="k-new">Nowy kontrakt</button>${finOk ? '<button type="button" class="btn btn-secondary" id="f-new">Dodaj fakturę / koszt</button>' : ''}${xl('kontrakty')}${finOk ? xl('finanse').replace('Eksport do Excela', 'Finanse działu do Excela') : ''}</div>
      <section class="panel"><h2 class="panel-title">Kontrakty</h2>${table(['Kontrakt', 'Klient', 'Status', { t: 'Wartość', num: 1 }, { t: 'Zafakturowano', num: 1 }, { t: 'Zapłacono', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, 'Montaże'], kt.map(k => `<tr>
        <td><button type="button" class="linkish" data-proj="${k.id}"><b>${esc(k.number)}</b></button><div class="small">${esc(k.title)}</div>${k.document_id ? B().pdfLink('/api/dokumenty/' + k.document_id + '/plik', 'Umowa / harmonogram') : ''}</td><td>${esc(k.customer_name || '–')}</td>
        <td><label class="visually-hidden" for="ks-${k.id}">Status</label><select class="status-select" id="ks-${k.id}" data-ks="${k.id}">${Object.entries(KT_ST).map(([s, v]) => `<option value="${s}"${s === k.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="num">${esc(pln(k.value_net))}</td><td class="num">${esc(pln(k.zafakturowano))}${k.do_zafakturowania ? `<div class="small muted">zostało ${esc(pln(k.do_zafakturowania))}</div>` : ''}</td><td class="num">${esc(pln(k.zaplacono))}</td>
        <td class="num">${esc(pln(k.koszt))}</td><td class="num"><b>${esc(pln(k.marza))}</b></td><td class="num">${esc(k.installations_done)}/${esc(k.installations)}</td></tr>`), 'Brak kontraktów.')}</section>
      ${finOk ? '<section class="panel"><h2 class="panel-title">Faktury i koszty działu</h2><div id="fin-rows"></div></section>' : ''}`;
    if (finOk) {
      const fr = body.querySelector('#fin-rows'); fr.innerHTML = B().financeRows(fin, reload, fr);
      body.querySelector('#f-new').addEventListener('click', () => B().financeForm({ department_id: DEP }, reload));
    }
    body.querySelectorAll('[data-proj]').forEach(b => b.addEventListener('click', () => window.MXT_ERP.projectCard(b.dataset.proj, reload)));
    body.querySelectorAll('[data-ks]').forEach(s => s.addEventListener('change', async () => { try { await api('d1/kontrakty/' + s.dataset.ks, { status: s.value }, 'PATCH'); toast('Status kontraktu zmieniony.'); } catch (e) { toast(e.message); reload(); } }));
    body.querySelector('#k-new').addEventListener('click', async () => {
      const cust = await api('klienci');
      modal('Nowy kontrakt', `${field('k-c', 'Klient', `<select id="k-c" name="customer_id" required>${opts(cust, null, c => c.name, c => c.id, '– wybierz z CRM –')}</select>`)}
        ${field('k-t', 'Nazwa kontraktu', '<input id="k-t" name="title" required maxlength="200" placeholder="np. Wymiana podzielników – Słoneczna 12">')}
        <div class="field-row">${field('k-v', 'Wartość netto (PLN)', '<input id="k-v" name="value_net" type="number" min="0" step="0.01">')}${field('k-s', 'Początek', '<input id="k-s" name="start_date" type="date">')}${field('k-e', 'Koniec', '<input id="k-e" name="end_date" type="date">')}</div>`,
      { submit: 'Dodaj kontrakt', onSubmit: async f => { await api('d1/kontrakty', { customer_id: val(f, 'customer_id'), title: val(f, 'title'), value_net: val(f, 'value_net'), start_date: val(f, 'start_date'), end_date: val(f, 'end_date') }); toast('Kontrakt dodany.'); reload(); } });
    });
  }

  // ---------- rentowność ----------
  async function rentownosc(body, reload, alive) {
    const r = await api('d1/rentownosc');
    if (!alive()) return;
    const max = Math.max(1, ...r.buildings.map(b => Math.abs(b.marza)));
    const row = (name, sub, x) => `<tr><td>${name}${sub ? `<div class="muted small">${sub}</div>` : ''}</td><td class="num">${esc(pln(x.przychod))}</td><td class="num">${esc(pln(x.koszt))}</td>
      <td class="num"><b class="${x.marza < 0 ? 'txt-danger' : ''}">${esc(pln(x.marza))}</b></td><td class="num">${x.marza_pct == null ? '–' : esc(x.marza_pct) + '%'}</td></tr>`;
    body.innerHTML = `${xl('rentownosc') ? `<div class="toolbar">${xl('rentownosc')}</div>` : ''}<section class="panel"><h2 class="panel-title">Rentowność budynków</h2>
        <div class="hbars">${r.buildings.filter(b => b.przychod || b.koszt).map(b => `<div class="hb"><span class="hb-l">${esc(b.name)}</span><span class="hb-bar"><i class="${b.marza < 0 ? 'neg' : ''}" data-w="${Math.round(Math.abs(b.marza) / max * 100)}"></i></span><span class="hb-v">${esc(pln(b.marza))}</span></div>`).join('') || '<p class="empty-inline">Brak przychodów i kosztów przypisanych do budynków.</p>'}</div>
        ${table(['Budynek', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Marża %', num: 1 }], r.buildings.map(b => row(esc(b.name), esc(b.address), b)), '')}</section>
      <section class="panel"><h2 class="panel-title">Rentowność zleceń montażowych</h2>${table(['Zlecenie', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Marża %', num: 1 }], r.installations.map(i => row(esc(i.number), esc(i.building_name) + ' · ' + esc(fd(i.planned_date)), i)), 'Brak zleceń.')}</section>
      <section class="panel"><h2 class="panel-title">Rentowność kontraktów</h2>${table(['Kontrakt', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Marża %', num: 1 }], r.projects.map(k => row(esc(k.number), esc(k.title), k)), 'Brak kontraktów.')}</section>
      <p class="muted small">Przychody i koszty pochodzą z wpisów Finance Intelligence przypisanych do budynku, zlecenia lub kontraktu.</p>`;
  }

  // ---------- oferty (Handlowiec) ----------
  async function oferty(body, reload) { await B().offersPanel(body, DEP, reload); }

  window.MXT_D1 = { installationForm: (x, after) => installationForm(x, after || (() => {})), buildingCard: (id, after) => buildingCard(id, after || (() => {})) };
  window.MXT_MODULES.register(PATH, { title: 'Ciepłomierze i podzielniki', perm: 'departments.view', render: page });
})();
