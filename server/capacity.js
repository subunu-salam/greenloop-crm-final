// ─────────────────────────────────────────────────────────────
// Daily capacity moderation (v3.2)
// A vehicle's capacity is no longer a fixed 15. Every engine asks
// capacityFor(vehicle, date), which returns the per-day override when the
// office has set one (truck in the workshop → 0, extra helper → 18) and
// otherwise the vehicle's own default (vehicles.max_daily_capacity).
// ─────────────────────────────────────────────────────────────
const { q } = require('./db');

const MIN_CAPACITY = 0;
const MAX_CAPACITY = 60;

q.run(`CREATE TABLE IF NOT EXISTS vehicle_capacity_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  date TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  reason TEXT,
  set_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(vehicle_id, date)
)`);

function validCapacity(n) {
  return Number.isInteger(n) && n >= MIN_CAPACITY && n <= MAX_CAPACITY;
}

function overrideFor(vehicleId, date) {
  return q.get(`SELECT * FROM vehicle_capacity_overrides WHERE vehicle_id=? AND date=?`, vehicleId, date) || null;
}

// vehicle: a row from `vehicles` (needs id + max_daily_capacity)
function capacityFor(vehicle, date) {
  if (!vehicle) return 0;
  const o = date ? overrideFor(vehicle.id, date) : null;
  return o ? o.capacity : vehicle.max_daily_capacity;
}

function loadOf(vehicleId, date) {
  return q.get(`SELECT COUNT(*) c FROM pickups WHERE vehicle_id=? AND scheduled_date=? AND status IN ('pending','collected','overdue')`, vehicleId, date).c;
}

function setOverride(vehicleId, date, capacity, reason, by) {
  q.run(`INSERT INTO vehicle_capacity_overrides(vehicle_id,date,capacity,reason,set_by) VALUES (?,?,?,?,?)
         ON CONFLICT(vehicle_id,date) DO UPDATE SET capacity=excluded.capacity, reason=excluded.reason, set_by=excluded.set_by, created_at=datetime('now')`,
    vehicleId, date, capacity, reason || null, by || null);
}
function clearOverride(vehicleId, date) {
  return q.run(`DELETE FROM vehicle_capacity_overrides WHERE vehicle_id=? AND date=?`, vehicleId, date).changes;
}

module.exports = { capacityFor, overrideFor, setOverride, clearOverride, loadOf, validCapacity, MIN_CAPACITY, MAX_CAPACITY };
