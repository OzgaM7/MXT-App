'use strict';
// Powiadomienia dla pracowników: zapis w aplikacji (dzwonek), push na telefon (Web Push), opcjonalnie kopia e-mail.
// Dostawę (push, e-mail) wykonuje kolejka zadań z ponawianiem, więc zapis danych nie czeka na sieć.
// dedup: ten sam klucz nie trafi do tej samej osoby drugi raz (np. przypomnienie o terminie z harmonogramu).
const webpush = require('web-push');
const { pool } = require('../db');
const jobs = require('./jobs');

const MAX = { title: 200, body: 1000 };

// --- klucze VAPID: generowane przy pierwszym użyciu i przechowywane w bazie (bez konfiguracji serwera) ---
let vapid = null;
async function vapidKeys() {
  if (vapid) return vapid;
  let row = (await pool.query(`SELECT value FROM system_settings WHERE key = 'vapid'`)).rows[0];
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(k)]);
    row = (await pool.query(`SELECT value FROM system_settings WHERE key = 'vapid'`)).rows[0];
  }
  vapid = row.value;
  return vapid;
}
// Kontakt wymagany przez usługi push (Apple, Google, Mozilla): adres aplikacji albo e-mail z konfiguracji.
const subject = () => process.env.PUSH_CONTACT || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'mailto:powiadomienia@example.com';

/**
 * Tworzy powiadomienia dla podanych kont (tylko aktywnych). Zwraca liczbę nowych powiadomień.
 * @param {string[]} userIds
 * @param {{kind:string,title:string,body?:string,link?:string,related_type?:string,related_id?:string,dedup?:string}} n
 */
async function notify(userIds, n, { client = pool } = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const link = /^\/[a-z0-9/_?=&.-]*$/.test(n.link || '') ? n.link : '';
  const q = await client.query(`INSERT INTO notifications (user_id, kind, title, body, link, related_type, related_id, dedup_key)
      SELECT u.id, $2, $3, $4, $5, $6, $7, $8 FROM users u WHERE u.id = ANY($1::uuid[]) AND u.is_active
      ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING RETURNING id`,
    [ids, n.kind, String(n.title).slice(0, MAX.title), String(n.body || '').slice(0, MAX.body), link, n.related_type || null, n.related_id || null, n.dedup || null]);
  for (const row of q.rows) await jobs.enqueue('powiadomienie', { id: row.id }, { client, maxAttempts: 4 });
  return q.rows.length;
}

// Dostawa jednego powiadomienia: push na wszystkie urządzenia konta + e-mail, jeśli konto ma to włączone.
jobs.register('powiadomienie', async ({ id }) => {
  const n = (await pool.query(`SELECT n.*, u.email, u.notify_email, u.is_active FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id = $1`, [id])).rows[0];
  if (!n || !n.is_active) return { pominieto: true };
  const out = { push: 0, push_bledy: 0, email: false };
  const subs = (await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [n.user_id])).rows;
  if (subs.length) {
    const k = await vapidKeys();
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.link || '/powiadomienia', tag: 'mxt-' + n.id });
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 24 * 3600, urgency: 'normal' });
        await pool.query('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [s.id]);
        out.push++;
      } catch (e) {
        // 404/410: urządzenie wypisało się z powiadomień (np. odinstalowana aplikacja) – subskrypcja do usunięcia.
        if (e.statusCode === 404 || e.statusCode === 410) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        else out.push_bledy++;
      }
    }
  }
  if (n.notify_email && n.email) {
    const mail = require('./mail');
    const url = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    await mail.queue({ to: n.email, subject: '[MXT] ' + n.title, related_type: 'notification', related_id: null,
      text: `${n.title}\n\n${n.body}${url ? `\n\nOtwórz w aplikacji: ${url}${n.link || '/powiadomienia'}` : ''}\n\n— Powiadomienie z aplikacji MXT. Kopie e-mail wyłączysz w Powiadomienia → Ustawienia.` });
    out.email = true;
  }
  return out;
});

module.exports = { notify, vapidKeys };
