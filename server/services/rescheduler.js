// ─────────────────────────────────────────────────────────────
// Intelligent Conflict-Free Rescheduling Engine (PRD §3.2)
//   1. Zone filtering   — only vehicles operating in the client's zone
//   2. Capacity check   — skip days where vehicle already ≥ max capacity
//   3. Distance dev.    — cheapest-insertion mileage deviation per option
//   4. Top-3 ranking    — lowest added mileage first
//   5. One-click apply  — moves the stop, re-sorts routes, notifies driver
// ─────────────────────────────────────────────────────────────
const { prisma, now } = require('../db');
const { insertionCost } = require('./geo');
const { resortDay } = require('./scheduler');
const { capacityFor } = require('../capacity');

const HORIZON_DAYS = 7;
const ACTIVE_LOAD = ['pending', 'collected', 'overdue'];

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function recommend(pickupId) {
  if (!Number.isInteger(pickupId)) return { error: 'Pickup not found' };
  const p = await prisma.pickup.findUnique({ where: { id: pickupId } });
  const cust = p ? await prisma.customer.findUnique({ where: { id: p.customer_id } }) : null;
  if (!p || !cust) return { error: 'Pickup not found' };
  const pickup = { ...p, zone: cust.zone, lat: cust.lat, lng: cust.lng, customer_name: cust.name, branch: cust.branch };

  // Step 1 — zone filtering
  let vehicles = await prisma.vehicle.findMany({ where: { is_active: 1, zone: pickup.zone }, orderBy: { id: 'asc' } });
  let zoneRelaxed = false;
  if (!vehicles.length) { vehicles = await prisma.vehicle.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' } }); zoneRelaxed = true; }

  const today = new Date().toISOString().slice(0, 10);
  const startFrom = pickup.scheduled_date > today ? pickup.scheduled_date : today;
  const options = [];

  for (let i = 1; i <= HORIZON_DAYS; i++) {
    const date = addDays(startFrom, i);
    for (const v of vehicles) {
      // Step 2 — capacity threshold analysis
      const dayLoad = await prisma.pickup.count({ where: { vehicle_id: v.id, scheduled_date: date, status: { in: ACTIVE_LOAD } } });
      const dayCap = await capacityFor(v, date);
      if (dayLoad >= dayCap) continue;

      // avoid same-day duplicate visit for this customer
      const dup = await prisma.pickup.findFirst({
        where: { customer_id: pickup.customer_id, scheduled_date: date, status: { in: ['pending', 'collected'] } },
        select: { id: true },
      });
      if (dup) continue;

      // Step 3 — proximity distance deviation (cheapest insertion into that day's route)
      const stops = await prisma.pickup.findMany({
        where: { vehicle_id: v.id, scheduled_date: date, status: { in: ACTIVE_LOAD } },
        select: { customer_id: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      });
      const pts = await prisma.customer.findMany({ where: { id: { in: stops.map(s => s.customer_id) } }, select: { id: true, lat: true, lng: true } });
      const at = new Map(pts.map(c => [c.id, c]));
      const route = stops.map(s => at.get(s.customer_id)).filter(Boolean);
      const deviationKm = insertionCost(route, { lat: pickup.lat, lng: pickup.lng });

      options.push({
        date, vehicle_id: v.id, fleet_number: v.fleet_number, zone: v.zone,
        current_load: dayLoad, capacity: dayCap,
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
async function apply(pickupId, date, vehicleId) {
  const pickup = Number.isInteger(pickupId) ? await prisma.pickup.findUnique({ where: { id: pickupId } }) : null;
  if (!pickup) return { error: 'Pickup not found' };
  const vehicle = Number.isInteger(vehicleId) ? await prisma.vehicle.findUnique({ where: { id: vehicleId } }) : null;
  if (!vehicle) return { error: 'Vehicle not found' };
  const dayLoad = await prisma.pickup.count({ where: { vehicle_id: vehicleId, scheduled_date: date, status: { in: ACTIVE_LOAD } } });
  const dayCap = await capacityFor(vehicle, date);
  if (dayLoad >= dayCap)
    return { error: `Conflict: ${vehicle.fleet_number} already at capacity (${dayCap}) on ${date}` };

  const driver = await prisma.user.findFirst({ where: { role: 'driver', vehicle_id: vehicleId, is_active: 1 }, select: { id: true }, orderBy: { id: 'asc' } });

  // keep the original document as an audit trail, create the new stop
  await prisma.pickup.update({
    where: { id: pickupId },
    data: { status: 'rescheduled', notes: (pickup.notes || '') + ' → moved to ' + date, updated_at: now() },
  });
  await prisma.pickup.create({
    data: {
      customer_id: pickup.customer_id, vehicle_id: vehicleId, driver_id: driver ? driver.id : null,
      scheduled_date: date, status: 'pending', notes: 'Rescheduled from ' + pickup.scheduled_date,
    },
  });
  await resortDay(date);

  const cust = await prisma.customer.findUnique({ where: { id: pickup.customer_id }, select: { name: true, branch: true } });
  await prisma.alert.create({
    data: {
      type: 'RESCHEDULED', severity: 'info', pickup_id: pickupId,
      message: `${cust.name} (${cust.branch}) moved ${pickup.scheduled_date} → ${date} on ${vehicle.fleet_number}`,
    },
  });

  return { ok: true, new_date: date, vehicle: vehicle.fleet_number };
}

module.exports = { recommend, apply };
