// ─────────────────────────────────────────────────────────────
// GreenLoop CRM v3.2 — Fleet maintenance & expenses · Push notifications
// (loaded after app.js / sales.js; uses their helpers: api, $, esc, icon, toast,
//  openModal, field, dmy, dmyTime, AED, nav)
// ─────────────────────────────────────────────────────────────

// multipart helper (photos / receipts) — api() is JSON only
async function apiForm(path, formData, method = 'POST') {
  const res = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + token }, body: formData });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const MT_STATUS = { open: 'Open', approved: 'Approved', in_progress: 'In progress', resolved: 'Resolved', rejected: 'Rejected' };
const MT_URGENCY = { low: 'Low', normal: 'Normal', high: 'High', off_road: 'Cannot drive' };
const MT_PAY = { cash: 'Cash', card: 'Card', transfer: 'Bank transfer', cheque: 'Cheque', fuel_card: 'Fuel card', company_account: 'Company account' };
let mtFilter = 'active';
let mtCats = null;
async function mtCategories() { if (!mtCats) mtCats = (await api('/fleet/maintenance/categories')).categories; return mtCats; }
const mtDate = r => dmy(r.service_date || r.reported_at);
const km = n => (n == null ? '—' : Number(n).toLocaleString('en-GB') + ' km');
function proofCellMt(r) {
  if (r.receipt_url) return `<img class="photo-thumb" src="${r.receipt_url}" alt="Payment proof" onclick="viewPhoto('${r.receipt_url}')"> <span class="pill proof">proof</span>`;
  if (r.cost > 0) return `<span class="pill noproof">missing</span>`;
  return '<span class="muted">—</span>';
}

// ═══════════════ FLEET MAINTENANCE & EXPENSES ═══════════════
async function maintenance() {
  const q = mtFilter === 'active' ? '?status=active' : mtFilter === 'resolved' ? '?status=resolved' : '';
  const d = await api('/fleet/maintenance' + q);
  const s = d.summary;
  const rows = mtFilter === 'noproof' ? d.rows.filter(r => r.proof_missing) : mtFilter === 'reimburse' ? d.rows.filter(r => r.reimbursement_due) : d.rows;
  const tabs = [['active', 'Needs action'], ['all', 'All records'], ['resolved', 'Resolved'], ['noproof', 'Missing payment proof'], ['reimburse', 'Reimburse driver']]
    .map(([k, l]) => `<button class="ptab ${mtFilter === k ? 'on' : ''}" onclick="mtFilter='${k}';maintenance()">${l}</button>`).join('');
  const maxCat = Math.max(1, ...s.spend_by_category.map(c => c.amount));
  $('#main').innerHTML = `
    <div class="head"><div><h1>Fleet maintenance & expenses</h1>
      <p class="sub">Vehicle issues reported from the driver app — tyres, oil, service — with full service history, costs and payment proof per vehicle.</p></div>
      <button class="btn primary" onclick="mtLogForm()">${icon('plus', 13)} Log service / expense</button></div>
    <div class="kpis">
      <div class="kpi amber"><div class="num">${s.open}</div><div class="lbl">${icon('inbox', 13)} New reports</div></div>
      <div class="kpi blue"><div class="num">${s.in_progress}</div><div class="lbl">${icon('wrench', 13)} In progress</div></div>
      <div class="kpi ${s.off_road ? 'red' : 'green'}"><div class="num">${s.off_road}</div><div class="lbl">${icon('alertTriangle', 13)} Vehicles off the road</div></div>
      <div class="kpi violet"><div class="num" style="font-size:24px">${AED(s.spend_month)}</div><div class="lbl">Spend this month</div></div>
      <div class="kpi ${s.proof_missing ? 'red' : 'green'}"><div class="num">${s.proof_missing}</div><div class="lbl">Expenses without payment proof</div></div>
      <div class="kpi ${s.reimbursement_due ? 'amber' : ''}"><div class="num" style="font-size:24px">${AED(s.reimbursement_due)}</div><div class="lbl">Owed to drivers</div></div>
    </div>
    ${s.due.length ? `<div class="banner ${s.due.some(x => x.state === 'overdue') ? 'red' : ''}">${icon('clock', 16)} <div><b>Maintenance due:</b> ${s.due.map(x =>
      `${esc(x.fleet_number)} — ${esc(x.label)} ${x.state === 'overdue' ? 'overdue' : 'due soon'}${x.next_due_date ? ' (' + dmy(x.next_due_date) + ')' : ''}${x.next_due_km ? ' (at ' + km(x.next_due_km) + ')' : ''}`).join(' · ')}</div></div>` : ''}
    <div class="veh-cards">${d.vehicles.map(v => `
      <div class="veh-card ${v.off_road ? 'offroad' : ''}" onclick="mtVehicle(${v.id})" tabindex="0" onkeydown="if(event.key==='Enter')mtVehicle(${v.id})">
        <div class="row spread"><b style="font-size:15px">${icon('truck', 15)} ${esc(v.fleet_number)}</b>
          ${v.off_road ? '<span class="pill off_road">off the road</span>' : v.open ? `<span class="pill open">${v.open} open</span>` : '<span class="pill resolved">OK</span>'}</div>
        <div class="muted small">${esc(v.plate)} · ${esc(v.zone)}${v.is_active ? '' : ' · parked'}</div>
        <div class="kv"><span>Odometer</span><div>${km(v.last_odometer_km)}</div>
          <span>Last oil change</span><div>${v.last_oil_change ? dmy(v.last_oil_change.date) + (v.last_oil_change.odometer_km ? ' · ' + km(v.last_oil_change.odometer_km) : '') : '—'}</div>
          <span>Last service</span><div>${v.last_service ? dmy(v.last_service.date) : '—'}</div>
          <span>Last tyre work</span><div>${v.last_tire ? dmy(v.last_tire.date) : '—'}</div>
          <span>Spend this year</span><div><b>${AED(v.spend_year)}</b></div></div>
        <div class="small" style="margin-top:8px;color:var(--teal);font-weight:700">Service history →</div>
      </div>`).join('')}</div>
    ${s.spend_by_category.length ? `<div class="card"><h3>${icon('chart', 15)} Spend this month by category</h3><div class="catbars">${s.spend_by_category.map(c =>
      `<div class="catbar"><span>${esc(c.label)}</span><i style="width:${Math.round(100 * c.amount / maxCat)}%"></i><span class="r">${AED(c.amount)}</span></div>`).join('')}</div></div>` : ''}
    <div class="row" style="margin-bottom:12px"><div class="ptabs">${tabs}</div>
      <span class="fmt-hint">${icon('calendar', 13)} DD/MM/YYYY</span></div>
    <div class="card scroll-x">${rows.length ? `<table><tr><th>Date</th><th>Vehicle</th><th>Issue / work</th><th>Reported by</th><th class="r">Odometer</th><th>Urgency</th><th class="r">Cost</th><th>Payment proof</th><th>Status</th><th></th></tr>
      ${rows.map(r => `<tr>
        <td>${mtDate(r)}</td><td><b>${esc(r.fleet_number)}</b><br><span class="muted small">${esc(r.plate)}</span></td>
        <td><b>${esc(r.category_label)}</b>${r.description ? `<br><span class="muted small">${esc(r.description)}</span>` : ''}${r.work_done ? `<br><span class="small">${icon('check', 11)} ${esc(r.work_done)}</span>` : ''}</td>
        <td>${r.source === 'office' ? '<span class="muted">Office</span>' : esc(r.driver || '—')}${r.photo_url ? `<br><img class="photo-thumb" src="${r.photo_url}" alt="Issue photo" onclick="viewPhoto('${r.photo_url}')">` : ''}</td>
        <td class="r small">${km(r.odometer_km)}</td>
        <td><span class="pill ${r.urgency}">${MT_URGENCY[r.urgency] || r.urgency}</span></td>
        <td class="r">${r.cost > 0 ? `<b>${AED(r.cost)}</b><br><span class="muted small">${r.paid_by === 'driver' ? (r.reimbursed ? 'driver · reimbursed' : 'paid by driver') : 'company'}${r.payment_method ? ' · ' + (MT_PAY[r.payment_method] || r.payment_method) : ''}</span>` : '—'}</td>
        <td>${proofCellMt(r)}</td>
        <td><span class="pill ${r.status}">${MT_STATUS[r.status]}</span></td>
        <td class="r"><button class="btn ${['open'].includes(r.status) ? 'primary' : 'ghost'} small" onclick="mtReview(${r.id})">${r.status === 'open' ? 'Review' : 'Open'}</button></td>
      </tr>`).join('')}</table>` : `<p class="empty">${mtFilter === 'active' ? 'Nothing needs action — no open vehicle reports.' : 'No records in this view.'}</p>`}</div>`;
}

let _mtRows = {};
async function mtReview(id) {
  const d = await api('/fleet/maintenance');
  const r = d.rows.find(x => x.id === id);
  if (!r) return toast('Report not found', 'critical');
  _mtRows[id] = r;
  const opt = (map, cur) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`).join('');
  openModal(`
    <div class="row spread"><h3 style="margin:0">${icon('wrench', 17)} ${esc(r.fleet_number)} — ${esc(r.category_label)}</h3><span class="pill ${r.status}">${MT_STATUS[r.status]}</span></div>
    <p class="muted small" style="margin:4px 0 12px">Reported ${dmyTime(r.reported_at)} by ${r.source === 'office' ? 'the office' : esc(r.driver || 'driver')} · odometer ${km(r.odometer_km)} · <span class="pill ${r.urgency}">${MT_URGENCY[r.urgency]}</span></p>
    ${r.description ? `<p style="margin-bottom:12px">“${esc(r.description)}”</p>` : ''}
    <div class="row" style="margin-bottom:14px;align-items:flex-start">
      ${r.photo_url ? `<figure style="margin:0"><img src="${r.photo_url}" alt="Issue photo" style="width:150px;height:110px;object-fit:cover;border-radius:12px;cursor:pointer;border:1px solid var(--line)" onclick="window.open('${r.photo_url}','_blank')"><figcaption class="muted small">Issue photo</figcaption></figure>` : ''}
      ${r.receipt_url ? `<figure style="margin:0"><img src="${r.receipt_url}" alt="Payment proof" style="width:150px;height:110px;object-fit:cover;border-radius:12px;cursor:pointer;border:1px solid rgba(52,211,153,.5)" onclick="window.open('${r.receipt_url}','_blank')"><figcaption class="small" style="color:var(--green)">Payment proof</figcaption></figure>`
        : `<div class="banner ${r.cost > 0 ? 'red' : ''}" style="flex:1;margin:0">${icon('camera', 16)}<div>${r.cost > 0 ? '<b>No payment proof yet.</b> ' : ''}Attach a photo of the receipt / invoice.<br>
          <input type="file" id="mt-proof" accept="image/jpeg,image/png,image/webp,image/heic" style="margin-top:6px"><button class="btn ghost small" style="margin-top:6px" onclick="mtUploadProof(${r.id})">${icon('upload', 12)} Upload proof</button></div></div>`}
    </div>
    ${r.receipt_url ? `<div class="row" style="margin:-6px 0 12px"><input type="file" id="mt-proof" accept="image/jpeg,image/png,image/webp,image/heic" style="max-width:260px"><button class="btn ghost small" onclick="mtUploadProof(${r.id})">${icon('upload', 12)} Replace proof</button></div>` : ''}
    <div class="fgrid3">
      ${field('Status', `<select id="mt-status">${opt(MT_STATUS, r.status)}</select>`)}
      ${field('Urgency', `<select id="mt-urg">${opt(MT_URGENCY, r.urgency)}</select>`)}
      ${field('Service date', `<input id="mt-date" type="date" max="${today()}" value="${r.service_date || ''}">`)}
      ${field('Workshop / vendor', `<input id="mt-vendor" maxlength="120" value="${esc(r.vendor || '')}" placeholder="e.g. Al Quoz Tyres">`)}
      ${field('Cost (AED, incl. VAT)', `<input id="mt-cost" type="number" step="0.01" min="0" value="${r.cost ?? ''}">`)}
      ${field('Paid by', `<select id="mt-paidby"><option value="">—</option><option value="company" ${r.paid_by === 'company' ? 'selected' : ''}>Company</option><option value="driver" ${r.paid_by === 'driver' ? 'selected' : ''}>Driver (reimburse)</option></select>`)}
      ${field('Payment method', `<select id="mt-method"><option value="">—</option>${opt(MT_PAY, r.payment_method)}</select>`)}
      ${field('Payment reference', `<input id="mt-ref" maxlength="120" value="${esc(r.payment_ref || '')}" placeholder="Receipt / txn no.">`)}
      ${field('Odometer (km)', `<input id="mt-odo" type="number" step="1" min="0" value="${r.odometer_km ?? ''}">`)}
      ${field('Next due — date', `<input id="mt-nd" type="date" value="${r.next_due_date || ''}">`)}
      ${field('Next due — odometer (km)', `<input id="mt-nk" type="number" step="1" min="0" value="${r.next_due_km ?? ''}">`)}
      ${r.paid_by === 'driver' && r.cost > 0 && CRM_ROLE === 'owner' ? field('Driver reimbursed', `<select id="mt-reimb"><option value="0">Not yet</option><option value="1" ${r.reimbursed ? 'selected' : ''}>Yes — paid back</option></select>`) : '<div></div>'}
    </div>
    ${field('Work done', `<input id="mt-work" maxlength="500" value="${esc(r.work_done || '')}" placeholder="e.g. 2 rear tyres replaced, wheel balancing">`)}
    ${field('Note to driver (required when rejecting)', `<input id="mt-note" maxlength="500" value="${esc(r.admin_note || '')}">`)}
    <div class="row"><button class="btn primary" onclick="mtSave(${r.id})">Save</button>
      ${r.status !== 'resolved' ? `<button class="btn ghost" onclick="$('#mt-status').value='resolved';mtSave(${r.id})">${icon('checkCircle', 13)} Save & mark resolved</button>` : ''}
      <button class="btn ghost" onclick="mtVehicle(${r.vehicle_id})">Vehicle history</button><button class="btn ghost" onclick="closeModal()">Close</button></div>
    <p id="m-err" class="err"></p>`, true);
}
async function mtSave(id) {
  const v = s => ($(s) ? $(s).value : undefined);
  const body = { status: v('#mt-status'), urgency: v('#mt-urg'), service_date: v('#mt-date'), vendor: v('#mt-vendor'), cost: v('#mt-cost'), paid_by: v('#mt-paidby'),
    payment_method: v('#mt-method'), payment_ref: v('#mt-ref'), odometer_km: v('#mt-odo'), next_due_date: v('#mt-nd'), next_due_km: v('#mt-nk'), work_done: v('#mt-work'), admin_note: v('#mt-note') };
  if ($('#mt-reimb')) body.reimbursed = $('#mt-reimb').value === '1';
  try {
    const r = await api('/fleet/maintenance/' + id, { method: 'PUT', body });
    closeModal();
    const rep = r.report;
    if (rep.proof_missing) toast(`Saved — ${rep.fleet_number} ${MT_STATUS[rep.status].toLowerCase()}. Payment proof is still missing for ${AED(rep.cost)}.`, 'warning');
    else toast(`Saved — ${rep.fleet_number} · ${rep.category_label} is ${MT_STATUS[rep.status].toLowerCase()}${rep.driver ? '. Driver notified.' : ''}`, 'success');
    if (currentPage === 'maintenance') maintenance();
  } catch (e) { $('#m-err').textContent = e.message; }
}
async function mtUploadProof(id) {
  const f = $('#mt-proof') && $('#mt-proof').files[0];
  if (!f) return toast('Choose a photo of the receipt first', 'warning');
  const fd = new FormData(); fd.append('receipt', f);
  try { await apiForm(`/fleet/maintenance/${id}/proof`, fd); toast('Payment proof attached', 'success'); mtReview(id); if (currentPage === 'maintenance') maintenance(); }
  catch (e) { toast(e.message, 'critical'); }
}

// office logs a service / expense directly
async function mtLogForm(vehicleId) {
  const [cats, vs] = await Promise.all([mtCategories(), api('/vehicles')]);
  openModal(`
    <h3>${icon('plus', 17)} Log service / expense</h3>
    <div class="fgrid3">
      ${field('Vehicle', `<select id="ml-v">${vs.map(v => `<option value="${v.id}" ${vehicleId === v.id ? 'selected' : ''}>${esc(v.fleet_number)} · ${esc(v.plate)}</option>`).join('')}</select>`)}
      ${field('Category', `<select id="ml-c">${cats.map(c => `<option value="${c.code}">${esc(c.label)}</option>`).join('')}</select>`)}
      ${field('Service date', `<input id="ml-d" type="date" max="${today()}" value="${today()}">`)}
      ${field('Workshop / vendor', `<input id="ml-vendor" maxlength="120">`)}
      ${field('Cost (AED, incl. VAT)', `<input id="ml-cost" type="number" step="0.01" min="0">`)}
      ${field('Payment method', `<select id="ml-m"><option value="">—</option>${Object.entries(MT_PAY).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`)}
      ${field('Payment reference', `<input id="ml-ref" maxlength="120">`)}
      ${field('Odometer (km)', `<input id="ml-odo" type="number" step="1" min="0">`)}
      ${field('Status', `<select id="ml-s"><option value="resolved">Done (resolved)</option><option value="in_progress">In progress</option><option value="approved">Planned</option></select>`)}
      ${field('Next due — date', `<input id="ml-nd" type="date">`)}
      ${field('Next due — odometer (km)', `<input id="ml-nk" type="number" step="1" min="0">`)}
      ${field('Payment proof (receipt photo)', `<input id="ml-proof" type="file" accept="image/jpeg,image/png,image/webp,image/heic">`)}
    </div>
    ${field('Work done / notes', `<input id="ml-work" maxlength="500" placeholder="e.g. Engine oil 15W-40 + oil filter">`)}
    <div class="row"><button class="btn primary" onclick="mtLogSave()">Save record</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>
    <p id="m-err" class="err"></p>`, true);
}
async function mtLogSave() {
  const fd = new FormData();
  const put = (k, sel) => { const val = $(sel).value; if (val !== '') fd.append(k, val); };
  put('vehicle_id', '#ml-v'); put('category', '#ml-c'); put('service_date', '#ml-d'); put('vendor', '#ml-vendor'); put('cost', '#ml-cost'); put('payment_method', '#ml-m');
  put('payment_ref', '#ml-ref'); put('odometer_km', '#ml-odo'); put('status', '#ml-s'); put('next_due_date', '#ml-nd'); put('next_due_km', '#ml-nk'); put('work_done', '#ml-work');
  if ($('#ml-proof').files[0]) fd.append('receipt', $('#ml-proof').files[0]);
  try {
    const r = await apiForm('/fleet/maintenance', fd);
    closeModal();
    toast(r.report.proof_missing ? `Record saved for ${r.report.fleet_number} — remember to attach the payment proof` : `Record saved for ${r.report.fleet_number}`, r.report.proof_missing ? 'warning' : 'success');
    if (currentPage === 'maintenance') maintenance();
  } catch (e) { $('#m-err').textContent = e.message; }
}

// full service history of one vehicle
async function mtVehicle(id) {
  const d = await api('/fleet/maintenance/vehicle/' + id);
  const s = d.summary, v = d.vehicle;
  window._mtHist = d;
  openModal(`
    <div class="row spread"><h3 style="margin:0">${icon('truck', 17)} ${esc(v.fleet_number)} — service history</h3>
      ${s.off_road ? '<span class="pill off_road">off the road</span>' : `<span class="pill ${s.open ? 'open' : 'resolved'}">${s.open ? s.open + ' open' : 'no open issues'}</span>`}</div>
    <p class="muted small" style="margin:4px 0 14px">${esc(v.plate)} · ${esc(v.zone)} · default capacity ${v.max_daily_capacity} stops/day</p>
    <div class="kpis">
      <div class="kpi"><div class="num" style="font-size:22px">${km(s.last_odometer_km)}</div><div class="lbl">Last odometer</div></div>
      <div class="kpi violet"><div class="num" style="font-size:22px">${AED(s.spend_month)}</div><div class="lbl">Spend this month</div></div>
      <div class="kpi blue"><div class="num" style="font-size:22px">${AED(s.spend_year)}</div><div class="lbl">Spend this year</div></div>
      <div class="kpi"><div class="num" style="font-size:22px">${AED(s.spend_total)}</div><div class="lbl">Lifetime spend</div></div>
    </div>
    ${s.next_due.length ? `<div class="row" style="margin-bottom:14px">${s.next_due.map(x => `<span class="pill ${x.state === 'overdue' ? 'canceled' : x.state === 'due_soon' ? 'pending' : 'resolved'}">${esc(x.label)}: next ${x.next_due_date ? dmy(x.next_due_date) : ''}${x.next_due_date && x.next_due_km ? ' or ' : ''}${x.next_due_km ? km(x.next_due_km) : ''}${x.state === 'overdue' ? ' — OVERDUE' : x.state === 'due_soon' ? ' — due soon' : ''}</span>`).join(' ')}</div>` : ''}
    <div class="row" style="margin-bottom:12px"><button class="btn primary small" onclick="mtLogForm(${v.id})">${icon('plus', 12)} Log service / expense</button>
      <button class="btn ghost small" onclick="mtHistCsv()">${icon('download', 12)} Export CSV</button></div>
    ${d.history.length ? `<div class="timeline">${d.history.map(r => `
      <div class="tl-item ${r.kind}"><div class="tl-body">
        <div class="row spread"><b>${mtDate(r)} · ${esc(r.category_label)}</b><span><span class="pill ${r.status}">${MT_STATUS[r.status]}</span> ${r.cost > 0 ? `<b style="margin-left:6px">${AED(r.cost)}</b>` : ''}</span></div>
        <div class="muted small">${r.source === 'office' ? 'Logged by office' : 'Reported by ' + esc(r.driver || 'driver')} · odometer ${km(r.odometer_km)}${r.vendor ? ' · ' + esc(r.vendor) : ''}${r.payment_method ? ' · ' + (MT_PAY[r.payment_method] || r.payment_method) : ''}${r.payment_ref ? ' · ref ' + esc(r.payment_ref) : ''}${r.paid_by === 'driver' ? (r.reimbursed ? ' · driver reimbursed' : ' · owed to driver') : ''}</div>
        ${r.description ? `<div class="small" style="margin-top:4px">“${esc(r.description)}”</div>` : ''}${r.work_done ? `<div class="small" style="margin-top:4px">${icon('check', 11)} ${esc(r.work_done)}</div>` : ''}
        <div class="row" style="margin-top:8px">
          ${r.photo_url ? `<img class="photo-thumb" src="${r.photo_url}" alt="Issue photo" onclick="window.open('${r.photo_url}','_blank')">` : ''}
          ${r.receipt_url ? `<img class="photo-thumb" src="${r.receipt_url}" alt="Payment proof" style="border-color:rgba(52,211,153,.6)" onclick="window.open('${r.receipt_url}','_blank')"><span class="pill proof">payment proof</span>` : r.cost > 0 ? '<span class="pill noproof">payment proof missing</span>' : ''}
          <button class="btn ghost small" style="margin-left:auto" onclick="mtReview(${r.id})">Open</button></div>
      </div></div>`).join('')}</div>` : '<p class="empty">No service records yet for this vehicle.</p>'}
    <button class="btn ghost full" onclick="closeModal()">Close</button>`, true);
}
function mtHistCsv() {
  const d = window._mtHist; if (!d) return;
  const cols = [['Date (DD/MM/YYYY)', r => mtDate(r)], ['Vehicle', r => r.fleet_number], ['Category', r => r.category_label], ['Status', r => MT_STATUS[r.status]], ['Reported by', r => r.source === 'office' ? 'Office' : r.driver || ''],
    ['Odometer km', r => r.odometer_km ?? ''], ['Description', r => r.description || ''], ['Work done', r => r.work_done || ''], ['Vendor', r => r.vendor || ''], ['Cost AED', r => r.cost ?? ''],
    ['Paid by', r => r.paid_by || ''], ['Payment method', r => MT_PAY[r.payment_method] || ''], ['Payment ref', r => r.payment_ref || ''], ['Payment proof', r => r.receipt_url ? 'yes' : (r.cost > 0 ? 'MISSING' : '')], ['Reimbursed', r => r.paid_by === 'driver' ? (r.reimbursed ? 'yes' : 'no') : ''],
    ['Next due date', r => r.next_due_date ? dmy(r.next_due_date) : ''], ['Next due km', r => r.next_due_km ?? '']];
  // leading = + - @ would be run as a formula by Excel — neutralise them
  const cell = x => { let s = String(x ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = [cols.map(c => cell(c[0])).join(','), ...d.history.map(r => cols.map(c => cell(c[1](r))).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })); a.download = `service-history_${d.vehicle.fleet_number}.csv`; a.click();
}

// ═══════════════ PUSH NOTIFICATIONS (admin-wide) ═══════════════
async function broadcast() {
  const s = await api('/push/stats');
  const aud = { customers: 'Customers', drivers: 'Drivers', all: 'Everyone' };
  $('#main').innerHTML = `
    <div class="head"><div><h1>Push notifications</h1>
      <p class="sub">Send one announcement to every signed-in customer and/or driver. It is pushed to their phones and saved in the app inbox, so nobody misses it.</p></div></div>
    <div class="kpis">
      <div class="kpi green"><div class="num">${s.customer.users}<span class="muted" style="font-size:15px"> / ${s.totals.customer_accounts}</span></div><div class="lbl">${icon('store', 13)} Customers with push on</div></div>
      <div class="kpi"><div class="num">${s.customer.devices}</div><div class="lbl">${icon('smartphone', 13)} Customer devices</div></div>
      <div class="kpi blue"><div class="num">${s.driver.users}<span class="muted" style="font-size:15px"> / ${s.totals.drivers}</span></div><div class="lbl">${icon('truck', 13)} Drivers with push on</div></div>
      <div class="kpi"><div class="num">${s.driver.devices}</div><div class="lbl">${icon('smartphone', 13)} Driver devices</div></div>
    </div>
    ${s.customer.users < s.totals.customer_accounts ? `<div class="banner">${icon('info', 16)}<div>${s.totals.customer_accounts - s.customer.users} customer account(s) have not turned on notifications on any phone. They still get every message in the app inbox (bell icon) and see it the next time they open the app. Customers turn push on from the prompt after sign-in, or in the app under <b>More → Notifications</b>.</div></div>` : ''}
    <div class="grid2">
      <div class="card"><h3>${icon('megaphone', 15)} New announcement</h3>
        ${field('Send to', `<div class="seg-aud">
          <label><input type="radio" name="bc-aud" value="customers" checked onchange="bcPreview()"><b>Customers</b><small>${s.customer.devices} device(s) · ${s.totals.customer_accounts} inboxes</small></label>
          <label><input type="radio" name="bc-aud" value="drivers" onchange="bcPreview()"><b>Drivers</b><small>${s.driver.devices} device(s)</small></label>
          <label><input type="radio" name="bc-aud" value="all" onchange="bcPreview()"><b>Everyone</b><small>${s.customer.devices + s.driver.devices} device(s)</small></label></div>`)}
        ${field('Title (max 80)', `<input id="bc-title" maxlength="80" placeholder="e.g. Eid Al Fitr schedule" oninput="bcPreview()">`)}
        ${field('Message (max 300)', `<textarea id="bc-body" maxlength="300" placeholder="e.g. No collections on 20/03/2026. Normal service resumes 21/03/2026." oninput="bcPreview()"></textarea>`)}
        <div class="row"><button class="btn primary" id="bc-send" onclick="bcSend()">${icon('send', 13)} Send notification</button><span id="bc-count" class="muted small"></span></div>
        <p id="m-err" class="err"></p>
      </div>
      <div class="card"><h3>${icon('smartphone', 15)} Preview on the phone</h3>
        <div class="phone-prev"><div class="app-ic">${icon('bell', 18)}</div><div><b id="bc-pt">Title</b><span id="bc-pb">Your message appears here.</span></div></div>
        <p class="muted small" style="margin-top:12px">Alerts that are sent automatically (no action needed): service tomorrow reminder, driver on the way / arrived, service completed, not-picked-up confirmation, booking decisions, invoice issued, payment received — and for drivers: route changes, stop at risk, vehicle-report updates.</p>
      </div>
    </div>
    <div class="card scroll-x"><h3>${icon('list', 15)} Sent announcements</h3>
      ${s.history.length ? `<table><tr><th>Sent</th><th>To</th><th>Message</th><th class="r">Inboxes</th><th class="r">Devices</th><th class="r">Delivered</th><th class="r">Failed</th><th>By</th></tr>
        ${s.history.map(h => `<tr><td class="small">${dmyTime(h.created_at)}</td><td><span class="pill sent">${aud[h.audience] || h.audience}</span></td>
          <td><b>${esc(h.title)}</b><br><span class="muted small">${esc(h.body)}</span></td><td class="r">${h.recipients}</td><td class="r">${h.devices}</td>
          <td class="r"><b style="color:var(--green)">${h.delivered}</b></td><td class="r">${h.failed ? `<b style="color:var(--red)">${h.failed}</b>` : '0'}${h.removed ? `<br><span class="muted small">${h.removed} expired removed</span>` : ''}</td>
          <td class="small muted">${esc(h.sent_by || '')}</td></tr>`).join('')}</table>` : '<p class="empty">No announcements sent yet.</p>'}</div>`;
  bcPreview();
}
function bcPreview() {
  if (!$('#bc-title')) return;
  $('#bc-pt').textContent = $('#bc-title').value.trim() || 'Title';
  $('#bc-pb').textContent = $('#bc-body').value.trim() || 'Your message appears here.';
  $('#bc-count').textContent = `${$('#bc-title').value.length}/80 · ${$('#bc-body').value.length}/300`;
}
async function bcSend() {
  const audience = document.querySelector('input[name="bc-aud"]:checked').value;
  const title = $('#bc-title').value.trim(), body = $('#bc-body').value.trim();
  $('#m-err').textContent = '';
  if (!title || !body) { $('#m-err').textContent = 'Write a title and a message first'; return; }
  const who = { customers: 'ALL customers', drivers: 'ALL drivers', all: 'ALL customers and drivers' }[audience];
  if (!confirm(`Send this notification to ${who}?\n\n${title}\n${body}`)) return;
  const btn = $('#bc-send'); btn.disabled = true;
  try {
    const r = await api('/push/broadcast', { method: 'POST', body: { audience, title, body } });
    const msg = `Sent to ${r.recipients} inbox(es) · pushed to ${r.delivered} of ${r.devices} device(s)` + (r.removed ? ` · ${r.removed} expired device(s) cleaned up` : '');
    if (r.failed) toast(`${msg} · ${r.failed} device(s) failed (${(r.errors || []).join(', ') || 'push service error'})`, 'warning');
    else if (!r.devices) toast(`${msg}. No phone has notifications turned on yet — the message is waiting in the app inbox.`, 'warning');
    else toast(msg, 'success');
    broadcast();
  } catch (e) { $('#m-err').textContent = e.message; btn.disabled = false; }
}
