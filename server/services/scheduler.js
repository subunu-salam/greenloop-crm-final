// ─────────────────────────────────────────────────────────────
// Mandatory Frequency Scheduler (PRD §3.1)
// Generates each customer's 2–3 monthly visits with 8–12 day gaps,
// balances daily vehicle load (≤ capacity), assigns vehicle by zone,
// and pre-sorts each day's route geographically for the driver app.
// ─────────────────────────────────────────────────────────────
const { prisma } = require('../db');
const { orderRoute } = require('./geo');
const { capacityFor } = require('../capacity');

const MIN_GAP = 8, MAX_GAP = 12;
const ACTIVE_LOAD = ['pending', 'collected', 'overdue'];

function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function dstr(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

function pickVehicle(zone, vehicles) {
  return vehicles.find(v => v.zone === zone) || null;
}

async function generateMonth(year, month, { force = false } = {}) {
  const first = dstr(year, month, 1), last = dstr(year, month, daysInMonth(year, month));
  const inMonth = { gte: first, lte: last };                    // SQL: BETWEEN first AND last
  const existing = await prisma.pickup.count({ where: { scheduled_date: inMonth } });
  if (existing > 0 && !force) return { created: 0, skipped: true, existing };
  if (force) await prisma.pickup.deleteMany({ where: { scheduled_date: inMonth, status: 'pending' } });

  const vehicles = await prisma.vehicle.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' } });
  const drivers = await prisma.user.findMany({ where: { role: 'driver', is_active: 1 }, orderBy: { id: 'asc' } });
  // customers on a recurring service plan are scheduled by the v3 recurrence engine instead
  const planned = await prisma.servicePlan.findMany({ where: { status: 'active' }, select: { customer_id: true }, distinct: ['customer_id'] });
  const customers = await prisma.customer.findMany({
    where: { is_active: 1, id: { notIn: planned.map(p => p.customer_id) } }, orderBy: { id: 'asc' },
  });
  const dim = daysInMonth(year, month);

  // load[vehicleId][day] = stop count
  const load = {};
  vehicles.forEach(v => { load[v.id] = new Array(dim + 1).fill(0); });
  // count pre-existing (non-canceled) stops — groupBy is Prisma's GROUP BY
  const groups = await prisma.pickup.groupBy({
    by: ['vehicle_id', 'scheduled_date'],
    where: { scheduled_date: inMonth, status: { in: ACTIVE_LOAD } },
    _count: { _all: true },
  });
  groups.forEach(r => { if (load[r.vehicle_id]) load[r.vehicle_id][Number(r.scheduled_date.slice(8))] += r._count._all; });

  // per-day capacity: the vehicle default unless the office set an override for that date
  const caps = new Map();
  for (const v of vehicles) for (let d = 1; d <= dim; d++) caps.set(v.id + ':' + d, await capacityFor(v, dstr(year, month, d)));
  const capOn = (v, day) => caps.get(v.id + ':' + day);
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
    for (const d of candidates) if (load[vehicle.id][d] < capOn(vehicle, d)) return d;
    return null;
  }

  const toInsert = [];
  if (vehicles.length) for (const c of customers) {
    let vehicle = pickVehicle(c.zone, vehicles);
    const gaps = c.frequency === 3 ? [9, 10] : [10];   // 8–12 window respected via ±2 shift
    let day = 2 + Math.floor(Math.random() * 6);       // first visit: day 2–7
    let prev = 0;
    for (let visit = 0; visit < c.frequency; visit++) {
      const veh = vehicle || fallbackVehicle(Math.min(day, dim));
      const placed = placeDay(veh, Math.min(day, dim - 1), prev + (visit ? MIN_GAP - 1 : 0));
      if (placed == null) break;
      const driver = drivers.find(dr => dr.vehicle_id === veh.id) || drivers[0];
      toInsert.push({ customer_id: c.id, vehicle_id: veh.id, driver_id: driver ? driver.id : null, scheduled_date: dstr(year, month, placed), status: 'pending' });
      load[veh.id][placed]++;
      prev = placed;
      day = placed + (gaps[Math.min(visit, gaps.length - 1)] || 10);
      if (day > dim) break;
    }
  }
  // one round-trip for the whole month instead of one INSERT per stop
  if (toInsert.length) await prisma.pickup.createMany({ data: toInsert });

  // Geographic pre-sort (seq) per vehicle per day
  for (let d = 1; d <= dim; d++) await resortDay(dstr(year, month, d));
  return { created: toInsert.length, skipped: false };
}

// Re-order a day's stops per vehicle with nearest-neighbour heuristic
async function resortDay(date) {
  const stops = await prisma.pickup.findMany({
    where: { scheduled_date: date, status: { in: ACTIVE_LOAD } },
    select: { id: true, vehicle_id: true, customer_id: true },
    orderBy: { id: 'asc' },
  });
  if (!stops.length) return;
  const custs = await prisma.customer.findMany({ where: { id: { in: [...new Set(stops.map(s => s.customer_id))] } }, select: { id: true, lat: true, lng: true } });
  const where = new Map(custs.map(c => [c.id, c]));
  const byVehicle = new Map();
  for (const s of stops) {
    const c = where.get(s.customer_id);
    if (!c) continue;                                      // SQL inner JOIN: skip stops without a customer
    if (!byVehicle.has(s.vehicle_id)) byVehicle.set(s.vehicle_id, []);
    byVehicle.get(s.vehicle_id).push({ id: s.id, lat: c.lat, lng: c.lng });
  }
  for (const list of byVehicle.values()) {
    const ordered = orderRoute(list);
    // the updates are independent, so send them in parallel
    await Promise.all(ordered.map((s, i) => prisma.pickup.update({ where: { id: s.id }, data: { seq: i + 1 } })));
  }
}

module.exports = { generateMonth, resortDay };
