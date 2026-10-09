// ─────────────────────────────────────────────────────────────
// SLA Time-Window Breach Monitor (PRD §3.3)
// Every 60 s: if past the shift cutoff and today's stops are still
// 'pending' → mark OVERDUE, raise a critical alert, push over WebSocket.
// ─────────────────────────────────────────────────────────────
const { q, getSetting } = require('./../db');

// v3.4.2: a stop that was added to today AFTER the cutoff (ad-hoc order, confirmed booking,
// rescheduled visit) is not a breach, so it no longer turns Overdue a minute after it is created.
// It stays pending for the rest of that day and turns Overdue the next morning if nobody did it.
const sqlUtc = s => Date.parse(String(s || '').replace(' ', 'T') + 'Z');          // SQLite datetime('now') is UTC
const cutoffAt = (ymd, cutoff) => new Date(`${ymd}T${cutoff}:00`).getTime();       // cutoff on the server clock, as before
function breach(io, l, cutoff, why) {
  q.run(`UPDATE pickups SET status = 'overdue', updated_at = datetime('now') WHERE id = ?`, l.id);
  const msg = `SLA BREACH: ${l.name} (${l.branch}) ${why} — vehicle ${l.fleet_number || 'unassigned'}`;
  q.run(`INSERT INTO alerts(type, severity, message, pickup_id) VALUES ('SLA_BREACH','critical',?,?)`, msg, l.id);
  if (io) io.to('staff').emit('alert', { type: 'SLA_BREACH', severity: 'critical', message: msg, pickup_id: l.id });
}
const SELECT = `SELECT p.id, p.created_at, p.scheduled_date, c.name, c.branch, v.fleet_number
     FROM pickups p
     JOIN customers c ON c.id = p.customer_id
     LEFT JOIN vehicles v ON v.id = p.vehicle_id`;

function checkNow(io) {
  const cutoff = getSetting('shift_cutoff', '12:00');
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  const today = now.toISOString().slice(0, 10);
  let breaches = 0, lateAdded = 0;

  // 1) stops added after the cutoff on an earlier day (last 7 days) that nobody completed
  const weekAgo = new Date(now.getTime() - 7 * 864e5).toISOString().slice(0, 10);
  for (const l of q.all(`${SELECT} WHERE p.scheduled_date < ? AND p.scheduled_date >= ? AND p.status = 'pending'`, today, weekAgo)) {
    const made = sqlUtc(l.created_at);                                // only stops created that same day, after its cutoff
    if (made >= cutoffAt(l.scheduled_date, cutoff) && made <= new Date(`${l.scheduled_date}T23:59:59.999`).getTime()) { breach(io, l, cutoff, `was added after the ${cutoff} cutoff on ${l.scheduled_date} and is still not done`); breaches++; }
  }

  // 2) today's stops that were already planned when the cutoff passed
  if (hhmm >= cutoff) {
    const cut = cutoffAt(today, cutoff);
    for (const l of q.all(`${SELECT} WHERE p.scheduled_date = ? AND p.status = 'pending'`, today)) {
      if (sqlUtc(l.created_at) >= cut) { lateAdded++; continue; }      // added after the cutoff: not a breach today
      breach(io, l, cutoff, `still pending after ${cutoff}`); breaches++;
    }
  }
  if (breaches && io) io.to('staff').emit('ledger:refresh', { date: today });
  return { breaches, cutoff, added_after_cutoff: lateAdded };
}

function start(io, intervalMs = 60_000) {
  setInterval(() => { try { checkNow(io); } catch (e) { console.error('SLA monitor error', e); } }, intervalMs);
}

module.exports = { start, checkNow };
