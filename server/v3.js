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
// SQLite (node:sqlite) implementation, same as api.js.
// ─────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const security = require('./security');
const { q, getSetting, setSetting } = require('./db');

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

// ── schema (idempotent) ──────────────────────────────────────
function tryExec(sql) { try { q.run(sql); } catch { /* column/table exists */ } }
function ensureSchema() {
  const { db } = require('./db');
  db.exec(`
CREATE TABLE IF NOT EXISTS service_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'waste' CHECK (category IN ('waste','pest')),
  default_duration_min INTEGER NOT NULL DEFAULT 20,
  default_price REAL NOT NULL DEFAULT 0,
  checklist TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact TEXT NOT NULL, company TEXT, phone TEXT, email TEXT,
  service_type TEXT, sites TEXT NOT NULL DEFAULT '[]', frequency TEXT,
  source TEXT, stage TEXT NOT NULL DEFAULT 'new', lost_reason TEXT,
  owner_id INTEGER, follow_up_at TEXT, notes TEXT,
  customer_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  number TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  items TEXT NOT NULL DEFAULT '[]', plan TEXT NOT NULL DEFAULT '{}',
  subtotal REAL NOT NULL DEFAULT 0, vat REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  valid_until TEXT, status TEXT NOT NULL DEFAULT 'draft',
  sent_via TEXT, sent_at TEXT, accepted_at TEXT, share_token TEXT,
  notes TEXT, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(number, version)
);
CREATE TABLE IF NOT EXISTS service_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_code TEXT NOT NULL DEFAULT 'WASTE',
  recurrence TEXT NOT NULL DEFAULT '{"type":"weekly","days":[0]}',
  time_window TEXT NOT NULL DEFAULT '07:00-12:00',
  start_date TEXT NOT NULL, end_date TEXT,
  paused INTEGER NOT NULL DEFAULT 0, pause_from TEXT, pause_to TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  billing TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'active',
  quotation_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plan_skips (
  plan_id INTEGER NOT NULL, date TEXT NOT NULL, reason TEXT,
  PRIMARY KEY(plan_id, date)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, service_code TEXT NOT NULL,
  date TEXT NOT NULL, time_window TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'requested', pickup_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL,
  period TEXT NOT NULL, job_ids TEXT NOT NULL DEFAULT '[]', lines TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL, vat REAL NOT NULL, amount REAL NOT NULL,
  due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount REAL NOT NULL, method TEXT NOT NULL, reference TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')), recorded_by TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, entity TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL,
  before TEXT, after TEXT, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customer_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, kind TEXT, title TEXT, body TEXT, link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, channel TEXT, code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);`);
  // column additions (PRD §8 "Enhance")
  [
    `ALTER TABLE pickups ADD COLUMN service_type TEXT DEFAULT 'WASTE'`,
    `ALTER TABLE pickups ADD COLUMN time_window TEXT`,
    `ALTER TABLE pickups ADD COLUMN photo_taken_at TEXT`,
    `ALTER TABLE pickups ADD COLUMN confirmation_status TEXT`,
    `ALTER TABLE pickups ADD COLUMN confirm_deadline TEXT`,
    `ALTER TABLE pickups ADD COLUMN plan_id INTEGER`,
    `ALTER TABLE pickups ADD COLUMN invoice_id INTEGER`,
    `ALTER TABLE pickups ADD COLUMN checklist TEXT`,
    `ALTER TABLE pickups ADD COLUMN proof_meta TEXT`,
    `ALTER TABLE pickups ADD COLUMN at_risk_alerted INTEGER DEFAULT 0`,
    `ALTER TABLE pickups ADD COLUMN is_revisit INTEGER DEFAULT 0`,
    `ALTER TABLE pickups ADD COLUMN billable INTEGER DEFAULT 1`,
    `ALTER TABLE customers ADD COLUMN account_id INTEGER`,
    `ALTER TABLE customers ADD COLUMN email TEXT`,
    `ALTER TABLE customers ADD COLUMN time_window TEXT`,
    `ALTER TABLE customers ADD COLUMN portal_code_hash TEXT`,
    `ALTER TABLE customers ADD COLUMN access_notes TEXT`,
    `ALTER TABLE vehicles ADD COLUMN service_tags TEXT DEFAULT 'waste'`,
    `ALTER TABLE users ADD COLUMN crm_role TEXT DEFAULT 'owner'`,
  ].forEach(tryExec);
  tryExec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_pickups_plan_date ON pickups(plan_id, scheduled_date) WHERE plan_id IS NOT NULL AND is_revisit = 0`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_pickups_conf ON pickups(confirmation_status)`);
  tryExec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_number ON invoices(number)`);
  tryExec(`CREATE INDEX IF NOT EXISTS ix_invoices_customer ON invoices(customer_id)`);
  tryExec(`CREATE INDEX IF NOT EXISTS ix_pickups_invoice ON pickups(invoice_id)`);
  tryExec(`CREATE INDEX IF NOT EXISTS ix_payments_invoice ON payments(invoice_id)`);

  if (!q.get(`SELECT id FROM service_types LIMIT 1`)) {
    const ins = (code, name, cat, dur, price, list) =>
      q.run(`INSERT INTO service_types(code,name,category,default_duration_min,default_price,checklist) VALUES (?,?,?,?,?,?)`,
        code, name, cat, dur, price, JSON.stringify(list));
    ins('WASTE', 'Machari waste pickup', 'waste', 20, 150, ['Bins emptied', 'Area left clean']);
    ins('WASTE_BULK', 'Bulk / extra waste removal', 'waste', 40, 350, ['Waste loaded', 'Area left clean']);
    ins('PEST_GENERAL', 'General pest control treatment', 'pest', 45, 400, ['Areas treated', 'Chemicals used recorded', 'Next visit agreed']);
    ins('PEST_TERMITE', 'Termite treatment', 'pest', 90, 900, ['Areas treated', 'Chemicals used recorded', 'Next visit agreed']);
  }
  if (!getSetting('uae_holidays', '')) {
    // Approximate 2026 dates (lunar holidays shift) — edit in Settings when officially announced.
    setSetting('uae_holidays', JSON.stringify([
      '2026-01-01', '2026-03-19', '2026-03-20', '2026-03-21', '2026-05-26', '2026-05-27', '2026-05-28',
      '2026-05-29', '2026-06-16', '2026-08-25', '2026-12-01', '2026-12-02', '2026-12-03']));
  }
  if (!getSetting('default_time_window', '')) setSetting('default_time_window', '07:00-12:00');
  if (!getSetting('invoice_due_days', '')) setSetting('invoice_due_days', '15');
  if (!getSetting('company_whatsapp', '')) setSetting('company_whatsapp', '+971500000001');
  tryExec(`ALTER TABLE invoices ADD COLUMN sent_at TEXT`);
  tryExec(`ALTER TABLE invoices ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0`);
  tryExec(`ALTER TABLE quotations ADD COLUMN sent_to TEXT`);
  q.run(`UPDATE vehicles SET service_tags='waste' WHERE service_tags IS NULL`);

  q.run(`UPDATE users SET crm_role='owner' WHERE role='admin' AND crm_role IS NULL`);
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
      try {
        q.run(`INSERT INTO audit_log(actor,entity,entity_id,action,after) VALUES (?,?,?,?,?)`,
          actorName({ ...p, eff: p.crm_role === 'ops' ? 'ops' : 'admin' }),
          req.path.split('/')[1] || 'api', (req.path.match(/\/(\d+)/) || [])[1] || null,
          `${req.method} ${req.path}`, JSON.stringify(body).slice(0, 4000));
      } catch { /* ignore */ }
    });
  }
  next();
}
function audit(req, entity, id, action, before, after) {
  if (req) req._audited = true;
  q.run(`INSERT INTO audit_log(actor,entity,entity_id,action,before,after) VALUES (?,?,?,?,?,?)`,
    req ? actorName(req.user) : 'system', entity, id == null ? null : String(id), action,
    before ? JSON.stringify(before).slice(0, 4000) : null, after ? JSON.stringify(after).slice(0, 4000) : null);
}

// ── notifications ────────────────────────────────────────────
let IO = null;
function alertCrm(type, severity, message, pickupId = null) {
  q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES (?,?,?,?)`, type, severity, message, pickupId);
  if (IO) IO.to('staff').emit('alert', { type, severity, message, pickup_id: pickupId });
}
function notifyCustomer(customerId, kind, title, body, link = '/customer/') {
  q.run(`INSERT INTO customer_notifications(customer_id,kind,title,body,link) VALUES (?,?,?,?,?)`, customerId, kind, title, body, link);
  if (IO) IO.to('customer:' + customerId).emit('customer:notify', { kind, title, body });
  // returns the push delivery report so callers can show "delivered to N device(s)"
  if (!push) return Promise.resolve({ devices: 0, delivered: 0, failed: 0, removed: 0 });
  return push.sendPush('customer', customerId, title, body, link).catch(() => ({ devices: 0, delivered: 0, failed: 0, removed: 0 }));
}
// Push + live in-app alert for the driver(s) of a vehicle.
function notifyVehicleDrivers(vehicleId, title, body) {
  if (!vehicleId) return;
  try {
    q.all(`SELECT id FROM users WHERE role='driver' AND is_active=1 AND vehicle_id=?`, vehicleId)
      .forEach(d => { if (IO) IO.to('driver:' + d.id).emit('driver:notify', { kind: 'info', title, body }); });
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
const holidays = () => new Set(J(getSetting('uae_holidays', '[]'), []));
const isPaused = (plan, date) => !!plan.paused && (!plan.pause_from || date >= plan.pause_from) && (!plan.pause_to || date <= plan.pause_to);

// ── fleet auto-allocation (§7) ───────────────────────────────
function serviceCategory(code) {
  const t = q.get(`SELECT category FROM service_types WHERE code=?`, code || 'WASTE');
  return t ? t.category : 'waste';
}
function zoneCentroids() {
  const m = {};
  q.all(`SELECT zone, AVG(lat) lat, AVG(lng) lng FROM customers GROUP BY zone`).forEach(z => { m[z.zone] = z; });
  return m;
}
const { capacityFor, loadOf } = require('./capacity');
function allocate(customer, date, serviceCode) {
  const cat = serviceCategory(serviceCode);
  const cents = zoneCentroids();
  const vehicles = q.all(`SELECT * FROM vehicles WHERE is_active=1`).filter(v => {
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
    const load = loadOf(v.id, date);
    if (load < capacityFor(v, date)) {
      const drv = q.get(`SELECT id FROM users WHERE role='driver' AND is_active=1 AND vehicle_id=? ORDER BY id LIMIT 1`, v.id);
      return { vehicle: v, driver_id: drv ? drv.id : null, load };
    }
  }
  return { vehicle: null, driver_id: null, reason: vehicles.length ? 'all eligible vehicles full' : `no active vehicle tagged "${cat}"` };
}
function resequence(vehicleId, date) {
  if (!vehicleId) return;
  const rows = q.all(`SELECT id, seq, time_window FROM pickups WHERE vehicle_id=? AND scheduled_date=? AND status!='rescheduled'
                      ORDER BY COALESCE(substr(time_window,1,5),'99:99'), seq, id`, vehicleId, date);
  rows.forEach((r, i) => { if (r.seq !== i + 1) q.run(`UPDATE pickups SET seq=? WHERE id=?`, i + 1, r.id); });
}
function createJob({ customer, date, serviceCode, window, planId = null, revisit = false, billable = true, note = null, quiet = false }) {
  const a = allocate(customer, date, serviceCode);
  const tw = window || customer.time_window || getSetting('default_time_window', '07:00-12:00');
  const info = q.run(`INSERT INTO pickups(customer_id,vehicle_id,driver_id,scheduled_date,seq,status,service_type,time_window,plan_id,is_revisit,billable,notes)
      VALUES (?,?,?,?,999,'pending',?,?,?,?,?,?)`,
    customer.id, a.vehicle ? a.vehicle.id : null, a.driver_id, date, serviceCode || 'WASTE', tw, planId, revisit ? 1 : 0, billable ? 1 : 0, note);
  const id = Number(info.lastInsertRowid);
  if (a.vehicle) resequence(a.vehicle.id, date);
  else if (!quiet) alertCrm('UNALLOCATED', 'warning', `No capacity for ${customer.name} (${customer.branch || ''}) on ${date}: ${a.reason}. Add capacity or reschedule.`, id);
  return { id, vehicle: a.vehicle ? a.vehicle.fleet_number : null, unallocated: a.vehicle ? null : a.reason };
}

function generatePlans({ days = 14, planId = null } = {}) {
  const today = ymd();
  const hol = holidays();
  const plans = planId
    ? q.all(`SELECT * FROM service_plans WHERE id=? AND status='active'`, planId)
    : q.all(`SELECT * FROM service_plans WHERE status='active'`);
  let created = 0, skipped = 0;
  const unalloc = {};
  for (const p of plans) {
    const c = q.get(`SELECT * FROM customers WHERE id=? AND is_active=1`, p.customer_id);
    if (!c) continue;
    const rule = J(p.recurrence, null);
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      if (date < p.start_date || (p.end_date && date > p.end_date)) continue;
      if (!occursOn(rule, date)) continue;
      if (isPaused(p, date)) continue;
      if (hol.has(date)) {
        const exists = q.get(`SELECT 1 x FROM plan_skips WHERE plan_id=? AND date=?`, p.id, date);
        if (!exists) {
          q.run(`INSERT INTO plan_skips(plan_id,date,reason) VALUES (?,?,'UAE public holiday')`, p.id, date);
          alertCrm('HOLIDAY_SKIP', 'info', `Holiday ${date}: visit for ${c.name} (${c.branch || ''}) skipped — reschedule if needed.`);
          skipped++;
        }
        continue;
      }
      if (q.get(`SELECT id FROM pickups WHERE plan_id=? AND scheduled_date=? AND is_revisit=0`, p.id, date)) continue;
      const j = createJob({ customer: c, date, serviceCode: p.service_code, window: p.time_window, planId: p.id, quiet: true });
      if (j.unallocated) (unalloc[p.id] ||= { c, reason: j.unallocated, dates: [] }).dates.push(date);
      created++;
    }
  }
  Object.values(unalloc).forEach(u => alertCrm('UNALLOCATED', 'warning',
    `${u.dates.length} job(s) for ${u.c.name} (${u.c.branch || ''}) not allocated — ${u.reason}. Dates: ${u.dates.slice(0, 5).join(', ')}${u.dates.length > 5 ? '…' : ''}`));
  if (created && IO) IO.to('staff').emit('ledger:refresh', {});
  return { created, skipped, unallocated: Object.values(unalloc).reduce((a, u) => a + u.dates.length, 0) };
}
function regeneratePlan(planId) {
  const today = ymd();
  const del = q.run(`DELETE FROM pickups WHERE plan_id=? AND scheduled_date>=? AND status='pending' AND stage IS NULL AND is_revisit=0`, planId, today);
  const g = generatePlans({ planId });
  return { removed: del.changes, ...g };
}

// ── proof validation (DRV-06/07) ─────────────────────────────
// body: lat, lng, photo_taken_at (ISO, device), device_now (ISO at send), stamped ('1'), stamp_text
function validateProof(pickup, body) {
  const c = q.get(`SELECT name, lat, lng FROM customers WHERE id=?`, pickup.customer_id);
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
function flagLateProof(pickup, v, driverName) {
  if (!v.meta || !v.meta.late_min) return;
  const c = q.get(`SELECT name, branch FROM customers WHERE id=?`, pickup.customer_id);
  alertCrm('LATE_PROOF', 'warning', `Proof for ${c?.name} (${c?.branch || ''}) by ${driverName} was uploaded ${v.meta.late_min} min after the photo was taken (offline). Please review.`, pickup.id);
}
function rejectProof(pickup, v, driverName, kind) {
  const c = q.get(`SELECT name, branch FROM customers WHERE id=?`, pickup.customer_id);
  q.run(`UPDATE pickups SET proof_meta=?, updated_at=datetime('now') WHERE id=?`, JSON.stringify({ rejected: true, kind, ...v.meta, problems: v.problems }), pickup.id);
  alertCrm('PHOTO_REJECTED', 'critical',
    `Proof photo rejected for ${c?.name} (${c?.branch || ''}) by ${driverName}: ${v.problems.join('; ')}. Ops can override in Alerts.`, pickup.id);
}

// ── invoices ─────────────────────────────────────────────────
function priceFor(p) {
  if (p.plan_id) {
    const pl = q.get(`SELECT unit_price FROM service_plans WHERE id=?`, p.plan_id);
    if (pl && pl.unit_price > 0) return pl.unit_price;
  }
  const st = q.get(`SELECT default_price FROM service_types WHERE code=?`, p.service_type || 'WASTE');
  return st ? st.default_price : 0;
}
function nextInvoiceNumber(period) {
  // highest existing sequence + 1 (a count could repeat a number if one was ever removed)
  const pre = `INV-${period.replace('-', '')}-`;
  const n = (q.get(`SELECT MAX(CAST(substr(number, ?) AS INTEGER)) m FROM invoices WHERE number LIKE ?`, pre.length + 1, pre + '%').m || 0) + 1;
  return `INV-${period.replace('-', '')}-${String(n).padStart(4, '0')}`;
}
function accountOf(customerId) {
  const c = q.get(`SELECT id, account_id FROM customers WHERE id=?`, customerId);
  return c ? (c.account_id || c.id) : customerId;
}
function createInvoice(accountId, period, jobs) {
  if (!jobs.length) return null;
  const lines = jobs.map(j => ({ job_id: j.id, date: j.scheduled_date, site: j.branch || j.name, service: j.service_type || 'WASTE', amount: money(priceFor(j)) }));
  const subtotal = money(lines.reduce((a, l) => a + l.amount, 0));
  const vat = money(subtotal * VAT_RATE);
  const due = addDays(ymd(), Number(getSetting('invoice_due_days', '15')) || 15);
  const number = nextInvoiceNumber(period);
  const info = q.run(`INSERT INTO invoices(number,customer_id,period,job_ids,lines,subtotal,vat,amount,due_date) VALUES (?,?,?,?,?,?,?,?,?)`,
    number, accountId, period, JSON.stringify(jobs.map(j => j.id)), JSON.stringify(lines), subtotal, vat, money(subtotal + vat), due);
  const id = Number(info.lastInsertRowid);
  jobs.forEach(j => q.run(`UPDATE pickups SET invoice_id=? WHERE id=?`, id, j.id));
  // Step 3 of the workflow: the invoice (with its PDF) is delivered in the customer app + push
  notifyCustomer(accountId, 'invoice', `Invoice ${number} issued`, `AED ${money(subtotal + vat).toFixed(2)} due ${dmy(due)} — tap to view the PDF`, '/customer/#invoices');
  q.run(`UPDATE invoices SET sent_at=datetime('now'), sent_count=1 WHERE id=?`, id);
  return { id, number, amount: money(subtotal + vat) };
}
const BILLABLE_SQL = `SELECT p.*, c.name, c.branch, COALESCE(c.account_id, c.id) acct FROM pickups p JOIN customers c ON c.id=p.customer_id
  WHERE p.status='collected' AND p.invoice_id IS NULL AND COALESCE(p.billable,1)=1`;
function generateInvoices(period, customerId = null) {
  let rows = q.all(BILLABLE_SQL + ` AND p.scheduled_date LIKE ?`, period + '%');
  if (customerId) { const a = accountOf(customerId); rows = rows.filter(r => r.acct === a); }
  const groups = {};
  rows.forEach(r => { (groups[r.acct] ||= []).push(r); });
  return Object.entries(groups).map(([acct, jobs]) => createInvoice(Number(acct), period, jobs)).filter(Boolean);
}
function invoiceView(inv) {
  const paid = q.get(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?`, inv.id).s;
  const balance = money(inv.amount - paid);
  let status = inv.status === 'void' ? 'Void' : balance <= 0.004 ? 'Paid' : inv.due_date < ymd() ? 'Overdue' : paid > 0 ? 'Partly paid' : 'Due';
  const c = q.get(`SELECT name, branch, contact_phone, email FROM customers WHERE id=?`, inv.customer_id);
  return { ...inv, lines: J(inv.lines, []), job_ids: J(inv.job_ids, []), paid: money(paid), balance, status_label: status, customer: c };
}
function onPickupCompleted(pickupId) {
  const p = q.get(`SELECT p.*, c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, pickupId);
  if (!p) return;
  notifyCustomer(p.customer_id, 'completed', 'Service completed', `${p.name} ${p.branch || ''} — photo proof is in your history`, '/customer/#history');
  if (p.plan_id) {
    const pl = q.get(`SELECT billing FROM service_plans WHERE id=?`, p.plan_id);
    if (pl && pl.billing === 'per_visit' && p.billable) createInvoice(accountOf(p.customer_id), p.scheduled_date.slice(0, 7), [p]);
  }
}
function onNotPickedUp(pickupId) {
  const deadline = new Date(Date.now() + CONFIRM_WINDOW_H * 3600e3).toISOString();
  q.run(`UPDATE pickups SET confirmation_status='awaiting', confirm_deadline=? WHERE id=?`, deadline, pickupId);
  const p = q.get(`SELECT p.anomaly_reason, c.id cid, c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, pickupId);
  notifyCustomer(p.cid, 'confirm', 'Please confirm: not picked up',
    `Driver reported "${String(p.anomaly_reason || '').replace(/_/g, ' ').toLowerCase()}" at ${p.name} ${p.branch || ''}. Confirm or dispute within 24 h.`, '/customer/#confirm');
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
function nextQuoteNumber() {
  const y = new Date().getFullYear();
  const pre = `QT-${y}-`;
  const n = (q.get(`SELECT MAX(CAST(substr(number, ?) AS INTEGER)) m FROM quotations WHERE number LIKE ?`, pre.length + 1, pre + '%').m || 0) + 1;
  return `QT-${y}-${String(n).padStart(4, '0')}`;
}
function quoteView(qt) {
  if (!qt) return null;
  const lead = qt.lead_id ? q.get(`SELECT * FROM leads WHERE id=?`, qt.lead_id) : null;
  const expired = qt.valid_until && qt.valid_until < ymd() && ['draft', 'sent'].includes(qt.status);
  return { ...qt, items: J(qt.items, []), plan: J(qt.plan, {}), status: expired ? 'expired' : qt.status,
    lead: lead ? { ...lead, sites: J(lead.sites, []) } : null };
}
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
const LOGO = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#14b8a6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>`;
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function docShell(title, body, extraBar = '', autoPrint = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title><style>${DOC_CSS}</style></head>
<body><div class="bar">${extraBar}<button onclick="print()">Download PDF</button></div><div class="page">${body}</div>
${autoPrint ? '<script>setTimeout(()=>print(),400)</script>' : ''}</body></html>`;
}
function brandHeader(docTitle, number, lines) {
  return `<div class="hd"><div class="brand">${LOGO}<div>GreenLoop<small>${h(getSetting('company_name', 'Majari / GreenLoop'))} · Waste management &amp; pest control · Dubai, UAE</small></div></div>
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
const QUOTE_MARK = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#0f766e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>`;
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
function quoteMail(qv, to, base) {
  const link = `${base}/q/${qv.share_token}`;
  return { to, link, subject: `Your GreenLoop quotation ${qv.number} — AED ${aed(qv.total)}${quoteIsMonthly(qv) ? ' a month' : ''}`,
    text: quoteEmailText(qv, link), html: quoteEmailHtml(qv, link), replyTo: getSetting('company_email', '') };
}
// Fingerprint of a previewed email. Sending requires it, so nothing goes out unseen or changed.
function previewToken(qv, mail) {
  return crypto.createHmac('sha256', SECRET).update([qv.id, qv.version, mail.to, mail.subject, mail.html].join('\n')).digest('hex').slice(0, 32);
}

function quoteHtml(qv, opts = {}) {
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
  <div class="lh"><div class="mark">${QUOTE_MARK}<div>GreenLoop<small>${h(getSetting('company_name', 'Majari / GreenLoop'))}, waste management and pest control, Dubai</small></div></div>
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
function invoiceHtml(iv, autoPrint) {
  const pays = q.all(`SELECT * FROM payments WHERE invoice_id=? ORDER BY received_at`, iv.id);
  return docShell(`Invoice ${iv.number}`, `
    ${brandHeader('TAX INVOICE', iv.number, [`Period: ${h(iv.period.slice(5) + '/' + iv.period.slice(0, 4))}`, `Issued: ${dmy(iv.created_at)}`, `Due: <b>${h(dmy(iv.due_date))}</b>`, `<span class="pill">${h(iv.status_label)}</span>`])}
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
  r.get('/service-types', (req, res) => {
    res.json(q.all(`SELECT * FROM service_types ORDER BY category, name`).map(t => ({ ...t, checklist: J(t.checklist, []) })));
  });
  r.post('/service-types', owner, (req, res) => {
    const b = req.body || {};
    if (!b.code || !b.name) return res.status(400).json({ error: 'code and name required' });
    if (!['waste', 'pest'].includes(b.category)) return res.status(400).json({ error: 'category must be waste or pest' });
    const info = q.run(`INSERT INTO service_types(code,name,category,default_duration_min,default_price,checklist) VALUES (?,?,?,?,?,?)`,
      String(b.code).toUpperCase().replace(/\s+/g, '_'), b.name, b.category, Number(b.default_duration_min) || 20, money(b.default_price), JSON.stringify(b.checklist || []));
    audit(req, 'service_type', info.lastInsertRowid, 'create', null, b);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  r.put('/service-types/:id', owner, (req, res) => {
    const t = q.get(`SELECT * FROM service_types WHERE id=?`, req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const b = { ...t, ...req.body };
    q.run(`UPDATE service_types SET name=?,category=?,default_duration_min=?,default_price=?,checklist=?,is_active=? WHERE id=?`,
      b.name, b.category, Number(b.default_duration_min), money(b.default_price),
      JSON.stringify(Array.isArray(b.checklist) ? b.checklist : J(b.checklist, [])), b.is_active ? 1 : 0, t.id);
    audit(req, 'service_type', t.id, 'update', t, req.body);
    res.json({ ok: true });
  });

  // ── Leads (CRM-09) ──
  const STAGES = ['new', 'contacted', 'quoted', 'won', 'lost'];
  r.get('/leads', staff, (req, res) => {
    const rows = q.all(`SELECT l.*, u.full_name owner_name,
        (SELECT COUNT(*) FROM quotations x WHERE x.lead_id=l.id) quotes,
        (SELECT total FROM quotations x WHERE x.lead_id=l.id ORDER BY id DESC LIMIT 1) last_quote_total
      FROM leads l LEFT JOIN users u ON u.id=l.owner_id ORDER BY
      CASE l.stage WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'quoted' THEN 2 WHEN 'won' THEN 3 ELSE 4 END, COALESCE(l.follow_up_at,'9999'), l.id DESC`);
    res.json(rows.map(l => ({ ...l, sites: J(l.sites, []), overdue_follow_up: !!(l.follow_up_at && l.follow_up_at < nowIso() && !['won', 'lost'].includes(l.stage)) })));
  });
  r.get('/leads/:id', staff, (req, res) => {
    const l = q.get(`SELECT * FROM leads WHERE id=?`, req.params.id);
    if (!l) return res.status(404).json({ error: 'Not found' });
    res.json({ ...l, sites: J(l.sites, []), quotations: q.all(`SELECT * FROM quotations WHERE lead_id=? ORDER BY id DESC`, l.id).map(quoteView) });
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
  function leadContacts(b, lead = null) {
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
      const dup = contacts.findDuplicate({ phone: out.phone, email: out.email }, { exceptLeadId: lead ? lead.id : null, exceptAccountId: lead ? lead.customer_id : null });
      if (dup) return { status: 409, body: { error: contacts.duplicateMessage(dup), code: 'DUPLICATE', duplicate: dup } };
    }
    return out;
  }
  r.post('/leads', staff, (req, res) => {
    const b = req.body || {};
    if (!String(b.contact || '').trim()) return res.status(400).json({ error: 'Contact name is required' });
    const lErr = leadError(b); if (lErr) return res.status(400).json({ error: lErr });
    const ct = leadContacts(b); if (ct.status) return res.status(ct.status).json(ct.body);
    const info = q.run(`INSERT INTO leads(contact,company,phone,email,service_type,sites,frequency,source,stage,owner_id,follow_up_at,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      String(b.contact).trim(), b.company || '', ct.phone, ct.email, b.service_type || 'WASTE', JSON.stringify(b.sites || []), b.frequency || '',
      b.source || 'other', 'new', b.owner_id || req.user.id, b.follow_up_at || null, b.notes || '');
    audit(req, 'lead', info.lastInsertRowid, 'create', null, b);
    io.to('staff').emit('lead:changed', {});
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  r.put('/leads/:id', staff, (req, res) => {
    const l = q.get(`SELECT * FROM leads WHERE id=?`, req.params.id);
    if (!l) return res.status(404).json({ error: 'Not found' });
    const b = { ...l, ...req.body };
    if (!STAGES.includes(b.stage)) return res.status(400).json({ error: 'Invalid stage' });
    const lErr = leadError(req.body || {}); if (lErr) return res.status(400).json({ error: lErr });
    if (b.stage === 'won' && l.stage !== 'won' && !l.customer_id) return res.status(400).json({ error: 'A lead becomes Won by converting an accepted quotation' });
    const ct = leadContacts(req.body || {}, l); if (ct.status) return res.status(ct.status).json(ct.body);
    q.run(`UPDATE leads SET contact=?,company=?,phone=?,email=?,service_type=?,sites=?,frequency=?,source=?,stage=?,lost_reason=?,owner_id=?,follow_up_at=?,notes=?,updated_at=datetime('now') WHERE id=?`,
      b.contact, b.company, ct.phone, ct.email, b.service_type, JSON.stringify(Array.isArray(b.sites) ? b.sites : J(b.sites, [])), b.frequency, b.source,
      b.stage, b.lost_reason || null, b.owner_id, b.follow_up_at || null, b.notes, l.id);
    audit(req, 'lead', l.id, 'update', l, req.body);
    io.to('staff').emit('lead:changed', {});
    res.json({ ok: true });
  });
  // Is this mobile number / email already in the CRM? (used by the forms while typing)
  r.get('/contacts/check', staff, (req, res) => {
    const out = { phone: null, email: null, duplicate: null };
    if (req.query.phone) { const p = contacts.parsePhone(req.query.phone); if (!p.ok) return res.json({ ...out, error: p.error, field: 'phone' }); out.phone = p.e164; }
    if (req.query.email) { const e = contacts.parseEmail(req.query.email); if (!e.ok) return res.json({ ...out, error: e.error, field: 'email' }); out.email = e.email; }
    const dup = contacts.findDuplicate({ phone: out.phone, email: out.email }, { exceptLeadId: Number(req.query.lead_id) || null, exceptAccountId: Number(req.query.account_id) || null });
    if (dup) out.duplicate = { ...dup, message: contacts.duplicateMessage(dup) };
    res.json(out);
  });

  // ── Quotations (CRM-10/11) ──
  r.get('/quotations', staff, (req, res) => {
    const rows = q.all(`SELECT * FROM quotations WHERE id IN (SELECT MAX(id) FROM quotations GROUP BY number) ORDER BY id DESC`);
    res.json(rows.map(quoteView));
  });
  r.get('/pricing/frequency', staff, (req, res) => {
    const fErr = frequencyError(req.query.unit, Number(req.query.count));
    if (fErr) return res.status(400).json({ error: fErr });
    const visits = visitsPerMonth(req.query.unit, Number(req.query.count)), price = Math.max(0, Number(req.query.unit_price) || 0);
    res.json({ unit: req.query.unit, count: Number(req.query.count), visits_per_month: visits, label: frequencyLabel(req.query.unit, Number(req.query.count)), line_total: money(visits * price) });
  });
  r.get('/quotations/:id', staff, (req, res) => {
    const qt = quoteView(q.get(`SELECT * FROM quotations WHERE id=?`, req.params.id));
    if (!qt) return res.status(404).json({ error: 'Not found' });
    qt.versions = q.all(`SELECT id, version, total, status, created_at FROM quotations WHERE number=? ORDER BY version DESC`, qt.number);
    res.json(qt);
  });
  function planFromBody(b) {
    const plan = b.plan || {};
    const err = validateRule(plan.recurrence);
    if (err) return { err };
    if (plan.time_window && !WIN_RX.test(plan.time_window)) return { err: security.windowError(plan.time_window) };
    if (plan.start_date && !security.isRealDate(plan.start_date)) return { err: 'Plan start date is not a valid date' };
    if (plan.end_date && (!security.isRealDate(plan.end_date) || (plan.start_date && plan.end_date < plan.start_date))) return { err: 'Plan end date is invalid or before the start date' };
    return { plan: { recurrence: plan.recurrence, time_window: plan.time_window || getSetting('default_time_window', '07:00-12:00'),
      start_date: plan.start_date || null, end_date: plan.end_date || null, billing: plan.billing === 'per_visit' ? 'per_visit' : 'monthly' } };
  }
  r.post('/quotations', staff, (req, res) => {
    const b = req.body || {};
    const lead = q.get(`SELECT * FROM leads WHERE id=?`, b.lead_id);
    if (!lead) return res.status(400).json({ error: 'lead_id required' });
    const iErr = quoteItemsError(b.items); if (iErr) return res.status(400).json({ error: iErr });
    const calc = calcQuote(b.items);
    if (!calc.items.length || calc.total <= 0) return res.status(400).json({ error: 'Add at least one priced line item' });
    const pp = planFromBody(b); if (pp.err) return res.status(400).json({ error: pp.err });
    let number = nextQuoteNumber(), version = 1;
    if (b.revise_of) {
      const prev = q.get(`SELECT * FROM quotations WHERE id=?`, b.revise_of);
      if (!prev) return res.status(404).json({ error: 'Quotation to revise not found' });
      number = prev.number;
      version = q.get(`SELECT MAX(version) v FROM quotations WHERE number=?`, number).v + 1;
      q.run(`UPDATE quotations SET status='superseded' WHERE number=? AND status IN ('draft','sent')`, number);
    }
    const valid = b.valid_until || addDays(ymd(), 30);
    const info = q.run(`INSERT INTO quotations(lead_id,number,version,items,plan,subtotal,vat,total,valid_until,status,share_token,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      lead.id, number, version, JSON.stringify(calc.items), JSON.stringify(pp.plan), calc.subtotal, calc.vat, calc.total, valid, 'draft',
      crypto.randomBytes(12).toString('hex'), b.notes || '', req.user.id);
    if (['new', 'contacted'].includes(lead.stage)) q.run(`UPDATE leads SET stage='quoted', updated_at=datetime('now') WHERE id=?`, lead.id);
    audit(req, 'quotation', info.lastInsertRowid, b.revise_of ? `revise → v${version}` : 'create', null, { number, version, ...calc });
    res.json({ ok: true, id: Number(info.lastInsertRowid), number, version });
  });
  r.post('/quotations/:id/status', staff, (req, res) => {
    const qt = q.get(`SELECT * FROM quotations WHERE id=?`, req.params.id);
    if (!qt) return res.status(404).json({ error: 'Not found' });
    const st = String(req.body?.status || '');
    if (!['accepted', 'rejected', 'draft', 'sent'].includes(st)) return res.status(400).json({ error: 'Invalid status' });
    q.run(`UPDATE quotations SET status=?, accepted_at=CASE WHEN ?='accepted' THEN datetime('now') ELSE accepted_at END WHERE id=?`, st, st, qt.id);
    if (st === 'rejected' && qt.lead_id) q.run(`UPDATE leads SET stage='lost', lost_reason=COALESCE(lost_reason,'Quote rejected') WHERE id=?`, qt.lead_id);
    audit(req, 'quotation', qt.id, 'status → ' + st, { status: qt.status }, { status: st });
    res.json({ ok: true });
  });
  // printable / PDF (token via ?t=)
  r.get('/quotations/:id/pdf', staff, (req, res) => {
    const qv = quoteView(q.get(`SELECT * FROM quotations WHERE id=?`, req.params.id));
    if (!qv) return res.status(404).send('Not found');
    res.type('html').send(quoteHtml(qv, { print: req.query.print === '1', embed: req.query.embed === '1' }));
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
  r.post('/quotations/:id/preview', staff, (req, res) => {
    const qv = quoteView(q.get(`SELECT * FROM quotations WHERE id=?`, req.params.id));
    if (!qv) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'sent'].includes(qv.status)) return res.status(409).json({ error: `This quotation is ${qv.status} and can no longer be sent` });
    const rc = recipientFor(req, qv.lead || {}); if (rc.error) return res.status(400).json(rc);
    const mail = quoteMail(qv, rc.to, quoteBase(req));
    const st = mailer.status();
    res.json({ ok: true, to: mail.to, from: st.sender || null, from_name: st.from_name, reply_to: mail.replyTo || null, subject: mail.subject, html: mail.html, text: mail.text, link: mail.link,
      delivery: st.configured ? 'sent' : 'compose', preview_token: previewToken(qv, mail),
      quotation: { id: qv.id, number: qv.number, version: qv.version, total: qv.total, valid_until: qv.valid_until, customer: (qv.lead || {}).company || (qv.lead || {}).contact || '' } });
  });
  //   via: 'gmail' (default, needs preview_token) | 'whatsapp' | 'pdf'
  r.post('/quotations/:id/send', staff, async (req, res) => {
    const qv = quoteView(q.get(`SELECT * FROM quotations WHERE id=?`, req.params.id));
    if (!qv) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'sent'].includes(qv.status)) return res.status(409).json({ error: `This quotation is ${qv.status} and can no longer be sent` });
    const lead = qv.lead || {};
    const via = ['whatsapp', 'pdf'].includes(req.body?.via) ? req.body.via : 'gmail';
    const markSent = (how, to, link) => {
      q.run(`UPDATE quotations SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_via=?, sent_to=?, sent_at=datetime('now') WHERE id=?`, how, to || null, qv.id);
      if (lead.id) q.run(`UPDATE leads SET stage=CASE WHEN stage IN ('new','contacted','qualified') THEN 'quoted' ELSE stage END, updated_at=datetime('now') WHERE id=?`, lead.id);
      audit(req, 'quotation', qv.id, 'sent via ' + how, null, { link, to: to || null });
    };
    if (via !== 'gmail') {
      const link = `${quoteBase(req)}/q/${qv.share_token}`;
      const text = quoteEmailText(qv, link);
      markSent(via, via === 'whatsapp' ? lead.phone : null, link);
      return res.json({ ok: true, via, link, whatsapp_url: waLink(lead.phone, text), text });
    }
    const rc = recipientFor(req, lead); if (rc.error) return res.status(400).json(rc);
    const mail = quoteMail(qv, rc.to, quoteBase(req));
    const seen = String(req.body?.preview_token || '');
    if (!seen) return res.status(428).json({ error: 'Preview the quotation email before sending it.', code: 'PREVIEW_REQUIRED' });
    if (seen !== previewToken(qv, mail)) return res.status(409).json({ error: 'The quotation or the recipient changed after you previewed it. Preview it again before sending.', code: 'PREVIEW_STALE' });
    const st = mailer.status();
    if (!st.configured) {
      // Gmail not connected on the server yet → hand the user a pre-filled Gmail compose window
      markSent('gmail', mail.to, mail.link);
      return res.json({ ok: true, via: 'gmail', delivery: 'compose', to: mail.to, link: mail.link, gmail_compose_url: mailer.composeUrl(mail), text: mail.text });
    }
    try {
      await mailer.send(mail);
      markSent('gmail', mail.to, mail.link);
      res.json({ ok: true, via: 'gmail', delivery: 'sent', to: mail.to, link: mail.link, from: st.sender });
    } catch (e) {
      // nothing is marked as sent when the email did not go out
      res.status(e.status || 502).json({ error: `Email not sent: ${e.message}`, gmail_compose_url: mailer.composeUrl(mail) });
    }
  });
  r.get('/mail/status', staff, (req, res) => res.json(mailer.status()));
  r.post('/mail/test', owner, async (req, res) => {
    const to = String(req.body?.to || '').trim();
    try { await mailer.send({ to, subject: 'GreenLoop — Gmail connection test', text: 'Gmail is connected. Quotations will be sent from this address.' }); res.json({ ok: true, to }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  // ── Convert accepted quote → customer (CRM-12) ──
  r.post('/quotations/:id/convert', staff, async (req, res) => {
    const qv = quoteView(q.get(`SELECT * FROM quotations WHERE id=?`, req.params.id));
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
    const dupC = contacts.findDuplicate({ phone: lead.phone, email: lead.email }, { exceptLeadId: lead.id });
    if (dupC && dupC.type === 'customer') return res.status(409).json({ error: contacts.duplicateMessage(dupC), code: 'DUPLICATE', duplicate: dupC });
    const code = await uniquePortalCode();
    const start = qv.plan.start_date && qv.plan.start_date >= ymd() ? qv.plan.start_date : ymd();
    let accountId = null; const created = [];
    for (const s of sites) {
      const info = q.run(`INSERT INTO customers(name,branch,zone,frequency,lat,lng,address,contact_phone,email,time_window,account_id,portal_code_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        lead.company || lead.contact, s.name || '', s.zone, 2, Number(s.lat), Number(s.lng), s.address || '', lead.phone || '', lead.email || '',
        qv.plan.time_window, accountId, accountId ? null : bcrypt.hashSync(code, 10));
      const cid = Number(info.lastInsertRowid);
      if (!accountId) { accountId = cid; q.run(`UPDATE customers SET account_id=? WHERE id=?`, cid, cid); }
      if (s.access_notes) q.run(`UPDATE customers SET access_notes=? WHERE id=?`, s.access_notes, cid);
      const items = qv.items.filter(i => !i.site || i.site === s.name);
      const byService = {};
      items.forEach(i => { byService[i.service_code] ||= i; });
      for (const [code2, it] of Object.entries(byService)) {
        const pi = q.run(`INSERT INTO service_plans(customer_id,service_code,recurrence,time_window,start_date,end_date,unit_price,billing,quotation_id) VALUES (?,?,?,?,?,?,?,?,?)`,
          cid, code2, JSON.stringify(recurrenceForLine(it, qv.plan.recurrence)), qv.plan.time_window, start, qv.plan.end_date || null, it.unit_price, qv.plan.billing, qv.id);
        created.push({ customer_id: cid, plan_id: Number(pi.lastInsertRowid) });
      }
    }
    q.run(`UPDATE leads SET stage='won', customer_id=?, updated_at=datetime('now') WHERE id=?`, accountId, lead.id);
    q.run(`UPDATE quotations SET status='converted' WHERE id=?`, qv.id);
    let jobs = 0;
    created.forEach(c => { jobs += generatePlans({ planId: c.plan_id }).created; });
    audit(req, 'quotation', qv.id, 'convert → customer', null, { account_id: accountId, sites: sites.length, plans: created.length, jobs });
    const portal = `${req.protocol}://${req.get('host')}/customer/`;
    const msg = `Welcome to GreenLoop, ${lead.contact}! Your customer app: ${portal}\nSign in with your mobile number ${lead.phone ? contacts.formatPhone(lead.phone) : ''} and your 4-digit code: ${code}\nYou can also ask the app to email you a one-time code${lead.email ? ' at ' + lead.email : ''}.\nTurn on notifications in the app — your invoices (with PDF), visit proof and reminders arrive there.`;
    io.to('staff').emit('ledger:refresh', {});
    // STEP 2 — registration: the app is waiting with a welcome message, access goes out by Gmail
    notifyCustomer(accountId, 'welcome', 'Welcome to GreenLoop', 'Your account is ready. Invoices, visit proof and reminders will arrive here — turn on notifications so you never miss one.', '/customer/');
    const welcome = { to: lead.email, subject: 'Welcome to GreenLoop — your customer app access', text: msg, replyTo: getSetting('company_email', '') };
    let email = { sent: false, to: lead.email || null, gmail_compose_url: mailer.isEmail(lead.email) ? mailer.composeUrl(welcome) : null };
    if (mailer.isEmail(lead.email) && mailer.status().configured) {
      try { await mailer.send(welcome); email.sent = true; } catch (e) { email.error = e.message; }
    }
    res.json({ ok: true, customer_id: accountId, sites: sites.length, plans: created.length, jobs_generated: jobs,
      portal_code: code, portal_url: portal, email, whatsapp_url: waLink(lead.phone, msg) });
  });

  // ── Pipeline dashboard (CRM-16) ──
  r.get('/pipeline/stats', staff, (req, res) => {
    const by = Object.fromEntries(STAGES.map(s => [s, 0]));
    q.all(`SELECT stage, COUNT(*) c FROM leads GROUP BY stage`).forEach(x => { by[x.stage] = x.c; });
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const quoted = q.get(`SELECT COUNT(DISTINCT lead_id) c FROM quotations`).c;
    const won = by.won;
    const pipelineValue = q.get(`SELECT COALESCE(SUM(total),0) s FROM quotations WHERE status IN ('draft','sent') AND id IN (SELECT MAX(id) FROM quotations GROUP BY number)`).s;
    const wonValue = q.get(`SELECT COALESCE(SUM(total),0) s FROM quotations WHERE status IN ('accepted','converted')`).s;
    const fast = q.get(`SELECT COUNT(*) c FROM leads l WHERE EXISTS (SELECT 1 FROM quotations x WHERE x.lead_id=l.id AND x.sent_at IS NOT NULL
      AND (julianday(x.sent_at)-julianday(l.created_at))*24 <= 24)`).c;
    const sources = q.all(`SELECT source, COUNT(*) c, SUM(stage='won') won FROM leads GROUP BY source ORDER BY c DESC`);
    const followUps = q.all(`SELECT id, contact, company, stage, follow_up_at FROM leads WHERE follow_up_at IS NOT NULL AND stage NOT IN ('won','lost') ORDER BY follow_up_at LIMIT 8`);
    res.json({ by_stage: by, total, quoted, won,
      lead_to_quote_pct: total ? Math.round(100 * quoted / total) : 0,
      quote_to_customer_pct: quoted ? Math.round(100 * won / quoted) : 0,
      lead_to_customer_pct: total ? Math.round(100 * won / total) : 0,
      quote_within_24h_pct: quoted ? Math.round(100 * fast / quoted) : 0,
      pipeline_value: money(pipelineValue), won_value: money(wonValue), sources, follow_ups: followUps });
  });

  // ── Service plans (§7) ──
  r.get('/service-plans', staff, (req, res) => {
    const rows = q.all(`SELECT sp.*, c.name, c.branch, c.zone, st.name service_name, st.category FROM service_plans sp
      JOIN customers c ON c.id=sp.customer_id LEFT JOIN service_types st ON st.code=sp.service_code
      ${req.query.customer_id ? 'WHERE sp.customer_id=' + Number(req.query.customer_id) : ''} ORDER BY c.name, sp.id`);
    res.json(rows.map(p => ({ ...p, recurrence: J(p.recurrence, {}), rule_label: describeRule(J(p.recurrence, {})) })));
  });
  function upsertPlan(req, res, customerId, existing) {
    const b = { ...(existing ? { ...existing, recurrence: J(existing.recurrence, {}) } : {}), ...(req.body || {}) };
    const err = validateRule(b.recurrence); if (err) return res.status(400).json({ error: err });
    if (b.time_window && !WIN_RX.test(b.time_window)) return res.status(400).json({ error: security.windowError(b.time_window) });
    if (!b.start_date) b.start_date = ymd();
    if (!security.isRealDate(b.start_date)) return res.status(400).json({ error: 'Start date is not a valid date' });
    if (b.end_date && !security.isRealDate(b.end_date)) return res.status(400).json({ error: 'End date is not a valid date' });
    if (b.end_date && b.end_date < b.start_date) return res.status(400).json({ error: 'End date is before start date' });
    const st = q.get(`SELECT * FROM service_types WHERE code=?`, b.service_code || 'WASTE');
    if (!st) return res.status(400).json({ error: 'Unknown service type' });
    const price = b.unit_price != null && b.unit_price !== '' ? money(b.unit_price) : st.default_price;
    let id;
    if (existing) {
      q.run(`UPDATE service_plans SET service_code=?,recurrence=?,time_window=?,start_date=?,end_date=?,paused=?,pause_from=?,pause_to=?,unit_price=?,billing=?,status=?,updated_at=datetime('now') WHERE id=?`,
        st.code, JSON.stringify(b.recurrence), b.time_window || '07:00-12:00', b.start_date, b.end_date || null, b.paused ? 1 : 0, b.pause_from || null, b.pause_to || null,
        price, b.billing === 'per_visit' ? 'per_visit' : 'monthly', b.status === 'ended' ? 'ended' : 'active', existing.id);
      id = existing.id;
    } else {
      id = Number(q.run(`INSERT INTO service_plans(customer_id,service_code,recurrence,time_window,start_date,end_date,unit_price,billing) VALUES (?,?,?,?,?,?,?,?)`,
        customerId, st.code, JSON.stringify(b.recurrence), b.time_window || '07:00-12:00', b.start_date, b.end_date || null, price, b.billing === 'per_visit' ? 'per_visit' : 'monthly').lastInsertRowid);
    }
    const out = regeneratePlan(id);
    audit(req, 'service_plan', id, existing ? 'update' : 'create', existing, b);
    io.to('staff').emit('ledger:refresh', {});
    return res.json({ ok: true, id, ...out });
  }
  r.post('/service-plans', staff, (req, res) => {
    const c = q.get(`SELECT id FROM customers WHERE id=?`, req.body?.customer_id);
    if (!c) return res.status(400).json({ error: 'customer_id required' });
    upsertPlan(req, res, c.id, null);
  });
  r.put('/service-plans/:id', staff, (req, res) => {
    const p = q.get(`SELECT * FROM service_plans WHERE id=?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    upsertPlan(req, res, p.customer_id, p);
  });
  r.post('/service-plans/generate', staff, (req, res) => res.json(generatePlans({ days: 14 })));

  // ── Ad-hoc order (CRM-04, real implementation) ──
  r.post('/pickups/adhoc', staff, (req, res) => {
    const { customer_id, date, vehicle_id, service_code, time_window } = req.body || {};
    const c = q.get(`SELECT * FROM customers WHERE id=? AND is_active=1`, customer_id);
    if (!c) return res.status(400).json({ error: 'Choose an active client' });
    const dErr = security.dateInRange(date, { futureDays: 366 }); if (dErr) return res.status(400).json({ error: dErr });
    if (time_window && !WIN_RX.test(time_window)) return res.status(400).json({ error: security.windowError(time_window) });
    if (q.get(`SELECT id FROM pickups WHERE customer_id=? AND scheduled_date=? AND status IN ('pending','overdue','collected') AND COALESCE(service_type,'WASTE')=?`, c.id, date, service_code || 'WASTE'))
      return res.status(409).json({ error: 'This client already has this service on that date' });
    if (vehicle_id) {
      const v = q.get(`SELECT * FROM vehicles WHERE id=? AND is_active=1`, vehicle_id);
      if (!v) return res.status(400).json({ error: 'Vehicle not found' });
      if (loadOf(v.id, date) >= capacityFor(v, date)) return res.status(409).json({ error: `${v.fleet_number} is full on ${date}` });
      const drv = q.get(`SELECT id FROM users WHERE role='driver' AND is_active=1 AND vehicle_id=? LIMIT 1`, v.id);
      const info = q.run(`INSERT INTO pickups(customer_id,vehicle_id,driver_id,scheduled_date,seq,status,service_type,time_window) VALUES (?,?,?,?,999,'pending',?,?)`,
        c.id, v.id, drv ? drv.id : null, date, service_code || 'WASTE', time_window || c.time_window || getSetting('default_time_window', '07:00-12:00'));
      resequence(v.id, date);
      audit(req, 'pickup', info.lastInsertRowid, 'ad-hoc create', null, req.body);
      io.to('staff').emit('ledger:refresh', { date }); io.to('staff').emit('driver:queue-updated', { vehicle_id: v.id, date });
      notifyVehicleDrivers(v.id, 'New stop added', `${c.name}${c.branch ? ' · ' + c.branch : ''} on ${dmy(date)}`);
      return res.json({ ok: true, id: Number(info.lastInsertRowid), vehicle: v.fleet_number });
    }
    const out = createJob({ customer: c, date, serviceCode: service_code, window: time_window });
    audit(req, 'pickup', out.id, 'ad-hoc create (auto-allocated)', null, req.body);
    io.to('staff').emit('ledger:refresh', { date });
    res.json({ ok: true, ...out });
  });

  // ── One-off bookings (CUS-07) ──
  r.get('/bookings', staff, (req, res) => res.json(q.all(`SELECT b.*, c.name, c.branch, c.zone FROM bookings b JOIN customers c ON c.id=b.customer_id ORDER BY b.status='requested' DESC, b.date`)));
  r.post('/bookings/:id/decide', staff, (req, res) => {
    const b = q.get(`SELECT * FROM bookings WHERE id=?`, req.params.id);
    if (!b || b.status !== 'requested') return res.status(404).json({ error: 'Booking not open' });
    if (req.body?.approve) {
      const c = q.get(`SELECT * FROM customers WHERE id=?`, b.customer_id);
      const date = req.body.date || b.date;
      const dErr = security.dateInRange(date, { futureDays: 366 }); if (dErr) return res.status(400).json({ error: dErr });
      const out = createJob({ customer: c, date, serviceCode: b.service_code, window: b.time_window });
      q.run(`UPDATE bookings SET status='confirmed', pickup_id=?, date=? WHERE id=?`, out.id, date, b.id);
      notifyCustomer(b.customer_id, 'booking', 'Booking confirmed', `Extra visit confirmed for ${date}${out.vehicle ? ' · ' + out.vehicle : ''}`);
    } else {
      q.run(`UPDATE bookings SET status='declined' WHERE id=?`, b.id);
      notifyCustomer(b.customer_id, 'booking', 'Booking not possible', `We could not schedule ${b.date}. ${req.body?.reason || 'Our team will call you.'}`);
    }
    audit(req, 'booking', b.id, req.body?.approve ? 'confirm' : 'decline', b, req.body);
    io.to('staff').emit('ledger:refresh', {});
    res.json({ ok: true });
  });

  // ── Invoices & payments (CRM-14) ──
  r.get('/invoices', staff, (req, res) => {
    const rows = q.all(`SELECT * FROM invoices ${req.query.customer_id ? 'WHERE customer_id=' + accountOf(Number(req.query.customer_id)) : ''} ORDER BY id DESC LIMIT 500`).map(invoiceView);
    const summary = rows.reduce((a, i) => { if (i.status_label !== 'Void') { a.billed += i.amount; a.collected += i.paid; a.outstanding += i.balance; if (i.status_label === 'Overdue') a.overdue += i.balance; } return a; },
      { billed: 0, collected: 0, outstanding: 0, overdue: 0 });
    Object.keys(summary).forEach(k => { summary[k] = money(summary[k]); });
    const unbilled = q.get(`SELECT COUNT(*) c FROM (${BILLABLE_SQL})`).c;
    res.json({ rows, summary, unbilled_jobs: unbilled });
  });
  r.post('/invoices/generate', owner, (req, res) => {
    const period = String(req.body?.period || ymd().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    const out = generateInvoices(period, req.body?.customer_id || null);
    audit(req, 'invoice', null, 'generate ' + period, null, { count: out.length });
    res.json({ ok: true, created: out.length, invoices: out });
  });
  r.get('/invoices/:id/pdf', need('admin', 'ops', 'customer'), (req, res) => {
    const inv = q.get(`SELECT * FROM invoices WHERE id=?`, req.params.id);
    if (!inv) return res.status(404).send('Not found');
    if (req.user.eff === 'customer' && accountOf(custId(req)) !== inv.customer_id) return res.status(403).send('Forbidden');
    res.type('html').send(invoiceHtml(invoiceView(inv), req.query.print === '1'));
  });
  // STEP 3 — (re)send an invoice to the customer app: in-app inbox + push, link opens the PDF
  r.post('/invoices/:id/send', owner, async (req, res) => {
    const inv = q.get(`SELECT * FROM invoices WHERE id=?`, req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (inv.status === 'void') return res.status(409).json({ error: 'A void invoice cannot be sent' });
    const v = invoiceView(inv);
    const body = v.balance > 0.004
      ? `AED ${v.balance.toFixed(2)} due ${dmy(inv.due_date)} — tap to view the PDF`
      : `AED ${inv.amount.toFixed(2)} — paid in full. Tap to view the PDF`;
    const pushed = await notifyCustomer(inv.customer_id, 'invoice', `Invoice ${inv.number}`, body, '/customer/#invoices');
    q.run(`UPDATE invoices SET sent_at=datetime('now'), sent_count=COALESCE(sent_count,0)+1 WHERE id=?`, inv.id);
    audit(req, 'invoice', inv.id, 'sent to customer app', null, { devices: pushed.devices, delivered: pushed.delivered });
    res.json({ ok: true, in_app: true, push: pushed });
  });
  r.post('/invoices/:id/void', owner, (req, res) => {
    const inv = q.get(`SELECT * FROM invoices WHERE id=?`, req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (q.get(`SELECT COUNT(*) c FROM payments WHERE invoice_id=?`, inv.id).c) return res.status(409).json({ error: 'Invoice has payments — cannot void' });
    q.run(`UPDATE invoices SET status='void' WHERE id=?`, inv.id);
    q.run(`UPDATE pickups SET invoice_id=NULL WHERE invoice_id=?`, inv.id);
    audit(req, 'invoice', inv.id, 'void', inv, null);
    res.json({ ok: true });
  });
  r.post('/payments', owner, (req, res) => {
    const { invoice_id, amount, method, reference, received_at } = req.body || {};
    const inv = q.get(`SELECT * FROM invoices WHERE id=?`, invoice_id);
    if (!inv || inv.status === 'void') return res.status(400).json({ error: 'Invoice not found or void' });
    const v = invoiceView(inv), amt = money(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be positive' });
    if (amt > v.balance + 0.004) return res.status(400).json({ error: `Amount exceeds balance (AED ${v.balance.toFixed(2)})` });
    if (!['cash', 'card', 'transfer', 'cheque', 'online'].includes(method)) return res.status(400).json({ error: 'Method must be cash, card, transfer, cheque or online' });
    const info = q.run(`INSERT INTO payments(invoice_id,amount,method,reference,received_at,recorded_by) VALUES (?,?,?,?,?,?)`,
      inv.id, amt, method, reference || '', received_at || nowIso(), req.user.name);
    audit(req, 'payment', info.lastInsertRowid, 'record', { balance: v.balance }, { invoice: inv.number, amount: amt, method, reference });
    notifyCustomer(inv.customer_id, 'payment', 'Payment received', `AED ${amt.toFixed(2)} received for ${inv.number}. Thank you!`, '/customer/#invoices');
    res.json({ ok: true, id: Number(info.lastInsertRowid), balance: invoiceView(inv).balance });
  });
  r.get('/payments', staff, (req, res) => res.json(q.all(`SELECT p.*, i.number, i.customer_id, c.name FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id ORDER BY p.received_at DESC LIMIT 300`)));

  // ── Customer 360 (CRM-15) ──
  r.get('/customers/:id/360', staff, (req, res) => {
    const c = q.get(`SELECT * FROM customers WHERE id=?`, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const acct = c.account_id || c.id;
    const sites = q.all(`SELECT id, name, branch, zone, address, lat, lng, is_active FROM customers WHERE id=? OR account_id=? ORDER BY id`, acct, acct);
    const ids = sites.map(s => s.id);
    const inList = ids.join(',') || '0';
    const plans = q.all(`SELECT sp.*, st.name service_name FROM service_plans sp LEFT JOIN service_types st ON st.code=sp.service_code WHERE customer_id IN (${inList})`)
      .map(p => ({ ...p, rule_label: describeRule(J(p.recurrence, {})) }));
    const visits = q.all(`SELECT p.id, p.scheduled_date, p.status, p.service_type, p.photo_url, p.anomaly_reason, p.confirmation_status, p.completed_at, p.notes, p.customer_id,
        c.branch, u.full_name driver FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.driver_id
        WHERE p.customer_id IN (${inList}) ORDER BY p.scheduled_date DESC LIMIT 60`);
    const invoices = q.all(`SELECT * FROM invoices WHERE customer_id=? ORDER BY id DESC`, acct).map(invoiceView);
    const payments = q.all(`SELECT p.*, i.number FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.customer_id=? ORDER BY p.received_at DESC`, acct);
    const lead = q.get(`SELECT * FROM leads WHERE customer_id=?`, acct);
    const since30 = addDays(ymd(), -30);
    const noPick30 = q.get(`SELECT COUNT(*) c FROM pickups WHERE customer_id IN (${inList}) AND status='canceled' AND confirmation_status IN ('confirmed','auto_confirmed') AND scheduled_date>=?`, since30).c;
    const done90 = q.get(`SELECT SUM(status='collected') ok, COUNT(*) n FROM pickups WHERE customer_id IN (${inList}) AND scheduled_date BETWEEN ? AND ? AND status!='rescheduled'`, addDays(ymd(), -90), ymd());
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
    const c = q.get(`SELECT * FROM customers WHERE id=?`, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const code = await uniquePortalCode();
    q.run(`UPDATE customers SET portal_code_hash=? WHERE id=?`, bcrypt.hashSync(code, 10), c.account_id || c.id);
    audit(req, 'customer', c.id, 'reset portal code', null, null);
    res.json({ ok: true, portal_code: code, whatsapp_url: waLink(c.contact_phone, `Your GreenLoop app code is ${code}. Sign in to the customer app with this mobile number and the 4-digit code.`) });
  });

  // ── Not picked up: confirmation (CUS-10) + override ──
  r.get('/confirmations', staff, (req, res) => {
    res.json(q.all(`SELECT p.id, p.scheduled_date, p.anomaly_reason, p.photo_url, p.confirmation_status, p.confirm_deadline, p.proof_meta,
        c.id customer_id, c.name, c.branch, c.contact_phone, u.full_name driver FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.driver_id
        WHERE p.confirmation_status IS NOT NULL ORDER BY p.confirmation_status='awaiting' DESC, p.confirmation_status='disputed' DESC, p.scheduled_date DESC LIMIT 100`)
      .map(x => ({ ...x, whatsapp_url: waLink(x.contact_phone, `GreenLoop: our driver could not complete the visit at ${x.name} ${x.branch || ''} on ${x.scheduled_date} (${String(x.anomaly_reason || '').replace(/_/g, ' ').toLowerCase()}). Please confirm or dispute in your portal.`) })));
  });
  function resolveNoPickup(req, p, action, note, by) {
    if (!p || p.status !== 'canceled') return { code: 404, error: 'No "not picked up" job to confirm' };
    if (p.confirmation_status !== 'awaiting' && by !== 'override') return { code: 409, error: `Already ${p.confirmation_status}` };
    const c = q.get(`SELECT * FROM customers WHERE id=?`, p.customer_id);
    if (action === 'confirm') {
      q.run(`UPDATE pickups SET confirmation_status='confirmed', billable=0, notes=COALESCE(notes,'')||? WHERE id=?`, note ? ` [confirm: ${note}]` : '', p.id);
      q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES ('RESCHEDULED','info',?,?)`, `No-pickup confirmed by ${by} — ${c.name} ${c.branch || ''} (not billed)`, p.id);
      checkAttention(c);
      return { ok: true, status: 'Canceled – confirmed, not billed' };
    }
    if (action === 'dispute') {
      q.run(`UPDATE pickups SET confirmation_status='disputed', billable=0, notes=COALESCE(notes,'')||? WHERE id=?`, ` [dispute: ${note || 'no reason'}]`, p.id);
      let date = addDays(ymd(), 1), out = null;
      for (let i = 0; i < 7 && !out; i++) {
        const d = addDays(date, i);
        if (holidays().has(d)) continue;
        const a = allocate(c, d, p.service_type || 'WASTE');
        if (a.vehicle) out = createJob({ customer: c, date: d, serviceCode: p.service_type, window: p.time_window, planId: p.plan_id, revisit: true, billable: true, note: `Free revisit for disputed job #${p.id}` });
      }
      // free revisit: not billed
      if (out) q.run(`UPDATE pickups SET billable=0 WHERE id=?`, out.id);
      q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES ('RESCHEDULED','warning',?,?)`, `No-pickup marked as RESCHEDULED`, p.id);
      alertCrm('DISPUTE', 'critical', `DISPUTE: ${c.name} (${c.branch || ''}) says job #${p.id} on ${p.scheduled_date} was not a valid no-pickup. ${note ? '“' + note + '” ' : ''}${out ? 'Free revisit booked #' + out.id : 'No capacity for revisit — schedule manually.'}`, p.id);
      notifyCustomer(c.id, 'revisit', 'Free revisit booked', out ? `We will come back — job #${out.id}` : 'Our team will call you to arrange a revisit.');
      if (IO) IO.to('staff').emit('ledger:refresh', {});
      return { ok: true, status: 'Disputed — free revisit', revisit_id: out ? out.id : null };
    }
    return { code: 400, error: 'action must be confirm or dispute' };
  }
  r.post('/pickups/:id/confirm', need('customer', 'admin', 'ops'), (req, res) => {
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (req.user.eff === 'customer') {
      const acct = accountOf(custId(req));
      if (!p || accountOf(p.customer_id) !== acct) return res.status(404).json({ error: 'Not found' });
    }
    const by = req.user.eff === 'customer' ? 'customer' : 'override';
    const out = resolveNoPickup(req, p, req.body?.action, String(req.body?.note || '').slice(0, 300), by);
    if (out.error) return res.status(out.code).json({ error: out.error });
    if (by === 'override') audit(req, 'pickup', p.id, 'no-pickup override → ' + req.body?.action, { confirmation_status: p.confirmation_status }, req.body);
    res.json(out);
  });
  // Ops override for a rejected proof photo (poor GPS indoors etc.) — logged
  r.post('/pickups/:id/proof-override', staff, (req, res) => {
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (min 5 characters)' });
    if (['collected', 'rescheduled'].includes(p.status)) return res.status(409).json({ error: 'Already ' + p.status });
    const meta = J(p.proof_meta, {});
    q.run(`UPDATE pickups SET status='collected', completed_at=datetime('now'), proof_meta=?, notes=COALESCE(notes,'')||?, updated_at=datetime('now') WHERE id=?`,
      JSON.stringify({ ...meta, overridden: true, override_reason: reason, override_by: req.user.name }), ` [ops override: ${reason}]`, p.id);
    audit(req, 'pickup', p.id, 'proof override → collected', meta, { reason });
    onPickupCompleted(p.id);
    io.to('staff').emit('ledger:refresh', {});
    res.json({ ok: true });
  });
  r.get('/attention', staff, (req, res) => {
    res.json(q.all(`SELECT c.id, c.name, c.branch, c.zone, COUNT(*) confirmed FROM pickups p JOIN customers c ON c.id=p.customer_id
      WHERE p.status='canceled' AND p.confirmation_status IN ('confirmed','auto_confirmed') AND p.scheduled_date>=? GROUP BY c.id HAVING COUNT(*)>=3 ORDER BY confirmed DESC`, addDays(ymd(), -30)));
  });

  // ── Audit log (CRM-18) ──
  r.get('/audit', owner, (req, res) => {
    const ent = req.query.entity ? String(req.query.entity) : null;
    res.json(ent ? q.all(`SELECT * FROM audit_log WHERE entity=? ORDER BY id DESC LIMIT 300`, ent) : q.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 300`));
  });
  // weak_password: this account still uses the seeded demo password → CRM shows a warning.
  const weakPw = new Map();   // user id → { hash, weak } (bcrypt is slow; recheck only when the hash changes)
  r.get('/me', staff, (req, res) => {
    const u = q.get(`SELECT id, password_hash FROM users WHERE id=?`, req.user.id);
    let weak = false;
    if (u && u.password_hash) {
      const c = weakPw.get(u.id);
      if (c && c.hash === u.password_hash) weak = c.weak;
      else { weak = ['admin123', 'admin', 'password', 'greenloop'].some((p) => bcrypt.compareSync(p, u.password_hash)); weakPw.set(u.id, { hash: u.password_hash, weak }); }
    }
    res.json({ id: req.user.id, name: req.user.name, crm_role: req.user.eff, weak_password: weak });
  });
  r.put('/users/:id/crm-role', owner, (req, res) => {
    const role = req.body?.crm_role === 'ops' ? 'ops' : 'owner';
    const u = q.get(`SELECT * FROM users WHERE id=? AND role='admin'`, req.params.id);
    if (!u) return res.status(404).json({ error: 'CRM user not found' });
    if (u.id === req.user.id && role === 'ops') return res.status(400).json({ error: 'You cannot demote yourself' });
    q.run(`UPDATE users SET crm_role=? WHERE id=?`, role, u.id);
    audit(req, 'user', u.id, 'crm_role → ' + role, { crm_role: u.crm_role }, { crm_role: role });
    res.json({ ok: true });
  });
  r.get('/v3/settings', owner, (req, res) => res.json({
    uae_holidays: J(getSetting('uae_holidays', '[]'), []), default_time_window: getSetting('default_time_window'),
    invoice_due_days: getSetting('invoice_due_days'), company_whatsapp: getSetting('company_whatsapp'), company_email: getSetting('company_email', ''), mail: mailer.status(), shift_cutoff: getSetting('shift_cutoff', '12:00') }));
  r.put('/v3/settings', owner, (req, res) => {
    const b = req.body || {};
    if (b.uae_holidays) setSetting('uae_holidays', JSON.stringify(b.uae_holidays.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))));
    if (b.default_time_window && WIN_RX.test(b.default_time_window)) setSetting('default_time_window', b.default_time_window);
    if (b.invoice_due_days) setSetting('invoice_due_days', String(Number(b.invoice_due_days) || 15));
    if (b.company_whatsapp) { const wp = contacts.parsePhone(b.company_whatsapp); if (!wp.ok) return res.status(400).json({ error: 'Company WhatsApp number: ' + wp.error }); setSetting('company_whatsapp', wp.e164); }
    if (b.company_email !== undefined) { if (b.company_email && !mailer.isEmail(b.company_email)) return res.status(400).json({ error: 'Company email is not a valid address' }); setSetting('company_email', b.company_email || ''); }
    if (b.shift_cutoff && /^\d{2}:\d{2}$/.test(b.shift_cutoff)) setSetting('shift_cutoff', b.shift_cutoff);
    audit(req, 'settings', null, 'update', null, b);
    res.json({ ok: true });
  });
  r.put('/vehicles/:id/tags', owner, (req, res) => {
    const tags = (req.body?.service_tags || []).filter(t => ['waste', 'pest'].includes(t));
    if (!tags.length) return res.status(400).json({ error: 'Pick waste and/or pest' });
    q.run(`UPDATE vehicles SET service_tags=? WHERE id=?`, tags.join(','), req.params.id);
    audit(req, 'vehicle', req.params.id, 'service tags', null, { tags });
    res.json({ ok: true });
  });

  // ── Public quotation link (from WhatsApp) + accept (CUS-11) ──
  r.get('/public/quotations/:token', (req, res) => {
    const qv = quoteView(q.get(`SELECT * FROM quotations WHERE share_token=?`, req.params.token));
    if (!qv) return res.status(404).type('html').send('<h3>Quotation not found</h3>');
    res.type('html').send(quoteHtml(qv, { acceptUrl: `/api/v1/public/quotations/${req.params.token}/accept` }));
  });
  r.post('/public/quotations/:token/accept', (req, res) => {
    const qt = q.get(`SELECT * FROM quotations WHERE share_token=?`, req.params.token);
    const qv = quoteView(qt);
    if (!qv) return res.status(404).send('Not found');
    if (qv.status === 'expired') return res.status(409).type('html').send(docShell('Expired', '<h2>This quotation has expired.</h2><p>Please contact GreenLoop for a new one.</p>'));
    if (['draft', 'sent'].includes(qv.status)) {
      q.run(`UPDATE quotations SET status='accepted', accepted_at=datetime('now') WHERE id=?`, qt.id);
      audit(null, 'quotation', qt.id, 'accepted by customer (link)', null, null);
      alertCrm('QUOTE_ACCEPTED', 'info', `Quotation ${qt.number} v${qt.version} accepted by ${qv.lead?.company || qv.lead?.contact} — convert to customer in Quotations.`);
      io.to('staff').emit('lead:changed', {});
    }
    res.type('html').send(docShell('Accepted', `${brandHeader('THANK YOU', qt.number, [])}<h2>Quotation accepted ✓</h2><p>Our team will set up your service plan and send your customer-portal access shortly.</p>`));
  });

  // ── Customer portal additions ──
  // One-time sign-in code (CUS-01): 6 digits, 10 minutes, 5 attempts.
  // v3.3: the code is emailed through the Gmail account the quotations use (free). A customer
  // who types their mobile number gets the code at the email address saved on their account.
  function otpAccount(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return { error: 'Enter your mobile number or email' };
    if (id.includes('@')) {
      const e = contacts.parseEmail(id); if (!e.ok) return { error: e.error };
      const c = q.get(`SELECT * FROM customers WHERE is_active=1 AND lower(email)=? ORDER BY COALESCE(account_id,id)=id DESC LIMIT 1`, e.email);
      return { channel: 'email', customer: c || null, typedEmail: e.email };
    }
    const p = contacts.parsePhone(id); if (!p.ok) return { error: p.error };
    const c = q.all(`SELECT * FROM customers WHERE is_active=1 AND contact_phone IS NOT NULL AND contact_phone!=''`).find(x => contacts.samePhone(x.contact_phone, p.e164));
    return { channel: 'phone', customer: c || null };
  }
  r.post('/auth/customer-otp/request', (req, res) => {
    const who = otpAccount(req.body?.identifier);
    if (who.error) return res.status(400).json({ error: who.error });
    // same response whether or not the account exists (no account enumeration)
    const generic = { ok: true, message: 'If this mobile number or email is registered, we have emailed a 6-digit code to the address on the account. It is valid for 10 minutes.' };
    const c = who.customer;
    if (!c) return res.json(generic);
    const acct = c.account_id || c.id;
    const account = q.get(`SELECT * FROM customers WHERE id=?`, acct) || c;
    const code = String(crypto.randomInt(100000, 1000000));
    q.run(`DELETE FROM otp_codes WHERE customer_id=?`, acct);
    q.run(`INSERT INTO otp_codes(customer_id,channel,code_hash,expires_at) VALUES (?,?,?,?)`, acct, who.channel,
      bcrypt.hashSync(code, 8), new Date(Date.now() + 10 * 60e3).toISOString());
    const to = who.typedEmail || [account.email, c.email].find(e => contacts.parseEmail(e).ok) || null;
    const mailOn = mailer.status().configured;
    if (mailOn && to) {
      // not awaited: the reply must not take longer for a registered account than for an unknown one
      mailer.send({ to, subject: `${code} is your GreenLoop sign-in code`, replyTo: getSetting('company_email', ''),
        text: `Your GreenLoop sign-in code is ${code}\n\nIt is valid for 10 minutes. If you did not ask for it, ignore this email.\n\nGreenLoop`,
        html: `<div style="font:15px/1.55 'Segoe UI',-apple-system,Arial,sans-serif;color:#13231f;max-width:480px;margin:0 auto;padding:8px 4px">
          <p style="margin:0 0 14px;padding-bottom:12px;border-bottom:2px solid #13231f;font-size:19px;font-weight:700">GreenLoop</p>
          <p style="margin:0 0 8px">Your sign-in code for ${h(account.name)}</p>
          <p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:6px">${code}</p>
          <p style="margin:0;font-size:13px;color:#55645f">It is valid for 10 minutes. If you did not ask for it, ignore this email.</p></div>` })
        .catch(e => alertCrm('OTP_NOT_SENT', 'warning', `Sign-in code for ${account.name} could not be emailed to ${to}: ${e.message}`));
    } else if (mailOn && !to) {
      alertCrm('OTP_NOT_SENT', 'info', `${account.name} asked for a sign-in code but has no email on the account. Add one in Customers, or give them their 4-digit app code.`);
    }
    const out = { ...generic };
    // Demo mode shows the code on screen. It is off as soon as Gmail is connected, unless OTP_DEV=1 forces it.
    if (process.env.OTP_DEV === '1' || (process.env.OTP_DEV !== '0' && !mailOn)) out.dev_code = code;
    res.json(out);
  });
  r.post('/auth/customer-otp/verify', (req, res) => {
    const code = String(req.body?.code || '');
    const who = otpAccount(req.body?.identifier);
    const c = who.customer;
    if (who.error || !c) return res.status(401).json({ error: 'Invalid or expired code' });
    const acct = c.account_id || c.id;
    const row = q.get(`SELECT * FROM otp_codes WHERE customer_id=? ORDER BY id DESC LIMIT 1`, acct);
    if (!row || row.expires_at < nowIso() || row.attempts >= 5) return res.status(401).json({ error: 'Invalid or expired code' });
    if (!bcrypt.compareSync(code, row.code_hash)) {
      q.run(`UPDATE otp_codes SET attempts=attempts+1 WHERE id=?`, row.id);
      return res.status(401).json({ error: 'Invalid or expired code' });
    }
    q.run(`DELETE FROM otp_codes WHERE customer_id=?`, acct);
    const a = q.get(`SELECT * FROM customers WHERE id=?`, acct);
    const token = jwt.sign({ id: a.id, role: 'customer', name: a.name, customer_id: a.id }, SECRET, { expiresIn: '30d' });
    res.json({ token, customer: { id: a.id, name: a.name, branch: a.branch, zone: a.zone, address: a.address, contact_phone: a.contact_phone } });
  });

  r.get('/customer/sites', cust, (req, res) => {
    const acct = accountOf(custId(req));
    res.json({ current: custId(req), sites: q.all(`SELECT id, name, branch, zone, address FROM customers WHERE (id=? OR account_id=?) AND is_active=1 ORDER BY id`, acct, acct) });
  });
  r.post('/customer/switch-site', cust, (req, res) => {
    const acct = accountOf(custId(req));
    const s = q.get(`SELECT * FROM customers WHERE id=? AND (id=? OR account_id=?) AND is_active=1`, req.body?.site_id, acct, acct);
    if (!s) return res.status(404).json({ error: 'Site not in your account' });
    const token = jwt.sign({ id: s.id, role: 'customer', name: s.name, customer_id: s.id }, SECRET, { expiresIn: '30d' });
    res.json({ token, customer: { id: s.id, name: s.name, branch: s.branch, zone: s.zone, address: s.address, contact_phone: s.contact_phone } });
  });
  r.get('/customer/plans', cust, (req, res) => {
    const rows = q.all(`SELECT sp.*, st.name service_name, st.category FROM service_plans sp LEFT JOIN service_types st ON st.code=sp.service_code WHERE sp.customer_id=? AND sp.status!='ended' ORDER BY sp.id`, custId(req));
    res.json({ plans: rows.map(p => ({ ...p, recurrence: J(p.recurrence, {}), rule_label: describeRule(J(p.recurrence, {})) })),
      services: q.all(`SELECT code, name, category, default_price FROM service_types WHERE is_active=1`) });
  });
  const custPlanReq = (req, res, existing) => {
    const b = req.body || {};
    // customers can't set price/billing
    delete b.unit_price; delete b.billing; delete b.status;
    const fake = { ...req, user: { ...req.user, eff: 'customer' }, body: b };
    const before = existing ? { ...existing } : null;
    upsertPlan(fake, { json: (o) => {
      const c = q.get(`SELECT name, branch FROM customers WHERE id=?`, custId(req));
      alertCrm('PLAN_CHANGE', 'info', `${c.name} (${c.branch || ''}) ${before ? 'changed' : 'booked'} a service plan: ${describeRule(b.recurrence || J(before?.recurrence, {}))} ${b.time_window || ''}`);
      return res.json(o);
    }, status: (c) => res.status(c) }, custId(req), existing);
  };
  r.post('/customer/plans', cust, (req, res) => custPlanReq(req, res, null));
  r.put('/customer/plans/:id', cust, (req, res) => {
    const p = q.get(`SELECT * FROM service_plans WHERE id=? AND customer_id=?`, req.params.id, custId(req));
    if (!p) return res.status(404).json({ error: 'Not found' });
    custPlanReq(req, res, p);
  });
  r.get('/customer/bookings', cust, (req, res) => res.json(q.all(`SELECT * FROM bookings WHERE customer_id=? ORDER BY id DESC LIMIT 30`, custId(req))));
  r.post('/customer/bookings', cust, (req, res) => {
    const b = req.body || {};
    const dErr = security.dateInRange(b.date, { futureDays: 366 }); if (dErr) return res.status(400).json({ error: dErr === 'Date cannot be in the past' ? 'Pick a date from today onwards' : dErr });
    if (b.time_window && !WIN_RX.test(b.time_window)) return res.status(400).json({ error: security.windowError(b.time_window) });
    if (!q.get(`SELECT 1 x FROM service_types WHERE code=? AND is_active=1`, b.service_code)) return res.status(400).json({ error: 'Pick a service' });
    const info = q.run(`INSERT INTO bookings(customer_id,service_code,date,time_window,notes) VALUES (?,?,?,?,?)`, custId(req), b.service_code, b.date,
      WIN_RX.test(b.time_window || '') ? b.time_window : null, String(b.notes || '').slice(0, 300));
    const c = q.get(`SELECT name, branch FROM customers WHERE id=?`, custId(req));
    alertCrm('BOOKING', 'warning', `One-off booking request: ${c.name} (${c.branch || ''}) · ${b.service_code} on ${b.date} — confirm in Bookings.`);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  r.get('/customer/invoices', cust, (req, res) => {
    const acct = accountOf(custId(req));
    const rows = q.all(`SELECT * FROM invoices WHERE customer_id=? AND status!='void' ORDER BY id DESC`, acct).map(invoiceView);
    const payments = q.all(`SELECT p.*, i.number FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.customer_id=? ORDER BY p.received_at DESC`, acct);
    res.json({ rows, payments, balance: money(rows.reduce((a, i) => a + i.balance, 0)), overdue: money(rows.filter(i => i.status_label === 'Overdue').reduce((a, i) => a + i.balance, 0)) });
  });
  r.get('/customer/confirmations', cust, (req, res) => {
    const acct = accountOf(custId(req));
    res.json(q.all(`SELECT p.id, p.scheduled_date, p.anomaly_reason, p.photo_url, p.confirmation_status, p.confirm_deadline, c.branch, u.full_name driver
      FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.driver_id
      WHERE (c.id=? OR c.account_id=?) AND p.confirmation_status IS NOT NULL ORDER BY p.confirmation_status='awaiting' DESC, p.scheduled_date DESC LIMIT 30`, acct, acct));
  });
  r.get('/customer/quotations', cust, (req, res) => {
    const acct = accountOf(custId(req));
    const lead = q.get(`SELECT id FROM leads WHERE customer_id=?`, acct);
    res.json(lead ? q.all(`SELECT * FROM quotations WHERE lead_id=? AND status NOT IN ('superseded','draft') ORDER BY id DESC`, lead.id).map(quoteView) : []);
  });
  r.post('/customer/quotations/:id/accept', cust, (req, res) => {
    const acct = accountOf(custId(req));
    const lead = q.get(`SELECT id FROM leads WHERE customer_id=?`, acct);
    const qt = lead && q.get(`SELECT * FROM quotations WHERE id=? AND lead_id=?`, req.params.id, lead.id);
    const qv = quoteView(qt);
    if (!qv) return res.status(404).json({ error: 'Not found' });
    if (qv.status !== 'sent') return res.status(409).json({ error: 'This quotation is ' + qv.status });
    q.run(`UPDATE quotations SET status='accepted', accepted_at=datetime('now') WHERE id=?`, qt.id);
    alertCrm('QUOTE_ACCEPTED', 'info', `Existing customer accepted quotation ${qt.number} v${qt.version}.`);
    res.json({ ok: true });
  });
  r.get('/customer/notifications', cust, (req, res) => {
    const acct = accountOf(custId(req));
    const rows = q.all(`SELECT n.* FROM customer_notifications n JOIN customers c ON c.id=n.customer_id WHERE c.id=? OR c.account_id=? ORDER BY n.id DESC LIMIT 40`, acct, acct);
    res.json({ rows, unread: rows.filter(r2 => !r2.is_read).length });
  });
  r.post('/customer/notifications/read', cust, (req, res) => {
    const acct = accountOf(custId(req));
    q.run(`UPDATE customer_notifications SET is_read=1 WHERE customer_id IN (SELECT id FROM customers WHERE id=? OR account_id=?)`, acct, acct);
    res.json({ ok: true });
  });
  // full history with filters (CUS-03)
  r.get('/customer/history-v3', cust, (req, res) => {
    const acct = accountOf(custId(req));
    const site = req.query.site ? Number(req.query.site) : null;
    const from = req.query.from || '0000', to = req.query.to || '9999';
    const rows = q.all(`SELECT p.id, p.scheduled_date, p.status, p.completed_at, p.photo_url, p.anomaly_reason, p.service_type, p.checklist, p.confirmation_status,
        c.id site_id, c.branch, u.full_name driver_name, v.fleet_number, st.name service_name
      FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.driver_id LEFT JOIN vehicles v ON v.id=p.vehicle_id
      LEFT JOIN service_types st ON st.code=p.service_type
      WHERE (c.id=? OR c.account_id=?) AND p.status IN ('collected','canceled','overdue') AND p.scheduled_date BETWEEN ? AND ? ${site ? 'AND c.id=' + site : ''}
      ORDER BY p.scheduled_date DESC LIMIT 300`, acct, acct, from, to);
    res.json(rows.map(x => ({ ...x, checklist: J(x.checklist, []) })));
  });
  r.get('/customer/history-v3/pdf', cust, (req, res) => {
    const acct = accountOf(custId(req));
    const from = req.query.from || addDays(ymd(), -90), to = req.query.to || ymd();
    const c = q.get(`SELECT * FROM customers WHERE id=?`, acct);
    const rows = q.all(`SELECT p.*, c.branch, u.full_name driver, st.name service_name FROM pickups p JOIN customers c ON c.id=p.customer_id
      LEFT JOIN users u ON u.id=p.driver_id LEFT JOIN service_types st ON st.code=p.service_type
      WHERE (c.id=? OR c.account_id=?) AND p.status IN ('collected','canceled','overdue') AND p.scheduled_date BETWEEN ? AND ? ORDER BY p.scheduled_date`, acct, acct, from, to);
    res.type('html').send(docShell('Service history', `${brandHeader('SERVICE HISTORY', c.name, [`${from} → ${to}`, `${rows.length} visits`])}
      <table><tr><th>Date</th><th>Site</th><th>Service</th><th>Driver</th><th>Outcome</th><th>Checklist</th><th>GPS photo</th></tr>
      ${rows.map(p => `<tr><td>${p.scheduled_date}</td><td>${h(p.branch)}</td><td>${h(p.service_name || p.service_type)}</td><td>${h(p.driver || '—')}</td>
      <td>${p.status === 'collected' ? 'Completed' : 'Not picked up: ' + h(String(p.anomaly_reason || '').replace(/_/g, ' ').toLowerCase())}</td>
      <td>${h(J(p.checklist, []).join(', '))}</td><td>${p.photo_url ? `<img class="ph" src="${h(p.photo_url)}">` : '—'}</td></tr>`).join('')}</table>
      <div class="foot">Photos are captured with the live camera and stamped on-device with date, time and GPS.</div>`, '', req.query.print === '1'));
  });

  // ── driver helpers (DRV-08/09/11) ──
  r.get('/driver/jobs-v3', need('driver'), (req, res) => {
    const today = ymd();
    const rows = q.all(`SELECT p.id, p.status, p.stage, p.seq, p.time_window, p.service_type, p.confirmation_status, p.is_revisit,
        p.started_at, p.arrived_at, p.completed_at, p.arrival_photo_url,
        c.name, c.branch, c.zone, c.address, c.lat, c.lng, c.access_notes, c.contact_phone, st.name service_name, st.category, st.checklist
      FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN service_types st ON st.code=p.service_type
      WHERE p.scheduled_date=? AND p.driver_id=? AND p.status!='rescheduled' ORDER BY p.seq`, today, req.user.id);
    res.json({ date: today, server_now: nowIso(), proof_radius_m: PROOF_RADIUS_M, jobs: rows.map(j => ({ ...j, checklist: J(j.checklist, []), maps_url: mapsDir(j.lat, j.lng) })) });
  });
}

// ── background jobs ──────────────────────────────────────────
function checkAttention(c) {
  const n = q.get(`SELECT COUNT(*) c FROM pickups WHERE customer_id=? AND status='canceled' AND confirmation_status IN ('confirmed','auto_confirmed') AND scheduled_date>=?`, c.id, addDays(ymd(), -30)).c;
  if (n === 3) alertCrm('ATTENTION', 'warning', `${c.name} (${c.branch || ''}) has 3 confirmed no-pickups in 30 days — see "Clients needing attention".`);
}
function autoConfirm() {
  const due = q.all(`SELECT p.*, c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.confirmation_status='awaiting' AND p.confirm_deadline < ?`, nowIso());
  for (const p of due) {
    q.run(`UPDATE pickups SET confirmation_status='auto_confirmed', billable=0 WHERE id=?`, p.id);
    q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES ('AUTO_CONFIRMED','info',?,?)`, `No response in 24 h — no-pickup auto-confirmed for ${p.name} (${p.branch || ''})`, p.id);
    checkAttention({ id: p.customer_id, name: p.name, branch: p.branch });
  }
  return due.length;
}
function atRiskCheck() {
  const today = ymd(), now = new Date();
  const hm = now.toTimeString().slice(0, 5);
  const rows = q.all(`SELECT p.id, p.time_window, p.driver_id, c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id
    WHERE p.scheduled_date=? AND p.status='pending' AND p.stage IS NULL AND COALESCE(p.at_risk_alerted,0)=0 AND p.time_window IS NOT NULL`, today);
  let n = 0;
  for (const r2 of rows) {
    const end = r2.time_window.slice(6, 11);
    const [eh, em] = end.split(':').map(Number), [nh, nm] = hm.split(':').map(Number);
    const mins = eh * 60 + em - (nh * 60 + nm);
    if (mins <= 30 && mins > -600) {
      q.run(`UPDATE pickups SET at_risk_alerted=1 WHERE id=?`, r2.id);
      alertCrm('AT_RISK', 'warning', `At risk of being late: ${r2.name} (${r2.branch || ''}) window ends ${end}, not started.`, r2.id);
      if (IO) IO.to('staff').emit('driver:at-risk', { pickup_id: r2.id, driver_id: r2.driver_id, window_end: end });
      if (push && r2.driver_id) push.sendPush('driver', r2.driver_id, 'Stop at risk', `${r2.name} window ends ${end}`, '/driver/').catch(() => {});
      n++;
    }
  }
  return n;
}
// Nightly plan generation in batches of 25 plans, each batch in one transaction,
// yielding to the event loop in between so the app stays responsive.
async function generatePlansBatched({ days = 14, batch = 25 } = {}) {
  const ids = q.all(`SELECT id FROM service_plans WHERE status='active' ORDER BY id`).map((r) => r.id);
  let created = 0, skipped = 0;
  for (let i = 0; i < ids.length; i += batch) {
    q.run('BEGIN');
    try {
      for (const id of ids.slice(i, i + batch)) { const g = generatePlans({ days, planId: id }); created += g.created || 0; skipped += g.skipped || 0; }
      q.run('COMMIT');
    } catch (e) { try { q.run('ROLLBACK'); } catch {} throw e; }
    await new Promise((r) => setImmediate(r));
  }
  return { created, skipped, plans: ids.length };
}

// Daily SQLite backup (VACUUM INTO) kept for BACKUP_DAYS days next to the database.
function dailyBackup() {
  const dbPath = process.env.DB_PATH;
  if (!dbPath || process.env.BACKUP_DISABLED === '1') return;
  const path = require('path'), fs = require('fs');
  const dir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `greenloop-${ymd()}.sqlite`);
    if (!fs.existsSync(file)) { q.run('VACUUM INTO ?', file); console.log('✔ Backup written', file); }
    const keep = Number(process.env.BACKUP_DAYS || 14);
    fs.readdirSync(dir).filter((f) => /^greenloop-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -keep)
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
  if (getSetting('v3_last_generate', '') !== today) {
    setSetting('v3_last_generate', today);
    try { const g = await generatePlansBatched({ days: 14 }); console.log(`✔ Recurrence engine: ${g.created} jobs generated for ${g.plans} plans, ${g.skipped} holiday skips`); }
    catch (e) { console.warn('generatePlans', e.message); setSetting('v3_last_generate', ''); }
  }
  if (getSetting('v3_last_backup', '') !== today) { setSetting('v3_last_backup', today); dailyBackup(); }
  // reminders go out at 17:00 UAE time (server clocks run on UTC)
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: process.env.APP_TZ || 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour >= 17 && getSetting('v3_last_reminder', '') !== today) {
    const tmr = addDays(today, 1);
    q.all(`SELECT DISTINCT p.customer_id, p.time_window, c.name FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.scheduled_date=? AND p.status='pending'`, tmr)
      .forEach(x => notifyCustomer(x.customer_id, 'reminder', 'Service tomorrow', `${x.name}: visit on ${tmr}${x.time_window ? ', window ' + x.time_window : ''}. Please keep access clear.`));
    setSetting('v3_last_reminder', today);
  }
}
function seedDemo() {
  if (!q.get(`SELECT id FROM leads LIMIT 1`) && process.env.SEED_DEMO !== '0') {
    // demo pipeline so dashboards aren't empty; TRUCK-02 doubles as pest-control unit
    q.run(`UPDATE vehicles SET service_tags='waste,pest' WHERE fleet_number='TRUCK-02'`);
    const L = (contact, company, phone, st, stage, src, sites, days) => q.run(
      `INSERT INTO leads(contact,company,phone,service_type,sites,frequency,source,stage,owner_id,follow_up_at,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,datetime('now',?))`,
      contact, company, phone, st, JSON.stringify(sites), 'weekly:3', src, stage, addDays(ymd(), 2) + 'T10:00:00.000Z', `-${days} days`);
    L('Omar Khalid', 'Spice Route Restaurant', '+971502223344', 'WASTE', 'new', 'website', [{ name: 'Karama', zone: 'Downtown', lat: 25.2425, lng: 55.3031, address: 'Karama St 12' }], 1);
    L('Fatima Noor', 'Cool Mart Group', '+971503334455', 'WASTE', 'contacted', 'referral', [{ name: 'Marina Walk', zone: 'Marina', lat: 25.0781, lng: 55.1391 }, { name: 'JBR', zone: 'Marina', lat: 25.0775, lng: 55.1332 }], 3);
    L('Arjun Mehta', 'Golden Fork Bakery', '+971504445566', 'PEST_GENERAL', 'lost', 'whatsapp', [{ name: 'Deira', zone: 'Deira', lat: 25.2711, lng: 55.3075 }], 12);
    const lid = Number(q.run(`INSERT INTO leads(contact,company,phone,email,service_type,sites,frequency,source,stage,owner_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,datetime('now','-2 days'))`,
      'Layla Hassan', 'Harbour Seafood', '+971505556677', 'layla@harbour.ae', 'WASTE', JSON.stringify([{ name: 'Al Mina', zone: 'Deira', lat: 25.2632, lng: 55.2912, address: 'Port Rashid Rd' }]), 'weekly:3', 'walk-in', 'quoted').lastInsertRowid);
    const calc = calcQuote([{ service_code: 'WASTE', description: 'Machari waste pickup', freq_unit: 'weekly', freq_count: 3, unit_price: 160 }, { service_code: 'PEST_GENERAL', description: 'Pest treatment', freq_unit: 'monthly', freq_count: 1, unit_price: 450 }]);
    q.run(`INSERT INTO quotations(lead_id,number,version,items,plan,subtotal,vat,total,valid_until,status,sent_via,sent_at,share_token,created_by,created_at) VALUES (?,?,1,?,?,?,?,?,?,'sent','whatsapp',datetime('now','-1 days'),?,1,datetime('now','-1 days'))`,
      lid, 'QT-' + new Date().getFullYear() + '-0001', JSON.stringify(calc.items),
      JSON.stringify({ recurrence: { type: 'weekly', days: [0, 2, 4] }, time_window: '06:00-10:00', billing: 'monthly' }),
      calc.subtotal, calc.vat, calc.total, addDays(ymd(), 28), crypto.randomBytes(12).toString('hex'));
  }
}
function start(io) {
  IO = io;
  try { seedDemo(); } catch (e) { console.warn('v3 demo seed', e.message); }
  const tick = () => {
    try { autoConfirm(); atRiskCheck(); } catch (e) { console.warn('v3 tick', e.message); }
    dailyJobs().catch((e) => console.warn('v3 daily', e.message));
  };
  tick();
  setInterval(tick, 60_000);
}

ensureSchema();

module.exports = {
  mountV3Routes, guard, start, validateProof, rejectProof, onPickupCompleted, onNotPickedUp, notifyCustomer, notifyVehicleDrivers, dmy,
  generatePlans, occursOn, describeRule, calcQuote, visitsPerMonth, frequencyLabel, parseFrequency, recurrenceForLine, haversineM, autoConfirm, atRiskCheck, allocate,
  alertCrm, flagLateProof, generatePlansBatched, dailyBackup, dailyJobs,
};
