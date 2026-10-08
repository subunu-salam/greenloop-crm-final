const http = require('http');
const { call, tok, db, v3 } = require('../unit/harness'); const { q } = db;
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = new Date().toISOString().slice(0, 10);
const zones = ['Deira', 'Marina', 'Downtown', 'JLT', 'Al Quoz'];
// ---------- seed production-size data ----------
let t0 = Date.now();
q.run('BEGIN');
const vIds = [], dIds = [];
for (let i = 0; i < 15; i++) {
  vIds.push(q.run(`INSERT INTO vehicles(fleet_number,plate,zone,max_daily_capacity,is_active) VALUES (?,?,?,?,1)`, 'LT-' + (100 + i), 'DXB ' + (5000 + i), zones[i % 5], 40).lastInsertRowid);
  dIds.push(q.run(`INSERT INTO users(full_name,role,pin_hash,vehicle_id,is_active) VALUES (?,?,?,?,1)`, 'Load Driver ' + i, 'driver', 'h:' + (7000 + i), vIds[i]).lastInsertRowid);
}
const cIds = [];
for (let i = 0; i < 500; i++) cIds.push(q.run(`INSERT INTO customers(name,branch,zone,lat,lng,is_active,frequency) VALUES (?,?,?,?,?,1,3)`, 'Client ' + i, 'Branch ' + (i % 9), zones[i % 5], 25.0 + (i % 50) / 500, 55.1 + (i % 40) / 400).lastInsertRowid);
let pk = 0;
for (let d = -90; d <= 14; d++) {
  const date = addDays(today, d);
  for (let i = 0; i < cIds.length; i++) {
    if ((i + d) % 2 !== 0) continue;               // ~250 jobs/day
    const v = i % 15, st = d < 0 ? (i % 17 === 0 ? 'canceled' : 'collected') : 'pending';
    q.run(`INSERT INTO pickups(customer_id,vehicle_id,driver_id,scheduled_date,status,service_type,time_window) VALUES (?,?,?,?,?,'WASTE','07:00-12:00')`, cIds[i], vIds[v], dIds[v], date, st); pk++;
  }
}
q.run('COMMIT');
if (process.env.IDX === '1') { for (const sql of ['CREATE INDEX ix_p_cust ON pickups(customer_id, scheduled_date)','CREATE INDEX ix_p_drv ON pickups(driver_id, scheduled_date)','CREATE INDEX ix_p_veh ON pickups(vehicle_id, scheduled_date)','CREATE INDEX ix_p_done ON pickups(completed_at)','CREATE INDEX ix_p_date_st ON pickups(scheduled_date, status)']) q.run(sql); console.log('VARIANT B: +5 indexes'); } else console.log('VARIANT A: current indexes');
console.log(`seeded 500 customers, 15 trucks, ${pk} jobs in ${Date.now() - t0} ms`);
// ---------- HTTP server wrapping the real route handlers ----------
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    const r = await call(req.method, req.url.replace('/api/v1', ''), { token: (req.headers.authorization || '').slice(7) || undefined, body: body ? JSON.parse(body) : {} });
    const out = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(out);
  });
});
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const D = tok({ id: dIds[0], role: 'driver', name: 'Load Driver 0', vehicle_id: vIds[0] });
const C = tok({ id: cIds[0], role: 'customer', customer_id: cIds[0], name: 'Client 0' });
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
srv.listen(0, async () => {
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
  const plansBefore = q.get('SELECT COUNT(*) c FROM service_plans').c;
  q.run('BEGIN'); for (let i = 0; i < 300; i++) q.run(`INSERT INTO service_plans(customer_id,service_code,recurrence,time_window,start_date,unit_price,billing,status) VALUES (?,?,?,?,?,?,?,?)`, cIds[i], 'WASTE', JSON.stringify({ type: 'weekly', days: [1, 3, 5] }), '07:00-12:00', today, 150, 'monthly', 'active'); q.run('COMMIT');
  let maxLag = 0, last = Date.now(); const lagT = setInterval(() => { const d = Date.now() - last - 5; if (d > maxLag) maxLag = d; last = Date.now(); }, 5);
  t0 = Date.now(); const g = await v3.generatePlansBatched({ days: 14 }); const gms = Date.now() - t0; clearInterval(lagT);
  console.log('NIGHTLY', JSON.stringify({ plans: g.plans, ms: gms, jobs: g.created, longest_freeze_ms: maxLag }));
  const sz = require('fs').statSync(process.env.DB_PATH).size; console.log('DBSIZE_MB', (sz / 1048576).toFixed(1));
  srv.close(); process.exit(0);
});
