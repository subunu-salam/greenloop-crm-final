// ─────────────────────────────────────────────────────────────
// Daily capacity moderation (v3.2)
// A vehicle's capacity is no longer a fixed 15. Every engine asks
// capacityFor(vehicle, date), which returns the per-day override when the
// office has set one (truck in the workshop → 0, extra helper → 18) and
// otherwise the vehicle's own default (vehicles.max_daily_capacity).
// Collection: vehicle_capacity_overrides (unique per vehicle_id + date).
// ─────────────────────────────────────────────────────────────
const { prisma, now } = require('./db');

const MIN_CAPACITY = 0;
const MAX_CAPACITY = 60;
const ACTIVE_LOAD = ['pending', 'collected', 'overdue'];

function validCapacity(n) {
  return Number.isInteger(n) && n >= MIN_CAPACITY && n <= MAX_CAPACITY;
}

async function overrideFor(vehicleId, date) {
  return prisma.vehicleCapacityOverride.findUnique({
    where: { vehicle_id_date: { vehicle_id: Number(vehicleId), date } },   // compound unique key
  });
}

// vehicle: a document from `vehicles` (needs id + max_daily_capacity)
async function capacityFor(vehicle, date) {
  if (!vehicle) return 0;
  const o = date ? await overrideFor(vehicle.id, date) : null;
  return o ? o.capacity : vehicle.max_daily_capacity;
}

async function loadOf(vehicleId, date) {
  return prisma.pickup.count({ where: { vehicle_id: Number(vehicleId), scheduled_date: date, status: { in: ACTIVE_LOAD } } });
}

async function setOverride(vehicleId, date, capacity, reason, by) {
  await prisma.vehicleCapacityOverride.upsert({
    where: { vehicle_id_date: { vehicle_id: Number(vehicleId), date } },
    create: { vehicle_id: Number(vehicleId), date, capacity, reason: reason || null, set_by: by || null },
    update: { capacity, reason: reason || null, set_by: by || null, created_at: now() },
  });
}
async function clearOverride(vehicleId, date) {
  const r = await prisma.vehicleCapacityOverride.deleteMany({ where: { vehicle_id: Number(vehicleId), date } });
  return r.count;
}

module.exports = { capacityFor, overrideFor, setOverride, clearOverride, loadOf, validCapacity, MIN_CAPACITY, MAX_CAPACITY, ACTIVE_LOAD };
