// ─────────────────────────────────────────────────────────────
// GreenLoop phone field — country code + local number, the same format
// as the DevX Nexus sign-in. Used by the CRM and the customer app.
//
//   GLPhone.html('l-phone', '+971501234567')  → markup for the field
//   GLPhone.read('l-phone')   → { ok, e164, empty, kind } | { ok:false, error }
//   GLPhone.format('+971501234567') → '+971 50 123 4567'
//
// v3.4.2: the numbering rules are spelled out per country (the same table as
// server/contacts.js) and the field explains them while you type:
//   UAE      mobile 9 digits starting 5 · landline 8 digits starting 2,3,4,6,7 or 9
//   Saudi    mobile 9 digits starting 5 · landline 9 digits starting 1
//   Qatar    8 digits · mobile 3,5,6,7 · landline 4
//   Oman     8 digits · mobile 7,9 · landline 2
//   Kuwait   8 digits · mobile 5,6,9 · landline 2
//   Bahrain  8 digits · mobile 3,6 · landline 1,7
// The server applies the same rules; this file gives the answer before Save.
// ─────────────────────────────────────────────────────────────
(function () {
  const COUNTRIES = [
    { cc: '971', name: 'UAE / Dubai', mobile: { len: 9, lead: '5', eg: '50 123 4567' }, landline: { len: 8, lead: '234679', eg: '4 123 4567' }, ph: '50 XXX XXXX' },
    { cc: '966', name: 'Saudi Arabia', mobile: { len: 9, lead: '5', eg: '50 123 4567' }, landline: { len: 9, lead: '1', eg: '11 123 4567' }, ph: '50 XXX XXXX' },
    { cc: '974', name: 'Qatar', mobile: { len: 8, lead: '3567', eg: '3312 3456' }, landline: { len: 8, lead: '4', eg: '4412 3456' }, ph: '3XXX XXXX' },
    { cc: '968', name: 'Oman', mobile: { len: 8, lead: '79', eg: '9212 3456' }, landline: { len: 8, lead: '2', eg: '2412 3456' }, ph: '9XXX XXXX' },
    { cc: '965', name: 'Kuwait', mobile: { len: 8, lead: '569', eg: '5012 3456' }, landline: { len: 8, lead: '2', eg: '2212 3456' }, ph: '5XXX XXXX' },
    { cc: '973', name: 'Bahrain', mobile: { len: 8, lead: '36', eg: '3612 3456' }, landline: { len: 8, lead: '17', eg: '1712 3456' }, ph: '3XXX XXXX' },
  ];
  COUNTRIES.forEach(c => { c.len = [...new Set([c.mobile.len, c.landline.len])]; c.max = Math.max(...c.len); });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const byCc = cc => COUNTRIES.find(c => c.cc === cc) || COUNTRIES[0];
  const orList = s => { const a = s.split(''); return a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1]; };

  const ruleShort = c => `Mobile: ${c.mobile.len} digits starting with ${orList(c.mobile.lead)}, e.g. ${c.mobile.eg}. Landline: ${c.landline.len} digits starting with ${orList(c.landline.lead)}.`;
  const ruleText = c => `${c.name} mobile numbers have ${c.mobile.len} digits and start with ${orList(c.mobile.lead)} (e.g. +${c.cc} ${c.mobile.eg}). ` +
    `Landlines have ${c.landline.len} digits and start with ${orList(c.landline.lead)} (e.g. +${c.cc} ${c.landline.eg}).`;
  function kindOf(c, d) {
    if (d.length === c.mobile.len && c.mobile.lead.includes(d[0])) return 'mobile';
    if (d.length === c.landline.len && c.landline.lead.includes(d[0])) return 'landline';
    return null;
  }
  const whyNot = (c, d) => !c.len.includes(d.length)
    ? `That number has ${d.length} digit${d.length === 1 ? '' : 's'} after +${c.cc}. ${ruleText(c)}`
    : `${d.length === 8 ? 'An' : 'A'} ${d.length}-digit ${c.name} number cannot start with ${d[0]}. ${ruleText(c)}`;
  // can these first digits still become a valid number?
  const canStart = (c, d) => !d || [c.mobile, c.landline].some(k => k.lead.includes(d[0]) && d.length <= k.len);

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
  // 50 123 4567 · 4 123 4567 (UAE landline) · 3312 3456
  function group(local, cc) {
    const l = String(local).replace(/\D/g, '');
    const c = byCc(cc || '971');
    if (c.max === 9) {
      const uaeLand = c.cc === '971' && l && !c.mobile.lead.includes(l[0]);
      return uaeLand ? [l.slice(0, 1), l.slice(1, 4), l.slice(4)].filter(Boolean).join(' ')
        : [l.slice(0, 2), l.slice(2, 5), l.slice(5)].filter(Boolean).join(' ');
    }
    return [l.slice(0, 4), l.slice(4)].filter(Boolean).join(' ');
  }
  const HINT = 'grid-column:1/-1;font-size:12px;line-height:1.4;margin-top:-2px;';
  function html(id, value, opts) {
    opts = opts || {};
    const v = split(value), c = byCc(v.cc);
    return `<div class="gl-phone" id="${id}-wrap">
      <select id="${id}-cc" class="gl-phone-cc" aria-label="Country code" onchange="GLPhone.sync('${id}')">${COUNTRIES.map(x =>
        `<option value="${x.cc}" ${x.cc === v.cc ? 'selected' : ''}>+${x.cc} — ${esc(x.name)}</option>`).join('')}</select>
      <input id="${id}" class="gl-phone-num" type="tel" inputmode="numeric" autocomplete="${opts.autocomplete || 'tel-national'}" maxlength="13"
        value="${esc(group(v.local, v.cc))}" placeholder="${c.ph}" aria-label="${esc(opts.label || 'Mobile number')}" aria-describedby="${id}-hint" oninput="GLPhone.sync('${id}')">
      <small id="${id}-hint" class="gl-phone-hint" style="${HINT}color:var(--muted)">${esc(ruleShort(c))}</small>
    </div>`;
  }
  // keeps the placeholder, the digit grouping and the hint in step with the country and what was typed
  function sync(id) {
    const cc = document.getElementById(id + '-cc'), inp = document.getElementById(id), hint = document.getElementById(id + '-hint');
    if (!cc || !inp) return;
    const c = byCc(cc.value);
    inp.placeholder = c.ph;
    const digits = inp.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, c.max);
    const next = group(digits, c.cc);
    if (next !== inp.value) inp.value = next;
    if (!hint) return;
    const kind = kindOf(c, digits);
    let text = ruleShort(c), color = 'var(--muted)';
    if (kind) { text = `✓ Valid ${c.name} ${kind} number: +${c.cc} ${next}`; color = 'var(--green)'; }
    else if (digits && !canStart(c, digits)) { text = whyNot(c, digits); color = 'var(--red)'; }
    hint.textContent = text; hint.style.color = color;
  }
  function read(id) {
    const cc = document.getElementById(id + '-cc'), inp = document.getElementById(id);
    if (!cc || !inp) return { ok: false, error: 'Mobile number field is missing' };
    const c = byCc(cc.value);
    const d = inp.value.replace(/\D/g, '').replace(/^0+/, '');
    if (!d) return { ok: true, empty: true, e164: '' };
    const kind = kindOf(c, d);
    if (!kind) return { ok: false, error: whyNot(c, d) };
    return { ok: true, empty: false, e164: `+${c.cc}${d}`, kind };
  }
  function format(value) {
    const v = split(value);
    return v.local ? `+${v.cc} ${group(v.local, v.cc)}` : String(value ?? '');
  }
  window.GLPhone = { html, read, sync, format, split, COUNTRIES };
})();
