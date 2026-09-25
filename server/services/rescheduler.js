// ─────────────────────────────────────────────────────────────
// Intelligent Conflict-Free Rescheduling Engine (PRD §3.2)
//   1. Zone filtering   — only vehicles operating in the client's zone
//   2. Capacity check   — skip days where vehicle already ≥ max capacity
//   3. Distance dev.    — cheapest-insertion mileage deviation per option
//   4. Top-3 ranking    — lowest added mileage first
//   5. One-click apply  — moves the stop, re-sorts routes, notifies driver
// ─────────────────────────────────────────────────────────────
const { q } = require('../db');
const { insertionCost } = require('./geo');
const { resortDay } = require('./scheduler');

const HORIZON_DAYS = 7;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function recommend(pickupId) {
  const pickup = q.get(
    `SELECT p.*, c.zone, c.lat, c.lng, c.name AS customer_name, c.branch
     FROM pickups p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?`, pickupId);
  if (!pickup) return { error: 'Pickup not found' };

  // Step 1 — zone filtering
  let vehicles = q.all(`SELECT * FROM vehicles WHERE is_active = 1 AND zone = ?`, pickup.zone);
  let zoneRelaxed = false;
  if (!vehicles.length) { vehicles = q.all(`SELECT * FROM vehicles WHERE is_active = 1`); zoneRelaxed = true; }

  const today = new Date().toISOString().slice(0, 10);
  const startFrom = pickup.scheduled_date > today ? pickup.scheduled_date : today;
  const options = [];

  for (let i = 1; i <= HORIZON_DAYS; i++) {
    const date = addDays(startFrom, i);
    for (const v of vehicles) {
      // Step 2 — capacity threshold analysis
      const dayLoad = q.get(
        `SELECT COUNT(*) c FROM pickups
         WHERE vehicle_id = ? AND scheduled_date = ? AND status IN ('pending','collected','overdue')`,
        v.id, date).c;
      if (dayLoad >= v.max_daily_capacity) continue;

      // avoid same-day duplicate visit for this customer
      const dup = q.get(
        `SELECT id FROM pickups WHERE customer_id = ? AND scheduled_date = ? AND status IN ('pending','collected')`,
        pickup.customer_id, date);
      if (dup) continue;

      // Step 3 — proximity distance deviation (cheapest insertion into that day's route)
      const route = q.all(
        `SELECT c.lat, c.lng FROM pickups p JOIN customers c ON c.id = p.customer_id
         WHERE p.vehicle_id = ? AND p.scheduled_date = ? AND p.status IN ('pending','collected','overdue')
         ORDER BY p.seq`, v.id, date);
      const deviationKm = insertionCost(route, { lat: pickup.lat, lng: pickup.lng });

      options.push({
        date, vehicle_id: v.id, fleet_number: v.fleet_number, zone: v.zone,
        current_load: dayLoad, capacity: v.max_daily_capacity,
        deviation_km: Math.round(deviationKm * 100) / 100,
      });
    }
  }

  // Step 4 — rank by lowest mileage deviation, then earliest date
  options.sort((a, b) => a.deviation_km - b.deviation_km || (a.date < b.date ? -1 : 1));
  return {
    pickup: {
      id: pickup.id, customer: pickup.customer_name, branch: pickup.branch,
      zone: pickup.zone, original_date: pickup.scheduled_date, status: pickup.status,
      anomaly_reason: pickup.anomaly_reason,
    },
    zone_relaxed: zoneRelaxed,
    options: options.slice(0, 3),
  };
}

// Step 5 — one-click dispatch
function apply(pickupId, date, vehicleId) {
  const pickup = q.get(`SELECT * FROM pickups WHERE id = ?`, pickupId);
  if (!pickup) return { error: 'Pickup not found' };
  const vehicle = q.get(`SELECT * FROM vehicles WHERE id = ?`, vehicleId);
  if (!vehicle) return { error: 'Vehicle not found' };
  const dayLoad = q.get(
    `SELECT COUNT(*) c FROM pickups WHERE vehicle_id = ? AND scheduled_date = ? AND status IN ('pending','collected','overdue')`,
    vehicleId, date).c;
  if (dayLoad >= vehicle.max_daily_capacity)
    return { error: `Conflict: ${vehicle.fleet_number} already at capacity (${vehicle.max_daily_capacity}) on ${date}` };

  const driver = q.get(`SELECT id FROM users WHERE role='driver' AND vehicle_id = ? AND is_active = 1`, vehicleId);

  // keep the original row as an audit trail, create the new stop
  q.run(`UPDATE pickups SET status = 'rescheduled', notes = COALESCE(notes,'') || ' → moved to ' || ?, updated_at = datetime('now') WHERE id = ?`,
    date, pickupId);
  q.run(`INSERT INTO pickups(customer_id, vehicle_id, driver_id, scheduled_date, status, notes)
         VALUES (?,?,?,?, 'pending', 'Rescheduled from ' || ?)`,
    pickup.customer_id, vehicleId, driver ? driver.id : null, date, pickup.scheduled_date);
  resortDay(date);

  const cust = q.get(`SELECT name, branch FROM customers WHERE id = ?`, pickup.customer_id);
  q.run(`INSERT INTO alerts(type, severity, message, pickup_id) VALUES ('RESCHEDULED','info',?,?)`,
    `${cust.name} (${cust.branch}) moved ${pickup.scheduled_date} → ${date} on ${vehicle.fleet_number}`, pickupId);

  return { ok: true, new_date: date, vehicle: vehicle.fleet_number };
}

module.exports = { recommend, apply };
