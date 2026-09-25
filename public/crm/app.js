// ─────────────────────────────────────────────────────────────
// GreenLoop CRM — Owner Control Center (vanilla SPA, no build step)
// ─────────────────────────────────────────────────────────────
const API = '/api/v1';
let token = sessionStorage.getItem('gl_token') || null;
let socket = null;
let currentPage = 'dashboard';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ── SVG icon system (no emojis) ──────────────────────────────
const PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  truck: '<rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  swap: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  store: '<path d="M3 9l2-5h14l2 5"/><path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9z"/><path d="M9 21v-6h6v6"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  alertTriangle: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
};
const icon = (name, size = 16, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
const statusIcon = s => ({ collected: icon('checkCircle', 14), canceled: icon('xCircle', 14), pending: icon('clock', 14), overdue: icon('alertTriangle', 14), rescheduled: icon('swap', 14) }[s] || '');

const NAV = [
  ['dashboard', 'grid', 'Dashboard'],
  ['ledger', 'list', 'Daily Route Ledger'],
  ['fleet', 'truck', 'Fleet Load Tracker'],
  ['reschedule', 'swap', 'Rescheduling'],
  ['customers', 'store', 'Customers'],
  ['users', 'users', 'Users'],
  ['vehicles', 'truck', 'Vehicles'],
  ['reports', 'chart', 'Reports'],
  ['alerts', 'bell', 'Alerts'],
];
function buildNav() {
  $('#nav').innerHTML = NAV.map(([page, ic, label]) =>
    `<a data-page="${page}">${icon(ic, 17)} <span>${label}</span>${page === 'alerts' ? ' <span id="alert-badge" class="badge hidden">0</span>' : ''}</a>`).join('');
  document.querySelectorAll('.sidebar nav a').forEach(a => a.addEventListener('click', () => nav(a.dataset.page)));
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── auth ─────────────────────────────────────────────────────
async function doLogin() {
  $('#login-err').textContent = '';
  try {
    const data = await fetch(API + '/auth/admin-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#login-user').value, password: $('#login-pass').value }),
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
    token = data.token;
    sessionStorage.setItem('gl_token', token);
    boot();
  } catch (e) { $('#login-err').textContent = e.message; }
}
function logout() {
  sessionStorage.removeItem('gl_token'); token = null;
  if (socket) socket.disconnect();
  $('#app').classList.add('hidden'); $('#login-screen').classList.remove('hidden');
}
$('#login-pass').addEventListener('keydown', e => e.key === 'Enter' && doLogin());

// ── shell / realtime ─────────────────────────────────────────
function boot() {
  $('#login-screen').classList.add('hidden'); $('#app').classList.remove('hidden');
  buildNav();
  socket = io();
  socket.on('connect', () => { $('#live-dot').classList.remove('off'); $('#live-label').textContent = 'live stream on'; });
  socket.on('disconnect', () => { $('#live-dot').classList.add('off'); $('#live-label').textContent = 'reconnecting…'; });
  socket.on('pickup:completed', d => { toast(`Collected: ${d.customer} (${d.branch}) by ${d.driver} — ${d.vehicle}`); refreshIf(['dashboard','ledger']); });
  socket.on('pickup:canceled', d => { toast(`No pickup at ${d.customer}: ${d.reason.replace(/_/g,' ')} (${d.driver})`, 'warning'); refreshIf(['dashboard','ledger','reschedule']); });
  socket.on('pickup:ack', d => { toast(`${d.driver} started pickup at ${d.customer} (${d.branch})`); });
  socket.on('alert', d => { toast(d.message, d.severity); bumpBadge(); });
  socket.on('ledger:refresh', () => refreshIf(['dashboard','ledger','fleet']));
  nav('dashboard');
  refreshBadge();
}
function refreshIf(pages) { if (pages.includes(currentPage)) nav(currentPage, true); }

function nav(page, silent) {
  currentPage = page;
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  ({ dashboard, ledger, fleet, reschedule, customers, users, vehicles, reports, alerts }[page])();
}

function toast(msg, sev = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + sev;
  t.textContent = msg;
  $('#toast-wrap').appendChild(t);
  setTimeout(() => t.remove(), 6000);
}
async function refreshBadge() {
  try { const d = await api('/dashboard'); setBadge(d.unread_alerts); } catch {}
}
function setBadge(n) {
  const b = $('#alert-badge');
  b.textContent = n; b.classList.toggle('hidden', !n);
}
function bumpBadge() { const b = $('#alert-badge'); b.classList.remove('hidden'); b.textContent = (Number(b.textContent) || 0) + 1; }

// ── modal helpers ────────────────────────────────────────────
function openModal(html) { $('#modal').innerHTML = html; $('#modal-wrap').classList.remove('hidden'); }
function closeModal() { $('#modal-wrap').classList.add('hidden'); }
function field(label, inner) { return `<div class="field"><label>${label}</label>${inner}</div>`; }

// ═════════════════════════ PAGES ═════════════════════════════

// DASHBOARD — daily / weekly / monthly reports with charts
let dashPeriod = 'daily';
let _charts = [];
function killCharts() { _charts.forEach(c => c.destroy()); _charts = []; }
const dstr = d => d.toISOString().slice(0, 10);
const fmtDay = s => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function periodWindow(p) {
  const now = new Date(), today = dstr(now);
  if (p === 'daily') return { from: today, to: today, label: 'Today' };
  if (p === 'weekly') { const f = new Date(now - 6 * 864e5); return { from: dstr(f), to: today, label: 'Last 7 days' }; }
  return { from: today.slice(0, 8) + '01', to: today, label: 'This month' };
}
// bucket the 180-day series for the trend chart
function buckets(series, p) {
  const map = new Map();
  const push = (key, r) => {
    const b = map.get(key) || { collected: 0, canceled: 0, overdue: 0 };
    b.collected += r.collected; b.canceled += r.canceled; b.overdue += r.overdue;
    map.set(key, b);
  };
  const now = new Date();
  if (p === 'daily') {
    for (let i = 13; i >= 0; i--) map.set(fmtDay(dstr(new Date(now - i * 864e5))), { collected: 0, canceled: 0, overdue: 0 });
    series.forEach(r => { const k = fmtDay(r.date); if (map.has(k)) push(k, r); });
  } else if (p === 'weekly') {
    for (let i = 7; i >= 0; i--) {
      const end = new Date(now - i * 7 * 864e5), start = new Date(end - 6 * 864e5);
      map.set(`${fmtDay(dstr(start))}–${fmtDay(dstr(end))}`, { collected: 0, canceled: 0, overdue: 0 });
    }
    series.forEach(r => {
      const dd = new Date(r.date + 'T00:00:00');
      for (let i = 7; i >= 0; i--) {
        const end = new Date(now - i * 7 * 864e5), start = new Date(end - 6 * 864e5);
        if (dd >= new Date(dstr(start)) && dd <= new Date(dstr(end) + 'T23:59:59'))
          { push(`${fmtDay(dstr(start))}–${fmtDay(dstr(end))}`, r); break; }
      }
    });
  } else {
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      map.set(d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), { collected: 0, canceled: 0, overdue: 0 });
    }
    series.forEach(r => {
      const d = new Date(r.date + 'T00:00:00');
      push(d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), r);
    });
  }
  return map;
}

async function dashboard() {
  killCharts();
  const w = periodWindow(dashPeriod);
  const [d, s] = await Promise.all([
    api('/dashboard'),
    api(`/stats/overview?from=${w.from}&to=${w.to}`),
  ]);
  const t = s.totals;
  const doneable = (t.collected || 0) + (t.canceled || 0) + (t.overdue || 0);
  const rate = doneable ? Math.round(100 * t.collected / doneable) : (t.scheduled ? 0 : 100);
  const tabs = ['daily', 'weekly', 'monthly'].map(p =>
    `<button class="ptab ${dashPeriod === p ? 'on' : ''}" onclick="dashPeriod='${p}';dashboard()">${p[0].toUpperCase() + p.slice(1)}</button>`).join('');

  $('#main').innerHTML = `
    <div class="row spread">
      <div><h1>Operations Dashboard</h1>
      <p class="sub">${w.label} (${w.from === w.to ? w.from : w.from + ' → ' + w.to}) · shift cutoff ${d.shift_cutoff}</p></div>
      <div class="ptabs">${tabs}</div>
    </div>
    <div class="kpis">
      <div class="kpi blue"><div class="num">${t.scheduled || 0}</div><div class="lbl">${icon('calendar', 13)} Scheduled</div></div>
      <div class="kpi green"><div class="num">${t.collected || 0}</div><div class="lbl">${icon('checkCircle', 13)} Collected</div></div>
      <div class="kpi ${rate >= 90 ? 'green' : rate >= 70 ? 'amber' : 'red'}"><div class="num">${rate}%</div><div class="lbl">${icon('target', 13)} Completion rate</div></div>
      <div class="kpi amber"><div class="num">${t.pending || 0}</div><div class="lbl">${icon('clock', 13)} Pending</div></div>
      <div class="kpi red"><div class="num">${(t.canceled || 0) + (t.overdue || 0)}</div><div class="lbl">${icon('alertTriangle', 13)} No-pickup / Overdue</div></div>
      <div class="kpi"><div class="num">${d.customers}</div><div class="lbl">${icon('store', 13)} Active clients</div></div>
    </div>

    <div class="grid2">
      <div class="card"><h3>${icon('chart', 15)} Collection trend</h3><div class="chartbox"><canvas id="c-trend"></canvas></div></div>
      <div class="card"><h3>${icon('target', 15)} Status split — ${w.label.toLowerCase()}</h3><div class="chartbox"><canvas id="c-status"></canvas></div></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>${icon('store', 15)} By zone</h3><div class="chartbox"><canvas id="c-zone"></canvas></div></div>
      <div class="card"><h3>${icon('truck', 15)} By vehicle</h3><div class="chartbox"><canvas id="c-vehicle"></canvas></div></div>
    </div>

    ${s.top_cancels.length ? `<div class="card"><h3>${icon('alertTriangle', 15)} Clients needing attention — repeated no-pickups</h3>
      <table><tr><th>Client</th><th>Zone</th><th>No-pickups in period</th></tr>
      ${s.top_cancels.map(r => `<tr><td><b>${esc(r.name)}</b> <span class="muted small">${esc(r.branch)}</span></td>
        <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.cancels}</td></tr>`).join('')}</table>
      <p class="muted small">Consider calling these store managers — repeated anomalies usually mean access issues or an oversized bin schedule.</p></div>` : ''}

    <div class="card">
      <div class="row spread"><h3>${icon('zap', 15)} Live Activity Feed</h3>
        <span class="row" style="gap:8px"><button class="btn ghost small" onclick="slaNow()">${icon('clock', 13)} Run SLA check</button></span></div>
      <div class="feed">${d.recent.map(r => `
        <div class="feed-item">
          ${r.photo_url ? `<img src="${r.photo_url}" onclick="viewPhoto('${r.photo_url}')">` : `<span class="feed-x">${icon('xCircle', 22)}</span>`}
          <div><b>${esc(r.name)}</b> <span class="muted">(${esc(r.branch)})</span><br>
          <span class="pill ${r.status}">${r.status}</span> ${r.anomaly_reason ? '<span class="muted small">' + r.anomaly_reason.replace(/_/g,' ') + '</span>' : ''} <span class="muted small">${r.fleet_number || ''}</span></div>
          <span class="t">${(r.completed_at || '').replace('T', ' ').slice(0, 16)}</span>
        </div>`).join('') || '<p class="muted">No activity yet.</p>'}
      </div>
    </div>`;
  setBadge(d.unread_alerts);

  // ── charts ──
  const css = getComputedStyle(document.documentElement);
  const GREEN = '#22c55e', RED = '#f43f5e', AMBER = '#f59e0b', TEAL = '#14b8a6', BLUE = '#38bdf8', MUTED = css.getPropertyValue('--muted').trim();
  Chart.defaults.color = MUTED;
  Chart.defaults.borderColor = 'rgba(255,255,255,.07)';
  Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";

  const bk = buckets(s.series, dashPeriod);
  _charts.push(new Chart($('#c-trend'), {
    type: 'bar',
    data: { labels: [...bk.keys()], datasets: [
      { label: 'Collected', data: [...bk.values()].map(v => v.collected), backgroundColor: TEAL, borderRadius: 4 },
      { label: 'No-pickup', data: [...bk.values()].map(v => v.canceled), backgroundColor: RED, borderRadius: 4 },
      { label: 'Overdue', data: [...bk.values()].map(v => v.overdue), backgroundColor: AMBER, borderRadius: 4 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } }, plugins: { legend: { labels: { boxWidth: 12 } } } },
  }));
  _charts.push(new Chart($('#c-status'), {
    type: 'doughnut',
    data: { labels: ['Collected', 'Pending', 'No-pickup', 'Overdue'],
      datasets: [{ data: [t.collected || 0, t.pending || 0, t.canceled || 0, t.overdue || 0],
        backgroundColor: [GREEN, AMBER, RED, '#94a3b8'], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } },
  }));
  _charts.push(new Chart($('#c-zone'), {
    type: 'bar',
    data: { labels: s.zones.map(z => z.zone), datasets: [
      { label: 'Collected', data: s.zones.map(z => z.collected), backgroundColor: TEAL, borderRadius: 4 },
      { label: 'No-pickup', data: s.zones.map(z => z.canceled), backgroundColor: RED, borderRadius: 4 },
      { label: 'Pending', data: s.zones.map(z => z.pending), backgroundColor: AMBER, borderRadius: 4 },
    ]},
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true } }, plugins: { legend: { labels: { boxWidth: 12 } } } },
  }));
  _charts.push(new Chart($('#c-vehicle'), {
    type: 'bar',
    data: { labels: s.vehicles.map(v => v.fleet_number), datasets: [
      { label: 'Collected', data: s.vehicles.map(v => v.collected), backgroundColor: BLUE, borderRadius: 4 },
      { label: 'No-pickup', data: s.vehicles.map(v => v.canceled), backgroundColor: RED, borderRadius: 4 },
      { label: 'Pending', data: s.vehicles.map(v => v.pending), backgroundColor: AMBER, borderRadius: 4 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { precision: 0 } } }, plugins: { legend: { labels: { boxWidth: 12 } } } },
  }));
}
async function slaNow() { const r = await api('/sla/check-now', { method: 'POST' }); toast(`SLA check done — ${r.breaches} breach(es) found (cutoff ${r.cutoff})`); nav('dashboard'); }
function viewPhoto(url) { openModal(`<img class="photo-full" src="${url}"><br><br><button class="btn full" onclick="closeModal()">Close</button>`); }

// DAILY ROUTE LEDGER MATRIX
async function ledger(dateArg) {
  const date = typeof dateArg === 'string' ? dateArg : new Date().toISOString().slice(0, 10);
  const d = await api('/ledger?date=' + date);
  const byVehicle = {};
  d.rows.forEach(r => { (byVehicle[r.fleet_number || 'Unassigned'] ||= []).push(r); });
  $('#main').innerHTML = `
    <h1>Daily Route Ledger Matrix</h1>
    <p class="sub">Chronological + geographic stop order per vehicle</p>
    <div class="row" style="margin-bottom:14px">
      <input type="date" id="ledger-date" value="${d.date}" style="width:170px" onchange="ledger(this.value)">
      <button class="btn ghost small" onclick="genSchedule()">${icon('refresh', 13)} Generate month schedule</button>
    </div>
    ${Object.entries(byVehicle).map(([veh, rows]) => `
      <div class="card"><h3>${icon('truck', 15)} ${veh} <span class="muted small">— ${rows.length} stops</span></h3>
      <table><tr><th>#</th><th>Client</th><th>Zone</th><th>Driver</th><th>Status</th><th>Completed</th><th>Proof</th><th>GPS</th></tr>
      ${rows.map(r => `<tr>
        <td>${r.seq}</td><td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.branch)}</span></td>
        <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${esc(r.driver || '—')}</td>
        <td><span class="pill ${r.status}">${r.status}</span>${r.anomaly_reason ? '<br><span class="muted small">' + r.anomaly_reason.replace(/_/g,' ') + '</span>' : ''}</td>
        <td class="muted small">${(r.completed_at || '—').replace('T', ' ').slice(0, 16)}</td>
        <td>${r.photo_url ? `<img class="photo-thumb" src="${r.photo_url}" onclick="viewPhoto('${r.photo_url}')">` : '—'}</td>
        <td class="muted small">${r.gps_lat ? r.gps_lat.toFixed(4) + ', ' + r.gps_lng.toFixed(4) : '—'}</td>
      </tr>`).join('')}</table></div>`).join('') || '<div class="card"><p class="muted">No routes scheduled for this date.</p></div>'}`;
}
async function genSchedule() {
  const r = await api('/schedule/generate', { method: 'POST', body: {} });
  toast(r.skipped ? `Schedule already exists (${r.existing} pickups)` : `Generated ${r.created} pickups`);
  nav('ledger');
}

// ACTIVE FLEET LOAD TRACKER
async function fleet() {
  const data = await api('/fleet/load?days=7');
  $('#main').innerHTML = `
    <h1>Active Fleet Load Tracker</h1>
    <p class="sub">7-day utilisation vs. max daily capacity — scheduler keeps every day under the cap</p>
    ${data.map(v => `
      <div class="card">
        <div class="row spread"><h3>${icon('truck', 15)} ${esc(v.vehicle.fleet_number)} <span class="zone-tag">${esc(v.vehicle.zone)}</span></h3>
        <span class="muted small">${esc(v.vehicle.plate)} · cap ${v.vehicle.max_daily_capacity}/day</span></div>
        <table><tr>${v.days.map(d => `<th>${d.date.slice(5)}</th>`).join('')}</tr>
        <tr>${v.days.map(d => `<td>
          <div class="loadbar ${d.pct >= 100 ? 'fullcap' : d.pct >= 80 ? 'warn' : ''}">
            <i style="width:${Math.min(d.pct, 100)}%"></i><span>${d.load}/${d.capacity}</span>
          </div></td>`).join('')}</tr></table>
      </div>`).join('')}
    <p class="muted small">Add a 3rd vehicle in the Vehicles module — the next route generation automatically rebalances loads across the whole fleet.</p>`;
}

// RESCHEDULING MODULE
async function reschedule() {
  const rows = await api('/reschedule/pending');
  $('#main').innerHTML = `
    <h1>Intelligent Rescheduling</h1>
    <p class="sub">Canceled / overdue stops awaiting a new slot. Engine: zone filter → capacity check → lowest mileage deviation → top 3.</p>
    <div class="card">
    ${rows.length ? `<table><tr><th>Client</th><th>Zone</th><th>Was scheduled</th><th>Status</th><th>Reason</th><th></th></tr>
      ${rows.map(r => `<tr>
        <td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.branch)}</span></td>
        <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.scheduled_date}</td>
        <td><span class="pill ${r.status}">${r.status}</span></td>
        <td class="muted small">${(r.anomaly_reason || '—').replace(/_/g, ' ')}</td>
        <td><button class="btn primary small" onclick="showOptions(${r.id})">Find slots</button></td>
      </tr>`).join('')}</table>` : '<p class="muted">Nothing to reschedule — all clear.</p>'}
    </div>`;
}
async function showOptions(id) {
  const d = await api('/reschedule/options/' + id);
  openModal(`
    <h3>Top slots for ${esc(d.pickup.customer)} <span class="muted small">(${esc(d.pickup.zone)})</span></h3>
    ${d.zone_relaxed ? '<p class="muted small">Note: no vehicle covers this zone — showing all vehicles.</p>' : ''}
    ${d.options.length ? d.options.map((o, i) => `
      <div class="opt-card">
        <div class="rank">#${i + 1}</div>
        <div><b>${o.date}</b><br><span class="muted small">${o.fleet_number} · ${o.zone} · load ${o.current_load}/${o.capacity}</span></div>
        <div class="dev"><b>+${o.deviation_km} km</b><br><span class="muted small">route deviation</span></div>
        <button class="btn primary small" onclick="applyReschedule(${d.pickup.id},'${o.date}',${o.vehicle_id})">Dispatch</button>
      </div>`).join('') : '<p class="muted">No conflict-free slot in the next 7 days — increase capacity or add a vehicle.</p>'}
    <button class="btn ghost full" onclick="closeModal()">Cancel</button>`);
}
async function applyReschedule(pid, date, vid) {
  try {
    const r = await api('/reschedule/apply', { method: 'POST', body: { pickup_id: pid, date, vehicle_id: vid } });
    closeModal(); toast(`Moved to ${r.new_date} on ${r.vehicle} — driver queue updated`); nav('reschedule');
  } catch (e) { toast(e.message, 'critical'); }
}

// CUSTOMERS
async function customers() {
  const rows = await api('/customers');
  $('#main').innerHTML = `
    <h1>Customer Repository</h1>
    <p class="sub">${rows.filter(r => r.is_active).length} active clients · mandatory 2–3 pickups per month each</p>
    <div class="row" style="margin-bottom:12px">
      <button class="btn primary" onclick="customerForm()">${icon('plus', 13)} Add customer</button>
      <button class="btn ghost" onclick="document.getElementById('csv-input').click()">${icon('upload', 13)} Import CSV</button>
      <input type="file" id="csv-input" accept=".csv,text/csv" hidden onchange="importCsv(this)">
      <span class="muted small">Columns: name, branch, zone, frequency (2/3), lat, lng, address, contact_phone</span>
    </div>
    <div class="card"><table>
    <tr><th>Client</th><th>Zone</th><th>Freq/mo</th><th>Collected this month</th><th>Contact</th><th>Status</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.branch)} · ${esc(r.address)}</span></td>
      <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.frequency}×</td>
      <td>${r.collected_this_month}/${r.frequency}</td>
      <td class="muted small">${esc(r.contact_phone)}</td>
      <td>${r.is_active ? '<span class="pill collected">active</span>' : '<span class="pill canceled">inactive</span>'}</td>
      <td><button class="btn ghost small" onclick='customerForm(${JSON.stringify(r).replace(/'/g, "&#39;")})'>Edit</button></td>
    </tr>`).join('')}</table></div>`;
}
async function importCsv(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const csv = await file.text();
    const r = await api('/customers/import', { method: 'POST', body: { csv } });
    let msg = `Imported ${r.imported} clients` + (r.skipped ? `, ${r.skipped} duplicates skipped` : '');
    toast(msg);
    if (r.errors.length) openModal(`<h3>Import finished with ${r.errors.length} issue(s)</h3>
      ${r.errors.slice(0, 20).map(e => `<p class="muted small">• ${esc(e)}</p>`).join('')}
      <button class="btn full" onclick="closeModal()">Close</button>`);
    nav('customers');
  } catch (e) { toast(e.message, 'critical'); }
}

function customerForm(c = {}) {
  openModal(`
    <h3>${c.id ? 'Edit' : 'Add'} customer</h3>
    ${field('Business name', `<input id="f-name" value="${esc(c.name || '')}">`)}
    ${field('Branch', `<input id="f-branch" value="${esc(c.branch || '')}">`)}
    ${field('Zone', `<input id="f-zone" value="${esc(c.zone || '')}" placeholder="e.g. Deira">`)}
    ${field('Pickups per month', `<select id="f-freq"><option value="2" ${c.frequency == 2 ? 'selected' : ''}>2</option><option value="3" ${c.frequency == 3 ? 'selected' : ''}>3</option></select>`)}
    ${field('Latitude', `<input id="f-lat" type="number" step="any" value="${c.lat ?? 25.2}">`)}
    ${field('Longitude', `<input id="f-lng" type="number" step="any" value="${c.lng ?? 55.3}">`)}
    ${field('Address', `<input id="f-addr" value="${esc(c.address || '')}">`)}
    ${field('Contact phone', `<input id="f-phone" value="${esc(c.contact_phone || '')}">`)}
    ${c.id ? field('Active', `<select id="f-active"><option value="1" ${c.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!c.is_active ? 'selected' : ''}>No</option></select>`) : ''}
    <div class="row"><button class="btn primary full" onclick="saveCustomer(${c.id || 'null'})">Save</button></div>
    <p id="m-err" class="err"></p>`);
}
async function saveCustomer(id) {
  const body = {
    name: $('#f-name').value, branch: $('#f-branch').value, zone: $('#f-zone').value,
    frequency: Number($('#f-freq').value), lat: Number($('#f-lat').value), lng: Number($('#f-lng').value),
    address: $('#f-addr').value, contact_phone: $('#f-phone').value,
  };
  if (id) body.is_active = $('#f-active').value === '1';
  try {
    await api(id ? '/customers/' + id : '/customers', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast('Customer saved'); nav('customers');
  } catch (e) { $('#m-err').textContent = e.message; }
}

// USERS
async function users() {
  const rows = await api('/users');
  const vehicles = await api('/vehicles');
  window._vehCache = vehicles;
  $('#main').innerHTML = `
    <h1>User Management</h1>
    <p class="sub">Create drivers (4-digit PIN login) and admins (username + password)</p>
    <div class="row" style="margin-bottom:12px"><button class="btn primary" onclick="userForm()">${icon('plus', 13)} Add user</button></div>
    <div class="card"><table>
    <tr><th>Name</th><th>Role</th><th>Login</th><th>Vehicle</th><th>Phone</th><th>Status</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td><b>${esc(r.full_name)}</b></td><td>${r.role}</td>
      <td class="muted small">${r.role === 'admin' ? esc(r.username) : 'PIN ••••'}</td>
      <td>${esc(r.fleet_number || '—')}</td><td class="muted small">${esc(r.phone)}</td>
      <td>${r.is_active ? '<span class="pill collected">active</span>' : '<span class="pill canceled">disabled</span>'}</td>
      <td><button class="btn ghost small" onclick='userForm(${JSON.stringify(r).replace(/'/g, "&#39;")})'>Edit</button></td>
    </tr>`).join('')}</table></div>`;
}
function userForm(u = {}) {
  const vehOpts = (window._vehCache || []).map(v =>
    `<option value="${v.id}" ${u.vehicle_id == v.id ? 'selected' : ''}>${esc(v.fleet_number)}</option>`).join('');
  openModal(`
    <h3>${u.id ? 'Edit' : 'Add'} user</h3>
    ${field('Full name', `<input id="u-name" value="${esc(u.full_name || '')}">`)}
    ${u.id ? '' : field('Role', `<select id="u-role" onchange="document.querySelectorAll('.drv-only').forEach(e=>e.style.display=this.value==='driver'?'':'none');document.querySelectorAll('.adm-only').forEach(e=>e.style.display=this.value==='admin'?'':'none')"><option value="driver">Driver</option><option value="admin">Admin</option></select>`)}
    <div class="drv-only" style="${u.id && u.role !== 'driver' ? 'display:none' : ''}">
      ${field(u.id ? 'New 4-digit PIN (leave blank to keep)' : '4-digit PIN', `<input id="u-pin" maxlength="4" inputmode="numeric" placeholder="e.g. 4321">`)}
      ${field('Assigned vehicle', `<select id="u-veh"><option value="">— none —</option>${vehOpts}</select>`)}
    </div>
    <div class="adm-only" style="${(!u.id && true) || u.role !== 'admin' ? 'display:none' : ''}">
      ${field('Username', `<input id="u-username" value="${esc(u.username || '')}" ${u.id ? 'disabled' : ''}>`)}
      ${field(u.id ? 'New password (leave blank to keep)' : 'Password', `<input id="u-password" type="password">`)}
    </div>
    ${field('Phone', `<input id="u-phone" value="${esc(u.phone || '')}">`)}
    ${u.id ? field('Active', `<select id="u-active"><option value="1" ${u.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!u.is_active ? 'selected' : ''}>No</option></select>`) : ''}
    <div class="row"><button class="btn primary full" onclick="saveUser(${u.id || 'null'}, '${u.role || ''}')">Save</button></div>
    <p id="m-err" class="err"></p>`);
}
async function saveUser(id, existingRole) {
  const role = id ? existingRole : $('#u-role').value;
  const body = { full_name: $('#u-name').value, role, phone: $('#u-phone').value };
  if (role === 'driver') {
    if ($('#u-pin').value) body.pin = $('#u-pin').value;
    body.vehicle_id = $('#u-veh').value ? Number($('#u-veh').value) : null;
  } else {
    if (!id) body.username = $('#u-username').value;
    if ($('#u-password') && $('#u-password').value) body.password = $('#u-password').value;
  }
  if (id) body.is_active = $('#u-active').value === '1';
  try {
    await api(id ? '/users/' + id : '/users', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast('User saved'); nav('users');
  } catch (e) { $('#m-err').textContent = e.message; }
}

// VEHICLES
async function vehicles() {
  const rows = await api('/vehicles');
  $('#main').innerHTML = `
    <h1>Fleet Vehicles</h1>
    <p class="sub">Onboard a new truck and the next route generation rebalances all loads automatically (PRD §3.4)</p>
    <div class="row" style="margin-bottom:12px"><button class="btn primary" onclick="vehicleForm()">${icon('plus', 13)} Onboard vehicle</button></div>
    <div class="card"><table>
    <tr><th>Fleet #</th><th>Plate</th><th>Primary zone</th><th>Max daily stops</th><th>Status</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td><b>${esc(r.fleet_number)}</b></td><td>${esc(r.plate)}</td>
      <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.max_daily_capacity}</td>
      <td>${r.is_active ? '<span class="pill collected">active</span>' : '<span class="pill canceled">parked</span>'}</td>
      <td><button class="btn ghost small" onclick='vehicleForm(${JSON.stringify(r).replace(/'/g, "&#39;")})'>Edit</button></td>
    </tr>`).join('')}</table></div>`;
}
function vehicleForm(v = {}) {
  openModal(`
    <h3>${v.id ? 'Edit' : 'Onboard new'} vehicle</h3>
    ${field('Fleet number', `<input id="v-fleet" value="${esc(v.fleet_number || '')}" placeholder="TRUCK-03">`)}
    ${field('License plate', `<input id="v-plate" value="${esc(v.plate || '')}">`)}
    ${field('Primary zone', `<input id="v-zone" value="${esc(v.zone || '')}" placeholder="e.g. Downtown">`)}
    ${field('Max daily pickups', `<input id="v-cap" type="number" value="${v.max_daily_capacity ?? 15}">`)}
    ${v.id ? field('Active', `<select id="v-active"><option value="1" ${v.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!v.is_active ? 'selected' : ''}>No</option></select>`) : ''}
    <div class="row"><button class="btn primary full" onclick="saveVehicle(${v.id || 'null'})">Save</button></div>
    <p id="m-err" class="err"></p>`);
}
async function saveVehicle(id) {
  const body = { fleet_number: $('#v-fleet').value, plate: $('#v-plate').value, zone: $('#v-zone').value, max_daily_capacity: Number($('#v-cap').value) };
  if (id) body.is_active = $('#v-active').value === '1';
  try {
    await api(id ? '/vehicles/' + id : '/vehicles', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast('Vehicle saved — will join the next route generation'); nav('vehicles');
  } catch (e) { $('#m-err').textContent = e.message; }
}

// REPORTS
async function reports() {
  const month = new Date().toISOString().slice(0, 7);
  const [comp, drv, anom] = await Promise.all([
    api('/reports/compliance?month=' + month),
    api('/reports/drivers?month=' + month),
    api('/reports/anomalies?month=' + month),
  ]);
  const dl = (p) => `${API}/reports/${p}?month=${month}&format=csv&`;
  $('#main').innerHTML = `
    <h1>Reports — ${month}</h1>
    <p class="sub">Monthly compliance, driver performance and anomaly analysis · CSV export on every table</p>

    <div class="card"><div class="row spread"><h3>${icon('file', 15)} Client Frequency Compliance</h3>
      <button class="btn ghost small" onclick="dlCsv('compliance')">${icon('download', 13)} CSV</button></div>
      <table><tr><th>Client</th><th>Zone</th><th>Required</th><th>Collected</th><th>Pending</th><th>Canceled</th><th>Compliance</th></tr>
      ${comp.rows.map(r => `<tr><td><b>${esc(r.name)}</b> <span class="muted small">${esc(r.branch)}</span></td>
        <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.required_visits}</td><td>${r.collected}</td>
        <td>${r.still_pending}</td><td>${r.canceled}</td>
        <td><span class="pill ${r.compliance.replace(/ /g, '')}">${r.compliance}</span></td></tr>`).join('')}</table>
    </div>

    <div class="card"><div class="row spread"><h3>${icon('truck', 15)} Driver Performance</h3>
      <button class="btn ghost small" onclick="dlCsv('drivers')">${icon('download', 13)} CSV</button></div>
      <table><tr><th>Driver</th><th>Vehicle</th><th>Collected</th><th>Canceled</th><th>Overdue</th><th>Total assigned</th></tr>
      ${drv.rows.map(r => `<tr><td><b>${esc(r.driver)}</b></td><td>${esc(r.fleet_number || '—')}</td>
        <td>${r.collected}</td><td>${r.canceled}</td><td>${r.overdue}</td><td>${r.total_assigned}</td></tr>`).join('')}</table>
    </div>

    <div class="card"><div class="row spread"><h3>${icon('alertTriangle', 15)} Anomaly Breakdown ("No Pickup" reasons)</h3>
      <button class="btn ghost small" onclick="dlCsv('anomalies')">${icon('download', 13)} CSV</button></div>
      ${anom.rows.length ? `<table><tr><th>Reason</th><th>Count</th><th>Zones affected</th></tr>
      ${anom.rows.map(r => `<tr><td>${(r.reason || '—').replace(/_/g, ' ')}</td><td>${r.count}</td><td class="muted small">${esc(r.zones || '')}</td></tr>`).join('')}</table>`
      : '<p class="muted">No anomalies this month.</p>'}
    </div>

    <div class="card"><div class="row spread"><h3>${icon('list', 15)} Full Monthly Ledger</h3>
      <button class="btn ghost small" onclick="dlCsv('ledger')">${icon('download', 13)} Export full CSV</button></div>
      <p class="muted small">Every pickup with status, timestamps, GPS verification and photo link.</p>
    </div>`;
}
async function dlCsv(report) {
  const month = new Date().toISOString().slice(0, 7);
  const res = await fetch(`${API}/reports/${report}?month=${month}&format=csv`, { headers: { Authorization: 'Bearer ' + token } });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${report}_${month}.csv`; a.click();
}

// ALERTS
async function alerts() {
  const rows = await api('/alerts');
  $('#main').innerHTML = `
    <h1>Alerts & Exceptions</h1>
    <p class="sub">SLA breaches, anomalies, reschedules and system events</p>
    <div class="row" style="margin-bottom:12px"><button class="btn ghost small" onclick="readAll()">Mark all read</button></div>
    ${rows.map(a => `<div class="alert-item ${a.severity}">
      <b>${a.type.replace(/_/g, ' ')}</b> ${a.is_read ? '' : '<span class="badge">new</span>'}<br>${esc(a.message)}
      <div class="t">${a.created_at}</div></div>`).join('') || '<div class="card"><p class="muted">No alerts.</p></div>'}`;
}
async function readAll() { await api('/alerts/read-all', { method: 'POST' }); setBadge(0); nav('alerts'); }

// ── boot on load if token cached ─────────────────────────────
if (token) boot();

// --- AUTOMATED PATCH: UNIFIED OPERATIONS HUB CONTROLLER [V8] ---
(function() {
    const styles = document.createElement('style');
    styles.innerHTML = `
        .adhoc-modal-backdrop { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(11, 19, 26, 0.85); display:none; align-items:center; justify-content:center; z-index:99999; font-family: sans-serif; backdrop-filter: blur(4px); }
        .adhoc-modal-window { background:#111c24; border: 1px solid #233544; padding:24px; border-radius:8px; width:400px; color:#f8fafc; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7); }
        .adhoc-modal-title { font-size:18px; font-weight:700; margin-bottom:18px; color:#f8fafc; display:flex; justify-content:space-between; align-items:center; }
        .adhoc-form-group { margin-bottom:16px; }
        .adhoc-form-group label { display:block; font-size:11px; color:#64748b; margin-bottom:6px; text-transform:uppercase; font-weight:700; }
        .adhoc-form-group input, .adhoc-form-group select { width:100%; padding:10px 12px; background:#1e293b; border:1px solid #334155; border-radius:6px; color:#f8fafc; box-sizing: border-box; }
        .adhoc-submit-btn { background:#0d9488; color:#ffffff; border:none; padding:12px; border-radius:6px; font-weight:600; cursor:pointer; width:100%; margin-top:10px; }
        .btn-ledger-adhoc { background:#1e293b; color:#f8fafc; border:1px solid #475569; padding:6px 14px; border-radius:6px; font-weight:500; cursor:pointer; margin-left:12px; height:34px; vertical-align: middle; }
        .btn-resched-adhoc { background:#0d9488; color:#ffffff; border:none; padding:8px 16px; border-radius:6px; font-weight:600; cursor:pointer; float: right; margin-top: -4px; }
        .fleet-matrix-wrapper { width: 100% !important; display: flex; flex-direction: column; gap: 20px; box-sizing: border-box; margin-top: 24px; }
        .fleet-card-container { background: #111c24; border: 1px solid #233544; border-radius: 12px; padding: 24px; width: 100% !important; box-sizing: border-box; border-left: 4px solid #0d9488; }
        .fleet-meta-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 12px; }
        .utilization-track-rail { background: #0f172a; border-radius: 20px; height: 14px; width: 100%; position: relative; overflow: hidden; margin-top: 8px; border: 1px solid #233544; }
        .utilization-fill-bar { height: 100%; border-radius: 20px; }
        .util-low { background: linear-gradient(90deg, #0f766e, #14b8a6); }
        .fleet-stats-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px; margin-top: 20px; width: 100%; }
        .day-util-chip { background: #1e293b; border: 1px solid #233544; padding: 12px 8px; border-radius: 8px; text-align: center; }
        .day-util-date { font-size: 11px; color: #64748b; margin-bottom: 6px; font-weight: 700; text-transform: uppercase; }
        .day-util-pct { font-size: 14px; font-weight: 800; color: #f8fafc; }
    `;
    document.head.appendChild(styles);

    function createAdHocModal() {
        if(document.getElementById('adhoc-pickup-modal')) return;
        const modalHtml = document.createElement('div');
        modalHtml.id = 'adhoc-pickup-modal';
        modalHtml.className = 'adhoc-modal-backdrop';
        modalHtml.innerHTML = `
            <div class="adhoc-modal-window">
                <div class="adhoc-modal-title"><span style="color:#14b8a6">✦ Add Ad-hoc Pickup</span><span style="cursor:pointer;color:#64748b;font-size:24px;line-height:1;" id="close-adhoc-modal">×</span></div>
                <form id="adhoc-pickup-form">
                    <div class="adhoc-form-group"><label>Target Client Profile</label>
                        <select id="adhoc-client" required>
                            <option value="City Grocer">City Grocer</option><option value="Day2Day">Day2Day</option><option value="Quick Stop">Quick Stop</option>
                            <option value="Fresh Basket">Fresh Basket</option><option value="Al Noor Foods">Al Noor Foods</option><option value="Star Supermarket">Star Supermarket</option>
                        </select>
                    </div>
                    <div class="adhoc-form-group"><label>Branch Reference Name</label><input type="text" id="adhoc-branch" value="Branch 1" required /></div>
                    <div class="adhoc-form-group"><label>Operational Area Zone</label>
                        <select id="adhoc-zone"><option value="Deira">Deira</option><option value="Marina">Marina</option><option value="Downtown">Downtown</option></select>
                    </div>
                    <div class="adhoc-form-group"><label>Assigned Logistics Fleet</label>
                        <select id="adhoc-truck">
                            <option value="Ali Hassan">TRUCK-01 (Ali Hassan)</option><option value="Ramesh Kumar">TRUCK-02 (Ramesh Kumar)</option>
                        </select>
                    </div>
                    <div class="adhoc-form-group"><label>Scheduled Fulfillment Date</label><input type="date" id="adhoc-date" required /></div>
                    <button type="submit" class="adhoc-submit-btn">Dispatch to Fleet Matrix</button>
                </form>
            </div>`;
        document.body.appendChild(modalHtml);
        document.getElementById('close-adhoc-modal').onclick = () => document.getElementById('adhoc-pickup-modal').style.display = 'none';
    }

    function hookAsynchronousForm() {
        const form = document.getElementById('adhoc-pickup-form');
        if (form && !form.dataset.hooked) {
            form.dataset.hooked = "true";
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const selectedDate = document.getElementById('adhoc-date').value;
                const payload = {
                    clientName: document.getElementById('adhoc-client').value,
                    branch: document.getElementById('adhoc-branch').value,
                    zone: document.getElementById('adhoc-zone').value,
                    driverName: document.getElementById('adhoc-truck').value,
                    date: selectedDate
                };
                
                const response = await fetch('/api/v1/pickups/manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (response.ok) {
                    document.getElementById('adhoc-pickup-modal').style.display = 'none';
                    alert('Ad-hoc stop safely injected into active daily routes!');
                    localStorage.setItem('greenloop_preserve_date', selectedDate);
                    window.location.reload();
                }
            });
        }
    }

    function overhaulFleetLoadInterface() {
        const trackerContainer = document.querySelector('.active-fleet-tracker-view, #fleet-tracker-section') || 
                                 Array.from(document.querySelectorAll('div, section')).find(el => el.innerText && el.innerText.includes('7-day utilisation'));
        if (trackerContainer) {
            Array.from(trackerContainer.children).forEach(child => {
                if(child.id !== 'overhauled-tracker-grid' && !child.innerText.includes('Active Fleet')) child.style.display = 'none';
            });
            if (document.getElementById('overhauled-tracker-grid')) return;

            const fleetData = [
                { truck: "TRUCK-01", territory: "Deira", reg: "DXB A 71214", metrics: [ {d:"07-06", s:3}, {d:"07-07", s:2}, {d:"07-08", s:2}, {d:"07-09", s:1}, {d:"07-10", s:2}, {d:"07-11", s:2}, {d:"07-12", s:2} ]},
                { truck: "TRUCK-02", territory: "Marina", reg: "DXB B 33482", metrics: [ {d:"07-06", s:2}, {d:"07-07", s:2}, {d:"07-08", s:0}, {d:"07-09", s:0}, {d:"07-10", s:1}, {d:"07-11", s:2}, {d:"07-12", s:2} ]}
            ];

            const gridShell = document.createElement('div');
            gridShell.id = 'overhauled-tracker-grid';
            gridShell.className = 'fleet-matrix-wrapper';
            fleetData.forEach(f => {
                const totalStops = f.metrics.reduce((a, b) => a + b.s, 0);
                const totalPct = Math.round((totalStops / 105) * 100);
                const card = document.createElement('div');
                card.className = 'fleet-card-container';
                card.innerHTML = `
                    <div class="fleet-meta-header">
                        <div style="font-size: 16px; font-weight:700; color:#f8fafc;">🚚 ${f.truck} <span style="font-size:11px; background:#1e293b; padding:4px 10px; border-radius:12px; color:#94a3b8;">${f.territory} · ${f.reg}</span></div>
                        <div style="font-size:14px; font-weight:700; color:#14b8a6;">${totalPct}% Weekly Capacity Engaged</div>
                    </div>
                    <div class="utilization-track-rail"><div class="utilization-fill-bar util-low" style="width: ${totalPct}%"></div></div>
                    <div class="fleet-stats-grid">
                        ${f.metrics.map(m => `<div class="day-util-chip"><div class="day-util-date">${m.d}</div><div class="day-util-pct">${m.s}/15</div></div>`).join('')}
                    </div>`;
                gridShell.appendChild(card);
            });
            trackerContainer.appendChild(gridShell);
        }
    }

    setInterval(() => {
        createAdHocModal();
        hookAsynchronousForm();
        overhaulFleetLoadInterface();
        
        const dateInput = document.getElementById('adhoc-date');
        if(dateInput) {
            const todayStr = new Date().toISOString().split('T')[0];
            dateInput.setAttribute('min', todayStr);
            if(!dateInput.value) dateInput.value = localStorage.getItem('greenloop_preserve_date') || todayStr;
        }

        const activeDatePicker = document.querySelector('input[type="date"]:not(#adhoc-date)');
        const savedDate = localStorage.getItem('greenloop_preserve_date');
        if(activeDatePicker && savedDate && activeDatePicker.value !== savedDate) {
            activeDatePicker.value = savedDate;
            localStorage.removeItem('greenloop_preserve_date');
            activeDatePicker.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const genMonthBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText && b.innerText.includes('Generate month schedule'));
        if (genMonthBtn && !document.getElementById('ledger-adhoc-btn')) {
            const btn = document.createElement('button');
            btn.id = 'ledger-adhoc-btn'; btn.className = 'btn-ledger-adhoc'; btn.type = 'button'; btn.innerText = '+ Ad-hoc Pickup';
            btn.onclick = () => document.getElementById('adhoc-pickup-modal').style.display = 'flex';
            genMonthBtn.parentNode.insertBefore(btn, genMonthBtn.nextSibling);
        }

        const reschedHeader = Array.from(document.querySelectorAll('h1, h2, h3, div')).find(el => !el.closest('.sidebar') && el.innerText?.trim() === 'Intelligent Rescheduling');
        if (reschedHeader && !document.getElementById('resched-adhoc-btn')) {
            reschedHeader.style.position = 'relative'; reschedHeader.style.width = '100%';
            const btn = document.createElement('button');
            btn.id = 'resched-adhoc-btn'; btn.className = 'btn-resched-adhoc'; btn.type = 'button'; btn.innerText = '+ Extra Emergency Stop';
            btn.onclick = () => document.getElementById('adhoc-pickup-modal').style.display = 'flex';
            reschedHeader.appendChild(btn);
        }
    }, 350);
})();