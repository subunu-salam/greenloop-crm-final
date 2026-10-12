// ─────────────────────────────────────────────────────────────
// GreenLoop CRM v3 pages — sales pipeline, quotations, 360, plans,
// billing, not-picked-up confirmations, catalogue, audit, settings.
// Loaded after app.js; uses its helpers (api, $, esc, icon, toast, openModal…).
// ─────────────────────────────────────────────────────────────
const AED = n => 'AED ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STAGE_LABEL = { new: 'New', contacted: 'Contacted', quoted: 'Quoted', won: 'Won', lost: 'Lost' };
const SOURCES = ['website', 'whatsapp', 'phone', 'referral', 'walk-in', 'social', 'other'];
let _services = null;
async function services() { if (!_services) _services = await api('/service-types'); return _services; }
const svcName = code => (_services || []).find(s => s.code === code)?.name || code;
const svcCat = code => (_services || []).find(s => s.code === code)?.category || 'waste';
const jsonAttr = o => JSON.stringify(o).replace(/&/g, '&amp;').replace(/'/g, '&#39;');   // v3.4.4: & first, so &quot; in data stays text
function openDoc(path) { window.open(`${API}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, '_blank'); }

// ── shared recurrence editor ─────────────────────────────────
function recurrenceFields(rule = { type: 'weekly', days: [0, 3] }, win = '07:00-12:00') {
  const t = rule.type || 'weekly';
  const [ws, we] = String(win || '07:00-12:00').split('-');
  return `
  <div class="fgrid">
    ${field('Frequency', `<select id="rc-type" onchange="rcToggle()">
      <option value="daily" ${t === 'daily' ? 'selected' : ''}>Daily</option>
      <option value="weekly" ${t === 'weekly' ? 'selected' : ''}>Weekly — choose days</option>
      <option value="monthly" ${t === 'monthly' ? 'selected' : ''}>Monthly</option></select>`)}
    ${field('Time window', `<div class="row" style="gap:6px;flex-wrap:nowrap"><input id="rc-ws" type="time" value="${ws}"><span class="muted">to</span><input id="rc-we" type="time" value="${we}"></div>`)}
  </div>
  <div id="rc-daily" class="field ${t === 'daily' ? '' : 'hidden'}"><label class="daypick" style="display:inline-flex"><input type="checkbox" id="rc-wd" ${rule.weekdays_only ? 'checked' : ''}> Weekdays only (Mon–Fri)</label></div>
  <div id="rc-weekly" class="field ${t === 'weekly' ? '' : 'hidden'}"><div class="daypick">${DOW.map((d, i) =>
    `<label><input type="checkbox" class="rc-day" value="${i}" ${(rule.days || []).map(Number).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
  <div id="rc-monthly" class="fgrid ${t === 'monthly' ? '' : 'hidden'}">
    ${field('Monthly by', `<select id="rc-mode" onchange="rcToggle()"><option value="date" ${rule.mode !== 'nth' ? 'selected' : ''}>Fixed date</option><option value="nth" ${rule.mode === 'nth' ? 'selected' : ''}>Nth weekday</option></select>`)}
    <div>
      <div id="rc-m-date" class="${rule.mode === 'nth' ? 'hidden' : ''}">${field('Day of month (1–28)', `<input id="rc-date" type="number" min="1" max="28" value="${rule.date || 1}">`)}</div>
      <div id="rc-m-nth" class="${rule.mode === 'nth' ? '' : 'hidden'}">${field('Which', `<div class="row" style="gap:6px;flex-wrap:nowrap"><select id="rc-n">${[[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [-1, 'Last']].map(([v, l]) => `<option value="${v}" ${Number(rule.n) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="rc-wday">${DOW.map((d, i) => `<option value="${i}" ${Number(rule.weekday) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>`)}</div>
    </div>
  </div>`;
}
function rcToggle() {
  const t = $('#rc-type').value;
  ['daily', 'weekly', 'monthly'].forEach(x => $('#rc-' + x).classList.toggle('hidden', x !== t));
  const nth = $('#rc-mode') && $('#rc-mode').value === 'nth';
  $('#rc-m-date')?.classList.toggle('hidden', nth); $('#rc-m-nth')?.classList.toggle('hidden', !nth);
}
function readRecurrence() {
  const t = $('#rc-type').value;
  let rule;
  if (t === 'daily') rule = { type: 'daily', weekdays_only: $('#rc-wd').checked };
  else if (t === 'weekly') rule = { type: 'weekly', days: [...document.querySelectorAll('.rc-day:checked')].map(x => Number(x.value)) };
  else rule = $('#rc-mode').value === 'nth' ? { type: 'monthly', mode: 'nth', n: Number($('#rc-n').value), weekday: Number($('#rc-wday').value) } : { type: 'monthly', mode: 'date', date: Number($('#rc-date').value) };
  return { rule, time_window: `${$('#rc-ws').value}-${$('#rc-we').value}` };
}
function ruleLabel(r) {
  if (!r) return '—';
  if (r.type === 'daily') return r.weekdays_only ? 'Daily, Mon–Fri' : 'Daily';
  if (r.type === 'weekly') return 'Weekly on ' + (r.days || []).map(d => DOW[d]).join(', ');
  if (r.mode === 'nth') return `Monthly, ${r.n == -1 ? 'last' : ['', '1st', '2nd', '3rd', '4th', '5th'][r.n]} ${DOW[r.weekday]}`;
  return `Monthly on day ${r.date}`;
}

// ── service frequency (v3.3) ─────────────────────────────────
// How often a service happens is picked as a number + per day / week / month.
// The visits a month, and so the price, follow from it (same rules as the server):
//   daily n → n × 30 · weekly n → n × 52 ÷ 12 rounded · monthly n → n
const FREQ = { daily: { max: 3, per: 'day' }, weekly: { max: 7, per: 'week' }, monthly: { max: 28, per: 'month' } };
const visitsPerMonth = (unit, n) => unit === 'daily' ? n * 30 : unit === 'weekly' ? Math.round(n * 52 / 12) : n;
function freqLabel(unit, n) {
  if (!FREQ[unit]) return '—';
  if (unit === 'daily' && n === 1) return 'Every day';
  return n === 1 ? `Once a ${FREQ[unit].per}` : n === 2 ? `Twice a ${FREQ[unit].per}` : `${n} times a ${FREQ[unit].per}`;
}
// stored as "weekly:3"; older leads hold free text such as "3× weekly" or "weekly"
function parseFreq(v) {
  const s = String(v || '').toLowerCase();
  let m = /^(daily|weekly|monthly):(\d{1,2})$/.exec(s);
  if (!m) { const u = /(dai|day)/.test(s) ? 'daily' : /(month)/.test(s) ? 'monthly' : /(week)/.test(s) ? 'weekly' : null; const n = /(\d{1,2})/.exec(s); if (u) m = [0, u, n ? n[1] : 1]; }
  if (!m) return null;
  const unit = m[1], count = Math.min(FREQ[unit].max, Math.max(1, Number(m[2]) || 1));
  return { unit, count };
}
const freqText = v => { const f = parseFreq(v); return f ? freqLabel(f.unit, f.count) : (v || '—'); };
// a visit count from an older quotation → the nearest frequency that gives the same count
function freqFromVisits(qty) {
  const n = Math.round(Number(qty) || 1);
  if (n % 30 === 0 && n / 30 <= 3) return { unit: 'daily', count: n / 30 };
  for (let w = 1; w <= 6; w++) if (visitsPerMonth('weekly', w) === n && n > 3) return { unit: 'weekly', count: w };
  return { unit: 'monthly', count: Math.min(28, Math.max(1, n)) };
}
// the control: [−] 3 [+] times a [day|week|month]
function freqControl(f, id) {
  f = f || { unit: 'weekly', count: 1 };
  return `<div class="freq" ${id ? `id="${id}"` : ''} data-unit="${f.unit}" data-count="${f.count}" role="group" aria-label="How often">
    <div class="fq-num"><button type="button" onclick="fqStep(this,-1)" aria-label="Fewer">−</button><output>${f.count}</output><button type="button" onclick="fqStep(this,1)" aria-label="More">+</button></div>
    <span class="fq-x">${f.count === 1 ? 'time a' : 'times a'}</span>
    <div class="fq-unit">${Object.entries(FREQ).map(([u, d]) => `<button type="button" class="${u === f.unit ? 'on' : ''}" data-u="${u}" onclick="fqUnit(this)">${d.per}</button>`).join('')}</div>
  </div>`;
}
const fqRead = el => ({ unit: el.dataset.unit, count: Number(el.dataset.count) });
function fqSet(el, unit, count) {
  count = Math.min(FREQ[unit].max, Math.max(1, count));
  el.dataset.unit = unit; el.dataset.count = count;
  el.querySelector('output').textContent = count;
  el.querySelector('.fq-x').textContent = count === 1 ? 'time a' : 'times a';
  el.querySelectorAll('.fq-unit button').forEach(b => b.classList.toggle('on', b.dataset.u === unit));
}
function fqStep(btn, d) { const el = btn.closest('.freq'); fqSet(el, el.dataset.unit, Number(el.dataset.count) + d); fqChanged(el); }
// a new unit starts again from once: "4 times a week" must not silently become "4 times a day"
function fqUnit(btn) { const el = btn.closest('.freq'); if (btn.dataset.u === el.dataset.unit) return; fqSet(el, btn.dataset.u, 1); fqChanged(el); }
function fqChanged(el) {
  const line = el.closest('.qline');
  if (!line) return;
  if (line === document.querySelector('#qb-body .qline')) qbPlanFromLine();
  qbCalc();
}

// ═══════════════════ PIPELINE DASHBOARD (CRM-16) ═════════════
async function pipeline() {
  killCharts();
  const [s, leadsRows] = await Promise.all([api('/pipeline/stats'), api('/leads')]);
  const b = s.by_stage;
  const max = Math.max(s.total, 1);
  $('#main').innerHTML = `
    <div class="head"><div><h1>Sales pipeline</h1><p class="sub">From first inquiry to signed customer</p></div>
      <div class="row"><button class="btn primary" onclick="leadForm()">${icon('plus', 13)} New lead</button></div></div>
    <div class="kpis">
      <div class="kpi blue"><div class="num">${s.total}</div><div class="lbl">${icon('target', 13)} Leads captured</div></div>
      <div class="kpi green"><div class="num">${s.lead_to_customer_pct}%</div><div class="lbl">${icon('checkCircle', 13)} Lead → customer</div></div>
      <div class="kpi ${s.quote_within_24h_pct >= 90 ? 'green' : 'amber'}"><div class="num">${s.quote_within_24h_pct}%</div><div class="lbl">${icon('clock', 13)} Quotes sent within 24 h · target 90%</div></div>
      <div class="kpi violet"><div class="num" style="font-size:24px">${AED(s.pipeline_value)}</div><div class="lbl">${icon('fileText', 13)} Open quote value</div></div>
      <div class="kpi"><div class="num" style="font-size:24px">${AED(s.won_value)}</div><div class="lbl">${icon('wallet', 13)} Won quote value</div></div>
    </div>
    <div class="grid3">
      <div class="card"><h3>${icon('funnel', 15)} Conversion funnel</h3>
        <div class="funnel">
          <div class="fstep"><span>Leads</span><div class="bar" style="width:100%">${s.total}</div><span class="pc">100%</span></div>
          <div class="fstep"><span>Quoted</span><div class="bar" style="width:${Math.max(8, 100 * s.quoted / max)}%">${s.quoted}</div><span class="pc">${s.lead_to_quote_pct}%</span></div>
          <div class="fstep"><span>Customers</span><div class="bar" style="width:${Math.max(8, 100 * s.won / max)}%">${s.won}</div><span class="pc">${s.lead_to_customer_pct}%</span></div>
        </div>
        <p class="muted small" style="margin-top:12px">Quote → customer: <b>${s.quote_to_customer_pct}%</b> · Lost: <b>${b.lost}</b></p>
      </div>
      <div class="card"><h3>${icon('chart', 15)} Leads by source</h3><div class="chartbox" style="height:200px"><canvas id="c-src"></canvas></div></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>${icon('calendar', 15)} Follow-ups due</h3>
        ${s.follow_ups.length ? `<table>${s.follow_ups.map(f => `<tr style="cursor:pointer" onclick="leadDetail(${f.id})"><td><b>${esc(f.company || f.contact)}</b><br><span class="muted small">${esc(f.contact)}</span></td>
          <td><span class="pill ${f.stage}">${STAGE_LABEL[f.stage]}</span></td><td class="small ${f.follow_up_at < new Date().toISOString() ? '' : 'muted'}" style="${f.follow_up_at < new Date().toISOString() ? 'color:var(--amber);font-weight:700' : ''}">${String(f.follow_up_at).replace('T', ' ').slice(0, 16)}</td></tr>`).join('')}</table>` : '<p class="empty">No follow-ups scheduled.</p>'}
      </div>
      <div class="card"><h3>${icon('list', 15)} Stage counts</h3>
        <table>${Object.entries(b).map(([k, v]) => `<tr><td><span class="pill ${k}">${STAGE_LABEL[k]}</span></td><td class="r"><b>${v}</b></td></tr>`).join('')}</table>
        <button class="btn ghost small" style="margin-top:10px" onclick="nav('leads')">Open lead board</button></div>
    </div>`;
  if (s.sources.length) _charts.push(new Chart($('#c-src'), {
    type: 'doughnut',
    data: { labels: s.sources.map(x => x.source), datasets: [{ data: s.sources.map(x => x.c), backgroundColor: ['#2ee6a6', '#5ce1e6', '#7cc8ff', '#b9a8ff', '#ffd166', '#ff6b6b', '#94a3b8'], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '64%', plugins: { legend: { position: 'right', labels: { color: '#93b3aa', boxWidth: 10 } } } },
  }));
  void leadsRows;
}

// ═══════════════════ LEADS (CRM-09) — kanban ═════════════════
let _leads = [];
async function leads() {
  _leads = await api('/leads');
  await services();
  const lanes = Object.keys(STAGE_LABEL);
  $('#main').innerHTML = `
    <div class="head"><div><h1>Leads</h1><p class="sub">Drag a card to move its stage. A lead becomes Won when its accepted quote is converted.</p></div>
      <div class="row"><input id="lead-q" placeholder="Search name, company, phone" style="width:240px" oninput="leadFilter()"><button class="btn primary" onclick="leadForm()">${icon('plus', 13)} New lead</button></div></div>
    <div class="kanban">${lanes.map(st => `
      <div class="lane" data-stage="${st}" ondragover="event.preventDefault();this.classList.add('drop')" ondragleave="this.classList.remove('drop')" ondrop="leadDrop(event,'${st}')">
        <h4>${STAGE_LABEL[st]} <span>${_leads.filter(l => l.stage === st).length}</span></h4>
        <div class="lane-body">${_leads.filter(l => l.stage === st).map(leadCard).join('') || '<p class="muted small">—</p>'}</div>
      </div>`).join('')}</div>`;
}
function leadCard(l) {
  const late = l.overdue_follow_up;
  return `<div class="lead-card" draggable="true" data-search="${esc((l.contact + ' ' + l.company + ' ' + l.phone).toLowerCase())}" ondragstart="event.dataTransfer.setData('id','${l.id}')" onclick="leadDetail(${l.id})">
    <b>${esc(l.company || l.contact)}</b>
    <div class="meta">${esc(l.contact)} · ${esc(svcName(l.service_type))}</div>
    <div class="meta">${l.sites.length} site${l.sites.length === 1 ? '' : 's'} · ${esc(l.source || '')}${l.last_quote_total ? ' · ' + AED(l.last_quote_total) : ''}</div>
    ${l.follow_up_at && !['won', 'lost'].includes(l.stage) ? `<div class="fu ${late ? 'late' : ''}">${icon('clock', 11)} ${late ? 'Overdue ' : ''}follow-up ${String(l.follow_up_at).replace('T', ' ').slice(0, 16)}</div>` : ''}
  </div>`;
}
function leadFilter() {
  const t = $('#lead-q').value.toLowerCase();
  document.querySelectorAll('.lead-card').forEach(c => c.style.display = c.dataset.search.includes(t) ? '' : 'none');
}
async function leadDrop(e, stage) {
  e.preventDefault();
  document.querySelectorAll('.lane').forEach(l => l.classList.remove('drop'));
  const id = Number(e.dataTransfer.getData('id'));
  const l = _leads.find(x => x.id === id);
  if (!l || l.stage === stage) return;
  if (stage === 'lost') { const reason = prompt('Reason the lead was lost?', 'Price'); if (reason === null) return; l.lost_reason = reason; }
  try { await api('/leads/' + id, { method: 'PUT', body: { stage, lost_reason: l.lost_reason } }); toast(`${l.company || l.contact} → ${STAGE_LABEL[stage]}`); }
  catch (err) { toast(err.message, 'critical'); }
  leads();
}
function siteRow(s = {}) {
  return `<div class="site-row">
    <input class="s-name" placeholder="Site / branch" value="${esc(s.name || '')}">
    <input class="s-zone" placeholder="Zone" value="${esc(s.zone || '')}">
    <input class="s-lat" placeholder="Lat" type="number" step="any" value="${s.lat ?? ''}">
    <input class="s-lng" placeholder="Lng" type="number" step="any" value="${s.lng ?? ''}">
    <input class="s-addr" placeholder="Address / access notes" value="${esc(s.address || '')}">
    <button class="btn ghost small" type="button" onclick="this.parentElement.remove()" aria-label="Remove site">${icon('x', 12)}</button></div>`;
}
async function leadForm(l = {}) {
  await services();
  const sites = l.sites && l.sites.length ? l.sites : [{}];
  openModal(`
    <h3>${l.id ? 'Edit lead' : 'New lead'}</h3>
    <div class="fgrid">
      ${field('Contact name *', `<input id="l-contact" value="${esc(l.contact || '')}">`)}
      ${field('Company', `<input id="l-company" value="${esc(l.company || '')}">`)}
      ${field('Mobile number *', GLPhone.html('l-phone', l.phone))}
      ${field('Email (quotations are sent here)', `<input id="l-email" type="email" inputmode="email" autocomplete="off" value="${esc(l.email || '')}" placeholder="name@company.ae" onblur="leadCheck(${l.id || 'null'})">`)}
      ${field('Service type', `<select id="l-svc">${_services.map(s => `<option value="${s.code}" ${l.service_type === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`)}
      ${field('How often', freqControl(parseFreq(l.frequency) || { unit: 'weekly', count: 1 }, 'l-freq'))}
      ${field('Source', `<select id="l-src">${SOURCES.map(s => `<option ${l.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
      ${field('Follow-up', `<input id="l-fu" type="datetime-local" value="${l.follow_up_at ? String(l.follow_up_at).slice(0, 16) : ''}">`)}
    </div>
    <div class="field"><label>Sites — enter coordinates once (copy from Google Maps "What's here?"); no map API is used</label>
      <div id="l-sites">${sites.map(siteRow).join('')}</div>
      <button class="btn ghost small" type="button" onclick="document.getElementById('l-sites').insertAdjacentHTML('beforeend', siteRow())">${icon('plus', 12)} Add site</button></div>
    ${field('Notes', `<textarea id="l-notes">${esc(l.notes || '')}</textarea>`)}
    <div id="m-dup"></div>
    <button class="btn primary full" onclick="saveLead(${l.id || 'null'})">Save lead</button>
    <p id="m-err" class="err"></p>`, true);
  $('#l-phone').addEventListener('blur', () => leadCheck(l.id || null));
}
// tells the user while they type that a mobile number / email is already in the CRM
async function leadCheck(id) {
  const box = $('#m-dup'); if (!box) return;
  const ph = GLPhone.read('l-phone'), email = ($('#l-email').value || '').trim();
  if (!ph.ok || (ph.empty && !email)) { box.innerHTML = ''; return; }
  try {
    const r = await api(`/contacts/check?lead_id=${id || ''}${ph.empty ? '' : '&phone=' + encodeURIComponent(ph.e164)}${email ? '&email=' + encodeURIComponent(email) : ''}`);
    if (!$('#m-dup')) return;
    box.innerHTML = r.duplicate ? duplicateBox({ message: r.duplicate.message, data: { duplicate: r.duplicate } }) : r.error && r.field === 'email' ? `<div class="dupbox"><p>${esc(r.error)}</p></div>` : '';
  } catch { /* the save itself still checks */ }
}
async function saveLead(id) {
  const sites = [...document.querySelectorAll('#l-sites .site-row')].map(r => ({
    name: r.querySelector('.s-name').value.trim(), zone: r.querySelector('.s-zone').value.trim(),
    lat: r.querySelector('.s-lat').value === '' ? '' : Number(r.querySelector('.s-lat').value),
    lng: r.querySelector('.s-lng').value === '' ? '' : Number(r.querySelector('.s-lng').value),
    address: r.querySelector('.s-addr').value.trim(),
  })).filter(s => s.name || s.address);
  const fu = $('#l-fu').value;
  $('#m-err').textContent = '';
  const ph = GLPhone.read('l-phone');
  if (!ph.ok) { $('#m-err').textContent = ph.error; $('#l-phone').focus(); return; }
  const fq = fqRead($('#l-freq'));
  const body = { contact: $('#l-contact').value.trim(), company: $('#l-company').value.trim(), phone: ph.e164, email: $('#l-email').value.trim(),
    service_type: $('#l-svc').value, frequency: `${fq.unit}:${fq.count}`, source: $('#l-src').value, follow_up_at: fu ? new Date(fu).toISOString() : null, notes: $('#l-notes').value, sites };
  try {
    const r = await api(id ? '/leads/' + id : '/leads', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast('Lead saved', 'success'); if (!id) leadDetail(r.id); else if (currentPage === 'leads') leads();
  } catch (e) {
    if (e.data && e.data.duplicate) $('#m-dup').innerHTML = duplicateBox(e);
    else $('#m-err').textContent = e.message;
  }
}
async function leadDetail(id) {
  await services();
  const l = await api('/leads/' + id);
  const wa = `https://wa.me/${String(l.phone || '').replace(/[^\d]/g, '')}`;
  openModal(`
    <div class="row spread"><h3 style="margin:0">${esc(l.company || l.contact)}</h3><span class="pill ${l.stage}">${STAGE_LABEL[l.stage]}</span></div>
    <div class="kv" style="margin:14px 0">
      <span>Contact</span><div>${esc(l.contact)}</div>
      <span>Mobile</span><div>${esc(GLPhone.format(l.phone)) || '—'}</div>
      <span>Email</span><div>${esc(l.email || '—')}</div>
      <span>Service</span><div>${esc(svcName(l.service_type))}, ${esc(freqText(l.frequency)).toLowerCase()}</div>
      <span>Source</span><div>${esc(l.source)}</div>
      <span>Sites</span><div>${l.sites.map(s => `${esc(s.name)} <span class="zone-tag">${esc(s.zone || '?')}</span> <span class="muted small">${s.lat !== '' && s.lat != null ? s.lat + ', ' + s.lng : 'no coordinates'}</span>`).join('<br>') || '—'}</div>
      ${l.notes ? `<span>Notes</span><div>${esc(l.notes)}</div>` : ''}
      ${l.lost_reason ? `<span>Lost reason</span><div>${esc(l.lost_reason)}</div>` : ''}
    </div>
    <div class="row" style="margin-bottom:14px">
      ${l.stage !== 'won' ? `<button class="btn primary" onclick='closeModal();quoteForm({ lead_id: ${l.id} })'>${icon('fileText', 13)} New quotation</button>` : `<button class="btn primary" onclick="closeModal();customer360(${l.customer_id})">Open customer 360</button>`}
      <a class="btn wa" href="${wa}" target="_blank" rel="noopener">${icon('phone', 13)} WhatsApp</a>
      <button class="btn ghost" onclick='leadForm(${jsonAttr(l)})'>Edit</button>
      ${l.stage === 'new' ? `<button class="btn ghost" onclick="leadStage(${l.id},'contacted')">Mark contacted</button>` : ''}
    </div>
    <h3 style="font-size:14px">Quotations</h3>
    ${l.quotations.length ? `<table>${l.quotations.map(q => `<tr><td><b>${esc(q.number)}</b> v${q.version}</td><td>${AED(q.total)}</td><td><span class="pill ${q.status}">${q.status}</span></td>
      <td class="r"><button class="btn ghost small" onclick="closeModal();quoteDetail(${q.id})">Open</button></td></tr>`).join('')}</table>` : '<p class="empty">No quotations yet.</p>'}`, true);
}
async function leadStage(id, stage) { await api('/leads/' + id, { method: 'PUT', body: { stage } }); toast('Stage updated'); leadDetail(id); if (currentPage === 'leads') leads(); }

// ═══════════════════ QUOTATIONS (CRM-10/11/12) ═══════════════
// Gmail connection notice shown wherever quotations are sent from
function mailBanner(m) {
  if (!m) return '';
  return m.configured
    ? `<div class="banner ok">${icon('mail', 16)}<div>Email connected — quotations are emailed from <b>${esc(m.sender || 'your account')}</b> (${esc(m.provider || (m.mode === 'api' ? 'Gmail API' : 'Gmail SMTP'))}).${m.note ? '<br><b>' + esc(m.note) + '</b>' : ''}</div></div>`
    : `<div class="banner">${icon('mail', 16)}<div><b>Gmail is not connected on the server yet.</b> After the preview, Send opens the message in your own Gmail for you to send. To send straight from here, add a Gmail account in the server settings (README, Gmail section).</div></div>`;
}
let quoteFilter = 'all';
async function quotations() {
  const [rows, mail] = await Promise.all([api('/quotations'), api('/mail/status').catch(() => null)]);
  const by = st => rows.filter(q => q.status === st);
  const open = rows.filter(q => ['draft', 'sent'].includes(q.status));
  const stages = [
    ['draft', 'Send by Gmail', by('draft').length, by('draft').length === 1 ? 'draft to preview and send' : 'drafts to preview and send'],
    ['sent', 'Waiting for the customer', by('sent').length, `${AED(by('sent').reduce((a, q) => a + q.total, 0))} quoted`],
    ['accepted', 'Approve and register', by('accepted').length, 'accepted, ready to become customers'],
    ['converted', 'Invoiced in the customer app', by('converted').length, 'registered customers'],
  ];
  const shown = quoteFilter === 'all' ? rows : rows.filter(q => q.status === quoteFilter);
  $('#main').innerHTML = `
    <div class="head"><div><h1>Quotations</h1><p class="sub">Priced from how often each service happens. Every email is previewed before it goes to the customer.</p></div>
      <button class="btn primary" onclick="pickLeadForQuote()">${icon('plus', 13)} New quotation</button></div>
    <div class="qpipe" role="tablist" aria-label="Quotation stage">${stages.map(([st, label, n, sub]) => `
      <button role="tab" aria-selected="${quoteFilter === st}" class="${quoteFilter === st ? 'on' : ''}" onclick="quoteFilter=quoteFilter==='${st}'?'all':'${st}';quotations()">
        <span class="n">${n}</span><span class="l">${label}</span><span class="s">${sub}</span></button>`).join('')}</div>
    ${mail && !mail.configured ? mailBanner(mail) : ''}
    <div class="card qlist">${shown.length ? shown.map(q => `
      <div class="qrow" onclick="quoteDetail(${q.id})" tabindex="0" onkeydown="if(event.key==='Enter')quoteDetail(${q.id})">
        <div class="who"><b>${esc(q.lead?.company || q.lead?.contact || 'No lead')}</b>
          <span>${esc(q.number)}${q.version > 1 ? ', version ' + q.version : ''} for ${esc(q.lead?.contact || '—')}</span></div>
        <div class="what">${q.items.slice(0, 2).map(i => `<span>${esc(i.description || svcName(i.service_code))}${i.frequency ? ', ' + esc(i.frequency).toLowerCase() : ''}</span>`).join('')}${q.items.length > 2 ? `<span>and ${q.items.length - 2} more</span>` : ''}</div>
        <div class="when">${q.sent_at ? `Sent ${dmy(q.sent_at)}${q.sent_to ? '<span>' + esc(q.sent_to) + '</span>' : ''}` : 'Not sent yet'}<span>Valid until ${dmy(q.valid_until)}</span></div>
        <div class="amt"><b>${AED(q.total)}</b><span>${q.items.every(i => i.freq_unit) ? 'a month, with VAT' : 'with VAT'}</span></div>
        <div class="st"><span class="pill ${q.status}">${q.status}</span>
          ${q.status === 'draft' ? `<button class="btn primary small" onclick="event.stopPropagation();sendQuoteForm(${q.id})">Preview and send</button>` : ''}
          ${q.status === 'accepted' ? `<button class="btn primary small" onclick="event.stopPropagation();convertQuote(${q.id})">Register customer</button>` : ''}</div>
      </div>`).join('') : `<p class="empty">${rows.length ? 'No quotations at this stage.' : 'No quotations yet. Create one from a lead.'}</p>`}</div>
    <p class="muted small" style="margin-top:10px">${open.length} open, worth ${AED(open.reduce((a, q) => a + q.total, 0))}. Dates are day/month/year.</p>`;
}
async function pickLeadForQuote() {
  const ls = (await api('/leads')).filter(l => !['won', 'lost'].includes(l.stage));
  if (!ls.length) { toast('Create a lead first'); return leadForm(); }
  openModal(`<h3>Quotation for which lead?</h3>
    ${field('Lead', `<select id="pick-lead">${ls.map(l => `<option value="${l.id}">${esc(l.company || l.contact)} — ${esc(l.contact)}</option>`).join('')}</select>`)}
    <button class="btn primary full" onclick="const v=+document.getElementById('pick-lead').value;quoteForm({ lead_id: v })">Continue</button>`);
}
// One priced line: what, where, how often → visits a month × price a visit.
function qbRow(it = {}) {
  const f = it.freq_unit ? { unit: it.freq_unit, count: it.freq_count } : it.qty ? freqFromVisits(it.qty) : { unit: 'weekly', count: 1 };
  return `<div class="qline">
    <div class="ql-what">
      <select class="qi-svc" aria-label="Service" onchange="qbPrice(this)">${_services.map(s => `<option value="${s.code}" data-price="${s.default_price}" ${it.service_code === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <input class="qi-desc" value="${esc(it.description || '')}" placeholder="Description on the quotation" aria-label="Description">
      <input class="qi-site" value="${esc(it.site || '')}" placeholder="All sites" aria-label="Site">
      <button class="btn ghost small ql-x" type="button" onclick="qbRemove(this)" aria-label="Remove line">${icon('x', 12)}</button>
    </div>
    <div class="ql-price">
      ${freqControl(f)}
      <span class="ql-eq"><b class="qi-visits">—</b> a month</span>
      <label class="ql-unit"><span>AED a visit</span><input class="qi-unit" type="number" min="0" step="0.01" inputmode="decimal" value="${it.unit_price ?? _services[0].default_price}" oninput="qbCalc()"></label>
      <span class="ql-total"><span>a month</span><b class="qi-line">—</b></span>
    </div></div>`;
}
function qbRemove(btn) {
  if (document.querySelectorAll('#qb-body .qline').length < 2) return toast('A quotation needs at least one line', 'warning');
  btn.closest('.qline').remove(); qbCalc();
}
function qbPrice(sel) { const ln = sel.closest('.qline'); ln.querySelector('.qi-unit').value = sel.selectedOptions[0].dataset.price; if (!ln.querySelector('.qi-desc').value) ln.querySelector('.qi-desc').value = sel.selectedOptions[0].textContent; qbCalc(); }
function qbItems() {
  return [...document.querySelectorAll('#qb-body .qline')].map(ln => { const f = fqRead(ln.querySelector('.freq')); return { service_code: ln.querySelector('.qi-svc').value, description: ln.querySelector('.qi-desc').value,
    site: ln.querySelector('.qi-site').value, freq_unit: f.unit, freq_count: f.count, unit_price: Number(ln.querySelector('.qi-unit').value) }; });
}
function qbCalc() {
  let sub = 0;
  document.querySelectorAll('#qb-body .qline').forEach(ln => {
    const f = fqRead(ln.querySelector('.freq')), visits = visitsPerMonth(f.unit, f.count);
    const v = Math.round(visits * (Number(ln.querySelector('.qi-unit').value) || 0) * 100) / 100;
    sub += v;
    ln.querySelector('.qi-visits').textContent = `${visits} visit${visits === 1 ? '' : 's'}`;
    ln.querySelector('.qi-line').textContent = AED(v);
  });
  const vat = Math.round(sub * 5) / 100;
  $('#qb-sub').textContent = AED(sub); $('#qb-vat').textContent = AED(vat); $('#qb-tot').textContent = AED(sub + vat);
}
// The visit days follow the first line; ticking different days updates that line's frequency.
const SPREAD_DAYS = { 1: [1], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4], 6: [6, 0, 1, 2, 3, 4], 7: [0, 1, 2, 3, 4, 5, 6] };
function qbPlanFromLine() {
  const first = document.querySelector('#qb-body .qline .freq'); if (!first || !$('#rc-type')) return;
  const f = fqRead(first);
  $('#rc-type').value = f.unit;
  if (f.unit === 'daily') $('#rc-wd').checked = false;
  if (f.unit === 'weekly' && document.querySelectorAll('.rc-day:checked').length !== f.count)
    document.querySelectorAll('.rc-day').forEach(c => { c.checked = SPREAD_DAYS[f.count].includes(Number(c.value)); });
  rcToggle();
}
function qbLineFromPlan() {
  const first = document.querySelector('#qb-body .qline .freq'); if (!first || !$('#rc-type')) return;
  const t = $('#rc-type').value, cur = fqRead(first);
  if (t === 'daily' && $('#rc-wd').checked) {
    // Monday to Friday is five visits a week, and is priced as that
    $('#rc-type').value = 'weekly'; $('#rc-wd').checked = false;
    document.querySelectorAll('.rc-day').forEach(c => { c.checked = [1, 2, 3, 4, 5].includes(Number(c.value)); });
    rcToggle(); fqSet(first, 'weekly', 5);
    toast('Monday to Friday is priced as 5 times a week', 'info');
  } else if (t === 'daily') fqSet(first, 'daily', cur.unit === 'daily' ? cur.count : 1);
  else if (t === 'weekly') { const n = document.querySelectorAll('.rc-day:checked').length; if (n) fqSet(first, 'weekly', n); }
  else if (cur.unit !== 'monthly') fqSet(first, 'monthly', 1);
  qbCalc();
}
document.addEventListener('change', e => { if (document.getElementById('qb-body') && e.target.matches && e.target.matches('#rc-type, .rc-day, #rc-wd')) qbLineFromPlan(); });

async function quoteForm(q = {}) {
  await services();
  const lead = await api('/leads/' + q.lead_id);
  const want = parseFreq(lead.frequency) || { unit: 'weekly', count: 1 };
  const items = q.items && q.items.length ? q.items : [{ service_code: lead.service_type, description: svcName(lead.service_type), freq_unit: want.unit, freq_count: want.count, unit_price: (_services.find(s => s.code === lead.service_type) || _services[0]).default_price }];
  const plan = q.plan || {};
  openModal(`
    <h3>${q.revise_of ? `Revise ${esc(q.number)}` : 'New quotation'} <span class="muted small">for ${esc(lead.company || lead.contact)}</span></h3>
    <p class="muted small" style="margin:-8px 0 12px">Choose how often each service happens. The visits a month and the price are worked out for you.</p>
    <div id="qb-body">${items.map(qbRow).join('')}</div>
    <button class="btn ghost small" type="button" onclick="document.getElementById('qb-body').insertAdjacentHTML('beforeend', qbRow());qbCalc()">${icon('plus', 12)} Add a service</button>
    <table class="qtot"><tr><td>Subtotal a month</td><td class="r" id="qb-sub">—</td></tr><tr><td>VAT 5%</td><td class="r" id="qb-vat">—</td></tr><tr class="g"><td>Total a month</td><td class="r" id="qb-tot">—</td></tr></table>
    <h3 style="font-size:14px;margin-top:6px">${icon('repeat', 14)} Visit days</h3>
    <p class="muted small" style="margin:-8px 0 10px">Follows the first service above. Any other service is scheduled from its own frequency when the customer is registered.</p>
    ${recurrenceFields(plan.recurrence || { type: 'weekly', days: SPREAD_DAYS[1] }, plan.time_window)}
    <div class="fgrid">
      ${field('Start date', `<input id="qb-start" type="date" value="${plan.start_date || ''}">`)}
      ${field('Billing', `<select id="qb-bill"><option value="monthly" ${plan.billing !== 'per_visit' ? 'selected' : ''}>One invoice a month</option><option value="per_visit" ${plan.billing === 'per_visit' ? 'selected' : ''}>An invoice after each visit</option></select>`)}
      ${field('Valid until (30 days if left empty)', `<input id="qb-valid" type="date" min="${today()}">`)}
    </div>
    ${field('Notes or terms shown on the quotation', `<textarea id="qb-notes">${esc(q.notes || '')}</textarea>`)}
    <button class="btn primary full" onclick="saveQuote(${q.lead_id}, ${q.revise_of || 'null'})">${q.revise_of ? 'Save new version' : 'Create quotation'}</button>
    <p id="m-err" class="err"></p>`, true);
  if (!q.plan) qbPlanFromLine();
  qbCalc();
}
async function saveQuote(leadId, reviseOf) {
  const rc = readRecurrence();
  const body = { lead_id: leadId, revise_of: reviseOf, items: qbItems(), notes: $('#qb-notes').value, valid_until: $('#qb-valid').value || undefined,
    plan: { recurrence: rc.rule, time_window: rc.time_window, start_date: $('#qb-start').value || null, billing: $('#qb-bill').value } };
  try { const r = await api('/quotations', { method: 'POST', body }); closeModal(); toast(`Quotation ${r.number} created. Preview it before sending.`, 'success'); quoteDetail(r.id); if (currentPage === 'quotations') quotations(); }
  catch (e) { $('#m-err').textContent = e.message; }
}
// Fit an iframe to the document inside it (same origin, no scripts run in it).
function fitFrame(f) { try { f.style.height = Math.max(240, f.contentDocument.documentElement.scrollHeight + 2) + 'px'; } catch { f.style.height = '640px'; } }
// The quotation as the customer sees it, beside what can be done with it.
async function quoteDetail(id) {
  const q = await api('/quotations/' + id);
  const editable = ['draft', 'sent'].includes(q.status);
  const docUrl = `${API}/quotations/${q.id}/pdf?embed=1&t=${encodeURIComponent(token)}`;
  const sent = q.sent_at ? `Sent by ${({ gmail: 'Gmail', whatsapp: 'WhatsApp', pdf: 'PDF' })[q.sent_via] || esc(q.sent_via)} on ${dmyTime(q.sent_at)}${q.sent_to ? ' to ' + esc(q.sent_to) : ''}.` : 'Not sent to the customer yet.';
  openModal(`
    <div class="qdetail">
      <div class="paper"><iframe title="Quotation ${esc(q.number)} as the customer sees it" src="${docUrl}" sandbox="allow-same-origin" onload="fitFrame(this)"></iframe></div>
      <aside class="rail">
        <h3>${esc(q.number)}</h3>
        <p class="rail-st"><span class="pill ${q.status}">${q.status}</span>${q.version > 1 ? ` <span class="muted small">version ${q.version}</span>` : ''}</p>
        <p class="muted small">${sent}</p>
        ${q.lead && !q.lead.email && editable ? `<p class="small" style="color:var(--amber)">This lead has no email yet. You can type one when you send.</p>` : ''}
        <div class="rail-acts">
          ${editable ? `<button class="btn primary" onclick="sendQuoteForm(${q.id})">${icon('mail', 13)} ${q.sent_at ? 'Preview and resend' : 'Preview and send'}</button>` : ''}
          ${q.status === 'accepted' ? `<button class="btn primary" onclick="convertQuote(${q.id})">${icon('userCheck', 13)} Register customer</button>` : ''}
          ${editable || q.status === 'expired' ? `<button class="btn ghost" onclick='quoteForm(${jsonAttr({ lead_id: q.lead_id, revise_of: q.id, number: q.number, items: q.items, plan: q.plan, notes: q.notes })})'>${icon('edit', 13)} Revise</button>` : ''}
          <button class="btn ghost" onclick="openDoc('/quotations/${q.id}/pdf?print=1')">${icon('download', 13)} Save as PDF</button>
          ${editable ? `<button class="btn ghost" onclick="quoteStatus(${q.id},'accepted')">Mark accepted</button><button class="btn ghost" onclick="quoteStatus(${q.id},'rejected')">Mark rejected</button>` : ''}
        </div>
        ${q.versions.length > 1 ? `<p class="muted small rail-v">Versions<br>${q.versions.map(v => `<a href="#" onclick="quoteDetail(${v.id});return false">${v.version === q.version ? '<b>' : ''}v${v.version}, ${AED(v.total)}, ${v.status}${v.version === q.version ? '</b>' : ''}</a>`).join('<br>')}</p>` : ''}
        <button class="btn ghost rail-close" onclick="closeModal()">Close</button>
      </aside>
    </div>`, 'xl');
}

// STEP 1. Nothing is emailed until the sender has seen the exact message and confirmed it.
let _pv = null;   // the preview currently on screen: { id, to, token, delivery }
async function sendQuoteForm(id) {
  const q = await api('/quotations/' + id);
  _pv = null;
  openModal(`
    <div class="pv">
      <div class="pv-head"><h3>Preview before sending</h3>
        <p class="muted small">${esc(q.number)} for ${esc(q.lead?.company || q.lead?.contact || '')}. This is exactly what the customer receives.</p></div>
      <div class="pv-to"><label for="sq-to">Send to</label>
        <input id="sq-to" type="email" inputmode="email" autocomplete="off" value="${esc(q.lead?.email || '')}" placeholder="name@company.ae" oninput="pvStale()" onkeydown="if(event.key==='Enter')loadPreview(${id})">
        <button class="btn ghost" id="pv-refresh" onclick="loadPreview(${id})">Show preview</button></div>
      <div id="pv-body"><p class="pv-empty">${q.lead?.email ? 'Loading the preview…' : 'Type the customer\'s email address, then choose Show preview.'}</p></div>
      <div class="pv-foot">
        <button class="btn primary" id="sq-go" disabled onclick="confirmSend(${id})">${icon('send', 13)} Send</button>
        <button class="btn ghost" onclick="quoteDetail(${id})">Back to the quotation</button>
        <button class="btn ghost pv-wa" onclick="sendQuoteWa(${id})" title="Gmail is the standard channel">Send on WhatsApp instead</button>
      </div>
      <p id="m-err" class="err"></p>
      <div id="pv-confirm" class="confirm hidden" role="alertdialog" aria-modal="true" aria-labelledby="pvc-t"></div>
    </div>`, 'xl');
  if (q.lead?.email) loadPreview(id); else $('#sq-to').focus();
}
// the recipient was edited after the preview was made → it has to be previewed again
function pvStale() {
  if (!_pv) return;
  const same = $('#sq-to').value.trim().toLowerCase() === _pv.to;
  $('#sq-go').disabled = !same;
  $('#pv-refresh').textContent = same ? 'Show preview' : 'Update preview';
  $('#pv-body').classList.toggle('stale', !same);
}
async function loadPreview(id) {
  $('#m-err').textContent = '';
  const to = $('#sq-to').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) { $('#m-err').textContent = 'Enter a valid email address for the customer'; $('#sq-to').focus(); return; }
  try {
    const p = await api(`/quotations/${id}/preview`, { method: 'POST', body: { base_url: location.origin, to } });
    _pv = { id, to: p.to, token: p.preview_token, delivery: p.delivery, subject: p.subject, total: p.quotation.total, number: p.quotation.number, customer: p.quotation.customer };
    const docUrl = `${API}/quotations/${id}/pdf?embed=1&t=${encodeURIComponent(token)}`;
    $('#pv-body').classList.remove('stale');
    $('#pv-body').innerHTML = `
      <div class="pv-tabs" role="tablist"><button role="tab" class="on" onclick="pvTab(this,'mail')">The email</button><button role="tab" onclick="pvTab(this,'doc')">The quotation it links to</button></div>
      <div id="pv-mail" class="mailframe">
        <dl><dt>From</dt><dd>${p.from ? esc(p.from_name) + ' &lt;' + esc(p.from) + '&gt;' : 'Your Gmail account'}</dd>
          <dt>To</dt><dd>${esc(p.to)}</dd>${p.reply_to ? `<dt>Reply to</dt><dd>${esc(p.reply_to)}</dd>` : ''}
          <dt>Subject</dt><dd><b>${esc(p.subject)}</b></dd></dl>
        ${p.delivery === 'compose' ? `<pre class="mailtext"></pre>` : `<iframe title="Email preview" sandbox="allow-same-origin" onload="fitFrame(this)"></iframe>`}
      </div>
      <div id="pv-doc" class="paper hidden"><iframe title="Quotation preview" data-src="${docUrl}" sandbox="allow-same-origin" onload="fitFrame(this)"></iframe></div>
      ${p.delivery === 'compose' ? `<p class="muted small" style="margin-top:8px">Gmail is not connected on the server, so Send opens this message in your own Gmail for you to send. It goes as plain text.</p>` : ''}`;
    if (p.delivery === 'compose') $('#pv-mail .mailtext').textContent = p.text;
    else $('#pv-mail iframe').srcdoc = p.html;
    $('#sq-go').disabled = false;
    $('#sq-go').innerHTML = `${icon('send', 13)} ${p.delivery === 'compose' ? 'Open in Gmail' : 'Send to ' + esc(p.to)}`;
    $('#pv-refresh').textContent = 'Show preview';
  } catch (e) { $('#m-err').textContent = e.message; }
}
function pvTab(btn, which) {
  btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  $('#pv-mail').classList.toggle('hidden', which !== 'mail'); $('#pv-doc').classList.toggle('hidden', which !== 'doc');
  const f = $('#pv-doc iframe'); if (which === 'doc' && !f.src) f.src = f.dataset.src;
}
// the confirmation alert: one last look at who gets what
function confirmSend(id) {
  if (!_pv || _pv.id !== id) return;
  const c = $('#pv-confirm');
  c.innerHTML = `<div class="confirm-card">
    <h3 id="pvc-t">Send this quotation?</h3>
    <dl><dt>To</dt><dd>${esc(_pv.to)}</dd><dt>Customer</dt><dd>${esc(_pv.customer || '—')}</dd><dt>Quotation</dt><dd>${esc(_pv.number)}, ${AED(_pv.total)} with VAT</dd></dl>
    <p class="muted small">${_pv.delivery === 'compose' ? 'Gmail opens with the message ready. It is logged as sent once Gmail opens.' : 'The customer gets the email you just previewed. This cannot be undone.'}</p>
    <div class="row"><button class="btn primary" id="pvc-yes" onclick="sendQuote(${id})">${_pv.delivery === 'compose' ? 'Open in Gmail' : 'Send now'}</button>
      <button class="btn ghost" onclick="document.getElementById('pv-confirm').classList.add('hidden')">Go back</button></div></div>`;
  c.classList.remove('hidden');
  $('#pvc-yes').focus();
}
async function sendQuote(id) {
  if (!_pv || _pv.id !== id) return;
  $('#m-err').textContent = '';
  const btn = $('#pvc-yes'); btn.disabled = true;
  // The no-setup fallback opens Gmail in a new tab. Browsers only allow that directly
  // inside the click, so the tab is reserved now and pointed at Gmail once the server answers.
  const tab = _pv.delivery === 'compose' ? window.open('about:blank', '_blank') : null;
  try {
    const r = await api(`/quotations/${id}/send`, { method: 'POST', body: { base_url: location.origin, to: _pv.to, via: 'gmail', preview_token: _pv.token } });
    if (r.delivery === 'compose') {
      if (tab) tab.location = r.gmail_compose_url;
      toast(tab ? `Gmail opened with the quotation for ${r.to}. Press Send there.` : 'Your browser blocked the Gmail tab. Allow pop-ups for this site, then preview and send again.', tab ? 'success' : 'warning');
    } else { if (tab) tab.close(); toast(`Quotation sent to ${r.to}`, 'success'); }
    _pv = null;
    quoteDetail(id);
    if (currentPage === 'quotations') quotations();
  } catch (e) {
    if (tab) tab.close();
    $('#pv-confirm').classList.add('hidden');
    // the server could not reach Gmail: say why, and offer to send the same message from the user's own Gmail
    if (e.data && e.data.gmail_compose_url && e.data.code !== 'PREVIEW_STALE') {
      $('#m-err').innerHTML = `${esc(e.message)}<br><button class="btn gmail small" style="margin-top:8px" onclick="sendQuoteCompose(${id})">${icon('mail', 13)} Open it in my Gmail instead</button>`;
    } else $('#m-err').textContent = e.message;
    if (e.data && e.data.code === 'PREVIEW_STALE') loadPreview(id);
  }
}
// Same previewed message, sent by hand from the user's Gmail tab (used when the server cannot reach Gmail).
async function sendQuoteCompose(id) {
  if (!_pv || _pv.id !== id) return;
  const tab = window.open('about:blank', '_blank');
  try {
    const r = await api(`/quotations/${id}/send`, { method: 'POST', body: { base_url: location.origin, to: _pv.to, via: 'gmail', preview_token: _pv.token, fallback: 'compose' } });
    if (tab) tab.location = r.gmail_compose_url;
    toast(tab ? `Gmail opened with the quotation for ${r.to}. Press Send there.` : 'Your browser blocked the Gmail tab. Allow pop-ups for this site and try again.', tab ? 'success' : 'warning');
    _pv = null; quoteDetail(id); if (currentPage === 'quotations') quotations();
  } catch (e) { if (tab) tab.close(); $('#m-err').textContent = e.message; }
}
async function sendQuoteWa(id) {
  try {
    const r = await api(`/quotations/${id}/send`, { method: 'POST', body: { base_url: location.origin, via: 'whatsapp' } });
    window.open(r.whatsapp_url, '_blank');
    toast('WhatsApp opened with the quotation summary and link. Logged as sent.', 'success');
    quoteDetail(id);
    if (currentPage === 'quotations') quotations();
  } catch (e) { $('#m-err').textContent = e.message; }
}
async function quoteStatus(id, status) {
  try { await api(`/quotations/${id}/status`, { method: 'POST', body: { status } }); toast('Quotation ' + status, status === 'accepted' ? 'success' : 'info'); quoteDetail(id); if (currentPage === 'quotations') quotations(); }
  catch (e) { toast(e.message, 'critical'); }
}
async function convertQuote(id) {
  if (!confirm('Create the customer, its sites, the recurring service plan and portal access now?')) return;
  try {
    const r = await api(`/quotations/${id}/convert`, { method: 'POST' });
    openModal(`<h3>${icon('checkCircle', 18)} Customer created</h3>
      <div class="kv"><span>Sites</span><div>${r.sites}</div><span>Service plans</span><div>${r.plans}</div><span>Jobs generated</span><div>${r.jobs_generated} (next 14 days)</div>
      <span>4-digit app code</span><div><b style="font-size:22px;letter-spacing:4px">${r.portal_code}</b><br><span class="muted small">Shown once. The customer signs in with their mobile number and this code, or with a one-time code sent to their email.</span></div></div>
      <div class="banner ${r.email.sent ? 'ok' : ''}" style="margin-top:14px">${icon('mail', 16)}<div>${r.email.sent ? `App access emailed to <b>${esc(r.email.to)}</b>.`
        : r.email.to ? `App access was <b>not emailed automatically</b>${r.email.error ? ' (' + esc(r.email.error) + ')' : ' (Gmail not connected)'} — use the button below.` : 'This customer has no email — share the code by phone or WhatsApp.'}
        <br>A welcome message is waiting in their app. Invoices will be delivered there with the PDF.</div></div>
      <div class="row" style="margin-top:12px">${!r.email.sent && r.email.gmail_compose_url ? `<a class="btn gmail" href="${esc(r.email.gmail_compose_url)}" target="_blank" rel="noopener">${icon('mail', 13)} Send app access via Gmail</a>` : ''}
      <a class="btn ghost" href="${r.whatsapp_url}" target="_blank" rel="noopener">WhatsApp</a>
      <button class="btn primary" onclick="closeModal();customer360(${r.customer_id})">Open customer 360</button></div>`);
    toast(`Customer registered — ${r.jobs_generated} job(s) scheduled`, 'success');
    if (currentPage === 'quotations') quotations();
  } catch (e) { toast(e.message, 'critical'); }
}

// ═══════════════════ CUSTOMER 360 (CRM-15) ═══════════════════
async function customer360(id) {
  const d = await api(`/customers/${id}/360`);
  currentPage = 'customers';
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === 'customers'));
  const c = d.customer, risk = d.risk.score;
  const rc = risk >= 50 ? 'var(--red)' : risk >= 25 ? 'var(--amber)' : 'var(--green)';
  const photos = d.visits.filter(v => v.photo_url);
  $('#main').innerHTML = `
    <p><a href="#" onclick="nav('customers');return false">${icon('list', 12)} Customers</a></p>
    <div class="card"><div class="hero360">
      <div class="risk" style="background:conic-gradient(${rc} ${risk * 3.6}deg, rgba(255,255,255,.08) 0);"><div style="position:absolute;inset:7px;border-radius:50%;background:rgba(6,26,23,.92)"></div><span style="color:${rc}">${risk}</span><small>risk</small></div>
      <div style="flex:1;min-width:220px"><h1>${esc(c.name)}</h1><p class="muted">${esc(c.branch || '')} · <span class="zone-tag">${esc(c.zone)}</span> · ${esc(c.contact_phone || '')} ${esc(c.email || '')}</p>
        <p class="small muted" style="margin-top:4px">Completion (90 d): <b>${d.risk.completion_90d ?? '—'}%</b> · Confirmed no-pickups (30 d): <b>${d.risk.no_pickups_30d}</b> · Overdue: <b>${AED(d.risk.overdue)}</b></p></div>
      <div class="kpi ${d.balance > 0 ? 'amber' : 'green'}" style="min-width:170px"><div class="num" style="font-size:22px">${AED(d.balance)}</div><div class="lbl">Outstanding balance</div></div>
    </div>
    <div class="row" style="margin-top:14px">
      <a class="btn wa small" href="${d.whatsapp_url}" target="_blank" rel="noopener">${icon('phone', 12)} WhatsApp</a>
      <a class="btn ghost small" href="${d.maps_url}" target="_blank" rel="noopener">${icon('mapPin', 12)} Google Maps</a>
      <button class="btn ghost small" onclick="planForm({ customer_id: ${c.id} })">${icon('repeat', 12)} Add service plan</button>
      <button class="btn ghost small" onclick="adhocForm(null, ${c.id})">${icon('plus', 12)} Ad-hoc order</button>
      ${CRM_ROLE === 'owner' ? `<button class="btn ghost small" onclick="genInvoiceFor(${c.id})">${icon('wallet', 12)} Invoice this month</button><button class="btn ghost small" onclick="resetPortal(${c.id})">${icon('shield', 12)} Reset portal code</button>` : ''}
    </div></div>
    <div class="grid2">
      <div class="card"><h3>${icon('store', 15)} Sites (${d.sites.length})</h3><table>${d.sites.map(s => `<tr><td><b>${esc(s.branch || s.name)}</b><br><span class="muted small">${esc(s.address || '')}</span></td><td><span class="zone-tag">${esc(s.zone)}</span></td>
        <td class="r"><a class="btn ghost small" href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}" target="_blank" rel="noopener">Map</a></td></tr>`).join('')}</table></div>
      <div class="card"><h3>${icon('repeat', 15)} Service plans</h3>${d.plans.length ? `<table>${d.plans.map(p => `<tr><td><b>${esc(p.service_name || p.service_code)}</b><br><span class="muted small">${esc(p.rule_label)} · ${esc(p.time_window)}</span></td>
        <td class="small">${AED(p.unit_price)}/visit<br><span class="muted">${p.billing === 'per_visit' ? 'per visit' : 'monthly'}</span></td><td><span class="pill ${p.paused ? 'paused' : p.status}">${p.paused ? 'paused' : p.status}</span></td>
        <td class="r"><button class="btn ghost small" onclick='planForm(${jsonAttr(p)})'>Edit</button></td></tr>`).join('')}</table>` : '<p class="empty">No recurring plan — jobs come from the legacy monthly scheduler.</p>'}</div>
    </div>
    <div class="card"><h3>${icon('camera', 15)} Photo proof (${photos.length})</h3>
      ${photos.length ? `<div class="gallery">${photos.slice(0, 24).map(v => `<figure><img src="${v.photo_url}" alt="Visit ${v.scheduled_date}" onclick="viewPhoto('${v.photo_url}')"><figcaption>${v.scheduled_date} · ${esc(v.branch || '')} · ${v.status}</figcaption></figure>`).join('')}</div>` : '<p class="empty">No photos yet.</p>'}</div>
    <div class="grid2">
      <div class="card scroll-x"><h3>${icon('list', 15)} Visit history</h3><table><tr><th>Date</th><th>Site</th><th>Service</th><th>Driver</th><th>Status</th></tr>
        ${d.visits.slice(0, 30).map(v => `<tr><td class="small">${v.scheduled_date}</td><td class="small">${esc(v.branch || '')}</td><td class="small">${esc(v.service_type || 'WASTE')}</td><td class="small">${esc(v.driver || '—')}</td>
        <td><span class="pill ${v.status}">${v.status}</span>${v.confirmation_status ? ` <span class="pill ${v.confirmation_status}">${v.confirmation_status.replace('_', ' ')}</span>` : ''}</td></tr>`).join('')}</table></div>
      <div class="card scroll-x"><h3>${icon('wallet', 15)} Invoices & payments</h3>
        ${d.invoices.length ? `<table><tr><th>Invoice</th><th>Period</th><th class="r">Total</th><th class="r">Balance</th><th>Status</th><th></th></tr>${d.invoices.map(i => `<tr><td><b>${esc(i.number)}</b></td><td>${i.period}</td><td class="r">${AED(i.amount)}</td><td class="r">${AED(i.balance)}</td>
          <td><span class="pill ${i.status_label.split(' ')[0]}">${i.status_label}</span></td><td class="r" style="white-space:nowrap"><button class="btn ghost small" onclick="openDoc('/invoices/${i.id}/pdf')">View</button>${CRM_ROLE === 'owner' && i.balance > 0 && i.status_label !== 'Void' ? ` <button class="btn primary small" onclick='paymentForm(${jsonAttr({ id: i.id, number: i.number, balance: i.balance })})'>Pay</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="empty">No invoices yet.</p>'}
        ${d.payments.length ? `<p class="small muted" style="margin-top:10px">Payments: ${d.payments.slice(0, 6).map(p => `${dmy(p.received_at)} ${AED(p.amount)} (${p.method})`).join(' · ')}</p>` : ''}
      </div>
    </div>
    ${d.lead ? `<div class="card"><h3>${icon('target', 15)} Sales history</h3><p class="small">Lead from <b>${esc(d.lead.source)}</b>, created ${dmy(d.lead.created_at)} by contact ${esc(d.lead.contact)}. ${d.lead.notes ? '“' + esc(d.lead.notes) + '”' : ''}</p></div>` : ''}`;
}
async function genInvoiceFor(id) {
  const r = await api('/invoices/generate', { method: 'POST', body: { period: today().slice(0, 7), customer_id: id } });
  toast(r.created ? `Invoice ${r.invoices[0].number} issued` : 'No completed, uninvoiced visits this month'); customer360(id);
}
async function resetPortal(id) {
  if (!confirm('Issue a new portal code? The old one stops working.')) return;
  const r = await api(`/customers/${id}/portal-code`, { method: 'POST' });
  openModal(`<h3>New portal code</h3><p style="font-size:30px;font-weight:800;letter-spacing:6px">${r.portal_code}</p>
    <div class="row"><a class="btn wa" href="${r.whatsapp_url}" target="_blank" rel="noopener">Send on WhatsApp</a><button class="btn ghost" onclick="closeModal()">Close</button></div>`);
}

// ═══════════════════ SERVICE PLANS (§7) ══════════════════════
async function plans() {
  const rows = await api('/service-plans');
  await services();
  $('#main').innerHTML = `
    <div class="head"><div><h1>Service plans</h1><p class="sub">Recurring plans generate jobs 14 days ahead every night. UAE public holidays and pause dates are skipped; edits regenerate future pending jobs only.</p></div>
      <div class="row"><button class="btn ghost" onclick="genPlans()">${icon('refresh', 13)} Generate now</button><button class="btn primary" onclick="pickCustomerForPlan()">${icon('plus', 13)} New plan</button></div></div>
    <div class="card scroll-x">${rows.length ? `<table><tr><th>Customer / site</th><th>Service</th><th>Recurrence</th><th>Window</th><th>Period</th><th>Price</th><th>Status</th><th></th></tr>
    ${rows.map(p => `<tr><td><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.branch || '')} · ${esc(p.zone)}</span></td>
      <td><span class="pill ${p.category || 'waste'}">${esc(p.service_name || p.service_code)}</span></td><td class="small">${esc(p.rule_label)}</td><td class="small">${esc(p.time_window)}</td>
      <td class="small muted">${esc(p.start_date)} → ${esc(p.end_date || 'ongoing')}</td><td class="small">${AED(p.unit_price)}<br><span class="muted">${p.billing === 'per_visit' ? 'per visit' : 'monthly'}</span></td>
      <td><span class="pill ${p.paused ? 'paused' : esc(p.status)}">${p.paused ? 'paused' + (p.pause_to ? ' → ' + esc(p.pause_to) : '') : esc(p.status)}</span></td>
      <td class="r" style="white-space:nowrap"><button class="btn ghost small" onclick="planPause(${p.id}, ${p.paused ? 0 : 1})">${p.paused ? 'Resume' : 'Pause'}</button> <button class="btn ghost small" onclick='planForm(${jsonAttr(p)})'>Edit</button></td></tr>`).join('')}</table>`
    : '<p class="empty">No recurring plans yet — convert an accepted quotation or add one here.</p>'}</div>`;
}
async function pickCustomerForPlan() {
  const cs = (await api('/customers')).filter(c => c.is_active);
  openModal(`<h3>Plan for which customer site?</h3>${field('Customer', `<select id="pick-c">${cs.map(c => `<option value="${c.id}">${esc(c.name)} — ${esc(c.branch || '')}</option>`).join('')}</select>`)}
    <button class="btn primary full" onclick="planForm({ customer_id: +document.getElementById('pick-c').value })">Continue</button>`);
}
async function planForm(p = {}) {
  await services();
  const rule = typeof p.recurrence === 'string' ? JSON.parse(p.recurrence) : (p.recurrence || { type: 'weekly', days: [0, 3] });
  openModal(`
    <h3>${p.id ? 'Edit service plan' : 'New service plan'}${p.name ? ` <span class="muted small">${esc(p.name)} ${esc(p.branch || '')}</span>` : ''}</h3>
    <div class="fgrid">
      ${field('Service', `<select id="p-svc">${_services.map(s => `<option value="${s.code}" ${p.service_code === s.code ? 'selected' : ''}>${esc(s.name)} (${s.category})</option>`).join('')}</select>`)}
      ${field('Unit price AED (blank = catalogue)', `<input id="p-price" type="number" step="0.01" value="${p.unit_price ?? ''}">`)}
    </div>
    ${recurrenceFields(rule, p.time_window)}
    <div class="fgrid3">
      ${field('Start', `<input id="p-start" type="date" value="${p.start_date || today()}">`)}
      ${field('End (optional)', `<input id="p-end" type="date" value="${p.end_date || ''}">`)}
      ${field('Billing', `<select id="p-bill"><option value="monthly" ${p.billing !== 'per_visit' ? 'selected' : ''}>Monthly</option><option value="per_visit" ${p.billing === 'per_visit' ? 'selected' : ''}>Per visit</option></select>`)}
    </div>
    <div class="fgrid3">
      ${field('Paused', `<select id="p-paused"><option value="0">No</option><option value="1" ${p.paused ? 'selected' : ''}>Yes</option></select>`)}
      ${field('Pause from', `<input id="p-pf" type="date" value="${p.pause_from || ''}">`)}
      ${field('Pause until', `<input id="p-pt" type="date" value="${p.pause_to || ''}">`)}
    </div>
    ${p.id ? field('Plan status', `<select id="p-status"><option value="active">Active</option><option value="ended" ${p.status === 'ended' ? 'selected' : ''}>Ended</option></select>`) : ''}
    <button class="btn primary full" onclick="savePlan(${p.id || 'null'}, ${p.customer_id})">Save & regenerate jobs</button>
    <p id="m-err" class="err"></p>`, true);
}
async function savePlan(id, customerId) {
  const rc = readRecurrence();
  const body = { customer_id: customerId, service_code: $('#p-svc').value, unit_price: $('#p-price').value === '' ? null : Number($('#p-price').value),
    recurrence: rc.rule, time_window: rc.time_window, start_date: $('#p-start').value, end_date: $('#p-end').value || null, billing: $('#p-bill').value,
    paused: $('#p-paused').value === '1', pause_from: $('#p-pf').value || null, pause_to: $('#p-pt').value || null, status: $('#p-status') ? $('#p-status').value : 'active' };
  try {
    const r = await api(id ? '/service-plans/' + id : '/service-plans', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast(`Plan saved — ${r.removed || 0} future jobs replaced, ${r.created} generated`);
    currentPage === 'plans' ? plans() : customer360(customerId);
  } catch (e) { $('#m-err').textContent = e.message; }
}
async function planPause(id, paused) {
  await api('/service-plans/' + id, { method: 'PUT', body: { paused: !!paused, pause_from: paused ? today() : null, pause_to: null } });
  toast(paused ? 'Plan paused — future jobs removed' : 'Plan resumed — jobs regenerated'); plans();
}

// ═══════════════════ AD-HOC ORDER (CRM-04) ═══════════════════
async function adhocForm(date, customerId) {
  const [cs, vs] = await Promise.all([api('/customers'), api('/vehicles').catch(() => [])]);
  await services();
  openModal(`<h3>${icon('plus', 16)} Ad-hoc order</h3>
    ${field('Client', `<select id="ah-c">${cs.filter(c => c.is_active).map(c => `<option value="${c.id}" ${c.id === customerId ? 'selected' : ''}>${esc(c.name)} — ${esc(c.branch || '')} (${esc(c.zone)})</option>`).join('')}</select>`)}
    <div class="fgrid">
      ${field('Date', `<input id="ah-d" type="date" min="${today()}" value="${date && date >= today() ? date : today()}">`)}
      ${field('Service', `<select id="ah-s">${_services.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>`)}
      ${field('Vehicle', `<select id="ah-v"><option value="">Auto-allocate (zone + capacity)</option>${vs.filter(v => v.is_active).map(v => `<option value="${v.id}">${esc(v.fleet_number)} · ${esc(v.zone)}</option>`).join('')}</select>`)}
      ${field('Time window (optional)', `<input id="ah-w" placeholder="08:00-11:00">`)}
    </div>
    <button class="btn primary full" onclick="saveAdhoc()">Add to route</button><p id="m-err" class="err"></p>`);
}
async function saveAdhoc() {
  const body = { customer_id: Number($('#ah-c').value), date: $('#ah-d').value, service_code: $('#ah-s').value, vehicle_id: $('#ah-v').value ? Number($('#ah-v').value) : null, time_window: $('#ah-w').value.trim() || null };
  try { const r = await api('/pickups/adhoc', { method: 'POST', body }); closeModal(); toast(`Order added${r.vehicle ? ' to ' + r.vehicle : ' — not allocated, see alerts'}`); if (currentPage === 'ledger') ledger(body.date); }
  catch (e) { $('#m-err').textContent = e.message; }
}

// ═══════════════════ BOOKINGS (CUS-07) ═══════════════════════
async function bookings() {
  const rows = await api('/bookings');
  await services();
  $('#main').innerHTML = `
    <div class="head"><div><h1>One-off bookings</h1><p class="sub">Extra visits requested from the customer app. Confirming auto-allocates a vehicle within capacity.</p></div></div>
    <div class="card scroll-x">${rows.length ? `<table><tr><th>Requested</th><th>Customer</th><th>Service</th><th>Date</th><th>Window</th><th>Notes</th><th>Status</th><th></th></tr>
    ${rows.map(b => `<tr><td class="small muted">${String(b.created_at).slice(0, 16)}</td><td><b>${esc(b.name)}</b><br><span class="muted small">${esc(b.branch || '')}</span></td>
      <td><span class="pill ${svcCat(b.service_code)}">${esc(svcName(b.service_code))}</span></td><td>${b.date}</td><td class="small">${esc(b.time_window || 'any')}</td><td class="small">${esc(b.notes || '')}</td>
      <td><span class="pill ${b.status}">${b.status}</span></td>
      <td class="r" style="white-space:nowrap">${b.status === 'requested' ? `<button class="btn primary small" onclick="decideBooking(${b.id}, true)">Confirm</button> <button class="btn ghost small" onclick="decideBooking(${b.id}, false)">Decline</button>` : ''}</td></tr>`).join('')}</table>`
    : '<p class="empty">No booking requests.</p>'}</div>`;
}
async function decideBooking(id, approve) {
  const body = { approve };
  if (!approve) { const r = prompt('Reason shown to the customer', 'No capacity on that date — our team will call you.'); if (r === null) return; body.reason = r; }
  try { await api(`/bookings/${id}/decide`, { method: 'POST', body }); toast(approve ? 'Booking confirmed and allocated' : 'Booking declined'); bookings(); }
  catch (e) { toast(e.message, 'critical'); }
}

// ═══════════════════ NOT PICKED UP (§7, CUS-10) ══════════════
async function confirmations() {
  const rows = await api('/confirmations');
  const awaiting = rows.filter(r => r.confirmation_status === 'awaiting');
  const hoursLeft = d => Math.max(0, Math.round((new Date(d) - Date.now()) / 36e5));
  $('#main').innerHTML = `
    <div class="head"><div><h1>Not picked up</h1><p class="sub">A no-pickup is never final until the customer confirms. Disputes book a free revisit; silence for 24 h auto-confirms.</p></div></div>
    <div class="kpis">
      <div class="kpi amber"><div class="num">${awaiting.length}</div><div class="lbl">Awaiting customer</div></div>
      <div class="kpi red"><div class="num">${rows.filter(r => r.confirmation_status === 'disputed').length}</div><div class="lbl">Disputed</div></div>
      <div class="kpi green"><div class="num">${rows.filter(r => r.confirmation_status === 'confirmed').length}</div><div class="lbl">Confirmed by customer</div></div>
      <div class="kpi"><div class="num">${rows.filter(r => r.confirmation_status === 'auto_confirmed').length}</div><div class="lbl">Auto-confirmed (flagged)</div></div>
    </div>
    <div class="card scroll-x">${rows.length ? `<table><tr><th>Date</th><th>Customer</th><th>Reason</th><th>Driver</th><th>Photo</th><th>Status</th><th></th></tr>
    ${rows.map(r => `<tr><td class="small">${r.scheduled_date}</td><td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.branch || '')}</span></td>
      <td class="small">${esc(String(r.anomaly_reason || '').replace(/_/g, ' ').toLowerCase())}</td><td class="small">${esc(r.driver || '—')}</td>
      <td>${r.photo_url ? `<img class="photo-thumb" src="${r.photo_url}" alt="Site photo" onclick="viewPhoto('${r.photo_url}')">` : '—'}</td>
      <td><span class="pill ${r.confirmation_status}">${r.confirmation_status.replace('_', ' ')}</span>${r.confirmation_status === 'awaiting' ? `<br><span class="muted small">${hoursLeft(r.confirm_deadline)} h left</span>` : ''}</td>
      <td class="r" style="white-space:nowrap">${r.confirmation_status === 'awaiting' ? `<a class="btn wa small" href="${r.whatsapp_url}" target="_blank" rel="noopener">Nudge</a> ` : ''}
        ${['awaiting', 'confirmed', 'auto_confirmed'].includes(r.confirmation_status) ? `<button class="btn ghost small" onclick="overrideNpu(${r.id},'confirm')">Confirm</button> <button class="btn ghost small" onclick="overrideNpu(${r.id},'dispute')">Revisit</button>` : ''}</td></tr>`).join('')}</table>`
    : '<p class="empty">No not-picked-up cases.</p>'}</div>`;
}
async function overrideNpu(id, action) {
  const note = prompt(action === 'confirm' ? 'Override: confirm as not billed. Reason?' : 'Override: book a free revisit. Reason?', '');
  if (note === null) return;
  try { const r = await api(`/pickups/${id}/confirm`, { method: 'POST', body: { action, note } }); toast(r.status); confirmations(); }
  catch (e) { toast(e.message, 'critical'); }
}
async function proofOverride(pickupId) {
  const reason = prompt('Ops override — accept this job as completed. Reason (logged in audit):', 'Basement site, poor GPS — driver called in');
  if (!reason) return;
  try { await api(`/pickups/${pickupId}/proof-override`, { method: 'POST', body: { reason } }); toast('Override applied and logged'); }
  catch (e) { toast(e.message, 'critical'); }
}

// ═══════════════════ INVOICES & PAYMENTS (CRM-14) ════════════
let invFilter = 'all';
async function invoices() {
  const d = await api('/invoices');
  const rows = d.rows.filter(i => invFilter === 'all' || i.status_label.startsWith(invFilter));
  const tabs = ['all', 'Due', 'Overdue', 'Partly', 'Paid'].map(t => `<button class="ptab ${invFilter === t ? 'on' : ''}" onclick="invFilter='${t}';invoices()">${t === 'all' ? 'All' : t === 'Partly' ? 'Partly paid' : t}</button>`).join('');
  $('#main').innerHTML = `
    <div class="head"><div><h1>Invoices & payments</h1><p class="sub">Invoices are built only from completed, photo-verified, billable visits and are delivered to the customer app (in-app + push) with the PDF. Dates are DD/MM/YYYY.</p></div>
      ${CRM_ROLE === 'owner' ? `<div class="row"><input id="inv-period" type="month" value="${today().slice(0, 7)}" style="width:160px"><button class="btn primary" onclick="genInvoices()">${icon('wallet', 13)} Generate invoices</button></div>` : ''}</div>
    <div class="kpis">
      <div class="kpi blue"><div class="num" style="font-size:24px">${AED(d.summary.billed)}</div><div class="lbl">Billed</div></div>
      <div class="kpi green"><div class="num" style="font-size:24px">${AED(d.summary.collected)}</div><div class="lbl">Collected</div></div>
      <div class="kpi amber"><div class="num" style="font-size:24px">${AED(d.summary.outstanding)}</div><div class="lbl">Outstanding</div></div>
      <div class="kpi red"><div class="num" style="font-size:24px">${AED(d.summary.overdue)}</div><div class="lbl">Overdue</div></div>
      <div class="kpi"><div class="num">${d.unbilled_jobs}</div><div class="lbl">Completed jobs not yet invoiced</div></div>
    </div>
    <div class="row" style="margin-bottom:12px"><div class="ptabs">${tabs}</div></div>
    <div class="card scroll-x">${rows.length ? `<table><tr><th>Invoice</th><th>Customer</th><th>Period</th><th class="r">Visits</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Due</th><th>Customer app</th><th>Status</th><th></th></tr>
    ${rows.map(i => `<tr><td><b>${esc(i.number)}</b></td><td>${esc(i.customer?.name || '')}<br><span class="muted small">${esc(i.customer?.branch || '')}</span></td><td>${i.period.slice(5)}/${i.period.slice(0, 4)}</td>
      <td class="r">${i.job_ids.length}</td><td class="r">${AED(i.amount)}</td><td class="r">${AED(i.paid)}</td><td class="r"><b>${AED(i.balance)}</b></td><td class="small">${dmy(i.due_date)}</td>
      <td class="small">${i.sent_at ? `<span style="color:var(--green)">${icon('smartphone', 12)} sent</span><br><span class="muted">${dmyTime(i.sent_at)}${i.sent_count > 1 ? ' · ×' + i.sent_count : ''}</span>` : '<span class="muted">not sent</span>'}</td>
      <td><span class="pill ${i.status_label.split(' ')[0]}">${i.status_label}</span></td>
      <td class="r" style="white-space:nowrap"><button class="btn ghost small" onclick="openDoc('/invoices/${i.id}/pdf?print=1')">${icon('download', 12)} PDF</button>
        ${CRM_ROLE === 'owner' && i.status_label !== 'Void' ? ` <button class="btn ghost small" title="Push this invoice (with PDF link) to the customer app" onclick="sendInvoice(${i.id},'${esc(i.number)}')">${icon('smartphone', 12)} ${i.sent_at ? 'Resend' : 'Send'} to app</button>` : ''}
        ${CRM_ROLE === 'owner' && i.balance > 0 && i.status_label !== 'Void' ? ` <button class="btn primary small" onclick='paymentForm(${jsonAttr({ id: i.id, number: i.number, balance: i.balance })})'>Record payment</button>` : ''}
        ${CRM_ROLE === 'owner' && i.paid === 0 && i.status_label !== 'Void' ? ` <button class="btn ghost small" onclick="voidInvoice(${i.id})">Void</button>` : ''}</td></tr>`).join('')}</table>`
    : '<p class="empty">No invoices in this view.</p>'}</div>`;
}
// STEP 3 — push an invoice to the customer app
async function sendInvoice(id, number) {
  try {
    const r = await api(`/invoices/${id}/send`, { method: 'POST' });
    if (r.push.delivered) toast(`${number} sent to the customer app — pushed to ${r.push.delivered} device(s)`, 'success');
    else toast(`${number} is in the customer's app inbox. No push was delivered: the customer has not turned on notifications on any phone yet.`, 'warning');
    invoices();
  } catch (e) { toast(e.message, 'critical'); }
}
async function genInvoices() {
  try { const r = await api('/invoices/generate', { method: 'POST', body: { period: $('#inv-period').value } }); const p = $('#inv-period').value; toast(r.created ? `${r.created} invoice(s) issued for ${p.slice(5)}/${p.slice(0, 4)} and sent to the customer app` : `No completed, un-invoiced visits for ${p.slice(5)}/${p.slice(0, 4)}`, r.created ? 'success' : 'info'); invoices(); }
  catch (e) { toast(e.message, 'critical'); }
}
function paymentForm(i) {
  openModal(`<h3>Record payment — ${esc(i.number)}</h3>
    <p class="muted small" style="margin-bottom:10px">Balance ${AED(i.balance)}</p>
    <div class="fgrid">
      ${field('Amount (AED)', `<input id="pay-a" type="number" step="0.01" value="${i.balance}">`)}
      ${field('Method', `<select id="pay-m"><option value="transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option></select>`)}
      ${field('Reference', `<input id="pay-r" placeholder="Txn / receipt no.">`)}
      ${field('Received on', `<input id="pay-d" type="date" value="${today()}">`)}
    </div>
    <button class="btn primary full" onclick="savePayment(${i.id})">Save payment</button><p id="m-err" class="err"></p>`);
}
async function savePayment(id) {
  try {
    const r = await api('/payments', { method: 'POST', body: { invoice_id: id, amount: Number($('#pay-a').value), method: $('#pay-m').value, reference: $('#pay-r').value, received_at: new Date($('#pay-d').value).toISOString() } });
    closeModal(); toast(`Payment recorded — balance ${AED(r.balance)}. Customer notified in the app.`, 'success'); if (currentPage === 'invoices') invoices();
  } catch (e) { $('#m-err').textContent = e.message; }
}
async function voidInvoice(id) {
  if (!confirm('Void this invoice? Its visits become billable again.')) return;
  try { await api(`/invoices/${id}/void`, { method: 'POST' }); toast('Invoice voided'); invoices(); } catch (e) { toast(e.message, 'critical'); }
}

// ═══════════════════ SERVICE CATALOGUE (CRM-13) ══════════════
async function catalogue() {
  _services = null;
  const rows = await services();
  $('#main').innerHTML = `
    <div class="head"><div><h1>Service catalogue</h1><p class="sub">Service types, default durations and prices, and the checklist the driver completes before finishing a job.</p></div>
      <button class="btn primary" onclick="svcForm()">${icon('plus', 13)} Add service</button></div>
    <div class="card scroll-x"><table><tr><th>Code</th><th>Name</th><th>Line</th><th>Duration</th><th>Default price</th><th>Checklist</th><th>Status</th><th></th></tr>
    ${rows.map(s => `<tr><td><b>${esc(s.code)}</b></td><td>${esc(s.name)}</td><td><span class="pill ${s.category}">${s.category === 'pest' ? 'Pest control' : 'Waste'}</span></td>
      <td>${s.default_duration_min} min</td><td>${AED(s.default_price)}</td><td class="small">${s.checklist.map(esc).join(' · ') || '—'}</td>
      <td><span class="pill ${s.is_active ? 'active' : 'ended'}">${s.is_active ? 'active' : 'off'}</span></td>
      <td><button class="btn ghost small" onclick='svcForm(${jsonAttr(s)})'>Edit</button></td></tr>`).join('')}</table></div>`;
}
function svcForm(s = {}) {
  openModal(`<h3>${s.id ? 'Edit service' : 'New service'}</h3>
    <div class="fgrid">
      ${field('Code', `<input id="sv-code" value="${esc(s.code || '')}" ${s.id ? 'disabled' : ''} placeholder="PEST_RODENT">`)}
      ${field('Name', `<input id="sv-name" value="${esc(s.name || '')}">`)}
      ${field('Business line', `<select id="sv-cat"><option value="waste">Waste management (Machari)</option><option value="pest" ${s.category === 'pest' ? 'selected' : ''}>Pest control</option></select>`)}
      ${field('Default duration (min)', `<input id="sv-dur" type="number" value="${s.default_duration_min ?? 20}">`)}
      ${field('Default price (AED)', `<input id="sv-price" type="number" step="0.01" value="${s.default_price ?? 0}">`)}
      ${s.id ? field('Active', `<select id="sv-act"><option value="1">Yes</option><option value="0" ${s.is_active ? '' : 'selected'}>No</option></select>`) : ''}
    </div>
    ${field('Checklist items (one per line)', `<textarea id="sv-list">${esc((s.checklist || []).join('\n'))}</textarea>`)}
    <button class="btn primary full" onclick="saveSvc(${s.id || 'null'})">Save</button><p id="m-err" class="err"></p>`);
}
async function saveSvc(id) {
  const body = { code: $('#sv-code').value, name: $('#sv-name').value, category: $('#sv-cat').value, default_duration_min: Number($('#sv-dur').value),
    default_price: Number($('#sv-price').value), checklist: $('#sv-list').value.split('\n').map(x => x.trim()).filter(Boolean), is_active: $('#sv-act') ? $('#sv-act').value === '1' : true };
  try { await api(id ? '/service-types/' + id : '/service-types', { method: id ? 'PUT' : 'POST', body }); closeModal(); toast('Service saved — price changes are logged'); catalogue(); }
  catch (e) { $('#m-err').textContent = e.message; }
}

// ═══════════════════ AUDIT LOG (CRM-18) ══════════════════════
let auditEntity = '';
async function audit() {
  const rows = await api('/audit' + (auditEntity ? '?entity=' + auditEntity : ''));
  const ents = ['', 'quotation', 'service_type', 'service_plan', 'payment', 'invoice', 'pickup', 'lead', 'settings', 'user'];
  $('#main').innerHTML = `
    <div class="head"><div><h1>Audit log</h1><p class="sub">Who changed what and when — quotes, prices, schedules, payments and overrides.</p></div>
      <select style="width:200px" onchange="auditEntity=this.value;audit()">${ents.map(e => `<option value="${e}" ${auditEntity === e ? 'selected' : ''}>${e || 'All entities'}</option>`).join('')}</select></div>
    <div class="card scroll-x">${rows.length ? `<table><tr><th>When</th><th>Who</th><th>Entity</th><th>Action</th><th>Change</th></tr>
    ${rows.map(a => `<tr><td class="small muted" style="white-space:nowrap">${a.at}</td><td class="small">${esc(a.actor)}</td><td><span class="zone-tag">${esc(a.entity)}${a.entity_id ? ' #' + esc(a.entity_id) : ''}</span></td>
      <td class="small"><b>${esc(a.action)}</b></td><td class="small muted" style="max-width:420px;word-break:break-word">${a.before ? '<span style="color:var(--red)">' + esc(a.before).slice(0, 180) + '</span><br>' : ''}${esc(a.after || '').slice(0, 220)}</td></tr>`).join('')}</table>`
    : '<p class="empty">Nothing logged yet.</p>'}</div>`;
}

// ═══════════════════ SETTINGS (v3) ═══════════════════════════
async function settingsV3() {
  const s = await api('/v3/settings');
  $('#main').innerHTML = `
    <div class="head"><div><h1>Settings</h1><p class="sub">Shift cutoff, default service window, invoice terms and the UAE public-holiday calendar used by the recurrence engine.</p></div></div>
    <div class="grid2">
      <div class="card"><h3>${icon('clock', 15)} Operations</h3>
        ${field('Shift cutoff (unfinished jobs become Overdue)', `<input id="st-cut" type="time" value="${s.shift_cutoff}">`)}
        ${field('Default time window', `<input id="st-win" value="${esc(s.default_time_window)}" placeholder="07:00-12:00">`)}
        ${field('Invoice due (days)', `<input id="st-due" type="number" value="${esc(s.invoice_due_days)}">`)}
        ${field('Company WhatsApp number', GLPhone.html('st-wa', s.company_whatsapp))}
        ${field('Reply-to email on quotations', `<input id="st-mail" type="email" value="${esc(s.company_email || '')}" placeholder="sales@yourcompany.ae">`)}
        <h3 style="margin-top:16px">${icon('mail', 15)} Gmail (quotations)</h3>
        ${mailBanner(s.mail)}
        ${s.mail && s.mail.configured ? `<div class="row"><input id="st-test" type="email" placeholder="Send a test email to…" style="max-width:260px"><button class="btn ghost small" onclick="mailTest()">Send test</button></div>` : ''}
      </div>
      <div class="card"><h3>${icon('calendar', 15)} UAE public holidays</h3>
        <p class="muted small" style="margin-bottom:8px">One date per line, typed as YYYY-MM-DD (year-month-day) so they sort correctly; shown everywhere else as DD/MM/YYYY. Lunar holidays move each year — update when officially announced. Plan visits on these dates are skipped and flagged for rescheduling.</p>
        <textarea id="st-hol" style="min-height:230px">${s.uae_holidays.join('\n')}</textarea></div>
    </div>
    <button class="btn primary" onclick="saveSettingsV3()">Save settings</button>`;
}
async function saveSettingsV3() {
  const stWa = GLPhone.read('st-wa');
  if (!stWa.ok) return toast('Company WhatsApp number: ' + stWa.error, 'critical');
  try { await api('/v3/settings', { method: 'PUT', body: { shift_cutoff: $('#st-cut').value, default_time_window: $('#st-win').value, invoice_due_days: $('#st-due').value,
    company_whatsapp: stWa.e164 || undefined, company_email: $('#st-mail').value.trim(), uae_holidays: $('#st-hol').value.split('\n').map(x => x.trim()).filter(Boolean) } });
  } catch (e) { return toast(e.message, 'critical'); }
  toast('Settings saved', 'success');
}
async function mailTest() {
  try { const r = await api('/mail/test', { method: 'POST', body: { to: $('#st-test').value.trim() } }); toast(`Test email sent to ${r.to}`, 'success'); }
  catch (e) { toast(e.message, 'critical'); }
}
