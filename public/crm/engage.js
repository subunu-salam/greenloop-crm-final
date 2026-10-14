// ─────────────────────────────────────────────────────────────
// GreenLoop CRM — customer engagement (v3.8, add-on screens)
//   visitRatings()  stars from customers, low ratings to follow up, driver averages
//   busyPeriods()   "expecting more waste" periods and their extra visits
//   weeklyEmails()  Sunday summary email: status, preview, test, log, recipients
// Data: server/engage.js. Uses app.js / growth.js / care.js helpers.
// ─────────────────────────────────────────────────────────────
PATHS.star = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';

(function addEngageNav() {
  const at = page => NAV.findIndex(n => n[0] === page);
  NAV.splice(at('customerIssues') + 1, 0, ['visitRatings', 'star', 'Visit ratings'], ['busyPeriods', 'calendar', 'Busy periods'], ['weeklyEmails', 'mail', 'Weekly emails']);
  const navEl = document.getElementById('nav');
  if (navEl && navEl.children.length) { buildNav(); document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === currentPage)); }
  const hook = setInterval(() => {
    if (typeof socket === 'undefined' || !socket || !socket.on) return;
    clearInterval(hook);
    socket.on('ratings:changed', () => refreshIf(['visitRatings']));
    socket.on('events:changed', () => refreshIf(['busyPeriods']));
  }, 1000);
})();

const stars = n => `<span style="color:${n <= 2 ? 'var(--red)' : n === 3 ? 'var(--amber)' : 'var(--green)'};letter-spacing:1px;white-space:nowrap">${'★'.repeat(n)}<span style="opacity:.25">${'★'.repeat(5 - n)}</span></span>`;

// ══ VISIT RATINGS ════════════════════════════════════════════
let ratingFilter = 'todo';
async function visitRatings() {
  const d = await api('/ratings' + (ratingFilter === 'all' ? '' : '?filter=' + ratingFilter));
  const s = d.summary;
  const tab = (k, l) => `<button class="ptab ${ratingFilter === k ? 'on' : ''}" onclick="ratingFilter='${k}';visitRatings()">${l}</button>`;
  $('#main').innerHTML = `
    <div class="head"><div><h1>Visit ratings</h1>
      <p class="sub">After each pickup the customer can give 1 to 5 stars and a comment. 1 and 2 star ratings alert the office and lower the customer's health score.</p></div></div>
    <div class="kpis">
      <div class="kpi green"><div class="num">${s.last30.avg ?? '—'}${s.last30.avg ? '<span style="font-size:16px"> / 5</span>' : ''}</div><div class="lbl">${icon('star', 13)} Average, last 30 days</div></div>
      <div class="kpi blue"><div class="num">${s.last30.happy_pct ?? '—'}${s.last30.happy_pct != null ? '%' : ''}</div><div class="lbl">${icon('checkCircle', 13)} Rated 4 or 5 stars</div></div>
      <div class="kpi red"><div class="num">${s.to_follow_up}</div><div class="lbl">${icon('alertTriangle', 13)} Low ratings to follow up</div></div>
      <div class="kpi violet"><div class="num">${s.rated_share ?? '—'}${s.rated_share != null ? '%' : ''}</div><div class="lbl">${icon('users', 13)} Visits rated by customers</div></div>
    </div>
    <div class="grid3">
      <div>
        <div class="row" style="margin-bottom:12px"><div class="ptabs">${tab('todo', 'To follow up')}${tab('low', '1-2 stars')}${tab('all', 'All ratings')}</div></div>
        <div class="card scroll-x"><table><tr><th>Visit</th><th>Customer</th><th>Rating</th><th>Comment</th><th>Driver</th><th>Follow-up</th></tr>
        ${d.rows.length ? d.rows.map(x => `<tr>
          <td class="small">${dmyT(x.scheduled_date)}</td>
          <td><b>${esc(x.name)}</b><br><span class="muted small">${esc(x.branch || '')}</span></td>
          <td>${stars(x.stars)}</td>
          <td class="small">${x.comment ? esc(x.comment) : '<span class="muted">—</span>'}</td>
          <td class="small">${esc(x.driver || '—')}</td>
          <td class="small">${x.followed_up_at ? `${icon('check', 12)} ${esc(x.followed_up_by || '')}<br><span class="muted">${esc(x.follow_up_note || '')}</span>`
            : x.stars <= 2 ? `<div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn primary small" onclick="ratingFollowUp(${x.id})">Mark handled</button><button class="btn ghost small" onclick="logContactForm(${x.customer_id})">Log contact</button></div>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="muted">${ratingFilter === 'todo' ? 'No low ratings waiting. 🎉' : 'No ratings yet.'}</td></tr>`}
        </table></div>
      </div>
      <div class="card"><h3>Drivers, last 90 days</h3>
        <table><tr><th>Driver</th><th>Average</th><th>Ratings</th><th>1-2★</th></tr>
        ${d.drivers.length ? d.drivers.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${stars(Math.round(r.avg))} <b>${r.avg}</b></td><td>${r.n}</td><td>${r.low ? `<span class="pill canceled">${r.low}</span>` : '0'}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No ratings yet.</td></tr>'}
        </table>
        <p class="small muted" style="margin-top:10px">Use this in driver reviews: one bad day is normal, a pattern is worth a talk.</p></div>
    </div>`;
}
async function ratingFollowUp(id) {
  const note = prompt('What did you do about it? (shown in the CRM only)', 'Called the customer and apologised');
  if (note === null) return;
  try { await api(`/ratings/${id}/follow-up`, { method: 'POST', body: { note } }); toast('Marked as handled', 'success'); visitRatings(); }
  catch (e) { toast(e.message, 'critical'); }
}

// ══ BUSY PERIODS ═════════════════════════════════════════════
let busyAll = false;
async function busyPeriods() {
  const d = await api('/events' + (busyAll ? '?all=1' : ''));
  const owner = CRM_ROLE === 'owner';
  const sug = d.suggested || {};
  $('#main').innerHTML = `
    <div class="head"><div><h1>Busy periods</h1>
      <p class="sub">Customers tap "Expecting more waste" before Ramadan, Eid, a sale or a stock clearance, and extra visits are planned automatically. You can also plan one for a customer.</p></div>
      <div class="row" style="gap:8px"><button class="btn primary" onclick="busyForm()">${icon('plus', 13)} Plan for a customer</button></div></div>
    <div class="kpis">
      <div class="kpi blue"><div class="num">${d.summary.active}</div><div class="lbl">${icon('calendar', 13)} Upcoming or running</div></div>
      <div class="kpi green"><div class="num">${d.summary.extra_visits}</div><div class="lbl">${icon('truck', 13)} Extra visits planned</div></div>
      <div class="kpi ${d.summary.unallocated ? 'red' : 'violet'}"><div class="num">${d.summary.unallocated}</div><div class="lbl">${icon('alertTriangle', 13)} Need a vehicle</div></div>
    </div>
    <div class="row" style="margin-bottom:12px"><div class="ptabs"><button class="ptab ${!busyAll ? 'on' : ''}" onclick="busyAll=false;busyPeriods()">Upcoming</button><button class="ptab ${busyAll ? 'on' : ''}" onclick="busyAll=true;busyPeriods()">All, incl. past and cancelled</button></div></div>
    <div class="card scroll-x"><table><tr><th>Customer</th><th>Occasion</th><th>Dates</th><th>Expected</th><th>Extra visits</th><th>Est. cost</th><th></th></tr>
    ${d.rows.length ? d.rows.map(e => `<tr>
      <td><b>${esc(e.name)}</b><br><span class="muted small">${esc(e.branch || '')} · <span class="zone-tag">${esc(e.zone)}</span></span></td>
      <td><b>${esc(e.label)}</b>${e.label !== e.kind_label ? `<br><span class="small muted">${esc(e.kind_label)}</span>` : ''}${e.status === 'cancelled' ? '<br><span class="pill ended">cancelled</span>' : ''}</td>
      <td class="small">${dmyT(e.start_date)} to ${dmyT(e.end_date)}</td>
      <td class="small">${esc(e.level_label)}<br><span class="muted">+${e.per_week} a week</span></td>
      <td class="small">${e.visits.map(v => `<span class="pill ${v.status === 'collected' ? 'collected' : 'sent'}" style="margin:1px">${dmyT(v.scheduled_date).slice(0, 5)}</span>`).join(' ') || '—'}
        ${e.unallocated ? `<br><span class="pill canceled">${e.unallocated} need a vehicle</span>` : ''}</td>
      <td class="small">AED ${Number(e.est_total).toFixed(2)}<br><span class="muted">+ VAT</span></td>
      <td>${e.status === 'planned' ? `<button class="btn ghost small" onclick="cancelBusy(${e.id})">Cancel</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">No busy periods planned.</td></tr>'}
    </table></div>
    <div class="card"><h3>UAE dates customers are offered</h3>
      <p class="small muted">Lunar dates move every year. Update them when they are announced; customers see these as suggestions.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:10px">
      ${['ramadan', 'eid_fitr', 'eid_adha', 'national_day'].map(k => `<div>${field(esc(d.kinds[k]), `<div class="row" style="gap:6px;flex-wrap:nowrap"><input type="date" id="ud-${k}-s" value="${(sug[k] || [])[0] || ''}" ${owner ? '' : 'disabled'}><input type="date" id="ud-${k}-e" value="${(sug[k] || [])[1] || ''}" ${owner ? '' : 'disabled'}></div>`)}</div>`).join('')}
      </div>
      ${owner ? '<button class="btn primary" onclick="saveUaeDates()">Save dates</button>' : ''}</div>`;
}
async function busyForm() {
  const [cs, d] = await Promise.all([api('/customers'), api('/events')]);
  const kinds = Object.entries(d.kinds);
  openModal(`<h3>Plan a busy period</h3>
    ${field('Customer', `<select id="bf-c">${cs.filter(c => c.is_active).map(c => `<option value="${c.id}">${esc(c.name)} · ${esc(c.branch || '')}</option>`).join('')}</select>`)}
    <div class="grid2" style="gap:10px">
      ${field('Occasion', `<select id="bf-k" onchange="busyFill()">${kinds.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>`)}
      ${field('Name (optional)', '<input id="bf-l" placeholder="e.g. Summer clearance">')}
      ${field('From', `<input id="bf-s" type="date">`)}${field('To', `<input id="bf-e" type="date">`)}
    </div>
    ${field('How much more waste?', '<select id="bf-lv"><option value="more">A bit more: +1 visit a week</option><option value="much_more">A lot more: +2 visits a week</option></select>')}
    <div id="bf-out" class="small muted" style="margin:8px 0"></div>
    <div class="row"><button class="btn primary" onclick="saveBusy()">Plan extra visits</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
  window._busySug = d.suggested || {};
  busyFill();
}
function busyFill() {
  const k = $('#bf-k').value, s = (window._busySug || {})[k];
  if (s) { $('#bf-s').value = s[0]; $('#bf-e').value = s[1]; }
}
async function saveBusy() {
  try {
    const r = await api('/events', { method: 'POST', body: { customer_id: $('#bf-c').value, kind: $('#bf-k').value, label: $('#bf-l').value, start_date: $('#bf-s').value, end_date: $('#bf-e').value, level: $('#bf-lv').value } });
    closeModal(); toast(`${r.created} extra visit${r.created === 1 ? '' : 's'} planned${r.unallocated ? `, ${r.unallocated} need a vehicle` : ''}. The customer has been told.`, r.unallocated ? 'warning' : 'success'); busyPeriods();
  } catch (e) { $('#bf-out').textContent = e.message; toast(e.message, 'critical'); }
}
async function cancelBusy(id) {
  if (!confirm('Cancel this busy period? Extra visits that have not happened yet are removed and the customer is told.')) return;
  try { const r = await api('/events/' + id, { method: 'DELETE' }); toast(`Cancelled, ${r.removed} visit${r.removed === 1 ? '' : 's'} removed`, 'success'); busyPeriods(); }
  catch (e) { toast(e.message, 'critical'); }
}
async function saveUaeDates() {
  const body = {};
  ['ramadan', 'eid_fitr', 'eid_adha', 'national_day'].forEach(k => { const s = $(`#ud-${k}-s`).value, e = $(`#ud-${k}-e`).value; if (s && e) body[k] = [s, e]; });
  try { await api('/events/dates', { method: 'PUT', body }); toast('Dates saved', 'success'); } catch (e) { toast(e.message, 'critical'); }
}

// ══ WEEKLY EMAILS ════════════════════════════════════════════
let wePreviewId = null;
async function weeklyEmails() {
  const d = await api('/weekly-email');
  const owner = CRM_ROLE === 'owner';
  const m = d.mail;
  if (!wePreviewId && d.customers.length) wePreviewId = (d.customers.find(c => c.email) || d.customers[0]).id;
  const st = { sent: 'collected', failed: 'canceled', skipped: 'pending' };
  $('#main').innerHTML = `
    <div class="head"><div><h1>Weekly emails</h1>
      <p class="sub">Every Sunday at 8:00 each customer gets a short summary of their week: pickups done, anything not completed, open issues, separation score and the next pickup.</p></div>
      ${owner ? `<div class="row" style="gap:8px"><label class="row" style="gap:6px;margin:0"><input type="checkbox" ${d.enabled ? 'checked' : ''} onchange="weToggle(this.checked)" style="width:auto"> <b>Send every Sunday</b></label>
        <button class="btn ghost" onclick="weSendNow()">${icon('send', 13)} Send this week's now</button></div>` : ''}</div>
    ${m.configured ? '' : `<div class="card" style="border-color:rgba(251,113,133,.5)"><h3>${icon('alertTriangle', 15)} Email is not connected</h3>
      <p class="small">Nothing can be sent until email is set up on the server (Resend, Brevo or Gmail; see DEPLOY.md). Previews below still work.</p></div>`}
    <div class="kpis">
      <div class="kpi green"><div class="num">${d.accounts.eligible}</div><div class="lbl">${icon('mail', 13)} Customers who will get it</div></div>
      <div class="kpi amber"><div class="num">${d.accounts.no_email}</div><div class="lbl">${icon('alertTriangle', 13)} No email address saved</div></div>
      <div class="kpi violet"><div class="num">${d.accounts.opted_out}</div><div class="lbl">${icon('x', 13)} Switched off</div></div>
      <div class="kpi blue"><div class="num" style="font-size:20px">${d.last_week ? dmyT(d.last_week) : '—'}</div><div class="lbl">${icon('calendar', 13)} Last week sent (week ending)</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>Preview</h3>
        <div class="row" style="gap:8px;margin-bottom:10px;flex-wrap:nowrap"><select id="we-c" onchange="wePreviewId=Number(this.value);wePreview()">${d.customers.map(c => `<option value="${c.id}" ${c.id === wePreviewId ? 'selected' : ''}>${esc(c.name)} · ${esc(c.branch || '')}${c.email ? '' : ' (no email)'}</option>`).join('')}</select></div>
        <div id="we-subject" class="small" style="margin-bottom:8px"></div>
        <iframe id="we-frame" style="width:100%;height:560px;border:1px solid var(--line);border-radius:12px;background:#fff"></iframe>
        ${owner ? `<div class="row" style="gap:8px;margin-top:10px;flex-wrap:nowrap"><input id="we-to" type="email" placeholder="Send a test to (e.g. your email)"><button class="btn primary" onclick="weTest()">Send test</button></div>` : ''}
      </div>
      <div>
        <div class="card"><h3>Who gets it</h3>
          <div style="max-height:300px;overflow:auto"><table><tr><th>Customer</th><th>Email</th><th>Weekly email</th></tr>
          ${d.customers.map(c => `<tr><td><b>${esc(c.name)}</b><br><span class="small muted">${esc(c.branch || '')}</span></td><td class="small">${c.email ? esc(c.email) : '<span class="pill pending">missing</span>'}</td>
            <td><input type="checkbox" ${c.weekly_email ? 'checked' : ''} ${c.email ? '' : 'disabled'} onchange="weCustomer(${c.id}, this.checked)" style="width:auto"></td></tr>`).join('')}
          </table></div>
          <p class="small muted" style="margin-top:8px">Add missing emails in Customers → Edit. Customers can also switch it off themselves in the app.</p></div>
        <div class="card"><h3>Recent sends</h3>
          <div style="max-height:280px;overflow:auto"><table><tr><th>Week ending</th><th>Customer</th><th>Status</th></tr>
          ${d.log.length ? d.log.map(l => `<tr><td class="small">${dmyT(l.week)}</td><td class="small"><b>${esc(l.name)}</b><br><span class="muted">${esc(l.to_email || '')}</span></td>
            <td><span class="pill ${st[l.status] || 'ended'}">${esc(l.status)}</span>${l.error ? `<br><span class="small muted">${esc(l.error)}</span>` : ''}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">Nothing sent yet.</td></tr>'}
          </table></div></div>
      </div>
    </div>`;
  wePreview();
}
async function wePreview() {
  if (!wePreviewId) return;
  try {
    const p = await api('/weekly-email/preview/' + wePreviewId);
    $('#we-subject').innerHTML = `<b>To:</b> ${esc(p.to || 'no email saved')} &nbsp; <b>Subject:</b> ${esc(p.subject)}`;
    $('#we-frame').srcdoc = p.html;
  } catch (e) { toast(e.message, 'critical'); }
}
async function weTest() {
  try { const r = await api('/weekly-email/test', { method: 'POST', body: { customer_id: wePreviewId, to: $('#we-to').value } }); toast('Test sent to ' + r.to, 'success'); }
  catch (e) { toast(e.message, 'critical'); }
}
async function weSendNow() {
  if (!confirm("Send this week's summary to every customer now? Customers who already got it this week are skipped.")) return;
  try { const r = await api('/weekly-email/send-now', { method: 'POST' }); toast(r.mail_configured ? `Sent ${r.sent} of ${r.accounts}${r.failed ? `, ${r.failed} failed` : ''}` : 'Email is not connected on the server yet', r.mail_configured && !r.failed ? 'success' : 'warning'); weeklyEmails(); }
  catch (e) { toast(e.message, 'critical'); }
}
async function weToggle(on) { try { await api('/weekly-email/settings', { method: 'PUT', body: { enabled: on } }); toast(on ? 'Weekly emails on' : 'Weekly emails paused', 'success'); } catch (e) { toast(e.message, 'critical'); } }
async function weCustomer(id, on) { try { await api(`/customers/${id}/weekly-email`, { method: 'PUT', body: { enabled: on } }); } catch (e) { toast(e.message, 'critical'); } }
