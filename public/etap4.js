'use strict';
// Etap 4 – Business Intelligence, Communication Hub, Automatyzacje (dzienny raport zarządu, reguły, integracje n8n i poczty),
// karta wyników agentów i oceny wyników pracy agentów.
(() => {
  const U = () => window.MXT_UI, B = () => window.MXT_BIZ;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b), has = p => U().has(p);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => B().pln(n), table = (...a) => B().table(...a), opts = (...a) => B().opts(...a);
  const MON = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

  // ---------- wykres trendu (1–2 serie, paleta zwalidowana: seria 1 niebieska, seria 2 pomarańczowa) ----------
  function trend(months, series, { money = false, label } = {}) {
    const W = 600, H = 210, P = { l: 58, r: 8, t: 12, b: 30 };
    const max = Math.max(1, ...series.flatMap(s => s.values));
    const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= raw) || raw;
    const top = step * 4, y = v => P.t + (H - P.t - P.b) * (1 - v / top), gw = (W - P.l - P.r) / months.length, n = series.length;
    const bw = Math.max(4, Math.min(18, gw / n - 4));
    const fmtv = v => money ? (v >= 1000 ? Math.round(v / 1000) + ' tys.' : Math.round(v)) : (Number.isInteger(v) ? v : v.toFixed(1));
    const bar = (x, v, cls) => { const h = Math.max(0, y(0) - y(v)); if (!h) return ''; const r = Math.min(4, h / 2, bw / 2), yt = y(v);
      return `<path class="${cls}" d="M${x},${y(0)} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${y(0)} Z"/>`; };
    const id = 'tr' + Math.random().toString(36).slice(2, 8);
    const html = `<div class="chart" id="${id}">${n > 1 ? `<div class="legend">${series.map((s, i) => `<span><i class="${i ? 'lg-cost' : 'lg-rev'}"></i>${esc(s.label)}</span>`).join('')}</div>` : ''}
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label || series.map(s => s.label).join(', '))} – 12 miesięcy">
      ${[0, 1, 2, 3, 4].map(i => i * step).map(t => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${P.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmtv(t))}</text>`).join('')}
      ${months.map((m, i) => { const cx = P.l + i * gw + gw / 2, x0 = cx - (n * bw + (n - 1) * 2) / 2;
        return `<g class="grp" data-i="${i}">${series.map((s, k) => bar(x0 + k * (bw + 2), s.values[i], k ? 'b-cost' : 'b-rev')).join('')}<rect class="hit" x="${P.l + i * gw}" y="${P.t}" width="${gw}" height="${H - P.t - P.b}"/>
        <text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${MON[Number(m.slice(5)) - 1]}</text></g>`; }).join('')}
      </svg><div class="tip" hidden></div></div>`;
    setTimeout(() => {
      const ch = document.getElementById(id); if (!ch) return;
      const tip = ch.querySelector('.tip');
      ch.querySelectorAll('.grp').forEach(g => { const i = Number(g.dataset.i);
        const show = () => { tip.innerHTML = `<b>${esc(months[i])}</b>${series.map((s, k) => `<div><i class="${k ? 'lg-cost' : 'lg-rev'}"></i>${esc(s.label)}: ${esc(money ? pln(s.values[i]) : s.values[i])}</div>`).join('')}`;
          tip.hidden = false; const r = g.getBoundingClientRect(), c = ch.getBoundingClientRect(); tip.style.left = Math.min(c.width - 190, Math.max(0, r.left - c.left + r.width / 2 - 95)) + 'px'; g.classList.add('on'); };
        g.addEventListener('mouseenter', show); g.addEventListener('mouseleave', () => { tip.hidden = true; g.classList.remove('on'); }); g.addEventListener('click', show); });
    });
    return html;
  }
  const dataTable = (months, series, money) => `<details><summary class="small">Pokaż dane jako tabelę</summary>${table(['Miesiąc', ...series.map(s => ({ t: s.label, num: 1 }))],
    months.map((m, i) => `<tr><td>${esc(m)}</td>${series.map(s => `<td class="num">${esc(money ? pln(s.values[i]) : s.values[i])}</td>`).join('')}</tr>`), '')}</details>`;
  const kpi = (v, l, tone = 'neutral') => `<div class="kpi kpi-${tone}"><span class="kpi-v">${esc(v)}</span><span class="kpi-l">${esc(l)}</span></div>`;
  const pctv = v => v == null ? '–' : v + '%';

  // ---------- Business Intelligence ----------
  async function biPage(root, path, alive) {
    const body = U().frame(root, path, 'Business Intelligence', 'Analizy, trendy i wskaźniki z całej firmy – 12 ostatnich miesięcy.');
    const d = await api('bi');
    if (!alive()) return;
    const M = d.months, sec = (title, chart, extra = '') => `<section class="panel"><h2 class="panel-title">${esc(title)}</h2>${chart}${extra}</section>`;
    const fin = [{ label: 'Przychody', values: d.finanse.przychod }, { label: 'Koszty', values: d.finanse.koszt }];
    const off = [{ label: 'Wysłane', values: d.oferty.wyslane }, { label: 'Przyjęte', values: d.oferty.przyjete }];
    const ins = [{ label: 'Zaplanowane', values: d.montaze.zaplanowane }, { label: 'Odebrane', values: d.montaze.odebrane }];
    const cpl = [{ label: 'Zgłoszone', values: d.reklamacje.zgloszone }, { label: 'Rozwiązane', values: d.reklamacje.rozwiazane }];
    const tsk = [{ label: 'Utworzone', values: d.zadania.utworzone }, { label: 'Zakończone', values: d.zadania.zakonczone }];
    const sumL = a => a.reduce((s, x) => s + x, 0);
    body.innerHTML = `<section class="kpis">
        ${kpi(pln(sumL(d.finanse.przychod)), 'Przychody (12 mies.)', 'blue')}${kpi(pln(sumL(d.finanse.przychod) - sumL(d.finanse.koszt)), 'Marża (12 mies.)', 'ok')}
        ${kpi(pctv(d.oferty.konwersja_pct), 'Konwersja ofert (przyjęte / zamknięte)', 'violet')}${kpi(pctv(d.montaze.terminowosc_pct), 'Terminowość montaży', d.montaze.opoznione ? 'warn' : 'teal')}
        ${kpi(d.reklamacje.sredni_czas_dni == null ? '–' : d.reklamacje.sredni_czas_dni + ' dni', 'Średni czas reklamacji', 'neutral')}${kpi(pctv(d.szkolenia.zaliczalnosc_pct), 'Zaliczalność testów', 'neutral')}</section>
      <div class="cols cols-even">
        ${sec('Przychody i koszty (PLN)', trend(M, fin, { money: true }), dataTable(M, fin, true))}
        ${sec('Oferty', trend(M, off), `<p class="small muted">Wysłane łącznie: ${esc(d.oferty.wyslane_razem)} · przyjęte: ${esc(d.oferty.przyjete_razem)} · odrzucone: ${esc(d.oferty.odrzucone_razem)} · średnia wartość wysłanej: ${esc(pln(d.oferty.srednia_wartosc_pln))}</p>${dataTable(M, off)}`)}
        ${sec('Montaże', trend(M, ins), `<p class="small muted">Odebrane: ${esc(d.montaze.odebrane_razem)} · opóźnione w toku: ${esc(d.montaze.opoznione)} · terminowość: ${esc(pctv(d.montaze.terminowosc_pct))} (odbiór najpóźniej dzień po terminie)</p>${dataTable(M, ins)}`)}
        ${sec('Reklamacje', trend(M, cpl), `<p class="small muted">Otwarte: ${esc(d.reklamacje.otwarte)} · Podzielniki i Montaże: ${esc(d.reklamacje.dzial1)} · Sprzedaż i eksport: ${esc(d.reklamacje.dzial2)}</p>${dataTable(M, cpl)}`)}
        ${sec('Zadania', trend(M, tsk), `<p class="small muted">Otwarte: ${esc(d.zadania.otwarte)} · po terminie: ${esc(d.zadania.po_terminie)} · przydzielone agentom: ${esc(d.zadania.dla_agentow)}</p>${dataTable(M, tsk)}`)}
        ${sec('Agenci AI – uruchomienia', trend(M, [{ label: 'Uruchomienia', values: d.agenci.uruchomienia }]), `<p class="small muted">Koszt w 12 mies.: ${esc(new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'USD' }).format(sumL(d.agenci.koszt_usd)))}</p>`)}
      </div>
      <div class="cols cols-even">
        ${sec('Najwięksi klienci (przychody, 12 mies.)', table(['Klient', { t: 'Przychód', num: 1 }], d.klienci_top.map(x => `<tr><td>${esc(x.klient)}</td><td class="num">${esc(pln(x.przychod))}</td></tr>`), 'Brak przychodów przypisanych do klientów.'))}
        ${sec('Sprzedaż według krajów', table(['Kraj', { t: 'Transakcje', num: 1 }, { t: 'Sprzedaż PLN', num: 1 }], d.sprzedaz_kraje.map(x => `<tr><td>${esc(x.kraj)}</td><td class="num">${esc(x.transakcje)}</td><td class="num">${esc(pln(x.sprzedaz))}</td></tr>`), 'Brak sprzedaży.'))}
      </div>
      ${sec('Szkolenia', `<p>Opublikowane kursy: <b>${esc(d.szkolenia.kursy)}</b> · wydane zaświadczenia: <b>${esc(d.szkolenia.zaswiadczenia)}</b> · podejścia do testów: ${esc(d.szkolenia.podejscia)} · średni wynik: ${esc(d.szkolenia.sredni_wynik == null ? '–' : d.szkolenia.sredni_wynik + '%')}</p>`)}`;
  }

  // ---------- Communication Hub ----------
  const DIR = { przychodzaca: 'Przychodząca', wychodzaca: 'Wychodząca', wewnetrzna: 'Wewnętrzna' };
  const CH = { email: 'E-mail', telefon: 'Telefon', spotkanie: 'Spotkanie', notatka: 'Notatka', system: 'System' };
  const MAIL_ST = { do_wyslania: 'W kolejce', wyslany: 'Wysłany', symulowany: 'Tryb testowy', blad: 'Błąd' };
  let chTab = 'skrzynka', chFilter = { kierunek: '', nieprzypisane: '' };
  async function composeForm(pre, after) {
    const [cust, kb] = await Promise.all([api('klienci'), api('wiedza').catch(() => [])]);
    modal(pre && pre.subject ? 'Odpowiedź do klienta' : 'Nowa wiadomość e-mail', `
      ${pre && pre.agent ? `<p class="notice notice-test">Szkic przygotował agent ${esc(pre.agent)}${pre.mode === 'test' ? ' (tryb testowy – treść symulowana)' : ''}. Przeczytaj i popraw przed wysłaniem – wysyła człowiek.</p>` : ''}
      <div class="field-row">${field('m-c', 'Klient', `<select id="m-c" name="customer_id" required>${opts(cust, pre && pre.customer_id, c => c.name + (c.email ? ' <' + c.email + '>' : ''), c => c.id, '– wybierz klienta –')}</select>`)}
        ${field('m-to', 'Adres (pusty = e-mail klienta z CRM)', `<input id="m-to" name="to" type="email" maxlength="200" value="${esc(pre && pre.to || '')}">`)}</div>
      ${field('m-s', 'Temat', `<input id="m-s" name="subject" required maxlength="300" value="${esc(pre && pre.subject || '')}">`)}
      ${field('m-b', 'Treść', `<textarea id="m-b" name="body" rows="10" required>${esc(pre && pre.draft || '')}</textarea>`)}
      ${field('m-d', 'Załącznik z Knowledge Base (PDF, opcjonalnie)', `<select id="m-d" name="document_id">${opts(kb.filter(x => x.file_name), null, x => x.title, x => x.id, '– bez załącznika –')}</select>`)}
      <p class="muted small">Oferty wysyła się z modułu Oferty – po akceptacji administratora.</p>`,
    { submit: 'Wyślij', wide: true, onSubmit: async f => {
      const r = await api('komunikacja/email', { customer_id: val(f, 'customer_id'), to: val(f, 'to') || undefined, subject: val(f, 'subject'), body: val(f, 'body'), document_id: val(f, 'document_id') || null, reply_to: pre && pre.reply_to || null });
      toast(r.configured ? 'Wiadomość w kolejce wysyłki.' : 'Zapisano (tryb testowy poczty – bez konfiguracji SMTP).'); if (after) after();
    } });
  }
  async function chPage(root, path, alive) {
    const body = U().frame(root, path, 'Communication Hub', 'Korespondencja z klientami, wysyłka e-mail i rozmowy agentów.', '<button type="button" class="btn btn-primary" id="ch-new">Nowa wiadomość</button>');
    const reload = () => U().render(path, root);
    root.querySelector('#ch-new').addEventListener('click', () => composeForm(null, reload));
    const tabs = [['skrzynka', 'Skrzynka'], ['wysylka', 'Wysyłka e-mail'], ['agenci', 'Rozmowy agentów']];
    let html = `<div class="seg" role="tablist">${tabs.map(([k, v]) => `<button type="button" role="tab" class="seg-b${chTab === k ? ' seg-on' : ''}" aria-selected="${chTab === k}" data-cht="${k}">${v}</button>`).join('')}</div>`;
    if (chTab === 'skrzynka') {
      const list = await api('komunikacja?' + new URLSearchParams(Object.entries(chFilter).filter(([, v]) => v)));
      if (!alive()) return;
      html += `<form class="toolbar" id="chf"><label class="visually-hidden" for="chk">Kierunek</label><select id="chk" name="kierunek" class="select-sm"><option value="">Wszystkie</option>${Object.entries(DIR).map(([k, v]) => `<option value="${k}"${chFilter.kierunek === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <label class="toggle small"><input type="checkbox" name="nieprzypisane"${chFilter.nieprzypisane ? ' checked' : ''}> <span>Tylko nieprzypisane do klienta</span></label><button type="submit" class="btn btn-secondary btn-sm">Filtruj</button></form>
        <section class="panel">${list.length ? `<ol class="inbox">${list.map(m => `<li class="msg msg-${esc(m.direction)}">
          <div class="msg-head"><b>${esc(m.subject || '(bez tematu)')}</b>${m.mail_status ? chip(m.mail_status === 'wyslany' ? 'ok' : m.mail_status === 'blad' ? 'deny' : 'soon', MAIL_ST[m.mail_status]) : ''}</div>
          <div class="muted small">${esc(DIR[m.direction])} · ${esc(CH[m.channel])} · ${esc(fdt(m.created_at))} · ${m.customer_name ? esc(m.customer_name) : '<b class="txt-warn">nieprzypisana</b>'}${m.email_from ? ' · od ' + esc(m.email_from) : ''}${m.email_to ? ' · do ' + esc(m.email_to) : ''}${m.created_by_login ? ' · ' + esc(m.created_by_login) : ''}</div>
          ${m.body ? `<div class="small pre-wrap msg-body">${esc(m.body.slice(0, 1200))}</div>` : ''}
          <div class="ap-actions">${m.direction === 'przychodzaca' ? `<button type="button" class="btn btn-secondary btn-sm" data-draft="${m.id}">Szkic odpowiedzi (agent AI)</button><button type="button" class="btn btn-ghost btn-sm" data-reply="${m.id}">Odpowiedz</button>` : ''}
            ${!m.customer_id ? `<button type="button" class="btn btn-ghost btn-sm" data-assign="${m.id}">Przypisz do klienta</button>` : ''}</div></li>`).join('')}</ol>` : '<p class="empty-inline">Brak wiadomości. E-maile od klientów trafiają tu przez integrację skrzynki (Automatyzacje → Integracje).</p>'}</section>`;
      body.innerHTML = html;
      body.querySelector('#chf').addEventListener('submit', e => { e.preventDefault(); chFilter.kierunek = val(e.target, 'kierunek'); chFilter.nieprzypisane = e.target.elements.nieprzypisane.checked ? '1' : ''; reload(); });
      body.querySelectorAll('[data-draft]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Agent przygotowuje szkic…';
        try { const d = await api(`komunikacja/${b.dataset.draft}/szkic-odpowiedzi`, {}); composeForm({ ...d, agent: d.agent_id, reply_to: b.dataset.draft }, reload); }
        catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Szkic odpowiedzi (agent AI)'; }
      }));
      body.querySelectorAll('[data-reply]').forEach(b => b.addEventListener('click', () => { const m = list.find(x => x.id === b.dataset.reply); composeForm({ customer_id: m.customer_id, to: m.email_from, subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, reply_to: m.id }, reload); }));
      body.querySelectorAll('[data-assign]').forEach(b => b.addEventListener('click', async () => { const cust = await api('klienci');
        modal('Przypisz wiadomość do klienta', field('as-c', 'Klient', `<select id="as-c" name="customer_id" required>${opts(cust, null, c => c.name, c => c.id, '– wybierz –')}</select>`) + '<p class="muted small">Nowego klienta dodasz w CRM.</p>',
          { submit: 'Przypisz', onSubmit: async f => { await api(`komunikacja/${b.dataset.assign}/przypisz`, { customer_id: val(f, 'customer_id') }); toast('Przypisano.'); reload(); } }); }));
    } else if (chTab === 'wysylka') {
      const d = await api('komunikacja/wysylka');
      if (!alive()) return;
      html += `${d.configured ? '' : '<p class="notice notice-test"><b>Tryb testowy poczty.</b> Serwer nie ma konfiguracji SMTP – wiadomości są zapisywane, ale nie wychodzą. Konfigurację ustawia administrator serwera (SMTP_HOST, SMTP_FROM …).</p>'}
        <section class="panel">${table(['Utworzono', 'Do', 'Temat', 'Klient', 'Załączniki', 'Status'], d.items.map(m => `<tr><td class="nowrap">${esc(fdt(m.created_at))}</td><td class="small">${esc(m.to_addr)}</td><td>${esc(m.subject)}</td><td>${esc(m.customer_name || '–')}</td><td class="num">${esc(m.attachments)}</td>
          <td>${chip(m.status === 'wyslany' ? 'ok' : m.status === 'blad' ? 'deny' : m.status === 'symulowany' ? 'soon' : 'oczekuje', MAIL_ST[m.status])}${m.error ? `<div class="small txt-danger">${esc(m.error)}</div>` : ''}${m.sent_at ? `<div class="muted small">${esc(fdt(m.sent_at))}</div>` : ''}</td></tr>`), 'Brak wysłanych wiadomości.')}</section>`;
      body.innerHTML = html;
    } else {
      const d = await api('komunikacja/agenci');
      if (!alive()) return;
      html += `<section class="panel"><h2 class="panel-title">Ostatnie wyniki pracy agentów</h2>${d.runs.length ? `<ol class="protocol">${d.runs.map(x => `<li class="pc">${U().avatar(x)}<div class="pc-body">
          <p class="pc-head"><b>${esc(x.display_name)}</b> <span class="muted small">${esc(x.kind === 'raport' ? 'Raport' : 'Zadanie')} · ${esc(x.input_summary)} · ${esc(fdt(x.created_at))}${x.user_login ? ' · zlecił ' + esc(x.user_login) : ''}${x.mode === 'test' ? ' · tryb testowy' : ''}</span></p>
          ${U().pre(x.output)}${rateBar(x.id, x.my_rating)}</div></li>`).join('')}</ol>` : '<p class="empty-inline">Agenci jeszcze nie pracowali nad zadaniami.</p>'}</section>
        <section class="panel"><h2 class="panel-title">Posiedzenia Zarządu AI</h2>${d.meetings.length ? `<ul class="tool-list">${d.meetings.map(m => `<li><button type="button" class="linkish" data-gom>${esc(m.topic)}</button> <span class="muted small">${esc(fdt(m.created_at))}</span></li>`).join('')}</ul>` : '<p class="empty-inline">Brak posiedzeń.</p>'}</section>`;
      body.innerHTML = html;
      bindRate(body);
      body.querySelectorAll('[data-gom]').forEach(b => b.addEventListener('click', () => U().go('/ai-board')));
    }
    body.querySelectorAll('[data-cht]').forEach(b => b.addEventListener('click', () => { chTab = b.dataset.cht; reload(); }));
  }

  // ---------- oceny wyników pracy agentów ----------
  const rateBar = (runId, my) => `<div class="rate" data-run="${esc(runId)}"><span class="muted small">Oceń wynik:</span>
    <button type="button" class="btn btn-ghost btn-sm rate-b${my === 1 ? ' rate-on' : ''}" data-rate="1" aria-pressed="${my === 1}">Przydatny</button>
    <button type="button" class="btn btn-ghost btn-sm rate-b${my === -1 ? ' rate-on rate-neg' : ''}" data-rate="-1" aria-pressed="${my === -1}">Nieprzydatny</button></div>`;
  function bindRate(box) {
    box.querySelectorAll('.rate').forEach(r => r.querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', async () => {
      try { await api(`ai/uruchomienia/${r.dataset.run}/ocena`, { rating: Number(b.dataset.rate) });
        r.querySelectorAll('[data-rate]').forEach(x => { const on = x === b; x.classList.toggle('rate-on', on); x.classList.toggle('rate-neg', on && x.dataset.rate === '-1'); x.setAttribute('aria-pressed', on); });
        toast('Dziękujemy – ocena trafi do karty wyników agenta.'); } catch (e) { toast(e.message); }
    })));
  }
  // ---------- karta wyników agentów (w AI Workforce) ----------
  async function scorecardPage(root, path, alive) {
    const body = U().frame(root, path, 'Karta wyników agentów', 'Skuteczność, decyzje administratorów, oceny pracowników i koszty – ostatnie 30 dni.');
    const d = await api('ai/karta-wynikow?dni=30');
    if (!alive()) return;
    const sc = v => v == null ? '<span class="muted">brak danych</span>' : `<b class="score score-${v >= 75 ? 'hi' : v >= 50 ? 'mid' : 'lo'}">${esc(v)}</b>`;
    const usd = n => U().usd(n);
    body.innerHTML = `<section class="panel"><p class="muted small">Wynik 0–100 = 40% skuteczność uruchomień + 30% odsetek zatwierdzonych operacji agenta + 30% ocen „przydatny” od pracowników. Składniki bez danych są pomijane.</p>
      ${table(['Agent', 'Wynik', { t: 'Uruchomienia', num: 1 }, 'Skuteczność', 'Zatwierdzone operacje', 'Oceny', { t: 'Zadania', num: 1 }, { t: 'Śr. czas', num: 1 }, { t: 'Koszt (mies.)', num: 1 }, 'Blokady'], d.agents.map(a => `<tr>
        <td><div class="sc-agent">${U().avatar(a)}<div><b>${esc(a.display_name)}</b><div class="muted small">${esc(String(a.title).split(' – ')[0])}</div></div></div></td><td>${sc(a.score)}</td>
        <td class="num">${esc(a.runs)}</td><td>${esc(pctv(a.success_pct))}${a.errors ? `<div class="small txt-danger">${esc(a.errors)} błędów</div>` : ''}</td>
        <td>${a.ops_ok + a.ops_rejected ? `${esc(a.approval_pct)}% <span class="muted small">(${esc(a.ops_ok)}/${esc(a.ops_ok + a.ops_rejected)})</span>` : '<span class="muted">–</span>'}${a.ops - a.ops_ok - a.ops_rejected > 0 ? `<div class="muted small">${esc(a.ops - a.ops_ok - a.ops_rejected)} czeka</div>` : ''}</td>
        <td>${a.fb_up + a.fb_down ? `${esc(a.fb_up)} przydatne · ${esc(a.fb_down)} nieprzydatne` : '<span class="muted">–</span>'}</td>
        <td class="num">${esc(a.tasks_done)}/${esc(a.tasks)}</td><td class="num">${a.avg_ms ? esc((a.avg_ms / 1000).toFixed(1)) + ' s' : '–'}</td>
        <td class="num">${esc(usd(a.month_cost))}<div class="muted small">z ${esc(usd(a.cost_limit))}</div></td><td class="num">${a.blocked ? chip('warn', a.blocked) : '–'}</td></tr>`), '')}</section>`;
  }

  // ---------- Automatyzacje (administratorzy) ----------
  async function autoPage(root, path, alive) {
    const body = U().frame(root, path, 'Automatyzacje', 'Dzienny raport zarządu, reguły zdarzenie → działanie, integracje (n8n, poczta) i kolejka zadań w tle.');
    const reload = () => U().render(path, root);
    const [d, meta] = await Promise.all([api('automatyzacje'), U().meta()]);
    if (!alive()) return;
    const ACT = { zadanie: 'Utwórz zadanie', email: 'Wyślij powiadomienie e-mail', webhook: 'Wyślij do n8n (webhook)' };
    const JOB = { mail: 'E-mail', automatyzacja: 'Automatyzacja', raport_dzienny: 'Raport dzienny', langfuse: 'Monitoring (Langfuse)' };
    const JST = { oczekuje: 'Oczekuje', w_toku: 'W toku', ok: 'OK', blad: 'Błąd' };
    const dr = d.daily;
    body.innerHTML = `
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Dzienny raport Zarządu AI</h2>${dr.enabled ? chip('ok', 'Włączony') : chip('off', 'Wyłączony')}</div>
        <form class="ae" id="drf"><p class="muted small">CEO przygotowuje raport z danych firmy (z wskaźnikami Business Intelligence) codziennie o wskazanej godzinie i wysyła go e-mailem do odbiorców. Teraz w strefie raportu: ${esc(d.now.date)} ${esc(d.now.time)}.</p>
          <label class="toggle"><input type="checkbox" name="enabled"${dr.enabled ? ' checked' : ''}> <span>Wysyłaj codziennie</span></label>
          <div class="field-row">${field('dr-t', 'Godzina', `<input id="dr-t" name="time" type="time" required value="${esc(dr.time)}">`)}${field('dr-z', 'Strefa czasowa', `<input id="dr-z" name="timezone" value="${esc(dr.timezone)}">`)}</div>
          ${field('dr-r', 'Odbiorcy (adresy e-mail, oddzielone przecinkiem)', `<input id="dr-r" name="recipients" value="${esc((dr.recipients || []).join(', '))}">`)}
          <div class="ae-actions"><button type="button" class="btn btn-secondary" id="dr-now">Uruchom teraz</button><span class="ae-spacer"></span><button type="submit" class="btn btn-primary">Zapisz harmonogram</button></div></form>
        ${d.daily_runs.length ? `<h3 class="panel-sub">Ostatnie uruchomienia</h3>${table(['Dzień', 'Uruchomiono', 'Status'], d.daily_runs.map(x => `<tr><td>${esc(fd(x.run_date))}</td><td>${esc(fdt(x.created_at))}</td><td>${chip(x.status === 'ok' ? 'ok' : x.status === 'blad' ? 'deny' : 'oczekuje', JST[x.status] || '–')}${x.last_error ? `<div class="small txt-danger">${esc(x.last_error)}</div>` : ''}</td></tr>`), '')}` : ''}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Reguły automatyzacji</h2><button type="button" class="btn btn-primary btn-sm" id="ru-new">Nowa reguła</button></div>
        <p class="muted small">Automatyzacje wykonują tylko czynności niewiążące: tworzą zadania, wysyłają powiadomienia i przekazują zdarzenia do n8n. Nie zatwierdzają operacji i nie wysyłają ofert.</p>
        ${table(['Reguła', 'Gdy', 'Wtedy', 'Uruchomienia', ''], d.rules.map(x => `<tr class="${x.is_active ? '' : 'row-off'}"><td><b>${esc(x.name)}</b><div class="muted small">${esc(x.created_by_login)} · ${esc(fd(x.created_at))}</div></td>
          <td>${esc((d.events[x.event] || {}).label || x.event)}</td><td>${esc(ACT[x.action])}<div class="muted small">${esc(x.action === 'webhook' ? x.params.url : x.action === 'email' ? (x.params.recipients || []).join(', ') : x.params.title)}</div></td>
          <td class="small">${esc(x.runs)}${x.last_run_at ? ' · ' + esc(fdt(x.last_run_at)) : ''}${x.last_error ? `<div class="txt-danger">${esc(x.last_error)}</div>` : ''}</td>
          <td class="nowrap"><button type="button" class="btn btn-ghost btn-sm" data-rt="${x.id}">${x.is_active ? 'Wyłącz' : 'Włącz'}</button><button type="button" class="btn btn-ghost btn-sm txt-danger" data-rd="${x.id}">Usuń</button></td></tr>`), 'Brak reguł.')}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Integracje: n8n i skrzynka pocztowa</h2><button type="button" class="btn btn-secondary btn-sm" id="tk-new">Nowy token</button></div>
        <p class="small">Przychodzące e-maile: <span class="mono">POST ${esc(d.app_url || '')}/api/integracje/poczta</span> (zakres „poczta”), zadania z n8n: <span class="mono">POST ${esc(d.app_url || '')}/api/integracje/zadania</span> (zakres „zadania”). Nagłówek <span class="mono">Authorization: Bearer &lt;token&gt;</span>.</p>
        <p class="small muted">Webhooki do n8n są podpisane: <span class="mono">X-MXT-Signature: sha256=HMAC(sekret, treść)</span>. Dozwolone hosty http: ${esc(d.n8n_allowed_hosts || 'brak (tylko https)')}.</p>
        ${table(['Nazwa', 'Zakresy', 'Token', 'Ostatnio użyty', ''], d.tokens.map(t => `<tr class="${t.is_active ? '' : 'row-off'}"><td>${esc(t.name)}</td><td>${t.scopes.map(s => chip('soon', s)).join(' ')}</td><td class="mono">${esc(t.token_hint)}</td>
          <td>${esc(fdt(t.last_used_at))}</td><td>${t.is_active ? `<button type="button" class="btn btn-ghost btn-sm txt-danger" data-tr="${t.id}">Unieważnij</button>` : chip('off', 'Unieważniony')}</td></tr>`), 'Brak tokenów.')}</section>
      <div class="cols cols-even">
        <section class="panel"><h2 class="panel-title">Poczta</h2><p>${d.mail.configured ? `${chip('ok', 'SMTP skonfigurowany')} nadawca: <span class="mono">${esc(d.mail.from)}</span>` : `${chip('soon', 'Tryb testowy')} brak konfiguracji SMTP – wiadomości są zapisywane, ale nie wychodzą.`}</p>
          <p class="small muted">Wysłane: ${esc(d.mail.wyslane)} · tryb testowy: ${esc(d.mail.symulowane)} · w kolejce: ${esc(d.mail.w_kolejce)} · błędy: ${esc(d.mail.bledy)}</p>
          <form class="toolbar" id="mt"><label class="visually-hidden" for="mt-to">Adres testowy</label><input id="mt-to" name="to" type="email" class="select-sm" placeholder="adres do testu" required><button type="submit" class="btn btn-secondary btn-sm">Wyślij test</button></form></section>
        <section class="panel"><h2 class="panel-title">Monitoring AI</h2><p>${d.langfuse ? chip('ok', 'Eksport do Langfuse włączony') : chip('off', 'Langfuse nieskonfigurowany')}</p>
          <p class="small muted">Każde uruchomienie agenta jest zapisane w systemie (tokeny, koszt, wersja promptu, czas, narzędzia) – AI Workforce i karta wyników. Langfuse jest opcjonalny (LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY); domyślnie bez treści zapytań.</p></section>
      </div>
      <section class="panel"><h2 class="panel-title">Kolejka zadań w tle</h2>${table(['#', 'Rodzaj', 'Status', 'Próby', 'Utworzono', ''], d.queue.map(j => `<tr><td class="num">${esc(j.id)}</td><td>${esc(JOB[j.kind] || j.kind)}</td>
        <td>${chip(j.status === 'ok' ? 'ok' : j.status === 'blad' ? 'deny' : 'oczekuje', JST[j.status])}${j.last_error ? `<div class="small txt-danger">${esc(j.last_error)}</div>` : ''}</td><td class="num">${esc(j.attempts)}/${esc(j.max_attempts)}</td><td class="nowrap">${esc(fdt(j.created_at))}</td>
        <td>${j.status === 'blad' ? `<button type="button" class="btn btn-ghost btn-sm" data-jr="${j.id}">Ponów</button>` : ''}</td></tr>`), 'Kolejka jest pusta.')}</section>`;
    const f = body.querySelector('#drf');
    f.addEventListener('submit', async e => { e.preventDefault();
      try { await api('automatyzacje/raport-dzienny', { enabled: f.elements.enabled.checked, time: val(f, 'time'), timezone: val(f, 'timezone'), recipients: val(f, 'recipients') }, 'PUT'); toast('Harmonogram zapisany.'); reload(); } catch (x) { toast(x.message); } });
    const now = body.querySelector('#dr-now');
    now.addEventListener('click', async () => { now.disabled = true; now.textContent = 'CEO przygotowuje raport…';
      try { await api('automatyzacje/raport-dzienny/uruchom', {}); toast('Raport gotowy – zobacz w AI Board.'); reload(); } catch (x) { toast(x.message); now.disabled = false; now.textContent = 'Uruchom teraz'; } });
    body.querySelector('#mt').addEventListener('submit', async e => { e.preventDefault(); const r = await api('automatyzacje/test-poczty', { to: val(e.target, 'to') }); toast(r.status === 'wyslany' ? 'Wysłano wiadomość testową.' : r.status === 'symulowany' ? 'Tryb testowy: wiadomość zapisana, nie wysłana.' : 'Błąd: ' + (r.error || '')); reload(); });
    body.querySelectorAll('[data-rt]').forEach(b => b.addEventListener('click', async () => { const x = d.rules.find(y => y.id === b.dataset.rt); await api('automatyzacje/reguly/' + x.id, { is_active: !x.is_active }, 'PATCH'); reload(); }));
    body.querySelectorAll('[data-rd]').forEach(b => b.addEventListener('click', () => modal('Usunąć regułę?', '<p>Reguła przestanie działać. Utworzone przez nią zadania zostaną.</p>', { submit: 'Usuń', danger: true, onSubmit: async () => { await api('automatyzacje/reguly/' + b.dataset.rd, null, 'DELETE'); toast('Usunięto.'); reload(); } })));
    body.querySelectorAll('[data-tr]').forEach(b => b.addEventListener('click', () => modal('Unieważnić token?', '<p>Integracja korzystająca z tego tokenu przestanie działać natychmiast.</p>', { submit: 'Unieważnij', danger: true, onSubmit: async () => { await api(`automatyzacje/tokeny/${b.dataset.tr}/uniewaznij`, {}); toast('Token unieważniony.'); reload(); } })));
    body.querySelectorAll('[data-jr]').forEach(b => b.addEventListener('click', async () => { await api(`automatyzacje/kolejka/${b.dataset.jr}/ponow`, {}); toast('Zadanie wróciło do kolejki.'); reload(); }));
    body.querySelector('#tk-new').addEventListener('click', () => modal('Nowy token integracji', `${field('tk-n', 'Nazwa (np. n8n – skrzynka biuro)', '<input id="tk-n" name="name" required maxlength="100">')}
      <fieldset class="checks"><legend class="flabel">Zakres</legend>${Object.entries(d.scopes).map(([k, v]) => `<label class="toggle"><input type="checkbox" name="sc" value="${k}"> <span>${esc(v)}</span></label>`).join('')}</fieldset>`,
    { submit: 'Utwórz token', onSubmit: async fm => { const r = await api('automatyzacje/tokeny', { name: val(fm, 'name'), scopes: [...fm.querySelectorAll('[name=sc]:checked')].map(x => x.value) });
      setTimeout(() => modal('Token utworzony', `<p>Skopiuj token teraz – nie będzie można go wyświetlić ponownie.</p><p class="mono sel token-box">${esc(r.token)}</p>`, {}), 50); reload(); } }));
    body.querySelector('#ru-new').addEventListener('click', () => ruleForm(d, meta, reload));
  }
  function ruleForm(d, meta, reload) {
    const box = modal('Nowa reguła automatyzacji', `${field('ru-n', 'Nazwa', '<input id="ru-n" name="name" required maxlength="120" placeholder="np. Reklamacja → zadanie dla Technika">')}
      <div class="field-row">${field('ru-e', 'Gdy (zdarzenie)', `<select id="ru-e" name="event">${Object.entries(d.events).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>`)}
        ${field('ru-a', 'Wtedy (działanie)', '<select id="ru-a" name="action"><option value="zadanie">Utwórz zadanie</option><option value="email">Wyślij powiadomienie e-mail</option><option value="webhook">Wyślij do n8n (webhook)</option></select>')}</div>
      <p class="muted small" id="ru-fields">Pola zdarzenia do użycia w treści: <span class="mono"></span></p>
      <div data-ra="zadanie">${field('ru-t', 'Tytuł zadania', '<input id="ru-t" name="title" maxlength="200" value="{{tytul}}">')}
        <div class="field-row">${field('ru-as', 'Przydziel do', `<select id="ru-as" name="assignee_id"><option value="">– nieprzypisane –</option><optgroup label="Pracownicy">${meta.users.map(u => `<option value="${u.id}">${esc(u.login)}</option>`).join('')}</optgroup><optgroup label="Agenci AI">${d.agents.map(a => `<option value="${esc(a.id)}">${esc(a.display_name)}</option>`).join('')}</optgroup></select>`)}
          ${field('ru-dep', 'Dział', `<select id="ru-dep" name="department_id"><option value="">– bez działu –</option>${meta.departments.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>`)}</div>
        <div class="field-row">${field('ru-p', 'Priorytet', '<select id="ru-p" name="priority"><option value="normalny">Normalny</option><option value="wysoki">Wysoki</option><option value="pilny">Pilny</option><option value="niski">Niski</option></select>')}${field('ru-dd', 'Termin (dni od zdarzenia)', '<input id="ru-dd" name="due_days" type="number" min="0" max="365" value="2">')}</div>
        ${field('ru-desc', 'Opis', '<textarea id="ru-desc" name="description" rows="2"></textarea>')}</div>
      <div data-ra="email" hidden>${field('ru-rc', 'Odbiorcy (adresy wewnętrzne)', '<input id="ru-rc" name="recipients">')}${field('ru-s', 'Temat', '<input id="ru-s" name="subject" maxlength="200">')}${field('ru-b', 'Treść (pusta = wszystkie pola zdarzenia)', '<textarea id="ru-b" name="body" rows="3"></textarea>')}</div>
      <div data-ra="webhook" hidden>${field('ru-u', 'Adres webhooka n8n', '<input id="ru-u" name="url" maxlength="500" placeholder="https://n8n.twojafirma.pl/webhook/…">')}<p class="muted small">Sekret podpisu zobaczysz raz, po utworzeniu reguły.</p></div>`,
    { submit: 'Utwórz regułę', wide: true, onSubmit: async f => {
      const a = val(f, 'action'), p = a === 'zadanie' ? { title: val(f, 'title'), assignee_id: val(f, 'assignee_id') || null, department_id: val(f, 'department_id') || null, priority: val(f, 'priority'), due_days: val(f, 'due_days'), description: val(f, 'description') }
        : a === 'email' ? { recipients: val(f, 'recipients'), subject: val(f, 'subject'), body: val(f, 'body') } : { url: val(f, 'url') };
      const r = await api('automatyzacje/reguly', { name: val(f, 'name'), event: val(f, 'event'), action: a, params: p });
      if (r.secret) setTimeout(() => modal('Sekret webhooka', `<p>${esc(r.info)}</p><p class="mono sel token-box">${esc(r.secret)}</p>`, {}), 50);
      toast('Reguła utworzona.'); reload();
    } });
    const sync = () => { const a = box.querySelector('[name=action]').value; box.querySelectorAll('[data-ra]').forEach(x => { x.hidden = x.dataset.ra !== a; });
      box.querySelector('#ru-fields .mono').textContent = d.events[box.querySelector('[name=event]').value].fields.map(x => '{{' + x + '}}').join(' '); };
    box.querySelector('[name=action]').addEventListener('change', sync); box.querySelector('[name=event]').addEventListener('change', sync); sync();
  }

  window.MXT_ETAP4 = { rateBar, bindRate };
  const reg = window.MXT_MODULES.register;
  reg('/komunikacja', { title: 'Communication Hub', perm: 'tasks.use', render: chPage }, { tab: true, after: '/wiedza' });
  reg('/bi', { title: 'Business Intelligence', perm: 'tasks.use', render: biPage }, { tab: true, after: '/komunikacja' });
  reg('/karta-wynikow', { title: 'Karta wyników agentów', perm: 'command.view', render: scorecardPage }, { tab: true, after: '/ai-workforce' });
  reg('/automatyzacje', { title: 'Automatyzacje', perm: 'automations.manage', render: autoPage, admin: true }, { tab: true });
})();
