/* GreenLoop FX — visual-only enhancements shared by CRM, driver and customer.
   Animated KPI counters, chart draw-in + gradients, staggered card transitions,
   button ripples and a cursor spotlight. Does not touch app logic or data. */
(function () {
  'use strict';
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CARDS = '.card,.kpi,.lane,.opt-card,.lead-card,.alert-item,.hero360,.feed-item,' +
    '.sumcard,.job-card,.hist-item,.stat,.inforow,.acct-hero,.checklist,.reason,' +
    '.hero-card,.visit,.plan,.inv,.quote,.alert,.g-item,.notif,.row-btn';
  const COUNTERS = '.kpi .num,.kpi b,.stat .n,.sumcount,.giant,.qtot b,[data-count]';
  const RIPPLE = '.btn,.wide-btn,.qbtn,.tab,.pad button,.row-btn,.ptab,.seg button,.site-btn,.chip';
  const SPOT = '.card,.kpi,.opt-card,.job-card,.stat,.hero-card,.visit,.plan,.inv,.quote,.sumcard';

  /* ---------- Chart.js: draw-in animation, gradient bars, glass tooltips ---------- */
  function setupCharts() {
    const C = window.Chart; if (!C || C.__fx) return; C.__fx = true;
    if (reduce) C.defaults.animation = false;
    else Object.assign(C.defaults.animation, {
      duration: 1100, easing: 'easeOutQuart',
      delay: (ctx) => (ctx.type === 'data' && ctx.mode === 'default') ? ctx.dataIndex * 55 + ctx.datasetIndex * 110 : 0,
    });
    const tt = C.defaults.plugins.tooltip;
    Object.assign(tt, { backgroundColor: 'rgba(12,26,40,.94)', borderColor: 'rgba(46,230,166,.45)', borderWidth: 1,
      padding: 10, cornerRadius: 10, titleFont: { weight: '700' }, boxPadding: 4, usePointStyle: true });
    C.defaults.elements.arc.hoverOffset = 10;
    C.defaults.elements.line.tension = .38;
    C.defaults.elements.point.hoverRadius = 6;

    const alpha = (col, a) => {
      if (typeof col !== 'string') return col;
      if (col.startsWith('#')) {
        let h = col.slice(1); if (h.length === 3) h = h.split('').map(x => x + x).join('');
        const n = parseInt(h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
      }
      return col;
    };
    C.register({
      id: 'fxGradients',
      beforeUpdate(chart) {
        chart.data.datasets.forEach((ds) => {
          const type = ds.type || chart.config.type;
          if (ds.__fx || typeof ds.backgroundColor !== 'string' || !ds.backgroundColor.startsWith('#')) return;
          const base = ds.backgroundColor; ds.__fx = true;
          const horizontal = chart.options.indexAxis === 'y';
          if (type === 'bar') {
            ds.backgroundColor = (c) => {
              const a = c.chart.chartArea; if (!a) return base;
              const g = horizontal ? c.chart.ctx.createLinearGradient(a.left, 0, a.right, 0)
                                   : c.chart.ctx.createLinearGradient(0, a.bottom, 0, a.top);
              g.addColorStop(0, alpha(base, .55)); g.addColorStop(1, base); return g;
            };
            ds.hoverBackgroundColor = ds.hoverBackgroundColor || base;
            if (ds.borderRadius == null || ds.borderRadius < 6) ds.borderRadius = 6;
          } else if (type === 'line') {
            ds.borderColor = ds.borderColor || base;
            ds.backgroundColor = (c) => {
              const a = c.chart.chartArea; if (!a) return alpha(base, .2);
              const g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
              g.addColorStop(0, alpha(base, .35)); g.addColorStop(1, alpha(base, 0)); return g;
            };
            if (ds.fill == null) ds.fill = true;
          }
        });
      },
    });
  }
  setupCharts();
  document.addEventListener('DOMContentLoaded', setupCharts);

  if (reduce) return;

  /* ---------- animated counters ---------- */
  const NUM = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s;
  function countUp(el) {
    if (el.__fxCounted || el.children.length > 1) return;
    const txt = el.textContent.trim();
    if (!txt || /\d[:\-]\d/.test(txt)) return;        // skip times and dates
    const m = txt.match(NUM); if (!m) return;
    const end = parseFloat(m[2].replace(/,/g, '')); if (!isFinite(end) || end === 0) return;
    el.__fxCounted = true;
    const dec = (m[2].split('.')[1] || '').length, commas = m[2].includes(',');
    const fmt = (v) => { const s = v.toFixed(dec); return commas ? Number(s).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : s; };
    const node = [...el.childNodes].find(n => n.nodeType === 3 && /\d/.test(n.nodeValue));
    if (!node) return;
    const orig = node.nodeValue, dur = 900 + Math.min(600, end * 4), t0 = performance.now();
    const step = (t) => {
      if (!node.isConnected) return;
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      node.nodeValue = p < 1 ? orig.replace(m[2], fmt(end * e)) : orig;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- staggered entrance for freshly rendered content ---------- */
  // Only animate renders the user caused (click / key / navigation) or the first load —
  // background refreshes (live updates, 30 s timers) stay still so nothing flickers.
  let lastAct = performance.now();
  const mark = () => { lastAct = performance.now(); };
  ['pointerdown', 'keydown', 'hashchange', 'popstate', 'submit'].forEach(ev => addEventListener(ev, mark, true));
  const userCaused = () => performance.now() - lastAct < 2600;

  function animate(root) {
    if (!(root instanceof Element)) return;
    if (root.closest('#s-cam,.cam,canvas,.toasts,#toasts')) return;
    root.classList.add('fx-play'); setTimeout(() => root.classList.remove('fx-play'), 1600);
    let i = 0;
    const list = root.matches(CARDS) ? [root] : [...root.querySelectorAll(CARDS)];
    for (const el of list) {
      if (i > 28) break;
      if (el.parentElement && el.parentElement.closest('.fx-in')) continue;   // nested — parent animates it
      el.style.setProperty('--fx-d', (i++ * 45) + 'ms');
      el.classList.remove('fx-in'); void el.offsetWidth; el.classList.add('fx-in');
      el.addEventListener('animationend', () => el.classList.remove('fx-in'), { once: true });
    }
    if (!i && root.children.length) { root.classList.remove('fx-page'); void root.offsetWidth; root.classList.add('fx-page');
      root.addEventListener('animationend', () => root.classList.remove('fx-page'), { once: true }); }
    (root.matches(COUNTERS) ? [root] : root.querySelectorAll(COUNTERS)).forEach(countUp);
  }

  let pending = new Set(), scheduled = false;
  const mo = new MutationObserver((muts) => {
    if (!userCaused()) return;
    for (const m of muts) {
      if (m.type !== 'childList' || ![...m.addedNodes].some(n => n.nodeType === 1 && !n.classList.contains('fx-ripple'))) continue;
      pending.add(m.target);
    }
    if (!scheduled && pending.size) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const roots = [...pending]; pending = new Set();
        roots.filter(r => !roots.some(o => o !== r && o.contains(r))).forEach(animate);
      });
    }
  });
  const start = () => {
    mo.observe(document.body, { childList: true, subtree: true });
    mark(); animate(document.body);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  /* ---------- ripple on press ---------- */
  addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest(RIPPLE); if (!b || b.disabled) return;
    const cs = getComputedStyle(b);
    if (cs.position === 'static') b.style.position = 'relative';
    if (cs.overflow === 'visible') b.style.overflow = 'hidden';
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
    const s = document.createElement('span'); s.className = 'fx-ripple';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s); setTimeout(() => s.remove(), 650);
  }, { passive: true });

  /* ---------- cursor spotlight on glass cards (desktop) ---------- */
  if (matchMedia('(hover: hover)').matches) {
    let cur = null, raf = 0, ev = null;
    addEventListener('pointermove', (e) => {
      ev = e; if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = ev.target.closest && ev.target.closest(SPOT);
        if (cur && cur !== el) cur.classList.remove('fx-spot');
        cur = el; if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
        el.style.setProperty('--my', (ev.clientY - r.top) + 'px');
        el.classList.add('fx-spot');
      });
    }, { passive: true });
  }
})();
