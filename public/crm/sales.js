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
const jsonAttr = o => JSON.stringify(o).replace(/'/g, '&#39;');
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
    data: { labels: s.sources.map(x => x.source), datasets: [{ data: s.sources.map(x => x.c), backgroundColor: ['#2dd4bf', '#7dd3fc', '#34d399', '#c4b5fd', '#fbbf24', '#fb7185', '#94a3b8'], borderWidth: 0 }] },
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
      ${field('Phone (WhatsApp) *', `<input id="l-phone" value="${esc(l.phone || '')}" placeholder="+9715…">`)}
      ${field('Email', `<input id="l-email" value="${esc(l.email || '')}">`)}
      ${field('Service type', `<select id="l-svc">${_services.map(s => `<option value="${s.code}" ${l.service_type === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`)}
      ${field('Frequency wanted', `<input id="l-freq" value="${esc(l.frequency || '')}" placeholder="e.g. 3× weekly">`)}
      ${field('Source', `<select id="l-src">${SOURCES.map(s => `<option ${l.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
      ${field('Follow-up', `<input id="l-fu" type="datetime-local" value="${l.follow_up_at ? String(l.follow_up_at).slice(0, 16) : ''}">`)}
    </div>
    <div class="field"><label>Sites — enter coordinates once (copy from Google Maps "What's here?"); no map API is used</label>
      <div id="l-sites">${sites.map(siteRow).join('')}</div>
      <button class="btn ghost small" type="button" onclick="document.getElementById('l-sites').insertAdjacentHTML('beforeend', siteRow())">${icon('plus', 12)} Add site</button></div>
    ${field('Notes', `<textarea id="l-notes">${esc(l.notes || '')}</textarea>`)}
    <button class="btn primary full" onclick="saveLead(${l.id || 'null'})">Save lead</button>
    <p id="m-err" class="err"></p>`, true);
}
async function saveLead(id) {
  const sites = [...document.querySelectorAll('#l-sites .site-row')].map(r => ({
    name: r.querySelector('.s-name').value.trim(), zone: r.querySelector('.s-zone').value.trim(),
    lat: r.querySelector('.s-lat').value === '' ? '' : Number(r.querySelector('.s-lat').value),
    lng: r.querySelector('.s-lng').value === '' ? '' : Number(r.querySelector('.s-lng').value),
    address: r.querySelector('.s-addr').value.trim(),
  })).filter(s => s.name || s.address);
  const fu = $('#l-fu').value;
  const body = { contact: $('#l-contact').value.trim(), company: $('#l-company').value.trim(), phone: $('#l-phone').value.trim(), email: $('#l-email').value.trim(),
    service_type: $('#l-svc').value, frequency: $('#l-freq').value, source: $('#l-src').value, follow_up_at: fu ? new Date(fu).toISOString() : null, notes: $('#l-notes').value, sites };
  try {
    const r = await api(id ? '/leads/' + id : '/leads', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast('Lead saved'); if (!id) leadDetail(r.id); else if (currentPage === 'leads') leads();
  } catch (e) { $('#m-err').textContent = e.message; }
}
async function leadDetail(id) {
  await services();
  const l = await api('/leads/' + id);
  const wa = `https://wa.me/${String(l.phone || '').replace(/[^\d]/g, '')}`;
  openModal(`
    <div class="row spread"><h3 style="margin:0">${esc(l.company || l.contact)}</h3><span class="pill ${l.stage}">${STAGE_LABEL[l.stage]}</span></div>
    <div class="kv" style="margin:14px 0">
      <span>Contact</span><div>${esc(l.contact)}</div>
      <span>Phone / email</span><div>${esc(l.phone)} ${esc(l.email || '')}</div>
      <span>Service</span><div>${esc(svcName(l.service_type))} · ${esc(l.frequency || '—')}</div>
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
    ? `<div class="banner ok">${icon('mail', 16)}<div>Gmail connected — quotations are emailed from <b>${esc(m.sender || 'your Gmail account')}</b> (${m.mode === 'api' ? 'Gmail API' : 'Gmail SMTP'}).</div></div>`
    : `<div class="banner">${icon('mail', 16)}<div><b>Gmail is not connected on the server yet.</b> “Send via Gmail” opens a ready-written Gmail message for you to press Send. To send automatically, add a Gmail account in the server settings (see README → Gmail).</div></div>`;
}
async function quotations() {
  const [rows, mail] = await Promise.all([api('/quotations'), api('/mail/status').catch(() => null)]);
  const open = rows.filter(q => ['draft', 'sent'].includes(q.status));
  $('#main').innerHTML = `
    <div class="head"><div><h1>Quotations</h1><p class="sub">Numbered, versioned quotes with VAT 5%. Sent by Gmail with a view / PDF / accept link; accepted quotes convert to a registered customer in one click.</p></div>
      <button class="btn primary" onclick="pickLeadForQuote()">${icon('plus', 13)} New quotation</button></div>
    <div class="flow">
      <div class="flow-step"><span class="n">1</span><span class="cnt">${rows.filter(q => q.status === 'draft').length}</span><span class="k">Step 1</span><b>Send quotation via Gmail</b><small>Free Gmail account · drafts waiting to be sent</small></div>
      <div class="flow-step"><span class="n">2</span><span class="cnt">${rows.filter(q => q.status === 'accepted').length}</span><span class="k">Step 2</span><b>Lead approval & customer registration</b><small>Accepted quotes ready to convert</small></div>
      <div class="flow-step"><span class="n">3</span><span class="cnt">${rows.filter(q => q.status === 'converted').length}</span><span class="k">Step 3</span><b>Invoice & PDF via customer app</b><small>Converted customers · invoices are pushed to the app</small></div>
    </div>
    ${mailBanner(mail)}
    <div class="kpis">
      <div class="kpi amber"><div class="num">${open.length}</div><div class="lbl">Open quotes</div></div>
      <div class="kpi violet"><div class="num" style="font-size:24px">${AED(open.reduce((a, q) => a + q.total, 0))}</div><div class="lbl">Open value</div></div>
      <div class="kpi green"><div class="num">${rows.filter(q => q.status === 'accepted').length}</div><div class="lbl">Accepted — ready to convert</div></div>
      <div class="kpi"><div class="num">${rows.filter(q => q.status === 'converted').length}</div><div class="lbl">Converted</div></div>
    </div>
    <div class="card scroll-x">${rows.length ? `<table><tr><th>Number</th><th>Client</th><th>Total</th><th>Valid until</th><th>Sent</th><th>Status</th><th></th></tr>
      ${rows.map(q => `<tr><td><b>${esc(q.number)}</b> <span class="muted small">v${q.version}</span></td>
        <td>${esc(q.lead?.company || q.lead?.contact || '—')}<br><span class="muted small">${esc(q.lead?.contact || '')}</span></td>
        <td><b>${AED(q.total)}</b></td><td class="small">${dmy(q.valid_until)}</td>
        <td class="small muted">${q.sent_at ? `${icon(q.sent_via === 'gmail' ? 'mail' : 'send', 12)} ${esc(q.sent_via)} · ${dmyTime(q.sent_at)}${q.sent_to ? '<br>' + esc(q.sent_to) : ''}` : '<span class="pill draft">not sent</span>'}</td>
        <td><span class="pill ${q.status}">${q.status}</span></td>
        <td class="r" style="white-space:nowrap">${q.status === 'draft' ? `<button class="btn gmail small" onclick="sendQuoteForm(${q.id})">${icon('mail', 12)} Send</button> ` : ''}${q.status === 'accepted' ? `<button class="btn primary small" onclick="convertQuote(${q.id})">Convert</button> ` : ''}<button class="btn ghost small" onclick="quoteDetail(${q.id})">Open</button></td></tr>`).join('')}</table>`
      : '<p class="empty">No quotations yet. Create one from a lead.</p>'}</div>`;
}
async function pickLeadForQuote() {
  const ls = (await api('/leads')).filter(l => !['won', 'lost'].includes(l.stage));
  if (!ls.length) { toast('Create a lead first'); return leadForm(); }
  openModal(`<h3>Quotation for which lead?</h3>
    ${field('Lead', `<select id="pick-lead">${ls.map(l => `<option value="${l.id}">${esc(l.company || l.contact)} — ${esc(l.contact)}</option>`).join('')}</select>`)}
    <button class="btn primary full" onclick="const v=+document.getElementById('pick-lead').value;quoteForm({ lead_id: v })">Continue</button>`);
}
function qbRow(it = {}) {
  return `<tr>
    <td><select class="qi-svc" onchange="qbPrice(this)">${_services.map(s => `<option value="${s.code}" data-price="${s.default_price}" ${it.service_code === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></td>
    <td><input class="qi-desc" value="${esc(it.description || '')}" placeholder="Description"></td>
    <td><input class="qi-site" value="${esc(it.site || '')}" placeholder="All sites"></td>
    <td style="width:78px"><input class="qi-qty" type="number" min="0" value="${it.qty ?? 1}" oninput="qbCalc()"></td>
    <td style="width:100px"><input class="qi-unit" type="number" min="0" step="0.01" value="${it.unit_price ?? _services[0].default_price}" oninput="qbCalc()"></td>
    <td class="r qi-line" style="width:110px">—</td>
    <td style="width:34px"><button class="btn ghost small" onclick="this.closest('tr').remove();qbCalc()" aria-label="Remove line">${icon('x', 12)}</button></td></tr>`;
}
function qbPrice(sel) { const tr = sel.closest('tr'); tr.querySelector('.qi-unit').value = sel.selectedOptions[0].dataset.price; if (!tr.querySelector('.qi-desc').value) tr.querySelector('.qi-desc').value = sel.selectedOptions[0].textContent; qbCalc(); }
function qbItems() {
  return [...document.querySelectorAll('#qb-body tr')].map(tr => ({ service_code: tr.querySelector('.qi-svc').value, description: tr.querySelector('.qi-desc').value,
    site: tr.querySelector('.qi-site').value, qty: Number(tr.querySelector('.qi-qty').value), unit_price: Number(tr.querySelector('.qi-unit').value) }));
}
function qbCalc() {
  let sub = 0;
  document.querySelectorAll('#qb-body tr').forEach(tr => {
    const v = (Number(tr.querySelector('.qi-qty').value) || 0) * (Number(tr.querySelector('.qi-unit').value) || 0);
    sub += v; tr.querySelector('.qi-line').textContent = v.toFixed(2);
  });
  const vat = Math.round(sub * 5) / 100;
  $('#qb-sub').textContent = AED(sub); $('#qb-vat').textContent = AED(vat); $('#qb-tot').textContent = AED(sub + vat);
}
async function quoteForm(q = {}) {
  await services();
  const lead = await api('/leads/' + q.lead_id);
  const items = q.items && q.items.length ? q.items : [{ service_code: lead.service_type, description: svcName(lead.service_type), qty: 4, unit_price: (_services.find(s => s.code === lead.service_type) || _services[0]).default_price }];
  const plan = q.plan || {};
  const valid = q.revise_of ? '' : '';
  openModal(`
    <h3>${q.revise_of ? `Revise ${esc(q.number)} → new version` : 'New quotation'} <span class="muted small">for ${esc(lead.company || lead.contact)}</span></h3>
    <div class="scroll-x"><table class="qb"><tr><th>Service</th><th>Description</th><th>Site</th><th>Visits</th><th>Unit AED</th><th class="r">Line</th><th></th></tr>
      <tbody id="qb-body">${items.map(qbRow).join('')}</tbody></table></div>
    <button class="btn ghost small" onclick="document.getElementById('qb-body').insertAdjacentHTML('beforeend', qbRow());qbCalc()">${icon('plus', 12)} Add line</button>
    <table class="qtot"><tr><td>Subtotal</td><td class="r" id="qb-sub">—</td></tr><tr><td>VAT 5%</td><td class="r" id="qb-vat">—</td></tr><tr class="g"><td>Total</td><td class="r" id="qb-tot">—</td></tr></table>
    <h3 style="font-size:14px;margin-top:6px">${icon('repeat', 14)} Service plan created on conversion</h3>
    ${recurrenceFields(plan.recurrence, plan.time_window)}
    <div class="fgrid">
      ${field('Start date', `<input id="qb-start" type="date" value="${plan.start_date || ''}">`)}
      ${field('Billing', `<select id="qb-bill"><option value="monthly" ${plan.billing !== 'per_visit' ? 'selected' : ''}>Monthly consolidated</option><option value="per_visit" ${plan.billing === 'per_visit' ? 'selected' : ''}>Per visit</option></select>`)}
      ${field('Valid until', `<input id="qb-valid" type="date" value="${valid}" placeholder="30 days">`)}
    </div>
    ${field('Notes / terms', `<textarea id="qb-notes">${esc(q.notes || '')}</textarea>`)}
    <button class="btn primary full" onclick="saveQuote(${q.lead_id}, ${q.revise_of || 'null'})">${q.revise_of ? 'Save new version' : 'Create quotation'}</button>
    <p id="m-err" class="err"></p>`, true);
  qbCalc();
}
async function saveQuote(leadId, reviseOf) {
  const rc = readRecurrence();
  const body = { lead_id: leadId, revise_of: reviseOf, items: qbItems(), notes: $('#qb-notes').value, valid_until: $('#qb-valid').value || undefined,
    plan: { recurrence: rc.rule, time_window: rc.time_window, start_date: $('#qb-start').value || null, billing: $('#qb-bill').value } };
  try { const r = await api('/quotations', { method: 'POST', body }); closeModal(); toast(`Quotation ${r.number} v${r.version} created`); quoteDetail(r.id); }
  catch (e) { $('#m-err').textContent = e.message; }
}
async function quoteDetail(id) {
  const q = await api('/quotations/' + id);
  const editable = ['draft', 'sent'].includes(q.status);
  openModal(`
    <div class="row spread"><h3 style="margin:0">${esc(q.number)} <span class="muted small">v${q.version}</span></h3><span class="pill ${q.status}">${q.status}</span></div>
    <p class="muted small" style="margin:4px 0 12px">${esc(q.lead?.company || '')} · ${esc(q.lead?.contact || '')} · valid until ${dmy(q.valid_until)}${q.sent_at ? ' · sent via ' + esc(q.sent_via) + (q.sent_to ? ' to ' + esc(q.sent_to) : '') + ' on ' + dmyTime(q.sent_at) : ' · not sent yet'}</p>
    <table><tr><th>Service</th><th>Site</th><th class="r">Visits</th><th class="r">Unit</th><th class="r">Line</th></tr>
      ${q.items.map(i => `<tr><td>${esc(i.description || i.service_code)}</td><td class="small">${esc(i.site || 'All')}</td><td class="r">${i.qty}</td><td class="r">${i.unit_price.toFixed(2)}</td><td class="r">${i.line_total.toFixed(2)}</td></tr>`).join('')}</table>
    <table class="qtot"><tr><td>Subtotal</td><td class="r">${AED(q.subtotal)}</td></tr><tr><td>VAT 5%</td><td class="r">${AED(q.vat)}</td></tr><tr class="g"><td>Total</td><td class="r">${AED(q.total)}</td></tr></table>
    <p class="small"><b>Plan:</b> ${esc(ruleLabel(q.plan.recurrence))} · window ${esc(q.plan.time_window)} · ${q.plan.billing === 'per_visit' ? 'billed per visit' : 'billed monthly'}</p>
    <div class="row" style="margin-top:14px">
      <button class="btn ghost" onclick="openDoc('/quotations/${q.id}/pdf?print=1')">${icon('download', 13)} PDF</button>
      ${editable ? `<button class="btn gmail" onclick="sendQuoteForm(${q.id})">${icon('mail', 13)} ${q.sent_at ? 'Resend' : 'Send'} via Gmail</button>` : ''}
      ${editable ? `<button class="btn ghost" onclick="quoteStatus(${q.id},'accepted')">Mark accepted</button><button class="btn ghost" onclick="quoteStatus(${q.id},'rejected')">Mark rejected</button>` : ''}
      ${q.status === 'accepted' ? `<button class="btn primary" onclick="convertQuote(${q.id})">${icon('userCheck', 13)} Convert to customer</button>` : ''}
      ${editable || q.status === 'expired' ? `<button class="btn ghost" onclick='quoteForm(${jsonAttr({ lead_id: q.lead_id, revise_of: q.id, number: q.number, items: q.items, plan: q.plan, notes: q.notes })})'>Revise (v${q.version + 1})</button>` : ''}
    </div>
    ${q.versions.length > 1 ? `<p class="muted small" style="margin-top:12px">Versions: ${q.versions.map(v => `<a href="#" onclick="quoteDetail(${v.id});return false">v${v.version} (${v.status}, ${AED(v.total)})</a>`).join(' · ')}</p>` : ''}
    <div id="q-out"></div>`, true);
}
// STEP 1 — send by Gmail. Shows the recipient first so a missing / wrong email is caught before sending.
async function sendQuoteForm(id) {
  const [q, mail] = await Promise.all([api('/quotations/' + id), api('/mail/status').catch(() => ({ configured: false }))]);
  window._sqCompose = !mail.configured;
  openModal(`
    <h3>${icon('mail', 17)} Send ${esc(q.number)} v${q.version} via Gmail</h3>
    <p class="muted small" style="margin-bottom:12px">${esc(q.lead?.company || q.lead?.contact || '')} · ${AED(q.total)} incl. VAT · valid until ${dmy(q.valid_until)}</p>
    ${mailBanner(mail)}
    ${field('To (customer email)', `<input id="sq-to" type="email" value="${esc(q.lead?.email || '')}" placeholder="name@company.ae" autocomplete="off">`)}
    <p class="muted small" style="margin:-4px 0 12px">The email contains the quotation summary and one button to view it, download the PDF and accept online. ${q.lead?.email ? '' : '<b style="color:var(--amber)">This lead has no email saved — type it here.</b>'}</p>
    <div class="row"><button class="btn gmail" id="sq-go" onclick="sendQuote(${id})">${icon('send', 13)} ${mail.configured ? 'Send email now' : 'Open in Gmail'}</button>
      <button class="btn ghost" onclick="sendQuoteWa(${id})" title="Fallback only — Gmail is the standard channel">WhatsApp instead</button>
      <button class="btn ghost" onclick="quoteDetail(${id})">Back</button></div>
    <p id="m-err" class="err"></p>`);
}
async function sendQuote(id) {
  const to = $('#sq-to').value.trim();
  $('#m-err').textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) { $('#m-err').textContent = 'Enter a valid email address for the customer'; $('#sq-to').focus(); return; }
  const btn = $('#sq-go'); btn.disabled = true;
  // The no-setup fallback opens Gmail in a new tab. Browsers only allow that directly
  // inside the click, so the tab is reserved now and pointed at Gmail once the server answers.
  const tab = window._sqCompose ? window.open('about:blank', '_blank') : null;
  try {
    const r = await api(`/quotations/${id}/send`, { method: 'POST', body: { base_url: location.origin, to, via: 'gmail' } });
    if (r.delivery === 'compose') {
      if (tab) tab.location = r.gmail_compose_url;
      toast(tab ? `Gmail opened with the quotation for ${r.to} — press Send there. Logged as sent.` : 'Your browser blocked the Gmail tab — allow pop-ups for this site, then press Resend via Gmail.', tab ? 'success' : 'warning');
    } else { if (tab) tab.close(); toast(`Quotation emailed to ${r.to}`, 'success'); }
    quoteDetail(id);
    if (currentPage === 'quotations') quotations();
  } catch (e) { if (tab) tab.close(); $('#m-err').textContent = e.message; btn.disabled = false; }
}
async function sendQuoteWa(id) {
  try {
    const r = await api(`/quotations/${id}/send`, { method: 'POST', body: { base_url: location.origin, via: 'whatsapp' } });
    window.open(r.whatsapp_url, '_blank');
    toast('WhatsApp opened with the quote summary and link — logged as sent', 'success');
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
      <span>Portal code</span><div><b style="font-size:22px;letter-spacing:4px">${r.portal_code}</b><br><span class="muted small">Shown once. Customers can also sign in with an OTP to their phone or email.</span></div></div>
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
      <td class="small muted">${p.start_date} → ${p.end_date || 'ongoing'}</td><td class="small">${AED(p.unit_price)}<br><span class="muted">${p.billing === 'per_visit' ? 'per visit' : 'monthly'}</span></td>
      <td><span class="pill ${p.paused ? 'paused' : p.status}">${p.paused ? 'paused' + (p.pause_to ? ' → ' + p.pause_to : '') : p.status}</span></td>
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
        ${field('Company WhatsApp number', `<input id="st-wa" value="${esc(s.company_whatsapp)}">`)}
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
  try { await api('/v3/settings', { method: 'PUT', body: { shift_cutoff: $('#st-cut').value, default_time_window: $('#st-win').value, invoice_due_days: $('#st-due').value,
    company_whatsapp: $('#st-wa').value, company_email: $('#st-mail').value.trim(), uae_holidays: $('#st-hol').value.split('\n').map(x => x.trim()).filter(Boolean) } });
  } catch (e) { return toast(e.message, 'critical'); }
  toast('Settings saved', 'success');
}
async function mailTest() {
  try { const r = await api('/mail/test', { method: 'POST', body: { to: $('#st-test').value.trim() } }); toast(`Test email sent to ${r.to}`, 'success'); }
  catch (e) { toast(e.message, 'critical'); }
}
