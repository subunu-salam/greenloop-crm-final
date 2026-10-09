// ─────────────────────────────────────────────────────────────
// Contact identifiers (v3.3): one phone format, validated email, no duplicates.
//
//   Phone   stored as E.164 ("+971501234567"). Entered as country code + local
//           number, the same six GCC codes as the DevX Nexus sign-in.
//   Email   trimmed + lower-cased.
//   Unique  a mobile number or email may belong to only one lead and one
//           customer account (an account can have several sites that share it).
// ─────────────────────────────────────────────────────────────
const { q } = require('./db');

// Numbering rules per country (digits after the country code, without the leading 0):
//   UAE      mobile 9 digits starting 5 (50 123 4567) · landline 8 digits, area code 2,3,4,6,7 or 9 (4 123 4567)
//   Saudi    mobile 9 digits starting 5 · landline 9 digits starting 1 (11 = Riyadh, 12 = Jeddah …)
//   Qatar    8 digits · mobile starts 3, 5, 6 or 7 · landline starts 4
//   Oman     8 digits · mobile starts 7 or 9 · landline starts 2
//   Kuwait   8 digits · mobile starts 5, 6 or 9 · landline starts 2
//   Bahrain  8 digits · mobile starts 3 or 6 · landline starts 1 or 7
// public/shared/phone.js carries the same table for the browser.
const COUNTRIES = [
  { cc: '971', name: 'UAE / Dubai', mobile: { len: 9, lead: '5', eg: '50 123 4567' }, landline: { len: 8, lead: '234679', eg: '4 123 4567' } },
  { cc: '966', name: 'Saudi Arabia', mobile: { len: 9, lead: '5', eg: '50 123 4567' }, landline: { len: 9, lead: '1', eg: '11 123 4567' } },
  { cc: '974', name: 'Qatar', mobile: { len: 8, lead: '3567', eg: '3312 3456' }, landline: { len: 8, lead: '4', eg: '4412 3456' } },
  { cc: '968', name: 'Oman', mobile: { len: 8, lead: '79', eg: '9212 3456' }, landline: { len: 8, lead: '2', eg: '2412 3456' } },
  { cc: '965', name: 'Kuwait', mobile: { len: 8, lead: '569', eg: '5012 3456' }, landline: { len: 8, lead: '2', eg: '2212 3456' } },
  { cc: '973', name: 'Bahrain', mobile: { len: 8, lead: '36', eg: '3612 3456' }, landline: { len: 8, lead: '17', eg: '1712 3456' } },
];
COUNTRIES.forEach(c => { c.len = [...new Set([c.mobile.len, c.landline.len])]; c.example = c.mobile.eg; });
const CODES = COUNTRIES.map(c => '+' + c.cc).join(', ');
const orList = s => { const a = s.split(''); return a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1]; };
// one sentence that states the rule for a country, used in every error so the fix is obvious
function ruleText(c) {
  const m = c.mobile, l = c.landline;
  return `${c.name} mobile numbers have ${m.len} digits and start with ${orList(m.lead)} (e.g. +${c.cc} ${m.eg}). ` +
    `Landlines have ${l.len} digits and start with ${orList(l.lead)} (e.g. +${c.cc} ${l.eg}).`;
}
// digits after the country code → 'mobile' | 'landline' | null
function kindOf(c, d) {
  if (d.length === c.mobile.len && c.mobile.lead.includes(d[0])) return 'mobile';
  if (d.length === c.landline.len && c.landline.lead.includes(d[0])) return 'landline';
  return null;
}
function whyNot(c, d) {
  if (!c.len.includes(d.length)) return `That number has ${d.length} digit${d.length === 1 ? '' : 's'} after +${c.cc}. ${ruleText(c)}`;
  return `${d.length === 8 ? 'An' : 'A'} ${d.length}-digit ${c.name} number cannot start with ${d[0]}. ${ruleText(c)}`;
}

// → { ok, e164, cc, local, kind } or { ok:false, error }
function parsePhone(input, defaultCc = '971') {
  let s = String(input ?? '').trim();
  if (!s) return { ok: false, error: 'Enter a mobile number' };
  if (/[^\d+\s().-]/.test(s)) return { ok: false, error: 'A mobile number can only contain digits' };
  let d = s.replace(/\D/g, '');
  let country = null;
  if (s.startsWith('+') || d.startsWith('00')) {
    if (d.startsWith('00')) d = d.slice(2);
    country = COUNTRIES.find(c => d.startsWith(c.cc));
    if (!country) return { ok: false, error: `Choose a supported country code (${CODES})` };
    d = d.slice(country.cc.length);
  } else {
    // "971501234567" typed without the plus is still recognised
    country = COUNTRIES.find(c => d.startsWith(c.cc) && c.len.includes(d.length - c.cc.length));
    if (country) d = d.slice(country.cc.length);
    else country = COUNTRIES.find(c => c.cc === String(defaultCc)) || COUNTRIES[0];
  }
  d = d.replace(/^0+/, '');                       // 050 123 4567 → 50 123 4567
  const kind = kindOf(country, d);
  if (!kind) return { ok: false, error: whyNot(country, d) };
  return { ok: true, e164: `+${country.cc}${d}`, cc: country.cc, local: d, kind };
}
const normalizePhone = (input, defaultCc) => { const p = parsePhone(input, defaultCc); return p.ok ? p.e164 : null; };

// "+971501234567" → "+971 50 123 4567" · "+97141234567" → "+971 4 123 4567" · "+97433123456" → "+974 3312 3456"
function groupLocal(cc, l) {
  if (l.length === 9) return `${l.slice(0, 2)} ${l.slice(2, 5)} ${l.slice(5)}`;
  if (cc === '971' && l.length === 8) return `${l.slice(0, 1)} ${l.slice(1, 4)} ${l.slice(4)}`;
  return `${l.slice(0, 4)} ${l.slice(4)}`;
}
function formatPhone(input) {
  const p = parsePhone(input);
  if (!p.ok) return String(input ?? '');
  return `+${p.cc} ${groupLocal(p.cc, p.local)}`;
}

const EMAIL_RX = /^[a-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
function parseEmail(input) {
  const e = String(input ?? '').trim().toLowerCase();
  if (!e) return { ok: false, error: 'Enter an email address' };
  if (e.length > 190 || !EMAIL_RX.test(e) || e.includes('..')) return { ok: false, error: 'That email address is not valid (e.g. name@company.ae)' };
  return { ok: true, email: e };
}

// Same number, however it was typed or stored (older rows are not all E.164).
const tail = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '').slice(-9);
function samePhone(a, b) {
  if (!a || !b) return false;
  const na = normalizePhone(a), nb = normalizePhone(b);
  if (na && nb) return na === nb;
  const ta = tail(a), tb = tail(b);
  return ta.length >= 7 && ta === tb;
}
const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/* Who already uses this mobile number or email?
   opts.exceptLeadId     ignore this lead (editing it)
   opts.exceptAccountId  ignore this customer account and every site in it
   Returns null, or { type:'lead'|'customer', id, name, field:'mobile number'|'email', stage? } */
function findDuplicate({ phone, email }, opts = {}) {
  if (!phone && !email) return null;
  const hit = (row, rowPhone, rowEmail) => (phone && samePhone(phone, rowPhone)) ? 'mobile number' : (email && sameEmail(email, rowEmail)) ? 'email' : null;

  const customers = q.all(`SELECT id, COALESCE(account_id, id) acct, name, branch, contact_phone, email FROM customers`);
  for (const c of customers) {
    if (opts.exceptAccountId && Number(c.acct) === Number(opts.exceptAccountId)) continue;
    const field = hit(c, c.contact_phone, c.email);
    if (field) return { type: 'customer', id: c.acct, name: c.name + (c.branch ? ` (${c.branch})` : ''), field };
  }
  const leads = q.all(`SELECT id, contact, company, phone, email, stage, customer_id FROM leads`);
  for (const l of leads) {
    if (opts.exceptLeadId && Number(l.id) === Number(opts.exceptLeadId)) continue;
    // a won lead is the same party as its customer account, already checked above
    if (opts.exceptAccountId && l.customer_id && Number(l.customer_id) === Number(opts.exceptAccountId)) continue;
    const field = hit(l, l.phone, l.email);
    if (field) return { type: 'lead', id: l.id, name: l.company || l.contact, field, stage: l.stage };
  }
  return null;
}
function duplicateMessage(d) {
  return d.type === 'customer'
    ? `This ${d.field} already belongs to customer “${d.name}”. Open that customer instead of creating a duplicate.`
    : `This ${d.field} is already on the lead “${d.name}” (${d.stage}). Open that lead instead of creating a duplicate.`;
}

module.exports = { COUNTRIES, parsePhone, normalizePhone, formatPhone, parseEmail, samePhone, sameEmail, findDuplicate, duplicateMessage };
