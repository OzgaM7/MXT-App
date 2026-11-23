// Dział „Asystent telefoniczny” (MXT Recepcja AI): rozmowy odebrane przez bota z transkrypcją i przeglądem,
// kolejka zgłoszeń z telefonu, wskaźniki z planu wdrożenia i integracja z botem (klucz webhooka, rozmowa testowa).
(function () {
  'use strict';
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), go = p => U().go(p), toast = m => U().toast(m), modal = (...a) => U().modal(...a);
  const field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), chip = (...a) => U().chip(...a), fdt = v => U().fdt(v);
  const PATH = '/dzial/asystent-telefoniczny';
  const TABS = [['rozmowy', 'Rozmowy'], ['zgloszenia', 'Zgłoszenia'], ['integracja', 'Integracja z botem']];
  const DEPT = { podzielniki: 'Podzielniki', ubezpieczenia: 'Ubezpieczenia', czesci: 'Części', taxi: 'Taxi', inne: 'Inne' };
  const OUT = { rezerwacja: 'Rezerwacja', zgloszenie: 'Zgłoszenie', oddzwonienie: 'Oddzwonienie', przekazanie: 'Przekazana', informacja: 'Informacja', przerwana: 'Przerwana' };
  const OUT_CLS = { rezerwacja: 'ok', zgloszenie: 'ok', oddzwonienie: 'ok', przekazanie: 'w_toku', informacja: 'off', przerwana: 'warn' };
  const REV = { nowa: 'Do przejrzenia', sprawdzona: 'Sprawdzona', blad_danych: 'Błąd w danych' };
  const REV_CLS = { nowa: 'warn', sprawdzona: 'ok', blad_danych: 'deny' };
  const KIND = { wizyta_serwisowa: 'Wizyta serwisowa', rozmowa_agent: 'Rozmowa z agentem', zapytanie_czesci: 'Zapytanie o części', oddzwonienie: 'Prośba o oddzwonienie', taxi: 'Zamówienie taxi', inne: 'Inna sprawa' };
  const RQ = { nowe: 'Nowe', w_toku: 'W toku', zalatwione: 'Załatwione', anulowane: 'Anulowane' };
  const RQ_CLS = { nowe: 'warn', w_toku: 'w_toku', zalatwione: 'ok', anulowane: 'off' };
  let tab = 'rozmowy';
  const st = { dni: 14, dzial: '', wynik: '', przeglad: '', q: '', strona: 1, zst: 'otwarte', zdzial: '', zq: '' };
  const opts = (map, cur, empty) => `<option value="">${esc(empty)}</option>` + Object.entries(map).map(([k, v]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const secs = s => s == null ? '–' : s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
  const pct = v => v == null ? '–' : String(v).replace('.', ',') + '%';
  const tel = p => p ? `<a class="ast-tel" href="tel:${esc(p.replace(/[^\d+]/g, ''))}">${esc(p)}</a>` : '–';
  const orderLink = x => x.order_number ? `<button type="button" class="linkish" data-order="${esc(x.service_order_id)}">${esc(x.order_number)}</button>` : '';

  async function page(root, path, alive) {
    const want = new URLSearchParams(location.search).get('tab');
    if (want && TABS.some(([k]) => k === want)) tab = want;
    const body = U().deptFrame(root, 'Asystent telefoniczny', TABS, tab, t => { tab = t; reload(); },
      'Asystentka AI „Ola” odbiera telefony MXT: rozmowy z transkrypcją, zgłoszenia do załatwienia i wizyty przekazane do Serwisów.');
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await ({ rozmowy, zgloszenia, integracja }[tab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel);
  }
  // Numer zlecenia serwisowego (w liście i w karcie rozmowy) otwiera kartę zlecenia w module Serwisy.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-order]');
    if (!b || location.pathname !== PATH) return;
    document.getElementById('modal').hidden = true;
    go('/dzial/podzielniki-i-montaze?tab=serwisy&z=' + b.dataset.order);
  });

  // =============== Rozmowy ===============
  async function rozmowy(body, reload, alive) {
    const qs = new URLSearchParams(Object.entries({ dzial: st.dzial, wynik: st.wynik, przeglad: st.przeglad, q: st.q, strona: st.strona }).filter(([, v]) => v));
    const [sum, resp] = await Promise.all([api('asystent/podsumowanie?dni=' + st.dni), fetch('/api/asystent/rozmowy?' + qs, { credentials: 'same-origin', cache: 'no-store' })]);
    if (!resp.ok) throw Object.assign(new Error((await resp.json().catch(() => ({}))).error || 'Nie udało się wczytać rozmów.'), { status: resp.status });
    const list = await resp.json(), total = +resp.headers.get('X-Total-Count') || 0, pages = Math.max(1, Math.ceil(total / 50));
    if (!alive()) return;
    const c = sum.cele, none = !sum.rozmowy;
    const kpi = (label, v, tone, goal, act) => `<${act ? `button type="button" data-k="${act}"` : 'div'} class="kpi kpi-${none ? 'neutral' : tone}"><span class="kpi-v">${esc(v)}</span>
      <span class="kpi-l">${esc(label)}</span>${goal ? `<span class="kpi-goal">${esc(goal)}</span>` : ''}</${act ? 'button' : 'div'}>`;
    const ms = sum.czas_odpowiedzi_ms;
    const xl = U().has('export.xlsx') ? '<a class="btn btn-secondary btn-sm btn-xl" href="/api/asystent/eksport" download>Eksport do Excela</a>' : '';
    body.innerHTML = `<div class="seg" role="tablist" aria-label="Okres">${[7, 14, 30, 90].map(d => `<button type="button" class="seg-b${st.dni === d ? ' seg-on' : ''}" data-d="${d}" role="tab" aria-selected="${st.dni === d}">${d} dni</button>`).join('')}</div>
      <section class="kpis">
        ${kpi('Rozmowy', sum.rozmowy, 'blue', sum.sredni_czas_s ? 'średnio ' + secs(sum.sredni_czas_s) : '')}
        ${kpi('Rezerwacja lub zgłoszenie', pct(sum.skutecznosc_pct), sum.skutecznosc_pct >= c.skutecznosc_pct ? 'ok' : 'warn', 'cel: co najmniej ' + c.skutecznosc_pct + '%')}
        ${kpi('Przekazane do pracownika', pct(sum.przekazania_pct), sum.przekazania_pct < c.przekazania_pct ? 'ok' : 'warn', 'cel: poniżej ' + c.przekazania_pct + '%')}
        ${kpi('Pomyłki w danych', pct(sum.bledy_pct), sum.bledy_pct == null ? 'neutral' : sum.bledy_pct <= c.bledy_pct ? 'ok' : 'danger', `cel: do ${c.bledy_pct}% · sprawdzono ${sum.sprawdzone}`)}
        ${kpi('Czas odpowiedzi asystentki', ms == null ? '–' : (ms / 1000).toFixed(1).replace('.', ',') + ' s', ms == null ? 'neutral' : ms < c.czas_odpowiedzi_ms ? 'ok' : 'warn', 'cel: poniżej 1,5 s')}
        ${kpi('Do przejrzenia', sum.do_przejrzenia, 'warn', 'transkrypcje bez oceny', 'nowa')}
      </section>
      <form class="toolbar" id="af"><label class="visually-hidden" for="a-q">Szukaj</label><input id="a-q" name="q" class="select-sm" placeholder="Szukaj: telefon, treść podsumowania" value="${esc(st.q)}">
        <label class="visually-hidden" for="a-d">Dział</label><select id="a-d" name="dzial" class="select-sm">${opts(DEPT, st.dzial, 'Każdy dział')}</select>
        <label class="visually-hidden" for="a-w">Wynik</label><select id="a-w" name="wynik" class="select-sm">${opts(OUT, st.wynik, 'Każdy wynik')}</select>
        <label class="visually-hidden" for="a-p">Przegląd</label><select id="a-p" name="przeglad" class="select-sm">${opts(REV, st.przeglad, 'Przegląd: wszystkie')}</select>
        <button type="submit" class="btn btn-secondary btn-sm">Filtruj</button>${xl}</form>
      <section class="panel">${list.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Kiedy</th><th>Dzwoniący</th><th>Dział i wynik</th><th>Podsumowanie</th><th>Przegląd</th><th></th></tr></thead><tbody>
        ${list.map(x => `<tr><td class="nowrap">${esc(fdt(x.started_at))}<div class="muted small">${esc(secs(x.duration_s))}</div></td>
          <td class="nowrap">${tel(x.caller_phone)}</td>
          <td>${esc(DEPT[x.department])}<div>${chip(OUT_CLS[x.outcome], OUT[x.outcome])}${x.transferred && x.outcome !== 'przekazanie' ? ' ' + chip('w_toku', 'przekazana') : ''}${x.is_test ? ' ' + chip('soon', 'test') : ''}</div></td>
          <td class="small">${esc(x.summary || '–')}${x.zgloszenia ? `<div class="muted small">zgłoszenia: ${esc(x.zgloszenia)}</div>` : ''}</td>
          <td>${chip(REV_CLS[x.review_status], REV[x.review_status])}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-open="${x.id}">Otwórz</button></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty-inline"><p><b>Nie ma jeszcze rozmów${st.dzial || st.wynik || st.przeglad || st.q ? ' dla tych filtrów' : ''}.</b></p>
            <p class="muted small">Gdy bot zacznie odbierać telefony, każda rozmowa pojawi się tutaj z transkrypcją. Połączenie z botem sprawdzisz w zakładce „Integracja z botem” (rozmowa testowa).</p></div>`}
        <p class="muted small list-count">Razem: <b>${esc(total)}</b>${pages > 1 ? ` · strona ${st.strona} z ${pages}` : ''}</p>
        ${pages > 1 ? `<nav class="pager" aria-label="Strony"><button type="button" class="btn btn-secondary btn-sm" data-pg="-1"${st.strona <= 1 ? ' disabled' : ''}>← Poprzednia</button>
          <button type="button" class="btn btn-secondary btn-sm" data-pg="1"${st.strona >= pages ? ' disabled' : ''}>Następna →</button></nav>` : ''}</section>
      ${sum.dzialy.length ? `<section class="panel"><h3 class="panel-sub">Działy (${sum.dni} dni, bez rozmów testowych)</h3><div class="table-wrap"><table class="table"><thead><tr><th>Dział</th><th class="num">Rozmowy</th><th class="num">Rezerwacja lub zgłoszenie</th></tr></thead><tbody>
        ${sum.dzialy.map(d => `<tr><td>${esc(DEPT[d.dzial])}</td><td class="num">${esc(d.rozmowy)}</td><td class="num">${esc(pct(d.rozmowy ? Math.round(d.skuteczne * 1000 / d.rozmowy) / 10 : null))}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
    body.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => { st.dni = +b.dataset.d; reload(); }));
    body.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => { st.przeglad = b.dataset.k; st.strona = 1; reload(); }));
    body.querySelector('#af').addEventListener('submit', e => { e.preventDefault(); const f = e.target; Object.assign(st, { q: val(f, 'q').trim(), dzial: val(f, 'dzial'), wynik: val(f, 'wynik'), przeglad: val(f, 'przeglad'), strona: 1 }); reload(); });
    body.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => { st.strona += Number(b.dataset.pg); reload(); }));
    body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => callCard(b.dataset.open, reload)));
  }

  async function callCard(id, after) {
    const c = await api('asystent/rozmowy/' + id);
    const tr = Array.isArray(c.transcript) ? c.transcript : null;
    const rqs = c.requests.map(x => `<li class="ast-rq"><div>${chip(RQ_CLS[x.status], RQ[x.status])} <b>${esc(KIND[x.kind])}</b>${x.urgent ? ' ' + chip('deny', 'pilne') : ''}</div>
        <div class="small">${esc([x.caller_name, x.phone, [x.address, x.unit && 'lok. ' + x.unit, x.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '–')}</div>
        ${x.slot_at ? `<div class="small">Termin uzgodniony: <b>${esc(fdt(x.slot_at))}</b>${x.slot_minutes ? ` (${esc(x.slot_minutes)} min)` : ''}</div>` : ''}
        ${x.description ? `<div class="small muted">${esc(x.description)}</div>` : ''}
        ${x.order_number ? `<div class="small">Zlecenie serwisowe: ${orderLink(x)}</div>` : ''}</li>`).join('');
    modal('Rozmowa ' + fdt(c.started_at), `
      <dl class="ast-meta"><div><dt>Dzwoniący</dt><dd>${tel(c.caller_phone)}</dd></div><div><dt>Dział</dt><dd>${esc(DEPT[c.department])}</dd></div>
        <div><dt>Wynik</dt><dd>${chip(OUT_CLS[c.outcome], OUT[c.outcome])}${c.is_test ? ' ' + chip('soon', 'test') : ''}</dd></div>
        <div><dt>Czas rozmowy</dt><dd>${esc(secs(c.duration_s))}</dd></div><div><dt>Śr. odpowiedź</dt><dd>${c.avg_response_ms == null ? '–' : esc((c.avg_response_ms / 1000).toFixed(1).replace('.', ',') + ' s')}</dd></div></dl>
      ${c.summary ? `<p>${esc(c.summary)}</p>` : ''}
      ${rqs ? `<h3 class="panel-sub">Zgłoszenia z rozmowy</h3><ul class="ast-rqs">${rqs}</ul>` : ''}
      <h3 class="panel-sub">Transkrypcja</h3>
      ${tr ? `<ol class="ast-tr">${tr.map(t => `<li class="ast-msg ast-${esc(t.rola)}"><span class="ast-who">${t.rola === 'asystent' ? 'Ola (AI)' : t.rola === 'klient' ? 'Klient' : 'System'}${t.czas ? ' · ' + esc(new Date(t.czas).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })) : ''}</span>${esc(t.tekst)}</li>`).join('')}</ol>`
        : `<p class="muted small">${c.transcript_deleted_at ? 'Transkrypcja usunięta ' + esc(fdt(c.transcript_deleted_at)) + ' po okresie przechowywania (RODO).' : 'Bot nie przesłał transkrypcji.'}</p>`}
      <h3 class="panel-sub">Przegląd</h3>
      <p class="muted small">Sprawdź, czy asystentka dobrze zapisała dane (nazwisko, adres, termin). Oceny tworzą wskaźnik „Pomyłki w danych”.${c.reviewed_at ? ` Ostatnio: ${esc(c.reviewed_by_name || c.reviewed_by_login || '')}, ${esc(fdt(c.reviewed_at))}.` : ''}</p>
      ${field('r-s', 'Ocena', `<select id="r-s" name="status">${Object.entries(REV).map(([k, v]) => `<option value="${k}"${(c.review_status === 'nowa' ? 'sprawdzona' : c.review_status) === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`)}
      ${field('r-n', 'Uwaga (wymagana przy błędzie w danych)', `<textarea id="r-n" name="uwaga" rows="2" maxlength="1000" placeholder="np. zły numer domu: 15 zamiast 5">${esc(c.review_note || '')}</textarea>`)}`,
    { submit: 'Zapisz przegląd', wide: true, cancel: 'Zamknij', onSubmit: async f => {
      await api(`asystent/rozmowy/${id}/ocena`, { status: val(f, 'status'), uwaga: val(f, 'uwaga') });
      toast('Zapisano przegląd rozmowy.'); after();
    } });
  }

  // =============== Zgłoszenia ===============
  async function zgloszenia(body, reload, alive) {
    const qs = new URLSearchParams(Object.entries({ status: st.zst, dzial: st.zdzial, q: st.zq }).filter(([, v]) => v));
    const list = await api('asystent/zgloszenia?' + qs);
    if (!alive()) return;
    const VIEWS = [['otwarte', 'Do załatwienia'], ['nowe', 'Nowe'], ['w_toku', 'W toku'], ['zalatwione', 'Załatwione'], ['anulowane', 'Anulowane'], ['wszystkie', 'Wszystkie']];
    body.innerHTML = `<div class="seg seg-wrap" role="tablist" aria-label="Widok">${VIEWS.map(([k, v]) => `<button type="button" class="seg-b${st.zst === k ? ' seg-on' : ''}" data-v="${k}" role="tab" aria-selected="${st.zst === k}">${v}</button>`).join('')}</div>
      <form class="toolbar" id="zf"><label class="visually-hidden" for="z-q">Szukaj</label><input id="z-q" name="q" class="select-sm" placeholder="Szukaj: klient, telefon, adres, opis" value="${esc(st.zq)}">
        <label class="visually-hidden" for="z-d">Dział</label><select id="z-d" name="dzial" class="select-sm">${opts(DEPT, st.zdzial, 'Każdy dział')}</select>
        <button type="submit" class="btn btn-secondary btn-sm">Filtruj</button></form>
      <p class="muted small">Wizyty serwisowe umówione przez asystentkę trafiają od razu do modułu Serwisy (status „Nowe”, do weryfikacji). Tu zostają sprawy do oddzwonienia i załatwienia przez biuro.</p>
      <section class="panel">${list.length ? `<ul class="ast-queue">${list.map(x => `<li class="ast-item${x.urgent && ['nowe', 'w_toku'].includes(x.status) ? ' ast-urgent' : ''}" id="rq-${x.id}">
          <div class="ast-item-main"><div>${chip(RQ_CLS[x.status], RQ[x.status])} <b>${esc(KIND[x.kind])}</b> <span class="muted small">· ${esc(DEPT[x.department])}</span>${x.urgent ? ' ' + chip('deny', 'pilne') : ''}${x.is_test ? ' ' + chip('soon', 'test') : ''}</div>
            <div>${esc(x.caller_name || 'Bez nazwiska')} · ${tel(x.phone)}</div>
            ${x.address ? `<div class="small">${esc([x.address, x.unit && 'lok. ' + x.unit, x.city].filter(Boolean).join(', '))}</div>` : ''}
            ${x.slot_at ? `<div class="small">Termin uzgodniony: <b>${esc(fdt(x.slot_at))}</b></div>` : ''}
            ${x.description ? `<div class="small">${esc(x.description)}</div>` : ''}
            ${Object.keys(x.details || {}).length ? `<div class="small muted">${Object.entries(x.details).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</div>` : ''}
            <div class="small muted">Przyjęto ${esc(fdt(x.created_at))}${x.handled_by_name || x.handled_by_login ? ` · ${esc(x.handled_by_name || x.handled_by_login)}, ${esc(fdt(x.handled_at))}` : ''}${x.note ? ' · ' + esc(x.note) : ''}</div>
            ${x.order_number ? `<div class="small">Zlecenie serwisowe: ${orderLink(x)}</div>` : ''}</div>
          <div class="ast-item-act">${x.status === 'nowe' ? `<button type="button" class="btn btn-secondary btn-sm" data-set="w_toku" data-id="${x.id}">Biorę</button>` : ''}
            ${['nowe', 'w_toku'].includes(x.status) ? `<button type="button" class="btn btn-primary btn-sm" data-set="zalatwione" data-id="${x.id}">Załatwione</button>
              <button type="button" class="btn btn-ghost btn-sm" data-set="anulowane" data-id="${x.id}">Anuluj</button>` : ''}
            ${['zalatwione', 'anulowane'].includes(x.status) && !x.order_number ? `<button type="button" class="btn btn-ghost btn-sm" data-set="nowe" data-id="${x.id}">Otwórz ponownie</button>` : ''}</div></li>`).join('')}</ul>`
        : '<p class="empty-inline">Brak zgłoszeń w tym widoku.</p>'}</section>`;
    body.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { st.zst = b.dataset.v; reload(); }));
    body.querySelector('#zf').addEventListener('submit', e => { e.preventDefault(); st.zq = val(e.target, 'q').trim(); st.zdzial = val(e.target, 'dzial'); reload(); });
    body.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => setStatus(b.dataset.id, b.dataset.set, reload)));
    // Link z powiadomienia: ?tab=zgloszenia&z=<id> – przewinięcie do zgłoszenia.
    const z = new URLSearchParams(location.search).get('z');
    if (z) { history.replaceState({}, '', location.pathname); const el = body.querySelector('#rq-' + CSS.escape(z)); if (el) { el.classList.add('ast-focus'); setTimeout(() => el.scrollIntoView({ block: 'center' }), 50); } }
  }
  function setStatus(id, status, after) {
    if (status === 'w_toku' || status === 'nowe') return api('asystent/zgloszenia/' + id, { status }, 'PATCH').then(() => { toast(status === 'w_toku' ? 'Zgłoszenie jest Twoje.' : 'Zgłoszenie otwarte ponownie.'); after(); }).catch(e => toast(e.message));
    const done = status === 'zalatwione';
    modal(done ? 'Zgłoszenie załatwione' : 'Anuluj zgłoszenie',
      field('s-n', done ? 'Notatka (opcjonalnie): co ustalono' : 'Powód anulowania', `<textarea id="s-n" name="notatka" rows="3" maxlength="2000"${done ? '' : ' required'} placeholder="${done ? 'np. oddzwoniono, umówiono spotkanie na piątek' : 'np. klient zrezygnował'}"></textarea>`),
      { submit: done ? 'Oznacz jako załatwione' : 'Anuluj zgłoszenie', danger: !done, cancel: 'Wróć', onSubmit: async f => {
        const n = val(f, 'notatka').trim();
        await api('asystent/zgloszenia/' + id, { status, ...(n ? { notatka: n } : {}) }, 'PATCH');
        toast(done ? 'Zgłoszenie załatwione.' : 'Zgłoszenie anulowane.'); after();
      } });
  }

  // =============== Integracja z botem ===============
  async function integracja(body, reload, alive) {
    const s = await api('asystent/integracja');
    if (!alive()) return;
    const k = s.klucz, adm = s.moze_zmieniac;
    body.innerHTML = `<section class="panel"><h3 class="panel-sub">Połączenie</h3>
        <p>Bot wysyła po każdej rozmowie jedno zdarzenie (JSON) na adres poniżej, z kluczem w nagłówku <code>Authorization: Bearer …</code>. Ta sama rozmowa wysłana drugi raz nie tworzy duplikatów.</p>
        <dl class="ast-meta"><div><dt>Adres webhooka</dt><dd><code class="ast-code">${esc(s.adres)}</code></dd></div>
          <div><dt>Klucz</dt><dd>${k.ustawiony ? `${chip('ok', 'ustawiony')} <span class="small muted">…${esc(k.koncowka)}, utworzony ${esc(fdt(k.utworzony))}</span>` : chip('warn', 'nie ustawiony')}</dd></div>
          <div><dt>Ostatnia rozmowa od bota</dt><dd>${k.ostatnie_uzycie ? esc(fdt(k.ostatnie_uzycie)) : '–'}</dd></div></dl>
        ${adm ? `<div class="toolbar"><button type="button" class="btn btn-primary btn-sm" id="i-key">${k.ustawiony ? 'Wygeneruj nowy klucz' : 'Wygeneruj klucz'}</button>
          <button type="button" class="btn btn-secondary btn-sm" id="i-test">Wyślij rozmowę testową</button></div>
          <p class="muted small">Rozmowa testowa przechodzi tę samą drogę co rozmowa od bota, ale nie tworzy zleceń ani powiadomień i nie liczy się do wskaźników.</p>`
          : '<p class="muted small">Klucz i ustawienia zmienia administrator.</p>'}</section>
      <section class="panel"><h3 class="panel-sub">Ustawienia bota (plik .env)</h3>
        <pre class="ast-pre">MXT_APP_WEBHOOK_URL=${esc(s.adres)}\nMXT_APP_WEBHOOK_TOKEN=${k.ustawiony ? '&lt;klucz wygenerowany powyżej&gt;' : '&lt;najpierw wygeneruj klucz&gt;'}</pre></section>
      <section class="panel"><h3 class="panel-sub">Przechowywanie transkrypcji (RODO)</h3>
        <form class="toolbar" id="i-ret">${field('i-d', 'Usuwaj transkrypcje starsze niż (dni)', `<input id="i-d" name="dni" type="number" min="7" max="3650" inputmode="numeric" value="${esc(s.retencja_dni)}"${adm ? '' : ' disabled'}>`)}
          ${adm ? '<button type="submit" class="btn btn-secondary btn-sm">Zapisz</button>' : ''}</form>
        <p class="muted small">Plan wdrożenia zakłada 90 dni. Podsumowanie, wynik i zgłoszenia zostają; usuwana jest tylko treść rozmowy.</p></section>
      <section class="panel"><h3 class="panel-sub">Format danych od bota</h3>
        <div class="table-wrap"><table class="table"><thead><tr><th>Pole</th><th>Znaczenie</th></tr></thead><tbody>
          <tr><td><code>call_sid</code></td><td>Identyfikator rozmowy u operatora (np. Twilio CallSid), wymagany</td></tr>
          <tr><td><code>rozpoczeta</code>, <code>zakonczona</code></td><td>Data i godzina ISO 8601</td></tr>
          <tr><td><code>dzial</code></td><td>${Object.keys(DEPT).map(x => `<code>${x}</code>`).join(', ')}</td></tr>
          <tr><td><code>wynik</code></td><td>${Object.keys(OUT).map(x => `<code>${x}</code>`).join(', ')}</td></tr>
          <tr><td><code>transkrypcja</code></td><td>Lista <code>{rola: asystent|klient, tekst, czas}</code></td></tr>
          <tr><td><code>zgloszenia</code></td><td>Lista spraw; <code>rodzaj</code>: ${Object.keys(KIND).map(x => `<code>${x}</code>`).join(', ')}. Wizyta serwisowa z adresem tworzy zlecenie w Serwisach.</td></tr>
          <tr><td><code>test</code></td><td><code>true</code> – rozmowa testowa</td></tr></tbody></table></div>
        <details class="ast-details"><summary>Przykładowa rozmowa (JSON)</summary><pre class="ast-pre">${esc(JSON.stringify(s.przyklad, null, 2))}</pre></details></section>`;
    if (!adm) return;
    body.querySelector('#i-key').addEventListener('click', () => modal(k.ustawiony ? 'Nowy klucz webhooka' : 'Klucz webhooka',
      `<p>${k.ustawiony ? 'Obecny klucz przestanie działać – bot będzie odrzucany, dopóki nie wpiszesz w nim nowego.' : 'Klucz pozwala botowi zapisywać rozmowy w aplikacji.'} Klucz pokażemy tylko raz.</p>`,
      { submit: 'Wygeneruj', onSubmit: async () => {
        const r = await api('asystent/integracja/klucz', {});
        setTimeout(() => modal('Klucz webhooka – skopiuj teraz', `<p>Wpisz go w ustawieniach bota jako <code>MXT_APP_WEBHOOK_TOKEN</code>. Po zamknięciu tego okna nie da się go odczytać.</p>
          <pre class="ast-pre ast-key" id="k-val">${esc(r.klucz)}</pre><button type="button" class="btn btn-secondary btn-sm" id="k-copy">Kopiuj klucz</button>`,
          { cancel: 'Zamknij' }), 0);
        setTimeout(() => { const b = document.getElementById('k-copy'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(r.klucz).then(() => toast('Skopiowano klucz.'), () => toast('Zaznacz klucz i skopiuj ręcznie.'))); }, 50);
        reload();
      } }));
    body.querySelector('#i-test').addEventListener('click', async () => {
      try { const r = await api('asystent/integracja/test', {}); toast('Zapisano rozmowę testową.'); tab = 'rozmowy'; reload(); setTimeout(() => callCard(r.rozmowa_id, reload), 400); }
      catch (e) { toast(e.message); }
    });
    body.querySelector('#i-ret').addEventListener('submit', async e => {
      e.preventDefault();
      try { const r = await api('asystent/integracja/ustawienia', { retencja_dni: Number(val(e.target, 'dni')) }, 'PUT'); toast(`Zapisano. Usunięto transkrypcji: ${r.usunieto}.`); }
      catch (x) { toast(x.message); }
    });
  }

  window.MXT_MODULES.register(PATH, { title: 'Asystent telefoniczny', perm: 'departments.view', render: page });
})();
