// Strefa GHOST: ekran logowania z logo i animowanym tłem („deszcz znaków” jak w Matriksie, w kolorach logo).
// Kafelek GHOST widzą wszyscy na ekranie wyboru działu (app.js), a pozycję w menu – każde konto.
// Wejście: login konta MXT + osobne hasło do GHOST; przy pierwszym wejściu właściciel konta ustawia hasło.
(function () {
  'use strict';
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), go = p => U().go(p);
  const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789GHOST#$%&+=<>*';

  // Deszcz znaków na <canvas>: ~20 klatek/s, odcień od błękitu do fioletu (kolory logo), jaśniejsza „głowa” kolumny.
  function rain(canvas) {
    const ctx = canvas.getContext('2d');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0, h = 0, size = 16, cols = 0, drops = [], speed = [], prev = [], at = [], last = 0, timer = null;
    const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
    const hue = i => 190 + (i / Math.max(1, cols - 1)) * 85;
    function fit() {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      size = w < 560 ? 14 : 17;
      cols = Math.ceil(w / size);
      drops = Array.from({ length: cols }, () => -Math.random() * (h / size));
      speed = Array.from({ length: cols }, () => 0.55 + Math.random() * 0.6);
      prev = Array.from({ length: cols }, () => '');
      at = Array.from({ length: cols }, () => -1);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      ctx.font = `${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      ctx.textBaseline = 'top';
      if (still) {   // ograniczony ruch: jeden spokojny kadr zamiast animacji
        for (let i = 0; i < cols; i++) for (let y = 0; y < h; y += size) if (Math.random() < 0.18) {
          ctx.fillStyle = `hsla(${hue(i)}, 90%, 60%, ${0.08 + Math.random() * 0.25})`; ctx.fillText(pick(), i * size, y);
        }
      }
    }
    function frame(t) {
      if (!canvas.isConnected || !canvas.getClientRects().length) { window.removeEventListener('resize', onResize); return; }
      requestAnimationFrame(frame);
      if (t - last < 50) return;
      last = t;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.085)'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < cols; i++) {
        const row = Math.floor(drops[i]);
        if (row >= 0 && row !== at[i]) {   // nowy wiersz: poprzednia „głowa” przechodzi w kolor, nowa jasna
          if (prev[i]) { ctx.fillStyle = `hsl(${hue(i)}, 95%, 58%)`; ctx.fillText(prev[i], i * size, at[i] * size); }
          const ch = pick(); ctx.fillStyle = `hsl(${hue(i)}, 100%, 90%)`; ctx.fillText(ch, i * size, row * size);
          prev[i] = ch; at[i] = row;
        }
        drops[i] += speed[i];
        if (row * size > h && Math.random() > 0.972) { drops[i] = -Math.random() * 8; prev[i] = ''; at[i] = -1; }
      }
    }
    const onResize = () => { clearTimeout(timer); timer = setTimeout(fit, 150); };
    fit();
    window.addEventListener('resize', onResize);
    if (!still) requestAnimationFrame(frame);
  }

  const field = (id, label, input) => `<div class="ghost-field"><label for="${id}">${esc(label)}</label>${input}</div>`;

  // Nakładka na całe okno jest dzieckiem <body>: ekrany aplikacji mają animację z transform, przez co „fixed” w ich
  // wnętrzu liczyłby się względem ekranu, a nie okna. Nakładka znika sama, gdy adres przestaje być /ghost.
  async function page(root) {
    document.querySelectorAll('body > .ghost').forEach(e => e.remove());
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'ghost'; box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'GHOST');
    box.innerHTML = `<canvas class="ghost-rain" aria-hidden="true"></canvas><div class="ghost-veil" aria-hidden="true"></div>
        <button type="button" class="ghost-back" data-back>← MXT</button>
        <div class="ghost-main">
          <img class="ghost-logo" src="/logos/ghost.webp" alt="GHOST" width="760" height="684" decoding="async">
          <section class="ghost-card" aria-live="polite"><p class="ghost-muted">Łączenie…</p></section>
        </div>`;
    document.body.append(box);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const watch = setInterval(() => {
      if (location.pathname === '/ghost' && box.isConnected) return;
      clearInterval(watch); box.remove(); document.body.style.overflow = overflow;
    }, 250);
    rain(box.querySelector('.ghost-rain'));
    box.querySelector('[data-back]').addEventListener('click', () => go('/'));
    const card = box.querySelector('.ghost-card');
    const busy = (btn, on, text) => { btn.disabled = on; if (text) btn.textContent = text; };

    function formView(html, onSubmit, focus) {
      card.innerHTML = html;
      const f = card.querySelector('form'), err = card.querySelector('.ghost-err'), btn = f.querySelector('[type=submit]'), label = btn.textContent;
      f.addEventListener('submit', async e => {
        e.preventDefault(); err.hidden = true; busy(btn, true, 'Sprawdzam…');
        try { await onSubmit(f); }
        catch (x) { err.textContent = x.message || 'Nie udało się. Spróbuj ponownie.'; err.hidden = false; busy(btn, false, label); }
      });
      const fi = card.querySelector(focus); if (fi) fi.focus();
    }
    const login = () => formView(`<form class="ghost-form" novalidate autocomplete="off">
        <h1 class="ghost-title">Logowanie</h1>
        <p class="ghost-muted">Strefa GHOST ma osobne hasło.</p>
        ${field('g-l', 'Login', '<input id="g-l" name="ghost_login" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required maxlength="100">')}
        ${field('g-p', 'Hasło GHOST', '<input id="g-p" name="ghost_pass" type="password" autocomplete="off" required maxlength="200">')}
        <p class="ghost-err" role="alert" hidden></p>
        <button type="submit" class="ghost-btn">Wejdź</button></form>`,
      async f => { await api('ghost/login', { login: f.ghost_login.value, haslo: f.ghost_pass.value }); await show(); }, '#g-l');
    const setPass = () => formView(`<form class="ghost-form" novalidate autocomplete="off">
        <h1 class="ghost-title">Ustaw hasło do GHOST</h1>
        <p class="ghost-muted">Pierwsze wejście. Ustaw osobne hasło – inne niż do MXT. Nikt inny go nie zna, więc je zapamiętaj.</p>
        ${field('g-n', 'Nowe hasło GHOST', '<input id="g-n" name="ghost_new" type="password" autocomplete="new-password" required maxlength="200">')}
        ${field('g-r', 'Powtórz hasło', '<input id="g-r" name="ghost_rep" type="password" autocomplete="new-password" required maxlength="200">')}
        <p class="ghost-hint">Co najmniej 10 znaków, litera i cyfra.</p>
        <p class="ghost-err" role="alert" hidden></p>
        <button type="submit" class="ghost-btn">Ustaw hasło i wejdź</button></form>`,
      async f => { await api('ghost/haslo', { nowe: f.ghost_new.value, powtorz: f.ghost_rep.value }); await show(); }, '#g-n');
    async function panel() {
      const p = await api('ghost/panel');
      const until = new Date(p.odblokowany_do).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      card.innerHTML = `<h1 class="ghost-title">Witaj, ${esc(p.witaj)}</h1>
        <p class="ghost-muted">Jesteś w strefie GHOST. Zawartość panelu pojawi się wkrótce.</p>
        <p class="ghost-hint">Odblokowano do ${esc(until)} (albo do wylogowania z MXT).</p>
        <div class="ghost-actions"><button type="button" class="ghost-btn ghost-btn-alt" data-lock>Zablokuj GHOST</button>
          <button type="button" class="ghost-btn" data-back2>Wróć do MXT</button></div>`;
      card.querySelector('[data-lock]').addEventListener('click', async () => { await api('ghost/wyloguj', {}); await show(); });
      card.querySelector('[data-back2]').addEventListener('click', () => go('/'));
    }
    async function show() {
      const s = await api('ghost/stan');
      if (s.odblokowany) return panel();
      return s.ustaw_haslo ? setPass() : login();
    }
    try { await show(); } catch (e) { card.innerHTML = `<p class="ghost-err">${esc(e.message || 'Nie udało się połączyć.')}</p>`; }
  }

  window.MXT_MODULES.register('/ghost', { title: 'GHOST', perm: null, render: page }, { menu: true });
})();
