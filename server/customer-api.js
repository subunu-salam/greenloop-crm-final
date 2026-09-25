// Customer portal API routes — mount inside buildApi
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { q, getSetting } = require('./db');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

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

function mountCustomerRoutes(r, io) {
  // Ensure portal_code column exists
  Promise.resolve(q.run(`ALTER TABLE customers ADD COLUMN portal_code_hash TEXT`)).catch(() => {
    /* already exists */
  });

  // Seed demo portal codes for first 3 customers if missing
  Promise.resolve(
    q.all(
      `SELECT id FROM customers WHERE is_active=1 AND (portal_code_hash IS NULL OR portal_code_hash='') ORDER BY id LIMIT 3`
    )
  )
    .then((need) => {
      const codes = ['1001', '1002', '1003'];
      need.forEach((c, i) => {
        if (codes[i])
          q.run(`UPDATE customers SET portal_code_hash=? WHERE id=?`, bcrypt.hashSync(codes[i], 10), c.id);
      });
    })
    .catch((e) => console.warn('Customer portal seed:', e.message));

  r.post('/auth/customer-login', (req, res) => {
    const code = String((req.body || {}).code || '');
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Code must be 4 digits' });
    const rows = q.all(`SELECT * FROM customers WHERE is_active=1 AND portal_code_hash IS NOT NULL`);
    const c = rows.find((row) => row.portal_code_hash && bcrypt.compareSync(code, row.portal_code_hash));
    if (!c) return res.status(401).json({ error: 'Invalid store code' });
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

  r.get('/customer/dashboard', authCustomer, (req, res) => {
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

    const todayRows = q.all(
      `SELECT p.*, v.fleet_number, u.full_name AS driver_name
       FROM pickups p
       LEFT JOIN vehicles v ON v.id = p.vehicle_id
       LEFT JOIN users u ON u.id = p.driver_id
       WHERE p.customer_id = ? AND p.scheduled_date = ? AND p.status != 'rescheduled'
       ORDER BY p.seq`,
      cid,
      today
    );
    const upcoming = q.all(
      `SELECT p.*, v.fleet_number, u.full_name AS driver_name
       FROM pickups p
       LEFT JOIN vehicles v ON v.id = p.vehicle_id
       LEFT JOIN users u ON u.id = p.driver_id
       WHERE p.customer_id = ? AND p.scheduled_date > ? AND p.scheduled_date <= ?
         AND p.status IN ('pending','rescheduled')
       ORDER BY p.scheduled_date LIMIT 20`,
      cid,
      today,
      in14
    );
    const collected = q.get(
      `SELECT COUNT(*) c FROM pickups WHERE customer_id=? AND status='collected' AND scheduled_date LIKE ?`,
      cid,
      month + '%'
    ).c;
    const cust = q.get(`SELECT frequency FROM customers WHERE id=?`, cid);
    const pendingUp = q.get(
      `SELECT COUNT(*) c FROM pickups WHERE customer_id=? AND scheduled_date >= ? AND status='pending'`,
      cid,
      today
    ).c;

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

  r.get('/customer/pickups/:id', authCustomer, (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const p = q.get(
      `SELECT p.*, v.fleet_number, u.full_name AS driver_name, c.name, c.branch
       FROM pickups p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN vehicles v ON v.id = p.vehicle_id
       LEFT JOIN users u ON u.id = p.driver_id
       WHERE p.id = ? AND p.customer_id = ?`,
      req.params.id,
      cid
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  });

  r.get('/customer/history', authCustomer, (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const rows = q.all(
      `SELECT p.id, p.scheduled_date, p.status, p.completed_at, p.photo_url, p.anomaly_reason,
              v.fleet_number, u.full_name AS driver_name
       FROM pickups p
       LEFT JOIN vehicles v ON v.id = p.vehicle_id
       LEFT JOIN users u ON u.id = p.driver_id
       WHERE p.customer_id = ? AND p.status IN ('collected','canceled','overdue')
       ORDER BY COALESCE(p.completed_at, p.scheduled_date) DESC LIMIT 50`,
      cid
    );
    res.json(rows);
  });

  r.post('/customer/pickups/:id/note', authCustomer, (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const p = q.get(`SELECT * FROM pickups WHERE id=? AND customer_id=?`, req.params.id, cid);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const notes = String((req.body || {}).notes || '').slice(0, 500);
    if (!notes) return res.status(400).json({ error: 'notes required' });
    q.run(
      `UPDATE pickups SET notes = COALESCE(notes,'') || ' [customer: ' || ? || ']', updated_at=datetime('now') WHERE id=?`,
      notes,
      p.id
    );
    const msg = `Customer note (${req.user.name}): ${notes}`;
    q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES ('INFO','info',?,?)`, msg, p.id);
    io.emit('alert', { type: 'INFO', severity: 'info', message: msg, pickup_id: p.id });
    res.json({ ok: true });
  });

  r.post('/customer/pickups/:id/access-issue', authCustomer, (req, res) => {
    const cid = req.user.customer_id || req.user.id;
    const p = q.get(`SELECT * FROM pickups WHERE id=? AND customer_id=?`, req.params.id, cid);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const message =
      String((req.body || {}).message || 'Access issue reported by store') + ' — ' + req.user.name;
    q.run(`INSERT INTO alerts(type,severity,message,pickup_id) VALUES ('ANOMALY','warning',?,?)`, message, p.id);
    io.emit('alert', { type: 'ANOMALY', severity: 'warning', message, pickup_id: p.id });
    res.json({ ok: true });
  });
}

module.exports = { mountCustomerRoutes, authCustomer };
