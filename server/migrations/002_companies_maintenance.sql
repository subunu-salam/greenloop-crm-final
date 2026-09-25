-- GreenLoop — Multi-company + Vehicle Maintenance (Majari UAE)
-- Run after existing schema

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trade_license TEXT,
  emirate TEXT NOT NULL DEFAULT 'Dubai',
  address TEXT,
  contact_phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  zone TEXT,
  lat REAL,
  lng REAL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Link existing tables optionally
-- ALTER TABLE vehicles ADD COLUMN company_id INTEGER REFERENCES companies(id);
-- ALTER TABLE customers ADD COLUMN company_id INTEGER REFERENCES companies(id);

CREATE TABLE IF NOT EXISTS vehicle_maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  next_service_date TEXT,
  last_service_date TEXT,
  last_odometer INTEGER,
  registration_expiry TEXT,
  insurance_expiry TEXT,
  insurance_provider TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','due','overdue','expired')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vm_vehicle ON vehicle_maintenance(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vm_status ON vehicle_maintenance(status);
