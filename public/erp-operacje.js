'use strict';
// ERP – dział Ciepłomierze i podzielniki: pulpit działu, wspólny rejestr zleceń (montaż, serwis, odczyt) z rozliczaniem,
// karta projektu (budżet, zespół, materiały, czas pracy, protokół miesięczny), karta urządzenia z historią, lokale,
// odczyty per urządzenie (wpis, kontrola kompletności, import z czytnika, protokół).
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b), has = p => U().has(p);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => n == null ? '–' : U().money(n, 'PLN'), go = p => U().go(p);
  const DEP = 'podzielniki-i-montaze', D1 = '/dzial/' + DEP;
  const TYPES = { montaz: 'Montaż', serwis: 'Serwis', odczyt: 'Odczyt' };
  const ST = { nowe: 'Nowe', do_przydzielenia: 'Do przydzielenia', przydzielone: 'Przydzielone', zaplanowane: 'Zaplanowane', w_realizacji: 'W realizacji',
    wykonane: 'Wykonane', rozliczone: 'Rozliczone', zamkniete: 'Zamknięte', anulowane: 'Anulowane' };
  const ST_CLS = { nowe: 'warn', do_przydzielenia: 'warn', przydzielone: 'w_toku', zaplanowane: 'w_toku', w_realizacji: 'w_toku', wykonane: 'ok', rozliczone: 'zatwierdzona', zamkniete: 'off', anulowane: 'off' };
  const TYPE_CLS = { montaz: 'lvl2', serwis: 'soon', odczyt: 'lvl1' };
  const DEV = { podzielnik: 'Podzielnik kosztów', wodomierz: 'Wodomierz', cieplomierz: 'Ciepłomierz', modul_radiowy: 'Moduł radiowy', inny: 'Inne' };
  const DEV_ST = { magazyn: 'Magazyn', zamontowane: 'Zamontowane', zdemontowane: 'Zdemontowane', wadliwe: 'Wadliwe' };
  const EV = { montaz: 'Montaż', demontaz: 'Demontaż', wymiana: 'Wymiana', serwis: 'Serwis', odczyt: 'Odczyt', zmiana_statusu: 'Zmiana statusu', legalizacja: 'Legalizacja', przeniesienie: 'Zmiana lokalu', inne: 'Inne' };
  const CAT = { montaz: 'Montaże', serwis: 'Serwisy', odczyty: 'Odczyty', materialy: 'Materiały', robocizna: 'Robocizna', transport: 'Transport', podwykonawcy: 'Podwykonawcy', inne: 'Inne' };
  const PROJ_ST = { oferta: 'Oferta', w_realizacji: 'W realizacji', zakonczony: 'Zakończony', rozliczony: 'Rozliczony', anulowany: 'Anulowany' };
  const BILL = { po_zleceniu: 'Po każdym zleceniu', miesiecznie: 'Miesięcznie (protokół miesięczny)', ryczalt: 'Ryczałt' };
  const pct = v => v == null ? '–' : String(v).replace('.', ',') + '%';
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const curMonth = () => today().slice(0, 7);
  const MON = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
  const monthLabel = m => MON[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
  const closeModal = () => { document.getElementById('modal').hidden = true; };
  // Tabela, która na telefonie zamienia się w karty (etykiety kolumn z data-label).
  const ctable = (head, rows, empty) => rows.length ? `<div class="table-wrap"><table class="table table-cards"><thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.t || h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty-inline">${esc(empty)}</p>`;
  const td = (label, html, cls) => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;

  // ======================= pulpit działu =======================
  const pst = { miesiac: curMonth() };
  async function pulpit(body, reload, alive, ctx) {
    const d = await api('d1/pulpit?miesiac=' + pst.miesiac);
    if (!alive()) return;
    const k = d.kpi, f = d.finance;
    const tile = (label, v, tone, foot, act) => `<${act ? `button type="button" class="hk hk-btn" ${act}` : 'div class="hk"'}><span class="hk-l">${esc(label)}</span><span class="hk-v${v ? '' : ' hk-zero'}">${esc(v)}</span>${foot ? (tone ? `<span class="hk-tag hk-${tone}">${esc(foot)}</span>` : `<span class="hk-f">${esc(foot)}</span>`) : ''}</${act ? 'button' : 'div'}>`;
    body.innerHTML = `<p data-ws-sub>${esc(monthLabel(pst.miesiac))} · dane z harmonogramu, zleceń, magazynu i finansów</p>
      <div data-ws-actions hidden><label class="visually-hidden" for="pu-m">Miesiąc</label><input type="month" id="pu-m" class="select-sm" value="${esc(pst.miesiac)}">
        ${has('employees.manage') ? '<button type="button" class="btn btn-secondary" id="pu-plan">Plan miesiąca</button>' : ''}</div>
      <section class="hm-kpis" aria-label="Zlecenia">
        ${tile('Aktywne projekty', k.projekty_aktywne, '', '', 'data-gotab="rozliczenia"')}
        ${tile('Otwarte serwisy', k.serwisy_otwarte, '', '', 'data-zl="serwis"')}
        ${tile('Odczyty w miesiącu', `${k.odczyty_wykonane}/${k.odczyty_zaplanowane + k.odczyty_wykonane}`, '', 'wykonane / wszystkie', '')}
        ${tile('Po terminie', k.po_terminie, 'danger', k.po_terminie ? 'wymaga reakcji' : '', k.po_terminie ? 'data-zl-termin="po_terminie"' : '')}
        ${tile('Zagrożone (≤ 3 dni)', k.zagrozone, 'warn', k.zagrozone ? 'termin blisko' : '', k.zagrozone ? 'data-zl-termin="7dni"' : '')}
        ${tile('Bez przydziału', k.bez_przydzialu, 'warn', k.bez_przydzialu ? 'do przydzielenia' : '', k.bez_przydzialu ? 'data-zl-status="do_przydzielenia"' : '')}
        ${tile('Do rozliczenia', k.do_rozliczenia, 'warn', k.do_rozliczenia ? 'wykonane, bez faktury' : '', k.do_rozliczenia ? 'data-zl-roz="do_rozliczenia"' : '')}
      </section>
      <div class="pu-grid">
        <section class="panel"><h2 class="panel-title">Finanse działu – ${esc(monthLabel(pst.miesiac))}</h2>
          <div class="kpis kpis-3"><div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(f.przychod))}</span><span class="kpi-l">Przychody</span></div>
            <div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(f.koszt))}</span><span class="kpi-l">Koszty (z materiałami i robocizną)</span></div>
            <div class="kpi ${f.wynik < 0 ? 'kpi-danger' : 'kpi-ok'}"><span class="kpi-v">${esc(pln(f.wynik))}</span><span class="kpi-l">Wynik · marża ${esc(pct(f.marza_pct))}</span></div></div>
          <p class="muted small">Materiały wydane na zlecenia w miesiącu: <b>${esc(pln(d.materials.zuzycie))}</b> (${esc(d.materials.wydania)} wydań RW).</p></section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Wykonanie planu</h2></div>
          ${d.plan.some(p => p.target != null) ? `<ul class="plan-list">${d.plan.map(p => `<li><div class="plan-h"><span>${esc(p.label)}</span><b>${esc(p.key === 'przychod' ? pln(p.actual) : p.actual)}${p.target != null ? ' / ' + esc(p.key === 'przychod' ? pln(p.target) : p.target) : ''}</b></div>
            ${p.target != null ? `<div class="bar bar-lg" aria-hidden="true"><i data-w="${Math.min(100, p.pct || 0)}"></i></div><span class="muted small">${esc(pct(p.pct))}</span>` : '<span class="muted small">bez planu</span>'}</li>`).join('')}</ul>`
            : `<p class="empty-inline">Plan na ${esc(monthLabel(pst.miesiac))} nie jest ustalony.${has('employees.manage') ? ' Ustal go przyciskiem „Plan miesiąca”.' : ''}</p>`}</section>
      </div>
      <section class="panel"><h2 class="panel-title">Obciążenie pracowników terenowych</h2>
        ${ctable(['Pracownik', { t: 'Otwarte serwisy', num: 1 }, { t: 'Odczyty do miesiąca', num: 1 }, { t: 'Godziny w miesiącu', num: 1 }, 'Dostępność'], d.load.map(x => `<tr>
          ${td('Pracownik', `<b>${esc(x.name)}</b>`)}${td('Otwarte serwisy', esc(x.serwisy), 'num')}${td('Odczyty', esc(x.odczyty), 'num')}${td('Godziny', esc(String(x.godziny).replace('.', ',')), 'num')}
          ${td('Dostępność', x.nieobecny ? chip('warn', 'nieobecny dziś') : chip('ok', 'dostępny'))}</tr>`), 'Brak pracowników terenowych (role: monter, serwisant, obsługa odczytów).')}</section>
      <section class="panel"><h2 class="panel-title">Rentowność projektów</h2>
        ${ctable(['Projekt', { t: 'Przychody', num: 1 }, { t: 'Koszty', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Marża %', num: 1 }, { t: 'Budżet kosztów', num: 1 }], d.projects.map(p => `<tr>
          ${td('Projekt', `<button type="button" class="linkish" data-proj="${esc(p.id)}">${esc(p.number)}</button><div class="muted small">${esc(p.title)}</div>`)}
          ${td('Przychody', esc(pln(p.przychod)), 'num')}${td('Koszty', esc(pln(p.koszt)), 'num')}${td('Marża', `<b class="${p.marza < 0 ? 'txt-danger' : ''}">${esc(pln(p.marza))}</b>`, 'num')}
          ${td('Marża %', esc(pct(p.marza_pct)), 'num')}${td('Budżet kosztów', p.budzet_koszt ? `${esc(pct(p.wykorzystanie_budzetu_pct))} z ${esc(pln(p.budzet_koszt))}` : '–', 'num')}</tr>`), 'Brak projektów.')}</section>`;
    body.querySelector('#pu-m').addEventListener('change', e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { pst.miesiac = e.target.value; reload(); } });
    const pl = body.querySelector('#pu-plan'); if (pl) pl.addEventListener('click', () => planForm(pst.miesiac, reload));
    body.querySelectorAll('[data-proj]').forEach(b => b.addEventListener('click', () => projectCard(b.dataset.proj, reload)));
    body.querySelectorAll('[data-gotab]').forEach(b => b.addEventListener('click', () => ctx.goTab(b.dataset.gotab)));
    body.querySelectorAll('[data-zl],[data-zl-termin],[data-zl-status],[data-zl-roz]').forEach(b => b.addEventListener('click', () => {
      Object.assign(zst, { typ: b.dataset.zl || '', termin: b.dataset.zlTermin || '', status: b.dataset.zlStatus || (b.dataset.zlRoz ? '' : 'otwarte'), rozliczenie: b.dataset.zlRoz || '', q: '' });
      ctx.goTab('zlecenia');
    }));
  }
  async function planForm(month, after) {
    const p = await api('d1/plany?miesiac=' + month);
    modal('Plan miesiąca – ' + monthLabel(month), `<p class="muted">Cele działu na miesiąc. Wykonanie liczy się automatycznie z danych (montaże odebrane/wykonane, urządzenia zamontowane, serwisy wykonane, odczyty, przychody). Puste pole = bez planu.</p>
      ${p.metrics.map(m => field('pl-' + m.key, `${m.label} (wykonano: ${m.key === 'przychod' ? pln(m.actual) : m.actual})`, `<input id="pl-${m.key}" name="${m.key}" type="number" min="0" step="${m.key === 'przychod' ? '0.01' : '1'}" inputmode="decimal" value="${m.target ?? ''}">`)).join('')}`,
    { submit: 'Zapisz plan', onSubmit: async f => { const cele = Object.fromEntries(p.metrics.map(m => [m.key, val(f, m.key)])); await api('d1/plany', { miesiac: month, cele }, 'PUT'); toast('Plan zapisany.'); after(); } });
  }

  // ======================= wspólny rejestr zleceń =======================
  const zst = { typ: '', status: 'otwarte', termin: '', rozliczenie: '', q: '' };
  async function zlecenia(body, reload, alive) {
    const qs = new URLSearchParams(Object.entries(zst).filter(([, v]) => v));
    const d = await api('d1/zlecenia?' + qs);
    if (!alive()) return;
    const sel = (id, k, label, o) => `<label class="visually-hidden" for="${id}">${label}</label><select id="${id}" class="select-sm" data-f="${k}">${o.map(([v, t]) => `<option value="${v}"${zst[k] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const overdue = d.rows.filter(x => x.overdue).length;
    const finance = has('finance.view');
    // „Dodaj zlecenie”: jeden przycisk dla montażu, serwisu i odczytu (tylko typy, do których konto ma uprawnienia).
    const addTypes = [['montaz', 'Montaż', 'Nowy montaż w harmonogramie: firma zlecająca, osiedle, liczba budynków, termin i pracownicy.', 'tasks.use'],
      ['serwis', 'Serwis', 'Zlecenie serwisowe: klient, adres, opis usterki, priorytet, serwisant (termin przydziału 14 dni).', 'service.manage'],
      ['odczyt', 'Odczyt', 'Obiekt do odczytów: budynek, zakres, metoda, cykl i termin pierwszego odczytu, osoba odpowiedzialna.', 'readings.manage']].filter(t => has(t[3]));
    body.innerHTML = `<p data-ws-sub>${d.rows.length} ${d.rows.length === 1 ? 'zlecenie' : 'zleceń'} w widoku${overdue ? ` · ${overdue} po terminie` : ''} · montaże, serwisy i odczyty w jednym rejestrze</p>
      ${addTypes.length ? '<div data-ws-actions hidden><button type="button" class="btn btn-primary" id="zl-new">Dodaj zlecenie</button></div>' : ''}
      <form class="toolbar zl-bar" id="zl-f">
        ${sel('zf-t', 'typ', 'Typ', [['', 'Wszystkie typy'], ...Object.entries(TYPES)])}
        ${sel('zf-s', 'status', 'Status', [['otwarte', 'Otwarte'], ['', 'Wszystkie statusy'], ...Object.entries(ST)])}
        ${sel('zf-d', 'termin', 'Termin', [['', 'Każdy termin'], ['po_terminie', 'Po terminie'], ['7dni', 'Termin w 7 dni'], ['miesiac', 'W tym miesiącu']])}
        ${sel('zf-r', 'rozliczenie', 'Rozliczenie', [['', 'Rozliczone i nie'], ['do_rozliczenia', 'Do rozliczenia'], ['rozliczone', 'Rozliczone']])}
        <label class="visually-hidden" for="zf-q">Szukaj</label><input id="zf-q" name="q" class="select-sm" placeholder="Numer, obiekt, adres" value="${esc(zst.q)}">
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button><div class="zl-sv"></div></form>
      <section class="panel">${ctable(['Typ', 'Numer', 'Obiekt', 'Status', 'Termin', 'Wykonawca', 'Projekt', 'Rozliczenie', ''], d.rows.map(x => `<tr class="${x.overdue ? 'row-deny' : ''}">
        ${td('Typ', chip(TYPE_CLS[x.type], TYPES[x.type]))}
        ${td('Numer', `<button type="button" class="linkish" data-open="${esc(x.id)}">${esc(x.number)}</button>`)}
        ${td('Obiekt', `${esc(x.object_name || '–')}<div class="muted small">${esc(x.address || '')}</div>`)}
        ${td('Status', chip(ST_CLS[x.status], ST[x.status] || x.status))}
        ${td('Termin', `${esc(fd(x.due_date))}${x.overdue ? ' <b class="txt-danger small">po terminie</b>' : ''}`, 'nowrap')}
        ${td('Wykonawca', x.assignee_name ? esc(x.assignee_name) : '<span class="txt-warn">nieprzydzielone</span>')}
        ${td('Projekt', x.project_number ? `<button type="button" class="linkish" data-proj="${esc(x.project_id)}">${esc(x.project_number)}</button>` : '–')}
        ${td('Rozliczenie', x.settled_at ? (x.invoice_no ? 'FV ' + esc(x.invoice_no) : 'bez opłaty') : x.status === 'wykonane' ? '<span class="txt-warn">do rozliczenia</span>' : '–')}
        ${td('', `${finance && x.status === 'wykonane' ? `<button type="button" class="btn btn-primary btn-sm" data-settle="${esc(x.id)}">Rozlicz</button>` : ''}
          ${finance && x.type === 'serwis' && x.status === 'rozliczone' ? `<button type="button" class="btn btn-secondary btn-sm" data-close-o="${esc(x.id)}">Zamknij</button>` : ''}
          ${!['rozliczone', 'zamkniete', 'anulowane'].includes(x.status) && (x.type !== 'odczyt' || x.raw_status === 'zaplanowany') ? `<button type="button" class="btn btn-ghost btn-sm" data-assign-p="${esc(x.id)}">Projekt</button>` : ''}`, 'td-actions')}</tr>`),
      'Brak zleceń dla wybranych filtrów.')}</section>`;
    const rows = d.rows, byId = id => rows.find(x => x.id === id);
    body.querySelectorAll('[data-f]').forEach(s => s.addEventListener('change', () => { zst[s.dataset.f] = s.value; reload(); }));
    body.querySelector('#zl-f').addEventListener('submit', e => { e.preventDefault(); zst.q = val(e.target, 'q').trim(); reload(); });
    U().savedViews(body.querySelector('.zl-sv'), 'zlecenia', () => ({ ...zst }), p => { for (const k of Object.keys(zst)) zst[k] = typeof p[k] === 'string' ? p[k] : ''; reload(); });
    body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openOrder(byId(b.dataset.open), reload)));
    body.querySelectorAll('[data-proj]').forEach(b => b.addEventListener('click', () => projectCard(b.dataset.proj, reload)));
    body.querySelectorAll('[data-settle]').forEach(b => b.addEventListener('click', () => settleForm(byId(b.dataset.settle), reload)));
    body.querySelectorAll('[data-close-o]').forEach(b => b.addEventListener('click', () => modal('Zamknąć zlecenie?', `<p>Zlecenie ${esc(byId(b.dataset.closeO).number)} zostanie zamknięte (koniec procesu, bez dalszej edycji).</p>`,
      { submit: 'Zamknij zlecenie', onSubmit: async () => { await api('d1/zlecenia/zamknij', { id: b.dataset.closeO }); toast('Zlecenie zamknięte.'); reload(); } })));
    body.querySelectorAll('[data-assign-p]').forEach(b => b.addEventListener('click', () => assignProject(byId(b.dataset.assignP), reload)));
    const zn = body.querySelector('#zl-new');
    if (zn) zn.addEventListener('click', () => {
      const box = modal('Dodaj zlecenie', `<p class="muted">Wybierz rodzaj zlecenia – otworzy się jego formularz. Nowe zlecenie pojawi się w tym rejestrze.</p>
        <div class="zl-types">${addTypes.map(([k, t, d]) => `<button type="button" class="zl-type" data-new="${k}"><b>${t}</b><span>${esc(d)}</span></button>`).join('')}</div>`, {});
      box.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => {
        const open = { montaz: () => window.MXT_D1.installationForm(null, reload), serwis: () => window.MXT_SERWIS.newOrder(reload), odczyt: () => window.MXT_ODCZYTY.newObject(reload) }[b.dataset.new];
        Promise.resolve(open()).catch(e => toast(e.message));
      }));
    });
  }
  async function openOrder(x, after) {
    if (x.type === 'montaz' && window.MXT_D1) return window.MXT_D1.installationForm(await api('d1/montaze/' + x.id), after);
    if (x.type === 'serwis') return go(`${D1}?tab=serwisy&z=${x.id}`);
    if (x.raw_status === 'zaplanowany') return go('/odczyty?z=' + x.id);
    return go(`${D1}?tab=odczyty`);
  }
  function settleForm(x, after) {
    const due = U().dayPlus(14);
    modal(`Rozlicz: ${TYPES[x.type].toLowerCase()} ${x.number}`, `<p class="muted">${esc(x.object_name || '')} · ${esc(x.address || '')}</p>
      <div class="field-row">${field('st-k', 'Kwota netto (PLN)', '<input id="st-k" name="kwota" type="number" min="0" step="0.01" inputmode="decimal" required>')}
        ${field('st-f', 'Numer faktury', '<input id="st-f" name="faktura" maxlength="60" placeholder="np. FV/2026/11/015">')}</div>
      <div class="field-row">${field('st-d', 'Data rozliczenia', `<input id="st-d" name="data" type="date" value="${today()}">`)}${field('st-p', 'Termin płatności', `<input id="st-p" name="termin" type="date" value="${due}">`)}</div>
      ${field('st-o', 'Opis (opcjonalnie)', '<input id="st-o" name="opis" maxlength="300">')}
      <p class="muted small">Kwota trafia do przychodów działu z fakturą i powiązaniem ze zleceniem${x.project_id ? ' i projektem' : ''}. Zlecenie bez opłaty: kwota 0, bez faktury.</p>`,
    { submit: 'Rozlicz zlecenie', onSubmit: async f => {
      await api('d1/zlecenia/rozlicz', { typ: x.type, id: x.id, kwota: val(f, 'kwota'), faktura: val(f, 'faktura'), data: val(f, 'data'), termin_platnosci: val(f, 'termin'), opis: val(f, 'opis') });
      toast('Zlecenie rozliczone.'); after();
    } });
  }
  async function assignProject(x, after) {
    const list = (await api('d1/projekty')).filter(p => ['oferta', 'w_realizacji'].includes(p.status) || p.id === x.project_id);
    modal(`Projekt dla zlecenia ${x.number}`, field('ap-p', 'Projekt', `<select id="ap-p" name="p"><option value="">– bez projektu –</option>${list.map(p => `<option value="${esc(p.id)}"${p.id === x.project_id ? ' selected' : ''}>${esc(p.number + ' – ' + p.title)}</option>`).join('')}</select>`),
      { submit: 'Zapisz', onSubmit: async f => { await api('d1/zlecenia/projekt', { typ: x.type, id: x.id, projekt: val(f, 'p') || null }); toast('Zapisano powiązanie z projektem.'); after(); } });
  }

  // ======================= karta projektu =======================
  async function projectCard(id, after) {
    const [p, M] = await Promise.all([api('d1/projekty/' + id), U().meta()]);
    const m = p.money, users = M.users.filter(u => u.is_active !== false);
    const fin = has('finance.view'), refresh = () => projectCard(id, after);
    const keys = kind => [...new Set([...Object.keys(kind === 'przychod' ? m.rev : m.cost), ...Object.keys(m.plan).filter(k => k.startsWith(kind + ':')).map(k => k.split(':')[1])])];
    const budRows = kind => keys(kind).map(c => { const plan = m.plan[kind + ':' + c], act = (kind === 'przychod' ? m.rev : m.cost)[c] || 0;
      return `<tr><td>${esc(CAT[c] || c)}</td><td class="num">${plan != null ? esc(pln(plan)) : '–'}</td><td class="num">${esc(pln(act))}</td><td class="num${plan != null && kind === 'koszt' && act > plan ? ' txt-danger' : ''}">${plan != null ? esc(pln(kind === 'koszt' ? plan - act : act - plan)) : '–'}</td></tr>`; });
    const sec = (t, html, extra = '') => `<div class="pc-sec"><div class="panel-head"><h3 class="panel-sub">${esc(t)}</h3>${extra}</div>${html}</div>`;
    const box = modal(`${p.number} – ${p.title}`, `<p class="muted">${esc(p.customer_name || 'bez klienta')} · ${chip(p.status === 'w_realizacji' ? 'w_toku' : p.status === 'anulowany' ? 'off' : 'ok', PROJ_ST[p.status])} · rozliczanie: ${esc(BILL[p.billing] || p.billing)}
        · kierownik: ${esc(p.manager_name || '–')}${p.start_date ? ' · ' + esc(fd(p.start_date)) + ' – ' + esc(fd(p.end_date)) : ''} · wartość umowy ${esc(pln(p.value_net))}</p>
      <div class="kpis kpis-3"><div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(m.przychod))}</span><span class="kpi-l">Przychody${m.budzet_przychod ? ' (budżet ' + esc(pln(m.budzet_przychod)) + ')' : ''}</span></div>
        <div class="kpi ${m.budzet_koszt && m.koszt > m.budzet_koszt ? 'kpi-danger' : 'kpi-neutral'}"><span class="kpi-v">${esc(pln(m.koszt))}</span><span class="kpi-l">Koszty${m.budzet_koszt ? ' · ' + esc(pct(m.wykorzystanie_budzetu_pct)) + ' budżetu' : ''}</span></div>
        <div class="kpi ${m.marza < 0 ? 'kpi-danger' : 'kpi-ok'}"><span class="kpi-v">${esc(pln(m.marza))}</span><span class="kpi-l">Marża ${esc(pct(m.marza_pct))}</span></div></div>
      <div class="ap-actions pc-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="pc-set">Ustawienia projektu</button>
        ${fin ? '<button type="button" class="btn btn-secondary btn-sm" id="pc-bud">Budżet</button>' : ''}
        <button type="button" class="btn btn-secondary btn-sm" id="pc-mat">Wydaj materiał</button>
        <button type="button" class="btn btn-secondary btn-sm" id="pc-time">Dodaj czas pracy</button>
        <button type="button" class="btn btn-secondary btn-sm" id="pc-prot">Protokół miesięczny</button>
        ${U().delBtn('d1/kontrakty/' + p.id, 'Kontrakt ' + p.number, 'Zmień status kontraktu na „Anulowany” – historia zostanie.')}
        <button type="button" class="btn btn-ghost btn-sm" id="pc-note">Notatka</button></div>
      ${sec('Budżet i wykonanie', `<div class="table-wrap"><table class="table table-sm"><thead><tr><th>Przychody</th><th class="num">Plan</th><th class="num">Wykonanie</th><th class="num">Różnica</th></tr></thead><tbody>${budRows('przychod').join('') || '<tr><td colspan="4" class="muted">Brak przychodów i planu.</td></tr>'}</tbody></table></div>
        <div class="table-wrap"><table class="table table-sm"><thead><tr><th>Koszty</th><th class="num">Plan</th><th class="num">Wykonanie</th><th class="num">Pozostało</th></tr></thead><tbody>${budRows('koszt').join('') || '<tr><td colspan="4" class="muted">Brak kosztów i planu.</td></tr>'}</tbody></table></div>`)}
      ${sec(`Zespół (${p.members.length})`, p.members.length ? `<ul class="tool-list">${p.members.map(x => `<li><b>${esc(x.full_name || x.login)}</b>${x.role ? ' – ' + esc(x.role) : ''}${x.phone ? ' · ' + esc(x.phone) : ''}
          <button type="button" class="sv-del" data-rm="${esc(x.user_id)}" aria-label="Usuń z zespołu" title="Usuń z zespołu">×</button></li>`).join('')}</ul>` : '<p class="empty-inline">Brak przypisanych pracowników.</p>',
        '<button type="button" class="btn btn-ghost btn-sm" id="pc-add">Dodaj osobę</button>')}
      ${sec(`Zlecenia (${p.orders.length})`, ctable(['Typ', 'Numer', 'Obiekt', 'Status', 'Termin'], p.orders.map(x => `<tr>${td('Typ', chip(TYPE_CLS[x.type], TYPES[x.type]))}
        ${td('Numer', `<button type="button" class="linkish" data-ord="${esc(x.id)}">${esc(x.number)}</button>`)}${td('Obiekt', esc(x.object_name || '–'))}${td('Status', chip(ST_CLS[x.status], ST[x.status]))}${td('Termin', esc(fd(x.due_date)))}</tr>`), 'Brak zleceń w projekcie. Dodaj montaż z projektem albo przypisz zlecenie w rejestrze zleceń.'))}
      ${sec('Materiały (wydania i zwroty)', ctable(['Dokument', 'Data', { t: 'Wartość', num: 1 }], p.materials.map(x => `<tr>${td('Dokument', esc(x.number))}${td('Data', esc(fd(x.doc_date)))}${td('Wartość', esc(pln(x.kind === 'ZW' ? -x.total_value : x.total_value)), 'num')}</tr>`), 'Brak wydań materiałów.'))}
      ${sec('Czas pracy', ctable(['Pracownik', { t: 'Godziny', num: 1 }, { t: 'Koszt', num: 1 }], p.time.map(x => `<tr>${td('Pracownik', esc(x.name))}${td('Godziny', esc(String(x.hours).replace('.', ',')), 'num')}${td('Koszt', esc(pln(x.cost)), 'num')}</tr>`), 'Brak wpisów czasu pracy.'))}
      ${sec('Faktury i koszty', ctable(['Data', 'Rodzaj', 'Opis', 'Faktura', { t: 'Kwota', num: 1 }], p.finance.map(x => `<tr>${td('Data', esc(fd(x.entry_date)))}${td('Rodzaj', x.kind === 'przychod' ? 'Przychód' : 'Koszt')}
        ${td('Opis', esc(x.description || x.category))}${td('Faktura', esc(x.invoice_no || '–') + (x.kind === 'przychod' && x.invoice_no ? (x.paid_at ? ' ' + chip('ok', 'zapłacona') : ' ' + chip('warn', 'nieopłacona')) : ''))}${td('Kwota', esc(pln(x.amount)), 'num')}</tr>`), 'Brak wpisów finansowych.'))}
      ${sec('Dokumenty', p.documents.length ? `<ul class="tool-list">${p.documents.map(x => `<li><a class="linkish" href="/api/dokumenty/${esc(x.id)}/plik" target="_blank" rel="noopener">${esc(x.title)}</a> <span class="muted small">${esc(fdt(x.created_at))}</span></li>`).join('')}</ul>` : '<p class="empty-inline">Brak dokumentów. Protokół miesięczny zapisze się tutaj.</p>')}
      ${sec('Historia', p.events.length ? `<ol class="comm">${p.events.map(e => `<li><b>${esc(fdt(e.created_at))}</b>${e.login ? ' · ' + esc(e.login) : ''}<div class="small">${esc(e.text)}</div></li>`).join('')}</ol>` : '<p class="empty-inline">Brak wpisów.</p>')}`, { wide: true });
    const $ = s => box.querySelector(s);
    $('#pc-set').addEventListener('click', () => modal('Ustawienia projektu ' + p.number, `${field('ps-t', 'Nazwa', `<input id="ps-t" name="title" maxlength="200" required value="${esc(p.title)}">`)}
      <div class="field-row">${field('ps-s', 'Status', `<select id="ps-s" name="status">${Object.entries(PROJ_ST).map(([k, v]) => `<option value="${k}"${p.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${field('ps-b', 'Rozliczanie', `<select id="ps-b" name="billing">${Object.entries(BILL).map(([k, v]) => `<option value="${k}"${p.billing === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      <div class="field-row">${field('ps-m', 'Kierownik projektu', `<select id="ps-m" name="manager"><option value="">– brak –</option>${users.map(u => `<option value="${esc(u.id)}"${p.manager_id === u.id ? ' selected' : ''}>${esc(u.full_name || u.login)}</option>`).join('')}</select>`)}
        ${field('ps-v', 'Wartość umowy netto', `<input id="ps-v" name="value" type="number" min="0" step="0.01" value="${esc(p.value_net)}">`)}</div>
      <div class="field-row">${field('ps-a', 'Początek', `<input id="ps-a" name="start" type="date" value="${esc(p.start_date || '')}">`)}${field('ps-e', 'Koniec', `<input id="ps-e" name="end" type="date" value="${esc(p.end_date || '')}">`)}</div>`,
    { submit: 'Zapisz', onSubmit: async f => { await api('d1/projekty/' + id, { updated_at: p.updated_at, title: val(f, 'title'), status: val(f, 'status'), billing: val(f, 'billing'), manager_id: val(f, 'manager') || null, value_net: val(f, 'value'), start_date: val(f, 'start') || null, end_date: val(f, 'end') || null }, 'PATCH'); toast('Projekt zapisany.'); refresh(); if (after) after(); } }));
    if ($('#pc-bud')) $('#pc-bud').addEventListener('click', () => {
      const cell = (kind, c) => `<input type="number" min="0" step="0.01" inputmode="decimal" name="${kind}:${c}" aria-label="${kind === 'przychod' ? 'Przychód' : 'Koszt'}: ${esc(CAT[c])}" value="${m.plan[kind + ':' + c] ?? ''}">`;
      modal('Budżet projektu ' + p.number, `<p class="muted">Plan przychodów i kosztów w podziale na kategorie. Wykonanie liczy się z faktur, wydań materiałów i czasu pracy.</p>
        <div class="table-wrap"><table class="table table-sm bud-t"><thead><tr><th>Kategoria</th><th>Przychód plan</th><th>Koszt plan</th></tr></thead><tbody>
        ${Object.entries(CAT).map(([c, l]) => `<tr><td>${esc(l)}</td><td>${['montaz', 'serwis', 'odczyty', 'inne'].includes(c) ? cell('przychod', c) : ''}</td><td>${['materialy', 'robocizna', 'transport', 'podwykonawcy', 'inne'].includes(c) ? cell('koszt', c) : ''}</td></tr>`).join('')}</tbody></table></div>`,
      { submit: 'Zapisz budżet', wide: true, onSubmit: async f => {
        const lines = [...f.querySelectorAll('input[name*=":"]')].filter(i => i.value !== '').map(i => { const [kind, category] = i.name.split(':'); return { kind, category, amount: i.value }; });
        await api('d1/projekty/' + id + '/budzet', { lines }, 'PUT'); toast('Budżet zapisany.'); refresh();
      } });
    });
    $('#pc-add').addEventListener('click', () => modal('Dodaj osobę do projektu', `${field('pa-u', 'Pracownik', `<select id="pa-u" name="u" required><option value="">– wybierz –</option>${users.map(u => `<option value="${esc(u.id)}">${esc(u.full_name || u.login)}</option>`).join('')}</select>`)}
      ${field('pa-r', 'Rola w projekcie', '<input id="pa-r" name="role" maxlength="100" placeholder="np. kierownik robót, monter, rozliczający">')}`,
    { submit: 'Dodaj', onSubmit: async f => { await api('d1/projekty/' + id + '/zespol', { user_id: val(f, 'u'), role: val(f, 'role') }); toast('Dodano do zespołu.'); refresh(); } }));
    box.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => { try { await api('d1/projekty/' + id + '/zespol/' + b.dataset.rm, null, 'DELETE'); toast('Usunięto z zespołu.'); refresh(); } catch (e) { toast(e.message); } }));
    box.querySelectorAll('[data-ord]').forEach(b => b.addEventListener('click', () => { const x = p.orders.find(o => o.id === b.dataset.ord); closeModal(); openOrder(x, after || (() => {})); }));
    $('#pc-mat').addEventListener('click', () => issueForm({ project: p }, refresh));
    $('#pc-time').addEventListener('click', () => timeForm({ project: p }, refresh));
    $('#pc-note').addEventListener('click', () => modal('Notatka w historii projektu', field('pn-t', 'Treść', '<textarea id="pn-t" name="t" rows="4" required maxlength="2000"></textarea>'),
      { submit: 'Zapisz', onSubmit: async f => { await api('d1/projekty/' + id + '/notatka', { text: val(f, 't') }); refresh(); } }));
    $('#pc-prot').addEventListener('click', () => modal('Protokół miesięczny – ' + p.number, `${field('pm-m', 'Miesiąc', `<input id="pm-m" name="m" type="month" required value="${curMonth()}">`)}
      <p class="muted small">Protokół obejmuje montaże wykonane i odebrane, serwisy wykonane, odczyty i zużyte materiały z wybranego miesiąca. Zapisuje się w dokumentach projektu.</p>`,
    { submit: 'Generuj PDF', onSubmit: async f => { const r = await api('d1/projekty/' + id + '/protokol-miesieczny', { miesiac: val(f, 'm') }); toast('Protokół ' + r.number + ' zapisany w dokumentach projektu.'); window.open('/api/dokumenty/' + r.document_id + '/plik', '_blank', 'noopener'); refresh(); } }));
  }

  // Wydanie materiałów na projekt lub zlecenie (RW) – z magazynu, po średnim koszcie.
  async function issueForm({ project, related_type, related_id, title }, after) {
    const [whs, items] = await Promise.all([api('magazyn/magazyny'), api('magazyn/pozycje?dzial=' + DEP)]);
    const act = whs.filter(w => w.is_active), orders = project ? project.orders.filter(o => o.type !== 'odczyt' && !['rozliczone', 'zamkniete', 'anulowane'].includes(o.status)) : [];
    const line = i => `<div class="field-row is-line">${field('is-i' + i, i ? 'Pozycja ' + (i + 1) : 'Materiał', `<select id="is-i${i}" name="item${i}"${i ? '' : ' required'}><option value="">– wybierz –</option>${items.map(x => `<option value="${esc(x.id)}">${esc(x.sku + ' · ' + x.name + ' (wolne: ' + x.free + ' ' + x.unit + ')')}</option>`).join('')}</select>`)}
      ${field('is-q' + i, 'Ilość', `<input id="is-q${i}" name="qty${i}" type="number" min="0.001" step="0.001" inputmode="decimal"${i ? '' : ' required'}>`)}</div>`;
    modal('Wydaj materiał' + (title ? ' – ' + title : project ? ' – ' + project.number : ''), `
      <div class="field-row">${field('is-w', 'Magazyn', `<select id="is-w" name="wh">${act.map(w => `<option value="${esc(w.id)}">${esc(w.code + ' – ' + w.name)}</option>`).join('')}</select>`)}
        ${project ? field('is-o', 'Na co', `<select id="is-o" name="ord"><option value="project">Projekt ${esc(project.number)} (ogólnie)</option>${orders.map(o => `<option value="${o.type === 'montaz' ? 'installation' : 'service_order'}:${esc(o.id)}">${esc(TYPES[o.type] + ' ' + o.number + ' – ' + (o.object_name || ''))}</option>`).join('')}</select>`) : ''}</div>
      ${[0, 1, 2].map(line).join('')}
      ${field('is-n', 'Uwagi', '<input id="is-n" name="note" maxlength="300">')}
      <p class="muted small">Materiał zostaje wydany po średnim koszcie zakupu i trafia do kosztów ${project ? 'projektu' : 'zlecenia'}. Zwrot niewykorzystanego materiału – w module Magazyn (dokument ZW).</p>`,
    { submit: 'Wydaj (RW)', wide: true, onSubmit: async f => {
      const lines = [0, 1, 2].map(i => ({ item_id: val(f, 'item' + i), qty: val(f, 'qty' + i) })).filter(l => l.item_id && l.qty);
      let rt = related_type, rid = related_id;
      if (project) { const o = val(f, 'ord'); if (o === 'project') { rt = 'project'; rid = project.id; } else [rt, rid] = o.split(':'); }
      const d = await api('magazyn/dokumenty', { kind: 'RW', warehouse_id: val(f, 'wh'), related_type: rt, related_id: rid, project_id: project ? project.id : null, lines, note: val(f, 'note') });
      toast(`Wydano materiał: ${d.number} (${pln(d.total_value)}).`); if (after) after();
    } });
  }
  // Czas pracy – własny (każdy z uprawnieniem) albo innej osoby (kierownik).
  async function timeForm({ project, related_type, related_id, title }, after) {
    const team = has('employees.manage'), M = team ? await U().meta() : null;
    const orders = project ? project.orders : [];
    modal('Czas pracy' + (title ? ' – ' + title : project ? ' – ' + project.number : ''), `
      ${team ? field('tf-u', 'Pracownik', `<select id="tf-u" name="u">${M.users.filter(u => u.is_active !== false).map(u => `<option value="${esc(u.id)}"${u.id === U().me().id ? ' selected' : ''}>${esc(u.full_name || u.login)}</option>`).join('')}</select>`) : ''}
      <div class="field-row">${field('tf-d', 'Data', `<input id="tf-d" name="d" type="date" required value="${today()}">`)}${field('tf-h', 'Godziny', '<input id="tf-h" name="h" type="number" min="0.25" max="24" step="0.25" inputmode="decimal" required>')}</div>
      ${project ? field('tf-o', 'Czego dotyczy', `<select id="tf-o" name="o"><option value="project">Projekt ${esc(project.number)}</option>${orders.map(o => `<option value="${o.type === 'montaz' ? 'installation' : o.type === 'serwis' ? 'service_order' : 'reading'}:${esc(o.id)}"${o.type === 'odczyt' && o.raw_status === 'zaplanowany' ? ' disabled' : ''}>${esc(TYPES[o.type] + ' ' + o.number)}</option>`).join('')}</select>`) : ''}
      ${field('tf-n', 'Opis pracy', '<input id="tf-n" name="n" maxlength="500">')}`,
    { submit: 'Zapisz czas', onSubmit: async f => {
      let rt = related_type || 'inne', rid = related_id || null;
      if (project) { const o = val(f, 'o'); if (o === 'project') { rt = 'project'; rid = project.id; } else [rt, rid] = o.split(':'); }
      await api('czas', { user_id: team ? val(f, 'u') : undefined, work_date: val(f, 'd'), hours: val(f, 'h'), related_type: rt, related_id: rid, project_id: project ? project.id : null, note: val(f, 'n') });
      toast('Czas pracy zapisany.'); if (after) after();
    } });
  }

  // ======================= urządzenie: karta z historią =======================
  async function deviceCard(id, after) {
    const d = await api('d1/urzadzenia/' + id);
    const units = d.building_id ? await api('d1/budynki/' + d.building_id + '/lokale').catch(() => []) : [];
    const refresh = () => deviceCard(id, after);
    const box = modal(`${d.type_label} ${d.serial_no}`, `<p class="muted">${esc(d.building_name || 'bez budynku')}${d.address ? ', ' + esc(d.address) : ''}${d.unit_number ? ' · lokal ' + esc(d.unit_number) : ''}${d.location ? ' · ' + esc(d.location) : ''}
        · ${chip(d.status === 'wadliwe' ? 'deny' : d.status === 'zamontowane' ? 'ok' : 'off', DEV_ST[d.status])}</p>
      <div class="dev-form" id="dv-f">
        <div class="field-row">${field('dv-m', 'Producent', `<input id="dv-m" name="manufacturer" maxlength="100" value="${esc(d.manufacturer)}">`)}${field('dv-md', 'Model', `<input id="dv-md" name="model" maxlength="100" value="${esc(d.model)}">`)}
          ${field('dv-r', 'ID radiowe', `<input id="dv-r" name="radio_id" maxlength="60" value="${esc(d.radio_id)}">`)}</div>
        <div class="field-row">${field('dv-u', 'Lokal', `<select id="dv-u" name="unit_id"><option value="">– bez lokalu –</option>${units.filter(u => u.is_active).map(u => `<option value="${esc(u.id)}"${u.id === d.unit_id ? ' selected' : ''}>${esc(u.number)}${u.occupant ? ' – ' + esc(u.occupant) : ''}</option>`).join('')}</select>`)}
          ${field('dv-l', 'Miejsce montażu', `<input id="dv-l" name="location" maxlength="200" value="${esc(d.location)}" placeholder="np. pokój, grzejnik 2">`)}
          ${field('dv-g', 'Legalizacja do', `<input id="dv-g" name="legalization_until" type="date" value="${esc(d.legalization_until ? String(d.legalization_until).slice(0, 10) : '')}">`)}</div>
        <div class="field-row">${field('dv-s', 'Status', `<select id="dv-s" name="status">${Object.entries(DEV_ST).map(([k, v]) => `<option value="${k}"${d.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
          ${field('dv-p', 'Powód zmiany statusu (opcjonalnie)', '<input id="dv-p" name="powod" maxlength="300">')}</div>
        <div class="ap-actions"><button type="button" class="btn btn-primary btn-sm" id="dv-save">Zapisz dane urządzenia</button><button type="button" class="btn btn-secondary btn-sm" id="dv-ev">Dodaj zdarzenie</button>${U().delBtn('d1/urzadzenia/' + d.id, 'Urządzenie ' + d.serial_no, 'Zmień status na „Zdemontowane” albo „Wadliwe” – historia urządzenia zostanie.')}</div></div>
      <h3 class="panel-sub">Historia (${d.timeline.length})</h3>
      ${d.timeline.length ? `<ol class="timeline dev-tl">${d.timeline.map(t => `<li><span class="tl-dot tl-${t.kind === 'serwis' ? 'zmiana' : t.kind === 'odczyt' ? 'wykonanie' : t.kind === 'zmiana_statusu' || t.kind === 'demontaz' ? 'odrzucenie' : 'utworzenie'}"></span>
        <div><b>${esc(fd(t.date))} · ${esc(EV[t.kind] || t.kind)}</b>${t.by ? ' · ' + esc(t.by) : ''}<div class="small">${esc(t.text)}</div></div></li>`).join('')}</ol>` : '<p class="empty-inline">Brak zdarzeń.</p>'}
      ${d.documents.length ? `<h3 class="panel-sub">Dokumenty</h3><ul class="tool-list">${d.documents.map(x => `<li><a class="linkish" href="/api/dokumenty/${esc(x.id)}/plik" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ul>` : ''}`, { wide: true });
    box.querySelector('#dv-save').addEventListener('click', async () => {
      const g = n => box.querySelector(`#dv-f [name="${n}"]`).value.trim();
      const b = { manufacturer: g('manufacturer'), model: g('model'), radio_id: g('radio_id'), unit_id: g('unit_id') || null, location: g('location'), legalization_until: g('legalization_until') || null, status: g('status'), powod: g('powod') };
      try { await api('d1/urzadzenia/' + id, { ...b, updated_at: d.updated_at }, 'PATCH'); toast('Dane urządzenia zapisane.'); refresh(); if (after) after(); } catch (x) { toast(x.message); }
    });
    box.querySelector('#dv-ev').addEventListener('click', () => modal('Zdarzenie urządzenia ' + d.serial_no, `<div class="field-row">${field('de-k', 'Rodzaj', `<select id="de-k" name="k">${['wymiana', 'serwis', 'legalizacja', 'demontaz', 'montaz', 'przeniesienie', 'inne'].map(k => `<option value="${k}">${EV[k]}</option>`).join('')}</select>`)}
      ${field('de-d', 'Data', `<input id="de-d" name="d" type="date" value="${today()}">`)}</div>${field('de-t', 'Opis', '<textarea id="de-t" name="t" rows="3" required maxlength="1000"></textarea>')}`,
    { submit: 'Zapisz', onSubmit: async f => { await api('d1/urzadzenia/' + id + '/zdarzenia', { kind: val(f, 'k'), event_date: val(f, 'd'), description: val(f, 't') }); toast('Zdarzenie zapisane.'); refresh(); } }));
  }

  // ======================= lokale (w karcie budynku) =======================
  async function unitsSection(holder, buildingId) {
    const list = await api('d1/budynki/' + buildingId + '/lokale');
    holder.innerHTML = `<div class="panel-head"><h3 class="panel-sub">Lokale (${list.length})</h3><span><button type="button" class="btn btn-ghost btn-sm" data-u-series>Dodaj serię</button><button type="button" class="btn btn-ghost btn-sm" data-u-one>Dodaj lokal</button></span></div>
      ${list.length ? `<div class="unit-grid">${list.map(u => `<button type="button" class="unit${u.is_active ? '' : ' unit-off'}" data-u="${esc(u.id)}"><b>${esc(u.number)}</b><span>${esc(u.occupant || '–')}</span><span class="muted small">${u.devices} urz.</span></button>`).join('')}</div>`
        : '<p class="empty-inline">Brak lokali. Dodaj serię (np. 1–60), żeby przypisywać urządzenia i odczyty do lokali.</p>'}`;
    const reload = () => unitsSection(holder, buildingId);
    // Okno lokalu otwiera się nad kartą budynku: po zapisie wracamy do karty budynku (MXT_D1.buildingCard).
    const back = () => window.MXT_D1 && window.MXT_D1.buildingCard(buildingId);
    holder.querySelector('[data-u-series]').addEventListener('click', () => modal('Seria lokali', `<div class="field-row">${field('us-a', 'Od numeru', '<input id="us-a" name="a" type="number" min="1" value="1" required>')}
      ${field('us-b', 'Do numeru', '<input id="us-b" name="b" type="number" min="1" required>')}${field('us-p', 'Prefiks (opcjonalnie)', '<input id="us-p" name="p" maxlength="10" placeholder="np. A/">')}</div>
      <p class="muted small">Istniejące numery są pomijane.</p>`, { submit: 'Dodaj lokale', onSubmit: async f => { const r = await api('d1/budynki/' + buildingId + '/lokale', { seria: { od: val(f, 'a'), do: val(f, 'b'), prefiks: val(f, 'p') } }); toast('Dodano lokali: ' + r.added + '.'); back(); } }));
    const unitForm = u => modal(u ? 'Lokal ' + u.number : 'Nowy lokal', `<div class="field-row">${field('uf-n', 'Numer', `<input id="uf-n" name="number" required maxlength="40" value="${esc(u ? u.number : '')}">`)}${field('uf-f', 'Piętro', `<input id="uf-f" name="floor" maxlength="20" value="${esc(u ? u.floor : '')}">`)}
      ${field('uf-a', 'Powierzchnia m²', `<input id="uf-a" name="area" type="number" min="0" step="0.01" value="${esc(u && u.area_m2 != null ? u.area_m2 : '')}">`)}</div>
      <div class="field-row">${field('uf-o', 'Lokator / właściciel', `<input id="uf-o" name="occupant" maxlength="200" value="${esc(u ? u.occupant : '')}">`)}${field('uf-p', 'Telefon', `<input id="uf-p" name="phone" type="tel" maxlength="50" value="${esc(u ? u.phone : '')}">`)}</div>
      ${field('uf-x', 'Uwagi (dostęp, klucze)', `<input id="uf-x" name="notes" maxlength="1000" value="${esc(u ? u.notes : '')}">`)}
      ${u ? `<label class="toggle"><input type="checkbox" name="active"${u.is_active ? ' checked' : ''}> Lokal aktywny</label><div class="ap-actions">${U().delBtn('d1/lokale/' + u.id, 'Lokal ' + u.number, 'Odznacz „Lokal aktywny” – historia urządzeń i zleceń zostanie.', 'Usuń lokal')}</div>` : ''}`,
    { submit: 'Zapisz', onSubmit: async f => {
      const b = { number: val(f, 'number'), floor: val(f, 'floor'), area_m2: val(f, 'area'), occupant: val(f, 'occupant'), phone: val(f, 'phone'), notes: val(f, 'notes') };
      if (u) await api('d1/lokale/' + u.id, { ...b, is_active: f.elements.active.checked, updated_at: u.updated_at }, 'PATCH'); else await api('d1/budynki/' + buildingId + '/lokale', b);
      toast('Lokal zapisany.'); back();
    } });
    holder.querySelector('[data-u-one]').addEventListener('click', () => unitForm(null));
    holder.querySelectorAll('[data-u]').forEach(b => b.addEventListener('click', () => unitForm(list.find(u => u.id === b.dataset.u))));
    void reload;
  }

  // ======================= odczyty per urządzenie =======================
  async function deviceReadings(scheduleId, date) {
    const d = await api(`d1/odczyty/${scheduleId}/urzadzenia?data=${date || today()}`), s = d.schedule;
    const k = await api(`d1/odczyty/${scheduleId}/kontrola?data=${d.read_at}`);
    const open = dt => deviceReadings(scheduleId, dt);
    const box = modal(`Odczyty urządzeń – ${s.building_name}`, `<div class="field-row">${field('dr-d', 'Data odczytu', `<input id="dr-d" type="date" value="${esc(d.read_at)}">`)}
        <div class="field dr-sum"><span class="flabel">Kompletność</span><p>${k.total ? `<b>${k.read}</b> z ${k.total} (${esc(pct(k.complete_pct))})` : 'brak urządzeń w zakresie'}${k.missing.length ? ' · ' + chip('warn', 'braki: ' + k.missing.length) : ''}${k.suspicious.length ? ' · ' + chip('deny', 'podejrzane: ' + k.suspicious.length) : ''}</p></div></div>
      ${d.devices.length ? `<div id="dr-f"><div class="dr-list">${d.devices.map(x => `<div class="dr-row${x.status === 'podejrzany' ? ' dr-bad' : x.status === 'brak' ? ' dr-miss' : ''}">
          <div class="dr-id"><b>${x.unit_number ? 'Lokal ' + esc(x.unit_number) : esc(x.location || '–')}</b><span class="mono-ink">${esc(x.serial_no)}</span><span class="muted small">${esc(DEV[x.type])}${x.prev_value != null ? ` · poprzednio ${esc(String(x.prev_value).replace('.', ','))} (${esc(fd(x.prev_date))})` : ''}</span>
            ${x.status === 'podejrzany' ? `<span class="small txt-danger">do sprawdzenia: ${esc(x.anomaly)}</span>` : ''}</div>
          <label class="visually-hidden" for="dv-${esc(x.id)}">Wartość ${esc(x.serial_no)}</label><input id="dv-${esc(x.id)}" name="v:${esc(x.id)}" inputmode="decimal" autocomplete="off" placeholder="wartość" value="${x.value != null ? esc(String(x.value).replace('.', ',')) : ''}">
          <label class="visually-hidden" for="dn-${esc(x.id)}">Uwagi ${esc(x.serial_no)}</label><input id="dn-${esc(x.id)}" name="n:${esc(x.id)}" maxlength="300" placeholder="uwagi / powód braku" value="${esc(x.note || '')}">
        </div>`).join('')}</div>
        <div class="ap-actions"><button type="button" class="btn btn-primary" id="dr-save">Zapisz odczyty</button><button type="button" class="btn btn-secondary" id="dr-pdf"${k.entered ? '' : ' disabled'}>Protokół PDF</button></div></div>
        <details class="dr-imp"><summary>Import z czytnika radiowego / pliku</summary>
          ${field('dr-csv', 'Wklej wiersze: numer seryjny lub ID radiowe;wartość', '<textarea id="dr-csv" rows="5" placeholder="12345678;104,5&#10;R-0001;88"></textarea>')}
          <button type="button" class="btn btn-secondary btn-sm" id="dr-imp">Importuj</button></details>
        <p class="muted small">Puste pole = brak odczytu (wpisz powód w uwagach, np. brak dostępu). Spadek wskazania ciepłomierza lub wodomierza i podzielnik wielokrotnie powyżej mediany budynku są oznaczane jako podejrzane.</p>`
      : '<p class="empty-inline">W budynku nie ma zamontowanych urządzeń objętych zakresem odczytu. Dodaj urządzenia w zakładce Urządzenia.</p>'}`, { wide: true });
    box.querySelector('#dr-d').addEventListener('change', e => { if (e.target.value) open(e.target.value); });
    const form = box.querySelector('#dr-f');
    if (!form) return;
    const inp = n => form.querySelector(`[name="${n}"]`);
    box.querySelector('#dr-save').addEventListener('click', async () => {
      const values = d.devices.map(x => ({ device_id: x.id, value: inp('v:' + x.id).value.trim().replace(',', '.'), note: inp('n:' + x.id).value.trim() }))
        .filter((v, i) => v.value !== '' || v.note !== '' || d.devices[i].status != null);
      if (!values.length) return toast('Wpisz co najmniej jedną wartość.');
      try { const r = await api(`d1/odczyty/${scheduleId}/wartosci`, { read_at: d.read_at, values, source: matchMedia('(max-width: 640px)').matches ? 'mobilny' : 'reczny' }); toast(`Zapisano ${r.saved} odczytów.`); open(d.read_at); }
      catch (x) { toast(x.message); }
    });
    box.querySelector('#dr-pdf').addEventListener('click', async () => { try { const r = await api(`d1/odczyty/${scheduleId}/protokol`, { read_at: d.read_at }); toast('Protokół ' + r.number + ' zapisany.'); window.open('/api/dokumenty/' + r.document_id + '/plik', '_blank', 'noopener'); } catch (x) { toast(x.message); } });
    box.querySelector('#dr-imp').addEventListener('click', async () => {
      try { const r = await api(`d1/odczyty/${scheduleId}/import`, { read_at: d.read_at, csv: box.querySelector('#dr-csv').value }); toast(`Zaimportowano ${r.saved} odczytów${r.unknown.length ? ', nieznane numery: ' + r.unknown.length : ''}.`); open(d.read_at); }
      catch (x) { toast(x.message); }
    });
  }

  window.MXT_ERP = { pulpit, zlecenia, zst, projectCard, deviceCard, unitsSection, deviceReadings, issueForm, timeForm, settleForm };
  window.MXT_PROJEKT = { open: projectCard };
})();
