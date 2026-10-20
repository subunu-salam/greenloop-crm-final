// v3.7 — customer issues, visit history, health follow-up, zero-cost rewards (server/care.js, server/growth.js)
const { call, tok, emitted } = require('./harness');
const { prisma } = require('../../server/db');
const one = (model, where, select) => prisma[model].findFirst({ where, ...(select ? { select } : {}), orderBy: { id: 'asc' } });
const count = (model, where) => prisma[model].count({ where });
const growth = require('../../server/growth');
const care = require('../../server/care');

const results = [];
const rec = (area, name, ok, note = '') => { results.push({ area, name, ok: !!ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${note ? ' → ' + note : ''}`); };
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const OPS = tok({ id: 1, role: 'admin', crm_role: 'ops', name: 'Ops' });
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const today = ymd();

(async () => {
  await require('./harness').ready;
  const [c1, c2, c3, c4] = await prisma.customer.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' }, take: 4 });
  const C1 = tok({ id: c1.id, role: 'customer', customer_id: c1.id, name: c1.name });
  const C2 = tok({ id: c2.id, role: 'customer', customer_id: c2.id, name: c2.name });
  const D = tok({ id: 2, role: 'driver', vehicle_id: 1, name: 'Driver' });
  const job = async (cid, date, status, extra = {}) => (await prisma.pickup.create({ data: { customer_id: cid, scheduled_date: date, status, confirmation_status: extra.conf || null,
    anomaly_reason: extra.reason || null, notes: extra.notes || null, segregation_rating: extra.rating || null, completed_at: status === 'collected' ? date + 'T08:30:00.000Z' : null } })).id;

  // ══ VISIT HISTORY ══
  await job(c1.id, addDays(today, -3), 'collected', { rating: 'good' });
  await job(c1.id, addDays(today, -6), 'overdue');
  await job(c1.id, addDays(today, -9), 'pending');
  await job(c1.id, addDays(today, -12), 'canceled', { conf: 'awaiting', reason: 'NO_ACCESS' });
  await job(c1.id, addDays(today, -15), 'canceled', { conf: 'confirmed', reason: 'CLOSED' });
  await job(c1.id, addDays(today, -18), 'canceled', { conf: 'auto_confirmed', reason: 'NO_WASTE' });
  await job(c1.id, addDays(today, -21), 'canceled', { conf: 'disputed', reason: 'CLOSED' });
  await job(c1.id, addDays(today, -24), 'rescheduled', { notes: ' → moved to ' + addDays(today, -23) });
  await job(c1.id, addDays(today, 4), 'pending');
  let r = await call('GET', '/customer/visits', { token: C1 });
  const s = r.body.summary;
  rec('History', 'Every visit lands in the right group', r.status === 200 && s.completed >= 1 && s.missed === 2 && s.awaiting === 1 && s.cancelled === 2 && s.disputed === 1 && s.rescheduled === 1 && s.upcoming >= 1, JSON.stringify(s));
  const moved = r.body.rows.find(x => x.category === 'rescheduled');
  rec('History', 'Rescheduled visits say where they moved to', /Moved to \d{2}\/\d{2}\/\d{4}/.test(moved.detail), moved.detail);
  rec('History', 'Not-picked-up visits give the reason in plain words', r.body.rows.find(x => x.category === 'cancelled').detail === 'Site was closed' || r.body.rows.some(x => x.detail === 'No waste to collect'));
  rec('History', 'A reliability figure is given (completed out of visits due)', r.body.reliability != null && r.body.reliability >= 0 && r.body.reliability <= 100, `${r.body.reliability}%`);
  r = await call('GET', '/customer/visits?category=missed', { token: C1 });
  rec('History', 'Filter by group', r.body.rows.length === 2 && r.body.rows.every(x => x.category === 'missed'));
  r = await call('GET', '/customer/visits', { token: C2 });
  rec('History', 'A customer only sees their own visits', r.body.rows.every(x => x.site_id === c2.id));
  r = await call('GET', `/customers/${c1.id}/visits`, { token: OPS });
  rec('History', 'Office sees the same history for any customer', r.status === 200 && r.body.summary.missed === 2);

  // ══ ISSUES ══
  r = await call('GET', '/customer/issues/options', { token: C1 });
  rec('Issues', 'Customer gets the issue types and the response time for their tier', r.status === 200 && r.body.categories.length === 7 && r.body.response_h === 24);
  const missedVisit = (await one('pickup', { customer_id: c1.id, status: 'overdue' })).id;
  const healthBefore = (await growth.scoreCustomer(c1)).score;
  r = await call('POST', '/customer/issues', { token: C1, body: { category: 'missed_pickup', description: 'Nobody came on Tuesday', pickup_id: missedVisit } });
  const issueId = r.body.id;
  const iss = await one('customerIssue', { id: issueId });
  rec('Issues', 'Customer reports an issue on a visit; missed pickups are high priority', r.status === 200 && iss.pickup_id === missedVisit && iss.priority === 'high' && iss.status === 'open');
  rec('Issues', 'The office is alerted live', emitted.includes('staff|issues:changed') && await count('alert', { type: 'ISSUE' }) === 1);
  const healthAfter = await growth.scoreCustomer(c1);
  rec('Issues', 'An open issue lowers the customer\'s health score', healthAfter.score < healthBefore && healthAfter.reasons.some(x => /open issue/.test(x)), `${healthBefore} → ${healthAfter.score}`);
  rec('Issues', 'Too-short descriptions are refused', (await call('POST', '/customer/issues', { token: C1, body: { category: 'other', description: 'bad' } })).status === 400);
  rec('Issues', 'Unknown issue types are refused', (await call('POST', '/customer/issues', { token: C1, body: { category: 'aliens', description: 'Something happened here' } })).status === 400);
  const otherVisit = await job(c2.id, addDays(today, -2), 'collected');
  rec('Issues', 'A customer cannot attach someone else\'s visit', (await call('POST', '/customer/issues', { token: C1, body: { category: 'mess', description: 'Mess left at the gate', pickup_id: otherVisit } })).status === 404);
  rec('Issues', 'A bad photo is refused', (await call('POST', '/customer/issues', { token: C1, body: { category: 'bin', description: 'Bin lid broken', image: 'data:text/plain;base64,AAAA' } })).status === 400);

  r = await call('GET', '/issues?status=active', { token: OPS });
  rec('Issues', 'Office sees open issues with summary counts', r.status === 200 && r.body.rows[0].id === issueId && r.body.summary.open === 1, JSON.stringify(r.body.summary));
  r = await call('POST', `/issues/${issueId}/reply`, { token: OPS, body: { body: 'Sorry, the truck broke down. Extra pickup booked for Thursday.' } });
  const after = await one('customerIssue', { id: issueId });
  rec('Issues', 'First reply moves it to In progress and records the response time', r.status === 200 && after.status === 'in_progress' && after.first_response_at && after.assigned_to === 'Ops');
  rec('Issues', 'The customer is notified of the reply', await count('customerNotification', { customer_id: c1.id, kind: 'issue' }) === 1);
  r = await call('POST', `/issues/${issueId}/reply`, { token: OPS, body: { body: 'Done, thank you for your patience.', status: 'resolved' } });
  rec('Issues', 'Office resolves the issue', (await one('customerIssue', { id: issueId })).status === 'resolved');
  r = await call('GET', '/customer/issues', { token: C1 });
  rec('Issues', 'Customer sees the whole conversation', r.body[0].messages.length === 3 && r.body[0].messages[1].author_role === 'staff', `${r.body[0].messages.length} messages`);
  r = await call('POST', `/customer/issues/${issueId}/messages`, { token: C1, body: { body: 'It happened again today.' } });
  rec('Issues', 'A customer reply reopens a resolved issue', r.body.reopened && (await one('customerIssue', { id: issueId })).status === 'open');
  rec('Issues', 'Another customer cannot reply on it', (await call('POST', `/customer/issues/${issueId}/messages`, { token: C2, body: { body: 'hi' } })).status === 404);
  rec('Issues', 'Drivers cannot see issues', (await call('GET', '/issues', { token: D })).status === 403);
  // overdue: past the response target with no reply
  await prisma.customerIssue.update({ where: { id: issueId }, data: { due_at: new Date(Date.now() - 3600e3).toISOString(), first_response_at: null, status: 'open' } });
  rec('Issues', 'Issues past their response target are flagged overdue', (await call('GET', '/issues', { token: OPS })).body.summary.overdue === 1);

  // ══ HEALTH FOLLOW-UP ══
  await growth.recalcHealth({ notify: false });
  r = await call('POST', `/health-scores/${c3.id}/contact`, { token: OPS, body: { method: 'call', contact_status: 'follow_up', note: 'Call back Thursday' } });
  rec('Follow-up', 'A follow-up needs a date', r.status === 400);
  r = await call('POST', `/health-scores/${c3.id}/contact`, { token: OPS, body: { method: 'whatsapp', contact_status: 'follow_up', follow_up_at: today, note: 'Waiting for manager' } });
  const hs = await prisma.healthScore.findUnique({ where: { customer_id: c3.id } });
  rec('Follow-up', 'Logging a contact sets status, date and note on the account', r.status === 200 && hs.contact_status === 'follow_up' && hs.follow_up_at === today && hs.contact_note === 'Waiting for manager');
  await call('POST', `/health-scores/${c3.id}/contact`, { token: OPS, body: { method: 'call', contact_status: 'resolved', note: 'Sorted' } });
  r = await call('GET', `/health-scores/${c3.id}/contacts`, { token: OPS });
  rec('Follow-up', 'Every contact is kept in a log, newest first', r.body.contacts.length === 2 && r.body.contacts[0].contact_status === 'resolved' && r.body.contacts[1].method_label === 'WhatsApp');
  r = await call('GET', '/health-scores', { token: OPS });
  rec('Follow-up', 'Health list carries contact status and follow-up date', r.body.rows.find(x => x.customer_id === c3.id).contact_status === 'resolved');
  rec('Follow-up', 'The older "mark contacted" button still works', (await call('POST', `/health-scores/${c4.id}/contacted`, { token: OPS, body: { note: 'ok' } })).status === 200);

  // ══ ZERO-COST REWARDS ══
  const rate = async (cid, n, rating) => { for (let k = 0; k < n; k++) await job(cid, addDays(today, -1 - k * 5), 'collected', { rating }); };
  await rate(c4.id, 7, 'good');
  let t = await growth.tierOf(c4.id);
  rec('Tiers', '7 Good pickups in 90 days reach Forest with a 4-hour issue response', t.key === 'forest' && t.response_h === 4 && t.next === null, `${t.name} ${t.rate}%`);
  await rate(c2.id, 3, 'average');
  t = await growth.tierOf(c2.id);
  rec('Tiers', 'Average separation stays at Sapling and says what is needed for the next tier', t.key === 'sapling' && /Tree/.test(t.next.name) && t.next.need.length > 0, t.next.need);
  rec('Tiers', 'A new customer starts at Seedling', (await growth.tierOf((await prisma.customer.findFirst({ orderBy: { id: 'desc' } })).id)).key === 'seedling');
  r = await call('POST', '/customer/issues', { token: tok({ id: c4.id, role: 'customer', customer_id: c4.id }), body: { category: 'bin', description: 'Bin lid broken, please replace' } });
  rec('Tiers', 'A Forest site\'s issue gets a 4-hour response target', r.body.response_h === 4 && (await one('customerIssue', { id: r.body.id })).response_h === 4);
  await prisma.booking.create({ data: { customer_id: c2.id, service_code: 'WASTE', date: addDays(today, 3), status: 'requested' } });
  await prisma.booking.create({ data: { customer_id: c4.id, service_code: 'WASTE', date: addDays(today, 5), status: 'requested' } });
  r = await call('GET', '/bookings', { token: OPS });
  rec('Tiers', 'Extra pickup requests from Tree / Forest sites go to the top', r.body[0].customer_id === c4.id && r.body[0].priority === true, r.body.slice(0, 2).map(b => b.tier).join(', '));

  const R4 = (await call('GET', '/customer/rewards', { token: tok({ id: c4.id, role: 'customer', customer_id: c4.id }) })).body;
  rec('Rewards', 'Customer sees tier, perks, streak and badges', R4.tier.key === 'forest' && R4.tier.perks.length >= 5 && R4.streak.current === 7 && R4.badges.find(b => b.key === 'streak5').earned, `streak ${R4.streak.current}`);
  rec('Rewards', 'Impact estimate is shown and labelled as an estimate', R4.impact.visits >= 1 && R4.impact.diverted_kg > 0 && R4.impact.estimate && /Estimate/.test(R4.impact.method), `${R4.impact_year.diverted_kg} kg kept out of landfill this year`);
  r = await call('GET', '/customer/certificate', { token: tok({ id: c4.id, role: 'customer', customer_id: c4.id }) });
  rec('Rewards', 'Monthly sustainability certificate with a Green Partner badge for higher tiers', r.status === 200 && /Sustainability certificate/.test(r.body) && /GREEN PARTNER/.test(r.body) && /kg/.test(r.body));
  r = await call('GET', `/customers/${c1.id}/certificate?month=2026-13`, { token: OPS });
  rec('Rewards', 'Office can open any customer\'s certificate; bad months fall back to this month', r.status === 200 && /Sustainability certificate/.test(r.body));

  // discounts: off by default, budget-capped when on
  const disc = await prisma.rewardCatalog.findFirst({ where: { kind: 'discount' }, orderBy: [{ points_cost: 'asc' }, { id: 'asc' }] });
  await prisma.rewardPoint.create({ data: { customer_id: c4.id, points: 2000, kind: 'adjust', reason: 'test' } });
  const C4 = tok({ id: c4.id, role: 'customer', customer_id: c4.id });
  rec('Budget', 'Money-off rewards cannot be redeemed while switched off', (await call('POST', '/customer/rewards/redeem', { token: C4, body: { reward_id: disc.id } })).status === 409);
  await call('PUT', '/rewards/settings', { token: A, body: { discounts_enabled: true, budget_aed: 30 } });
  r = await call('POST', '/customer/rewards/redeem', { token: C4, body: { reward_id: disc.id } });
  rec('Budget', 'With discounts on, a redemption inside the budget works', r.status === 200, `AED ${disc.discount_aed} of 30`);
  r = await call('POST', '/customer/rewards/redeem', { token: C4, body: { reward_id: disc.id } });
  rec('Budget', 'The monthly budget stops further money-off rewards', r.status === 409 && /all taken/.test(r.body.error));
  r = await call('GET', '/rewards/overview', { token: A });
  rec('Budget', 'Office sees budget used, tier counts and total impact', r.body.discounts.spent_aed === disc.discount_aed && r.body.tiers.find(x => x.key === 'forest').sites >= 1 && r.body.impact.diverted_kg > 0);
  rec('Budget', 'Ops staff cannot switch discounts on', (await call('PUT', '/rewards/settings', { token: OPS, body: { discounts_enabled: true } })).status === 403);
  await call('PUT', '/rewards/settings', { token: A, body: { discounts_enabled: false } });

  // ══ DEMO DATA ══
  const issuesBefore = await count('customerIssue'), contactsBefore = await count('healthContact');
  r = await call('POST', '/growth/demo', { token: A });
  const demoIssues = await count('customerIssue', { is_demo: 1 });
  const sumd = (await call('GET', '/issues', { token: OPS })).body.summary;
  rec('Demo', 'Demo adds issues in every state and follow-ups (one due today)', r.status === 200 && demoIssues === 5 && sumd.resolved >= 2 && sumd.in_progress >= 1 &&
    await prisma.healthScore.count({ where: { contact_status: 'follow_up', follow_up_at: { lte: today } } }) >= 2, JSON.stringify(sumd));
  const first = await one('customer', { is_active: 1 });
  const vh = (await call('GET', '/customer/visits', { token: tok({ id: first.id, role: 'customer', customer_id: first.id }) })).body.summary;
  rec('Demo', 'Demo customer has a full visit history', vh.upcoming >= 2 && vh.missed >= 1 && vh.awaiting >= 1 && vh.rescheduled >= 1 && vh.completed > 3, JSON.stringify(vh));
  await call('DELETE', '/growth/demo', { token: A });
  rec('Demo', 'Remove demo data takes the issues and contacts out again', await count('customerIssue') === issuesBefore && await count('healthContact') === contactsBefore);
  rec('Demo', 'Real follow-ups survive removing demo data', (await prisma.healthScore.findUnique({ where: { customer_id: c3.id } })).contact_status === 'resolved');

  void care;
  const failed = results.filter(x => !x.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
