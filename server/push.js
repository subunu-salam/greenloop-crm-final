// Free Web Push (VAPID) — no WhatsApp/SMS cost
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const { q, isPg } = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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
  const sql = isPg
    ? `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        user_ref TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    : `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        user_ref TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`;
  Promise.resolve(q.run(sql)).catch((e) => console.warn('push table:', e.message));
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

// One customer account can have several sites, and the app can be switched between
// them. Alerts are addressed to a site OR to the account, so a device must receive
// both: resolve any customer id to every id in the same account.
function customerRefs(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id)) return [String(customerId)];
  try {
    const c = q.get(`SELECT id, account_id FROM customers WHERE id=?`, id);
    const acct = c ? (c.account_id || c.id) : id;
    const ids = q.all(`SELECT id FROM customers WHERE id=? OR account_id=?`, acct, acct).map((r) => String(r.id));
    return [...new Set([String(id), String(acct), ...ids])];
  } catch {
    return [String(id)];
  }
}

function removeSubscription(endpoint) {
  try {
    q.run(`DELETE FROM push_subscriptions WHERE endpoint=?`, endpoint);
  } catch {}
}

// Deliver one payload to a set of subscription rows. Sends run in parallel
// (batches of 25) and never throw: the caller gets an honest delivery report.
async function deliver(rows, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const seen = new Set();
  rows = rows.filter((r) => (seen.has(r.endpoint) ? false : seen.add(r.endpoint)));
  const out = { devices: rows.length, delivered: 0, failed: 0, removed: 0, errors: [] };
  for (let i = 0; i < rows.length; i += 25) {
    await Promise.all(
      rows.slice(i, i + 25).map(async (row) => {
        const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
        try {
          await webpush.sendNotification(sub, body, { TTL: 24 * 60 * 60, urgency: payload && payload.urgent ? 'high' : 'normal' });
          out.delivered++;
        } catch (e) {
          // 404/410 = the browser dropped this subscription (app removed, permission revoked)
          if (e.statusCode === 404 || e.statusCode === 410) { removeSubscription(row.endpoint); out.removed++; }
          else {
            out.failed++;
            if (out.errors.length < 5) out.errors.push(String(e.statusCode || e.message));
            console.warn('push fail:', e.statusCode || e.message);
          }
        }
      })
    );
  }
  return out;
}

async function sendToRole(role, user_ref, payload) {
  ensureTable();
  const refs = role === 'customer' ? customerRefs(user_ref) : [String(user_ref)];
  const rows = q.all(
    `SELECT * FROM push_subscriptions WHERE role=? AND user_ref IN (${refs.map(() => '?').join(',')})`,
    role,
    ...refs
  );
  return deliver(rows, payload);
}

async function sendPush(role, user_ref, title, body, url, extra) {
  return sendToRole(role, user_ref, { title, body, url: url || '/', ts: Date.now(), ...(extra || {}) });
}

// Every signed-in device of a role (admin-wide announcement).
async function sendToAll(role, payload) {
  ensureTable();
  const rows = q.all(`SELECT * FROM push_subscriptions WHERE role=?`, role);
  return deliver(rows, { ts: Date.now(), ...payload });
}

// Every driver currently assigned to a vehicle (route changes, capacity changes).
async function sendToVehicleDrivers(vehicleId, title, body, url = '/driver/') {
  const total = { devices: 0, delivered: 0, failed: 0, removed: 0, errors: [] };
  let drivers = [];
  try { drivers = q.all(`SELECT id FROM users WHERE role='driver' AND is_active=1 AND vehicle_id=?`, vehicleId); } catch {}
  for (const d of drivers) {
    const r = await sendPush('driver', d.id, title, body, url);
    ['devices', 'delivered', 'failed', 'removed'].forEach((k) => { total[k] += r[k]; });
  }
  return total;
}

function stats() {
  ensureTable();
  const by = (role) => q.get(`SELECT COUNT(*) devices, COUNT(DISTINCT user_ref) users FROM push_subscriptions WHERE role=?`, role);
  return { customer: by('customer'), driver: by('driver'), admin: by('admin') };
}

function hasSubscription(role, user_ref) {
  const refs = role === 'customer' ? customerRefs(user_ref) : [String(user_ref)];
  return q.get(`SELECT COUNT(*) c FROM push_subscriptions WHERE role=? AND user_ref IN (${refs.map(() => '?').join(',')})`, role, ...refs).c;
}

module.exports = {
  vapid,
  saveSubscription,
  removeSubscription,
  sendToRole,
  sendPush,
  sendToAll,
  sendToVehicleDrivers,
  customerRefs,
  hasSubscription,
  stats,
  getPublicKey: () => vapid.publicKey,
};
