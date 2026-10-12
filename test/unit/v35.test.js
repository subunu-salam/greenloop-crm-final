// v3.5 — AI insights and performance reports (server/insights.js, GET /ai/*)
const { call, tok } = require('./harness');
const { q } = require('../../server/db');
const ins = require('../../server/insights');
const { fitForecast, localMinutes, windowEnd } = ins._internal;

const results = [];
const rec = (area, name, ok, note = '') => { results.push({ area, name, ok: !!ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${note ? ' → ' + note : ''}`); };
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const OPS = tok({ id: 1, role: 'admin', crm_role: 'ops', name: 'Ops' });
const dubaiToday = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

(async () => {
  // ── time handling ──
  rec('Time', 'Arrival times are read in Dubai time (08:15 UTC is 12:15)', localMinutes('2026-10-05T08:15:00.000Z') === 735 && localMinutes('2026-10-05 08:15:00') === 735, String(localMinutes('2026-10-05T08:15:00.000Z')));
  rec('Time', 'The window end comes from the stop\'s time window', windowEnd('07:00-12:00') === 720 && windowEnd('12:00-16:30') === 990 && windowEnd(null, 600) === 600);

  // ── demo data on an empty history ──
  const before = q.get(`SELECT COUNT(*) c FROM pickups`).c;
  let r = await call('GET', '/ai/insights', { token: A });
  const o = r.body;
  rec('Data', 'With little history the page uses demo data and says so', r.status === 200 && o.source === 'demo' && /demo data/i.test(o.note || ''), o.note);
  rec('Data', 'Demo data is never written to the database', q.get(`SELECT COUNT(*) c FROM pickups`).c === before, `${before} jobs before and after`);
  rec('Data', 'Asking for demo data explicitly works', (await call('GET', '/ai/insights?source=demo', { token: A })).body.source === 'demo');

  // ── forecast and confidence ──
  const f = o.forecast;
  rec('Forecast', '14 days forecast, each with a range around it', f.next.length === 14 && f.next.every(n => n.low <= n.predicted && n.predicted <= n.high), `${f.next[0].label}: ${f.next[0].low}–${f.next[0].high}`);
  rec('Forecast', 'AI confidence is measured on 14 days the model had not seen', f.backtest.length === 14 && f.confidence.accuracy >= 0 && f.confidence.accuracy <= 100 && ['High', 'Medium', 'Low'].includes(f.confidence.level), `${f.confidence.accuracy}% (${f.confidence.level})`);
  const series = []; for (let i = 0; i < 70; i++) { const d = addDays('2026-07-05', i); series.push({ date: d, n: Math.round((60 + i * 0.2) * [0.9, 1.1, 1, 1, 1.2, 0.6, 0.9][new Date(d + 'T00:00:00Z').getUTCDay()]) }); }
  const m = fitForecast(series.slice(0, 56)); const errs = series.slice(56).map((s, k) => Math.abs(s.n - m.predict(s.date, 56 + k)) / s.n);
  rec('Forecast', 'On a regular weekly pattern with growth the forecast is within 5%', Math.max(...errs) < 0.05, `worst day ${(100 * Math.max(...errs)).toFixed(1)}% off`);
  rec('Forecast', 'Days above fleet capacity are flagged with the trucks needed', f.next.every(n => n.over_capacity === (n.high > f.fleet.capacity) && n.trucks_needed >= 1));

  // ── driver delays ──
  const hot = o.delays.hotspots;
  rec('Delays', 'The planted pattern (one driver late in the Marina) is found', hot.some(h => h.driver === 'Ramesh Kumar' && h.key === 'Marina'), hot.map(h => `${h.driver} ${h.where} ${h.late_rate}%`).join('; '));
  rec('Delays', 'Every driver has an on-time rate, delay and score', o.delays.drivers.length === 5 && o.delays.drivers.every(d => d.on_time >= 0 && d.on_time <= 100 && d.score != null));
  rec('Delays', 'Weekday by zone heatmap covers every zone', o.delays.heatmap.length === 6 && o.delays.heatmap.every(z => z.days.length === 7));

  // ── risk model ──
  const rk = o.risk;
  rec('Risk', 'Tomorrow\'s stops are scored 0–100 and sorted', rk.stops.length > 0 && rk.stops.every((s, i) => s.risk >= 0 && s.risk <= 100 && (!i || rk.stops[i - 1].risk >= s.risk)), `${rk.total} stops, ${rk.high} high`);
  rec('Risk', 'Tested on the last 14 days, flagged stops are late more often than average', rk.check.lift > 1.2, rk.check.text);

  // ── recommendations ──
  const recs = o.recommendations;
  rec('Advice', 'Recommendations come with a confidence between 40% and 96%', recs.length >= 4 && recs.every(x => x.confidence >= 40 && x.confidence <= 96), `${recs.length} recommendations`);
  rec('Advice', 'Recommendation text is complete (no "undefined", "NaN" or "null")', !recs.some(x => /undefined|NaN|null/.test(x.title + x.detail + x.impact)));
  rec('Advice', 'Covers delays, capacity and wasted trips', ['Driver delays', 'Capacity', 'Route efficiency'].every(c => recs.some(x => x.category === c)), [...new Set(recs.map(x => x.category))].join(', '));

  // ── reports ──
  const d = (await call('GET', '/ai/reports/daily', { token: A })).body;
  rec('Reports', 'Daily report: yesterday, with a baseline and an AI summary', d.date === addDays(dubaiToday(), -1) && d.baseline.on_time != null && d.summary.length >= 3, d.summary[0]);
  const w = (await call('GET', '/ai/reports/weekly', { token: A })).body;
  rec('Reports', 'Weekly report: 7 days, change on the previous week, drivers ranked 1 to n', w.days.length === 7 && w.change.on_time != null && w.drivers.every((x, i) => x.rank === i + 1), w.summary[1]);
  const bad = (await call('GET', '/ai/reports/daily?date=<script>', { token: A })).body;
  rec('Reports', 'A bad date falls back to yesterday', bad.date === addDays(dubaiToday(), -1));

  // ── access ──
  const drv = await call('GET', '/ai/insights', { token: tok({ id: 2, role: 'driver', name: 'D' }) });
  const cus = await call('GET', '/ai/reports/weekly', { token: tok({ id: 1, role: 'customer', customer_id: 1 }) });
  const none = await call('GET', '/ai/insights', {});
  const ops = await call('GET', '/ai/insights', { token: OPS });
  rec('Access', 'Office staff (owner and operations) can open it; drivers, customers and visitors cannot', ops.status === 200 && drv.status === 403 && cus.status === 403 && none.status === 401, `ops ${ops.status}, driver ${drv.status}, customer ${cus.status}, no sign-in ${none.status}`);

  // ── live data ──
  // 8 weeks of finished jobs for the seeded customers; driver 1 is late on every 4th stop
  const cust = q.all(`SELECT id FROM customers WHERE is_active=1 ORDER BY id LIMIT 6`), drivers = q.all(`SELECT id, vehicle_id FROM users WHERE role='driver' ORDER BY id LIMIT 2`);
  let late = 0, done = 0, n = 0;
  q.run('BEGIN');
  for (let back = 56; back >= 1; back--) {
    const day = addDays(dubaiToday(), -back);
    for (let i = 0; i < 6; i++) {
      const dv = drivers[i % 2], isLate = dv === drivers[0] && n % 4 === 0; n++;
      const arrive = new Date(`${day}T${isLate ? '08:40' : '07:10'}:00Z`).toISOString();     // 12:40 or 11:10 in Dubai, window ends 12:00
      q.run(`INSERT INTO pickups(customer_id,vehicle_id,driver_id,scheduled_date,status,completed_at,arrived_at,time_window) VALUES (?,?,?,?,?,?,?,?)`, cust[i].id, dv.vehicle_id, dv.id, day, 'collected', arrive, arrive, '07:00-12:00');
      if (back <= 28) { done++; if (isLate) late++; }
    }
  }
  q.run('COMMIT');
  const live = (await call('GET', '/ai/insights', { token: A })).body;
  const expect = Math.round((1000 * (done - late)) / done) / 10;
  rec('Data', 'With enough history the page switches to your own data', live.source === 'live' && !live.note, `${done} finished jobs in 28 days`);
  rec('Data', 'On-time rate on your data matches a hand count', live.delays.fleet.on_time === expect, `${live.delays.fleet.on_time}% (expected ${expect}%)`);
  rec('Data', 'Late stops are measured in minutes past the window', live.delays.fleet.avg_delay === 40, `${live.delays.fleet.avg_delay} min (arrived 12:40, window ended 12:00)`);

  // ── speed ──
  const t0 = Date.now(); await call('GET', '/ai/insights?source=demo', { token: A }); const ms = Date.now() - t0;
  rec('Speed', 'The whole insights page is computed in under a second', ms < 1000, `${ms} ms`);

  const failed = results.filter(x => !x.ok).length;
  console.log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
