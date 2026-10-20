// ─────────────────────────────────────────────────────────────
// Database entry — MongoDB through Prisma.
//
// Everything database-related that the rest of the server needs is exported
// from here, so a module only has to write:
//
//   const { prisma, join, now } = require('./db');
//
// Connection string: DATABASE_URL in .env, e.g.
//   mongodb://127.0.0.1:27017/greenloop?replicaSet=rs0
// (Prisma needs MongoDB to run as a replica set — see docs/MONGODB-SETUP.md.)
// ─────────────────────────────────────────────────────────────
const bcrypt = require('bcryptjs');
const P = require('./prisma');
const { prisma } = P;

/**
 * Manual JOIN. MongoDB has no SQL JOIN, so we load the related documents in
 * ONE extra query (`id IN [...]`) and copy the fields we need onto each row.
 *
 *   rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone']);
 *   rows = await join(rows, 'vehicle_id', 'vehicle', { fleet_number: 'fleet_number' });
 *
 * fields: array (same names) or { outputName: 'fieldInRelatedDoc' }.
 * opts.inner = true drops rows with no match (SQL "JOIN"); default keeps them
 * with nulls (SQL "LEFT JOIN").
 */
async function join(rows, fk, delegate, fields, opts = {}) {
  const map = Array.isArray(fields) ? Object.fromEntries(fields.map(f => [f, f])) : fields;
  const ids = [...new Set(rows.map(r => r[fk]).filter(v => v != null))];
  const key = opts.key || 'id';
  const related = ids.length
    ? await prisma[delegate].findMany({ where: { [key]: { in: ids } }, select: { [key]: true, ...Object.fromEntries(Object.values(map).map(f => [f, true])) } })
    : [];
  const byKey = new Map(related.map(d => [d[key], d]));
  const out = [];
  for (const r of rows) {
    const d = byKey.get(r[fk]);
    if (!d && opts.inner) continue;
    for (const [as, f] of Object.entries(map)) r[as] = d ? d[f] ?? null : null;
    out.push(r);
  }
  return out;
}

/** Keep only these keys (like a SQL column list) — handy after a join. */
const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, row[k] ?? null]));

/** Group an array by a key function → Map key → rows[] (like SQL GROUP BY). */
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

/** Count rows per status → { collected, canceled, overdue, pending } (SUM(status='x')). */
function statusCounts(rows, statuses = ['collected', 'canceled', 'overdue', 'pending']) {
  const out = Object.fromEntries(statuses.map(s => [s, 0]));
  for (const r of rows) if (r.status in out) out[r.status]++;
  return out;
}

/** Compare like SQL ORDER BY: nulls first, then plain (binary) order. Use in Array.sort. */
const cmp = (a, b) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);
/** Sort by several keys: sortBy(rows, r => r.zone, r => r.name) — prefix a key with '-' via desc(). */
const desc = (fn) => Object.assign((r) => fn(r), { desc: true });
function sortBy(rows, ...keys) {
  return rows.sort((a, b) => { for (const k of keys) { const c = cmp(k(a), k(b)); if (c) return k.desc ? -c : c; } return 0; });
}

/** A URL/body id → Int, or null if it isn't a valid id (Prisma rejects "12" strings for Int fields). */
const toId = (v) => { const n = Number(v); return v !== '' && v != null && Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };
/** A number for a Float field, or null (SQLite stored NaN as NULL; Prisma would reject NaN). */
const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
/** A whole number for an Int field, or `fallback`. */
const int = (v, fallback = null) => { const n = Number(v); return v !== '' && v != null && Number.isInteger(n) && Math.abs(n) <= 2147483647 ? n : fallback; };
/** A text value for a String field (numbers become text), null stays null. */
const str = (v) => (v == null ? null : String(v));

/** findUnique by id that simply returns null for a bad id like "abc". */
async function findById(delegate, rawId, args = {}) {
  const id = toId(rawId);
  return id == null ? null : prisma[delegate].findUnique({ where: { id }, ...args });
}

/** First run only: demo trucks, drivers, admin and 36 supermarket customers. */
async function seed() {
  if (await prisma.user.findFirst({ select: { id: true } })) return false;
  await P.setSetting('shift_cutoff', '12:00');
  await P.setSetting('company_name', 'Majari / GreenLoop');
  await prisma.vehicle.createMany({
    data: [
      { fleet_number: 'TRUCK-01', plate: 'DXB A 71214', max_daily_capacity: 15, zone: 'Deira' },
      { fleet_number: 'TRUCK-02', plate: 'DXB B 33482', max_daily_capacity: 15, zone: 'Marina' },
    ],
  });
  await prisma.user.create({
    data: {
      full_name: 'Shahzad (Owner)', role: 'admin', username: 'admin',
      password_hash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10), phone: '+971500000001',
    },
  });
  const pins = { 'Ali Hassan': ['1111', 1], 'Ramesh Kumar': ['2222', 2], 'Joseph Mathew': ['3333', null] };
  for (const [name, [pin, veh]] of Object.entries(pins)) {
    await prisma.user.create({
      data: {
        full_name: name, role: 'driver', pin_hash: bcrypt.hashSync(pin, 10), vehicle_id: veh,
        phone: '+9715' + Math.floor(10000000 + Math.random() * 89999999),
      },
    });
  }
  const zones = {
    Deira: { lat: 25.2697, lng: 55.3094 },
    Marina: { lat: 25.0805, lng: 55.1403 },
    Downtown: { lat: 25.1972, lng: 55.2744 },
  };
  const brands = ['Al Madina Mart', 'Fresh Basket', 'City Grocer', 'Lulu Express', 'Nesto Mini', 'Day2Day',
    'Green Valley', 'Star Supermarket', 'Al Noor Foods', 'Sunrise Mart', 'Family Choice', 'Quick Stop'];
  const customers = [];
  let n = 0;
  for (const [zone, c] of Object.entries(zones)) {
    for (let i = 0; i < 12; i++) {
      customers.push({
        name: brands[(n + i) % brands.length], branch: `${zone} Branch ${i + 1}`, zone, frequency: (i % 3 === 0) ? 3 : 2,
        lat: c.lat + (Math.random() - 0.5) * 0.05, lng: c.lng + (Math.random() - 0.5) * 0.05,
        address: `${zone}, Street ${10 + i}, Dubai`, contact_phone: '+9714' + Math.floor(1000000 + Math.random() * 8999999),
      });
    }
    n++;
  }
  await prisma.customer.createMany({ data: customers });
  return true;
}

module.exports = { ...P, join, pick, groupBy, statusCounts, toId, num, int, str, findById, cmp, desc, sortBy, seed };
