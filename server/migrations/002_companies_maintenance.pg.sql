-- Companies + vehicle maintenance (Neon / Postgres)
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  trade_license VARCHAR(80),
  emirate VARCHAR(40) NOT NULL DEFAULT 'Dubai',
  address TEXT,
  contact_phone VARCHAR(30),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id),
  name VARCHAR(120) NOT NULL,
  zone VARCHAR(60),
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicle_maintenance (
  id SERIAL PRIMARY KEY,
  vehicle_id INT NOT NULL REFERENCES vehicles(id),
  next_service_date DATE,
  last_service_date DATE,
  last_odometer INT,
  registration_expiry DATE,
  insurance_expiry DATE,
  insurance_provider VARCHAR(120),
  notes TEXT,
  status VARCHAR(15) NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok','due','overdue','expired')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vm_vehicle ON vehicle_maintenance(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vm_status ON vehicle_maintenance(status);
