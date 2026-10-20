// Customer portal API routes — mount inside buildApi
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { prisma, join, toId, sortBy, desc, now: sqlNow } = require('./db');
const security = require('./security');
const contacts = require('./contacts');

require('./security').ensureSecret();
const SECRET = process.env.JWT_SECRET;

function signCustomer(c) {
  return jwt.sign(
    { id: c.id, role: 'customer', name: c.name, customer_id: c.id },
    SECRET,
    { expiresIn: '30d' }
  );
}

function authCustomer(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const p = jwt.verify(token, SECRET);
    if (p.role !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    req.user = p;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Give demo codes 1001-1003 to the first 3 customers that have none.
// Called once at start-up, after the demo data is seeded.
async function seedPortalCodes() {
  try {
    // Demo accounts: mobile 050 000 100X + code 100X (only set when the
    // customer has no code yet, i.e. a freshly seeded demo database).
    // v3.4.4: once any customer has a code the database is in use, so nothing is touched again.
    // Before, a restart could overwrite a real customer's phone and give them a demo code.
    if (await prisma.customer.findFirst({ where: { portal_code_hash: { not: null } }, select: { id: true } })) return;
    const first = await prisma.customer.findMany({ where: { is_active: 1 }, select: { id: true, portal_code_hash: true }, orderBy: { id: 'asc' }, take: 3 });
    let n = 0;
    for (const [i, code] of ['1001', '1002', '1003'].entries()) {
      if (first[i] && !first[i].portal_code_hash) {
        await prisma.customer.update({ where: { id: first[i].id }, data: { portal_code_hash: bcrypt.hashSync(code, 10), contact_phone: '+97150000' + code } });
        n++;
      }
    }
    if (n) console.log('✔ Customer demo logins ready: mobile 050 000 1001 / code 1001 (also …1002, …1003)');
  } catch (e) { console.warn('Customer portal seed:', e.message); }
}

// pickups + fleet number + driver name (two LEFT JOINs)
async function withVehicleAndDriver(rows) {
  rows = await join(rows, 'vehicle_id', 'vehicle', ['fleet_number']);
  return join(rows, 'driver_id', 'user', { driver_name: 'full_name' });
}

function mountCustomerRoutes(r, io) {
  // Sign in with the account's mobile number (or email) + its store code.
  // Only the matching account's code is checked (one bcrypt compare), and
  // index.js throttles failed attempts per IP and per number.
  r.post('/auth/customer-login', async (req, res) => {
    const code = String((req.body || {}).code || '');
    const who = String((req.body || {}).phone || '').trim();
    if (!who) return res.status(400).json({ error: 'Enter the mobile number on your account' });
    // 4 digits; codes issued before v3.3 had 6 and still sign in
    if (!/^\d{4,6}$/.test(code)) return res.status(400).json({ error: 'Enter your 4-digit code' });
    const email = who.includes('@') ? who.toLowerCase() : null;
    if (!email) { const ph = contacts.parsePhone(who); if (!ph.ok) return res.status(400).json({ error: ph.error }); }
    // sites whose phone/email matches → their account (codes live on the account document)
    const sites = (await prisma.customer.findMany({ where: { is_active: 1 }, select: { id: true, account_id: true, contact_phone: true, email: true }, orderBy: { id: 'asc' } }))
      .map((s) => ({ ...s, acct: s.account_id ?? s.id }))
      .filter((s) => email ? contacts.sameEmail(s.email, email) : contacts.samePhone(s.contact_phone, who));
    const accts = [...new Set(sites.map((s) => s.acct))].slice(0, 5);
    let c = null;
    for (const id of accts) {
      const row = await prisma.customer.findFirst({ where: { id, is_active: 1, portal_code_hash: { not: null } } });
      if (row && bcrypt.compareSync(code, row.portal_code_hash)) { c = row; break; }
    }
    if (!c) return res.status(401).json({ error: 'Mobile number or code is incorrect' });
    res.json({
      token: signCustomer(c),
      customer: {
        id: c.id,
        name: c.name,
        branch: c.branch,
        zone: c.zone,
        address: c.address,
        contact_phone: c.contact_phone,
        frequency: c.frequency,
      },
    });
  });

  r.get('/customer/dashboard', authCustomer, async (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    const mapRow = (p) => ({
      id: p.id,
      scheduled_date: p.scheduled_date,
      status: p.status,
      stage: p.stage,
      fleet_number: p.fleet_number,
      driver_name: p.driver_name,
      photo_url: p.photo_url,
      completed_at: p.completed_at,
    });

    const todayRows = await withVehicleAndDriver(await prisma.pickup.findMany({
      where: { customer_id: cid, scheduled_date: today, status: { not: 'rescheduled' } },
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    }));
    const upcoming = await withVehicleAndDriver(await prisma.pickup.findMany({
      where: { customer_id: cid, scheduled_date: { gt: today, lte: in14 }, status: { in: ['pending', 'rescheduled'] } },
      orderBy: [{ scheduled_date: 'asc' }, { id: 'asc' }], take: 20,
    }));
    const collected = await prisma.pickup.count({ where: { customer_id: cid, status: 'collected', scheduled_date: { startsWith: month } } });
    const cust = await prisma.customer.findUnique({ where: { id: cid }, select: { frequency: true } });
    const pendingUp = await prisma.pickup.count({ where: { customer_id: cid, scheduled_date: { gte: today }, status: 'pending' } });

    res.json({
      today: todayRows.map(mapRow),
      upcoming: upcoming.map(mapRow),
      compliance: {
        collected_this_month: collected,
        frequency: cust?.frequency || 2,
        pending_upcoming: pendingUp,
      },
    });
  });

  // a pickup that belongs to the signed-in site, or null
  const ownPickup = async (req) => {
    const id = toId(req.params.id);
    return id ? prisma.pickup.findFirst({ where: { id, customer_id: req.user.customer_id || req.user.id } }) : null;
  };

  r.get('/customer/pickups/:id', authCustomer, async (req, res) => {
    const p = await ownPickup(req);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const [row] = await join(await withVehicleAndDriver([p]), 'customer_id', 'customer', ['name', 'branch'], { inner: true });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  r.get('/customer/history', authCustomer, async (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    let rows = await prisma.pickup.findMany({
      where: { customer_id: cid, status: { in: ['collected', 'canceled', 'overdue'] } },
      select: { id: true, scheduled_date: true, status: true, completed_at: true, photo_url: true, anomaly_reason: true, vehicle_id: true, driver_id: true },
    });
    // ORDER BY COALESCE(completed_at, scheduled_date) DESC LIMIT 50
    rows = sortBy(rows, desc((p) => p.completed_at ?? p.scheduled_date)).slice(0, 50);
    rows = await withVehicleAndDriver(rows);
    res.json(rows.map(({ vehicle_id, driver_id, ...x }) => x));
  });

  r.post('/customer/pickups/:id/note', authCustomer, async (req, res) => {
    const p = await ownPickup(req);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const notes = String((req.body || {}).notes || '').slice(0, 500);
    if (!notes) return res.status(400).json({ error: 'notes required' });
    await prisma.pickup.update({ where: { id: p.id }, data: { notes: (p.notes || '') + ' [customer: ' + notes + ']', updated_at: sqlNow() } });
    const msg = `Customer note (${req.user.name}): ${notes}`;
    await prisma.alert.create({ data: { type: 'INFO', severity: 'info', message: msg, pickup_id: p.id } });
    io.to('staff').emit('alert', { type: 'INFO', severity: 'info', message: msg, pickup_id: p.id });
    res.json({ ok: true });
  });

  r.post('/customer/pickups/:id/access-issue', authCustomer, async (req, res) => {
    const p = await ownPickup(req);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const message =
      String((req.body || {}).message || 'Access issue reported by store') + ' — ' + req.user.name;
    await prisma.alert.create({ data: { type: 'ANOMALY', severity: 'warning', message, pickup_id: p.id } });
    io.to('staff').emit('alert', { type: 'ANOMALY', severity: 'warning', message, pickup_id: p.id });
    res.json({ ok: true });
  });
}

module.exports = { seedPortalCodes, mountCustomerRoutes, authCustomer };
