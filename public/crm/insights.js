// ─────────────────────────────────────────────────────────────
// GreenLoop CRM v3.5 — AI insights and performance reports
//   aiInsights()   predictive view: recommendations, demand forecast with an AI
//                  confidence level, driver delay patterns, tomorrow's risky stops
//   perfReports()  daily and weekly performance reports with an AI summary,
//                  comparisons against the baseline, print and CSV
// Data: GET /ai/insights, /ai/reports/daily, /ai/reports/weekly (server/insights.js).
// Uses app.js helpers: api, $, esc, icon, killCharts, _charts, toast.
// ─────────────────────────────────────────────────────────────
PATHS.sparkle = '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>';
PATHS.activity = '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>';
PATHS.printer = '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>';

let aiSource = 'auto';            // auto | live | demo — shared by both pages
let repMode = 'daily', repDate = '';

const AI_C = { accent: '#2ee6a6', accent2: '#5ce1e6', red: '#ff6b6b', amber: '#ffd166', grey: 'rgba(200,220,225,.38)', grid: 'rgba(255,255,255,.07)' };
const signed = (x, unit = '', digits = 1) => x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(Number(x)).toFixed(Number.isInteger(x) ? 0 : digits)}${unit}`;
const pctTxt = x => (x == null ? '—' : `${x}%`);
function deltaChip(x, goodUp = true, unit = ' pts') {
  if (x == null || isNaN(x)) return '';
  const good = x === 0 ? null : (x > 0) === goodUp;
  return `<span class="ai-delta ${good == null ? '' : good ? 'up' : 'down'}">${signed(x, unit)}</span>`;
}
function sourceBar(d) {
  const opts = [['auto', 'Auto'], ['live', 'My data'], ['demo', 'Demo data']].map(([k, l]) =>
    `<button class="ptab ${aiSource === k ? 'on' : ''}" onclick="aiSource='${k}';nav(currentPage)">${l}</button>`).join('');
  const badge = d.source === 'demo' ? `<span class="ai-src demo" title="${esc(d.note || '')}">${icon('info', 12)} Demo data</span>` : `<span class="ai-src live">${icon('checkCircle', 12)} Your data</span>`;
  return `<div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">${badge}<div class="ptabs">${opts}</div></div>`;
}
function chartDefaults() {
  Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#9fb5b8';
  Chart.defaults.borderColor = AI_C.grid;
  Chart.defaults.font.family = "'Outfit', 'Segoe UI', system-ui, sans-serif";
}
const confBar = c => `<div class="ai-conf" title="AI confidence ${c}%"><i style="width:${c}%"></i></div><span class="small muted">${c}%</span>`;

// ══ AI INSIGHTS ═══════════════════════════════════════════════
async function aiInsights() {
  killCharts();
  $('#main').innerHTML = `<div class="card"><p class="muted">${icon('sparkle', 14)} Analysing the last ten weeks of jobs…</p></div>`;
  const d = await api('/ai/insights?source=' + aiSource);
  const f = d.forecast, r = d.risk, dl = d.delays, fl = dl.fleet;
  const next7 = f.next.slice(0, 7).reduce((s, n) => s + n.predicted, 0);
  const lvl = f.confidence.level, lvlCls = lvl === 'High' ? 'green' : lvl === 'Medium' ? 'amber' : 'red';

  $('#main').innerHTML = `
    <div class="head">
      <div><h1>AI insights</h1><p class="sub">Predictions and recommendations from the last ten weeks of jobs · updated ${new Date(d.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></div>
      ${sourceBar(d)}
    </div>
    ${d.source === 'demo' && d.note ? `<div class="ai-note">${icon('info', 14)} ${esc(d.note)}</div>` : ''}
    <div class="card ai-hero"><div class="ai-hero-ic">${icon('sparkle', 22)}</div><div><div class="ai-kicker">Today's read-out</div><p class="ai-headline">${esc(d.headline)}</p></div></div>

    <div class="kpis">
      <div class="kpi ${fl.on_time >= 90 ? 'green' : fl.on_time >= 80 ? 'amber' : 'red'}"><div class="num">${pctTxt(fl.on_time)}</div><div class="lbl">${icon('clock', 13)} On time, 28 days</div></div>
      <div class="kpi"><div class="num">${fl.avg_delay}<small> min</small></div><div class="lbl">${icon('alertTriangle', 13)} Average delay when late</div></div>
      <div class="kpi blue"><div class="num">${next7}</div><div class="lbl">${icon('calendar', 13)} Stops forecast, next 7 days</div></div>
      <div class="kpi ${lvlCls}"><div class="num">${f.confidence.accuracy ?? '—'}<small>%</small></div><div class="lbl">${icon('target', 13)} AI confidence · ${lvl}</div></div>
      <div class="kpi ${r.high ? 'red' : 'green'}"><div class="num">${r.high}<small> / ${r.total}</small></div><div class="lbl">${icon('mapPin', 13)} High-risk stops tomorrow</div></div>
    </div>

    <div class="card"><div class="row spread"><h3>${icon('sparkle', 15)} Recommended actions</h3><span class="small muted">Sorted by AI confidence</span></div>
      ${d.recommendations.length ? `<div class="ai-recs">${d.recommendations.map((x, i) => `
        <div class="ai-rec"><div class="ai-rec-n">${i + 1}</div>
          <div class="ai-rec-body"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><span class="ai-cat">${esc(x.category)}</span><b>${esc(x.title)}</b></div>
            <p class="small" style="margin:6px 0 4px">${esc(x.detail)}</p><span class="small muted">${icon('zap', 12)} ${esc(x.impact)}</span></div>
          <div class="ai-rec-conf"><span class="small muted">Confidence</span>${confBar(x.confidence)}</div></div>`).join('')}</div>`
        : '<p class="muted">Nothing needs action. Operations are running to pattern.</p>'}
    </div>

    <div class="grid2">
      <div class="card"><h3>${icon('chart', 15)} Demand forecast, next 14 days</h3>
        <p class="small muted" style="margin:-4px 0 8px">Solid: actual stops. Dashed: what the model predicted for days it had not seen. Green: forecast with its 80% range.${f.busiest_day ? ` Busiest day: ${f.busiest_day}.` : ''}</p>
        <div class="chartbox" style="height:270px"><canvas id="ai-fc"></canvas></div></div>
      <div class="card"><h3>${icon('target', 15)} AI confidence: predicted against actual</h3>
        <div class="ai-confbig"><div class="ai-ring ${lvlCls}" style="--p:${f.confidence.accuracy ?? 0}"><span>${f.confidence.accuracy ?? '—'}%</span></div>
          <div><b>${lvl} confidence</b><p class="small muted" style="margin:4px 0 0">${esc(f.confidence.text)}</p></div></div>
        <div class="chartbox" style="height:170px"><canvas id="ai-bt"></canvas></div></div>
    </div>

    ${f.next.length ? `<div class="card"><div class="row spread"><h3>${icon('truck', 15)} Fleet capacity against the forecast</h3><span class="small muted">${f.fleet.trucks} trucks × ${f.fleet.perTruck} stops = ${f.fleet.capacity} a day</span></div>
      <div class="ai-days">${f.next.map(n => `<div class="ai-day ${n.over_capacity ? 'over' : ''}" title="${n.low}–${n.high} stops, ${n.planned} planned so far">
        <div class="small muted">${esc(n.label)}</div><div class="ai-day-n">${n.predicted}</div><div class="small">${n.low}–${n.high}</div>
        <div class="small ${n.over_capacity ? 'ai-red' : 'muted'}">${n.trucks_needed} truck${n.trucks_needed === 1 ? '' : 's'}</div></div>`).join('')}</div></div>` : ''}

    <div class="card"><div class="row spread"><h3>${icon('users', 15)} Driver delays, last 28 days</h3><span class="small muted">A stop is late when the driver arrives more than 10 minutes after its window</span></div>
      <div class="scroll-x"><table><tr><th>Driver</th><th>Stops</th><th>On time</th><th>Avg delay</th><th>Worst 10%</th><th>Week on week</th><th>Score</th></tr>
      ${dl.drivers.map(x => `<tr><td><b>${esc(x.driver)}</b><br><span class="muted small">${esc(x.truck)}</span></td><td>${x.stops}</td>
        <td><span class="pill ${x.on_time >= 90 ? 'collected' : x.on_time >= 80 ? 'pending' : 'canceled'}">${pctTxt(x.on_time)}</span></td>
        <td>${x.avg_delay} min</td><td>${x.p90_delay} min</td><td>${x.trend == null ? '—' : deltaChip(x.trend)}</td>
        <td><div class="row" style="gap:8px;align-items:center">${confBar(x.score ?? 0)}</div></td></tr>`).join('')}</table></div>
      ${dl.hotspots.length ? `<h4 class="ai-h4">${icon('sparkle', 13)} Patterns the AI found</h4><div class="ai-hot">${dl.hotspots.map(h => `
        <div class="ai-hotc"><b>${esc(h.driver)}</b> <span class="muted">${esc(h.where)}</span><div class="ai-hot-n">${h.late_rate}%<small> late</small></div>
        <div class="small muted">usual ${h.driver_rate}% · ${h.avg_delay} min average delay · ${h.stops} stops · confidence ${h.confidence}%</div></div>`).join('')}</div>` : ''}
    </div>

    <div class="grid2">
      <div class="card"><h3>${icon('grid', 15)} Where and when stops run late</h3><p class="small muted" style="margin:-4px 0 10px">Share of collected stops that were late, by zone and weekday</p>
        <div class="scroll-x"><table class="ai-heat"><tr><th></th>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(x => `<th>${x}</th>`).join('')}</tr>
        ${dl.heatmap.map(z => `<tr><td><b>${esc(z.zone)}</b></td>${z.days.map(c => c ? `<td><span class="ai-cell" style="--h:${Math.min(1, c.late / 45)}" title="${c.late}% late of ${c.n} stops">${Math.round(c.late)}</span></td>` : '<td class="muted">·</td>').join('')}</tr>`).join('')}</table></div></div>
      <div class="card"><h3>${icon('mapPin', 15)} Tomorrow's stops most likely to run late</h3>
        <p class="small muted" style="margin:-4px 0 10px">${esc(r.label || r.date)} · ${r.total} stops planned · usual late rate ${r.base_rate}% · about ${r.expected_late} expected late</p>
        ${r.stops.length ? `<div class="scroll-x"><table><tr><th>Stop</th><th>Driver</th><th>Window ends</th><th>Risk</th><th>Main reason</th></tr>
        ${r.stops.slice(0, 8).map(s => `<tr><td><b>${esc(s.customer)}</b><br><span class="muted small">${esc(s.branch || s.zone)}</span></td><td class="small">${esc(s.driver)}</td><td>${esc(s.window_end)}</td>
          <td><span class="pill ${s.level === 'high' ? 'canceled' : s.level === 'medium' ? 'pending' : 'collected'}">${s.risk}%</span></td><td class="small muted">${esc(s.why)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No stops planned for tomorrow yet.</p>'}
        <p class="small muted" style="margin-top:10px">${icon('checkCircle', 12)} ${esc(r.check.text)}</p></div>
    </div>

    <details class="card ai-how"><summary><b>How the AI works</b></summary>
      <ul class="small">
        <li><b>Forecast:</b> weekly level with a linear trend, multiplied by each weekday's typical share. The 80% range comes from how far real days strayed from the model.</li>
        <li><b>AI confidence:</b> the same model is fitted without the last 14 days, asked to predict them, and scored against what actually happened. High is 90% or better, Medium 80–89%, Low below 80%.</li>
        <li><b>Delay risk:</b> a Bayesian model that starts from the fleet's late rate and adjusts it for the driver, the zone, the weekday and the time window, each weighted by how much history backs it. It is tested on the last 14 days the same way.</li>
        <li><b>Patterns and recommendations:</b> a pattern is reported when a driver's late rate in one zone, weekday or window is at least 15 points and 1.5 times above his own average over 8 or more stops. Confidence grows with the number of stops and the size of the effect.</li>
        <li><b>Data:</b> your jobs once there are about 150 finished in 28 days; until then, realistic demo data that is never saved.</li>
      </ul></details>`;

  chartDefaults();
  const hist = f.history, bt = new Map(f.backtest.map(b => [b.date, b.predicted]));
  const labels = [...hist.map(h => h.date.slice(5)), ...f.next.map(n => n.date.slice(5))];
  const pad = Array(hist.length).fill(null);
  const lastActual = hist.length ? hist[hist.length - 1].n : null;
  _charts.push(new Chart($('#ai-fc'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Range (80%)', data: [...pad.slice(1), lastActual, ...f.next.map(n => n.high)], borderColor: 'transparent', backgroundColor: 'rgba(46,230,166,.13)', fill: '+1', pointRadius: 0 },
      { label: 'low', data: [...pad.slice(1), lastActual, ...f.next.map(n => n.low)], borderColor: 'transparent', pointRadius: 0, fill: false },
      { label: 'Forecast', data: [...pad.slice(1), lastActual, ...f.next.map(n => n.predicted)], borderColor: AI_C.accent, borderWidth: 2.5, pointRadius: 2, tension: .25 },
      { label: 'Actual', data: [...hist.map(h => h.n), ...Array(f.next.length).fill(null)], borderColor: 'rgba(230,240,242,.85)', borderWidth: 2, pointRadius: 0, tension: .25 },
      { label: 'Predicted (test)', data: [...hist.map(h => bt.get(h.date) ?? null), ...Array(f.next.length).fill(null)], borderColor: AI_C.accent2, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, tension: .25 },
      { label: 'Fleet capacity', data: labels.map(() => f.fleet.capacity), borderColor: 'rgba(255,107,107,.55)', borderWidth: 1, borderDash: [2, 3], pointRadius: 0 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 12, filter: i => i.text !== 'low' } }, tooltip: { filter: i => i.dataset.label !== 'low' && i.raw != null } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { maxTicksLimit: 10 } } } },
  }));
  _charts.push(new Chart($('#ai-bt'), {
    type: 'bar',
    data: { labels: f.backtest.map(b => b.date.slice(5)), datasets: [
      { label: 'Actual', data: f.backtest.map(b => b.actual), backgroundColor: 'rgba(230,240,242,.35)', borderRadius: 3 },
      { label: 'AI predicted', data: f.backtest.map(b => b.predicted), backgroundColor: AI_C.accent, borderRadius: 3 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 10 } } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { maxTicksLimit: 7 } } } },
  }));
}

// ══ PERFORMANCE REPORTS ═══════════════════════════════════════
async function perfReports() {
  killCharts();
  const q = repMode === 'daily' ? `/ai/reports/daily?source=${aiSource}${repDate ? '&date=' + repDate : ''}` : `/ai/reports/weekly?source=${aiSource}${repDate ? '&end=' + repDate : ''}`;
  const d = await api(q), meta = d;
  const k = d.kpis;
  const tabs = ['daily', 'weekly'].map(m => `<button class="ptab ${repMode === m ? 'on' : ''}" onclick="repMode='${m}';repDate='';perfReports()">${m === 'daily' ? 'Daily' : 'Weekly'}</button>`).join('');
  const pickVal = repMode === 'daily' ? d.date : d.end;
  const cmp = repMode === 'daily' ? d.baseline : d.previous, cmpName = repMode === 'daily' ? `vs last 4 ${d.label.split(' ')[0]}s` : 'vs previous week';
  const dlt = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 10) / 10);
  window._repDrivers = d.drivers;

  $('#main').innerHTML = `
    <div class="head ai-print-head">
      <div><h1>${repMode === 'daily' ? 'Daily' : 'Weekly'} performance report</h1><p class="sub">${esc(d.label)} · GreenLoop / Majari</p></div>
      <div class="row ai-noprint" style="gap:10px;flex-wrap:wrap;align-items:center">
        <div class="ptabs">${tabs}</div>
        <input type="date" value="${pickVal}" max="${new Date(Date.now() - 864e5).toISOString().slice(0, 10)}" onchange="repDate=this.value;perfReports()" aria-label="${repMode === 'daily' ? 'Day' : 'Week ending'}" style="width:auto">
        <button class="btn ghost small" onclick="repCsv()">${icon('download', 13)} CSV</button>
        <button class="btn primary small" onclick="window.print()">${icon('printer', 13)} Print / PDF</button>
      </div>
    </div>
    <div class="ai-noprint" style="margin:-6px 0 14px">${sourceBar(meta)}</div>

    <div class="card ai-hero"><div class="ai-hero-ic">${icon('sparkle', 22)}</div><div><div class="ai-kicker">AI summary</div>
      <ul class="ai-sum">${d.summary.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div></div>

    <div class="kpis">
      <div class="kpi blue"><div class="num">${k.stops}</div><div class="lbl">${icon('calendar', 13)} Stops ${deltaChip(dlt(k.stops, cmp.stops), true, '')}</div></div>
      <div class="kpi ${k.completion >= 95 ? 'green' : k.completion >= 85 ? 'amber' : 'red'}"><div class="num">${pctTxt(k.completion)}</div><div class="lbl">${icon('checkCircle', 13)} Completion ${deltaChip(dlt(k.completion, cmp.completion))}</div></div>
      <div class="kpi ${k.on_time >= 90 ? 'green' : k.on_time >= 80 ? 'amber' : 'red'}"><div class="num">${pctTxt(k.on_time)}</div><div class="lbl">${icon('clock', 13)} On time ${deltaChip(dlt(k.on_time, cmp.on_time))}</div></div>
      <div class="kpi"><div class="num">${k.avg_delay}<small> min</small></div><div class="lbl">${icon('alertTriangle', 13)} Avg delay when late ${deltaChip(dlt(k.avg_delay, cmp.avg_delay), false, ' min')}</div></div>
      <div class="kpi red"><div class="num">${k.no_pickup + k.missed}</div><div class="lbl">${icon('xCircle', 13)} No-pickup / missed ${deltaChip(dlt(k.no_pickup, cmp.no_pickup), false, '')}</div></div>
    </div>
    <p class="small muted" style="margin:-6px 0 14px">Arrows compare ${cmpName}.</p>

    <div class="card"><h3>${icon('chart', 15)} ${repMode === 'daily' ? 'Stops completed by hour' : 'Day by day'}</h3><div class="chartbox" style="height:250px"><canvas id="rep-c"></canvas></div></div>

    <div class="card"><div class="row spread"><h3>${icon('users', 15)} Driver ${repMode === 'weekly' ? 'ranking' : 'performance'}</h3><span class="small muted">Score = 50% on time + 30% completion + 20% few no-pickups</span></div>
      <div class="scroll-x"><table><tr>${repMode === 'weekly' ? '<th>#</th>' : ''}<th>Driver</th><th>Stops</th><th>Collected</th><th>On time</th><th>Late</th><th>Avg delay</th><th>No-pickup</th><th>Score</th>${repMode === 'weekly' ? '<th>Change</th>' : ''}</tr>
      ${d.drivers.map(x => `<tr>${repMode === 'weekly' ? `<td><b>${x.rank}</b></td>` : ''}<td><b>${esc(x.driver)}</b><br><span class="muted small">${esc(x.truck)}</span></td><td>${x.stops}</td><td>${x.collected}</td>
        <td><span class="pill ${x.on_time >= 90 ? 'collected' : x.on_time >= 80 ? 'pending' : 'canceled'}">${pctTxt(x.on_time)}</span></td><td>${x.late}</td><td>${x.avg_delay} min</td><td>${x.no_pickup}</td>
        <td><b>${x.score ?? '—'}</b></td>${repMode === 'weekly' ? `<td>${deltaChip(x.score_change, true, '')}</td>` : ''}</tr>`).join('') || '<tr><td colspan="9" class="muted">No stops.</td></tr>'}</table></div></div>

    <div class="grid2">
      <div class="card"><h3>${icon('store', 15)} By zone</h3><div class="scroll-x"><table><tr><th>Zone</th><th>Stops</th><th>Completion</th><th>On time</th><th>Avg delay</th></tr>
        ${d.zones.map(z => `<tr><td><b>${esc(z.zone)}</b></td><td>${z.stops}</td><td>${pctTxt(z.completion)}</td><td>${pctTxt(z.on_time)}</td><td>${z.avg_delay} min</td></tr>`).join('')}</table></div></div>
      ${repMode === 'daily' ? `<div class="card"><h3>${icon('alertTriangle', 15)} Latest arrivals</h3>${d.late.length ? `<div class="scroll-x"><table><tr><th>Stop</th><th>Driver</th><th>Window ends</th><th>Arrived</th><th>Late by</th></tr>
        ${d.late.map(l => `<tr><td><b>${esc(l.customer)}</b><br><span class="muted small">${esc(l.branch || l.zone)}</span></td><td class="small">${esc(l.driver)}</td><td>${l.window_end}</td><td>${l.arrived}</td><td><span class="pill canceled">${l.delay} min</span></td></tr>`).join('')}</table></div>` : '<p class="muted">No late stops.</p>'}
        ${d.reasons.length ? `<h4 class="ai-h4">No-pickup reasons</h4><p class="small">${d.reasons.map(x => `${esc(x.reason)} <b>${x.count}</b>`).join(' · ')}</p>` : ''}</div>`
      : `<div class="card"><h3>${icon('calendar', 15)} Each day</h3><div class="scroll-x"><table><tr><th>Day</th><th>Stops</th><th>Completion</th><th>On time</th><th>Avg delay</th></tr>
        ${d.days.map(x => `<tr><td><b>${esc(x.label)}</b></td><td>${x.stops}</td><td>${pctTxt(x.completion)}</td><td>${pctTxt(x.on_time)}</td><td>${x.avg_delay} min</td></tr>`).join('')}</table></div></div>`}
    </div>`;

  chartDefaults();
  if (repMode === 'daily') {
    _charts.push(new Chart($('#rep-c'), { type: 'bar', data: { labels: d.hours.map(h => h.hour), datasets: [
      { label: 'On time', data: d.hours.map(h => h.done - h.late), backgroundColor: AI_C.accent, borderRadius: 4, stack: 's' },
      { label: 'Late', data: d.hours.map(h => h.late), backgroundColor: AI_C.red, borderRadius: 4, stack: 's' },
    ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12 } } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } } }));
  } else {
    _charts.push(new Chart($('#rep-c'), { data: { labels: d.days.map(x => x.label), datasets: [
      { type: 'bar', label: 'Collected', data: d.days.map(x => x.collected), backgroundColor: AI_C.accent, borderRadius: 4, stack: 's', yAxisID: 'y' },
      { type: 'bar', label: 'No-pickup / missed', data: d.days.map(x => x.no_pickup + x.missed), backgroundColor: AI_C.red, borderRadius: 4, stack: 's', yAxisID: 'y' },
      { type: 'line', label: 'On time %', data: d.days.map(x => x.on_time), borderColor: AI_C.amber, backgroundColor: AI_C.amber, borderWidth: 2, tension: .3, fill: false, yAxisID: 'y2' },
    ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12 } } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y2: { position: 'right', min: 50, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } } } } }));
  }
}
function repCsv() {
  const rows = window._repDrivers || [];
  const head = ['rank', 'driver', 'truck', 'stops', 'collected', 'on_time_pct', 'late', 'avg_delay_min', 'no_pickup', 'missed', 'score', 'score_change'];
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [head.join(','), ...rows.map((r, i) => [r.rank ?? i + 1, r.driver, r.truck, r.stops, r.collected, r.on_time, r.late, r.avg_delay, r.no_pickup, r.missed, r.score, r.score_change ?? ''].map(cell).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `greenloop-${repMode}-report-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
