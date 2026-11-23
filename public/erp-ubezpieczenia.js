'use strict';
// Dział Ubezpieczenia – rejestr podpisanych polis: pulpit, polisy, do odnowienia, przypomnienia, klienci.
// Zysk = kwota polisy × marża % / 100 – podgląd liczony na bieżąco w formularzu, zapisywany i przeliczany przez serwer (baza).
(() => {
  const U = () => window.MXT_UI;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b), has = p => U().has(p);
  const fd = v => U().fd(v), fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const pln = n => n == null ? '–' : U().money(n, 'PLN');
  const PATH = '/dzial/ubezpieczenia';
  const ST_CLS = { aktywna: 'ok', konczy_sie: 'warn', zakonczona: 'off', odnowiona: 'zatwierdzona' };
  const ST = { aktywna: 'Aktywna', konczy_sie: 'Zbliża się koniec', zakonczona: 'Zakończona', odnowiona: 'Odnowiona' };
  const TABS = [['pulpit', 'Pulpit', '', 'Pulpit'], ['polisy', 'Polisy', '', 'Polisy'], ['odnowienia', 'Polisy do odnowienia', '', 'Odnowienia'], ['przypomnienia', 'Przypomnienia', '', 'Przypomn.'], ['klienci', 'Klienci', '', 'Klienci']];
  const IC_EXTRA = { odnowienia: 'odczyty', przypomnienia: 'czas', klienci: 'ekipy', polisy: 'rozliczenia', pulpit: 'pulpit' };
  const td = (label, html, cls) => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;
  const ctable = (head, rows, empty) => rows.length ? `<div class="table-wrap"><table class="table table-cards"><thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${esc(h.t || h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty-inline">${esc(empty)}</p>`;
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const plusYear = s => { const d = new Date(s + 'T12:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  const pct = v => v == null ? '–' : String(Math.round(Number(v) * 100) / 100).replace('.', ',') + '%';
  const days = n => n === 1 ? '1 dzień' : n + ' dni';
  let tab = 'pulpit';
  const st = { q: '', status: '', towarzystwo: '', rodzaj: '', od: '', do: '', sort: '', klient: '', klient_name: '' };
  const pst = { od: '', do: '', towarzystwo: '', rodzaj: '' };

  // Podgląd zysku: arytmetyka całkowita (grosze, marża × 10 000) – ten sam wynik co serwer i baza.
  function previewProfit(amount, margin) {
    const sc = (v, k) => { const s = String(v || '').trim().replace(/\s/g, '').replace(',', '.'); if (!/^\d+(\.\d+)?$/.test(s)) return null; const [i, f = ''] = s.split('.'); if (f.length > k && /[1-9]/.test(f.slice(k))) return null; return BigInt(i) * 10n ** BigInt(k) + BigInt((f + '0'.repeat(k)).slice(0, k) || '0'); };
    const a = sc(amount, 2), m = sc(margin, 4);
    if (a == null || m == null || m > 1000000n) return null;
    return Number((a * m + 500000n) / 1000000n) / 100;
  }

  async function page(root, path, alive) {
    const sp = new URLSearchParams(location.search);
    if (sp.get('tab') && TABS.some(t => t[0] === sp.get('tab'))) tab = sp.get('tab');
    const body = U().deptFrame(root, 'Ubezpieczenia', TABS, tab, t => { tab = t; reload(); });
    const reload = () => U().render(path, root);
    const panel = document.createElement('div'); panel.className = 'mod-body';
    await ({ pulpit, polisy, odnowienia, przypomnienia, klienci }[tab])(panel, reload, alive);
    if (!alive()) return;
    body.replaceChildren(panel); U().wsHoist(root);
    // „Dodaj polisę” w nagłówku na każdej zakładce (najczęstsza operacja).
    const acts = root.querySelector('.ws-actions'), add = document.createElement('button');
    add.type = 'button'; add.className = 'btn btn-primary ws-fab'; add.id = 'pol-new'; add.innerHTML = U().icon('plus') + 'Dodaj polisę';
    add.addEventListener('click', () => policyForm(null, reload)); acts.append(add);
    if (location.search) history.replaceState({}, '', location.pathname);
    if (sp.get('p')) policyCard(sp.get('p'), reload);
    api('polisy/podsumowanie').then(s => { U().wsBadge(root, 'odnowienia', s.do_odnowienia, 'warn'); U().wsBadge(root, 'przypomnienia', s.przypomnienia_nowe, 'danger'); }).catch(() => {});
    void IC_EXTRA;
  }

  // ---------- pulpit ----------
  async function pulpit(body, reload, alive) {
    const [s, dict] = await Promise.all([api('polisy/podsumowanie?' + new URLSearchParams(Object.entries(pst).filter(([, v]) => v))), api('polisy/slowniki')]);
    if (!alive()) return;
    const tile = (label, v, foot, tone, act) => `<${act ? `button type="button" class="hk hk-btn" ${act}` : 'div class="hk"'}><span class="hk-l">${esc(label)}</span><span class="hk-v${v && v !== '0,00 zł' ? '' : ' hk-zero'}">${esc(v)}</span>${foot ? (tone ? `<span class="hk-tag hk-${tone}">${esc(foot)}</span>` : `<span class="hk-f">${esc(foot)}</span>`) : ''}</${act ? 'button' : 'div'}>`;
    const filtered = Object.values(pst).some(Boolean);
    body.innerHTML = `<p data-ws-sub>${filtered ? 'Wybrany okres i filtry' : 'Wszystkie polisy w rejestrze'} · kwota polis i zysk MXT pokazane osobno</p>
      <form class="toolbar" id="pd"><label class="small muted" for="pd-od">Podpisane od</label><input id="pd-od" name="od" type="date" class="select-sm" value="${esc(pst.od)}">
        <label class="small muted" for="pd-do">do</label><input id="pd-do" name="do" type="date" class="select-sm" value="${esc(pst.do)}">
        <label class="visually-hidden" for="pd-t">Towarzystwo</label><select id="pd-t" name="towarzystwo" class="select-sm"><option value="">Wszystkie towarzystwa</option>${dict.insurers.map(i => `<option${pst.towarzystwo === i ? ' selected' : ''}>${esc(i)}</option>`).join('')}</select>
        <label class="visually-hidden" for="pd-r">Rodzaj</label><select id="pd-r" name="rodzaj" class="select-sm"><option value="">Każdy rodzaj</option>${dict.types.map(i => `<option${pst.rodzaj === i ? ' selected' : ''}>${esc(i)}</option>`).join('')}</select>
        <button type="submit" class="btn btn-secondary btn-sm">Pokaż</button>${filtered ? '<button type="button" class="btn btn-ghost btn-sm" id="pd-x">Wyczyść</button>' : ''}</form>
      <section class="hm-kpis" aria-label="Polisy">
        ${tile('Podpisane polisy', String(s.liczba), `aktywne: ${s.aktywne}`, '')}
        ${tile('Kwota polis (łącznie)', pln(s.kwota), 'wartość u towarzystw – nie przychód MXT', '')}
        ${tile('Zysk MXT', pln(s.zysk), 'z marży', 'ok')}
        ${tile('Średnia kwota polisy', pln(s.srednia_kwota), '', '')}
        ${tile('Średnia marża', pct(s.srednia_marza), s.marza_wazona != null ? 'ważona kwotą: ' + pct(s.marza_wazona) : '', '')}
        ${tile('Kończą się w 30 dni', String(s.konczy_30_wszystkie), s.konczy_30_wszystkie ? 'do odnowienia' : '', 'warn', s.konczy_30_wszystkie ? 'data-go-tab="odnowienia"' : '')}
        ${tile('Przypomnienia do obsłużenia', String(s.przypomnienia_nowe), '', s.przypomnienia_nowe ? 'danger' : '', s.przypomnienia_nowe ? 'data-go-tab="przypomnienia"' : '')}
      </section>
      <div class="pu-grid">
        <section class="panel"><h2 class="panel-title">Towarzystwa</h2>${ctable(['Towarzystwo', { t: 'Polisy', num: 1 }, { t: 'Kwota polis', num: 1 }, { t: 'Zysk', num: 1 }], s.by_insurer.map(x => `<tr>${td('Towarzystwo', esc(x.k))}${td('Polisy', esc(x.n), 'num')}${td('Kwota polis', esc(pln(x.kwota)), 'num')}${td('Zysk', `<b>${esc(pln(x.zysk))}</b>`, 'num')}</tr>`), 'Brak polis.')}</section>
        <section class="panel"><h2 class="panel-title">Rodzaje ubezpieczeń</h2>${ctable(['Rodzaj', { t: 'Polisy', num: 1 }, { t: 'Kwota polis', num: 1 }, { t: 'Zysk', num: 1 }], s.by_type.map(x => `<tr>${td('Rodzaj', esc(x.k))}${td('Polisy', esc(x.n), 'num')}${td('Kwota polis', esc(pln(x.kwota)), 'num')}${td('Zysk', `<b>${esc(pln(x.zysk))}</b>`, 'num')}</tr>`), 'Brak polis.')}</section>
      </div>
      <section class="panel"><h2 class="panel-title">Ostatnie 12 miesięcy (data podpisania)</h2>${ctable(['Miesiąc', { t: 'Polisy', num: 1 }, { t: 'Kwota polis', num: 1 }, { t: 'Zysk', num: 1 }], s.months.map(x => `<tr>${td('Miesiąc', esc(x.m))}${td('Polisy', esc(x.n), 'num')}${td('Kwota polis', esc(pln(x.kwota)), 'num')}${td('Zysk', `<b>${esc(pln(x.zysk))}</b>`, 'num')}</tr>`), 'Brak polis w ostatnich 12 miesiącach.')}
        <p class="muted small">${esc(s.uwaga)}</p></section>`;
    body.querySelector('#pd').addEventListener('submit', e => { e.preventDefault(); const f = e.target; Object.assign(pst, { od: val(f, 'od'), do: val(f, 'do'), towarzystwo: val(f, 'towarzystwo'), rodzaj: val(f, 'rodzaj') }); reload(); });
    const x = body.querySelector('#pd-x'); if (x) x.addEventListener('click', () => { for (const k of Object.keys(pst)) pst[k] = ''; reload(); });
    body.querySelectorAll('[data-go-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.goTab; reload(); }));
  }

  // ---------- lista polis ----------
  const row = (p, actions) => `<tr class="${p.status === 'konczy_sie' && p.days_left <= 7 ? 'row-deny' : ''}">
    ${td('Polisa', `<button type="button" class="linkish" data-p="${esc(p.id)}">${esc(p.number)}</button><div class="muted small">${esc(p.insurer)}</div>`)}
    ${td('Klient', `${esc(p.customer_name)}${p.customer_phone ? `<div class="muted small">${esc(p.customer_phone)}</div>` : ''}`)}
    ${td('Rodzaj', esc(p.insurance_type))}
    ${td('Ochrona', `${esc(fd(p.start_date))} – ${esc(fd(p.end_date))}${p.status === 'konczy_sie' ? `<div class="small txt-warn">zostało ${esc(days(p.days_left))}</div>` : p.status === 'zakonczona' && p.days_left < 0 && !p.closed_at ? `<div class="small txt-danger">${esc(days(-p.days_left))} po końcu</div>` : ''}`)}
    ${td('Kwota polisy', esc(pln(p.total_amount)), 'num')}${td('Marża', esc(pct(p.margin_pct)), 'num')}${td('Zysk', `<b>${esc(pln(p.profit))}</b>`, 'num')}
    ${td('Status', chip(ST_CLS[p.status], ST[p.status]))}${actions ? td('', actions(p), 'td-actions') : ''}</tr>`;
  async function polisy(body, reload, alive) {
    const q = new URLSearchParams(Object.entries(st).filter(([k, v]) => v && k !== 'klient_name'));
    const [list, dict] = await Promise.all([api('polisy?' + q), api('polisy/slowniki')]);
    if (!alive()) return;
    const sum = list.reduce((a, p) => ({ k: a.k + p.total_amount, z: a.z + p.profit }), { k: 0, z: 0 });
    const sel = (id, k, label, o) => `<label class="visually-hidden" for="${id}">${label}</label><select id="${id}" class="select-sm" name="${k}">${o.map(([v, t]) => `<option value="${esc(v)}"${st[k] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    body.innerHTML = `<p data-ws-sub>${list.length} polis · kwota ${esc(pln(sum.k))} · zysk MXT ${esc(pln(sum.z))}${st.klient_name ? ' · klient: ' + esc(st.klient_name) : ''}</p>
      <form class="toolbar" id="lf"><label class="visually-hidden" for="lq">Szukaj</label><input id="lq" name="q" class="select-sm" placeholder="Numer polisy, klient, towarzystwo, opis" value="${esc(st.q)}">
        ${sel('ls', 'status', 'Status', [['', 'Każdy status'], ...Object.entries(ST)])}
        ${sel('lt', 'towarzystwo', 'Towarzystwo', [['', 'Wszystkie towarzystwa'], ...dict.insurers.map(i => [i, i])])}
        ${sel('lr', 'rodzaj', 'Rodzaj', [['', 'Każdy rodzaj'], ...dict.types.map(i => [i, i])])}
        <label class="small muted" for="lod">Podpisane od</label><input id="lod" name="od" type="date" class="select-sm" value="${esc(st.od)}"><label class="small muted" for="ldo">do</label><input id="ldo" name="do" type="date" class="select-sm" value="${esc(st.do)}">
        ${sel('lso', 'sort', 'Sortowanie', [['', 'Najnowsze'], ['koniec', 'Koniec ochrony'], ['kwota', 'Kwota'], ['klient', 'Klient']])}
        <button type="submit" class="btn btn-secondary btn-sm">Szukaj</button>${st.klient ? '<button type="button" class="btn btn-ghost btn-sm" id="lk-x">Wszyscy klienci</button>' : ''}<div class="pol-sv"></div></form>
      <section class="panel">${ctable(['Polisa', 'Klient', 'Rodzaj', 'Ochrona', { t: 'Kwota polisy', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Zysk', num: 1 }, 'Status'], list.map(p => row(p)), 'Brak polis dla wybranych filtrów. Dodaj polisę przyciskiem „Dodaj polisę”.')}</section>`;
    body.querySelector('#lf').addEventListener('submit', e => { e.preventDefault(); const f = e.target; for (const k of ['q', 'status', 'towarzystwo', 'rodzaj', 'od', 'do', 'sort']) st[k] = val(f, k).trim(); reload(); });
    const kx = body.querySelector('#lk-x'); if (kx) kx.addEventListener('click', () => { st.klient = ''; st.klient_name = ''; reload(); });
    U().savedViews(body.querySelector('.pol-sv'), 'polisy', () => ({ ...st }), p => { for (const k of Object.keys(st)) st[k] = typeof p[k] === 'string' ? p[k] : ''; reload(); });
    body.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => policyCard(b.dataset.p, reload)));
  }

  // ---------- do odnowienia ----------
  async function odnowienia(body, reload, alive) {
    const list = await api('polisy/do-odnowienia');
    if (!alive()) return;
    body.innerHTML = `<p data-ws-sub>${list.filter(p => p.status === 'konczy_sie').length} kończą się w ciągu 30 dni · ${list.filter(p => p.status === 'zakonczona').length} zakończone w ostatnich 30 dniach bez odnowienia</p>
      <section class="panel">${ctable(['Polisa', 'Klient', 'Rodzaj', 'Ochrona', { t: 'Kwota polisy', num: 1 }, { t: 'Marża', num: 1 }, { t: 'Zysk', num: 1 }, 'Status', ''], list.map(p => row(p, x => `<button type="button" class="btn btn-primary btn-sm" data-renew="${esc(x.id)}">Odnów</button><button type="button" class="btn btn-ghost btn-sm" data-end="${esc(x.id)}">Klient nie odnawia</button>`)),
        'Brak polis do odnowienia w najbliższych 30 dniach.')}</section>
      <p class="muted small">Odnowienie: nowa polisa z danymi poprzedniej (klient, towarzystwo, rodzaj, opis); po zapisie poprzednia polisa jest oznaczona jako odnowiona. Przypomnienie powstaje automatycznie 30 dni przed końcem ochrony.</p>`;
    body.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => policyCard(b.dataset.p, reload)));
    body.querySelectorAll('[data-renew]').forEach(b => b.addEventListener('click', () => policyForm(null, reload, list.find(p => p.id === b.dataset.renew))));
    body.querySelectorAll('[data-end]').forEach(b => b.addEventListener('click', () => endForm(list.find(p => p.id === b.dataset.end), reload)));
  }
  const endForm = (p, after) => modal('Zakończ polisę ' + p.number, `<p>Polisa zostanie oznaczona jako zakończona (bez odnowienia). Przypomnienia o niej zostaną zamknięte.</p>${field('ef-r', 'Powód', '<input id="ef-r" name="r" required maxlength="500" placeholder="np. klient przeszedł do innego agenta, sprzedał pojazd">')}`,
    { submit: 'Oznacz jako zakończoną', danger: true, onSubmit: async f => { await api('polisy/' + p.id + '/zakoncz', { powod: val(f, 'r') }); toast('Polisa oznaczona jako zakończona.'); after(); } });

  // ---------- przypomnienia ----------
  async function przypomnienia(body, reload, alive) {
    const list = await api('polisy/przypomnienia');
    if (!alive()) return;
    const open = list.filter(r => !r.handled_at).length;
    body.innerHTML = `<p data-ws-sub>${open} do obsłużenia · historia wszystkich wygenerowanych przypomnień</p>
      <section class="panel">${ctable(['Wygenerowano', 'Polisa', 'Klient', 'Koniec ochrony', { t: 'Dni (w dniu przyp.)', num: 1 }, { t: 'Odbiorcy', num: 1 }, 'Stan', ''], list.map(r => `<tr class="${r.handled_at ? 'row-off' : ''}">
        ${td('Wygenerowano', esc(fdt(r.generated_at)) + (String(r.generated_on).slice(0, 10) > String(r.due_date).slice(0, 10) ? '<div class="small muted">nadrobione po przerwie</div>' : ''))}
        ${td('Polisa', `<button type="button" class="linkish" data-p="${esc(r.policy_id)}">${esc(r.number)}</button><div class="muted small">${esc(r.insurer)} · ${esc(r.insurance_type)}</div>`)}
        ${td('Klient', esc(r.customer_name))}${td('Koniec ochrony', esc(fd(r.end_date)))}${td('Dni', esc(r.days_left), 'num')}${td('Odbiorcy', esc(r.recipients), 'num')}
        ${td('Stan', r.handled_at ? `${chip('ok', 'obsłużone')}<div class="small muted">${esc(r.handled_by_name || 'automatycznie')} · ${esc(fdt(r.handled_at))}${r.handled_note ? ' · ' + esc(r.handled_note) : ''}</div>` : chip('warn', 'do obsłużenia'))}
        ${td('', r.handled_at ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-h="${esc(r.id)}">Obsłużone</button>`, 'td-actions')}</tr>`), 'Brak przypomnień. Powstają automatycznie 30 dni przed końcem ochrony.')}</section>`;
    body.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => policyCard(b.dataset.p, reload)));
    body.querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => modal('Przypomnienie obsłużone', field('ph-n', 'Notatka (opcjonalnie)', '<input id="ph-n" name="n" maxlength="500" placeholder="np. klient umówiony, oferta wysłana, klient rezygnuje">'),
      { submit: 'Oznacz jako obsłużone', onSubmit: async f => { await api('polisy/przypomnienia/' + b.dataset.h + '/obsluz', { notatka: val(f, 'n') }); toast('Przypomnienie obsłużone.'); reload(); } })));
  }

  // ---------- klienci (wspólna kartoteka CRM, z liczbą polis) ----------
  async function klienci(body, reload, alive) {
    const [list, pol] = await Promise.all([api('klienci?dzial=ubezpieczenia'), api('polisy')]);
    if (!alive()) return;
    const by = {}; for (const p of pol) (by[p.customer_id] = by[p.customer_id] || []).push(p);
    body.innerHTML = `<p data-ws-sub>${list.length} klientów z polisami lub oznaczonych w CRM jako klienci działu</p>
      <section class="panel">${ctable(['Klient', 'Kontakt', { t: 'Polisy', num: 1 }, { t: 'Aktywne', num: 1 }, { t: 'Kwota polis', num: 1 }, { t: 'Zysk', num: 1 }, ''], list.map(c => { const ps = by[c.id] || [];
        return `<tr>${td('Klient', `<button type="button" class="linkish" data-c="${esc(c.id)}">${esc(c.name)}</button>`)}${td('Kontakt', esc([c.phone, c.email].filter(Boolean).join(' · ') || '–'))}
          ${td('Polisy', esc(ps.length), 'num')}${td('Aktywne', esc(ps.filter(p => ['aktywna', 'konczy_sie'].includes(p.status)).length), 'num')}
          ${td('Kwota polis', esc(pln(ps.reduce((s, p) => s + p.total_amount, 0))), 'num')}${td('Zysk', `<b>${esc(pln(ps.reduce((s, p) => s + p.profit, 0)))}</b>`, 'num')}
          ${td('', `<button type="button" class="btn btn-ghost btn-sm" data-cp="${esc(c.id)}" data-cn="${esc(c.name)}">Polisy</button>`, 'td-actions')}</tr>`; }), 'Brak klientów. Klient powstaje w CRM przy rejestracji pierwszej polisy.')}</section>`;
    body.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => window.MXT_BIZ.customerCard(b.dataset.c, reload)));
    body.querySelectorAll('[data-cp]').forEach(b => b.addEventListener('click', () => { st.klient = b.dataset.cp; st.klient_name = b.dataset.cn; tab = 'polisy'; reload(); }));
  }

  // ---------- karta polisy ----------
  const FIELD_PL = { number: 'Numer', insurer: 'Towarzystwo', insurance_type: 'Rodzaj', description: 'Opis', signed_at: 'Podpisanie', start_date: 'Początek ochrony', end_date: 'Koniec ochrony',
    total_amount: 'Kwota polisy', margin_pct: 'Marża %', profit: 'Zysk', notes: 'Uwagi', customer_id: 'Klient', kwota: 'Kwota', marza: 'Marża', zysk: 'Zysk', renewed_by: 'Odnowiona polisą', previous: 'Poprzednia polisa' };
  const EVL = { utworzenie: 'Rejestracja', zmiana: 'Zmiana', odnowienie: 'Odnowienie', zakonczenie: 'Zakończenie', wznowienie: 'Cofnięcie zakończenia', dokument: 'Dokument', przypomnienie: 'Przypomnienie', obsluga_przypomnienia: 'Obsługa przypomnienia' };
  async function policyCard(id, after) {
    const p = await api('polisy/' + id);
    const refresh = () => { policyCard(id, after); if (after) after(); };
    const box = modal(`Polisa ${p.number}`, `<p class="muted">${chip(ST_CLS[p.status], ST[p.status])} · ${esc(p.insurer)} · ${esc(p.insurance_type)}${p.status === 'konczy_sie' ? ` · <b class="txt-warn">koniec za ${esc(days(p.days_left))}</b>` : ''}</p>
      <div class="kpis kpis-3"><div class="kpi kpi-neutral"><span class="kpi-v">${esc(pln(p.total_amount))}</span><span class="kpi-l">Kwota polisy (nie przychód MXT)</span></div>
        <div class="kpi kpi-neutral"><span class="kpi-v">${esc(pct(p.margin_pct))}</span><span class="kpi-l">Marża</span></div>
        <div class="kpi kpi-ok"><span class="kpi-v">${esc(pln(p.profit))}</span><span class="kpi-l">Zysk MXT</span></div></div>
      <dl class="kv"><dt>Klient</dt><dd><button type="button" class="linkish" id="pc-cust">${esc(p.customer_name)}</button>${p.customer_phone ? ' · ' + esc(p.customer_phone) : ''}${p.customer_email ? ' · ' + esc(p.customer_email) : ''}</dd>
        <dt>Podpisana</dt><dd>${esc(fd(p.signed_at))}</dd><dt>Ochrona</dt><dd>${esc(fd(p.start_date))} – ${esc(fd(p.end_date))}</dd>
        ${p.description ? `<dt>Opis polisy</dt><dd class="pre-wrap">${esc(p.description)}</dd>` : ''}${p.notes ? `<dt>Uwagi</dt><dd class="pre-wrap">${esc(p.notes)}</dd>` : ''}
        ${p.previous_number ? `<dt>Zastępuje</dt><dd><button type="button" class="linkish" data-p="${esc(p.previous_id)}">${esc(p.previous_number)}</button></dd>` : ''}
        ${p.renewed_by_number ? `<dt>Odnowiona polisą</dt><dd><button type="button" class="linkish" data-p="${esc(p.renewed_by)}">${esc(p.renewed_by_number)}</button></dd>` : ''}
        ${p.closed_at ? `<dt>Zakończona</dt><dd>${esc(fdt(p.closed_at))} – ${esc(p.close_reason)}</dd>` : ''}
        <dt>Dokument polisy</dt><dd>${p.document_id ? `<a class="linkish" href="/api/dokumenty/${esc(p.document_id)}/plik" target="_blank" rel="noopener">Otwórz</a> · <a class="linkish" href="/api/dokumenty/${esc(p.document_id)}/plik?pobierz=1">Pobierz</a>` : 'brak'}
          <label class="btn btn-ghost btn-sm" for="pc-file">${p.document_id ? 'Nowa wersja' : 'Załącz plik'}</label><input id="pc-file" type="file" accept="application/pdf,image/jpeg,image/png" class="visually-hidden"></dd>
        <dt>Zarejestrował</dt><dd>${esc(p.created_by_login || '–')} · ${esc(fdt(p.created_at))}</dd></dl>
      <div class="ap-actions"><button type="button" class="btn btn-primary btn-sm" id="pc-edit">Edytuj</button>
        ${!p.renewed_by && p.status !== 'odnowiona' ? '<button type="button" class="btn btn-secondary btn-sm" id="pc-renew">Odnów (nowa polisa)</button>' : ''}
        ${!p.renewed_by && p.customer_policies.some(x => !x.previous_id && x.id !== p.id) ? '<button type="button" class="btn btn-secondary btn-sm" id="pc-link">Powiąż z istniejącą polisą</button>' : ''}
        ${!p.closed_at && !p.renewed_by ? '<button type="button" class="btn btn-ghost btn-sm" id="pc-end">Oznacz jako zakończoną</button>' : ''}
        ${p.closed_at ? '<button type="button" class="btn btn-ghost btn-sm" id="pc-reopen">Cofnij zakończenie</button>' : ''}</div>
      ${p.reminders.length ? `<h3 class="panel-sub">Przypomnienia</h3><ul class="tool-list">${p.reminders.map(r => `<li>${esc(fdt(r.generated_at))} – koniec ${esc(fd(r.end_date))}, zostało ${esc(days(r.days_left))} · ${r.handled_at ? 'obsłużone' + (r.handled_note ? ': ' + esc(r.handled_note) : '') : '<b class="txt-warn">do obsłużenia</b>'}</li>`).join('')}</ul>` : ''}
      ${p.customer_policies.length ? `<h3 class="panel-sub">Inne polisy klienta</h3><ul class="tool-list">${p.customer_policies.map(x => `<li><button type="button" class="linkish" data-p="${esc(x.id)}">${esc(x.number)}</button> · ${esc(x.insurer)} · ${esc(x.insurance_type)} · do ${esc(fd(x.end_date))} ${chip(ST_CLS[x.status], ST[x.status])}</li>`).join('')}</ul>` : ''}
      <h3 class="panel-sub">Historia zmian</h3><ol class="comm">${p.events.map(e => `<li><b>${esc(EVL[e.kind] || e.kind)}</b> · ${esc(fdt(e.created_at))}${e.login ? ' · ' + esc(e.login) : ''}
        ${Object.keys(e.changes || {}).length ? `<div class="small">${Object.entries(e.changes).map(([k, v]) => `${esc(FIELD_PL[k] || k)}: ${esc(v[0] == null || v[0] === '' ? '–' : v[0])} → <b>${esc(v[1] == null || v[1] === '' ? '–' : v[1])}</b>`).join('<br>')}</div>` : ''}${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</li>`).join('')}</ol>`, { wide: true });
    const $ = s => box.querySelector(s);
    $('#pc-cust').addEventListener('click', () => window.MXT_BIZ.customerCard(p.customer_id, after));
    box.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => policyCard(b.dataset.p, after)));
    $('#pc-edit').addEventListener('click', () => policyForm(p, refresh));
    if ($('#pc-renew')) $('#pc-renew').addEventListener('click', () => policyForm(null, refresh, p));
    if ($('#pc-end')) $('#pc-end').addEventListener('click', () => endForm(p, refresh));
    if ($('#pc-reopen')) $('#pc-reopen').addEventListener('click', async () => { try { await api('polisy/' + p.id + '/wznow', {}); toast('Cofnięto zakończenie.'); refresh(); } catch (e) { toast(e.message); } });
    if ($('#pc-link')) $('#pc-link').addEventListener('click', () => modal('Powiąż odnowienie – ' + p.number, `<p class="muted">Wskaż polisę tego klienta, która zastępuje ${esc(p.number)}. Bieżąca polisa zostanie oznaczona jako odnowiona.</p>
      ${field('pl-n', 'Nowa polisa', `<select id="pl-n" name="n" required><option value="">– wybierz –</option>${p.customer_policies.filter(x => !x.previous_id).map(x => `<option value="${esc(x.id)}">${esc(x.number + ' · ' + x.insurer + ' · od ' + fd(x.start_date))}</option>`).join('')}</select>`)}`,
    { submit: 'Potwierdzam odnowienie', onSubmit: async f => { await api('polisy/' + p.id + '/odnow', { nowa_polisa: val(f, 'n') }); toast('Polisa oznaczona jako odnowiona.'); refresh(); } }));
    $('#pc-file').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 10 * 1024 * 1024) return toast('Plik jest za duży (maks. 10 MB).');
      try { await api('polisy/' + p.id + '/dokument', { plik: await window.MXT_BIZ.fileToB64(file), nazwa: file.name }); toast('Dokument polisy zapisany.'); refresh(); } catch (x) { toast(x.message); }
    });
  }

  // ---------- formularz polisy (rejestracja, edycja, odnowienie) ----------
  async function policyForm(p, after, renewOf) {
    const dict = await api('polisy/slowniki');
    const src = p || (renewOf ? { customer_id: renewOf.customer_id, customer_name: renewOf.customer_name, insurer: renewOf.insurer, insurance_type: renewOf.insurance_type, description: renewOf.description,
      start_date: addDays(String(renewOf.end_date).slice(0, 10), 1), margin_pct: renewOf.margin_pct } : {});
    const start = src.start_date ? String(src.start_date).slice(0, 10) : today();
    const title = p ? 'Edytuj polisę ' + p.number : renewOf ? 'Odnowienie polisy ' + renewOf.number : 'Nowa polisa';
    modal(title, `
      <div class="pf-cust" id="pf-cust">${p || renewOf ? `<p class="label-sm">Klient</p><p><b>${esc(src.customer_name)}</b>${p ? ' <button type="button" class="linkish" id="pf-chg">zmień klienta</button>' : ''}</p>` : ''}
        <div id="pf-pick"${p || renewOf ? ' hidden' : ''}>
          ${field('pf-q', 'Klient – szukaj w kartotece (nazwisko, firma, telefon, e-mail)', '<input id="pf-q" autocomplete="off" placeholder="np. Kowalski, 600 123 456">')}
          <div class="pf-res" id="pf-res"></div>
          <button type="button" class="linkish" id="pf-newc">+ Nowy klient</button>
          <div class="subform" id="pf-nc" hidden><div class="field-row">${field('nc-k', 'Rodzaj', '<select id="nc-k" name="nc_kind"><option value="osoba_prywatna">Osoba prywatna</option><option value="firma">Firma</option></select>')}
            ${field('nc-n', 'Imię i nazwisko lub nazwa firmy', '<input id="nc-n" name="nc_name" maxlength="200">')}</div>
            <div class="field-row">${field('nc-p', 'Telefon', '<input id="nc-p" name="nc_phone" type="tel" maxlength="50">')}${field('nc-e', 'E-mail', '<input id="nc-e" name="nc_email" type="email" maxlength="200">')}</div>
            ${field('nc-a', 'Adres', '<input id="nc-a" name="nc_address" maxlength="400">')}</div></div>
        <input type="hidden" name="customer_id" value="${esc(src.customer_id || '')}"></div>
      <div class="field-row">${field('pf-n', 'Numer polisy', `<input id="pf-n" name="number" required maxlength="60" value="${esc(p ? p.number : '')}">`)}
        ${field('pf-i', 'Towarzystwo ubezpieczeniowe', `<input id="pf-i" name="insurer" required maxlength="120" list="pf-il" value="${esc(src.insurer || '')}"><datalist id="pf-il">${dict.insurers.map(i => `<option value="${esc(i)}">`).join('')}</datalist>`)}
        ${field('pf-t', 'Rodzaj ubezpieczenia', `<input id="pf-t" name="insurance_type" required maxlength="80" list="pf-tl" value="${esc(src.insurance_type || '')}"><datalist id="pf-tl">${dict.types.map(i => `<option value="${esc(i)}">`).join('')}</datalist>`)}</div>
      ${field('pf-d', 'Opis polisy (zakres, przedmiot ubezpieczenia, szczegóły)', `<textarea id="pf-d" name="description" rows="3" maxlength="4000">${esc(src.description || '')}</textarea>`)}
      <div class="field-row">${field('pf-s', 'Data podpisania', `<input id="pf-s" name="signed_at" type="date" required value="${esc(p ? String(p.signed_at).slice(0, 10) : today())}">`)}
        ${field('pf-a', 'Początek ochrony', `<input id="pf-a" name="start_date" type="date" required value="${esc(start)}">`)}
        ${field('pf-e', 'Koniec ochrony', `<input id="pf-e" name="end_date" type="date" required value="${esc(p ? String(p.end_date).slice(0, 10) : plusYear(start))}">`)}</div>
      <div class="field-row pf-money">${field('pf-k', 'Kwota całkowita polisy (zł)', `<input id="pf-k" name="total_amount" required inputmode="decimal" placeholder="np. 3000" value="${esc(p ? String(p.total_amount).replace('.', ',') : '')}">`)}
        ${field('pf-m', 'Procent marży (%)', `<input id="pf-m" name="margin_pct" required inputmode="decimal" placeholder="np. 15" value="${esc(src.margin_pct != null ? String(src.margin_pct).replace('.', ',') : '')}">`)}
        <div class="field"><span class="flabel">Zysk MXT (wyliczany)</span><output id="pf-z" class="pf-profit" aria-live="polite">–</output></div></div>
      <p class="muted small">Zysk = kwota całkowita × procent marży / 100, zaokrąglony do grosza. Kwota polisy nie jest przychodem MXT.</p>
      ${field('pf-x', 'Uwagi (opcjonalnie)', `<textarea id="pf-x" name="notes" rows="2" maxlength="4000">${esc(p ? p.notes : '')}</textarea>`)}
      ${p ? field('pf-r', 'Powód zmiany (do historii, opcjonalnie)', '<input id="pf-r" name="powod" maxlength="300">') : field('pf-f', 'Dokument polisy (PDF, JPG, PNG – opcjonalnie)', '<input id="pf-f" name="file" type="file" accept="application/pdf,image/jpeg,image/png">')}
      ${renewOf ? `<p class="notice">Po zapisie polisa ${esc(renewOf.number)} zostanie oznaczona jako <b>odnowiona</b> (zastąpiona nową).</p>` : ''}`,
    { submit: p ? 'Zapisz zmiany' : 'Zarejestruj polisę', wide: true, onSubmit: async f => {
      const b = { number: val(f, 'number'), insurer: val(f, 'insurer'), insurance_type: val(f, 'insurance_type'), description: val(f, 'description'), signed_at: val(f, 'signed_at'),
        start_date: val(f, 'start_date'), end_date: val(f, 'end_date'), total_amount: val(f, 'total_amount'), margin_pct: val(f, 'margin_pct'), notes: val(f, 'notes') };
      const cid = val(f, 'customer_id');
      if (p) {
        if (cid && cid !== p.customer_id) b.customer_id = cid;
        b.powod_zmiany = val(f, 'powod');
        await api('polisy/' + p.id, b, 'PATCH'); toast('Polisa zapisana.'); after(); return;
      }
      if (cid) b.customer_id = cid;
      else if (!f.querySelector('#pf-nc').hidden) b.new_customer = { kind: val(f, 'nc_kind'), name: val(f, 'nc_name'), phone: val(f, 'nc_phone'), email: val(f, 'nc_email'), address: val(f, 'nc_address') };
      else throw new Error('Wybierz klienta z kartoteki albo dodaj nowego klienta.');
      if (renewOf) b.odnawia = renewOf.id;
      const x = await api('polisy', b);
      const file = f.elements.file && f.elements.file.files[0];
      if (file) {
        try { await api('polisy/' + x.id + '/dokument', { plik: await window.MXT_BIZ.fileToB64(file), nazwa: file.name }); }
        catch (e) { toast('Polisa zapisana, ale dokument nie: ' + e.message); after(); return; }
      }
      toast(`Polisa ${x.number} zarejestrowana · zysk ${pln(x.profit)}.`); after();
    } });
    const box = document.getElementById('modal-box'), $ = s => box.querySelector(s);
    const z = $('#pf-z'), calc = () => { const v = previewProfit($('#pf-k').value, $('#pf-m').value); z.textContent = v == null ? '–' : pln(v); z.classList.toggle('pf-bad', v == null && !!($('#pf-k').value && $('#pf-m').value)); };
    $('#pf-k').addEventListener('input', calc); $('#pf-m').addEventListener('input', calc); calc();
    $('#pf-a').addEventListener('change', () => { if (!p && $('#pf-a').value) $('#pf-e').value = plusYear($('#pf-a').value); });
    // Wybór klienta z kartoteki (wyszukiwanie na bieżąco) albo nowy klient.
    const pick = $('#pf-pick'), hid = box.querySelector('[name="customer_id"]'), res = $('#pf-res');
    if ($('#pf-chg')) $('#pf-chg').addEventListener('click', () => { pick.hidden = false; $('#pf-q').focus(); });
    let t = null;
    $('#pf-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
      const q = $('#pf-q').value.trim(); if (q.length < 2) { res.innerHTML = ''; return; }
      const list = await api('klienci?q=' + encodeURIComponent(q)).catch(() => []);
      res.innerHTML = list.slice(0, 8).map(c => `<button type="button" class="pop-i" data-cid="${esc(c.id)}" data-cname="${esc(c.name)}">${esc(c.name)}<span class="muted small"> ${esc([c.phone, c.email].filter(Boolean).join(' · '))}</span></button>`).join('') || '<p class="muted small">Brak klienta – dodaj nowego.</p>';
      res.querySelectorAll('[data-cid]').forEach(b => b.addEventListener('click', () => { hid.value = b.dataset.cid; $('#pf-q').value = b.dataset.cname; res.innerHTML = `<p class="small txt-ok">Wybrano: <b>${esc(b.dataset.cname)}</b></p>`; $('#pf-nc').hidden = true; }));
    }, 200); });
    $('#pf-newc').addEventListener('click', () => { $('#pf-nc').hidden = false; hid.value = ''; res.innerHTML = ''; $('#nc-n').value = $('#pf-q').value; $('#nc-n').focus(); });
  }

  window.MXT_POLISY = { policyCard, policyForm, previewProfit };
  window.MXT_MODULES.register(PATH, { title: 'Ubezpieczenia', perm: 'insurance.manage', render: page });
})();
