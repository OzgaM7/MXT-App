'use strict';
// Harmonogram montaży: „Importuj z Excela” (szablon → podgląd z błędami → zapis) i „Wczytaj z umowy / harmonogramu”
// (PDF, skan, zdjęcie → odczyt danych → formularz do sprawdzenia → kontrakt, obiekty, montaże i dokument w kontrakcie).
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), modal = (...a) => U().modal(...a);
  const field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), chip = (...a) => U().chip(...a), fd = v => U().fd(v);
  const toB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('Nie udało się odczytać pliku.')); r.readAsDataURL(file); });
  const opt = (list, sel, label, value) => list.map(x => `<option value="${esc(value(x))}"${String(sel || '') === String(value(x)) ? ' selected' : ''}>${esc(label(x))}</option>`).join('');
  const later = fn => setTimeout(fn, 60);   // nowe okno po zamknięciu bieżącego

  // ==================== Excel ====================
  function excel(reload) {
    modal('Importuj montaże z Excela', `
      <p>Wczytaj listę montaży z arkusza <b>.xlsx</b> albo <b>.csv</b> – jeden wiersz to jeden montaż. Przed zapisem zobaczysz podgląd: błędne wiersze i możliwe duplikaty nie zostaną zaimportowane.</p>
      <p><a class="btn btn-secondary btn-sm" href="/api/d1/import/szablon" download>Pobierz szablon Excela</a></p>
      ${field('x-f', 'Plik Excel lub CSV (do 5 MB)', '<input id="x-f" name="plik" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required>')}
      <p class="muted small">Wymagane kolumny: <b>Termin od</b> oraz <b>Budynek</b> lub <b>Adres</b>. Opcjonalne: miasto, kod, lokale, termin do, ekipa, liczba urządzeń, zakres prac, kontrakt, materiały, uwagi. Nieznane budynki zostaną dodane do ewidencji.</p>`,
    { submit: 'Sprawdź plik', onSubmit: async f => {
      const file = f.querySelector('[name=plik]').files[0];
      if (!file) throw new Error('Wybierz plik.');
      if (file.size > 5 * 1024 * 1024) throw new Error('Plik jest za duży (maks. 5 MB).');
      const plik = await toB64(file);
      const a = await api('d1/import/excel', { plik, nazwa: file.name });
      later(() => preview(a, plik, file.name, reload));
    } });
  }
  function preview(a, plik, nazwa, reload) {
    const s = a.summary, ST = { ok: ['ok', 'do importu'], blad: ['deny', 'błąd'], duplikat: ['warn', 'pominięty'] };
    const rows = a.rows.slice(0, 300);
    modal('Podgląd importu – ' + nazwa, `
      <p class="card-chips">${chip('ok', 'do importu: ' + s.ok)} ${s.bledy ? chip('deny', 'z błędami: ' + s.bledy) : ''} ${s.duplikaty ? chip('warn', 'możliwe duplikaty: ' + s.duplikaty) : ''} ${s.nowe_budynki ? chip('w_toku', 'nowe budynki: ' + s.nowe_budynki) : ''}</p>
      <p class="muted small">Rozpoznane kolumny: ${esc(a.columns.join(', '))}.${a.missing.length ? ' Brak (opcjonalne): ' + esc(a.missing.join(', ')) + '.' : ''}</p>
      <div class="table-wrap"><table class="table table-sm"><thead><tr><th>Wiersz</th><th>Budynek</th><th>Termin</th><th>Ekipa</th><th class="num">Urządzenia</th><th>Status</th><th>Uwagi</th></tr></thead><tbody>
      ${rows.map(o => `<tr class="${o.status === 'ok' ? '' : 'row-off'}"><td>${esc(o.row)}</td>
        <td>${esc(o.data.building ? o.data.building.label : o.data.name || o.data.address || '–')}${o.data.building && o.data.building.mode === 'nowy' ? ' ' + chip('w_toku', 'nowy') : ''}</td>
        <td class="nowrap">${o.data.planned_date ? esc(fd(o.data.planned_date)) : '–'}${o.data.planned_end ? ' – ' + esc(fd(o.data.planned_end)) : ''}</td>
        <td>${esc(o.data.crew ? o.data.crew.name : '–')}</td><td class="num">${esc(o.data.devices_planned)}</td>
        <td>${chip(ST[o.status][0], ST[o.status][1])}</td><td class="small">${[...o.errors.map(e => `<span class="txt-danger">${esc(e)}</span>`), ...o.warnings.map(w => esc(w))].join('<br>') || '–'}</td></tr>`).join('')}
      </tbody></table></div>${a.rows.length > rows.length ? `<p class="muted small">Pokazano ${rows.length} z ${a.rows.length} wierszy.</p>` : ''}
      ${s.ok ? '' : '<p class="notice notice-error">Brak poprawnych wierszy – popraw plik i wczytaj go ponownie.</p>'}`,
    s.ok ? { submit: `Importuj ${s.ok} ${s.ok === 1 ? 'montaż' : 'montaże'}`, wide: true, onSubmit: async () => {
      const r = await api('d1/import/excel', { plik, nazwa, zatwierdz: true });
      toast(`Zaimportowano montaże: ${r.utworzono}${r.nowe_budynki ? `, nowe budynki: ${r.nowe_budynki}` : ''}${r.pominieto ? `, pominięto: ${r.pominieto}` : ''}.`); reload();
    } } : { wide: true });
  }

  // ==================== umowa / harmonogram ====================
  async function document_(reload) {
    const av = await api('d1/import/dokument/dostepnosc').catch(() => ({ ai: true }));
    modal('Wczytaj montaż z umowy lub harmonogramu', `
      <p>Wybierz umowę, zlecenie albo harmonogram – <b>PDF, skan lub zdjęcie</b>. ${av.ai
        ? 'Dane (zamawiający, terminy, liczba urządzeń, stawki, kary) zostaną odczytane automatycznie i pokazane w formularzu do sprawdzenia.'
        : 'Po wczytaniu przepiszesz dane (zamawiający, terminy, liczba urządzeń, stawki, kary) do formularza – dokument otworzysz przyciskiem „Otwórz dokument”.'} Nic nie zapisze się bez Twojego zatwierdzenia.</p>
      ${av.ai ? '' : `<p class="notice">Automatyczny odczyt jest wyłączony${U().has('ai.settings') ? ' – włącza go klucz ANTHROPIC_API_KEY w ustawieniach serwera (Render → Environment)' : ''}.</p>`}
      ${field('d-f', 'Dokument (PDF, JPG lub PNG, do 10 MB)', '<input id="d-f" name="plik" type="file" accept=".pdf,application/pdf,image/jpeg,image/png" required>')}
      <p class="muted small">${av.ai ? 'Odczyt trwa zwykle do minuty. ' : ''}Dokument zostanie dołączony do kontraktu.</p>`,
    { submit: 'Wczytaj dokument', onSubmit: async f => {
      const file = f.querySelector('[name=plik]').files[0];
      if (!file) throw new Error('Wybierz plik.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Plik jest za duży (maks. 10 MB).');
      const btn = f.querySelector('[type=submit]'); btn.textContent = 'Odczytuję dokument…';
      const r = await api('d1/import/dokument', { plik: await toB64(file), nazwa: file.name });
      later(() => review(r, reload));
    } });
  }

  const objRow = (o, i, bs, crews) => `<div class="obj-row" data-i="${i}">
      <div class="obj-head"><b>Montaż ${i + 1}</b><button type="button" class="btn btn-ghost btn-sm" data-del="${i}">Usuń</button></div>
      ${field(`o${i}-b`, 'Budynek / obiekt', `<select id="o${i}-b" name="o_building"><option value="">+ Nowy (dane poniżej)</option>${opt(bs, o.building_id, b => b.name + ', ' + b.address, b => b.id)}</select>`)}
      <div class="obj-new"${o.building_id ? ' hidden' : ''}>
        <div class="field-row">${field(`o${i}-n`, 'Nazwa budynku / obiektu', `<input id="o${i}-n" name="o_name" maxlength="200" value="${esc(o.name || '')}">`)}${field(`o${i}-u`, 'Liczba lokali', `<input id="o${i}-u" name="o_units" type="number" min="0" inputmode="numeric" value="${esc(o.units_count == null ? '' : o.units_count)}">`)}</div>
        <div class="field-row">${field(`o${i}-a`, 'Adres', `<input id="o${i}-a" name="o_address" maxlength="300" value="${esc(o.address || '')}" placeholder="ulica i numer">`)}${field(`o${i}-c`, 'Miasto', `<input id="o${i}-c" name="o_city" maxlength="100" value="${esc(o.city || '')}">`)}</div></div>
      <div class="field-row">${field(`o${i}-d`, 'Termin od', `<input id="o${i}-d" name="o_from" type="date" value="${esc(o.planned_date || '')}">`)}${field(`o${i}-e`, 'Termin do', `<input id="o${i}-e" name="o_to" type="date" value="${esc(o.planned_end || '')}">`)}</div>
      <div class="field-row">${field(`o${i}-v`, 'Liczba urządzeń', `<input id="o${i}-v" name="o_devices" type="number" min="0" inputmode="numeric" value="${esc(o.devices_planned == null ? '' : o.devices_planned)}">`)}
        ${field(`o${i}-k`, 'Ekipa', `<select id="o${i}-k" name="o_crew"><option value="">– później –</option>${opt(crews, o.crew_id, c => c.name, c => c.id)}</select>`)}</div>
      ${field(`o${i}-s`, 'Zakres prac', `<textarea id="o${i}-s" name="o_scope" rows="2" maxlength="4000">${esc(o.scope || '')}</textarea>`)}</div>`;

  async function review(r, reload) {
    const [bs, crewsAll, kt, custs] = await Promise.all([api('d1/budynki'), api('d1/ekipy'), api('d1/kontrakty'), api('klienci')]);
    const crews = crewsAll.filter(c => !c.virtual && c.is_active);
    const p = r.propozycja || { klient: {}, inwestor: null, kontrakt: {}, obiekty: [{}] };
    const k = p.kontrakt || {}, kl = p.klient || {}, inv = p.inwestor;
    let objects = (p.obiekty && p.obiekty.length ? p.obiekty : [{}]).map(o => ({ ...o }));
    const custSel = (id, sel, empty) => `<select id="${id}" name="${id}"><option value="">${esc(empty)}</option>${opt(custs, sel, c => c.name + (c.tax_id ? ' · NIP ' + c.tax_id : ''), c => c.id)}</select>`;
    modal('Sprawdź dane z dokumentu – ' + (r.dane && r.dane.document_type ? r.dane.document_type : 'dokument'), `
      ${r.tryb === 'ai' ? `<p class="notice">Dane odczytane automatycznie. Porównaj je z dokumentem przed zapisem.${p.uncertain ? ' <b>Niepewne:</b> ' + esc(p.uncertain) : ''}</p>`
        : `<p class="notice">${esc(r.uwaga || 'Uzupełnij dane ręcznie.')}</p>`}
      <p><a class="btn btn-secondary btn-sm" href="/api/d1/import/dokument/${esc(r.id)}/plik" target="_blank" rel="noopener">Otwórz dokument</a></p>
      <fieldset class="imp-sec"><legend>Zamawiający (zleceniodawca MXT)</legend>
        ${field('kl-id', 'Klient z ewidencji', custSel('kl-id', kl.id, '+ Nowy klient (dane poniżej)'))}
        <div class="kl-new"${kl.id ? ' hidden' : ''}>${field('kl-n', 'Nazwa', `<input id="kl-n" name="kl_name" maxlength="200" value="${esc(kl.name || '')}">`)}
          <div class="field-row">${field('kl-t', 'NIP', `<input id="kl-t" name="kl_tax" maxlength="20" value="${esc(kl.tax_id || '')}">`)}${field('kl-a', 'Adres', `<input id="kl-a" name="kl_addr" maxlength="400" value="${esc(kl.address || '')}">`)}</div></div></fieldset>
      <fieldset class="imp-sec"><legend>Inwestor / właściciel budynków (opcjonalnie)</legend>
        ${field('in-id', 'Klient z ewidencji', custSel('in-id', inv && inv.id, '+ Nowy (nazwa poniżej) / brak'))}
        <div class="in-new"${inv && inv.id ? ' hidden' : ''}>${field('in-n', 'Nazwa (np. spółdzielnia mieszkaniowa)', `<input id="in-n" name="in_name" maxlength="200" value="${esc(inv && !inv.id ? inv.name : '')}">`)}</div></fieldset>
      <fieldset class="imp-sec"><legend>Kontrakt</legend>
        ${field('kt-m', 'Kontrakt', `<select id="kt-m" name="kt_mode"><option value="new">Utwórz nowy kontrakt (dane poniżej)</option>${opt(kt.filter(x => !['anulowany', 'rozliczony'].includes(x.status)), '', x => 'Istniejący: ' + x.number + ' – ' + x.title, x => x.id)}<option value="">Bez kontraktu</option></select>`)}
        <div class="kt-new">${field('kt-t', 'Nazwa kontraktu', `<input id="kt-t" name="kt_title" maxlength="200" value="${esc(k.title || '')}">`)}
          <div class="field-row">${field('kt-v', 'Wartość netto (zł)', `<input id="kt-v" name="kt_value" type="number" min="0" step="0.01" value="${esc(k.value_net == null ? '' : k.value_net)}">`)}
            ${field('kt-s', 'Od', `<input id="kt-s" name="kt_start" type="date" value="${esc(k.start_date || '')}">`)}${field('kt-e', 'Do', `<input id="kt-e" name="kt_end" type="date" value="${esc(k.end_date || '')}">`)}</div>
          ${field('kt-u', 'Warunki z dokumentu (umowa, stawki, kary, obowiązki)', `<textarea id="kt-u" name="kt_notes" rows="5" maxlength="4000">${esc(k.notes || '')}</textarea>`)}</div></fieldset>
      <fieldset class="imp-sec"><legend>Montaże w harmonogramie</legend><div id="obj-list"></div>
        <button type="button" class="btn btn-secondary btn-sm" id="obj-add">+ Dodaj kolejny montaż</button></fieldset>`,
    { submit: 'Zapisz kontrakt i montaże', wide: true, onSubmit: async f => {
      const rowsEl = [...f.querySelectorAll('.obj-row')];
      const q = (el, n) => (el.querySelector(`[name=${n}]`) || {}).value || '';
      const body = {
        klient: val(f, 'kl-id') ? { id: val(f, 'kl-id') } : (val(f, 'kl_name').trim() ? { name: val(f, 'kl_name'), tax_id: val(f, 'kl_tax'), address: val(f, 'kl_addr') } : null),
        inwestor: val(f, 'in-id') ? { id: val(f, 'in-id') } : (val(f, 'in_name').trim() ? { name: val(f, 'in_name'), kind: 'spoldzielnia' } : null),
        kontrakt: val(f, 'kt_mode') === 'new' ? { utworz: true, title: val(f, 'kt_title'), value_net: val(f, 'kt_value'), start_date: val(f, 'kt_start') || null, end_date: val(f, 'kt_end') || null, notes: val(f, 'kt_notes') }
          : val(f, 'kt_mode') ? { id: val(f, 'kt_mode') } : {},
        obiekty: rowsEl.map(el => ({ building_id: q(el, 'o_building') || null, name: q(el, 'o_name'), address: q(el, 'o_address'), city: q(el, 'o_city'), units_count: q(el, 'o_units'),
          planned_date: q(el, 'o_from'), planned_end: q(el, 'o_to') || null, devices_planned: q(el, 'o_devices'), crew_id: q(el, 'o_crew') || null, scope: q(el, 'o_scope') }))
      };
      if (val(f, 'kt_mode') === 'new' && !body.kontrakt.title.trim()) throw new Error('Podaj nazwę kontraktu.');
      const res = await api('d1/import/dokument/' + r.id + '/zatwierdz', body);
      toast(`Zapisano${res.project_number ? ' kontrakt ' + res.project_number : ''}${res.installations.length ? ' i montaże: ' + res.installations.join(', ') : ''}. Dokument dołączony.`); reload();
    } });
    const box = window.document.getElementById('modal-box');
    const list = box.querySelector('#obj-list');
    const sync = () => { objects = [...list.querySelectorAll('.obj-row')].map(el => Object.fromEntries([...el.querySelectorAll('[name]')].map(x => [x.name, x.value]))).map(v => ({
      building_id: v.o_building, name: v.o_name, address: v.o_address, city: v.o_city, units_count: v.o_units, planned_date: v.o_from, planned_end: v.o_to, devices_planned: v.o_devices, crew_id: v.o_crew, scope: v.o_scope })); };
    const draw = () => {
      list.innerHTML = objects.map((o, i) => objRow(o, i, bs, crews)).join('') || '<p class="muted small">Bez montaży – zapisze się sam kontrakt z dokumentem.</p>';
      list.querySelectorAll('[name=o_building]').forEach(s => s.addEventListener('change', () => { s.closest('.obj-row').querySelector('.obj-new').hidden = !!s.value; }));
      list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { sync(); objects.splice(Number(b.dataset.del), 1); draw(); }));
    };
    draw();
    box.querySelector('#obj-add').addEventListener('click', () => { sync(); const last = objects[objects.length - 1] || {}; objects.push({ planned_date: last.planned_date, planned_end: last.planned_end, scope: last.scope }); draw(); });
    box.querySelector('#kl-id').addEventListener('change', e => { box.querySelector('.kl-new').hidden = !!e.target.value; });
    box.querySelector('#in-id').addEventListener('change', e => { box.querySelector('.in-new').hidden = !!e.target.value; });
    box.querySelector('#kt-m').addEventListener('change', e => { box.querySelector('.kt-new').hidden = e.target.value !== 'new'; });
  }

  window.MXT_IMPORT = { excel, document: document_ };
})();
