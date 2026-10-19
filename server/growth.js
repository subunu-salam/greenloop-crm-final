// ─────────────────────────────────────────────────────────────
// GreenLoop growth modules (add-ons, nothing existing is changed)
//   1. Customer Health Score  — nightly 0-100 score per site, at-risk alerts
//   2. Green Rewards          — driver rates segregation, customer earns points,
//                               redeems for invoice discounts, zone leaderboard
//   3. AI Waste Scanner       — customer photographs waste, gets type, tips and an
//                               estimate, sends a pre-filled quote request (lead)
// MongoDB through Prisma like the rest of the server (see server/db.js).
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const security = require('./security');
const { prisma, getSetting, setSetting, join, groupBy, findById, toId, sortBy, desc, now: sqlNow } = require('./db');
const v3 = require('./v3');

security.ensureSecret();
const SECRET = process.env.JWT_SECRET;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const J = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const money = n => Math.round(Number(n || 0) * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ── auth (same token rules as v3) ────────────────────────────
const need = (...roles) => (req, res, next) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.query && req.query.t) || null;
  let p = null;
  try { p = t ? jwt.verify(t, SECRET) : null; } catch { p = null; }
  if (!p) return res.status(401).json({ error: 'Missing or invalid token' });
  const eff = p.role === 'admin' ? (p.crm_role === 'ops' ? 'ops' : 'admin') : p.role;
  if (!roles.includes(eff)) return res.status(403).json({ error: 'Your role cannot do this' });
  req.user = { ...p, eff };
  next();
};
const staff = need('admin', 'ops');
const owner = need('admin');
const cust = need('customer');
const driver = need('driver');
const custId = req => Number(req.user.customer_id || req.user.id);

// ── first-run data (settings, rewards catalogue, waste scan rules) ──
// order the waste categories are shown in (SQLite used insertion order: ORDER BY rowid)
const RULE_ORDER = ['plastic', 'cardboard', 'organic', 'glass', 'metal', 'mixed', 'bulky', 'e_waste', 'hazardous'];
async function init() {
  const defaults = { rewards_points_good: '10', rewards_points_average: '5', rewards_points_poor: '0', rewards_monthly_cap: '200' };
  for (const [k, v] of Object.entries(defaults)) if (!(await getSetting(k, ''))) await setSetting(k, v);
  if (!(await prisma.rewardCatalog.findFirst({ select: { id: true } }))) {
    await prisma.rewardCatalog.createMany({
      data: [['AED 25 off your next invoice', 250, 25], ['AED 60 off your next invoice', 500, 60], ['One free extra pickup', 800, 150]]
        .map(([name, points_cost, discount_aed]) => ({ name, points_cost, discount_aed })),
    });
  }
  // v3.7: rewards that cost the client nothing ("perk") vs money off ("discount", off by default, budget-capped)
  await prisma.rewardCatalog.updateMany({ where: { kind: null, discount_aed: { gt: 0 } }, data: { kind: 'discount' } });
  await prisma.rewardCatalog.updateMany({ where: { kind: null }, data: { kind: 'perk' } });
  if (!(await prisma.rewardCatalog.findFirst({ where: { kind: 'perk' }, select: { id: true } }))) {
    await prisma.rewardCatalog.createMany({
      data: [['Priority slot for your next extra pickup', 100, 'Your next extra pickup request goes to the top of the queue and you choose the time window.'],
        ['Waste audit report for your site', 150, 'A one-page report of what you throw away, how well it is separated and where you can cut volume.'],
        ['Featured as a Green Partner of the month', 250, 'Your business is named on the GreenLoop Green Partners list and in our monthly social post.']]
        .map(([name, points_cost, description]) => ({ name, points_cost, discount_aed: 0, kind: 'perk', description })),
    });
  }
  const more = { rewards_discounts_enabled: '0', rewards_monthly_budget_aed: '500', impact_kg_per_visit: '120', impact_co2_per_kg: '0.7' };
  for (const [k, v] of Object.entries(more)) if (!(await getSetting(k, ''))) await setSetting(k, v);
  if (!(await prisma.wasteScanRule.findFirst({ select: { category: true } }))) {
    await prisma.wasteScanRule.createMany({
      data: [
        ['plastic', 'Plastic', 'WASTE', 0, 'Rinse bottles and containers, flatten them and keep them out of food waste.'],
        ['cardboard', 'Cardboard and paper', 'WASTE', 0, 'Flatten boxes and keep them dry; wet cardboard cannot be recycled.'],
        ['organic', 'Food and organic', 'WASTE', 0, 'Keep food waste in sealed bags, separate from packaging.'],
        ['glass', 'Glass', 'WASTE', 0, 'Keep glass in its own container so it does not break into other waste.'],
        ['metal', 'Metal and cans', 'WASTE', 0, 'Empty and crush cans; keep metal separate from food waste.'],
        ['mixed', 'Mixed general waste', 'WASTE', 0, 'Pull out cardboard and plastic first; it lowers your mixed-waste volume.'],
        ['bulky', 'Bulky items (furniture, pallets)', 'WASTE_BULK', 0, 'Stack bulky items near the collection point so the crew can load quickly.'],
        ['e_waste', 'Electronic waste', 'WASTE_BULK', 1, 'Keep electronics and batteries apart; they need special handling.'],
        ['hazardous', 'Hazardous (chemicals, oil, batteries)', 'WASTE_BULK', 1, 'Do not mix with other waste. Keep containers closed and labelled.'],
      ].map(([category, label, service_code, hazardous, tip]) => ({ category, label, service_code, hazardous, tip })),
    });
  }
}

// ═════════════ 1. CUSTOMER HEALTH SCORE ═════════════════════
const BAND = s => (s >= 70 ? 'healthy' : s >= 40 ? 'watch' : 'at_risk');
const BAND_LABEL = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk' };

async function scoreCustomer(c, today = ymd()) {
  const acct = c.account_id || c.id;
  const d30 = addDays(today, -30), d60 = addDays(today, -60), d90 = addDays(today, -90);
  const count = (where) => prisma.pickup.count({ where: { customer_id: c.id, ...where } });
  // overdue, or "not picked up" that was confirmed / auto-confirmed / still awaiting (or has no status)
  const missed = await count({
    scheduled_date: { gte: d60, lte: today },
    OR: [{ status: 'overdue' }, { status: 'canceled', OR: [{ confirmation_status: null }, { confirmation_status: { in: ['confirmed', 'auto_confirmed', 'awaiting', ''] } }] }],
  });
  const complaints = await count({ confirmation_status: 'disputed', scheduled_date: { gte: d90 } });
  const invoices = await prisma.invoice.findMany({ where: { customer_id: acct, status: { not: 'void' } }, select: { id: true, amount: true, due_date: true } });
  const paidBy = await prisma.payment.groupBy({ by: ['invoice_id'], where: { invoice_id: { in: invoices.map(i => i.id) } }, _sum: { amount: true } });
  const paidMap = new Map(paidBy.map(g => [g.invoice_id, g._sum.amount || 0]));
  const inv = invoices.map(i => ({ ...i, paid: paidMap.get(i.id) || 0 }));
  const overdueInv = inv.filter(i => i.due_date < today && i.amount - i.paid > 0.004);
  const overdueAmt = money(overdueInv.reduce((a, i) => a + i.amount - i.paid, 0));
  const recent = await count({ status: 'collected', scheduled_date: { gt: d30, lte: today } });
  const before = await count({ status: 'collected', scheduled_date: { gt: d90, lte: d30 } });
  const usual = before / 2;                      // collected per 30 days over the 60 days before
  const drop = usual >= 2 ? Math.round(100 * (usual - recent) / usual) : 0;
  const goodRatings = await count({ segregation_rating: 'good', scheduled_date: { gt: d30 } });
  const redeemed = await prisma.rewardRedemption.count({ where: { customer_id: c.id, created_at: { gte: d90 } } });
  const openIssues = await prisma.customerIssue.count({ where: { customer_id: c.id, status: { in: ['open', 'in_progress'] } } });

  let score = 100; const reasons = [];
  const take = (pts, why) => { if (pts > 0) { score -= pts; reasons.push(why); } };
  take(Math.min(30, missed * 10), `${missed} missed pickup${missed === 1 ? '' : 's'} in 60 days`);
  take(Math.min(30, complaints * 15), `${complaints} disputed visit${complaints === 1 ? '' : 's'} in 90 days`);
  if (overdueInv.length) take(Math.min(30, 15 + (overdueInv.length - 1) * 8 + Math.floor(overdueAmt / 500) * 2),
    `${overdueInv.length} overdue invoice${overdueInv.length === 1 ? '' : 's'} (AED ${overdueAmt.toFixed(2)})`);
  take(Math.min(24, openIssues * 12), `${openIssues} open issue${openIssues === 1 ? '' : 's'} raised by the customer`);
  if (drop >= 40) take(15, `Pickups down ${drop}% on their usual`);
  else if (drop >= 20) take(8, `Pickups down ${drop}% on their usual`);
  let bonus = 0;
  if (goodRatings >= 2) bonus += 5;
  if (redeemed) bonus += 3;
  score = clamp(Math.round(score + bonus), 0, 100);
  return { score, band: BAND(score), reasons,
    factors: { missed_60d: missed, disputes_90d: complaints, overdue_invoices: overdueInv.length, overdue_aed: overdueAmt,
      collected_30d: recent, usual_per_30d: Math.round(usual * 10) / 10, drop_pct: drop, good_segregation_30d: goodRatings, open_issues: openIssues, bonus } };
}

async function scoreAndStore(c, today, now, notify) {
  const r = await scoreCustomer(c, today);
  const old = await prisma.healthScore.findUnique({ where: { customer_id: c.id } });
  const changed = !old || old.band !== r.band;
  const fresh = { score: r.score, band: r.band, reasons: JSON.stringify(r.reasons), factors: JSON.stringify(r.factors), computed_at: now };
  // The SQL "ON CONFLICT … CASE WHEN" rules, written out in JS:
  //   band changed → remember the previous band and when this one started;
  //   newly at risk → the follow-up starts again ("not contacted").
  const resetContact = changed && old && r.band === 'at_risk';
  await prisma.healthScore.upsert({
    where: { customer_id: c.id },
    create: { customer_id: c.id, ...fresh, prev_band: null, band_since: now },
    update: {
      ...fresh,
      prev_band: changed ? (old ? old.band : null) : (old?.prev_band ?? null),
      band_since: changed ? now : (old?.band_since || now),
      ...(resetContact ? { contacted_at: null, contact_status: 'not_contacted' } : {}),
    },
  });
  const turned = changed && old && r.band === 'at_risk';
  if (turned && notify) try { await v3.alertCrm('HEALTH', 'warning', `At risk: ${c.name} (${c.branch || ''}) — ${r.reasons.join('; ') || 'score ' + r.score}`); } catch { /* ignore */ }
  return turned;
}
async function recalcHealth({ notify = true } = {}) {
  const now = new Date().toISOString(), today = ymd();
  const rows = await prisma.customer.findMany({ where: { is_active: 1 }, select: { id: true, name: true, branch: true, account_id: true }, orderBy: { id: 'asc' } });
  let newlyAtRisk = 0;
  for (const c of rows) if (await scoreAndStore(c, today, now, notify)) newlyAtRisk++;
  await setSetting('health_last_run', today);
  return { customers: rows.length, newly_at_risk: newlyAtRisk, computed_at: now };
}
// one customer, e.g. right after they raise an issue
async function recalcCustomer(cid, { notify = true } = {}) {
  const id = toId(cid);
  const c = id ? await prisma.customer.findFirst({ where: { id, is_active: 1 }, select: { id: true, name: true, branch: true, account_id: true } }) : null;
  if (c) await scoreAndStore(c, ymd(), new Date().toISOString(), notify);
}

let healthTimer = null;
async function startHealth() {
  const tick = async () => {
    try {
      const h = new Date().getHours();
      const last = await getSetting('health_last_run', '');
      const never = !last;
      if (never || (last !== ymd() && h >= 2)) await recalcHealth({ notify: !never });
    } catch (e) { console.warn('Health score:', e.message); }
  };
  await tick();
  if (!healthTimer) { healthTimer = setInterval(() => { tick(); }, 30 * 60 * 1000); if (healthTimer.unref) healthTimer.unref(); }
}

// ═════════════ 2. GREEN REWARDS ═════════════════════════════
const RATINGS = ['good', 'average', 'poor'];
const pointsFor = async rating => Number(await getSetting('rewards_points_' + rating, rating === 'good' ? '10' : rating === 'average' ? '5' : '0')) || 0;
// SQL: COALESCE(SUM(points),0)
const sumPoints = async (where) => (await prisma.rewardPoint.aggregate({ where, _sum: { points: true } }))._sum.points || 0;
const balanceOf = cid => sumPoints({ customer_id: cid });
const earnedThisMonth = cid => sumPoints({ customer_id: cid, kind: 'earn', created_at: { startsWith: ymd().slice(0, 7) } });

async function rateSegregation(pickupId, rating, by) {
  const p = await prisma.pickup.findUnique({ where: { id: pickupId } });
  if (!p || !(await prisma.customer.findUnique({ where: { id: p.customer_id }, select: { id: true } }))) return { status: 404, error: 'Not found' };
  if (p.status !== 'collected') return { status: 409, error: 'Rate segregation after the pickup is finished' };
  if (p.segregation_rating) return { status: 200, ok: true, already: true, rating: p.segregation_rating, points: 0 };
  await prisma.pickup.update({ where: { id: p.id }, data: { segregation_rating: rating } });
  const cap = Number(await getSetting('rewards_monthly_cap', '200')) || 0;
  let pts = await pointsFor(rating);
  if (cap > 0) pts = Math.max(0, Math.min(pts, cap - await earnedThisMonth(p.customer_id)));
  if (pts > 0) {
    await prisma.rewardPoint.create({
      data: { customer_id: p.customer_id, pickup_id: p.id, points: pts, kind: 'earn', reason: `${rating[0].toUpperCase() + rating.slice(1)} segregation on ${v3.dmy(p.scheduled_date)}`, created_by: by == null ? null : String(by) },
    });
    await v3.notifyCustomer(p.customer_id, 'rewards', `+${pts} Green points`, `Thanks for separating your waste well on ${v3.dmy(p.scheduled_date)}. Balance: ${await balanceOf(p.customer_id)} points.`, '/customer/#home');
  }
  return { status: 200, ok: true, rating, points: pts, balance: await balanceOf(p.customer_id) };
}

async function leaderboard(cid) {
  const month = ymd().slice(0, 7);
  const active = await prisma.customer.findMany({ where: { is_active: 1 }, select: { id: true, zone: true }, orderBy: { id: 'asc' } });
  const earned = await prisma.rewardPoint.groupBy({ by: ['customer_id'], where: { kind: 'earn', created_at: { startsWith: month } }, _sum: { points: true } });
  const pts = new Map(earned.map(g => [g.customer_id, g._sum.points || 0]));
  const sites = active.map(c => ({ id: c.id, zone: c.zone, pts: pts.get(c.id) || 0 }));
  const sorted = [...sites].sort((a, b) => b.pts - a.pts);
  const mine = sorted.findIndex(s => s.id === cid);
  const zones = {};
  sites.forEach(s => { (zones[s.zone] ||= { zone: s.zone, sites: 0, points: 0 }); zones[s.zone].sites++; zones[s.zone].points += s.pts; });
  const myZone = (sites.find(s => s.id === cid) || {}).zone;
  return {
    month, my_rank: mine >= 0 ? mine + 1 : null, of: sites.length, my_points: mine >= 0 ? sorted[mine].pts : 0,
    zones: Object.values(zones).map(z => ({ ...z, avg_points: Math.round(z.points / z.sites), mine: z.zone === myZone }))
      .sort((a, b) => b.avg_points - a.avg_points).map((z, i) => ({ ...z, rank: i + 1 })),
  };
}

// ── Green tiers (zero cost to the client) ──
// Based on how well waste was separated over the last 90 days, not on how often a
// site is collected, so a small shop can reach Forest as easily as a hypermarket.
const TIERS = [
  { key: 'seedling', name: 'Seedling', min_rate: 0, min_visits: 0, response_h: 24,
    perks: ['Your impact dashboard', 'Monthly sustainability certificate'] },
  { key: 'sapling', name: 'Sapling', min_rate: 50, min_visits: 2, response_h: 24,
    perks: ['Green Partner badge on your certificate'] },
  { key: 'tree', name: 'Tree', min_rate: 75, min_visits: 4, response_h: 12,
    perks: ['Extra pickup requests go to the top of the queue', 'Issues answered within 12 hours'] },
  { key: 'forest', name: 'Forest', min_rate: 90, min_visits: 6, response_h: 4,
    perks: ['Issues answered within 4 hours', 'Named on the zone leaderboard as a Forest site'] },
];
async function ratingStats(cid, since) {
  const g = await prisma.pickup.groupBy({
    by: ['segregation_rating'],
    where: { customer_id: cid, status: 'collected', segregation_rating: { not: null }, scheduled_date: { gte: since } },
    _count: { _all: true },
  });
  const n = (r) => (g.find(x => x.segregation_rating === r)?._count._all) || 0;
  const good = n('good'), average = n('average'), poor = n('poor'), rated = good + average + poor;
  return { good, average, poor, rated, rate: rated ? Math.round(100 * (good + average * 0.5) / rated) : 0 };
}
async function tierOf(cid) {
  const st = await ratingStats(cid, addDays(ymd(), -90));
  let i = 0;
  TIERS.forEach((t, k) => { if (st.rated >= t.min_visits && st.rate >= t.min_rate) i = k; });
  const t = TIERS[i], next = TIERS[i + 1] || null;
  return { key: t.key, name: t.name, level: i + 1, response_h: t.response_h, rate: st.rate, rated: st.rated,
    perks: TIERS.slice(0, i + 1).flatMap(x => x.perks),
    next: next ? { name: next.name, min_rate: next.min_rate, min_visits: next.min_visits, perks: next.perks,
      need: next.min_visits > st.rated ? `${next.min_visits - st.rated} more rated pickup${next.min_visits - st.rated === 1 ? '' : 's'}` + (st.rate < next.min_rate ? ` and a ${next.min_rate}% separation score` : '')
        : `a ${next.min_rate}% separation score (now ${st.rate}%)` } : null };
}
async function streaks(cid) {
  const list = (await prisma.pickup.findMany({
    where: { customer_id: cid, status: 'collected', segregation_rating: { not: null } },
    select: { segregation_rating: true }, orderBy: [{ scheduled_date: 'desc' }, { id: 'desc' }], take: 200,
  })).map(x => x.segregation_rating);
  let current = 0; while (current < list.length && list[current] === 'good') current++;
  let best = 0, run = 0; list.forEach(x => { run = x === 'good' ? run + 1 : 0; best = Math.max(best, run); });
  return { current, best };
}
async function badgesOf(cid) {
  const s = await streaks(cid), out = [];
  const anyGood = await prisma.pickup.findFirst({ where: { customer_id: cid, segregation_rating: 'good' }, select: { id: true } });
  out.push({ key: 'first', name: 'First green pickup', earned: !!anyGood, hint: 'Get one pickup rated Good' });
  out.push({ key: 'streak5', name: '5 in a row', earned: s.best >= 5, hint: '5 Good pickups in a row' });
  out.push({ key: 'streak10', name: '10 in a row', earned: s.best >= 10, hint: '10 Good pickups in a row' });
  // GROUP BY month (substr(scheduled_date,1,7))
  const rated = await prisma.pickup.findMany({ where: { customer_id: cid, segregation_rating: { not: null }, scheduled_date: { gte: addDays(ymd(), -100) } }, select: { scheduled_date: true, segregation_rating: true } });
  const months = [...groupBy(rated, p => p.scheduled_date.slice(0, 7)).values()].map(list => ({ n: list.length, g: list.filter(p => p.segregation_rating === 'good').length }));
  out.push({ key: 'perfect', name: 'Perfect month', earned: months.some(m => m.n >= 2 && m.g === m.n), hint: 'Every pickup in a month rated Good' });
  const lb = await leaderboard(cid);
  const me = (await prisma.customer.findUnique({ where: { id: cid }, select: { zone: true } })) || {};
  // the site with the most points earned this month in my zone
  const zoneSites = me.zone ? (await prisma.customer.findMany({ where: { zone: me.zone }, select: { id: true } })).map(c => c.id) : [];
  const g = await prisma.rewardPoint.groupBy({ by: ['customer_id'], where: { kind: 'earn', created_at: { startsWith: ymd().slice(0, 7) }, customer_id: { in: zoneSites } }, _sum: { points: true } });
  const zoneTop = g.map(x => ({ id: x.customer_id, p: x._sum.points || 0 })).sort((a, b) => b.p - a.p)[0];
  out.push({ key: 'champion', name: 'Zone champion', earned: !!(zoneTop && zoneTop.id === cid && zoneTop.p > 0), hint: `Most points in ${me.zone || 'your zone'} this month` });
  return { streak: s, badges: out, rank: lb.my_rank };
}
// Estimated impact. Clearly labelled as an estimate; the factors are editable in the CRM.
const DIVERT = { good: 0.6, average: 0.35, poor: 0.1, unrated: 0.2 };
async function impactOf(cid, from, to) {
  const kgPerVisit = Number(await getSetting('impact_kg_per_visit', '120')) || 0;
  const co2PerKg = Number(await getSetting('impact_co2_per_kg', '0.7')) || 0;
  const g = await prisma.pickup.groupBy({ by: ['segregation_rating'], where: { customer_id: cid, status: 'collected', scheduled_date: { gte: from, lte: to } }, _count: { _all: true } });
  const rows = g.map(x => ({ r: x.segregation_rating ?? 'unrated', n: x._count._all }));    // COALESCE(rating,'unrated')
  const visits = rows.reduce((a, x) => a + x.n, 0);
  const diverted = rows.reduce((a, x) => a + x.n * kgPerVisit * (DIVERT[x.r] ?? 0.2), 0);
  const co2 = diverted * co2PerKg;
  return { from, to, visits, collected_kg: Math.round(visits * kgPerVisit), diverted_kg: Math.round(diverted), co2_kg: Math.round(co2),
    trees: Math.round(co2 / 21), estimate: true,
    method: `Estimate: ${kgPerVisit} kg per visit; share kept out of landfill by separation rating (good 60%, OK 35%, poor 10%); ${co2PerKg} kg CO2e avoided per kg; one tree absorbs about 21 kg CO2 a year.` };
}
const discountsOn = async () => (await getSetting('rewards_discounts_enabled', '0')) === '1';
const discountSpent = async month => (await prisma.rewardRedemption.aggregate({
  where: { status: { not: 'rejected' }, discount_aed: { gt: 0 }, created_at: { startsWith: month } }, _sum: { discount_aed: true },
}))._sum.discount_aed || 0;

async function certificateHtml(cid, month) {
  const c = await prisma.customer.findUnique({ where: { id: cid } });
  const company = await getSetting('company_name', 'Majari / GreenLoop');
  const from = month + '-01', to = month === ymd().slice(0, 7) ? ymd() : ymd(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)));
  const im = await impactOf(cid, from, to), tier = await tierOf(cid), st = await ratingStats(cid, from);
  const h = s => String(s ?? '').replace(/[&<>"]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
  const label = new Date(from + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const partner = tier.level >= 2;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sustainability certificate ${h(label)}</title>
<style>@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;color:#12312a;background:#eef5f1}
.c{width:297mm;height:210mm;padding:18mm 22mm;background:#fff;margin:auto;position:relative;border:10px solid #0f766e;display:flex;flex-direction:column}
.top{display:flex;justify-content:space-between;align-items:flex-start}.brand{font-size:22px;font-weight:800;color:#0f766e}.brand small{display:block;font-size:11px;color:#5b7a71;font-weight:600}
.badge{border:2px solid #0f766e;color:#0f766e;border-radius:40px;padding:6px 16px;font-weight:800;font-size:13px}
h1{font-size:34px;margin:16mm 0 2mm;letter-spacing:.5px}h2{font-size:26px;margin:2mm 0 8mm;color:#0f766e}
p{font-size:14px;line-height:1.55;margin:0 0 4mm;max-width:220mm}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8mm;margin:6mm 0}
.k{border-top:3px solid #14b8a6;padding-top:3mm}.k b{display:block;font-size:28px}.k span{font-size:12px;color:#5b7a71}
.foot{margin-top:auto;display:flex;justify-content:space-between;font-size:10.5px;color:#5b7a71;gap:20mm}.print{position:fixed;top:10px;right:10px}
@media print{.print{display:none}body{background:#fff}}</style></head><body>
<button class="print" onclick="print()">Print / save as PDF</button>
<div class="c"><div class="top"><div class="brand">GreenLoop<small>${h(company)}</small></div>
${partner ? `<div class="badge">GREEN PARTNER · ${h(tier.name.toUpperCase())}</div>` : ''}</div>
<h1>Sustainability certificate</h1><h2>${h(c.name)}${c.branch ? ' — ' + h(c.branch) : ''}</h2>
<p>In ${h(label)}, ${h(c.name)} had ${im.visits} waste collection${im.visits === 1 ? '' : 's'} with GreenLoop${st.rated ? ` and scored <b>${st.rate}%</b> on waste separation` : ''}. Separating waste at source keeps recyclable material out of landfill.</p>
<div class="grid"><div class="k"><b>${im.visits}</b><span>Collections</span></div><div class="k"><b>${im.diverted_kg.toLocaleString('en')} kg</b><span>Kept out of landfill (est.)</span></div>
<div class="k"><b>${im.co2_kg.toLocaleString('en')} kg</b><span>CO₂e avoided (est.)</span></div><div class="k"><b>${im.trees}</b><span>Trees' yearly CO₂ absorption</span></div></div>
<div class="foot"><span>${h(im.method)}</span><span>Issued ${h(ymd().split('-').reverse().join('/'))}<br>Certificate GL-${cid}-${month.replace('-', '')}</span></div></div></body></html>`;
}

// ═════════════ 3. AI WASTE SCANNER ══════════════════════════
const VOLUMES = ['small', 'medium', 'large'];
const rules = async () => {
  const list = await prisma.wasteScanRule.findMany();
  const pos = (c) => { const i = RULE_ORDER.indexOf(c); return i < 0 ? RULE_ORDER.length : i; };
  return list.sort((a, b) => pos(a.category) - pos(b.category) || (a.category < b.category ? -1 : 1));
};
function aiProvider() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}
const SCAN_PROMPT = cats => `You are helping a waste-collection company in Dubai. Look at the photo of a customer's waste.
Reply with JSON only, no other text, in this exact shape:
{"categories":[{"category":"<one of: ${cats.join(', ')}>","share_pct":<0-100>}],"volume":"<small|medium|large>","summary":"<one short sentence describing what you see>","tips":["<short practical segregation tip>"]}
small = fits in one or two bags or a small bin, medium = one large bin, large = several bins or a pile.
List up to 4 categories, largest first. Give 1 to 3 tips. If the photo does not show waste, return {"categories":[],"volume":"small","summary":"No waste visible","tips":[]}.`;

async function callVision(b64, mime) {
  const cats = (await rules()).map(r => r.category);
  const prompt = SCAN_PROMPT(cats);
  const provider = aiProvider();
  let text = '';
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 600,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }, { type: 'text', text: prompt }] }] }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'AI service error');
    text = (d.content || []).map(c => c.text || '').join('');
  } else if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini', max_tokens: 600, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }] }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'AI service error');
    text = d.choices?.[0]?.message?.content || '';
  } else throw Object.assign(new Error('AI scanning is not set up'), { code: 'AI_OFF' });
  const m = text.match(/\{[\s\S]*\}/);
  return J(m ? m[0] : '', null);
}

// Turns categories + volume into a service, an estimate and tips using the admin-editable rules.
async function estimate(categories, volume, aiTips = []) {
  const R = Object.fromEntries((await rules()).map(r => [r.category, r]));
  const cats = (Array.isArray(categories) ? categories : [])
    .map(c => (typeof c === 'string' ? { category: c, share_pct: null } : c))
    .filter(c => c && R[c.category])
    .slice(0, 4)
    .map(c => ({ category: c.category, label: R[c.category].label, share_pct: c.share_pct == null ? null : clamp(Math.round(Number(c.share_pct) || 0), 0, 100), hazardous: !!R[c.category].hazardous }));
  const vol = VOLUMES.includes(volume) ? volume : 'medium';
  const hazardous = cats.some(c => c.hazardous);
  let code = cats.some(c => R[c.category].service_code === 'WASTE_BULK') || vol === 'large' ? 'WASTE_BULK' : 'WASTE';
  const sel = { code: true, name: true, default_price: true };
  let st = (await prisma.serviceType.findFirst({ where: { code, is_active: 1 }, select: sel }))
    || (await prisma.serviceType.findFirst({ where: { category: 'waste', is_active: 1 }, select: sel, orderBy: [{ default_price: 'asc' }, { id: 'asc' }] }));
  const tips = [...new Set([...(Array.isArray(aiTips) ? aiTips.map(t => String(t).slice(0, 200)) : []), ...cats.map(c => R[c.category].tip)])].filter(Boolean).slice(0, 4);
  return { categories: cats, volume: vol, hazardous, service_code: st ? st.code : code, service_name: st ? st.name : code,
    est_price: st ? money(st.default_price) : null, tips };
}

function saveScanPhoto(b64, mime) {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `scan-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${mime === 'image/png' ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(b64, 'base64'));
    return '/uploads/' + name;
  } catch { return null; }
}
const scanView = s => ({ ...s, categories: J(s.categories, []), tips: J(s.tips, []), hazardous: !!s.hazardous });

async function scanHandler(req, res) {
  const cid = custId(req), b = req.body || {};
  let source = 'manual', summary = '', aiTips = [], categories = b.categories, volume = b.volume, photo = null;
  if (b.image) {
    const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
    if (!m) return res.status(400).json({ error: 'Send a JPEG or PNG photo' });
    if (m[3].length > 1_800_000) return res.status(413).json({ error: 'Photo is too large' });
    if (!aiProvider()) return res.status(503).json({ error: 'AI scanning is not set up yet. Choose your waste types instead.', code: 'AI_OFF' });
    try {
      const out = await callVision(m[3], m[1]);
      if (!out) throw new Error('Could not read the AI reply');
      categories = out.categories; volume = out.volume; summary = String(out.summary || '').slice(0, 300); aiTips = out.tips || [];
      source = 'ai';
      photo = saveScanPhoto(m[3], m[1]);
    } catch (e) {
      console.warn('Waste scan:', e.message);
      return res.status(502).json({ error: 'The scanner could not read this photo. Try again or choose your waste types instead.', code: 'AI_FAIL' });
    }
  }
  const est = await estimate(categories, volume, aiTips);
  if (!est.categories.length) return res.status(422).json({ error: source === 'ai' ? 'No waste could be seen in this photo. Try a clearer photo.' : 'Choose at least one waste type' });
  const scan = await prisma.wasteScan.create({
    data: { customer_id: cid, source, categories: JSON.stringify(est.categories), volume: est.volume, tips: JSON.stringify(est.tips), summary,
      service_code: est.service_code, est_price: est.est_price, hazardous: est.hazardous ? 1 : 0, photo_url: photo },
  });
  res.json({ id: scan.id, source, summary, ...est });
}

// ═════════════ DEMO DATA ═══════════════════════════════════
// Fills Customer health and Green rewards for a sales demo. Every document it adds is
// tagged ([growth-demo] note, DEMO- invoice number, created_by 'demo') so
// clearDemo() removes exactly what was added. Demo pickups are never billable.
const DEMO_TAG = '[growth-demo]';
const daysAgoStamp = (n) => sqlNow(new Date(Date.now() - n * 864e5));        // SQL: datetime('now', '-n days')
async function clearDemo() {
  const ids = (await prisma.pickup.findMany({ where: { notes: DEMO_TAG }, select: { id: true } })).map(r => r.id);
  await prisma.rewardPoint.deleteMany({ where: { OR: [{ created_by: 'demo' }, { pickup_id: { in: ids } }] } });
  await prisma.rewardRedemption.deleteMany({ where: { OR: [{ decided_by: 'demo' }, { note: DEMO_TAG }] } });
  const demoInv = (await prisma.invoice.findMany({ where: { number: { startsWith: 'DEMO-' } }, select: { id: true } })).map(i => i.id);
  await prisma.payment.deleteMany({ where: { invoice_id: { in: demoInv } } });
  await prisma.invoice.deleteMany({ where: { id: { in: demoInv } } });
  await prisma.alert.deleteMany({ where: { pickup_id: { in: ids } } });
  await prisma.pickup.deleteMany({ where: { id: { in: ids } } });
  await prisma.healthScore.updateMany({
    where: { contacted_by: 'Sales team', contact_note: 'Called store manager, agreed extra Thursday pickup' },
    data: { contacted_at: null, contacted_by: null, contact_note: null },
  });
  try { await require('./care').clearCareDemo(); } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; }
  await recalcHealth({ notify: false });
  return { removed_pickups: ids.length };
}
async function seedDemo() {
  await clearDemo();
  const today = ymd();
  const cs = await prisma.customer.findMany({ where: { is_active: 1 }, orderBy: { id: 'asc' } });
  if (cs.length < 8) throw new Error('Add at least 8 active customers first');
  const veh = await prisma.vehicle.findFirst({ where: { is_active: 1 }, select: { id: true }, orderBy: { id: 'asc' } });
  const job = async (c, daysAgo, status, conf = null) => (await prisma.pickup.create({
    data: {
      customer_id: c.id, vehicle_id: veh ? veh.id : null, scheduled_date: addDays(today, -daysAgo), status, confirmation_status: conf,
      completed_at: status === 'pickup' ? null : addDays(today, -daysAgo) + 'T08:30:00.000Z', notes: DEMO_TAG, billable: 0,
      anomaly_reason: status === 'canceled' ? 'CLOSED' : null,
    },
  })).id;
  const inv = (c, n, amount, dueAgo) => prisma.invoice.create({
    data: {
      number: 'DEMO-' + n, customer_id: c.account_id || c.id, period: addDays(today, -dueAgo - 15).slice(0, 7),
      subtotal: money(amount / 1.05), vat: money(amount - amount / 1.05), amount, due_date: addDays(today, -dueAgo), status: 'issued',
    },
  });

  // regular history for everyone: one collected visit every ~10 days over 90 days
  for (const [i, c] of cs.entries()) for (let d = 3 + (i % 4); d <= 88; d += 10) await job(c, d, 'collected');

  // At risk: missed pickups + disputes + overdue invoices
  const risk = cs.slice(1, 4);
  for (const [k, c] of risk.entries()) {
    for (let m = 0; m < 3; m++) await job(c, 4 + m * 9 + k, 'canceled', 'confirmed');
    await job(c, 15 + k, 'canceled', 'disputed');
    await inv(c, `R${k}`, 1260 + k * 420, 12 + k * 5);
    if (k === 0) await inv(c, `R${k}b`, 840, 40);
  }
  // Watch: one or two problems
  const watch = cs.slice(4, 7);
  for (const [k, c] of watch.entries()) {
    for (let m = 0; m < 2; m++) await job(c, 6 + m * 12, 'canceled', 'auto_confirmed');
    if (k === 1) await job(c, 25, 'canceled', 'disputed'); else await inv(c, `W${k}`, 525, 8);
  }
  // Booking drop: steady before, almost nothing in the last month
  const drop = cs[7];
  await prisma.pickup.deleteMany({ where: { customer_id: drop.id, notes: DEMO_TAG, scheduled_date: { gt: addDays(today, -30) } } });
  for (let d = 32; d <= 88; d += 6) await job(drop, d, 'collected');
  await job(drop, 9, 'canceled', 'confirmed');
  await job(drop, 20, 'canceled', 'confirmed');

  await recalcHealth({ notify: false });
  // one account already followed up, to show the follow-up column
  await prisma.healthScore.updateMany({
    where: { customer_id: watch[0].id },
    data: { contacted_at: daysAgoStamp(1), contacted_by: 'Sales team', contact_note: 'Called store manager, agreed extra Thursday pickup' },
  });

  // Green rewards: ratings on this month's demo visits
  const pGood = await pointsFor('good');
  for (const [i, c] of cs.entries()) {
    const visits = await prisma.pickup.findMany({
      where: { customer_id: c.id, notes: DEMO_TAG, status: 'collected', scheduled_date: { gte: addDays(today, -28) } },
      select: { id: true }, orderBy: [{ scheduled_date: 'desc' }, { id: 'asc' }],
    });
    for (const [k, v] of visits.entries()) {
      const rating = risk.includes(c) ? (k % 2 ? 'poor' : 'average') : (i + k) % 5 === 4 ? 'average' : (i + k) % 9 === 8 ? 'poor' : 'good';
      await prisma.pickup.update({ where: { id: v.id }, data: { segregation_rating: rating } });
      const pts = await pointsFor(rating);
      if (pts > 0) await prisma.rewardPoint.create({
        data: { customer_id: c.id, pickup_id: v.id, points: pts, kind: 'earn', reason: `${rating === 'good' ? 'Good' : 'Average'} segregation (demo)`, created_by: 'demo', created_at: daysAgoStamp(k * 6) },
      });
    }
    // a few extra visits this month so the leaderboard has spread
    const extra = (i * 7) % 6;
    for (let k = 0; k < extra && !risk.includes(c); k++) {
      const id = await job(c, 1 + k * 3, 'collected');
      await prisma.pickup.update({ where: { id }, data: { segregation_rating: 'good' } });
      await prisma.rewardPoint.create({ data: { customer_id: c.id, pickup_id: id, points: pGood, kind: 'earn', reason: 'Good segregation (demo)', created_by: 'demo' } });
    }
  }
  // earlier-month points so balances are big enough to redeem
  for (const [i, c] of cs.entries()) if (!risk.includes(c)) await prisma.rewardPoint.create({
    data: { customer_id: c.id, points: 60 + ((i * 37) % 220), kind: 'earn', reason: 'Points from last month (demo)', created_by: 'demo', created_at: daysAgoStamp(40) },
  });
  // the first customer (used for the customer-app demo) can redeem straight away
  await prisma.rewardPoint.create({ data: { customer_id: cs[0].id, points: 320, kind: 'earn', reason: 'Points from last month (demo)', created_by: 'demo', created_at: daysAgoStamp(35) } });

  // reward requests in each state
  const cat = await prisma.rewardCatalog.findMany({ where: { is_active: 1 }, orderBy: [{ points_cost: 'asc' }, { id: 'asc' }] });
  const redeem = async (c, rw, status) => {
    await prisma.rewardRedemption.create({
      data: { customer_id: c.id, reward_id: rw.id, reward_name: rw.name, points: rw.points_cost, discount_aed: rw.discount_aed, status, note: DEMO_TAG,
        decided_by: status === 'requested' ? null : 'demo', decided_at: status === 'requested' ? null : new Date().toISOString() },
    });
    await prisma.rewardPoint.create({ data: { customer_id: c.id, points: -rw.points_cost, kind: 'redeem', reason: `Redeemed: ${rw.name}`, created_by: 'demo' } });
    await prisma.rewardPoint.create({ data: { customer_id: c.id, points: rw.points_cost, kind: 'adjust', reason: 'Demo points for this request', created_by: 'demo' } });
  };
  if (cat.length) {
    await redeem(cs[9 % cs.length], cat[0], 'requested');
    await redeem(cs[12 % cs.length], cat[Math.min(1, cat.length - 1)], 'requested');
    await redeem(cs[15 % cs.length], cat[0], 'approved');
    await redeem(cs[18 % cs.length], cat[Math.min(1, cat.length - 1)], 'applied');
  }
  try { await require('./care').seedCareDemo(cs, { risk, watch, drop, job }); await recalcHealth({ notify: false }); } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; }
  const bands = await prisma.healthScore.groupBy({ by: ['band'], _count: { _all: true } });
  return { ok: true, health: Object.fromEntries(bands.map(r => [r.band, r._count._all])), demo_customer: `${cs[0].name} (${cs[0].branch || ''})` };
}

// ═════════════ ROUTES ═══════════════════════════════════════
function mountGrowthRoutes(r, io) {
  // ── Demo data (owner) ──
  r.post('/growth/demo', owner, async (req, res) => {
    try { const out = await seedDemo(); if (io) io.to('staff').emit('rewards:changed', {}); res.json(out); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.delete('/growth/demo', owner, async (req, res) => res.json({ ok: true, ...(await clearDemo()) }));
  r.get('/growth/demo', staff, async (req, res) => res.json({ loaded: !!(await prisma.pickup.findFirst({ where: { notes: DEMO_TAG }, select: { id: true } })) }));

  // ── Health score ──
  r.get('/health-scores', staff, async (req, res) => {
    if (!(await getSetting('health_last_run', ''))) await recalcHealth({ notify: false });
    let rows = await prisma.healthScore.findMany();
    rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone', 'contact_phone', 'is_active'], { inner: true });
    rows = sortBy(rows.filter(h => h.is_active === 1), h => h.score, h => h.name)
      .map(({ is_active, ...h }) => ({ ...h, reasons: J(h.reasons, []), factors: J(h.factors, {}), band_label: BAND_LABEL[h.band] }));
    const summary = { healthy: 0, watch: 0, at_risk: 0 };
    rows.forEach(h => { summary[h.band]++; });
    res.json({ rows, summary, last_run: await getSetting('health_last_run', null) });
  });
  r.post('/health-scores/recalculate', staff, async (req, res) => res.json({ ok: true, ...(await recalcHealth()) }));
  r.post('/health-scores/:id/contacted', staff, async (req, res) => {
    const cid = toId(req.params.id);
    const h = cid ? await prisma.healthScore.findUnique({ where: { customer_id: cid } }) : null;
    if (!h) return res.status(404).json({ error: 'Not found' });
    const note = String((req.body || {}).note || '').slice(0, 500);
    await prisma.healthScore.update({ where: { customer_id: h.customer_id }, data: { contacted_at: sqlNow(), contacted_by: String(req.user.name || 'staff'), contact_note: note } });
    res.json({ ok: true });
  });

  // ── Rewards: driver ──
  r.post('/pickups/:id/segregation', driver, async (req, res) => {
    const rating = String((req.body || {}).rating || '');
    if (!RATINGS.includes(rating)) return res.status(400).json({ error: 'Rating must be good, average or poor' });
    const p = await findById('pickup', req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const denied = security.driverJobError(p, req.user);
    if (denied) return res.status(denied[0]).json({ error: denied[1] });
    const out = await rateSegregation(p.id, rating, req.user.name);
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (io && out.points) io.to('staff').emit('rewards:changed', {});
    res.json(out);
  });

  // ── Rewards: customer ──
  r.get('/customer/rewards', cust, async (req, res) => {
    const cid = custId(req);
    const discounts = await discountsOn();
    // COALESCE(kind,'perk'); perks first, then by points (ORDER BY kind='discount', points_cost)
    let catalog = (await prisma.rewardCatalog.findMany({ where: { is_active: 1 }, select: { id: true, name: true, points_cost: true, discount_aed: true, kind: true, description: true }, orderBy: { id: 'asc' } }))
      .map(x => ({ ...x, kind: x.kind ?? 'perk' }));
    if (!discounts) catalog = catalog.filter(x => x.kind === 'perk');
    sortBy(catalog, x => (x.kind === 'discount' ? 1 : 0), x => x.points_cost);
    res.json({
      balance: await balanceOf(cid), earned_this_month: await earnedThisMonth(cid), monthly_cap: Number(await getSetting('rewards_monthly_cap', '200')) || 0,
      points: { good: await pointsFor('good'), average: await pointsFor('average'), poor: await pointsFor('poor') },
      history: await prisma.rewardPoint.findMany({ where: { customer_id: cid }, select: { points: true, kind: true, reason: true, created_at: true }, orderBy: { id: 'desc' }, take: 20 }),
      catalog,
      tier: await tierOf(cid), tiers: TIERS.map(t => ({ name: t.name, min_rate: t.min_rate, min_visits: t.min_visits, perks: t.perks })),
      ...(await badgesOf(cid)), impact: await impactOf(cid, ymd().slice(0, 7) + '-01', ymd()), impact_year: await impactOf(cid, addDays(ymd(), -365), ymd()),
      redemptions: await prisma.rewardRedemption.findMany({ where: { customer_id: cid }, select: { id: true, reward_name: true, points: true, discount_aed: true, status: true, created_at: true }, orderBy: { id: 'desc' }, take: 10 }),
      leaderboard: await leaderboard(cid),
    });
  });
  r.post('/customer/rewards/redeem', cust, async (req, res) => {
    const cid = custId(req);
    const rid = toId((req.body || {}).reward_id);
    const rw = rid ? await prisma.rewardCatalog.findFirst({ where: { id: rid, is_active: 1 } }) : null;
    if (!rw) return res.status(404).json({ error: 'Reward not found' });
    if ((rw.kind || 'perk') === 'discount') {
      if (!(await discountsOn())) return res.status(409).json({ error: 'This reward is not available right now' });
      const budget = Number(await getSetting('rewards_monthly_budget_aed', '0')) || 0;
      if (budget > 0 && (await discountSpent(ymd().slice(0, 7))) + rw.discount_aed > budget) return res.status(409).json({ error: 'This month\'s discount rewards are all taken. Try again next month or choose another reward.' });
    }
    const bal = await balanceOf(cid);
    if (bal < rw.points_cost) return res.status(409).json({ error: `You need ${rw.points_cost - bal} more points for this reward` });
    const red = await prisma.rewardRedemption.create({ data: { customer_id: cid, reward_id: rw.id, reward_name: rw.name, points: rw.points_cost, discount_aed: rw.discount_aed } });
    await prisma.rewardPoint.create({ data: { customer_id: cid, points: -rw.points_cost, kind: 'redeem', reason: `Redeemed: ${rw.name}`, created_by: 'customer' } });
    const c = await prisma.customer.findUnique({ where: { id: cid }, select: { name: true, branch: true } });
    try { await v3.alertCrm('REWARD', 'info', `Reward request: ${c.name} (${c.branch || ''}) — ${rw.name}`); } catch { /* ignore */ }
    if (io) io.to('staff').emit('rewards:changed', {});
    res.json({ ok: true, id: red.id, balance: await balanceOf(cid) });
  });

  // ── Sustainability certificate (customer, or office for any customer) ──
  const certMonth = m => (/^\d{4}-\d{2}$/.test(String(m || '')) && m <= ymd().slice(0, 7) ? m : ymd().slice(0, 7));
  r.get('/customer/certificate', cust, async (req, res) => res.type('html').send(await certificateHtml(custId(req), certMonth(req.query.month))));
  r.get('/customers/:id/certificate', staff, async (req, res) => {
    if (!(await findById('customer', req.params.id, { select: { id: true } }))) return res.status(404).send('Not found');
    res.type('html').send(await certificateHtml(Number(req.params.id), certMonth(req.query.month)));
  });

  // ── Rewards: office ──
  r.get('/rewards/overview', staff, async (req, res) => {
    const month = ymd().slice(0, 7);
    // requested first, then approved, then newest
    let redemptions = await join(await prisma.rewardRedemption.findMany(), 'customer_id', 'customer', ['name', 'branch'], { inner: true });
    redemptions = sortBy(redemptions, desc(x => (x.status === 'requested' ? 1 : 0)), desc(x => (x.status === 'approved' ? 1 : 0)), desc(x => x.id)).slice(0, 200);
    const earnedG = await prisma.rewardPoint.groupBy({ by: ['customer_id'], where: { kind: 'earn', created_at: { startsWith: month } }, _sum: { points: true } });
    const top = (await join(earnedG.map(g => ({ id: g.customer_id, points: g._sum.points || 0 })), 'id', 'customer', ['name', 'branch', 'zone'], { inner: true }))
      .sort((a2, b2) => b2.points - a2.points).slice(0, 10).map(x => ({ id: x.id, name: x.name, branch: x.branch, zone: x.zone, points: x.points }));
    const monthJobs = await prisma.pickup.findMany({ where: { scheduled_date: { startsWith: month } }, select: { segregation_rating: true, status: true } });
    const nRating = (r2) => monthJobs.filter(p => p.segregation_rating === r2).length;
    const ratings = monthJobs.length
      ? { good: nRating('good'), average: nRating('average'), poor: nRating('poor'), unrated: monthJobs.filter(p => p.segregation_rating == null && p.status === 'collected').length }
      : { good: null, average: null, poor: null, unrated: null };   // SUM over no rows is NULL
    const active = await prisma.customer.findMany({ where: { is_active: 1 }, select: { id: true }, orderBy: { id: 'asc' } });
    const n = { seedling: 0, sapling: 0, tree: 0, forest: 0 };
    for (const c of active) n[(await tierOf(c.id)).key]++;
    const impact = { diverted_kg: 0, co2_kg: 0, visits: 0 };
    for (const c of active) { const i = await impactOf(c.id, month + '-01', ymd()); impact.diverted_kg += i.diverted_kg; impact.co2_kg += i.co2_kg; impact.visits += i.visits; }
    res.json({
      redemptions,
      catalog: await prisma.rewardCatalog.findMany({ orderBy: [{ is_active: 'desc' }, { points_cost: 'asc' }, { id: 'asc' }] }),
      settings: { good: await pointsFor('good'), average: await pointsFor('average'), poor: await pointsFor('poor'), monthly_cap: Number(await getSetting('rewards_monthly_cap', '200')) || 0 },
      top,
      ratings,
      issued_this_month: await sumPoints({ kind: 'earn', created_at: { startsWith: month } }),
      tiers: TIERS.map(t => ({ key: t.key, name: t.name, sites: n[t.key], perks: t.perks, min_rate: t.min_rate, min_visits: t.min_visits })),
      discounts: { enabled: await discountsOn(), budget_aed: Number(await getSetting('rewards_monthly_budget_aed', '0')) || 0, spent_aed: money(await discountSpent(month)) },
      impact,
      impact_factors: { kg_per_visit: Number(await getSetting('impact_kg_per_visit', '120')), co2_per_kg: Number(await getSetting('impact_co2_per_kg', '0.7')) },
    });
  });
  r.post('/rewards/redemptions/:id/decide', owner, async (req, res) => {
    const rr = await findById('rewardRedemption', req.params.id);
    if (!rr) return res.status(404).json({ error: 'Not found' });
    const action = String((req.body || {}).action || '');
    const next = { approve: 'approved', reject: 'rejected', applied: 'applied' }[action];
    if (!next) return res.status(400).json({ error: 'Action must be approve, reject or applied' });
    const allowed = { requested: ['approved', 'rejected'], approved: ['applied', 'rejected'] }[rr.status] || [];
    if (!allowed.includes(next)) return res.status(409).json({ error: `This request is already ${rr.status}` });
    const note = String((req.body || {}).note || '').slice(0, 300);
    await prisma.rewardRedemption.update({ where: { id: rr.id }, data: { status: next, note, decided_by: String(req.user.name || 'owner'), decided_at: sqlNow() } });
    if (next === 'rejected') {
      await prisma.rewardPoint.create({ data: { customer_id: rr.customer_id, points: rr.points, kind: 'refund', reason: `Returned: ${rr.reward_name}${note ? ' (' + note + ')' : ''}`, created_by: String(req.user.name || 'owner') } });
      await v3.notifyCustomer(rr.customer_id, 'rewards', 'Reward request declined', `${rr.reward_name}: your ${rr.points} points were returned.${note ? ' ' + note : ''}`, '/customer/#home');
    } else if (next === 'approved') {
      await v3.notifyCustomer(rr.customer_id, 'rewards', 'Reward approved', rr.discount_aed > 0 ? `${rr.reward_name} will be taken off your next invoice.` : `${rr.reward_name}: our team will be in touch to arrange it.`, '/customer/#home');
    }
    res.json({ ok: true, status: next });
  });
  r.post('/rewards/catalog', owner, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120), cost = Math.round(Number(b.points_cost)), disc = money(b.discount_aed);
    if (!name || !(cost > 0) || !(disc >= 0)) return res.status(400).json({ error: 'Name, points (above 0) and discount are required' });
    const kind = disc > 0 ? 'discount' : 'perk';
    const rw = await prisma.rewardCatalog.create({ data: { name, points_cost: cost, discount_aed: disc, kind, description: String(b.description || '').slice(0, 300) } });
    res.json({ ok: true, id: rw.id });
  });
  r.put('/rewards/catalog/:id', owner, async (req, res) => {
    const rw = await findById('rewardCatalog', req.params.id);
    if (!rw) return res.status(404).json({ error: 'Not found' });
    const b = { ...rw, ...(req.body || {}) };
    const cost = Math.round(Number(b.points_cost)), disc = money(b.discount_aed);
    if (!String(b.name || '').trim() || !(cost > 0) || !(disc >= 0)) return res.status(400).json({ error: 'Name, points (above 0) and discount are required' });
    await prisma.rewardCatalog.update({
      where: { id: rw.id },
      data: { name: String(b.name).trim().slice(0, 120), points_cost: cost, discount_aed: disc, is_active: b.is_active ? 1 : 0, kind: disc > 0 ? 'discount' : 'perk', description: String(b.description || '').slice(0, 300) },
    });
    res.json({ ok: true });
  });
  r.put('/rewards/settings', owner, async (req, res) => {
    const b = req.body || {};
    for (const k of ['good', 'average', 'poor']) if (b[k] != null && !(Number(b[k]) >= 0 && Number(b[k]) <= 1000)) return res.status(400).json({ error: `Points for ${k} must be 0 to 1000` });
    if (b.monthly_cap != null && !(Number(b.monthly_cap) >= 0)) return res.status(400).json({ error: 'Monthly cap must be 0 or more (0 = no cap)' });
    for (const k of ['good', 'average', 'poor']) if (b[k] != null) await setSetting('rewards_points_' + k, String(Math.round(Number(b[k]))));
    if (b.monthly_cap != null) await setSetting('rewards_monthly_cap', String(Math.round(Number(b.monthly_cap))));
    if (b.discounts_enabled != null) await setSetting('rewards_discounts_enabled', b.discounts_enabled ? '1' : '0');
    if (b.budget_aed != null) { if (!(Number(b.budget_aed) >= 0)) return res.status(400).json({ error: 'Budget must be 0 or more' }); await setSetting('rewards_monthly_budget_aed', String(money(b.budget_aed))); }
    if (b.kg_per_visit != null) { if (!(Number(b.kg_per_visit) > 0)) return res.status(400).json({ error: 'Kg per visit must be above 0' }); await setSetting('impact_kg_per_visit', String(Number(b.kg_per_visit))); }
    if (b.co2_per_kg != null) { if (!(Number(b.co2_per_kg) >= 0)) return res.status(400).json({ error: 'CO2 factor must be 0 or more' }); await setSetting('impact_co2_per_kg', String(Number(b.co2_per_kg))); }
    res.json({ ok: true });
  });

  // ── Waste scanner: customer ──
  r.get('/customer/scan/options', cust, async (req, res) => res.json({
    ai: !!aiProvider(), volumes: VOLUMES, categories: (await rules()).map(x => ({ category: x.category, label: x.label, hazardous: !!x.hazardous })),
  }));
  r.post('/customer/scan', cust, scanHandler);
  r.post('/customer/scans/:id/request-quote', cust, async (req, res) => {
    const cid = custId(req);
    const sid = toId(req.params.id);
    const s = sid ? await prisma.wasteScan.findFirst({ where: { id: sid, customer_id: cid } }) : null;
    if (!s) return res.status(404).json({ error: 'Scan not found' });
    if (s.lead_id) return res.json({ ok: true, lead_id: s.lead_id, already: true });
    const c = await prisma.customer.findUnique({ where: { id: cid } });
    const sv = scanView(s);
    const note = String((req.body || {}).note || '').slice(0, 500);
    const lines = [
      `Quote request from the customer app (waste scan #${s.id}${s.source === 'ai' ? ', AI' : ', chosen by customer'}).`,
      `Existing customer: ${c.name}${c.branch ? ' — ' + c.branch : ''} (#${c.id}).`,
      `Waste: ${sv.categories.map(x => x.label + (x.share_pct != null ? ` ${x.share_pct}%` : '')).join(', ')}. Volume: ${s.volume}.`,
      s.summary ? `Seen in photo: ${s.summary}` : '',
      sv.hazardous ? 'SPECIAL HANDLING: hazardous or electronic waste.' : '',
      s.est_price != null ? `App estimate: AED ${Number(s.est_price).toFixed(2)} per visit + VAT (${s.service_code}).` : '',
      note ? `Customer note: ${note}` : '',
    ].filter(Boolean).join('\n');
    const site = [{ name: c.branch || c.name, zone: c.zone, lat: c.lat, lng: c.lng, address: c.address || '' }];
    const lead = await prisma.lead.create({
      data: { contact: c.name, company: c.name, phone: c.contact_phone || '', email: c.email || '', service_type: s.service_code || 'WASTE', sites: JSON.stringify(site),
        frequency: '', source: 'ai_scan', stage: 'new', follow_up_at: addDays(ymd(), 1), notes: lines },
    });
    const leadId = lead.id;
    await prisma.wasteScan.update({ where: { id: s.id }, data: { lead_id: leadId } });
    try { await v3.alertCrm('QUOTE_REQUEST', sv.hazardous ? 'warning' : 'info', `Quote request from ${c.name} (${c.branch || ''}) via waste scan${sv.hazardous ? ' — special handling' : ''}`); } catch { /* ignore */ }
    if (io) io.to('staff').emit('lead:changed', {});
    res.json({ ok: true, lead_id: leadId });
  });

  // ── Waste scanner: office ──
  r.get('/waste-scans', staff, async (req, res) => {
    let rows = await prisma.wasteScan.findMany({ orderBy: { id: 'desc' } });
    rows = await join(rows, 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true });
    rows = (await join(rows.slice(0, 200), 'lead_id', 'lead', { lead_stage: 'stage' })).map(scanView);
    res.json({
      rows,
      rules: (await rules()).map(x => ({ ...x, hazardous: !!x.hazardous })),
      services: await prisma.serviceType.findMany({ where: { is_active: 1, category: 'waste' }, select: { code: true, name: true, default_price: true }, orderBy: { name: 'asc' } }),
      ai: aiProvider(),
    });
  });
  r.put('/waste-scan-rules/:category', owner, async (req, res) => {
    const rule = await prisma.wasteScanRule.findUnique({ where: { category: String(req.params.category) } });
    if (!rule) return res.status(404).json({ error: 'Not found' });
    const b = { ...rule, ...(req.body || {}) };
    if (typeof b.service_code !== 'string' || !(await prisma.serviceType.findUnique({ where: { code: b.service_code }, select: { code: true } }))) return res.status(400).json({ error: 'Unknown service' });
    await prisma.wasteScanRule.update({
      where: { category: rule.category },
      data: { label: String(b.label || rule.label).slice(0, 80), service_code: b.service_code, hazardous: b.hazardous ? 1 : 0, tip: String(b.tip || '').slice(0, 300) },
    });
    res.json({ ok: true });
  });
}

// Mounted ahead of the global text-length guard in index.js (the photo is a long data URL).
const scanRoute = [cust, scanHandler];

module.exports = { init, mountGrowthRoutes, recalcCustomer, tierOf, impactOf, badgesOf, TIERS, seedDemo, clearDemo, scanRoute, startHealth, recalcHealth, scoreCustomer, rateSegregation, estimate, leaderboard };
