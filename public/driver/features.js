// Driver extras: navigate, call store, mark arrived, show access notes + status timeline
(function () {
  const API = '/api/v1';

  function token() {
    return localStorage.getItem('gl_drv_token');
  }

  async function fetchContext(pickupId) {
    try {
      const res = await fetch(API + '/driver/pickups/' + pickupId + '/context', {
        headers: { Authorization: 'Bearer ' + token() },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function mapsUrl(lat, lng, address) {
    if (lat != null && lng != null) {
      return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(lat + ',' + lng);
    }
    if (address) {
      return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(address);
    }
    return null;
  }

  const origOpenJob = window.openJob;
  window.openJob = async function (id) {
    if (typeof origOpenJob === 'function') origOpenJob(id);
    const ctx = await fetchContext(id);
    const job = window.currentJob || (window.jobs || []).find((j) => j.id === id);
    const meta = document.getElementById('job-meta');
    if (!meta) return;

    let extra = '';
    if (ctx && ctx.access_notes) {
      extra += `<div style="margin-top:10px;padding:10px;background:#1c2a36;border-radius:10px;border:1px solid #263847">
        <div style="font-size:11px;color:#8aa0b0;text-transform:uppercase">Access notes</div>
        <div style="margin-top:4px">${String(ctx.access_notes).replace(/</g, '&lt;')}</div></div>`;
    }
    const lat = ctx?.lat ?? job?.lat;
    const lng = ctx?.lng ?? job?.lng;
    const phone = ctx?.contact_phone || '';
    const address = ctx?.address || job?.address || '';
    const nav = mapsUrl(lat, lng, address);
    extra += `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">`;
    if (nav) {
      extra += `<a href="${nav}" target="_blank" rel="noopener" style="flex:1;text-align:center;padding:12px;background:#0f766e;color:#fff;border-radius:12px;font-weight:700;text-decoration:none">Navigate</a>`;
    }
    if (phone) {
      extra += `<a href="tel:${encodeURIComponent(phone)}" style="flex:1;text-align:center;padding:12px;background:#1c2a36;color:#e8eef2;border-radius:12px;font-weight:700;text-decoration:none;border:1px solid #263847">Call store</a>`;
    }
    extra += `</div>`;

    const stage = ctx?.stage || job?.stage;
    if (stage !== 'arrived' && job && !['collected', 'canceled'].includes(job.status)) {
      extra += `<button type="button" id="btn-arrived" style="width:100%;margin-top:10px;padding:14px;border:0;border-radius:12px;background:#0369a1;color:#fff;font-weight:700;font-size:15px">I'VE ARRIVED</button>`;
    }
    if (stage === 'arrived') {
      extra += `<p style="margin-top:8px;color:#22c55e;font-size:13px;font-weight:600">Status: Arrived at stop</p>`;
    }

    meta.insertAdjacentHTML('beforeend', extra);
    const btn = document.getElementById('btn-arrived');
    if (btn) {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await fetch(API + '/pickups/' + id + '/arrive', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token() },
          });
          if (window.currentJob) window.currentJob.stage = 'arrived';
          if (typeof window.renderJobDetail === 'function') window.renderJobDetail();
          btn.remove();
        } catch {
          btn.disabled = false;
        }
      };
    }
  };
})();
