const { call, tok, db, v3 } = require('./harness');
const { q } = db;
const assert = require('assert');
(async () => {
  const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
  const OPS = tok({ id: 9, role: 'admin', crm_role: 'ops', name: 'Ops' });
  // recurrence unit tests
  assert(v3.occursOn({ type: 'weekly', days: [0, 2] }, '2026-10-04')); // Sunday
  assert(!v3.occursOn({ type: 'weekly', days: [0, 2] }, '2026-10-05'));
  assert(v3.occursOn({ type: 'monthly', mode: 'nth', n: 2, weekday: 1 }, '2026-10-12')); // 2nd Monday Oct 2026
  assert(!v3.occursOn({ type: 'monthly', mode: 'nth', n: 2, weekday: 1 }, '2026-10-05'));
  assert(v3.occursOn({ type: 'monthly', mode: 'nth', n: -1, weekday: 5 }, '2026-10-30')); // last Friday
  assert(v3.occursOn({ type: 'monthly', date: 15 }, '2026-10-15'));
  assert(!v3.occursOn({ type: 'daily', weekdays_only: true }, '2026-10-03')); // Sat
  assert(v3.occursOn({ type: 'daily', weekdays_only: true }, '2026-10-05'));
  console.log('✔ recurrence rules');

  let r = await call('POST', '/leads', { token: OPS, body: { contact: 'Sara', company: 'Bayt Cafe', phone: '+971501234567', email: 'sara@bayt.ae', service_type: 'PEST_GENERAL', source: 'whatsapp',
    sites: [{ name: 'JLT', zone: 'Marina', lat: 25.07, lng: 55.14, address: 'JLT Cluster D' }, { name: 'Deira', zone: 'Deira', lat: 25.27, lng: 55.31 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); const leadId = r.body.id;
  r = await call('POST', '/quotations', { token: OPS, body: { lead_id: leadId, items: [{ service_code: 'WASTE', description: 'Waste pickup', qty: 12, unit_price: 150 }, { service_code: 'PEST_GENERAL', qty: 1, unit_price: 400, site: 'JLT' }],
    plan: { recurrence: { type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6] }, time_window: '08:00-11:00', billing: 'monthly' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); let qid = r.body.id;
  let qv = (await call('GET', '/quotations/' + qid, { token: A })).body;
  assert.equal(qv.subtotal, 2200); assert.equal(qv.vat, 110); assert.equal(qv.total, 2310);
  r = await call('POST', '/quotations', { token: A, body: { lead_id: leadId, revise_of: qid, items: [{ service_code: 'WASTE', qty: 12, unit_price: 140 }, { service_code: 'PEST_GENERAL', qty: 1, unit_price: 400, site: 'JLT' }], plan: qv.plan } });
  assert.equal(r.body.version, 2); qid = r.body.id;
  // v3.2: Gmail is the default channel; WhatsApp remains available as an explicit fallback
  r = await call('POST', `/quotations/${qid}/send`, { token: A, body: { via: 'whatsapp' } });
  assert(r.body.whatsapp_url.startsWith('https://wa.me/971501234567?text=')); console.log('✔ quote v2 + wa.me', r.body.link);
  r = await call('GET', `/quotations/${qid}/pdf`, { token: A }); assert(String(r.body).includes('VAT 5%'));
  r = await call('POST', `/quotations/${qid}/convert`, { token: A }); assert.equal(r.status, 409);
  const share = q.get('SELECT share_token FROM quotations WHERE id=?', qid).share_token;
  r = await call('POST', `/public/quotations/${share}/accept`, {}); assert.equal(r.status, 200);
  r = await call('POST', `/quotations/${qid}/convert`, { token: OPS });
  assert.equal(r.status, 200, JSON.stringify(r.body)); console.log('✔ convert', r.body.sites, 'sites,', r.body.plans, 'plans,', r.body.jobs_generated, 'jobs, code', r.body.portal_code);
  const acct = r.body.customer_id;
  // capacity invariant
  const over = q.all(`SELECT v.fleet_number, p.scheduled_date, COUNT(*) c, v.max_daily_capacity cap FROM pickups p JOIN vehicles v ON v.id=p.vehicle_id WHERE p.status IN ('pending','collected','overdue') AND p.plan_id IS NOT NULL GROUP BY p.vehicle_id, p.scheduled_date HAVING c > cap`);
  console.log('  capacity violations by plan jobs:', over.length);
  const pest = q.get(`SELECT COUNT(*) c FROM pickups WHERE service_type='PEST_GENERAL'`).c;
  const unalloc = q.get(`SELECT COUNT(*) c FROM pickups WHERE service_type='PEST_GENERAL' AND vehicle_id IS NULL`).c;
  console.log('  pest jobs', pest, 'unallocated (no pest-tagged vehicle yet):', unalloc);
  // tag vehicle 2 for pest, regen
  await call('PUT', '/vehicles/2/tags', { token: A, body: { service_tags: ['waste', 'pest'] } });
  const plan = q.get(`SELECT * FROM service_plans WHERE service_code='PEST_GENERAL'`);
  r = await call('PUT', '/service-plans/' + plan.id, { token: A, body: { recurrence: { type: 'weekly', days: [1, 3] } } });
  console.log('  plan edit regen', r.body);
  assert.equal(q.get(`SELECT COUNT(*) c FROM pickups WHERE plan_id=? AND vehicle_id IS NULL AND status='pending'`, plan.id).c, 0);
  // ops blocked
  // (guard is middleware on the app; simulate)
  let blocked = false; v3.guard({ headers: { authorization: 'Bearer ' + OPS }, method: 'POST', path: '/payments', body: {} }, { status: () => ({ json: () => { blocked = true; } }), on() {} }, () => {});
  assert(blocked); console.log('✔ ops blocked from payments');
  // driver completes job with proof
  const job = q.get(`SELECT p.*, c.lat, c.lng, c.name FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.customer_id=? AND p.scheduled_date=? AND p.service_type='WASTE'`, acct, new Date().toISOString().slice(0, 10));
  const D = tok({ id: job.driver_id, role: 'driver', name: 'Drv' });
  const now = new Date().toISOString();
  r = await call('POST', `/pickups/${job.id}/complete`, { token: D, file: { filename: 'x.jpg', path: '/tmp/none' }, body: { lat: job.lat + 0.01, lng: job.lng, photo_taken_at: now, device_now: now, stamped: '1', stamp_text: job.name + ' | x', source: 'camera' } });
  assert.equal(r.status, 422); console.log('✔ far photo rejected:', r.body.problems);
  r = await call('POST', `/pickups/${job.id}/complete`, { token: D, file: { filename: 'x.jpg', path: '/tmp/none' }, body: { lat: job.lat, lng: job.lng, photo_taken_at: now, device_now: new Date(Date.now() - 9 * 60e3).toISOString(), stamped: '1', stamp_text: job.name, source: 'camera' } });
  assert.equal(r.status, 422); console.log('✔ clock skew rejected:', r.body.problems);
  r = await call('POST', `/pickups/${job.id}/complete`, { token: D, file: { filename: 'x.jpg', path: '/tmp/none' }, body: { lat: job.lat + 0.0005, lng: job.lng, photo_taken_at: now, device_now: now, stamped: '1', stamp_text: job.name + ' 25.0,55.1', source: 'camera', checklist: '["Bins emptied"]' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); console.log('✔ valid photo accepted at', r.body.distance_m, 'm');
  // not picked up on another job
  const today = new Date().toISOString().slice(0, 10);
  const job2 = q.get(`SELECT p.*, c.lat, c.lng, c.name FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.customer_id=? AND p.status='pending' AND p.scheduled_date>? AND p.plan_id!=? ORDER BY p.scheduled_date LIMIT 1`, acct, today, job.plan_id);
  q.run(`DELETE FROM pickups WHERE plan_id=? AND scheduled_date=? AND id!=? AND status='pending'`, job2.plan_id, today, job2.id);
  q.run(`UPDATE pickups SET scheduled_date=? WHERE id=?`, today, job2.id);
  const D2 = tok({ id: job2.driver_id, role: 'driver', name: 'Drv2' });
  r = await call('POST', `/pickups/${job2.id}/cancel`, { token: D2, file: { filename: 'y.jpg', path: '/tmp/none' }, body: { reason: 'CLOSED', lat: job2.lat, lng: job2.lng, photo_taken_at: now, device_now: now, stamped: '1', stamp_text: job2.name, source: 'camera' } });
  assert.equal(r.body.confirmation_status, 'awaiting', JSON.stringify(r.body));
  const C = tok({ id: acct, role: 'customer', customer_id: acct, name: 'Bayt' });
  r = await call('GET', '/customer/confirmations', { token: C }); assert.equal(r.body[0].confirmation_status, 'awaiting');
  r = await call('POST', `/pickups/${job2.id}/confirm`, { token: C, body: { action: 'dispute', note: 'We were open' } });
  console.log('✔ dispute →', r.body);
  // invoices
  r = await call('POST', '/invoices/generate', { token: A, body: { period: new Date().toISOString().slice(0, 7) } });
  const inv = r.body.invoices.find(i => q.get('SELECT customer_id FROM invoices WHERE id=?', i.id).customer_id === acct);
  console.log('✔ invoices created', r.body.created, 'acct invoice', inv);
  assert.equal(inv.amount, 147); // 140 + 5%
  r = await call('POST', '/payments', { token: A, body: { invoice_id: inv.id, amount: 200, method: 'cash' } }); assert.equal(r.status, 400);
  r = await call('POST', '/payments', { token: A, body: { invoice_id: inv.id, amount: 100, method: 'card' } }); assert.equal(r.body.balance, 47);
  r = await call('GET', '/customer/invoices', { token: C }); assert.equal(r.body.balance, 47); console.log('✔ payment → balance', r.body.rows[0].status_label);
  r = await call('GET', `/customers/${acct}/360`, { token: OPS }); console.log('✔ 360: sites', r.body.sites.length, 'plans', r.body.plans.length, 'risk', r.body.risk);
  r = await call('GET', '/pipeline/stats', { token: A }); console.log('✔ pipeline', r.body.by_stage, r.body.lead_to_customer_pct + '%');
  // OTP
  process.env.OTP_DEV = '1';   // v3.4.4: the code is shown on screen only when this is set on purpose
  r = await call('POST', '/auth/customer-otp/request', { body: { identifier: '050 123 4567' } });
  delete process.env.OTP_DEV;
  r = await call('POST', '/auth/customer-otp/verify', { body: { identifier: '0501234567', code: r.body.dev_code } });
  assert(r.body.token); console.log('✔ OTP login as', r.body.customer.name);
  r = await call('GET', '/customer/sites', { token: C }); assert.equal(r.body.sites.length, 2);
  r = await call('POST', '/customer/bookings', { token: C, body: { service_code: 'WASTE_BULK', date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) } });
  const bk = r.body.id; r = await call('POST', `/bookings/${bk}/decide`, { token: OPS, body: { approve: true } }); assert(r.body.ok);
  r = await call('POST', '/pickups/adhoc', { token: A, body: { customer_id: 1, date: '2020-01-01' } }); assert.equal(r.status, 400);
  r = await call('POST', '/pickups/adhoc', { token: A, body: { customer_id: 1, date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) } }); assert(r.body.ok, JSON.stringify(r.body));
  r = await call('POST', '/pickups/adhoc', { token: A, body: { customer_id: 1, date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) } }); assert.equal(r.status, 409);
  console.log('✔ bookings + ad-hoc validations');
  // auto-confirm
  const job3 = q.get(`SELECT id FROM pickups WHERE status='pending' LIMIT 1`).id;
  q.run(`UPDATE pickups SET status='canceled', confirmation_status='awaiting', confirm_deadline='2000-01-01' WHERE id=?`, job3);
  assert.equal(v3.autoConfirm(), 1); console.log('✔ auto-confirm after 24h');
  r = await call('GET', '/driver/jobs-v3', { token: D }); console.log('✔ driver jobs-v3', r.body.jobs.length, r.body.jobs[0] && r.body.jobs[0].maps_url);
  r = await call('GET', '/audit', { token: A }); console.log('✔ audit rows', r.body.length);
  console.log('ALL PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
