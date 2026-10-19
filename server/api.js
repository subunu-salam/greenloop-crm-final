// ─────────────────────────────────────────────────────────────
// REST API — /api/v1/*
// ─────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { prisma, getSetting, setSetting, join, pick, groupBy, statusCounts, findById, toId, num, int, str, sortBy, desc, now: sqlNow, isUniqueError } = require('./db');
const scheduler = require('./services/scheduler');
const rescheduler = require('./services/rescheduler');
const sla = require('./services/sla');
const v3 = require('./v3');
const security = require('./security');
const capacity = require('./capacity');
const contacts = require('./contacts');
const shifts = require('./driver-shift');   // also adds the job-timing columns used below

require('./security').ensureSecret();
const SECRET = process.env.JWT_SECRET;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // random name + extension from the real file type (never the phone's file name)
    filename: security.safeImageName('pickup'),
  }),
  fileFilter: security.imageFileFilter,
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, crm_role: user.role === 'admin' ? (user.crm_role || 'owner') : undefined, name: user.full_name, vehicle_id: user.vehicle_id || null },
    SECRET, { expiresIn: '14h' });
}
const { driverJobError } = security;

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
  const ACTIVE_LOAD = ['pending', 'collected', 'overdue'];
  // customer name + branch for one pickup (used in live events and alerts)
  const customerOf = (p) => prisma.customer.findUnique({ where: { id: p.customer_id }, select: { name: true, branch: true } });

  // ── AUTH ────────────────────────────────────────────────────
  r.post('/auth/driver-login', async (req, res) => {
    const { pin } = req.body || {};
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4 digits' });
    const drivers = await prisma.user.findMany({ where: { role: 'driver', is_active: 1 }, orderBy: { id: 'asc' } });
    const user = drivers.find(d => d.pin_hash && bcrypt.compareSync(String(pin), d.pin_hash));
    if (!user) return res.status(401).json({ error: 'Wrong PIN' });
    const vehicle = user.vehicle_id ? await prisma.vehicle.findUnique({ where: { id: user.vehicle_id } }) : null;
    res.json({ token: sign(user), user: { id: user.id, name: user.full_name, vehicle } });
  });

  r.post('/auth/admin-login', async (req, res) => {
    const { username, password } = req.body || {};
    const user = await prisma.user.findFirst({ where: { role: 'admin', username: String(username || ''), is_active: 1 } });
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: sign(user), user: { id: user.id, name: user.full_name, crm_role: user.crm_role || 'owner' } });
  });

  // ── DRIVER APP ──────────────────────────────────────────────
  r.get('/driver/jobs', auth('driver'), async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await prisma.pickup.findMany({
      where: { scheduled_date: today, driver_id: req.user.id, status: { not: 'rescheduled' } },
      select: { id: true, status: true, stage: true, seq: true, anomaly_reason: true, completed_at: true, customer_id: true },
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    });
    const jobs = (await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone', 'address', 'lat', 'lng'], { inner: true }))
      .map(({ customer_id, ...j }) => j);
    res.json({ date: today, jobs });
  });

  // Driver acknowledges a pickup (progress step 1)
  r.post('/pickups/:id/ack', auth('driver'), async (req, res) => {
    const p = await findById('pickup', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const denied = driverJobError(p, req.user);
    if (denied) return res.status(denied[0]).json({ error: denied[1] });
    if (!['pending', 'overdue'].includes(p.status)) return res.status(409).json({ error: `Already ${p.status}` });
    await prisma.pickup.update({ where: { id: p.id }, data: { stage: 'acknowledged', updated_at: sqlNow() } });
    await shifts.onJobStarted(p, req.user);   // job timer starts; opens a shift if the driver forgot to clock in
    const info = await customerOf(p);
    io.to('staff').emit('pickup:ack', { id: p.id, customer: info.name, branch: info.branch, driver: req.user.name });
    try { await v3.notifyCustomer(p.customer_id, 'on_way', 'Driver on the way', `${req.user.name} has started your visit at ${info.name} ${info.branch || ''}`); } catch {}
    res.json({ ok: true, stage: 'acknowledged' });
  });

  // Driver history (past pickups)
  r.get('/driver/history', auth('driver'), async (req, res) => {
    let rows = await prisma.pickup.findMany({
      where: { driver_id: req.user.id, status: { in: ['collected', 'canceled', 'overdue'] } },
      select: { id: true, scheduled_date: true, status: true, completed_at: true, photo_url: true, anomaly_reason: true, customer_id: true },
    });
    // ORDER BY COALESCE(completed_at, scheduled_date) DESC LIMIT 100
    rows = sortBy(rows, desc(p => p.completed_at ?? p.scheduled_date)).slice(0, 100);
    rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true });
    res.json(rows.map(({ customer_id, ...x }) => x));
  });

  // Driver profile + performance stats
  r.get('/driver/me', auth('driver'), async (req, res) => {
    const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, full_name: true, phone: true, vehicle_id: true, created_at: true } });
    if (!u) return res.status(404).json({ error: 'Not found' });
    const vehicle = u.vehicle_id ? await prisma.vehicle.findUnique({ where: { id: u.vehicle_id } }) : null;
    const month = new Date().toISOString().slice(0, 7);
    const inMonth = { startsWith: month };               // SQL: scheduled_date LIKE '2026-10%'
    const stat = (where) => prisma.pickup.count({ where: { driver_id: u.id, ...where } });
    res.json({
      id: u.id, name: u.full_name, phone: u.phone, since: u.created_at, vehicle,
      stats: {
        month_collected: await stat({ status: 'collected', scheduled_date: inMonth }),
        month_no_pickup: await stat({ status: 'canceled', scheduled_date: inMonth }),
        month_total: await stat({ status: { in: ['collected', 'canceled', 'overdue'] }, scheduled_date: inMonth }),
        career_collected: await stat({ status: 'collected' }),
      },
    });
  });

  // DRV-06/07: live-camera proof only; server validates GPS distance, device clock and on-device stamp
  r.post('/pickups/:id/complete', auth('driver'), upload.single('photo'), async (req, res) => {
    const p = await findById('pickup', req.params.id);
    const drop = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
    if (!p) { drop(); return res.status(404).json({ error: 'Not found' }); }
    const denied = driverJobError(p, req.user);
    if (denied) { drop(); return res.status(denied[0]).json({ error: denied[1] }); }
    if (['collected', 'canceled', 'rescheduled'].includes(p.status)) { drop(); return res.status(409).json({ error: `Already ${p.status}` }); }
    if (!req.file) return res.status(400).json({ error: 'Verification photo is required' });
    const check = await v3.validateProof(p, req.body || {});
    if (!check.ok) {
      await v3.rejectProof(p, check, req.user.name, 'complete');
      await prisma.pickup.update({ where: { id: p.id }, data: { photo_url: `/uploads/${req.file.filename}` } }); // keep for ops review
      return res.status(422).json({ error: 'Photo rejected', problems: check.problems, rejected: true });
    }
    await v3.flagLateProof(p, check, req.user.name);
    const checklist = (() => { try { return JSON.parse(req.body.checklist || '[]'); } catch { return []; } })();
    const ts = new Date().toISOString();
    await prisma.pickup.update({
      where: { id: p.id },
      data: {
        status: 'collected', stage: 'completed', completed_at: ts, photo_url: `/uploads/${req.file.filename}`,
        gps_lat: num(req.body.lat), gps_lng: num(req.body.lng), photo_taken_at: str(req.body.photo_taken_at || null),
        proof_meta: JSON.stringify(check.meta), checklist: JSON.stringify(checklist), updated_at: sqlNow(),
      },
    });
    const info = await customerOf(p);
    const veh = p.vehicle_id ? await prisma.vehicle.findUnique({ where: { id: p.vehicle_id }, select: { fleet_number: true } }) : null;
    io.to('staff').emit('pickup:completed', { id: p.id, customer: info.name, branch: info.branch, vehicle: veh ? veh.fleet_number : null, photo_url: `/uploads/${req.file.filename}`, at: ts, driver: req.user.name });
    io.to('customer:' + p.customer_id).emit('pickup:completed', { id: p.id });
    try { await v3.onPickupCompleted(p.id); } catch (e) { console.warn('onPickupCompleted', e.message); }
    res.json({ ok: true, status: 'collected', at: ts, distance_m: check.distance_m });
  });

  // "Not picked up": reason + live GPS photo → Awaiting customer confirmation (PRD §7)
  const NPU_REASONS = ['CLOSED', 'NO_ACCESS', 'NO_WASTE', 'CUSTOMER_REFUSED', 'BIN_EMPTY', 'ACCESS_BLOCKED', 'MANAGER_REFUSED'];
  r.post('/pickups/:id/cancel', auth('driver'), upload.single('photo'), async (req, res) => {
    const drop = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
    const { reason } = req.body || {};
    if (!NPU_REASONS.includes(reason)) { drop(); return res.status(400).json({ error: 'Invalid reason' }); }
    const p = await findById('pickup', req.params.id);
    if (!p) { drop(); return res.status(404).json({ error: 'Not found' }); }
    const denied = driverJobError(p, req.user);
    if (denied) { drop(); return res.status(denied[0]).json({ error: denied[1] }); }
    if (['collected', 'canceled', 'rescheduled'].includes(p.status)) { drop(); return res.status(409).json({ error: `Already ${p.status}` }); }
    if (!req.file) return res.status(400).json({ error: 'A live photo of the site is required' });
    const check = await v3.validateProof(p, req.body || {});
    if (!check.ok) {
      await v3.rejectProof(p, check, req.user.name, 'not_picked_up');
      drop();
      return res.status(422).json({ error: 'Photo rejected', problems: check.problems, rejected: true });
    }
    await v3.flagLateProof(p, check, req.user.name);
    const stamp = sqlNow();
    await prisma.pickup.update({
      where: { id: p.id },
      data: {
        status: 'canceled', anomaly_reason: reason, gps_lat: num(req.body.lat), gps_lng: num(req.body.lng),
        photo_url: `/uploads/${req.file.filename}`, photo_taken_at: str(req.body.photo_taken_at || null),
        proof_meta: JSON.stringify(check.meta), completed_at: stamp, updated_at: stamp,
      },
    });
    await v3.onNotPickedUp(p.id);
    const info = await customerOf(p);
    const msg = `NOT PICKED UP: ${info.name} (${info.branch}) — ${reason.replace(/_/g, ' ')} (by ${req.user.name}) · awaiting customer confirmation`;
    await prisma.alert.create({ data: { type: 'ANOMALY', severity: 'warning', message: msg, pickup_id: p.id } });
    io.to('staff').emit('pickup:canceled', { id: p.id, customer: info.name, branch: info.branch, reason, driver: req.user.name });
    io.to('staff').emit('alert', { type: 'ANOMALY', severity: 'warning', message: msg, pickup_id: p.id });
    res.json({ ok: true, status: 'canceled', confirmation_status: 'awaiting' });
  });

  // ── DASHBOARD ───────────────────────────────────────────────
  r.get('/dashboard', auth('admin'), async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const count = (where) => prisma.pickup.count({ where });
    let recent = await prisma.pickup.findMany({
      where: { completed_at: { not: null } },
      select: { id: true, status: true, completed_at: true, anomaly_reason: true, photo_url: true, customer_id: true, vehicle_id: true },
      orderBy: [{ completed_at: 'desc' }, { id: 'desc' }], take: 12,
    });
    recent = await join(recent, 'customer_id', 'customer', ['name', 'branch'], { inner: true });
    recent = await join(recent, 'vehicle_id', 'vehicle', ['fleet_number']);
    res.json({
      date: today,
      today: {
        total: await count({ scheduled_date: today, status: { not: 'rescheduled' } }),
        collected: await count({ scheduled_date: today, status: 'collected' }),
        pending: await count({ scheduled_date: today, status: 'pending' }),
        canceled: await count({ scheduled_date: today, status: 'canceled' }),
        overdue: await count({ scheduled_date: today, status: 'overdue' }),
      },
      month: {
        collected: await count({ scheduled_date: { startsWith: month }, status: 'collected' }),
        canceled: await count({ scheduled_date: { startsWith: month }, status: 'canceled' }),
        scheduled: await count({ scheduled_date: { startsWith: month }, status: { not: 'rescheduled' } }),
      },
      customers: await prisma.customer.count({ where: { is_active: 1 } }),
      vehicles: await prisma.vehicle.count({ where: { is_active: 1 } }),
      unread_alerts: await prisma.alert.count({ where: { is_read: 0 } }),
      shift_cutoff: await getSetting('shift_cutoff', '12:00'),
      recent: recent.map(x => pick(x, ['id', 'status', 'completed_at', 'anomaly_reason', 'photo_url', 'name', 'branch', 'fleet_number'])),
    });
  });

  // ── STATS OVERVIEW (dashboard charts) ───────────────────────
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD → window aggregates + 180-day daily series
  r.get('/stats/overview', auth('admin'), async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const from = String(req.query.from || today), to = String(req.query.to || today);
    // groupBy lets MongoDB do the counting: one small row per (key, status) instead of every pickup
    const counted = (rows, key) => {
      const out = new Map();
      for (const g of rows) {
        const k = g[key];
        if (!out.has(k)) out.set(k, { collected: 0, canceled: 0, overdue: 0, pending: 0, total: 0 });
        const o = out.get(k);
        if (g.status in o) o[g.status] += g._count._all;
        o.total += g._count._all;
      }
      return out;
    };
    const inWindow = { scheduled_date: { gte: from, lte: to }, status: { not: 'rescheduled' } };
    const byStatus = await prisma.pickup.groupBy({ by: ['status'], where: inWindow, _count: { _all: true } });
    const t = counted(byStatus.map(g => ({ ...g, all: 'all' })), 'all').get('all');
    // SQL SUM() over zero rows is NULL, COUNT is 0 — kept so the charts behave exactly as before
    const totals = t ? { scheduled: t.total, collected: t.collected, canceled: t.canceled, overdue: t.overdue, pending: t.pending }
      : { scheduled: 0, collected: null, canceled: null, overdue: null, pending: null };

    const seriesFrom = new Date(Date.now() - 179 * 864e5).toISOString().slice(0, 10);
    const perDay = await prisma.pickup.groupBy({
      by: ['scheduled_date', 'status'], where: { scheduled_date: { gte: seriesFrom, lte: today }, status: { not: 'rescheduled' } }, _count: { _all: true },
    });
    const series = [...counted(perDay, 'scheduled_date')].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, c]) => ({ date, ...c }));

    // per zone: count per customer in MongoDB, then add the customers of each zone together
    const perCustomer = await prisma.pickup.groupBy({ by: ['customer_id', 'status'], where: inWindow, _count: { _all: true } });
    const custZone = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(perCustomer.map(g => g.customer_id))] } }, select: { id: true, zone: true } })).map(c => [c.id, c.zone]));
    const zones = [...counted(perCustomer.filter(g => custZone.has(g.customer_id)).map(g => ({ ...g, zone: custZone.get(g.customer_id) })), 'zone')]
      .map(([zone, c]) => ({ zone, collected: c.collected, canceled: c.canceled, pending: c.pending, total: c.total }))
      .sort((a, b) => b.total - a.total);

    const perVehicle = await prisma.pickup.groupBy({ by: ['vehicle_id', 'status'], where: { ...inWindow, vehicle_id: { not: null } }, _count: { _all: true } });
    const fleet = new Map((await prisma.vehicle.findMany({ select: { id: true, fleet_number: true } })).map(v => [v.id, v.fleet_number]));
    const vehicles = sortBy([...counted(perVehicle.filter(g => fleet.has(g.vehicle_id)), 'vehicle_id')]
      .map(([vid, c]) => ({ fleet_number: fleet.get(vid), collected: c.collected, canceled: c.canceled, pending: c.pending, total: c.total })), v => v.fleet_number);

    // (this one counts rescheduled stops too, as the SQL did)
    const cancels = await prisma.pickup.groupBy({ by: ['customer_id'], where: { anomaly_reason: { not: null }, scheduled_date: { gte: from, lte: to } }, _count: { _all: true } });
    const top_cancels = (await join(cancels.map(g => ({ customer_id: g.customer_id, cancels: g._count._all })), 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true }))
      .sort((a, b) => b.cancels - a.cancels).slice(0, 5)
      .map(x => ({ name: x.name, branch: x.branch, zone: x.zone, cancels: x.cancels }));

    res.json({ from, to, totals, series, zones, vehicles, top_cancels });
  });

  // ── CUSTOMERS CRUD ──────────────────────────────────────────
  r.get('/customers', auth('admin'), async (req, res) => {
    const month = new Date().toISOString().slice(0, 7);
    const customers = await prisma.customer.findMany({ orderBy: [{ zone: 'asc' }, { name: 'asc' }, { id: 'asc' }] });
    // one groupBy instead of a sub-query per customer
    const done = await prisma.pickup.groupBy({
      by: ['customer_id'], where: { status: 'collected', scheduled_date: { startsWith: month } }, _count: { _all: true },
    });
    const n = new Map(done.map(g => [g.customer_id, g._count._all]));
    res.json(customers.map(c => ({ ...c, collected_this_month: n.get(c.id) || 0 })));
  });
  // Mobile + email identify a customer account. One format, validated, and never shared
  // with another account (sites of the SAME account share them).
  //   → { phone, email, link } or { status, body }
  async function customerContacts(body, existing = null) {
    const out = { phone: existing ? existing.contact_phone || '' : '', email: existing ? existing.email || '' : '', link: null };
    if (body.contact_phone !== undefined && String(body.contact_phone || '') !== (existing ? existing.contact_phone || '' : '\u0000')) {
      if (!String(body.contact_phone || '').trim()) out.phone = '';
      else { const p = contacts.parsePhone(body.contact_phone); if (!p.ok) return { status: 400, body: { error: p.error, field: 'contact_phone' } }; out.phone = p.e164; }
    }
    if (body.email !== undefined && String(body.email || '') !== (existing ? existing.email || '' : '\u0000')) {
      if (!String(body.email || '').trim()) out.email = '';
      else { const e = contacts.parseEmail(body.email); if (!e.ok) return { status: 400, body: { error: e.error, field: 'email' } }; out.email = e.email; }
    }
    const changed = !existing || out.phone !== (existing.contact_phone || '') || out.email !== (existing.email || '');
    if (changed && (out.phone || out.email)) {
      const own = existing ? (existing.account_id || existing.id) : null;
      const dup = await contacts.findDuplicate({ phone: out.phone, email: out.email }, { exceptAccountId: own });
      if (dup) {
        // a new site for an existing customer is fine once the office says so
        if (!existing && dup.type === 'customer' && Number(body.link_account_id) === Number(dup.id)) out.link = dup.id;
        else return { status: 409, body: { error: contacts.duplicateMessage(dup), code: 'DUPLICATE', duplicate: dup, can_link: !existing && dup.type === 'customer' } };
      }
    }
    return out;
  }
  // the first site of an account becomes the account holder once a second site joins
  const linkAccount = (id) => prisma.customer.updateMany({ where: { id, account_id: null }, data: { account_id: id } });

  r.post('/customers', auth('admin'), async (req, res) => {
    const { name, branch, zone, frequency, lat, lng, address } = req.body || {};
    if (!name || !zone || !lat || !lng) return res.status(400).json({ error: 'name, zone, lat, lng required' });
    if (![2, 3].includes(Number(frequency))) return res.status(400).json({ error: 'frequency must be 2 or 3' });
    if (String(name).length > 160 || String(branch || '').length > 160) return res.status(400).json({ error: 'Name or branch is too long (max 160 characters)' });
    if (!(Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180)) return res.status(400).json({ error: 'Location (lat/lng) is out of range' });
    const ct = await customerContacts(req.body || {}); if (ct.status) return res.status(ct.status).json(ct.body);
    const created = await prisma.customer.create({
      data: {
        name: String(name), branch: String(branch || ''), zone: String(zone), frequency: Number(frequency), lat: Number(lat), lng: Number(lng),
        address: String(address || ''), contact_phone: ct.phone, email: ct.email, account_id: ct.link,
      },
    });
    if (ct.link) await linkAccount(ct.link);
    res.json({ ok: true, id: created.id, linked_account: ct.link });
  });
  r.put('/customers/:id', auth('admin'), async (req, res) => {
    const c = await findById('customer', req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const b = { ...c, ...req.body };
    if (!b.name || String(b.name).length > 160) return res.status(400).json({ error: 'Name is required (max 160 characters)' });
    if (!(Math.abs(Number(b.lat)) <= 90 && Math.abs(Number(b.lng)) <= 180)) return res.status(400).json({ error: 'Location (lat/lng) is out of range' });
    const ct = await customerContacts(req.body || {}, c); if (ct.status) return res.status(ct.status).json(ct.body);
    await prisma.customer.update({
      where: { id: c.id },
      data: {
        name: String(b.name), branch: str(b.branch), zone: String(b.zone ?? c.zone), frequency: int(b.frequency, c.frequency),
        lat: Number(b.lat), lng: Number(b.lng), address: str(b.address), contact_phone: ct.phone, email: ct.email, is_active: b.is_active ? 1 : 0,
      },
    });
    res.json({ ok: true });
  });

  // Bulk client import — CSV text in JSON body { csv: "..." }
  // Columns: name,branch,zone,frequency,lat,lng,address,contact_phone
  r.post('/customers/import', auth('admin'), async (req, res) => {
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
      // SQL: COALESCE(branch,'') = ?  → an empty branch also matches a missing one
      const dup = await prisma.customer.findFirst({
        where: { name, OR: branch ? [{ branch }] : [{ branch: '' }, { branch: null }] }, select: { id: true },
      });
      if (dup) { skipped++; continue; }
      // same contact rules as the form: valid format, and not already used by another customer or lead
      let phone = '', email = '', link = null;
      if (g('contact_phone')) { const ph = contacts.parsePhone(g('contact_phone')); if (!ph.ok) { errors.push(`Row ${i + 1} (${name}): ${ph.error}`); continue; } phone = ph.e164; }
      if (g('email')) { const em = contacts.parseEmail(g('email')); if (!em.ok) { errors.push(`Row ${i + 1} (${name}): ${em.error}`); continue; } email = em.email; }
      const taken = (phone || email) ? await contacts.findDuplicate({ phone, email }) : null;
      if (taken) {
        // another branch of the same business joins that customer's account; anything else is a duplicate
        const owner = taken.type === 'customer' ? await prisma.customer.findUnique({ where: { id: taken.id }, select: { id: true, name: true } }) : null;
        if (owner && owner.name.trim().toLowerCase() === name.toLowerCase()) link = owner.id;
        else { errors.push(`Row ${i + 1} (${name}): ${contacts.duplicateMessage(taken)}`); continue; }
      }
      await prisma.customer.create({ data: { name, branch, zone, frequency, lat, lng, address: g('address'), contact_phone: phone, email, account_id: link } });
      if (link) await linkAccount(link);
      imported++;
    }
    if (imported) await prisma.alert.create({ data: { type: 'INFO', severity: 'info',
      message: `Bulk import: ${imported} clients added${skipped ? `, ${skipped} duplicates skipped` : ''}` } });
    res.json({ ok: true, imported, skipped, errors });
  });

  // ── USERS CRUD (create / edit credentials) ──────────────────
  r.get('/users', auth('admin'), async (req, res) => {
    const users = await prisma.user.findMany({
      select: { id: true, full_name: true, role: true, crm_role: true, username: true, phone: true, vehicle_id: true, is_active: true, created_at: true },
      orderBy: [{ role: 'asc' }, { full_name: 'asc' }, { id: 'asc' }],
    });
    res.json(await join(users, 'vehicle_id', 'vehicle', ['fleet_number']));
  });
  r.post('/users', auth('admin'), async (req, res) => {
    let { full_name, role, pin, username, password, phone, vehicle_id } = req.body || {};
    const crmRole = role === 'ops' ? 'ops' : 'owner';
    if (role === 'ops') role = 'admin';
    if (!full_name || !['driver', 'admin'].includes(role)) return res.status(400).json({ error: 'full_name and valid role required' });
    if (role === 'driver' && !/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'Driver needs a 4-digit PIN' });
    if (role === 'admin' && (!username || !password)) return res.status(400).json({ error: 'Admin needs username + password' });
    if (role === 'driver') {
      const clash = (await prisma.user.findMany({ where: { role: 'driver', is_active: 1 }, select: { pin_hash: true } }))
        .some(u => u.pin_hash && bcrypt.compareSync(String(pin), u.pin_hash));
      if (clash) return res.status(409).json({ error: 'PIN already in use — choose another' });
    }
    if (role === 'admin' && await prisma.user.findFirst({ where: { username: String(username) }, select: { id: true } })) return res.status(409).json({ error: 'Username taken' });
    if (phone) { const ph = contacts.parsePhone(phone); if (!ph.ok) return res.status(400).json({ error: ph.error, field: 'phone' }); phone = ph.e164; }
    try {
      const u = await prisma.user.create({
        data: {
          full_name: String(full_name), role, crm_role: role === 'admin' ? crmRole : null, username: username ? String(username) : null,
          password_hash: password ? bcrypt.hashSync(String(password), 10) : null, pin_hash: pin ? bcrypt.hashSync(String(pin), 10) : null,
          phone: phone || '', vehicle_id: toId(vehicle_id),
        },
      });
      res.json({ ok: true, id: u.id });
    } catch (e) {
      if (isUniqueError(e)) return res.status(409).json({ error: 'Username taken' });   // two admins created at the same moment
      throw e;
    }
  });
  r.put('/users/:id', auth('admin'), async (req, res) => {
    const u = await findById('user', req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    let { full_name, phone, vehicle_id, is_active, pin, password } = req.body || {};
    if (phone && phone !== u.phone) { const ph = contacts.parsePhone(phone); if (!ph.ok) return res.status(400).json({ error: ph.error, field: 'phone' }); phone = ph.e164; }
    const data = {
      full_name: String(full_name ?? u.full_name), phone: str(phone ?? u.phone),
      vehicle_id: vehicle_id !== undefined ? toId(vehicle_id) : u.vehicle_id,
      is_active: is_active !== undefined ? (is_active ? 1 : 0) : u.is_active,
    };
    if (pin && /^\d{4}$/.test(String(pin))) data.pin_hash = bcrypt.hashSync(String(pin), 10);
    if (password) data.password_hash = bcrypt.hashSync(String(password), 10);
    await prisma.user.update({ where: { id: u.id }, data });
    res.json({ ok: true });
  });

  // ── VEHICLES / FLEET ────────────────────────────────────────
  r.get('/vehicles', auth('admin'), async (req, res) => res.json(await prisma.vehicle.findMany({ orderBy: { fleet_number: 'asc' } })));
  r.post('/vehicles', auth('admin'), async (req, res) => {
    const { fleet_number, plate, max_daily_capacity, zone } = req.body || {};
    if (!fleet_number || !plate || !zone) return res.status(400).json({ error: 'fleet_number, plate, zone required' });
    const cap = int(max_daily_capacity, null) || 15;
    let v;
    try {
      v = await prisma.vehicle.create({ data: { fleet_number: String(fleet_number), plate: String(plate), max_daily_capacity: cap, zone: String(zone) } });
    } catch (e) {
      if (isUniqueError(e)) return res.status(409).json({ error: `Fleet number ${fleet_number} already exists` });
      throw e;
    }
    await prisma.alert.create({ data: { type: 'INFO', severity: 'info',
      message: `New vehicle onboarded: ${fleet_number} (${zone}, capacity ${cap}) — will be included in next route generation` } });
    res.json({ ok: true, id: v.id });
  });
  r.put('/vehicles/:id', auth('admin'), async (req, res) => {
    const v = await findById('vehicle', req.params.id);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const b = { ...v, ...req.body };
    try {
      await prisma.vehicle.update({
        where: { id: v.id },
        data: { fleet_number: String(b.fleet_number), plate: String(b.plate), max_daily_capacity: int(b.max_daily_capacity, v.max_daily_capacity), zone: String(b.zone), is_active: b.is_active ? 1 : 0 },
      });
    } catch (e) {
      if (isUniqueError(e)) return res.status(409).json({ error: `Fleet number ${b.fleet_number} already exists` });
      throw e;
    }
    res.json({ ok: true });
  });

  // Active Fleet Load Tracker — next N days utilisation per vehicle
  r.get('/fleet/load', auth('admin'), async (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 31);
    const vehicles = await prisma.vehicle.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' } });
    const start = new Date();
    const dates = [];
    for (let i = 0; i < days; i++) { const d = new Date(start); d.setDate(d.getDate() + i); dates.push(d.toISOString().slice(0, 10)); }
    // two queries for the whole table: stop counts per vehicle + day, and the day overrides
    const loads = await prisma.pickup.groupBy({
      by: ['vehicle_id', 'scheduled_date'], where: { vehicle_id: { in: vehicles.map(v => v.id) }, scheduled_date: { in: dates }, status: { in: ACTIVE_LOAD } }, _count: { _all: true },
    });
    const loadOf = new Map(loads.map(g => [g.vehicle_id + '|' + g.scheduled_date, g._count._all]));
    const overrides = await prisma.vehicleCapacityOverride.findMany({ where: { vehicle_id: { in: vehicles.map(v => v.id) }, date: { in: dates } } });
    const ovOf = new Map(overrides.map(o => [o.vehicle_id + '|' + o.date, o]));
    const out = vehicles.map(v => ({
      vehicle: v,
      days: dates.map(ds => {
        const c = loadOf.get(v.id + '|' + ds) || 0;
        const ov = ovOf.get(v.id + '|' + ds) || null;
        const cap = ov ? ov.capacity : v.max_daily_capacity;
        return { date: ds, load: c, capacity: cap, default_capacity: v.max_daily_capacity,
          override: ov ? { capacity: ov.capacity, reason: ov.reason, set_by: ov.set_by } : null,
          over_by: Math.max(0, c - cap), pct: cap > 0 ? Math.round(100 * c / cap) : (c > 0 ? 999 : 0) };
      }),
    }));
    res.json(out);
  });

  // ── DAILY ROUTE LEDGER MATRIX ───────────────────────────────
  r.get('/ledger', auth('admin'), async (req, res) => {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    let rows = await prisma.pickup.findMany({
      where: { scheduled_date: date },
      select: {
        id: true, seq: true, status: true, completed_at: true, photo_url: true, anomaly_reason: true, gps_lat: true, gps_lng: true, notes: true,
        service_type: true, time_window: true, confirmation_status: true, proof_meta: true, is_revisit: true,
        started_at: true, arrived_at: true, arrival_photo_url: true, arrival_distance_m: true, driver_id: true,
        customer_id: true, vehicle_id: true,
      },
    });
    rows = await join(rows, 'service_type', 'serviceType', ['category'], { key: 'code' });
    rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true });
    rows = await join(rows, 'vehicle_id', 'vehicle', ['fleet_number']);
    rows = await join(rows, 'driver_id', 'user', { driver: 'full_name' });
    sortBy(rows, p => p.fleet_number, p => p.seq, p => p.id);
    res.json({ date, rows: rows.map(({ customer_id, vehicle_id, ...x }) => x) });
  });

  // ── SCHEDULE GENERATION ─────────────────────────────────────
  r.post('/schedule/generate', auth('admin'), async (req, res) => {
    const now = new Date();
    const year = Number(req.body?.year) || now.getFullYear();
    const month = Number(req.body?.month) || now.getMonth() + 1;
    const result = await scheduler.generateMonth(year, month, { force: !!req.body?.force });
    if (!result.skipped) {
      await prisma.alert.create({ data: { type: 'INFO', severity: 'info',
        message: `Monthly schedule generated for ${year}-${String(month).padStart(2, '0')}: ${result.created} pickups` } });
      io.to('staff').emit('ledger:refresh', {});
    }
    res.json(result);
  });

  // ── RESCHEDULING MODULE ─────────────────────────────────────
  r.get('/reschedule/pending', auth('admin'), async (req, res) => {
    const moved = await prisma.alert.findMany({ where: { type: 'RESCHEDULED', pickup_id: { not: null } }, select: { pickup_id: true } });
    let rows = await prisma.pickup.findMany({
      where: {
        status: { in: ['canceled', 'overdue'] },
        // SQL: COALESCE(confirmation_status,'') NOT IN (...)
        OR: [{ confirmation_status: null }, { confirmation_status: { notIn: ['awaiting', 'confirmed', 'auto_confirmed', 'disputed'] } }],
        id: { notIn: moved.map(a => a.pickup_id) },
      },
      select: { id: true, scheduled_date: true, status: true, anomaly_reason: true, customer_id: true, vehicle_id: true },
      orderBy: [{ scheduled_date: 'desc' }, { id: 'desc' }],
    });
    rows = (await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true })).slice(0, 50);
    rows = await join(rows, 'vehicle_id', 'vehicle', ['fleet_number']);
    res.json(rows.map(({ customer_id, vehicle_id, ...x }) => x));
  });
  r.get('/reschedule/options/:pickupId', auth('admin'), async (req, res) => {
    const out = await rescheduler.recommend(Number(req.params.pickupId));
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });
  r.post('/reschedule/apply', auth('admin'), async (req, res) => {
    const { pickup_id, date, vehicle_id } = req.body || {};
    const dErr = security.dateInRange(date, { futureDays: 366 }); if (dErr) return res.status(400).json({ error: dErr });
    const out = await rescheduler.apply(Number(pickup_id), date, Number(vehicle_id));
    if (out.error) return res.status(409).json(out);
    io.to('staff').emit('ledger:refresh', { date });
    io.to('staff').emit('driver:queue-updated', { vehicle_id: Number(vehicle_id), date });
    // push so the driver hears about it even with the app closed
    try { await v3.notifyVehicleDrivers(Number(vehicle_id), 'Route updated', `A stop was moved to your route on ${v3.dmy(date)}`); } catch {}
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
  const monthOf = (req) => String(req.query.month || new Date().toISOString().slice(0, 7));

  // Monthly compliance: did each customer get their mandatory visits?
  r.get('/reports/compliance', auth('admin'), async (req, res) => {
    const month = monthOf(req);
    const customers = await prisma.customer.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' } });
    const g = await prisma.pickup.groupBy({ by: ['customer_id', 'status'], where: { scheduled_date: { startsWith: month }, status: { not: 'rescheduled' } }, _count: { _all: true } });
    const n = (cid, st) => g.find(x => x.customer_id === cid && x.status === st)?._count._all || 0;
    const rows = customers.map(c => {
      const collected = n(c.id, 'collected'), pending = n(c.id, 'pending'), canceled = n(c.id, 'canceled');
      const compliance = collected >= c.frequency ? 'MET' : (collected + pending) >= c.frequency ? 'ON TRACK' : 'AT RISK';
      return { name: c.name, branch: c.branch, zone: c.zone, required_visits: c.frequency, collected, still_pending: pending, canceled, compliance };
    });
    sortBy(rows, desc(x => x.compliance), x => x.zone, x => x.name);
    if (req.query.format === 'csv') return csvOut(res, `compliance_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // Driver performance
  r.get('/reports/drivers', auth('admin'), async (req, res) => {
    const month = monthOf(req);
    let drivers = await prisma.user.findMany({ where: { role: 'driver' }, select: { id: true, full_name: true, vehicle_id: true }, orderBy: { id: 'asc' } });
    drivers = await join(drivers, 'vehicle_id', 'vehicle', ['fleet_number']);
    const g = await prisma.pickup.groupBy({ by: ['driver_id', 'status'], where: { scheduled_date: { startsWith: month }, status: { not: 'rescheduled' }, driver_id: { in: drivers.map(d => d.id) } }, _count: { _all: true } });
    const n = (id, st) => g.filter(x => x.driver_id === id && (!st || x.status === st)).reduce((a, x) => a + x._count._all, 0);
    const rows = drivers.map(u => ({ driver: u.full_name, fleet_number: u.fleet_number, collected: n(u.id, 'collected'), canceled: n(u.id, 'canceled'), overdue: n(u.id, 'overdue'), total_assigned: n(u.id) }));
    sortBy(rows, desc(x => x.collected));
    if (req.query.format === 'csv') return csvOut(res, `drivers_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // Anomaly breakdown
  r.get('/reports/anomalies', auth('admin'), async (req, res) => {
    const month = monthOf(req);
    let jobs = await prisma.pickup.findMany({
      where: { anomaly_reason: { not: null }, scheduled_date: { startsWith: month } },
      select: { anomaly_reason: true, customer_id: true }, orderBy: { id: 'asc' },
    });
    jobs = await join(jobs, 'customer_id', 'customer', ['zone'], { inner: true });
    const rows = [...groupBy(jobs, p => p.anomaly_reason)]
      .map(([reason, list]) => ({ reason, count: list.length, zones: [...new Set(list.map(p => p.zone))].join(',') }))   // GROUP_CONCAT(DISTINCT zone)
      .sort((a, b) => b.count - a.count);
    if (req.query.format === 'csv') return csvOut(res, `anomalies_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // Full ledger export
  r.get('/reports/ledger', auth('admin'), async (req, res) => {
    const month = monthOf(req);
    let jobs = await prisma.pickup.findMany({ where: { scheduled_date: { startsWith: month } } });
    jobs = await join(jobs, 'customer_id', 'customer', { customer: 'name', branch: 'branch', zone: 'zone' }, { inner: true });
    jobs = await join(jobs, 'vehicle_id', 'vehicle', { vehicle: 'fleet_number' });
    jobs = await join(jobs, 'driver_id', 'user', { driver: 'full_name' });
    sortBy(jobs, p => p.scheduled_date, p => p.vehicle, p => p.seq, p => p.id);
    const rows = jobs.map(p => pick(p, ['id', 'scheduled_date', 'customer', 'branch', 'zone', 'vehicle', 'driver', 'status', 'completed_at', 'anomaly_reason', 'gps_lat', 'gps_lng', 'photo_url']));
    if (req.query.format === 'csv') return csvOut(res, `ledger_${month}.csv`, rows);
    res.json({ month, rows });
  });

  // ── ALERTS ──────────────────────────────────────────────────
  r.get('/alerts', auth('admin'), async (req, res) => {
    res.json(await prisma.alert.findMany({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 100 }));
  });
  r.post('/alerts/read-all', auth('admin'), async (req, res) => {
    await prisma.alert.updateMany({ where: { is_read: 0 }, data: { is_read: 1 } });
    res.json({ ok: true });
  });

  // ── SETTINGS ────────────────────────────────────────────────
  r.get('/settings', auth('admin'), async (req, res) => {
    res.json({ shift_cutoff: await getSetting('shift_cutoff', '12:00'), company_name: await getSetting('company_name', '') });
  });
  r.put('/settings', auth('admin'), async (req, res) => {
    if (req.body?.shift_cutoff) await setSetting('shift_cutoff', req.body.shift_cutoff);
    if (req.body?.company_name) await setSetting('company_name', req.body.company_name);
    res.json({ ok: true });
  });
  r.post('/sla/check-now', auth('admin'), async (req, res) => res.json(await sla.checkNow(io)));

  return r;
};
