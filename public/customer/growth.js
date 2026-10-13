// ─────────────────────────────────────────────────────────────
// GreenLoop Customer — growth add-ons on the Today screen
//   Green Rewards   points balance, how to earn, redeem, zone leaderboard
//   Waste scanner   photo (or pick types) → waste type, tips, estimate → quote request
// Data: server/growth.js. Uses app.js helpers: api, esc, AED, dmy, dmyTime,
// toast, openSheet, closeSheet, token, API. Wraps loadHome without changing it.
// ─────────────────────────────────────────────────────────────
(function () {
  const css = document.createElement('style');
  css.textContent = `
    .gr-card{display:flex;align-items:center;gap:14px;cursor:pointer}
    .gr-card .gr-ic{width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .gr-card .gr-tx{flex:1;min-width:0}.gr-card .gr-tx b{display:block;font-size:16px}.gr-card .gr-tx small{color:var(--muted)}
    .gr-pts{font-size:26px;font-weight:800;color:var(--green)}
    .gr-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
    .gr-chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
    .gr-chip{border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:20px;padding:8px 12px;font:inherit;font-size:13px;font-weight:700}
    .gr-chip.on{background:rgba(45,212,191,.22);border-color:var(--teal);color:#fff}
    .gr-bar{height:6px;border-radius:4px;background:var(--card2);margin-top:4px}.gr-bar i{display:block;height:100%;border-radius:4px;background:var(--teal)}
    .gr-warn{background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);color:#fde68a;border-radius:12px;padding:10px 12px;font-size:13px;margin:10px 0}
    .gr-photo{width:100%;max-height:220px;object-fit:cover;border-radius:14px;margin:6px 0 10px}
    .gr-sheet h3{margin:4px 0 6px}.gr-sheet h4{margin:16px 0 6px;font-size:14px}
    .gr-sheet ul{margin:6px 0 0;padding-left:18px}.gr-sheet li{margin:4px 0}
    .gr-sheet textarea{width:100%}
    .pill.gr-requested{background:rgba(245,158,11,.18);color:#fde68a}.pill.gr-approved,.pill.gr-applied{background:rgba(34,197,94,.18);color:#86efac}.pill.gr-rejected{background:rgba(244,63,94,.18);color:#fecdd3}`;
  document.head.appendChild(css);

  const SV = {
    gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
  };
  const sv = (n, s = 24) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SV[n]}</svg>`;

  // ── Today screen: two cards above the monthly numbers ──
  const baseHome = loadHome;
  loadHome = async function () {
    await baseHome();
    const el = document.getElementById('v-home');
    if (!el || !el.querySelector('.hero-card')) return;
    let rw = null;
    try { rw = await api('/customer/rewards'); } catch { rw = null; }
    const cards = `
      <div class="card gr-card" onclick="openRewards()" role="button" tabindex="0">
        <div class="gr-ic" style="background:rgba(34,197,94,.18);color:var(--green)">${sv('gift')}</div>
        <div class="gr-tx"><b>Green rewards</b><small>${rw ? (rw.leaderboard.my_rank ? `Rank ${rw.leaderboard.my_rank} of ${rw.leaderboard.of} this month · ` : '') + 'Earn points for well-separated waste' : 'Earn points for well-separated waste'}</small></div>
        <div class="gr-pts">${rw ? rw.balance : '–'}</div>
      </div>
      <div class="card gr-card" onclick="openScanner()" role="button" tabindex="0">
        <div class="gr-ic" style="background:rgba(45,212,191,.18);color:var(--teal)">${sv('scan')}</div>
        <div class="gr-tx"><b>Scan your waste</b><small>Take a photo to see the waste type, tips and a price estimate</small></div>
      </div>`;
    const kpis = el.querySelector('.kpi-row');
    if (el.querySelector('.gr-card')) return;      // two loads raced: cards are already there
    if (kpis) kpis.insertAdjacentHTML('beforebegin', cards); else el.insertAdjacentHTML('beforeend', cards);
  };
  // app.js shows the Today screen before this file loads: draw it again with the cards
  if (typeof token !== 'undefined' && token && typeof me !== 'undefined' && me && currentTab === 'home') loadHome();

  // ══ GREEN REWARDS ══
  window.openRewards = async function () {
    openSheet('<p class="muted">Loading…</p>');
    let d;
    try { d = await api('/customer/rewards'); } catch (e) { return openSheet(`<p class="empty">${esc(e.message)}</p>`); }
    const lb = d.leaderboard;
    const next = d.catalog.find(c => c.points_cost > d.balance);
    openSheet(`<div class="gr-sheet">
      <h3>Green rewards</h3>
      <div class="gr-two">
        <div class="kpi"><b style="color:var(--green)">${d.balance}</b><span>Points to spend</span></div>
        <div class="kpi"><b>${lb.my_rank ? '#' + lb.my_rank : '–'}</b><span>Your rank of ${lb.of} sites</span></div>
      </div>
      ${next ? `<p class="small muted">${next.points_cost - d.balance} more points for <b>${esc(next.name)}</b></p>
        <div class="gr-bar"><i style="width:${Math.min(100, Math.round(100 * d.balance / next.points_cost))}%"></i></div>` : ''}
      <h4>How to earn</h4>
      <p class="small muted">At every pickup the driver checks how well your waste is separated: <b>${d.points.good} points</b> for good, <b>${d.points.average} points</b> for OK.${d.monthly_cap ? ` Up to ${d.monthly_cap} points a month (${d.earned_this_month} earned so far).` : ''}</p>
      <h4>Rewards</h4>
      ${d.catalog.map(c => `<div class="line"><span><b>${esc(c.name)}</b><small>${c.points_cost} points</small></span>
        <span class="r"><button class="btn ${d.balance >= c.points_cost ? 'primary' : 'ghost'} small" ${d.balance >= c.points_cost ? '' : 'disabled'} onclick="redeemReward(${c.id}, '${esc(c.name).replace(/'/g, '&#39;')}', ${c.points_cost})">Redeem</button></span></div>`).join('')}
      ${d.redemptions.length ? `<h4>Your requests</h4>${d.redemptions.map(r => `<div class="line"><span><b>${esc(r.reward_name)}</b><small>${dmy(r.created_at)}</small></span>
        <span class="r"><span class="pill ${esc(r.status)}">${({ requested: 'Waiting', approved: 'Approved', applied: 'On your invoice', rejected: 'Declined' })[r.status] || esc(r.status)}</span></span></div>`).join('')}` : ''}
      <h4>Zones this month</h4>
      ${lb.zones.map(z => `<div class="line"><span><b>${z.rank}. ${esc(z.zone)}${z.mine ? ' (your zone)' : ''}</b><small>${z.sites} sites</small></span><span class="r">${z.avg_points} pts avg</span></div>`).join('')}
      ${d.history.length ? `<h4>Points history</h4>${d.history.map(h => `<div class="line"><span>${esc(h.reason || h.kind)}<small>${dmy(h.created_at)}</small></span>
        <span class="r" style="color:${h.points >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:800">${h.points > 0 ? '+' : ''}${h.points}</span></div>`).join('')}` : ''}
      <button class="btn ghost full" onclick="closeSheet()">Close</button></div>`);
  };
  window.redeemReward = async function (id, name, cost) {
    if (!confirm(`Use ${cost} points for "${name}"?`)) return;
    try { await api('/customer/rewards/redeem', { method: 'POST', body: { reward_id: id } }); toast('Request sent. We will confirm it shortly.', 'success'); openRewards(); if (currentTab === 'home') loadHome(); }
    catch (e) { toast(e.message, 'error'); }
  };

  // ══ WASTE SCANNER ══
  let scanOpts = null, picked = new Set(), pickedVol = 'medium';
  window.openScanner = async function () {
    openSheet('<p class="muted">Loading…</p>');
    try { scanOpts = await api('/customer/scan/options'); } catch (e) { return openSheet(`<p class="empty">${esc(e.message)}</p>`); }
    picked = new Set(); pickedVol = 'medium';
    renderScanStart();
  };
  function manualHtml(open) {
    return `<div id="gr-manual" class="${open ? '' : 'hidden'}">
      <h4>What kind of waste?</h4>
      <div class="gr-chips">${scanOpts.categories.map(c => `<button class="gr-chip ${picked.has(c.category) ? 'on' : ''}" onclick="togglePick('${c.category}', this)">${esc(c.label)}</button>`).join('')}</div>
      <h4>How much?</h4>
      <div class="gr-chips">${[['small', 'One or two bags'], ['medium', 'One large bin'], ['large', 'Several bins or a pile']].map(([v, l]) => `<button class="gr-chip ${pickedVol === v ? 'on' : ''}" data-vol="${v}" onclick="pickVol('${v}')">${l}</button>`).join('')}</div>
      <button class="btn primary full" onclick="scanManual()">See estimate</button></div>`;
  }
  function renderScanStart(msg) {
    openSheet(`<div class="gr-sheet">
      <h3>Scan your waste</h3>
      <p class="small muted">We tell you what type of waste it is, how to separate it, and which service fits with a price estimate.</p>
      ${msg ? `<div class="gr-warn">${esc(msg)}</div>` : ''}
      ${scanOpts.ai ? `<input type="file" id="gr-file" accept="image/*" capture="environment" hidden onchange="scanPhoto(this)">
        <button class="btn primary full" onclick="document.getElementById('gr-file').click()">${sv('scan', 18)} Take a photo</button>
        <button class="btn ghost full" onclick="document.getElementById('gr-manual').classList.toggle('hidden')">Or choose the waste types</button>` : ''}
      ${manualHtml(!scanOpts.ai)}
      <button class="btn ghost full" onclick="closeSheet()">Close</button></div>`);
  }
  window.togglePick = function (cat, btn) { picked.has(cat) ? picked.delete(cat) : picked.add(cat); btn.classList.toggle('on'); };
  window.pickVol = function (v) { pickedVol = v; document.querySelectorAll('#gr-manual [data-vol]').forEach(b => b.classList.toggle('on', b.dataset.vol === v)); };
  window.scanManual = async function () {
    if (!picked.size) return toast('Choose at least one waste type', 'error');
    try { showResult(await api('/customer/scan', { method: 'POST', body: { categories: [...picked], volume: pickedVol } })); }
    catch (e) { toast(e.message, 'error'); }
  };

  // shrink the photo on the phone before sending (max 1280 px, JPEG)
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open this photo')); };
      img.src = url;
    });
  }
  window.scanPhoto = async function (input) {
    const f = input.files && input.files[0]; if (!f) return;
    let data;
    try { data = await shrink(f); } catch (e) { return toast(e.message, 'error'); }
    openSheet(`<div class="gr-sheet"><h3>Scanning…</h3><img class="gr-photo" src="${data}" alt=""><p class="muted">Looking at your photo. This takes a few seconds.</p></div>`);
    try {
      const res = await fetch(API + '/customer/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ image: data }) });
      const out = await res.json().catch(() => ({}));
      if (res.status === 401) return logout();
      if (!res.ok) { if (out.code === 'AI_OFF') scanOpts.ai = false; return renderScanStart(out.error || 'The scan did not work. Choose the waste types instead.'); }
      showResult(out, data);
    } catch { renderScanStart('No connection. Check your internet and try again.'); }
  };

  function showResult(r, photo) {
    openSheet(`<div class="gr-sheet">
      <h3>Your waste</h3>
      ${photo ? `<img class="gr-photo" src="${photo}" alt="">` : ''}
      ${r.summary ? `<p class="muted small">${esc(r.summary)}</p>` : ''}
      ${r.categories.map(c => `<div class="line"><span><b>${esc(c.label)}</b></span><span class="r">${c.share_pct != null ? c.share_pct + '%' : ''}</span></div>`).join('')}
      ${r.hazardous ? '<div class="gr-warn">This needs special handling. Keep it apart from your other waste until we collect it.</div>' : ''}
      <h4>How to separate it</h4>
      <ul class="small">${r.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <h4>Suggested service</h4>
      <div class="line"><span><b>${esc(r.service_name)}</b><small>Estimate per visit, before VAT. We confirm the final price in your quotation.</small></span>
        <span class="r"><b>${r.est_price != null ? AED(r.est_price) : '—'}</b></span></div>
      <h4>Anything we should know? (optional)</h4>
      <textarea id="gr-note" rows="2" placeholder="e.g. Twice a week, rear entrance"></textarea>
      <button class="btn primary full" onclick="requestScanQuote(${r.id})">Request a quotation</button>
      <button class="btn ghost full" onclick="openScanner()">Scan again</button></div>`);
  }
  window.requestScanQuote = async function (id) {
    try {
      const out = await api(`/customer/scans/${id}/request-quote`, { method: 'POST', body: { note: (document.getElementById('gr-note') || {}).value || '' } });
      openSheet(`<div class="gr-sheet"><h3>Request sent</h3><p class="muted">${out.already ? 'We already have this request.' : 'Our team will send you a quotation, usually within one working day. You will see it on your Today screen.'}</p>
        <button class="btn primary full" onclick="closeSheet()">Done</button></div>`);
    } catch (e) { toast(e.message, 'error'); }
  };
})();
