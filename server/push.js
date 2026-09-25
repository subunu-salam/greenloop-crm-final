// Free Web Push (VAPID) — no WhatsApp/SMS cost
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const { q } = require('./db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

function ensureVapid() {
  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:ops@greenloop.local';

  if (!publicKey || !privateKey) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(VAPID_FILE)) {
        const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
        publicKey = saved.publicKey;
        privateKey = saved.privateKey;
      } else {
        const keys = webpush.generateVAPIDKeys();
        publicKey = keys.publicKey;
        privateKey = keys.privateKey;
        fs.writeFileSync(VAPID_FILE, JSON.stringify({ publicKey, privateKey }, null, 2));
        console.log('✔ Generated VAPID keys → data/vapid.json');
      }
    } catch (e) {
      console.warn('VAPID setup:', e.message);
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
    }
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey, privateKey, subject };
}

const vapid = ensureVapid();

function ensureTable() {
  try {
    q.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      user_ref TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (e) {
    console.warn('push table:', e.message);
  }
}

ensureTable();

function saveSubscription({ role, user_ref, subscription }) {
  ensureTable();
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error('Invalid subscription');
  q.run(
    `INSERT INTO push_subscriptions(role, user_ref, endpoint, p256dh, auth)
     VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET role=excluded.role, user_ref=excluded.user_ref,
       p256dh=excluded.p256dh, auth=excluded.auth`,
    role,
    String(user_ref),
    endpoint,
    p256dh,
    auth
  );
}

function removeSubscription(endpoint) {
  try {
    q.run(`DELETE FROM push_subscriptions WHERE endpoint=?`, endpoint);
  } catch {}
}

async function sendToRole(role, user_ref, payload) {
  ensureTable();
  const rows = q.all(
    `SELECT * FROM push_subscriptions WHERE role=? AND user_ref=?`,
    role,
    String(user_ref)
  );
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const row of rows) {
    const sub = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 * 60 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) removeSubscription(row.endpoint);
      else console.warn('push fail:', e.statusCode || e.message);
    }
  }
}

async function sendPush(role, user_ref, title, body, url) {
  return sendToRole(role, user_ref, {
    title,
    body,
    url: url || '/',
    ts: Date.now(),
  });
}

module.exports = {
  vapid,
  saveSubscription,
  removeSubscription,
  sendToRole,
  sendPush,
  getPublicKey: () => vapid.publicKey,
};
