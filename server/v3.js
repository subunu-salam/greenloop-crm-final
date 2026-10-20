// ─────────────────────────────────────────────────────────────
// GreenLoop v3 — PRD v1.0 additions
//   Sales:      leads (CRM-09), quotations (CRM-10/11), convert (CRM-12),
//               service catalogue (CRM-13), pipeline (CRM-16)
//   Billing:    invoices + payments (CRM-14, CUS-08)
//   Engine:     recurring service plans, 14-day generation, zone/capacity
//               allocation, pest-control tagging, UAE holidays (§7)
//   Proof:      live-camera GPS/time/stamp validation (DRV-06/07)
//   Exceptions: "Not picked up" → Awaiting customer confirmation (§7, CUS-10)
//   Timers:     per-stop time windows + at-risk alerts (DRV-11)
//   Access:     Ops staff role (CRM-17), audit log (CRM-18), OTP login (CUS-01)
// MongoDB through Prisma (see server/db.js). Every database call is awaited.
// ─────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const security = require('./security');
const { prisma, getSetting, setSetting, join, groupBy, findById, toId, int, str, sortBy, desc, cmp, now: sqlNow, MODELS } = require('./db');

let push = null;
try { push = require('./push'); } catch { push = null; }
const mailer = require('./mailer');
const contacts = require('./contacts');

require('./security').ensureSecret();
const SECRET = process.env.JWT_SECRET;
const VAT_RATE = 0.05;
const PROOF_RADIUS_M = Number(process.env.PROOF_RADIUS_M || 150);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PHOTO_MAX_AGE_MIN = Number(process.env.PHOTO_MAX_AGE_MIN || 15);
const CONFIRM_WINDOW_H = 24;

// ── helpers ──────────────────────────────────────────────────
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const nowIso = () => new Date().toISOString();
// Dates are shown to people as DD/MM/YYYY everywhere (stored as YYYY-MM-DD).
const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || '—'); };
const money = n => Math.round(Number(n || 0) * 100) / 100;
const J = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
function haversineM(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function waLink(phone, text) {
  const num = String(phone || '').replace(/[^\d]/g, '');
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}
const mapsDir = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
// the sites of one customer account: the account holder + every site linked to it
const accountSites = (acct) => ({ OR: [{ id: acct }, { account_id: acct }] });
async function accountSiteIds(acct) {
  return (await prisma.customer.findMany({ where: accountSites(acct), select: { id: true } })).map(c => c.id);
}

// ── first-run data (MongoDB creates collections on first write; no CREATE TABLE needed) ──
async function init() {
  if (!(await prisma.serviceType.findFirst({ select: { id: true } }))) {
    const T = (code, name, category, default_duration_min, default_price, list) =>
      ({ code, name, category, default_duration_min, default_price, checklist: JSON.stringify(list) });
    await prisma.serviceType.createMany({
      data: [
        T('WASTE', 'Machari waste pickup', 'waste', 20, 150, ['Bins emptied', 'Area left clean']),
        T('WASTE_BULK', 'Bulk / extra waste removal', 'waste', 40, 350, ['Waste loaded', 'Area left clean']),
        T('PEST_GENERAL', 'General pest control treatment', 'pest', 45, 400, ['Areas treated', 'Chemicals used recorded', 'Next visit agreed']),
        T('PEST_TERMITE', 'Termite treatment', 'pest', 90, 900, ['Areas treated', 'Chemicals used recorded', 'Next visit agreed']),
      ],
    });
  }
  if (!(await getSetting('uae_holidays', ''))) {
    // Approximate 2026 dates (lunar holidays shift) — edit in Settings when officially announced.
    await setSetting('uae_holidays', JSON.stringify([
      '2026-01-01', '2026-03-19', '2026-03-20', '2026-03-21', '2026-05-26', '2026-05-27', '2026-05-28',
      '2026-05-29', '2026-06-16', '2026-08-25', '2026-12-01', '2026-12-02', '2026-12-03']));
  }
  if (!(await getSetting('default_time_window', ''))) await setSetting('default_time_window', '07:00-12:00');
  if (!(await getSetting('invoice_due_days', ''))) await setSetting('invoice_due_days', '15');
  if (!(await getSetting('company_whatsapp', ''))) await setSetting('company_whatsapp', '+971500000001');
  await prisma.vehicle.updateMany({ where: { service_tags: null }, data: { service_tags: 'waste' } });
  await prisma.user.updateMany({ where: { role: 'admin', crm_role: null }, data: { crm_role: 'owner' } });
}

// ── auth ─────────────────────────────────────────────────────
function decode(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.query && req.query.t) || null;
  if (!t) return null;
  try { return jwt.verify(t, SECRET); } catch { return null; }
}
const need = (...roles) => (req, res, next) => {
  const p = decode(req);
  if (!p) return res.status(401).json({ error: 'Missing or invalid token' });
  const eff = p.role === 'admin' ? (p.crm_role === 'ops' ? 'ops' : 'admin') : p.role;
  if (!roles.includes(eff)) return res.status(403).json({ error: 'Your role cannot do this' });
  req.user = { ...p, eff };
  next();
};
const staff = need('admin', 'ops');
const owner = need('admin');
const cust = need('customer');
const custId = req => req.user.customer_id || req.user.id;
const actorName = u => u ? `${u.name || 'user'} (${u.eff || u.role})` : 'system';

// ── ops guard + generic audit for legacy routes (mounted before api.js) ──
const OPS_BLOCK = [
  [/^\/users/, 'ALL'], [/^\/settings/, 'ALL'], [/^\/vehicles/, 'WRITE'], [/^\/audit/, 'ALL'],
  [/^\/reports\/(finance|revenue)/, 'ALL'], [/^\/invoices/, 'WRITE'], [/^\/payments/, 'WRITE'],
  [/^\/service-types/, 'WRITE'], [/^\/schedule\/generate/, 'WRITE'],
];
function guard(req, res, next) {
  const p = decode(req);
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (p && p.role === 'admin' && p.crm_role === 'ops') {
    const hit = OPS_BLOCK.find(([rx, mode]) => rx.test(req.path) && (mode === 'ALL' || write));
    if (hit) return res.status(403).json({ error: 'Ops staff role cannot access this section' });
  }
  if (write && p && p.role === 'admin') {
    res.on('finish', () => {
      if (res.statusCode >= 400 || req._audited) return;
      const body = { ...(req.body || {}) };
      ['password', 'pin', 'csv', 'photo'].forEach(k => { if (k in body) body[k] = '[redacted]'; });
      // fire-and-forget: the response has already gone out; a failed audit write is only logged
      prisma.auditLog.create({
        data: {
          actor: actorName({ ...p, eff: p.crm_role === 'ops' ? 'ops' : 'admin' }),
          entity: req.path.split('/')[1] || 'api', entity_id: (req.path.match(/\/(\d+)/) || [])[1] || null,
          action: `${req.method} ${req.path}`, after: JSON.stringify(body).slice(0, 4000),
        },
      }).catch(() => { /* ignore */ });
    });
  }
  next();
}
async function audit(req, entity, id, action, before, after) {
  if (req) req._audited = true;
  await prisma.auditLog.create({
    data: {
      actor: req ? actorName(req.user) : 'system', entity, entity_id: id == null ? null : String(id), action,
      before: before ? JSON.stringify(before).slice(0, 4000) : null, after: after ? JSON.stringify(after).slice(0, 4000) : null,
    },
  });
}

// ── notifications ────────────────────────────────────────────
let IO = null;
async function alertCrm(type, severity, message, pickupId = null) {
  await prisma.alert.create({ data: { type, severity, message, pickup_id: pickupId } });
  if (IO) IO.to('staff').emit('alert', { type, severity, message, pickup_id: pickupId });
}
async function notifyCustomer(customerId, kind, title, body, link = '/customer/') {
  await prisma.customerNotification.create({ data: { customer_id: customerId, kind, title, body, link } });
  if (IO) IO.to('customer:' + customerId).emit('customer:notify', { kind, title, body });
  // returns the push delivery report so callers can show "delivered to N device(s)"
  if (!push) return { devices: 0, delivered: 0, failed: 0, removed: 0 };
  return push.sendPush('customer', customerId, title, body, link).catch(() => ({ devices: 0, delivered: 0, failed: 0, removed: 0 }));
}
// Push + live in-app alert for the driver(s) of a vehicle.
async function notifyVehicleDrivers(vehicleId, title, body) {
  if (!vehicleId) return;
  try {
    const drivers = await prisma.user.findMany({ where: { role: 'driver', is_active: 1, vehicle_id: vehicleId }, select: { id: true } });
    drivers.forEach(d => { if (IO) IO.to('driver:' + d.id).emit('driver:notify', { kind: 'info', title, body }); });
  } catch { /* ignore */ }
  if (push) push.sendToVehicleDrivers(vehicleId, title, body).catch(() => {});
}

// ── recurrence engine (§7) ───────────────────────────────────
// rule: {type:'daily', weekdays_only?:bool}
//       {type:'weekly', days:[0..6]}   (0 = Sunday)
//       {type:'monthly', mode:'date', date:1..28} | {type:'monthly', mode:'nth', n:1..5|-1, weekday:0..6}
function occursOn(rule, dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(), dom = d.getUTCDate();
  if (!rule || !rule.type) return false;
  if (rule.type === 'daily') return rule.weekdays_only ? (dow >= 1 && dow <= 5) : true; // UAE weekend = Sat/Sun
  if (rule.type === 'weekly') return Array.isArray(rule.days) && rule.days.map(Number).includes(dow);
  if (rule.type === 'monthly') {
    if (rule.mode === 'nth') {
      if (dow !== Number(rule.weekday)) return false;
      const n = Number(rule.n);
      if (n === -1) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom + 7)).getUTCMonth() !== d.getUTCMonth();
      return Math.ceil(dom / 7) === n;
    }
    // several visits a month: {dates:[1,15]}; a single visit keeps the older {date:1} shape
    const dates = Array.isArray(rule.dates) && rule.dates.length ? rule.dates : [rule.date];
    return dates.some(x => dom === Math.min(28, Math.max(1, Number(x) || 1)));
  }
  return false;
}
function describeRule(r) {
  const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (!r) return '—';
  if (r.type === 'daily') return r.weekdays_only ? 'Daily (Mon–Fri)' : 'Daily';
  if (r.type === 'weekly') return 'Weekly · ' + (r.days || []).map(x => D[x]).join(', ');
  if (r.type === 'monthly' && r.mode === 'nth') return `Monthly · ${r.n == -1 ? 'last' : ['', '1st', '2nd', '3rd', '4th', '5th'][r.n]} ${D[r.weekday]}`;
  if (r.type === 'monthly' && Array.isArray(r.dates) && r.dates.length > 1) return `Monthly · days ${r.dates.join(', ')}`;
  if (r.type === 'monthly') return `Monthly · day ${r.date}`;
  return '—';
}
function validateRule(r) {
  if (!r || !['daily', 'weekly', 'monthly'].includes(r.type)) return 'recurrence.type must be daily, weekly or monthly';
  if (r.type === 'weekly' && (!Array.isArray(r.days) || !r.days.length || r.days.some(x => x < 0 || x > 6))) return 'Weekly plans need at least one day (0–6)';
  if (r.type === 'monthly' && r.mode === 'nth' && (![1, 2, 3, 4, 5, -1].includes(Number(r.n)) || !(r.weekday >= 0 && r.weekday <= 6))) return 'Monthly nth-weekday needs n (1–5 or -1) and weekday (0–6)';
  if (r.type === 'monthly' && r.mode !== 'nth' && Array.isArray(r.dates) && r.dates.length) {
    if (r.dates.length > 28 || r.dates.some(x => !(Number(x) >= 1 && Number(x) <= 28))) return 'Monthly dates must be 1–28';
    return null;
  }
  if (r.type === 'monthly' && r.mode !== 'nth' && !(Number(r.date) >= 1 && Number(r.date) <= 28)) return 'Monthly date must be 1–28';
  return null;
}
// Valid "HH:MM-HH:MM" that ends after it starts (used as WIN_RX.test(...) everywhere).
const WIN_RX = { test: (w) => !security.windowError(w) };
const holidays = async () => new Set(J(await getSetting('uae_holidays', '[]'), []));
const isPaused = (plan, date) => !!plan.paused && (!plan.pause_from || date >= plan.pause_from) && (!plan.pause_to || date <= plan.pause_to);

// ── fleet auto-allocation (§7) ───────────────────────────────
async function serviceCategory(code) {
  const t = await prisma.serviceType.findUnique({ where: { code: code || 'WASTE' }, select: { category: true } });
  return t ? t.category : 'waste';
}
async function zoneCentroids() {
  // SQL: SELECT zone, AVG(lat), AVG(lng) FROM customers GROUP BY zone
  const groups = await prisma.customer.groupBy({ by: ['zone'], _avg: { lat: true, lng: true } });
  return Object.fromEntries(groups.map(g => [g.zone, { zone: g.zone, lat: g._avg.lat, lng: g._avg.lng }]));
}
const { capacityFor, loadOf } = require('./capacity');
async function allocate(customer, date, serviceCode) {
  const cat = await serviceCategory(serviceCode);
  const cents = await zoneCentroids();
  const vehicles = (await prisma.vehicle.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' } })).filter(v => {
    const tags = String(v.service_tags || 'waste').split(',').map(s => s.trim());
    return tags.includes(cat);
  });
  const dist = v => {
    if (v.zone === customer.zone) return -1;
    const c = cents[v.zone];
    return c ? haversineM({ lat: customer.lat, lng: customer.lng }, { lat: c.lat, lng: c.lng }) : 1e12;
  };
  vehicles.sort((a, b) => dist(a) - dist(b));
  for (const v of vehicles) {
    const load = await loadOf(v.id, date);
    if (load < await capacityFor(v, date)) {
      const drv = await prisma.user.findFirst({ where: { role: 'driver', is_active: 1, vehicle_id: v.id }, orderBy: { id: 'asc' }, select: { id: true } });
      return { vehicle: v, driver_id: drv ? drv.id : null, load };
    }
  }
  return { vehicle: null, driver_id: null, reason: vehicles.length ? 'all eligible vehicles full' : `no active vehicle tagged "${cat}"` };
}
async function resequence(vehicleId, date) {
  if (!vehicleId) return;
  const rows = await prisma.pickup.findMany({
    where: { vehicle_id: vehicleId, scheduled_date: date, status: { not: 'rescheduled' } },
    select: { id: true, seq: true, time_window: true },
  });
  // ORDER BY COALESCE(substr(time_window,1,5),'99:99'), seq, id
  sortBy(rows, r => (r.time_window == null ? '99:99' : r.time_window.slice(0, 5)), r => r.seq, r => r.id);
  for (const [i, r] of rows.entries()) if (r.seq !== i + 1) await prisma.pickup.update({ where: { id: r.id }, data: { seq: i + 1 } });
}
async function createJob({ customer, date, serviceCode, window, planId = null, revisit = false, billable = true, note = null, quiet = false }) {
  const a = await allocate(customer, date, serviceCode);
  const tw = window || customer.time_window || await getSetting('default_time_window', '07:00-12:00');
  const job = await prisma.pickup.create({
    data: {
      customer_id: customer.id, vehicle_id: a.vehicle ? a.vehicle.id : null, driver_id: a.driver_id, scheduled_date: date, seq: 999,
      status: 'pending', service_type: serviceCode || 'WASTE', time_window: tw, plan_id: planId, is_revisit: revisit ? 1 : 0,
      billable: billable ? 1 : 0, notes: note,
    },
  });
  const id = job.id;
  if (a.vehicle) await resequence(a.vehicle.id, date);
  else if (!quiet) await alertCrm('UNALLOCATED', 'warning', `No capacity for ${customer.name} (${customer.branch || ''}) on ${date}: ${a.reason}. Add capacity or reschedule.`, id);
  return { id, vehicle: a.vehicle ? a.vehicle.fleet_number : null, unallocated: a.vehicle ? null : a.reason };
}

async function generatePlans({ days = 14, planId = null } = {}) {
  const today = ymd();
  const hol = await holidays();
  const plans = await prisma.servicePlan.findMany({ where: planId ? { id: planId, status: 'active' } : { status: 'active' }, orderBy: { id: 'asc' } });
  let created = 0, skipped = 0;
  const unalloc = {};
  for (const p of plans) {
    const c = await prisma.customer.findFirst({ where: { id: p.customer_id, is_active: 1 } });
    if (!c) continue;
    const rule = J(p.recurrence, null);
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      if (date < p.start_date || (p.end_date && date > p.end_date)) continue;
      if (!occursOn(rule, date)) continue;
      if (isPaused(p, date)) continue;
      if (hol.has(date)) {
        const exists = await prisma.planSkip.findUnique({ where: { plan_id_date: { plan_id: p.id, date } } });
        if (!exists) {
          await prisma.planSkip.create({ data: { plan_id: p.id, date, reason: 'UAE public holiday' } });
          await alertCrm('HOLIDAY_SKIP', 'info', `Holiday ${date}: visit for ${c.name} (${c.branch || ''}) skipped — reschedule if needed.`);
          skipped++;
        }
        continue;
      }
      if (await prisma.pickup.findFirst({ where: { plan_id: p.id, scheduled_date: date, is_revisit: 0 }, select: { id: true } })) continue;
      const j = await createJob({ customer: c, date, serviceCode: p.service_code, window: p.time_window, planId: p.id, quiet: true });
      if (j.unallocated) (unalloc[p.id] ||= { c, reason: j.unallocated, dates: [] }).dates.push(date);
      created++;
    }
  }
  for (const u of Object.values(unalloc)) await alertCrm('UNALLOCATED', 'warning',
    `${u.dates.length} job(s) for ${u.c.name} (${u.c.branch || ''}) not allocated — ${u.reason}. Dates: ${u.dates.slice(0, 5).join(', ')}${u.dates.length > 5 ? '…' : ''}`);
  if (created && IO) IO.to('staff').emit('ledger:refresh', {});
  return { created, skipped, unallocated: Object.values(unalloc).reduce((a, u) => a + u.dates.length, 0) };
}
async function regeneratePlan(planId) {
  const today = ymd();
  const del = await prisma.pickup.deleteMany({ where: { plan_id: planId, scheduled_date: { gte: today }, status: 'pending', stage: null, is_revisit: 0 } });
  const g = await generatePlans({ planId });
  return { removed: del.count, ...g };
}

// ── proof validation (DRV-06/07) ─────────────────────────────
// body: lat, lng, photo_taken_at (ISO, device), device_now (ISO at send), stamped ('1'), stamp_text
async function validateProof(pickup, body) {
  const c = await prisma.customer.findUnique({ where: { id: pickup.customer_id }, select: { name: true, lat: true, lng: true } });
  const lat = Number(body.lat), lng = Number(body.lng);
  const problems = [];
  let distance = null, lateMin = 0;
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0) || body.lat === '' || body.lat == null) problems.push('no GPS fix on photo');
  else if (c && c.lat != null) {
    distance = Math.round(haversineM({ lat, lng }, { lat: Number(c.lat), lng: Number(c.lng) }));
    if (distance > PROOF_RADIUS_M) problems.push(`photo taken ${distance} m from site (limit ${PROOF_RADIUS_M} m)`);
  }
  const serverNow = Date.now();
  const devNow = Date.parse(body.device_now || body.client_ts || '');
  if (!isFinite(devNow)) problems.push('missing device time');
  else if (Math.abs(devNow - serverNow) > MAX_CLOCK_SKEW_MS) problems.push(`device clock off by ${Math.round(Math.abs(devNow - serverNow) / 60000)} min`);
  const taken = Date.parse(body.photo_taken_at || '');
  if (!isFinite(taken)) problems.push('missing photo time');
  else if (isFinite(devNow) && taken > devNow + 60000) problems.push('photo time is in the future');
  else if (ymd(new Date(taken)) !== pickup.scheduled_date && ymd(new Date(taken)) !== ymd()) problems.push('photo not taken on the service day');
  else if (isFinite(devNow)) {
    // Proof must be fresh. Uploads from the driver app's offline queue are accepted
    // but flagged (late_min) so the office can review them.
    const ageMin = Math.round((devNow - taken) / 60000);
    if (ageMin > PHOTO_MAX_AGE_MIN) {
      if (String(body.queued) === '1') lateMin = ageMin;
      else problems.push(`photo taken ${ageMin} min before upload (limit ${PHOTO_MAX_AGE_MIN} min) — take a new photo`);
    }
  }
  if (String(body.stamped) !== '1' || !String(body.stamp_text || '').includes(String(c?.name || '').slice(0, 6)))
    problems.push('image lacks the on-device GPS stamp');
  if (String(body.source || 'camera') !== 'camera') problems.push('photo not from live camera');
  return { ok: problems.length === 0, problems, distance_m: distance,
    meta: { lat, lng, distance_m: distance, late_min: lateMin || undefined, photo_taken_at: body.photo_taken_at, device_now: body.device_now, server_at: new Date(serverNow).toISOString(), stamp: body.stamp_text } };
}
// Proof accepted from the offline queue but uploaded long after capture → office review.
async function flagLateProof(pickup, v, driverName) {
  if (!v.meta || !v.meta.late_min) return;
  const c = await prisma.customer.findUnique({ where: { id: pickup.customer_id }, select: { name: true, branch: true } });
  await alertCrm('LATE_PROOF', 'warning', `Proof for ${c?.name} (${c?.branch || ''}) by ${driverName} was uploaded ${v.meta.late_min} min after the photo was taken (offline). Please review.`, pickup.id);
}
async function rejectProof(pickup, v, driverName, kind) {
  const c = await prisma.customer.findUnique({ where: { id: pickup.customer_id }, select: { name: true, branch: true } });
  await prisma.pickup.update({ where: { id: pickup.id }, data: { proof_meta: JSON.stringify({ rejected: true, kind, ...v.meta, problems: v.problems }), updated_at: sqlNow() } });
  await alertCrm('PHOTO_REJECTED', 'critical',
    `Proof photo rejected for ${c?.name} (${c?.branch || ''}) by ${driverName}: ${v.problems.join('; ')}. Ops can override in Alerts.`, pickup.id);
}

// ── invoices ─────────────────────────────────────────────────
async function priceFor(p) {
  if (p.plan_id) {
    const pl = await prisma.servicePlan.findUnique({ where: { id: p.plan_id }, select: { unit_price: true } });
    if (pl && pl.unit_price > 0) return pl.unit_price;
  }
  const st = await prisma.serviceType.findUnique({ where: { code: p.service_type || 'WASTE' }, select: { default_price: true } });
  return st ? st.default_price : 0;
}
// highest number after a prefix ("INV-202610-0007" → 7) — SQL: MAX(CAST(substr(number, n) AS INTEGER))
async function maxSequence(delegate, pre) {
  const rows = await prisma[delegate].findMany({ where: { number: { startsWith: pre } }, select: { number: true } });
  return rows.reduce((m, r) => Math.max(m, parseInt(r.number.slice(pre.length), 10) || 0), 0);
}
async function nextInvoiceNumber(period) {
  // highest existing sequence + 1 (a count could repeat a number if one was ever removed)
  const pre = `INV-${period.replace('-', '')}-`;
  const n = (await maxSequence('invoice', pre)) + 1;
  return `INV-${period.replace('-', '')}-${String(n).padStart(4, '0')}`;
}
async function accountOf(customerId) {
  const id = toId(customerId);
  const c = id ? await prisma.customer.findUnique({ where: { id }, select: { id: true, account_id: true } }) : null;
  return c ? (c.account_id || c.id) : customerId;
}
async function createInvoice(accountId, period, jobs) {
  if (!jobs.length) return null;
  const lines = [];
  for (const j of jobs) lines.push({ job_id: j.id, date: j.scheduled_date, site: j.branch || j.name, service: j.service_type || 'WASTE', amount: money(await priceFor(j)) });
  const subtotal = money(lines.reduce((a, l) => a + l.amount, 0));
  const vat = money(subtotal * VAT_RATE);
  const due = addDays(ymd(), Number(await getSetting('invoice_due_days', '15')) || 15);
  const number = await nextInvoiceNumber(period);
  const inv = await prisma.invoice.create({
    data: {
      number, customer_id: accountId, period, job_ids: JSON.stringify(jobs.map(j => j.id)), lines: JSON.stringify(lines),
      subtotal, vat, amount: money(subtotal + vat), due_date: due,
    },
  });
  const id = inv.id;
  await prisma.pickup.updateMany({ where: { id: { in: jobs.map(j => j.id) } }, data: { invoice_id: id } });
  // Step 3 of the workflow: the invoice (with its PDF) is delivered in the customer app + push
  await notifyCustomer(accountId, 'invoice', `Invoice ${number} issued`, `AED ${money(subtotal + vat).toFixed(2)} due ${dmy(due)} — tap to view the PDF`, '/customer/#invoices');
  await prisma.invoice.update({ where: { id }, data: { sent_at: sqlNow(), sent_count: 1 } });
  return { id, number, amount: money(subtotal + vat) };
}
// completed jobs not yet invoiced (SQL: status='collected' AND invoice_id IS NULL AND COALESCE(billable,1)=1),
// each with its customer's name, branch and account id
async function billableJobs(extraWhere = {}) {
  const rows = await prisma.pickup.findMany({
    where: { status: 'collected', invoice_id: null, OR: [{ billable: null }, { billable: 1 }], ...extraWhere },
    orderBy: { id: 'asc' },
  });
  const withCust = await join(rows, 'customer_id', 'customer', { name: 'name', branch: 'branch', _account_id: 'account_id' }, { inner: true });
  return withCust.map(({ _account_id, ...r }) => ({ ...r, acct: _account_id ?? r.customer_id }));
}
async function generateInvoices(period, customerId = null) {
  let rows = await billableJobs({ scheduled_date: { startsWith: period } });
  if (customerId) { const a = await accountOf(customerId); rows = rows.filter(r => r.acct === a); }
  const groups = {};
  rows.forEach(r => { (groups[r.acct] ||= []).push(r); });
  const out = [];
  for (const [acct, jobs] of Object.entries(groups)) { const inv = await createInvoice(Number(acct), period, jobs); if (inv) out.push(inv); }
  return out;
}
async function invoiceView(inv) {
  const agg = await prisma.payment.aggregate({ where: { invoice_id: inv.id }, _sum: { amount: true } });
  const paid = agg._sum.amount || 0;     // COALESCE(SUM(amount),0)
  const balance = money(inv.amount - paid);
  let status = inv.status === 'void' ? 'Void' : balance <= 0.004 ? 'Paid' : inv.due_date < ymd() ? 'Overdue' : paid > 0 ? 'Partly paid' : 'Due';
  const c = await prisma.customer.findUnique({ where: { id: inv.customer_id }, select: { name: true, branch: true, contact_phone: true, email: true } });
  return { ...inv, lines: J(inv.lines, []), job_ids: J(inv.job_ids, []), paid: money(paid), balance, status_label: status, customer: c };
}
const invoiceViews = async (rows) => { const out = []; for (const r of rows) out.push(await invoiceView(r)); return out; };
async function onPickupCompleted(pickupId) {
  const p = await prisma.pickup.findUnique({ where: { id: pickupId } });
  const c = p && await prisma.customer.findUnique({ where: { id: p.customer_id }, select: { name: true, branch: true } });
  if (!p || !c) return;
  Object.assign(p, c);
  await notifyCustomer(p.customer_id, 'completed', 'Service completed', `${p.name} ${p.branch || ''} — photo proof is in your history`, '/customer/#history');
  if (p.plan_id) {
    const pl = await prisma.servicePlan.findUnique({ where: { id: p.plan_id }, select: { billing: true } });
    if (pl && pl.billing === 'per_visit' && p.billable) await createInvoice(await accountOf(p.customer_id), p.scheduled_date.slice(0, 7), [p]);
  }
}
async function onNotPickedUp(pickupId) {
  const deadline = new Date(Date.now() + CONFIRM_WINDOW_H * 3600e3).toISOString();
  const p = await prisma.pickup.update({ where: { id: pickupId }, data: { confirmation_status: 'awaiting', confirm_deadline: deadline } });
  const c = await prisma.customer.findUnique({ where: { id: p.customer_id }, select: { id: true, name: true, branch: true } });
  await notifyCustomer(c.id, 'confirm', 'Please confirm: not picked up',
    `Driver reported "${String(p.anomaly_reason || '').replace(/_/g, ' ').toLowerCase()}" at ${c.name} ${c.branch || ''}. Confirm or dispute within 24 h.`, '/customer/#confirm');
}

// ── sales helpers ────────────────────────────────────────────
/* Frequency-based pricing (v3.3).
   A quotation line is priced from how often the service happens, not from a typed
   visit count:   visits a month × price per visit.
     daily   n visits a day   → n × 30
     weekly  n visits a week  → n × 52 ÷ 12, rounded (3 a week = 13, 7 a week = 30)
     monthly n visits a month → n
   The month is an average month, so a quote does not change with the calendar.
   Invoices are still built from the visits actually completed. */
const FREQ = { daily: { max: 3, per: 'day' }, weekly: { max: 7, per: 'week' }, monthly: { max: 28, per: 'month' } };
function visitsPerMonth(unit, count) {
  const n = Number(count);
  if (unit === 'daily') return n * 30;
  if (unit === 'weekly') return Math.round(n * 52 / 12);
  return n;
}
function frequencyLabel(unit, count) {
  const n = Number(count), per = FREQ[unit].per;
  if (unit === 'daily' && n === 1) return 'Every day';
  return n === 1 ? `Once a ${per}` : n === 2 ? `Twice a ${per}` : `${n} times a ${per}`;
}
const frequencyError = (unit, count) => !FREQ[unit] ? 'frequency must be daily, weekly or monthly'
  : !(Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= FREQ[unit].max) ? `choose 1 to ${FREQ[unit].max} visits a ${FREQ[unit].per}` : null;
// "weekly:3" (how a lead stores the frequency it asked for) → { unit, count } | null
function parseFrequency(s) {
  const m = /^(daily|weekly|monthly):(\d{1,2})$/.exec(String(s || ''));
  return m && !frequencyError(m[1], Number(m[2])) ? { unit: m[1], count: Number(m[2]) } : null;
}
// The visit days a frequency implies when the quotation's own schedule does not already match it.
const SPREAD_DAYS = { 1: [1], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4], 6: [6, 0, 1, 2, 3, 4], 7: [0, 1, 2, 3, 4, 5, 6] };
function recurrenceForLine(line, planRule) {
  if (!line || !line.freq_unit || frequencyError(line.freq_unit, line.freq_count)) return planRule;
  const n = Number(line.freq_count), r = planRule || {};
  if (line.freq_unit === 'daily') return r.type === 'daily' && !r.weekdays_only ? r : { type: 'daily', weekdays_only: false };
  if (line.freq_unit === 'weekly') return r.type === 'weekly' && Array.isArray(r.days) && new Set(r.days.map(Number)).size === n ? r : { type: 'weekly', days: SPREAD_DAYS[n] };
  if (n === 1) return r.type === 'monthly' && !(Array.isArray(r.dates) && r.dates.length > 1) ? r : { type: 'monthly', mode: 'date', date: 1 };
  return { type: 'monthly', mode: 'date', dates: Array.from({ length: n }, (_, i) => Math.min(28, 1 + Math.round(i * 28 / n))) };
}

// Rejects impossible quotation lines instead of silently zeroing them.
function quoteItemsError(items) {
  if (!Array.isArray(items) || !items.length) return 'Add at least one priced line item';
  if (items.length > 100) return 'Too many line items (max 100)';
  for (const [i, it] of items.entries()) {
    const unit = Number(it.unit_price);
    if (it.freq_unit !== undefined && it.freq_unit !== null && it.freq_unit !== '') {
      const fErr = frequencyError(it.freq_unit, it.freq_count);
      if (fErr) return `Line ${i + 1}: ${fErr}`;
    } else {
      // older API callers that still send a plain visit count
      const qty = Number(it.qty);
      if (!isFinite(qty) || qty <= 0) return `Line ${i + 1}: quantity must be more than 0`;
      if (qty > 100000) return `Line ${i + 1}: quantity is too large`;
    }
    if (!isFinite(unit) || unit < 0) return `Line ${i + 1}: price cannot be negative`;
    if (unit > 1000000) return `Line ${i + 1}: unit price is too large (max AED 1,000,000)`;
  }
  return null;
}
function calcQuote(items) {
  const clean = (items || []).map(it => {
    const unit = Math.max(0, Number(it.unit_price) || 0);
    const byFreq = !!it.freq_unit && !frequencyError(it.freq_unit, it.freq_count);
    // the visit count is always worked out here, never trusted from the browser
    const qty = byFreq ? visitsPerMonth(it.freq_unit, it.freq_count) : Math.max(0, Number(it.qty) || 0);
    const line = { service_code: it.service_code || 'WASTE', description: String(it.description || ''), site: String(it.site || ''),
      frequency: byFreq ? frequencyLabel(it.freq_unit, it.freq_count) : String(it.frequency || ''), qty, unit_price: money(unit), line_total: money(qty * unit) };
    if (byFreq) { line.freq_unit = it.freq_unit; line.freq_count = Number(it.freq_count); }
    return line;
  });
  const subtotal = money(clean.reduce((a, i) => a + i.line_total, 0));
  const vat = money(subtotal * VAT_RATE);
  return { items: clean, subtotal, vat, total: money(subtotal + vat) };
}
async function nextQuoteNumber() {
  const y = new Date().getFullYear();
  const pre = `QT-${y}-`;
  const n = (await maxSequence('quotation', pre)) + 1;
  return `QT-${y}-${String(n).padStart(4, '0')}`;
}
async function quoteView(qt) {
  if (!qt) return null;
  const lead = qt.lead_id ? await prisma.lead.findUnique({ where: { id: qt.lead_id } }) : null;
  const expired = qt.valid_until && qt.valid_until < ymd() && ['draft', 'sent'].includes(qt.status);
  return { ...qt, items: J(qt.items, []), plan: J(qt.plan, {}), status: expired ? 'expired' : qt.status,
    lead: lead ? { ...lead, sites: J(lead.sites, []) } : null };
}
const quoteViews = async (rows) => { const out = []; for (const r of rows) out.push(await quoteView(r)); return out; };
// App codes are 4 digits (v3.3), the same length as the driver PIN. A code is always used
// together with the account's mobile number, and wrong attempts lock out after five tries,
// so codes do not need to be unique. Older 6-digit codes keep working until they are reset.
async function uniquePortalCode() {
  return String(crypto.randomInt(1000, 10000));
}

// ── printable documents (branded HTML → browser "Save as PDF") ──
const DOC_CSS = `
*{box-sizing:border-box}body{font:13px/1.5 'Segoe UI',system-ui,sans-serif;color:#10241f;margin:0;background:#eef4f2}
.page{max-width:820px;margin:24px auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 10px 40px rgba(15,118,110,.12)}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #14b8a6;padding-bottom:18px;margin-bottom:22px}
.brand{display:flex;gap:10px;align-items:center;font-size:24px;font-weight:800;color:#0f766e}.brand small{display:block;font-size:11px;color:#6b7280;font-weight:500}
.meta{text-align:right;font-size:12px;color:#374151}.meta b{font-size:18px;color:#10241f;display:block}
table{width:100%;border-collapse:collapse;margin:16px 0}th{background:#f0fdfa;color:#0f766e;text-align:left;font-size:11px;text-transform:uppercase;padding:9px}
td{padding:9px;border-bottom:1px solid #e5e7eb}.r{text-align:right}.tot td{border:0;padding:5px 9px}.tot .g td{font-size:16px;font-weight:800;color:#0f766e;border-top:2px solid #14b8a6}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}.box{background:#f8fafa;border-radius:10px;padding:12px 14px}.box h4{margin:0 0 4px;font-size:11px;color:#6b7280;text-transform:uppercase}
.foot{margin-top:28px;font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px}.pill{display:inline-block;padding:2px 10px;border-radius:20px;background:#ccfbf1;color:#0f766e;font-weight:700;font-size:11px}
.bar{max-width:820px;margin:16px auto 0;display:flex;gap:8px;justify-content:flex-end}.bar button,.bar a{background:#0f766e;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;text-decoration:none}
.bar .ghost{background:#fff;color:#0f766e;border:1px solid #99f6e4}img.ph{width:90px;height:68px;object-fit:cover;border-radius:6px}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;border-radius:0}.bar{display:none}}`;
const LOGO = `<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true"><defs><linearGradient id="glgDoc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3CF2B4"/><stop offset="1" stop-color="#0FB5A6"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#glgDoc)"/><path d="M44.5 36A14.5 14.5 0 1 1 30 21.5" fill="none" stroke="#062A24" stroke-width="6.5" stroke-linecap="round"/><path d="M29 24C29 14.5 37 10 48.5 11C49.5 22.5 44 30 34.5 29Z" fill="#fff"/></svg>`;
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function docShell(title, body, extraBar = '', autoPrint = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title><style>${DOC_CSS}</style></head>
<body><div class="bar">${extraBar}<button onclick="print()">Download PDF</button></div><div class="page">${body}</div>
${autoPrint ? '<script>setTimeout(()=>print(),400)</script>' : ''}</body></html>`;
}
async function brandHeader(docTitle, number, lines) {
  const company = await getSetting('company_name', 'Majari / GreenLoop');
  return `<div class="hd"><div class="brand">${LOGO}<div>GreenLoop<small>${h(company)} · Waste management &amp; pest control · Dubai, UAE</small></div></div>
  <div class="meta"><b>${h(docTitle)}</b>${h(number)}<br>${lines.join('<br>')}</div></div>`;
}
/* ── Quotation document + email (v3.3) ─────────────────────────
   One restrained layout for both: a letterhead, three facts, the priced lines,
   the monthly total. Hairlines and alignment do the work; no boxes or badges. */
const QUOTE_CSS = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#e9eeec;color:#13231f;font:14px/1.5 'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;font-variant-numeric:tabular-nums}
.bar{max-width:800px;margin:20px auto 0;padding:0 16px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.bar button{font:inherit;font-weight:600;cursor:pointer;border-radius:8px;padding:10px 18px;border:1px solid #0f766e;background:#fff;color:#0f766e}
.bar button.go{background:#0f766e;color:#fff}.bar form{margin:0}
.sheet{max-width:800px;margin:16px auto 40px;background:#fff;padding:56px 56px 40px;box-shadow:0 1px 2px rgba(19,35,31,.08),0 12px 32px -16px rgba(19,35,31,.25)}
.lh{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:20px;border-bottom:2px solid #13231f}
.mark{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;letter-spacing:-.01em}
.mark small{display:block;font-size:12px;font-weight:400;color:#55645f;letter-spacing:0}
.title{text-align:right}.title b{display:block;font-size:30px;font-weight:300;letter-spacing:-.02em;line-height:1.1}
.title span{font-size:13px;color:#55645f}
.facts{display:grid;grid-template-columns:1.2fr 1fr 1.2fr;margin:26px 0 30px}
.facts>div{padding:0 20px;border-left:1px solid #dfe6e3}.facts>div:first-child{padding-left:0;border-left:0}
.facts dt{font-size:12px;color:#55645f;margin-bottom:4px}.facts dd{margin:0}.facts dd b{font-weight:600}
table{width:100%;border-collapse:collapse}
thead th{font-size:12px;font-weight:600;color:#55645f;text-align:left;padding:0 10px 8px 0;border-bottom:1.5px solid #13231f;vertical-align:bottom}
tbody td{padding:13px 10px 13px 0;border-bottom:1px solid #dfe6e3;vertical-align:top}
th.n,td.n{text-align:right;padding-right:0;padding-left:10px;white-space:nowrap}
td .sub{display:block;font-size:12.5px;color:#55645f}
.sum{margin:18px 0 0 auto;width:300px}.sum td{padding:5px 0;border:0}.sum td.n{padding-left:10px}
.sum .total td{padding-top:12px;border-top:2px solid #13231f;font-weight:700;font-size:17px}
.sum .total td.n{font-size:22px;letter-spacing:-.01em}
.note{margin-top:30px}.note h4{margin:0 0 4px;font-size:12px;font-weight:600;color:#55645f}.note p{margin:0;white-space:pre-wrap}
.terms{margin-top:34px;padding-top:14px;border-top:1px solid #dfe6e3;font-size:12px;color:#55645f;line-height:1.6}
.state{margin:0 0 22px;padding:10px 14px;border-left:3px solid #0f766e;background:#f3f8f6;font-size:13px}
.state.off{border-left-color:#b45309;background:#fdf6ec}
@media (max-width:640px){.sheet{padding:28px 20px;margin:12px 0 24px}.lh{flex-direction:column;align-items:flex-start}.title{text-align:left}
  .facts{grid-template-columns:1fr;gap:14px}.facts>div{padding:0;border:0}
  thead{display:none}tbody tr{display:block;padding:12px 0;border-bottom:1px solid #dfe6e3}tbody td{display:block;border:0;padding:0}
  tbody td.n{text-align:left;padding:0;color:#55645f;font-size:13px;display:inline}tbody td.n::before{content:attr(data-l) ' '}tbody td.n+td.n::before{content:' · ' attr(data-l) ' '}
  tbody td.amt{display:block;color:#13231f;font-weight:600;font-size:15px;margin-top:4px}tbody td.amt::before{content:attr(data-l) ' ' !important}
  .sum{width:100%}}
@media print{body{background:#fff}.bar{display:none}.sheet{box-shadow:none;margin:0;max-width:none;padding:24px 8px}}
body.embed{background:#fff}body.embed .bar{display:none}body.embed .sheet{box-shadow:none;margin:0 auto;padding:36px 36px 28px}`;
const QUOTE_MARK = `<svg viewBox="0 0 64 64" width="32" height="32" aria-hidden="true"><defs><linearGradient id="glgQ" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3CF2B4"/><stop offset="1" stop-color="#0FB5A6"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#glgQ)"/><path d="M44.5 36A14.5 14.5 0 1 1 30 21.5" fill="none" stroke="#062A24" stroke-width="6.5" stroke-linecap="round"/><path d="M29 24C29 14.5 37 10 48.5 11C49.5 22.5 44 30 34.5 29Z" fill="#fff"/></svg>`;
const aed = n => Number(n || 0).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// every line priced by frequency → the total is a monthly figure
const quoteIsMonthly = qv => qv.items.length > 0 && qv.items.every(i => i.freq_unit);
function quoteLineText(i) {
  return i.freq_unit ? `${i.frequency} (${i.qty} visit${i.qty === 1 ? '' : 's'} a month)` : `${i.qty} visit${i.qty === 1 ? '' : 's'}${i.frequency ? ', ' + i.frequency : ''}`;
}

// Email body: what the customer reads in their inbox. Tables + inline styles only (mail clients).
function quoteEmailHtml(qv, link) {
  const lead = qv.lead || {};
  const monthly = quoteIsMonthly(qv);
  const cell = 'padding:12px 0;border-bottom:1px solid #dfe6e3;vertical-align:top';
  const rows = qv.items.map(i => `<tr><td style="${cell}">${h(i.description || i.service_code)}${i.site ? `<br><span style="color:#55645f;font-size:13px">${h(i.site)}</span>` : ''}
      <br><span style="color:#55645f;font-size:13px">${h(quoteLineText(i))} at AED ${aed(i.unit_price)} a visit</span></td>
    <td style="${cell};text-align:right;white-space:nowrap;padding-left:16px">AED ${aed(i.line_total)}</td></tr>`).join('');
  const sum = (label, value, strong) => `<tr><td style="padding:${strong ? '12px 0 0' : '5px 0'};${strong ? 'border-top:2px solid #13231f;font-weight:700;font-size:16px' : 'color:#55645f'}">${label}</td>
    <td style="padding:${strong ? '12px 0 0 16px' : '5px 0 5px 16px'};text-align:right;white-space:nowrap;${strong ? 'border-top:2px solid #13231f;font-weight:700;font-size:20px' : ''}">AED ${aed(value)}</td></tr>`;
  return `<div style="background:#ffffff;color:#13231f;font:15px/1.55 'Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:8px 4px">
  <table role="presentation" style="width:100%;border-collapse:collapse"><tr>
    <td style="padding:0 0 14px;border-bottom:2px solid #13231f;font-size:19px;font-weight:700">GreenLoop</td>
    <td style="padding:0 0 14px;border-bottom:2px solid #13231f;text-align:right;font-size:13px;color:#55645f">Quotation ${h(qv.number)}${qv.version > 1 ? `, version ${qv.version}` : ''}</td></tr></table>
  <p style="margin:22px 0 10px">Hello ${h(lead.contact || lead.company || '')},</p>
  <p style="margin:0 0 20px">Here is your quotation for ${h(lead.company || 'your sites')}. It is valid until ${h(dmy(qv.valid_until))}.</p>
  <table role="presentation" style="width:100%;border-collapse:collapse">${rows}</table>
  <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:10px">
    ${sum('Subtotal', qv.subtotal)}${sum('VAT 5%', qv.vat)}${sum(monthly ? 'Total a month' : 'Total', qv.total, true)}</table>
  <p style="margin:26px 0 8px"><a href="${h(link)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:8px">Review and accept the quotation</a></p>
  <p style="margin:0 0 22px;font-size:13px;color:#55645f">The link opens the full quotation, where you can also save it as a PDF.</p>
  <p style="margin:0;font-size:13px;color:#55645f;line-height:1.6">${monthly ? 'Monthly amounts use an average month. You are invoiced only for visits we complete, each one confirmed with a GPS-stamped photo. ' : ''}After you accept, we set up your account and send you access to the GreenLoop customer app, where your invoices and visit photos appear.</p>
  <p style="margin:18px 0 0;font-size:12px;color:#8a9692;word-break:break-all">If the button does not open, copy this address into your browser: ${h(link)}</p></div>`;
}
function quoteEmailText(qv, link) {
  const lead = qv.lead || {};
  const monthly = quoteIsMonthly(qv);
  return `Hello ${lead.contact || lead.company || ''},\n\nHere is your GreenLoop quotation ${qv.number}${qv.version > 1 ? ` (version ${qv.version})` : ''}, valid until ${dmy(qv.valid_until)}.\n\n` +
    qv.items.map(i => `- ${i.description || i.service_code}${i.site ? ' (' + i.site + ')' : ''}: ${quoteLineText(i)} at AED ${aed(i.unit_price)} a visit = AED ${aed(i.line_total)}`).join('\n') +
    `\n\nSubtotal: AED ${aed(qv.subtotal)}\nVAT 5%: AED ${aed(qv.vat)}\n${monthly ? 'Total a month' : 'Total'}: AED ${aed(qv.total)}\n\nReview and accept the quotation, or save it as a PDF:\n${link}\n\n` +
    `${monthly ? 'Monthly amounts use an average month. You are invoiced only for visits we complete.\n' : ''}GreenLoop`;
}
// The email exactly as it will go out. Preview and send both build it here, so they cannot differ.
async function quoteMail(qv, to, base) {
  const link = `${base}/q/${qv.share_token}`;
  return { to, link, subject: `Your GreenLoop quotation ${qv.number} — AED ${aed(qv.total)}${quoteIsMonthly(qv) ? ' a month' : ''}`,
    text: quoteEmailText(qv, link), html: quoteEmailHtml(qv, link), replyTo: await getSetting('company_email', '') };
}
// Fingerprint of a previewed email. Sending requires it, so nothing goes out unseen or changed.
function previewToken(qv, mail) {
  return crypto.createHmac('sha256', SECRET).update([qv.id, qv.version, mail.to, mail.subject, mail.html].join('\n')).digest('hex').slice(0, 32);
}

async function quoteHtml(qv, opts = {}) {
  const company = await getSetting('company_name', 'Majari / GreenLoop');
  const lead = qv.lead || {};
  const monthly = quoteIsMonthly(qv);
  const rows = qv.items.map(i => `<tr><td>${h(i.description || i.service_code)}${i.site ? `<span class="sub">${h(i.site)}</span>` : ''}</td>
    <td>${h(i.frequency || '—')}</td><td class="n" data-l="Visits${monthly ? ' a month' : ''}">${i.qty}</td>
    <td class="n" data-l="Per visit AED">${aed(i.unit_price)}</td><td class="n amt" data-l="AED">${aed(i.line_total)}</td></tr>`).join('');
  const canAccept = opts.acceptUrl && ['sent', 'draft'].includes(qv.status);
  const state = qv.status === 'expired' ? `<p class="state off">This quotation expired on ${h(dmy(qv.valid_until))}. Ask us for an updated one.</p>`
    : ['accepted', 'converted'].includes(qv.status) ? `<p class="state">Accepted${qv.accepted_at ? ' on ' + h(dmy(qv.accepted_at)) : ''}. Thank you.</p>`
    : qv.status === 'superseded' ? `<p class="state off">A newer version of this quotation replaces this one.</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quotation ${h(qv.number)}</title><style>${QUOTE_CSS}</style></head>
<body class="${opts.embed ? 'embed' : ''}">${opts.embed ? '' : `<div class="bar"><button onclick="print()">Save as PDF</button>${canAccept ? `<form method="post" action="${opts.acceptUrl}"><button class="go">Accept quotation</button></form>` : ''}</div>`}
<div class="sheet">
  <div class="lh"><div class="mark">${QUOTE_MARK}<div>GreenLoop<small>${h(company)}, waste management and pest control, Dubai</small></div></div>
    <div class="title"><b>Quotation</b><span>${h(qv.number)}${qv.version > 1 ? `, version ${qv.version}` : ''}</span></div></div>
  <dl class="facts">
    <div><dt>Prepared for</dt><dd><b>${h(lead.company || lead.contact || '')}</b><br>${lead.company ? h(lead.contact || '') + '<br>' : ''}${h(lead.phone ? contacts.formatPhone(lead.phone) : '')}${lead.phone && lead.email ? '<br>' : ''}${h(lead.email || '')}</dd></div>
    <div><dt>Issued</dt><dd>${h(dmy(qv.created_at))}</dd><dt style="margin-top:10px">Valid until</dt><dd><b>${h(dmy(qv.valid_until))}</b></dd></div>
    <div><dt>Service schedule</dt><dd>${h(describeRule(qv.plan.recurrence).replace(' · ', ' on '))}<br>Between ${h(String(qv.plan.time_window || '—').replace('-', ' and '))}<br>${qv.plan.start_date ? 'Starts ' + h(dmy(qv.plan.start_date)) : 'Starts when you accept'}</dd></div>
  </dl>
  ${state}
  <table><thead><tr><th>Service</th><th>How often</th><th class="n">Visits${monthly ? '<br>a month' : ''}</th><th class="n">Per visit<br>AED</th><th class="n">${monthly ? 'A month' : 'Amount'}<br>AED</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="sum"><tr><td>Subtotal</td><td class="n">AED ${aed(qv.subtotal)}</td></tr><tr><td>VAT 5%</td><td class="n">AED ${aed(qv.vat)}</td></tr>
    <tr class="total"><td>${monthly ? 'Total a month' : 'Total'}</td><td class="n">AED ${aed(qv.total)}</td></tr></table>
  ${qv.notes ? `<div class="note"><h4>Notes</h4><p>${h(qv.notes)}</p></div>` : ''}
  <p class="terms">${monthly ? 'Monthly amounts are worked out from an average month (a weekly visit counts as 4.33 visits). ' : ''}You are invoiced ${qv.plan.billing === 'per_visit' ? 'after each visit' : 'once a month'}, only for visits we complete. Every completed visit is confirmed with a GPS-stamped photo you can see in the customer app. Prices are in UAE dirhams. Dates are written day/month/year.</p>
</div>${opts.print ? '<script>setTimeout(()=>print(),400)</script>' : ''}</body></html>`;
}
async function invoiceHtml(iv, autoPrint) {
  const pays = await prisma.payment.findMany({ where: { invoice_id: iv.id }, orderBy: [{ received_at: 'asc' }, { id: 'asc' }] });
  return docShell(`Invoice ${iv.number}`, `
    ${await brandHeader('TAX INVOICE', iv.number, [`Period: ${h(iv.period.slice(5) + '/' + iv.period.slice(0, 4))}`, `Issued: ${dmy(iv.created_at)}`, `Due: <b>${h(dmy(iv.due_date))}</b>`, `<span class="pill">${h(iv.status_label)}</span>`])}
    <div class="box"><h4>Bill to</h4><b>${h(iv.customer?.name)}</b> ${h(iv.customer?.branch || '')}<br>${h(iv.customer?.contact_phone || '')}</div>
    <table><tr><th>Date</th><th>Site</th><th>Service</th><th>Job #</th><th class="r">AED</th></tr>
    ${iv.lines.map(l => `<tr><td>${h(dmy(l.date))}</td><td>${h(l.site)}</td><td>${h(l.service)}</td><td>${l.job_id}</td><td class="r">${Number(l.amount).toFixed(2)}</td></tr>`).join('')}</table>
    <table class="tot" style="width:320px;margin-left:auto"><tr><td>Subtotal</td><td class="r">${iv.subtotal.toFixed(2)}</td></tr><tr><td>VAT 5%</td><td class="r">${iv.vat.toFixed(2)}</td></tr>
    <tr class="g"><td>Total</td><td class="r">AED ${iv.amount.toFixed(2)}</td></tr><tr><td>Paid</td><td class="r">${iv.paid.toFixed(2)}</td></tr><tr><td><b>Balance</b></td><td class="r"><b>AED ${iv.balance.toFixed(2)}</b></td></tr></table>
    ${pays.length ? `<table><tr><th>Payment</th><th>Method</th><th>Reference</th><th class="r">AED</th></tr>${pays.map(p => `<tr><td>${dmy(p.received_at)}</td><td>${h(p.method)}</td><td>${h(p.reference || '')}</td><td class="r">${p.amount.toFixed(2)}</td></tr>`).join('')}</table>` : ''}
    <div class="foot">Invoice covers completed, photo-verified visits only. "Not picked up" visits confirmed by the customer are not billed.</div>`, '', autoPrint);
}


// ═════════════════════════ ROUTES ════════════════════════════
function mountV3Routes(r, io) {
  IO = io;

  // ── Service catalogue (CRM-13) ──
  r.get('/service-types', async (req, res) => {
    const rows = await prisma.serviceType.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }, { id: 'asc' }] });
    res.json(rows.map(t => ({ ...t, checklist: J(t.checklist, []) })));
  });
  r.post('/service-types', owner, async (req, res) => {
    const b = req.body || {};
    if (!b.code || !b.name) return res.status(400).json({ error: 'code and name required' });
    if (!['waste', 'pest'].includes(b.category)) return res.status(400).json({ error: 'category must be waste or pest' });
    const code = String(b.code).toUpperCase().replace(/\s+/g, '_');
    if (await prisma.serviceType.findUnique({ where: { code } })) return res.status(409).json({ error: `Service code ${code} already exists` });
    const t = await prisma.serviceType.create({
      data: { code, name: String(b.name), category: b.category, default_duration_min: int(b.default_duration_min, null) || 20, default_price: money(b.default_price), checklist: JSON.stringify(b.checklist || []) },
    });
    await audit(req, 'service_type', t.id, 'create', null, b);
    res.json({ ok: true, id: t.id });
  });
  r.put('/service-types/:id', owner, async (req, res) => {
    const t = await findById('serviceType', req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const b = { ...t, ...req.body };
    await prisma.serviceType.update({
      where: { id: t.id },
      data: {
        name: String(b.name), category: String(b.category), default_duration_min: int(b.default_duration_min, t.default_duration_min), default_price: money(b.default_price),
        checklist: JSON.stringify(Array.isArray(b.checklist) ? b.checklist : J(b.checklist, [])), is_active: b.is_active ? 1 : 0,
      },
    });
    await audit(req, 'service_type', t.id, 'update', t, req.body);
    res.json({ ok: true });
  });

  // ── Leads (CRM-09) ──
  const STAGES = ['new', 'contacted', 'quoted', 'won', 'lost'];
  r.get('/leads', staff, async (req, res) => {
    let rows = await prisma.lead.findMany();
    rows = await join(rows, 'owner_id', 'user', { owner_name: 'full_name' });
    // quote count + latest quote total per lead (two sub-queries in the SQL version)
    const quotes = await prisma.quotation.findMany({ where: { lead_id: { in: rows.map(l => l.id) } }, select: { id: true, lead_id: true, total: true }, orderBy: { id: 'desc' } });
    const per = groupBy(quotes, x => x.lead_id);
    rows.forEach(l => { const list = per.get(l.id) || []; l.quotes = list.length; l.last_quote_total = list.length ? list[0].total : null; });
    const rank = { new: 0, contacted: 1, quoted: 2, won: 3 };
    sortBy(rows, l => rank[l.stage] ?? 4, l => l.follow_up_at ?? '9999', desc(l => l.id));
    res.json(rows.map(l => ({ ...l, sites: J(l.sites, []), overdue_follow_up: !!(l.follow_up_at && l.follow_up_at < nowIso() && !['won', 'lost'].includes(l.stage)) })));
  });
  r.get('/leads/:id', staff, async (req, res) => {
    const l = await findById('lead', req.params.id);
    if (!l) return res.status(404).json({ error: 'Not found' });
    const quotations = await quoteViews(await prisma.quotation.findMany({ where: { lead_id: l.id }, orderBy: { id: 'desc' } }));
    res.json({ ...l, sites: J(l.sites, []), quotations });
  });
  // Lead field checks shared by create and update.
  function leadError(b) {
    if (String(b.contact || '').length > 120) return 'Contact name is too long (max 120 characters)';
    if (String(b.company || '').length > 160) return 'Company name is too long (max 160 characters)';
    if (Array.isArray(b.sites) && b.sites.length > 50) return 'Too many sites on one lead (max 50)';
    if (b.frequency && String(b.frequency).length > 40) return 'Frequency is too long';
    return null;
  }
  // Mobile + email are the lead's unique identifiers: one format, validated, never duplicated.
  //   → { phone, email } (normalised) or { status, body } to send back
  async function leadContacts(b, lead = null) {
    const out = { phone: lead ? lead.phone : '', email: lead ? lead.email : '' };
    if (b.phone !== undefined && String(b.phone || '') !== String(lead ? lead.phone || '' : '\u0000')) {
      if (!String(b.phone || '').trim()) out.phone = '';
      else { const p = contacts.parsePhone(b.phone); if (!p.ok) return { status: 400, body: { error: p.error, field: 'phone' } }; out.phone = p.e164; }
    }
    if (b.email !== undefined && String(b.email || '') !== String(lead ? lead.email || '' : '\u0000')) {
      if (!String(b.email || '').trim()) out.email = '';
      else { const e = contacts.parseEmail(b.email); if (!e.ok) return { status: 400, body: { error: e.error, field: 'email' } }; out.email = e.email; }
    }
    if (!out.phone && !out.email) return { status: 400, body: { error: 'A mobile number or an email is required' } };
    const changed = !lead || out.phone !== (lead.phone || '') || out.email !== (lead.email || '');
    if (changed) {
      const dup = await contacts.findDuplicate({ phone: out.phone, email: out.email }, { exceptLeadId: lead ? lead.id : null, exceptAccountId: lead ? lead.customer_id : null });
      if (dup) return { status: 409, body: { error: contacts.duplicateMessage(dup), code: 'DUPLICATE', duplicate: dup } };
    }
    return out;
  }
  r.post('/leads', staff, async (req, res) => {
    const b = req.body || {};
    if (!String(b.contact || '').trim()) return res.status(400).json({ error: 'Contact name is required' });
    const lErr = leadError(b); if (lErr) return res.status(400).json({ error: lErr });
    const ct = await leadContacts(b); if (ct.status) return res.status(ct.status).json(ct.body);
    const lead = await prisma.lead.create({
      data: {
        contact: String(b.contact).trim(), company: String(b.company || ''), phone: ct.phone, email: ct.email, service_type: String(b.service_type || 'WASTE'),
        sites: JSON.stringify(b.sites || []), frequency: String(b.frequency || ''), source: String(b.source || 'other'), stage: 'new',
        owner_id: toId(b.owner_id) || req.user.id, follow_up_at: str(b.follow_up_at || null), notes: String(b.notes || ''),
      },
    });
    await audit(req, 'lead', lead.id, 'create', null, b);
    io.to('staff').emit('lead:changed', {});
    res.json({ ok: true, id: lead.id });
  });
  r.put('/leads/:id', staff, async (req, res) => {
    const l = await findById('lead', req.params.id);
    if (!l) return res.status(404).json({ error: 'Not found' });
    const b = { ...l, ...req.body };
    if (!STAGES.includes(b.stage)) return res.status(400).json({ error: 'Invalid stage' });
    const lErr = leadError(req.body || {}); if (lErr) return res.status(400).json({ error: lErr });
    if (b.stage === 'won' && l.stage !== 'won' && !l.customer_id) return res.status(400).json({ error: 'A lead becomes Won by converting an accepted quotation' });
    const ct = await leadContacts(req.body || {}, l); if (ct.status) return res.status(ct.status).json(ct.body);
    await prisma.lead.update({
      where: { id: l.id },
      data: {
        contact: String(b.contact ?? ''), company: str(b.company), phone: ct.phone, email: ct.email, service_type: str(b.service_type),
        sites: JSON.stringify(Array.isArray(b.sites) ? b.sites : J(b.sites, [])), frequency: str(b.frequency), source: str(b.source),
        stage: b.stage, lost_reason: str(b.lost_reason || null), owner_id: toId(b.owner_id), follow_up_at: str(b.follow_up_at || null),
        notes: str(b.notes), updated_at: sqlNow(),
      },
    });
    await audit(req, 'lead', l.id, 'update', l, req.body);
    io.to('staff').emit('lead:changed', {});
    res.json({ ok: true });
  });
  // Is this mobile number / email already in the CRM? (used by the forms while typing)
  r.get('/contacts/check', staff, async (req, res) => {
    const out = { phone: null, email: null, duplicate: null };
    if (req.query.phone) { const p = contacts.parsePhone(req.query.phone); if (!p.ok) return res.json({ ...out, error: p.error, field: 'phone' }); out.phone = p.e164; }
    if (req.query.email) { const e = contacts.parseEmail(req.query.email); if (!e.ok) return res.json({ ...out, error: e.error, field: 'email' }); out.email = e.email; }
    const dup = await contacts.findDuplicate({ phone: out.phone, email: out.email }, { exceptLeadId: Number(req.query.lead_id) || null, exceptAccountId: Number(req.query.account_id) || null });
    if (dup) out.duplicate = { ...dup, message: contacts.duplicateMessage(dup) };
    res.json(out);
  });

  // ── Quotations (CRM-10/11) ──
  // newest version of every quotation number (SQL: id IN (SELECT MAX(id) … GROUP BY number))
  async function latestQuoteIds() {
    const g = await prisma.quotation.groupBy({ by: ['number'], _max: { id: true } });
    return g.map(x => x._max.id);
  }
  r.get('/quotations', staff, async (req, res) => {
    const rows = await prisma.quotation.findMany({ where: { id: { in: await latestQuoteIds() } }, orderBy: { id: 'desc' } });
    res.json(await quoteViews(rows));
  });
  r.get('/pricing/frequency', staff, (req, res) => {
    const fErr = frequencyError(req.query.unit, Number(req.query.count));
    if (fErr) return res.status(400).json({ error: fErr });
    const visits = visitsPerMonth(req.query.unit, Number(req.query.count)), price = Math.max(0, Number(req.query.unit_price) || 0);
    res.json({ unit: req.query.unit, count: Number(req.query.count), visits_per_month: visits, label: frequencyLabel(req.query.unit, Number(req.query.count)), line_total: money(visits * price) });
  });
  r.get('/quotations/:id', staff, async (req, res) => {
    const qt = await quoteView(await findById('quotation', req.params.id));
    if (!qt) return res.status(404).json({ error: 'Not found' });
    qt.versions = await prisma.quotation.findMany({ where: { number: qt.number }, select: { id: true, version: true, total: true, status: true, created_at: true }, orderBy: { version: 'desc' } });
    res.json(qt);
  });
  async function planFromBody(b) {
    const plan = b.plan || {};
    const err = validateRule(plan.recurrence);
    if (err) return { err };
    if (plan.time_window && !WIN_RX.test(plan.time_window)) return { err: security.windowError(plan.time_window) };
    if (plan.start_date && !security.isRealDate(plan.start_date)) return { err: 'Plan start date is not a valid date' };
    if (plan.end_date && (!security.isRealDate(plan.end_date) || (plan.start_date && plan.end_date < plan.start_date))) return { err: 'Plan end date is invalid or before the start date' };
    return { plan: { recurrence: plan.recurrence, time_window: plan.time_window || await getSetting('default_time_window', '07:00-12:00'),
      start_date: plan.start_date || null, end_date: plan.end_date || null, billing: plan.billing === 'per_visit' ? 'per_visit' : 'monthly' } };
  }
  r.post('/quotations', staff, async (req, res) => {
    const b = req.body || {};
    const lead = await findById('lead', b.lead_id);
    if (!lead) return res.status(400).json({ error: 'lead_id required' });
    const iErr = quoteItemsError(b.items); if (iErr) return res.status(400).json({ error: iErr });
    const calc = calcQuote(b.items);
    if (!calc.items.length || calc.total <= 0) return res.status(400).json({ error: 'Add at least one priced line item' });
    const pp = await planFromBody(b); if (pp.err) return res.status(400).json({ error: pp.err });
    let number = await nextQuoteNumber(), version = 1;
    if (b.revise_of) {
      const prev = await findById('quotation', b.revise_of);
      if (!prev) return res.status(404).json({ error: 'Quotation to revise not found' });
      number = prev.number;
      version = (await prisma.quotation.aggregate({ where: { number }, _max: { version: true } }))._max.version + 1;
      await prisma.quotation.updateMany({ where: { number, status: { in: ['draft', 'sent'] } }, data: { status: 'superseded' } });
    }
    const valid = String(b.valid_until || addDays(ymd(), 30));
    const qt = await prisma.quotation.create({
      data: {
        lead_id: lead.id, number, version, items: JSON.stringify(calc.items), plan: JSON.stringify(pp.plan), subtotal: calc.subtotal, vat: calc.vat, total: calc.total,
        valid_until: valid, status: 'draft', share_token: crypto.randomBytes(12).toString('hex'), notes: String(b.notes || ''), created_by: req.user.id,
      },
    });
    if (['new', 'contacted'].includes(lead.stage)) await prisma.lead.update({ where: { id: lead.id }, data: { stage: 'quoted', updated_at: sqlNow() } });
    await audit(req, 'quotation', qt.id, b.revise_of ? `revise → v${version}` : 'create', null, { number, version, ...calc });
    res.json({ ok: true, id: qt.id, number, version });
  });
  r.post('/quotations/:id/status', staff, async (req, res) => {
    const qt = await findById('quotation', req.params.id);
    if (!qt) return res.status(404).json({ error: 'Not found' });
    const st = String(req.body?.status || '');
    if (!['accepted', 'rejected', 'draft', 'sent'].includes(st)) return res.status(400).json({ error: 'Invalid status' });
    await prisma.quotation.update({ where: { id: qt.id }, data: { status: st, ...(st === 'accepted' ? { accepted_at: sqlNow() } : {}) } });
    if (st === 'rejected' && qt.lead_id) {
      const lead = await prisma.lead.findUnique({ where: { id: qt.lead_id }, select: { lost_reason: true } });
      if (lead) await prisma.lead.update({ where: { id: qt.lead_id }, data: { stage: 'lost', lost_reason: lead.lost_reason ?? 'Quote rejected' } });
    }
    await audit(req, 'quotation', qt.id, 'status → ' + st, { status: qt.status }, { status: st });
    res.json({ ok: true });
  });
  // printable / PDF (token via ?t=)
  r.get('/quotations/:id/pdf', staff, async (req, res) => {
    const qv = await quoteView(await findById('quotation', req.params.id));
    if (!qv) return res.status(404).send('Not found');
    res.type('html').send(await quoteHtml(qv, { print: req.query.print === '1', embed: req.query.embed === '1' }));
  });
  // STEP 1 — the quotation goes out by Gmail, and only after the sender has seen the preview.
  const quoteBase = req => String((req.body && req.body.base_url) || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  function recipientFor(req, lead) {
    const raw = String(req.body?.to || lead.email || '').trim();
    if (!raw) return { error: 'This lead has no email address. Add one to the lead, or type it here.', code: 'NO_EMAIL' };
    const e = contacts.parseEmail(raw);
    return e.ok ? { to: e.email } : { error: e.error, code: 'BAD_EMAIL' };
  }
  // The exact email + a token that proves it was looked at. Nothing is sent or logged here.
  r.post('/quotations/:id/preview', staff, async (req, res) => {
    const qv = await quoteView(await findById('quotation', req.params.id));
    if (!qv) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'sent'].includes(qv.status)) return res.status(409).json({ error: `This quotation is ${qv.status} and can no longer be sent` });
    const rc = recipientFor(req, qv.lead || {}); if (rc.error) return res.status(400).json(rc);
    const mail = await quoteMail(qv, rc.to, quoteBase(req));
    const st = mailer.status();
    res.json({ ok: true, to: mail.to, from: st.sender || null, from_name: st.from_name, reply_to: mail.replyTo || null, subject: mail.subject, html: mail.html, text: mail.text, link: mail.link,
      delivery: st.configured ? 'sent' : 'compose', preview_token: previewToken(qv, mail),
      quotation: { id: qv.id, number: qv.number, version: qv.version, total: qv.total, valid_until: qv.valid_until, customer: (qv.lead || {}).company || (qv.lead || {}).contact || '' } });
  });
  //   via: 'gmail' (default, needs preview_token) | 'whatsapp' | 'pdf'
  r.post('/quotations/:id/send', staff, async (req, res) => {
    const qv = await quoteView(await findById('quotation', req.params.id));
    if (!qv) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'sent'].includes(qv.status)) return res.status(409).json({ error: `This quotation is ${qv.status} and can no longer be sent` });
    const lead = qv.lead || {};
    const via = ['whatsapp', 'pdf'].includes(req.body?.via) ? req.body.via : 'gmail';
    const markSent = async (how, to, link) => {
      // SQL: status = CASE WHEN status='draft' THEN 'sent' ELSE status END
      await prisma.quotation.update({ where: { id: qv.id }, data: { status: qv.status === 'draft' ? 'sent' : qv.status, sent_via: how, sent_to: to || null, sent_at: sqlNow() } });
      if (lead.id) await prisma.lead.update({ where: { id: lead.id }, data: { stage: ['new', 'contacted', 'qualified'].includes(lead.stage) ? 'quoted' : lead.stage, updated_at: sqlNow() } });
      await audit(req, 'quotation', qv.id, 'sent via ' + how, null, { link, to: to || null });
    };
    if (via !== 'gmail') {
      const link = `${quoteBase(req)}/q/${qv.share_token}`;
      const text = quoteEmailText(qv, link);
      await markSent(via, via === 'whatsapp' ? lead.phone : null, link);
      return res.json({ ok: true, via, link, whatsapp_url: waLink(lead.phone, text), text });
    }
    const rc = recipientFor(req, lead); if (rc.error) return res.status(400).json(rc);
    const mail = await quoteMail(qv, rc.to, quoteBase(req));
    const seen = String(req.body?.preview_token || '');
    if (!seen) return res.status(428).json({ error: 'Preview the quotation email before sending it.', code: 'PREVIEW_REQUIRED' });
    if (seen !== previewToken(qv, mail)) return res.status(409).json({ error: 'The quotation or the recipient changed after you previewed it. Preview it again before sending.', code: 'PREVIEW_STALE' });
    const st = mailer.status();
    // fallback: 'compose' → the server could not reach Gmail, the user sends the same previewed message from their own Gmail tab
    if (!st.configured || req.body?.fallback === 'compose') {
      // Gmail not connected on the server yet → hand the user a pre-filled Gmail compose window
      await markSent('gmail', mail.to, mail.link);
      return res.json({ ok: true, via: 'gmail', delivery: 'compose', to: mail.to, link: mail.link, gmail_compose_url: mailer.composeUrl(mail), text: mail.text });
    }
    try {
      await mailer.send(mail);
    } catch (e) {
      // nothing is marked as sent when the email did not go out
      return res.status(e.status || 502).json({ error: `Email not sent. ${e.message || mailer.describe(e)}`, code: e.code || 'MAIL_FAILED', gmail_compose_url: mailer.composeUrl(mail) });
    }
    await markSent('gmail', mail.to, mail.link);
    res.json({ ok: true, via: 'gmail', delivery: 'sent', to: mail.to, link: mail.link, from: st.sender });
  });
  r.get('/mail/status', staff, (req, res) => res.json(mailer.status()));
  r.post('/mail/test', owner, async (req, res) => {
    const to = String(req.body?.to || '').trim();
    try { await mailer.send({ to, subject: 'GreenLoop — Gmail connection test', text: 'Gmail is connected. Quotations will be sent from this address.' }); res.json({ ok: true, to }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message || mailer.describe(e), code: e.code || 'MAIL_FAILED' }); }
  });

  // ── Convert accepted quote → customer (CRM-12) ──
  r.post('/quotations/:id/convert', staff, async (req, res) => {
    const qv = await quoteView(await findById('quotation', req.params.id));
    if (!qv) return res.status(404).json({ error: 'Not found' });
    if (qv.status !== 'accepted') return res.status(409).json({ error: 'Only an accepted quotation can be converted' });
    const lead = qv.lead;
    if (!lead) return res.status(400).json({ error: 'Quotation has no lead' });
    if (lead.customer_id) return res.status(409).json({ error: 'Already converted' });
    const sites = (lead.sites || []).filter(s => s && (s.name || s.address));
    if (!sites.length) return res.status(400).json({ error: 'Lead needs at least one site with zone and coordinates' });
    for (const s of sites) {
      if (!s.zone || !isFinite(Number(s.lat)) || !isFinite(Number(s.lng)) || s.lat === '' || s.lng === '')
        return res.status(400).json({ error: `Site "${s.name || s.address}" needs zone, lat and lng (enter once, no geocoding API)` });
    }
    const dupC = await contacts.findDuplicate({ phone: lead.phone, email: lead.email }, { exceptLeadId: lead.id });
    if (dupC && dupC.type === 'customer') return res.status(409).json({ error: contacts.duplicateMessage(dupC), code: 'DUPLICATE', duplicate: dupC });
    const code = await uniquePortalCode();
    const start = qv.plan.start_date && qv.plan.start_date >= ymd() ? qv.plan.start_date : ymd();
    let accountId = null; const created = [];
    for (const s of sites) {
      const site = await prisma.customer.create({
        data: {
          name: String(lead.company || lead.contact), branch: String(s.name || ''), zone: String(s.zone), frequency: 2, lat: Number(s.lat), lng: Number(s.lng),
          address: String(s.address || ''), contact_phone: lead.phone || '', email: lead.email || '', time_window: str(qv.plan.time_window),
          account_id: accountId, portal_code_hash: accountId ? null : bcrypt.hashSync(code, 10), access_notes: s.access_notes ? String(s.access_notes) : null,
        },
      });
      const cid = site.id;
      if (!accountId) { accountId = cid; await prisma.customer.update({ where: { id: cid }, data: { account_id: cid } }); }
      const items = qv.items.filter(i => !i.site || i.site === s.name);
      const byService = {};
      items.forEach(i => { byService[i.service_code] ||= i; });
      for (const [code2, it] of Object.entries(byService)) {
        const plan = await prisma.servicePlan.create({
          data: {
            customer_id: cid, service_code: code2, recurrence: JSON.stringify(recurrenceForLine(it, qv.plan.recurrence)), time_window: String(qv.plan.time_window || '07:00-12:00'),
            start_date: start, end_date: qv.plan.end_date || null, unit_price: Number(it.unit_price) || 0, billing: qv.plan.billing, quotation_id: qv.id,
          },
        });
        created.push({ customer_id: cid, plan_id: plan.id });
      }
    }
    await prisma.lead.update({ where: { id: lead.id }, data: { stage: 'won', customer_id: accountId, updated_at: sqlNow() } });
    await prisma.quotation.update({ where: { id: qv.id }, data: { status: 'converted' } });
    let jobs = 0;
    for (const c of created) jobs += (await generatePlans({ planId: c.plan_id })).created;
    await audit(req, 'quotation', qv.id, 'convert → customer', null, { account_id: accountId, sites: sites.length, plans: created.length, jobs });
    const portal = `${req.protocol}://${req.get('host')}/customer/`;
    const msg = `Welcome to GreenLoop, ${lead.contact}! Your customer app: ${portal}\nSign in with your mobile number ${lead.phone ? contacts.formatPhone(lead.phone) : ''} and your 4-digit code: ${code}\nYou can also ask the app to email you a one-time code${lead.email ? ' at ' + lead.email : ''}.\nTurn on notifications in the app — your invoices (with PDF), visit proof and reminders arrive there.`;
    io.to('staff').emit('ledger:refresh', {});
    // STEP 2 — registration: the app is waiting with a welcome message, access goes out by Gmail
    await notifyCustomer(accountId, 'welcome', 'Welcome to GreenLoop', 'Your account is ready. Invoices, visit proof and reminders will arrive here — turn on notifications so you never miss one.', '/customer/');
    const welcome = { to: lead.email, subject: 'Welcome to GreenLoop — your customer app access', text: msg, replyTo: await getSetting('company_email', '') };
    let email = { sent: false, to: lead.email || null, gmail_compose_url: mailer.isEmail(lead.email) ? mailer.composeUrl(welcome) : null };
    if (mailer.isEmail(lead.email) && mailer.status().configured) {
      try { await mailer.send(welcome); email.sent = true; } catch (e) { email.error = e.message || mailer.describe(e); }
    }
    res.json({ ok: true, customer_id: accountId, sites: sites.length, plans: created.length, jobs_generated: jobs,
      portal_code: code, portal_url: portal, email, whatsapp_url: waLink(lead.phone, msg) });
  });

  // ── Pipeline dashboard (CRM-16) ──
  r.get('/pipeline/stats', staff, async (req, res) => {
    const by = Object.fromEntries(STAGES.map(s => [s, 0]));
    (await prisma.lead.groupBy({ by: ['stage'], _count: { _all: true } })).forEach(x => { by[x.stage] = x._count._all; });
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const allQuotes = await prisma.quotation.findMany({ select: { id: true, lead_id: true, total: true, status: true, sent_at: true } });
    const quoted = new Set(allQuotes.map(x => x.lead_id).filter(x => x != null)).size;     // COUNT(DISTINCT lead_id)
    const won = by.won;
    const latest = new Set(await latestQuoteIds());
    const pipelineValue = allQuotes.filter(x => ['draft', 'sent'].includes(x.status) && latest.has(x.id)).reduce((a, x) => a + x.total, 0);
    const wonValue = allQuotes.filter(x => ['accepted', 'converted'].includes(x.status)).reduce((a, x) => a + x.total, 0);
    const leads = await prisma.lead.findMany({ select: { id: true, contact: true, company: true, stage: true, source: true, follow_up_at: true, created_at: true } });
    // leads that got a quotation within 24 hours of being created
    const ms = (s) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    const quotesByLead = groupBy(allQuotes.filter(x => x.sent_at), x => x.lead_id);
    const fast = leads.filter(l => (quotesByLead.get(l.id) || []).some(x => (ms(x.sent_at) - ms(l.created_at)) / 3600e3 <= 24)).length;
    const sources = [...groupBy(leads, l => l.source)]
      .map(([source, list]) => ({ source, c: list.length, won: list.filter(l => l.stage === 'won').length }))
      .sort((a, b) => b.c - a.c);
    const followUps = sortBy(leads.filter(l => l.follow_up_at != null && !['won', 'lost'].includes(l.stage)), l => l.follow_up_at).slice(0, 8)
      .map(l => ({ id: l.id, contact: l.contact, company: l.company, stage: l.stage, follow_up_at: l.follow_up_at }));
    res.json({ by_stage: by, total, quoted, won,
      lead_to_quote_pct: total ? Math.round(100 * quoted / total) : 0,
      quote_to_customer_pct: quoted ? Math.round(100 * won / quoted) : 0,
      lead_to_customer_pct: total ? Math.round(100 * won / total) : 0,
      quote_within_24h_pct: quoted ? Math.round(100 * fast / quoted) : 0,
      pipeline_value: money(pipelineValue), won_value: money(wonValue), sources, follow_ups: followUps });
  });

  // ── Service plans (§7) ──
  // plans + customer name/branch/zone + service name/category
  async function planRows(where) {
    let rows = await prisma.servicePlan.findMany({ where, orderBy: { id: 'asc' } });
    rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true });
    return join(rows, 'service_code', 'serviceType', { service_name: 'name', category: 'category' }, { key: 'code' });
  }
  r.get('/service-plans', staff, async (req, res) => {
    const cid = req.query.customer_id ? (toId(req.query.customer_id) ?? -1) : null;
    const rows = sortBy(await planRows(cid ? { customer_id: cid } : {}), p => p.name, p => p.id);
    res.json(rows.map(p => ({ ...p, recurrence: J(p.recurrence, {}), rule_label: describeRule(J(p.recurrence, {})) })));
  });
  // create or update a plan → { status, body } (the caller sends it)
  async function upsertPlan(req, customerId, existing) {
    const b = { ...(existing ? { ...existing, recurrence: J(existing.recurrence, {}) } : {}), ...(req.body || {}) };
    const err = validateRule(b.recurrence); if (err) return { status: 400, body: { error: err } };
    if (b.time_window && !WIN_RX.test(b.time_window)) return { status: 400, body: { error: security.windowError(b.time_window) } };
    if (!b.start_date) b.start_date = ymd();
    if (!security.isRealDate(b.start_date)) return { status: 400, body: { error: 'Start date is not a valid date' } };
    if (b.end_date && !security.isRealDate(b.end_date)) return { status: 400, body: { error: 'End date is not a valid date' } };
    if (b.end_date && b.end_date < b.start_date) return { status: 400, body: { error: 'End date is before start date' } };
    const st = await prisma.serviceType.findUnique({ where: { code: String(b.service_code || 'WASTE') } });
    if (!st) return { status: 400, body: { error: 'Unknown service type' } };
    const price = b.unit_price != null && b.unit_price !== '' ? money(b.unit_price) : st.default_price;
    const fields = {
      service_code: st.code, recurrence: JSON.stringify(b.recurrence), time_window: String(b.time_window || '07:00-12:00'), start_date: String(b.start_date),
      end_date: str(b.end_date || null), unit_price: price, billing: b.billing === 'per_visit' ? 'per_visit' : 'monthly',
    };
    let id;
    if (existing) {
      await prisma.servicePlan.update({
        where: { id: existing.id },
        data: { ...fields, paused: b.paused ? 1 : 0, pause_from: str(b.pause_from || null), pause_to: str(b.pause_to || null), status: b.status === 'ended' ? 'ended' : 'active', updated_at: sqlNow() },
      });
      id = existing.id;
    } else {
      id = (await prisma.servicePlan.create({ data: { customer_id: customerId, ...fields } })).id;
    }
    const out = await regeneratePlan(id);
    await audit(req, 'service_plan', id, existing ? 'update' : 'create', existing, b);
    io.to('staff').emit('ledger:refresh', {});
    return { status: 200, body: { ok: true, id, ...out } };
  }
  r.post('/service-plans', staff, async (req, res) => {
    const c = await findById('customer', req.body?.customer_id, { select: { id: true } });
    if (!c) return res.status(400).json({ error: 'customer_id required' });
    const out = await upsertPlan(req, c.id, null);
    res.status(out.status).json(out.body);
  });
  r.put('/service-plans/:id', staff, async (req, res) => {
    const p = await findById('servicePlan', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const out = await upsertPlan(req, p.customer_id, p);
    res.status(out.status).json(out.body);
  });
  r.post('/service-plans/generate', staff, async (req, res) => res.json(await generatePlans({ days: 14 })));

  // ── Ad-hoc order (CRM-04, real implementation) ──
  r.post('/pickups/adhoc', staff, async (req, res) => {
    const { customer_id, date, vehicle_id, service_code, time_window } = req.body || {};
    const cid = toId(customer_id);
    const c = cid ? await prisma.customer.findFirst({ where: { id: cid, is_active: 1 } }) : null;
    if (!c) return res.status(400).json({ error: 'Choose an active client' });
    const dErr = security.dateInRange(date, { futureDays: 366 }); if (dErr) return res.status(400).json({ error: dErr });
    if (time_window && !WIN_RX.test(time_window)) return res.status(400).json({ error: security.windowError(time_window) });
    const code = String(service_code || 'WASTE');
    // SQL: COALESCE(service_type,'WASTE') = code
    const sameService = code === 'WASTE' ? { OR: [{ service_type: 'WASTE' }, { service_type: null }] } : { service_type: code };
    if (await prisma.pickup.findFirst({ where: { customer_id: c.id, scheduled_date: date, status: { in: ['pending', 'overdue', 'collected'] }, ...sameService }, select: { id: true } }))
      return res.status(409).json({ error: 'This client already has this service on that date' });
    if (vehicle_id) {
      const vid = toId(vehicle_id);
      const v = vid ? await prisma.vehicle.findFirst({ where: { id: vid, is_active: 1 } }) : null;
      if (!v) return res.status(400).json({ error: 'Vehicle not found' });
      if (await loadOf(v.id, date) >= await capacityFor(v, date)) return res.status(409).json({ error: `${v.fleet_number} is full on ${date}` });
      const drv = await prisma.user.findFirst({ where: { role: 'driver', is_active: 1, vehicle_id: v.id }, select: { id: true }, orderBy: { id: 'asc' } });
      const job = await prisma.pickup.create({
        data: {
          customer_id: c.id, vehicle_id: v.id, driver_id: drv ? drv.id : null, scheduled_date: date, seq: 999, status: 'pending', service_type: code,
          time_window: time_window || c.time_window || await getSetting('default_time_window', '07:00-12:00'),
        },
      });
      await resequence(v.id, date);
      await audit(req, 'pickup', job.id, 'ad-hoc create', null, req.body);
      io.to('staff').emit('ledger:refresh', { date }); io.to('staff').emit('driver:queue-updated', { vehicle_id: v.id, date });
      await notifyVehicleDrivers(v.id, 'New stop added', `${c.name}${c.branch ? ' · ' + c.branch : ''} on ${dmy(date)}`);
      return res.json({ ok: true, id: job.id, vehicle: v.fleet_number });
    }
    const out = await createJob({ customer: c, date, serviceCode: service_code, window: time_window });
    await audit(req, 'pickup', out.id, 'ad-hoc create (auto-allocated)', null, req.body);
    io.to('staff').emit('ledger:refresh', { date });
    res.json({ ok: true, ...out });
  });

  // ── One-off bookings (CUS-07) ──
  r.get('/bookings', staff, async (req, res) => {
    let rows = await join(await prisma.booking.findMany({ orderBy: { id: 'asc' } }), 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true });
    sortBy(rows, desc(b => (b.status === 'requested' ? 1 : 0)), b => b.date);    // ORDER BY status='requested' DESC, date
    // Green rewards perk: requests from Tree / Forest sites go first (lazy require: growth.js loads after this file)
    let tierOf = null; try { tierOf = require('./growth').tierOf; } catch { tierOf = null; }
    if (!tierOf) return res.json(rows);
    const t = {};
    for (const b of rows) if (!(b.customer_id in t)) t[b.customer_id] = await tierOf(b.customer_id);
    const out = rows.map(b => ({ ...b, tier: t[b.customer_id].name, priority: b.status === 'requested' && t[b.customer_id].level >= 3 }));
    out.sort((a, b) => (b.status === 'requested') - (a.status === 'requested') || b.priority - a.priority);
    res.json(out);
  });
  r.post('/bookings/:id/decide', staff, async (req, res) => {
    const b = await findById('booking', req.params.id);
    if (!b || b.status !== 'requested') return res.status(404).json({ error: 'Booking not open' });
    if (req.body?.approve) {
      const c = await prisma.customer.findUnique({ where: { id: b.customer_id } });
      const date = req.body.date || b.date;
      const dErr = security.dateInRange(date, { futureDays: 366 }); if (dErr) return res.status(400).json({ error: dErr });
      const out = await createJob({ customer: c, date, serviceCode: b.service_code, window: b.time_window });
      await prisma.booking.update({ where: { id: b.id }, data: { status: 'confirmed', pickup_id: out.id, date } });
      await notifyCustomer(b.customer_id, 'booking', 'Booking confirmed', `Extra visit confirmed for ${date}${out.vehicle ? ' · ' + out.vehicle : ''}`);
    } else {
      await prisma.booking.update({ where: { id: b.id }, data: { status: 'declined' } });
      await notifyCustomer(b.customer_id, 'booking', 'Booking not possible', `We could not schedule ${b.date}. ${req.body?.reason || 'Our team will call you.'}`);
    }
    await audit(req, 'booking', b.id, req.body?.approve ? 'confirm' : 'decline', b, req.body);
    io.to('staff').emit('ledger:refresh', {});
    res.json({ ok: true });
  });

  // ── Invoices & payments (CRM-14) ──
  r.get('/invoices', staff, async (req, res) => {
    const where = req.query.customer_id ? { customer_id: toId(await accountOf(req.query.customer_id)) ?? -1 } : {};
    const rows = await invoiceViews(await prisma.invoice.findMany({ where, orderBy: { id: 'desc' }, take: 500 }));
    const summary = rows.reduce((a, i) => { if (i.status_label !== 'Void') { a.billed += i.amount; a.collected += i.paid; a.outstanding += i.balance; if (i.status_label === 'Overdue') a.overdue += i.balance; } return a; },
      { billed: 0, collected: 0, outstanding: 0, overdue: 0 });
    Object.keys(summary).forEach(k => { summary[k] = money(summary[k]); });
    // count in MongoDB instead of loading every unbilled job
    const unbilled = await prisma.pickup.count({ where: { status: 'collected', invoice_id: null, OR: [{ billable: null }, { billable: 1 }] } });
    res.json({ rows, summary, unbilled_jobs: unbilled });
  });
  r.post('/invoices/generate', owner, async (req, res) => {
    const period = String(req.body?.period || ymd().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    const out = await generateInvoices(period, req.body?.customer_id || null);
    await audit(req, 'invoice', null, 'generate ' + period, null, { count: out.length });
    res.json({ ok: true, created: out.length, invoices: out });
  });
  r.get('/invoices/:id/pdf', need('admin', 'ops', 'customer'), async (req, res) => {
    const inv = await findById('invoice', req.params.id);
    if (!inv) return res.status(404).send('Not found');
    if (req.user.eff === 'customer' && await accountOf(custId(req)) !== inv.customer_id) return res.status(403).send('Forbidden');
    res.type('html').send(await invoiceHtml(await invoiceView(inv), req.query.print === '1'));
  });
  // STEP 3 — (re)send an invoice to the customer app: in-app inbox + push, link opens the PDF
  r.post('/invoices/:id/send', owner, async (req, res) => {
    const inv = await findById('invoice', req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (inv.status === 'void') return res.status(409).json({ error: 'A void invoice cannot be sent' });
    const v = await invoiceView(inv);
    const body = v.balance > 0.004
      ? `AED ${v.balance.toFixed(2)} due ${dmy(inv.due_date)} — tap to view the PDF`
      : `AED ${inv.amount.toFixed(2)} — paid in full. Tap to view the PDF`;
    const pushed = await notifyCustomer(inv.customer_id, 'invoice', `Invoice ${inv.number}`, body, '/customer/#invoices');
    await prisma.invoice.update({ where: { id: inv.id }, data: { sent_at: sqlNow(), sent_count: { increment: 1 } } });   // atomic +1
    await audit(req, 'invoice', inv.id, 'sent to customer app', null, { devices: pushed.devices, delivered: pushed.delivered });
    res.json({ ok: true, in_app: true, push: pushed });
  });
  r.post('/invoices/:id/void', owner, async (req, res) => {
    const inv = await findById('invoice', req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (await prisma.payment.count({ where: { invoice_id: inv.id } })) return res.status(409).json({ error: 'Invoice has payments — cannot void' });
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'void' } });
    await prisma.pickup.updateMany({ where: { invoice_id: inv.id }, data: { invoice_id: null } });
    await audit(req, 'invoice', inv.id, 'void', inv, null);
    res.json({ ok: true });
  });
  r.post('/payments', owner, async (req, res) => {
    const { invoice_id, amount, method, reference, received_at } = req.body || {};
    const inv = await findById('invoice', invoice_id);
    if (!inv || inv.status === 'void') return res.status(400).json({ error: 'Invoice not found or void' });
    const v = await invoiceView(inv), amt = money(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be positive' });
    if (amt > v.balance + 0.004) return res.status(400).json({ error: `Amount exceeds balance (AED ${v.balance.toFixed(2)})` });
    if (!['cash', 'card', 'transfer', 'cheque', 'online'].includes(method)) return res.status(400).json({ error: 'Method must be cash, card, transfer, cheque or online' });
    const pay = await prisma.payment.create({
      data: { invoice_id: inv.id, amount: amt, method, reference: String(reference || ''), received_at: String(received_at || nowIso()), recorded_by: str(req.user.name) },
    });
    await audit(req, 'payment', pay.id, 'record', { balance: v.balance }, { invoice: inv.number, amount: amt, method, reference });
    await notifyCustomer(inv.customer_id, 'payment', 'Payment received', `AED ${amt.toFixed(2)} received for ${inv.number}. Thank you!`, '/customer/#invoices');
    res.json({ ok: true, id: pay.id, balance: (await invoiceView(inv)).balance });
  });
  // payments + their invoice number (+ customer id/name)
  async function paymentRows(invoiceWhere, withCustomer) {
    const invoices = await prisma.invoice.findMany({ where: invoiceWhere, select: { id: true, number: true, customer_id: true } });
    const byId = new Map(invoices.map(i => [i.id, i]));
    let rows = (await prisma.payment.findMany({ where: { invoice_id: { in: invoices.map(i => i.id) } } }))
      .map(p => ({ ...p, number: byId.get(p.invoice_id).number, ...(withCustomer ? { customer_id: byId.get(p.invoice_id).customer_id } : {}) }));
    if (withCustomer) rows = await join(rows, 'customer_id', 'customer', ['name'], { inner: true });
    return sortBy(rows, desc(p => p.received_at), desc(p => p.id));
  }
  r.get('/payments', staff, async (req, res) => res.json((await paymentRows({}, true)).slice(0, 300)));

  // ── Customer 360 (CRM-15) ──
  r.get('/customers/:id/360', staff, async (req, res) => {
    const c = await findById('customer', req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const acct = c.account_id || c.id;
    const sites = await prisma.customer.findMany({ where: accountSites(acct), select: { id: true, name: true, branch: true, zone: true, address: true, lat: true, lng: true, is_active: true }, orderBy: { id: 'asc' } });
    const ids = sites.map(s => s.id);
    const plans = (await join(await prisma.servicePlan.findMany({ where: { customer_id: { in: ids } }, orderBy: { id: 'asc' } }), 'service_code', 'serviceType', { service_name: 'name' }, { key: 'code' }))
      .map(p => ({ ...p, rule_label: describeRule(J(p.recurrence, {})) }));
    let visits = await prisma.pickup.findMany({
      where: { customer_id: { in: ids } },
      select: { id: true, scheduled_date: true, status: true, service_type: true, photo_url: true, anomaly_reason: true, confirmation_status: true, completed_at: true, notes: true, customer_id: true, driver_id: true },
      orderBy: [{ scheduled_date: 'desc' }, { id: 'desc' }], take: 60,
    });
    visits = await join(visits, 'customer_id', 'customer', ['branch'], { inner: true });
    visits = (await join(visits, 'driver_id', 'user', { driver: 'full_name' })).map(({ driver_id, ...v }) => v);
    const invoices = await invoiceViews(await prisma.invoice.findMany({ where: { customer_id: acct }, orderBy: { id: 'desc' } }));
    const payments = await paymentRows({ customer_id: acct }, false);
    const lead = await prisma.lead.findFirst({ where: { customer_id: acct } });
    const since30 = addDays(ymd(), -30);
    const noPick30 = await prisma.pickup.count({ where: { customer_id: { in: ids }, status: 'canceled', confirmation_status: { in: ['confirmed', 'auto_confirmed'] }, scheduled_date: { gte: since30 } } });
    const last90 = await prisma.pickup.findMany({ where: { customer_id: { in: ids }, scheduled_date: { gte: addDays(ymd(), -90), lte: ymd() }, status: { not: 'rescheduled' } }, select: { status: true } });
    const done90 = { ok: last90.filter(p => p.status === 'collected').length, n: last90.length };
    const overdue = invoices.filter(i => i.status_label === 'Overdue').reduce((a, i) => a + i.balance, 0);
    let risk = 0;
    risk += Math.min(40, noPick30 * 12);
    risk += done90.n ? Math.round(30 * (1 - (done90.ok || 0) / done90.n)) : 0;
    risk += overdue > 0 ? Math.min(30, 10 + Math.round(overdue / 200)) : 0;
    res.json({ customer: c, sites, plans, visits, invoices, payments, lead: lead ? { ...lead, sites: J(lead.sites, []) } : null,
      balance: money(invoices.reduce((a, i) => a + (i.status_label === 'Void' ? 0 : i.balance), 0)),
      risk: { score: Math.min(100, risk), no_pickups_30d: noPick30, completion_90d: done90.n ? Math.round(100 * (done90.ok || 0) / done90.n) : null, overdue: money(overdue) },
      whatsapp_url: waLink(c.contact_phone, `Hello from GreenLoop regarding ${c.name} ${c.branch || ''}.`),
      maps_url: mapsDir(c.lat, c.lng) });
  });
  r.post('/customers/:id/portal-code', owner, async (req, res) => {
    const c = await findById('customer', req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const code = await uniquePortalCode();
    await prisma.customer.updateMany({ where: { id: c.account_id || c.id }, data: { portal_code_hash: bcrypt.hashSync(code, 10) } });
    await audit(req, 'customer', c.id, 'reset portal code', null, null);
    res.json({ ok: true, portal_code: code, whatsapp_url: waLink(c.contact_phone, `Your GreenLoop app code is ${code}. Sign in to the customer app with this mobile number and the 4-digit code.`) });
  });

  // ── Not picked up: confirmation (CUS-10) + override ──
  // ORDER BY confirmation_status='awaiting' DESC, confirmation_status='disputed' DESC, scheduled_date DESC
  const confirmationOrder = [desc(p => (p.confirmation_status === 'awaiting' ? 1 : 0)), desc(p => (p.confirmation_status === 'disputed' ? 1 : 0)), desc(p => p.scheduled_date), desc(p => p.id)];
  r.get('/confirmations', staff, async (req, res) => {
    let rows = await prisma.pickup.findMany({
      where: { confirmation_status: { not: null } },
      select: { id: true, scheduled_date: true, anomaly_reason: true, photo_url: true, confirmation_status: true, confirm_deadline: true, proof_meta: true, customer_id: true, driver_id: true },
    });
    rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'contact_phone'], { inner: true });
    rows = sortBy(await join(rows, 'driver_id', 'user', { driver: 'full_name' }), ...confirmationOrder).slice(0, 100);
    res.json(rows.map(({ driver_id, ...x }) => ({ ...x, whatsapp_url: waLink(x.contact_phone, `GreenLoop: our driver could not complete the visit at ${x.name} ${x.branch || ''} on ${x.scheduled_date} (${String(x.anomaly_reason || '').replace(/_/g, ' ').toLowerCase()}). Please confirm or dispute in your portal.`) })));
  });
  async function resolveNoPickup(req, p, action, note, by) {
    if (!p || p.status !== 'canceled') return { code: 404, error: 'No "not picked up" job to confirm' };
    if (p.confirmation_status !== 'awaiting' && by !== 'override') return { code: 409, error: `Already ${p.confirmation_status}` };
    const c = await prisma.customer.findUnique({ where: { id: p.customer_id } });
    if (action === 'confirm') {
      await prisma.pickup.update({ where: { id: p.id }, data: { confirmation_status: 'confirmed', billable: 0, notes: (p.notes || '') + (note ? ` [confirm: ${note}]` : '') } });
      await prisma.alert.create({ data: { type: 'RESCHEDULED', severity: 'info', message: `No-pickup confirmed by ${by} — ${c.name} ${c.branch || ''} (not billed)`, pickup_id: p.id } });
      await checkAttention(c);
      return { ok: true, status: 'Canceled – confirmed, not billed' };
    }
    if (action === 'dispute') {
      await prisma.pickup.update({ where: { id: p.id }, data: { confirmation_status: 'disputed', billable: 0, notes: (p.notes || '') + ` [dispute: ${note || 'no reason'}]` } });
      const hol = await holidays();
      let date = addDays(ymd(), 1), out = null;
      for (let i = 0; i < 7 && !out; i++) {
        const d = addDays(date, i);
        if (hol.has(d)) continue;
        const a = await allocate(c, d, p.service_type || 'WASTE');
        if (a.vehicle) out = await createJob({ customer: c, date: d, serviceCode: p.service_type, window: p.time_window, planId: p.plan_id, revisit: true, billable: true, note: `Free revisit for disputed job #${p.id}` });
      }
      // free revisit: not billed
      if (out) await prisma.pickup.update({ where: { id: out.id }, data: { billable: 0 } });
      await prisma.alert.create({ data: { type: 'RESCHEDULED', severity: 'warning', message: 'No-pickup marked as RESCHEDULED', pickup_id: p.id } });
      await alertCrm('DISPUTE', 'critical', `DISPUTE: ${c.name} (${c.branch || ''}) says job #${p.id} on ${p.scheduled_date} was not a valid no-pickup. ${note ? '“' + note + '” ' : ''}${out ? 'Free revisit booked #' + out.id : 'No capacity for revisit — schedule manually.'}`, p.id);
      await notifyCustomer(c.id, 'revisit', 'Free revisit booked', out ? `We will come back — job #${out.id}` : 'Our team will call you to arrange a revisit.');
      if (IO) IO.to('staff').emit('ledger:refresh', {});
      return { ok: true, status: 'Disputed — free revisit', revisit_id: out ? out.id : null };
    }
    return { code: 400, error: 'action must be confirm or dispute' };
  }
  r.post('/pickups/:id/confirm', need('customer', 'admin', 'ops'), async (req, res) => {
    const p = await findById('pickup', req.params.id);
    if (req.user.eff === 'customer') {
      const acct = await accountOf(custId(req));
      if (!p || await accountOf(p.customer_id) !== acct) return res.status(404).json({ error: 'Not found' });
    }
    const by = req.user.eff === 'customer' ? 'customer' : 'override';
    const out = await resolveNoPickup(req, p, req.body?.action, String(req.body?.note || '').slice(0, 300), by);
    if (out.error) return res.status(out.code).json({ error: out.error });
    if (by === 'override') await audit(req, 'pickup', p.id, 'no-pickup override → ' + req.body?.action, { confirmation_status: p.confirmation_status }, req.body);
    res.json(out);
  });
  // Ops override for a rejected proof photo (poor GPS indoors etc.) — logged
  r.post('/pickups/:id/proof-override', staff, async (req, res) => {
    const p = await findById('pickup', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (min 5 characters)' });
    if (['collected', 'rescheduled'].includes(p.status)) return res.status(409).json({ error: 'Already ' + p.status });
    const meta = J(p.proof_meta, {});
    const stamp = sqlNow();
    await prisma.pickup.update({
      where: { id: p.id },
      data: {
        status: 'collected', completed_at: stamp, updated_at: stamp, notes: (p.notes || '') + ` [ops override: ${reason}]`,
        proof_meta: JSON.stringify({ ...meta, overridden: true, override_reason: reason, override_by: req.user.name }),
      },
    });
    await audit(req, 'pickup', p.id, 'proof override → collected', meta, { reason });
    await onPickupCompleted(p.id);
    io.to('staff').emit('ledger:refresh', {});
    res.json({ ok: true });
  });
  r.get('/attention', staff, async (req, res) => {
    // GROUP BY customer HAVING COUNT(*) >= 3
    const g = await prisma.pickup.groupBy({
      by: ['customer_id'],
      where: { status: 'canceled', confirmation_status: { in: ['confirmed', 'auto_confirmed'] }, scheduled_date: { gte: addDays(ymd(), -30) } },
      _count: { _all: true },
    });
    const rows = await join(g.filter(x => x._count._all >= 3).map(x => ({ id: x.customer_id, confirmed: x._count._all })), 'id', 'customer', ['name', 'branch', 'zone'], { inner: true });
    res.json(rows.sort((a, b) => b.confirmed - a.confirmed).map(x => ({ id: x.id, name: x.name, branch: x.branch, zone: x.zone, confirmed: x.confirmed })));
  });

  // ── Audit log (CRM-18) ──
  r.get('/audit', owner, async (req, res) => {
    const ent = req.query.entity ? String(req.query.entity) : null;
    res.json(await prisma.auditLog.findMany({ where: ent ? { entity: ent } : {}, orderBy: { id: 'desc' }, take: 300 }));
  });
  // weak_password: this account still uses the seeded demo password → CRM shows a warning.
  const weakPw = new Map();   // user id → { hash, weak } (bcrypt is slow; recheck only when the hash changes)
  r.get('/me', staff, async (req, res) => {
    const u = toId(req.user.id) ? await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, password_hash: true } }) : null;
    let weak = false;
    if (u && u.password_hash) {
      const c = weakPw.get(u.id);
      if (c && c.hash === u.password_hash) weak = c.weak;
      else { weak = ['admin123', 'admin', 'password', 'greenloop'].some((p) => bcrypt.compareSync(p, u.password_hash)); weakPw.set(u.id, { hash: u.password_hash, weak }); }
    }
    res.json({ id: req.user.id, name: req.user.name, crm_role: req.user.eff, weak_password: weak });
  });
  r.put('/users/:id/crm-role', owner, async (req, res) => {
    const role = req.body?.crm_role === 'ops' ? 'ops' : 'owner';
    const uid = toId(req.params.id);
    const u = uid ? await prisma.user.findFirst({ where: { id: uid, role: 'admin' } }) : null;
    if (!u) return res.status(404).json({ error: 'CRM user not found' });
    if (u.id === req.user.id && role === 'ops') return res.status(400).json({ error: 'You cannot demote yourself' });
    await prisma.user.update({ where: { id: u.id }, data: { crm_role: role } });
    await audit(req, 'user', u.id, 'crm_role → ' + role, { crm_role: u.crm_role }, { crm_role: role });
    res.json({ ok: true });
  });
  r.get('/v3/settings', owner, async (req, res) => res.json({
    uae_holidays: J(await getSetting('uae_holidays', '[]'), []), default_time_window: await getSetting('default_time_window'),
    invoice_due_days: await getSetting('invoice_due_days'), company_whatsapp: await getSetting('company_whatsapp'), company_email: await getSetting('company_email', ''),
    mail: mailer.status(), shift_cutoff: await getSetting('shift_cutoff', '12:00') }));
  r.put('/v3/settings', owner, async (req, res) => {
    const b = req.body || {};
    if (b.uae_holidays) await setSetting('uae_holidays', JSON.stringify(b.uae_holidays.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))));
    if (b.default_time_window && WIN_RX.test(b.default_time_window)) await setSetting('default_time_window', b.default_time_window);
    if (b.invoice_due_days) await setSetting('invoice_due_days', String(Number(b.invoice_due_days) || 15));
    if (b.company_whatsapp) { const wp = contacts.parsePhone(b.company_whatsapp); if (!wp.ok) return res.status(400).json({ error: 'Company WhatsApp number: ' + wp.error }); await setSetting('company_whatsapp', wp.e164); }
    if (b.company_email !== undefined) { if (b.company_email && !mailer.isEmail(b.company_email)) return res.status(400).json({ error: 'Company email is not a valid address' }); await setSetting('company_email', b.company_email || ''); }
    if (b.shift_cutoff && /^\d{2}:\d{2}$/.test(b.shift_cutoff)) await setSetting('shift_cutoff', b.shift_cutoff);
    await audit(req, 'settings', null, 'update', null, b);
    res.json({ ok: true });
  });
  r.put('/vehicles/:id/tags', owner, async (req, res) => {
    const tags = (req.body?.service_tags || []).filter(t => ['waste', 'pest'].includes(t));
    if (!tags.length) return res.status(400).json({ error: 'Pick waste and/or pest' });
    const vid = toId(req.params.id);
    if (vid) await prisma.vehicle.updateMany({ where: { id: vid }, data: { service_tags: tags.join(',') } });
    await audit(req, 'vehicle', req.params.id, 'service tags', null, { tags });
    res.json({ ok: true });
  });

  // ── Public quotation link (from WhatsApp) + accept (CUS-11) ──
  const byToken = (token) => prisma.quotation.findFirst({ where: { share_token: String(token) } });
  r.get('/public/quotations/:token', async (req, res) => {
    const qv = await quoteView(await byToken(req.params.token));
    if (!qv) return res.status(404).type('html').send('<h3>Quotation not found</h3>');
    res.type('html').send(await quoteHtml(qv, { acceptUrl: `/api/v1/public/quotations/${req.params.token}/accept` }));
  });
  r.post('/public/quotations/:token/accept', async (req, res) => {
    const qt = await byToken(req.params.token);
    const qv = await quoteView(qt);
    if (!qv) return res.status(404).send('Not found');
    if (qv.status === 'expired') return res.status(409).type('html').send(docShell('Expired', '<h2>This quotation has expired.</h2><p>Please contact GreenLoop for a new one.</p>'));
    if (['draft', 'sent'].includes(qv.status)) {
      await prisma.quotation.update({ where: { id: qt.id }, data: { status: 'accepted', accepted_at: sqlNow() } });
      await audit(null, 'quotation', qt.id, 'accepted by customer (link)', null, null);
      await alertCrm('QUOTE_ACCEPTED', 'info', `Quotation ${qt.number} v${qt.version} accepted by ${qv.lead?.company || qv.lead?.contact} — convert to customer in Quotations.`);
      io.to('staff').emit('lead:changed', {});
    }
    res.type('html').send(docShell('Accepted', `${await brandHeader('THANK YOU', qt.number, [])}<h2>Quotation accepted ✓</h2><p>Our team will set up your service plan and send your customer-portal access shortly.</p>`));
  });

  // ── Customer portal additions ──
  // One-time sign-in code (CUS-01): 6 digits, 10 minutes, 5 attempts.
  // v3.3: the code is emailed through the Gmail account the quotations use (free). A customer
  // who types their mobile number gets the code at the email address saved on their account.
  async function otpAccount(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return { error: 'Enter your mobile number or email' };
    if (id.includes('@')) {
      const e = contacts.parseEmail(id); if (!e.ok) return { error: e.error };
      // lower(email) = ?  → a case-insensitive match; the account holder wins over its other sites
      const list = await prisma.customer.findMany({ where: { is_active: 1, email: { equals: e.email, mode: 'insensitive' } }, orderBy: { id: 'asc' } });
      const c = list.find(x => (x.account_id ?? x.id) === x.id) || list[0];
      return { channel: 'email', customer: c || null, typedEmail: e.email };
    }
    const p = contacts.parsePhone(id); if (!p.ok) return { error: p.error };
    const list = await prisma.customer.findMany({ where: { is_active: 1, NOT: [{ contact_phone: null }, { contact_phone: '' }] }, orderBy: { id: 'asc' } });
    const c = list.find(x => contacts.samePhone(x.contact_phone, p.e164));
    return { channel: 'phone', customer: c || null };
  }
  r.post('/auth/customer-otp/request', async (req, res) => {
    const who = await otpAccount(req.body?.identifier);
    if (who.error) return res.status(400).json({ error: who.error });
    // same response whether or not the account exists (no account enumeration)
    const generic = { ok: true, message: 'If this mobile number or email is registered, we have emailed a 6-digit code to the address on the account. It is valid for 10 minutes.' };
    const c = who.customer;
    if (!c) return res.json(generic);
    const acct = c.account_id || c.id;
    const account = (await prisma.customer.findUnique({ where: { id: acct } })) || c;
    const code = String(crypto.randomInt(100000, 1000000));
    await prisma.otpCode.deleteMany({ where: { customer_id: acct } });
    await prisma.otpCode.create({ data: { customer_id: acct, channel: who.channel, code_hash: bcrypt.hashSync(code, 8), expires_at: new Date(Date.now() + 10 * 60e3).toISOString() } });
    const to = who.typedEmail || [account.email, c.email].find(e => contacts.parseEmail(e).ok) || null;
    const mailOn = mailer.status().configured;
    if (mailOn && to) {
      const replyTo = await getSetting('company_email', '');
      // not awaited: the reply must not take longer for a registered account than for an unknown one
      mailer.send({ to, subject: `${code} is your GreenLoop sign-in code`, replyTo,
        text: `Your GreenLoop sign-in code is ${code}\n\nIt is valid for 10 minutes. If you did not ask for it, ignore this email.\n\nGreenLoop`,
        html: `<div style="font:15px/1.55 'Segoe UI',-apple-system,Arial,sans-serif;color:#13231f;max-width:480px;margin:0 auto;padding:8px 4px">
          <p style="margin:0 0 14px;padding-bottom:12px;border-bottom:2px solid #13231f;font-size:19px;font-weight:700">GreenLoop</p>
          <p style="margin:0 0 8px">Your sign-in code for ${h(account.name)}</p>
          <p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:6px">${code}</p>
          <p style="margin:0;font-size:13px;color:#55645f">It is valid for 10 minutes. If you did not ask for it, ignore this email.</p></div>` })
        .catch(e => alertCrm('OTP_NOT_SENT', 'warning', `Sign-in code for ${account.name} could not be emailed to ${to}: ${e.message || mailer.describe(e)}`).catch(() => {}));
    } else if (mailOn && !to) {
      await alertCrm('OTP_NOT_SENT', 'info', `${account.name} asked for a sign-in code but has no email on the account. Add one in Customers, or give them their 4-digit app code.`);
    }
    const out = { ...generic };
    // v3.4.4: the code is shown on screen only when OTP_DEV=1 is set on purpose (local testing).
    // It used to be shown whenever email was not connected, which let anyone sign in with just a phone number.
    if (process.env.OTP_DEV === '1') out.dev_code = code;
    res.json(out);
  });
  r.post('/auth/customer-otp/verify', async (req, res) => {
    const code = String(req.body?.code || '');
    const who = await otpAccount(req.body?.identifier);
    const c = who.customer;
    if (who.error || !c) return res.status(401).json({ error: 'Invalid or expired code' });
    const acct = c.account_id || c.id;
    const row = await prisma.otpCode.findFirst({ where: { customer_id: acct }, orderBy: { id: 'desc' } });
    if (!row || row.expires_at < nowIso() || row.attempts >= 5) return res.status(401).json({ error: 'Invalid or expired code' });
    if (!bcrypt.compareSync(code, row.code_hash)) {
      await prisma.otpCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      return res.status(401).json({ error: 'Invalid or expired code' });
    }
    await prisma.otpCode.deleteMany({ where: { customer_id: acct } });
    const a = await prisma.customer.findUnique({ where: { id: acct } });
    const token = jwt.sign({ id: a.id, role: 'customer', name: a.name, customer_id: a.id }, SECRET, { expiresIn: '30d' });
    res.json({ token, customer: { id: a.id, name: a.name, branch: a.branch, zone: a.zone, address: a.address, contact_phone: a.contact_phone } });
  });

  r.get('/customer/sites', cust, async (req, res) => {
    const acct = await accountOf(custId(req));
    const sites = await prisma.customer.findMany({ where: { ...accountSites(acct), is_active: 1 }, select: { id: true, name: true, branch: true, zone: true, address: true }, orderBy: { id: 'asc' } });
    res.json({ current: custId(req), sites });
  });
  r.post('/customer/switch-site', cust, async (req, res) => {
    const acct = await accountOf(custId(req));
    const sid = toId(req.body?.site_id);
    const s = sid ? await prisma.customer.findFirst({ where: { id: sid, ...accountSites(acct), is_active: 1 } }) : null;
    if (!s) return res.status(404).json({ error: 'Site not in your account' });
    const token = jwt.sign({ id: s.id, role: 'customer', name: s.name, customer_id: s.id }, SECRET, { expiresIn: '30d' });
    res.json({ token, customer: { id: s.id, name: s.name, branch: s.branch, zone: s.zone, address: s.address, contact_phone: s.contact_phone } });
  });
  r.get('/customer/plans', cust, async (req, res) => {
    let rows = await prisma.servicePlan.findMany({ where: { customer_id: custId(req), status: { not: 'ended' } }, orderBy: { id: 'asc' } });
    rows = await join(rows, 'service_code', 'serviceType', { service_name: 'name', category: 'category' }, { key: 'code' });
    res.json({ plans: rows.map(p => ({ ...p, recurrence: J(p.recurrence, {}), rule_label: describeRule(J(p.recurrence, {})) })),
      services: await prisma.serviceType.findMany({ where: { is_active: 1 }, select: { code: true, name: true, category: true, default_price: true }, orderBy: { id: 'asc' } }) });
  });
  const custPlanReq = async (req, res, existing) => {
    const b = req.body || {};
    // customers can't set price/billing
    delete b.unit_price; delete b.billing; delete b.status;
    const asCustomer = { ...req, user: { ...req.user, eff: 'customer' }, body: b };
    const before = existing ? { ...existing } : null;
    const out = await upsertPlan(asCustomer, custId(req), existing);
    if (out.status === 200) {
      const c = await prisma.customer.findUnique({ where: { id: custId(req) }, select: { name: true, branch: true } });
      await alertCrm('PLAN_CHANGE', 'info', `${c.name} (${c.branch || ''}) ${before ? 'changed' : 'booked'} a service plan: ${describeRule(b.recurrence || J(before?.recurrence, {}))} ${b.time_window || ''}`);
    }
    res.status(out.status).json(out.body);
  };
  r.post('/customer/plans', cust, (req, res) => custPlanReq(req, res, null));
  r.put('/customer/plans/:id', cust, async (req, res) => {
    const pid = toId(req.params.id);
    const p = pid ? await prisma.servicePlan.findFirst({ where: { id: pid, customer_id: custId(req) } }) : null;
    if (!p) return res.status(404).json({ error: 'Not found' });
    await custPlanReq(req, res, p);
  });
  r.get('/customer/bookings', cust, async (req, res) => res.json(await prisma.booking.findMany({ where: { customer_id: custId(req) }, orderBy: { id: 'desc' }, take: 30 })));
  r.post('/customer/bookings', cust, async (req, res) => {
    const b = req.body || {};
    const dErr = security.dateInRange(b.date, { futureDays: 366 }); if (dErr) return res.status(400).json({ error: dErr === 'Date cannot be in the past' ? 'Pick a date from today onwards' : dErr });
    if (b.time_window && !WIN_RX.test(b.time_window)) return res.status(400).json({ error: security.windowError(b.time_window) });
    if (typeof b.service_code !== 'string' || !(await prisma.serviceType.findFirst({ where: { code: b.service_code, is_active: 1 }, select: { id: true } }))) return res.status(400).json({ error: 'Pick a service' });
    const booking = await prisma.booking.create({
      data: { customer_id: custId(req), service_code: b.service_code, date: b.date, time_window: WIN_RX.test(b.time_window || '') ? b.time_window : null, notes: String(b.notes || '').slice(0, 300) },
    });
    const c = await prisma.customer.findUnique({ where: { id: custId(req) }, select: { name: true, branch: true } });
    await alertCrm('BOOKING', 'warning', `One-off booking request: ${c.name} (${c.branch || ''}) · ${b.service_code} on ${b.date} — confirm in Bookings.`);
    res.json({ ok: true, id: booking.id });
  });
  r.get('/customer/invoices', cust, async (req, res) => {
    const acct = await accountOf(custId(req));
    const rows = await invoiceViews(await prisma.invoice.findMany({ where: { customer_id: acct, status: { not: 'void' } }, orderBy: { id: 'desc' } }));
    const payments = await paymentRows({ customer_id: acct }, false);
    res.json({ rows, payments, balance: money(rows.reduce((a, i) => a + i.balance, 0)), overdue: money(rows.filter(i => i.status_label === 'Overdue').reduce((a, i) => a + i.balance, 0)) });
  });
  r.get('/customer/confirmations', cust, async (req, res) => {
    const ids = await accountSiteIds(await accountOf(custId(req)));
    let rows = await prisma.pickup.findMany({
      where: { customer_id: { in: ids }, confirmation_status: { not: null } },
      select: { id: true, scheduled_date: true, anomaly_reason: true, photo_url: true, confirmation_status: true, confirm_deadline: true, customer_id: true, driver_id: true },
    });
    rows = await join(rows, 'customer_id', 'customer', ['branch'], { inner: true });
    rows = await join(rows, 'driver_id', 'user', { driver: 'full_name' });
    sortBy(rows, desc(p => (p.confirmation_status === 'awaiting' ? 1 : 0)), desc(p => p.scheduled_date), desc(p => p.id));
    res.json(rows.slice(0, 30).map(({ customer_id, driver_id, ...x }) => x));
  });
  r.get('/customer/quotations', cust, async (req, res) => {
    const acct = await accountOf(custId(req));
    const lead = await prisma.lead.findFirst({ where: { customer_id: acct }, select: { id: true } });
    res.json(lead ? await quoteViews(await prisma.quotation.findMany({ where: { lead_id: lead.id, status: { notIn: ['superseded', 'draft'] } }, orderBy: { id: 'desc' } })) : []);
  });
  r.post('/customer/quotations/:id/accept', cust, async (req, res) => {
    const acct = await accountOf(custId(req));
    const lead = await prisma.lead.findFirst({ where: { customer_id: acct }, select: { id: true } });
    const qid = toId(req.params.id);
    const qt = lead && qid ? await prisma.quotation.findFirst({ where: { id: qid, lead_id: lead.id } }) : null;
    const qv = await quoteView(qt);
    if (!qv) return res.status(404).json({ error: 'Not found' });
    if (qv.status !== 'sent') return res.status(409).json({ error: 'This quotation is ' + qv.status });
    await prisma.quotation.update({ where: { id: qt.id }, data: { status: 'accepted', accepted_at: sqlNow() } });
    await alertCrm('QUOTE_ACCEPTED', 'info', `Existing customer accepted quotation ${qt.number} v${qt.version}.`);
    res.json({ ok: true });
  });
  r.get('/customer/notifications', cust, async (req, res) => {
    const ids = await accountSiteIds(await accountOf(custId(req)));
    const rows = await prisma.customerNotification.findMany({ where: { customer_id: { in: ids } }, orderBy: { id: 'desc' }, take: 40 });
    res.json({ rows, unread: rows.filter(r2 => !r2.is_read).length });
  });
  r.post('/customer/notifications/read', cust, async (req, res) => {
    const ids = await accountSiteIds(await accountOf(custId(req)));
    await prisma.customerNotification.updateMany({ where: { customer_id: { in: ids } }, data: { is_read: 1 } });
    res.json({ ok: true });
  });
  // full history with filters (CUS-03)
  r.get('/customer/history-v3', cust, async (req, res) => {
    const acct = await accountOf(custId(req));
    const site = req.query.site ? toId(req.query.site) : null;
    const from = String(req.query.from || '0000'), to = String(req.query.to || '9999');
    let ids = await accountSiteIds(acct);
    if (site) ids = ids.filter(id => id === site);
    let rows = await prisma.pickup.findMany({
      where: { customer_id: { in: ids }, status: { in: ['collected', 'canceled', 'overdue'] }, scheduled_date: { gte: from, lte: to } },
      select: { id: true, scheduled_date: true, status: true, completed_at: true, photo_url: true, anomaly_reason: true, service_type: true, checklist: true, confirmation_status: true, customer_id: true, driver_id: true, vehicle_id: true },
      orderBy: [{ scheduled_date: 'desc' }, { id: 'desc' }], take: 300,
    });
    rows = await join(rows, 'customer_id', 'customer', { site_id: 'id', branch: 'branch' }, { inner: true });
    rows = await join(rows, 'driver_id', 'user', { driver_name: 'full_name' });
    rows = await join(rows, 'vehicle_id', 'vehicle', ['fleet_number']);
    rows = await join(rows, 'service_type', 'serviceType', { service_name: 'name' }, { key: 'code' });
    res.json(rows.map(({ customer_id, driver_id, vehicle_id, ...x }) => ({ ...x, checklist: J(x.checklist, []) })));
  });
  r.get('/customer/history-v3/pdf', cust, async (req, res) => {
    const acct = await accountOf(custId(req));
    // v3.4.4: only real dates are accepted; anything else falls back to the default range
    const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const from = isDay(req.query.from) ? req.query.from : addDays(ymd(), -90), to = isDay(req.query.to) ? req.query.to : ymd();
    const c = await prisma.customer.findUnique({ where: { id: acct } });
    let rows = await prisma.pickup.findMany({
      where: { customer_id: { in: await accountSiteIds(acct) }, status: { in: ['collected', 'canceled', 'overdue'] }, scheduled_date: { gte: from, lte: to } },
      orderBy: [{ scheduled_date: 'asc' }, { id: 'asc' }],
    });
    rows = await join(rows, 'customer_id', 'customer', ['branch'], { inner: true });
    rows = await join(rows, 'driver_id', 'user', { driver: 'full_name' });
    rows = await join(rows, 'service_type', 'serviceType', { service_name: 'name' }, { key: 'code' });
    res.type('html').send(docShell('Service history', `${await brandHeader('SERVICE HISTORY', c.name, [`${from} → ${to}`, `${rows.length} visits`])}
      <table><tr><th>Date</th><th>Site</th><th>Service</th><th>Driver</th><th>Outcome</th><th>Checklist</th><th>GPS photo</th></tr>
      ${rows.map(p => `<tr><td>${p.scheduled_date}</td><td>${h(p.branch)}</td><td>${h(p.service_name || p.service_type)}</td><td>${h(p.driver || '—')}</td>
      <td>${p.status === 'collected' ? 'Completed' : 'Not picked up: ' + h(String(p.anomaly_reason || '').replace(/_/g, ' ').toLowerCase())}</td>
      <td>${h(J(p.checklist, []).join(', '))}</td><td>${p.photo_url ? `<img class="ph" src="${h(p.photo_url)}">` : '—'}</td></tr>`).join('')}</table>
      <div class="foot">Photos are captured with the live camera and stamped on-device with date, time and GPS.</div>`, '', req.query.print === '1'));
  });

  // ── driver helpers (DRV-08/09/11) ──
  r.get('/driver/jobs-v3', need('driver'), async (req, res) => {
    const today = ymd();
    let rows = await prisma.pickup.findMany({
      where: { scheduled_date: today, driver_id: req.user.id, status: { not: 'rescheduled' } },
      select: { id: true, status: true, stage: true, seq: true, time_window: true, service_type: true, confirmation_status: true, is_revisit: true,
        started_at: true, arrived_at: true, completed_at: true, arrival_photo_url: true, customer_id: true },
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    });
    rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone', 'address', 'lat', 'lng', 'access_notes', 'contact_phone'], { inner: true });
    rows = await join(rows, 'service_type', 'serviceType', { service_name: 'name', category: 'category', checklist: 'checklist' }, { key: 'code' });
    res.json({ date: today, server_now: nowIso(), proof_radius_m: PROOF_RADIUS_M, jobs: rows.map(({ customer_id, ...j }) => ({ ...j, checklist: J(j.checklist, []), maps_url: mapsDir(j.lat, j.lng) })) });
  });
}

// ── background jobs ──────────────────────────────────────────
async function checkAttention(c) {
  const n = await prisma.pickup.count({ where: { customer_id: c.id, status: 'canceled', confirmation_status: { in: ['confirmed', 'auto_confirmed'] }, scheduled_date: { gte: addDays(ymd(), -30) } } });
  if (n === 3) await alertCrm('ATTENTION', 'warning', `${c.name} (${c.branch || ''}) has 3 confirmed no-pickups in 30 days — see "Clients needing attention".`);
}
async function autoConfirm() {
  let due = await prisma.pickup.findMany({ where: { confirmation_status: 'awaiting', confirm_deadline: { lt: nowIso() } }, orderBy: { id: 'asc' } });
  due = await join(due, 'customer_id', 'customer', ['name', 'branch'], { inner: true });
  for (const p of due) {
    await prisma.pickup.update({ where: { id: p.id }, data: { confirmation_status: 'auto_confirmed', billable: 0 } });
    await prisma.alert.create({ data: { type: 'AUTO_CONFIRMED', severity: 'info', message: `No response in 24 h — no-pickup auto-confirmed for ${p.name} (${p.branch || ''})`, pickup_id: p.id } });
    await checkAttention({ id: p.customer_id, name: p.name, branch: p.branch });
  }
  return due.length;
}
async function atRiskCheck() {
  const today = ymd(), now = new Date();
  const hm = now.toTimeString().slice(0, 5);
  let rows = await prisma.pickup.findMany({
    where: { scheduled_date: today, status: 'pending', stage: null, OR: [{ at_risk_alerted: null }, { at_risk_alerted: 0 }], time_window: { not: null } },
    select: { id: true, time_window: true, driver_id: true, customer_id: true }, orderBy: { id: 'asc' },
  });
  rows = await join(rows, 'customer_id', 'customer', ['name', 'branch'], { inner: true });
  let n = 0;
  for (const r2 of rows) {
    const end = r2.time_window.slice(6, 11);
    const [eh, em] = end.split(':').map(Number), [nh, nm] = hm.split(':').map(Number);
    const mins = eh * 60 + em - (nh * 60 + nm);
    if (mins <= 30 && mins > -600) {
      await prisma.pickup.update({ where: { id: r2.id }, data: { at_risk_alerted: 1 } });
      await alertCrm('AT_RISK', 'warning', `At risk of being late: ${r2.name} (${r2.branch || ''}) window ends ${end}, not started.`, r2.id);
      if (IO) IO.to('staff').emit('driver:at-risk', { pickup_id: r2.id, driver_id: r2.driver_id, window_end: end });
      if (push && r2.driver_id) push.sendPush('driver', r2.driver_id, 'Stop at risk', `${r2.name} window ends ${end}`, '/driver/').catch(() => {});
      n++;
    }
  }
  return n;
}
// Nightly plan generation in batches of 25 plans, yielding to the event loop in between so the
// app stays responsive. (Each insert is atomic on its own, and generatePlans skips dates that
// already have a job, so a run that stops half-way is simply completed by the next run.)
async function generatePlansBatched({ days = 14, batch = 25 } = {}) {
  const ids = (await prisma.servicePlan.findMany({ where: { status: 'active' }, select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  let created = 0, skipped = 0;
  for (let i = 0; i < ids.length; i += batch) {
    for (const id of ids.slice(i, i + batch)) { const g = await generatePlans({ days, planId: id }); created += g.created || 0; skipped += g.skipped || 0; }
    await new Promise((r) => setImmediate(r));
  }
  return { created, skipped, plans: ids.length };
}

// Daily JSON backup of every collection, kept for BACKUP_DAYS days.
// Written to BACKUP_DIR, or DATA_DIR/backups. For production also use MongoDB's own
// `mongodump` (or Atlas backups) — see docs/MONGODB-SETUP.md.
async function dailyBackup() {
  const path = require('path'), fs = require('fs');
  const dir = process.env.BACKUP_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'backups') : null);
  if (!dir || process.env.BACKUP_DISABLED === '1') return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `greenloop-${ymd()}.json`);
    if (!fs.existsSync(file)) {
      const dump = { exported_at: nowIso(), collections: {} };
      for (const m of Object.values(MODELS)) dump.collections[m.collection] = await prisma[m.delegate].findMany();
      fs.writeFileSync(file, JSON.stringify(dump));
      console.log('✔ Backup written', file);
    }
    const keep = Number(process.env.BACKUP_DAYS || 14);
    fs.readdirSync(dir).filter((f) => /^greenloop-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -keep)
      .forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
  } catch (e) { console.warn('Backup failed:', e.message); }
}

let dailyRunning = false;
async function dailyJobs() {
  if (dailyRunning) return;
  dailyRunning = true;
  try { await dailyJobsInner(); } finally { dailyRunning = false; }
}
async function dailyJobsInner() {
  const today = ymd();
  if (await getSetting('v3_last_generate', '') !== today) {
    await setSetting('v3_last_generate', today);
    try { const g = await generatePlansBatched({ days: 14 }); console.log(`✔ Recurrence engine: ${g.created} jobs generated for ${g.plans} plans, ${g.skipped} holiday skips`); }
    catch (e) { console.warn('generatePlans', e.message); await setSetting('v3_last_generate', ''); }
  }
  if (await getSetting('v3_last_backup', '') !== today) { await setSetting('v3_last_backup', today); await dailyBackup(); }
  // reminders go out at 17:00 UAE time (server clocks run on UTC)
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: process.env.APP_TZ || 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour >= 17 && await getSetting('v3_last_reminder', '') !== today) {
    const tmr = addDays(today, 1);
    // SELECT DISTINCT customer_id, time_window …  → one reminder per customer + window
    const jobs = await prisma.pickup.findMany({ where: { scheduled_date: tmr, status: 'pending' }, select: { customer_id: true, time_window: true }, distinct: ['customer_id', 'time_window'] });
    for (const x of await join(jobs, 'customer_id', 'customer', ['name'], { inner: true }))
      await notifyCustomer(x.customer_id, 'reminder', 'Service tomorrow', `${x.name}: visit on ${tmr}${x.time_window ? ', window ' + x.time_window : ''}. Please keep access clear.`);
    await setSetting('v3_last_reminder', today);
  }
}
async function seedDemo() {
  if (!(await prisma.lead.findFirst({ select: { id: true } })) && process.env.SEED_DEMO !== '0') {
    // demo pipeline so dashboards aren't empty; TRUCK-02 doubles as pest-control unit
    await prisma.vehicle.updateMany({ where: { fleet_number: 'TRUCK-02' }, data: { service_tags: 'waste,pest' } });
    const daysAgo = (n) => sqlNow(new Date(Date.now() - n * 864e5));     // SQL: datetime('now','-n days')
    const L = (contact, company, phone, service_type, stage, source, sites, days) => prisma.lead.create({
      data: { contact, company, phone, service_type, sites: JSON.stringify(sites), frequency: 'weekly:3', source, stage, owner_id: 1,
        follow_up_at: addDays(ymd(), 2) + 'T10:00:00.000Z', created_at: daysAgo(days) },
    });
    await L('Omar Khalid', 'Spice Route Restaurant', '+971502223344', 'WASTE', 'new', 'website', [{ name: 'Karama', zone: 'Downtown', lat: 25.2425, lng: 55.3031, address: 'Karama St 12' }], 1);
    await L('Fatima Noor', 'Cool Mart Group', '+971503334455', 'WASTE', 'contacted', 'referral', [{ name: 'Marina Walk', zone: 'Marina', lat: 25.0781, lng: 55.1391 }, { name: 'JBR', zone: 'Marina', lat: 25.0775, lng: 55.1332 }], 3);
    await L('Arjun Mehta', 'Golden Fork Bakery', '+971504445566', 'PEST_GENERAL', 'lost', 'whatsapp', [{ name: 'Deira', zone: 'Deira', lat: 25.2711, lng: 55.3075 }], 12);
    const lead = await prisma.lead.create({
      data: { contact: 'Layla Hassan', company: 'Harbour Seafood', phone: '+971505556677', email: 'layla@harbour.ae', service_type: 'WASTE',
        sites: JSON.stringify([{ name: 'Al Mina', zone: 'Deira', lat: 25.2632, lng: 55.2912, address: 'Port Rashid Rd' }]), frequency: 'weekly:3', source: 'walk-in', stage: 'quoted',
        owner_id: 1, created_at: daysAgo(2) },
    });
    const calc = calcQuote([{ service_code: 'WASTE', description: 'Machari waste pickup', freq_unit: 'weekly', freq_count: 3, unit_price: 160 }, { service_code: 'PEST_GENERAL', description: 'Pest treatment', freq_unit: 'monthly', freq_count: 1, unit_price: 450 }]);
    await prisma.quotation.create({
      data: {
        lead_id: lead.id, number: 'QT-' + new Date().getFullYear() + '-0001', version: 1, items: JSON.stringify(calc.items),
        plan: JSON.stringify({ recurrence: { type: 'weekly', days: [0, 2, 4] }, time_window: '06:00-10:00', billing: 'monthly' }),
        subtotal: calc.subtotal, vat: calc.vat, total: calc.total, valid_until: addDays(ymd(), 28), status: 'sent', sent_via: 'whatsapp',
        sent_at: daysAgo(1), share_token: crypto.randomBytes(12).toString('hex'), created_by: 1, created_at: daysAgo(1),
      },
    });
  }
}
async function start(io) {
  IO = io;
  try { await seedDemo(); } catch (e) { console.warn('v3 demo seed', e.message); }
  const tick = async () => {
    try { await autoConfirm(); await atRiskCheck(); } catch (e) { console.warn('v3 tick', e.message); }
    dailyJobs().catch((e) => console.warn('v3 daily', e.message));
  };
  await tick();
  setInterval(() => { tick().catch(() => {}); }, 60_000);
}

module.exports = {
  init, mountV3Routes, guard, start, validateProof, rejectProof, onPickupCompleted, onNotPickedUp, notifyCustomer, notifyVehicleDrivers, dmy,
  generatePlans, occursOn, describeRule, calcQuote, visitsPerMonth, frequencyLabel, parseFrequency, recurrenceForLine, haversineM, autoConfirm, atRiskCheck, allocate,
  alertCrm, flagLateProof, generatePlansBatched, dailyBackup, dailyJobs, accountOf, seedDemo,
};
