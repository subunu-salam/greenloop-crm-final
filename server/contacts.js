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

// local = digits after the country code; len = allowed lengths; lead = allowed first digits
const COUNTRIES = [
  { cc: '971', name: 'UAE / Dubai', len: [9, 8], lead: { 9: '5', 8: '234679' }, example: '50 123 4567' },
  { cc: '966', name: 'Saudi Arabia', len: [9], lead: { 9: '15' }, example: '50 123 4567' },
  { cc: '974', name: 'Qatar', len: [8], lead: { 8: '34567' }, example: '3312 3456' },
  { cc: '968', name: 'Oman', len: [8], lead: { 8: '279' }, example: '9212 3456' },
  { cc: '965', name: 'Kuwait', len: [8], lead: { 8: '2569' }, example: '5012 3456' },
  { cc: '973', name: 'Bahrain', len: [8], lead: { 8: '1367' }, example: '3612 3456' },
];
const CODES = COUNTRIES.map(c => '+' + c.cc).join(', ');

// → { ok, e164, cc, local } or { ok:false, error }
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
  if (!country.len.includes(d.length)) {
    return { ok: false, error: `A ${country.name} number has ${country.len.join(' or ')} digits after +${country.cc} (e.g. +${country.cc} ${country.example})` };
  }
  if (!country.lead[d.length].includes(d[0])) return { ok: false, error: `That is not a valid ${country.name} number (e.g. +${country.cc} ${country.example})` };
  return { ok: true, e164: `+${country.cc}${d}`, cc: country.cc, local: d };
}
const normalizePhone = (input, defaultCc) => { const p = parsePhone(input, defaultCc); return p.ok ? p.e164 : null; };

// "+971501234567" → "+971 50 123 4567"
function formatPhone(input) {
  const p = parsePhone(input);
  if (!p.ok) return String(input ?? '');
  const l = p.local;
  const body = l.length === 9 ? `${l.slice(0, 2)} ${l.slice(2, 5)} ${l.slice(5)}` : `${l.slice(0, 4)} ${l.slice(4)}`;
  return `+${p.cc} ${body}`;
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
