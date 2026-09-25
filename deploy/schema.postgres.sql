-- ─────────────────────────────────────────────────────────────
-- GreenLoop Waste Logistics — production PostgreSQL schema
-- Mirrors the SQLite dev schema in server/db.js
-- ─────────────────────────────────────────────────────────────
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  role VARCHAR(10) NOT NULL CHECK (role IN ('driver','admin')),
  username VARCHAR(60) UNIQUE,
  password_hash VARCHAR(80),
  pin_hash VARCHAR(80),
  phone VARCHAR(30),
  vehicle_id INT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vehicles (
  id SERIAL PRIMARY KEY,
  fleet_number VARCHAR(30) UNIQUE NOT NULL,
  plate VARCHAR(30) NOT NULL,
  max_daily_capacity INT NOT NULL DEFAULT 15,
  zone VARCHAR(60) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD CONSTRAINT fk_users_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  branch VARCHAR(120),
  zone VARCHAR(60) NOT NULL,
  frequency INT NOT NULL DEFAULT 2 CHECK (frequency IN (2,3)),
  lat NUMERIC(10,7) NOT NULL,
  lng NUMERIC(10,7) NOT NULL,
  address TEXT,
  contact_phone VARCHAR(30),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pickups (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  vehicle_id INT REFERENCES vehicles(id),
  driver_id INT REFERENCES users(id),
  scheduled_date DATE NOT NULL,
  seq INT NOT NULL DEFAULT 0,
  status VARCHAR(15) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','collected','canceled','overdue','rescheduled')),
  completed_at TIMESTAMPTZ,
  photo_url TEXT,
  gps_lat NUMERIC(10,7),
  gps_lng NUMERIC(10,7),
  anomaly_reason VARCHAR(30),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pickups_date ON pickups(scheduled_date);
CREATE INDEX idx_pickups_status ON pickups(status);
CREATE INDEX idx_pickups_vehicle_date ON pickups(vehicle_id, scheduled_date);

CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) NOT NULL,
  severity VARCHAR(10) NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  pickup_id INT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE settings (
  key VARCHAR(60) PRIMARY KEY,
  value TEXT NOT NULL
);
