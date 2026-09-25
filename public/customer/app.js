const API = '/api/v1';
let token = sessionStorage.getItem('gl_cust_token') || null;
let me = JSON.parse(sessionStorage.getItem('gl_cust_me') || 'null');
let pin = '';
let socket = null;
let currentTab = 'home';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pinKey(n) {
  if (pin.length >= 4) return;
  pin += String(n);
  renderDots();
  if (pin.length === 4) doLogin();
}
function pinDel() {
  pin = pin.slice(0, -1);
  renderDots();
  $('#login-msg').textContent = '';
}
function renderDots() {
  [...$('#pin-dots').children].forEach((d, i) => d.classList.toggle('on', i < pin.length));
}

async function doLogin() {
  $('#login-msg').textContent = '';
  try {
    const res = await fetch(API + '/auth/customer-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    token = data.token;
    me = data.customer;
    sessionStorage.setItem('gl_cust_token', token);
    sessionStorage.setItem('gl_cust_me', JSON.stringify(me));
    pin = '';
    renderDots();
    boot();
  } catch (e) {
    $('#login-msg').textContent = e.message;
    pin = '';
    renderDots();
  }
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function logout() {
  token = null;
  me = null;
  sessionStorage.removeItem('gl_cust_token');
  sessionStorage.removeItem('gl_cust_me');
  if (socket) socket.disconnect();
  $('#s-app').classList.add('hidden');
  $('#s-login').classList.remove('hidden');
}

function boot() {
  $('#s-login').classList.add('hidden');
  $('#s-app').classList.remove('hidden');
  $('#hdr-name').textContent = me.name;
  $('#hdr-sub').textContent = (me.branch || '') + (me.zone ? ' · ' + me.zone : '');
  $('#hdr-avatar').textContent = (me.name || 'S').charAt(0).toUpperCase();

  socket = io();
  socket.on('connect', () => {
    $('#hdr-live').classList.remove('off');
    socket.emit('customer:join', { customer_id: me.id });
  });
  socket.on('disconnect', () => $('#hdr-live').classList.add('off'));
  socket.on('pickup:completed', () => {
    toast('Collected — photo proof available');
    if (currentTab === 'home') loadHome();
  });
  socket.on('pickup:canceled', (d) => {
    toast('No pickup: ' + (d.reason || '').replace(/_/g, ' '));
    if (currentTab === 'home') loadHome();
  });
  socket.on('pickup:ack', () => toast('Driver started your pickup'));
  socket.on('pickup:arrived', () => {
    toast('Driver has arrived at your location');
    if (currentTab === 'home') loadHome();
  });
  socket.on('driver:nearby', (d) => {
    if (d.customer_id === me.id) {
      const eta = d.eta_minutes != null ? ` ~${d.eta_minutes} min` : '';
      toast((d.nearby || d.distance_m < 150 ? 'Driver nearby' : 'Driver on the way') + eta);
      updateTrackCard(d);
    }
  });

  switchTab('home');
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
  ['home', 'history', 'more'].forEach((v) => {
    const el = $('#v-' + v);
    if (el) el.classList.toggle('hidden', v !== tab);
  });
  if (tab === 'home') loadHome();
  if (tab === 'history') loadHistory();
  if (tab === 'more') loadMore();
}

function toast(msg) {
  const t = document.createElement('div');
  t.style.cssText =
    'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1c2a36;border:1px solid #263847;padding:10px 16px;border-radius:10px;z-index:50;font-size:13px;max-width:90%';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function updateTrackCard(d) {
  const el = $('#track-card');
  if (!el || !d || d.lat == null) return;
  const eta = d.eta_minutes != null ? `<b>~${d.eta_minutes} min</b>` : '—';
  const dist = d.distance_m != null ? Math.round(d.distance_m) + ' m' : '';
  el.innerHTML = `<h3>Live tracking</h3>
    <p style="margin:0 0 6px"><strong>${esc(d.fleet_number || 'Truck')}</strong> · ${esc(d.name || 'Driver')}</p>
    <p class="muted" style="margin:0">ETA ${eta} ${dist ? '· ' + dist : ''}
    ${d.nearby || (d.distance_m != null && d.distance_m < 150) ? ' · <span style="color:var(--green)">Nearby</span>' : ''}</p>`;
}

async function loadHome() {
  const el = $('#v-home');
  el.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const [d, track] = await Promise.all([
      api('/customer/dashboard'),
      api('/customer/driver-location').catch(() => ({ tracking: false })),
    ]);
    const today = d.today || [];
    const upcoming = d.upcoming || [];
    const compliance = d.compliance || {};

    let trackHtml = `<div class="card" id="track-card"><h3>Live tracking</h3>`;
    if (track.tracking) {
      trackHtml += `<p style="margin:0 0 6px"><strong>${esc(track.pickup?.fleet_number || 'Truck')}</strong> · ${esc(track.pickup?.driver_name || '')}</p>
        <p class="muted" style="margin:0">ETA <b>~${track.eta_minutes ?? '—'} min</b>
        · ${track.distance_m != null ? track.distance_m + ' m' : ''}
        ${track.nearby ? ' · <span style="color:var(--green)">Nearby</span>' : ''}
        ${track.pickup?.stage === 'arrived' ? ' · <span style="color:var(--green)">Arrived</span>' : ''}</p>`;
    } else {
      trackHtml += `<p class="muted">${esc(track.reason || 'No live location yet')}</p>`;
    }
    trackHtml += `</div>`;

    el.innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><b>${compliance.collected_this_month ?? 0}</b><span>Done MTD</span></div>
        <div class="kpi"><b>${compliance.frequency ?? 2}</b><span>Target / mo</span></div>
        <div class="kpi"><b>${compliance.pending_upcoming ?? 0}</b><span>Upcoming</span></div>
      </div>
      ${trackHtml}
      <div class="card"><h3>Today’s visit</h3>
        ${today.length === 0 ? '<p class="muted">No pickup scheduled for today.</p>' : today.map(visitCard).join('')}
      </div>
      <div class="card"><h3>Upcoming</h3>
        ${upcoming.length === 0 ? '<p class="muted">None in next 14 days.</p>' : upcoming.map(visitCard).join('')}
      </div>`;
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function visitCard(v) {
  return `<div class="visit" onclick="openDetail(${v.id})">
    <span class="st ${esc(v.status)}"></span>
    <div class="meta">
      <b>${esc(v.scheduled_date)}${v.fleet_number ? ' · ' + esc(v.fleet_number) : ''}</b>
      <small>${v.driver_name ? esc(v.driver_name) + ' · ' : ''}<span class="pill ${esc(v.status)}">${esc(v.status)}</span>
      ${v.stage ? ' · ' + esc(v.stage) : ''}</small>
    </div>
  </div>`;
}

async function openDetail(id) {
  $('#s-detail').classList.remove('hidden');
  $('#det-body').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const v = await api('/customer/pickups/' + id);
    $('#det-title').textContent = v.scheduled_date || 'Visit';
    let html = `<p><span class="pill ${esc(v.status)}">${esc(v.status)}</span>
      ${v.stage ? ' · ' + esc(v.stage) : ''}</p>
      <p class="muted" style="margin-top:10px">Vehicle: <b>${esc(v.fleet_number || '—')}</b><br>Driver: <b>${esc(v.driver_name || '—')}</b></p>`;
    if (v.photo_url) html += `<img class="photo" src="${esc(v.photo_url)}" alt="Proof">`;
    if (v.gps_lat) html += `<p class="muted">GPS: ${Number(v.gps_lat).toFixed(5)}, ${Number(v.gps_lng).toFixed(5)}</p>`;
    if (v.anomaly_reason) html += `<p style="color:var(--amber)">Reason: ${esc(v.anomaly_reason.replace(/_/g, ' '))}</p>`;
    if (['pending', 'overdue'].includes(v.status)) {
      html += `<div class="field" style="margin-top:16px"><label>Note for driver</label>
        <textarea id="note-text" rows="3"></textarea></div>
        <button class="btn primary" onclick="sendNote(${v.id})">Send note</button>
        <button class="btn ghost" onclick="reportAccess(${v.id})">Report access issue</button>`;
    }
    $('#det-body').innerHTML = html;
  } catch (e) {
    $('#det-body').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function closeDetail() {
  $('#s-detail').classList.add('hidden');
}

async function sendNote(id) {
  const notes = ($('#note-text') || {}).value || '';
  if (!notes.trim()) return toast('Write a note first');
  try {
    await api('/customer/pickups/' + id + '/note', { method: 'POST', body: { notes } });
    toast('Note sent');
    closeDetail();
  } catch (e) {
    toast(e.message);
  }
}

async function reportAccess(id) {
  try {
    await api('/customer/pickups/' + id + '/access-issue', {
      method: 'POST',
      body: { message: 'Store reports access may be blocked' },
    });
    toast('Ops notified');
    closeDetail();
  } catch (e) {
    toast(e.message);
  }
}

async function loadHistory() {
  const el = $('#v-history');
  el.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const rows = await api('/customer/history');
    el.innerHTML = rows.length
      ? '<div class="card"><h3>Past visits</h3>' + rows.map(visitCard).join('') + '</div>'
      : '<p class="empty">No past visits yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

async function loadMore() {
  const el = $('#v-more');
  el.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const p = await api('/customer/profile');
    el.innerHTML = `
      <div class="card">
        <h3>${esc(p.name)}</h3>
        <p class="muted">${esc(p.branch || '')}<br>${esc(p.zone || '')}<br>${esc(p.address || '')}</p>
        <p class="muted">Phone: ${esc(p.contact_phone || '—')} · ${p.frequency || 2}× / month</p>
      </div>
      <div class="card">
        <h3>Access notes for drivers</h3>
        <p class="muted">Gate codes, rear entrance, best time — shown on the driver app.</p>
        <textarea id="access-notes" rows="4" style="width:100%;background:#1c2a36;border:1px solid #263847;color:#e8eef2;border-radius:10px;padding:10px;margin-top:8px">${esc(p.access_notes || '')}</textarea>
        <button class="btn primary" onclick="saveAccessNotes()">Save notes</button>
      </div>
      <button class="btn danger" onclick="logout()">Sign out</button>`;
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

async function saveAccessNotes() {
  const notes = ($('#access-notes') || {}).value || '';
  try {
    await api('/customer/access-notes', { method: 'PUT', body: { access_notes: notes } });
    toast('Access notes saved');
  } catch (e) {
    toast(e.message);
  }
}

if (token && me) boot();
else $('#s-login').classList.remove('hidden');
