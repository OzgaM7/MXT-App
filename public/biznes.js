'use strict';
// Etap 3 – wspólne moduły: CRM, Finance Intelligence, Knowledge Base oraz komponenty używane w działach
// (oferty, reklamacje, wybór klienta, agenci działu).
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b);
  const fdt = v => U().fdt(v), fd = v => U().fd(v), money = (a, c) => U().money(a, c), has = p => U().has(p);
  const field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => money(n, 'PLN');
  const KIND = { osoba_prywatna: 'Osoba prywatna', firma: 'Firma', wspolnota: 'Wspólnota mieszkaniowa', spoldzielnia: 'Spółdzielnia', zarzadca: 'Zarządca nieruchomości', klient_zagraniczny: 'Klient zagraniczny', inny: 'Inny' };
  const DEP = { 'podzielniki-i-montaze': 'Ciepłomierze i podzielniki', 'sprzedaz-czesci-i-eksport': 'Sprzedaż części samochodowych', ubezpieczenia: 'Ubezpieczenia' };
  const SRV_ST = { nowe: 'Nowe', oczekuje: 'Do przydzielenia', przypisane: 'Przydzielone', zaplanowane: 'Zaplanowane', w_realizacji: 'W realizacji', ponowna_wizyta: 'Ponowna wizyta',
    wykonane: 'Wykonane', zatwierdzone: 'Zatwierdzone', rozliczone: 'Rozliczone', zamkniete: 'Zamknięte', anulowane: 'Anulowane' };
  const INST_LBL = { zaplanowany: 'Zaplanowany', w_toku: 'W toku', wykonany: 'Wykonany', odebrany: 'Odebrany', anulowany: 'Anulowany' };
  const OFFER_ST = { szkic: 'Szkic', do_akceptacji: 'Czeka na akceptację', wyslana: 'Wysłana', przyjeta: 'Przyjęta przez klienta', odrzucona: 'Odrzucona przez klienta', anulowana: 'Anulowana' };
  const CPL_ST = { zgloszona: 'Zgłoszona', w_analizie: 'W analizie', w_naprawie: 'W naprawie', rozwiazana: 'Rozwiązana', odrzucona: 'Odrzucona' };
  const CHAN = { email: 'E-mail', telefon: 'Telefon', spotkanie: 'Spotkanie', notatka: 'Notatka', system: 'System' };
  const opts = (list, sel, label = x => x.name, value = x => x.id, empty) => (empty ? `<option value="">${esc(empty)}</option>` : '') + list.map(x => `<option value="${esc(value(x))}"${String(value(x)) === String(sel || '') ? ' selected' : ''}>${esc(label(x))}</option>`).join('');
  const fileToB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
  const pdfLink = (href, label = 'PDF') => `<a class="btn btn-ghost btn-sm" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  const table = (head, rows, empty) => rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.t || h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty-inline">${esc(empty)}</p>`;
  const linesToContacts = t => String(t || '').split('\n').map(l => l.split(';').map(x => x.trim())).filter(a => a[0]).map(([imie, funkcja, email, telefon]) => ({ imie, funkcja, email, telefon }));

  // ---------- CRM ----------
  async function customerForm(c, after, defaults = {}) {
    const d = c || defaults;
    modal(c ? 'Edytuj klienta' : 'Nowy klient', `
      <div class="field-row">${field('c-kind', 'Rodzaj', `<select id="c-kind" name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${(d.kind || 'firma') === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${field('c-country', 'Kraj (kod)', `<input id="c-country" name="country" maxlength="2" value="${esc(d.country || 'PL')}">`)}</div>
      ${field('c-name', 'Nazwa', `<input id="c-name" name="name" required maxlength="200" value="${esc(d.name || '')}">`)}
      <div class="field-row">${field('c-tax', 'NIP / VAT ID', `<input id="c-tax" name="tax_id" maxlength="30" value="${esc(d.tax_id || '')}">`)}
        ${field('c-lang', 'Język korespondencji', `<select id="c-lang" name="language">${['pl', 'en', 'de', 'fr', 'es', 'it', 'cs', 'uk', 'lt'].map(l => `<option${(d.language || 'pl') === l ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}</div>
      ${field('c-addr', 'Adres', `<input id="c-addr" name="address" maxlength="400" value="${esc(d.address || '')}">`)}
      <div class="field-row">${field('c-email', 'E-mail', `<input id="c-email" name="email" type="email" maxlength="200" value="${esc(d.email || '')}">`)}
        ${field('c-phone', 'Telefon', `<input id="c-phone" name="phone" maxlength="50" value="${esc(d.phone || '')}">`)}</div>
      ${field('c-contacts', 'Osoby kontaktowe (jedna na linię: imię i nazwisko; funkcja; e-mail; telefon)', `<textarea id="c-contacts" name="contacts" rows="3">${esc((d.contacts || []).map(x => [x.imie, x.funkcja, x.email, x.telefon].join('; ')).join('\n'))}</textarea>`)}
      <fieldset class="checks"><legend class="flabel">Działy współpracy</legend>${Object.entries(DEP).map(([k, v]) => `<label class="toggle"><input type="checkbox" name="dep" value="${k}"${(d.departments || []).includes(k) ? ' checked' : ''}> <span>${v}</span></label>`).join('')}</fieldset>
      ${field('c-notes', 'Notatki', `<textarea id="c-notes" name="notes" rows="2">${esc(d.notes || '')}</textarea>`)}`,
    { submit: c ? 'Zapisz' : 'Dodaj klienta', wide: true, onSubmit: async f => {
      const b = { kind: val(f, 'kind'), name: val(f, 'name'), country: val(f, 'country'), tax_id: val(f, 'tax_id'), language: val(f, 'language'), address: val(f, 'address'),
        email: val(f, 'email'), phone: val(f, 'phone'), notes: val(f, 'notes'), contacts: linesToContacts(val(f, 'contacts')), departments: [...f.querySelectorAll('[name=dep]:checked')].map(x => x.value) };
      const r = c ? await api('klienci/' + c.id, b, 'PATCH') : await api('klienci', b);
      toast(c ? 'Klient zapisany.' : 'Klient dodany do CRM.'); if (after) after(r);
    } });
  }
  async function customerCard(id, after) {
    const c = await api('klienci/' + id);
    const sec = (t, html) => `<h3 class="panel-sub">${esc(t)}</h3>${html}`;
    const box = modal(c.name, `<p class="muted">${esc(KIND[c.kind])} · ${esc(c.country)}${c.tax_id ? ' · NIP/VAT ' + esc(c.tax_id) : ''}${c.address ? ' · ' + esc(c.address) : ''}</p>
      <p class="small">${c.email ? 'E-mail: <span class="sel">' + esc(c.email) + '</span> ' : ''}${c.phone ? ' · Telefon: <span class="sel">' + esc(c.phone) + '</span>' : ''}</p>
      ${c.contacts.length ? sec('Osoby kontaktowe', `<ul class="tool-list">${c.contacts.map(x => `<li><b>${esc(x.imie)}</b>${x.funkcja ? ' – ' + esc(x.funkcja) : ''}${x.email ? ' · ' + esc(x.email) : ''}${x.telefon ? ' · ' + esc(x.telefon) : ''}</li>`).join('')}</ul>`) : ''}
      <div class="kpis kpis-3"><div class="kpi kpi-blue"><span class="kpi-v">${esc(pln(c.finance.przychod))}</span><span class="kpi-l">Przychody</span></div>
        <div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(c.finance.przychod - c.finance.koszt))}</span><span class="kpi-l">Marża</span></div>
        <div class="kpi ${c.finance.nieoplacone ? 'kpi-warn' : 'kpi-neutral'}"><span class="kpi-v">${esc(pln(c.finance.nieoplacone))}</span><span class="kpi-l">Nieopłacone faktury</span></div></div>
      ${c.buildings.length ? sec('Budynki', table(['Budynek', 'Adres', { t: 'Lokale', num: 1 }], c.buildings.map(b => `<tr><td>${esc(b.name)}</td><td>${esc(b.address)}${b.city ? ', ' + esc(b.city) : ''}</td><td class="num">${esc(b.units_count)}</td></tr>`), '')) : ''}
      ${c.projects.length ? sec('Kontrakty', table(['Numer', 'Nazwa', 'Status', { t: 'Wartość', num: 1 }], c.projects.map(p => `<tr><td>${esc(p.number)}</td><td>${esc(p.title)}</td><td>${esc(p.status)}</td><td class="num">${esc(money(p.value_net, p.currency))}</td></tr>`), '')) : ''}
      ${sec('Oferty', table(['Numer', 'Temat', 'Status', { t: 'Kwota', num: 1 }], c.offers.map(o => `<tr><td>${esc(o.number)} <span class="muted small">v${esc(o.version)}</span></td><td>${esc(o.title)}</td><td>${chip(o.status, OFFER_ST[o.status])}</td><td class="num">${esc(money(o.total, o.currency))}</td></tr>`), 'Brak ofert.'))}
      ${c.sales.length ? sec('Sprzedaż', table(['Numer', 'Data', { t: 'Kwota', num: 1 }, 'Status'], c.sales.map(x => `<tr><td>${esc(x.number)}</td><td>${esc(fd(x.sale_date))}</td><td class="num">${esc(money(x.total, x.currency))}</td><td>${esc(x.status)}</td></tr>`), '')) : ''}
      ${c.complaints.length ? sec('Reklamacje', table(['Numer', 'Tytuł', 'Status', 'Zgłoszono'], c.complaints.map(x => `<tr><td>${esc(x.number)}</td><td>${esc(x.title)}</td><td>${chip(x.status, CPL_ST[x.status])}</td><td>${esc(fd(x.reported_at))}</td></tr>`), '')) : ''}
      ${(c.service_orders || []).length ? sec('Zlecenia serwisowe', table(['Numer', 'Przyjęte', 'Status', 'Opis'], c.service_orders.map(o => `<tr><td><button type="button" class="linkish" data-goto="/dzial/podzielniki-i-montaze?tab=serwisy&z=${esc(o.id)}">${esc(o.number)}</button></td>
        <td>${esc(fd(o.received_at))}</td><td>${chip(o.status, SRV_ST[o.status] || o.status)}</td><td class="small">${esc(String(o.description || '').slice(0, 140))}</td></tr>`), '')) : ''}
      ${(c.installations || []).length ? sec('Montaże', table(['Numer', 'Budynek', 'Termin', 'Status'], c.installations.map(x => `<tr><td><button type="button" class="linkish" data-goto="/dzial/podzielniki-i-montaze?tab=harmonogram&m=${esc(x.id)}">${esc(x.number)}</button></td>
        <td>${esc(x.building_name)}</td><td>${esc(fd(x.planned_date))}${x.planned_end && x.planned_end !== x.planned_date ? ' – ' + esc(fd(x.planned_end)) : ''}</td><td>${chip(x.status, INST_LBL[x.status] || x.status)}</td></tr>`), '')) : ''}
      ${(c.reading_schedules || []).length ? sec('Odczyty', table(['Budynek', 'Zakres', 'Ostatni', 'Kolejny'], c.reading_schedules.map(s => `<tr><td><button type="button" class="linkish" data-goto="/odczyty?z=${esc(s.id)}">${esc(s.building_name)}</button>${s.is_active ? '' : ' ' + chip('off', 'nieaktywny')}</td>
        <td>${esc(s.scope)}</td><td>${esc(fd(s.last_done))}</td><td>${esc(fd(s.next_due))}</td></tr>`), '')) : ''}
      ${(c.documents || []).length ? sec('Dokumenty', `<ul class="tool-list">${c.documents.map(d => `<li>${pdfLink('/api/dokumenty/' + d.id + '/plik', d.title)} <span class="muted small">${esc(fdt(d.created_at))}</span></li>`).join('')}</ul>`) : ''}
      ${(c.policies || []).length ? sec('Polisy', table(['Numer', 'Towarzystwo', 'Rodzaj', 'Ochrona do', { t: 'Kwota polisy', num: 1 }, { t: 'Zysk', num: 1 }, 'Status'], c.policies.map(p => `<tr><td><button type="button" class="linkish" data-goto="/dzial/ubezpieczenia?tab=polisy&p=${esc(p.id)}">${esc(p.number)}</button></td>
        <td>${esc(p.insurer)}</td><td>${esc(p.insurance_type)}</td><td>${esc(fd(p.end_date))}</td><td class="num">${esc(pln(p.total_amount))}</td><td class="num">${esc(pln(p.profit))}</td><td>${chip(p.status, p.status_label || p.status)}</td></tr>`), '')) : ''}
      ${(c.part_orders || []).length ? sec('Zamówienia części', table(['Numer', 'Data', 'Status', { t: 'Wartość', num: 1 }], c.part_orders.map(o => `<tr><td><button type="button" class="linkish" data-goto="/dzial/sprzedaz-czesci-i-eksport?tab=zamowienia&o=${esc(o.id)}">${esc(o.number)}</button></td>
        <td>${esc(fd(o.order_date))}</td><td>${chip(o.status, o.status_label || o.status)}</td><td class="num">${esc(pln(o.total_net))}</td></tr>`), '')) : ''}
      ${sec('Historia kontaktów', `<button type="button" class="btn btn-secondary btn-sm" id="cc-note">Dodaj wpis</button>` + (c.communications.length ? `<ol class="comm">${c.communications.map(m => `<li><b>${esc(CHAN[m.channel])}${m.direction !== 'wewnetrzna' ? ' · ' + (m.direction === 'wychodzaca' ? 'wychodząca' : 'przychodząca') : ''}</b> · ${esc(fdt(m.created_at))}${m.created_by_login ? ' · ' + esc(m.created_by_login) : ''}<div><b>${esc(m.subject)}</b></div>${m.body ? `<div class="muted small pre-wrap">${esc(m.body)}</div>` : ''}</li>`).join('')}</ol>` : '<p class="empty-inline">Brak wpisów.</p>'))}
      <div class="ap-actions"><button type="button" class="btn btn-secondary btn-sm" id="cc-edit">Edytuj dane klienta</button></div>`, { wide: true });
    box.querySelector('#cc-edit').addEventListener('click', () => customerForm(c, after));
    box.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => { document.getElementById('modal').hidden = true; U().go(b.dataset.goto); }));
    box.querySelector('#cc-note').addEventListener('click', () => modal('Nowy wpis – ' + c.name, `
      <div class="field-row">${field('n-ch', 'Kanał', `<select id="n-ch" name="channel">${['telefon', 'email', 'spotkanie', 'notatka'].map(k => `<option value="${k}">${CHAN[k]}</option>`).join('')}</select>`)}
        ${field('n-dir', 'Kierunek', '<select id="n-dir" name="direction"><option value="wychodzaca">Wychodząca</option><option value="przychodzaca">Przychodząca</option><option value="wewnetrzna">Notatka wewnętrzna</option></select>')}</div>
      ${field('n-sub', 'Temat', '<input id="n-sub" name="subject" required maxlength="300">')}${field('n-body', 'Treść', '<textarea id="n-body" name="body" rows="4"></textarea>')}`,
    { submit: 'Zapisz wpis', onSubmit: async f => { await api('klienci/' + c.id + '/komunikacja', { channel: val(f, 'channel'), direction: val(f, 'direction'), subject: val(f, 'subject'), body: val(f, 'body') }); toast('Wpis zapisany.'); customerCard(id, after); } }));
  }
  const crmFilter = { q: '', rodzaj: '' };
  async function crmPage(root, path, alive) {
    const body = U().frame(root, path, 'CRM', 'Klienci, osoby kontaktowe i historia współpracy we wszystkich działach.', '<button type="button" class="btn btn-primary" id="crm-new">Nowy klient</button>');
    const reload = () => U().render(path, root);
    root.querySelector('#crm-new').addEventListener('click', () => customerForm(null, reload));
    // Link z wyszukiwania lub innej karty: /crm?klient=<id> otwiera kartę klienta.
    const open = new URLSearchParams(location.search).get('klient');
    if (open) { history.replaceState({}, '', location.pathname); customerCard(open, reload); }
    const q = new URLSearchParams(Object.entries(crmFilter).filter(([, v]) => v));
    const list = await api('klienci?' + q);
    if (!alive()) return;
    body.innerHTML = `<form class="toolbar" id="crm-f"><label class="visually-hidden" for="crm-q">Szukaj</label><input id="crm-q" name="q" class="select-sm" placeholder="Szukaj: nazwa, NIP, adres, e-mail" value="${esc(crmFilter.q)}">
        <label class="visually-hidden" for="crm-k">Rodzaj</label><select id="crm-k" name="rodzaj" class="select-sm"><option value="">Wszyscy klienci</option>${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${crmFilter.rodzaj === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button></form>
      <section class="panel">${table(['Klient', 'Rodzaj', 'Kraj', 'Kontakt', { t: 'Budynki', num: 1 }, { t: 'Oferty', num: 1 }, 'Reklamacje'], list.map(c => `<tr>
        <td><button type="button" class="linkish" data-cust="${c.id}">${esc(c.name)}</button>${c.departments.length ? `<div class="muted small">${c.departments.map(d => esc(DEP[d])).join(', ')}</div>` : ''}</td>
        <td>${esc(KIND[c.kind])}</td><td>${esc(c.country)}</td><td class="small">${esc(c.email || c.phone || '–')}</td><td class="num">${esc(c.buildings)}</td><td class="num">${esc(c.offers)}</td>
        <td>${c.open_complaints ? chip('warn', c.open_complaints + ' otwarte') : '<span class="muted">–</span>'}</td></tr>`), 'Brak klientów. Dodaj pierwszego klienta przyciskiem „Nowy klient”.')}</section>`;
    body.querySelector('#crm-f').addEventListener('submit', e => { e.preventDefault(); crmFilter.q = val(e.target, 'q').trim(); crmFilter.rodzaj = val(e.target, 'rodzaj'); reload(); });
    body.querySelectorAll('[data-cust]').forEach(b => b.addEventListener('click', () => customerCard(b.dataset.cust, reload)));
  }

  // ---------- Finance Intelligence ----------
  function financeChart(series, months, dep) {
    const s = series.find(x => x.department_id === dep), W = 600, H = 230, P = { l: 58, r: 8, t: 12, b: 30 };
    const max = Math.max(1, ...s.months.flatMap(m => [m.przychod, m.koszt]));
    const step = (() => { const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= raw); })();
    const top = step * 4, y = v => P.t + (H - P.t - P.b) * (1 - v / top), gw = (W - P.l - P.r) / months.length, bw = Math.max(4, Math.min(18, gw / 2 - 4));
    const ticks = [0, 1, 2, 3, 4].map(i => i * step);
    const short = m => ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'][Number(m.slice(5)) - 1];
    const bar = (x, v, cls) => { const h = Math.max(0, y(0) - y(v)); if (!h) return ''; const r = Math.min(4, h / 2, bw / 2); const yt = y(v);
      return `<path class="${cls}" d="M${x},${y(0)} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${y(0)} Z"/>`; };
    const k = v => v >= 1000 ? Math.round(v / 1000) + ' tys.' : String(Math.round(v));
    return `<div class="chart" data-dep="${esc(dep)}"><div class="legend"><span><i class="lg-rev"></i>Przychody</span><span><i class="lg-cost"></i>Koszty</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Przychody i koszty miesięcznie, ${esc(DEP[dep])}">
        ${ticks.map(t => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${P.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(k(t))}</text>`).join('')}
        ${s.months.map((m, i) => { const x0 = P.l + i * gw + gw / 2; return `<g class="grp" data-i="${i}">${bar(x0 - bw - 1, m.przychod, 'b-rev')}${bar(x0 + 1, m.koszt, 'b-cost')}
          <rect class="hit" x="${P.l + i * gw}" y="${P.t}" width="${gw}" height="${H - P.t - P.b}"/><text class="axis" x="${x0}" y="${H - 8}" text-anchor="middle">${short(m.miesiac)}</text></g>`; }).join('')}
      </svg><div class="tip" hidden></div></div>`;
  }
  function bindChart(box, series) {
    box.querySelectorAll('.chart').forEach(ch => {
      const s = series.find(x => x.department_id === ch.dataset.dep), tip = ch.querySelector('.tip');
      ch.querySelectorAll('.grp').forEach(g => {
        const m = s.months[Number(g.dataset.i)];
        const show = () => { tip.innerHTML = `<b>${esc(m.miesiac)}</b><div><i class="lg-rev"></i>Przychody: ${esc(pln(m.przychod))}</div><div><i class="lg-cost"></i>Koszty: ${esc(pln(m.koszt))}</div><div>Marża: ${esc(pln(m.przychod - m.koszt))}</div>`;
          tip.hidden = false; const r = g.getBoundingClientRect(), c = ch.getBoundingClientRect(); tip.style.left = Math.min(c.width - 190, Math.max(0, r.left - c.left + r.width / 2 - 95)) + 'px'; g.classList.add('on'); };
        const hide = () => { tip.hidden = true; g.classList.remove('on'); };
        g.addEventListener('mouseenter', show); g.addEventListener('mouseleave', hide); g.addEventListener('click', show);
      });
    });
  }
  const finFilter = { dzial: '', rodzaj: '', status: '' };
  async function financeForm(defaults, after) {
    const [rates, M] = await Promise.all([api('kursy'), U().meta()]);
    const [projects, buildings] = await Promise.all([api('d1/kontrakty').catch(() => []), api('d1/budynki').catch(() => [])]);
    modal('Nowy wpis finansowy', `
      <div class="field-row">${field('f-dep', 'Dział', `<select id="f-dep" name="department_id">${['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport'].map(d => `<option value="${d}"${defaults.department_id === d ? ' selected' : ''}>${DEP[d]}</option>`).join('')}</select>`)}
        ${field('f-kind', 'Rodzaj', `<select id="f-kind" name="kind"><option value="przychod"${defaults.kind === 'przychod' ? ' selected' : ''}>Przychód (faktura)</option><option value="koszt"${defaults.kind === 'koszt' ? ' selected' : ''}>Koszt</option></select>`)}</div>
      <div class="field-row">${field('f-cat', 'Kategoria', '<input id="f-cat" name="category" maxlength="60" placeholder="np. faktura, materiały, robocizna, transport">')}
        ${field('f-date', 'Data', `<input id="f-date" name="entry_date" type="date" value="${U().today()}">`)}</div>
      ${field('f-desc', 'Opis', '<input id="f-desc" name="description" maxlength="500">')}
      <div class="field-row">${field('f-amount', 'Kwota netto', '<input id="f-amount" name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal">')}
        ${field('f-cur', 'Waluta (kurs NBP z dnia wpisu)', `<select id="f-cur" name="currency"><option>PLN</option>${rates.map(r => `<option>${esc(r.code)}</option>`).join('')}</select>`)}</div>
      <div class="field-row">${field('f-inv', 'Numer faktury', '<input id="f-inv" name="invoice_no" maxlength="60">')}${field('f-due', 'Termin płatności', '<input id="f-due" name="due_date" type="date">')}${field('f-paid', 'Zapłacono (data)', '<input id="f-paid" name="paid_at" type="date">')}</div>
      <div class="field-row">${field('f-proj', 'Kontrakt (dział 1)', `<select id="f-proj" name="project_id">${opts(projects, defaults.project_id, p => p.number + ' – ' + p.title, p => p.id, '– brak –')}</select>`)}
        ${field('f-bud', 'Budynek (dział 1)', `<select id="f-bud" name="building_id">${opts(buildings, defaults.building_id, b => b.name + ', ' + b.address, b => b.id, '– brak –')}</select>`)}</div>
      ${defaults.installation_id ? `<input type="hidden" name="installation_id" value="${esc(defaults.installation_id)}"><p class="muted small">Wpis zostanie przypisany do zlecenia montażowego.</p>` : ''}`,
    { submit: 'Zapisz wpis', wide: true, onSubmit: async f => {
      await api('finanse', { department_id: val(f, 'department_id'), kind: val(f, 'kind'), category: val(f, 'category'), entry_date: val(f, 'entry_date'), description: val(f, 'description'),
        amount: val(f, 'amount'), currency: val(f, 'currency'), invoice_no: val(f, 'invoice_no'), due_date: val(f, 'due_date'), paid_at: val(f, 'paid_at'),
        project_id: val(f, 'project_id') || null, building_id: val(f, 'building_id') || null, installation_id: val(f, 'installation_id') || null });
      toast('Wpis zapisany.'); if (after) after();
    } });
  }
  function financeRows(list, reload, box) {
    const html = table(['Data', 'Dział', 'Rodzaj', 'Opis', 'Faktura', { t: 'Kwota', num: 1 }, { t: 'PLN', num: 1 }, 'Płatność', ''], list.map(x => {
      const overdue = x.kind === 'przychod' && !x.paid_at && x.due_date && x.due_date < U().today();
      return `<tr><td class="nowrap">${esc(fd(x.entry_date))}</td><td class="small">${esc(DEP[x.department_id])}</td><td>${chip(x.kind === 'przychod' ? 'ok' : 'warn', x.kind === 'przychod' ? 'Przychód' : 'Koszt')}</td>
        <td>${esc(x.description || x.category || '–')}<div class="muted small">${[x.customer_name, x.building_name, x.project_number, x.installation_number].filter(Boolean).map(esc).join(' · ')}</div></td>
        <td class="small">${esc(x.invoice_no || '–')}</td><td class="num">${esc(money(x.amount, x.currency))}</td><td class="num">${esc(pln(x.amount_pln))}</td>
        <td class="small">${x.kind !== 'przychod' || !x.invoice_no ? '–' : x.paid_at ? 'zapłacono ' + esc(fd(x.paid_at)) : `${overdue ? '<b class="txt-danger">po terminie</b>' : 'do ' + esc(fd(x.due_date))} <button type="button" class="linkish" data-paid="${x.id}">Zapłacono</button>`}</td>
        <td>${has('finance.cancel') ? `<button type="button" class="btn btn-ghost btn-sm" data-fdel="${x.id}" aria-label="Anuluj wpis">Anuluj</button>` : ''}</td></tr>`;
    }), 'Brak wpisów finansowych.');
    setTimeout(() => {
      box.querySelectorAll('[data-paid]').forEach(b => b.addEventListener('click', async () => { await api('finanse/' + b.dataset.paid + '/zaplacono', {}); toast('Oznaczono jako zapłacone.'); reload(); }));
      box.querySelectorAll('[data-fdel]').forEach(b => b.addEventListener('click', () => modal('Anulować wpis finansowy?',
        `<p>Wpis zniknie z sum i zestawień. Pełna kopia zostanie w archiwum anulowanych wpisów razem z powodem, Twoim loginem i datą.</p>
        ${field('fd-reason', 'Powód anulowania', '<input id="fd-reason" name="powod" maxlength="500" required placeholder="np. dubel faktury FV/12/2026">')}`,
        { submit: 'Anuluj wpis', cancel: 'Wróć', danger: true, onSubmit: async f => {
          if (val(f, 'powod').trim().length < 3) throw new Error('Podaj powód anulowania.');
          await api('finanse/' + b.dataset.fdel + '/anuluj', { powod: val(f, 'powod') }); toast('Wpis anulowany i przeniesiony do archiwum.'); reload();
        } })));
    });
    return html;
  }
  async function financePage(root, path, alive) {
    const body = U().frame(root, path, 'Finance Intelligence', 'Przychody, koszty, faktury, marże i prognozy działów 1 i 2.', '<button type="button" class="btn btn-primary" id="fi-new">Nowy wpis</button>');
    const reload = () => U().render(path, root);
    root.querySelector('#fi-new').addEventListener('click', () => financeForm({}, reload));
    const q = new URLSearchParams(Object.entries(finFilter).filter(([, v]) => v));
    const [s, list] = await Promise.all([api('finanse/podsumowanie'), api('finanse?' + q)]);
    if (!alive()) return;
    const ytd = d => s.ytd.find(x => x.department_id === d), fc = d => s.forecast.find(x => x.department_id === d);
    body.innerHTML = `<section class="kpis">
        <div class="kpi kpi-blue"><span class="kpi-v">${esc(pln(s.ytd.reduce((a, x) => a + x.przychod, 0)))}</span><span class="kpi-l">Przychody od początku roku</span></div>
        <div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(s.ytd.reduce((a, x) => a + x.koszt, 0)))}</span><span class="kpi-l">Koszty od początku roku</span></div>
        <div class="kpi kpi-ok"><span class="kpi-v">${esc(pln(s.ytd.reduce((a, x) => a + x.marza, 0)))}</span><span class="kpi-l">Marża od początku roku</span></div>
        <div class="kpi ${s.invoices.nieoplacone ? 'kpi-violet' : 'kpi-neutral'}"><span class="kpi-v">${esc(pln(s.invoices.kwota_nieoplacona))}</span><span class="kpi-l">Nieopłacone faktury (${esc(s.invoices.nieoplacone)})</span></div>
        <div class="kpi ${s.invoices.po_terminie ? 'kpi-warn' : 'kpi-neutral'}"><span class="kpi-v">${esc(pln(s.invoices.kwota_po_terminie))}</span><span class="kpi-l">Po terminie (${esc(s.invoices.po_terminie)})</span></div>
      </section>
      <div class="cols cols-even">${['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport'].map(d => `<section class="panel"><div class="panel-head"><h2 class="panel-title">${esc(DEP[d])}</h2>
        <span class="small">Marża od pocz. roku: <b>${esc(pln(ytd(d).marza))}</b> (${esc(ytd(d).marza_pct)}%)</span></div>
        ${financeChart(s.series, s.months, d)}
        <p class="small muted">Prognoza na kolejny miesiąc (${esc(fc(d).metoda)}): przychody ${esc(pln(fc(d).przychod_mies))}, koszty ${esc(pln(fc(d).koszt_mies))}.</p>
        <details><summary class="small">Pokaż dane jako tabelę</summary>${table(['Miesiąc', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }], s.series.find(x => x.department_id === d).months.map(m => `<tr><td>${esc(m.miesiac)}</td><td class="num">${esc(pln(m.przychod))}</td><td class="num">${esc(pln(m.koszt))}</td><td class="num">${esc(pln(m.przychod - m.koszt))}</td></tr>`), '')}</details>
      </section>`).join('')}</div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Wpisy: faktury, przychody, koszty</h2></div>
        <form class="toolbar" id="fi-f">
          <label class="visually-hidden" for="fi-d">Dział</label><select id="fi-d" name="dzial" class="select-sm"><option value="">Oba działy</option>${['podzielniki-i-montaze', 'sprzedaz-czesci-i-eksport'].map(d => `<option value="${d}"${finFilter.dzial === d ? ' selected' : ''}>${DEP[d]}</option>`).join('')}</select>
          <label class="visually-hidden" for="fi-r">Rodzaj</label><select id="fi-r" name="rodzaj" class="select-sm"><option value="">Przychody i koszty</option><option value="przychod"${finFilter.rodzaj === 'przychod' ? ' selected' : ''}>Przychody</option><option value="koszt"${finFilter.rodzaj === 'koszt' ? ' selected' : ''}>Koszty</option></select>
          <label class="visually-hidden" for="fi-s">Płatności</label><select id="fi-s" name="status" class="select-sm"><option value="">Wszystkie</option><option value="nieoplacone"${finFilter.status === 'nieoplacone' ? ' selected' : ''}>Nieopłacone faktury</option><option value="po_terminie"${finFilter.status === 'po_terminie' ? ' selected' : ''}>Po terminie</option></select>
          <button type="submit" class="btn btn-secondary btn-sm">Filtruj</button></form>
        <div id="fi-rows"></div></section>`;
    const rows = body.querySelector('#fi-rows'); rows.innerHTML = financeRows(list, reload, rows);
    bindChart(body, s.series);
    body.querySelector('#fi-f').addEventListener('submit', e => { e.preventDefault(); finFilter.dzial = val(e.target, 'dzial'); finFilter.rodzaj = val(e.target, 'rodzaj'); finFilter.status = val(e.target, 'status'); reload(); });
  }

  // ---------- Knowledge Base ----------
  const kbFilter = { q: '' };
  async function kbForm(doc, after) {
    const admin = has('approvals.decide');
    modal(doc ? 'Nowa wersja: ' + doc.title : 'Nowy dokument w bazie wiedzy', `
      ${doc ? '' : `<div class="field-row">${field('k-kind', 'Rodzaj', '<select id="k-kind" name="kind"><option value="wiedza">Wiedza</option><option value="procedura">Procedura</option></select>')}
        ${field('k-dep', 'Dział', `<select id="k-dep" name="department_id"><option value="">Cała firma</option>${Object.entries(DEP).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`)}</div>`}
      ${field('k-title', 'Tytuł', `<input id="k-title" name="title" required maxlength="300" value="${esc(doc ? doc.title : '')}">`)}
      ${field('k-content', 'Treść', `<textarea id="k-content" name="content" rows="10">${esc(doc && doc.versions[0] ? doc.versions[0].content : '')}</textarea>`)}
      ${field('k-file', 'Załącznik PDF (opcjonalnie, do 10 MB)', '<input id="k-file" name="file" type="file" accept="application/pdf">')}
      ${doc ? field('k-note', 'Opis zmiany', '<input id="k-note" name="note" maxlength="300">') : ''}
      ${admin ? `<label class="toggle"><input type="checkbox" name="for_agents"${doc && doc.for_agents ? ' checked' : ''}> <span>Udostępnij agentom AI (Knowledge Base agentów)</span></label>` : '<p class="muted small">Dokumenty dla agentów AI publikuje administrator.</p>'}`,
    { submit: doc ? 'Zapisz nową wersję' : 'Dodaj dokument', wide: true, onSubmit: async f => {
      const file = f.elements.file.files[0];
      if (file && file.size > 10 * 1024 * 1024) throw new Error('Plik jest większy niż 10 MB.');
      const b = { title: val(f, 'title'), content: val(f, 'content'), note: val(f, 'note'), ...(file ? { file_base64: await fileToB64(file), file_name: file.name } : {}) };
      if (admin) b.for_agents = f.elements.for_agents.checked;
      if (doc) await api('wiedza/' + doc.id + '/wersja', b); else await api('wiedza', { ...b, kind: val(f, 'kind'), department_id: val(f, 'department_id') || null });
      toast(doc ? 'Zapisano nową wersję.' : 'Dokument dodany.'); if (after) after();
    } });
  }
  async function kbView(id, after) {
    const d = await api('wiedza/' + id), cur = d.versions[0];
    const box = modal(d.title, `<p class="muted small">${esc(d.kind === 'procedura' ? 'Procedura' : 'Wiedza')} · ${esc(d.department_id ? DEP[d.department_id] : 'cała firma')} · wersja ${esc(d.current_version)}${d.for_agents ? ' · ' + chip('soon', 'dostępny dla agentów') : ''}</p>
      ${cur.content ? `<div class="ai-text kb-text">${esc(cur.content)}</div>` : ''}
      ${cur.file_name ? `<p>${pdfLink(`/api/dokumenty/${d.id}/plik`, 'Otwórz PDF: ' + cur.file_name)}</p>` : ''}
      <h3 class="panel-sub">Wersje</h3><ul class="tool-list">${d.versions.map(v => `<li>v${esc(v.version)} · ${esc(v.author)} · ${esc(fdt(v.created_at))}${v.note ? ' – ' + esc(v.note) : ''}${v.file_name ? ' ' + pdfLink(`/api/dokumenty/${d.id}/plik?v=${v.version}`, 'PDF') : ''}</li>`).join('')}</ul>
      <div class="ap-actions"><button type="button" class="btn btn-secondary btn-sm" id="kb-ver">Nowa wersja</button></div>`, { wide: true });
    box.querySelector('#kb-ver').addEventListener('click', () => kbForm(d, after));
  }
  async function kbPage(root, path, alive) {
    const body = U().frame(root, path, 'Knowledge Base', 'Dokumenty, procedury i wiedza firmowa – także dla agentów AI. Oddzielna od platformy szkoleniowej.', '<button type="button" class="btn btn-primary" id="kb-new">Nowy dokument</button>');
    const reload = () => U().render(path, root);
    root.querySelector('#kb-new').addEventListener('click', () => kbForm(null, reload));
    const list = await api('wiedza?' + new URLSearchParams(kbFilter.q ? { q: kbFilter.q } : {}));
    if (!alive()) return;
    body.innerHTML = `<form class="toolbar" id="kb-f"><label class="visually-hidden" for="kb-q">Szukaj</label><input id="kb-q" name="q" class="select-sm" placeholder="Szukaj w tytułach i treści" value="${esc(kbFilter.q)}"><button type="submit" class="btn btn-secondary btn-sm">Szukaj</button></form>
      <section class="panel">${list.length ? `<div class="kb-list">${list.map(x => `<button type="button" class="kb-item" data-kb="${x.id}"><span class="kb-t"><b>${esc(x.title)}</b>
        <span class="muted small">${esc(x.kind === 'procedura' ? 'Procedura' : 'Wiedza')} · ${esc(x.department_id ? DEP[x.department_id] : 'cała firma')} · v${esc(x.current_version)} · ${esc(fdt(x.updated_at))}${x.file_name ? ' · PDF' : ''}</span>
        <span class="small">${esc(x.excerpt)}</span></span>${x.for_agents ? chip('soon', 'dla agentów') : ''}</button>`).join('')}</div>`
        : `<p class="empty-inline">${kbFilter.q ? 'Brak wyników.' : 'Baza wiedzy jest pusta. Dodaj pierwszą procedurę lub dokument.'}</p>`}</section>
      <p class="muted small">Treść dokumentów udostępnionych agentom trafia do nich jako dane do analizy – instrukcje zawarte w dokumentach nie zmieniają zasad działania agentów.</p>`;
    body.querySelector('#kb-f').addEventListener('submit', e => { e.preventDefault(); kbFilter.q = val(e.target, 'q').trim(); reload(); });
    body.querySelectorAll('[data-kb]').forEach(b => b.addEventListener('click', () => kbView(b.dataset.kb, reload)));
  }

  // ---------- komponent: oferty (działy 1 i 2) ----------
  function itemRow(x = {}) {
    return `<tr class="it"><td><label class="visually-hidden">Nazwa</label><input name="nazwa" maxlength="300" value="${esc(x.nazwa || '')}" required></td>
      <td><input name="ilosc" type="number" min="0.01" step="0.01" value="${esc(x.ilosc ?? 1)}" aria-label="Ilość"></td>
      <td><input name="jm" maxlength="10" value="${esc(x.jm || 'szt.')}" aria-label="Jednostka"></td>
      <td><input name="koszt_pln" type="number" min="0" step="0.01" value="${esc(x.koszt_pln ?? '')}" aria-label="Koszt jednostkowy PLN"></td>
      <td><input name="cena" type="number" min="0" step="0.01" value="${x.cena_reczna ? esc(x.cena) : ''}" placeholder="auto" aria-label="Cena ręczna w walucie oferty"></td>
      <td><input name="kod_hs" maxlength="10" value="${esc(x.kod_hs || '')}" aria-label="Kod HS"></td>
      <td><input name="waga_kg" type="number" min="0" step="0.001" value="${esc(x.waga_kg || '')}" aria-label="Waga kg"></td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-rm aria-label="Usuń pozycję">×</button></td></tr>`;
  }
  async function offerForm(o, dep, after) {
    const [customers, rates] = await Promise.all([api('klienci'), api('kursy')]);
    const curs = ['PLN', ...rates.map(r => r.code)];
    const box = modal(o ? `Edytuj ofertę ${o.number} (nowa wersja ${o.version + 1})` : 'Nowa oferta – automatyczna kalkulacja', `
      <div class="field-row">${field('o-cust', 'Klient (CRM)', `<select id="o-cust" name="customer_id" required>${opts(customers, o && o.customer_id, c => c.name + (c.country !== 'PL' ? ' (' + c.country + ')' : ''), c => c.id, '– wybierz klienta –')}</select>`)}
        ${field('o-title', 'Temat oferty', `<input id="o-title" name="title" required maxlength="200" value="${esc(o ? o.title : '')}">`)}</div>
      <div class="field-row">${field('o-cur', 'Waluta', `<select id="o-cur" name="currency">${curs.map(c => `<option${(o ? o.currency : 'PLN') === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`)}
        ${field('o-margin', 'Marża %', `<input id="o-margin" name="margin_pct" type="number" step="0.1" value="${esc(o ? o.margin_pct : 20)}">`)}
        ${field('o-disc', 'Rabat %', `<input id="o-disc" name="discount_pct" type="number" min="0" max="90" step="0.1" value="${esc(o ? o.discount_pct : 0)}">`)}
        ${field('o-valid', 'Ważna do', `<input id="o-valid" name="valid_until" type="date" value="${esc(o && o.valid_until ? String(o.valid_until).slice(0, 10) : '')}">`)}</div>
      ${rates.length ? '' : '<p class="notice">Brak kursów walut w bazie – dostępne tylko PLN. Kursy pobierzesz w dziale Sprzedaż części i eksport → Kalkulacje i kursy.</p>'}
      <div class="table-wrap"><table class="table items"><thead><tr><th>Pozycja</th><th>Ilość</th><th>J.m.</th><th>Koszt jedn. PLN</th><th>Cena (opcj.)</th><th>Kod HS</th><th>Waga kg</th><th></th></tr></thead>
        <tbody id="o-items">${(o ? o.items.map(x => ({ ...x, cena_reczna: false })) : [{}]).map(itemRow).join('')}</tbody></table></div>
      <button type="button" class="btn btn-secondary btn-sm" id="o-add">Dodaj pozycję</button>
      <p class="muted small">Cena pusta = wyliczana automatycznie: koszt × (1 + marża) ÷ kurs NBP waluty. Kod HS i waga są potrzebne do dokumentów eksportowych.</p>
      ${field('o-terms', 'Warunki (dostawa, płatność)', `<textarea id="o-terms" name="terms" rows="2">${esc(o ? o.terms : '')}</textarea>`)}
      <div class="calc" id="o-calc"></div>`,
    { submit: o ? 'Zapisz nową wersję' : 'Zapisz ofertę (szkic)', wide: true, onSubmit: async f => {
      const b = collect(f);
      const r = o ? await api('oferty/' + o.id, b, 'PATCH') : await api('oferty', { ...b, department_id: dep });
      toast(o ? `Zapisano wersję ${r.version}.` : `Oferta ${r.number} zapisana jako szkic.`); if (after) after(r);
    } });
    const tb = box.querySelector('#o-items'), form = box.querySelector('form');
    const collect = f => ({ customer_id: val(f, 'customer_id'), title: val(f, 'title'), currency: val(f, 'currency'), margin_pct: val(f, 'margin_pct'), discount_pct: val(f, 'discount_pct'),
      valid_until: val(f, 'valid_until') || null, terms: val(f, 'terms'),
      items: [...tb.querySelectorAll('tr.it')].map(tr => Object.fromEntries([...tr.querySelectorAll('input')].map(i => [i.name, i.value]))).filter(x => x.nazwa.trim()) });
    const bindRm = () => tb.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { if (tb.children.length > 1) b.closest('tr').remove(); recalc(); });
    box.querySelector('#o-add').addEventListener('click', () => { tb.insertAdjacentHTML('beforeend', itemRow()); bindRm(); });
    let timer;
    const recalc = () => { clearTimeout(timer); timer = setTimeout(async () => {
      const c = box.querySelector('#o-calc'), b = collect(form);
      if (!b.items.length) { c.innerHTML = ''; return; }
      try { const r = await api('oferty/kalkulacja', b);
        c.innerHTML = `<dl class="ap-meta"><div><dt>Razem</dt><dd><b>${esc(money(r.total, r.currency))}</b></dd></div><div><dt>W PLN</dt><dd>${esc(pln(r.total_pln))}</dd></div>
          <div><dt>Koszt</dt><dd>${esc(pln(r.cost_pln))}</dd></div><div><dt>Marża</dt><dd>${esc(pln(r.margin_pln))} (${esc(r.margin_real_pct)}%)</dd></div>
          <div><dt>Kurs</dt><dd>${r.currency === 'PLN' ? '–' : `${esc(r.rate_pln)} PLN · ${esc(fd(r.rate_date))} · ${esc(r.rate_source)}`}</dd></div></dl>`;
      } catch (e) { c.innerHTML = `<p class="small txt-danger">${esc(e.message)}</p>`; }
    }, 350); };
    form.addEventListener('input', recalc); bindRm(); recalc();
  }
  async function offerView(id, after) {
    const o = await api('oferty/' + id);
    const acts = [];
    if (o.status === 'szkic') acts.push('<button type="button" class="btn btn-secondary btn-sm" data-oa="edit">Edytuj (nowa wersja)</button><button type="button" class="btn btn-primary btn-sm" data-oa="send">Wyślij do akceptacji</button>');
    if (o.status === 'do_akceptacji' && o.approval_status === 'oczekuje') acts.push('<button type="button" class="btn btn-ghost btn-sm" data-oa="withdraw">Wycofaj z akceptacji</button>');
    if (o.status === 'do_akceptacji' && o.approval_status === 'zatwierdzona') acts.push('<button type="button" class="btn btn-primary btn-sm" data-oa="release">Wyślij do klienta</button>');
    if (o.status === 'wyslana') acts.push('<button type="button" class="btn btn-primary btn-sm" data-oa="won">Klient przyjął ofertę</button><button type="button" class="btn btn-secondary btn-sm" data-oa="lost">Klient odrzucił</button>');
    const box = modal(`Oferta ${o.number}`, `<p class="muted">${esc(o.customer_name)} · ${esc(DEP[o.department_id])} · wersja ${esc(o.version)} · ${chip(o.status, OFFER_ST[o.status])}${o.created_by_agent ? ' · przygotował agent AI' : ''}</p>
      <h3 class="ap-title">${esc(o.title)}</h3>
      ${table(['Pozycja', { t: 'Ilość', num: 1 }, { t: 'Cena', num: 1 }, { t: 'Wartość', num: 1 }, { t: 'Koszt PLN', num: 1 }], o.items.map(x => `<tr><td>${esc(x.nazwa)}${x.kod_hs ? `<div class="muted small">HS ${esc(x.kod_hs)}</div>` : ''}</td><td class="num">${esc(x.ilosc)} ${esc(x.jm)}</td><td class="num">${esc(money(x.cena, o.currency))}</td><td class="num">${esc(money(x.cena * x.ilosc, o.currency))}</td><td class="num">${esc(pln(x.koszt_pln * x.ilosc))}</td></tr>`), '')}
      <dl class="ap-meta"><div><dt>Razem${Number(o.discount_pct) ? ' (rabat ' + esc(o.discount_pct) + '%)' : ''}</dt><dd><b>${esc(money(o.total, o.currency))}</b></dd></div><div><dt>W PLN</dt><dd>${esc(pln(o.total_pln))}</dd></div>
        <div><dt>Marża</dt><dd>${esc(pln(o.margin_pln))}</dd></div><div><dt>Kurs</dt><dd>${o.currency === 'PLN' ? '–' : `${esc(o.rate_pln)} · ${esc(fd(o.rate_date))}<div class="small muted">${esc(o.rate_source)}</div>`}</dd></div>
        <div><dt>Ważna do</dt><dd>${esc(fd(o.valid_until))}</dd></div>${o.sent_at ? `<div><dt>Wysłana</dt><dd>${esc(fdt(o.sent_at))}</dd></div>` : ''}</dl>
      ${o.status === 'do_akceptacji' ? `<p class="notice">${o.approval_status === 'zatwierdzona' ? 'Administrator zatwierdził wysyłkę wersji ' + esc(o.approval_version || o.version) + '. Możesz zwolnić ofertę do klienta.' : 'Wysyłka czeka na decyzję administratora w Approval Center.'}</p>` : ''}
      <h3 class="panel-sub">Wersje</h3><ul class="tool-list">${o.versions.map(v => `<li>Wersja ${esc(v.version)} · ${esc(v.author)} · ${esc(fdt(v.created_at))} ${pdfLink(`/api/oferty/${o.id}/pdf?v=${v.version}`, 'PDF')}</li>`).join('')}</ul>
      ${acts.length ? `<div class="ap-actions">${acts.join('')}</div>` : ''}`, { wide: true });
    const act = async (fn, msg) => { try { await fn(); toast(msg); box.closest('.modal').hidden = true; if (after) after(); } catch (e) { toast(e.message); } };
    box.querySelectorAll('[data-oa]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.oa;
      if (a === 'edit') return offerForm(o, o.department_id, after);
      if (a === 'send') return modal('Wysłać ofertę do akceptacji?', `<p>Administrator zatwierdzi wysyłkę wersji <b>${esc(o.version)}</b> oferty ${esc(o.number)} (${esc(money(o.total, o.currency))}). Do czasu decyzji oferty nie można zmienić.</p>`,
        { submit: 'Wyślij do akceptacji', onSubmit: async () => { await api(`oferty/${o.id}/wyslij`, {}); toast('Wysłano do Approval Center.'); if (after) after(); } });
      if (a === 'withdraw') return act(() => api(`approvals/${o.approval_id}/wycofaj`, {}), 'Wniosek wycofany – oferta wróciła do szkicu.');
      if (a === 'release') return act(() => api(`approvals/${o.approval_id}/wykonaj`, {}), 'Oferta zwolniona do wysyłki i zapisana w historii klienta.');
      if (a === 'won') return act(() => api(`oferty/${o.id}/wynik`, { przyjeta: true }), 'Zapisano sprzedaż i przychód.');
      if (a === 'lost') return act(() => api(`oferty/${o.id}/wynik`, { przyjeta: false }), 'Zapisano odrzucenie oferty.');
    }));
  }
  async function offersPanel(body, dep, reload) {
    const list = await api('oferty?dzial=' + dep);
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="of-new">Nowa oferta</button><span class="muted small">Oferty liczone automatycznie z kosztu, marży i kursu NBP. Wysyłka po akceptacji administratora.</span></div>
      <section class="panel">${table(['Numer', 'Klient', 'Temat', 'Status', { t: 'Kwota', num: 1 }, { t: 'PLN', num: 1 }, 'Utworzona'], list.map(o => `<tr>
        <td><button type="button" class="linkish" data-of="${o.id}">${esc(o.number)}</button> <span class="muted small">v${esc(o.version)}</span></td><td>${esc(o.customer_name)}</td><td>${esc(o.title)}${o.created_by_agent ? ' ' + chip('soon', 'agent AI') : ''}</td>
        <td>${chip(o.status, OFFER_ST[o.status])}${o.status === 'do_akceptacji' && o.approval_status === 'zatwierdzona' ? ' ' + chip('zatwierdzona', 'zgoda') : ''}</td><td class="num">${esc(money(o.total, o.currency))}</td><td class="num">${esc(pln(o.total_pln))}</td><td class="nowrap">${esc(fd(o.created_at))}</td></tr>`), 'Brak ofert. Przygotuj pierwszą ofertę przyciskiem „Nowa oferta”.')}</section>`;
    body.querySelector('#of-new').addEventListener('click', () => offerForm(null, dep, reload));
    body.querySelectorAll('[data-of]').forEach(b => b.addEventListener('click', () => offerView(b.dataset.of, reload)));
  }

  // ---------- komponent: reklamacje ----------
  async function complaintsPanel(body, dep, reload, { sales = null } = {}) {
    const list = await api('reklamacje?dzial=' + dep);
    body.insertAdjacentHTML('beforeend', `<section class="panel"><div class="panel-head"><h2 class="panel-title">Reklamacje</h2><button type="button" class="btn btn-primary btn-sm" id="rk-new">Zgłoś reklamację</button></div>
      ${table(['Numer', 'Dotyczy', 'Tytuł', 'Status', 'Zgłoszono', ''], list.map(x => `<tr><td class="nowrap">${esc(x.number)}</td>
        <td class="small">${esc([x.customer_name, x.building_name, x.serial_no && 'nr ' + x.serial_no, x.sale_number].filter(Boolean).join(' · ') || '–')}</td>
        <td>${esc(x.title)}${x.resolution ? `<div class="muted small">Rozwiązanie: ${esc(x.resolution)}</div>` : ''}</td>
        <td><label class="visually-hidden" for="rs-${x.id}">Status</label><select class="status-select" id="rs-${x.id}" data-rk="${x.id}">${Object.entries(CPL_ST).map(([k, v]) => `<option value="${k}"${k === x.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="nowrap">${esc(fd(x.reported_at))}</td><td><button type="button" class="btn btn-ghost btn-sm" data-rkr="${x.id}">Rozwiązanie</button></td></tr>`), 'Brak reklamacji.')}</section>`);
    body.querySelectorAll('[data-rk]').forEach(s => s.addEventListener('change', async () => { try { await api('reklamacje/' + s.dataset.rk, { status: s.value }, 'PATCH'); toast('Status reklamacji zmieniony.'); reload(); } catch (e) { toast(e.message); } }));
    body.querySelectorAll('[data-rkr]').forEach(b => b.addEventListener('click', () => { const x = list.find(y => y.id === b.dataset.rkr);
      modal('Rozwiązanie reklamacji ' + x.number, field('rk-res', 'Opis rozwiązania', `<textarea id="rk-res" name="resolution" rows="4">${esc(x.resolution)}</textarea>`) +
        field('rk-st', 'Status', `<select id="rk-st" name="status">${Object.entries(CPL_ST).map(([k, v]) => `<option value="${k}"${k === (x.status === 'zgloszona' ? 'rozwiazana' : x.status) ? ' selected' : ''}>${v}</option>`).join('')}</select>`),
      { submit: 'Zapisz', onSubmit: async f => { await api('reklamacje/' + x.id, { resolution: val(f, 'resolution'), status: val(f, 'status') }, 'PATCH'); toast('Zapisano.'); reload(); } }); }));
    body.querySelector('#rk-new').addEventListener('click', async () => {
      const src = dep === 'podzielniki-i-montaze' ? await api('d1/budynki') : (sales || await api('sprzedaz'));
      modal('Zgłoś reklamację', `
        ${dep === 'podzielniki-i-montaze'
          ? `<div class="field-row">${field('rk-sn', 'Numer seryjny urządzenia (jeśli dotyczy)', '<input id="rk-sn" name="serial_no" maxlength="40">')}
            ${field('rk-b', 'Budynek', `<select id="rk-b" name="building_id">${opts(src, null, b => b.name + ', ' + b.address, b => b.id, '– wybierz lub podaj numer seryjny –')}</select>`)}</div>
            <label class="toggle"><input type="checkbox" name="mark_faulty" checked> <span>Oznacz urządzenie jako wadliwe</span></label>`
          : field('rk-s', 'Sprzedaż', `<select id="rk-s" name="sale_id">${opts(src, null, x => x.number + ' – ' + x.customer_name, x => x.id, '– wybierz sprzedaż –')}</select>`)}
        ${field('rk-t', 'Tytuł', '<input id="rk-t" name="title" required maxlength="200">')}${field('rk-d', 'Opis zgłoszenia', '<textarea id="rk-d" name="description" rows="4"></textarea>')}`,
      { submit: 'Zgłoś', onSubmit: async f => {
        await api('reklamacje', { department_id: dep, title: val(f, 'title'), description: val(f, 'description'), serial_no: val(f, 'serial_no') || undefined,
          building_id: val(f, 'building_id') || null, sale_id: val(f, 'sale_id') || null, mark_faulty: f.elements.mark_faulty ? f.elements.mark_faulty.checked : false });
        toast('Reklamacja zgłoszona.'); reload();
      } });
    });
  }

  // ---------- komponent: agenci działu ----------
  // where: 'afterbegin' (nad treścią) albo 'beforeend' (pod treścią – np. pod harmonogramem, który jest najważniejszy).
  async function agentsStrip(body, dep, where = 'afterbegin') {
    let d; try { d = await api('ai/agenci'); } catch (e) { return; }
    const list = d.agents.filter(a => a.department_id === dep);
    if (!list.length) return;
    body.insertAdjacentHTML(where, `<section class="panel agents-strip"><div class="panel-head"><h2 class="panel-title">Agenci AI działu</h2><button type="button" class="linkish" data-go-wf>AI Workforce →</button></div>
      <div class="as-list">${list.map(a => `<div class="as-item">${U().avatar(a)}<div><b>${esc(a.display_name)}</b><span class="muted small">${esc(String(a.title).split(' – ')[0])}</span></div>
        <button type="button" class="btn btn-secondary btn-sm" data-task-agent="${esc(a.id)}"${a.status !== 'aktywny' ? ' disabled' : ''}>Zleć zadanie</button></div>`).join('')}</div>
      ${d.mode === 'test' ? '<p class="muted small">Tryb testowy – odpowiedzi agentów są symulowane.</p>' : ''}</section>`);
    body.querySelector('[data-go-wf]').addEventListener('click', () => U().go('/ai-workforce'));
    body.querySelectorAll('[data-task-agent]').forEach(b => b.addEventListener('click', () => U().taskForm({ assignee_id: b.dataset.taskAgent, department_id: dep }, () => toast('Zadanie dodane. Uruchomisz agenta w oknie zadania (moduł Zadania).'))));
  }

  window.MXT_BIZ = { offersPanel, complaintsPanel, agentsStrip, customerForm, customerCard, financeForm, financeRows, table, opts, pdfLink, fileToB64, DEP, OFFER_ST, CPL_ST, pln };
  const reg = window.MXT_MODULES.register;
  reg('/crm', { title: 'CRM', perm: 'tasks.use', render: crmPage }, { tab: true, after: '/ai-workforce' });
  reg('/finanse', { title: 'Finance Intelligence', perm: 'tasks.use', render: financePage }, { tab: true, after: '/crm' });
  reg('/wiedza', { title: 'Knowledge Base', perm: 'tasks.use', render: kbPage }, { tab: true, after: '/finanse' });
})();
