// ─────────────────────────────────────────────────────────────
// Fleet Tracker v3.2 — vehicle issues, service maintenance & expenses
//
//   Driver app   reports a vehicle issue (tyre damage, oil change due, service,
//                brakes, battery …) with a photo, odometer and — if the driver
//                paid on the spot — the amount and a receipt photo.
//   Admin CRM    sees every report live, moderates it (approve → in progress →
//                resolved / rejected), records cost, workshop and payment proof,
//                and gets a full service history + expense totals per vehicle.
//   Capacity     per-vehicle default and per-day overrides (see capacity.js).
// ─────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { prisma, join, findById, sortBy, desc, now: sqlNow } = require('./db');
const security = require('./security');
const capacity = require('./capacity');

let push = null;
try { push = require('./push'); } catch { push = null; }

security.ensureSecret();
const SECRET = process.env.JWT_SECRET;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: security.safeImageName('fleet') }),
  fileFilter: security.imageFileFilter,
  limits: { fileSize: 12 * 1024 * 1024, files: 2 },
});
const files = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'receipt', maxCount: 1 }]);

// category → label, whether it is routine maintenance, default urgency
const CATEGORIES = {
  TIRE: { label: 'Tyre damage / puncture', kind: 'issue' },
  OIL: { label: 'Oil change / oil maintenance', kind: 'maintenance' },
  SERVICE: { label: 'Periodic service', kind: 'maintenance' },
  BRAKES: { label: 'Brakes', kind: 'issue' },
  BATTERY: { label: 'Battery / electrical', kind: 'issue' },
  ENGINE: { label: 'Engine / warning light', kind: 'issue' },
  AC: { label: 'A/C / cooling', kind: 'issue' },
  BODY: { label: 'Body damage / accident', kind: 'issue' },
  FUEL: { label: 'Fuel', kind: 'expense' },
  OTHER: { label: 'Other', kind: 'issue' },
};
const STATUSES = ['open', 'approved', 'in_progress', 'resolved', 'rejected'];
const URGENCY = ['low', 'normal', 'high', 'off_road'];
const PAY_METHODS = ['cash', 'card', 'transfer', 'cheque', 'fuel_card', 'company_account'];
const PAID_BY = ['company', 'driver'];

// Collection: vehicle_reports (see prisma/schema.prisma).

// ── helpers ──────────────────────────────────────────────────
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
const isOwner = (u) => u && u.role === 'admin' && u.crm_role !== 'ops';
const ownerOnly = (req, res, next) => (isOwner(req.user) ? next() : res.status(403).json({ error: 'Only the owner can do this' }));

const txt = (s, n = 500) => String(s ?? '').trim().slice(0, n);
const money = (n) => Math.round(Number(n) * 100) / 100;
const dmy = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || ''); };
const today = () => new Date().toISOString().slice(0, 10);
const fileUrl = (req, name) => { const f = req.files && req.files[name] && req.files[name][0]; return f ? `/uploads/${f.filename}` : null; };
const dropFiles = (req) => { Object.values(req.files || {}).flat().forEach((f) => fs.unlink(f.path, () => {})); };

// number or null; returns undefined when the value is present but invalid
function num(v, { min = 0, max = 1e7, int = false } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) return undefined;
  return n;
}
function dateOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  return security.isRealDate(String(v)) ? String(v) : undefined;
}

function view(r) {
  if (!r) return null;
  const c = CATEGORIES[r.category] || CATEGORIES.OTHER;
  return {
    ...r,
    category_label: c.label, kind: c.kind,
    has_payment_proof: !!r.receipt_url,
    // an expense with a cost but no receipt is flagged for the office
    proof_missing: r.cost > 0 && !r.receipt_url,
    reimbursement_due: r.paid_by === 'driver' && r.cost > 0 && !r.reimbursed && r.status !== 'rejected',
  };
}
// reports + vehicle fleet number / plate (JOIN) + driver name (LEFT JOIN)
async function withNames(rows) {
  rows = await join(rows, 'vehicle_id', 'vehicle', ['fleet_number', 'plate'], { inner: true });
  return join(rows, 'driver_id', 'user', { driver: 'full_name' });
}
const getReport = async (id) => {
  const r = await prisma.vehicleReport.findUnique({ where: { id } });
  return r ? view((await withNames([r]))[0]) : null;
};
// date a report counts for: COALESCE(service_date, substr(reported_at,1,10))
const reportDay = (r) => r.service_date || String(r.reported_at).slice(0, 10);

async function alertCrm(io, type, severity, message) {
  await prisma.alert.create({ data: { type, severity, message, pickup_id: null } });
  if (io) io.to('staff').emit('alert', { type, severity, message });
}
function notifyDriver(io, driverId, title, body) {
  if (!driverId) return;
  if (io) io.to('driver:' + driverId).emit('driver:notify', { kind: 'info', title, body });
  if (push) push.sendPush('driver', driverId, title, body, '/driver/#vehicle').catch(() => {});
}

async function vehicleSummary(vehicleId) {
  const rows = await prisma.vehicleReport.findMany({ where: { vehicle_id: vehicleId, status: { not: 'rejected' } }, orderBy: { id: 'asc' } });
  const month = today().slice(0, 7), year = today().slice(0, 4);
  const when = (r) => r.service_date || String(r.reported_at).slice(0, 10);
  const spend = (f) => money(rows.filter((r) => r.cost > 0 && f(r)).reduce((a, r) => a + r.cost, 0));
  const last = (cat) => rows.filter((r) => r.category === cat && r.status === 'resolved').sort((a, b) => when(b).localeCompare(when(a)))[0] || null;
  const odo = rows.reduce((m, r) => Math.max(m, r.odometer_km || 0), 0) || null;
  const due = rows.filter((r) => r.status === 'resolved' && (r.next_due_date || r.next_due_km))
    .sort((a, b) => when(b).localeCompare(when(a)));
  // the newest resolved record per category carries the "next due" reminder
  const nextDue = [];
  const seen = new Set();
  for (const r of due) {
    if (seen.has(r.category)) continue; seen.add(r.category);
    const overdue = (r.next_due_date && r.next_due_date < today()) || (r.next_due_km && odo && odo >= r.next_due_km);
    const soon = !overdue && ((r.next_due_date && r.next_due_date <= addDays(today(), 14)) || (r.next_due_km && odo && r.next_due_km - odo <= 500));
    nextDue.push({ category: r.category, label: (CATEGORIES[r.category] || CATEGORIES.OTHER).label, next_due_date: r.next_due_date, next_due_km: r.next_due_km, state: overdue ? 'overdue' : soon ? 'due_soon' : 'ok' });
  }
  const pick = (r) => r && { date: when(r), odometer_km: r.odometer_km, vendor: r.vendor };
  return {
    open: rows.filter((r) => ['open', 'approved', 'in_progress'].includes(r.status)).length,
    off_road: rows.some((r) => r.urgency === 'off_road' && ['open', 'approved', 'in_progress'].includes(r.status)),
    spend_month: spend((r) => when(r).startsWith(month)),
    spend_year: spend((r) => when(r).startsWith(year)),
    spend_total: spend(() => true),
    last_odometer_km: odo,
    last_oil_change: pick(last('OIL')), last_service: pick(last('SERVICE')), last_tire: pick(last('TIRE')),
    next_due: nextDue,
  };
}
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ═════════════════════════ ROUTES ════════════════════════════
function mountFleetMaintenanceRoutes(r, io) {
  r.get('/fleet/maintenance/categories', auth('admin', 'driver'), (req, res) => {
    res.json({ categories: Object.entries(CATEGORIES).map(([code, c]) => ({ code, ...c })), statuses: STATUSES, urgency: URGENCY, pay_methods: PAY_METHODS });
  });

  // ── DRIVER: report an issue / expense on the assigned vehicle ──
  r.post('/driver/vehicle-reports', auth('driver'), files, async (req, res) => {
    const b = req.body || {};
    const fail = (code, msg) => { dropFiles(req); return res.status(code).json({ error: msg }); };
    const me = await prisma.user.findFirst({ where: { id: req.user.id, role: 'driver', is_active: 1 }, select: { id: true, full_name: true, vehicle_id: true } });
    if (!me) return fail(403, 'Driver account not active');
    if (!me.vehicle_id) return fail(409, 'No vehicle is assigned to you — ask the office');
    const v = await prisma.vehicle.findUnique({ where: { id: me.vehicle_id } });
    if (!v) return fail(409, 'Assigned vehicle not found');
    if (!CATEGORIES[b.category]) return fail(400, 'Choose what the report is about');
    const urgency = URGENCY.includes(b.urgency) ? b.urgency : 'normal';
    const odo = num(b.odometer_km, { max: 2e6, int: true });
    if (odo === undefined) return fail(400, 'Odometer must be a whole number of km');
    const cost = num(b.cost, { max: 100000 });
    if (cost === undefined) return fail(400, 'Amount must be a number between 0 and 100,000');
    const receipt = fileUrl(req, 'receipt'), photo = fileUrl(req, 'photo');
    // money without proof is not accepted from the driver app
    if (cost > 0 && !receipt) return fail(400, 'Add a photo of the receipt as payment proof');
    if (['TIRE', 'BODY'].includes(b.category) && !photo) return fail(400, 'Add a photo of the damage');
    const method = cost > 0 ? (PAY_METHODS.includes(b.payment_method) ? b.payment_method : 'cash') : null;
    const paidBy = cost > 0 ? (method === 'fuel_card' || method === 'company_account' ? 'company' : 'driver') : null;

    const saved = await prisma.vehicleReport.create({
      data: {
        vehicle_id: v.id, driver_id: me.id, source: 'driver', category: b.category, urgency, description: txt(b.description), odometer_km: odo,
        photo_url: photo, cost: cost || null, paid_by: paidBy, payment_method: method, receipt_url: receipt, service_date: cost > 0 ? today() : null,
      },
    });
    const rep = await getReport(saved.id);
    const sev = urgency === 'off_road' ? 'critical' : urgency === 'high' ? 'warning' : 'info';
    await alertCrm(io, 'VEHICLE_ISSUE', sev,
      `${v.fleet_number}: ${rep.category_label} reported by ${me.full_name}` +
      `${urgency === 'off_road' ? ' — VEHICLE CANNOT DRIVE. Reschedule its stops or set today\'s capacity to 0.' : ''}` +
      `${cost > 0 ? ` · paid AED ${money(cost).toFixed(2)} (${method.replace('_', ' ')})` : ''}${rep.description ? ` · “${rep.description}”` : ''}`);
    if (io) io.to('staff').emit('fleet:report', { id: rep.id, vehicle_id: v.id });
    res.json({ ok: true, report: rep });
  });

  r.get('/driver/vehicle-reports', auth('driver'), async (req, res) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { vehicle_id: true } });
    const v = me && me.vehicle_id ? await prisma.vehicle.findUnique({ where: { id: me.vehicle_id }, select: { id: true, fleet_number: true, plate: true } }) : null;
    // a driver sees the reports on the current vehicle plus anything they filed themselves
    const rows = await withNames(await prisma.vehicleReport.findMany({ where: { OR: [{ driver_id: req.user.id }, { vehicle_id: v ? v.id : -1 }] }, orderBy: { id: 'desc' }, take: 40 }));
    res.json({
      vehicle: v,
      summary: v ? await vehicleSummary(v.id) : null,
      rows: rows.map(view),
    });
  });

  // ── ADMIN: list + dashboard numbers ──
  r.get('/fleet/maintenance', auth('admin'), async (req, res) => {
    // build the Prisma `where` object step by step (instead of SQL text)
    const where = {};
    if (req.query.vehicle_id) where.vehicle_id = Number.isInteger(Number(req.query.vehicle_id)) ? Number(req.query.vehicle_id) : -1;
    if (STATUSES.includes(req.query.status)) where.status = req.query.status;
    if (req.query.status === 'active') where.status = { in: ['open', 'approved', 'in_progress'] };
    if (CATEGORIES[req.query.category]) where.category = req.query.category;
    let list = await prisma.vehicleReport.findMany({ where });
    // the date filters use COALESCE(service_date, day of reported_at) → applied in JS
    if (security.isRealDate(req.query.from || '')) list = list.filter((x) => reportDay(x) >= req.query.from);
    if (security.isRealDate(req.query.to || '')) list = list.filter((x) => reportDay(x) <= req.query.to);
    const rank = { open: 0, approved: 1, in_progress: 2 };
    sortBy(list, (x) => rank[x.status] ?? 3, desc((x) => x.id));
    const rows = (await withNames(list.slice(0, 500))).map(view);
    const vehicles = [];
    for (const v of await prisma.vehicle.findMany({ orderBy: { fleet_number: 'asc' } }))
      vehicles.push({ id: v.id, fleet_number: v.fleet_number, plate: v.plate, zone: v.zone, is_active: v.is_active, ...(await vehicleSummary(v.id)) });
    const all = await prisma.vehicleReport.findMany({ where: { status: { not: 'rejected' } } });
    const month = today().slice(0, 7);
    const when = (x) => x.service_date || String(x.reported_at).slice(0, 10);
    const byCat = {};
    all.filter((x) => x.cost > 0 && when(x).startsWith(month)).forEach((x) => { byCat[x.category] = money((byCat[x.category] || 0) + x.cost); });
    res.json({
      rows, vehicles,
      summary: {
        open: all.filter((x) => x.status === 'open').length,
        in_progress: all.filter((x) => ['approved', 'in_progress'].includes(x.status)).length,
        off_road: vehicles.filter((v) => v.off_road).length,
        spend_month: money(all.filter((x) => x.cost > 0 && when(x).startsWith(month)).reduce((a, x) => a + x.cost, 0)),
        proof_missing: all.filter((x) => x.cost > 0 && !x.receipt_url).length,
        reimbursement_due: money(all.filter((x) => x.paid_by === 'driver' && x.cost > 0 && !x.reimbursed).reduce((a, x) => a + x.cost, 0)),
        spend_by_category: Object.entries(byCat).map(([code, amount]) => ({ code, label: CATEGORIES[code].label, amount })).sort((a, b) => b.amount - a.amount),
        due: vehicles.flatMap((v) => v.next_due.filter((d) => d.state !== 'ok').map((d) => ({ ...d, vehicle_id: v.id, fleet_number: v.fleet_number }))),
      },
    });
  });

  // full service history of one vehicle
  r.get('/fleet/maintenance/vehicle/:id', auth('admin'), async (req, res) => {
    const v = await findById('vehicle', req.params.id);
    if (!v) return res.status(404).json({ error: 'Vehicle not found' });
    const list = sortBy(await prisma.vehicleReport.findMany({ where: { vehicle_id: v.id } }), desc(reportDay), desc((x) => x.id)).slice(0, 500);
    res.json({
      vehicle: v, summary: await vehicleSummary(v.id),
      history: (await withNames(list)).map(view),
    });
  });

  // office logs a service / expense directly (e.g. workshop invoice)
  r.post('/fleet/maintenance', auth('admin'), files, async (req, res) => {
    const b = req.body || {};
    const fail = (code, msg) => { dropFiles(req); return res.status(code).json({ error: msg }); };
    const v = await findById('vehicle', b.vehicle_id);
    if (!v) return fail(400, 'Choose a vehicle');
    if (!CATEGORIES[b.category]) return fail(400, 'Choose a category');
    const p = parseDetails(b);
    if (p.error) return fail(400, p.error);
    const status = STATUSES.includes(b.status) ? b.status : 'resolved';
    const saved = await prisma.vehicleReport.create({
      data: {
        vehicle_id: v.id, driver_id: null, source: 'office', category: b.category, urgency: URGENCY.includes(b.urgency) ? b.urgency : 'normal',
        description: txt(b.description), odometer_km: p.odometer_km ?? null, photo_url: fileUrl(req, 'photo'), status,
        service_date: p.service_date ?? today(), vendor: p.vendor ?? null, work_done: p.work_done ?? null, cost: p.cost ?? null,
        paid_by: p.paid_by ?? (p.cost > 0 ? 'company' : null), payment_method: p.payment_method ?? null, payment_ref: p.payment_ref ?? null,
        receipt_url: fileUrl(req, 'receipt'), next_due_date: p.next_due_date ?? null, next_due_km: p.next_due_km ?? null, admin_note: p.admin_note ?? null,
        resolved_at: status === 'resolved' ? new Date().toISOString() : null, resolved_by: status === 'resolved' ? String(req.user.name) : null,
      },
    });
    if (io) io.to('staff').emit('fleet:report', { id: saved.id, vehicle_id: v.id });
    res.json({ ok: true, report: await getReport(saved.id) });
  });

  // moderate a report: status, cost, workshop, payment details, next-due reminder
  r.put('/fleet/maintenance/:id', auth('admin'), async (req, res) => {
    const cur = await findById('vehicleReport', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Report not found' });
    const b = req.body || {};
    if (b.status !== undefined && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
    const p = parseDetails(b);
    if (p.error) return res.status(400).json({ error: p.error });
    const next = { ...cur };
    for (const k of ['service_date', 'vendor', 'work_done', 'cost', 'paid_by', 'payment_method', 'payment_ref', 'next_due_date', 'next_due_km', 'admin_note', 'odometer_km'])
      if (p[k] !== undefined) next[k] = p[k];
    if (b.urgency !== undefined && URGENCY.includes(b.urgency)) next.urgency = b.urgency;
    if (b.reimbursed !== undefined) {
      if (!isOwner(req.user)) return res.status(403).json({ error: 'Only the owner can mark a reimbursement as paid' });
      next.reimbursed = b.reimbursed ? 1 : 0;
    }
    if (b.status) next.status = b.status;
    if (next.status === 'rejected' && !txt(next.admin_note)) return res.status(400).json({ error: 'Add a note telling the driver why it was rejected' });
    if (next.status === 'resolved' && cur.status !== 'resolved') { next.resolved_at = new Date().toISOString(); next.resolved_by = req.user.name; next.service_date = next.service_date || today(); }
    if (next.status !== 'resolved') { next.resolved_at = null; next.resolved_by = null; }
    if (next.cost > 0 && !next.paid_by) next.paid_by = 'company';

    const fields = ['status', 'urgency', 'service_date', 'vendor', 'work_done', 'cost', 'paid_by', 'payment_method', 'payment_ref', 'reimbursed',
      'next_due_date', 'next_due_km', 'admin_note', 'odometer_km', 'resolved_at', 'resolved_by'];
    const data = Object.fromEntries(fields.map((k) => [k, next[k] ?? null]));
    data.status = next.status; data.urgency = next.urgency; data.reimbursed = next.reimbursed ? 1 : 0;   // required fields
    if (data.resolved_by != null) data.resolved_by = String(data.resolved_by);
    await prisma.vehicleReport.update({ where: { id: cur.id }, data: { ...data, updated_at: sqlNow() } });

    const rep = await getReport(cur.id);
    if (next.status !== cur.status) {
      const word = { approved: 'approved', in_progress: 'being worked on', resolved: 'resolved', rejected: 'not approved', open: 're-opened' }[next.status];
      notifyDriver(io, cur.driver_id, `Vehicle report ${word}`, `${rep.fleet_number} · ${rep.category_label}${next.admin_note ? ' — ' + next.admin_note : ''}`);
    } else if (b.reimbursed && !cur.reimbursed) {
      notifyDriver(io, cur.driver_id, 'Expense reimbursed', `${rep.fleet_number} · ${rep.category_label} · AED ${money(rep.cost || 0).toFixed(2)}`);
    }
    if (io) io.to('staff').emit('fleet:report', { id: cur.id, vehicle_id: cur.vehicle_id });
    res.json({ ok: true, report: rep });
  });

  // attach / replace the payment proof (receipt photo) or the issue photo
  r.post('/fleet/maintenance/:id/proof', auth('admin'), files, async (req, res) => {
    const cur = await findById('vehicleReport', req.params.id);
    if (!cur) { dropFiles(req); return res.status(404).json({ error: 'Report not found' }); }
    const receipt = fileUrl(req, 'receipt'), photo = fileUrl(req, 'photo');
    if (!receipt && !photo) return res.status(400).json({ error: 'Attach a photo of the receipt (JPEG, PNG, WebP or HEIC)' });
    // SQL COALESCE(?, receipt_url): only overwrite what was uploaded
    await prisma.vehicleReport.update({ where: { id: cur.id }, data: { receipt_url: receipt ?? cur.receipt_url, photo_url: photo ?? cur.photo_url, updated_at: sqlNow() } });
    res.json({ ok: true, report: await getReport(cur.id) });
  });

  // ── CAPACITY MODERATION ──────────────────────────────────────
  // vehicle default (replaces the fixed 15)
  r.put('/fleet/capacity/default', auth('admin'), ownerOnly, async (req, res) => {
    const v = await findById('vehicle', (req.body || {}).vehicle_id);
    if (!v) return res.status(404).json({ error: 'Vehicle not found' });
    const cap = Number((req.body || {}).capacity);
    if (!capacity.validCapacity(cap) || cap < 1) return res.status(400).json({ error: `Default capacity must be a whole number from 1 to ${capacity.MAX_CAPACITY}` });
    await prisma.vehicle.update({ where: { id: v.id }, data: { max_daily_capacity: cap } });
    if (io) io.to('staff').emit('ledger:refresh', {});
    res.json({ ok: true, vehicle_id: v.id, capacity: cap, previous: v.max_daily_capacity });
  });

  // one-day override (workshop day → 0, extra helper → more)
  r.put('/fleet/capacity/override', auth('admin'), async (req, res) => {
    const b = req.body || {};
    const v = await findById('vehicle', b.vehicle_id);
    if (!v) return res.status(404).json({ error: 'Vehicle not found' });
    const dErr = security.dateInRange(b.date, { pastDays: 0, futureDays: 366 });
    if (dErr) return res.status(400).json({ error: dErr });
    const cap = Number(b.capacity);
    if (!capacity.validCapacity(cap)) return res.status(400).json({ error: `Capacity must be a whole number from ${capacity.MIN_CAPACITY} to ${capacity.MAX_CAPACITY}` });
    const reason = txt(b.reason, 200);
    if (cap !== v.max_daily_capacity && !reason) return res.status(400).json({ error: 'Add a short reason (e.g. "oil change at workshop")' });
    await capacity.setOverride(v.id, b.date, cap, reason, req.user.name);
    const load = await capacity.loadOf(v.id, b.date);
    const overBy = Math.max(0, load - cap);
    if (overBy > 0) await alertCrm(io, 'CAPACITY', 'warning', `${v.fleet_number} on ${dmy(b.date)}: capacity set to ${cap} but ${load} stops are scheduled — reschedule ${overBy} stop(s).`);
    if (io) io.to('staff').emit('ledger:refresh', { date: b.date });
    res.json({ ok: true, vehicle_id: v.id, date: b.date, capacity: cap, load, over_by: overBy });
  });
  r.delete('/fleet/capacity/override', auth('admin'), async (req, res) => {
    const b = { ...(req.query || {}), ...(req.body || {}) };
    const vid = Number(b.vehicle_id);
    const n = Number.isInteger(vid) ? await capacity.clearOverride(vid, String(b.date || '')) : 0;
    if (io) io.to('staff').emit('ledger:refresh', { date: b.date });
    res.json({ ok: true, removed: n });
  });
}

// shared validation for the office-side fields; only keys present in the body are returned
function parseDetails(b) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (has('cost')) { const c = num(b.cost, { max: 1e6 }); if (c === undefined) return { error: 'Cost must be a number (AED)' }; out.cost = c === null ? null : money(c); }
  if (has('odometer_km')) { const o = num(b.odometer_km, { max: 2e6, int: true }); if (o === undefined) return { error: 'Odometer must be a whole number of km' }; out.odometer_km = o; }
  if (has('next_due_km')) { const o = num(b.next_due_km, { max: 2e6, int: true }); if (o === undefined) return { error: 'Next-due odometer must be a whole number of km' }; out.next_due_km = o; }
  if (has('service_date')) { const d = dateOrNull(b.service_date); if (d === undefined) return { error: 'Service date is not a real date' }; if (d && d > today()) return { error: 'Service date cannot be in the future' }; out.service_date = d; }
  if (has('next_due_date')) { const d = dateOrNull(b.next_due_date); if (d === undefined) return { error: 'Next-due date is not a real date' }; out.next_due_date = d; }
  if (has('payment_method')) { if (b.payment_method && !PAY_METHODS.includes(b.payment_method)) return { error: 'Unknown payment method' }; out.payment_method = b.payment_method || null; }
  if (has('paid_by')) { if (b.paid_by && !PAID_BY.includes(b.paid_by)) return { error: 'Paid by must be company or driver' }; out.paid_by = b.paid_by || null; }
  for (const k of ['vendor', 'payment_ref']) if (has(k)) out[k] = txt(b[k], 120) || null;
  for (const k of ['work_done', 'admin_note']) if (has(k)) out[k] = txt(b[k], 500) || null;
  return out;
}

module.exports = { mountFleetMaintenanceRoutes, CATEGORIES, STATUSES, vehicleSummary };
