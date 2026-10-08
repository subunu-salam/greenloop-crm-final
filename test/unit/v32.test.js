// v3.2 — push broadcast, Gmail quotation workflow, invoice → customer app,
// fleet maintenance / expenses with payment proof, capacity moderation.
const { call, tok, db, v3, emitted, webpush } = require('./harness'); const { q } = db;
const mailer = require('../../server/mailer');
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const OPS = tok({ id: 9, role: 'admin', crm_role: 'ops', name: 'Ops' });
const results = []; const rec = (area, test, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + ' [' + area + '] ' + test + (detail !== undefined ? ' → ' + detail : '')); };
const today = new Date().toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sub = (name) => ({ endpoint: 'https://push.example/' + name, keys: { p256dh: 'k', auth: 'a' } });
const custTok = (id) => tok({ id, role: 'customer', customer_id: id, name: 'C' + id });
(async () => {
  const custs = q.all(`SELECT id FROM customers WHERE is_active=1 ORDER BY id LIMIT 4`).map(c => c.id);
  const drivers = q.all(`SELECT id, full_name, vehicle_id FROM users WHERE role='driver' AND is_active=1 ORDER BY id`);
  const D1 = tok({ id: drivers[0].id, role: 'driver', name: drivers[0].full_name, vehicle_id: drivers[0].vehicle_id });
  let r;

  // ───────── PUSH: registration ─────────
  r = await call('POST', '/push/subscribe', { body: { subscription: sub('x') } });
  rec('Push', 'Subscribing without signing in is refused', r.status === 401, r.status);
  r = await call('POST', '/push/subscribe', { token: custTok(custs[0]), body: { subscription: { endpoint: 'https://push.example/bad' } } });
  rec('Push', 'A subscription without keys is refused', r.status === 400, r.status);
  for (const [i, c] of custs.slice(0, 3).entries()) await call('POST', '/push/subscribe', { token: custTok(c), body: { subscription: sub('cust' + i) } });
  await call('POST', '/push/subscribe', { token: custTok(custs[0]), body: { subscription: sub('cust0-tablet') } });
  await call('POST', '/push/subscribe', { token: D1, body: { subscription: sub('drv0') } });
  r = await call('GET', '/push/status', { token: custTok(custs[0]) });
  rec('Push', 'A customer with phone + tablet has 2 registered devices', r.body.devices === 2, r.body.devices);
  // same phone, different customer signs in → device moves, old account no longer gets it
  await call('POST', '/push/subscribe', { token: custTok(custs[3]), body: { subscription: sub('cust2') } });
  const moved = q.get(`SELECT user_ref FROM push_subscriptions WHERE endpoint=?`, 'https://push.example/cust2').user_ref;
  rec('Push', 'Phone re-used by another customer moves to the new account', moved === String(custs[3]) && q.get(`SELECT COUNT(*) c FROM push_subscriptions WHERE endpoint=?`, 'https://push.example/cust2').c === 1, 'now ' + moved);

  // ───────── PUSH: admin-wide broadcast ─────────
  r = await call('POST', '/push/broadcast', { token: custTok(custs[0]), body: { audience: 'customers', title: 'x', body: 'y' } });
  rec('Push', 'A customer cannot send a broadcast', r.status === 403, r.status);
  r = await call('POST', '/push/broadcast', { token: A, body: { audience: 'customers', title: '', body: 'y' } });
  rec('Push', 'Broadcast without a title is refused', r.status === 400, r.body.error);
  r = await call('POST', '/push/broadcast', { token: A, body: { audience: 'everyone', title: 'a', body: 'b' } });
  rec('Push', 'Unknown audience is refused', r.status === 400, r.status);
  const accounts = q.get(`SELECT COUNT(*) c FROM customers WHERE is_active=1 AND (account_id IS NULL OR account_id=id)`).c;
  const inboxBefore = q.get(`SELECT COUNT(*) c FROM customer_notifications WHERE kind='announcement'`).c;
  webpush.sent.length = 0;
  r = await call('POST', '/push/broadcast', { token: A, body: { audience: 'customers', title: 'Eid schedule', body: 'No collections on 20/03/2026.' } });
  const custEndpoints = q.all(`SELECT endpoint FROM push_subscriptions WHERE role='customer'`).length;
  rec('Push', 'Broadcast reaches every signed-in customer device', r.status === 200 && r.body.delivered === custEndpoints && webpush.sent.length === custEndpoints, `${r.body.delivered}/${custEndpoints} devices`);
  rec('Push', 'Broadcast does not leak to driver devices', !webpush.sent.some(s => s.endpoint.includes('drv')), 'ok');
  rec('Push', 'Every customer account gets it in the in-app inbox (even without push)', q.get(`SELECT COUNT(*) c FROM customer_notifications WHERE kind='announcement'`).c - inboxBefore === accounts && r.body.recipients === accounts, `${accounts} accounts`);
  rec('Push', 'Payload carries title, body and an in-app link', webpush.sent[0].payload.title === 'Eid schedule' && webpush.sent[0].payload.url === '/customer/', webpush.sent[0].payload.url);
  rec('Push', 'Open apps are told live over the socket', emitted.includes('customer:' + custs[0] + '|customer:notify'), 'customer:notify');
  // dead + failing subscriptions
  q.run(`INSERT INTO push_subscriptions(role,user_ref,endpoint,p256dh,auth) VALUES ('customer',?,?,?,?)`, String(custs[1]), 'https://push.example/gone1', 'k', 'a');
  q.run(`INSERT INTO push_subscriptions(role,user_ref,endpoint,p256dh,auth) VALUES ('customer',?,?,?,?)`, String(custs[1]), 'https://push.example/boom1', 'k', 'a');
  r = await call('POST', '/push/broadcast', { token: A, body: { audience: 'customers', title: 'Second', body: 'msg' } });
  rec('Push', 'Expired device is removed, failing one is reported, the rest still deliver', r.body.removed === 1 && r.body.failed === 1 && r.body.delivered === custEndpoints && !q.get(`SELECT 1 x FROM push_subscriptions WHERE endpoint LIKE '%gone1'`), JSON.stringify({ delivered: r.body.delivered, failed: r.body.failed, removed: r.body.removed }));
  q.run(`DELETE FROM push_subscriptions WHERE endpoint LIKE '%boom1'`);
  webpush.sent.length = 0;
  r = await call('POST', '/push/broadcast', { token: OPS, body: { audience: 'all', title: 'Depot closed', body: 'Friday', url: 'https://evil.example/x' } });
  rec('Push', '"All" reaches customers and drivers', webpush.sent.some(s => s.endpoint.includes('drv0')) && webpush.sent.some(s => s.endpoint.includes('cust0')), webpush.sent.length + ' devices');
  rec('Push', 'External links are stripped from broadcasts', webpush.sent.every(s => s.payload.url.startsWith('/')), webpush.sent[0].payload.url);
  r = await call('GET', '/push/stats', { token: A });
  rec('Push', 'Stats show reach and broadcast history', r.body.customer.devices === custEndpoints && r.body.history.length === 3 && r.body.totals.customer_accounts === accounts, `${r.body.customer.users} customers / ${r.body.customer.devices} devices`);

  // multi-site: device registered on site B must get alerts addressed to the account (site A)
  const acct = custs[0];
  const siteB = Number(q.run(`INSERT INTO customers(name,branch,zone,frequency,lat,lng,account_id) VALUES ('Multi','B','Deira',2,25.2,55.3,?)`, acct).lastInsertRowid);
  q.run(`UPDATE customers SET account_id=? WHERE id=?`, acct, acct);
  await call('POST', '/push/subscribe', { token: custTok(siteB), body: { subscription: sub('siteB') } });
  webpush.sent.length = 0;
  await v3.notifyCustomer(acct, 'invoice', 'Invoice X', 'body', '/customer/#invoices');
  rec('Push', 'Account-level alert reaches a device signed in on another site', webpush.sent.some(s => s.endpoint.includes('siteB')) && webpush.sent.some(s => s.endpoint.includes('cust0')), webpush.sent.map(s => s.endpoint.split('/').pop()).join(','));
  r = await call('POST', '/push/test', { token: D1 });
  rec('Push', 'Test push goes to the caller\'s own device only', r.body.delivered === 1 && webpush.sent.at(-1).endpoint.includes('drv0'), r.body.delivered);

  // ───────── QUOTATION → GMAIL ─────────
  const mk = async (email) => {
    const l = await call('POST', '/leads', { token: A, body: { contact: 'Omar', company: 'Test Co', phone: '+971501112233', email, service_type: 'WASTE', source: 'website', sites: [{ name: 'HQ', zone: 'Deira', lat: 25.27, lng: 55.31 }] } });
    const qq = await call('POST', '/quotations', { token: A, body: { lead_id: l.body.id, items: [{ service_code: 'WASTE', qty: 8, unit_price: 100 }], plan: { recurrence: { type: 'weekly', days: [0, 3] }, time_window: '07:00-12:00', billing: 'monthly' } } });
    return { lead: l.body.id, quote: qq.body.id };
  };
  const noMail = await mk('');
  r = await call('POST', `/quotations/${noMail.quote}/send`, { token: A, body: {} });
  rec('Quotation', 'Gmail is the default channel; a lead without email gets a clear error', r.status === 400 && r.body.code === 'NO_EMAIL', r.body.error);
  rec('Quotation', 'A failed send leaves the quotation as draft', q.get(`SELECT status FROM quotations WHERE id=?`, noMail.quote).status === 'draft', 'draft');
  const withMail = await mk('omar@testco.ae');
  r = await call('POST', `/quotations/${withMail.quote}/send`, { token: A, body: { base_url: 'https://app.greenloop.ae' } });
  rec('Quotation', 'Without server Gmail credentials a pre-filled Gmail compose link is returned', r.status === 200 && r.body.delivery === 'compose' && r.body.gmail_compose_url.startsWith('https://mail.google.com/mail/?') && r.body.gmail_compose_url.includes('omar%40testco.ae'), r.body.delivery);
  let row = q.get(`SELECT status, sent_via, sent_to FROM quotations WHERE id=?`, withMail.quote);
  rec('Quotation', 'Quotation logged as sent via gmail to the lead\'s address', row.status === 'sent' && row.sent_via === 'gmail' && row.sent_to === 'omar@testco.ae', JSON.stringify(row));
  // real send path with a fake Gmail SMTP transport
  const realSend = mailer.send; const outbox = [];
  process.env.GMAIL_USER = 'sales@greenloop.ae'; process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  mailer.send = async (m) => { outbox.push(m); return { ok: true }; };
  const m2 = await mk('buyer@shop.ae');
  r = await call('POST', `/quotations/${m2.quote}/send`, { token: A, body: { base_url: 'https://app.greenloop.ae' } });
  rec('Quotation', 'With Gmail connected the email is sent by the server', r.body.delivery === 'sent' && outbox.length === 1 && outbox[0].to === 'buyer@shop.ae', r.body.delivery);
  rec('Quotation', 'Email has the accept / PDF link, total and DD/MM/YYYY validity', outbox[0].html.includes('https://app.greenloop.ae/q/') && outbox[0].subject.includes('AED 840.00') && /valid until \d{2}\/\d{2}\/\d{4}/.test(outbox[0].text), outbox[0].subject);
  mailer.send = async () => { const e = new Error('Gmail refused the message: quota'); e.status = 502; throw e; };
  const m3 = await mk('fail@shop.ae');
  r = await call('POST', `/quotations/${m3.quote}/send`, { token: A, body: {} });
  rec('Quotation', 'If Gmail rejects the email nothing is marked sent and a manual link is offered', r.status === 502 && q.get(`SELECT status FROM quotations WHERE id=?`, m3.quote).status === 'draft' && !!r.body.gmail_compose_url, r.body.error);
  const mime = mailer.buildMime({ to: 'a@b.ae', subject: 'Hello\r\nBcc: evil@x.com', text: 'x' });
  rec('Security', 'Email subject cannot inject extra headers', !/^Bcc:/m.test(mime), 'no Bcc header');
  rec('Quotation', 'Email address validation rejects junk', !mailer.isEmail('not-an-email') && !mailer.isEmail('a@b') && mailer.isEmail('a@b.ae'), 'ok');

  // STEP 2: accept → convert → registration (welcome email + app inbox)
  outbox.length = 0; mailer.send = async (m) => { outbox.push(m); return { ok: true }; };
  await call('POST', `/quotations/${m2.quote}/status`, { token: A, body: { status: 'accepted' } });
  r = await call('POST', `/quotations/${m2.quote}/convert`, { token: A });
  const newCust = r.body.customer_id;
  rec('Workflow', 'Converting an accepted quote registers the customer and emails app access', r.status === 200 && r.body.email.sent === true && outbox[0].to === 'buyer@shop.ae' && outbox[0].text.includes(r.body.portal_code), 'customer #' + newCust);
  rec('Workflow', 'New customer has a welcome message waiting in the app', !!q.get(`SELECT 1 x FROM customer_notifications WHERE customer_id=? AND kind='welcome'`, newCust), 'welcome');
  mailer.send = realSend; delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;

  // STEP 3: invoice → customer app (in-app + push), PDF only for the owner
  await call('POST', '/push/subscribe', { token: custTok(newCust), body: { subscription: sub('newcust') } });
  const job = q.get(`SELECT id, scheduled_date FROM pickups WHERE customer_id=? ORDER BY scheduled_date LIMIT 1`, newCust);
  q.run(`UPDATE pickups SET status='collected', completed_at=datetime('now') WHERE id=?`, job.id);
  webpush.sent.length = 0;
  r = await call('POST', '/invoices/generate', { token: A, body: { period: job.scheduled_date.slice(0, 7), customer_id: newCust } });
  const inv = r.body.invoices[0];
  rec('Invoice', 'Issuing an invoice pushes it to the customer app', r.body.created === 1 && webpush.sent.some(s => s.endpoint.includes('newcust') && s.payload.url === '/customer/#invoices'), inv && inv.number);
  rec('Invoice', 'Invoice is marked as sent to the app', !!q.get(`SELECT sent_at FROM invoices WHERE id=?`, inv.id).sent_at, 'sent_at set');
  r = await call('POST', `/invoices/${inv.id}/send`, { token: A });
  rec('Invoice', 'Resend reports push delivery and counts the resend', r.body.push.delivered === 1 && q.get(`SELECT sent_count FROM invoices WHERE id=?`, inv.id).sent_count === 2, JSON.stringify(r.body.push));
  r = await call('GET', '/customer/invoices', { token: custTok(newCust) });
  rec('Invoice', 'Customer sees the invoice in the app', r.body.rows.some(i => i.id === inv.id), r.body.rows.length + ' invoice(s)');
  r = await call('GET', `/invoices/${inv.id}/pdf`, { token: custTok(newCust) });
  rec('Invoice', 'Customer can open the invoice PDF; dates are DD/MM/YYYY', r.status === 200 && /Due: <b>\d{2}\/\d{2}\/\d{4}<\/b>/.test(String(r.body)), 'ok');
  r = await call('GET', `/invoices/${inv.id}/pdf`, { token: custTok(custs[2]) });
  rec('Security', 'Another customer cannot open that invoice', r.status === 403, r.status);
  r = await call('POST', `/invoices/${inv.id}/send`, { token: custTok(newCust) });
  rec('Security', 'A customer cannot trigger invoice sends', r.status === 403, r.status);

  // ───────── FLEET: driver vehicle reports ─────────
  const veh = q.get(`SELECT * FROM vehicles WHERE id=?`, drivers[0].vehicle_id);
  const F = (o) => ({ ...o, fieldname: 'x' });
  r = await call('POST', '/driver/vehicle-reports', { token: D1, body: { category: 'SPACESHIP' } });
  rec('Fleet', 'Unknown issue category is refused', r.status === 400, r.body.error);
  r = await call('POST', '/driver/vehicle-reports', { token: D1, body: { category: 'TIRE', odometer_km: '84210' } });
  rec('Fleet', 'Tyre damage needs a photo', r.status === 400, r.body.error);
  r = await call('POST', '/driver/vehicle-reports', { token: D1, body: { category: 'OIL', cost: '180' } });
  rec('Fleet', 'A paid amount without a receipt photo is refused (payment proof)', r.status === 400 && /receipt/i.test(r.body.error), r.body.error);
  r = await call('POST', '/driver/vehicle-reports', { token: D1, body: { category: 'OIL', odometer_km: '12.5' } });
  rec('Fleet', 'Odometer must be a whole number', r.status === 400, r.body.error);
  r = await call('POST', '/driver/vehicle-reports', { token: D1, body: { category: 'OIL', cost: '-5' }, files: { receipt: [F({ filename: 'fleet_r0.jpg', path: '/tmp/none' })] } });
  rec('Fleet', 'Negative amounts are refused', r.status === 400, r.body.error);
  const alertsBefore = q.get(`SELECT COUNT(*) c FROM alerts WHERE type='VEHICLE_ISSUE'`).c;
  r = await call('POST', '/driver/vehicle-reports', { token: D1, body: { category: 'TIRE', urgency: 'off_road', odometer_km: '84210', description: 'Rear left tyre burst on E11' }, files: { photo: [F({ filename: 'fleet_p1.jpg', path: '/tmp/none' })] } });
  const tire = r.body.report;
  rec('Fleet', 'Driver reports tyre damage on the assigned vehicle', r.status === 200 && tire.vehicle_id === veh.id && tire.status === 'open' && tire.photo_url === '/uploads/fleet_p1.jpg', `#${tire.id} ${tire.fleet_number}`);
  const al = q.get(`SELECT * FROM alerts WHERE type='VEHICLE_ISSUE' ORDER BY id DESC LIMIT 1`);
  rec('Fleet', 'Office gets a critical alert when the vehicle cannot drive', q.get(`SELECT COUNT(*) c FROM alerts WHERE type='VEHICLE_ISSUE'`).c === alertsBefore + 1 && al.severity === 'critical' && al.message.includes(veh.fleet_number), al.severity);
  r = await call('POST', '/driver/vehicle-reports', { token: D1, body: { category: 'OIL', odometer_km: '84300', cost: '185.50', payment_method: 'cash', description: 'Oil + filter' }, files: { receipt: [F({ filename: 'fleet_r1.jpg', path: '/tmp/none' })] } });
  const oil = r.body.report;
  rec('Fleet', 'Driver logs an oil change paid in cash with a receipt', r.status === 200 && oil.cost === 185.5 && oil.paid_by === 'driver' && oil.has_payment_proof && oil.reimbursement_due, `AED ${oil.cost}`);
  const D2 = tok({ id: drivers[1].id, role: 'driver', name: drivers[1].full_name, vehicle_id: drivers[1].vehicle_id });
  r = await call('GET', '/driver/vehicle-reports', { token: D2 });
  rec('Security', 'A driver on another truck does not see these reports', drivers[1].vehicle_id === veh.id || !r.body.rows.some(x => x.id === tire.id), r.body.rows.length + ' rows');
  r = await call('GET', '/fleet/maintenance', { token: custTok(custs[0]) });
  rec('Security', 'Customers cannot read fleet maintenance', r.status === 403, r.status);
  r = await call('PUT', `/fleet/maintenance/${tire.id}`, { token: D1, body: { status: 'resolved' } });
  rec('Security', 'Drivers cannot moderate their own reports', r.status === 403, r.status);

  // ───────── FLEET: admin moderation, service history, payment proof ─────────
  r = await call('GET', '/fleet/maintenance', { token: A });
  rec('Fleet', 'Admin dashboard lists the reports with open / off-road counts', r.body.summary.open === 2 && r.body.summary.off_road === 1 && r.body.rows.length === 2, JSON.stringify({ open: r.body.summary.open, off_road: r.body.summary.off_road }));
  rec('Fleet', 'Dashboard shows the driver reimbursement due', r.body.summary.reimbursement_due === 185.5, 'AED ' + r.body.summary.reimbursement_due);
  r = await call('PUT', `/fleet/maintenance/${tire.id}`, { token: A, body: { status: 'rejected' } });
  rec('Fleet', 'Rejecting needs a note for the driver', r.status === 400, r.body.error);
  r = await call('PUT', `/fleet/maintenance/${tire.id}`, { token: A, body: { status: 'resolved', service_date: addDays(3) } });
  rec('Fleet', 'A service date in the future is refused', r.status === 400, r.body.error);
  webpush.sent.length = 0;
  r = await call('PUT', `/fleet/maintenance/${tire.id}`, { token: OPS, body: { status: 'in_progress', vendor: 'Al Quoz Tyres', admin_note: 'Recovery truck sent' } });
  rec('Fleet', 'Status change pushes a notification to the reporting driver', r.status === 200 && webpush.sent.some(s => s.endpoint.includes('drv0') && /worked on/.test(s.payload.title)), webpush.sent[0] && webpush.sent[0].payload.title);
  r = await call('PUT', `/fleet/maintenance/${tire.id}`, { token: A, body: { status: 'resolved', cost: 420, payment_method: 'card', payment_ref: 'POS-88213', work_done: '1 new tyre fitted', service_date: today } });
  rec('Fleet', 'Resolved with cost but no receipt is flagged "proof missing"', r.body.report.status === 'resolved' && r.body.report.proof_missing === true && r.body.report.paid_by === 'company', 'proof_missing');
  r = await call('POST', `/fleet/maintenance/${tire.id}/proof`, { token: A, body: {} });
  rec('Fleet', 'Uploading proof without a file is refused', r.status === 400, r.body.error);
  r = await call('POST', `/fleet/maintenance/${tire.id}/proof`, { token: A, body: {}, files: { receipt: [F({ filename: 'fleet_r2.jpg', path: '/tmp/none' })] } });
  rec('Fleet', 'Admin attaches the payment proof afterwards', r.body.report.has_payment_proof && !r.body.report.proof_missing && r.body.report.receipt_url === '/uploads/fleet_r2.jpg', r.body.report.receipt_url);
  r = await call('PUT', `/fleet/maintenance/${oil.id}`, { token: OPS, body: { reimbursed: true } });
  rec('Security', 'Ops staff cannot mark a reimbursement as paid', r.status === 403, r.status);
  r = await call('PUT', `/fleet/maintenance/${oil.id}`, { token: A, body: { status: 'resolved', reimbursed: true, next_due_km: 89300, next_due_date: addDays(90) } });
  rec('Fleet', 'Owner resolves the oil change, reimburses the driver and sets the next due', r.body.report.reimbursed === 1 && !r.body.report.reimbursement_due && r.body.report.next_due_km === 89300, 'next ' + r.body.report.next_due_km + ' km');
  r = await call('POST', '/fleet/maintenance', { token: A, body: { vehicle_id: veh.id, category: 'SERVICE', cost: '950', vendor: 'Al Futtaim', service_date: addDays(-200), next_due_date: addDays(-10), odometer_km: 70000 } });
  rec('Fleet', 'Office can log a past workshop service directly', r.status === 200 && r.body.report.source === 'office' && r.body.report.status === 'resolved', '#' + r.body.report.id);
  r = await call('GET', `/fleet/maintenance/vehicle/${veh.id}`, { token: A });
  const sm = r.body.summary;
  rec('Fleet', 'Vehicle service history lists every record, newest first', r.body.history.length === 3 && r.body.history[r.body.history.length - 1].category === 'SERVICE', r.body.history.map(x => x.category).join(' › '));
  rec('Fleet', 'History totals spend and tracks last oil change + odometer', sm.spend_total === 1555.5 && sm.last_oil_change && sm.last_oil_change.odometer_km === 84300 && sm.last_odometer_km === 84300, `AED ${sm.spend_total}, odo ${sm.last_odometer_km}`);
  rec('Fleet', 'Overdue periodic service is flagged', sm.next_due.some(d => d.category === 'SERVICE' && d.state === 'overdue') && sm.next_due.some(d => d.category === 'OIL' && d.state === 'ok'), sm.next_due.map(d => d.category + ':' + d.state).join(', '));
  rec('Fleet', 'Vehicle is back on the road once the off-road report is resolved', sm.off_road === false, 'off_road=false');
  r = await call('GET', '/fleet/maintenance?status=active', { token: A });
  rec('Fleet', 'Filter "active" hides resolved reports', r.body.rows.length === 0, r.body.rows.length);

  // ───────── CAPACITY MODERATION ─────────
  const day = addDays(3);
  r = await call('GET', '/fleet/load?days=7', { token: A });
  const before = r.body.find(x => x.vehicle.id === veh.id).days.find(d => d.date === day);
  rec('Capacity', 'Without an override the day uses the vehicle default', before.capacity === veh.max_daily_capacity && before.override === null, `${before.load}/${before.capacity}`);
  r = await call('PUT', '/fleet/capacity/override', { token: A, body: { vehicle_id: veh.id, date: day, capacity: 61, reason: 'x' } });
  rec('Capacity', 'Capacity above 60 is refused', r.status === 400, r.body.error);
  r = await call('PUT', '/fleet/capacity/override', { token: A, body: { vehicle_id: veh.id, date: day, capacity: 3.5, reason: 'x' } });
  rec('Capacity', 'Fractional capacity is refused', r.status === 400, r.status);
  r = await call('PUT', '/fleet/capacity/override', { token: A, body: { vehicle_id: veh.id, date: addDays(-1), capacity: 5, reason: 'x' } });
  rec('Capacity', 'Past days cannot be changed', r.status === 400, r.body.error);
  r = await call('PUT', '/fleet/capacity/override', { token: A, body: { vehicle_id: veh.id, date: day, capacity: 0 } });
  rec('Capacity', 'An override needs a reason', r.status === 400, r.body.error);
  r = await call('PUT', '/fleet/capacity/override', { token: OPS, body: { vehicle_id: veh.id, date: day, capacity: 0, reason: 'Tyre replacement at workshop' } });
  rec('Capacity', 'Ops can close a truck for a day; overload is reported', r.status === 200 && r.body.capacity === 0 && r.body.over_by === r.body.load, `load ${r.body.load}, over by ${r.body.over_by}`);
  r = await call('GET', '/fleet/load?days=7', { token: A });
  const after = r.body.find(x => x.vehicle.id === veh.id).days.find(d => d.date === day);
  rec('Capacity', 'Fleet tracker shows the override and its reason', after.capacity === 0 && after.override && after.override.reason.includes('Tyre') && after.default_capacity === veh.max_daily_capacity, `${after.load}/${after.capacity}`);
  const cust = q.get(`SELECT * FROM customers WHERE zone=? AND is_active=1 LIMIT 1`, veh.zone);
  const alloc = v3.allocate(cust, day, 'WASTE');
  rec('Capacity', 'Auto-allocation skips the closed truck that day', !alloc.vehicle || alloc.vehicle.id !== veh.id, alloc.vehicle ? alloc.vehicle.fleet_number : 'unallocated');
  r = await call('POST', '/pickups/adhoc', { token: A, body: { customer_id: cust.id, date: day, vehicle_id: veh.id, service_code: 'PEST_GENERAL' } });
  rec('Capacity', 'Manual ad-hoc order onto the closed truck is refused', r.status === 409, r.body.error);
  r = await call('DELETE', '/fleet/capacity/override', { token: A, body: { vehicle_id: veh.id, date: day } });
  r = await call('GET', '/fleet/load?days=7', { token: A });
  rec('Capacity', 'Removing the override restores the default', r.body.find(x => x.vehicle.id === veh.id).days.find(d => d.date === day).capacity === veh.max_daily_capacity, 'restored');
  r = await call('PUT', '/fleet/capacity/default', { token: OPS, body: { vehicle_id: veh.id, capacity: 18 } });
  rec('Security', 'Only the owner can change a vehicle\'s default capacity', r.status === 403, r.status);
  r = await call('PUT', '/fleet/capacity/default', { token: A, body: { vehicle_id: veh.id, capacity: 0 } });
  rec('Capacity', 'Default capacity of 0 is refused (use a day override or park the vehicle)', r.status === 400, r.body.error);
  r = await call('PUT', '/fleet/capacity/default', { token: A, body: { vehicle_id: veh.id, capacity: 18 } });
  rec('Capacity', 'Owner changes the default from 15 to 18', r.status === 200 && q.get(`SELECT max_daily_capacity c FROM vehicles WHERE id=?`, veh.id).c === 18, `${r.body.previous} → ${r.body.capacity}`);
  // the engine returns only its top 3 slots, so moderate the whole 7-day horizon to make the check deterministic
  for (let i = 1; i <= 7; i++) await call('PUT', '/fleet/capacity/override', { token: A, body: { vehicle_id: veh.id, date: addDays(i), capacity: 22, reason: 'Extra helper on board' } });
  const opt = require('../../server/services/rescheduler');
  const pend = Number(q.run(`INSERT INTO pickups(customer_id,vehicle_id,scheduled_date,status,anomaly_reason) VALUES (?,?,?,'canceled','CLOSED')`, cust.id, veh.id, today).lastInsertRowid);
  const mine = (opt.recommend(pend).options || []).filter(x => x.vehicle_id === veh.id);
  rec('Capacity', 'Rescheduling engine uses the day\'s moderated capacity', mine.length > 0 && mine.every(x => x.capacity === 22), mine.map(x => x.capacity).join(',') || 'no option');
  rec('Format', 'Dates render as DD/MM/YYYY', v3.dmy('2026-10-05') === '05/10/2026' && v3.dmy('2026-03-07T10:00:00Z') === '07/03/2026', v3.dmy('2026-10-05'));

  const failed = results.filter(x => !x).length;
  console.log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL', e.stack); process.exit(1); });
