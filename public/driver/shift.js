// ─────────────────────────────────────────────────────────────
// GreenLoop Driver v3.3 — shift clock
// Clock in starts the shift timer; jobs can only be started inside a shift.
// Clock out ends it and shows the day's totals. The office sees the same times.
// Loaded after app.js (uses $, esc, svg, IC, t, TR, token, API, glToast, fmtDur, timer…).
// ─────────────────────────────────────────────────────────────
Object.assign(IC, {
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
});
Object.assign(TR.en, {
  clockIn: 'CLOCK IN', clockOut: 'Clock out', shiftOff: 'Clock in to start your shift', shiftOffSub: 'Your shift time and each job are timed from here.',
  onShift: 'On shift', since: 'since', clockInFirst: 'Clock in before you start a job', clockedIn: 'Clocked in. Have a safe shift.', clockedOut: 'Clocked out',
  onWay: 'On the way', onSite: 'On site', arrivePhoto: "I'VE ARRIVED", arriveSub: 'Take the GPS photo', camArrive: 'Arrival photo', arrivedAt: 'Arrived', fromSite: 'm from the site',
  finish: 'FINISH JOB', issue: 'REPORT ISSUE', usesArrival: 'Your arrival photo is sent with this report. The customer is asked to confirm within 24 h.',
  arrivalSaved: 'Arrival recorded', savedOffline: '(saved on phone)', sending: 'SENDING…', notSent: 'NOT SENT', why: 'What is the problem?',
  clockOutQ: 'Clock out now?', shiftLen: 'Shift', stopsDone: 'Stops done', stopsLeft: 'Stops not done', jobTime: 'Time on jobs', jobOpen: 'A job is still in progress. Finish it or report an issue first.',
  back: 'Back', stopsToday: 'stops today',
  sStart: 'Start job', sArrive: 'Arrive', sReport: 'Finish or report', sDone: 'Completed',
  stepHelp: ['Tap Start when you set off. Navigation opens from here.', 'At the site, take one photo. GPS and time are stamped on it.', 'Finish the job, or report a problem such as a closed site.', 'Done. On to the next stop.'],
});
Object.assign(TR.hi, {
  clockIn: 'शिफ़्ट शुरू करें', clockOut: 'शिफ़्ट खत्म करें', shiftOff: 'शिफ़्ट शुरू करने के लिए क्लॉक-इन करें', shiftOffSub: 'शिफ़्ट और हर काम का समय यहीं से गिना जाता है।',
  onShift: 'शिफ़्ट चालू', since: 'से', clockInFirst: 'काम शुरू करने से पहले क्लॉक-इन करें', clockedIn: 'क्लॉक-इन हो गया। सुरक्षित रहें।', clockedOut: 'क्लॉक-आउट हो गया',
  onWay: 'रास्ते में', onSite: 'साइट पर', arrivePhoto: 'मैं पहुँच गया', arriveSub: 'GPS फ़ोटो लें', camArrive: 'पहुँचने की फ़ोटो', arrivedAt: 'पहुँचे', fromSite: 'मीटर साइट से',
  finish: 'काम पूरा', issue: 'समस्या बताएँ', usesArrival: 'पहुँचने की फ़ोटो इस रिपोर्ट के साथ जाएगी। ग्राहक 24 घंटे में पुष्टि करेगा।',
  arrivalSaved: 'पहुँचना दर्ज हुआ', savedOffline: '(फ़ोन में सेव)', sending: 'भेज रहे हैं…', notSent: 'नहीं भेजा गया', why: 'क्या समस्या है?',
  clockOutQ: 'अभी क्लॉक-आउट करें?', shiftLen: 'शिफ़्ट', stopsDone: 'पूरे स्टॉप', stopsLeft: 'बचे स्टॉप', jobTime: 'काम का समय', jobOpen: 'एक काम अभी चल रहा है। पहले उसे पूरा करें या समस्या बताएँ।',
  back: 'वापस', stopsToday: 'स्टॉप आज',
  sStart: 'काम शुरू', sArrive: 'पहुँचें', sReport: 'पूरा करें या रिपोर्ट', sDone: 'पूरा',
  stepHelp: ['निकलते समय शुरू दबाएँ। नेविगेशन यहीं से खुलेगा।', 'साइट पर एक फ़ोटो लें। उस पर GPS और समय की मुहर लगती है।', 'काम पूरा करें, या बंद साइट जैसी समस्या बताएँ।', 'पूरा। अगला स्टॉप।'],
});
Object.assign(TR.ur, {
  clockIn: 'شفٹ شروع کریں', clockOut: 'شفٹ ختم کریں', shiftOff: 'شفٹ شروع کرنے کے لیے کلاک اِن کریں', shiftOffSub: 'شفٹ اور ہر کام کا وقت یہیں سے گنا جاتا ہے۔',
  onShift: 'شفٹ جاری', since: 'سے', clockInFirst: 'کام شروع کرنے سے پہلے کلاک اِن کریں', clockedIn: 'کلاک اِن ہو گیا۔ محفوظ رہیں۔', clockedOut: 'کلاک آؤٹ ہو گیا',
  onWay: 'راستے میں', onSite: 'سائٹ پر', arrivePhoto: 'میں پہنچ گیا', arriveSub: 'GPS تصویر لیں', camArrive: 'پہنچنے کی تصویر', arrivedAt: 'پہنچے', fromSite: 'میٹر سائٹ سے',
  finish: 'کام مکمل', issue: 'مسئلہ بتائیں', usesArrival: 'پہنچنے کی تصویر اس رپورٹ کے ساتھ جائے گی۔ گاہک 24 گھنٹے میں تصدیق کرے گا۔',
  arrivalSaved: 'پہنچنا درج ہو گیا', savedOffline: '(فون میں محفوظ)', sending: 'بھیج رہے ہیں…', notSent: 'نہیں بھیجا گیا', why: 'کیا مسئلہ ہے؟',
  clockOutQ: 'ابھی کلاک آؤٹ کریں؟', shiftLen: 'شفٹ', stopsDone: 'مکمل اسٹاپ', stopsLeft: 'باقی اسٹاپ', jobTime: 'کام کا وقت', jobOpen: 'ایک کام ابھی جاری ہے۔ پہلے اسے مکمل کریں یا مسئلہ بتائیں۔',
  back: 'واپس', stopsToday: 'اسٹاپ آج',
  sStart: 'کام شروع', sArrive: 'پہنچیں', sReport: 'مکمل کریں یا رپورٹ', sDone: 'مکمل',
  stepHelp: ['روانگی پر شروع دبائیں۔ راستہ یہیں سے کھلے گا۔', 'سائٹ پر ایک تصویر لیں۔ اس پر GPS اور وقت کی مہر لگتی ہے۔', 'کام مکمل کریں، یا بند سائٹ جیسا مسئلہ بتائیں۔', 'مکمل۔ اگلا اسٹاپ۔'],
});
Object.assign(TR.ar, {
  clockIn: 'بدء الوردية', clockOut: 'إنهاء الوردية', shiftOff: 'سجّل الحضور لبدء ورديتك', shiftOffSub: 'يُحسب وقت الوردية وكل مهمة من هنا.',
  onShift: 'في الوردية', since: 'منذ', clockInFirst: 'سجّل الحضور قبل بدء أي مهمة', clockedIn: 'تم تسجيل الحضور. وردية آمنة.', clockedOut: 'تم تسجيل الانصراف',
  onWay: 'في الطريق', onSite: 'في الموقع', arrivePhoto: 'وصلت', arriveSub: 'التقط صورة GPS', camArrive: 'صورة الوصول', arrivedAt: 'الوصول', fromSite: 'م عن الموقع',
  finish: 'إنهاء المهمة', issue: 'الإبلاغ عن مشكلة', usesArrival: 'تُرسل صورة الوصول مع هذا البلاغ. يُطلب من العميل التأكيد خلال 24 ساعة.',
  arrivalSaved: 'تم تسجيل الوصول', savedOffline: '(محفوظ على الهاتف)', sending: 'جارٍ الإرسال…', notSent: 'لم يُرسل', why: 'ما المشكلة؟',
  clockOutQ: 'تسجيل الانصراف الآن؟', shiftLen: 'الوردية', stopsDone: 'محطات منجزة', stopsLeft: 'محطات غير منجزة', jobTime: 'وقت المهام', jobOpen: 'توجد مهمة قيد التنفيذ. أنهِها أو أبلغ عن مشكلة أولاً.',
  back: 'رجوع', stopsToday: 'محطات اليوم',
  sStart: 'بدء المهمة', sArrive: 'الوصول', sReport: 'إنهاء أو بلاغ', sDone: 'مكتمل',
  stepHelp: ['اضغط ابدأ عند الانطلاق. تفتح الملاحة من هنا.', 'في الموقع التقط صورة واحدة. تُختم بالموقع والوقت.', 'أنهِ المهمة، أو أبلغ عن مشكلة مثل موقع مغلق.', 'تم. إلى المحطة التالية.'],
});

let shift = null;        // { clock_in_at, … } while on shift
let shiftDay = null;     // today's totals from the server
const onShift = () => !!shift;

async function loadShift() {
  try {
    const res = await fetch(API + '/driver/shift', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return logout();
    if (!res.ok) return;
    const d = await res.json();
    // a clock-in still waiting in the offline queue counts as on shift on this phone
    const pending = getQueue().find(x => x.kind === 'clockin');
    shift = d.shift || (pending ? { clock_in_at: pending.at, pending: true } : null);
    shiftDay = d.today;
    localStorage.setItem('gl_drv_shift', JSON.stringify(shift));
  } catch { shift = JSON.parse(localStorage.getItem('gl_drv_shift') || 'null'); }
}

// best-effort GPS for the clock-in / clock-out record; never blocks the driver for more than 5 s
function quickFix() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({});
    const done = setTimeout(() => resolve({}), 5000);
    navigator.geolocation.getCurrentPosition(p => { clearTimeout(done); resolve({ lat: p.coords.latitude, lng: p.coords.longitude }); },
      () => { clearTimeout(done); resolve({}); }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 4500 });
  });
}

function shiftCard() {
  const total = jobs.length, done = jobs.filter(j => ['collected', 'canceled'].includes(j.status)).length;
  if (!shift) {
    return `<div class="shiftcard off">
      <div class="sh-text"><b>${t('shiftOff')}</b><span>${total} ${t('stopsToday')}. ${t('shiftOffSub')}</span></div>
      <button class="giant teal" id="btn-clockin" onclick="clockIn()">${svg(IC.clock)}<span>${t('clockIn')}</span></button></div>`;
  }
  return `<div class="shiftcard on">
    <div class="sh-row"><span class="sh-dot"></span><span class="sh-lbl">${t('onShift')} ${t('since')} ${hhmm(shift.clock_in_at)}${shift.pending ? ' ' + t('savedOffline') : ''}</span>
      <button class="minibtn" onclick="askClockOut()">${svg(IC.stop, 13)} ${t('clockOut')}</button></div>
    <div class="sh-time" data-since="${esc(shift.clock_in_at)}">${fmtDur((serverNow() - Date.parse(shift.clock_in_at)) / 1000)}</div>
    <div class="sh-stats"><span><b>${done}/${total}</b> ${t('stopsDone')}</span><span><b>${fmtDur((shiftDay && shiftDay.job_s) || 0)}</b> ${t('jobTime')}</span></div>
  </div>`;
}
function refreshShiftUi() {
  if (activeTab === 'home') renderHome();
  if (currentJob && !$('#s-job').classList.contains('hidden')) renderJobDetail();
}

async function clockIn() {
  if (shift) return;
  const btn = $('#btn-clockin'); if (btn) btn.disabled = true;
  const fix = await quickFix();
  const r = await sendOrQueue({ kind: 'clockin', at: new Date(serverNow()).toISOString(), ...fix });
  if (r.status === 'rejected') { if (btn) btn.disabled = false; return glToast(r.problems.join('; '), 'error'); }
  shift = r.status === 'ok' && r.data.shift ? r.data.shift : { clock_in_at: new Date(serverNow()).toISOString(), pending: true };
  if (r.status === 'ok') shiftDay = r.data.today;
  localStorage.setItem('gl_drv_shift', JSON.stringify(shift));
  glToast(r.status === 'ok' ? t('clockedIn') : t('saved'), 'success');
  if (navigator.vibrate) navigator.vibrate(60);
  refreshShiftUi();
}

// Clock out asks first, and shows what the day came to.
function askClockOut() {
  if (!shift) return;
  const total = jobs.length, done = jobs.filter(j => ['collected', 'canceled'].includes(j.status)).length;
  const busy = jobs.some(j => jobSteps(j) === 1 || jobSteps(j) === 2);
  const el = document.createElement('div');
  el.className = 'sheet-wrap';
  el.innerHTML = `<div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="co-t">
    <h3 id="co-t">${t('clockOutQ')}</h3>
    <dl><dt>${t('shiftLen')}</dt><dd>${fmtDur((serverNow() - Date.parse(shift.clock_in_at)) / 1000)}</dd>
      <dt>${t('stopsDone')}</dt><dd>${done}</dd>
      <dt>${t('stopsLeft')}</dt><dd class="${total - done ? 'warn' : ''}">${total - done}</dd></dl>
    ${busy ? `<p class="sh-warn">${svg(IC.alert, 16)} ${t('jobOpen')}</p>` : ''}
    <button class="wide-btn go" id="co-yes" ${busy ? 'disabled' : ''} onclick="clockOut()">${svg(IC.stop, 18)} ${t('clockOut')}</button>
    <button class="wide-btn ghost" onclick="this.closest('.sheet-wrap').remove()">${t('back')}</button></div>`;
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
}
async function clockOut() {
  const btn = $('#co-yes'); if (btn) btn.disabled = true;
  const fix = await quickFix();
  const r = await sendOrQueue({ kind: 'clockout', ...fix });
  document.querySelector('.sheet-wrap')?.remove();
  if (r.status === 'rejected') return glToast(r.problems.join('; '), 'error');
  const len = fmtDur((serverNow() - Date.parse(shift.clock_in_at)) / 1000);
  shift = null; localStorage.removeItem('gl_drv_shift');
  glToast(`${t('clockedOut')} · ${t('shiftLen')} ${len}`, 'success');
  refreshShiftUi();
}

// the step labels were drawn before these translations were loaded
applyLang();
