// v3.8 — visit ratings, busy periods, weekly email (server/engage.js)
const { call, tok, emitted } = require('./harness');
const { q, getSetting, setSetting } = require('../../server/db');
const growth = require('../../server/growth');
const engage = require('../../server/engage');
const mailer = require('../../server/mailer');

const results = [];
const rec = (area, name, ok, note = '') => { results.push({ area, name, ok: !!ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${note ? ' → ' + note : ''}`); };
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const OPS = tok({ id: 1, role: 'admin', crm_role: 'ops', name: 'Ops' });
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const today = ymd();

(async () => {
  const [c1, c2, c3] = q.all(`SELECT * FROM customers WHERE is_active=1 ORDER BY id LIMIT 3`);
  const C1 = tok({ id: c1.id, role: 'customer', customer_id: c1.id, name: c1.name });
  const C2 = tok({ id: c2.id, role: 'customer', customer_id: c2.id, name: c2.name });
  const drv = q.get(`SELECT id FROM users WHERE role='driver' ORDER BY id LIMIT 1`).id;
  const job = (cid, date, status) => Number(q.run(`INSERT INTO pickups(customer_id,driver_id,scheduled_date,status,completed_at) VALUES (?,?,?,?,?)`,
    cid, drv, date, status, status === 'collected' ? date + 'T08:30:00.000Z' : null).lastInsertRowid);

  // ══ RATINGS ══
  const v1 = job(c1.id, addDays(today, -1), 'collected');
  let r = await call('GET', '/customer/ratings/pending', { token: C1 });
  rec('Ratings', 'The latest unrated visit is offered for rating', r.body.visit && r.body.visit.id === v1);
  r = await call('POST', `/customer/visits/${v1}/rate`, { token: C1, body: { stars: 5, comment: 'Quick and clean' } });
  rec('Ratings', 'Customer rates a completed visit 1 to 5 with a comment', r.status === 200 && q.get(`SELECT stars FROM visit_ratings WHERE pickup_id=?`, v1).stars === 5);
  rec('Ratings', 'A visit can only be rated once', (await call('POST', `/customer/visits/${v1}/rate`, { token: C1, body: { stars: 4 } })).status === 409);
  rec('Ratings', 'Nothing left to rate after that', (await call('GET', '/customer/ratings/pending', { token: C1 })).body.visit === null);
  rec('Ratings', 'Stars must be 1 to 5', (await call('POST', `/customer/visits/${job(c1.id, today, 'collected')}/rate`, { token: C1, body: { stars: 7 } })).status === 400);
  rec('Ratings', 'A visit that is not done yet cannot be rated', (await call('POST', `/customer/visits/${job(c1.id, addDays(today, 2), 'pending')}/rate`, { token: C1, body: { stars: 3 } })).status === 409);
  rec('Ratings', 'A customer cannot rate someone else\'s visit', (await call('POST', `/customer/visits/${job(c1.id, today, 'collected')}/rate`, { token: C2, body: { stars: 1 } })).status === 404);
  rec('Ratings', 'Visits older than 30 days cannot be rated', (await call('POST', `/customer/visits/${job(c1.id, addDays(today, -40), 'collected')}/rate`, { token: C1, body: { stars: 5 } })).status === 409);

  const healthBefore = growth.scoreCustomer(c2).score;
  const v2 = job(c2.id, addDays(today, -2), 'collected');
  const alertsBefore = q.get(`SELECT COUNT(*) n FROM alerts WHERE type='RATING'`).n;
  r = await call('POST', `/customer/visits/${v2}/rate`, { token: C2, body: { stars: 1, comment: 'Bins left half full' } });
  rec('Ratings', 'A 1-2 star rating alerts the office straight away', r.body.low && q.get(`SELECT COUNT(*) n FROM alerts WHERE type='RATING'`).n === alertsBefore + 1 && emitted.includes('staff|ratings:changed'));
  const after = growth.scoreCustomer(c2);
  rec('Ratings', 'A low rating lowers the customer\'s health score, with the reason', after.score < healthBefore && after.reasons.some(x => /low visit rating/.test(x)), `${healthBefore} → ${after.score}`);
  r = await call('GET', '/customer/visits', { token: C2 });
  rec('Ratings', 'Stars show in the visit history', r.body.rows.find(x => x.id === v2).stars === 1);

  r = await call('GET', '/ratings?filter=todo', { token: OPS });
  rec('Ratings', 'Office sees low ratings to follow up first', r.status === 200 && r.body.rows[0].pickup_id === v2 && r.body.summary.to_follow_up === 1);
  rec('Ratings', 'Driver performance: average stars per driver', r.body.drivers.length >= 1 && r.body.drivers[0].avg != null, r.body.drivers.map(d => `${d.name} ${d.avg}★ (${d.n})`).join(', '));
  rec('Ratings', 'Summary gives average and share of happy customers', r.body.summary.all.avg === 3 && r.body.summary.all.happy_pct === 50, JSON.stringify(r.body.summary.all));
  await call('POST', `/ratings/${r.body.rows[0].id}/follow-up`, { token: OPS, body: { note: 'Called, apologised' } });
  rec('Ratings', 'Marking a low rating as followed up clears it from the to-do list', (await call('GET', '/ratings?filter=todo', { token: OPS })).body.rows.length === 0);
  rec('Ratings', 'Drivers cannot see ratings', (await call('GET', '/ratings', { token: tok({ id: drv, role: 'driver' }) })).status === 403);

  // ══ BUSY PERIODS ══
  const start = addDays(localToday(), 10), end = addDays(start, 13);
  r = await call('GET', '/customer/events/options', { token: C1 });
  rec('Events', 'Customer gets event types, levels, suggested UAE dates and the price per visit', r.body.kinds.length === 7 && r.body.levels.length === 2 && r.body.suggested.ramadan && r.body.price_per_visit === 150);
  job(c1.id, addDays(start, 2), 'pending');                       // a regular visit already in the period
  r = await call('POST', '/customer/events/preview', { token: C1, body: { kind: 'ramadan', level: 'much_more', start_date: start, end_date: end } });
  rec('Events', 'Preview: 2 extra visits a week over 2 weeks = 4, with the cost before VAT', r.status === 200 && r.body.dates.length === 4 && r.body.est_total === 600, r.body.dates.join(', '));
  rec('Events', 'Extra visits avoid days that already have a visit', !r.body.dates.includes(addDays(start, 2)));
  const before = q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=?`, c1.id).n;
  rec('Events', 'Preview does not create anything', q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=?`, c1.id).n === before);
  r = await call('POST', '/customer/events', { token: C1, body: { kind: 'ramadan', level: 'much_more', start_date: start, end_date: end } });
  const evId = r.body.id;
  const created = q.all(`SELECT * FROM pickups WHERE customer_id=? AND notes LIKE 'Extra visit: Ramadan%'`, c1.id);
  rec('Events', 'Confirming plans the extra visits automatically on vehicles', r.status === 200 && r.body.created === 4 && created.length === 4 && created.every(p => p.status === 'pending' && p.billable === 1 && p.vehicle_id), `${created.filter(p => p.vehicle_id).length} of 4 on a vehicle`);
  rec('Events', 'The office is alerted', q.get(`SELECT COUNT(*) n FROM alerts WHERE type='EVENT'`).n === 1);
  rec('Events', 'UAE holidays are skipped', (() => {
    const hol = new Set(JSON.parse(getSetting('uae_holidays', '[]')));
    const d0 = [...hol].find(d => d > addDays(localToday(), 1));
    if (!d0) return true;
    return !engage.planEventDates(c3.id, d0, d0, 2).includes(d0);
  })());
  rec('Events', 'Dates in the past are refused', (await call('POST', '/customer/events/preview', { token: C1, body: { kind: 'sale', level: 'more', start_date: today, end_date: addDays(today, 3) } })).status === 400);
  rec('Events', 'Periods longer than 45 days are refused', (await call('POST', '/customer/events/preview', { token: C1, body: { kind: 'sale', level: 'more', start_date: start, end_date: addDays(start, 60) } })).status === 400);
  rec('Events', 'Unknown event types are refused', (await call('POST', '/customer/events/preview', { token: C1, body: { kind: 'party', level: 'more', start_date: start, end_date: end } })).status === 400);
  r = await call('GET', '/customer/events', { token: C1 });
  rec('Events', 'Customer sees the busy period with its visit dates and estimated cost', r.body.length === 1 && r.body[0].visits.length === 4 && r.body[0].est_total === 600);
  r = await call('GET', '/events', { token: OPS });
  rec('Events', 'Office sees active busy periods and extra visits', r.body.summary.active === 1 && r.body.summary.extra_visits === 4);
  rec('Events', 'Another customer cannot cancel it', (await call('DELETE', `/customer/events/${evId}`, { token: C2 })).status === 404);
  r = await call('DELETE', `/customer/events/${evId}`, { token: C1 });
  rec('Events', 'Cancelling removes the extra visits that have not happened yet', r.body.removed === 4 && q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=? AND notes LIKE 'Extra visit: Ramadan%'`, c1.id).n === 0);
  r = await call('POST', '/events', { token: OPS, body: { customer_id: c3.id, kind: 'sale', label: 'Summer clearance', level: 'more', start_date: start, end_date: addDays(start, 6) } });
  rec('Events', 'Office can plan a busy period for a customer, who is notified', r.status === 200 && r.body.created === 1 && r.body.label === 'Summer clearance' &&
    q.get(`SELECT COUNT(*) n FROM customer_notifications WHERE customer_id=? AND kind='event'`, c3.id).n === 1);

  // ══ WEEKLY EMAIL ══
  q.run(`UPDATE customers SET email='manager@example.ae' WHERE id=?`, c1.id);
  for (let k = 1; k <= 3; k++) job(c1.id, addDays(localToday(), -k - 1), 'collected');
  job(c1.id, addDays(localToday(), 3), 'pending');
  const m = engage.weeklyEmail(c1.id);
  rec('Email', 'Summary counts last week\'s pickups and shows the next pickup', m.summary.done >= 3 && m.summary.next && /pickups done/.test(m.subject), m.subject);
  rec('Email', 'Email has a plain-text and an HTML version', /Hello/.test(m.text) && /<html/.test(m.html) && /Next pickup/.test(m.text));
  r = await call('GET', `/weekly-email/preview/${c1.id}`, { token: OPS });
  rec('Email', 'Office can preview any customer\'s email', r.status === 200 && r.body.to === 'manager@example.ae' && /<html/.test(r.body.html));
  r = await call('GET', '/weekly-email', { token: OPS });
  rec('Email', 'Status shows who will get it and who has no email address', r.body.accounts.eligible >= 1 && r.body.accounts.no_email > 0 && r.body.mail.configured === false);
  r = await call('POST', '/weekly-email/send-now', { token: A });
  rec('Email', 'Without email set up nothing is sent and the office is warned', r.body.sent === 0 && q.get(`SELECT COUNT(*) n FROM weekly_email_log WHERE status='skipped'`).n >= 1 && q.get(`SELECT COUNT(*) n FROM alerts WHERE type='MAIL'`).n === 1);
  // pretend email is connected
  const sentMail = [];
  const origSend = mailer.send, origStatus = mailer.status;
  mailer.status = () => ({ configured: true, mode: 'test' });
  mailer.send = async (msg) => { sentMail.push(msg); return { ok: true }; };
  r = await call('POST', '/weekly-email/send-now', { token: A });
  rec('Email', 'With email connected every eligible account gets one email', r.body.sent === r.body.accounts && sentMail[0].to === 'manager@example.ae', `${r.body.sent} sent`);
  const n1 = sentMail.length;
  await engage.sendWeekly();
  rec('Email', 'The same week is never sent twice', sentMail.length === n1);
  r = await call('PUT', '/customer/weekly-email', { token: C1, body: { enabled: false } });
  rec('Email', 'Customer can switch the weekly email off in the app', (await call('GET', '/customer/weekly-email', { token: C1 })).body.enabled === false && q.get(`SELECT weekly_email FROM customers WHERE id=?`, c1.id).weekly_email === 0);
  setSetting('weekly_email_last', '');
  q.run(`DELETE FROM weekly_email_log`);
  sentMail.length = 0;
  await engage.sendWeekly();
  rec('Email', 'Customers who switched it off are skipped', !sentMail.some(x => x.to === 'manager@example.ae'));
  r = await call('POST', '/weekly-email/test', { token: A, body: { customer_id: c1.id, to: 'me@example.ae' } });
  rec('Email', 'Owner can send a test email to any address', r.status === 200 && sentMail.some(x => x.to === 'me@example.ae' && /^\[Test\]/.test(x.subject)));
  rec('Email', 'Ops staff cannot send emails', (await call('POST', '/weekly-email/send-now', { token: OPS })).status === 403);
  mailer.send = origSend; mailer.status = origStatus;

  // ══ DEMO ══
  r = await call('POST', '/growth/demo', { token: A });
  const dr = q.get(`SELECT COUNT(*) n, SUM(stars<=2) low FROM visit_ratings WHERE is_demo=1`);
  const de = q.get(`SELECT COUNT(*) n FROM waste_events WHERE is_demo=1`).n;
  rec('Demo', 'Demo data adds ratings (some low) and busy periods', r.status === 200 && dr.n > 20 && dr.low >= 2 && de === 3, `${dr.n} ratings, ${de} busy periods`);
  await call('DELETE', '/growth/demo', { token: A });
  rec('Demo', 'Remove demo data takes them out again, real ones stay', !q.get(`SELECT id FROM visit_ratings WHERE is_demo=1`) && !q.get(`SELECT id FROM waste_events WHERE is_demo=1`) && q.get(`SELECT COUNT(*) n FROM visit_ratings`).n >= 2);

  const failed = results.filter(x => !x.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
