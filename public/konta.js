'use strict';
// Konta i role (administrator) oraz Powiadomienia (każde konto): dzwonek, push na telefon, kopia e-mail.
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), modal = (...a) => U().modal(...a);
  const field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), chip = (...a) => U().chip(...a), fdt = v => U().fdt(v);

  // ---------- Konta i role ----------
  const ROLE_HELP = {
    administrator: 'pełny dostęp, konta, akceptacje',
    uzytkownik: 'praca w działach, CRM, finanse',
    kierownik: 'jak biuro; od etapu 2 – projekty, harmonogramy, zatwierdzanie rozliczeń',
    rozliczajacy: 'jak biuro; od etapu 2 – rozliczenia prac i materiałów',
    monter: 'tylko „Moje montaże” własnej ekipy, bez finansów'
  };
  async function accountsPage(root, path, alive) {
    const body = U().frame(root, path, 'Konta i role', 'Konta pracowników: role, powiązanie z instalatorem, wyłączanie kont i reset hasła.',
      '<button type="button" class="btn btn-primary" id="acc-new">Nowe konto</button>');
    const reload = () => U().render(path, root);
    const [list, M, inst] = await Promise.all([api('konta'), U().meta(), api('konta/instalatorzy')]);
    if (!alive()) return;
    const roleTxt = a => [a.role, ...(a.extra_roles || [])].map(r => M.roles[r] || r).join(' + ');
    const active = list.filter(a => a.is_active), off = list.filter(a => !a.is_active);
    const rows = arr => arr.map(a => `<tr class="${a.is_active ? '' : 'row-off'}">
        <td><b>${esc(a.login)}</b><div class="muted small">${esc(a.full_name || '–')}</div></td>
        <td>${a.role === 'administrator' ? chip('admin', roleTxt(a)) : esc(roleTxt(a))}</td>
        <td class="small">${a.installer_name ? esc(a.installer_name) + (a.crew_name ? '<div class="muted">ekipa: ' + esc(a.crew_name) + '</div>' : '<div class="muted">bez ekipy</div>') : '<span class="muted">–</span>'}</td>
        <td class="small">${esc(a.email || '–')}${a.phone ? '<div class="muted">' + esc(a.phone) + '</div>' : ''}</td>
        <td>${!a.is_active ? chip('off', 'wyłączone') : a.must_change_password ? chip('warn', 'hasło tymczasowe') : chip('ok', 'aktywne')}</td>
        <td class="small">${esc(fdt(a.last_login))}${a.push_devices ? '<div class="muted">push: ' + esc(a.push_devices) + ' urz.</div>' : ''}</td>
        <td class="nowrap"><button type="button" class="btn btn-ghost btn-sm" data-edit="${a.id}">Edytuj</button>${a.id === U().me().id ? '' : a.is_active
          ? `<button type="button" class="btn btn-ghost btn-sm" data-reset="${a.id}">Reset hasła</button>` : ''}</td></tr>`).join('');
    body.innerHTML = `
      <section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Konto</th><th>Role</th><th>Instalator</th><th>Kontakt</th><th>Status</th><th>Ostatnie logowanie</th><th></th></tr></thead>
        <tbody>${rows(active)}${rows(off)}</tbody></table></div>
        <p class="muted small">Kont się nie usuwa: po odejściu pracownika wyłącz konto – jego wpisy zostają w historii. Nowe konto dostaje hasło tymczasowe; pracownik ustawia własne przy pierwszym logowaniu.</p></section>
      <section class="panel"><h2 class="panel-title">Role</h2><ul class="role-help">${Object.entries(M.roles).map(([k, v]) => `<li><b>${esc(v)}</b> – ${esc(ROLE_HELP[k] || '')}</li>`).join('')}</ul>
        <p class="muted small">Konto może mieć rolę główną i role dodatkowe (np. monter, który też rozlicza) – uprawnienia się sumują. Pełna tabela uprawnień: Security &amp; Audit.</p></section>`;
    body.parentElement.querySelector('#acc-new').addEventListener('click', () => accountForm(null, M, inst, reload));
    body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => accountForm(list.find(a => a.id === b.dataset.edit), M, inst, reload)));
    body.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () => {
      const a = list.find(x => x.id === b.dataset.reset);
      modal('Zresetować hasło konta ' + a.login + '?', '<p>Konto zostanie wylogowane ze wszystkich urządzeń. Otrzymasz hasło tymczasowe do przekazania pracownikowi – przy logowaniu ustawi własne.</p>',
        { submit: 'Resetuj hasło', danger: true, onSubmit: async () => {
          const r = await api('konta/' + a.id + '/reset-hasla', {});
          setTimeout(() => showTemp(r), 50); reload();
        } });
    }));
  }
  function showTemp(r) {
    modal('Hasło tymczasowe: ' + r.login, `<p>${esc(r.info)}</p><p class="label-sm">Login</p><p class="mono sel token-box">${esc(r.login)}</p>
      <p class="label-sm">Hasło tymczasowe (pokazywane tylko teraz)</p><p class="mono sel token-box">${esc(r.temporary_password)}</p>`, {});
  }
  function accountForm(a, M, inst, after) {
    const isNew = !a, self = a && a.id === U().me().id, d = a || { role: 'monter', extra_roles: [], is_active: true };
    const extras = ['uzytkownik', 'kierownik', 'rozliczajacy', 'monter'];
    const free = inst.filter(i => i.is_active && (!i.user_id || (a && i.user_id === a.id)));
    modal(isNew ? 'Nowe konto pracownika' : 'Konto ' + a.login, `
      ${isNew ? field('a-login', 'Login (do logowania)', '<input id="a-login" name="login" required maxlength="64" autocapitalize="none" autocomplete="off" placeholder="np. j.kowalski">') : ''}
      ${field('a-name', 'Imię i nazwisko', `<input id="a-name" name="full_name" required maxlength="120" value="${esc(d.full_name || '')}">`)}
      <div class="field-row">${field('a-email', 'E-mail (opcjonalnie)', `<input id="a-email" name="email" type="email" maxlength="200" value="${esc(d.email || '')}">`)}
        ${field('a-phone', 'Telefon (opcjonalnie)', `<input id="a-phone" name="phone" type="tel" maxlength="40" value="${esc(d.phone || '')}">`)}</div>
      ${field('a-role', 'Rola główna', `<select id="a-role" name="role"${self ? ' disabled' : ''}>${Object.entries(M.roles).map(([k, v]) => `<option value="${k}"${d.role === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`)}
      <fieldset class="checks"><legend>Role dodatkowe</legend>${extras.map(r => `<label class="toggle"><input type="checkbox" name="extra" value="${r}"${(d.extra_roles || []).includes(r) ? ' checked' : ''}> ${esc(M.roles[r])}</label>`).join('')}</fieldset>
      ${field('a-inst', 'Powiązany instalator (monter widzi montaże jego ekipy)', `<select id="a-inst" name="installer_id"><option value="">– brak –</option>${free.map(i =>
        `<option value="${i.id}"${a && i.user_id === a.id ? ' selected' : ''}>${esc(i.name)}${i.crew_name ? ' – ' + esc(i.crew_name) : ' – bez ekipy'}</option>`).join('')}</select>`)}
      ${free.length ? '' : '<p class="muted small">Brak wolnych instalatorów. Dodaj instalatora w dziale Podzielniki i Montaże → Ekipy i instalatorzy.</p>'}
      ${!isNew && !self ? `<label class="toggle"><input type="checkbox" name="is_active"${d.is_active ? ' checked' : ''}> Konto aktywne (wyłączone konto nie może się zalogować, dane zostają)</label>` : ''}`,
    { submit: isNew ? 'Utwórz konto' : 'Zapisz', onSubmit: async f => {
      const extra = [...f.querySelectorAll('input[name=extra]:checked')].map(x => x.value);
      const body = { full_name: val(f, 'full_name'), email: val(f, 'email'), phone: val(f, 'phone'), extra_roles: extra, installer_id: val(f, 'installer_id') || null };
      if (!self) body.role = val(f, 'role');
      if (!isNew && !self) body.is_active = f.querySelector('[name=is_active]').checked;
      if (isNew) {
        body.login = val(f, 'login').trim().toLowerCase();
        const r = await api('konta', body);
        setTimeout(() => showTemp(r), 50);
      } else {
        await api('konta/' + a.id, body, 'PATCH');
        toast(body.is_active === false && a.is_active ? 'Konto wyłączone i wylogowane.' : 'Zapisano zmiany konta.');
      }
      after();
    } });
  }

  // ---------- Powiadomienia ----------
  const KIND = { 'montaz.przydzial': 'Przydział', 'montaz.zmiana_terminu': 'Zmiana terminu', 'montaz.odwolanie': 'Przekazanie', 'montaz.anulowanie': 'Anulowanie',
    'ekipa.przydzial': 'Ekipa', test: 'Test' };
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function keyBytes(b64) {
    const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function enablePush(publicKey) {
    if (!pushSupported()) throw new Error(isIos() ? 'Na iPhonie dodaj najpierw MXT do ekranu głównego (Udostępnij → Do ekranu początkowego) i otwórz aplikację z ikony.' : 'Ta przeglądarka nie obsługuje powiadomień push.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Powiadomienia są zablokowane w ustawieniach przeglądarki lub telefonu. Zezwól na nie i spróbuj ponownie.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const j = sub.toJSON();
    await api('powiadomienia/push', { endpoint: j.endpoint, keys: j.keys });
  }
  async function notificationsPage(root, path, alive) {
    const body = U().frame(root, path, 'Powiadomienia', 'Przydziały, zmiany terminów i inne informacje dla Ciebie.',
      '<button type="button" class="btn btn-secondary" id="n-all">Oznacz wszystkie jako przeczytane</button>');
    const reload = () => U().render(path, root);
    const [list, s, sub] = await Promise.all([api('powiadomienia'), api('powiadomienia/ustawienia'), currentSub().catch(() => null)]);
    if (!alive()) return;
    const unread = list.filter(n => !n.read_at).length;
    body.innerHTML = `
      <section class="panel">${list.length ? `<ul class="notif-list">${list.map(n => `<li class="notif${n.read_at ? '' : ' notif-new'}">
          <button type="button" class="notif-b" data-n="${n.id}" data-link="${esc(n.link)}">
            <span class="notif-top"><span class="notif-kind">${esc(KIND[n.kind] || 'Informacja')}</span><span class="muted small">${esc(fdt(n.created_at))}</span></span>
            <span class="notif-title">${esc(n.title)}</span>${n.body ? `<span class="notif-body">${esc(n.body)}</span>` : ''}</button></li>`).join('')}</ul>`
        : '<p class="empty-inline">Nie masz jeszcze powiadomień. Pojawią się tu np. przydziały montaży i zmiany terminów.</p>'}</section>
      <section class="panel"><h2 class="panel-title">Ustawienia powiadomień</h2>
        <div class="set-row"><div><b>Powiadomienia na tym urządzeniu</b><p class="muted small">${sub ? 'Włączone – telefon pokaże powiadomienie nawet przy zamkniętej aplikacji.'
          : pushSupported() ? 'Wyłączone. Włącz, aby dostawać przydziały i zmiany terminów od razu na telefon.'
          : isIos() && !standalone() ? 'Na iPhonie: dodaj MXT do ekranu głównego (Udostępnij → Do ekranu początkowego), otwórz z ikony i włącz tutaj.' : 'Ta przeglądarka nie obsługuje powiadomień push.'}</p></div>
          ${sub ? '<button type="button" class="btn btn-secondary btn-sm" id="p-off">Wyłącz</button>' : pushSupported() ? '<button type="button" class="btn btn-primary btn-sm" id="p-on">Włącz powiadomienia</button>' : ''}</div>
        <div class="set-row"><div><b>Kopia na e-mail</b><p class="muted small">${s.email ? esc(s.email) : 'Konto nie ma adresu e-mail – dodaje go administrator.'}</p></div>
          <label class="toggle"><input type="checkbox" id="p-mail"${s.notify_email ? ' checked' : ''}${s.email ? '' : ' disabled'}> wysyłaj</label></div>
        <div class="set-row"><div><b>Sprawdzenie</b><p class="muted small">Urządzenia z powiadomieniami: ${esc(s.devices.length)}.</p></div>
          <button type="button" class="btn btn-secondary btn-sm" id="p-test">Wyślij powiadomienie próbne</button></div></section>`;
    const allBtn = body.parentElement.querySelector('#n-all');
    allBtn.disabled = !unread;
    allBtn.addEventListener('click', async () => { await api('powiadomienia/przeczytane', {}); window.MXT.bell(); reload(); });
    body.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', async () => {
      await api('powiadomienia/przeczytane', { ids: [Number(b.dataset.n)] }).catch(() => {});
      window.MXT.bell();
      if (b.dataset.link && b.dataset.link !== '/powiadomienia') U().go(b.dataset.link); else reload();
    }));
    const on = body.querySelector('#p-on');
    if (on) on.addEventListener('click', async () => {
      on.disabled = true;
      try { await enablePush(s.vapid_public_key); toast('Powiadomienia włączone na tym urządzeniu.'); reload(); }
      catch (e) { toast(e.message); on.disabled = false; }
    });
    const offB = body.querySelector('#p-off');
    if (offB) offB.addEventListener('click', async () => {
      const cur = await currentSub();
      if (cur) { await api('powiadomienia/push', { endpoint: cur.endpoint }, 'DELETE').catch(() => {}); await cur.unsubscribe().catch(() => {}); }
      toast('Powiadomienia wyłączone na tym urządzeniu.'); reload();
    });
    body.querySelector('#p-mail').addEventListener('change', async e => {
      try { await api('powiadomienia/ustawienia', { notify_email: e.target.checked }, 'PUT'); toast(e.target.checked ? 'Kopie powiadomień będą wysyłane na e-mail.' : 'Kopie e-mail wyłączone.'); }
      catch (x) { e.target.checked = !e.target.checked; toast(x.message); }
    });
    body.querySelector('#p-test').addEventListener('click', async () => { await api('powiadomienia/test', {}); toast('Wysłano powiadomienie próbne.'); window.MXT.bell(); setTimeout(reload, 400); });
  }

  const reg = () => {
    window.MXT_MODULES.register('/konta', { title: 'Konta i role', perm: 'users.manage', render: accountsPage, admin: true }, { tab: true, after: '/bezpieczenstwo' });
    window.MXT_MODULES.register('/powiadomienia', { title: 'Powiadomienia', perm: null, render: notificationsPage }, { menu: true });
  };
  if (window.MXT_MODULES) reg(); else document.addEventListener('DOMContentLoaded', reg);
})();
