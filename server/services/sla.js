// ─────────────────────────────────────────────────────────────
// SLA Time-Window Breach Monitor (PRD §3.3)
// Every 60 s: if past the shift cutoff and today's stops are still
// 'pending' → mark OVERDUE, raise a critical alert, push over WebSocket.
// ─────────────────────────────────────────────────────────────
const { q, getSetting } = require('./../db');

function checkNow(io) {
  const cutoff = getSetting('shift_cutoff', '12:00');
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  if (hhmm < cutoff) return { breaches: 0, cutoff };

  const today = now.toISOString().slice(0, 10);
  const late = q.all(
    `SELECT p.id, c.name, c.branch, v.fleet_number
     FROM pickups p
     JOIN customers c ON c.id = p.customer_id
     LEFT JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.scheduled_date = ? AND p.status = 'pending'`, today);

  for (const l of late) {
    q.run(`UPDATE pickups SET status = 'overdue', updated_at = datetime('now') WHERE id = ?`, l.id);
    const msg = `SLA BREACH: ${l.name} (${l.branch}) still pending after ${cutoff} — vehicle ${l.fleet_number || 'unassigned'}`;
    q.run(`INSERT INTO alerts(type, severity, message, pickup_id) VALUES ('SLA_BREACH','critical',?,?)`, msg, l.id);
    if (io) io.emit('alert', { type: 'SLA_BREACH', severity: 'critical', message: msg, pickup_id: l.id });
  }
  if (late.length && io) io.emit('ledger:refresh', { date: today });
  return { breaches: late.length, cutoff };
}

function start(io, intervalMs = 60_000) {
  setInterval(() => { try { checkNow(io); } catch (e) { console.error('SLA monitor error', e); } }, intervalMs);
}

module.exports = { start, checkNow };
