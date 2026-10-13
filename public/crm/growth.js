// ─────────────────────────────────────────────────────────────
// GreenLoop CRM — growth modules (add-on screens)
//   customerHealth()  at-risk accounts with reasons, mark as contacted
//   greenRewards()    reward requests, settings, catalogue, top sites
//   wasteScans()      scans sent from the customer app, type → service mapping
// Data: server/growth.js. Uses app.js helpers: api, $, esc, icon, toast,
// openModal, closeModal, field, nav, currentPage, CRM_ROLE.
// ─────────────────────────────────────────────────────────────
PATHS.heart = '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>';
PATHS.gift = '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>';
PATHS.scan = '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>';

// add the three screens to the side menu (app.js builds it after sign-in)
(function addGrowthNav() {
  const at = page => NAV.findIndex(n => n[0] === page);
  NAV.splice(at('quotations') + 1, 0, ['wasteScans', 'scan', 'Waste scans']);
  NAV.splice(at('customers') + 1, 0, ['customerHealth', 'heart', 'Customer health'], ['greenRewards', 'gift', 'Green rewards']);
  // if sign-in finished before this file loaded, rebuild the menu so the new items show
  const navEl = document.getElementById('nav');
  if (navEl && navEl.children.length) { buildNav(); document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.page === currentPage)); }
})();

const HB = { healthy: ['Healthy', 'collected'], watch: ['Watch', 'pending'], at_risk: ['At risk', 'canceled'] };
const dmyT = s => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2}:\d{2})?/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ' ' + m[4] : ''}` : '—'; };
const scoreBar = s => `<div style="display:flex;align-items:center;gap:8px"><b style="min-width:26px">${s}</b>
  <div style="flex:1;min-width:70px;height:6px;border-radius:4px;background:var(--glass2)"><i style="display:block;height:100%;width:${s}%;border-radius:4px;background:${s >= 70 ? 'var(--green)' : s >= 40 ? 'var(--amber)' : 'var(--red)'}"></i></div></div>`;

// ══ CUSTOMER HEALTH ══════════════════════════════════════════
let healthBand = 'risk';
async function customerHealth() {
  const d = await api('/health-scores');
  const rows = d.rows.filter(h => healthBand === 'all' ? true : healthBand === 'risk' ? h.band !== 'healthy' : h.band === healthBand);
  const tab = (k, l) => `<button class="ptab ${healthBand === k ? 'on' : ''}" onclick="healthBand='${k}';customerHealth()">${l}</button>`;
  $('#main').innerHTML = `
    <div class="head">
      <div><h1>Customer health</h1>
      <p class="sub">Score from 0 to 100 for each site, worked out every night from missed pickups, disputes, overdue invoices and booking drops. Last run ${dmyT(d.last_run)}.</p></div>
      <button class="btn ghost" onclick="recalcHealth()">${icon('refresh', 13)} Recalculate now</button>
    </div>
    <div class="kpis">
      <div class="kpi red"><div class="num">${d.summary.at_risk}</div><div class="lbl">${icon('alertTriangle', 13)} At risk (below 40)</div></div>
      <div class="kpi amber"><div class="num">${d.summary.watch}</div><div class="lbl">${icon('clock', 13)} Watch (40 to 69)</div></div>
      <div class="kpi green"><div class="num">${d.summary.healthy}</div><div class="lbl">${icon('checkCircle', 13)} Healthy (70+)</div></div>
    </div>
    <div class="row" style="margin-bottom:12px"><div class="ptabs">${tab('risk', 'Needs attention')}${tab('at_risk', 'At risk')}${tab('watch', 'Watch')}${tab('healthy', 'Healthy')}${tab('all', 'All')}</div></div>
    <div class="card"><table>
      <tr><th>Customer</th><th style="width:170px">Score</th><th>Status</th><th>Why</th><th>Follow-up</th><th></th></tr>
      ${rows.length ? rows.map(h => `<tr>
        <td><b>${esc(h.name)}</b><br><span class="muted small">${esc(h.branch || '')} · <span class="zone-tag">${esc(h.zone)}</span></span></td>
        <td>${scoreBar(h.score)}</td>
        <td><span class="pill ${HB[h.band][1]}">${HB[h.band][0]}</span>${h.prev_band && h.prev_band !== h.band ? `<br><span class="muted small">was ${HB[h.prev_band][0]}</span>` : ''}</td>
        <td class="small">${h.reasons.length ? h.reasons.map(esc).join('<br>') : '<span class="muted">No issues</span>'}</td>
        <td class="small">${h.contacted_at ? `${icon('check', 12)} ${dmyT(h.contacted_at)}<br><span class="muted">${esc(h.contacted_by || '')}${h.contact_note ? ': ' + esc(h.contact_note) : ''}</span>` : h.band === 'healthy' ? '' : '<span class="muted">Not contacted</span>'}</td>
        <td class="row" style="gap:6px;flex-wrap:nowrap">
          ${h.band !== 'healthy' ? `<button class="btn primary small" onclick="healthContact(${h.customer_id}, '${esc(h.name).replace(/'/g, '&#39;')}')">Mark contacted</button>` : ''}
          <button class="btn ghost small" onclick="customer360(${h.customer_id})">360</button></td>
      </tr>`).join('') : `<tr><td colspan="6" class="muted">No customers in this group.</td></tr>`}
    </table></div>`;
}
async function recalcHealth() {
  const r = await api('/health-scores/recalculate', { method: 'POST' });
  toast(`Scores updated for ${r.customers} customers${r.newly_at_risk ? ` · ${r.newly_at_risk} newly at risk` : ''}`, r.newly_at_risk ? 'warning' : 'success');
  customerHealth();
}
function healthContact(id, name) {
  openModal(`<h3>Mark ${name} as contacted</h3>
    ${field('What was agreed?', '<textarea id="hc-note" rows="3" placeholder="e.g. Spoke to the store manager, extra pickup booked for Thursday"></textarea>')}
    <div class="row"><button class="btn primary" onclick="saveHealthContact(${id})">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
}
async function saveHealthContact(id) {
  try { await api(`/health-scores/${id}/contacted`, { method: 'POST', body: { note: $('#hc-note').value } }); closeModal(); toast('Follow-up saved', 'success'); customerHealth(); }
  catch (e) { toast(e.message, 'critical'); }
}

// ══ GREEN REWARDS ════════════════════════════════════════════
async function greenRewards() {
  const d = await api('/rewards/overview');
  const owner = CRM_ROLE === 'owner';
  const rt = d.ratings || {};
  const rated = (rt.good || 0) + (rt.average || 0) + (rt.poor || 0);
  const goodPct = rated ? Math.round(100 * (rt.good || 0) / rated) : 0;
  const open = d.redemptions.filter(x => x.status === 'requested' || x.status === 'approved');
  const act = x => !owner ? '' : x.status === 'requested'
    ? `<button class="btn primary small" onclick="decideReward(${x.id},'approve')">Approve</button><button class="btn ghost small" onclick="decideReward(${x.id},'reject')">Decline</button>`
    : x.status === 'approved' ? `<button class="btn primary small" onclick="decideReward(${x.id},'applied')">Applied to invoice</button>` : '';
  $('#main').innerHTML = `
    <div class="head"><div><h1>Green rewards</h1>
      <p class="sub">Drivers rate segregation at each finished pickup. Customers earn points and swap them for invoice discounts.</p></div></div>
    <div class="kpis">
      <div class="kpi green"><div class="num">${d.issued_this_month}</div><div class="lbl">${icon('gift', 13)} Points earned this month</div></div>
      <div class="kpi blue"><div class="num">${goodPct}%</div><div class="lbl">${icon('checkCircle', 13)} Pickups rated Good</div></div>
      <div class="kpi amber"><div class="num">${open.length}</div><div class="lbl">${icon('inbox', 13)} Requests to handle</div></div>
      <div class="kpi violet"><div class="num">${rt.unrated || 0}</div><div class="lbl">${icon('clock', 13)} Finished, not rated</div></div>
    </div>
    <div class="card"><h3>Reward requests</h3>
      <p class="muted small">Approve, then take the discount off the customer's next invoice and mark it applied. Declining returns the points.</p>
      <table><tr><th>Requested</th><th>Customer</th><th>Reward</th><th>Points</th><th>Discount</th><th>Status</th><th></th></tr>
      ${d.redemptions.length ? d.redemptions.map(x => `<tr><td class="small">${dmyT(x.created_at)}</td>
        <td><b>${esc(x.name)}</b><br><span class="muted small">${esc(x.branch || '')}</span></td>
        <td>${esc(x.reward_name)}</td><td>${x.points}</td><td>AED ${Number(x.discount_aed).toFixed(2)}</td>
        <td><span class="pill ${esc(x.status)}">${esc(x.status)}</span>${x.decided_by ? `<br><span class="muted small">${esc(x.decided_by)}</span>` : ''}</td>
        <td class="row" style="gap:6px;flex-wrap:nowrap">${act(x)}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No reward requests yet.</td></tr>'}
      </table></div>
    <div class="grid2">
      <div class="card"><h3>Top sites this month</h3>
        <table><tr><th>#</th><th>Customer</th><th>Zone</th><th>Points</th></tr>
        ${d.top.length ? d.top.map((t, i) => `<tr><td>${i + 1}</td><td><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.branch || '')}</span></td><td><span class="zone-tag">${esc(t.zone)}</span></td><td><b>${t.points}</b></td></tr>`).join('') : '<tr><td colspan="4" class="muted">No points earned yet this month.</td></tr>'}
        </table></div>
      <div class="card"><h3>Points rules</h3>
        <div class="grid2" style="gap:10px">
          ${field('Good segregation', `<input id="rw-good" type="number" min="0" value="${d.settings.good}" ${owner ? '' : 'disabled'}>`)}
          ${field('Average', `<input id="rw-average" type="number" min="0" value="${d.settings.average}" ${owner ? '' : 'disabled'}>`)}
          ${field('Poor', `<input id="rw-poor" type="number" min="0" value="${d.settings.poor}" ${owner ? '' : 'disabled'}>`)}
          ${field('Monthly cap per site (0 = none)', `<input id="rw-cap" type="number" min="0" value="${d.settings.monthly_cap}" ${owner ? '' : 'disabled'}>`)}
        </div>
        ${owner ? `<button class="btn primary" onclick="saveRewardSettings()">Save rules</button>` : '<p class="muted small">Only the owner can change these.</p>'}
        <h3 style="margin-top:18px">Rewards customers can choose</h3>
        <table><tr><th>Reward</th><th>Points</th><th>Discount</th><th></th></tr>
        ${d.catalog.map(c => `<tr><td>${esc(c.name)}${c.is_active ? '' : ' <span class="pill ended">hidden</span>'}</td><td>${c.points_cost}</td><td>AED ${Number(c.discount_aed).toFixed(2)}</td>
          <td>${owner ? `<button class="btn ghost small" onclick='rewardForm(${JSON.stringify(c).replace(/'/g, '&#39;')})'>Edit</button>` : ''}</td></tr>`).join('')}
        </table>
        ${owner ? `<button class="btn ghost" onclick="rewardForm()">${icon('plus', 13)} Add reward</button>` : ''}
      </div>
    </div>`;
}
async function decideReward(id, action) {
  let note = '';
  if (action === 'reject') { note = prompt('Reason for declining (shown to the customer):', '') ; if (note === null) return; }
  try { await api(`/rewards/redemptions/${id}/decide`, { method: 'POST', body: { action, note } }); toast(action === 'reject' ? 'Declined, points returned' : action === 'approve' ? 'Approved, customer notified' : 'Marked as applied', 'success'); greenRewards(); }
  catch (e) { toast(e.message, 'critical'); }
}
async function saveRewardSettings() {
  try {
    await api('/rewards/settings', { method: 'PUT', body: { good: $('#rw-good').value, average: $('#rw-average').value, poor: $('#rw-poor').value, monthly_cap: $('#rw-cap').value } });
    toast('Points rules saved', 'success');
  } catch (e) { toast(e.message, 'critical'); }
}
function rewardForm(c = {}) {
  openModal(`<h3>${c.id ? 'Edit reward' : 'Add reward'}</h3>
    ${field('Name customers see', `<input id="rf-name" value="${esc(c.name || '')}" placeholder="e.g. AED 25 off your next invoice">`)}
    <div class="grid2" style="gap:10px">${field('Points needed', `<input id="rf-points" type="number" min="1" value="${c.points_cost || ''}">`)}
    ${field('Discount (AED)', `<input id="rf-disc" type="number" min="0" step="0.01" value="${c.discount_aed ?? ''}">`)}</div>
    ${c.id ? `<label class="row" style="gap:8px;margin:6px 0 12px"><input id="rf-active" type="checkbox" ${c.is_active ? 'checked' : ''} style="width:auto"> Show to customers</label>` : ''}
    <div class="row"><button class="btn primary" onclick="saveReward(${c.id || 0})">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
}
async function saveReward(id) {
  const body = { name: $('#rf-name').value, points_cost: $('#rf-points').value, discount_aed: $('#rf-disc').value };
  if (id) body.is_active = $('#rf-active').checked;
  try { await api(id ? `/rewards/catalog/${id}` : '/rewards/catalog', { method: id ? 'PUT' : 'POST', body }); closeModal(); toast('Reward saved', 'success'); greenRewards(); }
  catch (e) { toast(e.message, 'critical'); }
}

// ══ WASTE SCANS ══════════════════════════════════════════════
async function wasteScans() {
  const d = await api('/waste-scans');
  const owner = CRM_ROLE === 'owner';
  const svc = code => (d.services.find(s => s.code === code) || {}).name || code;
  $('#main').innerHTML = `
    <div class="head"><div><h1>Waste scans</h1>
      <p class="sub">Customers photograph their waste in the app, see the type and an estimate, and can send a quote request. Requests arrive in Leads with the details filled in.</p></div>
      <span class="pill ${d.ai ? 'collected' : 'pending'}" style="align-self:center">${d.ai ? 'AI scanning on' : 'AI scanning off: customers choose types by hand'}</span>
    </div>
    <div class="card"><table>
      <tr><th>Date</th><th>Customer</th><th>Photo</th><th>Waste found</th><th>Suggested</th><th>Quote request</th></tr>
      ${d.rows.length ? d.rows.map(s => `<tr>
        <td class="small">${dmyT(s.created_at)}<br><span class="muted">${s.source === 'ai' ? 'AI' : 'Chosen by customer'}</span></td>
        <td><b>${esc(s.name)}</b><br><span class="muted small">${esc(s.branch || '')}</span></td>
        <td>${s.photo_url ? `<img src="${esc(s.photo_url)}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;cursor:pointer" onclick="viewPhoto('${esc(s.photo_url)}')">` : '<span class="muted small">—</span>'}</td>
        <td class="small">${s.categories.map(c => esc(c.label) + (c.share_pct != null ? ` ${c.share_pct}%` : '')).join('<br>')}<br><span class="muted">Volume: ${esc(s.volume)}</span>
          ${s.hazardous ? '<br><span class="pill canceled">Special handling</span>' : ''}${s.summary ? `<br><span class="muted">${esc(s.summary)}</span>` : ''}</td>
        <td class="small">${esc(svc(s.service_code))}<br>${s.est_price != null ? `AED ${Number(s.est_price).toFixed(2)} / visit` : ''}</td>
        <td>${s.lead_id ? `<span class="pill ${esc(s.lead_stage || 'new')}">${esc(s.lead_stage || 'new')}</span><br><button class="btn ghost small" style="margin-top:4px" onclick="nav('leads')">Open leads</button>` : '<span class="muted small">Not requested</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">No scans yet.</td></tr>'}
    </table></div>
    <div class="card"><h3>Waste type → service</h3>
      <p class="muted small">Decides which service and price the app suggests. Large volumes always move to the bulk service.</p>
      <table><tr><th>Waste type</th><th>Service</th><th>Special handling</th><th>Tip shown to the customer</th><th></th></tr>
      ${d.rules.map(r => `<tr><td><b>${esc(r.label)}</b></td>
        <td>${owner ? `<select id="sr-svc-${r.category}">${d.services.map(s => `<option value="${esc(s.code)}" ${s.code === r.service_code ? 'selected' : ''}>${esc(s.name)} (AED ${s.default_price})</option>`).join('')}</select>` : esc(svc(r.service_code))}</td>
        <td>${owner ? `<input type="checkbox" id="sr-haz-${r.category}" ${r.hazardous ? 'checked' : ''} style="width:auto">` : r.hazardous ? 'Yes' : 'No'}</td>
        <td>${owner ? `<input id="sr-tip-${r.category}" value="${esc(r.tip)}">` : esc(r.tip)}</td>
        <td>${owner ? `<button class="btn ghost small" onclick="saveScanRule('${r.category}')">Save</button>` : ''}</td></tr>`).join('')}
      </table>
      ${d.ai ? '' : '<p class="muted small" style="margin-top:10px">To turn on photo recognition, set ANTHROPIC_API_KEY (or OPENAI_API_KEY) on the server and restart.</p>'}
    </div>`;
}
async function saveScanRule(cat) {
  try {
    await api(`/waste-scan-rules/${cat}`, { method: 'PUT', body: { service_code: $('#sr-svc-' + cat).value, hazardous: $('#sr-haz-' + cat).checked, tip: $('#sr-tip-' + cat).value } });
    toast('Saved', 'success');
  } catch (e) { toast(e.message, 'critical'); }
}
