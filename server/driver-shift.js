// ─────────────────────────────────────────────────────────────
// Driver shift + job timing (v3.3)
//
//   Clock in   the driver starts the shift (time + GPS). A shift timer runs in the app.
//   Start job  the job timer starts; the app offers navigation.
//   Arrival    ONE live photo, stamped with GPS and time on the phone and checked
//              here against the site's location. This is the proof for the stop.
//   Report     Finish, or an issue (site closed, no access …). Both use the arrival
//              photo, so the driver never photographs the same stop twice.
//   Clock out  ends the shift.
//
// The office sees every time in the Daily Route Ledger. The older one-step routes
// (/pickups/:id/complete and /cancel) still work for the native app and offline queue.
// ─────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { q } = require('./db');
const security = require('./security');

security.ensureSecret();
const SECRET = process.env.JWT_SECRET;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: security.safeImageName('arrival') }),
  fileFilter: security.imageFileFilter,
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

q.run(`CREATE TABLE IF NOT EXISTS driver_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER,
  work_date TEXT NOT NULL,
  clock_in_at TEXT NOT NULL,
  clock_in_lat REAL, clock_in_lng REAL,
  clock_out_at TEXT,
  clock_out_lat REAL, clock_out_lng REAL,
  auto_in INTEGER NOT NULL DEFAULT 0,
  closed_by TEXT
)`);
q.run(`CREATE INDEX IF NOT EXISTS ix_shifts_driver_date ON driver_shifts(driver_id, work_date)`);
for (const col of ['started_at TEXT', 'arrived_at TEXT', 'arrival_lat REAL', 'arrival_lng REAL', 'arrival_distance_m INTEGER', 'arrival_photo_url TEXT', 'arrival_meta TEXT'])
  q.run(`ALTER TABLE pickups ADD COLUMN ${col}`);   // "duplicate column" is ignored by db.js

const NPU_REASONS = ['CLOSED', 'NO_ACCESS', 'NO_WASTE', 'CUSTOMER_REFUSED', 'BIN_EMPTY', 'ACCESS_BLOCKED', 'MANAGER_REFUSED'];
const nowIso = () => new Date().toISOString();
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const secs = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);
const coord = (v, max) => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && Math.abs(n) <= max && n !== 0 ? n : null; };

function auth(...roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const p = jwt.verify(token, SECRET);
      if (roles.length && !roles.includes(p.role)) return res.status(403).json({ error: 'Forbidden' });
      req.user = p;
      next();
    } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  };
}

// ── shifts ───────────────────────────────────────────────────
const openShift = (driverId) => q.get(`SELECT * FROM driver_shifts WHERE driver_id=? AND clock_out_at IS NULL ORDER BY id DESC LIMIT 1`, driverId) || null;

// A shift left open from an earlier day is closed at that day's last recorded activity.
function closeStale(driverId) {
  const s = openShift(driverId);
  if (!s || s.work_date >= ymd()) return;
  const last = q.get(`SELECT MAX(COALESCE(completed_at, arrived_at, started_at)) t FROM pickups WHERE driver_id=? AND scheduled_date=?`, driverId, s.work_date).t;
  q.run(`UPDATE driver_shifts SET clock_out_at=?, closed_by='auto' WHERE id=?`, last && last > s.clock_in_at ? last : s.clock_in_at, s.id);
}
function clockIn(user, { lat, lng } = {}, auto = false) {
  closeStale(user.id);
  const cur = openShift(user.id);
  if (cur) return { shift: cur, already: true };
  const u = q.get(`SELECT vehicle_id FROM users WHERE id=?`, user.id);
  const info = q.run(`INSERT INTO driver_shifts(driver_id,vehicle_id,work_date,clock_in_at,clock_in_lat,clock_in_lng,auto_in) VALUES (?,?,?,?,?,?,?)`,
    user.id, (u && u.vehicle_id) || user.vehicle_id || null, ymd(), nowIso(), coord(lat, 90), coord(lng, 180), auto ? 1 : 0);
  return { shift: q.get(`SELECT * FROM driver_shifts WHERE id=?`, Number(info.lastInsertRowid)), already: false };
}
// what the driver did today, for the timer card and the clock-out summary
function daySummary(driverId, date = ymd()) {
  const rows = q.all(`SELECT status, stage, started_at, arrived_at, completed_at FROM pickups WHERE driver_id=? AND scheduled_date=? AND status!='rescheduled'`, driverId, date);
  const done = rows.filter(r => ['collected', 'canceled'].includes(r.status));
  const sum = (f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
  return {
    jobs_total: rows.length, jobs_done: done.length,
    jobs_finished: rows.filter(r => r.status === 'collected').length, jobs_issue: rows.filter(r => r.status === 'canceled').length,
    jobs_open: rows.length - done.length,
    job_in_progress: rows.some(r => r.started_at && !['collected', 'canceled'].includes(r.status)),
    travel_s: sum(r => secs(r.started_at, r.arrived_at)), on_site_s: sum(r => secs(r.arrived_at, r.completed_at)),
    job_s: sum(r => secs(r.started_at, r.completed_at)),
  };
}
const shiftView = (s) => s && { ...s, duration_s: secs(s.clock_in_at, s.clock_out_at || nowIso()), open: !s.clock_out_at };

// Called when a driver starts a job. Starting without clocking in still opens a shift
// (flagged), so no working time goes unrecorded.
function onJobStarted(pickup, user) {
  if (!pickup.started_at) q.run(`UPDATE pickups SET started_at=? WHERE id=?`, nowIso(), pickup.id);
  if (!openShift(user.id)) clockIn(user, {}, true);
}

function jobTimes(p) {
  return { started_at: p.started_at || null, arrived_at: p.arrived_at || null, completed_at: p.completed_at || null,
    travel_s: secs(p.started_at, p.arrived_at), on_site_s: secs(p.arrived_at, p.completed_at), total_s: secs(p.started_at, p.completed_at) };
}

// ═════════════════════════ ROUTES ════════════════════════════
function mountDriverShiftRoutes(r, io) {
  const v3 = require('./v3');
  const ops = require('./ops-features');
  const staffPing = (driverId) => { if (io) io.to('staff').emit('shift:changed', { driver_id: driverId }); };

  r.get('/driver/shift', auth('driver'), (req, res) => {
    closeStale(req.user.id);
    res.json({ server_now: nowIso(), shift: shiftView(openShift(req.user.id)), today: daySummary(req.user.id) });
  });
  r.post('/driver/shift/clock-in', auth('driver'), (req, res) => {
    const me = q.get(`SELECT id, is_active FROM users WHERE id=? AND role='driver'`, req.user.id);
    if (!me || !me.is_active) return res.status(403).json({ error: 'Driver account not active' });
    const out = clockIn(req.user, req.body || {});
    if (!out.already) staffPing(req.user.id);
    res.json({ ok: true, already: out.already, server_now: nowIso(), shift: shiftView(out.shift), today: daySummary(req.user.id) });
  });
  r.post('/driver/shift/clock-out', auth('driver'), (req, res) => {
    const s = openShift(req.user.id);
    if (!s) return res.status(409).json({ error: 'You are not clocked in' });
    const b = req.body || {};
    q.run(`UPDATE driver_shifts SET clock_out_at=?, clock_out_lat=?, clock_out_lng=?, closed_by='driver' WHERE id=?`, nowIso(), coord(b.lat, 90), coord(b.lng, 180), s.id);
    staffPing(req.user.id);
    res.json({ ok: true, shift: shiftView(q.get(`SELECT * FROM driver_shifts WHERE id=?`, s.id)), today: daySummary(req.user.id, s.work_date) });
  });

  // ── ARRIVAL: one GPS-stamped live photo ──
  r.post('/pickups/:id/arrive-proof', auth('driver'), upload.single('photo'), (req, res) => {
    const drop = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) { drop(); return res.status(404).json({ error: 'Not found' }); }
    const denied = security.driverJobError(p, req.user);
    if (denied) { drop(); return res.status(denied[0]).json({ error: denied[1] }); }
    if (['collected', 'canceled', 'rescheduled'].includes(p.status)) { drop(); return res.status(409).json({ error: `Already ${p.status}` }); }
    if (!req.file) return res.status(400).json({ error: 'A live photo at the site is required' });
    const check = v3.validateProof(p, req.body || {});
    const url = `/uploads/${req.file.filename}`;
    if (!check.ok) {
      v3.rejectProof(p, check, req.user.name, 'arrival');
      q.run(`UPDATE pickups SET photo_url=? WHERE id=?`, url, p.id);          // kept so the office can review it
      return res.status(422).json({ error: 'Photo rejected', problems: check.problems, rejected: true });
    }
    v3.flagLateProof(p, check, req.user.name);
    onJobStarted(p, req.user);                                               // arrived without tapping Start
    // the time the photo was taken is the arrival time (matters for photos sent later from the offline queue)
    const taken = Date.parse(req.body.photo_taken_at || '');
    const arrivedAt = Number.isFinite(taken) && taken <= Date.now() + 60000 ? new Date(taken).toISOString() : nowIso();
    q.run(`UPDATE pickups SET arrived_at=?, arrival_lat=?, arrival_lng=?, arrival_distance_m=?, arrival_photo_url=?, arrival_meta=?, updated_at=datetime('now') WHERE id=?`,
      arrivedAt, Number(req.body.lat), Number(req.body.lng), check.distance_m, url, JSON.stringify(check.meta), p.id);
    ops.markArrived(p.id, io, { driver: req.user.name });                    // stage + live events + "driver arrived" to the customer
    res.json({ ok: true, stage: 'arrived', arrived_at: arrivedAt, distance_m: check.distance_m, photo_url: url });
  });

  // shared guard for Finish / Report issue
  function arrivedJob(req, res) {
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) { res.status(404).json({ error: 'Not found' }); return null; }
    const denied = security.driverJobError(p, req.user);
    if (denied) { res.status(denied[0]).json({ error: denied[1] }); return null; }
    if (['collected', 'canceled', 'rescheduled'].includes(p.status)) { res.status(409).json({ error: `Already ${p.status}` }); return null; }
    if (!p.arrived_at || !p.arrival_photo_url) { res.status(409).json({ error: 'Take the arrival photo at the site first', code: 'NOT_ARRIVED' }); return null; }
    return p;
  }
  const proofMeta = (p, extra) => JSON.stringify({ ...(() => { try { return JSON.parse(p.arrival_meta || '{}'); } catch { return {}; } })(), proof: 'arrival', ...extra });

  // ── REPORT: finished ──
  r.post('/pickups/:id/finish', auth('driver'), (req, res) => {
    const p = arrivedJob(req, res); if (!p) return;
    const list = Array.isArray((req.body || {}).checklist) ? req.body.checklist.slice(0, 50).map(x => String(x).slice(0, 200)) : [];
    const ts = nowIso();
    q.run(`UPDATE pickups SET status='collected', stage='completed', completed_at=?, photo_url=?, gps_lat=?, gps_lng=?, photo_taken_at=?,
           proof_meta=?, checklist=?, updated_at=datetime('now') WHERE id=?`,
      ts, p.arrival_photo_url, p.arrival_lat, p.arrival_lng, p.arrived_at, proofMeta(p, { on_site_s: secs(p.arrived_at, ts) }), JSON.stringify(list), p.id);
    const info = q.get(`SELECT c.name, c.branch, v.fleet_number FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN vehicles v ON v.id=p.vehicle_id WHERE p.id=?`, p.id);
    if (io) {
      io.to('staff').emit('pickup:completed', { id: p.id, customer: info.name, branch: info.branch, vehicle: info.fleet_number, photo_url: p.arrival_photo_url, at: ts, driver: req.user.name });
      io.to('customer:' + p.customer_id).emit('pickup:completed', { id: p.id });
    }
    try { v3.onPickupCompleted(p.id); } catch (e) { console.warn('onPickupCompleted', e.message); }
    res.json({ ok: true, status: 'collected', at: ts, ...jobTimes({ ...p, completed_at: ts }) });
  });

  // ── REPORT: an issue (site closed, no access …) → customer confirms within 24 h ──
  r.post('/pickups/:id/issue', auth('driver'), (req, res) => {
    const reason = String((req.body || {}).reason || '');
    if (!NPU_REASONS.includes(reason)) return res.status(400).json({ error: 'Choose what the problem is' });
    const p = arrivedJob(req, res); if (!p) return;
    const ts = nowIso();
    q.run(`UPDATE pickups SET status='canceled', anomaly_reason=?, gps_lat=?, gps_lng=?, photo_url=?, photo_taken_at=?, proof_meta=?,
           completed_at=?, updated_at=datetime('now') WHERE id=?`,
      reason, p.arrival_lat, p.arrival_lng, p.arrival_photo_url, p.arrived_at, proofMeta(p, { on_site_s: secs(p.arrived_at, ts) }), ts, p.id);
    v3.onNotPickedUp(p.id);
    const info = q.get(`SELECT c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, p.id);
    const msg = `NOT PICKED UP: ${info.name} (${info.branch}) — ${reason.replace(/_/g, ' ')} (by ${req.user.name}) · awaiting customer confirmation`;
    q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES ('ANOMALY','warning',?,?)`, msg, p.id);
    if (io) {
      io.to('staff').emit('pickup:canceled', { id: p.id, customer: info.name, branch: info.branch, reason, driver: req.user.name });
      io.to('staff').emit('alert', { type: 'ANOMALY', severity: 'warning', message: msg, pickup_id: p.id });
    }
    res.json({ ok: true, status: 'canceled', confirmation_status: 'awaiting', ...jobTimes({ ...p, completed_at: ts }) });
  });

  // ── OFFICE: who is on shift, and how long each job took ──
  r.get('/shifts', auth('admin'), (req, res) => {
    const date = security.isRealDate(req.query.date || '') ? req.query.date : ymd();
    const drivers = q.all(`SELECT u.id, u.full_name, u.vehicle_id, v.fleet_number FROM users u LEFT JOIN vehicles v ON v.id=u.vehicle_id WHERE u.role='driver' AND u.is_active=1 ORDER BY v.fleet_number, u.full_name`);
    res.json({ date, server_now: nowIso(), rows: drivers.map(d => {
      const shifts = q.all(`SELECT * FROM driver_shifts WHERE driver_id=? AND work_date=? ORDER BY id`, d.id, date).map(shiftView);
      return { driver_id: d.id, driver: d.full_name, vehicle_id: d.vehicle_id, fleet_number: d.fleet_number, shifts,
        on_shift: shifts.some(s => s.open), shift_s: shifts.reduce((a, s) => a + (s.duration_s || 0), 0), ...daySummary(d.id, date) };
    }) });
  });
}

module.exports = { mountDriverShiftRoutes, onJobStarted, jobTimes, daySummary, clockIn, openShift, NPU_REASONS };
