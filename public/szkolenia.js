'use strict';
// Dział 3 – Ubezpieczenia: wyłącznie Platforma Szkoleniowa (kursy, lekcje, testy, postęp, zaświadczenia, panel administratora).
(() => {
  const U = () => window.MXT_UI, B = () => window.MXT_BIZ;
  const esc = v => U().esc(v), api = (...a) => U().api(...a), toast = m => U().toast(m), chip = (a, b) => U().chip(a, b);
  const fdt = v => U().fdt(v), field = (...a) => U().field(...a), val = (f, n) => U().val(f, n), modal = (...a) => U().modal(...a);
  const PATH = '/dzial/ubezpieczenia';
  const KIND = { tekst: 'Tekst', pdf: 'PDF', wideo: 'Wideo' };
  let view = { mode: 'kursy' };   // kursy | kurs | lekcja | test | admin | edytor | postep
  const bar = p => `<div class="bar bar-lg" aria-hidden="true"><i data-w="${Number(p) || 0}"></i></div>`;

  async function page(root, path, alive) {
    const admin = U().has('training.admin');
    const tabs = [['kursy', 'Moje kursy'], ...(admin ? [['admin', 'Panel administratora'], ['postep', 'Postęp pracowników']] : [])];
    const active = ['kurs', 'lekcja', 'test'].includes(view.mode) ? 'kursy' : view.mode === 'edytor' ? 'admin' : view.mode;
    const body = U().deptFrame(root, 'Ubezpieczenia', tabs, active, t => { view = { mode: t }; reload(); }, 'Platforma szkoleniowa: kursy, lekcje, testy wiedzy i zaświadczenia.');
    const reload = () => U().render(path, root);
    await ({ kursy, kurs, lekcja, test, admin: adminPanel, edytor, postep }[view.mode])(body, reload, alive);
  }
  const go = (v, reload) => { view = v; reload(); };

  // ---------- uczestnik ----------
  async function kursy(body, reload, alive) {
    const list = await api('szkolenia/kursy');
    if (!alive()) return;
    body.innerHTML = list.length ? `<div class="wf-grid">${list.map(c => `<article class="panel course">
        <div class="panel-head"><h2 class="panel-title">${esc(c.title)}</h2>${c.is_published ? '' : chip('off', 'Nieopublikowany')}</div>
        <p class="small muted">${esc(c.description || '')}</p>
        <p class="small">${esc(c.progress.done)}/${esc(c.progress.lessons)} lekcji · testy ${esc(c.progress.passed)}/${esc(c.progress.quizzes)} · <b>${esc(c.progress.pct)}%</b></p>${bar(c.progress.pct)}
        <div class="ap-actions"><button type="button" class="btn btn-primary btn-sm" data-c="${c.id}">${c.progress.pct ? 'Kontynuuj' : 'Rozpocznij'}</button>
          ${c.progress.complete ? `<a class="btn btn-secondary btn-sm" href="/api/szkolenia/kursy/${esc(c.id)}/zaswiadczenie" target="_blank" rel="noopener">Zaświadczenie PDF</a>` : ''}</div></article>`).join('')}</div>`
      : '<section class="panel"><p class="empty-inline">Brak opublikowanych kursów. Kursy dodaje administrator w panelu administratora.</p></section>';
    body.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => go({ mode: 'kurs', id: b.dataset.c }, reload)));
  }
  async function kurs(body, reload, alive) {
    const c = await api('szkolenia/kursy/' + view.id);
    if (!alive()) return;
    const quizRow = q => `<li class="lesson"><button type="button" class="lesson-b" data-q="${q.id}"><span class="ls-ic ${q.result && q.result.passed ? 'done' : ''}" aria-hidden="true">${q.result && q.result.passed ? '✓' : '?'}</span>
      <span><b>Test: ${esc(q.title)}</b><span class="muted small">${esc(q.questions.length)} pytań · próg ${esc(q.pass_pct)}%${q.result ? ` · najlepszy wynik ${esc(q.result.best)}% (${esc(q.result.attempts)} podejść)` : ''}</span></span></button></li>`;
    body.innerHTML = `<div><button type="button" class="linkish" data-back>← Moje kursy</button></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">${esc(c.title)}</h2><span class="small"><b>${esc(c.progress.pct)}%</b> ukończenia</span></div>${bar(c.progress.pct)}
        ${c.description ? `<p class="muted">${esc(c.description)}</p>` : ''}
        ${c.progress.complete ? `<p class="notice notice-live">Kurs ukończony. <a href="/api/szkolenia/kursy/${esc(c.id)}/zaswiadczenie" target="_blank" rel="noopener">Pobierz zaświadczenie (PDF)</a></p>`
          : `<p class="muted small">Zaświadczenie będzie dostępne po ukończeniu wszystkich lekcji i zaliczeniu testów.</p>`}</section>
      ${c.modules.map((m, i) => `<section class="panel"><h2 class="panel-title">Moduł ${i + 1}: ${esc(m.title)}</h2><ol class="lessons">
        ${m.lessons.map(l => `<li class="lesson"><button type="button" class="lesson-b" data-l="${l.id}"><span class="ls-ic ${l.done ? 'done' : ''}" aria-hidden="true">${l.done ? '✓' : ''}</span>
          <span><b>${esc(l.title)}</b><span class="muted small">${esc(KIND[l.kind])}${l.duration_min ? ' · ' + esc(l.duration_min) + ' min' : ''}${l.done ? ' · ukończona' : ''}</span></span></button></li>`).join('')}
        ${m.quizzes.map(quizRow).join('')}</ol>${!m.lessons.length && !m.quizzes.length ? '<p class="empty-inline">Moduł jest pusty.</p>' : ''}</section>`).join('')}
      ${c.quizzes.length ? `<section class="panel"><h2 class="panel-title">Test końcowy</h2><ol class="lessons">${c.quizzes.map(quizRow).join('')}</ol></section>` : ''}`;
    body.querySelector('[data-back]').addEventListener('click', () => go({ mode: 'kursy' }, reload));
    const all = c.modules.flatMap(m => m.lessons), quizzes = [...c.modules.flatMap(m => m.quizzes), ...c.quizzes];
    body.querySelectorAll('[data-l]').forEach(b => b.addEventListener('click', () => go({ mode: 'lekcja', id: c.id, course: c, lesson: all.find(l => l.id === b.dataset.l) }, reload)));
    body.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => go({ mode: 'test', id: c.id, course: c, quiz: quizzes.find(q => q.id === b.dataset.q) }, reload)));
  }
  async function lekcja(body, reload) {
    const l = view.lesson, c = view.course, all = c.modules.flatMap(m => m.lessons), i = all.findIndex(x => x.id === l.id), next = all[i + 1];
    let media = '';
    if (l.kind === 'pdf' && l.document_id) media = `<div class="pdf-frame"><iframe src="/api/dokumenty/${esc(l.document_id)}/plik" title="${esc(l.title)}"></iframe></div><p class="small">${B().pdfLink('/api/dokumenty/' + l.document_id + '/plik', 'Otwórz PDF w nowej karcie')}</p>`;
    if (l.kind === 'wideo' && l.embed) media = l.embed.type === 'iframe' ? `<div class="video"><iframe src="${esc(l.embed.src)}" title="${esc(l.title)}" allow="fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
      : l.embed.type === 'video' ? `<video class="video-el" src="${esc(l.embed.src)}" controls preload="metadata"></video>` : `<p><a class="btn btn-secondary" href="${esc(l.embed.src)}" target="_blank" rel="noopener">Otwórz wideo</a></p>`;
    body.innerHTML = `<div><button type="button" class="linkish" data-back>← ${esc(c.title)}</button></div>
      <article class="panel lesson-view"><p class="eyebrow">${esc(KIND[l.kind])}${l.duration_min ? ' · ' + esc(l.duration_min) + ' min' : ''}</p><h2 class="mod-title">${esc(l.title)}</h2>
        ${media}${l.content ? `<div class="ai-text lesson-text">${esc(l.content)}</div>` : ''}
        <div class="ap-actions">${l.done ? chip('ok', 'Lekcja ukończona') : '<button type="button" class="btn btn-primary" id="done">Oznacz jako ukończoną</button>'}
          ${next ? `<button type="button" class="btn btn-secondary" id="next">Następna lekcja: ${esc(next.title)}</button>` : ''}</div></article>`;
    body.querySelector('[data-back]').addEventListener('click', () => go({ mode: 'kurs', id: c.id }, reload));
    const d = body.querySelector('#done');
    if (d) d.addEventListener('click', async () => { await api('szkolenia/lekcje/' + l.id + '/ukonczona', {}); l.done = true; toast('Lekcja ukończona.'); next ? go({ ...view, lesson: next }, reload) : go({ mode: 'kurs', id: c.id }, reload); });
    const n = body.querySelector('#next'); if (n) n.addEventListener('click', () => go({ ...view, lesson: next }, reload));
  }
  async function test(body, reload) {
    const q = view.quiz, c = view.course;
    body.innerHTML = `<div><button type="button" class="linkish" data-back>← ${esc(c.title)}</button></div>
      <form class="panel quiz" id="qz"><p class="eyebrow">Test wiedzy · próg zaliczenia ${esc(q.pass_pct)}%</p><h2 class="mod-title">${esc(q.title)}</h2>
        <ol class="qs">${q.questions.map((x, i) => `<li><fieldset><legend><b>${i + 1}. ${esc(x.pytanie)}</b></legend>${x.odpowiedzi.map((a, j) => `<label class="opt"><input type="radio" name="q${i}" value="${j}" required> <span>${esc(a)}</span></label>`).join('')}</fieldset><p class="q-fb" id="fb${i}" hidden></p></li>`).join('')}</ol>
        <p class="form-error" hidden></p><div class="ap-actions"><button type="submit" class="btn btn-primary">Sprawdź odpowiedzi</button></div><div id="qr"></div></form>`;
    body.querySelector('[data-back]').addEventListener('click', () => go({ mode: 'kurs', id: c.id }, reload));
    const f = body.querySelector('#qz');
    f.addEventListener('submit', async e => {
      e.preventDefault(); const err = f.querySelector('.form-error'); err.hidden = true;
      const answers = q.questions.map((_, i) => { const x = f.querySelector(`[name=q${i}]:checked`); return x ? Number(x.value) : null; });
      if (answers.some(a => a === null)) { err.textContent = 'Odpowiedz na wszystkie pytania.'; err.hidden = false; return; }
      const r = await api('szkolenia/testy/' + q.id + '/podejscie', { answers });
      r.review.forEach((x, i) => { const fb = f.querySelector('#fb' + i); fb.hidden = false; fb.className = 'q-fb ' + (x.ok ? 'txt-ok' : 'txt-danger'); fb.textContent = x.ok ? 'Poprawnie' : 'Niepoprawnie'; });
      f.querySelector('#qr').innerHTML = `<p class="notice ${r.passed ? 'notice-live' : 'notice-error'}"><b>Wynik: ${esc(r.score_pct)}%</b> (${esc(r.correct)}/${esc(r.total)}). ${r.passed ? 'Test zaliczony.' : `Próg zaliczenia: ${esc(r.pass_pct)}%. Przejrzyj lekcje i spróbuj ponownie.`}</p>
        <div class="ap-actions"><button type="button" class="btn btn-secondary" id="again">Spróbuj ponownie</button><button type="button" class="btn btn-primary" id="tocourse">Wróć do kursu</button></div>`;
      f.querySelector('#again').addEventListener('click', () => go({ ...view }, reload));
      f.querySelector('#tocourse').addEventListener('click', () => go({ mode: 'kurs', id: c.id }, reload));
      toast(r.passed ? 'Test zaliczony.' : 'Test niezaliczony.');
    });
  }

  // ---------- panel administratora ----------
  async function adminPanel(body, reload, alive) {
    const list = await api('szkolenia/kursy');
    if (!alive()) return;
    body.innerHTML = `<div class="toolbar"><button type="button" class="btn btn-primary" id="c-new">Nowy kurs</button></div>
      <section class="panel">${B().table(['Kurs', 'Moduły', 'Status', ''], list.map(c => `<tr><td><b>${esc(c.title)}</b><div class="muted small">${esc(c.description || '')}</div></td><td class="num">${esc(c.modules)}</td>
        <td>${c.is_published ? chip('ok', 'Opublikowany') : chip('off', 'Szkic')}</td><td class="nowrap"><button type="button" class="btn btn-secondary btn-sm" data-e="${c.id}">Edytuj treść</button>
        <button type="button" class="btn btn-ghost btn-sm" data-p="${c.id}">${c.is_published ? 'Wycofaj publikację' : 'Opublikuj'}</button></td></tr>`), 'Brak kursów. Utwórz pierwszy kurs.')}</section>`;
    body.querySelector('#c-new').addEventListener('click', () => modal('Nowy kurs', field('n-t', 'Tytuł kursu', '<input id="n-t" name="title" required maxlength="200">') + field('n-d', 'Opis', '<textarea id="n-d" name="description" rows="3"></textarea>'),
      { submit: 'Utwórz kurs', onSubmit: async f => { const c = await api('szkolenia/admin/kursy', { title: val(f, 'title'), description: val(f, 'description') }); toast('Kurs utworzony.'); go({ mode: 'edytor', id: c.id }, reload); } }));
    body.querySelectorAll('[data-e]').forEach(b => b.addEventListener('click', () => go({ mode: 'edytor', id: b.dataset.e }, reload)));
    body.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', async () => { const c = list.find(x => x.id === b.dataset.p); await api('szkolenia/admin/kursy/' + c.id, { is_published: !c.is_published }, 'PATCH'); toast(c.is_published ? 'Publikacja wycofana.' : 'Kurs opublikowany.'); reload(); }));
  }
  function lessonForm(moduleId, l, reload) {
    modal(l ? 'Edytuj lekcję' : 'Nowa lekcja', `${field('l-t', 'Tytuł', `<input id="l-t" name="title" required maxlength="200" value="${esc(l ? l.title : '')}">`)}
      <div class="field-row">${field('l-k', 'Rodzaj', `<select id="l-k" name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${l && l.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${field('l-dur', 'Czas (min)', `<input id="l-dur" name="duration_min" type="number" min="0" value="${esc(l ? l.duration_min : '')}">`)}${field('l-s', 'Kolejność', `<input id="l-s" name="sort_order" type="number" min="0" value="${esc(l ? l.sort_order : 0)}">`)}</div>
      ${field('l-c', 'Treść lekcji / opis', `<textarea id="l-c" name="content" rows="8">${esc(l ? l.content : '')}</textarea>`)}
      ${field('l-v', 'Adres wideo (https – YouTube, Vimeo lub plik .mp4)', `<input id="l-v" name="video_url" maxlength="500" value="${esc(l && l.video_url ? l.video_url : '')}">`)}
      ${field('l-f', l && l.document_id ? 'Nowy plik PDF (zastąpi obecny)' : 'Plik PDF (dla lekcji PDF, do 10 MB)', '<input id="l-f" name="file" type="file" accept="application/pdf">')}`,
    { submit: l ? 'Zapisz' : 'Dodaj lekcję', wide: true, onSubmit: async f => {
      const file = f.elements.file.files[0];
      if (file && file.size > 10 * 1024 * 1024) throw new Error('Plik jest większy niż 10 MB.');
      const b = { title: val(f, 'title'), kind: val(f, 'kind'), duration_min: val(f, 'duration_min'), sort_order: val(f, 'sort_order'), content: val(f, 'content'), video_url: val(f, 'video_url'), ...(file ? { file_base64: await B().fileToB64(file), file_name: file.name } : {}) };
      l ? await api('szkolenia/admin/lekcje/' + l.id, b, 'PATCH') : await api('szkolenia/admin/lekcje', { ...b, module_id: moduleId });
      toast('Lekcja zapisana.'); reload();
    } });
  }
  function quizForm(courseId, moduleId, q, reload) {
    const qRow = (x = { pytanie: '', odpowiedzi: ['', ''], poprawna: 0 }, i) => `<fieldset class="qe" data-qi><legend class="flabel">Pytanie</legend><input name="pytanie" maxlength="1000" value="${esc(x.pytanie)}" required aria-label="Treść pytania">
      <div class="qe-a">${x.odpowiedzi.map((a, j) => `<label class="opt"><input type="radio" name="ok${i}" value="${j}"${x.poprawna === j ? ' checked' : ''} aria-label="Poprawna odpowiedź"><input name="odp" maxlength="500" value="${esc(a)}" aria-label="Odpowiedź ${j + 1}"></label>`).join('')}</div>
      <div class="ap-actions"><button type="button" class="btn btn-ghost btn-sm" data-addopt>Dodaj odpowiedź</button><button type="button" class="btn btn-ghost btn-sm" data-rmq>Usuń pytanie</button></div></fieldset>`;
    let n = 0;
    const box = modal(q ? 'Edytuj test' : 'Nowy test', `<div class="field-row">${field('q-t', 'Tytuł testu', `<input id="q-t" name="title" required maxlength="200" value="${esc(q ? q.title : '')}">`)}
      ${field('q-p', 'Próg zaliczenia %', `<input id="q-p" name="pass_pct" type="number" min="1" max="100" value="${esc(q ? q.pass_pct : 70)}">`)}</div>
      <p class="muted small">Zaznacz poprawną odpowiedź przy każdym pytaniu. Poprawne odpowiedzi nie są wysyłane do uczestników – test ocenia serwer.</p>
      <div id="qs">${(q ? q.questions : [undefined]).map(x => qRow(x, n++)).join('')}</div><button type="button" class="btn btn-secondary btn-sm" id="q-add">Dodaj pytanie</button>`,
    { submit: q ? 'Zapisz test' : 'Dodaj test', wide: true, onSubmit: async f => {
      const questions = [...f.querySelectorAll('[data-qi]')].map(fs => { const odp = [...fs.querySelectorAll('[name=odp]')].map(i => i.value); const ok = fs.querySelector('input[type=radio]:checked');
        return { pytanie: fs.querySelector('[name=pytanie]').value, odpowiedzi: odp, poprawna: ok ? Number(ok.value) : -1 }; });
      const b = { title: val(f, 'title'), pass_pct: val(f, 'pass_pct'), questions };
      q ? await api('szkolenia/admin/testy/' + q.id, b, 'PATCH') : await api('szkolenia/admin/testy', { ...b, course_id: courseId, module_id: moduleId });
      toast('Test zapisany.'); reload();
    } });
    const qs = box.querySelector('#qs');
    const bind = () => { qs.querySelectorAll('[data-addopt]').forEach(b => b.onclick = () => { const fs = b.closest('[data-qi]'), wrap = fs.querySelector('.qe-a'), j = wrap.children.length, name = fs.querySelector('input[type=radio]').name;
        wrap.insertAdjacentHTML('beforeend', `<label class="opt"><input type="radio" name="${name}" value="${j}" aria-label="Poprawna odpowiedź"><input name="odp" maxlength="500" aria-label="Odpowiedź ${j + 1}"></label>`); });
      qs.querySelectorAll('[data-rmq]').forEach(b => b.onclick = () => { if (qs.children.length > 1) b.closest('[data-qi]').remove(); }); };
    box.querySelector('#q-add').addEventListener('click', () => { qs.insertAdjacentHTML('beforeend', qRow(undefined, n++)); bind(); });
    bind();
  }
  async function edytor(body, reload, alive) {
    const c = await api('szkolenia/kursy/' + view.id + '?edycja=1');
    if (!alive()) return;
    const quizLi = q => `<li class="ed-item"><span>Test: <b>${esc(q.title)}</b> <span class="muted small">${esc(q.questions.length)} pytań · próg ${esc(q.pass_pct)}%</span></span>
      <span><button type="button" class="btn btn-ghost btn-sm" data-eq="${q.id}">Edytuj</button><button type="button" class="btn btn-ghost btn-sm txt-danger" data-dq="${q.id}">Usuń</button></span></li>`;
    body.innerHTML = `<div><button type="button" class="linkish" data-back>← Panel administratora</button></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">${esc(c.title)}</h2>${c.is_published ? chip('ok', 'Opublikowany') : chip('off', 'Szkic')}</div>
        <div class="ap-actions"><button type="button" class="btn btn-secondary btn-sm" id="ce">Edytuj tytuł i opis</button><button type="button" class="btn btn-secondary btn-sm" id="cm">Dodaj moduł</button>
          <button type="button" class="btn btn-secondary btn-sm" id="cq">Dodaj test końcowy</button><button type="button" class="btn btn-ghost btn-sm txt-danger" id="cd">Usuń kurs</button></div></section>
      ${c.modules.map((m, i) => `<section class="panel"><div class="panel-head"><h2 class="panel-title">Moduł ${i + 1}: ${esc(m.title)}</h2>
          <span><button type="button" class="btn btn-ghost btn-sm" data-ml="${m.id}">Dodaj lekcję</button><button type="button" class="btn btn-ghost btn-sm" data-mq="${m.id}">Dodaj test</button><button type="button" class="btn btn-ghost btn-sm txt-danger" data-md="${m.id}">Usuń moduł</button></span></div>
        <ul class="ed-list">${m.lessons.map(l => `<li class="ed-item"><span><b>${esc(l.title)}</b> <span class="muted small">${esc(KIND[l.kind])}${l.file_name ? ' · ' + esc(l.file_name) : ''}${l.video_url ? ' · ' + esc(l.video_url) : ''}</span></span>
          <span><button type="button" class="btn btn-ghost btn-sm" data-el="${l.id}" data-m="${m.id}">Edytuj</button><button type="button" class="btn btn-ghost btn-sm txt-danger" data-dl="${l.id}">Usuń</button></span></li>`).join('')}${m.quizzes.map(quizLi).join('')}</ul>
        ${!m.lessons.length && !m.quizzes.length ? '<p class="empty-inline">Dodaj pierwszą lekcję modułu.</p>' : ''}</section>`).join('')}
      ${c.quizzes.length ? `<section class="panel"><h2 class="panel-title">Testy końcowe</h2><ul class="ed-list">${c.quizzes.map(quizLi).join('')}</ul></section>` : ''}`;
    const allQ = [...c.modules.flatMap(m => m.quizzes), ...c.quizzes], allL = c.modules.flatMap(m => m.lessons);
    const confirmDel = (what, url) => modal('Usunąć ' + what + '?', '<p>Tej operacji nie można cofnąć. Postęp uczestników powiązany z tym elementem zostanie usunięty.</p>', { submit: 'Usuń', danger: true, onSubmit: async () => { await api(url, null, 'DELETE'); toast('Usunięto.'); reload(); } });
    body.querySelector('[data-back]').addEventListener('click', () => go({ mode: 'admin' }, reload));
    body.querySelector('#ce').addEventListener('click', () => modal('Kurs', field('e-t', 'Tytuł', `<input id="e-t" name="title" required maxlength="200" value="${esc(c.title)}">`) + field('e-d', 'Opis', `<textarea id="e-d" name="description" rows="3">${esc(c.description)}</textarea>`),
      { submit: 'Zapisz', onSubmit: async f => { await api('szkolenia/admin/kursy/' + c.id, { title: val(f, 'title'), description: val(f, 'description') }, 'PATCH'); toast('Zapisano.'); reload(); } }));
    body.querySelector('#cm').addEventListener('click', () => modal('Nowy moduł', field('m-t', 'Tytuł modułu', '<input id="m-t" name="title" required maxlength="200">'),
      { submit: 'Dodaj moduł', onSubmit: async f => { await api('szkolenia/admin/moduly', { course_id: c.id, title: val(f, 'title'), sort_order: c.modules.length }); toast('Moduł dodany.'); reload(); } }));
    body.querySelector('#cq').addEventListener('click', () => quizForm(c.id, null, null, reload));
    body.querySelector('#cd').addEventListener('click', () => modal('Usunąć kurs „' + c.title + '”?', '<p>Zostaną usunięte moduły, lekcje, testy i postęp uczestników.</p>', { submit: 'Usuń kurs', danger: true, onSubmit: async () => { await api('szkolenia/admin/kursy/' + c.id, null, 'DELETE'); toast('Kurs usunięty.'); go({ mode: 'admin' }, reload); } }));
    body.querySelectorAll('[data-ml]').forEach(b => b.addEventListener('click', () => lessonForm(b.dataset.ml, null, reload)));
    body.querySelectorAll('[data-mq]').forEach(b => b.addEventListener('click', () => quizForm(c.id, b.dataset.mq, null, reload)));
    body.querySelectorAll('[data-md]').forEach(b => b.addEventListener('click', () => confirmDel('moduł', 'szkolenia/admin/moduly/' + b.dataset.md)));
    body.querySelectorAll('[data-el]').forEach(b => b.addEventListener('click', () => lessonForm(b.dataset.m, allL.find(l => l.id === b.dataset.el), reload)));
    body.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => confirmDel('lekcję', 'szkolenia/admin/lekcje/' + b.dataset.dl)));
    body.querySelectorAll('[data-eq]').forEach(b => b.addEventListener('click', () => quizForm(c.id, null, allQ.find(q => q.id === b.dataset.eq), reload)));
    body.querySelectorAll('[data-dq]').forEach(b => b.addEventListener('click', () => confirmDel('test', 'szkolenia/admin/testy/' + b.dataset.dq)));
  }
  async function postep(body, reload, alive) {
    const p = await api('szkolenia/admin/postep');
    if (!alive()) return;
    body.innerHTML = `<section class="panel"><h2 class="panel-title">Postęp pracowników</h2>
      ${p.courses.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Pracownik</th>${p.courses.map(c => `<th>${esc(c.title)}${c.is_published ? '' : ' (szkic)'}</th>`).join('')}</tr></thead><tbody>
      ${p.users.map(u => `<tr><td><b>${esc(u.login)}</b></td>${u.courses.map(c => `<td><div class="small">${esc(c.pct)}% · lekcje ${esc(c.done)}/${esc(c.lessons)} · testy ${esc(c.passed)}/${esc(c.quizzes)}</div>${bar(c.pct)}${c.certificate ? `<div class="small txt-ok">Zaświadczenie ${esc(c.certificate.number)}</div>` : ''}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>` : '<p class="empty-inline">Brak kursów.</p>'}<p class="muted small">Postęp szkoleń śledzi także COO (Zarząd AI) przez narzędzie „postęp szkoleń”.</p></section>`;
  }

  window.MXT_MODULES.register(PATH, { title: 'Ubezpieczenia – Platforma Szkoleniowa', perm: 'departments.view', render: page });
})();
