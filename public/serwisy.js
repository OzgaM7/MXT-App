'use strict';
// Zlecenia serwisowe: zakładka „Serwisy” w dziale Podzielniki i Montaże (biuro, kierownik) oraz „Moje serwisy” (serwisant, telefon).
// Wspólne elementy: karta zlecenia, zdjęcia z aparatu (zmniejszane przed wysłaniem), protokół z podpisem na ekranie.
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), modal = (...a) => U().modal(...a);
  const field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), chip = (...a) => U().chip(...a), fd = v => U().fd(v), fdt = v => U().fdt(v);
  const ST = { nowe: 'Nowe', oczekuje: 'Oczekuje na przydzielenie', przypisane: 'Przypisane', zaplanowane: 'Zaplanowane', w_realizacji: 'W realizacji',
    ponowna_wizyta: 'Wymaga ponownej wizyty', wykonane: 'Wykonane', zatwierdzone: 'Zatwierdzone', rozliczone: 'Rozliczone', zamkniete: 'Zamknięte', anulowane: 'Anulowane' };
  const ST_CLS = { nowe: 'warn', oczekuje: 'warn', przypisane: 'w_toku', zaplanowane: 'w_toku', w_realizacji: 'w_toku', ponowna_wizyta: 'warn', wykonane: 'ok', zatwierdzone: 'ok', rozliczone: 'ok', zamkniete: 'off', anulowane: 'off' };
  const PRIO = { niski: 'Niski', normalny: 'Normalny', wysoki: 'Wysoki', pilny: 'Pilny' };
  const EV = { utworzenie: 'Przyjęcie zlecenia', status: 'Zmiana statusu', przydzial: 'Przydział serwisanta', edycja: 'Edycja danych', notatka: 'Notatka', czynnosc: 'Wykonana czynność', zdjecie: 'Zdjęcie' };
  const tel = p => String(p || '').replace(/[^\d+]/g, '');
  const mapUrl = o => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([o.address, o.city].filter(Boolean).join(', '));
  const addr = o => [o.address, o.unit ? 'lok. ' + o.unit : '', o.city].filter(Boolean).join(', ');
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const days = n => Math.abs(n) === 1 ? '1 dzień' : Math.abs(n) + ' dni';

  // Oznaczenia terminów – osobno od statusu (status mówi, co się dzieje; flaga – czy termin jest zagrożony).
  function flags(o) {
    const out = [];
    if (o.po_terminie_przydzialu) out.push(chip('deny', 'po terminie przydziału'));
    else if (o.przydzial_wkrotce) out.push(chip('warn', o.dni_do_przydzialu === 0 ? 'przydział dziś' : 'przydział za ' + days(o.dni_do_przydzialu)));
    if (o.po_terminie_realizacji) out.push(chip('deny', 'po terminie realizacji'));
    if (o.priority === 'pilny' && !['wykonane', 'zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'].includes(o.status)) out.push(chip('deny', 'pilne'));
    return out.join(' ');
  }
  function assignInfo(o) {
    if (['nowe', 'oczekuje'].includes(o.status)) {
      const d = o.dni_do_przydzialu;
      return `<b class="${d < 0 ? 'txt-danger' : d <= 3 ? 'txt-warn' : ''}">do ${esc(fd(o.assign_due))}</b><div class="muted small">${d < 0 ? 'po terminie ' + days(d) : d === 0 ? 'mija dziś' : 'zostało ' + days(d)}</div>`;
    }
    return `${esc(o.assigned_name || o.assigned_login || '–')}${o.planned_date ? `<div class="muted small">wizyta ${esc(fd(o.planned_date))}</div>` : ''}`;
  }

  // ---------- zdjęcia: zmniejszenie w telefonie (maks. 1600 px, JPEG) ----------
  function compress(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type || 'image/')) return reject(new Error('Wybierz plik ze zdjęciem.'));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Nie udało się odczytać zdjęcia.'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Tego formatu zdjęcia nie da się odczytać. Zrób zdjęcie aparatem w aplikacji.'));
        img.onload = () => {
          const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);   // przezroczyste tło (PNG, zrzuty ekranu) → białe, nie czarne w JPEG
          g.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.8));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function pickPhoto(base, after) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.setAttribute('capture', 'environment');
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      try { toast('Wysyłanie zdjęcia…'); await api(base + '/zdjecia', { data: await compress(f) }); toast('Zdjęcie dodane.'); after(); }
      catch (e) { toast(e.message); }
    });
    inp.click();
  }

  // ---------- podpis na ekranie ----------
  function signaturePad(canvas) {
    const ctx = canvas.getContext('2d'); let drawing = false, dirty = false, last = null;
    const fit = () => { const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(300, Math.round(r.width * dpr)); canvas.height = Math.round(160 * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a1a'; };
    const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
    canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; dirty = true; e.preventDefault(); });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    setTimeout(fit, 30);
    return { clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; }, empty: () => !dirty, data: () => canvas.toDataURL('image/png') };
  }
  function protocolForm(base, o, after) {
    modal('Protokół serwisowy – ' + o.number, `
      <p class="muted small">Po zapisaniu zlecenie przejdzie do stanu „Wykonane”, a kierownik dostanie je do zatwierdzenia.</p>
      ${field('p-w', 'Wykonane czynności', '<textarea id="p-w" name="czynnosci" rows="4" required maxlength="4000" placeholder="np. wymiana baterii, plombowanie, kontrola odczytu"></textarea>')}
      ${field('p-u', 'Użyte części i urządzenia (opcjonalnie)', '<textarea id="p-u" name="uzyte" rows="2" maxlength="2000" placeholder="np. bateria 3,6 V – 1 szt., nr podzielnika"></textarea>')}
      ${field('p-n', 'Uwagi (opcjonalnie)', '<textarea id="p-n" name="uwagi" rows="2" maxlength="2000"></textarea>')}
      ${field('p-c', 'Osoba potwierdzająca wykonanie', `<input id="p-c" name="potwierdzajacy" maxlength="120" autocomplete="off" value="${esc(o.contact_name || '')}">`)}
      <p class="label-sm">Podpis osoby potwierdzającej (palcem na ekranie)</p>
      <canvas class="sig-pad" id="p-sig" aria-label="Pole podpisu"></canvas>
      <div class="sig-actions"><button type="button" class="btn btn-ghost btn-sm" id="p-clear">Wyczyść podpis</button><span class="muted small">Bez podpisu protokół też można zapisać (np. gdy nikogo nie ma w lokalu).</span></div>`,
    { submit: 'Zapisz protokół', wide: true, onSubmit: async f => {
      if (val(f, 'czynnosci').trim().length < 3) throw new Error('Opisz wykonane czynności.');
      const body = { czynnosci: val(f, 'czynnosci'), uzyte: val(f, 'uzyte'), uwagi: val(f, 'uwagi'), potwierdzajacy: val(f, 'potwierdzajacy') };
      if (!pad.empty()) { if (!body.potwierdzajacy.trim()) throw new Error('Podaj imię i nazwisko osoby, która podpisała.'); body.podpis = pad.data(); }
      const r = await api(base + '/protokol', body);
      toast('Protokół ' + r.number + ' zapisany.'); after();
    } });
    const pad = signaturePad(document.getElementById('p-sig'));
    document.getElementById('p-clear').addEventListener('click', () => pad.clear());
  }

  // ---------- karta zlecenia (wspólna) ----------
  function cardHtml(o, base, { office }) {
    // Kolor kropki: czerwony – anulowanie / ponowna wizyta, zielony – wykonanie, turkus – przydział, szary – pozostałe.
    const dot = e => e.to_status === 'anulowane' || e.to_status === 'ponowna_wizyta' ? ' tl-odrzucenie' : ['wykonane', 'zatwierdzone', 'rozliczone', 'zamkniete'].includes(e.to_status) ? ' tl-wykonanie' : e.kind === 'przydzial' ? ' tl-zatwierdzenie' : '';
    const ev = o.events.map(e => `<li><span class="tl-dot${dot(e)}"></span>
      <div><b>${esc(e.kind === 'status' ? ST[e.to_status] || e.to_status : EV[e.kind] || e.kind)}</b> · ${esc(e.full_name || e.login || 'system')} · ${esc(fdt(e.created_at))}${e.note ? `<div class="tl-note">${esc(e.note)}</div>` : ''}</div></li>`).join('');
    return `
      <p class="card-chips">${chip(ST_CLS[o.status], ST[o.status])} ${o.priority !== 'normalny' ? chip(o.priority === 'pilny' ? 'deny' : 'warn', 'priorytet: ' + PRIO[o.priority]) : ''} ${flags(o)}</p>
      <div class="job-addr"><b>${esc(o.client_name || '–')}</b><span>${esc(addr(o))}</span>
        ${o.contact_name || o.contact_phone ? `<span>${esc(o.contact_name || '')}${o.contact_phone ? ` · <a href="tel:${esc(tel(o.contact_phone))}">${esc(o.contact_phone)}</a>` : ''}</span>` : ''}
        <a class="btn btn-secondary btn-sm" href="${esc(mapUrl(o))}" target="_blank" rel="noopener">Nawiguj (mapy)</a></div>
      <dl class="kv"><dt>Otrzymano</dt><dd>${esc(fd(o.received_at))}</dd>
        <dt>Termin przydziału</dt><dd>${esc(fd(o.assign_due))}${['nowe', 'oczekuje'].includes(o.status) ? ' · ' + (o.dni_do_przydzialu < 0 ? '<b class="txt-danger">po terminie ' + days(o.dni_do_przydzialu) + '</b>' : 'zostało ' + days(o.dni_do_przydzialu)) : ''}</dd>
        <dt>Termin realizacji</dt><dd>${o.due_date ? esc(fd(o.due_date)) + (o.po_terminie_realizacji ? ' · <b class="txt-danger">po terminie</b>' : '') : '–'}</dd>
        <dt>Serwisant</dt><dd>${esc(o.assigned_name || o.assigned_login || '–')}</dd><dt>Wizyta</dt><dd>${esc(o.planned_date ? fd(o.planned_date) : '–')}</dd>
        ${office && o.complaint ? `<dt>Reklamacja</dt><dd>${esc(o.complaint.number)} – ${esc(o.complaint.title)}</dd>` : ''}</dl>
      <p class="label-sm">Opis usterki / zakres</p><p class="pre-wrap">${esc(o.description)}</p>
      <div class="card-actions" id="sc-actions"></div>
      ${o.photos.length ? `<p class="label-sm">Zdjęcia (${o.photos.length})</p><div class="photo-grid">${o.photos.map(p => `<a href="/api/${base}/zdjecia/${p.id}" target="_blank" rel="noopener"><img src="/api/${base}/zdjecia/${p.id}" alt="${esc(p.caption || 'Zdjęcie ze zlecenia')}" loading="lazy"></a>`).join('')}</div>` : ''}
      <details class="ap-hist" open><summary>Historia (${o.events.length})</summary><ol class="timeline">${ev}</ol></details>`;
  }
  const btn = (id, label, cls = 'btn-secondary') => `<button type="button" class="btn ${cls} btn-sm" data-a="${id}">${label}</button>`;
  function bindActions(map) {
    const box = document.getElementById('sc-actions'); if (!box) return;
    box.innerHTML = Object.entries(map).filter(([, v]) => v).map(([k, v]) => v.html).join('');
    box.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => map[b.dataset.a].run()));
  }
  const ask = (title, label, url, body, after, { danger = false, submit = 'Zapisz', required = true, input = 'text' } = {}) => modal(title,
    field('ask-v', label, input === 'date' ? `<input id="ask-v" name="v" type="date" required value="${today()}">` : `<textarea id="ask-v" name="v" rows="3" maxlength="1000"${required ? ' required' : ''}></textarea>`),
    { submit, danger, onSubmit: async f => { const v = val(f, 'v').trim(); if (required && !v) throw new Error('Uzupełnij pole.'); await api(url, body(v)); after(); } });

  // ==================== biuro: zakładka „Serwisy” w dziale ====================
  const st = { widok: 'aktywne', q: '', serwisant: '', strona: 1 };
  async function officeTab(body, reload, alive) {
    const qs = new URLSearchParams(Object.entries({ widok: st.widok, q: st.q, serwisant: st.serwisant, strona: st.strona }).filter(([, v]) => v));
    const [sum, techs, resp] = await Promise.all([api('serwisy/podsumowanie'), api('serwisy/serwisanci'),
      fetch('/api/serwisy?' + qs, { credentials: 'same-origin', cache: 'no-store' })]);
    if (!resp.ok) throw Object.assign(new Error((await resp.json().catch(() => ({}))).error || 'Nie udało się wczytać zleceń.'), { status: resp.status });
    const list = await resp.json(), total = +resp.headers.get('X-Total-Count') || 0, pages = Math.max(1, Math.ceil(total / 50));
    if (!alive()) return;
    const kpi = (label, v, tone, widok) => `<button type="button" class="kpi kpi-${v ? tone : 'neutral'}" data-w="${widok}"><span class="kpi-v">${esc(v)}</span><span class="kpi-l">${esc(label)}</span></button>`;
    const VIEWS = [['aktywne', 'Aktywne'], ['nieprzypisane', 'Do przydzielenia'], ['po_terminie', 'Po terminie'], ['w_realizacji', 'U serwisantów'], ['do_zatwierdzenia', 'Do zatwierdzenia'],
      ['zakonczone', 'Zatwierdzone'], ['anulowane', 'Anulowane'], ['wszystkie', 'Wszystkie']];
    const xl = U().has('export.xlsx') ? `<a class="btn btn-secondary btn-sm btn-xl" href="/api/eksport/d1/serwisy" download>Eksport do Excela</a>` : '';
    body.innerHTML = `<section class="kpis">
        ${kpi('Do przydzielenia', sum.nieprzypisane, 'warn', 'nieprzypisane')}
        ${kpi('Po terminie przydziału (' + sum.termin_przydzialu_dni + ' dni)', sum.po_terminie_przydzialu, 'danger', 'po_terminie')}
        ${kpi('Przydział w ciągu 3 dni', sum.przydzial_wkrotce, 'warn', 'nieprzypisane')}
        ${kpi('U serwisantów', sum.w_realizacji, 'blue', 'w_realizacji')}
        ${kpi('Po terminie realizacji', sum.po_terminie_realizacji, 'danger', 'po_terminie')}
        ${kpi('Do zatwierdzenia', sum.do_zatwierdzenia, 'violet', 'do_zatwierdzenia')}</section>
      <div class="seg seg-wrap" role="tablist" aria-label="Widok listy">${VIEWS.map(([k, v]) => `<button type="button" class="seg-b${st.widok === k ? ' seg-on' : ''}" data-w="${k}" role="tab" aria-selected="${st.widok === k}">${v}</button>`).join('')}</div>
      <form class="toolbar" id="sf"><label class="visually-hidden" for="sq">Szukaj</label><input id="sq" name="q" class="select-sm" placeholder="Szukaj: numer, klient, adres, telefon, opis" value="${esc(st.q)}">
        <label class="visually-hidden" for="ss">Serwisant</label><select id="ss" name="serwisant" class="select-sm"><option value="">Każdy serwisant</option>${techs.map(t => `<option value="${t.id}"${st.serwisant === t.id ? ' selected' : ''}>${esc(t.full_name || t.login)} (${t.otwarte})</option>`).join('')}</select>
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button><button type="button" class="btn btn-primary btn-sm" id="s-new">Nowe zlecenie</button>${xl}</form>
      ${techs.length ? '' : '<p class="notice">Nie ma jeszcze kont serwisantów. Załóż je w Menu → Konta i role (rola „Serwisant”), aby przydzielać zlecenia.</p>'}
      <section class="panel">${list.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Zlecenie</th><th>Klient i adres</th><th>Status</th><th>Przydział / serwisant</th><th>Termin realizacji</th><th></th></tr></thead><tbody>
        ${list.map(o => `<tr><td class="nowrap"><b>${esc(o.number)}</b><div class="muted small">otrzymano ${esc(fd(o.received_at))}</div></td>
          <td>${esc(o.client_name || '–')}<div class="muted small">${esc(addr(o))}</div></td>
          <td>${chip(ST_CLS[o.status], ST[o.status])}${o.priority !== 'normalny' && o.priority !== 'niski' ? ' ' + chip(o.priority === 'pilny' ? 'deny' : 'warn', PRIO[o.priority]) : ''}<div class="flags">${flags(o)}</div></td>
          <td class="small">${assignInfo(o)}</td><td class="small">${o.due_date ? `<span class="${o.po_terminie_realizacji ? 'txt-danger' : ''}">${esc(fd(o.due_date))}</span>` : '–'}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-open="${o.id}">Otwórz</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty-inline">Brak zleceń w tym widoku.</p>'}
        <p class="muted small list-count">Razem: <b>${esc(total)}</b>${pages > 1 ? ` · strona ${st.strona} z ${pages}` : ''}</p>
        ${pages > 1 ? `<nav class="pager" aria-label="Strony"><button type="button" class="btn btn-secondary btn-sm" data-pg="-1"${st.strona <= 1 ? ' disabled' : ''}>← Poprzednia</button>
          <button type="button" class="btn btn-secondary btn-sm" data-pg="1"${st.strona >= pages ? ' disabled' : ''}>Następna →</button></nav>` : ''}</section>`;
    body.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', () => { st.widok = b.dataset.w; st.strona = 1; reload(); }));
    body.querySelector('#sf').addEventListener('submit', e => { e.preventDefault(); st.q = val(e.target, 'q').trim(); st.serwisant = val(e.target, 'serwisant'); st.strona = 1; reload(); });
    body.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => { st.strona += Number(b.dataset.pg); reload(); }));
    body.querySelector('#s-new').addEventListener('click', () => orderForm(null, techs, reload));
    body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => officeCard(b.dataset.open, techs, reload)));
    // Link z powiadomienia: ?tab=serwisy&z=<id> otwiera kartę zlecenia.
    const z = new URLSearchParams(location.search).get('z');
    if (z) { history.replaceState({}, '', location.pathname); officeCard(z, techs, reload); }
  }

  async function orderForm(o, techs, after) {
    const isNew = !o, d = o || { priority: 'normalny', received_at: today() };
    const [blds, cpls] = await Promise.all([api('d1/budynki').catch(() => []), isNew ? api('serwisy/reklamacje').catch(() => []) : []]);
    modal(isNew ? 'Nowe zlecenie serwisowe' : 'Edycja zlecenia ' + o.number, `
      ${isNew ? '<p class="muted small">Termin przydzielenia serwisanta (14 dni kalendarzowych od daty otrzymania) wylicza się automatycznie. Termin realizacji ustawiasz osobno.</p>' : ''}
      <div class="field-row">${field('o-rec', 'Data otrzymania', `<input id="o-rec" name="received_at" type="date" max="${today()}" value="${esc(d.received_at || '')}">`)}
        ${field('o-pr', 'Priorytet', `<select id="o-pr" name="priority">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}"${d.priority === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      ${isNew && cpls.length ? field('o-cpl', 'Z reklamacji (opcjonalnie)', `<select id="o-cpl" name="complaint_id"><option value="">– brak –</option>${cpls.map(k => `<option value="${k.id}">${esc(k.number)} – ${esc(k.title)}${k.building_name ? ' (' + esc(k.building_name) + ')' : ''}</option>`).join('')}</select>`) : ''}
      ${field('o-b', 'Budynek z ewidencji (opcjonalnie – uzupełni adres i klienta)', `<select id="o-b" name="building_id"><option value="">– inny adres –</option>${blds.map(b => `<option value="${b.id}"${d.building_id === b.id ? ' selected' : ''}>${esc(b.name)} – ${esc(b.address)}</option>`).join('')}</select>`)}
      ${field('o-cl', 'Klient (osoba, wspólnota, firma)', `<input id="o-cl" name="client_name" maxlength="200" value="${esc(d.client_name || '')}">`)}
      <div class="field-row">${field('o-a', 'Adres realizacji', `<input id="o-a" name="address" maxlength="300" value="${esc(d.address || '')}">`)}${field('o-u', 'Lokal', `<input id="o-u" name="unit" maxlength="40" value="${esc(d.unit || '')}">`)}</div>
      ${field('o-c', 'Miasto', `<input id="o-c" name="city" maxlength="100" value="${esc(d.city || '')}">`)}
      <div class="field-row">${field('o-cn', 'Osoba kontaktowa', `<input id="o-cn" name="contact_name" maxlength="120" value="${esc(d.contact_name || '')}">`)}
        ${field('o-cp', 'Telefon', `<input id="o-cp" name="contact_phone" type="tel" maxlength="40" value="${esc(d.contact_phone || '')}">`)}</div>
      ${field('o-ce', 'E-mail (opcjonalnie)', `<input id="o-ce" name="contact_email" type="email" maxlength="200" value="${esc(d.contact_email || '')}">`)}
      ${field('o-d', 'Opis usterki / zakres prac', `<textarea id="o-d" name="description" rows="3" required maxlength="4000">${esc(d.description || '')}</textarea>`)}
      ${field('o-due', 'Termin realizacji (opcjonalnie)', `<input id="o-due" name="due_date" type="date" value="${esc(d.due_date || '')}">`)}
      ${isNew ? `<div class="field-row">${field('o-t', 'Przydziel od razu (opcjonalnie)', `<select id="o-t" name="assigned_to"><option value="">– później –</option>${techs.map(t => `<option value="${t.id}">${esc(t.full_name || t.login)} (otwarte: ${t.otwarte})</option>`).join('')}</select>`)}
        ${field('o-pd', 'Termin wizyty', '<input id="o-pd" name="planned_date" type="date">')}</div>
        <label class="toggle"><input type="checkbox" name="nowe"> Zgłoszenie do weryfikacji (status „Nowe”, np. niepełne dane)</label>` : ''}`,
    { submit: isNew ? 'Przyjmij zlecenie' : 'Zapisz', wide: true, onSubmit: async f => {
      const b = {};
      for (const k of ['received_at', 'priority', 'building_id', 'client_name', 'address', 'unit', 'city', 'contact_name', 'contact_phone', 'contact_email', 'description', 'due_date']) b[k] = val(f, k);
      if (!b.building_id) b.building_id = null;
      if (!b.due_date) b.due_date = null;
      if (isNew) {
        b.complaint_id = f.querySelector('[name=complaint_id]') ? val(f, 'complaint_id') || null : null;
        if (val(f, 'assigned_to')) { b.assigned_to = val(f, 'assigned_to'); b.planned_date = val(f, 'planned_date') || null; }
        b.zweryfikowane = !f.querySelector('[name=nowe]').checked;
        const r = await api('serwisy', b); toast(`Przyjęto zlecenie ${r.number}. Termin przydziału: ${fd(r.assign_due)}.`);
      } else { await api('serwisy/' + o.id, { ...b, updated_at: o.updated_at }, 'PATCH'); toast('Zapisano zmiany.'); }
      after();
    } });
  }

  async function officeCard(id, techs, reload) {
    let o;
    try { o = await api('serwisy/' + id); } catch (e) { toast(e.message); return; }
    const base = 'serwisy/' + o.id, again = () => { reload(); officeCard(id, techs, reload); };
    modal('Zlecenie serwisowe ' + o.number, cardHtml(o, base, { office: true }), { wide: true });
    const open = !['zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'].includes(o.status), assigned = ['przypisane', 'zaplanowane', 'ponowna_wizyta'].includes(o.status);
    const assignForm = () => modal(o.assigned_to ? 'Zmień serwisanta' : 'Przydziel serwisanta', `
      ${techs.length ? '' : '<p class="notice">Brak kont z rolą Serwisant.</p>'}
      ${field('a-t', 'Serwisant (w nawiasie – otwarte zlecenia)', `<select id="a-t" name="assigned_to" required>${techs.map(t => `<option value="${t.id}"${o.assigned_to === t.id ? ' selected' : ''}>${esc(t.full_name || t.login)} (${t.otwarte})</option>`).join('')}</select>`)}
      ${field('a-d', 'Termin wizyty (opcjonalnie)', `<input id="a-d" name="planned_date" type="date" value="${esc(o.planned_date || '')}">`)}
      <p class="muted small">Termin przydziału: ${esc(fd(o.assign_due))}. Serwisant dostanie powiadomienie.</p>`,
      { submit: 'Przydziel', onSubmit: async f => { await api(base + '/przydziel', { assigned_to: val(f, 'assigned_to'), planned_date: val(f, 'planned_date') || null }); toast('Przydzielono serwisanta.'); again(); } });
    bindActions({
      weryf: o.status === 'nowe' && { html: btn('weryf', 'Zweryfikuj zgłoszenie'), run: async () => { await api(base + '/weryfikacja', {}); toast('Zgłoszenie czeka na przydział.'); again(); } },
      przydziel: ['nowe', 'oczekuje'].includes(o.status) && { html: btn('przydziel', 'Przydziel serwisanta', 'btn-primary'), run: assignForm },
      zmien: assigned && { html: btn('zmien', 'Zmień serwisanta'), run: assignForm },
      termin: assigned && { html: btn('termin', 'Termin wizyty'), run: () => ask('Termin wizyty', 'Data wizyty', base + '/termin', v => ({ planned_date: v }), again, { input: 'date' }) },
      odbierz: assigned && { html: btn('odbierz', 'Odbierz przydział'), run: () => ask('Odebrać przydział?', 'Powód (serwisant dostanie powiadomienie)', base + '/odbierz', v => ({ powod: v }), again, { danger: true, submit: 'Odbierz' }) },
      protokol: ['przypisane', 'zaplanowane', 'w_realizacji', 'ponowna_wizyta'].includes(o.status) && { html: btn('protokol', 'Wpisz protokół'), run: () => protocolForm(base, o, again) },
      zatw: o.status === 'wykonane' && U().has('service.approve') && { html: btn('zatw', 'Zatwierdź wykonanie', 'btn-primary'), run: async () => { await api(base + '/zatwierdz', {}); toast('Zlecenie zatwierdzone.'); again(); } },
      popraw: o.status === 'wykonane' && { html: btn('popraw', 'Cofnij do poprawy'), run: () => ask('Cofnąć do poprawy?', 'Co trzeba poprawić (serwisant dostanie powiadomienie)', base + '/do-poprawy', v => ({ powod: v }), again, { submit: 'Cofnij' }) },
      pdf: o.protocol_document_id && { html: `<a class="btn btn-secondary btn-sm" href="/api/dokumenty/${o.protocol_document_id}/plik" target="_blank" rel="noopener">Protokół PDF</a>`, run: () => {} },
      notatka: open && { html: btn('notatka', 'Dodaj notatkę'), run: () => ask('Notatka', 'Treść notatki (trafi do historii)', base + '/notatka', v => ({ notatka: v }), again) },
      foto: open && { html: btn('foto', 'Dodaj zdjęcie'), run: () => pickPhoto(base, again) },
      // ERP: materiały z magazynu i czas pracy na zlecenie (koszty zlecenia i projektu).
      material: !['anulowane', 'zamkniete'].includes(o.status) && window.MXT_ERP && { html: btn('material', 'Wydaj materiał'), run: () => window.MXT_ERP.issueForm({ related_type: 'service_order', related_id: o.id, title: o.number }, again) },
      czas: !['anulowane', 'zamkniete'].includes(o.status) && window.MXT_ERP && U().has('time.own') && { html: btn('czas', 'Czas pracy'), run: () => window.MXT_ERP.timeForm({ related_type: 'service_order', related_id: o.id, title: o.number }, again) },
      edytuj: open && { html: btn('edytuj', 'Edytuj dane'), run: () => orderForm(o, techs, again) },
      anuluj: open && { html: btn('anuluj', 'Anuluj zlecenie', 'btn-ghost'), run: () => ask('Anulować zlecenie ' + o.number + '?', 'Powód anulowania', base + '/anuluj', v => ({ powod: v }), again, { danger: true, submit: 'Anuluj zlecenie' }) }
    });
  }

  // ==================== serwisant: „Moje serwisy” ====================
  const my = { zakres: 'aktywne' };
  async function myPage(root, path, alive) {
    const body = U().frame(root, path, 'Moje serwisy', 'Zlecenia przypisane do Ciebie: adres, kontakt, opis usterki, zdjęcia i protokół.');
    const reload = () => U().render(path, root);
    const list = await api('moje/serwisy' + (my.zakres === 'zakonczone' ? '?zakres=zakonczone' : ''));
    if (!alive()) return;
    const when = o => o.planned_date ? 'wizyta ' + fd(o.planned_date) : o.due_date ? 'termin ' + fd(o.due_date) : 'bez terminu';
    body.innerHTML = `
      <div class="seg" role="tablist" aria-label="Zakres">
        <button type="button" class="seg-b${my.zakres === 'aktywne' ? ' seg-on' : ''}" data-z="aktywne" role="tab" aria-selected="${my.zakres === 'aktywne'}">Do zrobienia</button>
        <button type="button" class="seg-b${my.zakres === 'zakonczone' ? ' seg-on' : ''}" data-z="zakonczone" role="tab" aria-selected="${my.zakres === 'zakonczone'}">Wykonane (60 dni)</button></div>
      ${list.length ? `<ul class="job-list">${list.map(o => `<li><button type="button" class="job${o.pilne ? ' job-urgent' : ''}" data-id="${o.id}">
          <span class="job-date">${esc(when(o))}</span>
          <span class="job-main"><b>${esc(o.client_name || addr(o))}</b><span class="muted">${esc(addr(o))}</span>
            <span class="small">${esc(o.number)} · ${esc(o.description.slice(0, 80))}${o.description.length > 80 ? '…' : ''}</span>${flags(o) ? `<span class="flags">${flags(o)}</span>` : ''}</span>
          ${chip(ST_CLS[o.status], ST[o.status])}</button></li>`).join('')}</ul>`
        : `<section class="panel"><p class="empty-inline">${my.zakres === 'aktywne' ? 'Nie masz zleceń do realizacji.' : 'Brak wykonanych zleceń w ostatnich 60 dniach.'}</p></section>`}`;
    body.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => { my.zakres = b.dataset.z; reload(); }));
    body.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => techCard(b.dataset.id, reload)));
    const z = new URLSearchParams(location.search).get('z');
    if (z) { history.replaceState({}, '', path); techCard(z, reload); }
  }
  async function techCard(id, reload) {
    let o;
    try { o = await api('moje/serwisy/' + encodeURIComponent(id)); }
    catch (e) { toast(e.status === 404 ? 'To zlecenie nie jest przypisane do Ciebie.' : e.message); return; }
    const base = 'moje/serwisy/' + o.id, again = () => { reload(); techCard(id, reload); };
    modal('Serwis ' + o.number, cardHtml(o, base, { office: false }), { wide: true });
    const status = to => api(base + '/status', { status: to });
    const active = ['przypisane', 'zaplanowane', 'w_realizacji', 'ponowna_wizyta'].includes(o.status);
    bindActions({
      start: ['przypisane', 'zaplanowane', 'ponowna_wizyta'].includes(o.status) && { html: btn('start', 'Rozpocznij pracę', 'btn-primary'), run: async () => { await status('w_realizacji'); toast('Status: w realizacji.'); again(); } },
      plan: ['przypisane', 'zaplanowane', 'ponowna_wizyta'].includes(o.status) && { html: btn('plan', o.planned_date ? 'Zmień termin wizyty' : 'Ustal termin wizyty'),
        run: () => ask('Termin wizyty', 'Data wizyty', base + '/status', v => ({ status: 'zaplanowane', planned_date: v }), again, { input: 'date' }) },
      done: o.status === 'w_realizacji' && { html: btn('done', 'Zakończ – protokół i podpis', 'btn-primary'), run: () => protocolForm(base, o, again) },
      again: o.status === 'w_realizacji' && { html: btn('again', 'Potrzebna ponowna wizyta'), run: () => modal('Ponowna wizyta', `
          ${field('rv-n', 'Powód (np. brak dostępu do lokalu, brak części)', '<textarea id="rv-n" name="notatka" rows="3" required maxlength="1000"></textarea>')}
          ${field('rv-d', 'Proponowany termin (opcjonalnie)', '<input id="rv-d" name="planned_date" type="date">')}`,
        { submit: 'Zgłoś', onSubmit: async f => { if (val(f, 'notatka').trim().length < 3) throw new Error('Opisz powód.'); await api(base + '/status', { status: 'ponowna_wizyta', notatka: val(f, 'notatka'), planned_date: val(f, 'planned_date') || null }); toast('Zgłoszono potrzebę ponownej wizyty.'); again(); } }) },
      foto: active && { html: btn('foto', 'Dodaj zdjęcie'), run: () => pickPhoto(base, again) },
      czyn: active && { html: btn('czyn', 'Dodaj notatkę'), run: () => ask('Notatka / wykonana czynność', 'Treść (trafi do historii zlecenia)', base + '/notatka', v => ({ notatka: v, czynnosc: true }), again) },
      pdf: o.protocol_document_id && { html: `<a class="btn btn-secondary btn-sm" href="/api/${base}/protokol" target="_blank" rel="noopener">Protokół PDF</a>`, run: () => {} }
    });
  }

  window.MXT_SERWIS = { officeTab };
  window.MXT_MODULES.register('/moje-serwisy', { title: 'Moje serwisy', perm: 'service.own', render: myPage }, { tab: true });
})();
