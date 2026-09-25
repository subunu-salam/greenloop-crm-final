// ─────────────────────────────────────────────────────────────
// PostgreSQL layer for Neon (and any Postgres)
// Activated when process.env.DATABASE_URL is set
// ─────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') || process.env.PGSSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined,
});

// Convert ? placeholders to $1, $2, ... for node-pg
function toPg(sql, params = []) {
  let i = 0;
  const normalized = sql
    .replace(/\bis_active\s*=\s*1\b/gi, 'is_active = true')
    .replace(/\bis_active\s*=\s*0\b/gi, 'is_active = false')
    .replace(/\bis_read\s*=\s*1\b/gi, 'is_read = true')
    .replace(/\bis_read\s*=\s*0\b/gi, 'is_read = false');
  const text = normalized.replace(/\?/g, () => `$${++i}`);
  return { text, values: params };
}

const q = {
  all: async (sql, ...p) => {
    const { text, values } = toPg(sql, p);
    const r = await pool.query(text, values);
    return r.rows;
  },
  get: async (sql, ...p) => {
    const { text, values } = toPg(sql, p);
    const r = await pool.query(text, values);
    return r.rows[0] || null;
  },
  run: async (sql, ...p) => {
    const { text, values } = toPg(sql, p);
    const r = await pool.query(text, values);
    return { changes: r.rowCount, lastInsertRowid: r.rows?.[0]?.id };
  },
};

async function getSetting(key, fallback) {
  const r = await q.get('SELECT value FROM settings WHERE key = $1', key);
  return r ? r.value : fallback;
}

async function setSetting(key, value) {
  await q.run(
    `INSERT INTO settings(key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    key, String(value)
  );
}

async function ensureSchema() {
  const schemaPath = path.join(__dirname, '..', 'deploy', 'schema.postgres.sql');
  const extraPath = path.join(__dirname, 'migrations', '002_companies_maintenance.pg.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  // Run base schema (ignore errors for existing objects)
  try {
    await pool.query(schema);
  } catch (e) {
    // Tables may already exist
    if (!/already exists/i.test(e.message)) console.warn('Schema note:', e.message);
  }
  // stage column for pickups
  try {
    await pool.query('ALTER TABLE pickups ADD COLUMN IF NOT EXISTS stage VARCHAR(30)');
  } catch {}
  if (fs.existsSync(extraPath)) {
    try {
      await pool.query(fs.readFileSync(extraPath, 'utf8'));
    } catch (e) {
      if (!/already exists/i.test(e.message)) console.warn('Migration note:', e.message);
    }
  }
}

async function seed() {
  const existing = await q.get('SELECT id FROM users LIMIT 1');
  if (existing) return false;

  await setSetting('shift_cutoff', '12:00');
  await setSetting('company_name', 'Majari / GreenLoop');

  await q.run(
    `INSERT INTO vehicles (fleet_number, plate, max_daily_capacity, zone) VALUES
     ('TRUCK-01', 'DXB A 71214', 15, 'Deira'),
     ('TRUCK-02', 'DXB B 33482', 15, 'Marina')`
  );

  const admin = bcrypt.hashSync('admin123', 10);
  await q.run(
    `INSERT INTO users (full_name, role, username, password_hash, phone)
     VALUES ($1, 'admin', 'admin', $2, $3)`,
    'Shahzad (Owner)', admin, '+971500000001'
  );

  const pins = [
    ['Ali Hassan', '1111', 1],
    ['Ramesh Kumar', '2222', 2],
    ['Joseph Mathew', '3333', null],
  ];
  for (const [name, pin, veh] of pins) {
    await q.run(
      `INSERT INTO users (full_name, role, pin_hash, vehicle_id, phone)
       VALUES ($1, 'driver', $2, $3, $4)`,
      name,
      bcrypt.hashSync(pin, 10),
      veh,
      '+9715' + Math.floor(10000000 + Math.random() * 89999999)
    );
  }

  const zones = {
    Deira: { lat: 25.2697, lng: 55.3094 },
    Marina: { lat: 25.0805, lng: 55.1403 },
    Downtown: { lat: 25.1972, lng: 55.2744 },
  };
  const brands = [
    'Al Madina Mart', 'Fresh Basket', 'City Grocer', 'Lulu Express', 'Nesto Mini', 'Day2Day',
    'Green Valley', 'Star Supermarket', 'Al Noor Foods', 'Sunrise Mart', 'Family Choice', 'Quick Stop',
  ];
  let n = 0;
  for (const [zone, c] of Object.entries(zones)) {
    for (let i = 0; i < 12; i++) {
      const brand = brands[(n + i) % brands.length];
      await q.run(
        `INSERT INTO customers (name, branch, zone, frequency, lat, lng, address, contact_phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        brand,
        `${zone} Branch ${i + 1}`,
        zone,
        i % 3 === 0 ? 3 : 2,
        c.lat + (Math.random() - 0.5) * 0.05,
        c.lng + (Math.random() - 0.5) * 0.05,
        `${zone}, Street ${10 + i}, Dubai`,
        '+9714' + Math.floor(1000000 + Math.random() * 8999999)
      );
    }
    n++;
  }
  return true;
}

module.exports = { pool, q, seed, getSetting, setSetting, ensureSchema, isPg: true };
