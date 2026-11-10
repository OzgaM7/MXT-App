'use strict';
// Dział 1 – Podzielniki i Montaże (pełny zakres).
(() => {
  const U = () => window.MXT_UI, B = () => window.MXT_BIZ;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => B().pln(n), table = (...a) => B().table(...a), opts = (...a) => B().opts(...a);
  const DEP = 'podzielniki-i-montaze', PATH = '/dzial/' + DEP;
  const TABS = [['budynki', 'Budynki i wspólnoty'], ['urzadzenia', 'Urządzenia'], ['harmonogram', 'Harmonogram montaży'], ['ekipy', 'Ekipy i instalatorzy'],
    ['reklamacje', 'Reklamacje'], ['rozliczenia', 'Rozliczenia kontraktów'], ['rentownosc', 'Rentowność'], ['oferty', 'Oferty']];
  const DEV = { podzielnik: 'Podzielnik kosztów', wodomierz: 'Wodomierz', cieplomierz: 'Ciepłomierz', modul_radiowy: 'Moduł radiowy', inny: 'Inne' };
  const DEV_ST = { magazyn: 'Magazyn', zamontowane: 'Zamontowane', zdemontowane: 'Zdemontowane', wadliwe: 'Wadliwe' };
  const INST_ST = { zaplanowany: 'Zaplanowany', w_toku: 'W toku', wykonany: 'Wykonany', odebrany: 'Odebrany (protokół)', anulowany: 'Anulowany' };
  const KT_ST = { oferta: 'Oferta', w_realizacji: 'W realizacji', zakonczony: 'Zakończony', rozliczony: 'Rozliczony', anulowany: 'Anulowany' };
  let tab = 'budynki';
  const st = { q: '', devQ: '' };

  async function page(root, path, alive) {
    const body = U().deptFrame(root, 'Podzielniki i Montaże', TABS, tab, t => { tab = t; reload(); }, 'Budynki, urządzenia, montaże, protokoły odbioru, rozliczenia i rentowność.');
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await ({ budynki, urzadzenia, harmonogram, ekipy, reklamacje, rozliczenia, rentownosc, oferty }[tab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel);
    if (['budynki', 'harmonogram'].includes(tab)) await B().agentsStrip(panel, DEP);
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
      b ? await api('d1/budynki/' + b.id, d, 'PATCH') : await api('d1/budynki', d); toast('Budynek zapisany.'); reload();
    } });
    box.querySelector('#b-newc').addEventListener('click', () => B().customerForm(null, () => buildingForm(b, reload), { kind: 'wspolnota', departments: [DEP] }));
  }
  async function buildingCard(id, reload) {
    const b = await api('d1/budynki/' + id);
    const box = modal(b.name, `<p class="muted">${esc(b.address)}${b.city ? ', ' + esc(b.city) : ''} · ${esc(b.customer_name || 'bez przypisanej wspólnoty')} · ${esc(b.units_count)} lokali${b.heating_type ? ' · ' + esc(b.heating_type) : ''}</p>
      <div class="kpis kpis-3"><div class="kpi kpi-blue"><span class="kpi-v">${esc(pln(b.przychod))}</span><span class="kpi-l">Przychody</span></div><div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(b.koszt))}</span><span class="kpi-l">Koszty</span></div>
        <div class="kpi ${b.przychod - b.koszt >= 0 ? 'kpi-ok' : 'kpi-danger'}"><span class="kpi-v">${esc(pln(b.przychod - b.koszt))}</span><span class="kpi-l">Marża budynku</span></div></div>
      <h3 class="panel-sub">Urządzenia (${b.devices.length})</h3>${table(['Numer seryjny', 'Typ', 'Lokalizacja', 'Status', 'Montaż'], b.devices.map(d => `<tr><td class="mono-ink">${esc(d.serial_no)}</td><td>${esc(DEV[d.type])}</td><td>${esc(d.location || '–')}</td><td>${chip(d.status === 'wadliwe' ? 'deny' : d.status === 'zamontowane' ? 'ok' : 'off', DEV_ST[d.status])}</td><td class="small">${esc(d.installation_number || '–')}</td></tr>`), 'Brak urządzeń.')}
      <h3 class="panel-sub">Montaże</h3>${table(['Numer', 'Termin', 'Ekipa', 'Status', ''], b.installations.map(i => `<tr><td>${esc(i.number)}</td><td>${esc(fd(i.planned_date))}</td><td>${esc(i.crew_name || '–')}</td><td>${chip(i.status, INST_ST[i.status])}</td><td>${i.protocol_document_id ? B().pdfLink('/api/dokumenty/' + i.protocol_document_id + '/plik', 'Protokół') : ''}</td></tr>`), 'Brak montaży.')}
      <h3 class="panel-sub">Reklamacje</h3>${table(['Numer', 'Tytuł', 'Status', 'Zgłoszono'], b.complaints.map(x => `<tr><td>${esc(x.number)}</td><td>${esc(x.title)}</td><td>${chip(x.status, B().CPL_ST[x.status])}</td><td>${esc(fd(x.reported_at))}</td></tr>`), 'Brak reklamacji.')}
      <h3 class="panel-sub">Rozliczenia</h3>${table(['Data', 'Rodzaj', 'Opis', 'Faktura', { t: 'PLN', num: 1 }], b.finance.map(x => `<tr><td>${esc(fd(x.entry_date))}</td><td>${esc(x.kind === 'przychod' ? 'Przychód' : 'Koszt')}</td><td>${esc(x.description || x.category)}</td><td>${esc(x.invoice_no || '–')}</td><td class="num">${esc(pln(x.amount_pln))}</td></tr>`), 'Brak wpisów.')}
      <div class="ap-actions"><button type="button" class="btn btn-secondary btn-sm" id="bc-edit">Edytuj budynek</button><button type="button" class="btn btn-secondary btn-sm" id="bc-dev">Dodaj urządzenia</button><button type="button" class="btn btn-secondary btn-sm" id="bc-fin">Dodaj fakturę / koszt</button></div>`, { wide: true });
    box.querySelector('#bc-edit').addEventListener('click', () => buildingForm(b, reload));
    box.querySelector('#bc-dev').addEventListener('click', () => deviceForm(b.id, reload));
    box.querySelector('#bc-fin').addEventListener('click', () => B().financeForm({ department_id: DEP, building_id: b.id }, reload));
  }
  async function budynki(body, reload, alive) {
    const [sum, list] = await Promise.all([api('d1/podsumowanie'), api('d1/budynki?' + new URLSearchParams(st.q ? { q: st.q } : {}))]);
    if (!alive()) return;
    body.innerHTML = `<section class="kpis">
        <div class="kpi kpi-blue"><span class="kpi-v">${esc(sum.budynki)}</span><span class="kpi-l">Budynki (${esc(sum.lokale)} lokali)</span></div>
        <div class="kpi kpi-teal"><span class="kpi-v">${esc(sum.urzadzenia)}</span><span class="kpi-l">Zamontowane urządzenia</span></div>
        <div class="kpi kpi-violet"><span class="kpi-v">${esc(sum.montaze_14d)}</span><span class="kpi-l">Montaże w 14 dni</span></div>
        <div class="kpi ${sum.do_odbioru ? 'kpi-warn' : 'kpi-neutral'}"><span class="kpi-v">${esc(sum.do_odbioru)}</span><span class="kpi-l">Czekają na protokół</span></div>
        <div class="kpi ${sum.reklamacje_otwarte ? 'kpi-warn' : 'kpi-neutral'}"><span class="kpi-v">${esc(sum.reklamacje_otwarte)}</span><span class="kpi-l">Otwarte reklamacje</span></div>
        <div class="kpi kpi-neutral"><span class="kpi-v">${esc(sum.ekipy)}</span><span class="kpi-l">Aktywne ekipy</span></div></section>
      <form class="toolbar" id="bf"><label class="visually-hidden" for="bq">Szukaj</label><input id="bq" name="q" class="select-sm" placeholder="Szukaj: nazwa, adres, miasto, wspólnota" value="${esc(st.q)}">
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button><button type="button" class="btn btn-primary btn-sm" id="b-new">Nowy budynek</button></form>
      <section class="panel">${table(['Budynek', 'Wspólnota', { t: 'Lokale', num: 1 }, { t: 'Urządzenia', num: 1 }, { t: 'Montaże', num: 1 }, 'Reklamacje', { t: 'Marża', num: 1 }], list.map(b => `<tr>
        <td><button type="button" class="linkish" data-b="${b.id}">${esc(b.name)}</button><div class="muted small">${esc(b.address)}${b.city ? ', ' + esc(b.city) : ''}</div></td><td>${esc(b.customer_name || '–')}</td>
        <td class="num">${esc(b.units_count)}</td><td class="num">${esc(b.devices)}</td><td class="num">${esc(b.installations)}</td><td>${b.open_complaints ? chip('warn', b.open_complaints + ' otwarte') : '<span class="muted">–</span>'}</td>
        <td class="num">${esc(pln(b.przychod - b.koszt))}</td></tr>`), 'Brak budynków. Dodaj pierwszy budynek przyciskiem „Nowy budynek”.')}</section>`;
    body.querySelector('#bf').addEventListener('submit', e => { e.preventDefault(); st.q = val(e.target, 'q').trim(); reload(); });
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
    const list = await api('d1/urzadzenia?' + new URLSearchParams(st.devQ ? { q: st.devQ } : {}));
    if (!alive()) return;
    body.innerHTML = `<form class="toolbar" id="df"><label class="visually-hidden" for="dq">Numer seryjny</label><input id="dq" name="q" class="select-sm" placeholder="Szukaj po numerze seryjnym, modelu, lokalizacji" value="${esc(st.devQ)}">
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button><button type="button" class="btn btn-primary btn-sm" id="d-new">Dodaj urządzenia</button></form>
      <section class="panel">${table(['Numer seryjny', 'Typ', 'Model', 'Budynek', 'Lokalizacja', 'Montaż', 'Status'], list.map(d => `<tr>
        <td class="mono-ink">${esc(d.serial_no)}</td><td>${esc(DEV[d.type])}</td><td>${esc(d.model || '–')}</td><td>${esc(d.building_name || '–')}</td><td>${esc(d.location || '–')}</td>
        <td class="small">${esc(d.installation_number || '–')}${d.installed_at ? '<div class="muted">' + esc(fd(d.installed_at)) + '</div>' : ''}</td>
        <td><label class="visually-hidden" for="ds-${d.id}">Status</label><select class="status-select" id="ds-${d.id}" data-dev="${d.id}">${Object.entries(DEV_ST).map(([k, v]) => `<option value="${k}"${k === d.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td></tr>`),
        st.devQ ? 'Brak urządzeń dla tego wyszukiwania.' : 'Brak urządzeń. Dodaj je przyciskiem „Dodaj urządzenia” (możesz wkleić listę numerów seryjnych).')}
        ${list.length === 500 ? '<p class="muted small">Pokazano 500 ostatnich – zawęź wyszukiwanie.</p>' : ''}</section>`;
    body.querySelector('#df').addEventListener('submit', e => { e.preventDefault(); st.devQ = val(e.target, 'q').trim(); reload(); });
    body.querySelector('#d-new').addEventListener('click', () => deviceForm(null, reload));
    body.querySelectorAll('[data-dev]').forEach(s => s.addEventListener('change', async () => { try { await api('d1/urzadzenia/' + s.dataset.dev, { status: s.value }, 'PATCH'); toast('Status urządzenia zmieniony.'); } catch (e) { toast(e.message); reload(); } }));
  }

  // ---------- harmonogram montaży ----------
  const matText = m => (m || []).map(x => `${x.nazwa}; ${x.ilosc}; ${x.jm}`).join('\n');
  const matParse = t => String(t || '').split('\n').map(l => l.split(';').map(s => s.trim())).filter(a => a[0]).map(([nazwa, ilosc, jm]) => ({ nazwa, ilosc: Number(ilosc || 1), jm: jm || 'szt.' }));
  async function installationForm(x, reload) {
    const [bs, crews, kt] = await Promise.all([api('d1/budynki'), api('d1/ekipy'), api('d1/kontrakty')]);
    const submit = async (f, allow) => {
      const d = { building_id: val(f, 'building_id'), crew_id: val(f, 'crew_id') || null, project_id: val(f, 'project_id') || null, planned_date: val(f, 'planned_date'), planned_end: val(f, 'planned_end') || null,
        scope: val(f, 'scope'), devices_planned: val(f, 'devices_planned'), materials: matParse(val(f, 'materials')), notes: val(f, 'notes'), allow_clash: allow };
      if (x) { delete d.building_id; delete d.allow_clash; await api('d1/montaze/' + x.id, d, 'PATCH'); } else await api('d1/montaze', d);
      toast(x ? 'Montaż zapisany.' : 'Montaż zaplanowany.'); reload();
    };
    modal(x ? 'Montaż ' + x.number : 'Zaplanuj montaż', `
      <div class="field-row">${field('i-b', 'Budynek', `<select id="i-b" name="building_id" ${x ? 'disabled' : 'required'}>${opts(bs, x && x.building_id, b => b.name + ', ' + b.address, b => b.id, '– wybierz –')}</select>`)}
        ${field('i-k', 'Kontrakt', `<select id="i-k" name="project_id">${opts(kt.filter(k => !['anulowany', 'rozliczony'].includes(k.status)), x && x.project_id, k => k.number + ' – ' + k.title, k => k.id, '– bez kontraktu –')}</select>`)}</div>
      <div class="field-row">${field('i-c', 'Ekipa', `<select id="i-c" name="crew_id">${opts(crews.filter(c => !c.virtual && c.is_active), x && x.crew_id, c => c.name + (c.leader ? ' (' + c.leader + ')' : ''), c => c.id, '– nieprzydzielona –')}</select>`)}
        ${field('i-d', 'Termin rozpoczęcia', `<input id="i-d" name="planned_date" type="date" required value="${esc(x ? x.planned_date : '')}">`)}${field('i-e', 'Termin zakończenia', `<input id="i-e" name="planned_end" type="date" value="${esc(x && x.planned_end ? x.planned_end : '')}">`)}</div>
      ${field('i-s', 'Zakres prac', `<textarea id="i-s" name="scope" rows="2">${esc(x ? x.scope : '')}</textarea>`)}
      <div class="field-row">${field('i-n', 'Liczba urządzeń do montażu', `<input id="i-n" name="devices_planned" type="number" min="0" value="${esc(x ? x.devices_planned : '')}">`)}</div>
      ${field('i-m', 'Lista materiałowa (jedna pozycja na linię: nazwa; ilość; jm)', `<textarea id="i-m" name="materials" rows="3" placeholder="Podzielnik elektroniczny; 48; szt.&#10;Plomba; 48; szt.">${esc(x ? matText(x.materials) : '')}</textarea>`)}
      ${field('i-notes', 'Uwagi', `<textarea id="i-notes" name="notes" rows="2">${esc(x ? x.notes : '')}</textarea>`)}`,
    { submit: x ? 'Zapisz' : 'Zaplanuj', wide: true, onSubmit: async f => {
      try { await submit(f, false); }
      catch (e) { if (/nakładanie/.test(e.message) && !x) { modal('Kolizja terminu ekipy', `<p>${esc(e.message)}</p>`, { submit: 'Zaplanuj mimo to', onSubmit: () => submit(f, true) }); return; } throw e; }
    } });
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
  async function harmonogram(body, reload, alive) {
    const from = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const list = await api('d1/montaze?od=' + from);
    if (!alive()) return;
    const byDate = {};
    for (const x of list) (byDate[x.planned_date] = byDate[x.planned_date] || []).push(x);
    const dayName = d => new Date(d + 'T12:00:00').toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="i-new">Zaplanuj montaż</button><span class="muted small">Od ${esc(fd(from))}. Kolizje terminów ekip są wykrywane automatycznie.</span></div>
      ${Object.keys(byDate).length ? Object.entries(byDate).map(([d, xs]) => `<section class="panel day${d === U().today() ? ' day-today' : ''}"><h2 class="panel-title">${esc(dayName(d))}${d === U().today() ? ' · dziś' : ''}</h2>
        <div class="task-list">${xs.map(x => `<div class="task"><div class="task-main"><button type="button" class="task-title linkish" data-ie="${x.id}">${esc(x.number)} · ${esc(x.building_name)}</button>
          <span class="muted small">${esc(x.address)}${x.city ? ', ' + esc(x.city) : ''} · ekipa: ${esc(x.crew_name || 'nieprzydzielona')} · urządzenia: ${esc(x.devices_installed)}/${esc(x.devices_planned)}${x.planned_end && x.planned_end !== x.planned_date ? ' · do ' + esc(fd(x.planned_end)) : ''}${x.project_number ? ' · ' + esc(x.project_number) : ''}</span></div>
          <div class="task-side">${x.status === 'odebrany' ? `${chip('odebrany', 'Odebrany')} ${B().pdfLink('/api/dokumenty/' + x.protocol_document_id + '/plik', 'Protokół PDF')}`
            : `<label class="visually-hidden" for="is-${x.id}">Status</label><select class="status-select st-${esc(x.status)}" id="is-${x.id}" data-is="${x.id}">${Object.entries(INST_ST).filter(([k]) => k !== 'odebrany').map(([k, v]) => `<option value="${k}"${k === x.status ? ' selected' : ''}>${v}</option>`).join('')}</select>
              ${x.status === 'wykonany' ? `<button type="button" class="btn btn-primary btn-sm" data-ip="${x.id}">Protokół odbioru</button>` : ''}`}</div></div>`).join('')}</div></section>`).join('')
      : '<section class="panel"><p class="empty-inline">Brak montaży w harmonogramie. Zaplanuj pierwszy montaż.</p></section>'}`;
    body.querySelector('#i-new').addEventListener('click', () => installationForm(null, reload));
    body.querySelectorAll('[data-ie]').forEach(b => b.addEventListener('click', async () => installationForm(await api('d1/montaze/' + b.dataset.ie), reload)));
    body.querySelectorAll('[data-is]').forEach(s => s.addEventListener('change', async () => { try { await api('d1/montaze/' + s.dataset.is, { status: s.value }, 'PATCH'); toast('Status montażu zmieniony.'); reload(); } catch (e) { toast(e.message); reload(); } }));
    body.querySelectorAll('[data-ip]').forEach(b => b.addEventListener('click', () => protocolForm(list.find(x => x.id === b.dataset.ip), reload)));
  }

  // ---------- ekipy ----------
  async function ekipy(body, reload, alive) {
    const crews = await api('d1/ekipy');
    if (!alive()) return;
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="c-new">Nowa ekipa</button><button type="button" class="btn btn-secondary" id="in-new">Dodaj instalatora</button></div>
      <div class="wf-grid">${crews.filter(c => !c.virtual || c.installers.length).map(c => `<section class="panel crew${c.is_active === false ? ' crew-off' : ''}">
        <div class="panel-head"><h2 class="panel-title">${esc(c.name)}</h2>${c.virtual ? '' : chip(c.is_active ? 'aktywny' : 'wylaczony', c.is_active ? 'Aktywna' : 'Nieaktywna')}</div>
        ${c.virtual ? '' : `<p class="small">${c.leader ? 'Brygadzista: <b>' + esc(c.leader) + '</b>' : 'Brak brygadzisty'}${c.phone ? ' · <span class="sel">' + esc(c.phone) + '</span>' : ''}</p><p class="muted small">Zaplanowane montaże: ${esc(c.upcoming)}</p>`}
        <ul class="mem-list">${c.installers.map(i => `<li><b>${esc(i.name)}</b>${i.phone ? ' · ' + esc(i.phone) : ''}${i.qualifications ? `<div class="muted small">${esc(i.qualifications)}</div>` : ''}${i.is_active ? '' : ' ' + chip('off', 'nieaktywny')}</li>`).join('') || '<li class="muted small">Brak instalatorów.</li>'}</ul>
        ${c.virtual ? '' : `<div class="ap-actions"><button type="button" class="btn btn-ghost btn-sm" data-ct="${c.id}">${c.is_active ? 'Dezaktywuj' : 'Aktywuj'}</button></div>`}</section>`).join('')}</div>
      ${crews.length <= 1 ? '<p class="empty-inline">Brak ekip. Dodaj pierwszą ekipę montażową.</p>' : ''}`;
    body.querySelector('#c-new').addEventListener('click', () => modal('Nowa ekipa', field('c-n', 'Nazwa', '<input id="c-n" name="name" required maxlength="100">') + `<div class="field-row">${field('c-l', 'Brygadzista', '<input id="c-l" name="leader" maxlength="100">')}${field('c-p', 'Telefon', '<input id="c-p" name="phone" maxlength="50">')}</div>`,
      { submit: 'Dodaj ekipę', onSubmit: async f => { await api('d1/ekipy', { name: val(f, 'name'), leader: val(f, 'leader'), phone: val(f, 'phone') }); toast('Ekipa dodana.'); reload(); } }));
    body.querySelector('#in-new').addEventListener('click', () => modal('Nowy instalator', `${field('n-n', 'Imię i nazwisko', '<input id="n-n" name="name" required maxlength="120">')}
      <div class="field-row">${field('n-c', 'Ekipa', `<select id="n-c" name="crew_id">${opts(crews.filter(c => !c.virtual), null, c => c.name, c => c.id, '– bez ekipy –')}</select>`)}${field('n-p', 'Telefon', '<input id="n-p" name="phone" maxlength="50">')}</div>
      ${field('n-q', 'Uprawnienia / kwalifikacje', '<input id="n-q" name="qualifications" maxlength="500" placeholder="np. SEP do 1 kV, praca na wysokości">')}`,
      { submit: 'Dodaj', onSubmit: async f => { await api('d1/instalatorzy', { name: val(f, 'name'), crew_id: val(f, 'crew_id') || null, phone: val(f, 'phone'), qualifications: val(f, 'qualifications') }); toast('Instalator dodany.'); reload(); } }));
    body.querySelectorAll('[data-ct]').forEach(b => b.addEventListener('click', async () => { const c = crews.find(x => x.id === b.dataset.ct); await api('d1/ekipy/' + c.id, { is_active: !c.is_active }, 'PATCH'); reload(); }));
  }

  // ---------- reklamacje ----------
  async function reklamacje(body, reload) { body.innerHTML = ''; await B().complaintsPanel(body, DEP, reload); }

  // ---------- rozliczenia kontraktów ----------
  async function rozliczenia(body, reload, alive) {
    const [kt, fin] = await Promise.all([api('d1/kontrakty'), api('finanse?dzial=' + DEP)]);
    if (!alive()) return;
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="k-new">Nowy kontrakt</button><button type="button" class="btn btn-secondary" id="f-new">Dodaj fakturę / koszt</button></div>
      <section class="panel"><h2 class="panel-title">Kontrakty</h2>${table(['Kontrakt', 'Klient', 'Status', { t: 'Wartość', num: 1 }, { t: 'Zafakturowano', num: 1 }, { t: 'Zapłacono', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, 'Montaże'], kt.map(k => `<tr>
        <td><b>${esc(k.number)}</b><div class="small">${esc(k.title)}</div></td><td>${esc(k.customer_name || '–')}</td>
        <td><label class="visually-hidden" for="ks-${k.id}">Status</label><select class="status-select" id="ks-${k.id}" data-ks="${k.id}">${Object.entries(KT_ST).map(([s, v]) => `<option value="${s}"${s === k.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="num">${esc(pln(k.value_net))}</td><td class="num">${esc(pln(k.zafakturowano))}${k.do_zafakturowania ? `<div class="small muted">zostało ${esc(pln(k.do_zafakturowania))}</div>` : ''}</td><td class="num">${esc(pln(k.zaplacono))}</td>
        <td class="num">${esc(pln(k.koszt))}</td><td class="num"><b>${esc(pln(k.marza))}</b></td><td class="num">${esc(k.installations_done)}/${esc(k.installations)}</td></tr>`), 'Brak kontraktów.')}</section>
      <section class="panel"><h2 class="panel-title">Faktury i koszty działu</h2><div id="fin-rows"></div></section>`;
    const fr = body.querySelector('#fin-rows'); fr.innerHTML = B().financeRows(fin, reload, fr);
    body.querySelector('#f-new').addEventListener('click', () => B().financeForm({ department_id: DEP }, reload));
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
    body.innerHTML = `<section class="panel"><h2 class="panel-title">Rentowność budynków</h2>
        <div class="hbars">${r.buildings.filter(b => b.przychod || b.koszt).map(b => `<div class="hb"><span class="hb-l">${esc(b.name)}</span><span class="hb-bar"><i class="${b.marza < 0 ? 'neg' : ''}" data-w="${Math.round(Math.abs(b.marza) / max * 100)}"></i></span><span class="hb-v">${esc(pln(b.marza))}</span></div>`).join('') || '<p class="empty-inline">Brak przychodów i kosztów przypisanych do budynków.</p>'}</div>
        ${table(['Budynek', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Marża %', num: 1 }], r.buildings.map(b => row(esc(b.name), esc(b.address), b)), '')}</section>
      <section class="panel"><h2 class="panel-title">Rentowność zleceń montażowych</h2>${table(['Zlecenie', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Marża %', num: 1 }], r.installations.map(i => row(esc(i.number), esc(i.building_name) + ' · ' + esc(fd(i.planned_date)), i)), 'Brak zleceń.')}</section>
      <section class="panel"><h2 class="panel-title">Rentowność kontraktów</h2>${table(['Kontrakt', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Marża %', num: 1 }], r.projects.map(k => row(esc(k.number), esc(k.title), k)), 'Brak kontraktów.')}</section>
      <p class="muted small">Przychody i koszty pochodzą z wpisów Finance Intelligence przypisanych do budynku, zlecenia lub kontraktu.</p>`;
  }

  // ---------- oferty (Handlowiec) ----------
  async function oferty(body, reload) { await B().offersPanel(body, DEP, reload); }

  window.MXT_MODULES.register(PATH, { title: 'Podzielniki i Montaże', perm: 'departments.view', render: page });
})();
