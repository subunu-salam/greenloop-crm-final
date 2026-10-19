// Free Web Push (VAPID) — no WhatsApp/SMS cost
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const { prisma, toId } = require('./db');

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

// Collection push_subscriptions (endpoint is unique) — see prisma/schema.prisma.
async function saveSubscription({ role, user_ref, subscription }) {
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error('Invalid subscription');
  const data = { role: String(role), user_ref: String(user_ref), p256dh: String(p256dh), auth: String(auth) };
  // INSERT … ON CONFLICT(endpoint) DO UPDATE  →  upsert on the unique endpoint
  await prisma.pushSubscription.upsert({ where: { endpoint: String(endpoint) }, create: { endpoint: String(endpoint), ...data }, update: data });
}

// One customer account can have several sites, and the app can be switched between
// them. Alerts are addressed to a site OR to the account, so a device must receive
// both: resolve any customer id to every id in the same account.
async function customerRefs(customerId) {
  const id = toId(customerId);
  if (!id) return [String(customerId)];
  try {
    const c = await prisma.customer.findUnique({ where: { id }, select: { id: true, account_id: true } });
    const acct = c ? (c.account_id || c.id) : id;
    const ids = (await prisma.customer.findMany({ where: { OR: [{ id: acct }, { account_id: acct }] }, select: { id: true } })).map((r) => String(r.id));
    return [...new Set([String(id), String(acct), ...ids])];
  } catch {
    return [String(id)];
  }
}

async function removeSubscription(endpoint) {
  try {
    await prisma.pushSubscription.deleteMany({ where: { endpoint: String(endpoint) } });
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
          if (e.statusCode === 404 || e.statusCode === 410) { await removeSubscription(row.endpoint); out.removed++; }
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
  const refs = role === 'customer' ? await customerRefs(user_ref) : [String(user_ref)];
  const rows = await prisma.pushSubscription.findMany({ where: { role, user_ref: { in: refs } }, orderBy: { id: 'asc' } });
  return deliver(rows, payload);
}

async function sendPush(role, user_ref, title, body, url, extra) {
  return sendToRole(role, user_ref, { title, body, url: url || '/', ts: Date.now(), ...(extra || {}) });
}

// Every signed-in device of a role (admin-wide announcement).
async function sendToAll(role, payload) {
  const rows = await prisma.pushSubscription.findMany({ where: { role }, orderBy: { id: 'asc' } });
  return deliver(rows, { ts: Date.now(), ...payload });
}

// Every driver currently assigned to a vehicle (route changes, capacity changes).
async function sendToVehicleDrivers(vehicleId, title, body, url = '/driver/') {
  const total = { devices: 0, delivered: 0, failed: 0, removed: 0, errors: [] };
  let drivers = [];
  try { drivers = await prisma.user.findMany({ where: { role: 'driver', is_active: 1, vehicle_id: Number(vehicleId) }, select: { id: true } }); } catch {}
  for (const d of drivers) {
    const r = await sendPush('driver', d.id, title, body, url);
    ['devices', 'delivered', 'failed', 'removed'].forEach((k) => { total[k] += r[k]; });
  }
  return total;
}

async function stats() {
  // SELECT COUNT(*) devices, COUNT(DISTINCT user_ref) users … WHERE role=?
  const by = async (role) => {
    const rows = await prisma.pushSubscription.findMany({ where: { role }, select: { user_ref: true } });
    return { devices: rows.length, users: new Set(rows.map((r) => r.user_ref)).size };
  };
  return { customer: await by('customer'), driver: await by('driver'), admin: await by('admin') };
}

async function hasSubscription(role, user_ref) {
  const refs = role === 'customer' ? await customerRefs(user_ref) : [String(user_ref)];
  return prisma.pushSubscription.count({ where: { role, user_ref: { in: refs } } });
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
