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
  funnel: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>',
  repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  wallet: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M16 12h2"/><path d="M2 9h20"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mapPin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19.5 5.5a9 9 0 0 1 0 13"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
};
const icon = (name, size = 16, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
const statusIcon = s => ({ collected: icon('checkCircle', 14), canceled: icon('xCircle', 14), pending: icon('clock', 14), overdue: icon('alertTriangle', 14), rescheduled: icon('swap', 14) }[s] || '');

// [page, icon, label, roles] — roles: owner (admin) / ops
let CRM_ROLE = 'owner';
const NAV = [
  ['Operations'],
  ['dashboard', 'grid', 'Dashboard'],
  ['ledger', 'list', 'Daily Route Ledger'],
  ['fleet', 'truck', 'Fleet Load Tracker'],
  ['maintenance', 'wrench', 'Fleet maintenance'],
  ['reschedule', 'swap', 'Rescheduling'],
  ['confirmations', 'userCheck', 'Not-picked-up'],
  ['bookings', 'inbox', 'Bookings'],
  ['alerts', 'bell', 'Alerts'],
  ['broadcast', 'megaphone', 'Push notifications'],
  ['Sales'],
  ['pipeline', 'funnel', 'Pipeline'],
  ['leads', 'target', 'Leads'],
  ['quotations', 'fileText', 'Quotations'],
  ['Customers & billing'],
  ['customers', 'store', 'Customers'],
  ['plans', 'repeat', 'Service plans'],
  ['invoices', 'wallet', 'Invoices & payments'],
  ['Admin', 'owner'],
  ['catalogue', 'tag', 'Service catalogue', 'owner'],
  ['vehicles', 'truck', 'Vehicles', 'owner'],
  ['users', 'users', 'Users', 'owner'],
  ['reports', 'chart', 'Reports'],
  ['audit', 'shield', 'Audit log', 'owner'],
  ['settingsV3', 'settings', 'Settings', 'owner'],
];
const canSee = roles => !roles || roles === CRM_ROLE;
function buildNav() {
  $('#nav').innerHTML = NAV.filter(n => canSee(n.length === 2 ? n[1] : n[3])).map(n => n.length <= 2
    ? `<div class="nav-group">${n[0]}</div>`
    : `<a data-page="${n[0]}" tabindex="0">${icon(n[1], 17)} <span>${n[2]}</span>${n[0] === 'alerts' ? ' <span id="alert-badge" class="badge hidden">0</span>' : ''}</a>`).join('');
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    a.addEventListener('click', () => nav(a.dataset.page));
    a.addEventListener('keydown', e => e.key === 'Enter' && nav(a.dataset.page));
  });
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || res.statusText); err.status = res.status; err.data = data; throw err; }
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
async function boot() {
  $('#login-screen').classList.add('hidden'); $('#app').classList.remove('hidden');
  try { const me = await api('/me'); CRM_ROLE = me.crm_role === 'ops' ? 'ops' : 'owner'; $('#me-role').textContent = CRM_ROLE === 'ops' ? 'Ops staff' : 'Owner'; $('#me-name').textContent = me.name;
    if (me.weak_password) setTimeout(() => toast('Security: this account still uses the default password. Change it in Admin → Users.', 'warning'), 1200); } catch {}
  buildNav();
  socket = io({ auth: { token } });
  socket.on('connect', () => { $('#live-dot').classList.remove('off'); $('#live-label').textContent = 'live stream on'; });
  socket.on('disconnect', () => { $('#live-dot').classList.add('off'); $('#live-label').textContent = 'reconnecting…'; });
  socket.on('pickup:completed', d => { toast(`Collected: ${d.customer} (${d.branch}) by ${d.driver} — ${d.vehicle}`); refreshIf(['dashboard','ledger']); });
  socket.on('pickup:canceled', d => { toast(`No pickup at ${d.customer}: ${d.reason.replace(/_/g,' ')} (${d.driver})`, 'warning'); refreshIf(['dashboard','ledger','reschedule']); });
  socket.on('pickup:ack', d => { toast(`${d.driver} started pickup at ${d.customer} (${d.branch})`); });
  socket.on('alert', d => { toast(d.message, d.severity); bumpBadge(); });
  socket.on('ledger:refresh', () => refreshIf(['dashboard','ledger','fleet','confirmations','plans']));
  socket.on('fleet:report', () => refreshIf(['maintenance']));
  socket.on('shift:changed', () => refreshIf(['ledger']));
  socket.on('pickup:arrived', () => refreshIf(['ledger']));
  socket.on('lead:changed', () => refreshIf(['leads','pipeline','quotations']));
  socket.emit('ops:join');
  nav('dashboard');
  refreshBadge();
}
function refreshIf(pages) { if (pages.includes(currentPage)) nav(currentPage, true); }

function nav(page, silent) {
  currentPage = page;
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  const fn = window[page];
  if (typeof fn !== 'function') return;
  Promise.resolve(fn()).catch(e => { $('#main').innerHTML = `<div class="card"><h3>Could not load this page</h3><p class="muted">${esc(e.message)}</p></div>`; });
}

// System response messages: top-centre, colour-coded, dismissible (v3.2).
// sev: 'info' | 'success' | 'warning' | 'critical'. Errors stay longer.
const TOAST_ICON = { info: 'info', success: 'checkCircle', warning: 'alertTriangle', critical: 'xCircle' };
function toast(msg, sev = 'info') {
  if (!TOAST_ICON[sev]) sev = 'info';
  const wrap = $('#toast-wrap');
  // the same message twice in a row just refreshes the existing one
  const dup = [...wrap.children].find(c => c.dataset.msg === String(msg) && !c.classList.contains('out'));
  if (dup) dup.remove();
  const ms = sev === 'critical' ? 9000 : sev === 'warning' ? 7500 : 5000;
  const t = document.createElement('div');
  t.className = 'toast ' + sev;
  t.dataset.msg = String(msg);
  t.setAttribute('role', sev === 'critical' || sev === 'warning' ? 'alert' : 'status');
  t.innerHTML = `<span class="t-ic">${icon(TOAST_ICON[sev], 17)}</span><span class="t-msg"></span><button class="t-x" aria-label="Dismiss">${icon('x', 15)}</button><i class="t-bar" style="animation-duration:${ms}ms"></i>`;
  t.querySelector('.t-msg').textContent = msg;
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.querySelector('.t-x').onclick = close;
  wrap.prepend(t);                                   // newest on top
  while (wrap.children.length > 4) wrap.lastChild.remove();
  setTimeout(close, ms);
}
const toastOk = msg => toast(msg, 'success');
// Form errors written into a modal / login (".err") are also raised as a top toast,
// so a response is never hidden below the fold of a long form.
new MutationObserver(muts => {
  for (const m of muts) {
    const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    if (el && el.classList && el.classList.contains('err') && el.textContent.trim()) toast(el.textContent.trim(), 'critical');
  }
}).observe(document.body, { childList: true, characterData: true, subtree: true });

async function refreshBadge() {
  try { const d = await api('/dashboard'); setBadge(d.unread_alerts); } catch {}
}
function setBadge(n) {
  const b = $('#alert-badge'); if (!b) return;
  b.textContent = n; b.classList.toggle('hidden', !n);
}
function bumpBadge() { const b = $('#alert-badge'); if (!b) return; b.classList.remove('hidden'); b.textContent = (Number(b.textContent) || 0) + 1; }

// ── modal helpers ────────────────────────────────────────────
function openModal(html, wide) { $('#modal').className = 'modal' + (wide === 'xl' ? ' wide xl' : wide ? ' wide' : ''); $('#modal').innerHTML = html; $('#modal-wrap').classList.remove('hidden'); $('#modal').scrollTop = 0; }
function closeModal() { $('#modal-wrap').classList.add('hidden'); }
function field(label, inner) { return `<div class="field"><label>${label}</label>${inner}</div>`; }

// ═════════════════════════ PAGES ═════════════════════════════

// DASHBOARD — daily / weekly / monthly reports with charts
let dashPeriod = 'daily';
let _charts = [];
function killCharts() { _charts.forEach(c => c.destroy()); _charts = []; }
const dstr = d => d.toISOString().slice(0, 10);
const fmtDay = s => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
// One date format everywhere: DD/MM/YYYY (date / month / year). Stored values stay YYYY-MM-DD.
const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s ? String(s) : '—'); };
const dmyTime = s => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : dmy(s); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// labelled date: 05/10/2026 with the month part tinted, plus "5 Oct" spelled out underneath
function dmyParts(s) {
  const [y, mo, d] = s.split('-');
  const wd = WEEKDAYS[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
  return { wd, html: `<span class="dmy" title="Date ${d} · Month ${mo} (${MONTHS[+mo - 1]}) · Year ${y}"><span class="dd">${d}</span><span class="sep">/</span><span class="mm">${mo}</span><span class="sep">/</span><span class="yy">${y}</span></span>`, long: `${+d} ${MONTHS[+mo - 1]} ${y}` };
}

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
  const [d, s, attn] = await Promise.all([
    api('/dashboard'),
    api(`/stats/overview?from=${w.from}&to=${w.to}`),
    api('/attention').catch(() => []),
  ]);
  const t = s.totals;
  const doneable = (t.collected || 0) + (t.canceled || 0) + (t.overdue || 0);
  const rate = doneable ? Math.round(100 * t.collected / doneable) : (t.scheduled ? 0 : 100);
  const tabs = ['daily', 'weekly', 'monthly'].map(p =>
    `<button class="ptab ${dashPeriod === p ? 'on' : ''}" onclick="dashPeriod='${p}';dashboard()">${p[0].toUpperCase() + p.slice(1)}</button>`).join('');

  $('#main').innerHTML = `
    <div class="head">
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

    ${attn.length ? `<div class="card"><h3>${icon('alertTriangle', 15)} Clients needing attention</h3>
      <p class="muted small" style="margin-bottom:8px">Three or more customer-confirmed no-pickups in the last 30 days.</p>
      <table><tr><th>Client</th><th>Zone</th><th>Confirmed no-pickups</th><th></th></tr>
      ${attn.map(r => `<tr><td><b>${esc(r.name)}</b> <span class="muted small">${esc(r.branch)}</span></td><td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.confirmed}</td>
      <td><button class="btn ghost small" onclick="customer360(${r.id})">Open 360</button></td></tr>`).join('')}</table></div>` : ''}
    ${s.top_cancels.length ? `<div class="card"><h3>${icon('alertTriangle', 15)} Repeated no-pickups in period</h3>
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
  Chart.defaults.font.family = "'Manrope', 'Segoe UI', system-ui, sans-serif";

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
  const [d, sh] = await Promise.all([api('/ledger?date=' + date), api('/shifts?date=' + date).catch(() => ({ rows: [] }))]);
  const shiftOf = {}; sh.rows.forEach(x => { if (x.fleet_number) (shiftOf[x.fleet_number] ||= []).push(x); });
  const byVehicle = {};
  d.rows.forEach(r => { (byVehicle[r.fleet_number || 'Unassigned'] ||= []).push(r); });
  $('#main').innerHTML = `
    <h1>Daily Route Ledger Matrix</h1>
    <p class="sub">Chronological + geographic stop order per vehicle</p>
    <div class="row" style="margin-bottom:14px">
      <input type="date" id="ledger-date" value="${d.date}" style="width:170px" onchange="ledger(this.value)">
      ${CRM_ROLE === 'owner' ? `<button class="btn ghost small" onclick="genSchedule()">${icon('refresh', 13)} Generate month schedule</button>` : ''}
      <button class="btn ghost small" onclick="genPlans()">${icon('repeat', 13)} Run recurring plans (14 days)</button>
      <button class="btn primary small" onclick="adhocForm('${d.date}')">${icon('plus', 13)} Ad-hoc order</button>
      <button class="btn ghost small" onclick="ledgerCsv('${d.date}')">${icon('download', 13)} CSV</button>
    </div>
    ${Object.entries(byVehicle).map(([veh, rows]) => `
      <div class="card"><h3>${icon('truck', 15)} ${veh} <span class="muted small">— ${rows.length} stops</span></h3>
      ${(shiftOf[veh] || []).map(shiftLine).join('')}
      <div class="scroll-x"><table><tr><th>#</th><th>Client</th><th>Service</th><th>Window</th><th>Driver</th><th>Status</th><th>Times</th><th>Proof</th><th>GPS check</th></tr>
      ${rows.map(r => `<tr>
        <td>${r.seq}</td><td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.branch)}</span></td>
        <td><span class="pill ${r.category || 'waste'}">${esc(r.service_type || 'WASTE')}</span>${r.is_revisit ? ' <span class="pill rescheduled">revisit</span>' : ''}</td>
        <td class="small">${esc(r.time_window || '—')}</td><td>${esc(r.driver || '—')}</td>
        <td><span class="pill ${r.status}">${r.status}</span>${r.anomaly_reason ? '<br><span class="muted small">' + r.anomaly_reason.replace(/_/g,' ') + '</span>' : ''}${r.confirmation_status ? `<br><span class="pill ${r.confirmation_status}">${r.confirmation_status.replace('_', ' ')}</span>` : ''}</td>
        <td class="small">${jobTimesCell(r)}</td>
        <td>${r.photo_url ? `<img class="photo-thumb" src="${r.photo_url}" onclick="viewPhoto('${r.photo_url}')">` : '—'}</td>
        <td class="small">${proofCell(r)}</td>
      </tr>`).join('')}</table></div></div>`).join('') || '<div class="card"><p class="muted">No routes scheduled for this date.</p></div>'}`;
}
// clock times in the office's own time zone, durations as "9 min" / "1 h 05 min"
const clock = iso => { const t = new Date(iso); return isNaN(t) ? '' : String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
const mins = s => { if (s == null) return ''; const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const gap = (a, b) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null);
// Start → arrival (GPS photo) → finish, with how long the drive and the stop took
function jobTimesCell(r) {
  if (!r.started_at && !r.arrived_at && !r.completed_at) return '<span class="muted">—</span>';
  const parts = [];
  if (r.started_at) parts.push(`Started ${clock(r.started_at)}`);
  if (r.arrived_at) parts.push(`arrived ${clock(r.arrived_at)}${r.started_at ? ` <span class="muted">(${mins(gap(r.started_at, r.arrived_at))} drive)</span>` : ''}`);
  if (r.completed_at) parts.push(`${r.status === 'canceled' ? 'reported' : 'finished'} ${clock(r.completed_at)}${r.arrived_at ? ` <span class="muted">(${mins(gap(r.arrived_at, r.completed_at))} on site)</span>` : ''}`);
  return parts.join('<br>');
}
// one driver's shift for the day, shown above their truck's stops
function shiftLine(x) {
  const first = x.shifts[0], last = x.shifts[x.shifts.length - 1];
  const state = !first ? '<span class="pill pending">not clocked in</span>'
    : x.on_shift ? `<span class="pill collected">on shift</span> since ${clock(last.clock_in_at)}`
    : `<span class="pill expired">clocked out</span> ${clock(first.clock_in_at)} to ${clock(last.clock_out_at)}`;
  return `<p class="shiftline">${icon('clock', 13)} <b>${esc(x.driver)}</b> ${state}${first ? ` <span class="muted">shift ${mins(x.shift_s)}, on jobs ${mins(x.job_s)}, ${x.jobs_done}/${x.jobs_total} stops reported</span>` : ''}${first && first.auto_in ? ' <span class="muted">(started a job without clocking in)</span>' : ''}</p>`;
}
function proofCell(r) {
  let m = {}; try { m = JSON.parse(r.proof_meta || '{}'); } catch {}
  if (m.overridden) return `<span class="pill Partly">override</span><br><span class="muted">${esc(m.override_reason || '')}</span>`;
  if (m.rejected) return `<span class="pill canceled">rejected</span><br><span class="muted">${esc((m.problems || []).join('; '))}</span>`;
  if (m.distance_m != null) return `<span class="pill collected">${m.distance_m} m</span>`;
  return r.gps_lat ? `<span class="muted">${Number(r.gps_lat).toFixed(4)}, ${Number(r.gps_lng).toFixed(4)}</span>` : '—';
}
async function ledgerCsv(date) {
  const d = await api('/ledger?date=' + date);
  const cols = ['fleet_number', 'seq', 'name', 'branch', 'zone', 'service_type', 'time_window', 'driver', 'status', 'anomaly_reason', 'confirmation_status', 'started_at', 'arrived_at', 'arrival_distance_m', 'completed_at', 'photo_url', 'gps_lat', 'gps_lng'];
  const csv = [cols.join(','), ...d.rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `ledger_${date}.csv`; a.click();
}
async function genPlans() { const r = await api('/service-plans/generate', { method: 'POST' }); toast(`Recurring plans: ${r.created} new jobs, ${r.skipped} holiday skips${r.unallocated ? ', ' + r.unallocated + ' unallocated' : ''}`); nav('ledger'); }
async function genSchedule() {
  const r = await api('/schedule/generate', { method: 'POST', body: {} });
  toast(r.skipped ? `Schedule already exists (${r.existing} pickups)` : `Generated ${r.created} pickups`);
  nav('ledger');
}

// ACTIVE FLEET LOAD TRACKER — DD/MM/YYYY dates + capacity moderation (v3.2)
async function fleet() {
  const data = await api('/fleet/load?days=7');
  const todayStr = dstr(new Date());
  const anyOver = data.some(v => v.days.some(d => d.over_by > 0));
  $('#main').innerHTML = `
    <div class="head"><div><h1>Active Fleet Load Tracker</h1>
      <p class="sub">Next 7 days · stops scheduled vs. that day's capacity. Capacity is no longer fixed at 15 — set each truck's default, or change a single day.</p></div>
      <span class="fmt-hint">${icon('calendar', 13)} Date format: DD/MM/YYYY &nbsp;(date / month / year)</span></div>
    ${anyOver ? `<div class="banner red">${icon('alertTriangle', 16)} <div>Some days have more stops than capacity. Open <a href="#" onclick="nav('reschedule');return false">Rescheduling</a> or the ledger for that date to move stops.</div></div>` : ''}
    ${data.map(v => `
      <div class="card">
        <div class="row spread" style="margin-bottom:12px"><h3 style="margin:0">${icon('truck', 15)} ${esc(v.vehicle.fleet_number)} <span class="zone-tag">${esc(v.vehicle.zone)}</span></h3>
        <span class="muted small">${esc(v.vehicle.plate)} · default capacity <b style="color:var(--text)">${v.vehicle.max_daily_capacity}</b> stops/day
          ${CRM_ROLE === 'owner' ? `<button class="cap-edit" onclick='capDefaultForm(${jsonSafe({ id: v.vehicle.id, fleet: v.vehicle.fleet_number, cap: v.vehicle.max_daily_capacity })})'>${icon('edit', 11)} Change default</button>` : ''}</span></div>
        <div class="scroll-x"><div class="fleet-grid">${v.days.map(d => {
          const p = dmyParts(d.date);
          const cls = d.over_by > 0 ? 'over' : d.override ? 'moderated' : '';
          return `<div class="day-cell ${cls} ${d.date === todayStr ? 'today' : ''}">
            <div class="day-head"><span class="wd">${p.wd}</span>${d.date === todayStr ? '<span class="tag">TODAY</span>' : ''}</div>
            ${p.html}<div class="dmy-long">${p.long}</div>
            <div class="loadbar ${d.pct >= 100 ? 'fullcap' : d.pct >= 80 ? 'warn' : ''}"><i style="width:${Math.min(d.pct, 100)}%"></i><span>${d.load}/${d.capacity}</span></div>
            <div class="cap-row"><span>Capacity <b>${d.capacity}</b></span>
              <button class="cap-edit" title="Change capacity for ${dmy(d.date)} only" onclick='capDayForm(${jsonSafe({ id: v.vehicle.id, fleet: v.vehicle.fleet_number, date: d.date, cap: d.capacity, def: d.default_capacity, load: d.load, reason: d.override ? d.override.reason : '', has: !!d.override })})'>${icon('edit', 11)} Edit</button></div>
            ${d.override ? `<div class="cap-note">Changed from ${d.default_capacity}${d.override.reason ? ' — ' + esc(d.override.reason) : ''}${d.override.set_by ? ' · ' + esc(d.override.set_by) : ''}</div>` : ''}
            ${d.over_by > 0 ? `<div class="cap-note red">${d.over_by} stop(s) over capacity</div>` : ''}
          </div>`; }).join('')}</div></div>
      </div>`).join('') || '<div class="card"><p class="muted">No active vehicles.</p></div>'}
    <p class="muted small">Bars: teal under 80% · amber from 80% · red when full. Day changes apply to auto-allocation, ad-hoc orders, bookings and rescheduling straight away. Vehicle issues and services are in <a href="#" onclick="nav('maintenance');return false">Fleet maintenance</a>.</p>`;
}
const jsonSafe = o => JSON.stringify(o).replace(/'/g, '&#39;').replace(/</g, '\\u003c');
function capStep(n) { const i = $('#cap-val'); i.value = Math.max(0, Math.min(60, (Number(i.value) || 0) + n)); capHint(); }
function capHint() {
  const el = $('#cap-hint'); if (!el) return;
  const v = Number($('#cap-val').value), load = Number(el.dataset.load);
  el.innerHTML = v < load ? `<span style="color:var(--red)">${load} stops are already scheduled — ${load - v} will be over capacity and must be rescheduled.</span>`
    : v === 0 ? 'Truck takes no stops this day.' : `${v - load} free slot(s) after this change.`;
}
function capDayForm(o) {
  const p = dmyParts(o.date);
  openModal(`
    <h3>${icon('truck', 17)} ${esc(o.fleet)} — capacity for one day</h3>
    <p style="margin-bottom:12px">${p.wd} ${p.html} <span class="muted small">(${p.long})</span></p>
    ${field('Stops this truck can take that day (0 = off the road)', `<div class="stepper-num"><button class="btn ghost" onclick="capStep(-1)">−</button><input id="cap-val" type="number" min="0" max="60" value="${o.cap}" oninput="capHint()"><button class="btn ghost" onclick="capStep(1)">+</button>
      <button class="btn ghost small" onclick="$('#cap-val').value=0;capHint()">Off the road (0)</button><button class="btn ghost small" onclick="$('#cap-val').value=${o.def};capHint()">Default (${o.def})</button></div>`)}
    <p id="cap-hint" class="small muted" data-load="${o.load}" style="margin:-4px 0 10px"></p>
    ${field('Reason (shown on the tracker)', `<input id="cap-reason" maxlength="200" value="${esc(o.reason)}" placeholder="e.g. Oil change at workshop · extra helper on board">`)}
    <div class="row"><button class="btn primary" onclick="saveCapDay(${o.id},'${o.date}')">Save for ${dmy(o.date)}</button>
      ${o.has ? `<button class="btn ghost" onclick="clearCapDay(${o.id},'${o.date}')">Back to default (${o.def})</button>` : ''}
      <button class="btn ghost" onclick="closeModal()">Cancel</button></div>
    <p id="m-err" class="err"></p>`);
  capHint();
}
async function saveCapDay(id, date) {
  try {
    const r = await api('/fleet/capacity/override', { method: 'PUT', body: { vehicle_id: id, date, capacity: Number($('#cap-val').value), reason: $('#cap-reason').value } });
    closeModal();
    if (r.over_by > 0) toast(`Capacity for ${dmy(date)} set to ${r.capacity}. ${r.over_by} stop(s) are now over capacity — reschedule them.`, 'warning');
    else toast(`Capacity for ${dmy(date)} set to ${r.capacity}`, 'success');
    nav('fleet');
  } catch (e) { $('#m-err').textContent = e.message; }
}
async function clearCapDay(id, date) {
  try { await api('/fleet/capacity/override', { method: 'DELETE', body: { vehicle_id: id, date } }); closeModal(); toast(`${dmy(date)} is back to the default capacity`, 'success'); nav('fleet'); }
  catch (e) { $('#m-err').textContent = e.message; }
}
function capDefaultForm(o) {
  openModal(`
    <h3>${icon('truck', 17)} ${esc(o.fleet)} — default daily capacity</h3>
    <p class="muted small" style="margin-bottom:12px">Used for every day that has no one-day change. Applies to new scheduling from now on; already scheduled stops are not moved.</p>
    ${field('Stops per day (1–60)', `<div class="stepper-num"><button class="btn ghost" onclick="capStep(-1)">−</button><input id="cap-val" type="number" min="1" max="60" value="${o.cap}"><button class="btn ghost" onclick="capStep(1)">+</button></div>`)}
    <div class="row"><button class="btn primary" onclick="saveCapDefault(${o.id})">Save default</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>
    <p id="m-err" class="err"></p>`);
}
async function saveCapDefault(id) {
  try { const r = await api('/fleet/capacity/default', { method: 'PUT', body: { vehicle_id: id, capacity: Number($('#cap-val').value) } }); closeModal(); toast(`Default capacity changed from ${r.previous} to ${r.capacity} stops/day`, 'success'); nav('fleet'); }
  catch (e) { $('#m-err').textContent = e.message; }
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
        <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${dmy(r.scheduled_date)}</td>
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
        <div><b>${dmy(o.date)}</b><br><span class="muted small">${o.fleet_number} · ${o.zone} · load ${o.current_load}/${o.capacity}</span></div>
        <div class="dev"><b>+${o.deviation_km} km</b><br><span class="muted small">route deviation</span></div>
        <button class="btn primary small" onclick="applyReschedule(${d.pickup.id},'${o.date}',${o.vehicle_id})">Dispatch</button>
      </div>`).join('') : '<p class="muted">No conflict-free slot in the next 7 days — increase capacity or add a vehicle.</p>'}
    <button class="btn ghost full" onclick="closeModal()">Cancel</button>`);
}
async function applyReschedule(pid, date, vid) {
  try {
    const r = await api('/reschedule/apply', { method: 'POST', body: { pickup_id: pid, date, vehicle_id: vid } });
    closeModal(); toast(`Moved to ${dmy(r.new_date)} on ${r.vehicle} — driver notified`, 'success'); nav('reschedule');
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
      <span class="muted small">Columns: name, branch, zone, frequency (2/3), lat, lng, address, contact_phone, email</span>
    </div>
    <div class="card"><table>
    <tr><th>Client</th><th>Zone</th><th>Freq/mo</th><th>Collected this month</th><th>Contact</th><th>Status</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.branch)} · ${esc(r.address)}</span></td>
      <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.frequency}×</td>
      <td>${r.collected_this_month}/${r.frequency}</td>
      <td class="muted small">${esc(GLPhone.format(r.contact_phone))}${r.email ? '<br>' + esc(r.email) : ''}</td>
      <td>${r.is_active ? '<span class="pill collected">active</span>' : '<span class="pill canceled">inactive</span>'}</td>
      <td class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn primary small" onclick="customer360(${r.id})">360</button><button class="btn ghost small" onclick='customerForm(${JSON.stringify(r).replace(/'/g, "&#39;")})'>Edit</button></td>
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
    ${field('Mobile number', GLPhone.html('f-phone', c.contact_phone))}
    ${field('Email (sign-in codes are sent here)', `<input id="f-email" type="email" inputmode="email" autocomplete="off" value="${esc(c.email || '')}" placeholder="name@company.ae">`)}
    ${c.id ? field('Active', `<select id="f-active"><option value="1" ${c.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!c.is_active ? 'selected' : ''}>No</option></select>`) : ''}
    <div class="row"><button class="btn primary full" onclick="saveCustomer(${c.id || 'null'})">Save</button></div>
    <p id="m-err" class="err"></p><div id="m-dup"></div>`);
}
// A mobile number or email that is already in the CRM is never saved twice.
// For a new customer the office can add it as another site of the existing customer instead.
function duplicateBox(e, linkAction) {
  const d = e.data && e.data.duplicate; if (!d) return '';
  const open = d.type === 'customer' ? `closeModal();customer360(${d.id})` : `leadDetail(${d.id})`;
  return `<div class="dupbox"><p>${esc(e.message)}</p><div class="row">
    <button class="btn ghost small" onclick="${open}">Open ${d.type === 'customer' ? 'that customer' : 'that lead'}</button>
    ${e.data.can_link && linkAction ? `<button class="btn primary small" onclick="${linkAction.replace('__ID__', d.id)}">Add as another site of ${esc(d.name)}</button>` : ''}</div></div>`;
}
async function saveCustomer(id, linkAccountId) {
  $('#m-err').textContent = ''; $('#m-dup').innerHTML = '';
  const ph = GLPhone.read('f-phone');
  if (!ph.ok) { $('#m-err').textContent = ph.error; $('#f-phone').focus(); return; }
  const body = {
    name: $('#f-name').value, branch: $('#f-branch').value, zone: $('#f-zone').value,
    frequency: Number($('#f-freq').value), lat: Number($('#f-lat').value), lng: Number($('#f-lng').value),
    address: $('#f-addr').value, contact_phone: ph.e164, email: $('#f-email').value.trim(),
  };
  if (linkAccountId) body.link_account_id = linkAccountId;
  if (id) body.is_active = $('#f-active').value === '1';
  try {
    const r = await api(id ? '/customers/' + id : '/customers', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast(r.linked_account ? 'Site added to the existing customer' : 'Customer saved', 'success'); nav('customers');
  } catch (e) {
    if (e.data && e.data.duplicate) $('#m-dup').innerHTML = duplicateBox(e, `saveCustomer(${id || 'null'}, __ID__)`);
    else $('#m-err').textContent = e.message;
  }
}

// USERS
async function users() {
  const rows = await api('/users');
  const vehicles = await api('/vehicles');
  window._vehCache = vehicles;
  $('#main').innerHTML = `
    <h1>User Management</h1>
    <p class="sub">Drivers sign in with a 4-digit PIN; owners and ops staff with username and password. Ops staff can't see users, settings, vehicles or billing actions.</p>
    <div class="row" style="margin-bottom:12px"><button class="btn primary" onclick="userForm()">${icon('plus', 13)} Add user</button></div>
    <div class="card"><table>
    <tr><th>Name</th><th>Role</th><th>Login</th><th>Vehicle</th><th>Phone</th><th>Status</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td><b>${esc(r.full_name)}</b></td><td>${r.role === 'admin' ? (r.crm_role === 'ops' ? '<span class="role-chip">Ops staff</span>' : 'Owner / admin') : 'Driver'}</td>
      <td class="muted small">${r.role === 'admin' ? esc(r.username) : 'PIN ••••'}</td>
      <td>${esc(r.fleet_number || '—')}</td><td class="muted small">${esc(GLPhone.format(r.phone))}</td>
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
    ${u.id ? '' : field('Role', `<select id="u-role" onchange="document.querySelectorAll('.drv-only').forEach(e=>e.style.display=this.value==='driver'?'':'none');document.querySelectorAll('.adm-only').forEach(e=>e.style.display=this.value!=='driver'?'':'none')"><option value="driver">Driver</option><option value="admin">Owner / admin</option><option value="ops">Ops staff</option></select>`)}
    <div class="drv-only" style="${u.id && u.role !== 'driver' ? 'display:none' : ''}">
      ${field(u.id ? 'New 4-digit PIN (leave blank to keep)' : '4-digit PIN', `<input id="u-pin" maxlength="4" inputmode="numeric" placeholder="e.g. 4321">`)}
      ${field('Assigned vehicle', `<select id="u-veh"><option value="">— none —</option>${vehOpts}</select>`)}
    </div>
    <div class="adm-only" style="${(!u.id && true) || u.role !== 'admin' ? 'display:none' : ''}">
      ${field('Username', `<input id="u-username" value="${esc(u.username || '')}" ${u.id ? 'disabled' : ''}>`)}
      ${field(u.id ? 'New password (leave blank to keep)' : 'Password', `<input id="u-password" type="password">`)}
    </div>
    ${field('Mobile number', GLPhone.html('u-phone', u.phone))}
    ${u.id && u.role === 'admin' ? field('CRM role', `<select id="u-crm"><option value="owner" ${u.crm_role !== 'ops' ? 'selected' : ''}>Owner / admin — full control</option><option value="ops" ${u.crm_role === 'ops' ? 'selected' : ''}>Ops staff — leads, quotes, ledger, rescheduling</option></select>`) : ''}
    ${u.id ? field('Active', `<select id="u-active"><option value="1" ${u.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!u.is_active ? 'selected' : ''}>No</option></select>`) : ''}
    <div class="row"><button class="btn primary full" onclick="saveUser(${u.id || 'null'}, '${u.role || ''}')">Save</button></div>
    <p id="m-err" class="err"></p>`);
}
async function saveUser(id, existingRole) {
  const picked = id ? existingRole : $('#u-role').value;
  const role = picked === 'ops' ? 'admin' : picked;
  const uph = GLPhone.read('u-phone');
  if (!uph.ok) { $('#m-err').textContent = uph.error; return; }
  const body = { full_name: $('#u-name').value, role, phone: uph.e164 };
  if (role === 'driver') {
    if ($('#u-pin').value) body.pin = $('#u-pin').value;
    body.vehicle_id = $('#u-veh').value ? Number($('#u-veh').value) : null;
  } else {
    if (!id) body.username = $('#u-username').value;
    if (!id && picked === 'ops') body.role = 'ops';
    if ($('#u-password') && $('#u-password').value) body.password = $('#u-password').value;
  }
  if (id) body.is_active = $('#u-active').value === '1';
  try {
    await api(id ? '/users/' + id : '/users', { method: id ? 'PUT' : 'POST', body });
    if (id && $('#u-crm')) await api(`/users/${id}/crm-role`, { method: 'PUT', body: { crm_role: $('#u-crm').value } });
    closeModal(); toast('User saved', 'success'); nav('users');
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
    <tr><th>Fleet #</th><th>Plate</th><th>Primary zone</th><th>Max daily stops</th><th>Services</th><th>Status</th><th></th></tr>
    ${rows.map(r => `<tr>
      <td><b>${esc(r.fleet_number)}</b></td><td>${esc(r.plate)}</td>
      <td><span class="zone-tag">${esc(r.zone)}</span></td><td>${r.max_daily_capacity}</td>
      <td>${String(r.service_tags || 'waste').split(',').map(t => `<span class="pill ${t}">${t}</span>`).join(' ')}</td>
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
    ${field('Service types this vehicle can take', `<div class="daypick"><label><input type="checkbox" id="v-t-waste" ${String(v.service_tags || 'waste').includes('waste') ? 'checked' : ''}> Waste (Machari)</label><label><input type="checkbox" id="v-t-pest" ${String(v.service_tags || '').includes('pest') ? 'checked' : ''}> Pest control</label></div>`)}
    ${v.id ? field('Active', `<select id="v-active"><option value="1" ${v.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!v.is_active ? 'selected' : ''}>No</option></select>`) : ''}
    <div class="row"><button class="btn primary full" onclick="saveVehicle(${v.id || 'null'})">Save</button></div>
    <p id="m-err" class="err"></p>`);
}
async function saveVehicle(id) {
  const body = { fleet_number: $('#v-fleet').value, plate: $('#v-plate').value, zone: $('#v-zone').value, max_daily_capacity: Number($('#v-cap').value) };
  if (id) body.is_active = $('#v-active').value === '1';
  try {
    const vr = await api(id ? '/vehicles/' + id : '/vehicles', { method: id ? 'PUT' : 'POST', body });
    const tags = [$('#v-t-waste').checked && 'waste', $('#v-t-pest').checked && 'pest'].filter(Boolean);
    if (tags.length) await api(`/vehicles/${id || vr.id}/tags`, { method: 'PUT', body: { service_tags: tags } });
    closeModal(); toast('Vehicle saved — will join the next route generation', 'success'); nav('vehicles');
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
      <div class="row spread"><b>${a.type.replace(/_/g, ' ')}</b> ${a.is_read ? '' : '<span class="badge" style="margin-left:0">new</span>'}</div>${esc(a.message)}
      ${a.type === 'PHOTO_REJECTED' && a.pickup_id ? `<div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="proofOverride(${a.pickup_id})">${icon('shield', 13)} Ops override…</button></div>` : ''}
      ${a.type === 'VEHICLE_ISSUE' ? `<div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="nav('maintenance')">${icon('wrench', 13)} Open fleet maintenance</button></div>` : ''}
      ${a.type === 'CAPACITY' ? `<div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="nav('fleet')">Open fleet tracker</button></div>` : ''}
      ${a.type === 'BOOKING' ? `<div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="nav('bookings')">Open bookings</button></div>` : ''}
      ${a.type === 'QUOTE_ACCEPTED' ? `<div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="nav('quotations')">Open quotations</button></div>` : ''}
      ${a.type === 'DISPUTE' ? `<div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="nav('confirmations')">Open not-picked-up</button></div>` : ''}
      <div class="t">${dmyTime(a.created_at)}</div></div>`).join('') || '<div class="card"><p class="muted">No alerts.</p></div>'}`;
}
async function readAll() { await api('/alerts/read-all', { method: 'POST' }); setBadge(0); nav('alerts'); }

// ── boot on load if token cached ─────────────────────────────
if (token) boot();
