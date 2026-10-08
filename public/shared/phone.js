// ─────────────────────────────────────────────────────────────
// GreenLoop phone field (v3.3) — country code + local number, the same format
// as the DevX Nexus sign-in. Used by the CRM and the customer app.
//
//   GLPhone.html('l-phone', '+971501234567')  → markup for the field
//   GLPhone.read('l-phone')   → { ok, e164, empty } | { ok:false, error }
//   GLPhone.format('+971501234567') → '+971 50 123 4567'
// The server (server/contacts.js) applies the same rules; this file only gives
// people the answer before they press Save.
// ─────────────────────────────────────────────────────────────
(function () {
  const COUNTRIES = [
    { cc: '971', name: 'UAE / Dubai', len: [9, 8], lead: { 9: '5', 8: '234679' }, ph: '50 XXX XXXX' },
    { cc: '966', name: 'Saudi Arabia', len: [9], lead: { 9: '15' }, ph: '50 XXX XXXX' },
    { cc: '974', name: 'Qatar', len: [8], lead: { 8: '34567' }, ph: '3XXX XXXX' },
    { cc: '968', name: 'Oman', len: [8], lead: { 8: '279' }, ph: '9XXX XXXX' },
    { cc: '965', name: 'Kuwait', len: [8], lead: { 8: '2569' }, ph: '5XXX XXXX' },
    { cc: '973', name: 'Bahrain', len: [8], lead: { 8: '1367' }, ph: '3XXX XXXX' },
  ];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const byCc = cc => COUNTRIES.find(c => c.cc === cc) || COUNTRIES[0];

  // split a stored value into { cc, local }; unknown formats keep their digits in `local`
  function split(value) {
    const s = String(value ?? '').trim();
    let d = s.replace(/\D/g, '');
    if (!d) return { cc: '971', local: '' };
    if (d.startsWith('00')) d = d.slice(2);
    const c = COUNTRIES.find(x => d.startsWith(x.cc) && (s.startsWith('+') || s.startsWith('00') || x.len.includes(d.length - x.cc.length)));
    if (c) return { cc: c.cc, local: d.slice(c.cc.length).replace(/^0+/, '') };
    return { cc: '971', local: d.replace(/^0+/, '') };
  }
  function group(local) {
    const l = String(local).replace(/\D/g, '');
    if (l.length <= 4) return l;
    return l.length === 9 || (l.length > 4 && l.length < 8 && l[0] === '5')
      ? [l.slice(0, 2), l.slice(2, 5), l.slice(5)].filter(Boolean).join(' ')
      : [l.slice(0, 4), l.slice(4)].filter(Boolean).join(' ');
  }
  function html(id, value, opts) {
    opts = opts || {};
    const v = split(value);
    return `<div class="gl-phone" id="${id}-wrap">
      <select id="${id}-cc" class="gl-phone-cc" aria-label="Country code" onchange="GLPhone.sync('${id}')">${COUNTRIES.map(c =>
        `<option value="${c.cc}" ${c.cc === v.cc ? 'selected' : ''}>+${c.cc} — ${esc(c.name)}</option>`).join('')}</select>
      <input id="${id}" class="gl-phone-num" type="tel" inputmode="numeric" autocomplete="${opts.autocomplete || 'tel-national'}" maxlength="12"
        value="${esc(group(v.local))}" placeholder="${byCc(v.cc).ph}" aria-label="${esc(opts.label || 'Mobile number')}" oninput="GLPhone.sync('${id}')">
    </div>`;
  }
  // keeps the placeholder in step with the country and re-groups digits as they are typed
  function sync(id) {
    const cc = document.getElementById(id + '-cc'), inp = document.getElementById(id);
    if (!cc || !inp) return;
    inp.placeholder = byCc(cc.value).ph;
    const digits = inp.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
    const next = group(digits);
    if (next !== inp.value) inp.value = next;
  }
  function read(id) {
    const cc = document.getElementById(id + '-cc'), inp = document.getElementById(id);
    if (!cc || !inp) return { ok: false, error: 'Mobile number field is missing' };
    const c = byCc(cc.value);
    const d = inp.value.replace(/\D/g, '').replace(/^0+/, '');
    if (!d) return { ok: true, empty: true, e164: '' };
    if (!c.len.includes(d.length)) return { ok: false, error: `A ${c.name} number has ${c.len.join(' or ')} digits after +${c.cc}` };
    if (!c.lead[d.length].includes(d[0])) return { ok: false, error: `That is not a valid ${c.name} number` };
    return { ok: true, empty: false, e164: `+${c.cc}${d}` };
  }
  function format(value) {
    const v = split(value);
    return v.local ? `+${v.cc} ${group(v.local)}` : String(value ?? '');
  }
  window.GLPhone = { html, read, sync, format, split, COUNTRIES };
})();
