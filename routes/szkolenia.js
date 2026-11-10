'use strict';
// Dział 3 – Ubezpieczenia: wyłącznie Platforma Szkoleniowa. Kursy → moduły → lekcje (tekst, PDF, wideo), testy z progiem
// zaliczenia, postęp, zaświadczenie PDF. Panel administratora (training.admin) do zarządzania treścią i podglądu postępów.
const express = require('express');
const { pool } = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm, can } = require('../lib/rbac');
const docs = require('../lib/docs');
const pdf = require('../lib/pdf');
const { wrap, idParam, V, bad, patchSql, sendPdf } = require('./_util');

const r = express.Router();
const use = requirePerm('tasks.use'), admin = requirePerm('training.admin');
const isAdmin = req => can(req.user, 'training.admin');

const VIDEO_OK = u => { try { const x = new URL(u); return x.protocol === 'https:'; } catch (e) { return false; } };
const embedOf = u => {
  try {
    const x = new URL(u);
    const yt = x.hostname.replace(/^www\./, '') === 'youtube.com' ? x.searchParams.get('v') : x.hostname === 'youtu.be' ? x.pathname.slice(1) : null;
    if (yt && /^[\w-]{6,20}$/.test(yt)) return { type: 'iframe', src: 'https://www.youtube-nocookie.com/embed/' + yt };
    const vm = /vimeo\.com\/(\d+)/.exec(u); if (vm) return { type: 'iframe', src: 'https://player.vimeo.com/video/' + vm[1] };
    if (/\.(mp4|webm)(\?|$)/i.test(x.pathname)) return { type: 'video', src: u };
    return { type: 'link', src: u };
  } catch (e) { return null; }
};

async function courseProgress(userId, courseIds) {
  if (!courseIds.length) return {};
  const [l, d, q, p, c] = await Promise.all([
    pool.query(`SELECT m.course_id, count(l.id)::int AS n FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = ANY($1) GROUP BY 1`, [courseIds]),
    pool.query(`SELECT m.course_id, count(*)::int AS n FROM user_progress up JOIN lessons l ON l.id = up.lesson_id JOIN modules m ON m.id = l.module_id
      WHERE up.user_id = $1 AND m.course_id = ANY($2) GROUP BY 1`, [userId, courseIds]),
    pool.query(`SELECT course_id, count(*)::int AS n FROM quizzes WHERE course_id = ANY($1) GROUP BY 1`, [courseIds]),
    pool.query(`SELECT q.course_id, count(DISTINCT q.id)::int AS n FROM quizzes q JOIN quiz_results r ON r.quiz_id = q.id AND r.user_id = $1 AND r.passed WHERE q.course_id = ANY($2) GROUP BY 1`, [userId, courseIds]),
    pool.query(`SELECT course_id, number, issued_at FROM certificates WHERE user_id = $1 AND course_id = ANY($2)`, [userId, courseIds])
  ]);
  const g = (rows, id) => (rows.find(x => x.course_id === id) || { n: 0 }).n;
  return Object.fromEntries(courseIds.map(id => {
    const lessons = g(l.rows, id), done = g(d.rows, id), quizzes = g(q.rows, id), passed = g(p.rows, id), cert = c.rows.find(x => x.course_id === id) || null;
    const total = lessons + quizzes;
    return [id, { lessons, done, quizzes, passed, pct: total ? Math.round((done + passed) / total * 100) : 0, complete: total > 0 && done === lessons && passed === quizzes, certificate: cert }];
  }));
}

// ---------- uczestnik ----------
r.get('/kursy', use, wrap(async (req, res) => {
  const q = await pool.query(`SELECT c.id, c.title, c.description, c.is_published, c.updated_at,
      (SELECT count(*)::int FROM modules m WHERE m.course_id = c.id) AS modules FROM courses c ${isAdmin(req) ? '' : 'WHERE c.is_published'} ORDER BY c.created_at`);
  const prog = await courseProgress(req.user.id, q.rows.map(x => x.id));
  res.json(q.rows.map(x => ({ ...x, progress: prog[x.id] })));
}));
r.get('/kursy/:id', idParam, use, wrap(async (req, res) => {
  const c = (await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.id])).rows[0];
  if (!c || (!c.is_published && !isAdmin(req))) throw bad(404, 'Nie znaleziono kursu.');
  const [m, l, q, done, results] = await Promise.all([
    pool.query('SELECT * FROM modules WHERE course_id = $1 ORDER BY sort_order, title', [c.id]),
    pool.query(`SELECT l.*, v.file_name FROM lessons l JOIN modules m ON m.id = l.module_id LEFT JOIN documents d ON d.id = l.document_id
      LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version WHERE m.course_id = $1 ORDER BY l.sort_order, l.title`, [c.id]),
    pool.query('SELECT * FROM quizzes WHERE course_id = $1 ORDER BY sort_order, title', [c.id]),
    pool.query(`SELECT lesson_id FROM user_progress WHERE user_id = $1`, [req.user.id]),
    pool.query(`SELECT quiz_id, max(score_pct)::int AS best, bool_or(passed) AS passed, count(*)::int AS attempts FROM quiz_results WHERE user_id = $1 GROUP BY 1`, [req.user.id])
  ]);
  const doneSet = new Set(done.rows.map(x => x.lesson_id));
  const showAnswers = isAdmin(req) && req.query.edycja === '1';
  const quiz = x => ({ id: x.id, module_id: x.module_id, title: x.title, pass_pct: x.pass_pct, sort_order: x.sort_order,
    questions: x.questions.map(qq => ({ pytanie: qq.pytanie, odpowiedzi: qq.odpowiedzi, ...(showAnswers ? { poprawna: qq.poprawna } : {}) })),
    result: results.rows.find(y => y.quiz_id === x.id) || null });
  const prog = (await courseProgress(req.user.id, [c.id]))[c.id];
  res.json({ ...c, progress: prog, modules: m.rows.map(mm => ({ ...mm,
    lessons: l.rows.filter(x => x.module_id === mm.id).map(x => ({ ...x, done: doneSet.has(x.id), embed: x.video_url ? embedOf(x.video_url) : null })),
    quizzes: q.rows.filter(x => x.module_id === mm.id).map(quiz) })),
    quizzes: q.rows.filter(x => !x.module_id).map(quiz) });
}));
r.post('/lekcje/:id/ukonczona', idParam, use, wrap(async (req, res) => {
  const l = (await pool.query(`SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = $1 AND (c.is_published OR $2)`, [req.params.id, isAdmin(req)])).rows[0];
  if (!l) throw bad(404, 'Nie znaleziono lekcji.');
  await pool.query('INSERT INTO user_progress (user_id, lesson_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, l.id]);
  res.json({ ok: true });
}));
// Ocena testu po stronie serwera (poprawne odpowiedzi nigdy nie trafiają do przeglądarki uczestnika).
r.post('/testy/:id/podejscie', idParam, use, wrap(async (req, res) => {
  const q = (await pool.query(`SELECT q.* FROM quizzes q JOIN courses c ON c.id = q.course_id WHERE q.id = $1 AND (c.is_published OR $2)`, [req.params.id, isAdmin(req)])).rows[0];
  if (!q) throw bad(404, 'Nie znaleziono testu.');
  const ans = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
  if (ans.length !== q.questions.length || ans.some(a => !Number.isInteger(a))) throw bad(400, 'Odpowiedz na wszystkie pytania.');
  const good = q.questions.reduce((s, x, i) => s + (x.poprawna === ans[i] ? 1 : 0), 0);
  const score = q.questions.length ? Math.round(good / q.questions.length * 100) : 0, passed = score >= q.pass_pct;
  await pool.query('INSERT INTO quiz_results (quiz_id, user_id, score_pct, passed, answers) VALUES ($1, $2, $3, $4, $5)', [q.id, req.user.id, score, passed, JSON.stringify(ans)]);
  await audit(req, 'szkolenia.test', { resource: 'quizzes', resourceId: q.id, details: { wynik: score, zaliczony: passed } });
  res.json({ score_pct: score, passed, pass_pct: q.pass_pct, correct: good, total: q.questions.length, review: q.questions.map((x, i) => ({ ok: x.poprawna === ans[i] })) });
}));
r.get('/kursy/:id/zaswiadczenie', idParam, use, wrap(async (req, res) => {
  const c = (await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.id])).rows[0];
  if (!c || (!c.is_published && !isAdmin(req))) throw bad(404, 'Nie znaleziono kursu.');
  const p = (await courseProgress(req.user.id, [c.id]))[c.id];
  if (!p.complete) throw bad(409, `Ukończ wszystkie lekcje (${p.done}/${p.lessons}) i zalicz testy (${p.passed}/${p.quizzes}), aby pobrać zaświadczenie.`);
  let cert = p.certificate;
  if (!cert) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const number = await docs.nextNumber(client, 'ZS');
      cert = (await client.query(`INSERT INTO certificates (number, user_id, course_id) VALUES ($1, $2, $3) ON CONFLICT (user_id, course_id) DO UPDATE SET number = certificates.number RETURNING *`, [number, req.user.id, c.id])).rows[0];
      await audit(req, 'szkolenia.zaswiadczenie', { resource: 'certificates', resourceId: cert.id, details: { kurs: c.title, numer: cert.number }, client });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }
  const best = (await pool.query(`SELECT q.title, max(r.score_pct)::int AS s FROM quizzes q JOIN quiz_results r ON r.quiz_id = q.id AND r.user_id = $1 WHERE q.course_id = $2 GROUP BY q.title`, [req.user.id, c.id])).rows;
  const buf = await pdf.certificate({ number: cert.number, person: req.user.login, course: c.title, date: cert.issued_at, lessons: p.lessons, quizSummary: best.length ? best.map(x => `${x.title} ${x.s}%`).join(', ') : 'brak testów' });
  sendPdf(res, buf, `Zaswiadczenie_${cert.number}.pdf`, req.query.pobierz !== '1');
}));

// ---------- panel administratora ----------
r.post('/admin/kursy', admin, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query('INSERT INTO courses (title, description, is_published, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [V.str(b.title, 200, true, 'Tytuł kursu'), V.str(b.description, 4000), !!b.is_published, req.user.id]);
  await audit(req, 'szkolenia.kurs_utworzenie', { resource: 'courses', resourceId: q.rows[0].id });
  res.status(201).json(q.rows[0]);
}));
r.patch('/admin/kursy/:id', idParam, admin, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.title !== undefined) f.title = V.str(b.title, 200, true, 'Tytuł kursu');
  if (b.description !== undefined) f.description = V.str(b.description, 4000);
  if (b.is_published !== undefined) f.is_published = !!b.is_published;
  const { sql, params } = patchSql('courses', req.params.id, f);
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono kursu.');
  await audit(req, 'szkolenia.kurs_zmiana', { resource: 'courses', resourceId: req.params.id, details: f });
  res.json(q.rows[0]);
}));
r.delete('/admin/kursy/:id', idParam, admin, wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM courses WHERE id = $1 RETURNING title', [req.params.id]);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono kursu.');
  await audit(req, 'szkolenia.kurs_usuniecie', { resource: 'courses', resourceId: req.params.id, details: { tytul: q.rows[0].title } });
  res.json({ ok: true });
}));
r.post('/admin/moduly', admin, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query('INSERT INTO modules (course_id, title, sort_order) VALUES ($1, $2, $3) RETURNING *', [V.uuid(b.course_id, 'Kurs', true), V.str(b.title, 200, true, 'Tytuł modułu'), V.num(b.sort_order, 0, 1000, 'Kolejność')]);
  await audit(req, 'szkolenia.modul', { resource: 'modules', resourceId: q.rows[0].id });
  res.status(201).json(q.rows[0]);
}));
r.patch('/admin/moduly/:id', idParam, admin, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.title !== undefined) f.title = V.str(b.title, 200, true, 'Tytuł modułu');
  if (b.sort_order !== undefined) f.sort_order = V.num(b.sort_order, 0, 1000, 'Kolejność');
  const { sql, params } = patchSql('modules', req.params.id, f);
  const q = await pool.query(sql, params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono modułu.');
  res.json(q.rows[0]);
}));
r.delete('/admin/moduly/:id', idParam, admin, wrap(async (req, res) => {
  await pool.query('DELETE FROM modules WHERE id = $1', [req.params.id]);
  await audit(req, 'szkolenia.modul_usuniecie', { resource: 'modules', resourceId: req.params.id });
  res.json({ ok: true });
}));
async function lessonFields(b, partial, req, client) {
  const o = {}, set = (k, fn) => { if (!partial || b[k] !== undefined) o[k] = fn(b[k]); };
  set('module_id', v => V.uuid(v, 'Moduł', true));
  set('title', v => V.str(v, 200, true, 'Tytuł lekcji'));
  set('kind', v => V.oneOf(v, ['tekst', 'pdf', 'wideo'], 'Rodzaj lekcji'));
  set('content', v => V.str(v, 100000));
  set('video_url', v => { const s = V.str(v, 500); if (s && !VIDEO_OK(s)) throw bad(400, 'Adres wideo musi zaczynać się od https://'); return s || null; });
  set('duration_min', v => V.num(v, 0, 1000, 'Czas trwania'));
  set('sort_order', v => V.num(v, 0, 1000, 'Kolejność'));
  if (b.file_base64) {
    const file = Buffer.from(String(b.file_base64), 'base64');
    if (!docs.isPdf(file)) throw bad(400, 'Materiał lekcji musi być plikiem PDF.');
    const doc = await docs.createDocument(client, { kind: 'szkolenie', title: 'Materiał: ' + (o.title || b.title || 'lekcja'), department_id: 'ubezpieczenia', userId: req.user.id });
    await docs.addVersion(client, doc.id, { file, fileName: V.str(b.file_name, 200) || 'lekcja.pdf', mime: 'application/pdf', userId: req.user.id });
    o.document_id = doc.id;
  }
  if (o.kind === 'wideo' && !o.video_url && !partial) throw bad(400, 'Podaj adres wideo (https://).');
  if (o.kind === 'pdf' && !o.document_id && !partial) throw bad(400, 'Dołącz plik PDF.');
  return o;
}
r.post('/admin/lekcje', admin, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await lessonFields(req.body || {}, false, req, client);
    const q = await client.query(`INSERT INTO lessons (module_id, title, kind, content, video_url, document_id, duration_min, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [o.module_id, o.title, o.kind, o.content, o.video_url, o.document_id || null, o.duration_min, o.sort_order]);
    await audit(req, 'szkolenia.lekcja', { resource: 'lessons', resourceId: q.rows[0].id, client });
    await client.query('COMMIT');
    res.status(201).json(q.rows[0]);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.patch('/admin/lekcje/:id', idParam, admin, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await lessonFields(req.body || {}, true, req, client); delete o.module_id;
    const { sql, params } = patchSql('lessons', req.params.id, o);
    const q = await client.query(sql, params);
    if (!q.rows[0]) throw bad(404, 'Nie znaleziono lekcji.');
    await audit(req, 'szkolenia.lekcja_zmiana', { resource: 'lessons', resourceId: req.params.id, client });
    await client.query('COMMIT');
    res.json(q.rows[0]);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
r.delete('/admin/lekcje/:id', idParam, admin, wrap(async (req, res) => {
  await pool.query('DELETE FROM lessons WHERE id = $1', [req.params.id]);
  await audit(req, 'szkolenia.lekcja_usuniecie', { resource: 'lessons', resourceId: req.params.id });
  res.json({ ok: true });
}));
function questions(v) {
  if (!Array.isArray(v) || !v.length) throw bad(400, 'Dodaj co najmniej jedno pytanie.');
  if (v.length > 100) throw bad(400, 'Najwyżej 100 pytań.');
  return v.map((q, i) => {
    const odp = (Array.isArray(q.odpowiedzi) ? q.odpowiedzi : []).map(a => V.str(a, 500)).filter(Boolean);
    if (!V.str(q.pytanie, 1000)) throw bad(400, `Pytanie ${i + 1}: wpisz treść.`);
    if (odp.length < 2 || odp.length > 8) throw bad(400, `Pytanie ${i + 1}: od 2 do 8 odpowiedzi.`);
    const ok = Number(q.poprawna);
    if (!Number.isInteger(ok) || ok < 0 || ok >= odp.length) throw bad(400, `Pytanie ${i + 1}: zaznacz poprawną odpowiedź.`);
    return { pytanie: V.str(q.pytanie, 1000), odpowiedzi: odp, poprawna: ok };
  });
}
r.post('/admin/testy', admin, wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query(`INSERT INTO quizzes (course_id, module_id, title, pass_pct, questions, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [V.uuid(b.course_id, 'Kurs', true), V.uuid(b.module_id), V.str(b.title, 200, true, 'Tytuł testu'), V.num(b.pass_pct, 1, 100, 'Próg zaliczenia', 70), JSON.stringify(questions(b.questions)), V.num(b.sort_order, 0, 1000, 'Kolejność')]);
  await audit(req, 'szkolenia.test_utworzenie', { resource: 'quizzes', resourceId: q.rows[0].id });
  res.status(201).json(q.rows[0]);
}));
r.patch('/admin/testy/:id', idParam, admin, wrap(async (req, res) => {
  const b = req.body || {}, f = {};
  if (b.title !== undefined) f.title = V.str(b.title, 200, true, 'Tytuł testu');
  if (b.pass_pct !== undefined) f.pass_pct = V.num(b.pass_pct, 1, 100, 'Próg zaliczenia');
  if (b.questions !== undefined) f.questions = JSON.stringify(questions(b.questions));
  const { sql, params } = patchSql('quizzes', req.params.id, f);
  const q = await pool.query(sql.replace('RETURNING *', 'RETURNING id'), params);
  if (!q.rows[0]) throw bad(404, 'Nie znaleziono testu.');
  await audit(req, 'szkolenia.test_zmiana', { resource: 'quizzes', resourceId: req.params.id });
  res.json(q.rows[0]);
}));
r.delete('/admin/testy/:id', idParam, admin, wrap(async (req, res) => {
  await pool.query('DELETE FROM quizzes WHERE id = $1', [req.params.id]);
  await audit(req, 'szkolenia.test_usuniecie', { resource: 'quizzes', resourceId: req.params.id });
  res.json({ ok: true });
}));
// Postęp wszystkich pracowników (panel administratora; COO śledzi go przez narzędzie postep_szkolen).
r.get('/admin/postep', admin, wrap(async (req, res) => res.json(await allProgress())));
async function allProgress() {
  const [users, courses] = await Promise.all([pool.query('SELECT id, login FROM users ORDER BY login'), pool.query('SELECT id, title, is_published FROM courses ORDER BY created_at')]);
  const out = [];
  for (const u of users.rows) {
    const p = await courseProgress(u.id, courses.rows.map(c => c.id));
    out.push({ login: u.login, courses: courses.rows.map(c => ({ course_id: c.id, title: c.title, ...p[c.id] })) });
  }
  return { courses: courses.rows, users: out };
}

module.exports = { router: r, allProgress };
