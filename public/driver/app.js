// ─────────────────────────────────────────────────────────────
// GreenLoop Driver v2 — proper app shell
// Tabs: Route · History · Account | Notification centre with chime
// Per-stop flow (v3.3): Clock in → Start job → Arrive (one GPS-stamped photo) → Finish or report an issue
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
  // stop pushes to this phone for the driver signing out (needs the token, so do it first)
  try { if (window.GLPush) window.GLPush.signOut(); } catch {}
  localStorage.removeItem('gl_drv_token'); localStorage.removeItem('gl_drv_user');
  token = null; driver = null;
  try { shift = null; localStorage.removeItem('gl_drv_shift'); } catch {}
  $('#s-app').classList.add('hidden');
  $('#s-login').classList.remove('hidden');
}

// ── app shell ────────────────────────────────────────────────
// weekday + DD/MM/YYYY (date / month / year) so day and month can never be confused
const fmtDate = d => `${d.toLocaleDateString(undefined, { weekday: 'long' })} · ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

// System messages drop in at the TOP of the screen (v3.2). kind: 'info' | 'success' | 'error'
function glToast(msg, kind = 'info') {
  const wrap = $('#toasts'); if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `${svg(kind === 'error' ? IC.xCircle : kind === 'success' ? IC.checkCircle : IC.bell, 22)}<span></span>`;
  el.querySelector('span').textContent = msg;
  el.onclick = () => el.remove();
  wrap.prepend(el);
  while (wrap.children.length > 3) wrap.lastChild.remove();
  if (kind === 'error' && navigator.vibrate) navigator.vibrate([80, 60, 80]);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4500);
}
window.toast = glToast;
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
  await Promise.all([loadJobs(), typeof loadShift === 'function' ? loadShift() : null]);
  switchTab('home');
  connectSocket();
}

let sock = null;
function connectSocket() {
  try {
    if (sock) sock.disconnect();
    sock = io({ auth: { token } });
    sock.on('connect', () => $('#hdr-live').classList.remove('off'));
    sock.on('disconnect', () => $('#hdr-live').classList.add('off'));
    sock.on('driver:at-risk', d => {
      if (driver && d.driver_id === driver.id) {
        const j = jobs.find(x => x.id === d.pickup_id);
        pushNotif('bad', 'Stop at risk', `${j ? j.name : 'Job #' + d.pickup_id} — window closes ${d.window_end}`);
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        if (activeTab === 'home') renderHome();
      }
    });
    // office messages: announcements, vehicle-report decisions, new stops
    sock.on('driver:notify', n => {
      pushNotif(n.kind === 'bad' ? 'bad' : 'info', n.title || 'GreenLoop', n.body || '');
      glToast(`${n.title || ''}${n.body ? ' — ' + n.body : ''}`);
      if (activeTab === 'vehicle' && typeof renderVehicle === 'function') renderVehicle();
    });
    sock.on('driver:queue-updated', d => {
      if (driver?.vehicle && d.vehicle_id === driver.vehicle.id) {
        pushNotif('info', 'Route updated', 'The office changed your pickup queue. Check your route.');
        glToast('Route updated — check your stops');
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
  ['home', 'history', 'vehicle', 'account'].forEach(v => $('#v-' + v).classList.toggle('hidden', v !== tab));
  if (tab === 'vehicle') renderVehicle();
  if (tab === 'home') { Promise.all([loadJobs(), typeof loadShift === 'function' ? loadShift() : null]).then(renderHome); renderHome(); }
  if (tab === 'history') renderHistory();
  if (tab === 'account') renderAccount();
}

// ── i18n (DRV-12): English · हिन्दी · اردو · العربية ─────────
const LANGS = { en: 'English', hi: 'हिन्दी', ur: 'اردو', ar: 'العربية' };
const TR = {
  en: { route: 'Route', history: 'History', account: 'Account', today: "Today's route", done: 'done', pickups: 'Stops', none: 'No stops scheduled today.<br>Enjoy the break!',
    start: 'START JOB', photo: 'TAKE PROOF PHOTO', nopick: 'NOT PICKED UP', navigate: 'Navigate', call: 'Call site', arrived: "I'VE ARRIVED",
    checklist: 'Checklist — tick every item', why: 'Why not picked up?', CLOSED: 'Site closed', NO_ACCESS: 'No access', NO_WASTE: 'No waste', CUSTOMER_REFUSED: 'Customer refused',
    left: 'left', closes: 'Closes in', missed: 'Window missed', opens: 'Opens', waitingGps: 'Waiting for GPS…', capture: 'Capture', retake: 'Retake', use: 'Use photo',
    rejected: 'PHOTO REJECTED', completed: 'COMPLETED', reported: 'REPORTED', saved: 'SAVED — WILL SEND', camBlocked: 'Camera access is required. Allow the camera for this app — gallery uploads are not accepted.',
    sAccepted: 'Job started', sInProgress: 'On site', sPhoto: 'Proof photo', sDone: 'Completed', lang: 'Language', notes: 'Access notes', revisit: 'Free revisit', stepHelp: ['Tap Start when you set off to this stop', 'Do the job, tick the checklist, then take the live photo', 'Photo + GPS + time stamped on the phone and checked by the office', 'All done — next stop!'] },
  hi: { route: 'रूट', history: 'इतिहास', account: 'खाता', today: 'आज का रूट', done: 'पूरे', pickups: 'स्टॉप', none: 'आज कोई स्टॉप नहीं।', start: 'काम शुरू करें', photo: 'प्रूफ़ फ़ोटो लें', nopick: 'पिकअप नहीं हुआ',
    navigate: 'नेविगेट', call: 'कॉल करें', arrived: 'मैं पहुँच गया', checklist: 'चेकलिस्ट — हर आइटम टिक करें', why: 'पिकअप क्यों नहीं हुआ?', CLOSED: 'दुकान बंद', NO_ACCESS: 'पहुँच नहीं', NO_WASTE: 'कचरा नहीं', CUSTOMER_REFUSED: 'ग्राहक ने मना किया',
    left: 'बाकी', closes: 'बंद होगा', missed: 'समय निकल गया', opens: 'खुलेगा', waitingGps: 'GPS का इंतज़ार…', capture: 'फ़ोटो लें', retake: 'फिर से', use: 'यह फ़ोटो भेजें', rejected: 'फ़ोटो अस्वीकृत', completed: 'पूरा हुआ', reported: 'रिपोर्ट हो गया', saved: 'सेव — बाद में भेजेंगे',
    camBlocked: 'कैमरा अनुमति ज़रूरी है। गैलरी से फ़ोटो नहीं चलेगी।', sAccepted: 'काम शुरू', sInProgress: 'साइट पर', sPhoto: 'प्रूफ़ फ़ोटो', sDone: 'पूरा', lang: 'भाषा', notes: 'पहुँच नोट्स', revisit: 'मुफ़्त दोबारा विज़िट', stepHelp: ['निकलते समय शुरू दबाएँ', 'काम करें, चेकलिस्ट टिक करें, फिर फ़ोटो लें', 'फ़ोटो पर GPS और समय की मुहर लगती है', 'पूरा — अगला स्टॉप!'] },
  ur: { route: 'روٹ', history: 'تاریخ', account: 'اکاؤنٹ', today: 'آج کا روٹ', done: 'مکمل', pickups: 'اسٹاپ', none: 'آج کوئی اسٹاپ نہیں۔', start: 'کام شروع کریں', photo: 'ثبوت کی تصویر لیں', nopick: 'پک اپ نہیں ہوا',
    navigate: 'راستہ', call: 'کال کریں', arrived: 'میں پہنچ گیا', checklist: 'چیک لسٹ — ہر آئٹم پر نشان لگائیں', why: 'پک اپ کیوں نہیں ہوا؟', CLOSED: 'دکان بند', NO_ACCESS: 'رسائی نہیں', NO_WASTE: 'کچرا نہیں', CUSTOMER_REFUSED: 'گاہک نے انکار کیا',
    left: 'باقی', closes: 'بند ہو گا', missed: 'وقت گزر گیا', opens: 'کھلے گا', waitingGps: 'GPS کا انتظار…', capture: 'تصویر لیں', retake: 'دوبارہ', use: 'یہ تصویر بھیجیں', rejected: 'تصویر مسترد', completed: 'مکمل', reported: 'رپورٹ ہو گئی', saved: 'محفوظ — بعد میں بھیجیں گے',
    camBlocked: 'کیمرے کی اجازت ضروری ہے۔ گیلری کی تصویر قبول نہیں۔', sAccepted: 'کام شروع', sInProgress: 'سائٹ پر', sPhoto: 'ثبوت کی تصویر', sDone: 'مکمل', lang: 'زبان', notes: 'رسائی نوٹس', revisit: 'مفت دوبارہ وزٹ', stepHelp: ['روانگی پر شروع دبائیں', 'کام کریں، چیک لسٹ، پھر تصویر', 'تصویر پر GPS اور وقت کی مہر', 'مکمل — اگلا اسٹاپ!'] },
  ar: { route: 'المسار', history: 'السجل', account: 'الحساب', today: 'مسار اليوم', done: 'مكتمل', pickups: 'المحطات', none: 'لا توجد محطات اليوم.', start: 'ابدأ المهمة', photo: 'التقط صورة الإثبات', nopick: 'لم يتم الاستلام',
    navigate: 'الملاحة', call: 'اتصال', arrived: 'وصلت', checklist: 'قائمة التحقق — أكمل كل البنود', why: 'لماذا لم يتم الاستلام؟', CLOSED: 'الموقع مغلق', NO_ACCESS: 'لا يمكن الدخول', NO_WASTE: 'لا توجد نفايات', CUSTOMER_REFUSED: 'رفض العميل',
    left: 'متبقٍ', closes: 'يغلق خلال', missed: 'فات الموعد', opens: 'يفتح', waitingGps: 'بانتظار GPS…', capture: 'التقاط', retake: 'إعادة', use: 'استخدم الصورة', rejected: 'تم رفض الصورة', completed: 'تم', reported: 'تم الإبلاغ', saved: 'محفوظ — سيُرسل لاحقًا',
    camBlocked: 'يجب السماح بالكاميرا. لا تُقبل الصور من المعرض.', sAccepted: 'بدأت المهمة', sInProgress: 'في الموقع', sPhoto: 'صورة الإثبات', sDone: 'مكتمل', lang: 'اللغة', notes: 'ملاحظات الدخول', revisit: 'زيارة مجانية', stepHelp: ['اضغط ابدأ عند الانطلاق', 'نفّذ المهمة ثم قائمة التحقق ثم الصورة', 'الصورة مختومة بالموقع والوقت', 'تم — المحطة التالية!'] },
};
let LANG = localStorage.getItem('gl_drv_lang') || 'en';
const t = k => (TR[LANG] && TR[LANG][k]) || TR.en[k] || k;
function applyLang() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = ['ur', 'ar'].includes(LANG) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
}
function setLang(l) { LANG = l; localStorage.setItem('gl_drv_lang', l); applyLang(); if (activeTab === 'account') renderAccount(); if (activeTab === 'vehicle') renderVehicle(); }

Object.assign(IC, {
  nav: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M20 13h-4M4 13h4M10 4l1 2M14 4l-1 2"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shutter: '<circle cx="12" cy="12" r="9"/>',
});

// ── jobs (with time windows, service type, checklist, maps link) ──
let clockOffsetMs = 0; // server − device, for countdown display only
async function loadJobs() {
  try {
    const res = await fetch(API + '/driver/jobs-v3', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return logout();
    const data = await res.json();
    jobs = data.jobs;
    clockOffsetMs = Date.parse(data.server_now) - Date.now();
  } catch { jobs = jobs.length ? jobs : JSON.parse(localStorage.getItem('gl_drv_jobs') || '[]'); }
  applyQueue();
  saveJobs();
}
function saveJobs() { try { localStorage.setItem('gl_drv_jobs', JSON.stringify(jobs.map(j => ({ ...j, arrival_local: undefined })))); } catch { /* storage full: the server copy is the record */ } }
// Steps saved offline have not reached the server yet; show them as done on this phone.
function applyQueue() {
  for (const p of getQueue()) {
    const j = jobs.find(x => x.id === p.pickupId); if (!j) continue;
    if (p.kind === 'arrive' && !j.arrived_at) { j.arrived_at = p.photo_taken_at; j.started_at = j.started_at || p.photo_taken_at; j.arrival_local = p.photo; j.pending_sync = true; }
    if (p.kind === 'finish') { j.status = 'collected'; j.stage = 'completed'; j.pending_sync = true; }
    if (p.kind === 'issue' || p.kind === 'cancel') { j.status = 'canceled'; j.confirmation_status = 'awaiting'; j.pending_sync = true; }
  }
}
const serverNow = () => Date.now() + clockOffsetMs;
// 754 → "12:34", 4000 → "1:06:40"
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(x).padStart(2, '0');
}
const hhmm = iso => { const d = new Date(iso); return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
// every element with data-since="<ISO time>" is a running timer
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach(el => { const t0 = Date.parse(el.dataset.since); if (isFinite(t0)) el.textContent = fmtDur((serverNow() - t0) / 1000); });
}, 1000);
const timer = iso => `<b class="tmr" data-since="${esc(iso)}">${fmtDur((serverNow() - Date.parse(iso)) / 1000)}</b>`;

// time-window countdown (DRV-11)
function windowState(j) {
  if (!j.time_window || ['collected', 'canceled'].includes(j.status)) return null;
  const now = new Date(Date.now() + clockOffsetMs);
  const [s, e] = j.time_window.split('-');
  const at = hm => { const d = new Date(now); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d; };
  const start = at(s), end = at(e);
  const mins = Math.round((end - now) / 60000);
  const fmt = m => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  if (now < start) return { cls: 'future', text: `${t('opens')} ${s}`, mins };
  if (mins < 0) return { cls: 'missed', text: t('missed'), mins };
  if (mins <= 30) return { cls: 'risk', text: `${t('closes')} ${fmt(mins)}`, mins };
  return { cls: 'ok', text: `${fmt(mins)} ${t('left')}`, mins };
}
function windowChip(j) {
  const w = windowState(j);
  if (!w) return j.time_window ? `<span class="win">${svg(IC.clock, 12)} ${esc(j.time_window)}</span>` : '';
  return `<span class="win ${w.cls}">${svg(IC.clock, 12)} ${esc(j.time_window)} · ${w.text}</span>`;
}

// stop model: 0 not started · 1 started, on the way · 2 arrived (GPS photo accepted) · 3 sending · 4 finished · -1 issue reported
function jobSteps(j) {
  if (j.status === 'collected') return 4;
  if (j.status === 'canceled') return -1;
  if (j.arrived_at) return 2;
  if (j.started_at || j.stage === 'acknowledged' || j.stage === 'arrived') return 1;
  return 0;
}
const stepLabels = () => [t('sStart'), t('sArrive'), t('sReport'), t('sDone')];

function ministeps(j) {
  const s = jobSteps(j);
  if (s === -1) return `<div class="ministeps"><span class="ms bad">${svg(IC.x, 12)}</span><span class="ln"></span><span class="ms bad">${svg(IC.ban, 12)}</span></div>`;
  return `<div class="ministeps">${[0, 1, 2, 3].map(i =>
    `<span class="ms ${i < s ? 'done' : ''}">${i < s ? svg(IC.check, 12) : i + 1}</span>${i < 3 ? `<span class="ln ${i < s - 1 ? 'done' : ''}"></span>` : ''}`).join('')}</div>`;
}
function chip(j) {
  if (j.status === 'collected') return `<span class="chip collected">${svg(IC.check, 11)} Done</span>`;
  if (j.status === 'canceled') return `<span class="chip canceled">${svg(IC.x, 11)} ${j.confirmation_status === 'awaiting' ? 'Awaiting' : 'No pickup'}</span>`;
  if (j.status === 'overdue') return `<span class="chip overdue">${svg(IC.clock, 11)} Overdue</span>`;
  if (jobSteps(j) === 2) return `<span class="chip progress">${svg(IC.pin, 11)} ${t('onSite')}</span>`;
  if (jobSteps(j) === 1) return `<span class="chip progress">${svg(IC.nav, 11)} ${t('onWay')}</span>`;
  return `<span class="chip pending">${svg(IC.clock, 11)} Waiting</span>`;
}
const catPill = j => `<span class="cat ${j.category || 'waste'}">${svg(j.category === 'pest' ? IC.bug : IC.truck, 11)} ${esc(j.service_name || j.service_type || 'Waste')}</span>`;

function renderHome() {
  const done = jobs.filter(j => ['collected', 'canceled'].includes(j.status)).length;
  const pct = jobs.length ? Math.round(100 * done / jobs.length) : 0;
  const risk = jobs.filter(j => (windowState(j) || {}).cls === 'risk' && jobSteps(j) === 0).length;
  $('#v-home').innerHTML = `
    ${typeof shiftCard === 'function' ? shiftCard() : ''}
    <div class="sumcard">
      <div class="sumtop"><span class="sumtitle">${svg(IC.calendar, 16)} ${t('today')}</span>
      <span class="sumcount">${done} / ${jobs.length} ${t('done')}</span></div>
      <div class="progressbar"><i style="width:${pct}%"></i></div>
      ${risk ? `<div class="riskbar">${svg(IC.alert, 15)} ${risk} stop${risk > 1 ? 's' : ''} at risk — window closes within 30 min</div>` : ''}
    </div>
    <div class="h-sec">${t('pickups')}${driver?.vehicle ? ` · ${esc(driver.vehicle.fleet_number)}` : ''}</div>
    ${jobs.map((j, i) => {
      const w = windowState(j);
      return `
      <button class="job-card ${w && w.cls === 'risk' && jobSteps(j) === 0 ? 'atrisk' : ''}" onclick="openJob(${j.id})" ${['collected', 'canceled'].includes(j.status) ? 'disabled' : ''}>
        <div class="jc-top">
          <span class="jc-num">${j.seq || i + 1}</span>
          <span class="jc-name">${esc(j.name)}<small>${esc(j.branch || '')} · ${esc(j.zone)}</small></span>
          ${chip(j)}
        </div>
        <div class="jc-tags">${catPill(j)} ${windowChip(j)} ${j.is_revisit ? `<span class="cat">${t('revisit')}</span>` : ''}</div>
        ${ministeps(j)}
      </button>`;
    }).join('') || `<div class="empty">${t('none')}</div>`}`;
}
setInterval(() => { if (activeTab === 'home' && token && $('#s-job').classList.contains('hidden') && $('#s-cam').classList.contains('hidden') && !document.querySelector('.sheet-wrap')) renderHome(); }, 30_000);

// ── JOB DETAIL ───────────────────────────────────────────────
let checks = {};
function openJob(id) {
  currentJob = jobs.find(j => j.id === id);
  if (!currentJob) return;
  checks = {};
  const j = currentJob;
  $('#job-name').textContent = j.name;
  $('#job-meta').innerHTML = `<b>${esc(j.name)}</b>
    <span>${svg(IC.pin, 13)} ${esc(j.branch || '')} · ${esc(j.zone)}</span>
    <span>${esc(j.address || '')}</span>
    <div class="jc-tags">${catPill(j)} ${windowChip(j)}</div>
    ${j.access_notes ? `<div class="notes"><span>${t('notes')}</span>${esc(j.access_notes)}</div>` : ''}
    <div class="quick">
      ${j.maps_url ? `<a class="qbtn nav" href="${esc(j.maps_url)}" target="_blank" rel="noopener">${svg(IC.nav, 18)} ${t('navigate')}</a>` : ''}
      ${j.contact_phone ? `<a class="qbtn" href="tel:${esc(j.contact_phone)}">${svg(IC.phone, 18)} ${t('call')}</a>` : ''}
    </div>`;
  renderJobDetail();
  $('#s-job').classList.remove('hidden');
}
function closeJob() { $('#s-job').classList.add('hidden'); renderHome(); }

function renderJobDetail(forceStep) {
  const j = currentJob;
  const s = forceStep !== undefined ? forceStep : jobSteps(j);
  const help = t('stepHelp');
  $('#stepper').innerHTML = stepLabels().map((lbl, i) => {
    // steps: 0 start · 1 arrive · 2 report · 3 done.  "sending" (s = 3) stays on Report.
    const done = s === 4 || i < Math.min(s, 2), active = s < 4 && i === Math.min(s, 2);
    return `<div class="step ${done ? 'done' : ''} ${active ? 'active' : ''}">
      <div class="rail"><div class="bub">${done ? svg(IC.check, 15) : i + 1}</div><div class="vline"></div></div>
      <div class="stext"><div class="stitle">${lbl}</div><div class="ssub">${help[i]}</div></div></div>`;
  }).join('');
  const A = $('#job-actions');
  const list = j.checklist || [];
  const needChecks = list.length && j.category === 'pest';
  const allTicked = list.every((_, i) => checks[i]);
  if (s === 0) {
    // a job can only start inside a shift
    A.innerHTML = (typeof onShift === 'function' && !onShift())
      ? `<p class="flow-hint">${svg(IC.clock, 16)} ${t('clockInFirst')}</p><button class="giant teal" onclick="clockIn()">${svg(IC.clock)}<span>${t('clockIn')}</span></button>`
      : `<button class="giant teal" onclick="ackJob()">${svg(IC.play)}<span>${t('start')}</span></button>`;
  } else if (s === 1) {
    A.innerHTML = `
      <div class="jobtimer">${svg(IC.nav, 18)}<span>${t('onWay')}</span>${j.started_at ? timer(j.started_at) : ''}</div>
      ${j.maps_url ? `<a class="giant blue" href="${esc(j.maps_url)}" target="_blank" rel="noopener">${svg(IC.nav)}<span>${t('navigate').toUpperCase()}</span></a>` : ''}
      <button class="giant green" onclick="openCamera('arrive')">${svg(IC.camera)}<span>${t('arrivePhoto')}</span><small>${t('arriveSub')}</small></button>
      <button class="giant red" onclick="showReasons()">${svg(IC.ban)}<span>${t('nopick')}</span></button>`;
  } else if (s === 2) {
    const pic = j.arrival_local || j.arrival_photo_url;
    A.innerHTML = `
      <div class="arrival">${pic ? `<img src="${esc(pic)}" alt="">` : ''}
        <div><b>${svg(IC.checkCircle, 16)} ${t('arrivedAt')} ${hhmm(j.arrived_at)}</b>
          <span>${j.arrival_distance_m != null ? `${j.arrival_distance_m} ${t('fromSite')}` : ''}${j.pending_sync ? ` ${t('savedOffline')}` : ''}</span>
          <span class="jobtimer inline">${t('onSite')} ${timer(j.arrived_at)}</span></div></div>
      ${list.length ? `<div class="checklist"><div class="cl-head">${svg(IC.check, 15)} ${t('checklist')}${needChecks ? '' : ' <small>(optional)</small>'}</div>
        ${list.map((c, i) => `<button class="cl-item ${checks[i] ? 'on' : ''}" onclick="toggleCheck(${i})"><span class="box">${checks[i] ? svg(IC.check, 16) : ''}</span>${esc(c)}</button>`).join('')}</div>` : ''}
      <button class="giant green" ${needChecks && !allTicked ? 'disabled' : ''} onclick="finishJob()">${needChecks && !allTicked ? svg(IC.lock) : svg(IC.checkCircle)}<span>${t('finish')}</span></button>
      <button class="giant red" onclick="showReasons()">${svg(IC.ban)}<span>${t('issue')}</span></button>`;
  } else if (s === 3) {
    A.innerHTML = `<button class="giant teal" disabled>${svg(IC.upload)}<span>${t('sending')}</span></button>`;
  } else A.innerHTML = '';
}
function toggleCheck(i) { checks[i] = !checks[i]; renderJobDetail(); }

// STEP 1 · Start job: the job timer starts, the customer is told the driver is on the way
async function ackJob() {
  if (!currentJob) return;
  if (typeof onShift === 'function' && !onShift()) return glToast(t('clockInFirst'), 'error');
  currentJob.stage = 'acknowledged';
  currentJob.started_at = new Date(serverNow()).toISOString();
  saveJobs();
  renderJobDetail();
  try { await fetch(`${API}/pickups/${currentJob.id}/ack`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch { /* offline: the arrival photo also starts the job on the server */ }
}

// STEP 3 · Report: finished. Uses the arrival photo as the proof, so no second photo.
async function finishJob() {
  const j = currentJob; if (!j) return;
  const checklist = (j.checklist || []).filter((_, i) => checks[i]);
  renderJobDetail(3);
  const r = await sendOrQueue({ kind: 'finish', pickupId: j.id, checklist });
  if (r.status === 'rejected') { renderJobDetail(); return flashMsg(false, t('notSent'), r.problems.join('\n'), false); }
  j.status = 'collected'; j.stage = 'completed'; j.completed_at = new Date(serverNow()).toISOString();
  saveJobs();
  renderJobDetail(4);
  if (typeof loadShift === 'function') loadShift();   // refreshes the time-on-jobs total
  pushNotif('ok', 'Job completed', `${j.name} — ${r.status === 'ok' ? 'sent to office' : 'saved, will send automatically'}`, true);
  flashMsg(true, r.status === 'ok' ? t('completed') : t('saved'));
}

// STEP 3 · Report: an issue. Reason only; the arrival photo already shows the site.
let npuReason = null;
function showReasons() {
  const arrived = currentJob && jobSteps(currentJob) === 2;
  $('#reasons-body').innerHTML = ['CLOSED', 'NO_ACCESS', 'NO_WASTE', 'CUSTOMER_REFUSED'].map(r =>
    `<button class="reason" onclick="${arrived ? 'reportIssue' : 'pickReason'}('${r}')">${svg(IC.ban, 26)}<span>${t(r)}</span></button>`).join('') +
    `<p class="reason-note">${svg(IC.camera, 14)} ${arrived ? t('usesArrival') : 'A live photo of the site is required. The customer is asked to confirm within 24 h.'}</p>`;
  $('#reasons-title').textContent = t('why');
  $('#s-reasons').classList.remove('hidden');
}
function hideReasons() { $('#s-reasons').classList.add('hidden'); }
// Not picked up without an arrival photo (as before v3.3): reason, then a live GPS photo
function pickReason(r) { npuReason = r; hideReasons(); openCamera('npu'); }
async function reportIssue(reason) {
  const j = currentJob; if (!j) return;
  hideReasons();
  renderJobDetail(3);
  const r = await sendOrQueue({ kind: 'issue', pickupId: j.id, reason });
  if (r.status === 'rejected') { renderJobDetail(); return flashMsg(false, t('notSent'), r.problems.join('\n'), false); }
  j.status = 'canceled'; j.confirmation_status = 'awaiting';
  saveJobs();
  if (typeof loadShift === 'function') loadShift();
  pushNotif('bad', 'Issue reported', `${j.name} — ${t(reason)}`, true);
  flashMsg(false, r.status === 'ok' ? t('reported') : t('saved'));
}

// ── LIVE CAMERA + ON-DEVICE STAMP (DRV-06) ───────────────────
// No file input / gallery: getUserMedia only. Each frame is stamped with
// date, time, GPS and the customer name before it leaves the phone.
const cam = { stream: null, watch: null, fix: null, mode: null, shot: null };
async function openCamera(mode) {
  cam.mode = mode; cam.shot = null; cam.fix = null;
  $('#s-cam').classList.remove('hidden');
  $('#cam-review').classList.add('hidden');
  $('#cam-live').classList.remove('hidden');
  $('#cam-title').textContent = mode === 'npu' ? `${t('nopick')} · ${t(npuReason)}` : t('camArrive');
  updateCamStatus();
  if (navigator.geolocation) {
    cam.watch = navigator.geolocation.watchPosition(p => { cam.fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }; updateCamStatus(); },
      () => updateCamStatus(), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false });
    $('#cam-video').srcObject = cam.stream;
    await $('#cam-video').play().catch(() => {});
  } catch {
    $('#cam-status').innerHTML = `<span class="bad">${t('camBlocked')}</span>`;
    $('#cam-shutter').disabled = true;
  }
}
function updateCamStatus() {
  const f = cam.fix;
  $('#cam-status').innerHTML = f ? `${svg(IC.pin, 14)} ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)} · ±${f.acc} m` : `<span class="warn">${svg(IC.pin, 14)} ${t('waitingGps')}</span>`;
  $('#cam-shutter').disabled = !f || !cam.stream;
}
function closeCamera() {
  if (cam.stream) cam.stream.getTracks().forEach(tr => tr.stop());
  if (cam.watch != null) navigator.geolocation.clearWatch(cam.watch);
  cam.stream = null; cam.watch = null;
  $('#s-cam').classList.add('hidden');
}
function pad(n) { return String(n).padStart(2, '0'); }
function capture() {
  const v = $('#cam-video'), f = cam.fix, j = currentJob;
  if (!v.videoWidth || !f || !j) return;
  const W = Math.min(1600, v.videoWidth), H = Math.round(v.videoHeight * W / v.videoWidth);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(v, 0, 0, W, H);
  const now = new Date();
  const when = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const lines = [`${j.name}${j.branch ? ' — ' + j.branch : ''}`, `${when}  ·  GPS ${f.lat.toFixed(6)}, ${f.lng.toFixed(6)} (±${f.acc} m)`,
    `GreenLoop · ${cam.mode === 'npu' ? 'NOT PICKED UP: ' + npuReason.replace(/_/g, ' ') : 'Arrived on site · ' + (j.service_name || 'Service')} · job #${j.id}`];
  const fs = Math.max(16, Math.round(W / 42)), band = fs * 1.55 * lines.length + fs;
  g.fillStyle = 'rgba(4,34,29,.72)'; g.fillRect(0, H - band, W, band);
  g.fillStyle = '#2dd4bf'; g.fillRect(0, H - band, 6, band);
  g.fillStyle = '#fff'; g.textBaseline = 'top';
  lines.forEach((l, i) => { g.font = `${i === 0 ? 700 : 500} ${fs}px system-ui, sans-serif`; g.fillText(l, fs, H - band + fs * 0.5 + i * fs * 1.55); });
  cam.shot = { photo: c.toDataURL('image/jpeg', 0.82), lat: f.lat, lng: f.lng, photo_taken_at: now.toISOString(), stamp_text: lines.join(' | ') };
  $('#cam-img').src = cam.shot.photo;
  $('#cam-live').classList.add('hidden');
  $('#cam-review').classList.remove('hidden');
}
function retake() { cam.shot = null; $('#cam-review').classList.add('hidden'); $('#cam-live').classList.remove('hidden'); }
// STEP 2 · Arrival: the GPS-stamped photo goes to the office, which checks it against the site.
async function usePhoto() {
  const shot = cam.shot, j = currentJob, mode = cam.mode;
  if (!shot || !j) return;
  closeCamera();
  renderJobDetail(3);
  const r = await sendOrQueue(mode === 'npu' ? { kind: 'cancel', pickupId: j.id, reason: npuReason, ...shot } : { kind: 'arrive', pickupId: j.id, ...shot });
  if (r.status === 'rejected') {
    renderJobDetail();
    pushNotif('bad', 'Photo rejected', `${j.name}: ${r.problems.join('; ')}. Office notified — retake at the site.`);
    return flashMsg(false, t('rejected'), r.problems.join('\n'), false);
  }
  if (mode === 'npu') {
    j.status = 'canceled'; j.confirmation_status = 'awaiting';
    saveJobs();
    if (typeof loadShift === 'function') loadShift();
    pushNotif('bad', 'Not picked up reported', `${j.name} — ${t(npuReason)}`, true);
    return flashMsg(false, r.status === 'ok' ? t('reported') : t('saved'));
  }
  j.stage = 'arrived';
  j.arrived_at = shot.photo_taken_at; j.started_at = j.started_at || shot.photo_taken_at;
  j.arrival_local = shot.photo;
  if (r.data && r.data.distance_m != null) j.arrival_distance_m = r.data.distance_m;
  if (r.status === 'queued') j.pending_sync = true;
  saveJobs();
  renderJobDetail();
  glToast(r.status === 'ok' ? t('arrivalSaved') : t('saved'), 'success');
}

function flashMsg(good, msg, detail = '', close = true) {
  const el = document.createElement('div');
  el.className = 'done-flash ' + (good ? 'ok' : 'bad');
  el.innerHTML = `${svg(good ? IC.checkCircle : IC.xCircle, 96)}<span>${esc(msg)}</span>${detail ? `<small>${esc(detail)}</small>` : ''}`;
  document.body.appendChild(el);
  setTimeout(() => { el.remove(); if (close) closeJob(); }, detail ? 3200 : 1300);
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
    `${new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })} · ${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  $('#v-history').innerHTML = `
    <div class="h-sec">${t('history')}</div>
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
      <div class="acct-sub">Driver since ${(me.since || '').slice(8, 10)}/${(me.since || '').slice(5, 7)}/${(me.since || '').slice(0, 4)}</div>
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
    <div class="h-sec">${svg(IC.globe, 13)} ${t('lang')}</div>
    <div class="langs">${Object.entries(LANGS).map(([k, v]) => `<button class="${LANG === k ? 'on' : ''}" onclick="setLang('${k}')">${v}</button>`).join('')}</div>
    <div class="h-sec">${svg(IC.bell, 13)} Notifications</div>
    <div class="inforow" id="push-row">${pushRowHtml()}</div>
    <button class="logoutbtn" onclick="logout()">${svg(IC.logout, 18)} Sign out</button>`;
}

// notifications status on this phone (Account tab)
function pushRowHtml() {
  const st = window.GLPush ? window.GLPush.state() : 'unsupported';
  const txt = { granted: 'On for this phone', default: 'Off — tap to turn on', denied: 'Blocked — allow in phone settings', 'ios-install': 'Add to Home Screen first', unsupported: 'Not supported in this browser' }[st];
  return `${svg(IC.bell, 20)}<div style="flex:1"><span class="lbl">Route changes · at-risk stops · vehicle reports</span><b>${txt}</b></div>
    ${st === 'default' || st === 'ios-install' ? `<button class="minibtn" onclick="pushTurnOn()">Turn on</button>` : st === 'granted' ? `<button class="minibtn" onclick="window.GLPush.test()">Test</button>` : ''}`;
}
async function pushTurnOn() { await window.GLPush.enable(); const r = $('#push-row'); if (r) r.innerHTML = pushRowHtml(); }
document.addEventListener('glpush:change', () => { const r = $('#push-row'); if (r) r.innerHTML = pushRowHtml(); });

// ── network layer with offline queue ────────────────────────
function dataUrlToBlob(u) {
  const [meta, b64] = u.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
// One step of a stop, sent to the office.
//   arrive  the GPS-stamped photo (multipart)      finish / issue  the report (JSON)
//   clockin / clockout  the shift                  complete / cancel  steps queued by an older app version
// returns {status:'ok', data} | {status:'rejected', problems} ; throws on network/5xx (→ stays queued)
async function transmit(p, queued = false) {
  const headers = { Authorization: 'Bearer ' + token };
  let url, body;
  if (p.kind === 'clockin' || p.kind === 'clockout') {
    url = `${API}/driver/shift/${p.kind === 'clockin' ? 'clock-in' : 'clock-out'}`;
    headers['Content-Type'] = 'application/json'; body = JSON.stringify({ lat: p.lat, lng: p.lng });
  } else if (p.kind === 'finish' || p.kind === 'issue') {
    url = `${API}/pickups/${p.pickupId}/${p.kind}`;
    headers['Content-Type'] = 'application/json'; body = JSON.stringify(p.kind === 'finish' ? { checklist: p.checklist || [] } : { reason: p.reason });
  } else {
    const fd = new FormData();
    fd.append('photo', dataUrlToBlob(p.photo), 'proof.jpg');
    fd.append('lat', p.lat ?? ''); fd.append('lng', p.lng ?? '');
    fd.append('photo_taken_at', p.photo_taken_at);
    fd.append('device_now', new Date().toISOString()); // checked against server clock (±5 min)
    fd.append('stamped', '1'); fd.append('stamp_text', p.stamp_text || ''); fd.append('source', 'camera');
    if (queued) fd.append('queued', '1');   // sent later from the offline queue → office reviews instead of rejecting
    if (p.kind === 'complete') fd.append('checklist', JSON.stringify(p.checklist || []));
    if (p.kind === 'cancel') fd.append('reason', p.reason);
    url = `${API}/pickups/${p.pickupId}/${p.kind === 'arrive' ? 'arrive-proof' : p.kind === 'complete' ? 'complete' : 'cancel'}`;
    body = fd;
  }
  const res = await fetch(url, { method: 'POST', headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { status: 'ok', data };
  if (res.status === 409 && data.code !== 'NOT_ARRIVED') return { status: 'ok', data };   // already done on the server
  if (res.status === 429) throw new Error('rate limited');   // keep it queued, retry later
  if ([400, 403, 404, 409, 422].includes(res.status)) return { status: 'rejected', problems: data.problems || [data.error || 'Rejected by server'] };
  throw new Error('HTTP ' + res.status);
}

function getQueue() { return JSON.parse(localStorage.getItem('gl_queue') || '[]'); }
function setQueue(q) {
  try { localStorage.setItem('gl_queue', JSON.stringify(q)); } catch { pushNotif('bad', 'Storage full', 'Could not save offline — reconnect to send.'); }
  $('#sync-banner').classList.toggle('hidden', q.length === 0);
  $('#sync-count').textContent = q.length;
}
async function sendOrQueue(payload) {
  // steps of one stop must reach the office in order: wait behind anything already queued for it
  if (payload.pickupId && getQueue().some(x => x.pickupId === payload.pickupId)) { setQueue([...getQueue(), payload]); return { status: 'queued' }; }
  try { return await transmit(payload); }
  catch { setQueue([...getQueue(), payload]); return { status: 'queued' }; }
}
let flushing = false;
async function flushQueue() {
  const q = getQueue();
  if (!q.length || !token || flushing) return;
  flushing = true;
  const remaining = [], held = new Set(), failed = new Set();
  try {
    for (const p of q) {
      const key = p.pickupId || p.kind;
      if (held.has(key)) { remaining.push(p); continue; }      // an earlier step of this stop is still waiting
      if (failed.has(key)) continue;                           // its arrival photo was rejected: the report cannot stand
      try {
        const r = await transmit(p, true);
        if (r.status === 'rejected') {
          failed.add(key);
          if (p.pickupId) pushNotif('bad', 'Saved step rejected', `Job #${p.pickupId}: ${r.problems.join('; ')}`);
        }
      } catch { remaining.push(p); held.add(key); }
    }
  } finally { flushing = false; }
  // v3.4.4: keep steps the driver saved while this send was running (they were being dropped)
  const added = getQueue().slice(q.length);
  remaining.push(...added);
  setQueue(remaining);
  if (!remaining.length && q.length) { pushNotif('ok', 'Back online', 'Everything saved on this phone was sent to the office.'); if (token) loadJobs().then(() => { if (activeTab === 'home') renderHome(); }); }
}
setInterval(flushQueue, 60_000);
window.addEventListener('online', () => { $('#hdr-live')?.classList.remove('off'); flushQueue(); });
window.addEventListener('offline', () => $('#hdr-live')?.classList.add('off'));

document.addEventListener('click', e => {
  const p = $('#notif-panel');
  if (!p.classList.contains('hidden') && !p.contains(e.target) && !e.target.closest('.bell')) p.classList.add('hidden');
});

// ── boot ─────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
$('#login-date').textContent = fmtDate(new Date());
applyLang();
setQueue(getQueue());
// a tapped notification (e.g. vehicle report answered) opens the right tab
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
  if (e.data && e.data.type === 'gl-open' && token && driver) switchTab(String(e.data.url).includes('#vehicle') ? 'vehicle' : 'home');
});
if (token && driver) enterApp().then(() => { if (location.hash === '#vehicle') switchTab('vehicle'); });
