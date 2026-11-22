'use strict';
const express = require('express'), cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'),
  crypto = require('crypto'), path = require('path');
const { pool } = require('./db');
const { audit } = require('./lib/audit');
const { permsOf, rolesOf, ROLES } = require('./lib/rbac');

const PORT = +process.env.PORT || 3000;
const SESSION_DAYS = +process.env.SESSION_DAYS || 30;
const COOKIE = 'mxt_sid';
const BAD_LOGIN = 'Nieprawidłowy login lub hasło';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', +process.env.TRUST_PROXY || 0);
// Załączniki PDF (Knowledge Base, materiały szkoleniowe) przesyłane jako base64 w JSON – większy limit tylko dla tych ścieżek.
app.use(['/api/wiedza', '/api/szkolenia/admin'], express.json({ limit: '15mb' }));
// Import montaży: arkusz Excel (do 5 MB) albo umowa / harmonogram PDF, skan lub zdjęcie (do 10 MB) – przesyłane jako base64.
app.use(['/api/d1/import/excel', '/api/d1/import/dokument'], express.json({ limit: '16mb' }));
// Zdjęcia z telefonu (zmniejszone w przeglądarce) i protokół z podpisem w zleceniach serwisowych.
app.use(['/api/serwisy/:id/zdjecia', '/api/serwisy/:id/protokol', '/api/moje/serwisy/:id/zdjecia', '/api/moje/serwisy/:id/protokol'], express.json({ limit: '4mb' }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
// Ochrona przed CSRF: zapisujące żądania API muszą być JSON-em (formularz z innej strony nie ustawi tego nagłówka).
app.use('/api', (req, res, next) => {
  const hasBody = +(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  if ((['POST', 'PUT', 'PATCH'].includes(req.method) || (req.method === 'DELETE' && hasBody)) && !req.is('application/json'))
    return res.status(415).json({ error: 'Wymagany format JSON.' });
  next();
});
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
      "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com; media-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  next();
});

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const cookieOpts = () => ({
  httpOnly: true, sameSite: 'strict', path: '/',
  secure: process.env.COOKIE_SECURE === '1', maxAge: SESSION_DAYS * 864e5
});

// Limit prób logowania: 10 nieudanych w 15 minut na adres IP + login.
const tries = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of tries) if (t - v.ts > 15 * 60e3) tries.delete(k); }, 60e3).unref();
// Stały czas odpowiedzi przy nieistniejącym loginie (nie zdradza, które loginy istnieją).
const DUMMY_HASH = bcrypt.hashSync('nieistniejace-konto', 12);

async function currentUser(req) {
  const token = req.cookies[COOKIE];
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const r = await pool.query(
    `SELECT u.id, u.login, u.role, u.extra_roles, u.full_name, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`, [sha(token)]);
  return r.rows[0] || null;
}
const pub = u => ({ id: u.id, login: u.login, fullName: u.full_name || '', role: u.role, roles: rolesOf(u), roleLabels: rolesOf(u).map(r => ROLES[r] || r),
  permissions: permsOf(u), mustChangePassword: u.must_change_password });

app.post('/api/login', async (req, res, next) => {
  try {
    const login = String((req.body || {}).login || '').trim().toLowerCase().slice(0, 64);
    const password = String((req.body || {}).password || '').slice(0, 200);
    const key = req.ip + '|' + login;
    const t = tries.get(key) || { n: 0, ts: Date.now() };
    if (t.n >= 10) return res.status(429).json({ error: 'Zbyt wiele nieudanych prób. Spróbuj ponownie za kilka minut.' });

    const r = await pool.query('SELECT id, login, role, extra_roles, full_name, password_hash, must_change_password, is_active FROM users WHERE lower(login) = $1', [login]);
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) {
      t.n++; tries.set(key, t);
      await audit(req, 'logowanie', { status: 'odmowa', details: { login } });
      return res.status(401).json({ error: BAD_LOGIN });
    }
    tries.delete(key);
    // Konto wyłączone przez administratora (np. pracownik odszedł): dane zostają, logowanie zablokowane.
    if (!u.is_active) {
      await audit(req, 'logowanie', { status: 'odmowa', details: { login, powod: 'konto nieaktywne' } });
      return res.status(403).json({ error: 'Konto jest wyłączone. Skontaktuj się z administratorem.' });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
      [sha(token), u.id, SESSION_DAYS]);
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    res.cookie(COOKIE, token, cookieOpts());
    await audit({ user: u, ip: req.ip }, 'logowanie');
    res.json(pub(u));
  } catch (e) { next(e); }
});

app.get('/api/me', async (req, res, next) => {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Brak aktywnej sesji' });
    res.json(pub(u));
  } catch (e) { next(e); }
});

app.post('/api/logout', async (req, res, next) => {
  try {
    const token = req.cookies[COOKIE];
    const u = await currentUser(req);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(String(token))]);
    if (u) await audit({ user: u, ip: req.ip }, 'wylogowanie');
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- zmiana hasła (wymagana przy pierwszym logowaniu: must_change_password) ----------
const pwTries = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of pwTries) if (t - v.ts > 15 * 60e3) pwTries.delete(k); }, 60e3).unref();
app.post('/api/haslo', async (req, res, next) => {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Brak aktywnej sesji' });
    const b = req.body || {}, current = String(b.obecne || '').slice(0, 200), next_ = String(b.nowe || '');
    const t = pwTries.get(u.id) || { n: 0, ts: Date.now() };
    if (t.n >= 5) return res.status(429).json({ error: 'Zbyt wiele błędnych prób. Spróbuj ponownie za kilka minut.' });
    const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [u.id])).rows[0];
    if (!(await bcrypt.compare(current, row.password_hash))) {
      t.n++; pwTries.set(u.id, t);
      await audit({ user: u, ip: req.ip }, 'haslo.zmiana', { status: 'odmowa', details: { powod: 'błędne obecne hasło' } });
      return res.status(400).json({ error: 'Obecne hasło jest nieprawidłowe.' });
    }
    const bad = require('./lib/password').problems(next_, { login: u.login, current });
    if (bad.length) return res.status(400).json({ error: 'Nowe hasło: ' + bad.join(', ') + '.', problems: bad });
    if (b.powtorz !== undefined && b.powtorz !== next_) return res.status(400).json({ error: 'Powtórzone hasło nie zgadza się z nowym.' });
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, await bcrypt.hash(next_, 12)]);
    // Wylogowanie z pozostałych urządzeń; bieżąca sesja zostaje.
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [u.id, sha(String(req.cookies[COOKIE]))]);
    pwTries.delete(u.id);
    await audit({ user: u, ip: req.ip }, 'haslo.zmiana', { details: { pierwsze_logowanie: u.must_change_password } });
    res.json(pub({ ...u, must_change_password: false }));
  } catch (e) { next(e); }
});

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

// Integracje (n8n, skrzynka pocztowa): bez sesji, uwierzytelnianie tokenem Bearer o określonym zakresie.
app.use('/api/integracje', require('./routes/integracje'));

// Moduły MXT Business OS: każde żądanie wymaga zalogowania, uprawnienia sprawdza lib/rbac.js.
app.use('/api', async (req, res, next) => {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Brak aktywnej sesji' });
    // Konto z hasłem startowym lub zresetowanym: dostęp do modułów dopiero po ustawieniu własnego hasła.
    if (u.must_change_password) return res.status(403).json({ error: 'Najpierw ustaw nowe hasło.', code: 'must_change_password' });
    req.user = { ...u, type: 'user' };
    next();
  } catch (e) { next(e); }
});
app.use('/api', require('./routes/api'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Nie znaleziono' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) {
    if (p.endsWith('sw.js') || p.endsWith('index.html')) res.set('Cache-Control', 'no-cache');
    if (p.endsWith('.webmanifest')) res.set('Content-Type', 'application/manifest+json');
  }
}));
// Każdy inny adres (np. odświeżenie na /dzial/...) zwraca aplikację.
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Błąd serwera. Spróbuj ponownie.' });
});

app.listen(PORT, () => {
  console.log('MXT działa na http://localhost:' + PORT);
  // Kolejka zadań w tle i harmonogram (dzienny raport zarządu). WORKERS=0 wyłącza je na tej instancji.
  if (process.env.WORKERS !== '0') {
    require('./lib/mail'); require('./lib/events'); require('./lib/monitoring');
    require('./lib/jobs').start(); require('./lib/scheduler').start();
  }
});
