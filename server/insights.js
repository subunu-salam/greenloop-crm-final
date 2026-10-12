// ─────────────────────────────────────────────────────────────
// GreenLoop AI insights (v3.5)
//
// Predictive analysis on the job history, computed on request:
//   • driver delays: who is late, where, on which days, and why
//   • delay risk for tomorrow's stops (a small Bayesian model trained on the history)
//   • daily and weekly performance reports against a baseline
//   • a 14-day demand forecast with an AI confidence level, measured by
//     forecasting the last 14 days from the data before them and comparing with what happened
//   • recommendations, each with its own confidence
//
// Source of data: the real pickups table when it holds enough history (150 closed
// jobs in 28 days). Otherwise a realistic demo dataset is generated in memory and the
// response says so (source: "demo"). The demo data is never written to the database.
//
// Times: Dubai local time (UTC+4, no daylight saving).
// ─────────────────────────────────────────────────────────────
const { q } = require('./db');

const TZ_MIN = 240;                        // Dubai = UTC+4
const GRACE = 10;                          // minutes after the window before a stop counts as late
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const REASON_TEXT = { BIN_EMPTY: 'bin empty', NO_WASTE: 'no waste', CLOSED: 'site closed', NO_ACCESS: 'no access', ACCESS_BLOCKED: 'access blocked', CUSTOMER_REFUSED: 'customer refused', MANAGER_REFUSED: 'manager refused' };

// ── small helpers ────────────────────────────────────────────
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const round1 = x => Math.round(x * 10) / 10;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => (a.length ? sum(a) / a.length : 0);
const quantile = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1)); };
const dubaiNow = () => new Date(Date.now() + TZ_MIN * 60000);
const todayLocal = () => dubaiNow().toISOString().slice(0, 10);
function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const dowOf = d => new Date(d + 'T00:00:00Z').getUTCDay();
const fmtDay = d => `${DOW[dowOf(d)]} ${Number(d.slice(8, 10))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1]}`;
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
function localMinutes(iso) {
  if (!iso) return null;
  const s = String(iso).includes('T') || String(iso).endsWith('Z') ? String(iso) : String(iso).replace(' ', 'T') + 'Z';
  const t = Date.parse(s.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  if (isNaN(t)) return null;
  const d = new Date(t + TZ_MIN * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function windowEnd(tw, fallback = 720) {
  const m = /(\d{1,2}):(\d{2})\s*$/.exec(String(tw || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}
// deterministic pseudo-random numbers for the demo data (same data on every call of the day)
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── data: live ───────────────────────────────────────────────
function liveJobs(from, to) {
  let cutoff = 720;
  try { const s = q.get(`SELECT value FROM settings WHERE key='shift_cutoff'`); if (s && /^\d{1,2}:\d{2}$/.test(s.value)) cutoff = windowEnd(s.value); } catch { /* old database */ }
  const rows = q.all(`SELECT p.id, p.scheduled_date d, p.status, p.anomaly_reason reason, p.time_window tw, p.arrived_at, p.completed_at,
      p.driver_id, u.full_name driver, v.fleet_number truck, p.vehicle_id, c.zone, c.name customer, c.branch, c.id cid, p.service_type service
    FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.driver_id LEFT JOIN vehicles v ON v.id=p.vehicle_id
    WHERE p.scheduled_date BETWEEN ? AND ? AND p.status != 'rescheduled'`, from, to);
  return rows.map(r => normalise({ ...r, end: windowEnd(r.tw, cutoff), actual: localMinutes(r.arrived_at || r.completed_at) }));
}
function liveFleet() {
  const v = q.all(`SELECT fleet_number, max_daily_capacity cap FROM vehicles WHERE is_active=1`);
  return { trucks: v.length, capacity: sum(v.map(x => Number(x.cap) || 15)) || 15 * Math.max(1, v.length), perTruck: v.length ? Math.round(sum(v.map(x => Number(x.cap) || 15)) / v.length) : 15 };
}

function normalise(r) {
  const done = r.status === 'collected';
  const delay = done && r.actual != null ? Math.max(0, r.actual - r.end) : null;
  return {
    id: r.id, date: r.d, dow: dowOf(r.d), status: r.status, reason: r.reason || null,
    driver: r.driver || 'Unassigned', truck: r.truck || '—', zone: r.zone || '—', customer: r.customer || '—', branch: r.branch || '', cid: r.cid,
    service: r.service || 'WASTE', end: r.end, actual: r.actual, delay,
    late: done && delay != null && delay > GRACE, missed: r.status === 'overdue', npu: r.status === 'canceled',
  };
}

// ── data: demo ───────────────────────────────────────────────
// Five trucks across Dubai with patterns a real fleet shows: one driver struggles in the
// Marina in the afternoon, Thursdays are congested, Deira early windows are tight, one driver
// is improving week on week, a handful of sites keep reporting an empty bin, and two sites
// are often closed on Fridays. Volume grows slowly over the ten weeks.
function demoData(today) {
  const R = rng(Number(today.replace(/-/g, '')));
  const drivers = [
    { name: 'Ali Hassan', truck: 'TRUCK-01', skill: 0.08 },
    { name: 'Ramesh Kumar', truck: 'TRUCK-02', skill: 0.13 },
    { name: 'Joseph Mathew', truck: 'TRUCK-03', skill: 0.10 },
    { name: 'Imran Sheikh', truck: 'TRUCK-04', skill: 0.24, improving: true },
    { name: 'Vijay Nair', truck: 'TRUCK-05', skill: 0.06 },
  ];
  const zones = ['Deira', 'Marina', 'Downtown', 'JLT', 'Al Quoz', 'Business Bay'];
  const brands = ['Carrefour', 'Spinneys', 'Choithrams', 'Lulu', 'Waitrose', 'Union Coop', 'Nesto', 'Grandiose', 'Viva', 'Al Maya'];
  const customers = [];
  for (let i = 0; i < 120; i++) {
    const zone = zones[i % zones.length];
    customers.push({ cid: 9000 + i, name: brands[i % brands.length], branch: `${zone} ${Math.floor(i / zones.length) + 1}`, zone,
      driver: drivers[(i + Math.floor(i / 7)) % drivers.length], tw: ['07:00-10:00', '07:00-12:00', '08:00-12:00', '12:00-16:00'][Math.floor(R() * 4)],
      emptyBin: [3, 17, 44, 61, 88, 102].includes(i), fridayClosed: [25, 70].includes(i), weight: 0.45 + R() * 0.55 });
  }
  const jobs = [], future = [];
  let id = 1;
  for (let back = 70; back >= -14; back--) {
    const d = addDays(today, -back), dow = dowOf(d);
    const growth = 1 + (70 - back) * 0.004;
    const dayFactor = [0.95, 1.05, 1.0, 1.0, 1.12, 0.62, 0.9][dow];
    for (const c of customers) {
      if (R() > c.weight * dayFactor * growth * 0.62) continue;
      const drv = c.driver, end = windowEnd(c.tw);
      const job = { id: id++, d, driver: drv.name, truck: drv.truck, zone: c.zone, customer: c.name, branch: c.branch, cid: c.cid, service: R() < 0.12 ? 'PEST_GENERAL' : 'WASTE', tw: c.tw, end };
      if (back <= 0) {                                       // today and the next 14 days: planned
        future.push(normalise({ ...job, status: 'pending', actual: null }));
        continue;
      }
      // what happened
      let pLate = drv.skill;
      if (drv.name === 'Ramesh Kumar' && c.zone === 'Marina') pLate += 0.30;
      if (drv.improving) pLate -= (70 - back) * 0.0022;         // ~15 points better over ten weeks
      if (dow === 4) pLate += 0.12;                             // Thursday traffic
      if (c.zone === 'Deira' && end <= 600) pLate += 0.14;      // tight early windows in Deira
      if (end >= 960) pLate += 0.05;
      let status = 'collected', reason = null;
      if (c.emptyBin && R() < 0.42) { status = 'canceled'; reason = 'BIN_EMPTY'; }
      else if (c.fridayClosed && dow === 5 && R() < 0.65) { status = 'canceled'; reason = 'CLOSED'; }
      else if (R() < 0.025) { status = 'canceled'; reason = ['NO_ACCESS', 'ACCESS_BLOCKED', 'CUSTOMER_REFUSED'][Math.floor(R() * 3)]; }
      else if (R() < Math.max(0, pLate) * 0.08) { status = 'overdue'; }
      let actual = null;
      if (status === 'collected') {
        const late = R() < Math.max(0.01, pLate);
        actual = late ? end + GRACE + 3 + Math.round(-Math.log(1 - R()) * 22) : end - 20 - Math.round(R() * 140);
        actual = Math.max(360, actual);
      }
      jobs.push(normalise({ ...job, status, reason, actual }));
    }
  }
  return { jobs, future: future.filter(f => f.date >= today), fleet: { trucks: 5, capacity: 5 * 17, perTruck: 17 } };
}

// ── loading ──────────────────────────────────────────────────
function load(source = 'auto') {
  const today = todayLocal();
  if (source !== 'demo') {
    const jobs = liveJobs(addDays(today, -70), addDays(today, -1));
    const closed28 = jobs.filter(j => j.date >= addDays(today, -28) && j.status !== 'pending').length;
    if (source === 'live' || closed28 >= 150) {
      const future = liveJobs(today, addDays(today, 14)).filter(j => j.status === 'pending' || j.status === 'overdue');
      return { source: 'live', today, jobs: jobs.filter(j => j.status !== 'pending'), future, fleet: liveFleet(), closed28 };
    }
    const d = demoData(today);
    return { source: 'demo', today, ...d, closed28, note: `Your data has ${closed28} finished jobs in the last 28 days; insights need about 150, so this view uses demo data until then.` };
  }
  return { source: 'demo', today, ...demoData(today), note: 'Demo data.' };
}

// ── measures ─────────────────────────────────────────────────
function kpis(js) {
  const done = js.filter(j => j.status === 'collected'), np = js.filter(j => j.npu).length, missed = js.filter(j => j.missed).length;
  const closed = done.length + np + missed, late = done.filter(j => j.late);
  return {
    stops: js.length, collected: done.length, no_pickup: np, missed,
    completion: pct(done.length, closed), on_time: pct(done.length - late.length, done.length),
    late: late.length, avg_delay: late.length ? Math.round(mean(late.map(j => j.delay))) : 0,
    p90_delay: late.length ? Math.round(quantile(late.map(j => j.delay), 0.9)) : 0,
  };
}
const inRange = (js, a, b) => js.filter(j => j.date >= a && j.date <= b);
const groupBy = (js, f) => { const m = new Map(); for (const j of js) { const k = f(j); if (!m.has(k)) m.set(k, []); m.get(k).push(j); } return m; };
// driver score 0–100: on time 50%, completion 30%, few no-pickups 20%
function score(k) {
  if (!k.collected) return null;
  return Math.round(0.5 * (k.on_time ?? 0) + 0.3 * (k.completion ?? 0) + 0.2 * (100 - pct(k.no_pickup, k.stops || 1)));
}
// confidence for a finding from its sample size and how big the effect is
const confidence = (n, effect) => Math.max(40, Math.min(96, Math.round(50 + 46 * (1 - Math.exp(-n / 25)) * Math.min(1, Math.abs(effect) / 0.25))));

// ── driver delays ────────────────────────────────────────────
function driverDelays(D) {
  const end = addDays(D.today, -1), from28 = addDays(D.today, -28), from14 = addDays(D.today, -14), from7 = addDays(D.today, -7);
  const recent = inRange(D.jobs, from28, end);
  const fleet = kpis(recent);
  const drivers = [...groupBy(recent, j => j.driver)].map(([name, js]) => {
    const k = kpis(js), a = kpis(inRange(js, from14, addDays(D.today, -8))), b = kpis(inRange(js, from7, end));
    return { driver: name, truck: js[0].truck, ...k, score: score(k), on_time_prev_week: a.on_time, on_time_last_week: b.on_time,
      trend: a.on_time != null && b.on_time != null ? round1(b.on_time - a.on_time) : null };
  }).sort((x, y) => (y.score ?? 0) - (x.score ?? 0));

  // hotspots: driver × zone and driver × weekday cells far above that driver's own late rate
  const hotspots = [];
  for (const d of drivers) {
    const mine = recent.filter(j => j.driver === d.driver && j.status === 'collected');
    const base = mine.filter(j => j.late).length / (mine.length || 1);
    for (const [kind, f, label] of [['zone', j => j.zone, k => `in ${k}`], ['day', j => j.dow, k => `on ${DOW_LONG[k]}s`], ['window', j => (j.end <= 600 ? 'early' : j.end >= 960 ? 'afternoon' : 'midday'), k => `on ${k} windows`]]) {
      for (const [key, js] of groupBy(mine, f)) {
        if (js.length < 8) continue;
        const r = js.filter(j => j.late).length / js.length;
        if (r - base >= 0.15 && r >= base * 1.5) {
          const late = js.filter(j => j.late);
          hotspots.push({ driver: d.driver, kind, key: String(key), where: label(key), late_rate: pct(late.length, js.length), driver_rate: pct(base * mine.length, mine.length),
            stops: js.length, avg_delay: Math.round(mean(late.map(j => j.delay))), effect: r - base, confidence: confidence(js.length, r - base) });
        }
      }
    }
  }
  hotspots.sort((a, b) => b.effect * Math.sqrt(b.stops) - a.effect * Math.sqrt(a.stops));

  // fleet heatmap: weekday × zone late rate
  const zones = [...new Set(recent.map(j => j.zone))].sort();
  const done = recent.filter(j => j.status === 'collected');
  const heat = zones.map(z => ({ zone: z, days: [0, 1, 2, 3, 4, 5, 6].map(dw => { const js = done.filter(j => j.zone === z && j.dow === dw); return js.length >= 3 ? { n: js.length, late: pct(js.filter(j => j.late).length, js.length) } : null; }) }));
  const byDay = [0, 1, 2, 3, 4, 5, 6].map(dw => { const k = kpis(recent.filter(j => j.dow === dw)); return { day: DOW[dw], dow: dw, stops: k.stops, on_time: k.on_time, avg_delay: k.avg_delay }; });
  return { period: { from: from28, to: end }, fleet, drivers, hotspots: hotspots.slice(0, 8), heatmap: heat, by_day: byDay };
}

// ── delay risk for upcoming stops ────────────────────────────
// Naive Bayes on odds: start from the fleet's late rate, then let the driver, the zone, the
// weekday and the window each move the odds by how far their own (smoothed) rate sits from it.
function riskModel(train) {
  const done = train.filter(j => j.status === 'collected');
  const r0 = (done.filter(j => j.late).length + 1) / (done.length + 2);
  const odds = p => p / (1 - p);
  const factors = { driver: j => j.driver, zone: j => j.zone, dow: j => j.dow, window: j => (j.end <= 600 ? 'early' : j.end >= 960 ? 'afternoon' : 'midday') };
  const tables = {};
  for (const [f, fn] of Object.entries(factors)) {
    tables[f] = new Map();
    for (const [k, js] of groupBy(done, fn)) tables[f].set(String(k), (js.filter(j => j.late).length + 10 * r0) / (js.length + 10));
  }
  return {
    r0,
    score(j) {
      let o = odds(r0); const parts = [];
      for (const [f, fn] of Object.entries(factors)) {
        const r = tables[f].get(String(fn(j)));
        if (r == null) continue;
        const ratio = odds(Math.min(0.97, Math.max(0.01, r))) / odds(r0);
        o *= ratio; parts.push({ f, ratio, rate: r });
      }
      const p = o / (1 + o);
      const top = parts.sort((a, b) => b.ratio - a.ratio)[0];
      return { p, top };
    },
  };
}
function delayRisk(D) {
  const model = riskModel(inRange(D.jobs, addDays(D.today, -56), addDays(D.today, -1)));
  // model check: train on the weeks before the last 14 days, score the last 14 days
  const testFrom = addDays(D.today, -14);
  const check = riskModel(inRange(D.jobs, addDays(D.today, -70), addDays(D.today, -15)));
  const test = inRange(D.jobs, testFrom, addDays(D.today, -1)).filter(j => j.status === 'collected').map(j => ({ late: j.late, p: check.score(j).p })).sort((a, b) => b.p - a.p);
  const top = test.slice(0, Math.max(1, Math.round(test.length / 4)));
  const base = pct(test.filter(t => t.late).length, test.length), topRate = pct(top.filter(t => t.late).length, top.length);
  const lift = base ? round1(topRate / base) : null;

  const tomorrow = addDays(D.today, 1);
  const label = (f, j) => ({ driver: `${j.driver}'s record`, zone: `${j.zone} traffic`, dow: `${DOW_LONG[j.dow]}s run late`, window: j.end <= 600 ? 'early window' : j.end >= 960 ? 'afternoon window' : 'midday window' }[f]);
  const stops = D.future.filter(j => j.date === tomorrow).map(j => { const s = model.score(j); return { id: j.id, customer: j.customer, branch: j.branch, zone: j.zone, driver: j.driver, truck: j.truck, window_end: hhmm(j.end), risk: Math.round(100 * s.p), why: s.top && s.top.ratio > 1.15 ? label(s.top.f, j) : 'normal pattern' }; })
    .sort((a, b) => b.risk - a.risk);
  // high risk = at least 1.7 times the fleet's usual late rate (and never below 15%)
  const highAt = Math.max(15, Math.round(model.r0 * 170));
  stops.forEach(s => { s.level = s.risk >= highAt ? 'high' : s.risk >= Math.round(highAt * 0.7) ? 'medium' : 'low'; });
  return {
    date: tomorrow, label: fmtDay(tomorrow), high_from: highAt, base_rate: Math.round(model.r0 * 100), stops: stops.slice(0, 12), total: stops.length, high: stops.filter(s => s.level === 'high').length,
    expected_late: Math.round(sum(stops.map(s => s.risk)) / 100),
    check: { days: 14, stops: test.length, late_rate_all: base, late_rate_flagged: topRate, lift,
      text: lift ? `Tested on the last 14 days: the quarter of stops the model rated riskiest were late ${topRate}% of the time, against ${base}% overall (${lift}× better than guessing).` : 'Not enough finished stops to test the model yet.' },
  };
}

// ── demand forecast with an AI confidence level ──────────────
// Model: weekly level (linear trend on the 7-day average) × weekday factor. The confidence level
// is the accuracy of the same model forecasting the last 14 days from only the data before them.
function fitForecast(series) {                         // series: [{date, n}] consecutive days
  const n = series.length; if (n < 21) return null;
  const avg7 = series.map((_, i) => (i >= 3 && i < n - 3 ? mean(series.slice(i - 3, i + 4).map(s => s.n)) : null));
  const ratios = [0, 1, 2, 3, 4, 5, 6].map(dw => { const r = series.map((s, i) => (avg7[i] && dowOf(s.date) === dw ? s.n / avg7[i] : null)).filter(x => x != null); return r.length ? mean(r) : 1; });
  const norm = mean(ratios); const factor = ratios.map(r => r / norm);
  const pts = series.map((s, i) => ({ x: i, y: s.n / factor[dowOf(s.date)] })).slice(-42);
  const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
  const slope = sum(pts.map(p => (p.x - mx) * (p.y - my))) / (sum(pts.map(p => (p.x - mx) ** 2)) || 1), icpt = my - slope * mx;
  const fitted = series.map((s, i) => (icpt + slope * i) * factor[dowOf(s.date)]);
  const resid = series.slice(-42).map((s, i) => s.n - fitted[n - Math.min(42, n) + i]);
  return { predict: (date, i) => Math.max(0, (icpt + slope * i) * factor[dowOf(date)]), sigma: sd(resid), slope, factor };
}
function forecast(D) {
  const end = addDays(D.today, -1), start = addDays(D.today, -70);
  const counts = new Map(); for (const j of D.jobs) counts.set(j.date, (counts.get(j.date) || 0) + 1);
  const series = []; for (let d = start; d <= end; d = addDays(d, 1)) series.push({ date: d, n: counts.get(d) || 0 });
  // backtest: fit on everything before the last 14 days, forecast those 14 days
  const train = series.slice(0, -14), hold = series.slice(-14);
  const bt = fitForecast(train);
  const backtest = bt ? hold.map((s, k) => ({ date: s.date, actual: s.n, predicted: Math.round(bt.predict(s.date, train.length + k)) })) : [];
  const errs = backtest.filter(b => b.actual > 0).map(b => Math.abs(b.actual - b.predicted) / b.actual);
  const mape = errs.length ? mean(errs) : null;
  const accuracy = mape == null ? null : Math.max(0, Math.round(100 * (1 - mape)));
  const within = backtest.length ? pct(backtest.filter(b => Math.abs(b.actual - b.predicted) <= Math.max(3, 0.1 * b.actual)).length, backtest.length) : null;
  const m = fitForecast(series);
  const cap = D.fleet.capacity;
  const plannedBy = new Map(); for (const j of D.future) plannedBy.set(j.date, (plannedBy.get(j.date) || 0) + 1);
  const next = m ? Array.from({ length: 14 }, (_, k) => {
    const date = addDays(D.today, k + 1), p = m.predict(date, series.length + k), band = 1.28 * m.sigma * Math.sqrt(1 + k / 14);
    const hi = Math.round(p + band);
    return { date, label: fmtDay(date), predicted: Math.round(p), low: Math.max(0, Math.round(p - band)), high: hi, planned: plannedBy.get(date) || 0,
      trucks_needed: Math.ceil(hi / D.fleet.perTruck), over_capacity: hi > cap };
  }) : [];
  const level = accuracy == null ? 'Not enough data' : accuracy >= 90 ? 'High' : accuracy >= 80 ? 'Medium' : 'Low';
  return {
    history: series.slice(-28), backtest, next, fleet: D.fleet,
    confidence: { accuracy, level, within_10pct: within, text: accuracy == null ? 'Needs three weeks of history.' : `Forecasting the last 14 days from the weeks before them, the model was ${accuracy}% accurate on average, and within 10% (or 3 stops) on ${within}% of days.` },
    weekly_growth_pct: m ? round1((100 * m.slope * 7) / Math.max(1, mean(series.slice(-28).map(s => s.n)))) : null,
    busiest_day: m ? DOW_LONG[m.factor.indexOf(Math.max(...m.factor))] : null,
  };
}

// ── recommendations ──────────────────────────────────────────
function recommendations(D, dd, fc, risk) {
  const recs = [];
  for (const h of dd.hotspots.slice(0, 3)) {
    const what = h.kind === 'zone' ? `Re-sequence ${h.driver}'s ${h.key} stops to the start of the route, or move them to a driver with spare time in ${h.key}.`
      : h.kind === 'day' ? `Lighten ${h.driver}'s ${DOW_LONG[h.key]} route or start it 30 minutes earlier.`
      : `Give ${h.driver} fewer ${h.key}-window stops or widen those windows with the customers.`;
    recs.push({ category: 'Driver delays', title: `${h.driver} is late on ${h.late_rate}% of stops ${h.where}`, detail: `${what} His usual late rate is ${h.driver_rate}%. When late in this pattern he is ${h.avg_delay} minutes past the window on average (${h.stops} stops in 28 days).`, impact: `About ${plural(Math.max(1, Math.round((h.effect * h.stops) / 4)), 'fewer late stop')} a week`, confidence: h.confidence });
  }
  const worstDay = dd.by_day.filter(d => d.stops >= 20 && d.on_time != null).sort((a, b) => a.on_time - b.on_time)[0];
  if (worstDay && dd.fleet.on_time != null && dd.fleet.on_time - worstDay.on_time >= 6)
    recs.push({ category: 'Scheduling', title: `${DOW_LONG[worstDay.dow]}s run ${round1(dd.fleet.on_time - worstDay.on_time)} points below the on-time average`, detail: `On-time is ${worstDay.on_time}% on ${DOW_LONG[worstDay.dow]}s against ${dd.fleet.on_time}% overall. Start ${DOW_LONG[worstDay.dow]} shifts 30 minutes earlier or move flexible customers to a quieter day.`, impact: `${worstDay.stops} stops in 28 days affected`, confidence: confidence(worstDay.stops, (dd.fleet.on_time - worstDay.on_time) / 100) });
  const over = fc.next.filter(n => n.over_capacity);
  if (over.length) {
    const d = over[0];
    recs.push({ category: 'Capacity', title: `Add a truck or overtime on ${d.label}${over.length > 1 ? ` (and ${over.length - 1} more day${over.length > 2 ? 's' : ''})` : ''}`, detail: `Forecast up to ${d.high} stops against a fleet capacity of ${fc.fleet.capacity} (${fc.fleet.trucks} trucks × ${fc.fleet.perTruck}). ${d.trucks_needed} trucks would cover it.`, impact: 'Avoids overdue stops and SLA alerts', confidence: fc.confidence.accuracy ?? 50 });
  } else if (fc.next.length) {
    const peak = fc.next.reduce((a, b) => (b.high > a.high ? b : a));
    recs.push({ category: 'Capacity', title: `Fleet capacity is enough for the next 14 days`, detail: `Busiest forecast day is ${peak.label} at up to ${peak.high} stops; the fleet holds ${fc.fleet.capacity}.`, impact: 'No action needed', confidence: fc.confidence.accuracy ?? 50 });
  }
  // sites that keep reporting an empty bin → lower frequency
  const recent = inRange(D.jobs, addDays(D.today, -28), addDays(D.today, -1));
  for (const [, js] of groupBy(recent, j => j.cid)) {
    const empty = js.filter(j => j.reason === 'BIN_EMPTY' || j.reason === 'NO_WASTE').length;
    if (js.length >= 5 && empty / js.length >= 0.3) recs.push({ category: 'Route efficiency', title: `Cut visits to ${js[0].customer} ${js[0].branch}`.trim(), detail: `The bin was empty on ${empty} of ${js.length} visits in 28 days. Offer a lower frequency plan; the truck time goes to other stops.`, impact: `Saves about ${plural(Math.max(1, Math.round(empty / 4)), 'trip')} a week`, confidence: confidence(js.length, empty / js.length) });
  }
  // sites closed on the same weekday → move the day
  for (const [, js] of groupBy(recent.filter(j => j.reason === 'CLOSED' || j.reason === 'NO_ACCESS' || j.reason === 'ACCESS_BLOCKED'), j => j.cid + '|' + j.dow)) {
    if (js.length >= 2) { const all = recent.filter(j => j.cid === js[0].cid && j.dow === js[0].dow).length; recs.push({ category: 'Scheduling', title: `Move ${js[0].customer} ${js[0].branch} off ${DOW_LONG[js[0].dow]}s`.trim(), detail: `${js.length} of ${all} ${DOW_LONG[js[0].dow]} visits failed (${REASON_TEXT[js[0].reason] || js[0].reason}). Ask the site for a day they are open.`, impact: `${plural(js.length, 'wasted trip')} in 28 days`, confidence: confidence(all * 2, js.length / all) }); }
  }
  // coaching
  for (const d of dd.drivers) {
    if (d.trend != null && d.trend <= -8 && d.stops >= 20) recs.push({ category: 'Coaching', title: `${d.driver}'s on-time rate fell ${Math.abs(d.trend)} points this week`, detail: `${d.on_time_prev_week}% the week before, ${d.on_time_last_week}% last week. Check route length and vehicle issues before it becomes a pattern.`, impact: 'Early warning', confidence: confidence(d.stops / 2, d.trend / 100) });
    if (d.trend != null && d.trend >= 8 && d.stops >= 20) recs.push({ category: 'Coaching', title: `${d.driver} improved ${d.trend} points on time this week`, detail: `${d.on_time_prev_week}% → ${d.on_time_last_week}%. Worth recognising.`, impact: 'Keeps the improvement going', confidence: confidence(d.stops / 2, d.trend / 100) });
  }
  if (risk.high) recs.push({ category: 'Tomorrow', title: `${risk.high} of tomorrow's ${risk.total} stops are high risk of running late`, detail: `Message those customers early or swap their order on the route. Expected late stops tomorrow: about ${risk.expected_late}.`, impact: 'Fewer complaints and SLA alerts', confidence: risk.check.lift ? Math.min(92, Math.round(55 + risk.check.lift * 12)) : 55 });
  return recs.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

// ── performance reports ──────────────────────────────────────
function dailyReport(D, date) {
  date = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : addDays(D.today, -1);
  const day = D.jobs.filter(j => j.date === date), k = kpis(day);
  const base = [1, 2, 3, 4].map(w => kpis(D.jobs.filter(j => j.date === addDays(date, -7 * w)))).filter(b => b.stops);
  const avg = f => (base.length ? round1(mean(base.map(b => b[f] ?? 0))) : null);
  const baseline = { stops: avg('stops'), completion: avg('completion'), on_time: avg('on_time'), avg_delay: avg('avg_delay'), no_pickup: avg('no_pickup') };
  const drivers = [...groupBy(day, j => j.driver)].map(([driver, js]) => { const x = kpis(js); return { driver, truck: js[0].truck, ...x, score: score(x) }; }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const zones = [...groupBy(day, j => j.zone)].map(([zone, js]) => ({ zone, ...kpis(js) })).sort((a, b) => (a.on_time ?? 100) - (b.on_time ?? 100));
  const reasons = [...groupBy(day.filter(j => j.npu), j => j.reason || 'OTHER')].map(([r, js]) => ({ reason: REASON_TEXT[r] || String(r).toLowerCase().replace(/_/g, ' '), count: js.length })).sort((a, b) => b.count - a.count);
  const late = day.filter(j => j.late).sort((a, b) => b.delay - a.delay).slice(0, 8).map(j => ({ customer: j.customer, branch: j.branch, zone: j.zone, driver: j.driver, window_end: hhmm(j.end), arrived: hhmm(j.actual), delay: j.delay }));
  const hours = Array.from({ length: 12 }, (_, i) => 6 + i).map(h => ({ hour: `${String(h).padStart(2, '0')}:00`, done: day.filter(j => j.actual != null && Math.floor(j.actual / 60) === h).length, late: day.filter(j => j.late && Math.floor(j.actual / 60) === h).length }));
  const s = [];
  if (!k.stops) s.push(`No stops were recorded on ${fmtDay(date)}.`);
  else {
    s.push(`${fmtDay(date)}: ${k.collected} of ${k.stops} stops collected (${k.completion}% completion), ${k.on_time}% on time.`);
    if (baseline.on_time != null && k.on_time != null) { const dlt = round1(k.on_time - baseline.on_time); s.push(Math.abs(dlt) < 2 ? `On-time was in line with the last four ${DOW_LONG[dowOf(date)]}s (${baseline.on_time}%).` : `On-time was ${Math.abs(dlt)} points ${dlt > 0 ? 'better' : 'worse'} than the last four ${DOW_LONG[dowOf(date)]}s (${baseline.on_time}%).`); }
    if (drivers.length > 1 && drivers[0].score != null) s.push(`Best driver: ${drivers[0].driver} (score ${drivers[0].score}). Needs attention: ${drivers.at(-1).driver} (score ${drivers.at(-1).score}, ${drivers.at(-1).late} late).`);
    if (zones[0] && zones[0].on_time != null && zones[0].on_time < (k.on_time ?? 0) - 8) s.push(`${zones[0].zone} was the slowest zone at ${zones[0].on_time}% on time.`);
    if (reasons[0]) s.push(`Most common no-pickup reason: ${reasons[0].reason} (${reasons[0].count}).`);
  }
  return { date, label: fmtDay(date), kpis: k, baseline, drivers, zones, reasons, late, hours, summary: s };
}
function weeklyReport(D, end) {
  end = /^\d{4}-\d{2}-\d{2}$/.test(String(end || '')) ? end : addDays(D.today, -1);
  const start = addDays(end, -6), pStart = addDays(start, -7), pEnd = addDays(start, -1);
  const cur = inRange(D.jobs, start, end), prev = inRange(D.jobs, pStart, pEnd);
  const k = kpis(cur), kp = kpis(prev);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i)).map(d => { const x = kpis(D.jobs.filter(j => j.date === d)); return { date: d, label: fmtDay(d), ...x }; });
  const pd = new Map([...groupBy(prev, j => j.driver)].map(([n, js]) => [n, kpis(js)]));
  const drivers = [...groupBy(cur, j => j.driver)].map(([driver, js]) => { const x = kpis(js), p = pd.get(driver); const sc = score(x), ps = p ? score(p) : null; return { driver, truck: js[0].truck, ...x, score: sc, score_change: sc != null && ps != null ? sc - ps : null }; }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((d, i) => ({ rank: i + 1, ...d }));
  const zones = [...groupBy(cur, j => j.zone)].map(([zone, js]) => ({ zone, ...kpis(js) })).sort((a, b) => b.stops - a.stops);
  const best = days.filter(d => d.stops).sort((a, b) => (b.on_time ?? 0) - (a.on_time ?? 0));
  const ch = (a, b) => (a != null && b != null ? round1(a - b) : null);
  const s = [];
  if (!k.stops) s.push('No stops this week.');
  else {
    s.push(`Week ${fmtDay(start)} to ${fmtDay(end)}: ${k.stops} stops, ${k.completion}% completion, ${k.on_time}% on time, average delay ${k.avg_delay} minutes when late.`);
    const c = ch(k.on_time, kp.on_time); if (c != null) s.push(`On-time ${c >= 0 ? 'up' : 'down'} ${Math.abs(c)} points on the previous week; volume ${k.stops >= kp.stops ? 'up' : 'down'} ${Math.abs(pct(k.stops - kp.stops, kp.stops || 1))}%.`);
    if (best.length > 1) s.push(`Best day ${best[0].label} (${best[0].on_time}% on time), weakest ${best.at(-1).label} (${best.at(-1).on_time}%).`);
    if (drivers.length) s.push(`Top driver ${drivers[0].driver} (score ${drivers[0].score}); ${drivers.at(-1).driver} ranks last (score ${drivers.at(-1).score}).`);
    const mover = drivers.filter(d => d.score_change != null).sort((a, b) => Math.abs(b.score_change) - Math.abs(a.score_change))[0];
    if (mover && Math.abs(mover.score_change) >= 4) s.push(`Biggest change: ${mover.driver} ${mover.score_change > 0 ? 'up' : 'down'} ${Math.abs(mover.score_change)} points.`);
  }
  return { start, end, label: `${fmtDay(start)} – ${fmtDay(end)}`, kpis: k, previous: kp, change: { stops: k.stops - kp.stops, completion: ch(k.completion, kp.completion), on_time: ch(k.on_time, kp.on_time), avg_delay: kp.avg_delay != null ? k.avg_delay - kp.avg_delay : null, no_pickup: k.no_pickup - kp.no_pickup }, days, drivers, zones, summary: s };
}

// ── the whole page ───────────────────────────────────────────
function overview(source) {
  const D = load(source);
  const dd = driverDelays(D), fc = forecast(D), risk = delayRisk(D);
  const recs = recommendations(D, dd, fc, risk);
  const wk = weeklyReport(D);
  const headline = [];
  if (dd.fleet.on_time != null) headline.push(`Fleet on time ${dd.fleet.on_time}% over 28 days.`);
  if (dd.hotspots[0]) headline.push(`Biggest delay pattern: ${dd.hotspots[0].driver} ${dd.hotspots[0].where} (${dd.hotspots[0].late_rate}% late).`);
  if (fc.next[0]) headline.push(`Forecast ${sum(fc.next.slice(0, 7).map(n => n.predicted))} stops in the next 7 days${fc.weekly_growth_pct != null ? `, demand ${fc.weekly_growth_pct >= 0 ? 'growing' : 'falling'} ${Math.abs(fc.weekly_growth_pct)}% a week` : ''}.`);
  if (risk.total) headline.push(`${risk.high} of tomorrow's ${risk.total} stops flagged high risk.`);
  return { source: D.source, note: D.note || null, generated_at: new Date().toISOString(), today: D.today, headline: headline.join(' '), week: { label: wk.label, kpis: wk.kpis, change: wk.change }, delays: dd, forecast: fc, risk, recommendations: recs };
}

const withSource = (D, rep) => ({ source: D.source, note: D.note || null, ...rep });
module.exports = { overview, dailyReport: (source, date) => { const D = load(source); return withSource(D, dailyReport(D, date)); }, weeklyReport: (source, end) => { const D = load(source); return withSource(D, weeklyReport(D, end)); }, _internal: { load, kpis, forecast, fitForecast, riskModel, demoData, windowEnd, localMinutes } };
