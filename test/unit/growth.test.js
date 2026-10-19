// Growth modules — customer health score, green rewards, AI waste scanner (server/growth.js)
const { call, tok, emitted } = require('./harness');
const { prisma } = require('../../server/db');
const one = (model, where, select) => prisma[model].findFirst({ where, ...(select ? { select } : {}), orderBy: { id: 'asc' } });
const count = (model, where) => prisma[model].count({ where });
const pointsOf = async (cid) => (await prisma.rewardPoint.aggregate({ where: { customer_id: cid }, _sum: { points: true } }))._sum.points;
const growth = require('../../server/growth');

const results = [];
const rec = (area, name, ok, note = '') => { results.push({ area, name, ok: !!ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${note ? ' → ' + note : ''}`); };
const A = tok({ id: 1, role: 'admin', crm_role: 'owner', name: 'Owner' });
const OPS = tok({ id: 1, role: 'admin', crm_role: 'ops', name: 'Ops' });
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const today = ymd();

(async () => {
  await require('./harness').ready;
  const cust = await prisma.customer.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' }, take: 3 });
  const [c1, c2, c3] = cust;
  const C1 = tok({ id: c1.id, role: 'customer', customer_id: c1.id, name: c1.name });
  const C2 = tok({ id: c2.id, role: 'customer', customer_id: c2.id, name: c2.name });
  const drv = await one('user', { role: 'driver', vehicle_id: { not: null } });
  const other = await one('user', { role: 'driver', id: { not: drv.id } });
  const D = tok({ id: drv.id, role: 'driver', vehicle_id: drv.vehicle_id, name: drv.full_name });
  const D2 = tok({ id: other.id, role: 'driver', vehicle_id: other.vehicle_id, name: other.full_name });
  const job = async (cid, date, status, extra = {}) => (await prisma.pickup.create({ data: { customer_id: cid, vehicle_id: drv.vehicle_id, driver_id: drv.id, scheduled_date: date, status,
    confirmation_status: extra.conf || null, completed_at: status === 'collected' ? new Date().toISOString() : null } })).id;

  // ══ HEALTH SCORE ══
  // c1: steady and clean → healthy. c2: missed pickups + dispute + overdue invoice → at risk.
  for (let i = 1; i <= 6; i++) await job(c1.id, addDays(today, -i * 12), 'collected');
  await job(c2.id, addDays(today, -5), 'canceled', { conf: 'confirmed' });
  await job(c2.id, addDays(today, -15), 'canceled', { conf: 'auto_confirmed' });
  await job(c2.id, addDays(today, -20), 'overdue');
  await job(c2.id, addDays(today, -25), 'canceled', { conf: 'disputed' });
  await prisma.invoice.create({ data: { number: 'T-HS-1', customer_id: c2.account_id || c2.id, period: today.slice(0, 7), subtotal: 1000, vat: 50, amount: 1050, due_date: addDays(today, -10), status: 'issued' } });

  let r = await call('GET', '/health-scores', { token: OPS });
  const byId = Object.fromEntries(r.body.rows.map(h => [h.customer_id, h]));
  rec('Health', 'Office staff get a score for every active customer', r.status === 200 && r.body.rows.length === await count('customer', { is_active: 1 }), `${r.body.rows.length} customers`);
  rec('Health', 'A clean, regular customer is Healthy', byId[c1.id].band === 'healthy' && byId[c1.id].score >= 70, `score ${byId[c1.id].score}`);
  rec('Health', 'Missed pickups, a dispute and an overdue invoice make a customer At risk', byId[c2.id].band === 'at_risk' && byId[c2.id].score < 40, `score ${byId[c2.id].score}`);
  rec('Health', 'Every At-risk customer comes with the reasons', byId[c2.id].reasons.length >= 3 && byId[c2.id].reasons.some(x => /overdue invoice/.test(x)) && byId[c2.id].reasons.some(x => /disputed/.test(x)), byId[c2.id].reasons.join('; '));
  rec('Health', 'Riskiest customers are listed first', r.body.rows[0].score <= r.body.rows[r.body.rows.length - 1].score);
  rec('Health', 'Summary counts add up', r.body.summary.healthy + r.body.summary.watch + r.body.summary.at_risk === r.body.rows.length, JSON.stringify(r.body.summary));

  // c3 becomes at risk after the first run → an alert is raised once
  const alertsBefore = await count('alert', { type: 'HEALTH' });
  for (let i = 1; i <= 4; i++) await job(c3.id, addDays(today, -i * 3), 'canceled', { conf: 'confirmed' });
  await job(c3.id, addDays(today, -2), 'canceled', { conf: 'disputed' });
  await job(c3.id, addDays(today, -3), 'canceled', { conf: 'disputed' });
  await prisma.invoice.create({ data: { number: 'T-HS-2', customer_id: c3.account_id || c3.id, period: today.slice(0, 7), subtotal: 1000, vat: 50, amount: 1050, due_date: addDays(today, -3), status: 'issued' } });
  r = await call('POST', '/health-scores/recalculate', { token: OPS });
  const alertsAfter = await count('alert', { type: 'HEALTH' });
  rec('Health', 'Moving into At risk raises one CRM alert', r.body.newly_at_risk >= 1 && alertsAfter === alertsBefore + r.body.newly_at_risk, `${r.body.newly_at_risk} new`);
  await call('POST', '/health-scores/recalculate', { token: OPS });
  rec('Health', 'Recalculating again does not repeat the alert', await count('alert', { type: 'HEALTH' }) === alertsAfter);
  r = await call('POST', `/health-scores/${c2.id}/contacted`, { token: OPS, body: { note: 'Called the manager' } });
  const hs = await prisma.healthScore.findUnique({ where: { customer_id: c2.id } });
  rec('Health', 'Sales can mark an account as contacted with a note', r.status === 200 && hs.contacted_at && hs.contact_note === 'Called the manager');
  rec('Health', 'Drivers and customers cannot see health scores', (await call('GET', '/health-scores', { token: D })).status === 403 && (await call('GET', '/health-scores', { token: C1 })).status === 403);

  // ══ GREEN REWARDS ══
  const p1 = await job(c1.id, today, 'collected');
  r = await call('POST', `/pickups/${p1}/segregation`, { token: D, body: { rating: 'good' } });
  rec('Rewards', 'Driver rates a finished pickup Good and the customer earns 10 points', r.status === 200 && r.body.points === 10 && r.body.balance === 10, JSON.stringify(r.body));
  r = await call('POST', `/pickups/${p1}/segregation`, { token: D, body: { rating: 'good' } });
  rec('Rewards', 'Rating the same pickup again gives no extra points', r.body.already && await pointsOf(c1.id) === 10);
  rec('Rewards', 'The customer is told about the points', await count('customerNotification', { customer_id: c1.id, kind: 'rewards' }) === 1);
  const pPending = await job(c1.id, today, 'pending');
  rec('Rewards', 'A pickup that is not finished cannot be rated', (await call('POST', `/pickups/${pPending}/segregation`, { token: D, body: { rating: 'good' } })).status === 409);
  const pOther = await job(c1.id, today, 'collected');
  rec('Rewards', 'Another driver cannot rate this job', (await call('POST', `/pickups/${pOther}/segregation`, { token: D2, body: { rating: 'good' } })).status === 403);
  rec('Rewards', 'Only good, average or poor are accepted', (await call('POST', `/pickups/${pOther}/segregation`, { token: D, body: { rating: 'great' } })).status === 400);
  r = await call('POST', `/pickups/${pOther}/segregation`, { token: D, body: { rating: 'poor' } });
  rec('Rewards', 'Poor segregation earns nothing', r.status === 200 && r.body.points === 0);

  // monthly cap
  await call('PUT', '/rewards/settings', { token: A, body: { monthly_cap: 25 } });
  const pa = await job(c1.id, today, 'collected'), pb = await job(c1.id, today, 'collected');
  await call('POST', `/pickups/${pa}/segregation`, { token: D, body: { rating: 'good' } });
  r = await call('POST', `/pickups/${pb}/segregation`, { token: D, body: { rating: 'good' } });
  rec('Rewards', 'The monthly cap limits points per customer', r.body.points === 5 && await pointsOf(c1.id) === 25, `last award ${r.body.points}, total 25`);
  await call('PUT', '/rewards/settings', { token: A, body: { monthly_cap: 0 } });
  rec('Rewards', 'Ops staff cannot change reward settings', (await call('PUT', '/rewards/settings', { token: OPS, body: { good: 50 } })).status === 403);

  r = await call('GET', '/customer/rewards', { token: C1 });
  const cat = r.body.catalog;
  rec('Rewards', 'Customer sees balance, history, rewards and leaderboard (no-cost perks only by default)', r.body.balance === 25 && r.body.history.length >= 3 && cat.length === 3 && cat.every(c => c.kind === 'perk' && c.discount_aed === 0) && r.body.leaderboard.my_rank === 1, `rank ${r.body.leaderboard.my_rank} of ${r.body.leaderboard.of}`);
  rec('Rewards', 'Leaderboard ranks zones and marks the customer\'s own zone', r.body.leaderboard.zones.length === 3 && r.body.leaderboard.zones.filter(z => z.mine).length === 1);
  r = await call('POST', '/customer/rewards/redeem', { token: C1, body: { reward_id: cat[0].id } });
  rec('Rewards', 'Not enough points: the request is refused with how many are missing', r.status === 409 && /75 more points/.test(r.body.error), r.body.error);

  await prisma.rewardPoint.create({ data: { customer_id: c1.id, points: 300, kind: 'adjust', reason: 'test top-up' } });
  r = await call('POST', '/customer/rewards/redeem', { token: C1, body: { reward_id: cat[0].id } });
  rec('Rewards', 'Redeeming takes the points and creates a request for the office', r.status === 200 && r.body.balance === 225 && (await one('rewardRedemption', { id: r.body.id })).status === 'requested');
  const redId = r.body.id;
  r = await call('GET', '/rewards/overview', { token: OPS });
  rec('Rewards', 'Office sees the request at the top of the list', r.status === 200 && r.body.redemptions[0].id === redId && r.body.ratings.good >= 3, `ratings ${JSON.stringify(r.body.ratings)}`);
  rec('Rewards', 'Ops staff cannot approve rewards', (await call('POST', `/rewards/redemptions/${redId}/decide`, { token: OPS, body: { action: 'approve' } })).status === 403);
  r = await call('POST', `/rewards/redemptions/${redId}/decide`, { token: A, body: { action: 'reject', note: 'Test' } });
  rec('Rewards', 'Declining returns the points to the customer', r.status === 200 && await pointsOf(c1.id) === 325);
  rec('Rewards', 'A decided request cannot be decided again', (await call('POST', `/rewards/redemptions/${redId}/decide`, { token: A, body: { action: 'approve' } })).status === 409);
  r = await call('POST', '/customer/rewards/redeem', { token: C1, body: { reward_id: cat[0].id } });
  await call('POST', `/rewards/redemptions/${r.body.id}/decide`, { token: A, body: { action: 'approve' } });
  const ap = await call('POST', `/rewards/redemptions/${r.body.id}/decide`, { token: A, body: { action: 'applied' } });
  rec('Rewards', 'Approved, then marked as applied to the invoice', ap.status === 200 && (await one('rewardRedemption', { id: r.body.id })).status === 'applied');
  r = await call('POST', '/rewards/catalog', { token: A, body: { name: 'Free bin wash', points_cost: 400, discount_aed: 0 } });
  rec('Rewards', 'Owner can add a no-cost reward', r.status === 200 && (await call('GET', '/customer/rewards', { token: C2 })).body.catalog.length === 4);
  r = await call('POST', '/rewards/catalog', { token: A, body: { name: 'AED 100 off', points_cost: 900, discount_aed: 100 } });
  rec('Rewards', 'Money-off rewards stay hidden while discounts are switched off', r.status === 200 && (await call('GET', '/customer/rewards', { token: C2 })).body.catalog.length === 4);

  // ══ WASTE SCANNER ══
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
  r = await call('GET', '/customer/scan/options', { token: C1 });
  rec('Scanner', 'Without an AI key the app is told to use the manual picker', r.status === 200 && r.body.ai === false && r.body.categories.length === 9);
  r = await call('POST', '/customer/scan', { token: C1, body: { image: 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64') } });
  rec('Scanner', 'A photo without AI set up gives a clear message, not a crash', r.status === 503 && r.body.code === 'AI_OFF');
  r = await call('POST', '/customer/scan', { token: C1, body: { categories: ['cardboard', 'plastic'], volume: 'medium' } });
  rec('Scanner', 'Chosen types give a service, an estimate and tips', r.status === 200 && r.body.service_code === 'WASTE' && r.body.est_price === 150 && r.body.tips.length === 2 && !r.body.hazardous, `${r.body.service_name} AED ${r.body.est_price}`);
  const scanId = r.body.id;
  r = await call('POST', '/customer/scan', { token: C1, body: { categories: ['e_waste'], volume: 'small' } });
  rec('Scanner', 'Electronic waste is flagged for special handling and priced as bulk', r.body.hazardous && r.body.service_code === 'WASTE_BULK' && r.body.est_price === 350);
  r = await call('POST', '/customer/scan', { token: C1, body: { categories: ['organic'], volume: 'large' } });
  rec('Scanner', 'A large volume moves to the bulk service', r.body.service_code === 'WASTE_BULK');
  rec('Scanner', 'Unknown or empty types are refused', (await call('POST', '/customer/scan', { token: C1, body: { categories: ['gold'] } })).status === 422);
  rec('Scanner', 'AI answers are cleaned: unknown types dropped, shares clamped to 0-100',
    await (async () => { const e = await growth.estimate([{ category: 'plastic', share_pct: 140 }, { category: 'unicorn', share_pct: 10 }], 'huge'); return e.categories.length === 1 && e.categories[0].share_pct === 100 && e.volume === 'medium'; })());

  const leadsBefore = await count('lead');
  r = await call('POST', `/customer/scans/${scanId}/request-quote`, { token: C1, body: { note: 'Twice a week please' } });
  const lead = await one('lead', { id: r.body.lead_id });
  rec('Scanner', 'Request quote creates a pre-filled lead in Sales', r.status === 200 && lead && lead.source === 'ai_scan' && lead.stage === 'new' && /Cardboard/.test(lead.notes) && /Twice a week/.test(lead.notes) && JSON.parse(lead.sites)[0].zone === c1.zone, lead && lead.notes.split('\n')[2]);
  r = await call('POST', `/customer/scans/${scanId}/request-quote`, { token: C1 });
  rec('Scanner', 'Asking twice does not create a second lead', r.body.already && await count('lead') === leadsBefore + 1);
  rec('Scanner', 'A customer cannot request a quote on someone else\'s scan', (await call('POST', `/customer/scans/${scanId}/request-quote`, { token: C2 })).status === 404);
  rec('Scanner', 'Office is alerted live', emitted.includes('staff|lead:changed') && await count('alert', { type: 'QUOTE_REQUEST' }) === 1);
  r = await call('GET', '/waste-scans', { token: OPS });
  rec('Scanner', 'Office sees scans with the lead stage', r.status === 200 && r.body.rows.find(s => s.id === scanId).lead_stage === 'new');
  r = await call('PUT', '/waste-scan-rules/glass', { token: A, body: { service_code: 'WASTE_BULK', tip: 'Box it' } });
  rec('Scanner', 'Owner can change which service a waste type maps to', r.status === 200 && (await growth.estimate(['glass'], 'small')).service_code === 'WASTE_BULK');
  rec('Scanner', 'Office staff cannot use the customer scanner', (await call('POST', '/customer/scan', { token: OPS, body: { categories: ['glass'] } })).status === 403);

  // ══ DEMO DATA ══
  const pickupsBefore = await count('pickup'), invBefore = await count('invoice');
  rec('Demo', 'Ops staff cannot load demo data', (await call('POST', '/growth/demo', { token: OPS })).status === 403);
  r = await call('POST', '/growth/demo', { token: A });
  rec('Demo', 'Demo data fills every health group', r.status === 200 && r.body.health.at_risk >= 3 && r.body.health.watch >= 2 && r.body.health.healthy > 10, JSON.stringify(r.body.health));
  const ov = (await call('GET', '/rewards/overview', { token: A })).body;
  rec('Demo', 'Rewards screen has points, ratings and requests in each state', ov.issued_this_month > 100 && ov.ratings.good > 20 && ov.ratings.poor > 0 && ov.redemptions.some(x => x.status === 'requested') && ov.redemptions.some(x => x.status === 'applied'), `${ov.issued_this_month} pts`);
  const cr = (await call('GET', '/customer/rewards', { token: tok({ id: cust[0].id, role: 'customer', customer_id: cust[0].id }) })).body;
  rec('Demo', 'The first customer can redeem a reward in the customer app', cr.balance >= cr.catalog[0].points_cost, `${cr.balance} points`);
  rec('Demo', 'Demo visits are never billable', await count('pickup', { notes: '[growth-demo]', OR: [{ billable: null }, { billable: 1 }] }) === 0);
  r = await call('POST', '/growth/demo', { token: A });
  const afterTwice = await count('pickup', { notes: '[growth-demo]' });
  r = await call('DELETE', '/growth/demo', { token: A });
  rec('Demo', 'Loading twice does not double up, and Remove takes it all out', r.body.removed_pickups === afterTwice && await count('pickup') === pickupsBefore && await count('invoice') === invBefore && !(await one('rewardPoint', { created_by: 'demo' })), `${afterTwice} demo visits removed`);
  rec('Demo', 'Real reward points survive removing demo data', await pointsOf(c1.id) > 0);

  const failed = results.filter(x => !x.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
