// ─────────────────────────────────────────────────────────────
// GreenLoop Customer — engagement (v3.8, add-on)
//   Rate your visit     5 stars + comment after each completed pickup
//   Busy periods        "Expecting more waste?" → extra visits, price shown first
//   Weekly email        switch the Sunday summary on or off (More tab)
// Data: server/engage.js. Wraps app.js / growth.js / care.js screens.
// ─────────────────────────────────────────────────────────────
(function () {
  const css = document.createElement('style');
  css.textContent = `
    .en-rate{border-color:rgba(245,158,11,.45)}
    .en-stars{display:flex;gap:6px;justify-content:center;margin:10px 0 4px}
    .en-stars button{background:none;border:0;font-size:34px;line-height:1;color:var(--line);padding:2px;cursor:pointer}
    .en-stars button.on{color:#fbbf24}
    .en-row{display:flex;gap:10px}.en-row>div{flex:1}
    .en-dates{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
    .en-dates span{background:rgba(45,212,191,.16);border:1px solid var(--line);border-radius:10px;padding:5px 9px;font-size:12.5px;font-weight:700}
    .en-switch{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .en-switch input{width:auto;transform:scale(1.4)}`;
  document.head.appendChild(css);
  const dm = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const WORDS = ['', 'Very poor', 'Poor', 'OK', 'Good', 'Excellent'];

  // ══ RATE A VISIT ══
  let rateStars = 0;
  window.openRateSheet = function (id, dateLabel, preset = 0) {
    rateStars = preset;
    openSheet(`<div class="gr-sheet">
      <h3>How was your pickup${dateLabel ? ' on ' + esc(dateLabel) : ''}?</h3>
      <div class="en-stars" id="en-stars">${[1, 2, 3, 4, 5].map(n => `<button aria-label="${n} star${n > 1 ? 's' : ''}" onclick="setRateStars(${n})">★</button>`).join('')}</div>
      <p class="small muted" id="en-word" style="text-align:center;margin:0 0 10px">Tap a star</p>
      <textarea id="en-comment" rows="3" placeholder="Anything to add? (optional)"></textarea>
      <button class="btn primary full" onclick="sendRating(${id})">Send</button>
      <button class="btn ghost full" onclick="closeSheet()">Not now</button></div>`);
    if (preset) setRateStars(preset);
  };
  window.setRateStars = function (n) {
    rateStars = n;
    document.querySelectorAll('#en-stars button').forEach((b, i) => b.classList.toggle('on', i < n));
    const w = document.getElementById('en-word');
    if (w) w.textContent = WORDS[n] + (n <= 2 ? ' — sorry about that. Tell us what went wrong and we will call you.' : '');
  };
  window.sendRating = async function (id) {
    if (!rateStars) return toast('Tap a star first', 'error');
    try {
      const r = await api(`/customer/visits/${id}/rate`, { method: 'POST', body: { stars: rateStars, comment: (document.getElementById('en-comment') || {}).value || '' } });
      openSheet(`<div class="gr-sheet"><h3>Thank you!</h3><p class="muted">${r.low ? 'We are sorry the visit was not up to standard. Our team has been told and will contact you.' : 'Your feedback helps our crews do a better job.'}</p>
        ${r.low ? '<button class="btn ghost full" onclick="openIssueSheet()">Report the problem in detail</button>' : ''}<button class="btn primary full" onclick="closeSheet()">Done</button></div>`);
      if (currentTab === 'home') loadHome(); else if (currentTab === 'history') loadHistory();
    } catch (e) { toast(e.message, 'error'); }
  };

  // ══ BUSY PERIODS ══
  let evOpts = null, evKind = '', evLevel = 'more';
  const clampDate = d => (d && evOpts && d < evOpts.min_date ? evOpts.min_date : d);
  window.openBusySheet = async function () {
    openSheet('<p class="muted">Loading…</p>');
    let mine = [];
    try { [evOpts, mine] = await Promise.all([api('/customer/events/options'), api('/customer/events')]); } catch (e) { return openSheet(`<p class="empty">${esc(e.message)}</p>`); }
    evKind = ''; evLevel = 'more';
    openSheet(`<div class="gr-sheet">
      <h3>Expecting more waste?</h3>
      <p class="small muted">Tell us about Ramadan, Eid, a sale or a stock clearance and we add extra pickups for those dates. You see the dates and the price before you confirm.</p>
      ${mine.length ? `<h4>Already planned</h4>${mine.map(e => `<div class="line"><span><b>${esc(e.label)}</b><small>${dm(e.start_date)} to ${dm(e.end_date)} · ${e.visits.length} extra pickup${e.visits.length === 1 ? '' : 's'}</small></span>
        <span class="r"><button class="btn ghost small" onclick="cancelBusyMine(${e.id})">Cancel</button></span></div>`).join('')}` : ''}
      <h4>What is happening?</h4>
      <div class="cc-chips" id="ev-kinds">${evOpts.kinds.map(k => `<button class="cc-chip" data-k="${k.key}" onclick="pickEvKind('${k.key}')">${esc(k.label)}</button>`).join('')}</div>
      <div id="ev-label-wrap" class="hidden"><label>Name it (optional)</label><input id="ev-label" placeholder="e.g. Weekend mega sale"></div>
      <div class="en-row"><div><label>From</label><input id="ev-s" type="date" min="${evOpts.min_date}"></div><div><label>To</label><input id="ev-e" type="date" min="${evOpts.min_date}"></div></div>
      <p class="small muted" id="ev-sug" style="margin:4px 0 0"></p>
      <h4>How much more waste?</h4>
      <div class="cc-chips" id="ev-levels">${evOpts.levels.map(l => `<button class="cc-chip ${l.key === evLevel ? 'on' : ''}" data-k="${l.key}" onclick="pickEvLevel('${l.key}')">${esc(l.label)} (+${l.per_week}/week)</button>`).join('')}</div>
      <div id="ev-prev"></div>
      <button class="btn primary full" id="ev-go" onclick="previewBusy()">See extra pickups and price</button>
      <button class="btn ghost full" onclick="closeSheet()">Close</button></div>`);
  };
  window.pickEvKind = function (k) {
    evKind = k;
    document.querySelectorAll('#ev-kinds .cc-chip').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    document.getElementById('ev-label-wrap').classList.toggle('hidden', !['sale', 'stocktake', 'other'].includes(k));
    const s = evOpts.suggested[k];
    if (s) { document.getElementById('ev-s').value = clampDate(s[0]); document.getElementById('ev-e').value = clampDate(s[1]); }
    document.getElementById('ev-sug').textContent = s ? `Expected dates filled in: ${dm(s[0])} to ${dm(s[1])} (approximate, change if needed).` : '';
    document.getElementById('ev-prev').innerHTML = '';
  };
  window.pickEvLevel = function (k) { evLevel = k; document.querySelectorAll('#ev-levels .cc-chip').forEach(b => b.classList.toggle('on', b.dataset.k === k)); document.getElementById('ev-prev').innerHTML = ''; };
  const evBody = () => ({ kind: evKind, level: evLevel, label: (document.getElementById('ev-label') || {}).value || '', start_date: document.getElementById('ev-s').value, end_date: document.getElementById('ev-e').value });
  window.previewBusy = async function () {
    if (!evKind) return toast('Choose what is happening', 'error');
    try {
      const p = await api('/customer/events/preview', { method: 'POST', body: evBody() });
      document.getElementById('ev-prev').innerHTML = `<div class="card" style="margin:10px 0"><b>${p.dates.length} extra pickup${p.dates.length === 1 ? '' : 's'}</b>
        <div class="en-dates">${p.dates.map(d => `<span>${nice(d)}</span>`).join('')}</div>
        <p class="small muted" style="margin:0">Estimated ${AED(p.est_total)} + VAT (${AED(p.price_per_visit)} per pickup), added to your next invoice only for pickups we complete.</p></div>`;
      const go = document.getElementById('ev-go'); go.textContent = 'Confirm extra pickups'; go.onclick = confirmBusy;
    } catch (e) { toast(e.message, 'error'); }
  };
  async function confirmBusy() {
    try {
      const r = await api('/customer/events', { method: 'POST', body: evBody() });
      openSheet(`<div class="gr-sheet"><h3>Extra pickups booked</h3><p class="muted">${esc(r.label)}: ${r.created} extra pickup${r.created === 1 ? '' : 's'} from ${dm(r.start_date)} to ${dm(r.end_date)}. You can see them on your Today screen and cancel any time before they happen.</p>
        <button class="btn primary full" onclick="closeSheet()">Done</button></div>`);
      if (currentTab === 'home') loadHome();
    } catch (e) { toast(e.message, 'error'); }
  }
  window.cancelBusyMine = async function (id) {
    if (!confirm('Cancel the extra pickups that have not happened yet?')) return;
    try { const r = await api('/customer/events/' + id, { method: 'DELETE' }); toast(`${r.removed} extra pickup${r.removed === 1 ? '' : 's'} cancelled`, 'success'); openBusySheet(); if (currentTab === 'home') loadHome(); }
    catch (e) { toast(e.message, 'error'); }
  };

  // ══ TODAY: rating prompt + busy period card ══
  const baseHome = loadHome;
  loadHome = async function () {
    await baseHome();
    const el = document.getElementById('v-home');
    if (!el || !el.querySelector('.hero-card') || el.querySelector('.en-card')) return;
    let pend = null, events = [];
    try { [pend, events] = await Promise.all([api('/customer/ratings/pending'), api('/customer/events')]); } catch { /* offline */ }
    if (el.querySelector('.en-card')) return;
    const v = pend && pend.visit;
    if (v) {
      const label = nice(v.scheduled_date);
      el.querySelector('.hero-card').insertAdjacentHTML('beforebegin', `<div class="card en-rate en-card"><b>How was your pickup on ${esc(label)}?</b>
        <p class="small muted" style="margin:2px 0 0">${v.driver ? esc(v.driver) + ' · ' : ''}${esc(v.branch || '')}</p>
        <div class="en-stars">${[1, 2, 3, 4, 5].map(n => `<button aria-label="${n} stars" onclick="openRateSheet(${v.id}, '${esc(label)}', ${n})">★</button>`).join('')}</div></div>`);
    }
    const ev = events[0];
    const card = `<div class="card gr-card en-card" onclick="openBusySheet()" role="button" tabindex="0">
      <div class="gr-ic" style="background:rgba(125,211,252,.18);color:var(--blue)"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M12 14v4M10 16h4"/></svg></div>
      <div class="gr-tx"><b>${ev ? esc(ev.label) + ': extra pickups planned' : 'Expecting more waste?'}</b><small>${ev ? `${dm(ev.start_date)} to ${dm(ev.end_date)} · ${ev.visits.length} extra pickup${ev.visits.length === 1 ? '' : 's'}` : 'Ramadan, Eid, a sale… we add extra pickups for those dates'}</small></div></div>`;
    const kpis = el.querySelector('.kpi-row');
    if (kpis) kpis.insertAdjacentHTML('beforebegin', card); else el.insertAdjacentHTML('beforeend', card);
  };

  // ══ MORE: weekly email switch ══
  const baseMore = loadMore;
  loadMore = async function () {
    await baseMore();
    const el = document.getElementById('v-more');
    if (!el || el.querySelector('.en-mail')) return;
    let w = null;
    try { w = await api('/customer/weekly-email'); } catch { return; }
    if (el.querySelector('.en-mail')) return;
    const html = `<div class="card en-mail"><div class="en-switch"><div><h3 style="margin:0 0 4px">Weekly summary email</h3>
      <p class="small muted" style="margin:0">${w.email ? `Every Sunday to <b>${esc(w.email)}</b>: pickups done, anything missed, open issues and your next pickup.` : 'Ask us to add an email address to your account to get a short summary every Sunday.'}</p></div>
      <input type="checkbox" ${w.enabled && w.email ? 'checked' : ''} ${w.email ? '' : 'disabled'} onchange="setWeeklyEmail(this.checked)" aria-label="Weekly summary email"></div>
      <button class="btn ghost full" onclick="openBusySheet()">Expecting more waste? Plan extra pickups</button></div>`;
    const anchor = el.querySelector('.cc-more') || el.querySelector('.card');
    if (anchor) anchor.insertAdjacentHTML('afterend', html); else el.insertAdjacentHTML('afterbegin', html);
  };
  window.setWeeklyEmail = async function (on) {
    try { await api('/customer/weekly-email', { method: 'PUT', body: { enabled: on } }); toast(on ? 'Weekly email switched on' : 'Weekly email switched off', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  };

  // ══ VISIT DETAIL: rate from the visit sheet too ══
  const baseDetail = openDetail;
  openDetail = async function (id) {
    await baseDetail(id);
    const b = document.getElementById('sheet-body');
    if (!b || b.querySelector('.en-rate-btn')) return;
    try {
      const list = await api('/customer/ratings');
      const mine = list.find(x => x.pickup_id === id);
      const pill = b.querySelector('h3 .pill');
      if (mine) b.insertAdjacentHTML('beforeend', `<p class="en-rate-btn" style="text-align:center;color:#fbbf24;font-size:22px;margin:10px 0 0">${'★'.repeat(mine.stars)}<span style="opacity:.3">${'★'.repeat(5 - mine.stars)}</span></p>`);
      else if (pill && /collected/.test(pill.className)) b.insertAdjacentHTML('beforeend', `<button class="btn primary full en-rate-btn" onclick="openRateSheet(${id}, '')">Rate this visit</button>`);
    } catch { /* offline */ }
  };

  if (typeof token !== 'undefined' && token && typeof me !== 'undefined' && me && currentTab === 'home') loadHome();
})();
