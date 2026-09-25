const tracking = require('./tracking');
const { q } = require('./db');
const jwt = require('jsonwebtoken');
const { checkGeofenceForDriver } = require('./ops-features');
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

let push;
try {
  push = require('./push');
} catch {
  push = null;
}

// throttle nearby pushes: key customerId → last sent ts
const nearbyPushSent = new Map();

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

function mountTrackingRoutes(r, io) {
  r.post('/driver/location', auth('driver'), (req, res) => {
    const { lat, lng, speed, heading, force } = req.body || {};
    if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
      return res.status(400).json({ error: 'lat and lng required' });
    }
    let fleet_number = null;
    let vehicle_id = req.user.vehicle_id || null;
    if (vehicle_id) {
      const v = q.get(`SELECT fleet_number FROM vehicles WHERE id=?`, vehicle_id);
      fleet_number = v?.fleet_number || null;
    }
    const { skipped, position } = tracking.setPosition(req.user.id, {
      lat: Number(lat),
      lng: Number(lng),
      speed: speed != null ? Number(speed) : null,
      heading: heading != null ? Number(heading) : null,
      force: !!force,
      vehicle_id,
      name: req.user.name,
      fleet_number,
    });

    let geofence = [];
    if (!skipped) {
      io.emit('driver:location', position);
      if (vehicle_id) io.to('vehicle:' + vehicle_id).emit('driver:location', position);

      try {
        geofence = checkGeofenceForDriver(req.user.id, position.lat, position.lng, io) || [];
      } catch {}

      try {
        const today = new Date().toISOString().slice(0, 10);
        const stops2 = q.all(
          `SELECT p.customer_id, c.lat, c.lng, c.name FROM pickups p
           JOIN customers c ON c.id = p.customer_id
           WHERE p.driver_id=? AND p.scheduled_date=? AND p.status IN ('pending','overdue')`,
          req.user.id,
          today
        );
        const seen = new Set();
        for (const s of stops2) {
          if (seen.has(s.customer_id)) continue;
          seen.add(s.customer_id);
          const eta = tracking.etaMinutes(
            { lat: position.lat, lng: position.lng },
            { lat: Number(s.lat), lng: Number(s.lng) }
          );
          const distance_m = tracking.haversineM(
            { lat: position.lat, lng: position.lng },
            { lat: Number(s.lat), lng: Number(s.lng) }
          );
          io.to('customer:' + s.customer_id).emit('driver:nearby', {
            ...position,
            customer_id: s.customer_id,
            eta_minutes: eta,
            distance_m,
            nearby: distance_m < 150,
          });

          // Free push once per 30 min when within 400m
          if (push && distance_m < 400) {
            const key = String(s.customer_id);
            const last = nearbyPushSent.get(key) || 0;
            if (Date.now() - last > 30 * 60 * 1000) {
              nearbyPushSent.set(key, Date.now());
              push
                .sendPush(
                  'customer',
                  s.customer_id,
                  'Driver on the way',
                  eta != null
                    ? `About ${eta} min away (${Math.round(distance_m)} m)`
                    : `Truck is approaching your store`,
                  '/customer/'
                )
                .catch(() => {});
            }
          }
        }
      } catch {}
    }
    res.json({ ok: true, skipped: !!skipped, at: position.at, geofence_arrived: geofence });
  });

  r.get('/fleet/live', auth('admin'), (req, res) => {
    res.json({ positions: tracking.getAll(), server_time: Date.now() });
  });

  r.get('/customer/driver-location', (req, res, next) => {
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
  }, (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const pickup = q.get(
      `SELECT p.*, c.lat AS cust_lat, c.lng AS cust_lng, v.fleet_number, u.full_name AS driver_name
       FROM pickups p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN vehicles v ON v.id = p.vehicle_id
       LEFT JOIN users u ON u.id = p.driver_id
       WHERE p.customer_id=? AND p.scheduled_date=? AND p.status IN ('pending','overdue')
       ORDER BY p.seq LIMIT 1`,
      cid,
      today
    );
    if (!pickup || !pickup.driver_id) {
      return res.json({ tracking: false, reason: 'No active pickup today' });
    }
    const pos = tracking.getByDriver(pickup.driver_id);
    if (!pos) {
      return res.json({
        tracking: false,
        reason: 'Driver location not available yet',
        pickup: {
          id: pickup.id,
          status: pickup.status,
          stage: pickup.stage,
          fleet_number: pickup.fleet_number,
          driver_name: pickup.driver_name,
        },
      });
    }
    const eta = tracking.etaMinutes(
      { lat: pos.lat, lng: pos.lng },
      { lat: Number(pickup.cust_lat), lng: Number(pickup.cust_lng) }
    );
    const distance_m = tracking.haversineM(
      { lat: pos.lat, lng: pos.lng },
      { lat: Number(pickup.cust_lat), lng: Number(pickup.cust_lng) }
    );
    res.json({
      tracking: true,
      position: pos,
      eta_minutes: eta,
      distance_m: Math.round(distance_m),
      nearby: distance_m < 150,
      pickup: {
        id: pickup.id,
        status: pickup.status,
        stage: pickup.stage,
        fleet_number: pickup.fleet_number,
        driver_name: pickup.driver_name,
      },
    });
  });
}

module.exports = { mountTrackingRoutes };
