'use strict';
// ERP – Pracownicy (kierownik): kartoteka i obciążenie, nieobecności, czas pracy zespołu.
// „Mój czas pracy” (każdy z uprawnieniem time.own): własne wpisy godzin na zlecenia i projekty.
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b), has = p => U().has(p);
  const fd = v => U().fd(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => n == null ? '–' : U().money(n, 'PLN');
  const h = n => String(Math.round(Number(n || 0) * 100) / 100).replace('.', ',');
  const EMP = { '': '–', umowa_o_prace: 'Umowa o pracę', zlecenie: 'Umowa zlecenie', b2b: 'B2B', inne: 'Inne' };
  const ABS = { urlop: 'Urlop', l4: 'Zwolnienie lekarskie', szkolenie: 'Szkolenie', delegacja: 'Delegacja', inne: 'Inne' };
  const REL = { installation: 'Montaż', service_order: 'Serwis', reading: 'Odczyt', project: 'Projekt', inne: 'Inne' };
  const TABS = [['kartoteka', 'Kartoteka i obciążenie', '', 'Kartoteka'], ['nieobecnosci', 'Nieobecności', '', 'Nieobecności'], ['czas', 'Czas pracy zespołu', '', 'Czas pracy']];
  const td = (label, html, cls) => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;
  const ctable = (head, rows, empty) => rows.length ? `<div class="table-wrap"><table class="table table-cards"><thead><tr>${head.map(x => `<th${x.num ? ' class="num"' : ''}>${esc(x.t || x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty-inline">${esc(empty)}</p>`;
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');   // data lokalna, nie UTC
  let tab = 'kartoteka';
  const st = { od: iso(new Date(Date.now() - 30 * 864e5)), osoba: '', wyl: false };

  async function page(root, path, alive) {
    const body = U().deptFrame(root, 'Pracownicy', TABS, tab, t => { tab = t; reload(); });
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await ({ kartoteka, nieobecnosci, czas }[tab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel); U().wsHoist(root);
    const p = new URLSearchParams(location.search).get('p');
    if (location.search) history.replaceState({}, '', location.pathname);
    if (p && tab === 'kartoteka') { const b = panel.querySelector(`[data-e="${p}"]`); if (b) b.click(); }
  }

  async function kartoteka(body, reload, alive) {
    const d = await api('pracownicy?od=' + st.od);
    if (!alive()) return;
    const act = d.rows.filter(x => x.is_active), off = d.rows.length - act.length, adm = has('users.manage');
    const rows = st.wyl ? d.rows : act;
    body.innerHTML = `<p data-ws-sub>${act.length} aktywnych kont · godziny od ${esc(fd(d.from))} · ${act.filter(x => x.nieobecnosc).length} nieobecnych dziś</p>
      ${adm ? '<div data-ws-actions hidden><button type="button" class="btn btn-primary" id="e-new">Nowe konto pracownika</button></div>' : ''}
      ${off ? `<label class="toggle"><input type="checkbox" id="e-off"${st.wyl ? ' checked' : ''}> Pokaż wyłączone konta (${off})</label>` : ''}
      <section class="panel">${ctable(['Pracownik', 'Rola', 'Stanowisko', { t: 'Stawka', num: 1 }, { t: 'Serwisy', num: 1 }, { t: 'Montaże 14 dni', num: 1 }, { t: 'Odczyty 30 dni', num: 1 }, { t: 'Godziny', num: 1 }, 'Dziś', ''], rows.map(x => `<tr class="${x.is_active ? '' : 'row-off'}">
        ${td('Pracownik', `<button type="button" class="linkish" data-e="${esc(x.id)}">${esc(x.full_name || x.login)}</button><div class="muted small">${esc([x.login, x.phone].filter(Boolean).join(' · '))}</div>`)}
        ${td('Rola', esc([x.role, ...(x.extra_roles || [])].map(r => d.roles[r] || r).join(' + ')))}${td('Stanowisko', esc(x.position || '–') + (x.employment ? `<div class="muted small">${esc(EMP[x.employment])}</div>` : ''))}
        ${td('Stawka', x.hourly_rate != null ? esc(pln(x.hourly_rate)) + '/h' : '<span class="muted">–</span>', 'num')}${td('Serwisy otwarte', esc(x.serwisy_otwarte), 'num')}${td('Montaże 14 dni', esc(x.montaze_14d), 'num')}
        ${td('Odczyty 30 dni', esc(x.odczyty_30d), 'num')}${td('Godziny', esc(h(x.godziny)), 'num')}${td('Dziś', x.nieobecnosc ? chip('warn', `${ABS[x.nieobecnosc.kind]} do ${fd(x.nieobecnosc.date_to)}`) : x.is_active ? chip('ok', 'dostępny') : chip('off', 'konto wyłączone'))}
        ${td('', `<button type="button" class="btn btn-ghost btn-sm" data-e="${esc(x.id)}">Edytuj</button>`, 'td-actions')}</tr>`), 'Brak kont.')}</section>
      <p class="muted small">${adm ? 'Edytuj: dane kadrowe (stanowisko, stawka, forma zatrudnienia) oraz konto – imię i nazwisko, kontakt, role, wyłączenie konta. Konto bez historii (np. założone przez pomyłkę) można usunąć; konto z historią się wyłącza, a wpisy pracownika zostają.'
        : 'Edytuj: dane kadrowe do planowania i kosztu robocizny (stawka × godziny w projektach). Konta, role i wyłączanie kont – administrator.'}</p>`;
    const accForm = async x => {
      const [M, inst] = await Promise.all([U().meta(), api('konta/instalatorzy')]);
      window.MXT_KONTA.accountForm(x, M, inst, reload);
    };
    const nb = body.querySelector('#e-new'); if (nb) nb.addEventListener('click', () => accForm(null).catch(e => toast(e.message)));
    const ob = body.querySelector('#e-off'); if (ob) ob.addEventListener('change', () => { st.wyl = ob.checked; reload(); });
    body.querySelectorAll('[data-e]').forEach(b => b.addEventListener('click', () => {
      const x = d.rows.find(r => r.id === b.dataset.e), self = x.id === U().me().id;
      const box = modal('Pracownik – ' + (x.full_name || x.login), `${adm ? `<div class="ap-actions"><button type="button" class="btn btn-secondary btn-sm" id="e-acc">Edytuj konto (dane, kontakt, role)</button>
          ${self ? '' : `<button type="button" class="btn btn-secondary btn-sm" id="e-tog">${x.is_active ? 'Wyłącz konto' : 'Włącz konto'}</button><button type="button" class="btn btn-ghost btn-sm" id="e-del">Usuń konto</button>`}</div>` : ''}
        <h3 class="panel-title">Dane kadrowe</h3>
        <div class="field-row">${field('e-p', 'Stanowisko', `<input id="e-p" name="position" maxlength="100" value="${esc(x.position || '')}">`)}
        ${field('e-r', 'Koszt godziny pracy (PLN)', `<input id="e-r" name="hourly_rate" type="number" min="0" step="0.01" value="${esc(x.hourly_rate ?? '')}">`)}</div>
        <div class="field-row">${field('e-e', 'Forma zatrudnienia', `<select id="e-e" name="employment">${Object.entries(EMP).map(([k, v]) => `<option value="${k}"${(x.employment || '') === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
          ${field('e-h', 'Data zatrudnienia', `<input id="e-h" name="hired_at" type="date" value="${esc(x.hired_at ? String(x.hired_at).slice(0, 10) : '')}">`)}</div>
        ${field('e-n', 'Notatki kadrowe', `<textarea id="e-n" name="hr_notes" rows="3" maxlength="2000">${esc(x.hr_notes || '')}</textarea>`)}
        <p class="muted small">Stawka liczy koszt robocizny dla nowych wpisów czasu pracy (wcześniejsze wpisy zachowują stawkę z dnia wpisu).</p>`,
      { submit: 'Zapisz dane kadrowe', wide: adm, onSubmit: async f => { await api('pracownicy/' + x.id, { updated_at: x.updated_at, position: val(f, 'position'), hourly_rate: val(f, 'hourly_rate'), employment: val(f, 'employment'), hired_at: val(f, 'hired_at') || null, hr_notes: val(f, 'hr_notes') }, 'PATCH'); toast('Kartoteka zapisana.'); reload(); } });
      const on = (sel, fn) => { const el = box.querySelector(sel); if (el) el.addEventListener('click', () => fn().catch(e => toast(e.message))); };
      on('#e-acc', () => accForm(x));
      on('#e-tog', async () => {
        if (x.is_active) {
          modal('Wyłączyć konto ' + x.login + '?', '<p>Pracownik zostanie wylogowany ze wszystkich urządzeń i nie zaloguje się ponownie. Jego wpisy (montaże, serwisy, czas pracy, dokumenty) zostają. Konto można później włączyć.</p>',
            { submit: 'Wyłącz konto', danger: true, onSubmit: async () => { await api('konta/' + x.id, { is_active: false }, 'PATCH'); toast('Konto wyłączone i wylogowane.'); reload(); } });
        } else { await api('konta/' + x.id, { is_active: true }, 'PATCH'); document.getElementById('modal').hidden = true; toast('Konto włączone.'); reload(); }
      });
      on('#e-del', async () => {
        const hist = await api('konta/' + x.id + '/historia');
        if (hist.length) { toast('Konto ma historię (' + hist.map(([l, n]) => l + ': ' + n).join(', ') + ') – nie można go usunąć. Użyj „Wyłącz konto”: wpisy pracownika zostaną.'); return; }
        modal('Usunąć konto ' + x.login + '?', `<p>Konto <b>${esc(x.full_name || x.login)}</b> nie ma żadnych wpisów w systemie. Usunięcie jest nieodwracalne.</p>`,
          { submit: 'Usuń konto', danger: true, onSubmit: async () => { await api('konta/' + x.id, null, 'DELETE'); toast('Konto usunięte.'); reload(); } });
      });
    }));
  }

  async function nieobecnosci(body, reload, alive) {
    const [list, M] = await Promise.all([api('nieobecnosci'), U().meta()]);
    if (!alive()) return;
    body.innerHTML = `<p data-ws-sub>Bieżące i zaplanowane nieobecności (${list.length})</p>
      <div data-ws-actions hidden><button type="button" class="btn btn-primary" id="ab-new">Dodaj nieobecność</button></div>
      <section class="panel">${ctable(['Pracownik', 'Rodzaj', 'Od', 'Do', 'Uwagi', ''], list.map(a => `<tr>${td('Pracownik', esc(a.name))}${td('Rodzaj', esc(ABS[a.kind]))}${td('Od', esc(fd(a.date_from)))}${td('Do', esc(fd(a.date_to)))}${td('Uwagi', esc(a.note || '–'))}
        ${td('', `<button type="button" class="btn btn-ghost btn-sm" data-del="${esc(a.id)}">Usuń</button>`, 'td-actions')}</tr>`), 'Brak zaplanowanych nieobecności.')}</section>
      <p class="muted small">Nieobecny pracownik jest oznaczony na pulpicie działu i w kartotece – przydzielając zlecenia, sprawdź dostępność.</p>`;
    body.querySelector('#ab-new').addEventListener('click', () => modal('Nieobecność', `${field('a-u', 'Pracownik', `<select id="a-u" name="u" required><option value="">– wybierz –</option>${M.users.filter(u => u.is_active !== false).map(u => `<option value="${esc(u.id)}">${esc(u.full_name || u.login)}</option>`).join('')}</select>`)}
      <div class="field-row">${field('a-k', 'Rodzaj', `<select id="a-k" name="k">${Object.entries(ABS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`)}${field('a-f', 'Od', '<input id="a-f" name="f" type="date" required>')}${field('a-t', 'Do', '<input id="a-t" name="t" type="date" required>')}</div>
      ${field('a-n', 'Uwagi', '<input id="a-n" name="n" maxlength="500">')}`,
    { submit: 'Zapisz', onSubmit: async f => { await api('nieobecnosci', { user_id: val(f, 'u'), kind: val(f, 'k'), date_from: val(f, 'f'), date_to: val(f, 't'), note: val(f, 'n') }); toast('Nieobecność zapisana.'); reload(); } }));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { try { await api('nieobecnosci/' + b.dataset.del, null, 'DELETE'); toast('Usunięto.'); reload(); } catch (e) { toast(e.message); } }));
  }

  async function czas(body, reload, alive, own) {
    const q = new URLSearchParams({ od: st.od, ...(st.osoba && !own ? { osoba: st.osoba } : {}) });
    const [d, M] = await Promise.all([api('czas?' + q), own ? null : U().meta()]);
    if (!alive()) return;
    body.innerHTML = `<p data-ws-sub>${esc(h(d.total_hours))} h od ${esc(fd(st.od))}${d.total_cost != null ? ' · koszt robocizny ' + esc(pln(d.total_cost)) : ''}</p>
      <div data-ws-actions hidden><button type="button" class="btn btn-primary" id="t-new">Dodaj czas pracy</button></div>
      <form class="toolbar" id="tf"><label class="visually-hidden" for="t-od">Od</label><input id="t-od" name="od" type="date" class="select-sm" value="${esc(st.od)}">
        ${own ? '' : `<label class="visually-hidden" for="t-os">Pracownik</label><select id="t-os" name="osoba" class="select-sm"><option value="">Wszyscy</option>${M.users.map(u => `<option value="${esc(u.id)}"${st.osoba === u.id ? ' selected' : ''}>${esc(u.full_name || u.login)}</option>`).join('')}</select>`}
        <button type="submit" class="btn btn-secondary btn-sm">Pokaż</button></form>
      <section class="panel">${ctable([...(own ? [] : ['Pracownik']), 'Data', { t: 'Godziny', num: 1 }, 'Czego dotyczy', 'Projekt', 'Opis', ...(d.team ? [{ t: 'Koszt', num: 1 }] : []), ''], d.rows.map(t => `<tr>
        ${own ? '' : td('Pracownik', esc(t.name))}${td('Data', esc(fd(t.work_date)))}${td('Godziny', esc(h(t.hours)), 'num')}${td('Czego dotyczy', esc(REL[t.related_type]) + (t.related_number ? ' ' + esc(t.related_number) : ''))}
        ${td('Projekt', esc(t.project_number || '–'))}${td('Opis', esc(t.note || '–'))}${d.team ? td('Koszt', esc(pln(t.cost)), 'num') : ''}
        ${td('', `<button type="button" class="btn btn-ghost btn-sm" data-del="${esc(t.id)}">Usuń</button>`, 'td-actions')}</tr>`), 'Brak wpisów w tym okresie.')}</section>`;
    body.querySelector('#tf').addEventListener('submit', e => { e.preventDefault(); st.od = val(e.target, 'od') || st.od; if (!own) st.osoba = val(e.target, 'osoba'); reload(); });
    body.querySelector('#t-new').addEventListener('click', () => window.MXT_ERP.timeForm({}, reload));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { try { await api('czas/' + b.dataset.del, null, 'DELETE'); toast('Wpis usunięty.'); reload(); } catch (e) { toast(e.message); } }));
  }
  // Mój czas pracy – zwykły ekran modułu (bez menu działu), dostępny dla wszystkich ról z ewidencją czasu.
  async function myTime(root, path, alive) {
    const body = U().frame(root, path, 'Mój czas pracy', 'Godziny przepracowane na zleceniach i projektach. Wpis można usunąć do 7 dni od dodania.',
      '<div class="mt-act"></div>');
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await czas(panel, reload, alive, true);
    if (!alive()) return;
    const actions = panel.querySelector('[data-ws-actions]'), sub = panel.querySelector('[data-ws-sub]');
    root.querySelector('.mt-act').replaceChildren(...actions.childNodes); actions.remove();
    sub.hidden = false; sub.className = 'muted';
    body.replaceChildren(panel);
  }

  window.MXT_MODULES.register('/pracownicy', { title: 'Pracownicy', perm: 'employees.manage', render: page, ws: true }, { menu: true });
  window.MXT_MODULES.register('/moj-czas', { title: 'Mój czas pracy', perm: 'time.own', render: myTime }, { menu: true });
})();
