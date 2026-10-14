// ─────────────────────────────────────────────────────────────
// GreenLoop CRM — customer care (v3.7, add-on screens)
//   customerIssues()       issues raised in the customer app: reply, status, priority
//   openIssue(id)          conversation + visit + reply box
//   visitHistoryModal(id)  every visit of a customer, grouped (completed, missed …)
//   bookings tier badges   Tree / Forest requests are marked Priority
// Data: server/care.js. Uses app.js / growth.js helpers.
// ─────────────────────────────────────────────────────────────
PATHS.messageSquare = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';

(function addCareNav() {
  const at = page => NAV.findIndex(n => n[0] === page);
  NAV.splice(at('customerHealth') + 1, 0, ['customerIssues', 'messageSquare', 'Customer issues']);
  const navEl = document.getElementById('nav');
  if (navEl && navEl.children.length) { buildNav(); document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === currentPage)); }
  // live refresh when a customer raises or answers an issue (socket is created at sign-in)
  const hook = setInterval(() => {
    if (typeof socket === 'undefined' || !socket || !socket.on) return;
    clearInterval(hook);
    socket.on('issues:changed', () => refreshIf(['customerIssues']));
  }, 1000);
})();

const IS = { open: ['Open', 'pending'], in_progress: ['In progress', 'sent'], resolved: ['Resolved', 'collected'] };
const ago = s => {
  const t = Date.parse(String(s || '').includes('T') ? s : String(s || '').replace(' ', 'T') + 'Z');
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const dueIn = s => {
  const h = (Date.parse(s) - Date.now()) / 3600e3;
  return h < 0 ? `<span class="pill canceled">Late by ${Math.round(-h)} h</span>` : `<span class="pill ${h < 4 ? 'pending' : 'sent'}">Reply within ${Math.max(1, Math.round(h))} h</span>`;
};

// ══ ISSUES ═══════════════════════════════════════════════════
let issueFilter = 'active';
async function customerIssues() {
  const d = await api('/issues' + (issueFilter === 'all' ? '' : '?status=' + issueFilter));
  const s = d.summary;
  const tab = (k, l) => `<button class="ptab ${issueFilter === k ? 'on' : ''}" onclick="issueFilter='${k}';customerIssues()">${l}</button>`;
  $('#main').innerHTML = `
    <div class="head"><div><h1>Customer issues</h1>
      <p class="sub">Problems raised by customers in the app. Reply here and the customer is notified. Response targets follow the customer's Green tier (24 h, 12 h for Tree, 4 h for Forest).</p></div></div>
    <div class="kpis">
      <div class="kpi amber"><div class="num">${s.open}</div><div class="lbl">${icon('inbox', 13)} Open</div></div>
      <div class="kpi blue"><div class="num">${s.in_progress}</div><div class="lbl">${icon('clock', 13)} In progress</div></div>
      <div class="kpi red"><div class="num">${s.overdue}</div><div class="lbl">${icon('alertTriangle', 13)} Past response target</div></div>
      <div class="kpi green"><div class="num">${s.avg_resolve_h == null ? '—' : s.avg_resolve_h + ' h'}</div><div class="lbl">${icon('checkCircle', 13)} Average time to resolve</div></div>
    </div>
    <div class="row" style="margin-bottom:12px"><div class="ptabs">${tab('active', 'Open and in progress')}${tab('open', 'Open')}${tab('in_progress', 'In progress')}${tab('resolved', 'Resolved')}${tab('all', 'All')}</div></div>
    <div class="card scroll-x"><table>
      <tr><th>Raised</th><th>Customer</th><th>Issue</th><th>Priority</th><th>Status</th><th>Response</th><th></th></tr>
      ${d.rows.length ? d.rows.map(i => `<tr>
        <td class="small">${dmyT(i.created_at)}<br><span class="muted">${ago(i.created_at)}</span></td>
        <td><b>${esc(i.name)}</b><br><span class="muted small">${esc(i.branch || '')} · ${esc(i.tier)}</span></td>
        <td><b class="small">${esc(i.category_label)}</b><br><span class="small muted">${esc(String(i.description).slice(0, 90))}${i.description.length > 90 ? '…' : ''}</span>${i.photo_url ? ` ${icon('camera', 12)}` : ''}</td>
        <td>${i.priority === 'high' ? '<span class="pill canceled">High</span>' : '<span class="pill ended">Normal</span>'}</td>
        <td><span class="pill ${IS[i.status][1]}">${IS[i.status][0]}</span>${i.assigned_to ? `<br><span class="small muted">${esc(i.assigned_to)}</span>` : ''}</td>
        <td>${i.status === 'resolved' ? '<span class="small muted">Done</span>' : i.first_response_at ? '<span class="small muted">Answered</span>' : dueIn(i.due_at)}</td>
        <td><button class="btn primary small" onclick="openIssue(${i.id})">Open</button></td>
      </tr>`).join('') : '<tr><td colspan="7" class="muted">No issues in this group.</td></tr>'}
    </table></div>`;
}
async function openIssue(id) {
  const i = await api('/issues/' + id);
  openModal(`<div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px">
      <div><h3 style="margin:0">${esc(i.category_label)}</h3><p class="small muted" style="margin:4px 0 0">${esc(i.name)} · ${esc(i.branch || '')} · ${esc(i.tier.name)} tier · raised ${dmyT(i.created_at)}</p></div>
      <span class="pill ${IS[i.status][1]}">${IS[i.status][0]}</span></div>
    ${i.visit ? `<p class="small" style="margin:10px 0">${icon('calendar', 12)} About the visit on <b>${dmyT(i.visit.scheduled_date)}</b> (${esc(i.visit.status)})${i.visit.photo_url ? ` · <a href="#" onclick="viewPhoto('${esc(i.visit.photo_url)}');return false">driver photo</a>` : ''}</p>` : ''}
    ${i.photo_url ? `<img src="${esc(i.photo_url)}" style="max-width:100%;max-height:220px;border-radius:12px;margin:6px 0;cursor:pointer" onclick="viewPhoto('${esc(i.photo_url)}')">` : ''}
    <div style="display:flex;flex-direction:column;gap:8px;margin:12px 0;max-height:300px;overflow:auto">
      ${i.messages.map(m => `<div style="align-self:${m.author_role === 'staff' ? 'flex-end' : 'flex-start'};max-width:85%;padding:9px 12px;border-radius:12px;
        background:${m.author_role === 'staff' ? 'rgba(45,212,191,.16)' : 'var(--glass2)'};border:1px solid var(--line)">
        <div class="small muted">${esc(m.author_name || m.author_role)} · ${dmyT(m.created_at)}</div><div>${esc(m.body)}</div></div>`).join('')}
    </div>
    ${field('Reply to the customer', '<textarea id="is-reply" rows="3" placeholder="The customer sees this in the app and gets a notification"></textarea>')}
    <div class="grid2" style="gap:10px">
      ${field('Status', `<select id="is-status">${Object.entries(IS).map(([k, v]) => `<option value="${k}" ${k === (i.status === 'open' ? 'in_progress' : i.status) ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>`)}
      ${field('Priority', `<select id="is-prio"><option value="normal" ${i.priority === 'normal' ? 'selected' : ''}>Normal</option><option value="high" ${i.priority === 'high' ? 'selected' : ''}>High</option></select>`)}
    </div>
    <div class="row"><button class="btn primary" onclick="sendIssueReply(${i.id}, '${i.priority}')">Send</button>
      <button class="btn ghost" onclick="closeModal();visitHistoryModal(${i.customer_id})">Visit history</button>
      <button class="btn ghost" onclick="closeModal();logContactForm(${i.customer_id})">Log contact</button>
      <button class="btn ghost" onclick="closeModal()">Close</button></div>`, true);
}
async function sendIssueReply(id, oldPrio) {
  try {
    const prio = $('#is-prio').value;
    if (prio !== oldPrio) await api('/issues/' + id, { method: 'PUT', body: { priority: prio } });
    await api(`/issues/${id}/reply`, { method: 'POST', body: { body: $('#is-reply').value, status: $('#is-status').value } });
    closeModal(); toast('Sent. The customer has been notified.', 'success'); if (currentPage === 'customerIssues') customerIssues();
  } catch (e) { toast(e.message, 'critical'); }
}

// ══ VISIT HISTORY ════════════════════════════════════════════
const VC = { completed: 'collected', upcoming: 'sent', missed: 'overdue', awaiting: 'awaiting', cancelled: 'canceled', disputed: 'disputed', rescheduled: 'rescheduled' };
const VL = { completed: 'Completed', upcoming: 'Upcoming', missed: 'Missed', awaiting: 'Awaiting confirmation', cancelled: 'Not picked up (confirmed)', disputed: 'Disputed', rescheduled: 'Rescheduled' };
let vhState = { id: null, cat: '', from: '', to: '' };
async function visitHistoryModal(id, cat = '') {
  if (vhState.id !== id) vhState = { id, cat: '', from: '', to: '' };
  if (cat !== undefined) vhState.cat = cat;
  const qs = new URLSearchParams({ account: '1', ...(vhState.from ? { from: vhState.from } : {}), ...(vhState.to ? { to: vhState.to } : {}), ...(vhState.cat ? { category: vhState.cat } : {}) });
  const d = await api(`/customers/${id}/visits?${qs}`);
  const chip = (k, n) => `<button class="ptab ${vhState.cat === k ? 'on' : ''}" onclick="visitHistoryModal(${id}, '${k}')">${k ? VL[k] : 'All'} <b>${n}</b></button>`;
  const total = Object.values(d.summary).reduce((a, b) => a + b, 0);
  openModal(`<div class="row" style="justify-content:space-between;align-items:flex-end;gap:12px">
      <div><h3 style="margin:0">Visit history</h3><p class="small muted" style="margin:4px 0 0">${dmyT(d.from)} to ${dmyT(d.to)}${d.reliability != null ? ` · <b>${d.reliability}%</b> of visits due were completed` : ''}</p></div>
      <div class="row" style="gap:6px"><input type="date" value="${d.from}" onchange="vhState.from=this.value;visitHistoryModal(${id}, vhState.cat)" style="width:auto">
        <input type="date" value="${d.to}" onchange="vhState.to=this.value;visitHistoryModal(${id}, vhState.cat)" style="width:auto"></div></div>
    <div class="ptabs" style="flex-wrap:wrap;margin:12px 0">${chip('', total)}${Object.keys(VL).filter(k => d.summary[k]).map(k => chip(k, d.summary[k])).join('')}</div>
    <div style="max-height:420px;overflow:auto"><table><tr><th>Date</th><th>Site</th><th>Status</th><th>Details</th><th>Driver</th><th></th></tr>
    ${d.rows.length ? d.rows.map(v => `<tr><td>${dmyT(v.date)}</td><td class="small">${esc(v.branch || '')}</td>
      <td><span class="pill ${VC[v.category]}">${esc(VL[v.category])}</span></td>
      <td class="small">${esc(v.detail)}${v.issue_id ? `<br><a href="#" onclick="closeModal();openIssue(${v.issue_id});return false">${icon('messageSquare', 11)} issue raised</a>` : ''}</td>
      <td class="small muted">${esc(v.driver || '')}</td>
      <td>${v.photo_url ? `<button class="btn ghost small" onclick="viewPhoto('${esc(v.photo_url)}')">Photo</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No visits in this group.</td></tr>'}
    </table></div>
    <div class="row" style="margin-top:12px"><button class="btn ghost" onclick="closeModal()">Close</button></div>`, 'xl');
}

// ══ BOOKINGS: tier priority badge ════════════════════════════
(function () {
  if (typeof bookings !== 'function') return;
  const base = bookings;
  bookings = async function () {
    await base();
    let rows = [];
    try { rows = await api('/bookings'); } catch { return; }
    const trs = [...document.querySelectorAll('#main table tr')].slice(1);
    rows.forEach((b, k) => {
      const td = trs[k] && trs[k].children[1];
      if (!td || !b.tier) return;
      td.insertAdjacentHTML('beforeend', `<br><span class="pill ${b.priority ? 'canceled' : 'ended'}" title="Green tier">${b.priority ? 'Priority · ' : ''}${esc(b.tier)}</span>`);
    });
  };
})();
