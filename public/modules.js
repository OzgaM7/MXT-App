'use strict';
// Moduły MXT Business OS – etap 1: Command Center, Zadania, Moje wnioski, Approval Center, Security & Audit, Ustawienia AI.
// Widoczność w interfejsie wynika z uprawnień z backendu; o dostępie zawsze decyduje serwer (403 + wpis w audycie).
(() => {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (...a) => window.MXT.api(...a);
  const go = p => window.MXT.go(p);
  const toast = m => window.MXT.toast(m);
  const me = () => window.MXT.user();
  const has = p => !!me() && (me().permissions || []).includes(p);
  let META = null;
  const meta = async () => META || (META = await api('meta'));

  // ---------- formatowanie ----------
  const dtf = new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const df = new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fdt = v => v ? dtf.format(new Date(v)) : '–';
  const fd = v => v ? df.format(new Date(String(v).slice(0, 10) + 'T12:00:00')) : '–';
  const money = (a, c) => a == null ? '' : new Intl.NumberFormat('pl-PL', { style: 'currency', currency: c || 'PLN' }).format(Number(a));
  const TASK_ST = { nowe: 'Nowe', w_toku: 'W toku', zakonczone: 'Zakończone', anulowane: 'Anulowane' };
  const PRIO = { pilny: 'Pilny', wysoki: 'Wysoki', normalny: 'Normalny', niski: 'Niski' };
  const AP_ST = { oczekuje: 'Oczekuje', zatwierdzona: 'Zatwierdzona', odrzucona: 'Odrzucona', wykonana: 'Wykonana', wycofana: 'Wycofana' };
  const EV = { utworzenie: 'Zgłoszenie', zmiana: 'Zmiana treści', zatwierdzenie: 'Zatwierdzenie', odrzucenie: 'Odrzucenie', wykonanie: 'Wykonanie', wycofanie: 'Wycofanie' };
  const chip = (cls, txt) => `<span class="chip chip-${esc(cls)}">${esc(txt)}</span>`;
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- nawigacja modułów ----------
  const ROUTES = {
    '/command-center': { title: 'Command Center', perm: 'command.view', render: commandCenter },
    '/zadania': { title: 'Zadania', perm: 'tasks.use', render: tasksPage },
    '/ai-board': { title: 'AI Board', perm: 'command.view', render: aiBoard },
    '/ai-workforce': { title: 'AI Workforce', perm: 'command.view', render: aiWorkforce },
    '/wnioski': { title: 'Moje wnioski', perm: 'approvals.request', render: myRequests },
    '/akceptacje': { title: 'Approval Center', perm: 'approvals.decide', render: approvalCenter, admin: true },
    '/bezpieczenstwo': { title: 'Security & Audit', perm: 'security.audit', render: securityPage, admin: true },
    '/ustawienia-ai': { title: 'Ustawienia AI', perm: 'ai.settings', render: aiSettings, admin: true }
  };
  const TABS = ['/command-center', '/zadania', '/ai-board', '/ai-workforce', '/wnioski', '/akceptacje', '/bezpieczenstwo', '/ustawienia-ai'];

  // Trasa bez `perm` jest dostępna dla każdego zalogowanego (np. Powiadomienia); o danych i tak decyduje serwer.
  const allowed = (u, def) => !def.perm || (u.permissions || []).includes(def.perm);
  const MENU_EXTRA = [];
  function menu(u) {
    const items = (u.permissions || []).includes('departments.view') ? [{ label: 'Wybór działu', path: '/dzialy' }] : [];
    for (const p of TABS) if (allowed(u, ROUTES[p])) items.push({ label: ROUTES[p].title, path: p, admin: ROUTES[p].admin });
    for (const p of MENU_EXTRA) if (allowed(u, ROUTES[p]) && !TABS.includes(p)) items.push({ label: ROUTES[p].title, path: p, admin: ROUTES[p].admin });
    items.push({ label: 'Zmień hasło', path: '/zmiana-hasla' });
    return items;
  }

  function frame(root, path, title, lead, actions) {
    const tabs = TABS.filter(p => allowed(me(), ROUTES[p])).map(p =>
      `<button type="button" class="tab${p === path ? ' tab-on' : ''}" data-go="${p}"${p === path ? ' aria-current="page"' : ''}>${esc(ROUTES[p].title)}</button>`).join('');
    root.innerHTML = `
      <nav class="modnav" aria-label="Moduły">${tabs}</nav>
      <header class="mod-head">
        <div class="mod-head-text"><p class="eyebrow">MXT Business OS</p><h1 class="mod-title">${esc(title)}</h1>${lead ? `<p class="mod-lead">${esc(lead)}</p>` : ''}</div>
        <div class="mod-actions">${actions || ''}</div>
      </header>
      <div class="mod-body" id="mod-body"><p class="muted loading">Wczytywanie…</p></div>`;
    root.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
    return root.querySelector('#mod-body');
  }

  let renderSeq = 0;
  async function render(path, root) {
    const def = ROUTES[path], seq = ++renderSeq;
    root.classList.remove('mod-in'); void root.offsetWidth; root.classList.add('mod-in');
    if (!allowed(me(), def)) {
      root.innerHTML = `<div class="forbidden"><h1 class="mod-title">Brak dostępu</h1><p>Twoje konto nie ma uprawnień do modułu „${esc(def.title)}”.${def.admin ? ' Moduł jest dostępny tylko dla administratorów.' : ''}</p>
        <button type="button" class="btn btn-secondary" data-go="/">Przejdź do strony startowej</button></div>`;
      root.querySelector('[data-go]').addEventListener('click', () => go('/'));
      return;
    }
    try { await def.render(root, path, () => seq === renderSeq); }
    catch (e) {
      const b = root.querySelector('#mod-body') || root;
      b.innerHTML = `<div class="notice notice-error">${esc(e.status === 403 ? 'Brak uprawnień do tego modułu.' : e.message || 'Nie udało się wczytać danych.')}</div>`;
    }
  }

  // ---------- okno dialogowe ----------
  function modal(title, bodyHtml, { submit = 'Zapisz', danger = false, onSubmit, wide = false, cancel = '' } = {}) {
    const m = document.getElementById('modal'), box = document.getElementById('modal-box');
    box.classList.toggle('modal-wide', wide);
    box.innerHTML = `<form class="modal-form" novalidate>
      <h2 class="modal-title" id="modal-title">${esc(title)}</h2>
      <div class="modal-content">${bodyHtml}</div>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-close>${esc(cancel || (onSubmit ? 'Anuluj' : 'Zamknij'))}</button>
        ${onSubmit ? `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submit)}</button>` : ''}
      </div></form>`;
    const form = box.querySelector('form'), err = box.querySelector('.form-error');
    const close = () => { m.hidden = true; document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    box.querySelector('[data-close]').addEventListener('click', close);
    m.onclick = e => { if (e.target === m) close(); };
    form.addEventListener('submit', async e => {
      e.preventDefault(); err.hidden = true;
      const btn = form.querySelector('[type=submit]'); btn.disabled = true;
      try { await onSubmit(form); close(); }
      catch (x) { if (x && x.keepOpen) return; err.textContent = x.message || 'Nie udało się zapisać.'; err.hidden = false; }
      finally { btn.disabled = false; }
    });
    m.hidden = false;
    const f = box.querySelector('input, select, textarea, [type=submit]'); if (f) f.focus();
    return box;
  }
  const field = (id, label, input) => `<div class="field"><label for="${id}">${esc(label)}</label>${input}</div>`;
  const val = (form, n) => form.elements[n] ? form.elements[n].value : undefined;

  // ---------- formularz wniosku do akceptacji ----------
  async function requestForm(existing, after) {
    const M = await meta();
    const types = Object.entries(M.operations).filter(([, o]) => o.requestable);
    const opt = types.map(([k, o]) => `<option value="${k}"${existing && existing.operation_type === k ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    const deps = '<option value="">– bez działu –</option>' + M.departments.map(d => `<option value="${d.id}"${existing && existing.department_id === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
    modal(existing ? 'Zmień wniosek (nowa wersja)' : 'Zgłoś operację do akceptacji', `
      <p class="muted">Operacje wiążące (poziom 2) wykonają się dopiero po zatwierdzeniu przez administratora.${existing ? ' Zmiana tworzy nową wersję – decyzja będzie dotyczyć nowej treści.' : ''}</p>
      ${existing ? '' : field('f-type', 'Rodzaj operacji', `<select id="f-type" name="operation_type">${opt}</select>`)}
      ${field('f-title', 'Tytuł', `<input id="f-title" name="title" maxlength="200" required value="${esc(existing ? existing.title : '')}">`)}
      ${field('f-desc', 'Opis i uzasadnienie', `<textarea id="f-desc" name="description" rows="4">${esc(existing ? existing.description : '')}</textarea>`)}
      <div class="field-row">
        ${field('f-amount', 'Kwota (opcjonalnie)', `<input id="f-amount" name="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${existing && existing.amount != null ? esc(existing.amount) : ''}">`)}
        ${field('f-cur', 'Waluta', `<select id="f-cur" name="currency">${['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map(c => `<option${existing && existing.currency === c ? ' selected' : ''}>${c}</option>`).join('')}</select>`)}
      </div>
      ${existing ? '' : field('f-dep', 'Dział', `<select id="f-dep" name="department_id">${deps}</select>`)}`,
    { submit: existing ? 'Zapisz nową wersję' : 'Wyślij do akceptacji', onSubmit: async f => {
      const body = { title: val(f, 'title'), description: val(f, 'description'), amount: val(f, 'amount'), currency: val(f, 'currency') };
      if (existing) await api('approvals/' + existing.id, body, 'PATCH');
      else {
        const a = await api('approvals', { ...body, operation_type: val(f, 'operation_type'), department_id: val(f, 'department_id') || null });
        toast(a.level === 3 ? 'Zatwierdzone automatycznie (reguła poziomu 3).' : 'Wniosek wysłany do akceptacji.');
      }
      if (after) after();
    } });
  }

  // ---------- karty operacji ----------
  function approvalCard(a, { admin, mine }) {
    const M = META || { operations: {} }, op = M.operations[a.operation_type] || { label: a.operation_type };
    const hist = (a.history || []).map(e => `<li><span class="tl-dot tl-${esc(e.event)}"></span><div><b>${esc(EV[e.event] || e.event)}</b> · ${esc(e.actor_label || e.actor_type)} · ${esc(fdt(e.ts))}
      <span class="mono">v${esc(e.version)} · ${esc(e.payload_hash.slice(0, 12))}</span>${e.note ? `<div class="tl-note">${esc(e.note)}</div>` : ''}</div></li>`).join('');
    const acts = [];
    if (admin && a.status === 'oczekuje') acts.push(`<button type="button" class="btn btn-primary btn-sm" data-act="ok" data-id="${a.id}">Zatwierdź</button><button type="button" class="btn btn-secondary btn-sm" data-act="no" data-id="${a.id}">Odrzuć</button>`);
    if ((mine || admin) && a.status === 'zatwierdzona') acts.push(`<button type="button" class="btn btn-primary btn-sm" data-act="exec" data-id="${a.id}">Wykonaj</button>`);
    if (mine && a.status === 'oczekuje') acts.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="edit" data-id="${a.id}">Zmień</button>`);
    if ((mine || admin) && ['oczekuje', 'zatwierdzona'].includes(a.status)) acts.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="withdraw" data-id="${a.id}">Wycofaj</button>`);
    return `<article class="ap-card ap-${esc(a.status)}">
      <div class="ap-top">
        <div class="ap-tags">${chip('lvl' + a.level, 'Poziom ' + a.level)} ${chip(a.status, AP_ST[a.status] || a.status)} <span class="muted">${esc(op.label)}</span></div>
        ${a.amount != null ? `<div class="ap-amount">${esc(money(a.amount, a.currency))}</div>` : ''}
      </div>
      <h3 class="ap-title">${esc(a.title)}</h3>
      ${a.description ? `<p class="ap-desc">${esc(a.description)}</p>` : ''}
      <dl class="ap-meta">
        <div><dt>Zgłosił</dt><dd>${esc(a.requested_by_label || a.requested_by)}${a.requested_by_type === 'agent' ? ' (agent AI)' : ''}</dd></div>
        <div><dt>Zgłoszono</dt><dd>${esc(fdt(a.created_at))}</dd></div>
        ${a.department_name ? `<div><dt>Dział</dt><dd>${esc(a.department_name)}</dd></div>` : ''}
        <div><dt>Wersja</dt><dd class="mono">v${esc(a.version)} · ${esc(a.payload_hash.slice(0, 12))}</dd></div>
        ${a.decided_at ? `<div><dt>Decyzja</dt><dd>${esc(a.decided_by_login || 'reguła')} · ${esc(fdt(a.decided_at))} (v${esc(a.decided_version)})</dd></div>` : ''}
      </dl>
      ${a.decision_note ? `<p class="ap-note">„${esc(a.decision_note)}”</p>` : ''}
      ${a.status === 'wykonana' && op.module ? `<p class="muted small">Skutek operacji zostanie podłączony do modułu: ${esc(op.module)}.</p>` : ''}
      ${acts.length ? `<div class="ap-actions">${acts.join('')}</div>` : ''}
      ${hist ? `<details class="ap-hist"><summary>Historia (${(a.history || []).length})</summary><ol class="timeline">${hist}</ol></details>` : ''}
    </article>`;
  }

  function bindApprovalActions(box, list, reload) {
    box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
      const a = list.find(x => x.id === b.dataset.id); if (!a) return;
      const act = b.dataset.act;
      if (act === 'edit') return requestForm(a, reload);
      if (act === 'ok' || act === 'no') {
        const ok = act === 'ok';
        return modal(ok ? 'Zatwierdź operację' : 'Odrzuć operację', `
          <p><b>${esc(a.title)}</b>${a.amount != null ? ' · ' + esc(money(a.amount, a.currency)) : ''}</p>
          <p class="muted">Decyzja dotyczy wersji <span class="mono">v${esc(a.version)} · ${esc(a.payload_hash.slice(0, 12))}</span>. Jeśli treść zmieni się przed zapisem, decyzja zostanie zablokowana.</p>
          ${field('f-note', ok ? 'Komentarz (opcjonalnie)' : 'Powód odrzucenia', `<textarea id="f-note" name="note" rows="3"></textarea>`)}`,
        { submit: ok ? 'Zatwierdzam' : 'Odrzucam', danger: !ok, onSubmit: async f => {
          await api('approvals/' + a.id + '/decyzja', { decision: ok ? 'zatwierdz' : 'odrzuc', version: a.version, note: val(f, 'note') });
          toast(ok ? 'Operacja zatwierdzona.' : 'Operacja odrzucona.'); reload();
        } });
      }
      if (act === 'exec') return modal('Wykonaj operację', `<p>Wykonać zatwierdzoną operację <b>${esc(a.title)}</b>?</p><p class="muted">System sprawdzi, czy treść jest identyczna z zatwierdzoną wersją.</p>`,
        { submit: 'Wykonaj', onSubmit: async () => { await api('approvals/' + a.id + '/wykonaj', {}); toast('Operacja wykonana.'); reload(); } });
      if (act === 'withdraw') return modal('Wycofaj wniosek', `<p>Wycofać <b>${esc(a.title)}</b>? Tej operacji nie będzie można już wykonać.</p>`,
        { submit: 'Wycofaj', danger: true, onSubmit: async () => { await api('approvals/' + a.id + '/wycofaj', {}); toast('Wniosek wycofany.'); reload(); } });
    }));
  }

  // ---------- Command Center ----------
  const MODULES = [
    ['Command Center', 'dostępny', '/command-center'], ['Zadania (Workflow Engine)', 'dostępny', '/zadania'],
    ['Approval Center', 'dostępny', '/akceptacje', 'approvals.decide'], ['Security & Audit', 'dostępny', '/bezpieczenstwo', 'security.audit'],
    ['AI Board', 'dostępny', '/ai-board'], ['AI Workforce', 'dostępny', '/ai-workforce'], ['Ustawienia AI', 'dostępny', '/ustawienia-ai', 'ai.settings'],
    ['Finance Intelligence', 'dostępny', '/finanse'], ['CRM', 'dostępny', '/crm'], ['Knowledge Base', 'dostępny', '/wiedza'],
    ['Podzielniki i Montaże', 'dostępny', '/dzial/podzielniki-i-montaze'], ['Sprzedaż części i eksport', 'dostępny', '/dzial/sprzedaz-czesci-i-eksport'], ['Platforma Szkoleniowa', 'dostępny', '/dzial/ubezpieczenia'],
    ['Communication Hub', 'dostępny', '/komunikacja'], ['Business Intelligence', 'dostępny', '/bi'], ['Karta wyników agentów', 'dostępny', '/karta-wynikow'],
    ['Automatyzacje i dzienny raport', 'dostępny', '/automatyzacje', 'automations.manage']
  ];
  async function commandCenter(root, path, alive) {
    const body = frame(root, path, 'Command Center', 'Stan firmy, alerty, zadania i decyzje w jednym miejscu.',
      `<button type="button" class="btn btn-secondary" id="cc-req">Zgłoś do akceptacji</button><button type="button" class="btn btn-primary" id="cc-task">Nowe zadanie</button>`);
    const reload = () => render(path, root);
    root.querySelector('#cc-task').addEventListener('click', () => taskForm(null, reload));
    root.querySelector('#cc-req').addEventListener('click', () => requestForm(null, reload));
    const [d] = await Promise.all([api('command-center'), meta()]);
    if (!alive()) return;
    const k = d.kpi;
    const kpi = (label, value, tone, link) => `<button type="button" class="kpi kpi-${tone}"${link ? ` data-go="${link}"` : ' disabled'}><span class="kpi-v">${esc(value)}</span><span class="kpi-l">${esc(label)}</span></button>`;
    const tiles = [
      kpi('Otwarte zadania', k.otwarte, 'blue', '/zadania'),
      kpi('Po terminie', k.po_terminie, k.po_terminie ? 'warn' : 'neutral', '/zadania'),
      kpi('Moje zadania', k.moje, 'teal', '/zadania'),
      kpi(d.admin ? 'Oczekujące decyzje' : 'Moje wnioski w toku', k.oczekujace, k.oczekujace ? 'violet' : 'neutral', d.admin ? '/akceptacje' : '/wnioski'),
      kpi('Zakończone (7 dni)', k.zakonczone_7d, 'ok', '/zadania'),
      d.admin ? kpi('Odmowy dostępu (24 h)', k.odmowy_24h, k.odmowy_24h ? 'warn' : 'neutral', '/bezpieczenstwo') : kpi('Wyłącznik agentów', k.agenci_zatrzymani ? 'Włączony' : 'Gotowi', k.agenci_zatrzymani ? 'danger' : 'neutral')
    ].join('');
    const alerts = d.alerts.length ? d.alerts.map(a => `<li class="alert alert-${esc(a.level)}">${a.link ? `<button type="button" class="linkish" data-go="${a.link}">${esc(a.text)}</button>` : esc(a.text)}</li>`).join('')
      : '<li class="alert alert-none">Brak alertów. Wszystko pod kontrolą.</li>';
    const tasks = d.tasks.length ? d.tasks.map(taskRow).join('') : `<p class="empty-inline">Nie masz otwartych zadań. <button type="button" class="linkish" id="cc-task2">Dodaj zadanie</button></p>`;
    const pend = d.pending.length ? d.pending.map(a => `<li class="pend"><div><b>${esc(a.title)}</b><span class="muted small">${esc((META.operations[a.operation_type] || {}).label || a.operation_type)} · ${esc(fdt(a.created_at))}${d.admin ? ' · ' + esc(a.requested_by_label) : ''}</span></div>
        <div class="pend-r">${a.amount != null ? `<span class="pend-amt">${esc(money(a.amount, a.currency))}</span>` : ''}${chip(a.status, AP_ST[a.status])}</div></li>`).join('')
      : `<p class="empty-inline">${d.admin ? 'Brak decyzji do podjęcia.' : 'Nie masz wniosków w toku.'}</p>`;
    body.innerHTML = `
      <section class="kpis" aria-label="Wskaźniki">${tiles}</section>
      <section class="panel"><h2 class="panel-title">Alerty</h2><ul class="alerts">${alerts}</ul></section>
      <div class="cols">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Moje zadania</h2><button type="button" class="linkish" data-go="/zadania">Wszystkie zadania →</button></div><div class="task-list">${tasks}</div></section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${d.admin ? 'Oczekujące decyzje' : 'Moje wnioski'}</h2><button type="button" class="linkish" data-go="${d.admin ? '/akceptacje' : '/wnioski'}">${d.admin ? 'Approval Center →' : 'Wszystkie wnioski →'}</button></div><ul class="pend-list">${pend}</ul></section>
      </div>
      <section class="panel"><h2 class="panel-title">Moduły MXT Business OS</h2>
        <div class="mods">${MODULES.filter(m => !m[3] || has(m[3])).map(m => `<button type="button" class="mod-tile${m[2] ? '' : ' mod-soon'}"${m[2] ? ` data-go="${m[2]}"` : ' disabled'}><span>${esc(m[0])}</span>${chip(m[1] === 'dostępny' ? 'ok' : 'soon', m[1] === 'dostępny' ? 'Dostępny' : 'W ' + m[1].replace('etap', 'etapie'))}</button>`).join('')}</div>
      </section>`;
    body.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
    const t2 = body.querySelector('#cc-task2'); if (t2) t2.addEventListener('click', () => taskForm(null, reload));
    bindTaskRows(body, d.tasks, reload);
  }

  // ---------- Zadania ----------
  function taskRow(t) {
    return `<div class="task${t.overdue ? ' task-overdue' : ''}" data-task="${t.id}">
      <div class="task-main"><button type="button" class="task-title linkish" data-edit="${t.id}">${esc(t.title)}</button>
        <span class="muted small">${t.department_name ? esc(t.department_name) + ' · ' : ''}${t.assignee_login ? (t.assignee_type === 'agent' ? 'Agent AI: ' : 'Przypisane: ') + esc(t.assignee_login) : 'Nieprzypisane'}${t.due_date ? ' · termin ' + esc(fd(t.due_date)) : ''}${t.overdue ? ' · <b class="txt-warn">po terminie</b>' : ''}</span></div>
      <div class="task-side">${t.assignee_type === 'agent' ? chip('soon', 'Agent AI') : ''}${chip('p-' + t.priority, PRIO[t.priority])}
        <label class="visually-hidden" for="st-${t.id}">Status zadania</label>
        <select class="status-select st-${esc(t.status)}" id="st-${t.id}" data-status="${t.id}">${Object.entries(TASK_ST).map(([k, v]) => `<option value="${k}"${k === t.status ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>`;
  }
  function bindTaskRows(box, list, reload) {
    box.querySelectorAll('[data-status]').forEach(s => s.addEventListener('change', async () => {
      try { await api('tasks/' + s.dataset.status, { status: s.value }, 'PATCH'); toast('Status zmieniony.'); reload(); }
      catch (e) { toast(e.message); reload(); }
    }));
    box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => taskForm(list.find(t => t.id === b.dataset.edit), reload)));
  }
  // t z id = edycja; obiekt bez id = wartości domyślne nowego zadania (np. dział i agent).
  async function taskForm(t0, after) {
    const t = t0 && t0.id ? t0 : null, d0 = t0 || null;
    const M = await meta();
    const deps = '<option value="">– bez działu –</option>' + M.departments.map(d => `<option value="${d.id}"${d0 && d0.department_id === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
    const users = '<option value="">– nieprzypisane –</option><optgroup label="Pracownicy">' + M.users.map(u => `<option value="${u.id}"${d0 && d0.assignee_id === u.id ? ' selected' : ''}>${esc(u.login)}</option>`).join('') + '</optgroup>' +
      ((M.agents || []).length ? '<optgroup label="Agenci AI">' + M.agents.map(g => `<option value="${esc(g.id)}"${d0 && d0.assignee_id === g.id ? ' selected' : ''}${g.is_active ? '' : ' disabled'}>${esc(g.display_name)} – ${esc(g.title)}${g.is_active ? '' : ' (wyłączony)'}</option>`).join('') + '</optgroup>' : '');
    const box = modal(t ? 'Edytuj zadanie' : 'Nowe zadanie', `
      ${field('t-title', 'Tytuł', `<input id="t-title" name="title" maxlength="200" required value="${esc(t ? t.title : '')}">`)}
      ${field('t-desc', 'Opis', `<textarea id="t-desc" name="description" rows="3">${esc(t ? t.description : '')}</textarea>`)}
      <div class="field-row">
        ${field('t-dep', 'Dział', `<select id="t-dep" name="department_id">${deps}</select>`)}
        ${field('t-user', 'Osoba odpowiedzialna', `<select id="t-user" name="assignee_id">${users}</select>`)}
      </div>
      <div class="field-row">
        ${field('t-prio', 'Priorytet', `<select id="t-prio" name="priority">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}"${(t ? t.priority : 'normalny') === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${field('t-due', 'Termin', `<input id="t-due" name="due_date" type="date" value="${esc(t && t.due_date ? String(t.due_date).slice(0, 10) : '')}">`)}
      </div>
      <p class="muted small">Zadanie możesz przydzielić agentowi AI. Agent analizuje i przygotowuje wynik; operacje wiążące zgłasza do Approval Center.</p>
      ${t ? `<p class="muted small">Utworzone przez ${esc(t.created_by_login || '–')} · ${esc(fdt(t.created_at))}</p><button type="button" class="btn btn-ghost btn-sm txt-danger" id="t-del">Usuń zadanie</button>` : ''}`,
    { submit: t ? 'Zapisz zmiany' : 'Dodaj zadanie', onSubmit: async f => {
      const b = { title: val(f, 'title'), description: val(f, 'description'), department_id: val(f, 'department_id') || null, assignee_id: val(f, 'assignee_id') || null, priority: val(f, 'priority'), due_date: val(f, 'due_date') || null };
      if (t) await api('tasks/' + t.id, b, 'PATCH'); else await api('tasks', b);
      toast(t ? 'Zadanie zapisane.' : 'Zadanie dodane.'); if (after) after();
    } });
    if (t && t.assignee_type === 'agent') agentTaskPanel(box, t, after);
    const del = box.querySelector('#t-del');
    if (del) del.addEventListener('click', () => modal('Usuń zadanie', `<p>Usunąć zadanie <b>${esc(t.title)}</b>? Tej operacji nie można cofnąć.</p>`,
      { submit: 'Usuń', danger: true, onSubmit: async () => { await api('tasks/' + t.id, null, 'DELETE'); toast('Zadanie usunięte.'); if (after) after(); } }));
  }

  const taskFilter = { scope: 'otwarte', department: '' };
  async function tasksPage(root, path, alive) {
    const body = frame(root, path, 'Zadania', 'Zlecanie i śledzenie pracy w działach.', `<button type="button" class="btn btn-primary" id="tk-new">Nowe zadanie</button>`);
    const reload = () => render(path, root);
    root.querySelector('#tk-new').addEventListener('click', () => taskForm(null, reload));
    const M = await meta();
    const q = new URLSearchParams();
    if (taskFilter.scope === 'moje') { q.set('scope', 'moje'); q.set('status', 'otwarte'); }
    else if (taskFilter.scope === 'otwarte') q.set('status', 'otwarte');
    else if (taskFilter.scope === 'zakonczone') q.set('status', 'zakonczone');
    if (taskFilter.department) q.set('department', taskFilter.department);
    const list = await api('tasks?' + q);
    if (!alive()) return;
    const scopes = [['otwarte', 'Otwarte'], ['moje', 'Moje'], ['zakonczone', 'Zakończone'], ['wszystkie', 'Wszystkie']];
    body.innerHTML = `
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Filtr zadań">${scopes.map(([k, v]) => `<button type="button" class="seg-b${taskFilter.scope === k ? ' seg-on' : ''}" data-scope="${k}" aria-pressed="${taskFilter.scope === k}">${v}</button>`).join('')}</div>
        <label class="visually-hidden" for="tk-dep">Dział</label>
        <select id="tk-dep" class="select-sm"><option value="">Wszystkie działy</option>${M.departments.map(d => `<option value="${d.id}"${taskFilter.department === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      </div>
      <section class="panel">${list.length ? `<div class="task-list">${list.map(taskRow).join('')}</div>` : '<p class="empty-inline">Brak zadań w tym widoku. Dodaj pierwsze zadanie przyciskiem „Nowe zadanie”.</p>'}</section>`;
    body.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { taskFilter.scope = b.dataset.scope; reload(); }));
    body.querySelector('#tk-dep').addEventListener('change', e => { taskFilter.department = e.target.value; reload(); });
    bindTaskRows(body, list, reload);
  }

  // ---------- Moje wnioski ----------
  async function myRequests(root, path, alive) {
    const body = frame(root, path, 'Moje wnioski', 'Operacje, które zgłosiłeś do akceptacji administratora.', `<button type="button" class="btn btn-primary" id="mr-new">Zgłoś do akceptacji</button>`);
    const reload = () => render(path, root);
    root.querySelector('#mr-new').addEventListener('click', () => requestForm(null, reload));
    const [list] = await Promise.all([api('approvals/moje'), meta()]);
    if (!alive()) return;
    body.innerHTML = list.length ? `<div class="ap-list">${list.map(a => approvalCard(a, { mine: true, admin: has('approvals.decide') })).join('')}</div>`
      : '<section class="panel"><p class="empty-inline">Nie zgłosiłeś jeszcze żadnej operacji. Wydatki, zmiany cen, rabaty, umowy i wysyłka ofert wymagają zgody administratora.</p></section>';
    bindApprovalActions(body, list, reload);
  }

  // ---------- Approval Center ----------
  let apTab = 'oczekuje';
  async function approvalCenter(root, path, alive) {
    const body = frame(root, path, 'Approval Center', 'Decyzje wiążące zatwierdza administrator. Każda decyzja dotyczy konkretnej wersji operacji.',
      `<button type="button" class="btn btn-secondary" id="ac-new">Zgłoś operację</button>`);
    const reload = () => render(path, root);
    root.querySelector('#ac-new').addEventListener('click', () => requestForm(null, reload));
    const M = await meta();
    const tabs = [['oczekuje', 'Oczekujące'], ['historia', 'Historia'], ['reguly', 'Reguły poziomu 3'], ['poziomy', 'Poziomy uprawnień']];
    const head = `<div class="seg" role="tablist">${tabs.map(([k, v]) => `<button type="button" role="tab" class="seg-b${apTab === k ? ' seg-on' : ''}" aria-selected="${apTab === k}" data-tab="${k}">${v}</button>`).join('')}</div>`;
    let html = '', list = [];
    if (apTab === 'oczekuje' || apTab === 'historia') {
      list = await api('approvals?status=' + apTab);
      html = list.length ? `<div class="ap-list">${list.map(a => approvalCard(a, { admin: true, mine: a.requested_by_type === 'user' && a.requested_by === me().id })).join('')}</div>`
        : `<section class="panel"><p class="empty-inline">${apTab === 'oczekuje' ? 'Brak operacji oczekujących na decyzję.' : 'Historia decyzji jest pusta.'}</p></section>`;
    } else if (apTab === 'reguly') {
      const rules = await api('approval-rules');
      html = `<section class="panel"><div class="panel-head"><h2 class="panel-title">Stałe zgody (poziom 3)</h2><button type="button" class="btn btn-primary btn-sm" id="rule-new">Nowa reguła</button></div>
        <p class="muted">Reguła pozwala wykonywać automatycznie wyłącznie operacje odwracalne, do określonej kwoty i liczby dziennie, do daty ważności.</p>
        ${rules.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Operacja</th><th>Limit</th><th>Dziennie</th><th>Ważna do</th><th>Użyta</th><th>Utworzył</th><th></th></tr></thead><tbody>
        ${rules.map(x => `<tr class="${x.is_active ? '' : 'row-off'}"><td>${esc((M.operations[x.operation_type] || {}).label || x.operation_type)}${x.description ? `<div class="muted small">${esc(x.description)}</div>` : ''}</td>
          <td class="num">${esc(money(x.max_amount, x.currency))}</td><td class="num">${esc(x.used_today)}/${esc(x.max_per_day)}</td><td>${esc(fd(x.valid_until))}</td><td class="num">${esc(x.used_total)}</td>
          <td>${esc(x.created_by_login)}</td><td>${x.is_active ? `<button type="button" class="btn btn-ghost btn-sm" data-off="${x.id}">Wyłącz</button>` : chip('off', 'Wyłączona')}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty-inline">Brak reguł. Bez reguł każda operacja poziomu 2 czeka na ręczną decyzję.</p>'}</section>`;
    } else {
      html = `<section class="panel"><h2 class="panel-title">Poziomy uprawnień</h2><ol class="levels">${Object.entries(M.levels).map(([k, v]) => `<li>${chip('lvl' + k, 'Poziom ' + k)} <span>${esc(v)}</span></li>`).join('')}</ol>
        <h3 class="panel-sub">Operacje i ich poziomy</h3><div class="table-wrap"><table class="table"><thead><tr><th>Operacja</th><th>Poziom</th><th>Odwracalna</th><th>Moduł</th></tr></thead><tbody>
        ${Object.values(M.operations).map(o => `<tr><td>${esc(o.label)}</td><td>${chip('lvl' + o.level, String(o.level))}</td><td>${o.reversible ? 'tak' : 'nie'}</td><td class="muted">${esc(o.module)}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">Reguły są egzekwowane przez serwer: agent AI nie może zatwierdzić żadnej operacji, a wykonanie wymaga zgodności z zatwierdzoną wersją (skrót SHA-256).</p></section>`;
    }
    if (!alive()) return;
    body.innerHTML = head + html;
    body.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { apTab = b.dataset.tab; reload(); }));
    bindApprovalActions(body, list, reload);
    const rn = body.querySelector('#rule-new'); if (rn) rn.addEventListener('click', () => ruleForm(reload));
    body.querySelectorAll('[data-off]').forEach(b => b.addEventListener('click', () => modal('Wyłącz regułę', '<p>Po wyłączeniu operacje tego typu znów będą czekać na ręczną decyzję.</p>',
      { submit: 'Wyłącz', danger: true, onSubmit: async () => { await api('approval-rules/' + b.dataset.off + '/wylacz', {}); toast('Reguła wyłączona.'); reload(); } })));
  }
  async function ruleForm(after) {
    const M = await meta();
    const types = Object.entries(M.operations).filter(([, o]) => o.level === 2 && o.reversible);
    const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    modal('Nowa reguła poziomu 3', `
      <p class="muted">Tylko operacje odwracalne. Operacje powyżej limitu nadal trafią do ręcznej akceptacji.</p>
      ${field('r-type', 'Operacja', `<select id="r-type" name="operation_type">${types.map(([k, o]) => `<option value="${k}">${esc(o.label)}</option>`).join('')}</select>`)}
      <div class="field-row">
        ${field('r-max', 'Maksymalna kwota', `<input id="r-max" name="max_amount" type="number" min="0.01" step="0.01" required>`)}
        ${field('r-cur', 'Waluta', `<select id="r-cur" name="currency">${['PLN', 'EUR', 'USD'].map(c => `<option>${c}</option>`).join('')}</select>`)}
      </div>
      <div class="field-row">
        ${field('r-day', 'Limit operacji dziennie', `<input id="r-day" name="max_per_day" type="number" min="1" max="100" value="5" required>`)}
        ${field('r-until', 'Ważna do', `<input id="r-until" name="valid_until" type="date" min="${today()}" value="${until}" required>`)}
      </div>
      ${field('r-desc', 'Opis (zakres, warunki)', `<input id="r-desc" name="description" maxlength="500">`)}`,
    { submit: 'Utwórz regułę', onSubmit: async f => {
      await api('approval-rules', { operation_type: val(f, 'operation_type'), max_amount: val(f, 'max_amount'), currency: val(f, 'currency'), max_per_day: val(f, 'max_per_day'), valid_until: val(f, 'valid_until'), description: val(f, 'description') });
      toast('Reguła utworzona.'); after();
    } });
  }

  // ---------- Security & Audit ----------
  const auditFilter = { status: '', actor_type: '', q: '' };
  const ACT_LABEL = { logowanie: 'Logowanie', wylogowanie: 'Wylogowanie', odmowa_dostepu: 'Odmowa dostępu' };
  async function securityPage(root, path, alive) {
    const body = frame(root, path, 'Security & Audit', 'Rejestr operacji użytkowników i agentów AI oraz wyłącznik bezpieczeństwa.');
    const reload = () => render(path, root);
    const q = new URLSearchParams(Object.entries(auditFilter).filter(([, v]) => v));
    const [stop, logs, M] = await Promise.all([api('security/agents-stop'), api('audit?' + q), meta()]);
    if (!alive()) return;
    const roles = Object.keys(M.roles);
    body.innerHTML = `
      <section class="panel kill ${stop.stopped ? 'kill-on' : ''}">
        <div class="kill-text"><h2 class="panel-title">Wyłącznik wszystkich agentów AI</h2>
          <p>${stop.stopped ? '<b>Agenci są zatrzymani.</b> Żadna operacja zgłoszona przez agenta nie zostanie przyjęta ani wykonana.' : 'Agenci mogą pracować w granicach swoich uprawnień.'}</p>
          ${stop.updated_by ? `<p class="muted small">Ostatnia zmiana: ${esc(stop.updated_by)} · ${esc(fdt(stop.updated_at))}${stop.reason ? ' · „' + esc(stop.reason) + '”' : ''}</p>` : ''}
          <p class="muted small">Agenci AI zostaną dodani w etapie 2; wyłącznik działa już teraz po stronie serwera.</p></div>
        <button type="button" class="btn ${stop.stopped ? 'btn-primary' : 'btn-danger'} btn-kill" id="kill">${stop.stopped ? 'Wznów pracę agentów' : 'Zatrzymaj wszystkich agentów'}</button>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Rejestr operacji</h2></div>
        <form class="toolbar" id="af">
          <label class="visually-hidden" for="af-q">Szukaj</label><input id="af-q" name="q" class="select-sm" placeholder="Szukaj: akcja, login, zasób" value="${esc(auditFilter.q)}">
          <label class="visually-hidden" for="af-s">Status</label><select id="af-s" name="status" class="select-sm"><option value="">Każdy status</option>${[['ok', 'OK'], ['odmowa', 'Odmowa'], ['blad', 'Błąd']].map(([k, v]) => `<option value="${k}"${auditFilter.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <label class="visually-hidden" for="af-a">Kto</label><select id="af-a" name="actor_type" class="select-sm"><option value="">Wszyscy</option>${[['user', 'Użytkownicy'], ['agent', 'Agenci AI'], ['system', 'System'], ['anonim', 'Niezalogowani']].map(([k, v]) => `<option value="${k}"${auditFilter.actor_type === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <button type="submit" class="btn btn-secondary btn-sm">Filtruj</button>
        </form>
        <div class="table-wrap"><table class="table table-audit"><thead><tr><th>Czas</th><th>Kto</th><th>Akcja</th><th>Zasób</th><th>Status</th><th>Szczegóły</th></tr></thead><tbody id="audit-rows">${auditRows(logs)}</tbody></table></div>
        ${logs.length === 100 ? '<button type="button" class="btn btn-secondary btn-sm" id="more">Pokaż starsze</button>' : ''}
        ${logs.length ? '' : '<p class="empty-inline">Brak wpisów dla wybranych filtrów.</p>'}
      </section>
      <section class="panel panel-link"><h2 class="panel-title">Konta pracowników</h2>
        <p class="muted">Zakładanie kont, role, powiązanie z instalatorami, wyłączanie kont i reset hasła są w module „Konta i role”.</p>
        <button type="button" class="btn btn-secondary btn-sm" data-go-konta>Przejdź do kont</button></section>
      <section class="panel"><h2 class="panel-title">Role i uprawnienia</h2>
        <div class="table-wrap"><table class="table"><thead><tr><th>Uprawnienie</th>${roles.map(r => `<th class="c">${esc(M.roles[r])}</th>`).join('')}</tr></thead><tbody>
        ${Object.entries(M.permissions).map(([k, p]) => `<tr><td>${esc(p.label)}</td>${roles.map(r => `<td class="c">${p.roles.includes(r) ? '<b class="txt-ok">TAK</b>' : '<span class="muted">NIE</span>'}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        <p class="muted small">Konto z kilkoma rolami ma sumę ich uprawnień. Aktywne konta: ${M.users.filter(u => u.is_active !== false).map(u => esc(u.login) + ' – ' + [u.role, ...(u.extra_roles || [])].map(r => esc(M.roles[r] || r)).join(' + ')).join(', ')}.</p></section>`;
    body.querySelector('#kill').addEventListener('click', () => {
      const stopping = !stop.stopped;
      modal(stopping ? 'Zatrzymać wszystkich agentów?' : 'Wznowić pracę agentów?', `
        <p>${stopping ? 'Wszystkie operacje zgłaszane i wykonywane przez agentów AI zostaną natychmiast zablokowane przez serwer.' : 'Agenci wrócą do pracy w granicach swoich uprawnień.'}</p>
        ${field('k-reason', 'Powód (zapisany w rejestrze)', `<input id="k-reason" name="reason" maxlength="500" ${stopping ? 'required' : ''}>`)}`,
      { submit: stopping ? 'Zatrzymaj agentów' : 'Wznów agentów', danger: stopping, onSubmit: async f => {
        if (stopping && !val(f, 'reason').trim()) throw new Error('Podaj powód zatrzymania.');
        await api('security/agents-stop', { stopped: stopping, reason: val(f, 'reason') });
        toast(stopping ? 'Agenci zatrzymani.' : 'Agenci wznowieni.'); reload();
      } });
    });
    body.querySelector('[data-go-konta]').addEventListener('click', () => go('/konta'));
    body.querySelector('#af').addEventListener('submit', e => {
      e.preventDefault(); const f = e.target;
      auditFilter.q = val(f, 'q').trim(); auditFilter.status = val(f, 'status'); auditFilter.actor_type = val(f, 'actor_type'); reload();
    });
    const more = body.querySelector('#more');
    if (more) {
      let last = logs[logs.length - 1].id;
      more.addEventListener('click', async () => {
        const q2 = new URLSearchParams(Object.entries(auditFilter).filter(([, v]) => v)); q2.set('przed', last);
        const next = await api('audit?' + q2);
        body.querySelector('#audit-rows').insertAdjacentHTML('beforeend', auditRows(next));
        if (next.length) last = next[next.length - 1].id;
        if (next.length < 100) more.remove();
      });
    }
  }
  function auditRows(rows) {
    const ACT_TYPE = { user: 'użytkownik', agent: 'agent AI', system: 'system', anonim: 'niezalogowany' };
    return rows.map(x => {
      const det = x.details && Object.keys(x.details).length ? Object.entries(x.details).map(([k, v]) => esc(k) + ': ' + esc(typeof v === 'object' ? JSON.stringify(v) : v)).join(', ') : '';
      return `<tr class="${x.status === 'odmowa' ? 'row-deny' : ''}"><td class="nowrap">${esc(fdt(x.ts))}</td><td>${esc(x.actor_label || '–')}<div class="muted small">${esc(ACT_TYPE[x.actor_type] || x.actor_type)}</div></td>
        <td>${esc(ACT_LABEL[x.action] || x.action)}</td><td class="muted">${esc(x.resource || '')}</td>
        <td>${chip(x.status === 'ok' ? 'ok' : x.status === 'odmowa' ? 'deny' : 'warn', x.status === 'ok' ? 'OK' : x.status === 'odmowa' ? 'Odmowa' : 'Błąd')}</td><td class="muted small">${det}</td></tr>`;
    }).join('');
  }

  // =====================================================================
  // Etap 2: Zarząd AI – AI Board, AI Workforce, Ustawienia AI
  // =====================================================================
  const STAGE = { otwarcie: 'Otwarcie posiedzenia', stanowisko: 'Stanowisko', rekomendacja: 'Rekomendacja CEO', pominiete: 'Pominięte' };
  const MEET_ST = { w_toku: 'W toku', oczekuje_decyzji: 'Czeka na decyzję', zakonczone: 'Zakończone', blad: 'Błąd' };
  const AG_ST = { aktywny: 'Aktywny', wylaczony: 'Wyłączony', zatrzymany: 'Zatrzymany' };
  const KIND = { test_promptu: 'Test promptu', zadanie: 'Zadanie', posiedzenie: 'Posiedzenie', raport: 'Raport' };
  const avatar = (a, size) => `<span class="avatar${size ? ' avatar-' + size : ''}" data-bg="${/^#[0-9a-f]{6}$/i.test(a.avatar_color || '') ? a.avatar_color : '#1a1a1a'}" aria-hidden="true">${esc(a.avatar || (a.display_name || '').slice(0, 3))}</span>`;
  const usd = n => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(n) || 0);
  const modeNote = mode => mode === 'live'
    ? '<div class="notice notice-live">Tryb rzeczywisty: agenci korzystają z modeli Claude. Wywołania są płatne i liczone w limitach kosztów.</div>'
    : '<div class="notice notice-test"><b>Tryb testowy.</b> Agenci odpowiadają treściami symulowanymi z danych systemu, bez wywołań modelu Claude i bez kosztów. Tryb rzeczywisty włącza administrator serwera (AI_MODE=live i klucz ANTHROPIC_API_KEY).</div>';
  const pre = t => `<div class="ai-text">${esc(t)}</div>`;

  function orgChart(agents) {
    const by = id => agents.find(a => a.id === id);
    const node = a => a ? `<div class="org-node org-${esc(a.status)}" title="${esc(a.title)}">${avatar(a)}<div><b>${esc(a.display_name)}</b><span>${esc(a.title)}</span></div></div>` : '';
    const dep = (name, ids) => `<div class="org-dep"><p class="org-dep-name">${esc(name)}</p>${ids.length ? ids.map(id => node(by(id))).join('') : '<p class="org-none">Bez agentów AI – platforma szkoleniowa</p>'}</div>`;
    return `<div class="org" aria-label="Struktura Zarządu AI i agentów">
      <div class="org-row">${node(by('ceo'))}</div>
      <div class="org-row org-board">${['cfo', 'coo', 'cso'].map(id => node(by(id))).join('')}</div>
      <div class="org-deps">${dep('Podzielniki i Montaże', ['handlowiec', 'technik', 'rozliczenia'])}${dep('Sprzedaż części i eksport', ['kierownik_sprzedazy', 'eksport'])}${dep('Ubezpieczenia', [])}</div>
    </div>`;
  }

  // ---------- AI Board ----------
  let boardView = null;
  async function aiBoard(root, path, alive) {
    const admin = has('board.convene');
    const body = frame(root, path, 'AI Board', 'Zarząd AI: CEO prowadzi posiedzenie, CFO, COO i CSO przedstawiają stanowiska, a administrator podejmuje decyzję.',
      admin ? `<button type="button" class="btn btn-secondary" id="bd-report">Przygotuj raport</button><button type="button" class="btn btn-primary" id="bd-new">Zwołaj posiedzenie</button>` : '');
    const reload = () => render(path, root);
    if (admin) {
      root.querySelector('#bd-new').addEventListener('click', () => modal('Zwołaj posiedzenie Zarządu AI', `
        <p class="muted">CEO otworzy posiedzenie, CFO, COO i CSO przedstawią stanowiska, CEO sformułuje rekomendację. Rekomendacja trafi do Approval Center.</p>
        ${field('b-topic', 'Temat posiedzenia', `<input id="b-topic" name="topic" maxlength="300" required placeholder="np. Czy uruchomić drugą ekipę montażową od stycznia?">`)}
        ${field('b-ctx', 'Kontekst dla zarządu (opcjonalnie)', `<textarea id="b-ctx" name="context" rows="4" maxlength="4000"></textarea>`)}`,
      { submit: 'Zwołaj posiedzenie', onSubmit: async f => { const m = await api('ai/posiedzenia', { topic: val(f, 'topic'), context: val(f, 'context') }); boardView = m.id; toast('Posiedzenie rozpoczęte.'); reload(); } }));
      const rb = root.querySelector('#bd-report');
      rb.addEventListener('click', async () => {
        rb.disabled = true;
        try { await api('ai/raporty', {}); toast('Raport przygotowany.'); reload(); } catch (x) { toast(x.message); rb.disabled = false; }
      });
    }
    if (boardView) return meetingView(body, boardView, alive, reload);
    const [ag, meetings, reports] = await Promise.all([api('ai/agenci'), api('ai/posiedzenia'), api('ai/raporty')]);
    if (!alive()) return;
    body.innerHTML = `${modeNote(ag.mode)}
      <section class="panel panel-dark"><h2 class="panel-title">Struktura organizacji AI</h2>${orgChart(ag.agents)}</section>
      <div class="cols">
        <section class="panel"><h2 class="panel-title">Posiedzenia</h2>${meetings.length ? `<ul class="meet-list">${meetings.map(m => `<li><button type="button" class="meet" data-meet="${m.id}">
          <span class="meet-t"><b>${esc(m.topic)}</b><span class="muted small">${esc(fdt(m.created_at))} · zwołał ${esc(m.convened_by_login)}${m.mode === 'test' ? ' · tryb testowy' : ''}</span></span>
          ${chip(m.decision || m.status, m.decision ? (m.decision === 'zatwierdzona' ? 'Zatwierdzona' : 'Odrzucona') : MEET_ST[m.status])}</button></li>`).join('')}</ul>`
          : `<p class="empty-inline">${admin ? 'Brak posiedzeń. Zwołaj pierwsze posiedzenie przyciskiem „Zwołaj posiedzenie”.' : 'Brak posiedzeń. Posiedzenia zwołują administratorzy.'}</p>`}</section>
        <section class="panel"><h2 class="panel-title">Raporty zarządu</h2>${reports.length ? reports.slice(0, 5).map((x, i) => `<details class="report"${i === 0 ? ' open' : ''}><summary><b>${esc(x.title)}</b> <span class="muted small">${esc(fdt(x.created_at))} · ${esc(x.created_by_login || 'harmonogram')}</span></summary>${pre(x.content)}${x.run_id && window.MXT_ETAP4 ? window.MXT_ETAP4.rateBar(x.run_id, x.my_rating) : ''}</details>`).join('')
          : `<p class="empty-inline">Brak raportów.${admin ? ' Użyj przycisku „Przygotuj raport” albo włącz dzienny raport w module Automatyzacje.' : ''}</p>`}</section>
      </div>`;
    body.querySelectorAll('[data-meet]').forEach(b => b.addEventListener('click', () => { boardView = b.dataset.meet; reload(); }));
    if (window.MXT_ETAP4) window.MXT_ETAP4.bindRate(body);
  }

  async function meetingView(body, id, alive, reload) {
    let m;
    try { m = await api('ai/posiedzenia/' + id); } catch (e) { boardView = null; throw e; }
    if (!alive()) return;
    const ap = m.approval;
    const decision = ap ? (ap.status === 'oczekuje'
      ? (m.canDecide ? `<div class="decide"><p>Rekomendacja czeka na Twoją decyzję (wersja v${esc(ap.version)} · <span class="mono">${esc(ap.payload_hash.slice(0, 12))}</span>).</p>
          <div class="ap-actions"><button type="button" class="btn btn-primary" data-dec="zatwierdz">Zatwierdź rekomendację</button><button type="button" class="btn btn-secondary" data-dec="odrzuc">Odrzuć</button></div></div>`
        : '<div class="decide"><p>Rekomendacja czeka na decyzję administratora.</p></div>')
      : `<div class="decide decide-${esc(ap.status)}"><p><b>${ap.status === 'zatwierdzona' || ap.status === 'wykonana' ? 'Zatwierdzona' : ap.status === 'odrzucona' ? 'Odrzucona' : esc(AP_ST[ap.status])}</b> przez ${esc(ap.decided_by_login || '–')} · ${esc(fdt(ap.decided_at))}</p>${ap.decision_note ? `<p class="muted">„${esc(ap.decision_note)}”</p>` : ''}</div>`) : '';
    body.innerHTML = `<div><button type="button" class="linkish" id="mt-back">← Wszystkie posiedzenia</button></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">${esc(m.topic)}</h2>${chip(m.status, MEET_ST[m.status])}</div>
        <p class="muted small">Zwołał ${esc(m.convened_by_login)} · ${esc(fdt(m.created_at))}${m.mode === 'test' ? ' · tryb testowy' : ''}</p>
        ${m.context ? `<p class="mt-ctx"><b>Kontekst:</b> ${esc(m.context)}</p>` : ''}
        ${m.status === 'w_toku' ? '<p class="notice">Posiedzenie trwa – protokół uzupełnia się na bieżąco.</p>' : ''}
        ${m.status === 'blad' ? `<p class="notice notice-error">Posiedzenie przerwane: ${esc(m.error)}</p>` : ''}
        <ol class="protocol">${m.contributions.map(c => `<li class="pc pc-${esc(c.stage)}">${avatar(c)}<div class="pc-body"><p class="pc-head"><b>${esc(c.display_name)}</b> <span class="muted small">${esc(c.title)} · ${esc(STAGE[c.stage])}${c.prompt_version ? ' · prompt v' + esc(c.prompt_version) : ''}</span></p>${pre(c.content)}${c.run_id && window.MXT_ETAP4 ? window.MXT_ETAP4.rateBar(c.run_id, c.my_rating) : ''}</div></li>`).join('')}</ol>
        ${decision}</section>`;
    body.querySelector('#mt-back').addEventListener('click', () => { boardView = null; reload(); });
    if (window.MXT_ETAP4) window.MXT_ETAP4.bindRate(body);
    body.querySelectorAll('[data-dec]').forEach(b => b.addEventListener('click', () => {
      const ok = b.dataset.dec === 'zatwierdz';
      modal(ok ? 'Zatwierdź rekomendację zarządu' : 'Odrzuć rekomendację zarządu', `<p><b>${esc(m.topic)}</b></p>
        <p class="muted">Decyzja dotyczy wersji v${esc(ap.version)} rekomendacji i zostanie zapisana w protokole, w Approval Center i w pamięci korporacyjnej agentów.</p>
        ${field('d-note', ok ? 'Komentarz (opcjonalnie)' : 'Powód odrzucenia', '<textarea id="d-note" name="note" rows="3"></textarea>')}`,
      { submit: ok ? 'Zatwierdzam' : 'Odrzucam', danger: !ok, onSubmit: async f => { await api('approvals/' + ap.id + '/decyzja', { decision: b.dataset.dec, version: ap.version, note: val(f, 'note') }); toast('Decyzja zapisana.'); reload(); } });
    }));
    if (m.status === 'w_toku') setTimeout(() => { if (alive()) reload(); }, 1500);
  }

  // ---------- AI Workforce ----------
  let wfAgent = null;
  async function aiWorkforce(root, path, alive) {
    const body = frame(root, path, 'AI Workforce', 'Profile agentów AI, statusy, historia zadań i wyniki.');
    const reload = () => render(path, root);
    if (wfAgent) return agentProfile(body, wfAgent, alive, reload);
    const d = await api('ai/agenci');
    if (!alive()) return;
    const card = a => {
      const pct = a.cost_limit > 0 ? Math.min(100, Math.round(a.month_cost / a.cost_limit * 100)) : 0;
      return `<button type="button" class="wf-card" data-agent="${esc(a.id)}">
        <div class="wf-top">${avatar(a, 'lg')}<div class="wf-name"><b>${esc(a.display_name)}</b><span class="muted small">${esc(a.title)}</span></div>${chip(a.status, AG_ST[a.status])}</div>
        <dl class="wf-stats"><div><dt>Uruchomienia</dt><dd>${esc(a.runs_total)}</dd></div><div><dt>Udane</dt><dd>${a.runs_total ? Math.round(a.runs_ok / a.runs_total * 100) + '%' : '–'}</dd></div>
          <div><dt>Zadania otwarte</dt><dd>${esc(a.open_tasks)}</dd></div><div><dt>Prompt</dt><dd>v${esc(a.prompt_version)}</dd></div></dl>
        <div class="wf-cost"><span class="small">Koszt w tym miesiącu: <b>${esc(usd(a.month_cost))}</b> z ${esc(usd(a.cost_limit))}</span><div class="bar" aria-hidden="true"><i data-w="${pct}"></i></div></div>
      </button>`;
    };
    const group = (t, list) => `<section class="panel"><h2 class="panel-title">${esc(t)}</h2><div class="wf-grid">${list.map(card).join('')}</div></section>`;
    body.innerHTML = modeNote(d.mode) + (d.stopped ? '<div class="notice notice-error">Wszyscy agenci są zatrzymani wyłącznikiem bezpieczeństwa.</div>' : '') +
      group('Zarząd AI', d.agents.filter(a => a.agent_group === 'zarzad')) +
      group('Podzielniki i Montaże', d.agents.filter(a => a.department_id === 'podzielniki-i-montaze')) +
      group('Sprzedaż części i eksport', d.agents.filter(a => a.department_id === 'sprzedaz-czesci-i-eksport')) +
      '<p class="small"><button type="button" class="linkish" data-go-sc>Karta wyników agentów →</button></p>';
    body.querySelectorAll('[data-agent]').forEach(b => b.addEventListener('click', () => { wfAgent = b.dataset.agent; reload(); }));
    const gsc = body.querySelector('[data-go-sc]'); if (gsc) gsc.addEventListener('click', () => go('/karta-wynikow'));
  }
  async function agentProfile(body, id, alive, reload) {
    const d = await api('ai/agenci/' + id);
    if (!alive()) return;
    const a = d.agent;
    body.innerHTML = `<div><button type="button" class="linkish" id="wf-back">← Wszyscy agenci</button></div>
      <section class="panel"><div class="wf-top">${avatar(a, 'lg')}<div class="wf-name"><h2 class="panel-title">${esc(a.display_name)}</h2><span class="muted">${esc(a.title)}${a.department_name ? ' · ' + esc(a.department_name) : ''}</span></div>${chip(a.status, AG_ST[a.status])}</div>
        <dl class="ap-meta"><div><dt>Model</dt><dd>${esc(a.model)}</dd></div><div><dt>Wysiłek</dt><dd>${esc(a.effort)}</dd></div><div><dt>Prompt</dt><dd>wersja ${esc(a.prompt_version)}</dd></div>
          <div><dt>Koszt (miesiąc)</dt><dd>${esc(usd(a.month_cost))} / ${esc(usd(a.cost_limit))}</dd></div><div><dt>Ostatnie uruchomienie</dt><dd>${esc(fdt(a.last_run))}</dd></div></dl>
        <h3 class="panel-sub">Narzędzia stanowiska</h3><ul class="tool-list">${a.tools.map(t => `<li>${esc(t.label)}</li>`).join('')}</ul>
        <h3 class="panel-sub">Operacje, które może zgłaszać</h3><ul class="tool-list">${a.operations.map(o => `<li>${esc(o.label)}</li>`).join('')}</ul></section>
      <section class="panel"><h2 class="panel-title">Historia uruchomień</h2>${d.runs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Czas</th><th>Rodzaj</th><th>Temat</th><th>Status</th><th>Tryb</th><th class="num">Tokeny</th><th class="num">Koszt</th><th>Zlecił</th></tr></thead><tbody>
        ${d.runs.map(x => `<tr><td class="nowrap">${esc(fdt(x.created_at))}</td><td>${esc(KIND[x.kind] || x.kind)}</td><td>${esc(x.input_summary)}${x.error ? `<div class="small txt-danger">${esc(x.error)}</div>` : ''}</td>
          <td>${chip(x.status === 'ok' ? 'ok' : x.status === 'blad' ? 'deny' : 'warn', x.status === 'ok' ? 'OK' : x.status === 'blad' ? 'Błąd' : x.status === 'odmowa' ? 'Odmowa' : 'Zablokowane')}</td>
          <td>${x.mode === 'live' ? 'Claude' : 'testowy'}</td><td class="num">${esc(x.input_tokens + x.output_tokens)}</td><td class="num">${esc(usd(x.cost_usd))}</td><td>${esc(x.user_login || '–')}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty-inline">Agent nie był jeszcze uruchamiany.</p>'}</section>
      <div class="cols">
        <section class="panel"><h2 class="panel-title">Zadania agenta</h2>${d.tasks.length ? `<ul class="pend-list">${d.tasks.map(t => `<li class="pend"><div><b>${esc(t.title)}</b><span class="muted small">${t.due_date ? 'termin ' + esc(fd(t.due_date)) : 'bez terminu'}</span></div><div class="pend-r">${chip('p-' + t.priority, PRIO[t.priority])}${chip(t.status, TASK_ST[t.status])}</div></li>`).join('')}</ul>` : '<p class="empty-inline">Brak zadań. Zadanie dla agenta dodasz w module Zadania.</p>'}</section>
        <section class="panel"><h2 class="panel-title">Pamięć dostępna dla agenta</h2>${d.memory.length ? `<ul class="mem-list">${d.memory.map(x => `<li>${chip('soon', x.scope)} ${esc(x.content)}<span class="muted small"> · ${esc(fdt(x.created_at))}</span></li>`).join('')}</ul>` : '<p class="empty-inline">Pamięć jest pusta. Wpisy pojawiają się m.in. po decyzjach w sprawie rekomendacji zarządu.</p>'}</section>
      </div>`;
    body.querySelector('#wf-back').addEventListener('click', () => { wfAgent = null; reload(); });
  }

  // ---------- Ustawienia AI ----------
  let aiTab = 'zarzad', aiEdit = null;
  async function aiSettings(root, path, alive) {
    const body = frame(root, path, 'Ustawienia AI', 'Konfiguracja Zarządu AI i agentów działowych. Każda zmiana jest zapisywana w rejestrze operacji.');
    const reload = () => render(path, root);
    const d = await api('ai/ustawienia');
    if (!alive()) return;
    if (aiEdit) { const a = d.agents.find(x => x.id === aiEdit); if (a) return agentEditor(body, a, d, alive, reload); aiEdit = null; }
    const list = d.agents.filter(a => aiTab === 'zarzad' ? a.agent_group === 'zarzad' : a.agent_group === 'dzial');
    const card = a => `<article class="set-card">${avatar(a, 'lg')}<div class="set-main"><b>${esc(a.display_name)}</b><span class="muted small">${esc(a.title)}</span>
        <span class="small">${esc((d.models[a.model] || {}).label || a.model)} · prompt v${esc(a.prompt_version)} · limit ${esc(usd(a.cost_limit))}/mies.</span></div>
        <div class="set-side">${chip(a.status, AG_ST[a.status])}<button type="button" class="btn btn-secondary btn-sm" data-edit-agent="${esc(a.id)}">Edytuj</button></div></article>`;
    const deps = aiTab === 'dzial' ? [['podzielniki-i-montaze', 'Podzielniki i Montaże'], ['sprzedaz-czesci-i-eksport', 'Sprzedaż części i eksport']] : null;
    body.innerHTML = modeNote(d.mode) + `<div class="seg" role="tablist">${[['zarzad', 'Zarząd AI'], ['dzial', 'Agenci działowi']].map(([k, v]) => `<button type="button" role="tab" class="seg-b${aiTab === k ? ' seg-on' : ''}" aria-selected="${aiTab === k}" data-aitab="${k}">${v}</button>`).join('')}</div>` +
      (deps ? deps.map(([id, n]) => `<section class="panel"><h2 class="panel-title">${esc(n)}</h2><div class="set-list">${list.filter(a => a.department_id === id).map(card).join('')}</div></section>`).join('') +
        '<p class="muted small">Dział Ubezpieczenia nie ma agentów AI.</p>'
        : `<section class="panel"><div class="set-list">${list.map(card).join('')}</div></section>`);
    body.querySelectorAll('[data-aitab]').forEach(b => b.addEventListener('click', () => { aiTab = b.dataset.aitab; reload(); }));
    body.querySelectorAll('[data-edit-agent]').forEach(b => b.addEventListener('click', () => { aiEdit = b.dataset.editAgent; reload(); }));
  }

  function lineDiff(a, b) {
    const x = String(a).split('\n'), y = String(b).split('\n'), n = x.length, m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) { if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', x[i++]]); else out.push(['+', y[j++]]); }
    while (i < n) out.push(['-', x[i++]]); while (j < m) out.push(['+', y[j++]]);
    return out;
  }
  const diffHtml = (a, b) => `<pre class="diff">${lineDiff(a, b).map(([t, l]) => `<span class="d${t === '+' ? 'a' : t === '-' ? 'r' : 'n'}">${t} ${esc(l)}</span>`).join('\n')}</pre>`;

  function agentEditor(body, a, d, alive, reload) {
    const COLORS = ['#1a1a1a', '#c8131c', '#8a6d1f', '#0b7f86', '#9a5b00', '#1d7a46', '#4a4a4a'];   // czerń, czerwień i złoto MXT + kolory pomocnicze
    body.innerHTML = `<div><button type="button" class="linkish" id="ae-back">← Lista agentów</button></div>
      <form class="panel ae" id="ae" novalidate>
        <div class="wf-top"><span id="ae-av">${avatar(a, 'lg')}</span><div class="wf-name"><h2 class="panel-title">${esc(a.display_name)}</h2><span class="muted">${esc(a.title)}</span></div>${chip(a.status, AG_ST[a.status])}</div>
        <div class="field-row">
          ${field('ae-name', 'Nazwa wyświetlana', `<input id="ae-name" name="display_name" maxlength="60" value="${esc(a.display_name)}">`)}
          ${field('ae-av-t', 'Awatar (skrót, 1–4 znaki)', `<input id="ae-av-t" name="avatar" maxlength="4" value="${esc(a.avatar)}">`)}
          <div class="field"><span class="flabel">Kolor awatara</span><div class="swatches" role="radiogroup" aria-label="Kolor awatara">${COLORS.map(c => `<label class="sw"><input type="radio" name="avatar_color" value="${c}"${c === a.avatar_color ? ' checked' : ''}><span data-bg="${c}"></span><span class="visually-hidden">${c}</span></label>`).join('')}</div></div>
        </div>
        ${field('ae-prompt', 'Prompt systemowy (wersja ' + a.prompt_version + ')', `<textarea id="ae-prompt" name="prompt_text" rows="16" class="prompt-area" maxlength="20000">${esc(a.prompt_text)}</textarea>`)}
        <p class="muted small">Twarde reguły bezpieczeństwa (brak prawa zatwierdzania, tylko przypisane narzędzia, dane wyłącznie z systemu) dodaje i egzekwuje system – nie da się ich zmienić ani wyłączyć w prompcie.</p>
        <div class="field-row">
          ${field('ae-model', 'Model AI', `<select id="ae-model" name="model">${Object.entries(d.models).map(([k, v]) => `<option value="${k}"${k === a.model ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select>`)}
          ${field('ae-effort', 'Poziom wysiłku (głębia analizy)', `<select id="ae-effort" name="effort">${Object.entries(d.efforts).map(([k, v]) => `<option value="${k}"${k === a.effort ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`)}
          ${field('ae-temp', 'Temperatura (kreatywność): ' + Number(a.temperature).toFixed(2), `<input id="ae-temp" name="temperature" type="range" min="0" max="1" step="0.05" value="${esc(a.temperature)}">`)}
          ${field('ae-limit', 'Miesięczny limit kosztów (USD)', `<input id="ae-limit" name="cost_limit" type="number" min="0" step="1" value="${esc(a.cost_limit)}">`)}
        </div>
        <p class="muted small">Modele Claude 5.5 nie przyjmują parametru temperatury: wartość jest zapisywana w ustawieniach, a styl i głębię odpowiedzi kształtują prompt oraz poziom wysiłku. Koszt w tym miesiącu: ${esc(usd(a.month_cost))}.</p>
        <label class="toggle"><input type="checkbox" name="is_active"${a.is_active ? ' checked' : ''}> <span>Agent aktywny</span></label>
        <div class="cols cols-even">
          <div><h3 class="panel-sub">Przypisane narzędzia (podgląd)</h3><ul class="tool-list">${a.tools.map(t => `<li>${esc(t.label)}</li>`).join('')}</ul></div>
          <div><h3 class="panel-sub">Operacje do zgłaszania (podgląd)</h3><ul class="tool-list">${a.operations.map(o => `<li>${esc(o.label)}</li>`).join('')}</ul></div>
        </div>
        <p class="muted small">Zakres narzędzi wynika ze stanowiska i nie może zostać rozszerzony w ustawieniach.</p>
        <div class="ae-actions">
          <button type="button" class="btn btn-secondary" id="ae-test">Testuj prompt</button>
          <button type="button" class="btn btn-secondary" id="ae-hist">Historia wersji</button>
          <button type="button" class="btn btn-ghost" id="ae-def">Przywróć domyślny</button>
          <span class="ae-spacer"></span>
          <button type="submit" class="btn btn-primary">Zapisz zmiany</button>
        </div>
      </form>
      <section class="panel" id="ae-versions" hidden></section>`;
    const f = body.querySelector('#ae'), reloadEdit = reload;
    body.querySelector('#ae-back').addEventListener('click', () => { aiEdit = null; reload(); });
    const tl = f.querySelector('label[for="ae-temp"]');
    f.elements.temperature.addEventListener('input', e => { tl.textContent = 'Temperatura (kreatywność): ' + Number(e.target.value).toFixed(2); });
    const repaintAv = () => { body.querySelector('#ae-av').innerHTML = avatar({ avatar: f.elements.avatar.value.toUpperCase(), avatar_color: (f.querySelector('[name=avatar_color]:checked') || {}).value }, 'lg'); };
    f.elements.avatar.addEventListener('input', repaintAv); f.querySelectorAll('[name=avatar_color]').forEach(x => x.addEventListener('change', repaintAv));
    const collect = () => ({
      display_name: f.elements.display_name.value, avatar: f.elements.avatar.value, avatar_color: (f.querySelector('[name=avatar_color]:checked') || {}).value || a.avatar_color,
      prompt_text: f.elements.prompt_text.value, model: f.elements.model.value, effort: f.elements.effort.value, temperature: Number(f.elements.temperature.value),
      cost_limit: Number(f.elements.cost_limit.value), is_active: f.elements.is_active.checked
    });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const n = collect(), labels = { display_name: 'Nazwa', avatar: 'Awatar', avatar_color: 'Kolor awatara', model: 'Model', effort: 'Poziom wysiłku', temperature: 'Temperatura', cost_limit: 'Limit kosztów', is_active: 'Status' };
      const ch = Object.keys(labels).filter(k => String(n[k]) !== String(k === 'temperature' || k === 'cost_limit' ? Number(a[k]) : a[k]));
      const promptChanged = n.prompt_text !== a.prompt_text;
      if (!ch.length && !promptChanged) return toast('Brak zmian do zapisania.');
      modal('Zapisać zmiany ustawień agenta?', `<p>Agent: <b>${esc(a.display_name)}</b></p><ul class="tool-list">${ch.map(k => `<li>${esc(labels[k])}: ${esc(k === 'is_active' ? (n[k] ? 'aktywny' : 'wyłączony') : a[k])} → <b>${esc(k === 'is_active' ? (n[k] ? 'aktywny' : 'wyłączony') : n[k])}</b></li>`).join('')}
        ${promptChanged ? `<li>Prompt systemowy: nowa wersja ${esc(a.prompt_version + 1)}</li>` : ''}</ul>${promptChanged ? '<h3 class="panel-sub">Zmiany w prompcie</h3>' + diffHtml(a.prompt_text, n.prompt_text) : ''}
        <p class="muted small">Zmiana zostanie zapisana w rejestrze operacji. Agenci użyją nowego promptu od następnego uruchomienia.</p>`,
      { submit: 'Zapisz', wide: true, onSubmit: async () => { const r = await api('ai/ustawienia/' + a.id, n, 'PUT'); toast(r.prompt_version ? 'Zapisano. Nowa wersja promptu: ' + r.prompt_version + '.' : 'Ustawienia zapisane.'); reloadEdit(); } });
    });
    body.querySelector('#ae-test').addEventListener('click', () => {
      const box = modal('Test promptu – ' + a.display_name, `<p class="muted">Wiadomość trafi do agenta z promptem z edytora (także niezapisanym). Test nie wykonuje żadnych operacji w systemie i nie używa narzędzi.</p>
        ${field('tp-msg', 'Wiadomość testowa', '<textarea id="tp-msg" name="message" rows="3" required>Przedstaw się i opisz krótko, za co odpowiadasz.</textarea>')}<div id="tp-out"></div>`,
      { submit: 'Wyślij do agenta', wide: true, onSubmit: async form => {
        const out = box.querySelector('#tp-out'); out.innerHTML = '<p class="muted">Agent przygotowuje odpowiedź…</p>';
        const r = await api('ai/ustawienia/' + a.id + '/test', { prompt_text: f.elements.prompt_text.value, message: val(form, 'message') });
        out.innerHTML = `<h3 class="panel-sub">Odpowiedź ${r.mode === 'live' ? '(Claude)' : '(tryb testowy)'}</h3>${pre(r.text)}<p class="muted small">Tokeny: ${esc(r.tokens.input)} wej. / ${esc(r.tokens.output)} wyj. · koszt ${esc(usd(r.cost_usd))}</p>`;
        throw Object.assign(new Error(''), { keepOpen: true });
      } });
    });
    body.querySelector('#ae-def').addEventListener('click', () => modal('Przywrócić domyślny prompt?', '<p>Domyślny prompt dostarczony z systemem zostanie zapisany jako nowa wersja. Historia zostaje zachowana.</p>',
      { submit: 'Przywróć domyślny', onSubmit: async () => { const r = await api('ai/ustawienia/' + a.id + '/domyslny', {}); toast('Przywrócono prompt domyślny jako wersję ' + r.prompt_version + '.'); reloadEdit(); } }));
    body.querySelector('#ae-hist').addEventListener('click', async () => {
      const sec = body.querySelector('#ae-versions');
      if (!sec.hidden) { sec.hidden = true; return; }
      const vs = await api('ai/ustawienia/' + a.id + '/wersje');
      const cur = vs.find(v => v.is_current) || vs[0];
      sec.innerHTML = `<h2 class="panel-title">Historia wersji promptu</h2><ol class="versions">${vs.map(v => `<li class="ver${v.is_current ? ' ver-cur' : ''}">
        <div class="ver-head"><b>Wersja ${esc(v.version)}</b> <span class="muted small">${esc(v.author)} · ${esc(fdt(v.created_at))}${v.restored_from ? ' · przywrócona z v' + esc(v.restored_from) : ''}</span>
          ${v.is_current ? chip('ok', 'Aktualna') : ''}${v.is_default ? chip('soon', 'Domyślna') : ''}</div>
        <div class="ver-acts"><button type="button" class="btn btn-ghost btn-sm" data-vdiff="${v.version}">${v.is_current ? 'Pokaż treść' : 'Różnice względem aktualnej'}</button>
          ${v.is_current ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-vrest="${v.version}">Przywróć tę wersję</button>`}</div>
        <div class="ver-diff" id="vd-${v.version}" hidden></div></li>`).join('')}</ol>`;
      sec.hidden = false;
      sec.querySelectorAll('[data-vdiff]').forEach(b => b.addEventListener('click', () => {
        const v = vs.find(x => String(x.version) === b.dataset.vdiff), box = sec.querySelector('#vd-' + v.version);
        box.innerHTML = v.is_current ? pre(v.prompt_text) : diffHtml(v.prompt_text, cur.prompt_text) + '<p class="muted small">„−” treść tej wersji usunięta w aktualnej, „+” dodana w aktualnej.</p>';
        box.hidden = !box.hidden;
      }));
      sec.querySelectorAll('[data-vrest]').forEach(b => b.addEventListener('click', () => modal('Przywrócić wersję ' + b.dataset.vrest + '?', '<p>Treść tej wersji zostanie zapisana jako nowa, aktualna wersja promptu.</p>',
        { submit: 'Przywróć tę wersję', onSubmit: async () => { const r = await api('ai/ustawienia/' + a.id + '/przywroc', { version: Number(b.dataset.vrest) }); toast('Przywrócono jako wersję ' + r.prompt_version + '.'); reloadEdit(); } })));
    });
  }

  // ---------- zadania przydzielone agentom ----------
  async function agentTaskPanel(box, t, after) {
    const holder = document.createElement('div'); holder.className = 'agent-task';
    holder.innerHTML = `<h3 class="panel-sub">Agent AI: ${esc(t.assignee_login || t.assignee_id)}</h3>
      <button type="button" class="btn btn-secondary btn-sm" id="at-run">Uruchom agenta</button><div id="at-out"><p class="muted small">Wczytywanie wyników…</p></div>`;
    box.querySelector('.modal-content').append(holder);
    const rate = x => x.status === 'ok' && window.MXT_ETAP4 ? window.MXT_ETAP4.rateBar(x.id, x.my_rating) : '';
    const show = rows => { const o = holder.querySelector('#at-out'); o.innerHTML = rows.length ? rows.map(x => `<details class="report"${x === rows[0] ? ' open' : ''}><summary>${esc(fdt(x.created_at))} · ${x.mode === 'live' ? 'Claude' : 'tryb testowy'} · ${esc(x.user_login || '')}</summary>${x.error ? `<p class="txt-danger small">${esc(x.error)}</p>` : pre(x.output) + rate(x)}</details>`).join('') : '<p class="muted small">Agent nie pracował jeszcze nad tym zadaniem.</p>';
      if (window.MXT_ETAP4) window.MXT_ETAP4.bindRate(o); };
    try { show(await api('ai/zadania/' + t.id + '/wyniki')); } catch (e) { holder.querySelector('#at-out').innerHTML = `<p class="small txt-danger">${esc(e.message)}</p>`; }
    const runBtn = holder.querySelector('#at-run');
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true; holder.querySelector('#at-out').insertAdjacentHTML('afterbegin', '<p class="muted small" id="at-wait">Agent pracuje…</p>');
      try { await api('ai/zadania/' + t.id + '/uruchom', {}); show(await api('ai/zadania/' + t.id + '/wyniki')); toast('Agent zakończył pracę.'); }
      catch (x) { toast(x.message); const w = holder.querySelector('#at-wait'); if (w) w.remove(); }
      runBtn.disabled = false;
    });
  }

  // CSP (style-src 'self') blokuje atrybuty style w HTML – kolory i szerokości ustawiamy przez CSSOM.
  const paint = n => {
    if (n.nodeType !== 1) return;
    const all = n.matches && n.matches('[data-bg],[data-w]') ? [n, ...n.querySelectorAll('[data-bg],[data-w]')] : n.querySelectorAll('[data-bg],[data-w]');
    for (const e of all) { if (e.dataset.bg) e.style.background = e.dataset.bg; if (e.dataset.w) e.style.width = Math.max(0, Math.min(100, Number(e.dataset.w))) + '%'; }
  };
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(paint))).observe(document.documentElement, { childList: true, subtree: true });

  // Rejestracja modułów z innych plików (działy, CRM, finanse, wiedza, szkolenia) i wspólne komponenty UI.
  // tab: zakładka w nawigacji modułów (i pozycja w menu); menu: tylko pozycja w menu (np. Powiadomienia).
  function register(path, def, { tab = false, after = null, menu: inMenu = false } = {}) {
    ROUTES[path] = def;
    if (tab && !TABS.includes(path)) { const i = after ? TABS.indexOf(after) : -1; i >= 0 ? TABS.splice(i + 1, 0, path) : TABS.push(path); }
    if (inMenu && !MENU_EXTRA.includes(path)) MENU_EXTRA.push(path);
  }
  // Ramka strony działu: logo (z ekranu), etykieta „Dział”, nazwa, „Powrót do wyboru działu”, zakładki działu.
  function deptFrame(root, title, tabs, active, onTab, lead) {
    root.innerHTML = `<div class="dept-head"><p class="eyebrow">Dział</p><h1 class="mod-title">${esc(title)}</h1>${lead ? `<p class="mod-lead">${esc(lead)}</p>` : ''}
      <button type="button" class="btn btn-secondary btn-sm" data-back>Powrót do wyboru działu</button></div>
      ${tabs.length > 1 ? `<nav class="modnav dept-tabs" aria-label="Funkcje działu">${tabs.map(([k, v]) => `<button type="button" class="tab${k === active ? ' tab-on' : ''}" data-dtab="${k}"${k === active ? ' aria-current="page"' : ''}>${esc(v)}</button>`).join('')}</nav>` : ''}
      <div class="mod-body" id="mod-body"><p class="muted loading">Wczytywanie…</p></div>`;
    root.querySelector('[data-back]').addEventListener('click', () => go('/dzialy'));
    root.querySelectorAll('[data-dtab]').forEach(b => b.addEventListener('click', () => onTab(b.dataset.dtab)));
    return root.querySelector('#mod-body');
  }
  window.MXT_UI = { esc, api, go, toast, me, has, meta, modal, field, val, chip, fdt, fd, money, frame, deptFrame, render, pre, avatar, usd, taskForm, today };

  window.MXT_MODULES = { routes: ROUTES, render, menu, register };
})();
