'use strict';
// Role i uprawnienia MXT Business OS. Jedyne źródło prawdy dla backendu:
// każde chronione żądanie przechodzi przez requirePerm(), a odmowa trafia do audit_logs.
const { audit } = require('./audit');

const ROLES = { administrator: 'Administrator', uzytkownik: 'Użytkownik' };

const PERMISSIONS = {
  'departments.view':  { label: 'Dostęp do wszystkich działów', roles: ['administrator', 'uzytkownik'] },
  'tasks.use':         { label: 'Zlecanie zadań i praca z modułami działów', roles: ['administrator', 'uzytkownik'] },
  'command.view':      { label: 'Command Center i AI Board (podgląd)', roles: ['administrator', 'uzytkownik'] },
  'approvals.request': { label: 'Zgłaszanie operacji do akceptacji', roles: ['administrator', 'uzytkownik'] },
  'board.convene':     { label: 'Zwoływanie posiedzeń AI Board', roles: ['administrator'] },
  'approvals.decide':  { label: 'Zatwierdzanie decyzji w Approval Center', roles: ['administrator'] },
  'ai.settings':       { label: 'Ustawienia Agentów AI i Zarządu AI', roles: ['administrator'] },
  'security.audit':    { label: 'Security & Audit, wyłącznik wszystkich agentów', roles: ['administrator'] },
  'training.admin':    { label: 'Panel administratora platformy szkoleniowej', roles: ['administrator'] },
  'automations.manage': { label: 'Automatyzacje, dzienny raport zarządu, integracje (n8n, poczta)', roles: ['administrator'] }
};

const can = (user, perm) => !!user && user.type !== 'agent' && !!PERMISSIONS[perm] && PERMISSIONS[perm].roles.includes(user.role);
const permsOf = user => Object.keys(PERMISSIONS).filter(p => can(user, p));

// Middleware: 403 + wpis w audit_logs, gdy brak uprawnienia.
const requirePerm = perm => async (req, res, next) => {
  if (can(req.user, perm)) return next();
  try {
    await audit(req, 'odmowa_dostepu', { status: 'odmowa', resource: req.method + ' ' + req.originalUrl.split('?')[0], details: { uprawnienie: perm } });
  } catch (e) { console.error('audit', e); }
  res.status(403).json({ error: 'Brak uprawnień do tej operacji.' });
};

module.exports = { ROLES, PERMISSIONS, can, permsOf, requirePerm };
