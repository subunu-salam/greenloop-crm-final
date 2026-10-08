// ─────────────────────────────────────────────────────────────
// GreenLoop Driver v3.2 — Vehicle tab
// Report a vehicle issue (tyre damage, oil change, service …) in a few taps:
// pick what it is → how urgent → photo → odometer → (if you paid) amount + receipt.
// The office sees it live in CRM → Fleet maintenance, and the driver gets a push
// when it is approved / resolved. Loaded after app.js (uses $, esc, svg, IC, t, token).
// ─────────────────────────────────────────────────────────────
Object.assign(IC, {
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  tire: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/>',
  drop: '<path d="M12 2.7l5.66 5.66a8 8 0 1 1-11.32 0z"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  battery: '<rect x="1" y="6" width="18" height="12" rx="2"/><line x1="23" y1="13" x2="23" y2="11"/><line x1="6" y1="10" x2="6" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/>',
  engine: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  snow: '<line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>',
  dent: '<rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><path d="M5 9l3 2-2 2"/>',
  fuel: '<path d="M3 22V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v18"/><line x1="3" y1="22" x2="14" y2="22"/><line x1="3" y1="10" x2="14" y2="10"/><path d="M14 13h2a2 2 0 0 1 2 2v3a2 2 0 0 0 4 0V9l-3-3"/>',
  dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/>',
});
const VCATS = [
  ['TIRE', 'tire', 'vTire'], ['OIL', 'drop', 'vOil'], ['SERVICE', 'wrench', 'vService'], ['BRAKES', 'disc', 'vBrakes'], ['BATTERY', 'battery', 'vBattery'],
  ['ENGINE', 'engine', 'vEngine'], ['AC', 'snow', 'vAc'], ['BODY', 'dent', 'vBody'], ['FUEL', 'fuel', 'vFuel'], ['OTHER', 'dots', 'vOther'],
];
// translations for the Vehicle tab (falls back to English for any missing key)
Object.assign(TR.en, { vehicle: 'Vehicle', vReport: 'Report a vehicle issue', vMine: 'My reports', vNone: 'No reports yet.', vNoVehicle: 'No vehicle is assigned to you. Ask the office.',
  vTire: 'Tyre damage', vOil: 'Oil change', vService: 'Service due', vBrakes: 'Brakes', vBattery: 'Battery', vEngine: 'Engine / warning light', vAc: 'A/C', vBody: 'Body damage', vFuel: 'Fuel', vOther: 'Other',
  vHow: 'How serious is it?', vCan: 'Can drive', vSoon: 'Fix soon', vCannot: 'CANNOT DRIVE', vPhoto: 'Photo of the problem', vTake: 'Take photo', vOdo: 'Odometer (km)', vPaid: 'I paid for this',
  vAmount: 'Amount paid (AED)', vReceipt: 'Photo of the receipt', vNote: 'Note (optional)', vSend: 'SEND TO OFFICE', vSent: 'REPORT SENT', vNeedPhoto: 'Add a photo of the damage', vNeedReceipt: 'Add a photo of the receipt',
  vOffline: 'No connection — move to signal and try again', vLastOil: 'Last oil change', vLastService: 'Last service', vDue: 'Due', vOverdue: 'OVERDUE',
  sopen: 'Sent', sapproved: 'Approved', sin_progress: 'In progress', sresolved: 'Resolved', srejected: 'Not approved', vCash: 'Cash', vCard: 'Card', vFuelCard: 'Fuel card', vOwed: 'to be reimbursed', vReimbursed: 'reimbursed' });
Object.assign(TR.hi, { vehicle: 'गाड़ी', vReport: 'गाड़ी की समस्या बताएँ', vMine: 'मेरी रिपोर्ट', vNone: 'अभी कोई रिपोर्ट नहीं।', vTire: 'टायर ख़राब', vOil: 'ऑयल चेंज', vService: 'सर्विस', vBrakes: 'ब्रेक', vBattery: 'बैटरी', vEngine: 'इंजन / वार्निंग लाइट', vAc: 'ए.सी.', vBody: 'बॉडी डैमेज', vFuel: 'ईंधन', vOther: 'अन्य',
  vHow: 'कितनी गंभीर है?', vCan: 'चला सकते हैं', vSoon: 'जल्दी ठीक करें', vCannot: 'गाड़ी नहीं चल सकती', vPhoto: 'समस्या की फ़ोटो', vTake: 'फ़ोटो लें', vOdo: 'ओडोमीटर (किमी)', vPaid: 'मैंने पैसे दिए',
  vAmount: 'दी गई रकम (AED)', vReceipt: 'रसीद की फ़ोटो', vNote: 'नोट (वैकल्पिक)', vSend: 'ऑफ़िस को भेजें', vSent: 'रिपोर्ट भेज दी', vNeedPhoto: 'नुकसान की फ़ोटो जोड़ें', vNeedReceipt: 'रसीद की फ़ोटो जोड़ें', vOffline: 'नेटवर्क नहीं — दोबारा कोशिश करें',
  sopen: 'भेजा गया', sapproved: 'मंज़ूर', sin_progress: 'काम जारी', sresolved: 'ठीक हो गया', srejected: 'नामंज़ूर', vCash: 'नकद', vCard: 'कार्ड', vFuelCard: 'फ़्यूल कार्ड' });
Object.assign(TR.ur, { vehicle: 'گاڑی', vReport: 'گاڑی کا مسئلہ بتائیں', vMine: 'میری رپورٹس', vNone: 'ابھی کوئی رپورٹ نہیں۔', vTire: 'ٹائر خراب', vOil: 'آئل چینج', vService: 'سروس', vBrakes: 'بریک', vBattery: 'بیٹری', vEngine: 'انجن / وارننگ لائٹ', vAc: 'اے سی', vBody: 'باڈی کا نقصان', vFuel: 'ایندھن', vOther: 'دیگر',
  vHow: 'کتنا سنگین ہے؟', vCan: 'چلا سکتے ہیں', vSoon: 'جلد ٹھیک کریں', vCannot: 'گاڑی نہیں چل سکتی', vPhoto: 'مسئلے کی تصویر', vTake: 'تصویر لیں', vOdo: 'اوڈومیٹر (کلومیٹر)', vPaid: 'میں نے ادائیگی کی',
  vAmount: 'ادا کی گئی رقم (AED)', vReceipt: 'رسید کی تصویر', vNote: 'نوٹ (اختیاری)', vSend: 'دفتر کو بھیجیں', vSent: 'رپورٹ بھیج دی گئی', vNeedPhoto: 'نقصان کی تصویر شامل کریں', vNeedReceipt: 'رسید کی تصویر شامل کریں', vOffline: 'نیٹ ورک نہیں — دوبارہ کوشش کریں',
  sopen: 'بھیج دیا', sapproved: 'منظور', sin_progress: 'کام جاری', sresolved: 'حل ہو گیا', srejected: 'نامنظور', vCash: 'نقد', vCard: 'کارڈ', vFuelCard: 'فیول کارڈ' });
Object.assign(TR.ar, { vehicle: 'المركبة', vReport: 'الإبلاغ عن مشكلة في المركبة', vMine: 'بلاغاتي', vNone: 'لا توجد بلاغات بعد.', vTire: 'تلف الإطار', vOil: 'تغيير الزيت', vService: 'صيانة دورية', vBrakes: 'الفرامل', vBattery: 'البطارية', vEngine: 'المحرك / ضوء تحذير', vAc: 'المكيف', vBody: 'ضرر بالهيكل', vFuel: 'وقود', vOther: 'أخرى',
  vHow: 'ما مدى خطورتها؟', vCan: 'يمكن القيادة', vSoon: 'إصلاح قريبًا', vCannot: 'لا يمكن القيادة', vPhoto: 'صورة المشكلة', vTake: 'التقط صورة', vOdo: 'عداد المسافات (كم)', vPaid: 'دفعتُ المبلغ',
  vAmount: 'المبلغ المدفوع (درهم)', vReceipt: 'صورة الإيصال', vNote: 'ملاحظة (اختياري)', vSend: 'إرسال إلى المكتب', vSent: 'تم إرسال البلاغ', vNeedPhoto: 'أضف صورة للضرر', vNeedReceipt: 'أضف صورة الإيصال', vOffline: 'لا يوجد اتصال — حاول مرة أخرى',
  sopen: 'أُرسل', sapproved: 'تمت الموافقة', sin_progress: 'قيد العمل', sresolved: 'تم الحل', srejected: 'غير موافق عليه', vCash: 'نقدًا', vCard: 'بطاقة', vFuelCard: 'بطاقة وقود' });

const vDmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };
const vKm = n => (n == null ? '—' : Number(n).toLocaleString('en-GB') + ' km');
let vForm = null; // { category, urgency, paid, method, photo: Blob, receipt: Blob }

async function renderVehicle() {
  const el = $('#v-vehicle');
  let d = null;
  try {
    const res = await fetch(API + '/driver/vehicle-reports', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return logout();
    d = await res.json();
  } catch {}
  if (!d) { el.innerHTML = `<div class="empty">${t('vOffline')}</div>`; return; }
  if (!d.vehicle) { el.innerHTML = `<div class="empty">${t('vNoVehicle')}</div>`; return; }
  const s = d.summary || {};
  const due = (s.next_due || []).filter(x => x.state !== 'ok');
  el.innerHTML = `
    <div class="sumcard vcard">
      <div class="vhead">${svg(IC.truck, 26)}<div><b>${esc(d.vehicle.fleet_number)}</b><span>${esc(d.vehicle.plate)}</span></div>
        ${s.off_road ? `<span class="chip overdue">${t('vCannot')}</span>` : s.open ? `<span class="chip pending">${s.open}</span>` : `<span class="chip collected">${svg(IC.check, 11)} OK</span>`}</div>
      <div class="vstats">
        <div><span>${t('vOdo')}</span><b>${vKm(s.last_odometer_km)}</b></div>
        <div><span>${t('vLastOil')}</span><b>${s.last_oil_change ? vDmy(s.last_oil_change.date) : '—'}</b></div>
        <div><span>${t('vLastService')}</span><b>${s.last_service ? vDmy(s.last_service.date) : '—'}</b></div>
      </div>
      ${due.map(x => `<div class="vdue ${x.state}">${svg(IC.clock, 14)} ${esc(x.label)} — ${x.state === 'overdue' ? t('vOverdue') : t('vDue')}${x.next_due_date ? ' ' + vDmy(x.next_due_date) : ''}${x.next_due_km ? ' · ' + vKm(x.next_due_km) : ''}</div>`).join('')}
    </div>
    <div class="h-sec">${svg(IC.wrench, 13)} ${t('vReport')}</div>
    <div class="vgrid">${VCATS.map(([code, ic, key]) => `<button class="vtile" onclick="openVReport('${code}')">${svg(IC[ic], 30)}<span>${t(key)}</span></button>`).join('')}</div>
    <div class="h-sec">${svg(IC.clock, 13)} ${t('vMine')}</div>
    ${d.rows.length ? d.rows.map(r => {
      const cat = VCATS.find(c => c[0] === r.category) || VCATS[VCATS.length - 1];
      return `<div class="hist-item vrep">
        ${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="">` : `<div class="hist-icon ${r.status === 'rejected' ? 'bad' : 'ok'}">${svg(IC[cat[1]], 22)}</div>`}
        <div class="hist-text"><div class="hist-name">${t(cat[2])} <span class="chip ${({ open: 'pending', approved: 'progress', in_progress: 'progress', resolved: 'collected', rejected: 'canceled' })[r.status]}">${t('s' + r.status)}</span></div>
          <div class="hist-sub">${vDmy(r.service_date || r.reported_at)}${r.odometer_km ? ' · ' + vKm(r.odometer_km) : ''}${r.cost > 0 ? ` · AED ${Number(r.cost).toFixed(2)}${r.paid_by === 'driver' ? ' (' + (r.reimbursed ? t('vReimbursed') : t('vOwed')) + ')' : ''}` : ''}</div>
          ${r.admin_note ? `<div class="hist-sub vnote">${svg(IC.bell, 11)} ${esc(r.admin_note)}</div>` : ''}</div>
      </div>`; }).join('') : `<div class="empty" style="padding:22px">${t('vNone')}</div>`}`;
}

function openVReport(category) {
  const cat = VCATS.find(c => c[0] === category);
  vForm = { category, urgency: 'normal', paid: category === 'FUEL', method: category === 'FUEL' ? 'fuel_card' : 'cash', photo: null, receipt: null };
  $('#vrep-title').textContent = t(cat[2]);
  $('#vrep-body').innerHTML = `
    <div class="h-sec">${t('vHow')}</div>
    <div class="vurg" id="vurg">
      <button data-u="normal" class="on" onclick="vSet('urgency','normal')">${svg(IC.checkCircle, 22)}<span>${t('vCan')}</span></button>
      <button data-u="high" onclick="vSet('urgency','high')">${svg(IC.clock, 22)}<span>${t('vSoon')}</span></button>
      <button data-u="off_road" class="danger" onclick="vSet('urgency','off_road')">${svg(IC.ban, 22)}<span>${t('vCannot')}</span></button>
    </div>
    <div class="h-sec">${svg(IC.camera, 13)} ${t('vPhoto')}</div>
    <label class="vphoto" id="vph-photo"><input type="file" accept="image/*" capture="environment" onchange="vPick(this,'photo')">${svg(IC.camera, 30)}<span>${t('vTake')}</span></label>
    <div class="h-sec">${svg(IC.gauge, 13)} ${t('vOdo')}</div>
    <input id="v-odo" class="vinput" type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" placeholder="0">
    <button class="vtoggle ${vForm.paid ? 'on' : ''}" id="v-paid" onclick="vSet('paid',!vForm.paid)" aria-pressed="${vForm.paid}">${svg(IC.receipt, 22)}<span>${t('vPaid')}</span><i></i></button>
    <div id="v-paybox" class="${vForm.paid ? '' : 'hidden'}">
      <div class="h-sec">${t('vAmount')}</div>
      <input id="v-cost" class="vinput" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00">
      <div class="vurg three" id="vmethod">
        <button data-m="cash" onclick="vSet('method','cash')"><span>${t('vCash')}</span></button>
        <button data-m="card" onclick="vSet('method','card')"><span>${t('vCard')}</span></button>
        <button data-m="fuel_card" onclick="vSet('method','fuel_card')"><span>${t('vFuelCard')}</span></button>
      </div>
      <div class="h-sec">${svg(IC.receipt, 13)} ${t('vReceipt')}</div>
      <label class="vphoto" id="vph-receipt"><input type="file" accept="image/*" capture="environment" onchange="vPick(this,'receipt')">${svg(IC.receipt, 30)}<span>${t('vTake')}</span></label>
    </div>
    <div class="h-sec">${t('vNote')}</div>
    <textarea id="v-note" class="vinput" rows="2" maxlength="500"></textarea>
    <button class="wide-btn go" id="v-send" onclick="sendVReport()">${svg(IC.upload, 20)} ${t('vSend')}</button>`;
  vSet('method', vForm.method);
  $('#s-vreport').classList.remove('hidden');
}
function closeVReport() { $('#s-vreport').classList.add('hidden'); vForm = null; }
function vSet(k, v) {
  if (!vForm) return;
  vForm[k] = v;
  document.querySelectorAll('#vurg button').forEach(b => b.classList.toggle('on', b.dataset.u === vForm.urgency));
  document.querySelectorAll('#vmethod button').forEach(b => b.classList.toggle('on', b.dataset.m === vForm.method));
  $('#v-paid').classList.toggle('on', vForm.paid); $('#v-paid').setAttribute('aria-pressed', vForm.paid);
  $('#v-paybox').classList.toggle('hidden', !vForm.paid);
}
// Phone photos are 4–12 MB; shrink to ≤1600 px JPEG so uploads work on weak signal.
function vShrink(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => resolve(b || file), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };  // e.g. HEIC the browser cannot decode → send as is
    img.src = url;
  });
}
async function vPick(input, key) {
  const f = input.files && input.files[0];
  if (!f || !vForm) return;
  const blob = await vShrink(f);
  vForm[key] = blob;
  const lab = $('#vph-' + key);
  lab.classList.add('has');
  lab.style.backgroundImage = `url(${URL.createObjectURL(blob)})`;
  lab.querySelector('span').textContent = '✓';
}
async function sendVReport() {
  if (!vForm) return;
  const f = vForm;
  const cost = f.paid ? Number($('#v-cost').value) : 0;
  if (['TIRE', 'BODY'].includes(f.category) && !f.photo) return glToast(t('vNeedPhoto'), 'error');
  if (f.paid && !(cost > 0)) return glToast(t('vAmount'), 'error');
  if (f.paid && !f.receipt) return glToast(t('vNeedReceipt'), 'error');
  const fd = new FormData();
  fd.append('category', f.category); fd.append('urgency', f.urgency);
  const odo = $('#v-odo').value.trim(); if (odo) fd.append('odometer_km', String(Math.round(Number(odo))));
  fd.append('description', $('#v-note').value.trim());
  if (f.photo) fd.append('photo', f.photo, 'issue.jpg');
  if (f.paid) { fd.append('cost', String(cost)); fd.append('payment_method', f.method); fd.append('receipt', f.receipt, 'receipt.jpg'); }
  const btn = $('#v-send'); btn.disabled = true;
  try {
    const res = await fetch(API + '/driver/vehicle-reports', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    if (res.status === 401) return logout();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { btn.disabled = false; return glToast(data.error || 'Could not send', 'error'); }
    const cat = VCATS.find(c => c[0] === f.category);
    closeVReport();
    glToast(t('vSent'), 'success');
    pushNotif('ok', t('vSent'), `${t(cat[2])} — ${data.report.fleet_number}`, true);
    renderVehicle();
  } catch { btn.disabled = false; glToast(t('vOffline'), 'error'); }
}

// the tab label was drawn before these translations were loaded
applyLang();
