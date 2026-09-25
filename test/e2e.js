// End-to-end smoke test — boots the server in-process and exercises every flow.
// Run: node test/e2e.js
process.env.PORT = process.env.PORT || '3123';
process.env.DB_PATH = process.env.DB_PATH || require('os').tmpdir() + '/gl_e2e_' + Date.now() + '.sqlite';
require('../server/index.js');

const BASE = `http://localhost:${process.env.PORT}/api/v1`;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✔' : '✘ FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

const j = (r) => r.json();
const auth = t => ({ Authorization: 'Bearer ' + t });

(async () => {
  await new Promise(r => setTimeout(r, 800));

  // 1. Auth
  const bad = await fetch(BASE + '/auth/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
  ok('rejects wrong admin password', bad.status === 401);
  const admin = await j(await fetch(BASE + '/auth/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }));
  ok('admin login', !!admin.token);
  const badPin = await fetch(BASE + '/auth/driver-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '9999' }) });
  ok('rejects wrong PIN', badPin.status === 401);
  const drv = await j(await fetch(BASE + '/auth/driver-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1111' }) }));
  ok('driver PIN login', !!drv.token && drv.user.vehicle.fleet_number === 'TRUCK-01');

  // 2. Driver jobs
  const jobs = await j(await fetch(BASE + '/driver/jobs', { headers: auth(drv.token) }));
  ok('driver sees today\'s jobs', Array.isArray(jobs.jobs), `${jobs.jobs.length} stops on ${jobs.date}`);
  ok('jobs pre-sorted by seq', jobs.jobs.every((x, i, a) => !i || a[i - 1].seq <= x.seq));
  const [j1, j2] = jobs.jobs;

  // 2b. Progress stages: acknowledge
  const ack = await j(await fetch(`${BASE}/pickups/${j1.id}/ack`, { method: 'POST', headers: auth(drv.token) }));
  ok('driver acknowledges pickup', ack.ok === true && ack.stage === 'acknowledged');
  const jobs2 = await j(await fetch(BASE + '/driver/jobs', { headers: auth(drv.token) }));
  ok('stage visible in job list', jobs2.jobs.find(x => x.id === j1.id).stage === 'acknowledged');

  // 3. Complete with photo + telemetry
  const fd = new FormData();
  fd.append('photo', new Blob([Buffer.from('ffd8ffe0', 'hex')], { type: 'image/jpeg' }), 'proof.jpg');
  fd.append('lat', '25.2712'); fd.append('lng', '55.3123'); fd.append('client_ts', new Date().toISOString());
  const comp = await j(await fetch(`${BASE}/pickups/${j1.id}/complete`, { method: 'POST', headers: auth(drv.token), body: fd }));
  ok('photo completion', comp.ok === true && comp.status === 'collected');
  const noPhoto = await fetch(`${BASE}/pickups/${j2.id}/complete`, { method: 'POST', headers: auth(drv.token), body: new FormData() });
  ok('rejects completion without photo', noPhoto.status === 400);
  const dup = await fetch(`${BASE}/pickups/${j1.id}/complete`, { method: 'POST', headers: auth(drv.token), body: fd });
  ok('dedupes double-submit (409)', dup.status === 409);

  // 4. Cancel with anomaly reason
  const can = await j(await fetch(`${BASE}/pickups/${j2.id}/cancel`, { method: 'POST', headers: { ...auth(drv.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'MANAGER_REFUSED', lat: 25.27, lng: 55.31 }) }));
  ok('no-pickup cancellation', can.ok === true);

  // 5. Dashboard reflects both
  const dash = await j(await fetch(BASE + '/dashboard', { headers: auth(admin.token) }));
  ok('dashboard counts update', dash.today.collected >= 1 && dash.today.canceled >= 1, JSON.stringify(dash.today));
  ok('anomaly raised an alert', dash.unread_alerts >= 1);

  // 6. Rescheduling engine
  const opts = await j(await fetch(`${BASE}/reschedule/options/${j2.id}`, { headers: auth(admin.token) }));
  ok('engine returns ≤3 ranked options', opts.options.length > 0 && opts.options.length <= 3,
    opts.options.map(o => `${o.date} ${o.fleet_number} +${o.deviation_km}km load ${o.current_load}/${o.capacity}`).join(' | '));
  ok('options sorted by deviation', opts.options.every((o, i, a) => !i || a[i - 1].deviation_km <= o.deviation_km));
  ok('zone respected', opts.zone_relaxed || opts.options.every(o => o.zone === opts.pickup.zone));
  const best = opts.options[0];
  const applied = await j(await fetch(BASE + '/reschedule/apply', { method: 'POST', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ pickup_id: j2.id, date: best.date, vehicle_id: best.vehicle_id }) }));
  ok('one-click dispatch', applied.ok === true, `→ ${applied.new_date} on ${applied.vehicle}`);
  const pend = await j(await fetch(BASE + '/reschedule/pending', { headers: auth(admin.token) }));
  ok('handled stop leaves the queue', !pend.some(p => p.id === j2.id));

  // 7. Fleet load tracker & capacity
  const load = await j(await fetch(BASE + '/fleet/load?days=7', { headers: auth(admin.token) }));
  ok('fleet load tracker', load.length >= 2 && load[0].days.length === 7);
  ok('no day exceeds capacity', load.every(v => v.days.every(d => d.load <= d.capacity)));

  // 8. Onboard 3rd vehicle + rebalanced regeneration
  const v3 = await j(await fetch(BASE + '/vehicles', { method: 'POST', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ fleet_number: 'TRUCK-03', plate: 'DXB C 90118', zone: 'Downtown', max_daily_capacity: 15 }) }));
  ok('onboard TRUCK-03', v3.ok === true);
  const next = new Date(); next.setMonth(next.getMonth() + 1);
  const gen = await j(await fetch(BASE + '/schedule/generate', { method: 'POST', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ year: next.getFullYear(), month: next.getMonth() + 1 }) }));
  ok('next month generated with 3 trucks', gen.created > 0, `${gen.created} pickups`);
  const { q } = require('../server/db');
  const nm = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  const t3 = q.get(`SELECT COUNT(*) c FROM pickups p JOIN vehicles v ON v.id=p.vehicle_id WHERE v.fleet_number='TRUCK-03' AND p.scheduled_date LIKE ?`, nm + '%').c;
  ok('TRUCK-03 absorbed its zone', t3 > 0, `${t3} Downtown stops assigned`);
  const gaps = q.all(`SELECT customer_id, GROUP_CONCAT(scheduled_date) ds FROM pickups WHERE scheduled_date LIKE ? AND status='pending' GROUP BY customer_id`, nm + '%');
  const gapOk = gaps.every(g => { const ds = g.ds.split(',').sort().map(x => new Date(x)); return ds.every((d, i) => !i || (d - ds[i - 1]) / 864e5 >= 8 && (d - ds[i - 1]) / 864e5 <= 12); });
  ok('8–12 day visit gaps respected', gapOk);

  // 9. SLA breach flow (set cutoff to now → pending flips to overdue)
  await fetch(BASE + '/settings', { method: 'PUT', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ shift_cutoff: '00:00' }) });
  const sla = await j(await fetch(BASE + '/sla/check-now', { method: 'POST', headers: auth(admin.token) }));
  ok('SLA monitor flags overdue stops', sla.breaches > 0, `${sla.breaches} breach(es)`);
  await fetch(BASE + '/settings', { method: 'PUT', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ shift_cutoff: '12:00' }) });

  // 10. Users module
  const u = await j(await fetch(BASE + '/users', { method: 'POST', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name: 'New Driver', role: 'driver', pin: '7777', vehicle_id: 3 }) }));
  ok('create driver', u.ok === true);
  const clash = await fetch(BASE + '/users', { method: 'POST', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name: 'Dup', role: 'driver', pin: '7777' }) });
  ok('rejects duplicate PIN', clash.status === 409);
  const newLogin = await fetch(BASE + '/auth/driver-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7777' }) });
  ok('new driver can log in', newLogin.ok);

  // 11. Reports + CSV
  const compR = await j(await fetch(BASE + '/reports/compliance', { headers: auth(admin.token) }));
  ok('compliance report', compR.rows.length >= 36);
  const csv = await (await fetch(BASE + '/reports/ledger?format=csv', { headers: auth(admin.token) })).text();
  ok('CSV export', csv.startsWith('"id"') || csv.startsWith('id'), csv.split('\n')[0].slice(0, 60));
  const drvR = await j(await fetch(BASE + '/reports/drivers', { headers: auth(admin.token) }));
  ok('driver performance report', drvR.rows.some(r => r.collected >= 1));
  const anomR = await j(await fetch(BASE + '/reports/anomalies', { headers: auth(admin.token) }));
  ok('anomaly report', anomR.rows.some(r => r.reason === 'MANAGER_REFUSED'));

  // 11b. Bulk CSV import
  const csvBody = [
    'name,branch,zone,frequency,lat,lng,address,contact_phone',
    '"Carrefour, Mini","JBR 1",Marina,2,25.0790,55.1330,"JBR Walk, Dubai",+97141234567',
    'Spinneys Metro,DIFC 2,Downtown,3,25.2115,55.2751,DIFC Gate,+97147654321',
    'Spinneys Metro,DIFC 2,Downtown,3,25.2115,55.2751,DIFC Gate,+97147654321', // duplicate
    'Bad Client,X,Deira,5,25.28,55.31,,',                                       // bad frequency
  ].join('\n');
  const imp = await j(await fetch(BASE + '/customers/import', { method: 'POST', headers: { ...auth(admin.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: csvBody }) }));
  ok('CSV import: 2 in, 1 dup skipped, 1 rejected', imp.imported === 2 && imp.skipped === 1 && imp.errors.length === 1,
    JSON.stringify(imp));
  const clist = await j(await fetch(BASE + '/customers', { headers: auth(admin.token) }));
  ok('imported client with comma-in-name survived quoting', clist.some(c => c.name === 'Carrefour, Mini'));

  // 11c. Driver history + profile
  const hist = await j(await fetch(BASE + '/driver/history', { headers: auth(drv.token) }));
  ok('driver history shows completed + canceled', hist.some(h => h.status === 'collected') && hist.some(h => ['canceled', 'overdue'].includes(h.status)));
  const me = await j(await fetch(BASE + '/driver/me', { headers: auth(drv.token) }));
  ok('driver profile with vehicle + stats', me.vehicle.fleet_number === 'TRUCK-01' && me.stats.month_collected >= 1);

  // 11d. Stats overview for dashboard charts
  const todayStr = new Date().toISOString().slice(0, 10);
  const ov = await j(await fetch(`${BASE}/stats/overview?from=${todayStr}&to=${todayStr}`, { headers: auth(admin.token) }));
  ok('stats overview totals + series + zones + vehicles',
    ov.totals.scheduled >= 1 && Array.isArray(ov.series) && ov.zones.length >= 1 && ov.vehicles.length >= 1);
  ok('stats overview counts todays collection', ov.totals.collected >= 1);

  // 12. Security
  const noTok = await fetch(BASE + '/dashboard');
  ok('blocks unauthenticated access', noTok.status === 401);
  const drvOnAdmin = await fetch(BASE + '/dashboard', { headers: auth(drv.token) });
  ok('blocks driver from admin API', drvOnAdmin.status === 403);

  // 13. Static apps served
  const crm = await (await fetch(`http://localhost:${process.env.PORT}/crm/`)).text();
  ok('CRM app served', crm.includes('GreenLoop CRM'));
  const app = await (await fetch(`http://localhost:${process.env.PORT}/driver/`)).text();
  ok('Driver app served', app.includes('GreenLoop Driver') && app.includes('tabbar'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('✘ E2E crashed:', e); process.exit(1); });
