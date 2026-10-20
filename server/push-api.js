// Push notification routes: device registration + admin-wide broadcast (v3.2)
const push = require('./push');
const jwt = require('jsonwebtoken');
const { prisma } = require('./db');
require('./security').ensureSecret();
const SECRET = process.env.JWT_SECRET;

function authAny(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
function adminOnly(req, res, next) {
  authAny(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

const AUDIENCES = ['customers', 'drivers', 'all'];
// One document per customer ACCOUNT: active sites that are not linked to another account.
// SQL: account_id IS NULL OR account_id = id   (comparing two fields → done in JS)
async function accountHolders() {
  const rows = await prisma.customer.findMany({ where: { is_active: 1 }, select: { id: true, account_id: true }, orderBy: { id: 'asc' } });
  return rows.filter((c) => c.account_id == null || c.account_id === c.id);
}
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Stores the announcement in every customer's in-app inbox, shows it live in
// open apps (socket) and pushes it to every signed-in device.
async function broadcast(io, { audience, title, body, url, by }) {
  const total = { recipients: 0, devices: 0, delivered: 0, failed: 0, removed: 0, errors: [] };
  const add = (r) => { ['devices', 'delivered', 'failed', 'removed'].forEach((k) => { total[k] += r[k]; }); total.errors.push(...(r.errors || [])); };

  if (audience === 'customers' || audience === 'all') {
    // one inbox entry per account (multi-site customers read it once)
    const accounts = await accountHolders();
    const link = url || '/customer/';
    if (accounts.length) {
      await prisma.customerNotification.createMany({ data: accounts.map((a) => ({ customer_id: a.id, kind: 'announcement', title, body, link })) });
    }
    if (io) for (const a of accounts) for (const ref of await push.customerRefs(a.id)) io.to('customer:' + ref).emit('customer:notify', { kind: 'announcement', title, body });
    total.recipients += accounts.length;
    add(await push.sendToAll('customer', { title, body, url: link, kind: 'announcement' }));
  }
  if (audience === 'drivers' || audience === 'all') {
    const drivers = await prisma.user.findMany({ where: { role: 'driver', is_active: 1 }, select: { id: true } });
    if (io) for (const d of drivers) io.to('driver:' + d.id).emit('driver:notify', { kind: 'info', title, body });
    total.recipients += drivers.length;
    add(await push.sendToAll('driver', { title, body, url: url || '/driver/', kind: 'announcement' }));
  }
  const saved = await prisma.pushBroadcast.create({
    data: { audience, title, body, url: url || null, recipients: total.recipients, devices: total.devices, delivered: total.delivered, failed: total.failed, removed: total.removed, sent_by: by || null },
  });
  return { id: saved.id, ...total, errors: [...new Set(total.errors)].slice(0, 5) };
}

function mountPushRoutes(r, io) {
  r.get('/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: push.getPublicKey() });
  });

  r.post('/push/subscribe', authAny, async (req, res) => {
    try {
      const subscription = (req.body || {}).subscription;
      if (!subscription) return res.status(400).json({ error: 'subscription required' });
      const role = req.user.role;
      const user_ref =
        role === 'customer'
          ? String(req.user.customer_id || req.user.id)
          : String(req.user.id);
      // The same phone signing in as someone else moves the device to the new user
      // (endpoint is unique), so alerts never reach the previous account.
      await push.saveSubscription({ role, user_ref, subscription });
      res.json({ ok: true, role, devices: await push.hasSubscription(role, user_ref) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/push/unsubscribe', authAny, async (req, res) => {
    const endpoint = (req.body || {}).endpoint;
    if (endpoint) await push.removeSubscription(endpoint);
    res.json({ ok: true });
  });

  // Is this user reachable by push? (used by the apps to show an "Enable" prompt)
  r.get('/push/status', authAny, async (req, res) => {
    const ref = req.user.role === 'customer' ? (req.user.customer_id || req.user.id) : req.user.id;
    res.json({ devices: await push.hasSubscription(req.user.role, ref) });
  });

  // Sends a test notification to the caller's own devices.
  r.post('/push/test', authAny, async (req, res) => {
    const ref = req.user.role === 'customer' ? (req.user.customer_id || req.user.id) : req.user.id;
    const url = req.user.role === 'customer' ? '/customer/' : req.user.role === 'driver' ? '/driver/' : '/crm/';
    const out = await push.sendPush(req.user.role, ref, 'GreenLoop test', 'Notifications are working on this device.', url);
    res.json({ ok: out.delivered > 0, ...out });
  });

  // ── Admin: reach + history + broadcast ──
  r.get('/push/stats', adminOnly, async (req, res) => {
    res.json({
      ...(await push.stats()),
      totals: { customer_accounts: (await accountHolders()).length, drivers: await prisma.user.count({ where: { role: 'driver', is_active: 1 } }) },
      history: await prisma.pushBroadcast.findMany({ orderBy: { id: 'desc' }, take: 25 }),
    });
  });

  r.post('/push/broadcast', adminOnly, async (req, res) => {
    const b = req.body || {};
    const audience = AUDIENCES.includes(b.audience) ? b.audience : null;
    const title = clean(b.title, 80), body = clean(b.body, 300);
    if (!audience) return res.status(400).json({ error: 'Choose who receives this: customers, drivers or all' });
    if (!title) return res.status(400).json({ error: 'A title is required' });
    if (!body) return res.status(400).json({ error: 'A message is required' });
    let url = clean(b.url, 200);
    if (url && !/^\/(customer|driver)\//.test(url)) url = ''; // only links inside our own apps
    try {
      const out = await broadcast(io, { audience, title, body, url, by: req.user.name });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ error: 'Broadcast failed: ' + e.message });
    }
  });
}

module.exports = { mountPushRoutes, broadcast };
