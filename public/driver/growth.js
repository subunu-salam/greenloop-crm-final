// ─────────────────────────────────────────────────────────────
// GreenLoop Driver — Green Rewards add-on
// At the Report step the driver taps how well the waste was separated
// (Good / OK / Poor). It is sent right after "Finished"; the customer earns
// points for Good and OK. Optional: finishing without a rating still works.
// Wraps app.js functions (renderJobDetail, finishJob) without changing them.
// ─────────────────────────────────────────────────────────────
(function () {
  const SEG_TR = {
    en: { q: 'Waste separated?', good: 'Good', average: 'OK', poor: 'Poor' },
    hi: { q: 'कचरा अलग किया?', good: 'अच्छा', average: 'ठीक', poor: 'खराब' },
    ur: { q: 'کچرا الگ کیا؟', good: 'اچھا', average: 'ٹھیک', poor: 'خراب' },
    ar: { q: 'هل تم فرز النفايات؟', good: 'جيد', average: 'مقبول', poor: 'ضعيف' },
  };
  const st = k => ((SEG_TR[typeof LANG !== 'undefined' ? LANG : 'en'] || SEG_TR.en)[k]) || SEG_TR.en[k];
  const ICON = {
    good: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
    average: '<circle cx="12" cy="12" r="10"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
    poor: '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  };
  const COLOR = { good: '#22c55e', average: '#f59e0b', poor: '#f43f5e' };
  const ic = n => `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`;

  const css = document.createElement('style');
  css.textContent = `
    .seg-box { border-radius: 20px; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: var(--card); border: 1px solid var(--line); }
    .seg-q { font-weight: 800; font-size: 15px; display: flex; align-items: center; gap: 8px; }
    .seg-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .seg-btn { min-height: 86px; border-radius: 16px; border: 2px solid var(--line); background: rgba(0,0,0,.2); color: var(--dark);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 15px; font-weight: 800; cursor: pointer; }
    .seg-btn:active { transform: scale(.97); }
    .seg-btn.on { color: #fff; }`;
  document.head.appendChild(css);

  const ratings = {};                   // pickupId → 'good' | 'average' | 'poor'
  window.pickSeg = (r) => { if (!currentJob) return; ratings[currentJob.id] = ratings[currentJob.id] === r ? undefined : r; renderJobDetail(); };

  function segHtml(id) {
    const cur = ratings[id];
    return `<div class="seg-box" id="seg-box"><div class="seg-q">${st('q')}</div><div class="seg-row">
      ${['good', 'average', 'poor'].map(r => `<button class="seg-btn ${cur === r ? 'on' : ''}" style="${cur === r ? `background:${COLOR[r]};border-color:${COLOR[r]}` : `color:${COLOR[r]}`}"
        onclick="pickSeg('${r}')" aria-pressed="${cur === r}">${ic(r)}<span>${st(r)}</span></button>`).join('')}</div></div>`;
  }

  // Show the rating on the Report step, just above the Finished button.
  const baseRender = renderJobDetail;
  renderJobDetail = function (forceStep) {
    baseRender(forceStep);
    const j = currentJob;
    if (!j) return;
    const step = forceStep !== undefined ? forceStep : jobSteps(j);
    if (step !== 2 || j.category === 'pest') return;
    const A = document.getElementById('job-actions');
    const fin = A && A.querySelector('.giant.green');
    if (fin) fin.insertAdjacentHTML('beforebegin', segHtml(j.id));
  };

  // Send the rating once the pickup is finished (queued on this phone if offline).
  const QKEY = 'gl_seg_queue';
  const getQ = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
  const setQ = q => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* storage full */ } };
  async function sendSeg(item) {
    const res = await fetch(`${API}/pickups/${item.id}/segregation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ rating: item.rating }),
    });
    if (res.status === 409) {                      // pickup still waiting in the offline queue → try later
      const d = await res.json().catch(() => ({}));
      if (/finished/.test(d.error || '')) throw new Error('not yet');
    }
    if (res.status >= 500 || res.status === 429) throw new Error('retry');
    return res.json().catch(() => ({}));
  }
  async function flushSeg() {
    const q = getQ(); if (!q.length || !token) return;
    const left = [];
    for (const item of q) { try { await sendSeg(item); } catch { left.push(item); } }
    setQ(left);
  }
  const baseFinish = finishJob;
  finishJob = async function () {
    const j = currentJob;
    const rating = j && ratings[j.id];
    await baseFinish();
    if (!j || !rating || j.status !== 'collected') return;
    delete ratings[j.id];
    try {
      if (j.pending_sync || getQueue().some(x => x.pickupId === j.id)) throw new Error('finish still queued');
      const r = await sendSeg({ id: j.id, rating });
      if (r && r.points > 0 && typeof pushNotif === 'function') pushNotif('ok', 'Green points', `${j.name}: +${r.points}`, true);
    } catch { setQ([...getQ(), { id: j.id, rating }]); }
  };

  setInterval(flushSeg, 60_000);
  window.addEventListener('online', () => setTimeout(flushSeg, 5000));
})();
