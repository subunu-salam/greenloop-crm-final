// ─────────────────────────────────────────────────────────────
// GreenLoop Customer — customer care (v3.7, add-on)
//   Visits tab     "All visits" (grouped: completed, upcoming, missed, not picked
//                  up, disputed, rescheduled) next to the existing photo proof view
//   Issues         report a problem (optionally on a visit, with a photo), follow
//                  the replies, answer back
//   Rewards        tier, perks, streak, badges, impact, sustainability certificate
// Data: server/care.js, server/growth.js. Wraps app.js / growth.js screens.
// ─────────────────────────────────────────────────────────────
(function () {
  const css = document.createElement('style');
  css.textContent = `
    .cc-seg{display:flex;gap:6px;margin-bottom:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:4px}
    .cc-seg button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-weight:800;font-size:13px;padding:9px;border-radius:10px}
    .cc-seg button.on{background:linear-gradient(135deg,var(--teal),var(--teal-d));color:#032}
    .cc-sum{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
    .cc-sum button{border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:14px;padding:10px 4px;font:inherit;text-align:center}
    .cc-sum button.on{border-color:var(--teal);background:rgba(45,212,191,.16)}
    .cc-sum b{display:block;font-size:19px}.cc-sum span{font-size:10.5px;color:var(--muted);line-height:1.2;display:block}
    .cc-v{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}.cc-v:last-child{border-bottom:0}
    .cc-dot{width:10px;height:10px;border-radius:50%;margin-top:6px;flex-shrink:0}
    .cc-v .t{flex:1;min-width:0}.cc-v .t b{display:block}.cc-v .t small{color:var(--muted);display:block}
    .cc-v .a{display:flex;flex-direction:column;gap:4px;align-items:flex-end}
    .cc-chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
    .cc-chip{border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:20px;padding:8px 12px;font:inherit;font-size:13px;font-weight:700}
    .cc-chip.on{background:rgba(45,212,191,.22);border-color:var(--teal);color:#fff}
    .cc-msg{padding:9px 12px;border-radius:12px;border:1px solid var(--line);max-width:88%;margin:6px 0}
    .cc-msg.me{background:var(--card2);margin-left:auto}.cc-msg.them{background:rgba(45,212,191,.14)}
    .cc-msg small{display:block;color:var(--muted);font-size:11px}
    .cc-tier{border-radius:16px;padding:14px;background:linear-gradient(140deg,rgba(34,197,94,.22),rgba(45,212,191,.10));border:1px solid rgba(34,197,94,.35);margin-bottom:12px}
    .cc-tier .n{font-size:24px;font-weight:800}.cc-tier ul{margin:8px 0 0;padding-left:18px;font-size:13px}
    .cc-badges{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin:8px 0}
    .cc-badge{text-align:center;font-size:10.5px;color:var(--muted);line-height:1.2}
    .cc-badge i{display:flex;width:42px;height:42px;border-radius:50%;margin:0 auto 4px;align-items:center;justify-content:center;font-style:normal;font-size:18px;border:2px dashed var(--line)}
    .cc-badge.on{color:var(--text)}.cc-badge.on i{border:2px solid var(--green);background:rgba(34,197,94,.18)}
    .cc-imp{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0}`;
  document.head.appendChild(css);

  const COLOR = { completed: 'var(--green)', upcoming: 'var(--blue)', missed: 'var(--red)', awaiting: 'var(--amber)', cancelled: 'var(--muted)', disputed: 'var(--red)', rescheduled: 'var(--blue)' };
  const SHORT = { completed: 'Completed', upcoming: 'Upcoming', missed: 'Missed', awaiting: 'To confirm', cancelled: 'Not picked up', disputed: 'Disputed', rescheduled: 'Rescheduled' };
  const ISS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
  const ISS_PILL = { open: 'gr-requested', in_progress: 'gr-approved', resolved: 'collected' };
  const dm = s => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2}:\d{2})?/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ' ' + m[4] : ''}` : ''; };

  // ══ VISITS TAB: All visits | Photo proof ══
  let histMode = 'all', vcat = '';
  const baseHistory = loadHistory;
  loadHistory = async function () {
    const el = document.getElementById('v-history');
    const seg = `<div class="cc-seg"><button class="${histMode === 'all' ? 'on' : ''}" onclick="setHistMode('all')">All visits</button><button class="${histMode === 'photo' ? 'on' : ''}" onclick="setHistMode('photo')">Photo proof</button></div>`;
    if (histMode === 'photo') { await baseHistory(); el.insertAdjacentHTML('afterbegin', seg); return; }
    el.innerHTML = seg + '<p class="muted">Loading…</p>';
    let d;
    try { d = await api('/customer/visits?from=' + hist.from + '&to=' + (hist.to > addDaysLocal(0) ? hist.to : addDaysLocal(30)) + (hist.site ? '&site=' + hist.site : '')); }
    catch (e) { el.innerHTML = seg + `<p class="empty">${esc(e.message)}</p>`; return; }
    const groups = ['completed', 'upcoming', 'missed', 'cancelled', 'awaiting', 'disputed', 'rescheduled'];
    const rows = vcat ? d.rows.filter(r => r.category === vcat) : d.rows;
    el.innerHTML = seg + `
      ${d.reliability != null ? `<div class="card"><b style="font-size:22px">${d.reliability}%</b> <span class="muted small">of visits due between ${dm(d.from)} and today were completed</span></div>` : ''}
      <div class="cc-sum">${groups.map(g => `<button class="${vcat === g ? 'on' : ''}" onclick="setVcat('${g}')"><b style="color:${COLOR[g]}">${d.summary[g] || 0}</b><span>${SHORT[g]}</span></button>`).join('')}
        <button class="${vcat === '' ? 'on' : ''}" onclick="setVcat('')"><b>${d.rows.length}</b><span>All</span></button></div>
      <div class="card">${rows.length ? rows.map(v => `<div class="cc-v"><span class="cc-dot" style="background:${COLOR[v.category]}"></span>
        <div class="t"><b>${nice(v.date)} · ${esc(v.label)}</b><small>${esc(v.detail)}${sites.length > 1 ? ' · ' + esc(v.branch || '') : ''}${v.driver ? ' · ' + esc(v.driver) : ''}</small></div>
        <div class="a">${v.category === 'completed' ? (v.stars ? `<span style="color:var(--amber);white-space:nowrap" title="Your rating">${'★'.repeat(v.stars)}<span style="opacity:.3">${'★'.repeat(5 - v.stars)}</span></span>` : (typeof openRateSheet === 'function' && v.date >= addDaysLocal(-30) ? `<button class="btn primary small" onclick="openRateSheet(${v.id}, '${dm(v.date)}')">Rate</button>` : '')) : ''}
          ${v.photo_url ? `<button class="btn ghost small" onclick="openDetail(${v.id})">Photo</button>` : ''}
          ${v.issue_id ? '<span class="pill gr-approved">Issue raised</span>' : v.category !== 'upcoming' ? `<button class="btn ghost small" onclick="openIssueSheet(${v.id}, '${dm(v.date)}', '${v.category === 'missed' ? 'missed_pickup' : ''}')">Report a problem</button>` : ''}</div></div>`).join('')
        : '<p class="muted">No visits in this group.</p>'}</div>
      <button class="btn ghost full" onclick="openDoc('/customer/history-v3/pdf?from=${hist.from}&to=${hist.to}&print=1')">Download PDF report</button>`;
  };
  const addDaysLocal = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  window.setHistMode = m => { histMode = m; loadHistory(); };
  window.setVcat = c => { vcat = c; loadHistory(); };

  // ══ ISSUES ══
  let issOpts = null, issCat = '', issPhoto = null;
  window.openIssueSheet = async function (pickupId = null, dateLabel = '', presetCat = '') {
    try { issOpts = issOpts || await api('/customer/issues/options'); } catch (e) { return toast(e.message, 'error'); }
    issCat = presetCat || ''; issPhoto = null;
    openSheet(`<div class="gr-sheet">
      <h3>Report an issue</h3>
      ${pickupId ? `<p class="small muted">About your visit on <b>${esc(dateLabel)}</b></p>` : ''}
      <h4>What is it about?</h4>
      <div class="cc-chips" id="iss-cats">${issOpts.categories.map(c => `<button class="cc-chip ${issCat === c.key ? 'on' : ''}" data-k="${c.key}" onclick="pickIssCat('${c.key}')">${esc(c.label)}</button>`).join('')}</div>
      <h4>What happened?</h4>
      <textarea id="iss-desc" rows="4" placeholder="A few words help us fix it faster"></textarea>
      <input type="file" id="iss-file" accept="image/*" capture="environment" hidden onchange="issPhotoPick(this)">
      <button class="btn ghost full" onclick="document.getElementById('iss-file').click()">Add a photo (optional)</button>
      <img id="iss-prev" class="gr-photo hidden" alt="">
      <p class="small muted">We reply within ${issOpts.response_h} hours. You will get a notification.</p>
      <button class="btn primary full" id="iss-send" onclick="sendIssue(${pickupId || 'null'})">Send</button>
      <button class="btn ghost full" onclick="closeSheet()">Cancel</button></div>`);
  };
  window.pickIssCat = k => { issCat = k; document.querySelectorAll('#iss-cats .cc-chip').forEach(b => b.classList.toggle('on', b.dataset.k === k)); };
  window.issPhotoPick = function (input) {
    const f = input.files && input.files[0]; if (!f) return;
    const img = new Image(), url = URL.createObjectURL(f);
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      issPhoto = c.toDataURL('image/jpeg', 0.8);
      const p = document.getElementById('iss-prev'); p.src = issPhoto; p.classList.remove('hidden');
    };
    img.src = url;
  };
  window.sendIssue = async function (pickupId) {
    if (!issCat) return toast('Choose what the issue is about', 'error');
    const btn = document.getElementById('iss-send'); btn.disabled = true;
    try {
      const out = await api('/customer/issues', { method: 'POST', body: { category: issCat, description: (document.getElementById('iss-desc') || {}).value || '', pickup_id: pickupId || undefined, image: issPhoto || undefined } });
      openSheet(`<div class="gr-sheet"><h3>Thank you, we are on it</h3><p class="muted">Issue #${out.id} is with our team. We reply within ${out.response_h} hours and you will get a notification.</p>
        <button class="btn primary full" onclick="openMyIssues()">See my issues</button><button class="btn ghost full" onclick="closeSheet()">Done</button></div>`);
      if (currentTab === 'home') loadHome(); else if (currentTab === 'history') loadHistory();
    } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
  };
  window.openMyIssues = async function () {
    openSheet('<p class="muted">Loading…</p>');
    let list;
    try { list = await api('/customer/issues'); } catch (e) { return openSheet(`<p class="empty">${esc(e.message)}</p>`); }
    openSheet(`<div class="gr-sheet"><h3>My issues</h3>
      ${list.length ? list.map(i => `<div class="line" onclick="openOneIssue(${i.id})" style="cursor:pointer"><span><b>${esc(i.category_label)}</b><small>#${i.id} · ${dm(i.created_at)}${sites.length > 1 ? ' · ' + esc(i.branch || '') : ''} · ${i.messages.length} message${i.messages.length === 1 ? '' : 's'}</small></span>
        <span class="r"><span class="pill ${ISS_PILL[i.status]}">${ISS[i.status]}</span></span></div>`).join('') : '<p class="muted">You have not reported any issues.</p>'}
      <button class="btn primary full" onclick="openIssueSheet()">Report a new issue</button><button class="btn ghost full" onclick="closeSheet()">Close</button></div>`);
  };
  window.openOneIssue = async function (id) {
    const list = await api('/customer/issues');
    const i = list.find(x => x.id === id); if (!i) return;
    openSheet(`<div class="gr-sheet"><h3>${esc(i.category_label)} <span class="pill ${ISS_PILL[i.status]}">${ISS[i.status]}</span></h3>
      ${i.photo_url ? `<img class="gr-photo" src="${esc(i.photo_url)}" alt="">` : ''}
      ${i.messages.map(m => `<div class="cc-msg ${m.author_role === 'customer' ? 'me' : 'them'}"><small>${m.author_role === 'customer' ? 'You' : 'GreenLoop team'} · ${dm(m.created_at)}</small>${esc(m.body)}</div>`).join('')}
      <textarea id="iss-reply" rows="2" placeholder="${i.status === 'resolved' ? 'Still a problem? Write here to reopen it' : 'Add a message'}"></textarea>
      <button class="btn primary full" onclick="replyIssue(${i.id})">Send</button>
      <button class="btn ghost full" onclick="openMyIssues()">Back</button></div>`);
  };
  window.replyIssue = async function (id) {
    const body = (document.getElementById('iss-reply') || {}).value || '';
    if (!body.trim()) return toast('Write a message', 'error');
    try { const r = await api(`/customer/issues/${id}/messages`, { method: 'POST', body: { body } }); toast(r.reopened ? 'Issue reopened' : 'Message sent', 'success'); openOneIssue(id); }
    catch (e) { toast(e.message, 'error'); }
  };

  // ══ TODAY: issue card ══
  const baseHome = loadHome;
  loadHome = async function () {
    await baseHome();
    const el = document.getElementById('v-home');
    if (!el || !el.querySelector('.hero-card') || el.querySelector('.cc-issue-card')) return;
    let open = 0;
    try { open = (await api('/customer/issues')).filter(i => i.status !== 'resolved').length; } catch { /* offline */ }
    if (el.querySelector('.cc-issue-card')) return;
    const card = `<div class="card gr-card cc-issue-card" onclick="${open ? 'openMyIssues()' : 'openIssueSheet()'}" role="button" tabindex="0">
      <div class="gr-ic" style="background:rgba(245,158,11,.18);color:var(--amber)"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
      <div class="gr-tx"><b>${open ? `${open} open issue${open === 1 ? '' : 's'}` : 'Report an issue'}</b><small>${open ? 'Tap to see replies from our team' : 'Missed pickup, mess left behind, a bin, a bill…'}</small></div></div>`;
    const kpis = el.querySelector('.kpi-row');
    if (kpis) kpis.insertAdjacentHTML('beforebegin', card); else el.insertAdjacentHTML('beforeend', card);
  };

  // ══ MORE: my issues ══
  const baseMore = loadMore;
  loadMore = async function () {
    await baseMore();
    const el = document.getElementById('v-more');
    if (!el || el.querySelector('.cc-more')) return;
    const first = el.querySelector('.card');
    if (first) first.insertAdjacentHTML('afterend', `<div class="card cc-more"><h3>Issues and feedback</h3><p class="muted small">Tell us about a missed pickup, mess, a damaged bin or a bill. We reply in the app.</p>
      <div class="two"><button class="btn primary" onclick="openIssueSheet()">Report an issue</button><button class="btn ghost" onclick="openMyIssues()">My issues</button></div></div>`);
  };

  // ══ VISIT DETAIL: report a problem ══
  const baseDetail = openDetail;
  openDetail = async function (id) {
    await baseDetail(id);
    const b = document.getElementById('sheet-body');
    if (b && !b.querySelector('.cc-rep')) b.insertAdjacentHTML('beforeend', `<button class="btn ghost full cc-rep" onclick="openIssueSheet(${id}, '')">Report a problem with this visit</button>`);
  };

  // ══ REWARDS: tiers, perks, streak, badges, impact, certificate ══
  const ICON = { first: '🌱', streak5: '🔥', streak10: '⚡', perfect: '⭐', champion: '🏆' };
  window.openRewards = async function () {
    openSheet('<p class="muted">Loading…</p>');
    let d;
    try { d = await api('/customer/rewards'); } catch (e) { return openSheet(`<p class="empty">${esc(e.message)}</p>`); }
    const t = d.tier, im = d.impact_year;
    openSheet(`<div class="gr-sheet">
      <h3>Green rewards</h3>
      <div class="cc-tier"><span class="small muted">Your tier</span><div class="n">${esc(t.name)}</div>
        <span class="small">${t.rated ? `${t.rate}% separation score over ${t.rated} rated pickups (90 days)` : 'Your driver rates how well waste is separated at each pickup'}</span>
        <ul>${t.perks.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
        ${t.next ? `<p class="small" style="margin:8px 0 0"><b>Next: ${esc(t.next.name)}</b>. You need ${esc(t.next.need)}. Unlocks: ${t.next.perks.map(esc).join(', ')}.</p>` : '<p class="small" style="margin:8px 0 0"><b>Top tier reached.</b> Thank you!</p>'}
      </div>
      <div class="gr-two">
        <div class="kpi"><b style="color:var(--green)">${d.balance}</b><span>Points to spend</span></div>
        <div class="kpi"><b>${d.streak.current}</b><span>Good pickups in a row (best ${d.streak.best})</span></div>
      </div>
      <h4>Badges</h4>
      <div class="cc-badges">${d.badges.map(b => `<div class="cc-badge ${b.earned ? 'on' : ''}" title="${esc(b.hint)}"><i>${b.earned ? ICON[b.key] || '✓' : ''}</i>${esc(b.name)}</div>`).join('')}</div>
      <h4>Your impact (last 12 months, estimate)</h4>
      <div class="cc-imp"><div class="kpi"><b>${im.diverted_kg.toLocaleString()}</b><span>kg kept out of landfill</span></div>
        <div class="kpi"><b>${im.co2_kg.toLocaleString()}</b><span>kg CO₂e avoided</span></div><div class="kpi"><b>${im.trees}</b><span>trees' yearly CO₂</span></div></div>
      <button class="btn primary full" onclick="openDoc('/customer/certificate')">Download this month's sustainability certificate</button>
      <p class="small muted" style="margin-top:6px">For your ESG / CSR reporting. ${esc(im.method)}</p>
      <h4>Spend your points</h4>
      ${d.catalog.map(c => `<div class="line"><span><b>${esc(c.name)}</b><small>${c.description ? esc(c.description) + ' · ' : ''}${c.points_cost} points</small></span>
        <span class="r"><button class="btn ${d.balance >= c.points_cost ? 'primary' : 'ghost'} small" ${d.balance >= c.points_cost ? '' : 'disabled'} onclick="redeemReward(${c.id}, '${esc(c.name).replace(/'/g, '&#39;')}', ${c.points_cost})">Redeem</button></span></div>`).join('')}
      ${d.redemptions.length ? `<h4>Your requests</h4>${d.redemptions.map(r => `<div class="line"><span><b>${esc(r.reward_name)}</b><small>${dmy(r.created_at)}</small></span>
        <span class="r"><span class="pill gr-${esc(r.status)}">${({ requested: 'Waiting', approved: 'Approved', applied: 'Done', rejected: 'Declined' })[r.status] || esc(r.status)}</span></span></div>`).join('')}` : ''}
      <h4>How to earn</h4>
      <p class="small muted">At every pickup the driver checks how well your waste is separated: <b>${d.points.good} points</b> for good, <b>${d.points.average}</b> for OK. Your tier follows your separation score, not how often we collect, so every site can reach Forest.</p>
      <h4>Zones this month</h4>
      ${d.leaderboard.zones.map(z => `<div class="line"><span><b>${z.rank}. ${esc(z.zone)}${z.mine ? ' (your zone)' : ''}</b><small>${z.sites} sites</small></span><span class="r">${z.avg_points} pts avg</span></div>`).join('')}
      <button class="btn ghost full" onclick="closeSheet()">Close</button></div>`);
  };

  // app.js may already have drawn the Today screen before this file loaded
  if (typeof token !== 'undefined' && token && typeof me !== 'undefined' && me && currentTab === 'home') loadHome();
})();
