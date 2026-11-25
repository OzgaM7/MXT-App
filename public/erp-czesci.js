'use strict';
// ERP – Sprzedaż części samochodowych: zamówienia (rezerwacja, wydanie, faktura, zapłata, zwroty, reklamacje), produkty i ceny,
// analityka sprzedaży; zamówienia zakupu do dostawców (zakładka w module Magazyn).
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b), has = p => U().has(p);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => n == null ? '–' : U().money(n, 'PLN');
  const num = n => String(Math.round(Number(n || 0) * 1000) / 1000).replace('.', ',');
  const pct = v => v == null ? '–' : String(v).replace('.', ',') + '%';
  const DEP = 'sprzedaz-czesci-i-eksport';
  const OST = { nowe: 'Nowe', potwierdzone: 'Zarezerwowane', wydane: 'Wydane', zafakturowane: 'Zafakturowane', anulowane: 'Anulowane' };
  const OST_CLS = { nowe: 'warn', potwierdzone: 'w_toku', wydane: 'zatwierdzona', zafakturowane: 'ok', anulowane: 'off' };
  const PST = { szkic: 'Szkic', zamowione: 'Zamówione', czesciowo: 'Przyjęte częściowo', przyjete: 'Przyjęte', anulowane: 'Anulowane' };
  const PST_CLS = { szkic: 'off', zamowione: 'w_toku', czesciowo: 'warn', przyjete: 'ok', anulowane: 'off' };
  const VEH = { '': '–', osobowe: 'Osobowe', ciezarowe: 'Ciężarowe', uniwersalne: 'Uniwersalne' };
  const td = (label, html, cls) => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;
  const ctable = (head, rows, empty) => rows.length ? `<div class="table-wrap"><table class="table table-cards"><thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.t || h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty-inline">${esc(empty)}</p>`;
  const today = () => U().today();
  const st = { q: '', status: '', naleznosci: '', limit: '' }, pr = { q: '' }, an = { od: '', do: '' }, po = { limit: '' };

  // ======================= zamówienia =======================
  async function zamowienia(body, reload, alive) {
    const q = new URLSearchParams(Object.entries(st).filter(([, v]) => v));
    const list = await api('czesci/zamowienia?' + q);
    if (!alive()) return;
    const open = list.filter(o => o.status === 'zafakturowane' && !o.paid_at);
    body.innerHTML = `<p data-ws-sub>${list.length} zamówień${open.length ? ` · nieopłacone: ${open.length} na ${esc(pln(open.reduce((s, o) => s + o.total_net, 0)))}` : ''}</p>
      <div data-ws-actions hidden><button type="button" class="btn btn-primary ws-fab" id="zo-new">${U().icon('plus')}Nowe zamówienie</button></div>
      <form class="toolbar" id="zf"><label class="visually-hidden" for="zq">Szukaj</label><input id="zq" name="q" class="select-sm" placeholder="Numer, klient, pojazd, faktura" value="${esc(st.q)}">
        <label class="visually-hidden" for="zs">Status</label><select id="zs" name="status" class="select-sm"><option value="">Każdy status</option>${Object.entries(OST).map(([k, v]) => `<option value="${k}"${st.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <label class="toggle"><input type="checkbox" name="naleznosci"${st.naleznosci ? ' checked' : ''}> Tylko nieopłacone</label><button type="submit" class="btn btn-secondary btn-sm">Szukaj</button></form>
      <section class="panel">${ctable(['Zamówienie', 'Klient', 'Pojazd', { t: 'Wartość', num: 1 }, 'Status', 'Faktura'], list.map(o => `<tr class="${o.overdue ? 'row-deny' : ''}">
        ${td('Zamówienie', `<button type="button" class="linkish" data-o="${esc(o.id)}">${esc(o.number)}</button><div class="muted small">${esc(fd(o.order_date))} · ${o.lines} poz.</div>`)}
        ${td('Klient', esc(o.customer_name))}${td('Pojazd', esc(o.vehicle || '–'))}${td('Wartość', esc(pln(o.total_net)), 'num')}${td('Status', chip(OST_CLS[o.status], o.status === 'zafakturowane' && o.paid_at ? 'Zapłacone' : OST[o.status]))}
        ${td('Faktura', o.invoice_no ? `${esc(o.invoice_no)}<div class="small ${o.overdue ? 'txt-danger' : 'muted'}">${o.paid_at ? 'zapłacona ' + esc(fd(o.paid_at)) : 'termin ' + esc(fd(o.due_date))}</div>` : '–')}</tr>`),
      'Brak zamówień. Dodaj zamówienie przyciskiem „Nowe zamówienie”.')}</section>`;
    body.querySelector('#zf').addEventListener('submit', e => { e.preventDefault(); const f = e.target; st.q = val(f, 'q').trim(); st.status = val(f, 'status'); st.naleznosci = f.elements.naleznosci.checked ? '1' : ''; st.limit = ''; reload(); });
    U().moreBar(body, list, n => { st.limit = n; reload(); });
    body.querySelector('#zo-new').addEventListener('click', () => orderForm(null, reload));
    body.querySelectorAll('[data-o]').forEach(b => b.addEventListener('click', () => orderCard(b.dataset.o, reload)));
  }
  async function orderForm(o, after) {
    const items = (await api('magazyn/pozycje?dzial=' + DEP)).filter(i => i.kind === 'czesc' || i.department_id === DEP);
    const N = 8, line = (i, l) => `<div class="field-row is-line">${field('ol-i' + i, i ? 'Pozycja ' + (i + 1) : 'Część', `<select id="ol-i${i}" name="item${i}" data-line="${i}"${i ? '' : ' required'}><option value="">– wybierz –</option>${items.map(x => `<option value="${esc(x.id)}" data-price="${x.sale_price}"${l && l.item_id === x.id ? ' selected' : ''}>${esc(x.sku + ' · ' + x.name + ' (wolne ' + num(x.free) + ')')}</option>`).join('')}</select>`)}
      ${field('ol-q' + i, 'Ilość', `<input id="ol-q${i}" name="qty${i}" type="number" min="0.001" step="1" inputmode="decimal" value="${l ? l.qty : ''}">`)}
      ${field('ol-p' + i, 'Cena netto', `<input id="ol-p${i}" name="price${i}" type="number" min="0" step="0.01" inputmode="decimal" value="${l ? l.unit_price : ''}">`)}
      ${field('ol-d' + i, 'Rabat %', `<input id="ol-d${i}" name="disc${i}" type="number" min="0" max="100" step="0.5" value="${l ? l.discount_pct : 0}">`)}</div>`;
    modal(o ? 'Edytuj zamówienie ' + o.number : 'Nowe zamówienie części', `
      ${o ? `<p><b>${esc(o.customer_name)}</b></p>` : `${field('oc-q', 'Klient – szukaj (nazwa, telefon, NIP)', '<input id="oc-q" autocomplete="off" placeholder="np. warsztat, 600 100 200">')}<div class="pf-res" id="oc-res"></div><input type="hidden" name="customer_id">`}
      ${field('oc-v', 'Pojazd (marka, model, VIN)', `<input id="oc-v" name="vehicle" maxlength="300" value="${esc(o ? o.vehicle : '')}">`)}
      ${Array.from({ length: N }, (_, i) => line(i, o && o.lines[i])).join('')}
      <p class="oc-total">Razem netto: <b id="oc-sum">–</b></p>
      ${field('oc-n', 'Uwagi', `<input id="oc-n" name="note" maxlength="2000" value="${esc(o ? o.note : '')}">`)}`,
    { submit: o ? 'Zapisz zamówienie' : 'Utwórz zamówienie', wide: true, onSubmit: async f => {
      const lines = Array.from({ length: N }, (_, i) => ({ item_id: val(f, 'item' + i), qty: val(f, 'qty' + i), unit_price: val(f, 'price' + i), discount_pct: val(f, 'disc' + i) || 0 })).filter(l => l.item_id && l.qty);
      if (o) await api('czesci/zamowienia/' + o.id, { lines, vehicle: val(f, 'vehicle'), note: val(f, 'note') }, 'PUT');
      else {
        if (!val(f, 'customer_id')) throw new Error('Wybierz klienta z kartoteki (lub dodaj go w CRM).');
        const x = await api('czesci/zamowienia', { customer_id: val(f, 'customer_id'), lines, vehicle: val(f, 'vehicle'), note: val(f, 'note') });
        toast(`Zamówienie ${x.number}: ${pln(x.total_net)}.`);
      }
      after();
    } });
    const box = document.getElementById('modal-box'), $ = s => box.querySelector(s);
    const sum = () => { let t = 0; for (let i = 0; i < N; i++) { const q = Number($('#ol-q' + i).value || 0), p = Number($('#ol-p' + i).value || 0), d = Number($('#ol-d' + i).value || 0); t += Math.round(q * p * (100 - d)) / 100; } $('#oc-sum').textContent = pln(t); };
    for (let i = 0; i < N; i++) {
      $('#ol-i' + i).addEventListener('change', e => { const opt = e.target.selectedOptions[0]; if (opt && opt.dataset.price && !$('#ol-p' + i).value) $('#ol-p' + i).value = opt.dataset.price; if (!$('#ol-q' + i).value && e.target.value) $('#ol-q' + i).value = 1; sum(); });
      ['#ol-q', '#ol-p', '#ol-d'].forEach(s => $(s + i).addEventListener('input', sum));
    }
    sum();
    if (!o) {
      const hid = box.querySelector('[name="customer_id"]'), res = $('#oc-res'); let t = null;
      $('#oc-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
        const q = $('#oc-q').value.trim(); if (q.length < 2) { res.innerHTML = ''; return; }
        const list = await api('klienci?q=' + encodeURIComponent(q)).catch(() => []);
        res.innerHTML = list.slice(0, 8).map(c => `<button type="button" class="pop-i" data-cid="${esc(c.id)}" data-cname="${esc(c.name)}">${esc(c.name)}<span class="muted small"> ${esc([c.phone, c.tax_id].filter(Boolean).join(' · '))}</span></button>`).join('') || '<p class="muted small">Brak klienta – dodaj go w CRM.</p>';
        res.querySelectorAll('[data-cid]').forEach(b => b.addEventListener('click', () => { hid.value = b.dataset.cid; $('#oc-q').value = b.dataset.cname; res.innerHTML = `<p class="small txt-ok">Wybrano: <b>${esc(b.dataset.cname)}</b></p>`; }));
      }, 200); });
    }
  }
  async function orderCard(id, after) {
    const o = await api('czesci/zamowienia/' + id);
    const refresh = () => { orderCard(id, after); if (after) after(); };
    const act = (cls, key, label) => `<button type="button" class="btn ${cls} btn-sm" data-a="${key}">${esc(label)}</button>`;
    const box = modal(`Zamówienie ${o.number}`, `<p class="muted">${esc(o.customer_name)} · ${esc(fd(o.order_date))} · magazyn ${esc(o.warehouse)}${o.vehicle ? ' · ' + esc(o.vehicle) : ''} · ${chip(OST_CLS[o.status], o.status === 'zafakturowane' && o.paid_at ? 'Zapłacone' : OST[o.status])}</p>
      ${ctable(['Część', { t: 'Ilość', num: 1 }, { t: 'Cena netto', num: 1 }, { t: 'Rabat', num: 1 }, { t: 'Wartość', num: 1 }, { t: 'Koszt', num: 1 }, { t: 'Zwrócono', num: 1 }], o.lines.map(l => `<tr>
        ${td('Część', `${esc(l.sku)} · ${esc(l.name)}<div class="muted small">${esc([l.manufacturer, l.catalog_no].filter(Boolean).join(' · '))}</div>`)}${td('Ilość', esc(num(l.qty)) + ' ' + esc(l.unit), 'num')}
        ${td('Cena', esc(pln(l.unit_price)), 'num')}${td('Rabat', esc(pct(l.discount_pct)), 'num')}${td('Wartość', esc(pln(l.line_net)), 'num')}${td('Koszt', l.unit_cost != null ? esc(pln(l.unit_cost * l.qty)) : '–', 'num')}${td('Zwrócono', l.returned_qty ? esc(num(l.returned_qty)) : '–', 'num')}</tr>`), '')}
      <div class="kpis kpis-3"><div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(o.total_net))}</span><span class="kpi-l">Wartość netto</span></div>
        <div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(o.total_cost))}</span><span class="kpi-l">Koszt sprzedanych części</span></div>
        <div class="kpi ${o.margin != null && o.margin < 0 ? 'kpi-danger' : 'kpi-ok'}"><span class="kpi-v">${o.margin != null ? esc(pln(o.margin)) : '–'}</span><span class="kpi-l">Marża${o.margin != null && o.total_net > 0 ? ' ' + esc(pct(Math.round(o.margin / o.total_net * 10000) / 100)) : ''}</span></div></div>
      ${o.invoice_no ? `<p>Faktura <b>${esc(o.invoice_no)}</b> z ${esc(fd(o.invoice_date))}, termin ${esc(fd(o.due_date))} · ${o.paid_at ? 'zapłacona ' + esc(fd(o.paid_at)) : '<b class="txt-warn">nieopłacona</b>'}</p>` : ''}
      <div class="ap-actions">${o.status === 'nowe' ? act('btn-primary', 'confirm', 'Potwierdź i zarezerwuj') + act('btn-secondary', 'edit', 'Edytuj') : ''}
        ${o.status === 'potwierdzone' ? act('btn-primary', 'issue', 'Wydaj towar (WZ)') : ''}${o.status === 'wydane' ? act('btn-primary', 'invoice', 'Wystaw fakturę') : ''}
        ${o.status === 'zafakturowane' && !o.paid_at ? act('btn-primary', 'paid', 'Zapłacono') : ''}${['wydane', 'zafakturowane'].includes(o.status) ? act('btn-secondary', 'return', 'Zwrot') + act('btn-secondary', 'complaint', 'Reklamacja') : ''}
        ${['nowe', 'potwierdzone'].includes(o.status) ? act('btn-ghost', 'cancel', 'Anuluj zamówienie') : ''}</div>
      ${o.returns.length ? `<h3 class="panel-sub">Zwroty</h3><ul class="tool-list">${o.returns.map(x => `<li><b>${esc(x.number)}</b> · ${esc(fd(x.return_date))} · ${x.restock ? 'na stan' : 'wadliwe (bez zwrotu na stan)'} · korekta ${esc(pln(x.refund_net))} · ${esc(x.reason)}</li>`).join('')}</ul>` : ''}
      ${o.complaints.length ? `<h3 class="panel-sub">Reklamacje</h3><ul class="tool-list">${o.complaints.map(x => `<li><b>${esc(x.number)}</b> · ${esc(x.title)} · ${esc(x.status)}</li>`).join('')}</ul>` : ''}`, { wide: true });
    const run = async (fn, msg) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast(e.message); } };
    const on = (k, fn) => { const b = box.querySelector(`[data-a="${k}"]`); if (b) b.addEventListener('click', fn); };
    on('confirm', () => run(() => api('czesci/zamowienia/' + id + '/potwierdz', {}), 'Zamówienie potwierdzone – towar zarezerwowany.'));
    on('edit', () => orderForm(o, refresh));
    on('issue', () => run(() => api('czesci/zamowienia/' + id + '/wydaj', {}), 'Towar wydany (WZ).'));
    on('paid', () => modal('Zapłata – ' + o.number, field('pd-d', 'Data zapłaty', `<input id="pd-d" name="d" type="date" value="${today()}">`), { submit: 'Zapisz zapłatę', onSubmit: async f => { await api('czesci/zamowienia/' + id + '/zaplata', { paid_at: val(f, 'd') }); toast('Zapłata zapisana.'); refresh(); } }));
    on('invoice', () => modal('Faktura – ' + o.number, `<div class="field-row">${field('iv-n', 'Numer faktury', '<input id="iv-n" name="n" required maxlength="60">')}${field('iv-d', 'Data', `<input id="iv-d" name="d" type="date" value="${today()}">`)}
      ${field('iv-t', 'Termin płatności', `<input id="iv-t" name="t" type="date" value="${U().dayPlus(14)}">`)}</div><p class="muted small">Kwota ${esc(pln(o.total_net))} trafi do przychodów działu i należności klienta.</p>`,
    { submit: 'Zapisz fakturę', onSubmit: async f => { await api('czesci/zamowienia/' + id + '/faktura', { invoice_no: val(f, 'n'), invoice_date: val(f, 'd'), due_date: val(f, 't') }); toast('Faktura zapisana.'); refresh(); } }));
    on('cancel', () => modal('Anulować zamówienie?', field('cn-r', 'Powód', '<input id="cn-r" name="r" required maxlength="500">'), { submit: 'Anuluj zamówienie', danger: true, onSubmit: async f => { await api('czesci/zamowienia/' + id + '/anuluj', { powod: val(f, 'r') }); toast('Zamówienie anulowane, rezerwacje zwolnione.'); refresh(); } }));
    on('complaint', () => modal('Reklamacja – ' + o.number, `${field('cp-t', 'Tytuł', '<input id="cp-t" name="t" required maxlength="200">')}${field('cp-d', 'Opis', '<textarea id="cp-d" name="d" rows="3"></textarea>')}`,
      { submit: 'Zgłoś reklamację', onSubmit: async f => { const x = await api('czesci/zamowienia/' + id + '/reklamacja', { title: val(f, 't'), description: val(f, 'd') }); toast('Reklamacja ' + x.number + ' zapisana.'); refresh(); } }));
    on('return', () => modal('Zwrot – ' + o.number, `${o.lines.filter(l => l.qty > l.returned_qty).map(l => field('rt-' + l.id, `${l.sku} · ${l.name} (można zwrócić ${num(l.qty - l.returned_qty)})`, `<input id="rt-${esc(l.id)}" name="q:${esc(l.id)}" type="number" min="0" max="${l.qty - l.returned_qty}" step="1" value="0">`)).join('')}
      ${field('rt-r', 'Powód zwrotu', '<input id="rt-r" name="r" required maxlength="1000">')}<label class="toggle"><input type="checkbox" name="stock" checked> Towar sprawny – wraca na stan</label>
      <p class="muted small">Po fakturze zwrot tworzy korektę sprzedaży (koszt „zwroty sprzedaży”). Sprawny towar wraca na magazyn po koszcie średnim.</p>`,
    { submit: 'Przyjmij zwrot', onSubmit: async f => {
      const lines = o.lines.map(l => ({ line_id: l.id, qty: f.elements['q:' + l.id] ? f.elements['q:' + l.id].value : 0 })).filter(l => Number(l.qty) > 0);
      const x = await api('czesci/zamowienia/' + id + '/zwrot', { powod: val(f, 'r'), na_stan: f.elements.stock.checked, lines }); toast(`Zwrot ${x.number}: korekta ${pln(x.refund_net)}.`); refresh();
    } }));
  }

  // ======================= produkty i ceny =======================
  async function produkty(body, reload, alive) {
    const list = await api('magazyn/pozycje?dzial=' + DEP + (pr.q ? '&q=' + encodeURIComponent(pr.q) : ''));
    if (!alive()) return;
    const parts = list.filter(i => i.kind === 'czesc' || i.department_id === DEP);
    body.innerHTML = `<p data-ws-sub>${parts.length} produktów · wartość zapasu ${esc(pln(parts.reduce((s, i) => s + i.stock_value, 0)))}</p>
      <div data-ws-actions hidden>${has('stock.manage') || has('purchases.manage') ? '<button type="button" class="btn btn-primary" id="pr-new">Nowy produkt</button>' : ''}</div>
      <form class="toolbar" id="prf"><label class="visually-hidden" for="prq">Szukaj</label><input id="prq" name="q" class="select-sm" placeholder="Indeks, nazwa, numer katalogowy, numer zamiennika, producent" value="${esc(pr.q)}"><button type="submit" class="btn btn-secondary btn-sm">Szukaj</button></form>
      <section class="panel">${ctable(['Produkt', 'Zamienniki', 'Pojazd', { t: 'Wolne', num: 1 }, { t: 'Cena zakupu', num: 1 }, { t: 'Cena sprzedaży', num: 1 }, { t: 'Marża', num: 1 }, 'Dostawca'], parts.map(i => `<tr class="${i.below_min ? 'row-deny' : ''}">
        ${td('Produkt', `<button type="button" class="linkish" data-it="${esc(i.id)}">${esc(i.sku)}</button> ${esc(i.name)}<div class="muted small">${esc([i.manufacturer, i.catalog_no && 'nr kat. ' + i.catalog_no, i.location].filter(Boolean).join(' · '))}</div>`)}
        ${td('Zamienniki', esc((i.replacement_nos || []).join(', ') || '–'))}${td('Pojazd', esc(VEH[i.vehicle_type || '']))}${td('Wolne', `${esc(num(i.free))} ${esc(i.unit)}${i.below_min ? ' ' + chip('warn', 'poniżej min.') : ''}`, 'num')}
        ${td('Cena zakupu', esc(pln(i.purchase_price)), 'num')}${td('Cena sprzedaży', esc(pln(i.sale_price)), 'num')}${td('Marża', `<b class="${i.margin_pct < 0 ? 'txt-danger' : ''}">${esc(pct(i.margin_pct))}</b>`, 'num')}${td('Dostawca', esc(i.supplier_name || '–'))}</tr>`),
      'Brak produktów. Dodaj część przyciskiem „Nowy produkt”.')}</section>`;
    body.querySelector('#prf').addEventListener('submit', e => { e.preventDefault(); pr.q = val(e.target, 'q').trim(); reload(); });
    const n = body.querySelector('#pr-new'); if (n) n.addEventListener('click', () => window.MXT_MAGAZYN.itemForm(null, reload));
    body.querySelectorAll('[data-it]').forEach(b => b.addEventListener('click', () => window.MXT_MAGAZYN.itemCard(b.dataset.it, reload)));
  }

  // ======================= analityka =======================
  async function analityka(body, reload, alive) {
    const d = await api('czesci/analityka?' + new URLSearchParams(Object.entries(an).filter(([, v]) => v)));
    if (!alive()) return;
    const tile = (l, v, f) => `<div class="hk"><span class="hk-l">${esc(l)}</span><span class="hk-v">${esc(v)}</span>${f ? `<span class="hk-f">${esc(f)}</span>` : ''}</div>`;
    body.innerHTML = `<p data-ws-sub>Sprzedaż zafakturowana ${esc(fd(d.od))} – ${d.do.startsWith('2999') ? 'dziś' : esc(fd(d.do))}</p>
      <form class="toolbar per-bar" id="anf"><span class="per-f"><label class="small muted" for="an-od">Od</label><input id="an-od" name="od" type="date" class="select-sm" value="${esc(an.od || d.od)}"></span><span class="per-f"><label class="small muted" for="an-do">do</label><input id="an-do" name="do" type="date" class="select-sm" value="${esc(an.do)}"></span>
        <button type="submit" class="btn btn-secondary btn-sm">Pokaż</button></form>
      <section class="fin-kpis">${tile('Przychody', pln(d.przychod), d.zwroty ? 'po korektach zwrotów ' + pln(d.zwroty) : `${d.zamowienia} zamówień`)}${tile('Koszt zakupu', pln(d.koszt), 'sprzedanych części')}
        ${tile('Marża', pln(d.marza), pct(d.marza_pct))}${tile('Należności', pln(d.naleznosci.s), `${d.naleznosci.n} faktur${d.naleznosci.po_terminie ? ' · po terminie ' + pln(d.naleznosci.s_po_terminie) : ''}`)}</section>
      <div class="pu-grid"><section class="panel"><h2 class="panel-title">Najlepiej sprzedające się produkty</h2>${ctable(['Produkt', { t: 'Ilość', num: 1 }, { t: 'Przychód', num: 1 }, { t: 'Marża', num: 1 }], d.top.map(t => `<tr>${td('Produkt', esc(t.sku + ' · ' + t.name))}${td('Ilość', esc(num(t.qty)), 'num')}${td('Przychód', esc(pln(t.przychod)), 'num')}${td('Marża', `${esc(pln(t.marza))} <span class="muted small">${esc(pct(t.marza_pct))}</span>`, 'num')}</tr>`), 'Brak sprzedaży w okresie.')}</section>
        <section class="panel"><h2 class="panel-title">Zalegające produkty (bez sprzedaży ${d.slow_days} dni)</h2>${ctable(['Produkt', { t: 'Stan', num: 1 }, { t: 'Wartość', num: 1 }, 'Ostatnie wydanie'], d.slow.map(s => `<tr>${td('Produkt', esc(s.sku + ' · ' + s.name))}${td('Stan', esc(num(s.qty)), 'num')}${td('Wartość', esc(pln(s.value)), 'num')}${td('Ostatnie wydanie', s.last_out ? esc(fd(s.last_out)) : 'nigdy')}</tr>`), 'Brak zalegających produktów.')}</section></div>
      <div class="pu-grid"><section class="panel"><h2 class="panel-title">Miesiące</h2>${ctable(['Miesiąc', { t: 'Zamówienia', num: 1 }, { t: 'Przychód', num: 1 }, { t: 'Koszt', num: 1 }, { t: 'Marża', num: 1 }], d.months.map(m => `<tr>${td('Miesiąc', esc(m.m))}${td('Zamówienia', esc(m.n), 'num')}${td('Przychód', esc(pln(m.przychod)), 'num')}${td('Koszt', esc(pln(m.koszt)), 'num')}${td('Marża', esc(pln(m.przychod - m.koszt)), 'num')}</tr>`), 'Brak danych.')}</section>
        <section class="panel"><h2 class="panel-title">Najwięksi klienci</h2>${ctable(['Klient', { t: 'Zamówienia', num: 1 }, { t: 'Przychód', num: 1 }, { t: 'Marża', num: 1 }], d.customers.map(c => `<tr>${td('Klient', esc(c.name))}${td('Zamówienia', esc(c.n), 'num')}${td('Przychód', esc(pln(c.przychod)), 'num')}${td('Marża', esc(pln(c.marza)), 'num')}</tr>`), 'Brak danych.')}</section></div>`;
    body.querySelector('#anf').addEventListener('submit', e => { e.preventDefault(); an.od = val(e.target, 'od'); an.do = val(e.target, 'do'); reload(); });
  }

  // ======================= zamówienia zakupu (moduł Magazyn) =======================
  async function zakupy(body, reload, alive) {
    const list = await api('zakupy' + (po.limit ? '?limit=' + po.limit : ''));
    if (!alive()) return;
    const can = has('purchases.manage');
    body.innerHTML = `<p data-ws-sub>${list.filter(o => ['szkic', 'zamowione', 'czesciowo'].includes(o.status)).length} otwartych zamówień do dostawców</p>
      <div data-ws-actions hidden>${can ? '<button type="button" class="btn btn-secondary" id="po-prop">Propozycje z minimów</button><button type="button" class="btn btn-primary" id="po-new">Nowe zamówienie</button>' : ''}</div>
      <section class="panel">${ctable(['Zamówienie', 'Dostawca', 'Magazyn', { t: 'Wartość', num: 1 }, 'Dostawa', 'Status'], list.map(o => `<tr class="${o.late ? 'row-deny' : ''}">
        ${td('Zamówienie', `<button type="button" class="linkish" data-po="${esc(o.id)}">${esc(o.number)}</button><div class="muted small">${esc(fd(o.order_date))} · ${o.lines} poz.</div>`)}
        ${td('Dostawca', esc(o.supplier_name))}${td('Magazyn', esc(o.warehouse))}${td('Wartość', esc(pln(o.total_net)), 'num')}${td('Dostawa', o.expected_date ? esc(fd(o.expected_date)) + (o.late ? ' <b class="txt-danger small">spóźniona</b>' : '') : '–')}${td('Status', chip(PST_CLS[o.status], PST[o.status]))}</tr>`),
      'Brak zamówień zakupu.')}</section>`;
    const n = body.querySelector('#po-new'); if (n) n.addEventListener('click', () => poForm(reload));
    const p = body.querySelector('#po-prop'); if (p) p.addEventListener('click', async () => { try { const r = await api('zakupy/propozycje', {}); toast(r.created.length ? 'Utworzono szkice: ' + r.created.join(', ') : 'Brak pozycji poniżej minimum z przypisanym dostawcą.'); reload(); } catch (e) { toast(e.message); } });
    body.querySelectorAll('[data-po]').forEach(b => b.addEventListener('click', () => poCard(b.dataset.po, reload)));
    U().moreBar(body, list, n => { po.limit = n; reload(); });
  }
  // Nowe zamówienie albo edycja szkicu (dostawca bez zmian – zmiana dostawcy = nowe zamówienie).
  async function poForm(after, o) {
    const [sup, items] = await Promise.all([api('magazyn/dostawcy'), api('magazyn/pozycje')]);
    const n = Math.max(6, o ? o.lines.length + 2 : 0), idx = [...Array(n).keys()], L = i => (o && o.lines[i]) || {};
    const line = i => `<div class="field-row is-line">${field('pl-i' + i, i ? 'Pozycja ' + (i + 1) : 'Pozycja', `<select id="pl-i${i}" name="item${i}"${i ? '' : ' required'}><option value="">– wybierz –</option>${items.map(x => `<option value="${esc(x.id)}" data-price="${x.purchase_price}"${L(i).item_id === x.id ? ' selected' : ''}>${esc(x.sku + ' · ' + x.name + ' (stan ' + num(x.qty) + ')')}</option>`).join('')}</select>`)}
      ${field('pl-q' + i, 'Ilość', `<input id="pl-q${i}" name="qty${i}" type="number" min="0.001" step="0.001" value="${esc(L(i).qty ?? '')}">`)}${field('pl-p' + i, 'Cena zakupu netto', `<input id="pl-p${i}" name="price${i}" type="number" min="0" step="0.01" value="${esc(L(i).unit_price ?? '')}">`)}</div>`;
    modal(o ? 'Edytuj szkic ' + o.number : 'Nowe zamówienie do dostawcy', `<div class="field-row">${o ? field('po-s', 'Dostawca', `<input id="po-s" value="${esc(o.supplier_name)}" disabled>`)
      : field('po-s', 'Dostawca', `<select id="po-s" name="sup" required><option value="">– wybierz –</option>${sup.filter(s => s.is_active).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`)}
      ${field('po-e', 'Planowana dostawa', `<input id="po-e" name="exp" type="date" value="${esc(o && o.expected_date ? String(o.expected_date).slice(0, 10) : '')}">`)}</div>${idx.map(line).join('')}${field('po-n', 'Uwagi', `<input id="po-n" name="note" maxlength="1000" value="${esc(o ? o.note || '' : '')}">`)}
      ${o ? '<p class="muted small">Pozycję usuwasz, wybierając „– wybierz –”. Zmiana dostawcy: anuluj szkic i utwórz nowe zamówienie.</p>' : ''}`,
    { submit: o ? 'Zapisz zmiany' : 'Zapisz szkic', wide: true, onSubmit: async f => {
      const lines = idx.map(i => ({ item_id: val(f, 'item' + i), qty: val(f, 'qty' + i), unit_price: val(f, 'price' + i) })).filter(l => l.item_id && l.qty);
      if (o) { await api('zakupy/' + o.id, { expected_date: val(f, 'exp') || null, note: val(f, 'note'), lines }, 'PUT'); toast('Szkic ' + o.number + ' zapisany.'); }
      else { const x = await api('zakupy', { supplier_id: val(f, 'sup'), expected_date: val(f, 'exp') || null, note: val(f, 'note'), lines }); toast('Szkic ' + x.number + ' zapisany.'); }
      after();
    } });
    const box = document.getElementById('modal-box');
    for (const i of idx) box.querySelector('#pl-i' + i).addEventListener('change', e => { const op = e.target.selectedOptions[0]; const p = box.querySelector('#pl-p' + i); if (op && op.dataset.price && !p.value) p.value = op.dataset.price; });
  }
  async function poCard(id, after) {
    const o = await api('zakupy/' + id);
    const refresh = () => { poCard(id, after); if (after) after(); };
    const box = modal(`Zamówienie zakupu ${o.number}`, `<p class="muted">${esc(o.supplier_name)} · magazyn ${esc(o.warehouse)} · ${chip(PST_CLS[o.status], PST[o.status])}${o.expected_date ? ' · dostawa ' + esc(fd(o.expected_date)) : ''}</p>
      ${ctable(['Pozycja', { t: 'Zamówiono', num: 1 }, { t: 'Przyjęto', num: 1 }, { t: 'Cena', num: 1 }, { t: 'Wartość', num: 1 }], o.lines.map(l => `<tr>${td('Pozycja', esc(l.sku + ' · ' + l.name))}${td('Zamówiono', esc(num(l.qty)) + ' ' + esc(l.unit), 'num')}${td('Przyjęto', esc(num(l.received_qty)), 'num')}${td('Cena', esc(pln(l.unit_price)), 'num')}${td('Wartość', esc(pln(l.qty * l.unit_price)), 'num')}</tr>`), '')}
      ${o.receipts.length ? `<h3 class="panel-sub">Przyjęcia (PZ)</h3><ul class="tool-list">${o.receipts.map(x => `<li><b>${esc(x.number)}</b> · ${esc(fd(x.doc_date))} · ${esc(pln(x.total_value))}${x.invoice_no ? ' · FV ' + esc(x.invoice_no) : ''} · ${x.paid_at ? 'zapłacona' : 'do zapłaty'}</li>`).join('')}</ul>` : ''}
      ${o.note ? `<p class="muted">${esc(o.note)}</p>` : ''}
      <div class="ap-actions">${o.status === 'szkic' && has('purchases.manage') ? '<button type="button" class="btn btn-primary btn-sm" data-a="order">Wyślij do dostawcy</button><button type="button" class="btn btn-secondary btn-sm" data-a="edit">Edytuj szkic</button>' : ''}
        ${['zamowione', 'czesciowo'].includes(o.status) && has('stock.manage') ? '<button type="button" class="btn btn-primary btn-sm" data-a="receive">Przyjmij dostawę</button>' : ''}
        ${['szkic', 'zamowione'].includes(o.status) && has('purchases.manage') ? '<button type="button" class="btn btn-ghost btn-sm" data-a="cancel">Anuluj</button>' : ''}</div>`, { wide: true });
    const on = (k, fn) => { const b = box.querySelector(`[data-a="${k}"]`); if (b) b.addEventListener('click', fn); };
    on('order', async () => { try { await api('zakupy/' + id + '/zamow', {}); toast('Zamówienie wysłane do dostawcy (status „zamówione”).'); refresh(); } catch (e) { toast(e.message); } });
    on('cancel', async () => { try { await api('zakupy/' + id + '/anuluj', {}); toast('Zamówienie anulowane.'); refresh(); } catch (e) { toast(e.message); } });
    on('edit', () => poForm(refresh, o));
    on('receive', () => modal('Przyjęcie dostawy – ' + o.number, `${o.lines.filter(l => l.qty > l.received_qty).map(l => field('rc-' + l.id, `${l.sku} · ${l.name} (zostało ${num(l.qty - l.received_qty)} ${l.unit})`, `<input id="rc-${esc(l.id)}" name="q:${esc(l.id)}" type="number" min="0" step="0.001" value="${l.qty - l.received_qty}">`)).join('')}
      <div class="field-row">${field('rc-f', 'Faktura dostawcy', '<input id="rc-f" name="inv" maxlength="60">')}${field('rc-d', 'Termin płatności', '<input id="rc-d" name="due" type="date">')}</div>
      <p class="muted small">Powstaje dokument PZ (stan i średni koszt) oraz zobowiązanie wobec dostawcy (termin domyślnie z warunków dostawcy).</p>`,
    { submit: 'Przyjmij (PZ)', onSubmit: async f => {
      const lines = o.lines.map(l => ({ line_id: l.id, qty: f.elements['q:' + l.id] ? f.elements['q:' + l.id].value : 0 })).filter(l => Number(l.qty) > 0);
      const r = await api('zakupy/' + id + '/przyjmij', { lines, invoice_no: val(f, 'inv'), due_date: val(f, 'due') || null }); toast(`Przyjęto ${r.doc.number} (${pln(r.doc.total_value)}).`); refresh();
    } }));
  }

  window.MXT_CZESCI = { zamowienia, produkty, analityka, zakupy, orderCard, poCard };
})();
