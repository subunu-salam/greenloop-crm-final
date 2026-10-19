// ─────────────────────────────────────────────────────────────
// GreenLoop customer care (v3.7, add-on)
//   1. Issues          customers report a problem (optionally on a visit, with a
//                      photo); office replies, sets status; response target by tier
//   2. Visit history   every visit grouped: completed, upcoming, missed, cancelled
//                      (awaiting / confirmed), disputed, rescheduled
//   3. Health follow-up contact status, method, follow-up date and a contact log
// MongoDB through Prisma like the rest of the server (see server/db.js).
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const security = require('./security');
const { prisma, join, findById, toId, sortBy, desc, now: sqlNow } = require('./db');
const v3 = require('./v3');
const growth = require('./growth');

security.ensureSecret();
const SECRET = process.env.JWT_SECRET;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const nowIso = () => new Date().toISOString();
// timestamps are ISO from JS or 'YYYY-MM-DD HH:MM:SS' (UTC) from the database defaults
const toMs = s => Date.parse(String(s || '').includes('T') ? s : String(s || '').replace(' ', 'T') + 'Z');

const need = (...roles) => (req, res, next) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  let p = null;
  try { p = t ? jwt.verify(t, SECRET) : null; } catch { p = null; }
  if (!p) return res.status(401).json({ error: 'Missing or invalid token' });
  const eff = p.role === 'admin' ? (p.crm_role === 'ops' ? 'ops' : 'admin') : p.role;
  if (!roles.includes(eff)) return res.status(403).json({ error: 'Your role cannot do this' });
  req.user = { ...p, eff };
  next();
};
const staff = need('admin', 'ops');
const cust = need('customer');
const custId = req => Number(req.user.customer_id || req.user.id);
// every site id in the same customer account as `cid`
const accountSites = async cid => {
  const id = toId(cid);
  const c = id ? await prisma.customer.findUnique({ where: { id }, select: { id: true, account_id: true } }) : null;
  if (!c) return [cid];
  const acct = c.account_id || c.id;
  return (await prisma.customer.findMany({ where: { OR: [{ id: acct }, { account_id: acct }] }, select: { id: true }, orderBy: { id: 'asc' } })).map(x => x.id);
};
// (collections customer_issues, issue_messages, health_contacts — see prisma/schema.prisma)

// ═════════════ 1. ISSUES ════════════════════════════════════
const ISSUE_CATS = {
  missed_pickup: { label: 'Pickup was missed', priority: 'high' },
  mess: { label: 'Waste or mess left behind', priority: 'high' },
  driver: { label: 'Driver behaviour', priority: 'normal' },
  bin: { label: 'Damaged or missing bin', priority: 'normal' },
  billing: { label: 'Question about a bill', priority: 'normal' },
  schedule: { label: 'Change my pickup schedule', priority: 'normal' },
  other: { label: 'Something else', priority: 'normal' },
};
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
async function issueView(i, withMessages = true) {
  const now = nowIso();
  return {
    ...i, category_label: (ISSUE_CATS[i.category] || {}).label || i.category, status_label: STATUS_LABEL[i.status],
    overdue: i.status !== 'resolved' && !i.first_response_at && toMs(i.due_at) < Date.parse(now),
    messages: withMessages ? await prisma.issueMessage.findMany({ where: { issue_id: i.id }, select: { author_role: true, author_name: true, body: true, created_at: true }, orderBy: { id: 'asc' } }) : undefined,
  };
}
const issueViews = async (rows, withMessages) => { const out = []; for (const r of rows) out.push(await issueView(r, withMessages)); return out; };
function savePhoto(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Send a JPEG or PNG photo' };
  if (m[3].length > 1_800_000) return { error: 'Photo is too large' };
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `issue-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${m[1] === 'image/png' ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[3], 'base64'));
    return { url: '/uploads/' + name };
  } catch { return { error: 'Could not save the photo' }; }
}
let IO = null;
async function createIssue(cid, b, { demo = false, createdAt = null } = {}) {
  const cat = ISSUE_CATS[b.category] ? b.category : null;
  if (!cat) return { status: 400, error: 'Choose what the issue is about' };
  const desc = String(b.description || '').trim();
  if (desc.length < 5) return { status: 400, error: 'Tell us a little more about the issue' };
  let pickupId = null;
  if (b.pickup_id) {
    const p = await findById('pickup', b.pickup_id, { select: { id: true, customer_id: true } });
    if (!p || !(await accountSites(cid)).includes(p.customer_id)) return { status: 404, error: 'Visit not found' };
    pickupId = p.id;
  }
  let photo = null;
  if (b.image) { const s = savePhoto(b.image); if (s.error) return { status: 400, error: s.error }; photo = s.url; }
  const tier = await growth.tierOf(cid);
  const created = createdAt || nowIso();
  const due = new Date(Date.parse(created) + tier.response_h * 3600e3).toISOString();
  const issue = await prisma.customerIssue.create({
    data: { customer_id: cid, pickup_id: pickupId, category: cat, description: desc.slice(0, 1500), photo_url: photo, priority: ISSUE_CATS[cat].priority,
      response_h: tier.response_h, due_at: due, is_demo: demo ? 1 : 0, created_at: created, updated_at: created },
  });
  const id = issue.id;
  if (!demo) {
    const c = await prisma.customer.findUnique({ where: { id: cid }, select: { name: true, branch: true } });
    try { await v3.alertCrm('ISSUE', ISSUE_CATS[cat].priority === 'high' ? 'warning' : 'info', `New issue from ${c.name} (${c.branch || ''}): ${ISSUE_CATS[cat].label}`); } catch { /* ignore */ }
    if (IO) IO.to('staff').emit('issues:changed', { id });
  }
  return { status: 200, ok: true, id, response_h: tier.response_h };
}

// ═════════════ 2. VISIT HISTORY ═════════════════════════════
const CAT_LABEL = {
  completed: 'Completed', upcoming: 'Upcoming', missed: 'Missed', awaiting: 'Not picked up — please confirm',
  cancelled: 'Not picked up — confirmed', disputed: 'Disputed', rescheduled: 'Rescheduled',
};
const REASON = { CLOSED: 'Site was closed', NO_ACCESS: 'No access to the bins', NO_WASTE: 'No waste to collect', CUSTOMER_REFUSED: 'Service refused on site',
  BIN_EMPTY: 'Bin empty', ACCESS_BLOCKED: 'Access blocked', MANAGER_REFUSED: 'Manager refused' };
function visitCategory(p, today = ymd()) {
  if (p.status === 'rescheduled') return 'rescheduled';
  if (p.status === 'collected') return 'completed';
  if (p.status === 'overdue') return 'missed';
  if (p.status === 'pending') return p.scheduled_date < today ? 'missed' : 'upcoming';
  if (p.status === 'canceled') {
    if (p.confirmation_status === 'awaiting') return 'awaiting';
    if (p.confirmation_status === 'disputed') return 'disputed';
    return 'cancelled';
  }
  return 'upcoming';
}
function visitDetail(p, cat) {
  if (cat === 'completed') return p.completed_at ? `Done at ${String(p.completed_at).slice(11, 16)}` + (p.segregation_rating ? ` · separation: ${p.segregation_rating === 'average' ? 'OK' : p.segregation_rating}` : '') : 'Done';
  if (cat === 'rescheduled') { const m = /moved to (\d{4}-\d{2}-\d{2})/.exec(p.notes || ''); return m ? `Moved to ${m[1].split('-').reverse().join('/')}` : 'Moved to another day'; }
  if (['awaiting', 'cancelled', 'disputed'].includes(cat)) return REASON[p.anomaly_reason] || String(p.anomaly_reason || 'Not picked up').replace(/_/g, ' ').toLowerCase();
  if (cat === 'missed') return 'The crew did not reach the site';
  if (cat === 'upcoming') return p.time_window ? `Between ${p.time_window.replace('-', ' and ')}` : 'Scheduled';
  return '';
}
async function visitHistory(siteIds, { from, to, category } = {}) {
  const today = ymd();
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : addDays(today, -90);
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : addDays(today, 30);
  const ids = siteIds.map(Number).filter(Number.isInteger);
  let rows = await prisma.pickup.findMany({
    where: { customer_id: { in: ids }, scheduled_date: { gte: f, lte: t } },
    select: { id: true, customer_id: true, scheduled_date: true, status: true, confirmation_status: true, anomaly_reason: true, completed_at: true, photo_url: true,
      notes: true, time_window: true, segregation_rating: true, service_type: true, driver_id: true },
    orderBy: [{ scheduled_date: 'desc' }, { id: 'desc' }], take: 500,
  });
  rows = await join(rows, 'customer_id', 'customer', ['branch', 'name'], { inner: true });
  rows = await join(rows, 'driver_id', 'user', { driver_name: 'full_name' });
  rows = await join(rows, 'service_type', 'serviceType', { service_name: 'name' }, { key: 'code' });
  // newest issue raised on each visit (was a sub-query per row)
  const issues = await prisma.customerIssue.findMany({ where: { pickup_id: { in: rows.map(r => r.id) } }, select: { id: true, pickup_id: true }, orderBy: { id: 'asc' } });
  const issueOf = new Map(issues.map(i => [i.pickup_id, i.id]));
  rows.forEach(r => { r.issue_id = issueOf.get(r.id) ?? null; });
  const summary = Object.fromEntries(Object.keys(CAT_LABEL).map(k => [k, 0]));
  const out = rows.map(p => { const cat = visitCategory(p, today); summary[cat]++;
    return { id: p.id, site_id: p.customer_id, branch: p.branch, date: p.scheduled_date, category: cat, label: CAT_LABEL[cat], detail: visitDetail(p, cat),
      driver: p.driver_name, service: p.service_name || p.service_type, photo_url: p.photo_url, segregation: p.segregation_rating, issue_id: p.issue_id }; });
  const done = summary.completed, due = done + summary.missed + summary.cancelled + summary.awaiting + summary.disputed;
  return { from: f, to: t, summary, reliability: due ? Math.round(100 * done / due) : null,
    rows: category && CAT_LABEL[category] ? out.filter(r => r.category === category) : out };
}

// ═════════════ 3. HEALTH FOLLOW-UP ══════════════════════════
const CONTACT_STATUS = { not_contacted: 'Not contacted', contacted: 'Contacted', follow_up: 'Follow-up scheduled', resolved: 'Resolved' };
const METHODS = { call: 'Phone call', whatsapp: 'WhatsApp', visit: 'Site visit', email: 'Email' };
async function logContact(cid, b, by, { demo = false, at = null } = {}) {
  const status = CONTACT_STATUS[b.contact_status] ? b.contact_status : 'contacted';
  const method = METHODS[b.method] ? b.method : 'call';
  if (status === 'follow_up' && !(b.follow_up_at && /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_at))) return { status: 400, error: 'Choose a follow-up date' };
  const follow = status === 'follow_up' ? b.follow_up_at : null;
  const note = String(b.note || '').slice(0, 600);
  const stamp = at || nowIso().replace('T', ' ').slice(0, 19);
  await prisma.healthContact.create({
    data: { customer_id: cid, method, note, contact_status: status, follow_up_at: follow, by_name: by == null ? null : String(by), is_demo: demo ? 1 : 0, created_at: stamp },
  });
  // contacted_at = COALESCE(new, contacted_at): only overwritten when this contact really happened
  await prisma.healthScore.updateMany({
    where: { customer_id: cid },
    data: { contact_status: status, follow_up_at: follow, ...(status === 'not_contacted' ? {} : { contacted_at: stamp }), contacted_by: by == null ? null : String(by), contact_note: note },
  });
  return { status: 200, ok: true };
}

// ═════════════ DEMO EXTRAS (called from growth.seedDemo) ════
async function clearCareDemo() {
  const ids = (await prisma.customerIssue.findMany({ where: { is_demo: 1 }, select: { id: true } })).map(r => r.id);
  if (ids.length) await prisma.issueMessage.deleteMany({ where: { issue_id: { in: ids } } });
  await prisma.customerIssue.deleteMany({ where: { is_demo: 1 } });
  const cids = (await prisma.healthContact.findMany({ where: { is_demo: 1 }, select: { customer_id: true }, distinct: ['customer_id'] })).map(r => r.customer_id);
  await prisma.healthContact.deleteMany({ where: { is_demo: 1 } });
  for (const id of cids) {
    const last = await prisma.healthContact.findFirst({ where: { customer_id: id }, orderBy: { id: 'desc' } });
    await prisma.healthScore.updateMany({
      where: { customer_id: id },
      data: { contact_status: last ? last.contact_status : null, follow_up_at: last ? last.follow_up_at : null, contacted_at: last ? last.created_at : null,
        contacted_by: last ? last.by_name : null, contact_note: last ? last.note : null },
    });
  }
}
async function seedCareDemo(cs, { risk, watch, drop, job }) {
  const today = ymd();
  const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
  const T = '[growth-demo]';
  // a rich visit history for the customer-app demo site: upcoming, missed, awaiting, rescheduled
  const c0 = cs[0];
  const ins = async (date, status, extra = {}) => (await prisma.pickup.create({
    data: { customer_id: c0.id, scheduled_date: date, status, confirmation_status: extra.conf || null, anomaly_reason: extra.reason || null, time_window: extra.win || null, notes: T, billable: 0 },
  })).id;
  await ins(addDays(today, 3), 'pending', { win: '07:00-12:00' });
  await ins(addDays(today, 10), 'pending', { win: '07:00-12:00' });
  await ins(addDays(today, -8), 'overdue');
  const npu = await ins(addDays(today, -2), 'canceled', { conf: 'awaiting', reason: 'NO_ACCESS' });
  await prisma.pickup.update({ where: { id: npu }, data: { confirm_deadline: new Date(Date.now() + 20 * 3600e3).toISOString() } });
  await ins(addDays(today, -26), 'canceled', { conf: 'confirmed', reason: 'CLOSED' });
  await ins(addDays(today, -19), 'rescheduled');
  // issues in every state
  const missedVisit = await prisma.pickup.findFirst({ where: { customer_id: c0.id, status: 'overdue', notes: T }, select: { id: true }, orderBy: { id: 'desc' } });
  const stamp = (h) => ago(h).replace('T', ' ').slice(0, 19);
  const mk = async (c, b, hoursAgo, status, replies = []) => {
    const r = await createIssue(c.id, b, { demo: true, createdAt: ago(hoursAgo) });
    if (!r.ok) return;
    await prisma.issueMessage.create({ data: { issue_id: r.id, author_role: 'customer', author_name: c.name, body: b.description, created_at: stamp(hoursAgo) } });
    for (const [h, txt] of replies) await prisma.issueMessage.create({ data: { issue_id: r.id, author_role: 'staff', author_name: 'GreenLoop team', body: txt, created_at: stamp(h) } });
    await prisma.customerIssue.update({
      where: { id: r.id },
      data: { status, first_response_at: replies.length ? ago(replies[0][0]) : null, resolved_at: status === 'resolved' ? ago(replies[replies.length - 1][0]) : null,
        updated_at: ago(replies.length ? replies[replies.length - 1][0] : hoursAgo) },
    });
  };
  await mk(c0, { category: 'missed_pickup', description: 'Nobody came for the pickup last week, bins were overflowing by the evening.', pickup_id: missedVisit && missedVisit.id }, 30, 'in_progress',
    [[26, 'Sorry about this. The truck broke down that morning. We have added a free extra pickup for you this Thursday.']]);
  await mk(risk[0], { category: 'mess', description: 'The crew left cardboard and spilled liquid at the back gate after the pickup.' }, 40, 'open');
  await mk(risk[1], { category: 'billing', description: 'We were charged for a visit on a day the store was closed.' }, 6, 'open');
  await mk(watch[1], { category: 'driver', description: 'Driver was rude to our store manager when asked to wait 5 minutes.' }, 70, 'resolved',
    [[60, 'Thank you for telling us. We have spoken to the driver and apologise.'], [58, 'We have also moved your pickup to the morning slot as you asked.']]);
  await mk(cs[8 % cs.length], { category: 'bin', description: 'One of our two bins has a broken lid.' }, 120, 'resolved', [[100, 'Replacement bin delivered today.']]);
  // follow-up workflow
  const at = h => stamp(h);
  await logContact(risk[0].id, { method: 'call', contact_status: 'follow_up', follow_up_at: today, note: 'Manager unhappy about missed pickups. Promised a call back today with a new schedule.' }, 'Sales team', { demo: true, at: at(48) });
  await logContact(risk[1].id, { method: 'whatsapp', contact_status: 'follow_up', follow_up_at: addDays(today, -1), note: 'Sent statement of overdue invoices. Waiting for accounts team to confirm payment date.' }, 'Sales team', { demo: true, at: at(72) });
  await logContact(watch[0].id, { method: 'call', contact_status: 'contacted', note: 'Called store manager, agreed extra Thursday pickup' }, 'Sales team', { demo: true, at: at(24) });
  await logContact(watch[2].id, { method: 'visit', contact_status: 'resolved', note: 'Visited site, bins moved to the front gate so the crew can reach them.' }, 'Ops team', { demo: true, at: at(96) });
  await logContact(drop.id, { method: 'email', contact_status: 'follow_up', follow_up_at: addDays(today, 2), note: 'Asked why bookings dropped. They are renovating, expect normal volume next month.' }, 'Sales team', { demo: true, at: at(30) });
  void job;
}

// ═════════════ ROUTES ═══════════════════════════════════════
// issues + their site's name/branch/zone/phone (SQL: JOIN customers)
async function issuesWithSite(where, fields = ['name', 'branch', 'zone', 'contact_phone']) {
  return join(await prisma.customerIssue.findMany({ where }), 'customer_id', 'customer', fields, { inner: true });
}
function mountCareRoutes(r, io) {
  IO = io;
  // ── customer: issues ──
  r.get('/customer/issues/options', cust, async (req, res) => res.json({
    categories: Object.entries(ISSUE_CATS).map(([k, v]) => ({ key: k, label: v.label })),
    response_h: (await growth.tierOf(custId(req))).response_h,
  }));
  r.get('/customer/issues', cust, async (req, res) => {
    const ids = await accountSites(custId(req));
    // ORDER BY status='resolved', id DESC → open issues first, newest first
    const rows = sortBy(await issuesWithSite({ customer_id: { in: ids } }, ['branch']), i => (i.status === 'resolved' ? 1 : 0), desc(i => i.id)).slice(0, 50);
    res.json(await issueViews(rows));
  });
  r.post('/customer/issues', cust, issueCreateHandler);
  r.post('/customer/issues/:id/messages', cust, async (req, res) => {
    const i = await findById('customerIssue', req.params.id);
    if (!i || !(await accountSites(custId(req))).includes(i.customer_id)) return res.status(404).json({ error: 'Issue not found' });
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'Write a message' });
    await prisma.issueMessage.create({ data: { issue_id: i.id, author_role: 'customer', author_name: String(req.user.name || 'Customer'), body: body.slice(0, 1500) } });
    // a new customer message re-opens a resolved issue
    await prisma.customerIssue.update({
      where: { id: i.id },
      data: { ...(i.status === 'resolved' ? { status: 'open', resolved_at: null } : {}), updated_at: sqlNow() },
    });
    if (io) io.to('staff').emit('issues:changed', { id: i.id });
    res.json({ ok: true, reopened: i.status === 'resolved' });
  });

  // ── customer: visit history ──
  r.get('/customer/visits', cust, async (req, res) => {
    const sites = await accountSites(custId(req));
    const site = req.query.site ? Number(req.query.site) : null;
    res.json(await visitHistory(site && sites.includes(site) ? [site] : sites, req.query));
  });

  // ── office: issues ──
  r.get('/issues', staff, async (req, res) => {
    const st = ['open', 'in_progress', 'resolved'].includes(req.query.status) ? req.query.status : null;
    const where = st ? { status: st } : req.query.status === 'active' ? { status: { not: 'resolved' } } : {};
    const list = sortBy(await issuesWithSite(where), i => (i.status === 'resolved' ? 1 : 0), desc(i => (i.priority === 'high' ? 1 : 0)), i => i.due_at, i => i.id).slice(0, 300);
    const rows = [];
    for (const i of list) rows.push({ ...(await issueView(i, false)), tier: (await growth.tierOf(i.customer_id)).name });
    const all = await prisma.customerIssue.findMany({ select: { status: true, first_response_at: true, due_at: true, resolved_at: true, created_at: true } });
    const now = nowIso();
    const resolved = all.filter(i => i.resolved_at);
    res.json({ rows, summary: {
      open: all.filter(i => i.status === 'open').length, in_progress: all.filter(i => i.status === 'in_progress').length,
      resolved: resolved.length, overdue: all.filter(i => i.status !== 'resolved' && !i.first_response_at && toMs(i.due_at) < Date.parse(now)).length,
      avg_resolve_h: resolved.length ? Math.round(resolved.reduce((a, i) => a + (toMs(i.resolved_at) - toMs(i.created_at)) / 3600e3, 0) / resolved.length) : null,
    } });
  });
  r.get('/issues/:id', staff, async (req, res) => {
    const id = toId(req.params.id);
    const [i] = id ? await issuesWithSite({ id }) : [];
    if (!i) return res.status(404).json({ error: 'Not found' });
    const visit = i.pickup_id ? await prisma.pickup.findUnique({ where: { id: i.pickup_id }, select: { id: true, scheduled_date: true, status: true, photo_url: true } }) : null;
    res.json({ ...(await issueView(i)), visit, tier: await growth.tierOf(i.customer_id) });
  });
  r.post('/issues/:id/reply', staff, async (req, res) => {
    const i = await findById('customerIssue', req.params.id);
    if (!i) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const body = String(b.body || '').trim();
    const status = ['open', 'in_progress', 'resolved'].includes(b.status) ? b.status : (i.status === 'open' ? 'in_progress' : i.status);
    if (!body && status === i.status) return res.status(400).json({ error: 'Write a reply or change the status' });
    if (body) await prisma.issueMessage.create({ data: { issue_id: i.id, author_role: 'staff', author_name: String(req.user.name || 'GreenLoop team'), body: body.slice(0, 1500) } });
    // COALESCE(first_response_at, now) / COALESCE(assigned_to, me): keep the first value once set
    await prisma.customerIssue.update({
      where: { id: i.id },
      data: {
        status, first_response_at: i.first_response_at ?? (body || status !== 'open' ? nowIso() : null), resolved_at: status === 'resolved' ? nowIso() : null,
        assigned_to: i.assigned_to ?? String(req.user.name || 'staff'), updated_at: sqlNow(),
      },
    });
    const label = (ISSUE_CATS[i.category] || {}).label || 'Your issue';
    const title = status === 'resolved' ? 'Issue resolved' : 'Reply to your issue';
    await v3.notifyCustomer(i.customer_id, 'issue', title, `${label}: ${body ? body.slice(0, 140) : STATUS_LABEL[status]}`, '/customer/#more');
    if (io) io.to('staff').emit('issues:changed', { id: i.id });
    res.json({ ok: true, status });
  });
  r.put('/issues/:id', staff, async (req, res) => {
    const i = await findById('customerIssue', req.params.id);
    if (!i) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const priority = ['normal', 'high'].includes(b.priority) ? b.priority : i.priority;
    const assigned = b.assigned_to !== undefined ? String(b.assigned_to || '').slice(0, 80) || null : i.assigned_to;
    await prisma.customerIssue.update({ where: { id: i.id }, data: { priority, assigned_to: assigned, updated_at: sqlNow() } });
    res.json({ ok: true });
  });

  // ── office: visit history for a customer ──
  r.get('/customers/:id/visits', staff, async (req, res) => {
    const c = await findById('customer', req.params.id, { select: { id: true } });
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(await visitHistory(req.query.account === '1' ? await accountSites(c.id) : [c.id], req.query));
  });

  // ── office: health follow-up ──
  r.post('/health-scores/:id/contact', staff, async (req, res) => {
    const cid = toId(req.params.id);
    if (!cid || !(await prisma.healthScore.findUnique({ where: { customer_id: cid }, select: { customer_id: true } }))) return res.status(404).json({ error: 'Not found' });
    const out = await logContact(cid, req.body || {}, req.user.name || 'staff');
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });
  r.get('/health-scores/:id/contacts', staff, async (req, res) => {
    const cid = toId(req.params.id) ?? -1;
    const contacts = await prisma.healthContact.findMany({ where: { customer_id: cid }, orderBy: { id: 'desc' }, take: 50 });
    const open = await prisma.customerIssue.findMany({ where: { customer_id: cid, status: { not: 'resolved' } }, select: { id: true, category: true, status: true, created_at: true }, orderBy: { id: 'desc' } });
    res.json({
      contacts: contacts.map(c => ({ ...c, method_label: METHODS[c.method] || c.method, status_label: CONTACT_STATUS[c.contact_status] || c.contact_status })),
      open_issues: await issueViews(open, false),
      statuses: CONTACT_STATUS, methods: METHODS,
    });
  });
}
async function issueCreateHandler(req, res) {
  const out = await createIssue(custId(req), req.body || {});
  if (out.error) return res.status(out.status).json({ error: out.error });
  await prisma.issueMessage.create({ data: { issue_id: out.id, author_role: 'customer', author_name: String(req.user.name || 'Customer'), body: String(req.body.description).trim().slice(0, 1500) } });
  try { await growth.recalcCustomer(custId(req)); } catch { /* ignore */ }
  res.json(out);
}

// Mounted ahead of the global text-length guard in index.js (the photo is a long data URL).
const issueRoute = [cust, issueCreateHandler];

module.exports = { mountCareRoutes, issueRoute, visitHistory, visitCategory, createIssue, logContact, seedCareDemo, clearCareDemo, ISSUE_CATS, CONTACT_STATUS };
