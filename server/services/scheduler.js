// ─────────────────────────────────────────────────────────────
// Mandatory Frequency Scheduler (PRD §3.1)
// Generates each customer's 2–3 monthly visits with 8–12 day gaps,
// balances daily vehicle load (≤ capacity), assigns vehicle by zone,
// and pre-sorts each day's route geographically for the driver app.
// ─────────────────────────────────────────────────────────────
const { q } = require('../db');
const { orderRoute } = require('./geo');

const MIN_GAP = 8, MAX_GAP = 12;

function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function dstr(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

function pickVehicle(zone, vehicles) {
  return vehicles.find(v => v.zone === zone) || null;
}

function generateMonth(year, month, { force = false } = {}) {
  const first = dstr(year, month, 1), last = dstr(year, month, daysInMonth(year, month));
  const existing = q.get(
    `SELECT COUNT(*) AS c FROM pickups WHERE scheduled_date BETWEEN ? AND ?`, first, last).c;
  if (existing > 0 && !force) return { created: 0, skipped: true, existing };
  if (force) q.run(`DELETE FROM pickups WHERE scheduled_date BETWEEN ? AND ? AND status = 'pending'`, first, last);

  const vehicles = q.all(`SELECT * FROM vehicles WHERE is_active = 1`);
  const drivers = q.all(`SELECT * FROM users WHERE role='driver' AND is_active=1`);
  const customers = q.all(`SELECT * FROM customers WHERE is_active = 1`);
  const dim = daysInMonth(year, month);

  // load[vehicleId][day] = stop count
  const load = {};
  vehicles.forEach(v => { load[v.id] = new Array(dim + 1).fill(0); });
  // count pre-existing (non-canceled) stops
  q.all(`SELECT vehicle_id, scheduled_date, COUNT(*) c FROM pickups
         WHERE scheduled_date BETWEEN ? AND ? AND status IN ('pending','collected','overdue')
         GROUP BY vehicle_id, scheduled_date`, first, last)
    .forEach(r => { if (load[r.vehicle_id]) load[r.vehicle_id][Number(r.scheduled_date.slice(8))] += r.c; });

  const cap = Object.fromEntries(vehicles.map(v => [v.id, v.max_daily_capacity]));
  const fallbackVehicle = (day) => vehicles.reduce((a, b) => (load[a.id][day] <= load[b.id][day] ? a : b));

  // Choose best day near target with lowest load & free capacity
  function placeDay(vehicle, target, day0) {
    const candidates = [];
    for (let off = -2; off <= 2; off++) {
      const d = target + off;
      if (d < 1 || d > dim || d <= day0) continue;
      candidates.push(d);
    }
    candidates.sort((a, b) => load[vehicle.id][a] - load[vehicle.id][b] || Math.abs(a - target) - Math.abs(b - target));
    for (const d of candidates) if (load[vehicle.id][d] < cap[vehicle.id]) return d;
    return null;
  }

  let created = 0;
  const ins = require('../db').db.prepare(
    `INSERT INTO pickups(customer_id, vehicle_id, driver_id, scheduled_date, status) VALUES (?,?,?,?, 'pending')`);

  for (const c of customers) {
    let vehicle = pickVehicle(c.zone, vehicles);
    const gaps = c.frequency === 3 ? [9, 10] : [10];   // 8–12 window respected via ±2 shift
    let day = 2 + Math.floor(Math.random() * 6);       // first visit: day 2–7
    let prev = 0;
    for (let visit = 0; visit < c.frequency; visit++) {
      const veh = vehicle || fallbackVehicle(Math.min(day, dim));
      const placed = placeDay(veh, Math.min(day, dim - 1), prev + (visit ? MIN_GAP - 1 : 0));
      if (placed == null) break;
      const driver = drivers.find(dr => dr.vehicle_id === veh.id) || drivers[0];
      ins.run(c.id, veh.id, driver ? driver.id : null, dstr(year, month, placed));
      load[veh.id][placed]++;
      created++;
      prev = placed;
      day = placed + (gaps[Math.min(visit, gaps.length - 1)] || 10);
      if (day > dim) break;
    }
  }

  // Geographic pre-sort (seq) per vehicle per day
  for (let d = 1; d <= dim; d++) resortDay(dstr(year, month, d));
  return { created, skipped: false };
}

// Re-order a day's stops per vehicle with nearest-neighbour heuristic
function resortDay(date) {
  const vehicles = q.all(`SELECT DISTINCT vehicle_id AS id FROM pickups WHERE scheduled_date = ?`, date);
  for (const { id } of vehicles) {
    const stops = q.all(
      `SELECT p.id, c.lat, c.lng FROM pickups p JOIN customers c ON c.id = p.customer_id
       WHERE p.scheduled_date = ? AND p.vehicle_id = ? AND p.status IN ('pending','collected','overdue')`, date, id);
    if (!stops.length) continue;
    const ordered = orderRoute(stops);
    ordered.forEach((s, i) => q.run(`UPDATE pickups SET seq = ? WHERE id = ?`, i + 1, s.id));
  }
}

module.exports = { generateMonth, resortDay };
