'use strict';
// Zasięg danych pracowników terenowych: monter widzi wyłącznie montaże ekipy, do której jest przypisany jako instalator.
// Jedno miejsce z regułą – używają go trasy „Moje montaże” i powiadomienia o przydziałach.
const { pool } = require('../db');

// Ekipy konta (aktywny instalator powiązany z kontem).
async function crewsOfUser(userId, client = pool) {
  const q = await client.query('SELECT crew_id FROM installers WHERE user_id = $1 AND is_active AND crew_id IS NOT NULL', [userId]);
  return q.rows.map(r => r.crew_id);
}
// Konta aktywnych instalatorów ekipy (odbiorcy powiadomień o przydziałach).
async function usersOfCrew(crewId, client = pool) {
  if (!crewId) return [];
  const q = await client.query(`SELECT i.user_id FROM installers i JOIN users u ON u.id = i.user_id
    WHERE i.crew_id = $1 AND i.is_active AND u.is_active`, [crewId]);
  return q.rows.map(r => r.user_id);
}

module.exports = { crewsOfUser, usersOfCrew };
