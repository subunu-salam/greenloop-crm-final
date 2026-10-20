const { prisma, findById, now: sqlNow } = require('./db');
const tracking = require('./tracking');
const jwt = require('jsonwebtoken');
require('./security').ensureSecret();
const SECRET = process.env.JWT_SECRET;

let push;
try {
  push = require('./push');
} catch {
  push = null;
}

const ARRIVE_RADIUS_M = 100;

function auth(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const p = jwt.verify(token, SECRET);
      if (role && p.role !== role) return res.status(403).json({ error: 'Forbidden' });
      req.user = p;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

async function markArrived(pickupId, io, meta = {}) {
  const p = await prisma.pickup.findUnique({ where: { id: pickupId } });
  if (!p) return null;
  if (!['pending', 'overdue'].includes(p.status)) return p;
  if (p.stage === 'arrived' || p.stage === 'completed') return p;
  await prisma.pickup.update({ where: { id: pickupId }, data: { stage: 'arrived', updated_at: sqlNow() } });
  const c = await prisma.customer.findUnique({ where: { id: p.customer_id }, select: { id: true, name: true, branch: true } });
  const info = c ? { name: c.name, branch: c.branch, customer_id: c.id } : null;
  const payload = {
    id: pickupId,
    stage: 'arrived',
    customer: info?.name,
    branch: info?.branch,
    customer_id: info?.customer_id,
    driver: meta.driver || null,
    auto: !!meta.auto,
  };
  if (io) {
    io.to('staff').emit('pickup:arrived', payload);
    if (info?.customer_id) io.to('customer:' + info.customer_id).emit('pickup:arrived', payload);
  }
  if (push && info?.customer_id) {
    push
      .sendPush(
        'customer',
        info.customer_id,
        'Driver arrived',
        `${info.name || 'Your store'} — truck is at your location`,
        '/customer/'
      )
      .catch(() => {});
  }
  return { ...p, stage: 'arrived' };
}

async function checkGeofenceForDriver(driverId, lat, lng, io) {
  const today = new Date().toISOString().slice(0, 10);
  const jobs = await prisma.pickup.findMany({
    where: { driver_id: driverId, scheduled_date: today, status: { in: ['pending', 'overdue'] } },
    select: { id: true, stage: true, status: true, customer_id: true }, orderBy: { id: 'asc' },
  });
  const custs = await prisma.customer.findMany({ where: { id: { in: jobs.map(j => j.customer_id) } }, select: { id: true, lat: true, lng: true, name: true } });
  const at = new Map(custs.map(c => [c.id, c]));
  const arrived = [];
  for (const j of jobs) {
    const c = at.get(j.customer_id);
    if (!c) continue;
    if (j.stage === 'arrived' || j.stage === 'completed') continue;
    if (c.lat == null || c.lng == null) continue;
    const d = tracking.haversineM({ lat, lng }, { lat: Number(c.lat), lng: Number(c.lng) });
    if (d <= ARRIVE_RADIUS_M) {
      await markArrived(j.id, io, { auto: true });
      arrived.push({ id: j.id, name: c.name, distance_m: Math.round(d) });
    }
  }
  return arrived;
}

function mountOpsFeatureRoutes(r, io) {
  r.get('/driver/pickups/:id/context', auth('driver'), async (req, res) => {
    const p = await findById('pickup', req.params.id, { select: { id: true, status: true, stage: true, seq: true, customer_id: true } });
    const c = p && await prisma.customer.findUnique({
      where: { id: p.customer_id },
      select: { name: true, branch: true, zone: true, address: true, lat: true, lng: true, contact_phone: true, access_notes: true },
    });
    if (!p || !c) return res.status(404).json({ error: 'Not found' });
    res.json({ id: p.id, status: p.status, stage: p.stage, seq: p.seq, ...c });
  });

  r.post('/pickups/:id/arrive', auth('driver'), async (req, res) => {
    const p = await findById('pickup', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const denied = require('./security').driverJobError(p, req.user);
    if (denied) return res.status(denied[0]).json({ error: denied[1] });
    await markArrived(p.id, io, { driver: req.user.name });
    res.json({ ok: true, stage: 'arrived' });
  });

  r.put('/customers/:id/access-notes', auth('admin'), async (req, res) => {
    const notes = String((req.body || {}).access_notes || '').slice(0, 1000);
    const c = await findById('customer', req.params.id, { select: { id: true } });
    if (!c) return res.status(404).json({ error: 'Not found' });
    await prisma.customer.update({ where: { id: c.id }, data: { access_notes: notes } });
    res.json({ ok: true });
  });

  function customerAuth(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const p = jwt.verify(token, SECRET);
      if (p.role !== 'customer') return res.status(403).json({ error: 'Forbidden' });
      req.user = p;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  r.put('/customer/access-notes', customerAuth, async (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const notes = String((req.body || {}).access_notes || '').slice(0, 1000);
    await prisma.customer.updateMany({ where: { id: cid }, data: { access_notes: notes } });
    res.json({ ok: true, access_notes: notes });
  });

  r.get('/customer/profile', customerAuth, async (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const c = await prisma.customer.findUnique({
      where: { id: cid },
      select: { id: true, name: true, branch: true, zone: true, address: true, contact_phone: true, frequency: true, access_notes: true },
    });
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  });
}

module.exports = {
  mountOpsFeatureRoutes,
  checkGeofenceForDriver,
  markArrived,
  ARRIVE_RADIUS_M,
};
