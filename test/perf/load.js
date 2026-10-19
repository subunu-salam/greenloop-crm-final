const http = require('http');
const { call, tok, prisma, v3, ready } = require('../unit/harness');
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = new Date().toISOString().slice(0, 10);
const zones = ['Deira', 'Marina', 'Downtown', 'JLT', 'Al Quoz'];
// Note: by default this measures the route code against the in-memory test database.
// For real MongoDB numbers run it with TEST_MONGO=1 (see scripts/test-mongo.js).
let t0, vIds = [], dIds = [], cIds = [], pk = 0;
async function seedData() {
  await ready;
  t0 = Date.now();
  // ---------- seed production-size data (bulk inserts) ----------
  for (let i = 0; i < 15; i++) {
    vIds.push((await prisma.vehicle.create({ data: { fleet_number: 'LT-' + (100 + i), plate: 'DXB ' + (5000 + i), zone: zones[i % 5], max_daily_capacity: 40, is_active: 1 } })).id);
    dIds.push((await prisma.user.create({ data: { full_name: 'Load Driver ' + i, role: 'driver', pin_hash: 'h:' + (7000 + i), vehicle_id: vIds[i], is_active: 1 } })).id);
  }
  for (let i = 0; i < 500; i++) cIds.push((await prisma.customer.create({ data: { name: 'Client ' + i, branch: 'Branch ' + (i % 9), zone: zones[i % 5], lat: 25.0 + (i % 50) / 500, lng: 55.1 + (i % 40) / 400, is_active: 1, frequency: 3 } })).id);
  const rows = [];
  for (let d = -90; d <= 14; d++) {
    const date = addDays(today, d);
    for (let i = 0; i < cIds.length; i++) {
      if ((i + d) % 2 !== 0) continue;               // ~250 jobs/day
      const v = i % 15, st = d < 0 ? (i % 17 === 0 ? 'canceled' : 'collected') : 'pending';
      rows.push({ customer_id: cIds[i], vehicle_id: vIds[v], driver_id: dIds[v], scheduled_date: date, status: st, service_type: 'WASTE', time_window: '07:00-12:00' }); pk++;
    }
  }
  for (let i = 0; i < rows.length; i += 5000) await prisma.pickup.createMany({ data: rows.slice(i, i + 5000) });
  // (indexes come from prisma/schema.prisma — `npx prisma db push` creates them in MongoDB)
  console.log(`seeded 500 customers, 15 trucks, ${pk} jobs in ${Date.now() - t0} ms`);
}
// ---------- HTTP server wrapping the real route handlers ----------
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    const r = await call(req.method, req.url.replace('/api/v1', ''), { token: (req.headers.authorization || '').slice(7) || undefined, body: body ? JSON.parse(body) : {} });
    const out = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(out);
  });
});
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
let D, C;
function hit(port, path, token, agent) {
  return new Promise((ok) => { const s = process.hrtime.bigint();
    const r = http.request({ port, path: '/api/v1' + path, headers: { authorization: 'Bearer ' + token }, agent }, (res) => { let n = 0; res.on('data', c => n += c.length); res.on('end', () => ok({ ms: Number(process.hrtime.bigint() - s) / 1e6, code: res.statusCode, bytes: n })); });
    r.on('error', () => ok({ ms: 0, code: 0, bytes: 0 })); r.end(); });
}
async function bench(port, name, path, token, conc = 25, durMs = 4000) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: conc }); const lat = []; let errs = 0, bytes = 0; const end = Date.now() + durMs;
  await Promise.all(Array.from({ length: conc }, async () => { while (Date.now() < end) { const r = await hit(port, path, token, agent); if (r.code !== 200) errs++; else { lat.push(r.ms); bytes = r.bytes; } } }));
  agent.destroy(); lat.sort((a, b) => a - b); const p = (x) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))] || 0;
  const rps = Math.round(lat.length / (durMs / 1000));
  return { name, rps, p50: +p(.5).toFixed(1), p95: +p(.95).toFixed(1), p99: +p(.99).toFixed(1), errs, kb: +(bytes / 1024).toFixed(1) };
}
seedData().then(() => { D = tok({ id: dIds[0], role: 'driver', name: 'Load Driver 0', vehicle_id: vIds[0] }); C = tok({ id: cIds[0], role: 'customer', customer_id: cIds[0], name: 'Client 0' }); srv.listen(0, async () => {
  const port = srv.address().port; const rows = [];
  const tests = [
    ['CRM dashboard', '/dashboard', A], ['CRM stats overview', '/stats/overview', A], ['Daily route ledger (today)', '/ledger?date=' + today, A],
    ['Fleet load tracker', '/fleet/load', A], ['Customers list', '/customers', A], ['Customer 360', '/customers/' + cIds[0] + '/360', A],
    ['Invoices list', '/invoices', A], ['Clients needing attention', '/attention', A], ['Pipeline stats', '/pipeline/stats', A],
    ['Driver jobs (today)', '/driver/jobs-v3', D], ['Customer history', '/customer/history-v3', C], ['Customer invoices', '/customer/invoices', C],
  ];
  for (const [n, p, t] of tests) { const r = await bench(port, n, p, t); rows.push(r); console.log(JSON.stringify(r)); }
  // stress: ramp concurrency on the heaviest common endpoint
  for (const c of [1, 10, 50, 100, 200]) { const r = await bench(port, 'ledger @' + c, '/ledger?date=' + today, A, c, 3000); console.log('RAMP', JSON.stringify(r)); }
  // nightly job: regenerate plans for the whole fleet
  await prisma.servicePlan.createMany({ data: cIds.slice(0, 300).map((cid) => ({ customer_id: cid, service_code: 'WASTE', recurrence: JSON.stringify({ type: 'weekly', days: [1, 3, 5] }), time_window: '07:00-12:00', start_date: today, unit_price: 150, billing: 'monthly', status: 'active' })) });
  let maxLag = 0, last = Date.now(); const lagT = setInterval(() => { const d = Date.now() - last - 5; if (d > maxLag) maxLag = d; last = Date.now(); }, 5);
  t0 = Date.now(); const g = await v3.generatePlansBatched({ days: 14 }); const gms = Date.now() - t0; clearInterval(lagT);
  console.log('NIGHTLY', JSON.stringify({ plans: g.plans, ms: gms, jobs: g.created, longest_freeze_ms: maxLag }));
  srv.close(); process.exit(0);
}); });
