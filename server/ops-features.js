const { q } = require('./db');
const tracking = require('./tracking');
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

let push;
try {
  push = require('./push');
} catch {
  push = null;
}

const ARRIVE_RADIUS_M = 100;

function ensureColumns() {
  try {
    q.run(`ALTER TABLE customers ADD COLUMN access_notes TEXT`);
  } catch {}
}

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

function markArrived(pickupId, io, meta = {}) {
  const p = q.get(`SELECT * FROM pickups WHERE id=?`, pickupId);
  if (!p) return null;
  if (!['pending', 'overdue'].includes(p.status)) return p;
  if (p.stage === 'arrived' || p.stage === 'completed') return p;
  q.run(`UPDATE pickups SET stage='arrived', updated_at=datetime('now') WHERE id=?`, pickupId);
  const info = q.get(
    `SELECT c.name, c.branch, c.id AS customer_id FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`,
    pickupId
  );
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
    io.emit('pickup:arrived', payload);
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

function checkGeofenceForDriver(driverId, lat, lng, io) {
  const today = new Date().toISOString().slice(0, 10);
  const jobs = q.all(
    `SELECT p.id, p.stage, p.status, c.lat, c.lng, c.id AS customer_id, c.name
     FROM pickups p JOIN customers c ON c.id=p.customer_id
     WHERE p.driver_id=? AND p.scheduled_date=? AND p.status IN ('pending','overdue')`,
    driverId,
    today
  );
  const arrived = [];
  for (const j of jobs) {
    if (j.stage === 'arrived' || j.stage === 'completed') continue;
    if (j.lat == null || j.lng == null) continue;
    const d = tracking.haversineM({ lat, lng }, { lat: Number(j.lat), lng: Number(j.lng) });
    if (d <= ARRIVE_RADIUS_M) {
      markArrived(j.id, io, { auto: true });
      arrived.push({ id: j.id, name: j.name, distance_m: Math.round(d) });
    }
  }
  return arrived;
}

function mountOpsFeatureRoutes(r, io) {
  ensureColumns();

  r.get('/driver/pickups/:id/context', auth('driver'), (req, res) => {
    const row = q.get(
      `SELECT p.id, p.status, p.stage, p.seq,
              c.name, c.branch, c.zone, c.address, c.lat, c.lng, c.contact_phone, c.access_notes
       FROM pickups p JOIN customers c ON c.id=p.customer_id
       WHERE p.id=?`,
      req.params.id
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  r.post('/pickups/:id/arrive', auth('driver'), (req, res) => {
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.driver_id && p.driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your job' });
    }
    markArrived(p.id, io, { driver: req.user.name });
    res.json({ ok: true, stage: 'arrived' });
  });

  r.put('/customers/:id/access-notes', auth('admin'), (req, res) => {
    const notes = String((req.body || {}).access_notes || '').slice(0, 1000);
    const c = q.get(`SELECT id FROM customers WHERE id=?`, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    q.run(`UPDATE customers SET access_notes=? WHERE id=?`, notes, c.id);
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

  r.put('/customer/access-notes', customerAuth, (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const notes = String((req.body || {}).access_notes || '').slice(0, 1000);
    q.run(`UPDATE customers SET access_notes=? WHERE id=?`, notes, cid);
    res.json({ ok: true, access_notes: notes });
  });

  r.get('/customer/profile', customerAuth, (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const c = q.get(
      `SELECT id, name, branch, zone, address, contact_phone, frequency, access_notes FROM customers WHERE id=?`,
      cid
    );
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
