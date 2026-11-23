'use strict';
// Odczyty: zakładka „Odczyty” w dziale Podzielniki i Montaże oraz ekran „Odczyty” dla roli „Obsługa odczytów”.
// Terminy i wykonanie (bez wartości odczytów). „Wykonano” zapisuje odczyt i od razu ustawia kolejny termin.
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), modal = (...a) => U().modal(...a);
  const field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), chip = (...a) => U().chip(...a), fd = v => U().fd(v), fdt = v => U().fdt(v);
  const SCOPE = { podzielniki: 'Podzielniki', wodomierze: 'Wodomierze', cieplomierze: 'Ciepłomierze', wszystkie: 'Wszystkie urządzenia', inne: 'Inne' };
  const METHOD = { radiowy: 'Radiowy', wizualny: 'Wizualny (w lokalach)', zdalny: 'Zdalny (system)', inny: 'Inny' };
  const DEV = { podzielnik: 'Podzielniki', wodomierz: 'Wodomierze', cieplomierz: 'Ciepłomierze', modul_radiowy: 'Moduły radiowe', inny: 'Inne' };
  const KINDS = { wspolnota: 'Wspólnota', spoldzielnia: 'Spółdzielnia', zarzadca: 'Zarządca', firma: 'Firma', inny: 'Inny' };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const addMonths = (s, m) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Number(m || 12)); return d.toISOString().slice(0, 10); };
  const days = n => Math.abs(n) === 1 ? '1 dzień' : Math.abs(n) + ' dni';
  const who = p => p ? esc(p.full_name || p.login) : '–';
  const opt = (list, sel, label, value, empty) => (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
    list.map(x => `<option value="${esc(value(x))}"${String(sel || '') === String(value(x)) ? ' selected' : ''}>${esc(label(x))}</option>`).join('');

  function due(s) {
    if (!s.is_active) return chip('off', 'nieaktywny');
    const d = s.dni_do_terminu;
    return `<b class="${d < 0 ? 'txt-danger' : s.wkrotce ? 'txt-warn' : ''}">${esc(fd(s.next_due))}</b><div class="small ${d < 0 ? 'txt-danger' : 'muted'}">${d < 0 ? 'po terminie ' + days(d) : d === 0 ? 'dziś' : 'za ' + days(d)}</div>`;
  }

  // ==================== lista ====================
  const st = { widok: 'najblizsze', q: '', osoba: '', zakres: '', strona: 1 };
  async function tab(body, reload, alive) {
    const qs = new URLSearchParams(Object.entries({ widok: st.widok, q: st.q, osoba: st.osoba, zakres: st.zakres, strona: st.strona }).filter(([, v]) => v));
    const [sum, people, resp] = await Promise.all([api('odczyty/podsumowanie'), api('odczyty/osoby'), fetch('/api/odczyty?' + qs, { credentials: 'same-origin', cache: 'no-store' })]);
    if (!resp.ok) throw Object.assign(new Error((await resp.json().catch(() => ({}))).error || 'Nie udało się wczytać odczytów.'), { status: resp.status });
    const list = await resp.json(), total = +resp.headers.get('X-Total-Count') || 0, pages = Math.max(1, Math.ceil(total / 50));
    if (!alive()) return;
    const kpi = (label, v, tone, w) => `<button type="button" class="kpi kpi-${v ? tone : 'neutral'}"${w ? ` data-w="${w}"` : ' disabled'}><span class="kpi-v">${esc(v)}</span><span class="kpi-l">${esc(label)}</span></button>`;
    const VIEWS = [['najblizsze', 'Najbliższe 30 dni'], ['po_terminie', 'Po terminie'], ['aktywne', 'Wszystkie aktywne'], ['nieaktywne', 'Nieaktywne']];
    body.innerHTML = `<section class="kpis">
        ${kpi('Po terminie', sum.po_terminie, 'danger', 'po_terminie')}${kpi('W ciągu 7 dni', sum.w_7_dni, 'warn', 'najblizsze')}
        ${kpi('W ciągu 30 dni', sum.w_30_dni, 'blue', 'najblizsze')}${kpi('Bez osoby odpowiedzialnej', sum.bez_osoby, 'warn', 'aktywne')}
        ${kpi('Wykonane w tym miesiącu', sum.wykonane_w_miesiacu, 'ok')}${kpi('Obiekty aktywne', sum.aktywne, 'neutral', 'aktywne')}</section>
      <div class="seg seg-wrap" role="tablist" aria-label="Widok">${VIEWS.map(([k, v]) => `<button type="button" class="seg-b${st.widok === k ? ' seg-on' : ''}" data-w="${k}" role="tab" aria-selected="${st.widok === k}">${v}</button>`).join('')}</div>
      <form class="toolbar" id="rf"><label class="visually-hidden" for="rq">Szukaj</label><input id="rq" name="q" class="select-sm" placeholder="Szukaj: budynek, adres, miasto, klient" value="${esc(st.q)}">
        <label class="visually-hidden" for="ro">Osoba</label><select id="ro" name="osoba" class="select-sm"><option value="">Każda osoba</option><option value="brak"${st.osoba === 'brak' ? ' selected' : ''}>Bez osoby</option>${opt(people, st.osoba, p => (p.full_name || p.login) + ' (' + p.obiekty + ')', p => p.id)}</select>
        <label class="visually-hidden" for="rz">Zakres</label><select id="rz" name="zakres" class="select-sm"><option value="">Każdy zakres</option>${Object.entries(SCOPE).map(([k, v]) => `<option value="${k}"${st.zakres === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button><button type="button" class="btn btn-primary btn-sm" id="r-new">Dodaj obiekt</button>
        <a class="btn btn-secondary btn-sm btn-xl" href="/api/odczyty/eksport" download>Eksport do Excela</a>
        ${U().has('readings.admin') ? '<button type="button" class="btn btn-ghost btn-sm" id="r-set">Przypomnienia</button>' : ''}</form>
      <p class="muted small">Przypomnienie przychodzi ${esc(days(sum.remind_days))} przed terminem (albo z wyprzedzeniem ustawionym przy obiekcie) do osoby odpowiedzialnej; po terminie także do kierownika.</p>
      <section class="panel">${list.length ? `<div class="table-wrap"><table class="table table-cards"><thead><tr><th>Obiekt</th><th>Zakres</th><th>Ostatni odczyt</th><th>Kolejny termin</th><th>Odpowiedzialny</th><th></th></tr></thead><tbody>
        ${list.map(s => `<tr class="${s.is_active ? '' : 'row-off'}">
          <td data-label="Obiekt"><button type="button" class="linkish" data-open="${s.id}">${esc(s.building_name)}</button><div class="muted small">${esc(s.address)}${s.city ? ', ' + esc(s.city) : ''}${s.customer_name ? ' · ' + esc(s.customer_name) : ''}</div></td>
          <td data-label="Zakres">${esc(SCOPE[s.scope])}<div class="muted small">${esc(METHOD[s.method])} · co ${esc(s.cycle_months)} mies.</div></td>
          <td data-label="Ostatni odczyt">${s.last_done ? esc(fd(s.last_done)) : '<span class="muted">–</span>'}${s.last_reading && s.last_reading.result === 'czesciowy' ? `<div>${chip('warn', 'częściowy: ' + s.last_reading.missing_units + ' lok.')}</div>` : ''}</td>
          <td data-label="Kolejny termin">${due(s)}</td>
          <td data-label="Odpowiedzialny" class="small">${s.assigned_to ? esc(s.assigned_name || s.assigned_login) : '<span class="txt-warn">nie przypisano</span>'}</td>
          <td class="nowrap td-actions">${s.is_active ? `<button type="button" class="btn btn-primary btn-sm" data-done="${s.id}">Wykonano</button><button type="button" class="btn btn-secondary btn-sm" data-devread="${s.id}">Odczyty urządzeń</button>` : ''}<button type="button" class="btn btn-ghost btn-sm" data-open="${s.id}">Szczegóły</button></td></tr>`).join('')}
        </tbody></table></div>` : `<p class="empty-inline">${st.widok === 'najblizsze' ? 'Brak odczytów w najbliższych 30 dniach.' : 'Brak obiektów w tym widoku.'} Dodaj obiekt przyciskiem „Dodaj obiekt”.</p>`}
        <p class="muted small list-count">Razem: <b>${esc(total)}</b>${pages > 1 ? ` · strona ${st.strona} z ${pages}` : ''}</p>
        ${pages > 1 ? `<nav class="pager" aria-label="Strony"><button type="button" class="btn btn-secondary btn-sm" data-pg="-1"${st.strona <= 1 ? ' disabled' : ''}>← Poprzednia</button>
          <button type="button" class="btn btn-secondary btn-sm" data-pg="1"${st.strona >= pages ? ' disabled' : ''}>Następna →</button></nav>` : ''}</section>`;
    body.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', () => { st.widok = b.dataset.w; st.strona = 1; reload(); }));
    body.querySelector('#rf').addEventListener('submit', e => { e.preventDefault(); st.q = val(e.target, 'q').trim(); st.osoba = val(e.target, 'osoba'); st.zakres = val(e.target, 'zakres'); st.strona = 1; reload(); });
    body.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => { st.strona += Number(b.dataset.pg); reload(); }));
    body.querySelector('#r-new').addEventListener('click', () => objectForm(null, people, sum, reload));
    const set = body.querySelector('#r-set'); if (set) set.addEventListener('click', () => settingsForm(sum, reload));
    body.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', () => doneForm(list.find(s => s.id === b.dataset.done), people, reload)));
    body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => card(b.dataset.open, people, sum, reload)));
    body.querySelectorAll('[data-devread]').forEach(b => b.addEventListener('click', () => window.MXT_ERP.deviceReadings(b.dataset.devread)));
    const z = new URLSearchParams(location.search).get('z');
    if (z) { history.replaceState({}, '', location.pathname); card(z, people, sum, reload); }
  }

  // ==================== „Wykonano” – zapis odczytu i kolejny termin ====================
  function doneForm(s, people, after) {
    const me = U().me();
    modal('Odczyt wykonany – ' + s.building_name, `
      <p class="muted small">${esc(SCOPE[s.scope])} · termin ${esc(fd(s.next_due))} · cykl co ${esc(s.cycle_months)} mies. Kolejny termin wyliczy się z daty odczytu – możesz go zmienić.</p>
      <div class="field-row">${field('d-at', 'Data odczytu', `<input id="d-at" name="done_at" type="date" required max="${today()}" value="${today()}">`)}
        ${field('d-next', 'Kolejny termin', `<input id="d-next" name="next_due" type="date" required value="${addMonths(today(), s.cycle_months)}">`)}</div>
      <div class="field-row">${field('d-res', 'Wynik', '<select id="d-res" name="result"><option value="pelny">Pełny – wszystkie lokale</option><option value="czesciowy">Częściowy – część lokali bez odczytu</option></select>')}
        ${field('d-by', 'Wykonał(a)', `<select id="d-by" name="done_by">${opt(people, me.id, p => p.full_name || p.login, p => p.id)}</select>`)}</div>
      <div id="d-part" hidden>${field('d-miss', 'Lokale bez odczytu (liczba)', '<input id="d-miss" name="missing_units" type="number" min="0" step="1" inputmode="numeric">')}</div>
      ${field('d-note', 'Uwagi (opcjonalnie)', '<textarea id="d-note" name="note" rows="2" maxlength="1000" placeholder="np. brak dostępu do lok. 4 i 12"></textarea>')}`,
    { submit: 'Zapisz odczyt', onSubmit: async f => {
      const b = { done_at: val(f, 'done_at'), next_due: val(f, 'next_due'), result: val(f, 'result'), done_by: val(f, 'done_by'), note: val(f, 'note') };
      if (b.result === 'czesciowy') b.missing_units = val(f, 'missing_units');
      const r = await api('odczyty/' + s.id + '/wykonano', b);
      toast(`Zapisano odczyt. Kolejny termin: ${fd(r.schedule.next_due)}.`); after();
    } });
    const box = document.getElementById('modal-box');
    box.querySelector('#d-at').addEventListener('change', e => { if (e.target.value) box.querySelector('#d-next').value = addMonths(e.target.value, s.cycle_months); });
    box.querySelector('#d-res').addEventListener('change', e => { box.querySelector('#d-part').hidden = e.target.value !== 'czesciowy'; });
  }

  // ==================== dodanie / edycja obiektu ====================
  async function objectForm(s, people, sum, after) {
    const isNew = !s, d = s || { scope: 'podzielniki', method: 'radiowy', cycle_months: sum.cycle_months };
    const [blds, custs] = await Promise.all([isNew ? api('odczyty/budynki') : [], api('odczyty/klienci')]);
    modal(isNew ? 'Dodaj obiekt do odczytów' : 'Edycja – ' + s.building_name, `
      ${isNew ? `${field('o-b', 'Budynek', `<select id="o-b" name="building_id"><option value="">+ Nowy budynek…</option>${opt(blds, '', b => `${b.name} – ${b.address}${b.city ? ', ' + b.city : ''}${(b.scopes || []).length ? ' (ma: ' + b.scopes.map(x => SCOPE[x].toLowerCase()).join(', ') + ')' : ''}`, b => b.id)}</select>`)}
        <div id="o-newb" class="subform"><p class="label-sm">Nowy budynek (trafi do wspólnej ewidencji budynków)</p>
          ${field('o-bn', 'Nazwa', '<input id="o-bn" name="b_name" maxlength="200" placeholder="np. Wspólnota Brzozowa 1">')}
          <div class="field-row">${field('o-ba', 'Adres', '<input id="o-ba" name="b_address" maxlength="300">')}${field('o-bc', 'Miasto', '<input id="o-bc" name="b_city" maxlength="100">')}</div>
          <div class="field-row">${field('o-bp', 'Kod pocztowy', '<input id="o-bp" name="b_postal" maxlength="10">')}${field('o-bu', 'Liczba lokali', '<input id="o-bu" name="b_units" type="number" min="0" inputmode="numeric">')}</div></div>` : ''}
      ${field('o-c', 'Klient (zleceniodawca odczytów)', `<select id="o-c" name="customer_id"><option value="">${isNew ? '– jak w budynku –' : '– brak –'}</option><option value="__new">+ Nowy klient…</option>${opt(custs, d.customer_id, c => c.name + ' (' + (KINDS[c.kind] || c.kind) + ')', c => c.id)}</select>`)}
      <div id="o-newc" class="subform" hidden><div class="field-row">${field('o-cn', 'Nazwa klienta', '<input id="o-cn" name="c_name" maxlength="200">')}
        ${field('o-ck', 'Rodzaj', `<select id="o-ck" name="c_kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`)}</div>
        ${field('o-cp', 'Telefon klienta', '<input id="o-cp" name="c_phone" maxlength="50">')}</div>
      <div class="field-row">${field('o-s', 'Zakres', `<select id="o-s" name="scope">${Object.entries(SCOPE).map(([k, v]) => `<option value="${k}"${d.scope === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${field('o-m', 'Sposób odczytu', `<select id="o-m" name="method">${Object.entries(METHOD).map(([k, v]) => `<option value="${k}"${d.method === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      <div class="field-row">${field('o-cy', 'Cykl (co ile miesięcy)', `<input id="o-cy" name="cycle_months" type="number" min="1" max="60" step="1" required value="${esc(d.cycle_months)}">`)}
        ${field('o-n', 'Kolejny termin', `<input id="o-n" name="next_due" type="date" required value="${esc(d.next_due || '')}">`)}</div>
      ${isNew ? field('o-l', 'Data ostatniego odczytu (opcjonalnie – jeśli był)', '<input id="o-l" name="last_done" type="date">') : ''}
      <div class="field-row">${field('o-p', 'Osoba odpowiedzialna', `<select id="o-p" name="assigned_to">${opt(people, d.assigned_to, p => (p.full_name || p.login) + (p.zespol_odczytow ? ' – odczyty' : ''), p => p.id, '– zespół odczytów –')}</select>`)}
        ${field('o-r', `Przypomnienie (dni przed; puste = ${sum.remind_days})`, `<input id="o-r" name="remind_days" type="number" min="0" max="120" step="1" inputmode="numeric" value="${esc(d.remind_days == null ? '' : d.remind_days)}">`)}</div>
      ${field('o-k', 'Kontakt na miejscu (zarządca, gospodarz, telefon)', `<input id="o-k" name="contact" maxlength="300" value="${esc(d.contact || '')}">`)}
      ${field('o-a', 'Dostęp do budynku (klucze, kod do bramy, godziny)', `<input id="o-a" name="access_notes" maxlength="1000" value="${esc(d.access_notes || '')}">`)}
      ${field('o-u', 'Uwagi', `<textarea id="o-u" name="notes" rows="2" maxlength="2000">${esc(d.notes || '')}</textarea>`)}
      ${isNew ? '' : `<label class="toggle"><input type="checkbox" name="is_active"${d.is_active ? ' checked' : ''}> Obiekt aktywny (nieaktywny nie ma terminów ani przypomnień)</label>`}`,
    { submit: isNew ? 'Dodaj obiekt' : 'Zapisz', wide: true, onSubmit: async f => {
      let customer = val(f, 'customer_id');
      if (customer === '__new') {
        if (!val(f, 'c_name').trim()) throw new Error('Podaj nazwę nowego klienta.');
        customer = (await api('odczyty/klienci', { name: val(f, 'c_name'), kind: val(f, 'c_kind'), phone: val(f, 'c_phone') })).id;
      }
      const b = { customer_id: customer || null, scope: val(f, 'scope'), method: val(f, 'method'), cycle_months: val(f, 'cycle_months'), next_due: val(f, 'next_due'),
        assigned_to: val(f, 'assigned_to') || null, remind_days: val(f, 'remind_days'), contact: val(f, 'contact'), access_notes: val(f, 'access_notes'), notes: val(f, 'notes') };
      if (isNew) {
        b.last_done = val(f, 'last_done') || null;
        if (val(f, 'building_id')) b.building_id = val(f, 'building_id');
        else b.building = { name: val(f, 'b_name'), address: val(f, 'b_address'), city: val(f, 'b_city'), postal_code: val(f, 'b_postal'), units_count: val(f, 'b_units'), customer_id: customer || null };
        await api('odczyty', b); toast('Obiekt dodany do odczytów.');
      } else {
        b.is_active = f.querySelector('[name=is_active]').checked;
        await api('odczyty/' + s.id, b, 'PATCH'); toast('Zapisano zmiany.');
      }
      after();
    } });
    const box = document.getElementById('modal-box');
    const sel = box.querySelector('#o-b');
    if (sel) sel.addEventListener('change', () => { box.querySelector('#o-newb').hidden = !!sel.value; });
    box.querySelector('#o-c').addEventListener('change', e => { box.querySelector('#o-newc').hidden = e.target.value !== '__new'; });
  }
  function settingsForm(sum, after) {
    modal('Przypomnienia o odczytach', `
      ${field('st-r', 'Domyślne wyprzedzenie przypomnienia (dni przed terminem)', `<input id="st-r" name="remind_days" type="number" min="0" max="120" step="1" required value="${esc(sum.remind_days)}">`)}
      ${field('st-c', 'Domyślny cykl nowych obiektów (miesiące)', `<input id="st-c" name="cycle_months" type="number" min="1" max="60" step="1" required value="${esc(sum.cycle_months)}">`)}
      <p class="muted small">Obiekt może mieć własne wyprzedzenie (pole „Przypomnienie” w obiekcie). Każde przypomnienie przychodzi raz na termin; po terminie – także do kierownika.</p>`,
    { submit: 'Zapisz', onSubmit: async f => { await api('odczyty/ustawienia', { remind_days: Number(val(f, 'remind_days')), cycle_months: Number(val(f, 'cycle_months')) }, 'PUT'); toast('Zapisano ustawienia.'); after(); } });
  }

  // ==================== karta obiektu ====================
  async function card(id, people, sum, reload) {
    let s;
    try { s = await api('odczyty/' + id); } catch (e) { toast(e.message); return; }
    const again = () => { reload(); card(id, people, sum, reload); };
    const active = s.history.find(h => !h.cancelled_at);
    modal(s.building_name + ' – ' + SCOPE[s.scope].toLowerCase(), `
      <p class="card-chips">${s.is_active ? (s.po_terminie ? chip('deny', 'po terminie') : s.wkrotce ? chip('warn', 'termin wkrótce') : chip('ok', 'zaplanowany')) : chip('off', 'nieaktywny')}</p>
      <div class="job-addr"><b>${esc(s.building_name)}</b><span>${esc(s.address)}${s.city ? ', ' + esc(s.postal_code ? s.postal_code + ' ' : '') + esc(s.city) : ''}</span>
        ${s.customer_name ? `<span class="muted small">Klient: ${esc(s.customer_name)}</span>` : ''}
        <a class="btn btn-secondary btn-sm" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.address, s.city].filter(Boolean).join(', '))}" target="_blank" rel="noopener">Nawiguj (mapy)</a></div>
      <dl class="kv"><dt>Kolejny termin</dt><dd>${esc(fd(s.next_due))}${s.is_active ? ` · ${s.dni_do_terminu < 0 ? '<b class="txt-danger">po terminie ' + days(s.dni_do_terminu) + '</b>' : 'za ' + days(s.dni_do_terminu)}` : ''}</dd>
        <dt>Ostatni odczyt</dt><dd>${esc(s.last_done ? fd(s.last_done) : '–')}</dd><dt>Zakres i sposób</dt><dd>${esc(SCOPE[s.scope])} · ${esc(METHOD[s.method])} · co ${esc(s.cycle_months)} mies.</dd>
        <dt>Odpowiedzialny</dt><dd>${s.assigned_to ? esc(s.assigned_name || s.assigned_login) : 'zespół odczytów'}</dd>
        <dt>Przypomnienie</dt><dd>${esc(days(s.wyprzedzenie))} przed terminem</dd>
        <dt>Lokale / urządzenia</dt><dd>${esc(s.units_count || '–')} lokali${s.devices_by_type.length ? ' · ' + s.devices_by_type.map(x => esc(DEV[x.type] || x.type) + ': ' + esc(x.n)).join(', ') : ''}</dd>
        ${s.contact ? `<dt>Kontakt</dt><dd>${esc(s.contact)}</dd>` : ''}${s.access_notes ? `<dt>Dostęp</dt><dd>${esc(s.access_notes)}</dd>` : ''}${s.notes ? `<dt>Uwagi</dt><dd class="pre-wrap">${esc(s.notes)}</dd>` : ''}</dl>
      <div class="card-actions" id="rc-actions">
        ${s.is_active ? '<button type="button" class="btn btn-primary btn-sm" data-a="done">Wykonano</button>' : ''}
        <button type="button" class="btn btn-secondary btn-sm" data-a="devread">Odczyty urządzeń</button>
        <button type="button" class="btn btn-secondary btn-sm" data-a="edit">Edytuj</button>
        ${active && U().has('readings.admin') ? '<button type="button" class="btn btn-ghost btn-sm" data-a="undo">Cofnij ostatni odczyt</button>' : ''}</div>
      <p class="label-sm">Historia odczytów (${s.history.length})</p>
      ${s.history.length ? `<ol class="timeline">${s.history.map(h => `<li><span class="tl-dot${h.cancelled_at ? ' tl-odrzucenie' : h.result === 'czesciowy' ? ' tl-zmiana' : ' tl-wykonanie'}"></span><div>
        <b>${esc(fd(h.done_at))}</b> · ${esc(h.result === 'czesciowy' ? 'częściowy (' + h.missing_units + ' lok. bez odczytu)' : 'pełny')} · ${esc(h.done_by_name || '–')}
        <div class="tl-note">termin ${esc(fd(h.due_date))} → kolejny ${esc(fd(h.next_due))}${h.note ? ' · ' + esc(h.note) : ''}</div>
        ${h.cancelled_at ? `<div class="tl-note txt-danger">cofnięty ${esc(fdt(h.cancelled_at))} (${esc(h.cancelled_by_name || '')}): ${esc(h.cancel_reason)}</div>` : ''}</div></li>`).join('')}</ol>` : '<p class="empty-inline">Brak zapisanych odczytów.</p>'}`, { wide: true });
    const box = document.getElementById('rc-actions');
    const on = (a, fn) => { const b = box.querySelector(`[data-a="${a}"]`); if (b) b.addEventListener('click', fn); };
    on('done', () => doneForm(s, people, again));
    on('edit', () => objectForm(s, people, sum, again));
    on('devread', () => window.MXT_ERP.deviceReadings(s.id));
    on('undo', () => modal('Cofnąć ostatni odczyt?', `<p>Odczyt z ${esc(fd(active.done_at))} zostanie oznaczony jako cofnięty (zostaje w historii), a termin wróci do ${esc(fd(active.prev_next_due))}.</p>
      ${field('u-r', 'Powód', '<input id="u-r" name="powod" required maxlength="500">')}`,
      { submit: 'Cofnij odczyt', danger: true, onSubmit: async f => { if (!val(f, 'powod').trim()) throw new Error('Podaj powód.'); await api('odczyty/' + s.id + '/cofnij', { powod: val(f, 'powod') }); toast('Odczyt cofnięty.'); again(); } }));
  }

  // Ekran dla roli „Obsługa odczytów” (i dostępny dla biura w menu modułów).
  async function page(root, path, alive) {
    const body = U().frame(root, path, 'Odczyty', 'Obiekty, terminy odczytów i ich wykonanie. „Wykonano” od razu ustawia kolejny termin.');
    await tab(body, () => U().render(path, root), alive);
  }
  window.MXT_ODCZYTY = { tab };
  window.MXT_MODULES.register('/odczyty', { title: 'Odczyty', perm: 'readings.manage', render: page }, { tab: true });
})();
