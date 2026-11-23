'use strict';
// ERP – Magazyn (wspólny): stany i pozycje, dokumenty PZ/WZ/RW/ZW/MM/INW, rezerwacje, dostawcy, magazyny.
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b), has = p => U().has(p);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => n == null ? '–' : U().money(n, 'PLN');
  const num = n => String(Math.round(Number(n || 0) * 1000) / 1000).replace('.', ',');
  const PATH = '/magazyn';
  const KIND = { material: 'Materiał', czesc: 'Część samochodowa', urzadzenie: 'Urządzenie', inne: 'Inne' };
  const DOC = { PZ: 'Przyjęcie (PZ)', WZ: 'Wydanie na zewnątrz (WZ)', RW: 'Wydanie na zlecenie (RW)', ZW: 'Zwrot ze zlecenia (ZW)', MM: 'Przesunięcie (MM)', INW: 'Inwentaryzacja (INW)' };
  const WK = { glowny: 'Główny', samochod: 'Samochód serwisowy', punkt: 'Punkt sprzedaży', inny: 'Inny' };
  const DEPT = { '': 'Wspólne', 'podzielniki-i-montaze': 'Ciepłomierze i podzielniki', 'sprzedaz-czesci-i-eksport': 'Sprzedaż części' };
  const VEH = { '': '–', osobowe: 'Osobowe', ciezarowe: 'Ciężarowe', uniwersalne: 'Uniwersalne' };
  const TABS = [['stany', 'Stany i pozycje', 'Magazyn', 'Stany'], ['dokumenty', 'Dokumenty', 'Magazyn'], ['dostawcy', 'Dostawcy', 'Zakupy'], ['magazyny', 'Magazyny', 'Ustawienia']];
  const td = (label, html, cls) => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;
  const ctable = (head, rows, empty) => rows.length ? `<div class="table-wrap"><table class="table table-cards"><thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.t || h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty-inline">${esc(empty)}</p>`;
  let tab = 'stany';
  const st = { q: '', rodzaj: '', dzial: '', ponizej: '', drodzaj: '' };

  async function page(root, path, alive) {
    const sp = new URLSearchParams(location.search);
    if (sp.get('tab') && TABS.some(t => t[0] === sp.get('tab'))) tab = sp.get('tab');
    const body = U().deptFrame(root, 'Magazyn', TABS, tab, t => { tab = t; reload(); });
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await ({ stany, dokumenty, dostawcy, magazyny }[tab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel); U().wsHoist(root);
    if (location.search) history.replaceState({}, '', location.pathname);
    if (sp.get('p')) itemCard(sp.get('p'), reload);
    api('magazyn/pozycje?ponizej=1').then(l => U().wsBadge(root, 'stany', l.length, 'warn')).catch(() => {});
  }

  // ---------- stany i pozycje ----------
  async function stany(body, reload, alive) {
    const q = new URLSearchParams(Object.entries({ q: st.q, rodzaj: st.rodzaj, dzial: st.dzial, ponizej: st.ponizej }).filter(([, v]) => v));
    const [items, whs] = await Promise.all([api('magazyn/pozycje?' + q), api('magazyn/magazyny')]);
    if (!alive()) return;
    const value = items.reduce((s, x) => s + x.stock_value, 0), low = items.filter(x => x.below_min).length;
    const manage = has('stock.manage'), purch = has('purchases.manage');
    body.innerHTML = `<p data-ws-sub>${items.length} pozycji · wartość zapasu ${esc(pln(value))}${low ? ` · ${low} poniżej minimum` : ''}</p>
      <div data-ws-actions hidden>${manage ? `<button type="button" class="btn btn-secondary" data-doc="PZ">Przyjęcie (PZ)</button><button type="button" class="btn btn-secondary" data-doc="RW">Wydanie (RW)</button>` : ''}
        ${manage || purch ? '<button type="button" class="btn btn-primary" id="it-new">Nowa pozycja</button>' : ''}</div>
      <form class="toolbar" id="sf"><label class="visually-hidden" for="sq">Szukaj</label><input id="sq" name="q" class="select-sm" placeholder="Indeks, nazwa, nr katalogowy, zamiennik, producent" value="${esc(st.q)}">
        <label class="visually-hidden" for="sk">Rodzaj</label><select id="sk" name="rodzaj" class="select-sm"><option value="">Każdy rodzaj</option>${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${st.rodzaj === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <label class="visually-hidden" for="sd">Dział</label><select id="sd" name="dzial" class="select-sm"><option value="">Wszystkie działy</option>${Object.entries(DEPT).filter(([k]) => k).map(([k, v]) => `<option value="${k}"${st.dzial === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <label class="toggle"><input type="checkbox" name="ponizej"${st.ponizej ? ' checked' : ''}> Poniżej minimum</label>
        <button type="submit" class="btn btn-secondary btn-sm">Filtruj</button></form>
      <section class="panel">${ctable(['Indeks', 'Nazwa', 'Rodzaj', { t: 'Stan', num: 1 }, { t: 'Zarezerw.', num: 1 }, { t: 'Wolne', num: 1 }, { t: 'Min.', num: 1 }, { t: 'Koszt śr.', num: 1 }, { t: 'Cena sprz.', num: 1 }, { t: 'Wartość', num: 1 }], items.map(x => `<tr class="${x.below_min ? 'row-deny' : ''}${x.is_active ? '' : ' row-off'}">
        ${td('Indeks', `<button type="button" class="linkish mono-ink" data-it="${esc(x.id)}">${esc(x.sku)}</button>`)}
        ${td('Nazwa', `${esc(x.name)}<div class="muted small">${esc([x.manufacturer, x.catalog_no, x.location].filter(Boolean).join(' · '))}</div>`)}
        ${td('Rodzaj', esc(KIND[x.kind]) + (x.department_id ? `<div class="muted small">${esc(DEPT[x.department_id])}</div>` : ''))}
        ${td('Stan', esc(num(x.qty)) + ' ' + esc(x.unit), 'num')}${td('Zarezerwowane', esc(num(x.reserved)), 'num')}${td('Wolne', `<b>${esc(num(x.free))}</b>${x.below_min ? ' ' + chip('warn', 'poniżej min.') : ''}`, 'num')}
        ${td('Minimum', esc(num(x.min_qty)), 'num')}${td('Koszt średni', esc(pln(x.avg_cost)), 'num')}${td('Cena sprzedaży', x.sale_price ? esc(pln(x.sale_price)) : '–', 'num')}${td('Wartość', esc(pln(x.stock_value)), 'num')}</tr>`),
      'Brak pozycji. Dodaj materiał lub część przyciskiem „Nowa pozycja”.')}</section>
      <p class="muted small">Wolne = stan − rezerwacje. Wycena wydań: średni ważony koszt zakupu (przeliczany przy każdym przyjęciu).</p>`;
    body.querySelector('#sf').addEventListener('submit', e => { e.preventDefault(); const f = e.target; st.q = val(f, 'q').trim(); st.rodzaj = val(f, 'rodzaj'); st.dzial = val(f, 'dzial'); st.ponizej = f.elements.ponizej.checked ? '1' : ''; reload(); });
    body.querySelectorAll('[data-it]').forEach(b => b.addEventListener('click', () => itemCard(b.dataset.it, reload)));
    const nb = body.querySelector('#it-new'); if (nb) nb.addEventListener('click', () => itemForm(null, reload));
    body.querySelectorAll('[data-doc]').forEach(b => b.addEventListener('click', () => docForm(b.dataset.doc, whs, reload)));
  }
  async function itemForm(it, after) {
    const sup = await api('magazyn/dostawcy').catch(() => []);
    const d = it || { kind: 'material', unit: 'szt.', department_id: '' };
    modal(it ? 'Pozycja ' + it.sku : 'Nowa pozycja magazynowa', `
      <div class="field-row">${field('if-s', 'Indeks (SKU)', `<input id="if-s" name="sku" required maxlength="60" value="${esc(d.sku || '')}" placeholder="np. PODZ-E-ITN40">`)}${field('if-k', 'Rodzaj', `<select id="if-k" name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${d.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${field('if-d', 'Dział', `<select id="if-d" name="dept">${Object.entries(DEPT).map(([k, v]) => `<option value="${k}"${(d.department_id || '') === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      ${field('if-n', 'Nazwa', `<input id="if-n" name="name" required maxlength="200" value="${esc(d.name || '')}">`)}
      <div class="field-row">${field('if-m', 'Producent', `<input id="if-m" name="manufacturer" maxlength="100" value="${esc(d.manufacturer || '')}">`)}${field('if-c', 'Numer katalogowy', `<input id="if-c" name="catalog_no" maxlength="60" value="${esc(d.catalog_no || '')}">`)}
        ${field('if-cat', 'Kategoria', `<input id="if-cat" name="category" maxlength="100" value="${esc(d.category || '')}" placeholder="np. hamulce, filtry, podzielniki">`)}</div>
      ${field('if-z', 'Numery zamienników (oddzielone przecinkiem)', `<input id="if-z" name="replacement_nos" maxlength="2000" value="${esc((d.replacement_nos || []).join(', '))}">`)}
      <div class="field-row">${field('if-u', 'J.m.', `<input id="if-u" name="unit" maxlength="10" value="${esc(d.unit || 'szt.')}">`)}${field('if-min', 'Stan minimalny', `<input id="if-min" name="min_qty" type="number" min="0" step="0.001" value="${esc(d.min_qty ?? 0)}">`)}
        ${field('if-l', 'Lokalizacja (regał, półka)', `<input id="if-l" name="location" maxlength="60" value="${esc(d.location || '')}">`)}${field('if-v', 'Pojazd', `<select id="if-v" name="vehicle_type">${Object.entries(VEH).map(([k, v]) => `<option value="${k}"${(d.vehicle_type || '') === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      <div class="field-row">${field('if-pp', 'Cena zakupu netto', `<input id="if-pp" name="purchase_price" type="number" min="0" step="0.01" value="${esc(d.purchase_price ?? 0)}">`)}${field('if-sp', 'Cena sprzedaży netto', `<input id="if-sp" name="sale_price" type="number" min="0" step="0.01" value="${esc(d.sale_price ?? 0)}">`)}
        ${field('if-sup', 'Dostawca', `<select id="if-sup" name="supplier_id"><option value="">– brak –</option>${sup.filter(s => s.is_active || s.id === d.supplier_id).map(s => `<option value="${esc(s.id)}"${s.id === d.supplier_id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`)}</div>
      <p class="muted small" id="if-mg"></p>
      ${field('if-o', 'Opis', `<textarea id="if-o" name="description" rows="2" maxlength="2000">${esc(d.description || '')}</textarea>`)}
      ${it ? `<label class="toggle"><input type="checkbox" name="active"${it.is_active ? ' checked' : ''}> Pozycja aktywna</label>` : ''}`,
    { submit: 'Zapisz', wide: true, onSubmit: async f => {
      const b = { sku: val(f, 'sku'), kind: val(f, 'kind'), department_id: val(f, 'dept') || null, name: val(f, 'name'), manufacturer: val(f, 'manufacturer'), catalog_no: val(f, 'catalog_no'),
        category: val(f, 'category'), replacement_nos: val(f, 'replacement_nos'), unit: val(f, 'unit'), min_qty: val(f, 'min_qty'), location: val(f, 'location'), vehicle_type: val(f, 'vehicle_type'),
        purchase_price: val(f, 'purchase_price'), sale_price: val(f, 'sale_price'), supplier_id: val(f, 'supplier_id') || null, description: val(f, 'description') };
      if (it) b.is_active = f.elements.active.checked;
      it ? await api('magazyn/pozycje/' + it.id, b, 'PATCH') : await api('magazyn/pozycje', b); toast('Pozycja zapisana.'); after();
    } });
    // Marża liczona na bieżąco (podgląd) – zapisane ceny przelicza serwer.
    const box = document.getElementById('modal-box'), mg = box.querySelector('#if-mg');
    const calc = () => { const p = Number(box.querySelector('#if-pp').value || 0), s = Number(box.querySelector('#if-sp').value || 0);
      mg.textContent = s > 0 ? `Marża: ${pln(s - p)} na sztuce (${String(Math.round((s - p) / s * 10000) / 100).replace('.', ',')}% ceny sprzedaży, narzut ${p > 0 ? String(Math.round((s - p) / p * 10000) / 100).replace('.', ',') + '%' : '–'}).` : ''; };
    box.querySelector('#if-pp').addEventListener('input', calc); box.querySelector('#if-sp').addEventListener('input', calc); calc();
  }
  async function itemCard(id, after) {
    const x = await api('magazyn/pozycje/' + id);
    const box = modal(`${x.sku} – ${x.name}`, `<p class="muted">${esc(KIND[x.kind])}${x.manufacturer ? ' · ' + esc(x.manufacturer) : ''}${x.catalog_no ? ' · nr kat. ' + esc(x.catalog_no) : ''}${x.replacement_nos.length ? ' · zamienniki: ' + esc(x.replacement_nos.join(', ')) : ''}${x.supplier_name ? ' · dostawca ' + esc(x.supplier_name) : ''}</p>
      <div class="kpis kpis-3"><div class="kpi kpi-neutral"><span class="kpi-v">${esc(num(x.qty))} ${esc(x.unit)}</span><span class="kpi-l">Stan (wolne ${esc(num(x.free))})</span></div>
        <div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(x.avg_cost))}</span><span class="kpi-l">Średni koszt · ostatni zakup ${esc(pln(x.purchase_price))}</span></div>
        <div class="kpi ${x.margin_pct != null && x.margin_pct < 0 ? 'kpi-danger' : 'kpi-neutral'}"><span class="kpi-v">${esc(pln(x.sale_price))}</span><span class="kpi-l">Cena sprzedaży${x.margin_pct != null ? ' · marża ' + esc(String(x.margin_pct).replace('.', ',')) + '%' : ''}</span></div></div>
      <h3 class="panel-sub">Stany w magazynach</h3>${ctable(['Magazyn', { t: 'Stan', num: 1 }, { t: 'Zarezerwowane', num: 1 }], x.levels.map(l => `<tr>${td('Magazyn', esc(l.code + ' – ' + l.warehouse_name))}${td('Stan', esc(num(l.qty)), 'num')}${td('Zarezerwowane', esc(num(l.reserved)), 'num')}</tr>`), 'Brak stanu.')}
      ${x.reservations.length ? `<h3 class="panel-sub">Rezerwacje</h3>${ctable(['Magazyn', { t: 'Ilość', num: 1 }, 'Dla', 'Od', ''], x.reservations.map(r => `<tr>${td('Magazyn', esc(r.warehouse))}${td('Ilość', esc(num(r.qty)), 'num')}${td('Dla', esc(r.related_type) + (r.note ? ' · ' + esc(r.note) : ''))}${td('Od', esc(fdt(r.created_at)))}
        ${td('', has('stock.manage') || has('parts.sell') ? `<button type="button" class="btn btn-ghost btn-sm" data-rel="${esc(r.id)}">Zwolnij</button>` : '', 'td-actions')}</tr>`), '')}` : ''}
      <h3 class="panel-sub">Ruchy magazynowe</h3>${ctable(['Dokument', 'Data', 'Magazyn', { t: 'Ilość', num: 1 }, { t: 'Koszt jedn.', num: 1 }, { t: 'Wartość', num: 1 }], x.moves.map(m => `<tr>${td('Dokument', `<button type="button" class="linkish" data-doc-o="${esc(m.doc_id)}">${esc(m.number)}</button>`)}${td('Data', esc(fd(m.doc_date)))}${td('Magazyn', esc(m.warehouse))}
        ${td('Ilość', `<b class="${Number(m.qty) < 0 ? 'txt-danger' : 'txt-ok'}">${Number(m.qty) > 0 ? '+' : ''}${esc(num(m.qty))}</b>`, 'num')}${td('Koszt jedn.', esc(pln(m.unit_cost)), 'num')}${td('Wartość', esc(pln(m.value)), 'num')}</tr>`), 'Brak ruchów.')}
      <div class="ap-actions">${has('stock.manage') || has('purchases.manage') ? '<button type="button" class="btn btn-secondary btn-sm" id="ic-edit">Edytuj pozycję</button>' : ''}${has('stock.manage') || has('parts.sell') ? '<button type="button" class="btn btn-secondary btn-sm" id="ic-res">Rezerwuj</button>' : ''}</div>`, { wide: true });
    const e = box.querySelector('#ic-edit'); if (e) e.addEventListener('click', () => itemForm(x, after));
    box.querySelectorAll('[data-doc-o]').forEach(b => b.addEventListener('click', () => docCard(b.dataset.docO)));
    box.querySelectorAll('[data-rel]').forEach(b => b.addEventListener('click', async () => { try { await api('magazyn/rezerwacje/' + b.dataset.rel + '/anuluj', {}); toast('Rezerwacja zwolniona.'); itemCard(id, after); } catch (er) { toast(er.message); } }));
    const r = box.querySelector('#ic-res');
    if (r) r.addEventListener('click', async () => {
      const whs = (await api('magazyn/magazyny')).filter(w => w.is_active);
      modal('Rezerwacja – ' + x.sku, `<div class="field-row">${field('rs-w', 'Magazyn', `<select id="rs-w" name="w">${whs.map(w => `<option value="${esc(w.id)}">${esc(w.code)}</option>`).join('')}</select>`)}${field('rs-q', 'Ilość', '<input id="rs-q" name="q" type="number" min="0.001" step="0.001" required>')}</div>
        ${field('rs-n', 'Dla kogo / czego', '<input id="rs-n" name="n" maxlength="300" placeholder="np. klient, numer zamówienia, montaż">')}`,
      { submit: 'Rezerwuj', onSubmit: async f => { await api('magazyn/rezerwacje', { item_id: x.id, warehouse_id: val(f, 'w'), qty: val(f, 'q'), related_type: 'inne', note: val(f, 'n') }); toast('Zarezerwowano.'); itemCard(id, after); } });
    });
  }

  // ---------- dokumenty ----------
  async function docForm(kind, whs, after) {
    const items = await api('magazyn/pozycje'), sup = kind === 'PZ' ? await api('magazyn/dostawcy').catch(() => []) : [];
    const act = (whs || await api('magazyn/magazyny')).filter(w => w.is_active);
    const orderSel = ['RW', 'ZW'].includes(kind) ? await api('d1/zlecenia?status=otwarte').then(d => d.rows.filter(o => o.type !== 'odczyt')).catch(() => []) : [];
    const line = i => `<div class="field-row is-line">${field('df-i' + i, i ? 'Pozycja ' + (i + 1) : 'Pozycja', `<select id="df-i${i}" name="item${i}"${i ? '' : ' required'}><option value="">– wybierz –</option>${items.map(x => `<option value="${esc(x.id)}">${esc(x.sku + ' · ' + x.name + ' (wolne ' + num(x.free) + ')')}</option>`).join('')}</select>`)}
      ${kind === 'INW' ? field('df-c' + i, 'Stan policzony', `<input id="df-c${i}" name="cnt${i}" type="number" min="0" step="0.001"${i ? '' : ' required'}>`) : field('df-q' + i, 'Ilość', `<input id="df-q${i}" name="qty${i}" type="number" min="0.001" step="0.001"${i ? '' : ' required'}>`)}
      ${kind === 'PZ' ? field('df-p' + i, 'Cena zakupu netto', `<input id="df-p${i}" name="price${i}" type="number" min="0" step="0.01"${i ? '' : ' required'}>`) : ''}
      ${kind === 'WZ' ? field('df-s' + i, 'Cena sprzedaży netto', `<input id="df-s${i}" name="sale${i}" type="number" min="0" step="0.01">`) : ''}</div>`;
    const due = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    modal(DOC[kind], `
      <div class="field-row">${field('df-w', kind === 'MM' ? 'Z magazynu' : 'Magazyn', `<select id="df-w" name="wh">${act.map(w => `<option value="${esc(w.id)}">${esc(w.code + ' – ' + w.name)}</option>`).join('')}</select>`)}
        ${kind === 'MM' ? field('df-t', 'Do magazynu', `<select id="df-t" name="to">${act.map((w, i) => `<option value="${esc(w.id)}"${i === 1 ? ' selected' : ''}>${esc(w.code + ' – ' + w.name)}</option>`).join('')}</select>`) : ''}
        ${kind === 'PZ' ? field('df-sup', 'Dostawca', `<select id="df-sup" name="sup"><option value="">– wybierz –</option>${sup.filter(s => s.is_active).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`) : ''}
        ${['RW', 'ZW'].includes(kind) ? field('df-o', 'Zlecenie', `<select id="df-o" name="ord" required><option value="">– wybierz –</option>${orderSel.map(o => `<option value="${o.type === 'montaz' ? 'installation' : 'service_order'}:${esc(o.id)}">${esc((o.type === 'montaz' ? 'Montaż ' : 'Serwis ') + o.number + ' – ' + (o.object_name || ''))}</option>`).join('')}</select>`) : ''}</div>
      ${kind === 'PZ' ? `<div class="field-row">${field('df-inv', 'Faktura dostawcy', '<input id="df-inv" name="inv" maxlength="60">')}${field('df-due', 'Termin płatności', `<input id="df-due" name="due" type="date" value="${due}">`)}</div>` : ''}
      ${[0, 1, 2, 3].map(line).join('')}
      ${field('df-n', 'Uwagi', '<input id="df-n" name="note" maxlength="1000">')}`,
    { submit: 'Zatwierdź dokument', wide: true, onSubmit: async f => {
      const lines = [0, 1, 2, 3].map(i => ({ item_id: val(f, 'item' + i), qty: val(f, 'qty' + i), counted: val(f, 'cnt' + i), unit_cost: val(f, 'price' + i), unit_price: val(f, 'sale' + i) || null }))
        .filter(l => l.item_id && (kind === 'INW' ? l.counted !== '' : l.qty));
      const b = { kind, warehouse_id: val(f, 'wh'), to_warehouse_id: val(f, 'to') || null, supplier_id: val(f, 'sup') || null, invoice_no: val(f, 'inv') || '', due_date: val(f, 'due') || null, note: val(f, 'note'), lines };
      if (['RW', 'ZW'].includes(kind)) [b.related_type, b.related_id] = val(f, 'ord').split(':');
      const d = await api('magazyn/dokumenty', b); toast(`Zatwierdzono ${d.number} (${pln(d.total_value)}).`); after();
    } });
  }
  async function docCard(id) {
    const d = await api('magazyn/dokumenty/' + id);
    modal(`${d.number} – ${DOC[d.kind]}`, `<p class="muted">${esc(fd(d.doc_date))} · magazyn ${esc(d.warehouse)}${d.to_warehouse ? ' → ' + esc(d.to_warehouse) : ''}${d.supplier_name ? ' · dostawca ' + esc(d.supplier_name) : ''}${d.invoice_no ? ' · faktura ' + esc(d.invoice_no) : ''}${d.project_number ? ' · projekt ' + esc(d.project_number) : ''} · ${esc(d.created_by_login || '')}</p>
      ${ctable(['Indeks', 'Nazwa', 'Magazyn', { t: 'Ilość', num: 1 }, { t: 'Koszt jedn.', num: 1 }, { t: 'Wartość', num: 1 }], d.moves.map(m => `<tr>${td('Indeks', esc(m.sku))}${td('Nazwa', esc(m.name))}${td('Magazyn', esc(m.warehouse))}${td('Ilość', esc(num(m.qty)) + ' ' + esc(m.unit), 'num')}${td('Koszt jedn.', esc(pln(m.unit_cost)), 'num')}${td('Wartość', esc(pln(m.value)), 'num')}</tr>`), '')}
      <p><b>Wartość dokumentu: ${esc(pln(d.total_value))}</b></p>${d.note ? `<p class="muted">${esc(d.note)}</p>` : ''}`, { wide: true });
  }
  async function dokumenty(body, reload, alive) {
    const [list, whs] = await Promise.all([api('magazyn/dokumenty' + (st.drodzaj ? '?rodzaj=' + st.drodzaj : '')), api('magazyn/magazyny')]);
    if (!alive()) return;
    const manage = has('stock.manage');
    body.innerHTML = `<p data-ws-sub>Ostatnie ${list.length} dokumentów magazynowych</p>
      <div data-ws-actions hidden>${manage ? Object.keys(DOC).map(k => `<button type="button" class="btn btn-secondary btn-sm" data-doc="${k}">${k}</button>`).join('') : has('service.manage') ? '<button type="button" class="btn btn-secondary btn-sm" data-doc="RW">RW</button><button type="button" class="btn btn-secondary btn-sm" data-doc="ZW">ZW</button>' : ''}</div>
      <div class="toolbar"><label class="visually-hidden" for="dk">Rodzaj</label><select id="dk" class="select-sm"><option value="">Wszystkie rodzaje</option>${Object.entries(DOC).map(([k, v]) => `<option value="${k}"${st.drodzaj === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      <section class="panel">${ctable(['Numer', 'Data', 'Magazyn', 'Dotyczy', { t: 'Pozycje', num: 1 }, { t: 'Wartość', num: 1 }, 'Wystawił'], list.map(d => `<tr>
        ${td('Numer', `<button type="button" class="linkish" data-o="${esc(d.id)}">${esc(d.number)}</button>`)}${td('Data', esc(fd(d.doc_date)))}${td('Magazyn', esc(d.warehouse) + (d.to_warehouse ? ' → ' + esc(d.to_warehouse) : ''))}
        ${td('Dotyczy', esc(d.supplier_name || d.customer_name || d.project_number || (d.related_type ? d.related_type : '–')) + (d.invoice_no ? `<div class="muted small">FV ${esc(d.invoice_no)}${d.kind === 'PZ' ? (d.paid_at ? ' · zapłacona' : d.due_date ? ' · termin ' + esc(fd(d.due_date)) : '') : ''}</div>` : ''))}
        ${td('Pozycje', esc(d.lines), 'num')}${td('Wartość', esc(pln(d.total_value)), 'num')}${td('Wystawił', esc(d.created_by_login || '–'))}</tr>`), 'Brak dokumentów.')}</section>`;
    body.querySelector('#dk').addEventListener('change', e => { st.drodzaj = e.target.value; reload(); });
    body.querySelectorAll('[data-o]').forEach(b => b.addEventListener('click', () => docCard(b.dataset.o)));
    body.querySelectorAll('[data-doc]').forEach(b => b.addEventListener('click', () => docForm(b.dataset.doc, whs, reload)));
  }

  // ---------- dostawcy ----------
  async function dostawcy(body, reload, alive) {
    const list = await api('magazyn/dostawcy');
    if (!alive()) return;
    const can = has('purchases.manage');
    body.innerHTML = `<p data-ws-sub>${list.filter(s => s.is_active).length} aktywnych dostawców</p>
      <div data-ws-actions hidden>${can ? '<button type="button" class="btn btn-primary" id="su-new">Nowy dostawca</button>' : ''}</div>
      <section class="panel">${ctable(['Dostawca', 'Kontakt', { t: 'Termin płatności', num: 1 }, { t: 'Pozycje', num: 1 }, { t: 'Nieopłacone PZ', num: 1 }], list.map(s => `<tr class="${s.is_active ? '' : 'row-off'}">
        ${td('Dostawca', `${can ? `<button type="button" class="linkish" data-s="${esc(s.id)}">${esc(s.name)}</button>` : esc(s.name)}<div class="muted small">${esc(s.tax_id ? 'NIP ' + s.tax_id : '')}</div>`)}
        ${td('Kontakt', esc([s.contact, s.phone, s.email].filter(Boolean).join(' · ') || '–'))}${td('Termin płatności', esc(s.payment_days) + ' dni', 'num')}${td('Pozycje', esc(s.items), 'num')}${td('Nieopłacone', s.unpaid ? `<b class="txt-warn">${esc(pln(s.unpaid))}</b>` : '–', 'num')}</tr>`), 'Brak dostawców.')}</section>`;
    const form = s => modal(s ? 'Dostawca ' + s.name : 'Nowy dostawca', `${field('su-n', 'Nazwa', `<input id="su-n" name="name" required maxlength="200" value="${esc(s ? s.name : '')}">`)}
      <div class="field-row">${field('su-t', 'NIP', `<input id="su-t" name="tax_id" maxlength="30" value="${esc(s ? s.tax_id : '')}">`)}${field('su-d', 'Termin płatności (dni)', `<input id="su-d" name="payment_days" type="number" min="0" max="365" value="${esc(s ? s.payment_days : 14)}">`)}</div>
      <div class="field-row">${field('su-c', 'Osoba kontaktowa', `<input id="su-c" name="contact" maxlength="200" value="${esc(s ? s.contact : '')}">`)}${field('su-p', 'Telefon', `<input id="su-p" name="phone" maxlength="50" value="${esc(s ? s.phone : '')}">`)}${field('su-e', 'E-mail', `<input id="su-e" name="email" maxlength="200" value="${esc(s ? s.email : '')}">`)}</div>
      ${field('su-a', 'Adres', `<input id="su-a" name="address" maxlength="300" value="${esc(s ? s.address : '')}">`)}${field('su-x', 'Uwagi', `<textarea id="su-x" name="notes" rows="2">${esc(s ? s.notes : '')}</textarea>`)}
      ${s ? `<label class="toggle"><input type="checkbox" name="active"${s.is_active ? ' checked' : ''}> Aktywny</label>` : ''}`,
    { submit: 'Zapisz', onSubmit: async f => {
      const b = { name: val(f, 'name'), tax_id: val(f, 'tax_id'), payment_days: val(f, 'payment_days'), contact: val(f, 'contact'), phone: val(f, 'phone'), email: val(f, 'email'), address: val(f, 'address'), notes: val(f, 'notes') };
      if (s) { b.is_active = f.elements.active.checked; await api('magazyn/dostawcy/' + s.id, b, 'PATCH'); } else await api('magazyn/dostawcy', b);
      toast('Dostawca zapisany.'); reload();
    } });
    const nb = body.querySelector('#su-new'); if (nb) nb.addEventListener('click', () => form(null));
    body.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => form(list.find(s => s.id === b.dataset.s))));
  }

  // ---------- magazyny ----------
  async function magazyny(body, reload, alive) {
    const list = await api('magazyn/magazyny');
    if (!alive()) return;
    const can = has('stock.manage');
    body.innerHTML = `<p data-ws-sub>${list.length} magazynów · wartość zapasów ${esc(pln(list.reduce((s, w) => s + w.value, 0)))}</p>
      <div data-ws-actions hidden>${can ? '<button type="button" class="btn btn-primary" id="w-new">Nowy magazyn</button>' : ''}</div>
      <section class="panel">${ctable(['Kod', 'Nazwa', 'Rodzaj', { t: 'Wartość zapasu', num: 1 }, ''], list.map(w => `<tr class="${w.is_active ? '' : 'row-off'}">${td('Kod', `<b>${esc(w.code)}</b>`)}${td('Nazwa', esc(w.name))}${td('Rodzaj', esc(WK[w.kind]))}${td('Wartość', esc(pln(w.value)), 'num')}
        ${td('', can && w.code !== 'MAG' ? `<button type="button" class="btn btn-ghost btn-sm" data-w="${esc(w.id)}">${w.is_active ? 'Wyłącz' : 'Włącz'}</button>` : '', 'td-actions')}</tr>`), 'Brak magazynów.')}</section>
      <p class="muted small">Samochód serwisowy jako magazyn: przesunięcie (MM) z magazynu głównego, wydanie na zlecenie (RW) z samochodu.</p>`;
    const nb = body.querySelector('#w-new');
    if (nb) nb.addEventListener('click', () => modal('Nowy magazyn', `<div class="field-row">${field('w-c', 'Kod', '<input id="w-c" name="code" required maxlength="12" placeholder="np. AUTO1">')}${field('w-k', 'Rodzaj', `<select id="w-k" name="kind">${Object.entries(WK).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`)}</div>
      ${field('w-n', 'Nazwa', '<input id="w-n" name="name" required maxlength="100" placeholder="np. Samochód serwisowy – Ekipa 1">')}`,
    { submit: 'Dodaj', onSubmit: async f => { await api('magazyn/magazyny', { code: val(f, 'code'), name: val(f, 'name'), kind: val(f, 'kind') }); toast('Magazyn dodany.'); reload(); } }));
    body.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', async () => { const w = list.find(x => x.id === b.dataset.w); try { await api('magazyn/magazyny/' + w.id, { is_active: !w.is_active }, 'PATCH'); reload(); } catch (e) { toast(e.message); } }));
  }

  window.MXT_MAGAZYN = { itemCard, docForm, itemForm };
  window.MXT_MODULES.register(PATH, { title: 'Magazyn', perm: 'stock.view', render: page, ws: true }, { menu: true });
})();
