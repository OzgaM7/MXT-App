'use strict';
(() => {
  // Każdy dział ma własne logo (public/logos): kafelek wyboru, nagłówek strony działu i dokumenty PDF.
  const DEPARTMENTS = [
    { slug: 'podzielniki-i-montaze', name: 'Ciepłomierze i podzielniki', logo: { src: '/logos/podzielniki.png', w: 640, h: 252, alt: 'MXT Ciepłomierze i podzielniki' } },
    { slug: 'sprzedaz-czesci-i-eksport', name: 'Sprzedaż części samochodowych', logo: { src: '/logos/express-parts.png', w: 640, h: 270, alt: 'Express Parts – części z dowozem' } },
    { slug: 'ubezpieczenia', name: 'Ubezpieczenia', logo: { src: '/logos/ubezpieczenia.png', w: 640, h: 253, alt: 'MXT Ubezpieczenia' } },
    { slug: 'asystent-telefoniczny', name: 'Asystent telefoniczny', logo: { src: '/logos/asystent-telefoniczny.png', w: 640, h: 241, alt: 'MXT Asystent telefoniczny' } }
  ];
  const MAIN_LOGO = { src: '/logo.png', w: 1000, h: 274, alt: 'MXT' };
  const WELCOME_MS = 2500;
  const $ = s => document.querySelector(s);
  let user = null, welcomeTimer = null, current = null;

  // ---------- API ----------
  async function api(path, body, method) {
    let r;
    try {
      r = await fetch('/api/' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin', cache: 'no-store'
      });
    } catch (netErr) {
      // Brak sieci albo przerwane połączenie – formularz zostaje otwarty, dane nie przepadają.
      const e = new Error('Brak połączenia z internetem. Sprawdź połączenie i spróbuj ponownie – wpisane dane zostały w formularzu.'); e.status = 0; e.offline = true; throw e;
    }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== 'login' && path !== 'me' && user) { setUser(null); go('/', true); }
    if (r.status === 403 && j.code === 'must_change_password' && user) { user.mustChangePassword = true; go('/zmiana-hasla', true); }
    if (!r.ok) { const e = new Error(j.error || 'Błąd połączenia (' + r.status + ')'); e.status = r.status; e.data = j; throw e; }
    return j;
  }

  // ---------- ekrany ----------
  function show(name) {
    if (current === name) return;
    const next = document.querySelector(`[data-screen="${name}"]`);
    const prev = current && document.querySelector(`[data-screen="${current}"]`);
    current = name;
    const reveal = () => {
      document.querySelectorAll('[data-screen]').forEach(s => { s.hidden = s !== next; s.classList.remove('leaving'); });
      window.scrollTo(0, 0);
      $('#userbar').hidden = !user || name === 'login' || name === 'start';
      $('#menu-toggle').hidden = !!(user && user.mustChangePassword);
      const f = next.querySelector('[autofocus], h1:not(.visually-hidden)');
      if (name === 'login') setTimeout(() => $('#login').focus(), 50);
      else if (f) { f.setAttribute('tabindex', '-1'); f.focus({ preventScroll: true }); }
    };
    if (prev && !prev.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      prev.classList.add('leaving');
      setTimeout(reveal, 200);
    } else reveal();
  }

  // ---------- routing (adresy: /, /dzialy, /dzial/<nazwa>) ----------
  function go(path, replace) {
    if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path);
    route();
  }
  function route() {
    clearTimeout(welcomeTimer);
    document.body.classList.remove('ws-mode');   // przywraca je render() modułu działu
    if (!user) { document.title = 'MXT · Logowanie'; return show('login'); }
    const p = location.pathname.replace(/\/+$/, '') || '/';
    // Hasło startowe lub zresetowane: żaden inny ekran, dopóki użytkownik nie ustawi własnego hasła (serwer też to wymusza).
    if (user.mustChangePassword && p !== '/zmiana-hasla') { history.replaceState({}, '', '/zmiana-hasla'); return passwordScreen(true); }
    if (p === '/zmiana-hasla') return passwordScreen(!!user.mustChangePassword);
    const m = p.match(/^\/dzial\/([a-z-]+)$/);
    const d = m && DEPARTMENTS.find(x => x.slug === m[1]);
    const mod = window.MXT_MODULES && window.MXT_MODULES.routes[p];
    // Na stronach działu w nagłówku logo tego działu, poza nimi – wspólne logo MXT.
    setLogo($('#module-logo'), d ? d.logo : MAIN_LOGO);
    setLogo($('#dept-logo'), d ? d.logo : MAIN_LOGO);
    if (mod) {
      document.title = 'MXT · ' + mod.title;
      show('module');
      window.MXT_MODULES.render(p, $('#module-root'));
      return;
    }
    if (d) {
      $('#dept-title').textContent = d.name;
      document.title = 'MXT · ' + d.name;
      return show('department');
    }
    if (p === '/witaj') return welcome();
    // Bez dostępu do działów (np. monter) – własny ekran startowy zamiast kafelków działów.
    if (!can('departments.view')) { const h = homePath(); if (p !== h) { history.replaceState({}, '', h); return route(); } }
    if (p !== '/dzialy') history.replaceState({}, '', '/dzialy');
    document.title = 'MXT · Wybór działu';
    show('departments');
  }

  function welcome() {
    const t = $('#welcome-title');
    t.textContent = 'Witaj, ';
    const b = document.createElement('b'); b.textContent = user.login; t.append(b, '!');
    document.title = 'MXT · Witaj';
    show('welcome');
    const bar = $('#welcome-progress');
    bar.classList.remove('run'); void bar.offsetWidth;
    bar.style.setProperty('--welcome-ms', WELCOME_MS + 'ms'); bar.classList.add('run');
    welcomeTimer = setTimeout(() => go('/dzialy', true), WELCOME_MS + 200);
  }

  function setLogo(img, l) {
    if (!img || img.getAttribute('src') === l.src) return;
    img.src = l.src; img.width = l.w; img.height = l.h; img.alt = l.alt;
    img.classList.toggle('logo-dept', l !== MAIN_LOGO);
  }

  function renderTiles() {
    const box = $('#tiles');
    box.replaceChildren(...DEPARTMENTS.map(d => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tile'; b.dataset.dept = d.slug;
      b.innerHTML = `<span class="tile-logo"><img alt="" decoding="async"></span><span class="tile-body"><span class="tile-name"></span><span class="tile-go">Otwórz dział →</span></span>`;
      const img = b.querySelector('img');
      img.src = d.logo.src; img.width = d.logo.w; img.height = d.logo.h; img.alt = d.logo.alt;
      b.querySelector('.tile-name').textContent = d.name;
      b.addEventListener('click', () => go('/dzial/' + d.slug));
      return b;
    }), ghostTile());
  }
  // Kafelek strefy GHOST – widoczny dla wszystkich; wejście chroni osobne hasło (public/ghost.js, routes/ghost.js).
  function ghostTile() {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tile tile-ghost'; b.dataset.dept = 'ghost';
    b.innerHTML = `<span class="tile-logo"><img src="/logos/ghost.webp" width="760" height="684" alt="GHOST" decoding="async"></span><span class="tile-body"><span class="tile-name">GHOST</span><span class="tile-go">Zaloguj się →</span></span>`;
    b.addEventListener('click', () => go('/ghost'));
    return b;
  }

  function setUser(u) {
    user = u;
    $('#userbar-name').textContent = u ? u.login : '';
    const rc = $('#userbar-role');
    rc.hidden = !u;
    // Rola główna; przy kilku rolach – liczba dodatkowych (pełna lista w podpowiedzi).
    const labels = u && u.roleLabels && u.roleLabels.length ? u.roleLabels : [u && u.role === 'administrator' ? 'Administrator' : 'Użytkownik'];
    rc.textContent = labels[0] + (labels.length > 1 ? ' +' + (labels.length - 1) : '');
    rc.title = labels.join(', ');
    rc.classList.toggle('role-admin', !!u && u.role === 'administrator');
    renderMenu();
    bell.refresh();
    $('#search-open').hidden = !can('search.global') || !!(u && u.mustChangePassword);
  }
  const can = p => !!user && (user.permissions || []).includes(p);
  // Ekran startowy zależy od roli: biuro – wybór działu, monter – „Moje montaże”, serwisant – „Moje serwisy”,
  // obsługa odczytów – „Odczyty”, pozostali – powiadomienia.
  const homePath = () => can('departments.view') ? '/dzialy' : can('field.own') ? '/moje-montaze' : can('service.own') ? '/moje-serwisy'
    : can('readings.manage') ? '/odczyty' : can('stock.view') && window.MXT_MODULES && window.MXT_MODULES.routes['/magazyn'] ? '/magazyn' : '/powiadomienia';

  // ---------- dzwonek: licznik nieprzeczytanych powiadomień ----------
  const bell = {
    timer: null,
    async refresh() {
      const b = $('#bell');
      b.hidden = !user || !!user.mustChangePassword;
      if (b.hidden) return;
      try {
        const r = await fetch('/api/powiadomienia/licznik', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return;
        const n = (await r.json()).nieprzeczytane || 0, badge = $('#bell-n');
        badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
        b.setAttribute('aria-label', n ? `Powiadomienia: ${n} nieprzeczytanych` : 'Powiadomienia');
      } catch (e) { /* brak sieci – licznik odświeży się później */ }
    },
    start() {
      clearInterval(this.timer);
      this.timer = setInterval(() => { if (document.visibilityState === 'visible') this.refresh(); }, 60000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.refresh(); });
      // Push dotarł, gdy aplikacja jest otwarta – service worker prosi o odświeżenie licznika.
      if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'mxt-push') this.refresh(); });
    }
  };
  $('#bell').addEventListener('click', () => { closeMenu(); go('/powiadomienia'); });
  $('#search-open').addEventListener('click', () => { closeMenu(); window.MXT_UI.searchOpen(); });
  bell.start();

  // ---------- menu ----------
  function renderMenu() {
    const m = $('#menu'); m.replaceChildren();
    if (!user || !window.MXT_MODULES) return;
    for (const it of window.MXT_MODULES.menu(user)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'menu-item' + (it.admin ? ' menu-admin' : '');
      b.textContent = it.label;
      b.addEventListener('click', () => { closeMenu(); go(it.path); });
      m.append(b);
    }
  }
  function closeMenu() { $('#menu').hidden = true; $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
  $('#menu-toggle').addEventListener('click', e => {
    e.stopPropagation();
    const open = $('#menu').hidden;
    $('#menu').hidden = !open; $('#menu-toggle').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', e => { if (!e.target.closest('#menu')) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ---------- logowanie ----------
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#login-error'), btn = $('#login-submit'), form = e.currentTarget;
    const login = $('#login').value.trim(), password = $('#password').value;
    err.hidden = true;
    if (!login || !password) { err.textContent = 'Wpisz login i hasło.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Logowanie…';
    try {
      setUser(await api('login', { login, password }));
      $('#password').value = '';
      go(user.mustChangePassword ? '/zmiana-hasla' : '/witaj');
    } catch (x) {
      err.textContent = x.status === 401 ? 'Nieprawidłowy login lub hasło'
        : x.status === 429 || x.status === 403 ? x.message
        : 'Nie udało się połączyć z serwerem. Sprawdź internet i spróbuj ponownie.';
      err.hidden = false;
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      $('#password').select();
    } finally { btn.disabled = false; btn.textContent = 'Zaloguj'; }
  });

  $('#logout').addEventListener('click', async () => {
    try { await api('logout', {}); } catch (e) { /* sesja i tak zostanie usunięta lokalnie */ }
    setUser(null); $('#login-form').reset(); $('#login-error').hidden = true;
    go('/', true);
  });

  $('#welcome-next').addEventListener('click', () => go('/dzialy', true));
  $('#dept-back').addEventListener('click', () => go('/dzialy'));
  $('#open-command').addEventListener('click', () => go('/command-center'));
  window.addEventListener('popstate', route);

  // Interfejs dla modułów (public/modules.js).
  window.MXT = { api, go: p => go(p), toast, user: () => user, bell: () => bell.refresh(), departments: () => DEPARTMENTS };

  // ---------- zmiana hasła ----------
  // Te same reguły sprawdza serwer (lib/password.js) – tutaj tylko podpowiedź na żywo.
  const WEAK = ['1234', '12345', '123456', '1234567', '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123', 'password', 'password1', 'haslo', 'haslo123',
    'mxt', 'mxt123', 'mxt2026', 'admin', 'admin123', 'zaq12wsx', 'qwertyuiop', 'abc123', '1q2w3e4r', '1qaz2wsx', 'polska', 'polska123'];
  function pwRules(p, cur) {
    const low = p.toLowerCase(), l = user ? user.login.toLowerCase() : '';
    return [['co najmniej 10 znaków', p.length >= 10], ['co najmniej jedna litera', /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(p)], ['co najmniej jedna cyfra', /\d/.test(p)],
      ['nie popularne hasło (np. 1234, qwerty)', !!p && !WEAK.some(w => low === w || low.startsWith(w) && low.length - w.length < 3)],
      ['nie zawiera loginu', !!p && !(l && (low.includes(l) || low.includes(l.replace(/\./g, ''))))], ['różne od obecnego', !!p && p !== cur]];
  }
  function paintRules() {
    const p = $('#pw-new').value, rules = pwRules(p, $('#pw-current').value), rep = $('#pw-repeat').value;
    rules.push(['oba pola nowego hasła są takie same', !!p && p === rep]);
    $('#pw-rules').replaceChildren(...rules.map(([t, ok]) => { const li = document.createElement('li'); li.className = ok ? 'ok' : ''; li.textContent = t; return li; }));
    return rules.every(r => r[1]);
  }
  ['#pw-new', '#pw-repeat', '#pw-current'].forEach(s => $(s).addEventListener('input', paintRules));
  function passwordScreen(forced) {
    document.title = 'MXT · Zmiana hasła';
    $('#pw-title').textContent = forced ? 'Ustaw własne hasło' : 'Zmień hasło';
    $('#pw-lead').textContent = forced ? `Witaj, ${user.login}! To Twoje pierwsze logowanie (albo hasło zostało zresetowane). Ustaw własne hasło, aby korzystać z MXT.` : 'Po zmianie hasła pozostałe urządzenia zostaną wylogowane.';
    $('#pw-back').hidden = forced;
    $('#pw-form').reset(); $('#pw-error').hidden = true; paintRules();
    show('password');
    setTimeout(() => $('#pw-current').focus(), 60);
  }
  $('#pw-back').addEventListener('click', () => history.length > 1 ? history.back() : go('/dzialy'));
  $('#pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#pw-error'), btn = $('#pw-submit'), forced = !!user.mustChangePassword;
    err.hidden = true;
    if (!$('#pw-current').value) { err.textContent = 'Wpisz obecne hasło.'; err.hidden = false; return; }
    if (!paintRules()) { err.textContent = 'Nowe hasło nie spełnia wszystkich wymagań.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Zapisywanie…';
    try {
      setUser(await api('haslo', { obecne: $('#pw-current').value, nowe: $('#pw-new').value, powtorz: $('#pw-repeat').value }));
      $('#pw-form').reset();
      toast('Hasło zostało zmienione.');
      go(forced ? '/witaj' : homePath(), true);
    } catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Zmień hasło'; }
  });

  // ---------- start ----------
  renderTiles();
  (async () => {
    try { setUser(await api('me')); }
    catch (e) {
      setUser(null);
      if (e.status !== 401) toast('Brak połączenia z serwerem.');
    }
    if (user && location.pathname === '/witaj') history.replaceState({}, '', '/dzialy');
    route();
  })();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
