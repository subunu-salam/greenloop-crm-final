const { call, tok, db, v3 } = require('./harness'); const { q } = db;
const S = require('../../server/security');
const bcrypt = require('bcryptjs');
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const results = []; const rec = (area, test, ok, detail) => { results.push({ area, test, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + ' [' + area + '] ' + test + (detail ? ' → ' + detail : '')); };
const today = new Date().toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
(async () => {
  // ---------- LOGIN ABUSE ----------
  const custT = S.loginThrottle('customer', { max: 5, idFrom: (r) => r.body && r.body.phone });
  let first429 = 0; for (let i = 1; i <= 60; i++) { const r = await call('POST', '/auth/customer-login', { pre: [custT], body: { phone: '0500001001', code: String(200000 + i) } }); if (r.status === 429 && !first429) first429 = i; }
  rec('Security', 'Wrong store codes lock out after 5 attempts', first429 === 6, `first 429 at attempt ${first429}`);
  S._resetThrottles();
  let r = await call('POST', '/auth/customer-login', { pre: [custT], body: { phone: '+971 50 000 1001', code: '1001' } });
  rec('Security', 'Demo login works with mobile + code (+971 format)', r.status === 200, `status ${r.status}`);
  r = await call('POST', '/auth/customer-login', { pre: [custT], body: { code: '1001' } });
  rec('Security', 'Code without a mobile number is refused', r.status === 400, `status ${r.status}`);
  let n = 0; const orig = bcrypt.compareSync; bcrypt.compareSync = (...a) => { n++; return orig(...a); };
  await call('POST', '/auth/customer-login', { body: { phone: '0500001002', code: '999999' } }); bcrypt.compareSync = orig;
  rec('Performance', 'Login checks only the matching account (not every customer)', n <= 1, `${n} password check(s) for ${q.get('SELECT COUNT(*) c FROM customers').c} customers`);
  S._resetThrottles();
  const drvT = S.loginThrottle('driver', { max: 8 });
  first429 = 0; for (let i = 1; i <= 30; i++) { const x = await call('POST', '/auth/driver-login', { pre: [drvT], body: { pin: String(5000 + i) } }); if (x.status === 429 && !first429) first429 = i; }
  rec('Security', 'Wrong driver PINs lock out after 8 attempts', first429 === 9, `first 429 at attempt ${first429}`);
  const adminT = S.loginThrottle('admin', { max: 5, idFrom: (x) => x.body && x.body.username });
  first429 = 0; for (let i = 1; i <= 10; i++) { const x = await call('POST', '/auth/admin-login', { pre: [adminT], ip: '10.9.9.' + i, body: { username: 'admin', password: 'guess' + i } }); if (x.status === 429 && !first429) first429 = i; }
  rec('Security', 'Admin account locks after 5 wrong passwords even from different IPs', first429 === 6, `first 429 at attempt ${first429}`);
  const otpT = S.rateLimit('otpsend', { max: 3, windowMs: 15 * 60e3, idFrom: (x) => x.body && x.body.identifier });
  let ok = 0; for (let i = 0; i < 15; i++) { const x = await call('POST', '/auth/customer-otp/request', { pre: [otpT], body: { identifier: '+971500001001' } }); if (x.status === 200) ok++; }
  rec('Security', 'One-time codes limited to 3 requests per 15 min', ok === 3, `${ok}/15 accepted`);
  // ---------- PHOTOS ----------
  const signed = S.signUploadUrl('/uploads/pickup_abc.jpg');
  const gate = (url) => { let st = 200; const u = new URL('http://x' + url); S.uploadsGate({ path: u.pathname.replace('/uploads', ''), query: Object.fromEntries(u.searchParams) }, { status(c) { st = c; return this; }, send() {}, setHeader() {} }, () => {}); return st; };
  rec('Security', 'Photo opens with the app-issued signed link', gate(signed) === 200);
  rec('Security', 'Photo blocked without a signature', gate('/uploads/pickup_abc.jpg') === 403);
  rec('Security', 'Signed link cannot be reused for another photo', gate(signed.replace('pickup_abc', 'pickup_xyz')) === 403);
  let fErr = null; S.imageFileFilter({}, { mimetype: 'text/html' }, (e) => { fErr = e; });
  rec('Security', 'HTML file upload rejected (only images)', !!fErr && fErr.status === 415);
  let name = ''; S.safeImageName('pickup')({}, { mimetype: 'image/jpeg', originalname: 'evil.html' }, (e, nm) => { name = nm; });
  rec('Security', 'Stored file name is random with a .jpg extension', /^pickup_[0-9a-f]{24}\.jpg$/.test(name), name);
  const jl = await call('GET', '/dashboard', { token: A, pre: [S.signUploadLinks] });
  rec('Security', 'API responses carry signed photo links', !JSON.stringify(jl.body).match(/"\/uploads\/[^"?]+"/));
  // ---------- DRIVER RULES ----------
  const drv = q.all("SELECT id, vehicle_id FROM users WHERE role='driver' ORDER BY id LIMIT 2");
  const c = q.get('SELECT id, name, lat, lng FROM customers WHERE is_active=1 ORDER BY id DESC LIMIT 1');
  let k = 0; const job = (did, vid, date) => q.run(`INSERT INTO pickups(customer_id,driver_id,vehicle_id,scheduled_date,status,service_type) VALUES (?,?,?,?, 'pending','WASTE')`, c.id, did, vid, date || today).lastInsertRowid;
  const now = new Date().toISOString();
  const proof = (extra = {}) => ({ lat: c.lat, lng: c.lng, photo_taken_at: now, device_now: now, stamped: '1', stamp_text: c.name, source: 'camera', ...extra });
  const D0 = tok({ id: drv[0].id, role: 'driver', name: 'D0', vehicle_id: drv[0].vehicle_id }), D1 = tok({ id: drv[1].id, role: 'driver', name: 'D1', vehicle_id: drv[1].vehicle_id });
  const file = { filename: 'p.jpg', path: '/tmp/none' };
  let id = job(null, drv[0].vehicle_id); // unassigned job on driver 0's truck; driver 1 tries it
  r = await call('POST', `/pickups/${id}/complete`, { token: D1, file, body: proof() });
  rec('Feature', 'Unassigned job cannot be completed by a random driver', r.status === 403, `status ${r.status}`);
  id = job(drv[0].id, drv[0].vehicle_id);
  r = await call('POST', `/pickups/${id}/ack`, { token: D1 });
  rec('Feature', "Driver cannot send 'on the way' for someone else's job", r.status === 403, `status ${r.status}`);
  r = await call('POST', `/pickups/${id}/cancel`, { token: D1, file, body: proof({ reason: 'CLOSED' }) });
  rec('Feature', "Driver cannot report another driver's job not picked up", r.status === 403, `status ${r.status}`);
  id = job(drv[0].id, drv[0].vehicle_id, addDays(3));
  r = await call('POST', `/pickups/${id}/complete`, { token: D0, file, body: proof() });
  rec('Feature', 'Future job cannot be completed today', r.status === 409, `status ${r.status}: ${r.body.error}`);
  id = job(drv[0].id, drv[0].vehicle_id);
  r = await call('POST', `/pickups/${id}/complete`, { token: D0, file, body: proof({ photo_taken_at: new Date(Date.now() - 2 * 3600e3).toISOString() }) });
  rec('Proof', '2-hour-old photo rejected when sent live', r.status === 422, `status ${r.status} ${JSON.stringify(r.body.problems || '')}`);
  const before = q.get("SELECT COUNT(*) c FROM alerts WHERE type='LATE_PROOF'").c;
  r = await call('POST', `/pickups/${id}/complete`, { token: D0, file, body: proof({ photo_taken_at: new Date(Date.now() - 2 * 3600e3).toISOString(), queued: '1' }) });
  const after = q.get("SELECT COUNT(*) c FROM alerts WHERE type='LATE_PROOF'").c;
  rec('Proof', 'Same photo from the offline queue accepted and flagged to office', r.status === 200 && after === before + 1, `status ${r.status}, office alerts +${after - before}`);
  id = job(drv[0].id, drv[0].vehicle_id);
  r = await call('POST', `/pickups/${id}/complete`, { token: D0, file, body: proof() });
  const r2 = await call('POST', `/pickups/${id}/complete`, { token: D0, file, body: proof() });
  rec('Proof', 'Fresh proof accepted once, duplicate blocked', r.status === 200 && r2.status === 409, `${r.status} then ${r2.status}`);
  for (const [label, b] of [['missing GPS', { lat: '', lng: '' }], ['gallery photo', { source: 'gallery' }], ['unstamped photo', { stamped: '0' }], ['lat 999', { lat: 999, lng: 999 }]]) {
    id = job(drv[0].id, drv[0].vehicle_id); r = await call('POST', `/pickups/${id}/complete`, { token: D0, file, body: proof(b) });
    rec('Proof', 'Rejects ' + label, r.status === 422, `status ${r.status}`);
  }
  // ---------- VALIDATION ----------
  const C = tok({ id: c.id, role: 'customer', customer_id: c.id, name: 'C' });
  for (const [label, date] of [['"banana"', 'banana'], ['2026-13-45', '2026-13-45'], ['a date 5 years ahead', addDays(1900)], ['yesterday', addDays(-1)]]) {
    r = await call('POST', '/customer/bookings', { token: C, body: { date, service_code: 'WASTE', time_window: '07:00-12:00' } });
    rec('Validation', 'Booking rejects ' + label, r.status === 400, `status ${r.status}: ${r.body.error}`);
  }
  r = await call('POST', '/customer/bookings', { token: C, body: { date: addDays(5), service_code: 'WASTE', time_window: '07:00-12:00' } });
  rec('Validation', 'Booking accepts a normal date', r.status === 200, `status ${r.status}`);
  r = await call('POST', '/pickups/adhoc', { token: A, body: { customer_id: c.id, date: 'zzz', service_code: 'WASTE' } });
  rec('Validation', 'Ad-hoc order rejects date "zzz"', r.status === 400, `status ${r.status}`);
  r = await call('POST', '/pickups/adhoc', { token: A, body: { customer_id: c.id, date: addDays(40), service_code: 'WASTE', time_window: '12:00-07:00' } });
  rec('Validation', 'Ad-hoc rejects window 12:00-07:00', r.status === 400, `status ${r.status}: ${r.body.error}`);
  let blocked = null; S.limitTextFields({ body: { contact: 'x'.repeat(200000) } }, { status(cd) { blocked = cd; return this; }, json() {} }, () => { blocked = 'next'; });
  rec('Validation', '200 KB text field rejected', blocked === 400);
  r = await call('POST', '/leads', { token: A, body: { contact: 'Bad Phone', phone: 'not-a-phone' } });
  rec('Validation', 'Lead with invalid phone rejected', r.status === 400, `status ${r.status}`);
  r = await call('POST', '/leads', { token: A, body: { contact: 'Real Lead', company: 'Acme', phone: '+971 50 123 4567', sites: [{ name: 'S', lat: 25.1, lng: 55.2 }] } });
  rec('Validation', 'Lead with UAE phone accepted', r.status === 200, `status ${r.status}`);
  const leadId = r.body.id;
  const qt = (items) => call('POST', '/quotations', { token: A, body: { lead_id: leadId, items, plan: { recurrence: { type: 'weekly', days: [1] }, time_window: '07:00-12:00' } } });
  r = await qt([{ service_code: 'WASTE', qty: -5, unit_price: 150 }]);
  rec('Validation', 'Quotation rejects negative quantity', r.status === 400, `status ${r.status}: ${r.body.error}`);
  r = await qt([{ service_code: 'WASTE', qty: 1e9, unit_price: 1e9 }]);
  rec('Validation', 'Quotation rejects absurd amounts', r.status === 400, `status ${r.status}`);
  r = await qt([{ service_code: 'WASTE', qty: 13, unit_price: 150 }]);
  rec('Validation', 'Normal quotation still works', r.status === 200, `total ${r.body.total ?? r.body.quotation?.total ?? ''}`);
  for (const [label, rule, extra] of [['weekly with no days', { type: 'weekly', days: [] }, {}], ['monthly 6th weekday', { type: 'monthly', nth: 6, weekday: 1 }, {}], ['end before start', { type: 'daily' }, { end_date: '2020-01-01' }], ['start date "soon"', { type: 'daily' }, { start_date: 'soon' }]]) {
    r = await call('POST', '/service-plans', { token: A, body: { customer_id: c.id, service_code: 'WASTE', recurrence: rule, time_window: '07:00-12:00', start_date: today, ...extra } });
    rec('Validation', 'Plan rejects ' + label, r.status === 400, `status ${r.status}`);
  }
  // ---------- BILLING ----------
  const g1 = await call('POST', '/invoices/generate', { token: A, body: { period: today.slice(0, 7) } });
  const g2 = await call('POST', '/invoices/generate', { token: A, body: { period: today.slice(0, 7) } });
  rec('Billing', 'Invoicing twice does not double-bill', (g2.body.created || 0) === 0, `1st ${g1.body.created}, 2nd ${g2.body.created}`);
  const nums = q.all('SELECT number FROM invoices').map((x) => x.number);
  rec('Billing', 'Invoice numbers are unique', new Set(nums).size === nums.length, `${nums.length} invoices`);
  const inv = q.get("SELECT id FROM invoices WHERE status!='void' LIMIT 1");
  for (const [label, amount] of [['negative', -50], ['zero', 0], ['text', 'abc'], ['over balance', 1e7]]) {
    r = await call('POST', '/payments', { token: A, body: { invoice_id: inv.id, amount, method: 'cash' } });
    rec('Billing', 'Payment rejects ' + label + ' amount', r.status === 400, `status ${r.status}`);
  }
  const other = q.get('SELECT id FROM customers WHERE COALESCE(account_id,id) != (SELECT customer_id FROM invoices WHERE id=?) LIMIT 1', inv.id);
  r = await call('GET', `/invoices/${inv.id}/pdf`, { token: tok({ id: other.id, role: 'customer', customer_id: other.id, name: 'X' }) });
  rec('Security', "Customer cannot open another customer's invoice", r.status === 403, `status ${r.status}`);
  // ---------- NIGHTLY / BACKUP ----------
  const pc = q.all('SELECT id FROM customers WHERE is_active=1 ORDER BY id LIMIT 60');
  pc.forEach((x) => q.run(`INSERT INTO service_plans(customer_id,service_code,recurrence,time_window,start_date,unit_price,billing,status) VALUES (?,?,?,?,?,?,?,?)`, x.id, 'WASTE', JSON.stringify({ type: 'weekly', days: [0, 2, 4] }), '07:00-12:00', today, 150, 'monthly', 'active'));
  const g = await v3.generatePlansBatched({ days: 14 });
  rec('Reliability', 'Nightly planning runs in batches', g.plans >= pc.length && g.created > 0, `${g.plans} plans, ${g.created} new jobs`);
  v3.dailyBackup();
  const bdir = require('path').join(require('path').dirname(process.env.DB_PATH), 'backups');
  const files = require('fs').existsSync(bdir) ? require('fs').readdirSync(bdir) : [];
  rec('Reliability', 'Daily backup file written', files.some((f) => f.startsWith('greenloop-' + today)), files.join(', '));
  const bad = results.filter((x) => !x.ok);
  console.log(`\nSUMMARY: ${results.length - bad.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
