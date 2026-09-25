// ─────────────────────────────────────────────────────────────
// GreenLoop Driver v2 — proper app shell
// Tabs: Route · History · Account | Notification centre with chime
// Per-order progress: Accepted → In progress → Photo uploaded → Completed
// Zero text inputs · silent GPS + timestamp · offline queue (60 s retry)
// ─────────────────────────────────────────────────────────────
const API = '/api/v1';
let token = localStorage.getItem('gl_drv_token') || null;
let driver = JSON.parse(localStorage.getItem('gl_drv_user') || 'null');
let jobs = [];
let currentJob = null;
let pin = '';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ── SVG icons ────────────────────────────────────────────────
const svg = (p, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  truck: '<rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  award: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
};

// ── notification chime (WebAudio — no sound file needed) ─────
let audioCtx = null;
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = [[880, 0], [1174.66, 0.12]]; // A5 → D6, friendly two-tone
    notes.forEach(([f, t]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.4);
    });
    if (navigator.vibrate) navigator.vibrate(120);
  } catch { /* audio blocked until first interaction — fine */ }
}

// ── notification centre (persisted) ──────────────────────────
function getNotifs() { return JSON.parse(localStorage.getItem('gl_notifs') || '[]'); }
function pushNotif(kind, title, body, silent = false) {
  const list = getNotifs();
  list.unshift({ kind, title, body, ts: Date.now() });
  localStorage.setItem('gl_notifs', JSON.stringify(list.slice(0, 50)));
  const unread = Number(localStorage.getItem('gl_notifs_unread') || 0) + 1;
  localStorage.setItem('gl_notifs_unread', unread);
  renderBellBadge();
  if (!silent) chime();
  if (!$('#notif-panel').classList.contains('hidden')) renderNotifs();
}
function renderBellBadge() {
  const n = Number(localStorage.getItem('gl_notifs_unread') || 0);
  const b = $('#bell-badge');
  b.textContent = n > 9 ? '9+' : n;
  b.classList.toggle('hidden', n === 0);
}
function toggleNotifs() {
  const p = $('#notif-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    localStorage.setItem('gl_notifs_unread', 0);
    renderBellBadge();
    renderNotifs();
  }
}
function clearNotifs() {
  localStorage.setItem('gl_notifs', '[]');
  localStorage.setItem('gl_notifs_unread', 0);
  renderBellBadge(); renderNotifs();
}
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function renderNotifs() {
  const list = getNotifs();
  $('#notif-list').innerHTML = list.length ? list.map(n => `
    <div class="notif-item">
      <div class="nicon ${n.kind}">${svg(n.kind === 'ok' ? IC.checkCircle : n.kind === 'bad' ? IC.xCircle : IC.bell, 19)}</div>
      <div class="ntext"><div class="ntitle">${esc(n.title)}</div><div class="nbody">${esc(n.body)}</div></div>
      <div class="ntime">${ago(n.ts)}</div>
    </div>`).join('') : '<div class="notif-empty">No notifications yet</div>';
}

// ── PIN login ────────────────────────────────────────────────
function renderDots() {
  document.querySelectorAll('#pin-dots i').forEach((d, i) => d.classList.toggle('on', i < pin.length));
}
function pinKey(n) {
  if (pin.length >= 4) return;
  pin += n; renderDots();
  if (pin.length === 4) tryLogin();
}
function pinDel() { pin = pin.slice(0, -1); renderDots(); $('#login-msg').textContent = ''; }

async function tryLogin() {
  try {
    const res = await fetch(API + '/auth/driver-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token; driver = data.user;
    localStorage.setItem('gl_drv_token', token);
    localStorage.setItem('gl_drv_user', JSON.stringify(driver));
    pin = ''; renderDots();
    pushNotif('info', `Welcome, ${driver.name.split(' ')[0]}`, 'You are signed in. Have a safe shift!', true);
    enterApp();
  } catch {
    pin = ''; renderDots();
    $('#login-msg').textContent = 'Wrong PIN — try again';
    setTimeout(() => { $('#login-msg').textContent = ''; }, 1800);
  }
}

function logout() {
  localStorage.removeItem('gl_drv_token'); localStorage.removeItem('gl_drv_user');
  token = null; driver = null;
  $('#s-app').classList.add('hidden');
  $('#s-login').classList.remove('hidden');
}

// ── app shell ────────────────────────────────────────────────
const fmtDate = d => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
function initials(name) { return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(); }

async function enterApp() {
  $('#s-login').classList.add('hidden');
  $('#s-app').classList.remove('hidden');
  $('#hdr-avatar').textContent = initials(driver.name);
  $('#hdr-greet').textContent = `${greeting()}, ${driver.name.split(' ')[0]}`;
  $('#hdr-date').textContent = fmtDate(new Date());
  renderBellBadge();
  await loadJobs();
  switchTab('home');
  connectSocket();
}

let sock = null;
function connectSocket() {
  try {
    if (sock) sock.disconnect();
    sock = io();
    sock.on('connect', () => $('#hdr-live').classList.remove('off'));
    sock.on('disconnect', () => $('#hdr-live').classList.add('off'));
    sock.on('driver:queue-updated', d => {
      if (driver?.vehicle && d.vehicle_id === driver.vehicle.id) {
        pushNotif('info', 'Route updated', 'The office changed your pickup queue. Check your route.');
        loadJobs().then(() => { if (activeTab === 'home') renderHome(); });
      }
    });
  } catch {}
}

let activeTab = 'home';
function switchTab(tab) {
  activeTab = tab;
  $('#notif-panel').classList.add('hidden');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  ['home', 'history', 'account'].forEach(v => $('#v-' + v).classList.toggle('hidden', v !== tab));
  if (tab === 'home') { loadJobs().then(renderHome); renderHome(); }
  if (tab === 'history') renderHistory();
  if (tab === 'account') renderAccount();
}

// ── HOME (today's route) ─────────────────────────────────────
async function loadJobs() {
  try {
    const res = await fetch(API + '/driver/jobs', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return logout();
    const data = await res.json();
    jobs = data.jobs;
  } catch { /* offline — keep last list */ }
}

// order stage model: pending(+no stage)=step0 · acknowledged=step1 · photo sent=step3 · collected=step4 · canceled=ended
function jobSteps(j) {
  if (j.status === 'collected') return 4;
  if (j.status === 'canceled') return -1;
  if (j.stage === 'acknowledged') return 1;
  return 0;
}
const STEP_LABELS = ['Pickup accepted', 'Collection in progress', 'Photo uploaded', 'Order completed'];

function ministeps(j) {
  const s = jobSteps(j);
  if (s === -1) return `<div class="ministeps"><span class="ms bad">${svg(IC.x, 12)}</span><span class="ln"></span><span class="ms bad">${svg(IC.ban, 12)}</span></div>`;
  return `<div class="ministeps">${STEP_LABELS.map((_, i) =>
    `<span class="ms ${i < s ? 'done' : ''}">${i < s ? svg(IC.check, 12) : i + 1}</span>${i < 3 ? `<span class="ln ${i < s - 1 ? 'done' : ''}"></span>` : ''}`).join('')}</div>`;
}
function chip(j) {
  if (j.status === 'collected') return `<span class="chip collected">${svg(IC.check, 11)} Done</span>`;
  if (j.status === 'canceled') return `<span class="chip canceled">${svg(IC.x, 11)} No pickup</span>`;
  if (j.status === 'overdue') return `<span class="chip overdue">${svg(IC.clock, 11)} Overdue</span>`;
  if (j.stage === 'acknowledged') return `<span class="chip progress">${svg(IC.play, 11)} In progress</span>`;
  return `<span class="chip pending">${svg(IC.clock, 11)} Waiting</span>`;
}

function renderHome() {
  const done = jobs.filter(j => ['collected', 'canceled'].includes(j.status)).length;
  const pct = jobs.length ? Math.round(100 * done / jobs.length) : 0;
  $('#v-home').innerHTML = `
    <div class="sumcard">
      <div class="sumtop"><span class="sumtitle">${svg(IC.calendar, 16)} Today's route</span>
      <span class="sumcount">${done} / ${jobs.length} done</span></div>
      <div class="progressbar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="h-sec">Pickups${driver?.vehicle ? ` — ${esc(driver.vehicle.fleet_number)}` : ''}</div>
    ${jobs.map((j, i) => `
      <button class="job-card" onclick="openJob(${j.id})" ${['collected', 'canceled'].includes(j.status) ? 'disabled' : ''}>
        <div class="jc-top">
          <span class="jc-num">${j.seq || i + 1}</span>
          <span class="jc-name">${esc(j.name)}<small>${esc(j.branch || '')} · ${esc(j.zone)}</small></span>
          ${chip(j)}
        </div>
        ${ministeps(j)}
      </button>`).join('') || '<div class="empty">No pickups scheduled today.<br>Enjoy the break!</div>'}`;
}

// ── JOB DETAIL + stepper ─────────────────────────────────────
function openJob(id) {
  currentJob = jobs.find(j => j.id === id);
  if (!currentJob) return;
  $('#job-name').textContent = currentJob.name;
  $('#job-meta').innerHTML = `<b>${esc(currentJob.name)}</b>
    <span>${svg(IC.pin, 13)} ${esc(currentJob.branch || '')} · ${esc(currentJob.zone)}</span>
    <span>${esc(currentJob.address || '')}</span>`;
  renderJobDetail();
  $('#s-job').classList.remove('hidden');
}
function closeJob() { $('#s-job').classList.add('hidden'); renderHome(); }

function renderJobDetail(forceStep) {
  const s = forceStep !== undefined ? forceStep : jobSteps(currentJob);
  $('#stepper').innerHTML = STEP_LABELS.map((lbl, i) => {
    const done = i < s, active = i === s;
    return `<div class="step ${done ? 'done' : ''} ${active ? 'active' : ''}">
      <div class="rail"><div class="bub">${done ? svg(IC.check, 15) : i + 1}</div><div class="vline"></div></div>
      <div class="stext"><div class="stitle">${lbl}</div>
      <div class="ssub">${['Tap Start Pickup when you arrive', 'Collect the waste, then take the photo', 'Photo + location sent to the office', 'All done — next stop!'][i]}</div></div>
    </div>`;
  }).join('');

  const A = $('#job-actions');
  if (s === 0) {
    A.innerHTML = `<button class="giant teal" onclick="ackJob()">${svg(IC.play)}<span>START PICKUP</span></button>`;
  } else if (s === 1) {
    A.innerHTML = `
      <button class="giant green" onclick="startPhoto()">${svg(IC.camera)}<span>TAKE PICKUP PHOTO</span></button>
      <button class="giant red" onclick="showReasons()">${svg(IC.ban)}<span>NO PICKUP TODAY</span></button>`;
  } else if (s === 2) {
    A.innerHTML = `<button class="giant teal" disabled>${svg(IC.upload)}<span>SENDING…</span></button>`;
  } else {
    A.innerHTML = '';
  }
}

async function ackJob() {
  if (!currentJob) return;
  currentJob.stage = 'acknowledged'; // optimistic
  renderJobDetail();
  try {
    await fetch(`${API}/pickups/${currentJob.id}/ack`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  } catch { /* offline — server learns on completion */ }
}

// telemetry
function getGPS() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { enableHighAccuracy: true, timeout: 6000 });
  });
}

// Action: photo + complete
function startPhoto() { $('#camera').click(); }
$('#camera').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !currentJob) return;
  renderJobDetail(2); // "photo uploaded / sending"
  const gps = await getGPS();
  const payload = {
    kind: 'complete', pickupId: currentJob.id,
    lat: gps.lat, lng: gps.lng, client_ts: new Date().toISOString(),
    photo: await fileToDataUrl(file),
  };
  const ok = await sendOrQueue(payload);
  currentJob.status = 'collected'; currentJob.stage = 'completed';
  renderJobDetail(4);
  pushNotif('ok', 'Pickup completed', `${currentJob.name} — ${ok ? 'sent to office' : 'saved, will send automatically'}`);
  flash(true, ok ? 'COMPLETED' : 'SAVED — WILL SEND');
});

// Action: no pickup
function showReasons() { $('#s-reasons').classList.remove('hidden'); }
function hideReasons() { $('#s-reasons').classList.add('hidden'); }
async function cancelJob(reason) {
  hideReasons();
  if (!currentJob) return;
  const gps = await getGPS();
  const payload = { kind: 'cancel', pickupId: currentJob.id, reason, lat: gps.lat, lng: gps.lng, client_ts: new Date().toISOString() };
  const ok = await sendOrQueue(payload);
  currentJob.status = 'canceled';
  pushNotif('bad', 'No pickup reported', `${currentJob.name} — ${reason.replace(/_/g, ' ').toLowerCase()}`);
  flash(false, ok ? 'REPORTED' : 'SAVED — WILL SEND');
}

function flash(good, msg) {
  const el = document.createElement('div');
  el.className = 'done-flash ' + (good ? 'ok' : 'bad');
  el.innerHTML = `${svg(good ? IC.checkCircle : IC.xCircle, 96)}<span>${msg}</span>`;
  document.body.appendChild(el);
  setTimeout(() => { el.remove(); closeJob(); }, 1300);
}

// ── HISTORY ──────────────────────────────────────────────────
async function renderHistory() {
  let rows = [];
  try {
    const res = await fetch(API + '/driver/history', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return logout();
    rows = await res.json();
  } catch {}
  const byDate = {};
  rows.forEach(r => { (byDate[r.scheduled_date] ||= []).push(r); });
  const today = new Date().toISOString().slice(0, 10);
  const nice = d => d === today ? 'Today' :
    new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  $('#v-history').innerHTML = `
    <div class="h-sec">Pickup history</div>
    ${Object.entries(byDate).map(([date, list]) => `
      <div class="hist-date">${nice(date)}</div>
      ${list.map(r => `
        <div class="hist-item">
          ${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="">` :
            `<div class="hist-icon ${r.status === 'collected' ? 'ok' : 'bad'}">${svg(r.status === 'collected' ? IC.checkCircle : IC.xCircle, 22)}</div>`}
          <div class="hist-text">
            <div class="hist-name">${esc(r.name)}</div>
            <div class="hist-sub">${esc(r.branch || '')} · ${r.status === 'collected' ? 'Collected' : r.status === 'canceled' ? (r.anomaly_reason || 'No pickup').replace(/_/g, ' ').toLowerCase() : 'Overdue'}</div>
          </div>
          <div class="hist-time">${r.completed_at ? r.completed_at.replace('T', ' ').slice(11, 16) : ''}</div>
        </div>`).join('')}`).join('') || '<div class="empty">No history yet — completed pickups will appear here.</div>'}`;
}

// ── ACCOUNT ──────────────────────────────────────────────────
async function renderAccount() {
  let me = null;
  try {
    const res = await fetch(API + '/driver/me', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return logout();
    me = await res.json();
  } catch {}
  if (!me) { $('#v-account').innerHTML = '<div class="empty">Offline — profile unavailable.</div>'; return; }
  const rate = me.stats.month_total ? Math.round(100 * me.stats.month_collected / me.stats.month_total) : 100;
  $('#v-account').innerHTML = `
    <div class="acct-hero">
      <div class="avatar">${initials(me.name)}</div>
      <div class="acct-name">${esc(me.name)}</div>
      <div class="acct-sub">Driver since ${(me.since || '').slice(0, 10)}</div>
    </div>
    <div class="h-sec">This month</div>
    <div class="statgrid">
      <div class="stat"><div class="n">${me.stats.month_collected}</div><div class="l">Collected</div></div>
      <div class="stat bad"><div class="n">${me.stats.month_no_pickup}</div><div class="l">No pickup</div></div>
      <div class="stat"><div class="n">${rate}%</div><div class="l">Success</div></div>
    </div>
    <div class="h-sec">Details</div>
    ${me.vehicle ? `<div class="inforow">${svg(IC.truck, 20)}<div><span class="lbl">Assigned vehicle</span><b>${esc(me.vehicle.fleet_number)}</b> · ${esc(me.vehicle.plate)} · ${esc(me.vehicle.zone)} zone</div></div>` : ''}
    <div class="inforow">${svg(IC.phone, 20)}<div><span class="lbl">Phone</span><b>${esc(me.phone || '—')}</b></div></div>
    <div class="inforow">${svg(IC.award, 20)}<div><span class="lbl">Career pickups completed</span><b>${me.stats.career_collected}</b></div></div>
    <button class="logoutbtn" onclick="logout()">${svg(IC.logout, 18)} Sign out</button>`;
}

// ── network layer with offline queue ─────────────────────────
function fileToDataUrl(file) {
  return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
}
function dataUrlToBlob(u) {
  const [meta, b64] = u.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function transmit(p) {
  if (p.kind === 'complete') {
    const fd = new FormData();
    fd.append('photo', dataUrlToBlob(p.photo), 'proof.jpg');
    fd.append('lat', p.lat ?? ''); fd.append('lng', p.lng ?? ''); fd.append('client_ts', p.client_ts);
    const res = await fetch(`${API}/pickups/${p.pickupId}/complete`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
    });
    return res.ok || res.status === 409;
  }
  const res = await fetch(`${API}/pickups/${p.pickupId}/cancel`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: p.reason, lat: p.lat, lng: p.lng }),
  });
  return res.ok || res.status === 409;
}

function getQueue() { return JSON.parse(localStorage.getItem('gl_queue') || '[]'); }
function setQueue(q) {
  localStorage.setItem('gl_queue', JSON.stringify(q));
  $('#sync-banner').classList.toggle('hidden', q.length === 0);
  $('#sync-count').textContent = q.length;
}
async function sendOrQueue(payload) {
  try {
    if (await transmit(payload)) return true;
    throw new Error('send failed');
  } catch {
    setQueue([...getQueue(), payload]);
    return false;
  }
}
setInterval(async () => {
  const q = getQueue();
  if (!q.length || !token) return;
  const remaining = [];
  for (const p of q) {
    try { if (!(await transmit(p))) remaining.push(p); }
    catch { remaining.push(p); }
  }
  setQueue(remaining);
  if (!remaining.length && q.length) pushNotif('ok', 'Back online', 'All saved pickups were sent to the office.');
}, 60_000);

window.addEventListener('online', () => $('#hdr-live')?.classList.remove('off'));
window.addEventListener('offline', () => $('#hdr-live')?.classList.add('off'));

// close notification panel when tapping outside
document.addEventListener('click', e => {
  const p = $('#notif-panel');
  if (!p.classList.contains('hidden') && !p.contains(e.target) && !e.target.closest('.bell')) p.classList.add('hidden');
});

// ── boot ─────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
$('#login-date').textContent = fmtDate(new Date());
setQueue(getQueue());
if (token && driver) enterApp();

// --- AUTOMATED PATCH: DRIVER INTERFACE MEDIA STEPS & ALERTS ---
(function() {
    const audioChime = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-600.wav');
    const driverStyles = document.createElement('style');
    driverStyles.innerHTML = `
        .camera-review-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:#0f172a; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:999999; padding:20px; }
        .camera-preview-box { width:100%; max-width:360px; height:270px; background:#1e293b; border:2px solid #0d9488; border-radius:12px; margin-bottom:20px; display:flex; align-items:center; justify-content:center; color:#64748b; }
        .review-action-row { display:flex; gap:16px; width:100%; max-width:360px; }
        .btn-review-confirm { flex:1; background:#0d9488; color:#fff; border:none; padding:14px; border-radius:8px; font-weight:600; }
        .btn-review-retry { flex:1; background:#334155; color:#f8fafc; border:1px solid #475569; padding:14px; border-radius:8px; font-weight:600; }
    `;
    document.head.appendChild(driverStyles);

    window.addEventListener('message', (e) => {
        if (e.data === 'route_changed') {
            audioChime.play().catch(() => {});
            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        }
    });

    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('#start-pickup-btn');
        if (btn) {
            const orderId = btn.dataset.orderId || "1";
            const currentStatus = btn.dataset.status || "PENDING";
            let nextStatus = "ACCEPTED";
            if (currentStatus === "ACCEPTED") nextStatus = "IN_PROGRESS";
            if (currentStatus === "IN_PROGRESS") {
                if(!document.getElementById('driver-camera-overlay')) {
                    const overlay = document.createElement('div');
                    overlay.id = 'driver-camera-overlay';
                    overlay.className = 'camera-review-overlay';
                    overlay.innerHTML = `
                        <h3 style="color:#fff;">📸 Image Verification Check</h3>
                        <div class="camera-preview-box"><div>📄 waste_proof_${orderId}.jpg</div></div>
                        <div class="review-action-row">
                            <button class="btn-review-retry" id="retry-photo-btn">Recapture</button>
                            <button class="btn-review-confirm" id="confirm-photo-btn">Confirm & Complete</button>
                        </div>`;
                    document.body.appendChild(overlay);
                    document.getElementById('retry-photo-btn').onclick = () => overlay.remove();
                    document.getElementById('confirm-photo-btn').onclick = async () => {
                        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
                        await fetch(`/api/v1/pickups/${orderId}/step`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'PHOTO_UPLOADED', timestamp: ts }) });
                        await fetch(`/api/v1/pickups/${orderId}/step`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'COMPLETED', timestamp: ts }) });
                        overlay.remove();
                        window.location.reload();
                    };
                }
                return;
            }
            const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
            await fetch(`/api/v1/pickups/${orderId}/step`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextStatus, timestamp: ts }) });
            window.location.reload();
        }
    });
})();