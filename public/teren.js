'use strict';
// „Moje montaże” – widok pracownika na telefonie: montaże, do których jest przydzielony (albo jego ekipy) (termin, adres z nawigacją, zakres, urządzenia,
// materiały, skład ekipy z numerami telefonów). Dane i zakres widoczności wyznacza serwer (/api/moje).
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), chip = (...a) => U().chip(...a), fd = v => U().fd(v);
  const ST = { zaplanowany: 'Zaplanowany', w_toku: 'W toku', wykonany: 'Wykonany', odebrany: 'Odebrany', anulowany: 'Anulowany' };
  const ST_CLS = { zaplanowany: 'w_toku', w_toku: 'warn', wykonany: 'ok', odebrany: 'ok', anulowany: 'off' };
  const st = { zakres: 'nadchodzace' };
  const wd = new Intl.DateTimeFormat('pl-PL', { weekday: 'short', day: 'numeric', month: 'short' });
  const day = v => v ? wd.format(new Date(String(v).slice(0, 10) + 'T12:00:00')) : '–';
  const when = x => day(x.planned_date) + (x.planned_end && String(x.planned_end).slice(0, 10) !== String(x.planned_date).slice(0, 10) ? ' – ' + day(x.planned_end) : '');
  const mapUrl = x => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([String(x.address || '').split(';')[0], x.postal_code, x.city].filter(Boolean).join(', '));
  const tel = p => String(p || '').replace(/[^\d+]/g, '');

  async function page(root, path, alive) {
    const body = U().frame(root, path, 'Moje montaże', 'Montaże przydzielone Tobie: terminy, adresy, zakres prac i urządzenia.');
    const reload = () => U().render(path, root);
    const [me, list] = await Promise.all([api('moje'), api('moje/montaze' + (st.zakres === 'wszystkie' ? '?zakres=wszystkie' : ''))]);
    if (!alive()) return;
    if (!me.installer) {
      body.innerHTML = `<section class="panel"><h2 class="panel-title">Konto nie jest powiązane z pracownikiem</h2>
        <p>Poproś administratora, aby w module „Konta i role” powiązał Twoje konto z pracownikiem z listy Pracownicy. Potem zobaczysz tu montaże, do których jesteś przydzielony.</p></section>`;
      return;
    }
    body.innerHTML = `
      <section class="panel field-me"><div>${me.installer.crew_name ? `<p class="label-sm">Ekipa</p><b>${esc(me.installer.crew_name)}</b>` : `<p class="label-sm">Pracownik</p><b>${esc(me.installer.name)}</b>`}
        ${me.installer.leader ? `<span class="muted small"> · brygadzista: ${esc(me.installer.leader)}</span>` : ''}</div>
        <div class="field-team">${me.team.map(t => t.phone ? `<a class="chip chip-link" href="tel:${esc(tel(t.phone))}">${esc(t.name)} ☎</a>` : `<span class="chip">${esc(t.name)}</span>`).join('')}</div></section>
      <div class="seg" role="tablist" aria-label="Zakres">
        <button type="button" class="seg-b${st.zakres === 'nadchodzace' ? ' seg-on' : ''}" data-z="nadchodzace" role="tab" aria-selected="${st.zakres === 'nadchodzace'}">Do zrobienia</button>
        <button type="button" class="seg-b${st.zakres === 'wszystkie' ? ' seg-on' : ''}" data-z="wszystkie" role="tab" aria-selected="${st.zakres === 'wszystkie'}">Ostatnie 90 dni i plan</button></div>
      ${list.length ? `<ul class="job-list">${list.map(x => `<li><button type="button" class="job" data-id="${x.id}">
          <span class="job-date">${esc(when(x))}</span>
          <span class="job-main"><b>${esc(x.building_name)}</b><span class="muted">${esc(x.address)}${x.city ? ', ' + esc(x.city) : ''}</span>
            <span class="small">${esc(x.number)} · urządzenia: ${esc(x.devices_installed)}/${esc(x.devices_planned)}</span></span>
          ${chip(ST_CLS[x.status] || 'off', ST[x.status] || x.status)}</button></li>`).join('')}</ul>`
        : `<section class="panel"><p class="empty-inline">${st.zakres === 'nadchodzace' ? 'Brak zaplanowanych montaży.' : 'Brak montaży w tym okresie.'}</p></section>`}`;
    body.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => { st.zakres = b.dataset.z; reload(); }));
    body.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => detail(b.dataset.id)));
    // Link z powiadomienia: /moje-montaze?m=<id> otwiera od razu kartę montażu.
    const m = new URLSearchParams(location.search).get('m');
    if (m) { history.replaceState({}, '', path); detail(m); }
  }

  async function detail(id) {
    let x;
    try { x = await api('moje/montaze/' + encodeURIComponent(id)); }
    catch (e) { U().toast(e.status === 404 ? 'Ten montaż nie jest przypisany do Ciebie.' : e.message); return; }
    const mats = Array.isArray(x.materials) ? x.materials : [];
    U().modal(`Montaż ${x.number}`, `
      <p>${chip(ST_CLS[x.status] || 'off', ST[x.status] || x.status)} <b>${esc(when(x))}</b></p>
      <div class="job-addr"><b>${esc(x.building_name)}</b><br>${esc(x.address)}${x.postal_code || x.city ? '<br>' + esc([x.postal_code, x.city].filter(Boolean).join(' ')) : ''}
        ${x.customer_name ? `<div class="muted small">Zleceniodawca: ${esc(x.customer_name)}</div>` : ''}
        <a class="btn btn-secondary btn-sm" href="${esc(mapUrl(x))}" target="_blank" rel="noopener">Nawiguj (mapy)</a></div>
      <dl class="kv">${x.buildings_count != null ? `<dt>Liczba budynków</dt><dd>${esc(x.buildings_count)}</dd>` : `<dt>Lokale w budynku</dt><dd>${esc(x.units_count || '–')}</dd>`}<dt>Ogrzewanie</dt><dd>${esc(x.heating_type || '–')}</dd>
        <dt>Urządzenia</dt><dd>${esc(x.devices_installed)} zamontowanych z ${esc(x.devices_planned)} planowanych</dd></dl>
      ${x.scope ? `<p class="label-sm">Zakres prac</p><p class="pre-wrap">${esc(x.scope)}</p>` : ''}
      ${mats.length ? `<p class="label-sm">Materiały</p><ul class="plain">${mats.map(m => `<li>${esc(m.nazwa)} – ${esc(m.ilosc)} ${esc(m.jm || 'szt.')}</li>`).join('')}</ul>` : ''}
      ${x.notes ? `<p class="label-sm">Uwagi</p><p class="pre-wrap">${esc(x.notes)}</p>` : ''}
      <p class="label-sm">Pracownicy na montażu</p><ul class="plain">${x.team.map(t => `<li>${esc(t.name)}${t.phone ? ` – <a href="tel:${esc(tel(t.phone))}">${esc(t.phone)}</a>` : ''}</li>`).join('')}</ul>
      ${x.devices.length ? `<p class="label-sm">Zamontowane urządzenia (${x.devices.length})</p><div class="table-wrap"><table class="table table-sm"><thead><tr><th>Nr seryjny</th><th>Typ</th><th>Lokalizacja</th></tr></thead><tbody>
        ${x.devices.map(d => `<tr><td class="mono-ink">${esc(d.serial_no)}</td><td>${esc(d.type_label)}</td><td>${esc(d.location || '–')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <p class="muted small">Potwierdzanie wykonania i dzienny raport prac pojawią się w kolejnym etapie.</p>`, { wide: true });
  }

  window.MXT_MODULES.register('/moje-montaze', { title: 'Moje montaże', perm: 'field.own', render: page }, { tab: true });
})();
