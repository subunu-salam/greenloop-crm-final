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

// Demo data buttons (owner): fill or clear Customer health and Green rewards for a sales demo
let demoLoaded = null;
async function demoButtons(page) {
  if (CRM_ROLE !== 'owner') return '';
  try { demoLoaded = (await api('/growth/demo')).loaded; } catch { demoLoaded = false; }
  return demoLoaded
    ? `<button class="btn ghost" onclick="clearDemoData('${page}')">${icon('x', 13)} Remove demo data</button>`
    : `<button class="btn ghost" onclick="loadDemoData('${page}')">${icon('sparkle', 13)} Load demo data</button>`;
}
async function loadDemoData(page) {
  try { const r = await api('/growth/demo', { method: 'POST' }); toast(`Demo data loaded. Customer app demo: ${r.demo_customer}`, 'success'); window[page](); }
  catch (e) { toast(e.message, 'critical'); }
}
async function clearDemoData(page) {
  if (!confirm('Remove all demo pickups, invoices and reward points?')) return;
  try { await api('/growth/demo', { method: 'DELETE' }); toast('Demo data removed', 'success'); window[page](); }
  catch (e) { toast(e.message, 'critical'); }
}

// ══ CUSTOMER HEALTH ══════════════════════════════════════════
let healthBand = 'risk';
const CS = { not_contacted: ['Not contacted', 'pending'], contacted: ['Contacted', 'sent'], follow_up: ['Follow-up scheduled', 'requested'], resolved: ['Resolved', 'collected'] };
const todayYmd = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
async function customerHealth() {
  const [d, demoBtn] = await Promise.all([api('/health-scores'), demoButtons('customerHealth')]);
  const today = todayYmd();
  const due = d.rows.filter(h => h.contact_status === 'follow_up' && h.follow_up_at && h.follow_up_at <= today);
  const rows = d.rows.filter(h => healthBand === 'all' ? true : healthBand === 'risk' ? h.band !== 'healthy' : healthBand === 'due' ? due.includes(h) : h.band === healthBand);
  const tab = (k, l) => `<button class="ptab ${healthBand === k ? 'on' : ''}" onclick="healthBand='${k}';customerHealth()">${l}</button>`;
  const cs = h => { const k = h.contact_status || (h.contacted_at ? 'contacted' : 'not_contacted'); return CS[k] || CS.not_contacted; };
  const followCell = h => {
    if (h.contact_status === 'follow_up' && h.follow_up_at) {
      const late = h.follow_up_at < today, now = h.follow_up_at === today;
      return `<span class="pill ${late ? 'canceled' : now ? 'pending' : 'sent'}">${late ? 'Overdue' : now ? 'Due today' : 'Due'} ${dmyT(h.follow_up_at)}</span>`;
    }
    return '';
  };
  $('#main').innerHTML = `
    <div class="head">
      <div><h1>Customer health</h1>
      <p class="sub">Score from 0 to 100 for each site, worked out every night from missed pickups, disputes, open issues, overdue invoices and booking drops. Last run ${dmyT(d.last_run)}.</p></div>
      <div class="row" style="gap:8px">${demoBtn}<button class="btn ghost" onclick="recalcHealth()">${icon('refresh', 13)} Recalculate now</button></div>
    </div>
    <div class="kpis">
      <div class="kpi red"><div class="num">${d.summary.at_risk}</div><div class="lbl">${icon('alertTriangle', 13)} At risk (below 40)</div></div>
      <div class="kpi amber"><div class="num">${d.summary.watch}</div><div class="lbl">${icon('clock', 13)} Watch (40 to 69)</div></div>
      <div class="kpi green"><div class="num">${d.summary.healthy}</div><div class="lbl">${icon('checkCircle', 13)} Healthy (70+)</div></div>
      <div class="kpi blue"><div class="num">${due.length}</div><div class="lbl">${icon('calendar', 13)} Follow-ups due</div></div>
    </div>
    ${due.length ? `<div class="card" style="border-color:rgba(251,191,36,.45)"><h3>${icon('calendar', 15)} Follow-ups due today</h3>
      ${due.map(h => `<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:nowrap;gap:12px">
        <span><b>${esc(h.name)}</b> <span class="muted small">${esc(h.branch || '')}</span><br><span class="small muted">${esc(h.contact_note || '')}</span></span>
        <span class="row" style="gap:6px;flex-wrap:nowrap">${followCell(h)}<button class="btn primary small" onclick="logContactForm(${h.customer_id})">Log contact</button></span></div>`).join('')}</div>` : ''}
    <div class="row" style="margin-bottom:12px"><div class="ptabs">${tab('risk', 'Needs attention')}${tab('due', 'Follow-ups due')}${tab('at_risk', 'At risk')}${tab('watch', 'Watch')}${tab('healthy', 'Healthy')}${tab('all', 'All')}</div></div>
    <div class="card scroll-x"><table>
      <tr><th>Customer</th><th style="width:150px">Score</th><th>Status</th><th>Why</th><th>Contact</th><th>Last contact</th><th></th></tr>
      ${rows.length ? rows.map(h => `<tr>
        <td><b>${esc(h.name)}</b><br><span class="muted small">${esc(h.branch || '')} · <span class="zone-tag">${esc(h.zone)}</span></span></td>
        <td>${scoreBar(h.score)}</td>
        <td><span class="pill ${HB[h.band][1]}">${HB[h.band][0]}</span>${h.prev_band && h.prev_band !== h.band ? `<br><span class="muted small">was ${HB[h.prev_band][0]}</span>` : ''}</td>
        <td class="small">${h.reasons.length ? h.reasons.map(esc).join('<br>') : '<span class="muted">No issues</span>'}</td>
        <td>${h.band === 'healthy' && !h.contact_status ? '' : `<span class="pill ${cs(h)[1]}">${cs(h)[0]}</span>`}${followCell(h) ? '<br><span style="display:inline-block;margin-top:4px">' + followCell(h) + '</span>' : ''}</td>
        <td class="small">${h.contacted_at ? `${dmyT(h.contacted_at)}<br><span class="muted">${esc(h.contacted_by || '')}${h.contact_note ? ': ' + esc(h.contact_note) : ''}</span>` : '<span class="muted">—</span>'}</td>
        <td><div class="row" style="gap:6px;flex-wrap:nowrap">
          <button class="btn primary small" onclick="logContactForm(${h.customer_id})">Log contact</button>
          <button class="btn ghost small" onclick="visitHistoryModal(${h.customer_id})">Visits</button>
          <button class="btn ghost small" onclick="customer360(${h.customer_id})">360</button></div></td>
      </tr>`).join('') : `<tr><td colspan="7" class="muted">No customers in this group.</td></tr>`}
    </table></div>`;
}
async function recalcHealth() {
  const r = await api('/health-scores/recalculate', { method: 'POST' });
  toast(`Scores updated for ${r.customers} customers${r.newly_at_risk ? ` · ${r.newly_at_risk} newly at risk` : ''}`, r.newly_at_risk ? 'warning' : 'success');
  customerHealth();
}
async function logContactForm(id) {
  const [d, all] = await Promise.all([api(`/health-scores/${id}/contacts`), api('/health-scores')]);
  const h = all.rows.find(x => x.customer_id === id) || {};
  const opt = (o, sel) => Object.entries(o).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  openModal(`<h3>${esc(h.name || 'Customer')} <span class="muted small">${esc(h.branch || '')}</span></h3>
    <p class="small muted">Score ${h.score ?? '—'} · ${(h.reasons || []).map(esc).join(' · ') || 'no issues'}</p>
    ${d.open_issues.length ? `<p class="small">${icon('alertTriangle', 12)} ${d.open_issues.length} open issue${d.open_issues.length === 1 ? '' : 's'}: ${d.open_issues.map(i => `<a href="#" onclick="closeModal();openIssue(${i.id});return false">${esc(i.category_label)}</a>`).join(', ')}</p>` : ''}
    <div class="grid2" style="gap:10px">
      ${field('How', `<select id="lc-method">${opt(d.methods, 'call')}</select>`)}
      ${field('Status after this contact', `<select id="lc-status" onchange="document.getElementById('lc-date-wrap').style.display=this.value==='follow_up'?'':'none'">${opt({ contacted: 'Contacted', follow_up: 'Follow-up scheduled', resolved: 'Resolved', not_contacted: 'Could not reach' }, 'contacted')}</select>`)}
    </div>
    <div id="lc-date-wrap" style="display:none">${field('Follow up on', `<input id="lc-date" type="date" value="${todayYmd()}">`)}</div>
    ${field('What was said or agreed', '<textarea id="lc-note" rows="3" placeholder="e.g. Store manager wants the pickup moved to mornings. Calling back Thursday."></textarea>')}
    <div class="row"><button class="btn primary" onclick="saveContact(${id})">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>
    <h3 style="margin-top:18px">Contact log</h3>
    ${d.contacts.length ? `<table><tr><th>When</th><th>How</th><th>Status</th><th>Note</th><th>By</th></tr>${d.contacts.map(c => `<tr><td class="small">${dmyT(c.created_at)}</td><td class="small">${esc(c.method_label)}</td>
      <td><span class="pill ${(CS[c.contact_status] || CS.contacted)[1]}">${esc(c.status_label)}</span>${c.follow_up_at ? `<br><span class="small muted">follow up ${dmyT(c.follow_up_at)}</span>` : ''}</td>
      <td class="small">${esc(c.note || '')}</td><td class="small muted">${esc(c.by_name || '')}</td></tr>`).join('')}</table>` : '<p class="muted small">No contacts logged yet.</p>'}`, true);
}
async function saveContact(id) {
  try {
    await api(`/health-scores/${id}/contact`, { method: 'POST', body: { method: $('#lc-method').value, contact_status: $('#lc-status').value, follow_up_at: $('#lc-date').value, note: $('#lc-note').value } });
    closeModal(); toast('Contact saved', 'success'); if (currentPage === 'customerHealth') customerHealth();
  } catch (e) { toast(e.message, 'critical'); }
}
// kept for older buttons / links
function healthContact(id) { logContactForm(id); }

// ══ GREEN REWARDS ════════════════════════════════════════════
const TIER_COLOR = { seedling: 'var(--muted)', sapling: 'var(--teal)', tree: 'var(--green)', forest: 'var(--mint)' };
async function greenRewards() {
  const [d, demoBtn] = await Promise.all([api('/rewards/overview'), demoButtons('greenRewards')]);
  const owner = CRM_ROLE === 'owner';
  const rt = d.ratings || {};
  const rated = (rt.good || 0) + (rt.average || 0) + (rt.poor || 0);
  const goodPct = rated ? Math.round(100 * (rt.good || 0) / rated) : 0;
  const open = d.redemptions.filter(x => x.status === 'requested' || x.status === 'approved');
  const dis = d.discounts;
  const act = x => !owner ? '' : x.status === 'requested'
    ? `<button class="btn primary small" onclick="decideReward(${x.id},'approve')">Approve</button><button class="btn ghost small" onclick="decideReward(${x.id},'reject')">Decline</button>`
    : x.status === 'approved' ? `<button class="btn primary small" onclick="decideReward(${x.id},'applied')">${x.discount_aed > 0 ? 'Applied to invoice' : 'Mark delivered'}</button>` : '';
  const dis_on = owner ? '' : 'disabled';
  $('#main').innerHTML = `
    <div class="head"><div><h1>Green rewards</h1>
      <p class="sub">Drivers rate waste separation at each pickup. Customers climb tiers that unlock perks costing you nothing: priority booking, faster issue response, a monthly sustainability certificate and public recognition.</p></div>
      <div class="row" style="gap:8px">${demoBtn}</div></div>
    <div class="kpis">
      <div class="kpi green"><div class="num">${Number(d.impact.diverted_kg).toLocaleString()} kg</div><div class="lbl">${icon('checkCircle', 13)} Kept out of landfill this month (est.)</div></div>
      <div class="kpi blue"><div class="num">${goodPct}%</div><div class="lbl">${icon('target', 13)} Pickups rated Good</div></div>
      <div class="kpi amber"><div class="num">${open.length}</div><div class="lbl">${icon('inbox', 13)} Requests to handle</div></div>
      <div class="kpi ${dis.enabled ? 'red' : 'violet'}"><div class="num">AED ${dis.enabled ? Number(dis.spent_aed).toFixed(0) : '0'}</div><div class="lbl">${icon('wallet', 13)} Reward cost this month${dis.enabled ? ` of ${dis.budget_aed}` : ''}</div></div>
    </div>
    <div class="card"><h3>Tiers</h3>
      <p class="muted small">Tiers follow the share of pickups rated Good over the last 90 days, so small and large sites compete fairly.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
      ${d.tiers.map(t => `<div style="border:1px solid var(--line);border-radius:14px;padding:12px 14px">
        <div class="row" style="justify-content:space-between"><b style="color:${TIER_COLOR[t.key]}">${esc(t.name)}</b><span class="num" style="font-size:22px;font-weight:800">${t.sites}</span></div>
        <div class="small muted">${t.min_visits ? `${t.min_rate}%+ Good · ${t.min_visits}+ rated pickups` : 'Every customer'}</div>
        <ul class="small" style="margin:8px 0 0;padding-left:16px">${t.perks.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`).join('')}
      </div></div>
    <div class="card"><h3>Reward requests</h3>
      <p class="muted small">No-cost perks: approve and arrange. Money-off rewards: approve, take the discount off the next invoice and mark it applied. Declining returns the points.</p>
      <div class="scroll-x"><table><tr><th>Requested</th><th>Customer</th><th>Reward</th><th>Points</th><th>Cost to you</th><th>Status</th><th></th></tr>
      ${d.redemptions.length ? d.redemptions.map(x => `<tr><td class="small">${dmyT(x.created_at)}</td>
        <td><b>${esc(x.name)}</b><br><span class="muted small">${esc(x.branch || '')}</span></td>
        <td>${esc(x.reward_name)}</td><td>${x.points}</td><td>${x.discount_aed > 0 ? 'AED ' + Number(x.discount_aed).toFixed(2) : '<span class="pill collected">None</span>'}</td>
        <td><span class="pill ${esc(x.status)}">${esc(x.status)}</span>${x.decided_by ? `<br><span class="muted small">${esc(x.decided_by)}</span>` : ''}</td>
        <td><div class="row" style="gap:6px;flex-wrap:nowrap">${act(x)}</div></td></tr>`).join('') : '<tr><td colspan="7" class="muted">No reward requests yet.</td></tr>'}
      </table></div></div>
    <div class="grid2">
      <div class="card"><h3>Top sites this month</h3>
        <table><tr><th>#</th><th>Customer</th><th>Zone</th><th>Points</th><th></th></tr>
        ${d.top.length ? d.top.map((t, i) => `<tr><td>${i + 1}</td><td><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.branch || '')}</span></td><td><span class="zone-tag">${esc(t.zone)}</span></td><td><b>${t.points}</b></td>
          <td><button class="btn ghost small" onclick="openCertificate(${t.id})">Certificate</button></td></tr>`).join('') : '<tr><td colspan="5" class="muted">No points earned yet this month.</td></tr>'}
        </table></div>
      <div class="card"><h3>Rules</h3>
        <div class="grid2" style="gap:10px">
          ${field('Points: Good', `<input id="rw-good" type="number" min="0" value="${d.settings.good}" ${dis_on}>`)}
          ${field('Points: OK', `<input id="rw-average" type="number" min="0" value="${d.settings.average}" ${dis_on}>`)}
          ${field('Points: Poor', `<input id="rw-poor" type="number" min="0" value="${d.settings.poor}" ${dis_on}>`)}
          ${field('Points cap per site a month (0 = none)', `<input id="rw-cap" type="number" min="0" value="${d.settings.monthly_cap}" ${dis_on}>`)}
          ${field('Kg collected per visit (impact estimate)', `<input id="rw-kg" type="number" min="1" value="${d.impact_factors.kg_per_visit}" ${dis_on}>`)}
          ${field('Kg CO₂e avoided per kg kept out of landfill', `<input id="rw-co2" type="number" min="0" step="0.05" value="${d.impact_factors.co2_per_kg}" ${dis_on}>`)}
        </div>
        <div style="border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:6px 0 12px">
          <label class="row" style="gap:8px;margin:0"><input id="rw-disc" type="checkbox" ${dis.enabled ? 'checked' : ''} ${dis_on} style="width:auto"> <b>Allow money-off rewards</b></label>
          <p class="small muted" style="margin:6px 0">Off by default. When on, invoice discounts are capped by this monthly budget across all customers.</p>
          ${field('Monthly budget (AED)', `<input id="rw-budget" type="number" min="0" value="${dis.budget_aed}" ${dis_on}>`)}
        </div>
        ${owner ? `<button class="btn primary" onclick="saveRewardSettings()">Save rules</button>` : '<p class="muted small">Only the owner can change these.</p>'}
        <h3 style="margin-top:18px">Rewards customers can choose</h3>
        <table><tr><th>Reward</th><th>Points</th><th>Cost to you</th><th></th></tr>
        ${d.catalog.map(c => `<tr><td>${esc(c.name)}${c.is_active ? '' : ' <span class="pill ended">hidden</span>'}${c.kind === 'discount' && !dis.enabled ? ' <span class="pill ended">off</span>' : ''}${c.description ? `<br><span class="small muted">${esc(c.description)}</span>` : ''}</td>
          <td>${c.points_cost}</td><td>${c.discount_aed > 0 ? 'AED ' + Number(c.discount_aed).toFixed(2) : '<span class="pill collected">None</span>'}</td>
          <td>${owner ? `<button class="btn ghost small" onclick='rewardForm(${JSON.stringify(c).replace(/'/g, '&#39;')})'>Edit</button>` : ''}</td></tr>`).join('')}
        </table>
        ${owner ? `<button class="btn ghost" onclick="rewardForm()">${icon('plus', 13)} Add reward</button>` : ''}
      </div>
    </div>`;
}
function openCertificate(id) { window.open(`${API}/customers/${id}/certificate?t=${encodeURIComponent(token)}`, '_blank'); }
async function decideReward(id, action) {
  let note = '';
  if (action === 'reject') { note = prompt('Reason for declining (shown to the customer):', ''); if (note === null) return; }
  try { await api(`/rewards/redemptions/${id}/decide`, { method: 'POST', body: { action, note } }); toast(action === 'reject' ? 'Declined, points returned' : action === 'approve' ? 'Approved, customer notified' : 'Marked as done', 'success'); greenRewards(); }
  catch (e) { toast(e.message, 'critical'); }
}
async function saveRewardSettings() {
  try {
    await api('/rewards/settings', { method: 'PUT', body: { good: $('#rw-good').value, average: $('#rw-average').value, poor: $('#rw-poor').value, monthly_cap: $('#rw-cap').value,
      kg_per_visit: $('#rw-kg').value, co2_per_kg: $('#rw-co2').value, discounts_enabled: $('#rw-disc').checked, budget_aed: $('#rw-budget').value } });
    toast('Rules saved', 'success'); greenRewards();
  } catch (e) { toast(e.message, 'critical'); }
}
function rewardForm(c = {}) {
  openModal(`<h3>${c.id ? 'Edit reward' : 'Add reward'}</h3>
    ${field('Name customers see', `<input id="rf-name" value="${esc(c.name || '')}" placeholder="e.g. Priority slot for your next extra pickup">`)}
    ${field('Short description', `<input id="rf-desc" value="${esc(c.description || '')}" placeholder="What the customer gets">`)}
    <div class="grid2" style="gap:10px">${field('Points needed', `<input id="rf-points" type="number" min="1" value="${c.points_cost || ''}">`)}
    ${field('Discount in AED (0 = no-cost perk)', `<input id="rf-disc" type="number" min="0" step="0.01" value="${c.discount_aed ?? 0}">`)}</div>
    ${c.id ? `<label class="row" style="gap:8px;margin:6px 0 12px"><input id="rf-active" type="checkbox" ${c.is_active ? 'checked' : ''} style="width:auto"> Show to customers</label>` : ''}
    <div class="row"><button class="btn primary" onclick="saveReward(${c.id || 0})">Save</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
}
async function saveReward(id) {
  const body = { name: $('#rf-name').value, description: $('#rf-desc').value, points_cost: $('#rf-points').value, discount_aed: $('#rf-disc').value };
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
