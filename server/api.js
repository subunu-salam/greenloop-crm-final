// ─────────────────────────────────────────────────────────────
// REST API — /api/v1/*
// ─────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { q, getSetting, setSetting } = require('./db');
const scheduler = require('./services/scheduler');
const rescheduler = require('./services/rescheduler');
const sla = require('./services/sla');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `pickup_${req.params.id}_${Date.now()}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.full_name, vehicle_id: user.vehicle_id || null },
    SECRET, { expiresIn: '14h' });
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
    } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  };
}

module.exports = function buildApi(io) {
  const r = express.Router();

  // ── AUTH ────────────────────────────────────────────────────
  r.post('/auth/driver-login', (req, res) => {
    const { pin } = req.body || {};
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4 digits' });
    const drivers = q.all(`SELECT * FROM users WHERE role='driver' AND is_active=1`);
    const user = drivers.find(d => bcrypt.compareSync(String(pin), d.pin_hash));
    if (!user) return res.status(401).json({ error: 'Wrong PIN' });
    const vehicle = user.vehicle_id ? q.get(`SELECT * FROM vehicles WHERE id=?`, user.vehicle_id) : null;
    res.json({ token: sign(user), user: { id: user.id, name: user.full_name, vehicle } });
  });

  r.post('/auth/admin-login', (req, res) => {
    const { username, password } = req.body || {};
    const user = q.get(`SELECT * FROM users WHERE role='admin' AND username=? AND is_active=1`, String(username || ''));
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: sign(user), user: { id: user.id, name: user.full_name } });
  });

  // ── DRIVER APP ──────────────────────────────────────────────
  r.get('/driver/jobs', auth('driver'), (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const jobs = q.all(
      `SELECT p.id, p.status, p.stage, p.seq, p.anomaly_reason, p.completed_at,
              c.name, c.branch, c.zone, c.address, c.lat, c.lng
       FROM pickups p JOIN customers c ON c.id = p.customer_id
       WHERE p.scheduled_date = ? AND p.driver_id = ? AND p.status != 'rescheduled'
       ORDER BY p.seq`, today, req.user.id);
    res.json({ date: today, jobs });
  });

  // Driver acknowledges a pickup (progress step 1)
  r.post('/pickups/:id/ack', auth('driver'), (req, res) => {
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (!['pending', 'overdue'].includes(p.status)) return res.status(409).json({ error: `Already ${p.status}` });
    q.run(`UPDATE pickups SET stage='acknowledged', updated_at=datetime('now') WHERE id=?`, p.id);
    const info = q.get(`SELECT c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, p.id);
    io.emit('pickup:ack', { id: p.id, customer: info.name, branch: info.branch, driver: req.user.name });
    res.json({ ok: true, stage: 'acknowledged' });
  });

  // Driver history (past pickups)
  r.get('/driver/history', auth('driver'), (req, res) => {
    const rows = q.all(
      `SELECT p.id, p.scheduled_date, p.status, p.completed_at, p.photo_url, p.anomaly_reason,
              c.name, c.branch, c.zone
       FROM pickups p JOIN customers c ON c.id = p.customer_id
       WHERE p.driver_id = ? AND p.status IN ('collected','canceled','overdue')
       ORDER BY COALESCE(p.completed_at, p.scheduled_date) DESC LIMIT 100`, req.user.id);
    res.json(rows);
  });

  // Driver profile + performance stats
  r.get('/driver/me', auth('driver'), (req, res) => {
    const u = q.get(`SELECT id, full_name, phone, vehicle_id, created_at FROM users WHERE id=?`, req.user.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const vehicle = u.vehicle_id ? q.get(`SELECT * FROM vehicles WHERE id=?`, u.vehicle_id) : null;
    const month = new Date().toISOString().slice(0, 7);
    const stat = (cond, ...p2) => q.get(`SELECT COUNT(*) c FROM pickups WHERE driver_id=? AND ${cond}`, u.id, ...p2).c;
    res.json({
      id: u.id, name: u.full_name, phone: u.phone, since: u.created_at, vehicle,
      stats: {
        month_collected: stat(`status='collected' AND scheduled_date LIKE ?`, month + '%'),
        month_no_pickup: stat(`status='canceled' AND scheduled_date LIKE ?`, month + '%'),
        month_total: stat(`status IN ('collected','canceled','overdue') AND scheduled_date LIKE ?`, month + '%'),
        career_collected: stat(`status='collected'`),
      },
    });
  });

  r.post('/pickups/:id/complete', auth('driver'), upload.single('photo'), (req, res) => {
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (['collected', 'canceled', 'rescheduled'].includes(p.status))
      return res.status(409).json({ error: `Already ${p.status}` });
    if (!req.file) return res.status(400).json({ error: 'Verification photo is required' });
    const { lat, lng, client_ts } = req.body;
    const ts = new Date().toISOString();
    q.run(`UPDATE pickups SET stage='completed' WHERE id=?`, p.id);
    q.run(`UPDATE pickups SET status='collected', completed_at=?, photo_url=?, gps_lat=?, gps_lng=?,
           notes = COALESCE(notes,'') || CASE WHEN ? != '' THEN ' [device ts: ' || ? || ']' ELSE '' END,
           updated_at=datetime('now') WHERE id=?`,
      ts, `/uploads/${req.file.filename}`, Number(lat) || null, Number(lng) || null,
      client_ts || '', client_ts || '', p.id);
    const info = q.get(`SELECT c.name, c.branch, v.fleet_number FROM pickups p
      JOIN customers c ON c.id=p.customer_id LEFT JOIN vehicles v ON v.id=p.vehicle_id WHERE p.id=?`, p.id);
    io.emit('pickup:completed', { id: p.id, customer: info.name, branch: info.branch, vehicle: info.fleet_number, photo_url: `/uploads/${req.file.filename}`, at: ts, driver: req.user.name });
    res.json({ ok: true, status: 'collected', at: ts });
  });

  r.post('/pickups/:id/cancel', auth('driver'), (req, res) => {
    const REASONS = ['BIN_EMPTY', 'ACCESS_BLOCKED', 'MANAGER_REFUSED'];
    const { reason, lat, lng } = req.body || {};
    if (!REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason' });
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (['collected', 'canceled', 'rescheduled'].includes(p.status))
      return res.status(409).json({ error: `Already ${p.status}` });
    q.run(`UPDATE pickups SET status='canceled', anomaly_reason=?, gps_lat=?, gps_lng=?,
           completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
      reason, Number(lat) || null, Number(lng) || null, p.id);
    const info = q.get(`SELECT c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, p.id);
    const msg = `NO PICKUP: ${info.name} (${info.branch}) — ${reason.replace(/_/g, ' ')} (by ${req.user.name})`;
    q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES ('ANOMALY','warning',?,?)`, msg, p.id);
    io.emit('pickup:canceled', { id: p.id, customer: info.name, branch: info.branch, reason, driver: req.user.name });
    io.emit('alert', { type: 'ANOMALY', severity: 'warning', message: msg, pickup_id: p.id });
    res.json({ ok: true, status: 'canceled' });
  });

  // ── DASHBOARD ───────────────────────────────────────────────
  r.get('/dashboard', auth('admin'), (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const stat = s => q.get(`SELECT COUNT(*) c FROM pickups WHERE scheduled_date=? AND status=?`, today, s).c;
    res.json({
      date: today,
      today: {
        total: q.get(`SELECT COUNT(*) c FROM pickups WHERE scheduled_date=? AND status!='rescheduled'`, today).c,
        collected: stat('collected'), pending: stat('pending'),
        canceled: stat('canceled'), overdue: stat('overdue'),
      },
      month: {
        collected: q.get(`SELECT COUNT(*) c FROM pickups WHERE scheduled_date LIKE ? AND status='collected'`, month + '%').c,
        canceled: q.get(`SELECT COUNT(*) c FROM pickups WHERE scheduled_date LIKE ? AND status='canceled'`, month + '%').c,
        scheduled: q.get(`SELECT COUNT(*) c FROM pickups WHERE scheduled_date LIKE ? AND status!='rescheduled'`, month + '%').c,
      },
      customers: q.get(`SELECT COUNT(*) c FROM customers WHERE is_active=1`).c,
      vehicles: q.get(`SELECT COUNT(*) c FROM vehicles WHERE is_active=1`).c,
      unread_alerts: q.get(`SELECT COUNT(*) c FROM alerts WHERE is_read=0`).c,
      shift_cutoff: getSetting('shift_cutoff', '12:00'),
      recent: q.all(`SELECT p.id, p.status, p.completed_at, p.anomaly_reason, p.photo_url,
                     c.name, c.branch, v.fleet_number
                     FROM pickups p JOIN customers c ON c.id=p.customer_id
                     LEFT JOIN vehicles v ON v.id=p.vehicle_id
                     WHERE p.completed_at IS NOT NULL ORDER BY p.completed_at DESC LIMIT 12`),
    });
  });

  // ── STATS OVERVIEW (dashboard charts) ───────────────────────
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD → window aggregates + 180-day daily series
  r.get('/stats/overview', auth('admin'), (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || today, to = req.query.to || today;

    const totals = q.get(
      `SELECT COUNT(*) scheduled,
        SUM(status='collected') collected, SUM(status='canceled') canceled,
        SUM(status='overdue') overdue, SUM(status='pending') pending
       FROM pickups WHERE scheduled_date BETWEEN ? AND ? AND status != 'rescheduled'`, from, to);

    const seriesFrom = new Date(Date.now() - 179 * 864e5).toISOString().slice(0, 10);
    const series = q.all(
      `SELECT scheduled_date AS date,
        SUM(status='collected') collected, SUM(status='canceled') canceled,
        SUM(status='overdue') overdue, SUM(status='pending') pending, COUNT(*) total
       FROM pickups WHERE scheduled_date BETWEEN ? AND ? AND status != 'rescheduled'
       GROUP BY scheduled_date ORDER BY scheduled_date`, seriesFrom, today);

    const zones = q.all(
      `SELECT c.zone, SUM(p.status='collected') collected, SUM(p.status='canceled') canceled,
              SUM(p.status='pending') pending, COUNT(*) total
       FROM pickups p JOIN customers c ON c.id=p.customer_id
       WHERE p.scheduled_date BETWEEN ? AND ? AND p.status != 'rescheduled'
       GROUP BY c.zone ORDER BY total DESC`, from, to);

    const vehicles = q.all(
      `SELECT v.fleet_number, SUM(p.status='collected') collected, SUM(p.status='canceled') canceled,
              SUM(p.status='pending') pending, COUNT(*) total
       FROM pickups p JOIN vehicles v ON v.id=p.vehicle_id
       WHERE p.scheduled_date BETWEEN ? AND ? AND p.status != 'rescheduled'
       GROUP BY v.id ORDER BY v.fleet_number`, from, to);

    const top_cancels = q.all(
      `SELECT c.name, c.branch, c.zone, COUNT(*) cancels
       FROM pickups p JOIN customers c ON c.id=p.customer_id
       WHERE p.anomaly_reason IS NOT NULL AND p.scheduled_date BETWEEN ? AND ?
       GROUP BY c.id ORDER BY cancels DESC LIMIT 5`, from, to);

    res.json({ from, to, totals, series, zones, vehicles, top_cancels });
  });

  // ── CUSTOMERS CRUD ──────────────────────────────────────────
  r.get('/customers', auth('admin'), (req, res) => {
    res.json(q.all(`SELECT c.*,
      (SELECT COUNT(*) FROM pickups p WHERE p.customer_id=c.id AND p.status='collected'
        AND p.scheduled_date LIKE strftime('%Y-%m','now') || '%') AS collected_this_month
      FROM customers c ORDER BY c.zone, c.name`));
  });
  r.post('/customers', auth('admin'), (req, res) => {
    const { name, branch, zone, frequency, lat, lng, address, contact_phone } = req.body || {};
    if (!name || !zone || !lat || !lng) return res.status(400).json({ error: 'name, zone, lat, lng required' });
    if (![2, 3].includes(Number(frequency))) return res.status(400).json({ error: 'frequency must be 2 or 3' });
    const info = q.run(`INSERT INTO customers(name,branch,zone,frequency,lat,lng,address,contact_phone)
      VALUES (?,?,?,?,?,?,?,?)`, name, branch || '', zone, Number(frequency), Number(lat), Number(lng), address || '', contact_phone || '');
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  r.put('/customers/:id', auth('admin'), (req, res) => {
    const c = q.get(`SELECT * FROM customers WHERE id=?`, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const b = { ...c, ...req.body };
    q.run(`UPDATE customers SET name=?,branch=?,zone=?,frequency=?,lat=?,lng=?,address=?,contact_phone=?,is_active=? WHERE id=?`,
      b.name, b.branch, b.zone, Number(b.frequency), Number(b.lat), Number(b.lng), b.address, b.contact_phone, b.is_active ? 1 : 0, c.id);
    res.json({ ok: true });
  });

  // Bulk client import — CSV text in JSON body { csv: "..." }
  // Columns: name,branch,zone,frequency,lat,lng,address,contact_phone
  r.post('/customers/import', auth('admin'), (req, res) => {
    const csv = String(req.body?.csv || '');
    if (!csv.trim()) return res.status(400).json({ error: 'Empty CSV' });

    // minimal RFC-4180 parser (handles quoted fields and commas inside quotes)
    function parseCSV(text) {
      const rows = []; let row = [], cur = '', inQ = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQ) {
          if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') inQ = false;
          else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          row.push(cur); rows.push(row); row = []; cur = '';
        } else cur += ch;
      }
      if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
      return rows.filter(r2 => r2.some(c => c.trim() !== ''));
    }

    const rows = parseCSV(csv);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });
    const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const idx = f => header.indexOf(f);
    const required = ['name', 'zone', 'frequency', 'lat', 'lng'];
    const missing = required.filter(f => idx(f) === -1);
    if (missing.length) return res.status(400).json({ error: 'Missing columns: ' + missing.join(', ') });

    let imported = 0, skipped = 0;
    const errors = [];
    for (let i = 1; i < rows.length; i++) {
      const g = f => (idx(f) >= 0 ? String(rows[i][idx(f)] ?? '').trim() : '');
      const name = g('name'), branch = g('branch'), zone = g('zone');
      const frequency = Number(g('frequency')), lat = Number(g('lat')), lng = Number(g('lng'));
      if (!name || !zone) { errors.push(`Row ${i + 1}: name and zone are required`); continue; }
      if (![2, 3].includes(frequency)) { errors.push(`Row ${i + 1} (${name}): frequency must be 2 or 3`); continue; }
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        errors.push(`Row ${i + 1} (${name}): invalid lat/lng`); continue;
      }
      const dup = q.get(`SELECT id FROM customers WHERE name = ? AND COALESCE(branch,'') = ?`, name, branch);
      if (dup) { skipped++; continue; }
      q.run(`INSERT INTO customers(name,branch,zone,frequency,lat,lng,address,contact_phone) VALUES (?,?,?,?,?,?,?,?)`,
        name, branch, zone, frequency, lat, lng, g('address'), g('contact_phone'));
      imported++;
    }
    if (imported) q.run(`INSERT INTO alerts(type,severity,message) VALUES ('INFO','info',?)`,
      `Bulk import: ${imported} clients added${skipped ? `, ${skipped} duplicates skipped` : ''}`);
    res.json({ ok: true, imported, skipped, errors });
  });

  // ── USERS CRUD (create / edit credentials) ──────────────────
  r.get('/users', auth('admin'), (req, res) => {
    res.json(q.all(`SELECT u.id,u.full_name,u.role,u.username,u.phone,u.vehicle_id,u.is_active,u.created_at,
      v.fleet_number FROM users u LEFT JOIN vehicles v ON v.id=u.vehicle_id ORDER BY u.role, u.full_name`));
  });
  r.post('/users', auth('admin'), (req, res) => {
    const { full_name, role, pin, username, password, phone, vehicle_id } = req.body || {};
    if (!full_name || !['driver', 'admin'].includes(role)) return res.status(400).json({ error: 'full_name and valid role required' });
    if (role === 'driver' && !/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'Driver needs a 4-digit PIN' });
    if (role === 'admin' && (!username || !password)) return res.status(400).json({ error: 'Admin needs username + password' });
    if (role === 'driver') {
      const clash = q.all(`SELECT pin_hash FROM users WHERE role='driver' AND is_active=1`)
        .some(u => bcrypt.compareSync(String(pin), u.pin_hash));
      if (clash) return res.status(409).json({ error: 'PIN already in use — choose another' });
    }
    const info = q.run(`INSERT INTO users(full_name,role,username,password_hash,pin_hash,phone,vehicle_id) VALUES (?,?,?,?,?,?,?)`,
      full_name, role, username || null, password ? bcrypt.hashSync(password, 10) : null,
      pin ? bcrypt.hashSync(String(pin), 10) : null, phone || '', vehicle_id || null);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  r.put('/users/:id', auth('admin'), (req, res) => {
    const u = q.get(`SELECT * FROM users WHERE id=?`, req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const { full_name, phone, vehicle_id, is_active, pin, password } = req.body || {};
    q.run(`UPDATE users SET full_name=?, phone=?, vehicle_id=?, is_active=? WHERE id=?`,
      full_name ?? u.full_name, phone ?? u.phone,
      vehicle_id !== undefined ? vehicle_id : u.vehicle_id,
      is_active !== undefined ? (is_active ? 1 : 0) : u.is_active, u.id);
    if (pin && /^\d{4}$/.test(String(pin))) q.run(`UPDATE users SET pin_hash=? WHERE id=?`, bcrypt.hashSync(String(pin), 10), u.id);
    if (password) q.run(`UPDATE users SET password_hash=? WHERE id=?`, bcrypt.hashSync(password, 10), u.id);
    res.json({ ok: true });
  });

  // ── VEHICLES / FLEET ────────────────────────────────────────
  r.get('/vehicles', auth('admin'), (req, res) => res.json(q.all(`SELECT * FROM vehicles ORDER BY fleet_number`)));
  r.post('/vehicles', auth('admin'), (req, res) => {
    const { fleet_number, plate, max_daily_capacity, zone } = req.body || {};
    if (!fleet_number || !plate || !zone) return res.status(400).json({ error: 'fleet_number, plate, zone required' });
    const info = q.run(`INSERT INTO vehicles(fleet_number,plate,max_daily_capacity,zone) VALUES (?,?,?,?)`,
      fleet_number, plate, Number(max_daily_capacity) || 15, zone);
    q.run(`INSERT INTO alerts(type,severity,message) VALUES ('INFO','info',?)`,
      `New vehicle onboarded: ${fleet_number} (${zone}, capacity ${Number(max_daily_capacity) || 15}) — will be included in next route generation`);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  r.put('/vehicles/:id', auth('admin'), (req, res) => {
    const v = q.get(`SELECT * FROM vehicles WHERE id=?`, req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const b = { ...v, ...req.body };
    q.run(`UPDATE vehicles SET fleet_number=?,plate=?,max_daily_capacity=?,zone=?,is_active=? WHERE id=?`,
      b.fleet_number, b.plate, Number(b.max_daily_capacity), b.zone, b.is_active ? 1 : 0, v.id);
    res.json({ ok: true });
  });

  // Active Fleet Load Tracker — next N days utilisation per vehicle
  r.get('/fleet/load', auth('admin'), (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 31);
    const vehicles = q.all(`SELECT * FROM vehicles WHERE is_active=1`);
    const start = new Date();
    const out = vehicles.map(v => {
      const row = { vehicle: v, days: [] };
      for (let i = 0; i < days; i++) {
        const d = new Date(start); d.setDate(d.getDate() + i);
        const ds = d.toISOString().slice(0, 10);
        const c = q.get(`SELECT COUNT(*) c FROM pickups WHERE vehicle_id=? AND scheduled_date=? AND status IN ('pending','collected','overdue')`, v.id, ds).c;
        row.days.push({ date: ds, load: c, capacity: v.max_daily_capacity, pct: Math.round(100 * c / v.max_daily_capacity) });
      }
      return row;
    });
    res.json(out);
  });

  // ── DAILY ROUTE LEDGER MATRIX ───────────────────────────────
  r.get('/ledger', auth('admin'), (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const rows = q.all(
      `SELECT p.id, p.seq, p.status, p.completed_at, p.photo_url, p.anomaly_reason, p.gps_lat, p.gps_lng, p.notes,
              c.name, c.branch, c.zone, v.fleet_number, u.full_name AS driver
       FROM pickups p
       JOIN customers c ON c.id=p.customer_id
       LEFT JOIN vehicles v ON v.id=p.vehicle_id
       LEFT JOIN users u ON u.id=p.driver_id
       WHERE p.scheduled_date = ? ORDER BY v.fleet_number, p.seq`, date);
    res.json({ date, rows });
  });

  // ── SCHEDULE GENERATION ─────────────────────────────────────
  r.post('/schedule/generate', auth('admin'), (req, res) => {
    const now = new Date();
    const year = Number(req.body?.year) || now.getFullYear();
    const month = Number(req.body?.month) || now.getMonth() + 1;
    const result = scheduler.generateMonth(year, month, { force: !!req.body?.force });
    if (!result.skipped) {
      q.run(`INSERT INTO alerts(type,severity,message) VALUES ('INFO','info',?)`,
        `Monthly schedule generated for ${year}-${String(month).padStart(2, '0')}: ${result.created} pickups`);
      io.emit('ledger:refresh', {});
    }
    res.json(result);
  });

  // ── RESCHEDULING MODULE ─────────────────────────────────────
  r.get('/reschedule/pending', auth('admin'), (req, res) => {
    res.json(q.all(
      `SELECT p.id, p.scheduled_date, p.status, p.anomaly_reason, c.name, c.branch, c.zone, v.fleet_number
       FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN vehicles v ON v.id=p.vehicle_id
       WHERE p.status IN ('canceled','overdue')
         AND p.id NOT IN (SELECT pickup_id FROM alerts WHERE type='RESCHEDULED' AND pickup_id IS NOT NULL)
       ORDER BY p.scheduled_date DESC LIMIT 50`));
  });
  r.get('/reschedule/options/:pickupId', auth('admin'), (req, res) => {
    const out = rescheduler.recommend(Number(req.params.pickupId));
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });
  r.post('/reschedule/apply', auth('admin'), (req, res) => {
    const { pickup_id, date, vehicle_id } = req.body || {};
    const out = rescheduler.apply(Number(pickup_id), date, Number(vehicle_id));
    if (out.error) return res.status(409).json(out);
    io.emit('ledger:refresh', { date });
    io.emit('driver:queue-updated', { vehicle_id: Number(vehicle_id), date });
    res.json(out);
  });

  // ── REPORTS (JSON + CSV export) ─────────────────────────────
  function csvOut(res, name, rows) {
    if (!rows.length) return res.status(200).type('text/csv').attachment(name).send('');
    const cols = Object.keys(rows[0]);
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    res.type('text/csv').attachment(name).send(csv);
  }

  // Monthly compliance: did each customer get their mandatory visits?
  r.get('/reports/compliance', auth('admin'), (req, res) => {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const rows = q.all(
      `SELECT c.name, c.branch, c.zone, c.frequency AS required_visits,
        SUM(CASE WHEN p.status='collected' THEN 1 ELSE 0 END) AS collected,
        SUM(CASE WHEN p.status='pending' THEN 1 ELSE 0 END) AS still_pending,
        SUM(CASE WHEN p.status='canceled' THEN 1 ELSE 0 END) AS canceled,
        CASE WHEN SUM(CASE WHEN p.status='collected' THEN 1 ELSE 0 END) >= c.frequency THEN 'MET'
             WHEN SUM(CASE WHEN p.status IN ('collected','pending') THEN 1 ELSE 0 END) >= c.frequency THEN 'ON TRACK'
             ELSE 'AT RISK' END AS compliance
       FROM customers c
       LEFT JOIN pickups p ON p.customer_id=c.id AND p.scheduled_date LIKE ? AND p.status!='rescheduled'
       WHERE c.is_active=1 GROUP BY c.id ORDER BY compliance DESC, c.zone, c.name`, month + '%');
    if (req.query.format === 'csv') return csvOut(res, `compliance_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // Driver performance
  r.get('/reports/drivers', auth('admin'), (req, res) => {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const rows = q.all(
      `SELECT u.full_name AS driver, v.fleet_number,
        SUM(CASE WHEN p.status='collected' THEN 1 ELSE 0 END) AS collected,
        SUM(CASE WHEN p.status='canceled' THEN 1 ELSE 0 END) AS canceled,
        SUM(CASE WHEN p.status='overdue' THEN 1 ELSE 0 END) AS overdue,
        COUNT(p.id) AS total_assigned
       FROM users u LEFT JOIN pickups p ON p.driver_id=u.id AND p.scheduled_date LIKE ? AND p.status!='rescheduled'
       LEFT JOIN vehicles v ON v.id=u.vehicle_id
       WHERE u.role='driver' GROUP BY u.id ORDER BY collected DESC`, month + '%');
    if (req.query.format === 'csv') return csvOut(res, `drivers_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // Anomaly breakdown
  r.get('/reports/anomalies', auth('admin'), (req, res) => {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const rows = q.all(
      `SELECT p.anomaly_reason AS reason, COUNT(*) AS count,
        GROUP_CONCAT(DISTINCT c.zone) AS zones
       FROM pickups p JOIN customers c ON c.id=p.customer_id
       WHERE p.anomaly_reason IS NOT NULL AND p.scheduled_date LIKE ?
       GROUP BY p.anomaly_reason ORDER BY count DESC`, month + '%');
    if (req.query.format === 'csv') return csvOut(res, `anomalies_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // Full ledger export
  r.get('/reports/ledger', auth('admin'), (req, res) => {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const rows = q.all(
      `SELECT p.id, p.scheduled_date, c.name AS customer, c.branch, c.zone, v.fleet_number AS vehicle,
              u.full_name AS driver, p.status, p.completed_at, p.anomaly_reason, p.gps_lat, p.gps_lng, p.photo_url
       FROM pickups p JOIN customers c ON c.id=p.customer_id
       LEFT JOIN vehicles v ON v.id=p.vehicle_id LEFT JOIN users u ON u.id=p.driver_id
       WHERE p.scheduled_date LIKE ? ORDER BY p.scheduled_date, v.fleet_number, p.seq`, month + '%');
    if (req.query.format === 'csv') return csvOut(res, `ledger_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // ── ALERTS ──────────────────────────────────────────────────
  r.get('/alerts', auth('admin'), (req, res) => {
    res.json(q.all(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`));
  });
  r.post('/alerts/read-all', auth('admin'), (req, res) => {
    q.run(`UPDATE alerts SET is_read=1 WHERE is_read=0`);
    res.json({ ok: true });
  });

  // ── SETTINGS ────────────────────────────────────────────────
  r.get('/settings', auth('admin'), (req, res) => {
    res.json({ shift_cutoff: getSetting('shift_cutoff', '12:00'), company_name: getSetting('company_name', '') });
  });
  r.put('/settings', auth('admin'), (req, res) => {
    if (req.body?.shift_cutoff) setSetting('shift_cutoff', req.body.shift_cutoff);
    if (req.body?.company_name) setSetting('company_name', req.body.company_name);
    res.json({ ok: true });
  });
  r.post('/sla/check-now', auth('admin'), (req, res) => res.json(sla.checkNow(io)));

  return r;
};

// --- AUTOMATED PATCH: ENTERPRISE STATE-MACHINE AND NOTIFICATION ENGINES ---
const handleManualPickupInjection = (req, res) => {
    try {
        const { clientName, branch, zone, driverName, date } = req.body;
        const dbHandle = typeof db !== 'undefined' ? db : (typeof database !== 'undefined' ? database : null);
        if (!dbHandle) return res.status(500).json({ success: false, error: "Active database handle instance not located." });

        const columnsInfo = dbHandle.prepare("PRAGMA table_info(pickups)").all();
        const existingColumns = columnsInfo.map(c => c.name);
        const record = {};
        
        if (existingColumns.includes('client_name')) record.client_name = clientName;
        if (existingColumns.includes('client')) record.client = clientName;
        if (existingColumns.includes('branch')) record.branch = branch;
        if (existingColumns.includes('zone')) record.zone = zone;
        if (existingColumns.includes('driver_name')) record.driver_name = driverName;
        if (existingColumns.includes('driver')) record.driver = driverName;
        if (existingColumns.includes('status')) record.status = 'PENDING';
        if (existingColumns.includes('date')) record.date = date;
        
        const truckId = driverName.includes('Ali') ? 'TRUCK-01' : 'TRUCK-02';
        if (existingColumns.includes('vehicle')) record.vehicle = truckId;
        if (existingColumns.includes('truck')) record.truck = truckId;
        if (existingColumns.includes('truck_id')) record.truck_id = truckId;
        
        const keys = Object.keys(record);
        const placeholders = keys.map(() => '?').join(', ');
        const insertQuery = `INSERT INTO pickups (${keys.join(', ')}) VALUES (${placeholders})`;
        dbHandle.prepare(insertQuery).run(...Object.values(record));
        
        try {
            dbHandle.prepare(`INSERT INTO notifications (driver_name, title, message, created_at, read) VALUES (?, 'Emergency Stop Assigned', ?, ?, 0)`).run(driverName, `New ad-hoc pickup registered for ${clientName} (${branch}).`, new Date().toISOString());
        } catch(e) {}
        if (typeof io !== 'undefined') {
            io.emit('pickup_updated');
            io.emit('route_changed', { driver_name: driverName });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};

router.post('/pickups/manual', handleManualPickupInjection);
router.post('/api/v1/pickups/manual', handleManualPickupInjection);

router.post('/pickups/:id/step', (req, res) => {
    try {
        const { id } = req.params;
        const { status, timestamp } = req.body;
        const dbHandle = typeof db !== 'undefined' ? db : (typeof database !== 'undefined' ? database : null);
        let tsColumn = 'completed_at';
        if (status === 'ACCEPTED') tsColumn = 'accepted_at';
        if (status === 'IN_PROGRESS') tsColumn = 'progress_at';
        if (status === 'PHOTO_UPLOADED') tsColumn = 'photo_at';
        dbHandle.prepare(`UPDATE pickups SET status = ?, ${tsColumn} = ? WHERE id = ?`).run(status, timestamp, id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

router.put('/pickups/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { client_name, zone, driver_name, date, status } = req.body;
        const dbHandle = typeof db !== 'undefined' ? db : (typeof database !== 'undefined' ? database : null);
        dbHandle.prepare(`UPDATE pickups SET client_name = ?, zone = ?, driver_name = ?, date = ?, status = ? WHERE id = ?`).run(client_name, zone, driver_name, date, status, id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});
module.exports = router;