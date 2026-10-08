// ─────────────────────────────────────────────────────────────
// GreenLoop Customer v3 — Today · Plans · Bills · Proof · More
// Login: mobile number + 4-digit code, or a one-time code by email (CUS-01) · site switcher (CUS-12)
// Live tracking, confirm/dispute not-picked-up (CUS-10), plans & one-off
// booking (CUS-06/07), invoices & balance (CUS-08), quotations (CUS-11),
// notifications (CUS-13), filtered history + PDF (CUS-03)
// ─────────────────────────────────────────────────────────────
const API = '/api/v1';
let token = localStorage.getItem('gl_cust_token') || null;
let me = JSON.parse(localStorage.getItem('gl_cust_me') || 'null');
let pin = '';
let socket = null;
let currentTab = 'home';
let sites = [];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AED = n => 'AED ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const today = () => new Date().toISOString().slice(0, 10);
const nice = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
// One date format everywhere: DD/MM/YYYY (date / month / year)
const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s ? String(s) : '—'); };
const dmyTime = s => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : dmy(s); };
const reasonTxt = r => ({ CLOSED: 'Site was closed', NO_ACCESS: 'No access to the bins', NO_WASTE: 'No waste to collect', CUSTOMER_REFUSED: 'Service refused on site',
  BIN_EMPTY: 'Bin empty', ACCESS_BLOCKED: 'Access blocked', MANAGER_REFUSED: 'Manager refused' }[r] || String(r || '').replace(/_/g, ' ').toLowerCase());

// ── login ────────────────────────────────────────────────────
function loginMode(m) {
  $('#lm-code').classList.toggle('on', m === 'code'); $('#lm-otp').classList.toggle('on', m === 'otp');
  $('#login-code').classList.toggle('hidden', m !== 'code'); $('#login-otp').classList.toggle('hidden', m !== 'otp');
  $('#login-msg').textContent = '';
}
// The code is 4 digits and signs in as soon as the fourth is typed.
function pinKey(n) { if (pin.length >= 4) return; pin += String(n); renderDots(); if (pin.length === 4) doLogin(); }
function pinDel() { pin = pin.slice(0, -1); renderDots(); $('#login-msg').textContent = ''; }
function renderDots() { [...$('#pin-dots').children].forEach((d, i) => d.classList.toggle('on', i < pin.length)); }
function signedIn(data) {
  token = data.token; me = data.customer;
  localStorage.setItem('gl_cust_token', token); localStorage.setItem('gl_cust_me', JSON.stringify(me));
  boot();
}
async function post(path, body) {
  const res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
async function doLogin() {
  $('#login-msg').textContent = '';
  const ph = GLPhone.read('login-phone');
  if (!ph.ok || ph.empty) { $('#login-msg').textContent = ph.ok ? 'Enter the mobile number on your account first' : ph.error; pin = ''; renderDots(); $('#login-phone').focus(); return; }
  try { localStorage.setItem('gl_cust_phone', ph.e164); signedIn(await post('/auth/customer-login', { phone: ph.e164, code: pin })); }
  catch (e) { $('#login-msg').textContent = e.message; }
  pin = ''; renderDots();
}
// one-time code by email: found by mobile number (default) or by email address
let otpMode = 'phone';
function otpBy() {
  otpMode = otpMode === 'phone' ? 'email' : 'phone';
  $('#otp-by-phone').classList.toggle('hidden', otpMode !== 'phone'); $('#otp-by-email').classList.toggle('hidden', otpMode !== 'email');
  $('#otp-switch').textContent = otpMode === 'phone' ? 'Use my email address instead' : 'Use my mobile number instead';
  $('#otp-step2').classList.add('hidden'); $('#login-msg').textContent = '';
}
function otpIdentifier() {
  if (otpMode === 'email') { const e = $('#otp-email').value.trim(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? { id: e } : { error: 'Enter the email address on your account' }; }
  const ph = GLPhone.read('otp-phone');
  return !ph.ok ? { error: ph.error } : ph.empty ? { error: 'Enter the mobile number on your account' } : { id: ph.e164 };
}
async function otpRequest() {
  $('#login-msg').textContent = '';
  const who = otpIdentifier(); if (who.error) { $('#login-msg').textContent = who.error; return; }
  try {
    const r = await post('/auth/customer-otp/request', { identifier: who.id });
    $('#otp-step2').classList.remove('hidden');
    $('#otp-dev').innerHTML = r.dev_code ? `Demo mode: your code is <b>${esc(r.dev_code)}</b>` : esc(r.message);
    $('#otp-code').value = ''; $('#otp-code').focus();
  } catch (e) { $('#login-msg').textContent = e.message; }
}
async function otpVerify() {
  const who = otpIdentifier(); if (who.error) { $('#login-msg').textContent = who.error; return; }
  try { signedIn(await post('/auth/customer-otp/verify', { identifier: who.id, code: $('#otp-code').value.trim() })); }
  catch (e) { $('#login-msg').textContent = e.message; }
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
function openDoc(path) { window.open(`${API}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, '_blank'); }

function logout() {
  // stop pushes to this phone for the account being signed out (needs the token, so do it first)
  try { if (window.GLPush) window.GLPush.signOut(); } catch {}
  token = null; me = null;
  localStorage.removeItem('gl_cust_token'); localStorage.removeItem('gl_cust_me');
  if (socket) socket.disconnect();
  $('#s-app').classList.add('hidden'); $('#s-login').classList.remove('hidden');
}

// ── shell ────────────────────────────────────────────────────
function boot() {
  $('#s-login').classList.add('hidden'); $('#s-app').classList.remove('hidden');
  $('#hdr-name').textContent = me.name;
  $('#hdr-sub').textContent = (me.branch || '') + (me.zone ? ' · ' + me.zone : '');
  $('#hdr-avatar').textContent = (me.name || 'S').charAt(0).toUpperCase();
  api('/customer/sites').then(r => { sites = r.sites; $('#site-caret').classList.toggle('hidden', sites.length < 2); }).catch(() => {});
  refreshBell();
  try {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('connect', () => { $('#hdr-live').classList.remove('off'); socket.emit('customer:join', { customer_id: me.id }); });
    socket.on('disconnect', () => $('#hdr-live').classList.add('off'));
    socket.on('customer:notify', n => { toast(n.title + ' — ' + n.body, n.kind === 'invoice' || n.kind === 'announcement' ? 'info' : 'success'); refreshBell(); if (['home', 'bills', 'plans'].includes(currentTab)) switchTab(currentTab); });
    socket.on('pickup:completed', () => { if (currentTab === 'home') loadHome(); });
    socket.on('pickup:arrived', () => { toast('Driver has arrived at your location'); if (currentTab === 'home') loadHome(); });
    socket.on('driver:nearby', d => {
      if (d.customer_id === me.id) {
        const eta = d.eta_minutes != null ? ` ~${d.eta_minutes} min` : '';
        toast((d.nearby || d.distance_m < 150 ? 'Driver nearby' : 'Driver on the way') + eta);
        updateTrackCard(d);
      }
    });
  } catch { /* offline */ }
  switchTab(tabFromHash());
}
// deep links used by push notifications: /customer/#invoices, #history, #confirm …
function tabFromHash(h = location.hash) {
  const hash = String(h).replace(/^.*#/, '');
  return ['plans', 'bills', 'history', 'more'].includes(hash) ? hash : hash === 'invoices' ? 'bills' : 'home';
}
window.addEventListener('hashchange', () => { if (token && me) switchTab(tabFromHash()); });
// a tapped notification while the app is already open → jump to the right screen
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
  if (e.data && e.data.type === 'gl-open' && token && me) { switchTab(tabFromHash(e.data.url)); refreshBell(); }
});
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  ['home', 'plans', 'bills', 'history', 'more'].forEach(v => $('#v-' + v).classList.toggle('hidden', v !== tab));
  ({ home: loadHome, plans: loadPlans, bills: loadBills, history: loadHistory, more: loadMore })[tab]();
  window.scrollTo(0, 0);
}
// System messages drop in at the TOP of the screen (v3.2) so they are seen immediately.
// kind: 'info' | 'success' | 'error'
function toast(msg, kind = 'info') {
  const wrap = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const ic = { info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' }[kind] || '';
  t.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ic}</svg><span></span>`;
  t.querySelector('span').textContent = msg;
  t.onclick = () => t.remove();
  wrap.prepend(t);
  while (wrap.children.length > 3) wrap.lastChild.remove();
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4500);
}
// Errors written into a form (.err / login message) are also raised at the top.
new MutationObserver(muts => {
  for (const m of muts) {
    const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    if (el && el.classList && (el.classList.contains('err') || el.classList.contains('login-err')) && el.textContent.trim()) toast(el.textContent.trim(), 'error');
  }
}).observe(document.body, { childList: true, characterData: true, subtree: true });
function openSheet(html) { $('#sheet-body').innerHTML = html; $('#sheet-wrap').classList.remove('hidden'); }
function closeSheet() { $('#sheet-wrap').classList.add('hidden'); }
const loading = el => { el.innerHTML = '<div class="skel"></div><div class="skel"></div>'; };

// ── sites (CUS-12) ───────────────────────────────────────────
function openSites() {
  if (sites.length < 2) return;
  openSheet(`<h3>Your sites</h3>${sites.map(s => `<button class="row-btn ${s.id === me.id ? 'on' : ''}" onclick="switchSite(${s.id})">
    <b>${esc(s.branch || s.name)}</b><small>${esc(s.zone)} · ${esc(s.address || '')}</small></button>`).join('')}`);
}
async function switchSite(id) {
  try { const r = await api('/customer/switch-site', { method: 'POST', body: { site_id: id } }); closeSheet(); signedIn(r); toast('Switched to ' + (r.customer.branch || r.customer.name)); }
  catch (e) { toast(e.message); }
}

// ── notifications (CUS-13) ───────────────────────────────────
async function refreshBell() {
  try { const r = await api('/customer/notifications'); const b = $('#bell-badge'); b.textContent = r.unread; b.classList.toggle('hidden', !r.unread); return r; } catch { return null; }
}
async function openNotifs() {
  const r = await refreshBell();
  openSheet(`<h3>Notifications</h3>${r && r.rows.length ? r.rows.map(n => `<div class="notif ${n.is_read ? '' : 'unread'}"><b>${esc(n.title)}</b><p>${esc(n.body)}</p><small>${dmyTime(n.created_at)}</small></div>`).join('')
    : '<p class="muted">Nothing yet. You will hear from us the day before a visit, when the driver starts, when a job is completed, and when an invoice is issued.</p>'}`);
  api('/customer/notifications/read', { method: 'POST' }).then(refreshBell).catch(() => {});
}

// ── TODAY ────────────────────────────────────────────────────
async function loadHome() {
  const el = $('#v-home'); loading(el);
  try {
    const [d, track, conf, quotes] = await Promise.all([
      api('/customer/dashboard'),
      api('/customer/driver-location').catch(() => ({ tracking: false })),
      api('/customer/confirmations').catch(() => []),
      api('/customer/quotations').catch(() => []),
    ]);
    const awaiting = conf.filter(c => c.confirmation_status === 'awaiting');
    const openQ = quotes.filter(q => q.status === 'sent');
    const t0 = (d.today || [])[0];
    el.innerHTML = `
      ${awaiting.map(c => `<div class="card alert">
        <div class="alert-head"><span class="dot-amber"></span><b>Please confirm — not picked up</b></div>
        <p>${nice(c.scheduled_date)} at <b>${esc(c.branch || me.branch || '')}</b>: the driver reported <b>${esc(reasonTxt(c.anomaly_reason))}</b>.</p>
        ${c.photo_url ? `<img class="photo" src="${esc(c.photo_url)}" alt="Site photo taken by the driver" onclick="viewPhoto('${esc(c.photo_url)}')">` : ''}
        <p class="muted small">If you don't reply within ${Math.max(0, Math.round((new Date(c.confirm_deadline) - Date.now()) / 36e5))} h, it is confirmed automatically. Confirmed no-pickups are not billed.</p>
        <div class="two"><button class="btn ghost" onclick="confirmNpu(${c.id}, 'confirm')">Yes, that's right</button><button class="btn primary" onclick="disputeNpu(${c.id})">No — dispute</button></div>
      </div>`).join('')}
      ${openQ.map(q => `<div class="card quote"><b>New quotation ${esc(q.number)}</b><p class="muted">${esc(q.items.length)} item(s) · ${AED(q.total)} incl. VAT · valid until ${esc(q.valid_until)}</p>
        <div class="two"><button class="btn ghost" onclick="window.open('/q/${esc(q.share_token)}','_blank')">View</button><button class="btn primary" onclick="acceptQuote(${q.id})">Accept</button></div></div>`).join('')}
      <div class="hero-card">
        ${t0 ? `<span class="eyebrow">Today · ${t0.status === 'collected' ? 'completed' : t0.stage === 'arrived' ? 'driver on site' : t0.stage === 'acknowledged' ? 'driver on the way' : 'scheduled'}</span>
          <div class="hero-status ${esc(t0.status)}">${t0.status === 'collected' ? 'Done' : t0.status === 'canceled' ? 'Not picked up' : t0.stage === 'arrived' ? 'Arrived' : t0.stage === 'acknowledged' ? 'On the way' : 'Scheduled'}</div>
          <p class="muted">${esc(t0.fleet_number || '')}${t0.driver_name ? ' · ' + esc(t0.driver_name) : ''}</p>
          <button class="btn ghost small" onclick="openDetail(${t0.id})">Details & photo</button>`
        : `<span class="eyebrow">Today</span><div class="hero-status idle">No visit today</div>
          ${d.upcoming && d.upcoming[0] ? `<p class="muted">Next: <b>${nice(d.upcoming[0].scheduled_date)}</b></p>` : ''}`}
      </div>
      <div class="card" id="track-card">${trackHtml(track)}</div>
      <div class="kpi-row">
        <div class="kpi"><b>${d.compliance?.collected_this_month ?? 0}</b><span>Visits this month</span></div>
        <div class="kpi"><b>${d.compliance?.pending_upcoming ?? 0}</b><span>Upcoming</span></div>
        <div class="kpi"><b>${awaiting.length}</b><span>To confirm</span></div>
      </div>
      <div class="card"><h3>Next 14 days</h3>
        ${(d.upcoming || []).length ? d.upcoming.map(visitRow).join('') : '<p class="muted">No visits in the next 14 days.</p>'}
        <button class="btn ghost full" onclick="bookingSheet()">Book an extra visit</button></div>`;
  } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
function trackHtml(track) {
  if (track.tracking) return `<h3>Live tracking</h3><p><b>${esc(track.pickup?.fleet_number || 'Truck')}</b> · ${esc(track.pickup?.driver_name || '')}</p>
    <p class="muted">ETA <b>~${track.eta_minutes ?? '—'} min</b>${track.distance_m != null ? ' · ' + track.distance_m + ' m' : ''}${track.nearby ? ' · <span class="ok">Nearby</span>' : ''}</p>`;
  return `<h3>Live tracking</h3><p class="muted">${esc(track.reason || 'Tracking starts when the driver sets off to you.')}</p>`;
}
function updateTrackCard(d) {
  const el = $('#track-card'); if (!el || !d || d.lat == null) return;
  el.innerHTML = `<h3>Live tracking</h3><p><b>${esc(d.fleet_number || 'Truck')}</b> · ${esc(d.name || 'Driver')}</p>
    <p class="muted">ETA <b>${d.eta_minutes != null ? '~' + d.eta_minutes + ' min' : '—'}</b>${d.distance_m != null ? ' · ' + Math.round(d.distance_m) + ' m' : ''}</p>`;
}
function visitRow(v) {
  return `<button class="visit" onclick="openDetail(${v.id})"><span class="st ${esc(v.status)}"></span>
    <span class="meta"><b>${nice(v.scheduled_date)}</b><small>${v.fleet_number ? esc(v.fleet_number) + ' · ' : ''}${esc(v.status)}${v.stage ? ' · ' + esc(v.stage) : ''}</small></span></button>`;
}
async function confirmNpu(id, action, note = '') {
  try { const r = await api(`/pickups/${id}/confirm`, { method: 'POST', body: { action, note } }); toast(r.status); closeSheet(); loadHome(); }
  catch (e) { toast(e.message); }
}
function disputeNpu(id) {
  openSheet(`<h3>Dispute this visit</h3><p class="muted">Tell us what happened. We'll book a free revisit straight away.</p>
    <textarea id="disp-note" rows="3" placeholder="e.g. We were open from 7 am, the back door was unlocked"></textarea>
    <button class="btn primary full" onclick="confirmNpu(${id}, 'dispute', document.getElementById('disp-note').value)">Send dispute & book revisit</button>`);
}
async function acceptQuote(id) {
  if (!confirm('Accept this quotation?')) return;
  try { await api(`/customer/quotations/${id}/accept`, { method: 'POST' }); toast('Quotation accepted — our team will set it up'); loadHome(); }
  catch (e) { toast(e.message); }
}

async function openDetail(id) {
  openSheet('<div class="skel"></div>');
  try {
    const v = await api('/customer/pickups/' + id);
    let meta = {}; try { meta = JSON.parse(v.proof_meta || '{}'); } catch {}
    let list = []; try { list = JSON.parse(v.checklist || '[]'); } catch {}
    $('#sheet-body').innerHTML = `
      <h3>${nice(v.scheduled_date)} <span class="pill ${esc(v.status)}">${esc(v.status)}</span></h3>
      <p class="muted">${esc(v.branch || '')} · ${esc(v.service_type || 'WASTE')}${v.time_window ? ' · window ' + esc(v.time_window) : ''}</p>
      <p class="muted">Vehicle <b>${esc(v.fleet_number || '—')}</b> · Driver <b>${esc(v.driver_name || '—')}</b></p>
      ${v.photo_url ? `<img class="photo" src="${esc(v.photo_url)}" alt="GPS-stamped proof photo" onclick="viewPhoto('${esc(v.photo_url)}')">` : ''}
      ${meta.distance_m != null ? `<p class="muted small">Verified: taken ${meta.distance_m} m from your site at ${esc(String(v.completed_at || '').slice(11, 16))}</p>` : ''}
      ${list.length ? `<p class="small">Checklist: ${list.map(esc).join(' · ')}</p>` : ''}
      ${v.anomaly_reason ? `<p class="warn">Reason: ${esc(reasonTxt(v.anomaly_reason))}</p>` : ''}
      ${['pending', 'overdue'].includes(v.status) ? `
        <label for="note-text">Note for the driver</label><textarea id="note-text" rows="3" placeholder="Gate code, rear entrance…"></textarea>
        <div class="two"><button class="btn primary" onclick="sendNote(${v.id})">Send note</button><button class="btn ghost" onclick="reportAccess(${v.id})">Report access issue</button></div>` : ''}`;
  } catch (e) { $('#sheet-body').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
function viewPhoto(u) { openSheet(`<img class="photo full" src="${esc(u)}" alt="Proof photo">`); }
async function sendNote(id) {
  const notes = ($('#note-text') || {}).value || '';
  if (!notes.trim()) return toast('Write a note first');
  try { await api('/customer/pickups/' + id + '/note', { method: 'POST', body: { notes } }); toast('Note sent'); closeSheet(); } catch (e) { toast(e.message); }
}
async function reportAccess(id) {
  try { await api('/customer/pickups/' + id + '/access-issue', { method: 'POST', body: { message: 'Store reports access may be blocked' } }); toast('Operations notified'); closeSheet(); }
  catch (e) { toast(e.message); }
}

// ── PLANS (CUS-06/07) ────────────────────────────────────────
let _plans = { plans: [], services: [] };
async function loadPlans() {
  const el = $('#v-plans'); loading(el);
  try {
    const [p, bk] = await Promise.all([api('/customer/plans'), api('/customer/bookings')]);
    _plans = p;
    el.innerHTML = `
      <div class="sec-head"><h2>Service plans</h2><button class="btn primary small" onclick="planSheet()">+ New plan</button></div>
      ${p.plans.length ? p.plans.map(pl => `<div class="card plan">
        <div class="plan-top"><div><b>${esc(pl.service_name || pl.service_code)}</b><small>${esc(pl.rule_label)}</small></div>
          <span class="pill ${pl.paused ? 'paused' : 'active'}">${pl.paused ? 'Paused' : 'Active'}</span></div>
        <div class="plan-meta"><span>🕘 ${esc(pl.time_window)}</span><span>From ${esc(pl.start_date)}${pl.end_date ? ' to ' + esc(pl.end_date) : ''}</span>
          ${pl.paused && (pl.pause_from || pl.pause_to) ? `<span>Paused ${esc(pl.pause_from || '')} → ${esc(pl.pause_to || 'until resumed')}</span>` : ''}</div>
        <div class="two"><button class="btn ghost" onclick="planSheet(${pl.id})">Change</button>
          ${pl.paused ? `<button class="btn primary" onclick="planPause(${pl.id}, false)">Resume</button>` : `<button class="btn ghost" onclick="pauseSheet(${pl.id})">Pause</button>`}</div>
      </div>`).join('') : '<div class="card"><p class="muted">No recurring plan yet. Set one up and we generate your visits automatically.</p></div>'}
      <div class="sec-head"><h2>Extra visits</h2><button class="btn ghost small" onclick="bookingSheet()">+ Book</button></div>
      <div class="card">${bk.length ? bk.map(b => `<div class="line"><span><b>${nice(b.date)}</b><small>${esc(b.service_code)}${b.time_window ? ' · ' + esc(b.time_window) : ''}</small></span><span class="pill ${esc(b.status)}">${esc(b.status)}</span></div>`).join('') : '<p class="muted">No one-off bookings.</p>'}</div>`;
  } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
function recurrenceHtml(r = { type: 'weekly', days: [0, 3] }, win = '07:00-12:00') {
  const [ws, we] = String(win).split('-');
  return `
    <label>How often</label>
    <div class="seg" id="rc-seg">${['daily', 'weekly', 'monthly'].map(tp => `<button type="button" class="${r.type === tp ? 'on' : ''}" onclick="rcSet('${tp}')">${tp[0].toUpperCase() + tp.slice(1)}</button>`).join('')}</div>
    <input type="hidden" id="rc-type" value="${r.type}">
    <div id="rc-daily" class="${r.type === 'daily' ? '' : 'hidden'}"><label class="check"><input type="checkbox" id="rc-wd" ${r.weekdays_only ? 'checked' : ''}> Weekdays only (Mon–Fri)</label></div>
    <div id="rc-weekly" class="days ${r.type === 'weekly' ? '' : 'hidden'}">${DOW.map((d, i) => `<label><input type="checkbox" class="rc-day" value="${i}" ${(r.days || []).map(Number).includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
    <div id="rc-monthly" class="${r.type === 'monthly' ? '' : 'hidden'}">
      <div class="two"><select id="rc-n"><option value="date">On day…</option>${[[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [-1, 'Last']].map(([v, l]) => `<option value="${v}" ${r.mode === 'nth' && Number(r.n) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="rc-wday">${DOW.map((d, i) => `<option value="${i}" ${Number(r.weekday) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <label>Day of month (if "On day…")</label><input id="rc-date" type="number" min="1" max="28" value="${r.date || 1}">
    </div>
    <label>Preferred time window</label>
    <div class="two"><input id="rc-ws" type="time" value="${ws}"><input id="rc-we" type="time" value="${we}"></div>`;
}
function rcSet(tp) {
  $('#rc-type').value = tp;
  document.querySelectorAll('#rc-seg button').forEach(b => b.classList.toggle('on', b.textContent.toLowerCase() === tp));
  ['daily', 'weekly', 'monthly'].forEach(x => $('#rc-' + x).classList.toggle('hidden', x !== tp));
}
function readRc() {
  const tp = $('#rc-type').value;
  let rule;
  if (tp === 'daily') rule = { type: 'daily', weekdays_only: $('#rc-wd').checked };
  else if (tp === 'weekly') rule = { type: 'weekly', days: [...document.querySelectorAll('.rc-day:checked')].map(x => Number(x.value)) };
  else rule = $('#rc-n').value === 'date' ? { type: 'monthly', mode: 'date', date: Number($('#rc-date').value) } : { type: 'monthly', mode: 'nth', n: Number($('#rc-n').value), weekday: Number($('#rc-wday').value) };
  return { recurrence: rule, time_window: `${$('#rc-ws').value}-${$('#rc-we').value}` };
}
function planSheet(id) {
  const pl = _plans.plans.find(x => x.id === id) || {};
  openSheet(`<h3>${id ? 'Change plan' : 'New service plan'}</h3>
    <label>Service</label><select id="pl-svc" ${id ? 'disabled' : ''}>${_plans.services.map(s => `<option value="${s.code}" ${pl.service_code === s.code ? 'selected' : ''}>${esc(s.name)} — from ${AED(s.default_price)}/visit</option>`).join('')}</select>
    ${recurrenceHtml(pl.recurrence, pl.time_window)}
    <label>Start date</label><input id="pl-start" type="date" min="${today()}" value="${pl.start_date && pl.start_date > today() ? pl.start_date : today()}">
    <p class="muted small">Visits are generated 14 days ahead. UAE public holidays are skipped. Changes apply to future visits only.</p>
    <button class="btn primary full" onclick="savePlan(${id || 'null'})">${id ? 'Save changes' : 'Start plan'}</button><p id="sh-err" class="err"></p>`);
}
async function savePlan(id) {
  const body = { ...readRc(), start_date: $('#pl-start').value, service_code: $('#pl-svc').value };
  try { await api(id ? '/customer/plans/' + id : '/customer/plans', { method: id ? 'PUT' : 'POST', body }); closeSheet(); toast(id ? 'Plan updated' : 'Plan started'); loadPlans(); }
  catch (e) { $('#sh-err').textContent = e.message; }
}
function pauseSheet(id) {
  openSheet(`<h3>Pause plan</h3><p class="muted">No visits are scheduled while paused. Leave "until" empty to pause until you resume.</p>
    <div class="two"><div><label>From</label><input id="pz-f" type="date" min="${today()}" value="${today()}"></div><div><label>Until</label><input id="pz-t" type="date" min="${today()}"></div></div>
    <button class="btn primary full" onclick="planPause(${id}, true)">Pause</button>`);
}
async function planPause(id, paused) {
  const body = paused ? { paused: true, pause_from: $('#pz-f').value || today(), pause_to: $('#pz-t').value || null } : { paused: false, pause_from: null, pause_to: null };
  try { await api('/customer/plans/' + id, { method: 'PUT', body }); closeSheet(); toast(paused ? 'Plan paused' : 'Plan resumed'); loadPlans(); }
  catch (e) { toast(e.message); }
}
async function bookingSheet() {
  if (!_plans.services.length) { try { _plans = await api('/customer/plans'); } catch {} }
  openSheet(`<h3>Book an extra visit</h3>
    <label>Service</label><select id="bk-s">${_plans.services.map(s => `<option value="${s.code}">${esc(s.name)} — ${AED(s.default_price)}</option>`).join('')}</select>
    <label>Date</label><input id="bk-d" type="date" min="${today()}" value="${today()}">
    <label>Preferred window (optional)</label><div class="two"><input id="bk-ws" type="time"><input id="bk-we" type="time"></div>
    <label>Notes</label><textarea id="bk-n" rows="2"></textarea>
    <button class="btn primary full" onclick="saveBooking()">Request visit</button><p id="sh-err" class="err"></p>`);
}
async function saveBooking() {
  const ws = $('#bk-ws').value, we = $('#bk-we').value;
  try {
    await api('/customer/bookings', { method: 'POST', body: { service_code: $('#bk-s').value, date: $('#bk-d').value, time_window: ws && we ? `${ws}-${we}` : null, notes: $('#bk-n').value } });
    closeSheet(); toast('Request sent — we will confirm shortly', 'success'); if (currentTab === 'plans') loadPlans();
  } catch (e) { $('#sh-err').textContent = e.message; }
}

// ── BILLS (CUS-08) ───────────────────────────────────────────
async function loadBills() {
  const el = $('#v-bills'); loading(el);
  try {
    const d = await api('/customer/invoices');
    el.innerHTML = `
      <div class="hero-card"><span class="eyebrow">Balance due</span><div class="hero-status ${d.balance > 0 ? (d.overdue > 0 ? 'canceled' : 'pending') : 'collected'}">${AED(d.balance)}</div>
        ${d.overdue > 0 ? `<p class="warn">${AED(d.overdue)} overdue</p>` : '<p class="muted">Thank you — all settled.</p>'}</div>
      <div class="sec-head"><h2>Invoices</h2></div>
      ${d.rows.length ? d.rows.map(i => `<button class="card inv" onclick="openDoc('/invoices/${i.id}/pdf')">
        <span><b>${esc(i.number)}</b><small>${esc(i.period.slice(5))}/${esc(i.period.slice(0, 4))} · ${i.job_ids.length} visit(s) · due ${dmy(i.due_date)} · tap for PDF</small></span>
        <span class="r"><b>${AED(i.amount)}</b><span class="pill ${esc(i.status_label.split(' ')[0])}">${esc(i.status_label)}</span></span></button>`).join('')
      : '<div class="card"><p class="muted">No invoices yet.</p></div>'}
      ${d.payments.length ? `<div class="sec-head"><h2>Payments</h2></div><div class="card">${d.payments.map(p => `<div class="line"><span><b>${AED(p.amount)}</b><small>${esc(p.number)} · ${esc(p.method)}</small></span><span class="muted small">${dmy(p.received_at)}</span></div>`).join('')}</div>` : ''}`;
  } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

// ── PROOF / HISTORY (CUS-03) ─────────────────────────────────
const hist = { from: new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10), to: today(), site: '' };
async function loadHistory() {
  const el = $('#v-history'); loading(el);
  try {
    const qs = `?from=${hist.from}&to=${hist.to}${hist.site ? '&site=' + hist.site : ''}`;
    const rows = await api('/customer/history-v3' + qs);
    const byMonth = {};
    rows.forEach(r => { (byMonth[r.scheduled_date.slice(0, 7)] ||= []).push(r); });
    el.innerHTML = `
      <div class="card filters">
        <div class="two"><div><label>From</label><input type="date" value="${hist.from}" onchange="hist.from=this.value;loadHistory()"></div>
          <div><label>To</label><input type="date" value="${hist.to}" onchange="hist.to=this.value;loadHistory()"></div></div>
        ${sites.length > 1 ? `<label>Site</label><select onchange="hist.site=this.value;loadHistory()"><option value="">All sites</option>${sites.map(s => `<option value="${s.id}" ${String(hist.site) === String(s.id) ? 'selected' : ''}>${esc(s.branch || s.name)}</option>`).join('')}</select>` : ''}
        <button class="btn ghost full" onclick="openDoc('/customer/history-v3/pdf${qs}&print=1')">Download PDF report</button>
      </div>
      ${Object.entries(byMonth).map(([m, list]) => `<h2 class="month">${new Date(m + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} <small>${list.filter(x => x.status === 'collected').length} completed</small></h2>
        <div class="gallery">${list.map(r => `<button class="g-item" onclick="openDetail(${r.id})">
          ${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="Visit ${esc(r.scheduled_date)}" loading="lazy">` : `<div class="noimg ${esc(r.status)}">${r.status === 'collected' ? '✓' : '✕'}</div>`}
          <span><b>${nice(r.scheduled_date)}</b><small>${esc(r.branch || '')} · ${r.status === 'collected' ? esc(r.service_name || 'Completed') : esc(reasonTxt(r.anomaly_reason))}</small></span></button>`).join('')}</div>`).join('')
      || '<p class="empty">No visits in this period.</p>'}`;
  } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

// ── MORE ─────────────────────────────────────────────────────
async function loadMore() {
  const el = $('#v-more'); loading(el);
  try {
    const [p, quotes] = await Promise.all([api('/customer/profile'), api('/customer/quotations').catch(() => [])]);
    el.innerHTML = `
      <div class="card"><h3>${esc(p.name)}</h3><p class="muted">${esc(p.branch || '')} · ${esc(p.zone || '')}<br>${esc(p.address || '')}<br>${esc(p.contact_phone || '')}</p>
        ${sites.length > 1 ? `<button class="btn ghost full" onclick="openSites()">Switch site (${sites.length})</button>` : ''}</div>
      <div class="card"><h3>Access notes for drivers</h3><p class="muted small">Gate codes, rear entrance, best time — shown in the driver app.</p>
        <textarea id="access-notes" rows="4">${esc(p.access_notes || '')}</textarea>
        <button class="btn primary full" onclick="saveAccessNotes()">Save notes</button></div>
      <div class="card" id="push-card">${pushCardHtml()}</div>
      ${quotes.length ? `<div class="card"><h3>Quotations</h3>${quotes.map(q => `<div class="line"><span><b>${esc(q.number)} v${q.version}</b><small>${AED(q.total)} · valid until ${dmy(q.valid_until)}</small></span>
        <span class="r"><span class="pill ${esc(q.status)}">${esc(q.status)}</span> <button class="btn ghost small" onclick="window.open('/q/${esc(q.share_token)}','_blank')">View</button></span></div>`).join('')}</div>` : ''}
      <button class="btn danger full" onclick="logout()">Sign out</button>`;
  } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
async function saveAccessNotes() {
  try { await api('/customer/access-notes', { method: 'PUT', body: { access_notes: ($('#access-notes') || {}).value || '' } }); toast('Access notes saved', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}
// Notifications card (More tab): shows whether this phone receives pushes and lets the customer fix it.
function pushCardHtml() {
  const st = window.GLPush ? window.GLPush.state() : 'unsupported';
  const info = {
    granted: ['ok', 'On for this device', 'You get alerts for visits, invoices and announcements even when the app is closed.'],
    default: ['warn', 'Off on this device', 'Turn on to hear about your driver, completed visits and new invoices.'],
    denied: ['blocked', 'Blocked in your browser', 'Open your phone / browser settings for this site, allow notifications, then come back.'],
    'ios-install': ['warn', 'Add to Home Screen first', 'On iPhone: Safari → Share → Add to Home Screen, then open GreenLoop from the new icon.'],
    unsupported: ['muted', 'Not supported in this browser', 'Use Chrome, Edge, Firefox or Safari. You still see every message under the bell icon.'],
  }[st];
  return `<h3>Notifications</h3><p class="${info[0]}" style="font-weight:800">${info[1]}</p><p class="muted small" style="margin:4px 0 2px">${info[2]}</p>
    ${st === 'default' ? '<button class="btn primary full" onclick="pushEnable()">Enable notifications</button>' : ''}
    ${st === 'granted' ? '<button class="btn ghost full" onclick="window.GLPush.test()">Send me a test notification</button>' : ''}`;
}
async function pushEnable() { await window.GLPush.enable(); const c = $('#push-card'); if (c) c.innerHTML = pushCardHtml(); }
document.addEventListener('glpush:change', () => { const c = $('#push-card'); if (c) c.innerHTML = pushCardHtml(); });

if (token && me) boot();
else $('#s-login').classList.remove('hidden');

// Mobile number fields: country code + number. The number used last time is remembered on this device.
try {
  const lp = localStorage.getItem('gl_cust_phone') || '';
  $('#login-phone-slot').innerHTML = GLPhone.html('login-phone', lp, { autocomplete: 'tel-national' });
  $('#otp-phone-slot').innerHTML = GLPhone.html('otp-phone', lp, { autocomplete: 'tel-national' });
} catch (e) { console.warn('phone field', e); }
