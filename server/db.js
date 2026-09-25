// ─────────────────────────────────────────────────────────────
// Database entry — SQLite (local) or Neon Postgres (DATABASE_URL)
// ─────────────────────────────────────────────────────────────
if (process.env.DATABASE_URL) {
  module.exports = require('./db-pg');
} else {
  // Original SQLite implementation for local demo
  const { DatabaseSync } = require('node:sqlite');
  const path = require('path');
  const bcrypt = require('bcryptjs');

  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');
  const db = new DatabaseSync(DB_PATH);
  try { db.exec('PRAGMA journal_mode = WAL;'); } catch {}
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('driver','admin')),
  username TEXT UNIQUE,
  password_hash TEXT,
  pin_hash TEXT,
  phone TEXT,
  vehicle_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fleet_number TEXT UNIQUE NOT NULL,
  plate TEXT NOT NULL,
  max_daily_capacity INTEGER NOT NULL DEFAULT 15,
  zone TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  branch TEXT,
  zone TEXT NOT NULL,
  frequency INTEGER NOT NULL DEFAULT 2 CHECK (frequency IN (2,3)),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT,
  contact_phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pickups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  driver_id INTEGER REFERENCES users(id),
  scheduled_date TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','collected','canceled','overdue','rescheduled')),
  completed_at TEXT,
  photo_url TEXT,
  gps_lat REAL, gps_lng REAL,
  anomaly_reason TEXT,
  stage TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pickups_date ON pickups(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_pickups_status ON pickups(status);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  pickup_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
  try { db.exec('ALTER TABLE pickups ADD COLUMN stage TEXT'); } catch {}

  const q = {
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
  };

  function getSetting(key, fallback) {
    const r = q.get('SELECT value FROM settings WHERE key = ?', key);
    return r ? r.value : fallback;
  }
  function setSetting(key, value) {
    q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  }

  function seed() {
    if (q.get('SELECT id FROM users LIMIT 1')) return false;
    setSetting('shift_cutoff', '12:00');
    setSetting('company_name', 'Majari / GreenLoop');
    q.run(`INSERT INTO vehicles(fleet_number,plate,max_daily_capacity,zone) VALUES
      ('TRUCK-01','DXB A 71214',15,'Deira'),
      ('TRUCK-02','DXB B 33482',15,'Marina')`);
    const admin = bcrypt.hashSync('admin123', 10);
    q.run(`INSERT INTO users(full_name,role,username,password_hash,phone) VALUES
      ('Shahzad (Owner)','admin','admin','${admin}','+971500000001')`);
    const pins = { 'Ali Hassan': ['1111', 1], 'Ramesh Kumar': ['2222', 2], 'Joseph Mathew': ['3333', null] };
    for (const [name, [pin, veh]] of Object.entries(pins)) {
      q.run('INSERT INTO users(full_name,role,pin_hash,vehicle_id,phone) VALUES (?,?,?,?,?)',
        name, 'driver', bcrypt.hashSync(pin, 10), veh, '+9715' + Math.floor(10000000 + Math.random() * 89999999));
    }
    const zones = {
      Deira: { lat: 25.2697, lng: 55.3094 },
      Marina: { lat: 25.0805, lng: 55.1403 },
      Downtown: { lat: 25.1972, lng: 55.2744 },
    };
    const brands = ['Al Madina Mart', 'Fresh Basket', 'City Grocer', 'Lulu Express', 'Nesto Mini', 'Day2Day',
      'Green Valley', 'Star Supermarket', 'Al Noor Foods', 'Sunrise Mart', 'Family Choice', 'Quick Stop'];
    const ins = db.prepare('INSERT INTO customers(name,branch,zone,frequency,lat,lng,address,contact_phone) VALUES (?,?,?,?,?,?,?,?)');
    let n = 0;
    for (const [zone, c] of Object.entries(zones)) {
      for (let i = 0; i < 12; i++) {
        const brand = brands[(n + i) % brands.length];
        ins.run(`${brand}`, `${zone} Branch ${i + 1}`, zone, (i % 3 === 0) ? 3 : 2,
          c.lat + (Math.random() - 0.5) * 0.05, c.lng + (Math.random() - 0.5) * 0.05,
          `${zone}, Street ${10 + i}, Dubai`, '+9714' + Math.floor(1000000 + Math.random() * 8999999));
      }
      n++;
    }
    return true;
  }

  module.exports = { db, q, seed, getSetting, setSetting, isPg: false };
}
