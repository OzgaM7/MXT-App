'use strict';
// Role i uprawnienia MXT Business OS. Jedyne źródło prawdy dla backendu:
// każde chronione żądanie przechodzi przez requirePerm(), a odmowa trafia do audit_logs.
// Konto ma rolę główną (users.role) i może mieć role dodatkowe (users.extra_roles) – uprawnienia się sumują.
const { audit } = require('./audit');

const ROLES = {
  administrator: 'Administrator',
  uzytkownik: 'Pracownik biura',
  kierownik: 'Kierownik',
  rozliczajacy: 'Osoba rozliczająca',
  monter: 'Monter'
};
// Role, które można nadać jako dodatkowe (administrator jest zawsze rolą główną).
const EXTRA_ROLES = ['uzytkownik', 'kierownik', 'rozliczajacy', 'monter'];
const OFFICE = ['administrator', 'uzytkownik', 'kierownik', 'rozliczajacy'];

const PERMISSIONS = {
  'departments.view':  { label: 'Dostęp do wszystkich działów', roles: OFFICE },
  'tasks.use':         { label: 'Zlecanie zadań i praca z modułami działów', roles: OFFICE },
  'command.view':      { label: 'Command Center i AI Board (podgląd)', roles: OFFICE },
  'approvals.request': { label: 'Zgłaszanie operacji do akceptacji', roles: OFFICE },
  'export.xlsx':       { label: 'Eksport danych do Excela', roles: OFFICE },
  'field.own':         { label: 'Moje montaże: tylko montaże własnej ekipy, bez finansów', roles: ['monter'] },
  'board.convene':     { label: 'Zwoływanie posiedzeń AI Board', roles: ['administrator'] },
  'approvals.decide':  { label: 'Zatwierdzanie decyzji w Approval Center', roles: ['administrator'] },
  'finance.cancel':    { label: 'Anulowanie wpisów finansowych (z powodem, wpis trafia do archiwum)', roles: ['administrator'] },
  'users.manage':      { label: 'Konta pracowników: zakładanie, role, dezaktywacja, reset hasła', roles: ['administrator'] },
  'ai.settings':       { label: 'Ustawienia Agentów AI i Zarządu AI', roles: ['administrator'] },
  'security.audit':    { label: 'Security & Audit, wyłącznik wszystkich agentów', roles: ['administrator'] },
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
