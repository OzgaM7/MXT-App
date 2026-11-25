'use strict';
// Role i uprawnienia MXT Business OS. Jedyne źródło prawdy dla backendu:
// każde chronione żądanie przechodzi przez requirePerm(), a odmowa trafia do audit_logs.
// Konto ma rolę główną (users.role) i może mieć role dodatkowe (users.extra_roles) – uprawnienia się sumują.
const { audit } = require('./audit');

const ROLES = {
  administrator: 'Administrator',
  wlasciciel: 'Właściciel',
  uzytkownik: 'Pracownik biura',
  kierownik: 'Kierownik',
  rozliczajacy: 'Osoba rozliczająca',
  ksiegowosc: 'Księgowość',
  magazynier: 'Magazynier',
  monter: 'Monter',
  serwisant: 'Serwisant',
  odczyty: 'Obsługa odczytów',
  ograniczony: 'Dostęp ograniczony'
};
// Role, które można nadać jako dodatkowe (administrator i „dostęp ograniczony” są tylko rolą główną).
const EXTRA_ROLES = ['wlasciciel', 'uzytkownik', 'kierownik', 'rozliczajacy', 'ksiegowosc', 'magazynier', 'monter', 'serwisant', 'odczyty'];
// Biuro: praca w działach. Właściciel ma wgląd we wszystko (działy, finanse, analityka), bez administrowania systemem.
const OFFICE = ['administrator', 'wlasciciel', 'uzytkownik', 'kierownik', 'rozliczajacy'];
const MANAGERS = ['administrator', 'wlasciciel', 'kierownik'];
const FINANCE = ['administrator', 'wlasciciel', 'ksiegowosc', 'rozliczajacy', 'kierownik'];

const PERMISSIONS = {
  'departments.view':  { label: 'Dostęp do wszystkich działów', roles: [...OFFICE, 'ksiegowosc'] },
  'tasks.use':         { label: 'Zlecanie zadań i praca z modułami działów', roles: [...OFFICE, 'ksiegowosc'] },
  'command.view':      { label: 'Command Center i AI Board (podgląd)', roles: OFFICE },
  'approvals.request': { label: 'Zgłaszanie operacji do akceptacji', roles: [...OFFICE, 'ksiegowosc', 'magazynier'] },
  'export.xlsx':       { label: 'Eksport danych do Excela', roles: [...OFFICE, 'ksiegowosc', 'magazynier'] },
  'search.global':     { label: 'Wyszukiwanie w całym systemie (wyniki tylko z dostępnych modułów)', roles: [...OFFICE, 'ksiegowosc', 'magazynier', 'serwisant', 'odczyty'] },
  'owner.dashboard':   { label: 'Dashboard właściciela: wynik firmy, działy, należności, alerty', roles: ['administrator', 'wlasciciel'] },
  'customers.delete':  { label: 'Klienci: usuwanie bez historii i anonimizacja danych (RODO)', roles: MANAGERS },
  'finance.view':      { label: 'Finanse firmy: należności, zobowiązania, przepływy, raporty działów', roles: FINANCE },
  'employees.manage':  { label: 'Pracownicy: kartoteka, dostępność, obciążenie, czas pracy zespołu', roles: MANAGERS },
  'time.own':          { label: 'Ewidencja własnego czasu pracy', roles: [...OFFICE, 'ksiegowosc', 'magazynier', 'monter', 'serwisant', 'odczyty'] },
  'field.own':         { label: 'Moje montaże: tylko montaże własnej ekipy, bez finansów', roles: ['monter'] },
  'service.manage':    { label: 'Zlecenia serwisowe: przyjmowanie, przydzielanie serwisantów, terminy', roles: OFFICE },
  'service.approve':   { label: 'Zatwierdzanie wykonanych zleceń serwisowych', roles: MANAGERS },
  'service.own':       { label: 'Moje serwisy: tylko zlecenia przypisane do serwisanta', roles: ['serwisant'] },
  'readings.manage':   { label: 'Odczyty: obiekty, klienci, terminy i rejestrowanie wykonania (bez finansów)', roles: [...OFFICE, 'odczyty'] },
  'readings.admin':    { label: 'Odczyty: domyślne wyprzedzenie przypomnień, cofanie wpisów', roles: MANAGERS },
  'stock.view':        { label: 'Magazyn: stany, ruchy, rezerwacje (podgląd)', roles: [...OFFICE, 'ksiegowosc', 'magazynier'] },
  'stock.manage':      { label: 'Magazyn: przyjęcia, wydania, przesunięcia, inwentaryzacja', roles: ['administrator', 'kierownik', 'magazynier'] },
  'purchases.manage':  { label: 'Zakupy: dostawcy i zamówienia zakupu', roles: ['administrator', 'wlasciciel', 'kierownik', 'magazynier'] },
  'insurance.manage':  { label: 'Ubezpieczenia: rejestr podpisanych polis i przypomnienia', roles: ['administrator', 'wlasciciel', 'uzytkownik', 'kierownik'] },
  'parts.sell':        { label: 'Sprzedaż części: zamówienia, sprzedaż, zwroty', roles: [...OFFICE, 'magazynier'] },
  'board.convene':     { label: 'Zwoływanie posiedzeń AI Board', roles: ['administrator'] },
  'approvals.decide':  { label: 'Zatwierdzanie decyzji w Approval Center', roles: ['administrator'] },
  'finance.cancel':    { label: 'Anulowanie wpisów finansowych (z powodem, wpis trafia do archiwum)', roles: ['administrator'] },
  'users.manage':      { label: 'Konta pracowników: zakładanie, role, dezaktywacja, reset hasła', roles: ['administrator'] },
  'ai.settings':       { label: 'Ustawienia Agentów AI i Zarządu AI', roles: ['administrator'] },
  'security.audit':    { label: 'Security & Audit, wyłącznik wszystkich agentów', roles: ['administrator', 'wlasciciel'] },
  'training.admin':    { label: 'Panel administratora platformy szkoleniowej', roles: ['administrator'] },
  'automations.manage': { label: 'Automatyzacje, dzienny raport zarządu, integracje (n8n, poczta)', roles: ['administrator'] }
};

const rolesOf = user => !user ? [] : [...new Set([user.role, ...(Array.isArray(user.extra_roles) ? user.extra_roles : [])].filter(Boolean))];
const can = (user, perm) => !!user && user.type !== 'agent' && !!PERMISSIONS[perm] && rolesOf(user).some(r => PERMISSIONS[perm].roles.includes(r));
const permsOf = user => Object.keys(PERMISSIONS).filter(p => can(user, p));

// Middleware: 403 + wpis w audit_logs, gdy brak uprawnienia.
const requirePerm = perm => async (req, res, next) => {
  if (can(req.user, perm)) return next();
  try {
    await audit(req, 'odmowa_dostepu', { status: 'odmowa', resource: req.method + ' ' + req.originalUrl.split('?')[0], details: { uprawnienie: perm } });
  } catch (e) { console.error('audit', e); }
  res.status(403).json({ error: 'Brak uprawnień do tej operacji.' });
};

module.exports = { ROLES, EXTRA_ROLES, PERMISSIONS, rolesOf, can, permsOf, requirePerm };
