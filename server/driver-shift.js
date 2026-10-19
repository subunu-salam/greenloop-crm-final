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
const { prisma, join, findById, num, sortBy, now: sqlNow } = require('./db');
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
// (collection driver_shifts and the job-timing fields on pickups are defined in prisma/schema.prisma)

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
const openShift = (driverId) => prisma.driverShift.findFirst({ where: { driver_id: driverId, clock_out_at: null }, orderBy: { id: 'desc' } });

// A shift left open from an earlier day is closed at that day's last recorded activity.
async function closeStale(driverId) {
  const s = await openShift(driverId);
  if (!s || s.work_date >= ymd()) return;
  const jobs = await prisma.pickup.findMany({ where: { driver_id: driverId, scheduled_date: s.work_date }, select: { completed_at: true, arrived_at: true, started_at: true } });
  // SQL: MAX(COALESCE(completed_at, arrived_at, started_at))
  const last = jobs.map(j => j.completed_at ?? j.arrived_at ?? j.started_at).filter(Boolean).sort().pop() || null;
  await prisma.driverShift.update({ where: { id: s.id }, data: { clock_out_at: last && last > s.clock_in_at ? last : s.clock_in_at, closed_by: 'auto' } });
}
async function clockIn(user, { lat, lng } = {}, auto = false) {
  await closeStale(user.id);
  const cur = await openShift(user.id);
  if (cur) return { shift: cur, already: true };
  const u = await prisma.user.findUnique({ where: { id: user.id }, select: { vehicle_id: true } });
  const shift = await prisma.driverShift.create({
    data: {
      driver_id: user.id, vehicle_id: (u && u.vehicle_id) || user.vehicle_id || null, work_date: ymd(), clock_in_at: nowIso(),
      clock_in_lat: coord(lat, 90), clock_in_lng: coord(lng, 180), auto_in: auto ? 1 : 0,
    },
  });
  return { shift, already: false };
}
// what the driver did today, for the timer card and the clock-out summary
async function daySummary(driverId, date = ymd()) {
  const rows = await prisma.pickup.findMany({
    where: { driver_id: driverId, scheduled_date: date, status: { not: 'rescheduled' } },
    select: { status: true, stage: true, started_at: true, arrived_at: true, completed_at: true },
  });
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
async function onJobStarted(pickup, user) {
  if (!pickup.started_at) await prisma.pickup.update({ where: { id: pickup.id }, data: { started_at: nowIso() } });
  if (!(await openShift(user.id))) await clockIn(user, {}, true);
}

function jobTimes(p) {
  return { started_at: p.started_at || null, arrived_at: p.arrived_at || null, completed_at: p.completed_at || null,
    travel_s: secs(p.started_at, p.arrived_at), on_site_s: secs(p.arrived_at, p.completed_at), total_s: secs(p.started_at, p.completed_at) };
}
// customer name/branch (+ fleet number) for the live events
async function stopInfo(p) {
  const [c, v] = await Promise.all([
    prisma.customer.findUnique({ where: { id: p.customer_id }, select: { name: true, branch: true } }),
    p.vehicle_id ? prisma.vehicle.findUnique({ where: { id: p.vehicle_id }, select: { fleet_number: true } }) : null,
  ]);
  return { name: c?.name ?? null, branch: c?.branch ?? null, fleet_number: v?.fleet_number ?? null };
}

// ═════════════════════════ ROUTES ════════════════════════════
function mountDriverShiftRoutes(r, io) {
  const v3 = require('./v3');
  const ops = require('./ops-features');
  const staffPing = (driverId) => { if (io) io.to('staff').emit('shift:changed', { driver_id: driverId }); };

  r.get('/driver/shift', auth('driver'), async (req, res) => {
    await closeStale(req.user.id);
    res.json({ server_now: nowIso(), shift: shiftView(await openShift(req.user.id)), today: await daySummary(req.user.id) });
  });
  r.post('/driver/shift/clock-in', auth('driver'), async (req, res) => {
    const me = await prisma.user.findFirst({ where: { id: req.user.id, role: 'driver' }, select: { id: true, is_active: true } });
    if (!me || !me.is_active) return res.status(403).json({ error: 'Driver account not active' });
    const out = await clockIn(req.user, req.body || {});
    if (!out.already) staffPing(req.user.id);
    res.json({ ok: true, already: out.already, server_now: nowIso(), shift: shiftView(out.shift), today: await daySummary(req.user.id) });
  });
  r.post('/driver/shift/clock-out', auth('driver'), async (req, res) => {
    const s = await openShift(req.user.id);
    if (!s) return res.status(409).json({ error: 'You are not clocked in' });
    const b = req.body || {};
    const closed = await prisma.driverShift.update({
      where: { id: s.id },
      data: { clock_out_at: nowIso(), clock_out_lat: coord(b.lat, 90), clock_out_lng: coord(b.lng, 180), closed_by: 'driver' },
    });
    staffPing(req.user.id);
    res.json({ ok: true, shift: shiftView(closed), today: await daySummary(req.user.id, s.work_date) });
  });

  // ── ARRIVAL: one GPS-stamped live photo ──
  r.post('/pickups/:id/arrive-proof', auth('driver'), upload.single('photo'), async (req, res) => {
    const drop = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
    const p = await findById('pickup', req.params.id);
    if (!p) { drop(); return res.status(404).json({ error: 'Not found' }); }
    const denied = security.driverJobError(p, req.user);
    if (denied) { drop(); return res.status(denied[0]).json({ error: denied[1] }); }
    if (['collected', 'canceled', 'rescheduled'].includes(p.status)) { drop(); return res.status(409).json({ error: `Already ${p.status}` }); }
    if (!req.file) return res.status(400).json({ error: 'A live photo at the site is required' });
    const check = await v3.validateProof(p, req.body || {});
    const url = `/uploads/${req.file.filename}`;
    if (!check.ok) {
      await v3.rejectProof(p, check, req.user.name, 'arrival');
      await prisma.pickup.update({ where: { id: p.id }, data: { photo_url: url } });   // kept so the office can review it
      return res.status(422).json({ error: 'Photo rejected', problems: check.problems, rejected: true });
    }
    await v3.flagLateProof(p, check, req.user.name);
    await onJobStarted(p, req.user);                                               // arrived without tapping Start
    // the time the photo was taken is the arrival time (matters for photos sent later from the offline queue)
    const taken = Date.parse(req.body.photo_taken_at || '');
    const arrivedAt = Number.isFinite(taken) && taken <= Date.now() + 60000 ? new Date(taken).toISOString() : nowIso();
    await prisma.pickup.update({
      where: { id: p.id },
      data: {
        arrived_at: arrivedAt, arrival_lat: num(req.body.lat), arrival_lng: num(req.body.lng),
        arrival_distance_m: check.distance_m == null ? null : Math.round(check.distance_m), arrival_photo_url: url,
        arrival_meta: JSON.stringify(check.meta), updated_at: sqlNow(),
      },
    });
    await ops.markArrived(p.id, io, { driver: req.user.name });                    // stage + live events + "driver arrived" to the customer
    res.json({ ok: true, stage: 'arrived', arrived_at: arrivedAt, distance_m: check.distance_m, photo_url: url });
  });

  // shared guard for Finish / Report issue
  async function arrivedJob(req, res) {
    const p = await findById('pickup', req.params.id);
    if (!p) { res.status(404).json({ error: 'Not found' }); return null; }
    const denied = security.driverJobError(p, req.user);
    if (denied) { res.status(denied[0]).json({ error: denied[1] }); return null; }
    if (['collected', 'canceled', 'rescheduled'].includes(p.status)) { res.status(409).json({ error: `Already ${p.status}` }); return null; }
    if (!p.arrived_at || !p.arrival_photo_url) { res.status(409).json({ error: 'Take the arrival photo at the site first', code: 'NOT_ARRIVED' }); return null; }
    return p;
  }
  const proofMeta = (p, extra) => JSON.stringify({ ...(() => { try { return JSON.parse(p.arrival_meta || '{}'); } catch { return {}; } })(), proof: 'arrival', ...extra });

  // ── REPORT: finished ──
  r.post('/pickups/:id/finish', auth('driver'), async (req, res) => {
    const p = await arrivedJob(req, res); if (!p) return;
    const list = Array.isArray((req.body || {}).checklist) ? req.body.checklist.slice(0, 50).map(x => String(x).slice(0, 200)) : [];
    const ts = nowIso();
    await prisma.pickup.update({
      where: { id: p.id },
      data: {
        status: 'collected', stage: 'completed', completed_at: ts, photo_url: p.arrival_photo_url, gps_lat: p.arrival_lat, gps_lng: p.arrival_lng,
        photo_taken_at: p.arrived_at, proof_meta: proofMeta(p, { on_site_s: secs(p.arrived_at, ts) }), checklist: JSON.stringify(list), updated_at: sqlNow(),
      },
    });
    const info = await stopInfo(p);
    if (io) {
      io.to('staff').emit('pickup:completed', { id: p.id, customer: info.name, branch: info.branch, vehicle: info.fleet_number, photo_url: p.arrival_photo_url, at: ts, driver: req.user.name });
      io.to('customer:' + p.customer_id).emit('pickup:completed', { id: p.id });
    }
    try { await v3.onPickupCompleted(p.id); } catch (e) { console.warn('onPickupCompleted', e.message); }
    res.json({ ok: true, status: 'collected', at: ts, ...jobTimes({ ...p, completed_at: ts }) });
  });

  // ── REPORT: an issue (site closed, no access …) → customer confirms within 24 h ──
  r.post('/pickups/:id/issue', auth('driver'), async (req, res) => {
    const reason = String((req.body || {}).reason || '');
    if (!NPU_REASONS.includes(reason)) return res.status(400).json({ error: 'Choose what the problem is' });
    const p = await arrivedJob(req, res); if (!p) return;
    const ts = nowIso();
    await prisma.pickup.update({
      where: { id: p.id },
      data: {
        status: 'canceled', anomaly_reason: reason, gps_lat: p.arrival_lat, gps_lng: p.arrival_lng, photo_url: p.arrival_photo_url,
        photo_taken_at: p.arrived_at, proof_meta: proofMeta(p, { on_site_s: secs(p.arrived_at, ts) }), completed_at: ts, updated_at: sqlNow(),
      },
    });
    await v3.onNotPickedUp(p.id);
    const info = await stopInfo(p);
    const msg = `NOT PICKED UP: ${info.name} (${info.branch}) — ${reason.replace(/_/g, ' ')} (by ${req.user.name}) · awaiting customer confirmation`;
    await prisma.alert.create({ data: { type: 'ANOMALY', severity: 'warning', message: msg, pickup_id: p.id } });
    if (io) {
      io.to('staff').emit('pickup:canceled', { id: p.id, customer: info.name, branch: info.branch, reason, driver: req.user.name });
      io.to('staff').emit('alert', { type: 'ANOMALY', severity: 'warning', message: msg, pickup_id: p.id });
    }
    res.json({ ok: true, status: 'canceled', confirmation_status: 'awaiting', ...jobTimes({ ...p, completed_at: ts }) });
  });

  // ── OFFICE: who is on shift, and how long each job took ──
  r.get('/shifts', auth('admin'), async (req, res) => {
    const date = security.isRealDate(req.query.date || '') ? req.query.date : ymd();
    let drivers = await prisma.user.findMany({ where: { role: 'driver', is_active: 1 }, select: { id: true, full_name: true, vehicle_id: true } });
    drivers = await join(drivers, 'vehicle_id', 'vehicle', ['fleet_number']);
    // ORDER BY v.fleet_number, u.full_name  (no fleet number sorts first, like SQL NULLs)
    sortBy(drivers, d => d.fleet_number, d => d.full_name);
    const rows = [];
    for (const d of drivers) {
      const shifts = (await prisma.driverShift.findMany({ where: { driver_id: d.id, work_date: date }, orderBy: { id: 'asc' } })).map(shiftView);
      rows.push({ driver_id: d.id, driver: d.full_name, vehicle_id: d.vehicle_id, fleet_number: d.fleet_number, shifts,
        on_shift: shifts.some(s => s.open), shift_s: shifts.reduce((a, s) => a + (s.duration_s || 0), 0), ...(await daySummary(d.id, date)) });
    }
    res.json({ date, server_now: nowIso(), rows });
  });
}

module.exports = { mountDriverShiftRoutes, onJobStarted, jobTimes, daySummary, clockIn, openShift, NPU_REASONS };
