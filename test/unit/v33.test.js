// v3.3 — one phone format + no duplicates, frequency-based pricing, preview before send,
// driver shift clock + arrival proof, 4-digit app codes, one-time codes by Gmail.
const { call, tok, db, v3 } = require('./harness'); const { q } = db;
const contacts = require('../../server/contacts');
const mailer = require('../../server/mailer');
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const results = []; const rec = (area, test, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + ' [' + area + '] ' + test + (detail !== undefined ? ' → ' + detail : '')); };
const today = new Date().toISOString().slice(0, 10);
const site = { name: 'HQ', zone: 'Deira', lat: 25.27, lng: 55.31 };
const lead = (o) => call('POST', '/leads', { token: A, body: { contact: 'Test', company: 'Co', service_type: 'WASTE', source: 'website', sites: [site], ...o } });
(async () => {
  let r;
  // ───────── PHONE FORMAT ─────────
  const P = (x) => contacts.parsePhone(x);
  rec('Phone', 'Every way of typing a UAE mobile gives the same stored number', ['+971 50 123 4567', '0501234567', '00971501234567', '971501234567', '50 123 4567'].every(x => P(x).e164 === '+971501234567'), '+971501234567');
  rec('Phone', 'The six GCC codes are accepted', ['+971501234567', '+966501234567', '+97433123456', '+96892123456', '+96550123456', '+97336123456'].every(x => P(x).ok), 'UAE, KSA, Qatar, Oman, Kuwait, Bahrain');
  rec('Phone', 'Other country codes are refused', !P('+91 98765 43210').ok && !P('+44 7700 900123').ok, P('+91 98765 43210').error);
  rec('Phone', 'Too short, too long and impossible numbers are refused', !P('+971 50 123').ok && !P('+971 50 123 45678').ok && !P('+971 60 123 4567').ok && !P('05O1234567').ok, P('+971 50 123').error);
  rec('Phone', 'Numbers display as +971 50 123 4567', contacts.formatPhone('+971501234567') === '+971 50 123 4567' && contacts.formatPhone('+97433123456') === '+974 3312 3456', contacts.formatPhone('+971501234567'));
  rec('Email', 'Email is trimmed, lower-cased and checked', contacts.parseEmail('  Sara@Bayt.AE ').email === 'sara@bayt.ae' && !contacts.parseEmail('sara@bayt').ok && !contacts.parseEmail('sara bayt@x.ae').ok && !contacts.parseEmail('a..b@x.ae').ok, 'sara@bayt.ae');

  // ───────── LEADS: validation + duplicates ─────────
  r = await lead({ phone: '050 777 0001', email: 'First@Dup.ae' });
  const L1 = r.body.id;
  rec('Lead', 'A lead is saved with the number in one format', r.status === 200 && q.get(`SELECT phone, email FROM leads WHERE id=?`, L1).phone === '+971507770001' && q.get(`SELECT email FROM leads WHERE id=?`, L1).email === 'first@dup.ae', '+971507770001');
  r = await lead({ phone: '+971 50 777 0001' });
  rec('Lead', 'The same mobile number cannot be added as a second lead', r.status === 409 && r.body.code === 'DUPLICATE' && r.body.duplicate.type === 'lead' && r.body.duplicate.id === L1, r.body.error);
  r = await lead({ phone: '+971507770002', email: 'FIRST@dup.ae' });
  rec('Lead', 'The same email (any capitals) cannot be added as a second lead', r.status === 409 && r.body.duplicate.field === 'email', r.body.duplicate && r.body.duplicate.field);
  r = await lead({ phone: '12345' });
  rec('Lead', 'A badly formed mobile number is refused with the reason', r.status === 400 && r.body.field === 'phone', r.body.error);
  r = await lead({ phone: '+971507770003', email: 'not-an-email' });
  rec('Lead', 'A badly formed email is refused', r.status === 400 && r.body.field === 'email', r.body.error);
  r = await lead({});
  rec('Lead', 'A lead needs a mobile number or an email', r.status === 400, r.body.error);
  r = await call('PUT', '/leads/' + L1, { token: A, body: { company: 'Renamed', phone: '+971507770001' } });
  rec('Lead', 'Editing a lead without changing its number is not a duplicate of itself', r.status === 200, r.status);
  r = await lead({ phone: '+971507770004' }); const L2 = r.body.id;
  r = await call('PUT', '/leads/' + L2, { token: A, body: { phone: '0507770001' } });
  rec('Lead', 'A lead cannot be changed to a number another lead has', r.status === 409, r.body.error);
  r = await call('PUT', '/leads/' + L2, { token: A, body: { stage: 'contacted' } });
  rec('Lead', 'Moving a lead between stages still works', r.status === 200, r.status);
  const cust0 = q.get(`SELECT id, name, branch, contact_phone FROM customers WHERE contact_phone LIKE '+9715%' ORDER BY id LIMIT 1`);
  r = await lead({ phone: cust0.contact_phone });
  rec('Lead', 'A number that already belongs to a customer cannot become a new lead', r.status === 409 && r.body.duplicate.type === 'customer', r.body.error);
  r = await call('GET', `/contacts/check?phone=${encodeURIComponent('050 777 0001')}`, { token: A });
  rec('Lead', 'The form can ask "is this already in the CRM?" while typing', r.body.duplicate && r.body.duplicate.id === L1 && r.body.phone === '+971507770001', r.body.duplicate && r.body.duplicate.message);

  // ───────── CUSTOMERS: validation + duplicates ─────────
  const cbody = (o) => ({ name: 'New Mart', branch: 'One', zone: 'Deira', frequency: 2, lat: 25.27, lng: 55.31, ...o });
  r = await call('POST', '/customers', { token: A, body: cbody({ contact_phone: '+971 50 888 0001', email: 'Shop@NewMart.ae' }) });
  const C1 = r.body.id;
  rec('Customer', 'A customer is saved with normalised mobile and email', r.status === 200 && q.get(`SELECT contact_phone p, email e FROM customers WHERE id=?`, C1).p === '+971508880001' && q.get(`SELECT email e FROM customers WHERE id=?`, C1).e === 'shop@newmart.ae', '+971508880001');
  r = await call('POST', '/customers', { token: A, body: cbody({ name: 'Other Shop', contact_phone: '0508880001' }) });
  rec('Customer', 'The same number on a different customer is refused, with an offer to add a site', r.status === 409 && r.body.can_link === true && r.body.duplicate.id === C1, r.body.error);
  r = await call('POST', '/customers', { token: A, body: cbody({ branch: 'Two', contact_phone: '0508880001', link_account_id: C1 }) });
  const C2 = r.body.id;
  rec('Customer', 'Adding it as another site joins the same account', r.status === 200 && r.body.linked_account === C1 && q.get(`SELECT account_id a FROM customers WHERE id=?`, C2).a === C1 && q.get(`SELECT account_id a FROM customers WHERE id=?`, C1).a === C1, 'account ' + C1);
  r = await call('PUT', '/customers/' + C2, { token: A, body: { address: 'New address' } });
  rec('Customer', 'Sites of one account may share the number', r.status === 200, r.status);
  r = await call('PUT', '/customers/' + cust0.id, { token: A, body: { contact_phone: '+971508880001' } });
  rec('Customer', 'Another customer cannot be changed to that number', r.status === 409, r.body.error);
  r = await call('PUT', '/customers/' + C1, { token: A, body: { contact_phone: '+44 7700 900123' } });
  rec('Customer', 'An unsupported country code is refused', r.status === 400, r.body.error);
  r = await call('POST', '/customers/import', { token: A, body: { csv: 'name,branch,zone,frequency,lat,lng,contact_phone,email\nNew Mart,Three,Deira,2,25.2,55.3,0508880001,\nStranger,Main,Deira,2,25.2,55.3,+971508880001,\nBad Phone,Main,Deira,2,25.2,55.3,123,\nFresh Co,Main,Deira,2,25.2,55.3,+971 50 888 0099,Hello@Fresh.ae' } });
  rec('Customer', 'CSV import: same business joins the account, strangers and bad numbers are reported', r.body.imported === 2 && r.body.errors.length === 2 && q.get(`SELECT account_id a FROM customers WHERE name='New Mart' AND branch='Three'`).a === C1 && q.get(`SELECT contact_phone p FROM customers WHERE name='Fresh Co'`).p === '+971508880099', `${r.body.imported} imported, ${r.body.errors.length} reported`);
  r = await call('POST', '/users', { token: A, body: { full_name: 'Test Driver', role: 'driver', pin: '7391', phone: '050-999-0001' } });
  rec('Phone', 'A driver\'s number is stored in the same format', r.status === 200 && q.get(`SELECT phone FROM users WHERE id=?`, r.body.id).phone === '+971509990001', '+971509990001');
  r = await call('POST', '/users', { token: A, body: { full_name: 'Bad', role: 'driver', pin: '7392', phone: '999' } });
  rec('Phone', 'A badly formed driver number is refused', r.status === 400, r.body.error);

  // ───────── FREQUENCY-BASED PRICING ─────────
  rec('Pricing', 'Visits a month follow the frequency', v3.visitsPerMonth('daily', 1) === 30 && v3.visitsPerMonth('daily', 2) === 60 && v3.visitsPerMonth('weekly', 1) === 4 && v3.visitsPerMonth('weekly', 3) === 13 && v3.visitsPerMonth('weekly', 7) === 30 && v3.visitsPerMonth('monthly', 2) === 2, 'daily 30, 3 a week 13, twice a month 2');
  const plan = { recurrence: { type: 'weekly', days: [0, 2, 4] }, time_window: '07:00-12:00', billing: 'monthly' };
  r = await lead({ phone: '+971507771001', email: 'buyer@freq.ae', frequency: 'weekly:3', sites: [site] }); const LF = r.body.id;
  r = await call('POST', '/quotations', { token: A, body: { lead_id: LF, plan, items: [
    { service_code: 'WASTE', freq_unit: 'weekly', freq_count: 3, unit_price: 100, qty: 999 },
    { service_code: 'PEST_GENERAL', freq_unit: 'monthly', freq_count: 1, unit_price: 400 },
    { service_code: 'WASTE', site: 'Depot', freq_unit: 'daily', freq_count: 1, unit_price: 10 }] } });
  const QF = r.body.id;
  let qv = (await call('GET', '/quotations/' + QF, { token: A })).body;
  rec('Pricing', 'Line totals are visits a month × price a visit', qv.items[0].qty === 13 && qv.items[0].line_total === 1300 && qv.items[1].qty === 1 && qv.items[2].qty === 30 && qv.items[2].line_total === 300 && qv.subtotal === 2000 && qv.total === 2100, `subtotal ${qv.subtotal}, total ${qv.total}`);
  rec('Pricing', 'A visit count sent by the browser is ignored when a frequency is set', qv.items[0].qty === 13, 'sent 999, stored ' + qv.items[0].qty);
  rec('Pricing', 'Each line carries a plain-words frequency', qv.items[0].frequency === '3 times a week' && qv.items[1].frequency === 'Once a month' && qv.items[2].frequency === 'Every day', qv.items.map(i => i.frequency).join(' | '));
  r = await call('POST', '/quotations', { token: A, body: { lead_id: LF, plan, items: [{ service_code: 'WASTE', freq_unit: 'weekly', freq_count: 9, unit_price: 100 }] } });
  rec('Pricing', 'More than 7 visits a week is refused', r.status === 400, r.body.error);
  r = await call('POST', '/quotations', { token: A, body: { lead_id: LF, plan, items: [{ service_code: 'WASTE', freq_unit: 'yearly', freq_count: 1, unit_price: 100 }] } });
  rec('Pricing', 'An unknown frequency is refused', r.status === 400, r.body.error);
  r = await call('GET', '/pricing/frequency?unit=weekly&count=5&unit_price=120', { token: A });
  rec('Pricing', 'The pricing rule can be asked directly', r.body.visits_per_month === 22 && r.body.line_total === 2640 && r.body.label === '5 times a week', `${r.body.visits_per_month} visits, AED ${r.body.line_total}`);
  const doc = String((await call('GET', `/quotations/${QF}/pdf`, { token: A })).body);
  rec('Pricing', 'The quotation document shows frequency, visits a month and a monthly total', doc.includes('3 times a week') && doc.includes('Total a month') && doc.includes('2,100.00'), 'Total a month AED 2,100.00');
  rec('Pricing', 'Schedules are derived from a frequency when the quote\'s days do not match it', JSON.stringify(v3.recurrenceForLine({ freq_unit: 'weekly', freq_count: 3 }, plan.recurrence)) === JSON.stringify(plan.recurrence)
    && v3.recurrenceForLine({ freq_unit: 'weekly', freq_count: 2 }, plan.recurrence).days.length === 2 && v3.recurrenceForLine({ freq_unit: 'monthly', freq_count: 1 }, plan.recurrence).type === 'monthly'
    && v3.recurrenceForLine({ freq_unit: 'daily', freq_count: 1 }, plan.recurrence).type === 'daily' && v3.recurrenceForLine({ qty: 4 }, plan.recurrence) === plan.recurrence, 'weekly×2 → 2 days, monthly → monthly');
  const twice = v3.recurrenceForLine({ freq_unit: 'monthly', freq_count: 2 }, plan.recurrence);
  rec('Pricing', 'Twice a month is scheduled on two dates', twice.dates.length === 2 && v3.occursOn(twice, '2026-10-01') && v3.occursOn(twice, '2026-10-15') && !v3.occursOn(twice, '2026-10-08') && v3.occursOn({ type: 'monthly', mode: 'date', date: 5 }, '2026-10-05'), 'days ' + twice.dates.join(', '));

  // ───────── PREVIEW BEFORE SEND ─────────
  r = await call('POST', `/quotations/${QF}/send`, { token: A, body: { to: 'buyer@freq.ae' } });
  rec('Preview', 'An email cannot be sent without previewing it first', r.status === 428 && r.body.code === 'PREVIEW_REQUIRED' && q.get(`SELECT status FROM quotations WHERE id=?`, QF).status === 'draft', r.body.error);
  r = await call('POST', `/quotations/${QF}/preview`, { token: A, body: { base_url: 'https://app.greenloop.ae' } });
  const pv = r.body;
  rec('Preview', 'The preview returns the exact email: recipient, subject and body', r.status === 200 && pv.to === 'buyer@freq.ae' && pv.subject.includes('AED 2,100.00 a month') && pv.html.includes('https://app.greenloop.ae/q/') && pv.html.includes('3 times a week') && pv.text.includes('Total a month: AED 2,100.00'), pv.subject);
  rec('Preview', 'Previewing does not send or log anything', q.get(`SELECT status, sent_at FROM quotations WHERE id=?`, QF).status === 'draft' && !q.get(`SELECT sent_at FROM quotations WHERE id=?`, QF).sent_at, 'still draft');
  r = await call('POST', `/quotations/${QF}/preview`, { token: A, body: { to: 'not an email' } });
  rec('Preview', 'A bad recipient address is caught at the preview', r.status === 400, r.body.error);
  r = await call('POST', `/quotations/${QF}/send`, { token: A, body: { base_url: 'https://app.greenloop.ae', to: 'someone.else@freq.ae', preview_token: pv.preview_token } });
  rec('Preview', 'Changing the recipient after the preview blocks the send', r.status === 409 && r.body.code === 'PREVIEW_STALE', r.body.error);
  r = await call('POST', `/quotations/${QF}/send`, { token: A, body: { base_url: 'https://app.greenloop.ae', preview_token: 'f'.repeat(32) } });
  rec('Preview', 'A made-up preview token is refused', r.status === 409, r.status);
  const realSend = mailer.send; const outbox = [];
  process.env.GMAIL_USER = 'sales@greenloop.ae'; process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  mailer.send = async (m) => { outbox.push(m); return { ok: true }; };
  const pv2 = (await call('POST', `/quotations/${QF}/preview`, { token: A, body: { base_url: 'https://app.greenloop.ae' } })).body;
  r = await call('POST', `/quotations/${QF}/send`, { token: A, body: { base_url: 'https://app.greenloop.ae', preview_token: pv2.preview_token } });
  rec('Preview', 'After the preview the email goes out, identical to what was shown', r.status === 200 && r.body.delivery === 'sent' && outbox.length === 1 && outbox[0].html === pv2.html && outbox[0].subject === pv2.subject && outbox[0].to === pv2.to, 'sent to ' + r.body.to);
  rec('Preview', 'Preview says who the email is from when Gmail is connected', pv2.from === 'sales@greenloop.ae' && pv2.delivery === 'sent', pv2.from);

  // ───────── 4-DIGIT APP CODE + per-line schedules on registration ─────────
  await call('POST', `/quotations/${QF}/status`, { token: A, body: { status: 'accepted' } });
  outbox.length = 0;
  r = await call('POST', `/quotations/${QF}/convert`, { token: A });
  const NC = r.body.customer_id, code = r.body.portal_code;
  rec('Sign-in', 'A new customer gets a 4-digit app code', r.status === 200 && /^\d{4}$/.test(code), code && code.replace(/\d/g, '•'));
  rec('Sign-in', 'The welcome email gives the mobile number in the standard format and the code', outbox.length === 1 && outbox[0].text.includes('+971 50 777 1001') && outbox[0].text.includes(code), 'welcome email');
  const plans = q.all(`SELECT service_code, recurrence FROM service_plans WHERE customer_id=?`, NC).map(p => ({ code: p.service_code, rule: JSON.parse(p.recurrence) }));
  rec('Pricing', 'On registration each service is scheduled by its own frequency', plans.find(p => p.code === 'WASTE').rule.type === 'weekly' && plans.find(p => p.code === 'PEST_GENERAL').rule.type === 'monthly', plans.map(p => p.code + ':' + p.rule.type).join(', '));
  r = await call('POST', '/auth/customer-login', { body: { phone: '050 777 1001', code } });
  rec('Sign-in', 'The customer signs in with mobile number + 4-digit code', r.status === 200 && r.body.customer.id === NC, r.status);
  r = await call('POST', '/auth/customer-login', { body: { phone: '+971 50 777 1001', code: '12' } });
  rec('Sign-in', 'A code shorter than 4 digits is refused', r.status === 400, r.body.error);
  q.run(`UPDATE customers SET portal_code_hash=? WHERE id=?`, 'h:654321', NC);
  r = await call('POST', '/auth/customer-login', { body: { phone: '+971507771001', code: '654321' } });
  rec('Sign-in', 'A 6-digit code issued before this version still works', r.status === 200, r.status);
  r = await call('POST', `/customers/${NC}/portal-code`, { token: A });
  rec('Sign-in', 'Resetting a code issues a 4-digit one', /^\d{4}$/.test(r.body.portal_code), 'reset');
  r = await lead({ phone: '+971507771001' });
  rec('Lead', 'A registered customer\'s number cannot be re-entered as a new lead', r.status === 409, r.body.duplicate && r.body.duplicate.type);

  // ───────── ONE-TIME CODES BY GMAIL ─────────
  outbox.length = 0;
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: '050 777 1001' } });
  await new Promise(x => setTimeout(x, 20));
  const otp = outbox[0] && /^(\d{6}) is your/.exec(outbox[0].subject);
  rec('OTP', 'Typing the mobile number emails a 6-digit code to the address on the account', r.status === 200 && outbox.length === 1 && outbox[0].to === 'buyer@freq.ae' && !!otp, outbox[0] && outbox[0].to);
  rec('OTP', 'With Gmail connected the code is never shown on screen', r.body.dev_code === undefined, 'no dev_code');
  r = await call('POST', '/auth/customer-otp/verify', { body: { identifier: '+971507771001', code: '000000' } });
  rec('OTP', 'A wrong code is refused', r.status === 401, r.status);
  r = await call('POST', '/auth/customer-otp/verify', { body: { identifier: '+971507771001', code: otp[1] } });
  rec('OTP', 'The emailed code signs the customer in', r.status === 200 && r.body.customer.id === NC, r.status);
  r = await call('POST', '/auth/customer-otp/verify', { body: { identifier: '+971507771001', code: otp[1] } });
  rec('OTP', 'A code works only once', r.status === 401, r.status);
  outbox.length = 0;
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: '+971 50 000 9999' } });
  rec('OTP', 'An unknown number gets the same reply and no email', r.status === 200 && outbox.length === 0 && /If this mobile number or email is registered/.test(r.body.message), 'no email sent');
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: '12' } });
  rec('OTP', 'A badly formed number is refused', r.status === 400, r.body.error);
  const noMail = q.get(`SELECT id, name, contact_phone FROM customers WHERE (email IS NULL OR email='') AND contact_phone LIKE '+9715%' AND portal_code_hash IS NOT NULL LIMIT 1`);
  const before = q.get(`SELECT COUNT(*) c FROM alerts WHERE type='OTP_NOT_SENT'`).c;
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: noMail.contact_phone } });
  rec('OTP', 'An account with no email raises an alert for the office instead of failing silently', outbox.length === 0 && q.get(`SELECT COUNT(*) c FROM alerts WHERE type='OTP_NOT_SENT'`).c === before + 1, noMail.name);
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: 'BUYER@freq.ae' } });
  await new Promise(x => setTimeout(x, 20));
  rec('OTP', 'Asking by email address works too', outbox.length === 1 && outbox[0].to === 'buyer@freq.ae', outbox.length + ' email');
  mailer.send = realSend; delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: '+971507771001' } });
  rec('OTP', 'Without Gmail the code is not shown on screen any more (v3.4.4)', r.body.dev_code === undefined, 'no dev_code');
  process.env.OTP_DEV = '1';
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: '+971507771001' } });
  delete process.env.OTP_DEV;
  rec('OTP', 'OTP_DEV=1 shows the code on screen for local testing', /^\d{6}$/.test(r.body.dev_code || ''), 'test mode');

  // ───────── DRIVER: shift clock, arrival proof, finish / issue ─────────
  const drivers = q.all(`SELECT id, full_name, vehicle_id FROM users WHERE role='driver' AND is_active=1 AND vehicle_id IS NOT NULL ORDER BY id`);
  const d1 = drivers[0], d2 = drivers.find(d => d.vehicle_id !== d1.vehicle_id);
  const D1 = tok({ id: d1.id, role: 'driver', name: d1.full_name, vehicle_id: d1.vehicle_id });
  const D2 = tok({ id: d2.id, role: 'driver', name: d2.full_name, vehicle_id: d2.vehicle_id });
  const sites = q.all(`SELECT id, name, lat, lng FROM customers WHERE is_active=1 ORDER BY id LIMIT 6`);
  const job = (c, drv = d1) => Number(q.run(`INSERT INTO pickups(customer_id,vehicle_id,driver_id,scheduled_date,seq,status,service_type) VALUES (?,?,?,?,90,'pending','WASTE')`, c.id, drv.vehicle_id, drv.id, today).lastInsertRowid);
  const photo = (c, o = {}) => ({ lat: String(c.lat), lng: String(c.lng), device_now: new Date().toISOString(), photo_taken_at: new Date().toISOString(), stamped: '1', stamp_text: `${c.name} | GPS | GreenLoop · Arrived on site`, source: 'camera', ...o });
  const F = (n) => ({ filename: n, path: '/tmp/none-' + n, mimetype: 'image/jpeg' });

  r = await call('GET', '/driver/shift', { token: D1 });
  rec('Shift', 'A driver starts the day not clocked in', r.status === 200 && r.body.shift === null, 'no shift');
  r = await call('POST', '/driver/shift/clock-out', { token: D1 });
  rec('Shift', 'Clocking out without a shift is refused', r.status === 409, r.body.error);
  r = await call('POST', '/driver/shift/clock-in', { token: D1, body: { lat: 25.27, lng: 55.31 } });
  rec('Shift', 'Clock in opens a shift with time and GPS', r.status === 200 && r.body.shift.open && r.body.shift.clock_in_lat === 25.27 && !r.body.already, r.body.shift.clock_in_at);
  r = await call('POST', '/driver/shift/clock-in', { token: D1, body: {} });
  rec('Shift', 'Clocking in twice keeps the one shift', r.body.already === true && q.get(`SELECT COUNT(*) c FROM driver_shifts WHERE driver_id=?`, d1.id).c === 1, 'already on shift');
  r = await call('POST', '/driver/shift/clock-in', { token: A, body: {} });
  rec('Security', 'Only drivers can clock in', r.status === 403, r.status);

  const j1 = job(sites[0]);
  r = await call('POST', `/pickups/${j1}/finish`, { token: D1, body: {} });
  rec('Driver', 'A job cannot be finished before the arrival photo', r.status === 409 && r.body.code === 'NOT_ARRIVED', r.body.error);
  r = await call('POST', `/pickups/${j1}/issue`, { token: D1, body: { reason: 'CLOSED' } });
  rec('Driver', 'An issue cannot be reported before the arrival photo', r.status === 409 && r.body.code === 'NOT_ARRIVED', r.body.code);
  r = await call('POST', `/pickups/${j1}/ack`, { token: D1 });
  rec('Driver', 'Start job starts the job timer', r.status === 200 && !!q.get(`SELECT started_at s FROM pickups WHERE id=?`, j1).s, 'started_at set');
  r = await call('POST', `/pickups/${j1}/arrive-proof`, { token: D1, body: photo(sites[0]) });
  rec('Driver', 'Arrival without a photo is refused', r.status === 400, r.body.error);
  const rejBefore = q.get(`SELECT COUNT(*) c FROM alerts WHERE type='PHOTO_REJECTED'`).c;
  r = await call('POST', `/pickups/${j1}/arrive-proof`, { token: D1, body: photo(sites[0], { lat: String(sites[0].lat + 0.02) }), file: F('far.jpg') });
  rec('Driver', 'An arrival photo taken far from the site is rejected and the office is alerted', r.status === 422 && r.body.rejected && /m from site/.test(r.body.problems[0]) && q.get(`SELECT COUNT(*) c FROM alerts WHERE type='PHOTO_REJECTED'`).c === rejBefore + 1 && !q.get(`SELECT arrived_at a FROM pickups WHERE id=?`, j1).a, r.body.problems[0]);
  r = await call('POST', `/pickups/${j1}/arrive-proof`, { token: D1, body: photo(sites[0], { lat: '', lng: '' }), file: F('nogps.jpg') });
  rec('Driver', 'An arrival photo without GPS is rejected', r.status === 422 && r.body.problems.some(x => /GPS/.test(x)), r.body.problems[0]);
  r = await call('POST', `/pickups/${j1}/arrive-proof`, { token: D2, body: photo(sites[0]), file: F('other.jpg') });
  rec('Security', 'Another driver cannot record arrival on this job', r.status === 403, r.status);
  r = await call('POST', `/pickups/${j1}/arrive-proof`, { token: D1, body: photo(sites[0]), file: F('ok1.jpg') });
  let row = q.get(`SELECT * FROM pickups WHERE id=?`, j1);
  rec('Driver', 'A GPS-stamped photo at the site records the arrival', r.status === 200 && r.body.stage === 'arrived' && row.arrival_photo_url === '/uploads/ok1.jpg' && row.arrival_distance_m === 0 && !!row.arrived_at && row.stage === 'arrived' && row.status === 'pending', `${row.arrival_distance_m} m from site`);
  r = await call('POST', `/pickups/${j1}/finish`, { token: D2, body: {} });
  rec('Security', 'Another driver cannot finish this job', r.status === 403, r.status);
  const invB = q.get(`SELECT COUNT(*) c FROM customer_notifications WHERE customer_id=? AND kind='completed'`, sites[0].id).c;
  r = await call('POST', `/pickups/${j1}/finish`, { token: D1, body: { checklist: ['Bins emptied'] } });
  row = q.get(`SELECT * FROM pickups WHERE id=?`, j1);
  rec('Driver', 'Finish completes the job with the arrival photo as proof (no second photo)', r.status === 200 && row.status === 'collected' && row.photo_url === '/uploads/ok1.jpg' && row.gps_lat === sites[0].lat && JSON.parse(row.proof_meta).proof === 'arrival' && JSON.parse(row.checklist)[0] === 'Bins emptied', row.status);
  rec('Driver', 'Job times are returned: drive, on site, total', r.body.travel_s >= 0 && r.body.on_site_s >= 0 && r.body.total_s >= 0 && !!r.body.arrived_at, `drive ${r.body.travel_s}s, on site ${r.body.on_site_s}s`);
  rec('Driver', 'The customer is told the service is completed', q.get(`SELECT COUNT(*) c FROM customer_notifications WHERE customer_id=? AND kind='completed'`, sites[0].id).c === invB + 1, 'notified');
  r = await call('POST', `/pickups/${j1}/finish`, { token: D1, body: {} });
  rec('Driver', 'A finished job cannot be finished again', r.status === 409, r.body.error);

  const j2 = job(sites[1]);
  await call('POST', `/pickups/${j2}/arrive-proof`, { token: D1, body: photo(sites[1]), file: F('ok2.jpg') });
  rec('Driver', 'Arriving without tapping Start still starts the job timer', !!q.get(`SELECT started_at s FROM pickups WHERE id=?`, j2).s, 'started_at set');
  r = await call('POST', `/pickups/${j2}/issue`, { token: D1, body: { reason: 'WEATHER' } });
  rec('Driver', 'An unknown issue reason is refused', r.status === 400, r.body.error);
  r = await call('POST', `/pickups/${j2}/issue`, { token: D1, body: { reason: 'CLOSED' } });
  row = q.get(`SELECT * FROM pickups WHERE id=?`, j2);
  rec('Driver', 'Site closed is reported with the arrival photo and goes to the customer to confirm', r.status === 200 && row.status === 'canceled' && row.anomaly_reason === 'CLOSED' && row.photo_url === '/uploads/ok2.jpg' && row.confirmation_status === 'awaiting', row.confirmation_status);
  rec('Driver', 'The office gets a not-picked-up alert', !!q.get(`SELECT 1 x FROM alerts WHERE type='ANOMALY' AND pickup_id=?`, j2), 'ANOMALY alert');

  const j3 = job(sites[2], d2);
  r = await call('POST', `/pickups/${j3}/ack`, { token: D2 });
  const auto = q.get(`SELECT * FROM driver_shifts WHERE driver_id=?`, d2.id);
  rec('Shift', 'Starting a job without clocking in opens a flagged shift, so no time is lost', !!auto && auto.auto_in === 1 && !auto.clock_out_at, 'auto_in');
  const j4 = job(sites[3]);
  r = await call('POST', `/pickups/${j4}/complete`, { token: D1, body: photo(sites[3]), file: F('old.jpg') });
  rec('Driver', 'The older one-step complete route still works (native app, offline queue)', r.status === 200 && q.get(`SELECT status s FROM pickups WHERE id=?`, j4).s === 'collected', r.status);

  r = await call('GET', '/driver/jobs-v3', { token: D1 });
  const fed = r.body.jobs.find(x => x.id === j1);
  rec('Driver', 'The app receives each job\'s times so the flow survives a reload', !!fed && !!fed.started_at && !!fed.arrived_at && fed.arrival_photo_url === '/uploads/ok1.jpg', 'started, arrived, photo');
  r = await call('GET', '/shifts?date=' + today, { token: A });
  const sv = r.body.rows.find(x => x.driver_id === d1.id);
  rec('Shift', 'The office sees who is on shift and the day\'s job figures', r.status === 200 && sv.on_shift === true && sv.jobs_finished >= 2 && sv.jobs_issue >= 1 && sv.shifts.length === 1, `${sv.jobs_done} of ${sv.jobs_total} reported`);
  r = await call('GET', '/shifts', { token: D1 });
  rec('Security', 'Drivers cannot read the shift report', r.status === 403, r.status);
  r = await call('GET', '/ledger?date=' + today, { token: A });
  const lr = r.body.rows.find(x => x.id === j1);
  rec('Shift', 'The route ledger carries start, arrival and distance for each stop', !!lr.started_at && !!lr.arrived_at && lr.arrival_distance_m === 0, 'started, arrived, 0 m');
  r = await call('POST', '/driver/shift/clock-out', { token: D1, body: {} });
  rec('Shift', 'Clock out closes the shift and returns the day\'s totals', r.status === 200 && !r.body.shift.open && r.body.shift.duration_s >= 0 && r.body.today.jobs_done >= 3, `${r.body.today.jobs_done} jobs`);
  q.run(`UPDATE driver_shifts SET work_date=date(work_date,'-1 day'), clock_in_at=datetime(clock_in_at,'-1 day') WHERE driver_id=?`, d2.id);
  r = await call('GET', '/driver/shift', { token: D2 });
  rec('Shift', 'A shift forgotten open yesterday is closed automatically', r.body.shift === null && q.get(`SELECT closed_by c FROM driver_shifts WHERE driver_id=?`, d2.id).c === 'auto', 'closed_by auto');

  const failed = results.filter(x => !x).length;
  console.log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL', e.stack); process.exit(1); });
