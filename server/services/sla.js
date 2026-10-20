// ─────────────────────────────────────────────────────────────
// SLA Time-Window Breach Monitor (PRD §3.3)
// Every 60 s: if past the shift cutoff and today's stops are still
// 'pending' → mark OVERDUE, raise a critical alert, push over WebSocket.
// ─────────────────────────────────────────────────────────────
const { prisma, getSetting, join, now: nowText } = require('./../db');

// v3.4.2: a stop that was added to today AFTER the cutoff (ad-hoc order, confirmed booking,
// rescheduled visit) is not a breach, so it no longer turns Overdue a minute after it is created.
// It stays pending for the rest of that day and turns Overdue the next morning if nobody did it.
const sqlUtc = s => Date.parse(String(s || '').replace(' ', 'T') + 'Z');          // stored timestamps are UTC text
const cutoffAt = (ymd, cutoff) => new Date(`${ymd}T${cutoff}:00`).getTime();       // cutoff on the server clock, as before
async function breach(io, l, cutoff, why) {
  await prisma.pickup.update({ where: { id: l.id }, data: { status: 'overdue', updated_at: nowText() } });
  const msg = `SLA BREACH: ${l.name} (${l.branch}) ${why} — vehicle ${l.fleet_number || 'unassigned'}`;
  await prisma.alert.create({ data: { type: 'SLA_BREACH', severity: 'critical', message: msg, pickup_id: l.id } });
  if (io) io.to('staff').emit('alert', { type: 'SLA_BREACH', severity: 'critical', message: msg, pickup_id: l.id });
}
// pending stops (+ customer name/branch and fleet number) matching `where`
async function pendingStops(where) {
  let rows = await prisma.pickup.findMany({
    where: { ...where, status: 'pending' },
    select: { id: true, created_at: true, scheduled_date: true, customer_id: true, vehicle_id: true },
    orderBy: { id: 'asc' },
  });
  rows = await join(rows, 'customer_id', 'customer', ['name', 'branch'], { inner: true });
  return join(rows, 'vehicle_id', 'vehicle', ['fleet_number']);
}

async function checkNow(io) {
  const cutoff = await getSetting('shift_cutoff', '12:00');
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  const today = now.toISOString().slice(0, 10);
  let breaches = 0, lateAdded = 0;

  // 1) stops added after the cutoff on an earlier day (last 7 days) that nobody completed
  const weekAgo = new Date(now.getTime() - 7 * 864e5).toISOString().slice(0, 10);
  for (const l of await pendingStops({ scheduled_date: { lt: today, gte: weekAgo } })) {
    const made = sqlUtc(l.created_at);                                // only stops created that same day, after its cutoff
    if (made >= cutoffAt(l.scheduled_date, cutoff) && made <= new Date(`${l.scheduled_date}T23:59:59.999`).getTime()) { await breach(io, l, cutoff, `was added after the ${cutoff} cutoff on ${l.scheduled_date} and is still not done`); breaches++; }
  }

  // 2) today's stops that were already planned when the cutoff passed
  if (hhmm >= cutoff) {
    const cut = cutoffAt(today, cutoff);
    for (const l of await pendingStops({ scheduled_date: today })) {
      if (sqlUtc(l.created_at) >= cut) { lateAdded++; continue; }      // added after the cutoff: not a breach today
      await breach(io, l, cutoff, `still pending after ${cutoff}`); breaches++;
    }
  }
  if (breaches && io) io.to('staff').emit('ledger:refresh', { date: today });
  return { breaches, cutoff, added_after_cutoff: lateAdded };
}

function start(io, intervalMs = 60_000) {
  // .catch: a failed run (e.g. database briefly unreachable) is logged, the timer keeps going
  setInterval(() => { checkNow(io).catch(e => console.error('SLA monitor error', e)); }, intervalMs);
}

module.exports = { start, checkNow };
