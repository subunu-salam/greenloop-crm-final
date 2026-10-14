// ─────────────────────────────────────────────────────────────
// GreenLoop customer care (v3.7, add-on)
//   1. Issues          customers report a problem (optionally on a visit, with a
//                      photo); office replies, sets status; response target by tier
//   2. Visit history   every visit grouped: completed, upcoming, missed, cancelled
//                      (awaiting / confirmed), disputed, rescheduled
//   3. Health follow-up contact status, method, follow-up date and a contact log
// SQLite (node:sqlite) like the rest of v3.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const security = require('./security');
const { q } = require('./db');
const v3 = require('./v3');
const growth = require('./growth');

security.ensureSecret();
const SECRET = process.env.JWT_SECRET;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const nowIso = () => new Date().toISOString();
// timestamps are ISO from JS or 'YYYY-MM-DD HH:MM:SS' (UTC) from SQLite
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
const accountSites = cid => {
  const c = q.get(`SELECT id, account_id FROM customers WHERE id=?`, cid);
  if (!c) return [cid];
  const acct = c.account_id || c.id;
  return q.all(`SELECT id FROM customers WHERE id=? OR account_id=?`, acct, acct).map(x => x.id);
};

// ── schema ───────────────────────────────────────────────────
function tryRun(sql) { try { q.run(sql); } catch { /* exists */ } }
function ensureSchema() {
  const { db } = require('./db');
  db.exec(`
CREATE TABLE IF NOT EXISTS customer_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, pickup_id INTEGER,
  category TEXT NOT NULL, description TEXT NOT NULL, photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  assigned_to TEXT, response_h INTEGER NOT NULL DEFAULT 24, due_at TEXT NOT NULL,
  first_response_at TEXT, resolved_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS issue_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL, author_role TEXT NOT NULL, author_name TEXT, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS health_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, method TEXT NOT NULL, note TEXT, contact_status TEXT NOT NULL,
  follow_up_at TEXT, by_name TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_issues_customer ON customer_issues(customer_id, status)`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_issue_messages ON issue_messages(issue_id)`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_health_contacts ON health_contacts(customer_id, created_at)`);
}

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
function issueView(i, withMessages = true) {
  const now = nowIso();
  return {
    ...i, category_label: (ISSUE_CATS[i.category] || {}).label || i.category, status_label: STATUS_LABEL[i.status],
    overdue: i.status !== 'resolved' && !i.first_response_at && toMs(i.due_at) < Date.parse(now),
    messages: withMessages ? q.all(`SELECT author_role, author_name, body, created_at FROM issue_messages WHERE issue_id=? ORDER BY id`, i.id) : undefined,
  };
}
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
function createIssue(cid, b, { demo = false, createdAt = null } = {}) {
  const cat = ISSUE_CATS[b.category] ? b.category : null;
  if (!cat) return { status: 400, error: 'Choose what the issue is about' };
  const desc = String(b.description || '').trim();
  if (desc.length < 5) return { status: 400, error: 'Tell us a little more about the issue' };
  let pickupId = null;
  if (b.pickup_id) {
    const p = q.get(`SELECT id, customer_id FROM pickups WHERE id=?`, b.pickup_id);
    if (!p || !accountSites(cid).includes(p.customer_id)) return { status: 404, error: 'Visit not found' };
    pickupId = p.id;
  }
  let photo = null;
  if (b.image) { const s = savePhoto(b.image); if (s.error) return { status: 400, error: s.error }; photo = s.url; }
  const tier = growth.tierOf(cid);
  const created = createdAt || nowIso();
  const due = new Date(Date.parse(created) + tier.response_h * 3600e3).toISOString();
  const info = q.run(`INSERT INTO customer_issues(customer_id,pickup_id,category,description,photo_url,priority,response_h,due_at,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    cid, pickupId, cat, desc.slice(0, 1500), photo, ISSUE_CATS[cat].priority, tier.response_h, due, demo ? 1 : 0, created, created);
  const id = Number(info.lastInsertRowid);
  if (!demo) {
    const c = q.get(`SELECT name, branch FROM customers WHERE id=?`, cid);
    try { v3.alertCrm('ISSUE', ISSUE_CATS[cat].priority === 'high' ? 'warning' : 'info', `New issue from ${c.name} (${c.branch || ''}): ${ISSUE_CATS[cat].label}`); } catch { /* ignore */ }
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
function visitHistory(siteIds, { from, to, category } = {}) {
  const today = ymd();
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : addDays(today, -90);
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : addDays(today, 30);
  const ids = siteIds.map(Number).filter(Boolean).join(',') || '0';
  const rows = q.all(`SELECT p.id, p.customer_id, p.scheduled_date, p.status, p.confirmation_status, p.anomaly_reason, p.completed_at, p.photo_url,
      p.notes, p.time_window, p.segregation_rating, p.service_type, c.branch, c.name, u.full_name driver_name, st.name service_name,
      (SELECT id FROM customer_issues WHERE pickup_id=p.id ORDER BY id DESC LIMIT 1) issue_id
    FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.driver_id LEFT JOIN service_types st ON st.code=p.service_type
    WHERE p.customer_id IN (${ids}) AND p.scheduled_date BETWEEN ? AND ? ORDER BY p.scheduled_date DESC, p.id DESC LIMIT 500`, f, t);
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
function logContact(cid, b, by, { demo = false, at = null } = {}) {
  const status = CONTACT_STATUS[b.contact_status] ? b.contact_status : 'contacted';
  const method = METHODS[b.method] ? b.method : 'call';
  if (status === 'follow_up' && !(b.follow_up_at && /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_at))) return { status: 400, error: 'Choose a follow-up date' };
  const follow = status === 'follow_up' ? b.follow_up_at : null;
  const note = String(b.note || '').slice(0, 600);
  q.run(`INSERT INTO health_contacts(customer_id,method,note,contact_status,follow_up_at,by_name,is_demo,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    cid, method, note, status, follow, by, demo ? 1 : 0, at || nowIso().replace('T', ' ').slice(0, 19));
  q.run(`UPDATE health_scores SET contact_status=?, follow_up_at=?, contacted_at=COALESCE(?, contacted_at), contacted_by=?, contact_note=? WHERE customer_id=?`,
    status, follow, status === 'not_contacted' ? null : (at || nowIso().replace('T', ' ').slice(0, 19)), by, note, cid);
  return { status: 200, ok: true };
}

// ═════════════ DEMO EXTRAS (called from growth.seedDemo) ════
function clearCareDemo() {
  const ids = q.all(`SELECT id FROM customer_issues WHERE is_demo=1`).map(r => r.id);
  if (ids.length) q.run(`DELETE FROM issue_messages WHERE issue_id IN (${ids.join(',')})`);
  q.run(`DELETE FROM customer_issues WHERE is_demo=1`);
  const cids = q.all(`SELECT DISTINCT customer_id id FROM health_contacts WHERE is_demo=1`).map(r => r.id);
  q.run(`DELETE FROM health_contacts WHERE is_demo=1`);
  cids.forEach(id => {
    const last = q.get(`SELECT * FROM health_contacts WHERE customer_id=? ORDER BY id DESC LIMIT 1`, id);
    q.run(`UPDATE health_scores SET contact_status=?, follow_up_at=?, contacted_at=?, contacted_by=?, contact_note=? WHERE customer_id=?`,
      last ? last.contact_status : null, last ? last.follow_up_at : null, last ? last.created_at : null, last ? last.by_name : null, last ? last.note : null, id);
  });
}
function seedCareDemo(cs, { risk, watch, drop, job }) {
  const today = ymd();
  const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
  const T = '[growth-demo]';
  const add = (cid, sql, ...a) => Number(q.run(sql, ...a).lastInsertRowid);
  // a rich visit history for the customer-app demo site: upcoming, missed, awaiting, rescheduled
  const c0 = cs[0];
  const ins = (date, status, extra = {}) => add(c0.id, `INSERT INTO pickups(customer_id,scheduled_date,status,confirmation_status,anomaly_reason,time_window,notes,billable) VALUES (?,?,?,?,?,?,?,0)`,
    c0.id, date, status, extra.conf || null, extra.reason || null, extra.win || null, T);
  ins(addDays(today, 3), 'pending', { win: '07:00-12:00' });
  ins(addDays(today, 10), 'pending', { win: '07:00-12:00' });
  ins(addDays(today, -8), 'overdue');
  const npu = ins(addDays(today, -2), 'canceled', { conf: 'awaiting', reason: 'NO_ACCESS' });
  q.run(`UPDATE pickups SET confirm_deadline=? WHERE id=?`, new Date(Date.now() + 20 * 3600e3).toISOString(), npu);
  ins(addDays(today, -26), 'canceled', { conf: 'confirmed', reason: 'CLOSED' });
  ins(addDays(today, -19), 'rescheduled');
  // issues in every state
  const missedVisit = q.get(`SELECT id FROM pickups WHERE customer_id=? AND status='overdue' AND notes=? ORDER BY id DESC`, c0.id, T);
  const mk = (c, b, hoursAgo, status, replies = []) => {
    const r = createIssue(c.id, b, { demo: true, createdAt: ago(hoursAgo) });
    if (!r.ok) return;
    q.run(`INSERT INTO issue_messages(issue_id,author_role,author_name,body,created_at) VALUES (?,?,?,?,?)`, r.id, 'customer', c.name, b.description, ago(hoursAgo).replace('T', ' ').slice(0, 19));
    replies.forEach(([h, txt]) => q.run(`INSERT INTO issue_messages(issue_id,author_role,author_name,body,created_at) VALUES (?,?,?,?,?)`, r.id, 'staff', 'GreenLoop team', txt, ago(h).replace('T', ' ').slice(0, 19)));
    q.run(`UPDATE customer_issues SET status=?, first_response_at=?, resolved_at=?, updated_at=? WHERE id=?`, status,
      replies.length ? ago(replies[0][0]) : null, status === 'resolved' ? ago(replies[replies.length - 1][0]) : null, ago(replies.length ? replies[replies.length - 1][0] : hoursAgo), r.id);
  };
  mk(c0, { category: 'missed_pickup', description: 'Nobody came for the pickup last week, bins were overflowing by the evening.', pickup_id: missedVisit && missedVisit.id }, 30, 'in_progress',
    [[26, 'Sorry about this. The truck broke down that morning. We have added a free extra pickup for you this Thursday.']]);
  mk(risk[0], { category: 'mess', description: 'The crew left cardboard and spilled liquid at the back gate after the pickup.' }, 40, 'open');
  mk(risk[1], { category: 'billing', description: 'We were charged for a visit on a day the store was closed.' }, 6, 'open');
  mk(watch[1], { category: 'driver', description: 'Driver was rude to our store manager when asked to wait 5 minutes.' }, 70, 'resolved',
    [[60, 'Thank you for telling us. We have spoken to the driver and apologise.'], [58, 'We have also moved your pickup to the morning slot as you asked.']]);
  mk(cs[8 % cs.length], { category: 'bin', description: 'One of our two bins has a broken lid.' }, 120, 'resolved', [[100, 'Replacement bin delivered today.']]);
  // follow-up workflow
  const at = h => ago(h).replace('T', ' ').slice(0, 19);
  logContact(risk[0].id, { method: 'call', contact_status: 'follow_up', follow_up_at: today, note: 'Manager unhappy about missed pickups. Promised a call back today with a new schedule.' }, 'Sales team', { demo: true, at: at(48) });
  logContact(risk[1].id, { method: 'whatsapp', contact_status: 'follow_up', follow_up_at: addDays(today, -1), note: 'Sent statement of overdue invoices. Waiting for accounts team to confirm payment date.' }, 'Sales team', { demo: true, at: at(72) });
  logContact(watch[0].id, { method: 'call', contact_status: 'contacted', note: 'Called store manager, agreed extra Thursday pickup' }, 'Sales team', { demo: true, at: at(24) });
  logContact(watch[2].id, { method: 'visit', contact_status: 'resolved', note: 'Visited site, bins moved to the front gate so the crew can reach them.' }, 'Ops team', { demo: true, at: at(96) });
  logContact(drop.id, { method: 'email', contact_status: 'follow_up', follow_up_at: addDays(today, 2), note: 'Asked why bookings dropped. They are renovating, expect normal volume next month.' }, 'Sales team', { demo: true, at: at(30) });
  void job;
}

// ═════════════ ROUTES ═══════════════════════════════════════
function mountCareRoutes(r, io) {
  IO = io;
  // ── customer: issues ──
  r.get('/customer/issues/options', cust, (req, res) => res.json({
    categories: Object.entries(ISSUE_CATS).map(([k, v]) => ({ key: k, label: v.label })),
    response_h: growth.tierOf(custId(req)).response_h,
  }));
  r.get('/customer/issues', cust, (req, res) => {
    const ids = accountSites(custId(req)).join(',');
    res.json(q.all(`SELECT i.*, c.branch FROM customer_issues i JOIN customers c ON c.id=i.customer_id WHERE i.customer_id IN (${ids}) ORDER BY i.status='resolved', i.id DESC LIMIT 50`).map(i => issueView(i)));
  });
  r.post('/customer/issues', cust, issueCreateHandler);
  r.post('/customer/issues/:id/messages', cust, (req, res) => {
    const i = q.get(`SELECT * FROM customer_issues WHERE id=?`, req.params.id);
    if (!i || !accountSites(custId(req)).includes(i.customer_id)) return res.status(404).json({ error: 'Issue not found' });
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'Write a message' });
    q.run(`INSERT INTO issue_messages(issue_id,author_role,author_name,body) VALUES (?,?,?,?)`, i.id, 'customer', req.user.name || 'Customer', body.slice(0, 1500));
    q.run(`UPDATE customer_issues SET status=CASE WHEN status='resolved' THEN 'open' ELSE status END, resolved_at=CASE WHEN status='resolved' THEN NULL ELSE resolved_at END, updated_at=datetime('now') WHERE id=?`, i.id);
    if (io) io.to('staff').emit('issues:changed', { id: i.id });
    res.json({ ok: true, reopened: i.status === 'resolved' });
  });

  // ── customer: visit history ──
  r.get('/customer/visits', cust, (req, res) => {
    const sites = accountSites(custId(req));
    const site = req.query.site ? Number(req.query.site) : null;
    res.json(visitHistory(site && sites.includes(site) ? [site] : sites, req.query));
  });

  // ── office: issues ──
  r.get('/issues', staff, (req, res) => {
    const st = ['open', 'in_progress', 'resolved'].includes(req.query.status) ? req.query.status : null;
    const rows = q.all(`SELECT i.*, c.name, c.branch, c.zone, c.contact_phone FROM customer_issues i JOIN customers c ON c.id=i.customer_id
      ${st ? 'WHERE i.status=?' : req.query.status === 'active' ? "WHERE i.status!='resolved'" : ''}
      ORDER BY i.status='resolved', i.priority='high' DESC, i.due_at LIMIT 300`, ...(st ? [st] : [])).map(i => ({ ...issueView(i, false), tier: growth.tierOf(i.customer_id).name }));
    const all = q.all(`SELECT status, first_response_at, due_at, resolved_at, created_at FROM customer_issues`);
    const now = nowIso();
    const resolved = all.filter(i => i.resolved_at);
    res.json({ rows, summary: {
      open: all.filter(i => i.status === 'open').length, in_progress: all.filter(i => i.status === 'in_progress').length,
      resolved: resolved.length, overdue: all.filter(i => i.status !== 'resolved' && !i.first_response_at && toMs(i.due_at) < Date.parse(now)).length,
      avg_resolve_h: resolved.length ? Math.round(resolved.reduce((a, i) => a + (toMs(i.resolved_at) - toMs(i.created_at)) / 3600e3, 0) / resolved.length) : null,
    } });
  });
  r.get('/issues/:id', staff, (req, res) => {
    const i = q.get(`SELECT i.*, c.name, c.branch, c.zone, c.contact_phone FROM customer_issues i JOIN customers c ON c.id=i.customer_id WHERE i.id=?`, req.params.id);
    if (!i) return res.status(404).json({ error: 'Not found' });
    const visit = i.pickup_id ? q.get(`SELECT id, scheduled_date, status, photo_url FROM pickups WHERE id=?`, i.pickup_id) : null;
    res.json({ ...issueView(i), visit, tier: growth.tierOf(i.customer_id) });
  });
  r.post('/issues/:id/reply', staff, async (req, res) => {
    const i = q.get(`SELECT * FROM customer_issues WHERE id=?`, req.params.id);
    if (!i) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const body = String(b.body || '').trim();
    const status = ['open', 'in_progress', 'resolved'].includes(b.status) ? b.status : (i.status === 'open' ? 'in_progress' : i.status);
    if (!body && status === i.status) return res.status(400).json({ error: 'Write a reply or change the status' });
    if (body) q.run(`INSERT INTO issue_messages(issue_id,author_role,author_name,body) VALUES (?,?,?,?)`, i.id, 'staff', req.user.name || 'GreenLoop team', body.slice(0, 1500));
    q.run(`UPDATE customer_issues SET status=?, first_response_at=COALESCE(first_response_at, ?), resolved_at=?, assigned_to=COALESCE(assigned_to, ?), updated_at=datetime('now') WHERE id=?`,
      status, body || status !== 'open' ? nowIso() : null, status === 'resolved' ? nowIso() : null, req.user.name || 'staff', i.id);
    const label = (ISSUE_CATS[i.category] || {}).label || 'Your issue';
    const title = status === 'resolved' ? 'Issue resolved' : 'Reply to your issue';
    v3.notifyCustomer(i.customer_id, 'issue', title, `${label}: ${body ? body.slice(0, 140) : STATUS_LABEL[status]}`, '/customer/#more');
    if (io) io.to('staff').emit('issues:changed', { id: i.id });
    res.json({ ok: true, status });
  });
  r.put('/issues/:id', staff, (req, res) => {
    const i = q.get(`SELECT * FROM customer_issues WHERE id=?`, req.params.id);
    if (!i) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const priority = ['normal', 'high'].includes(b.priority) ? b.priority : i.priority;
    const assigned = b.assigned_to !== undefined ? String(b.assigned_to || '').slice(0, 80) || null : i.assigned_to;
    q.run(`UPDATE customer_issues SET priority=?, assigned_to=?, updated_at=datetime('now') WHERE id=?`, priority, assigned, i.id);
    res.json({ ok: true });
  });

  // ── office: visit history for a customer ──
  r.get('/customers/:id/visits', staff, (req, res) => {
    const c = q.get(`SELECT id FROM customers WHERE id=?`, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(visitHistory(req.query.account === '1' ? accountSites(c.id) : [c.id], req.query));
  });

  // ── office: health follow-up ──
  r.post('/health-scores/:id/contact', staff, (req, res) => {
    if (!q.get(`SELECT customer_id FROM health_scores WHERE customer_id=?`, req.params.id)) return res.status(404).json({ error: 'Not found' });
    const out = logContact(Number(req.params.id), req.body || {}, req.user.name || 'staff');
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });
  r.get('/health-scores/:id/contacts', staff, (req, res) => res.json({
    contacts: q.all(`SELECT * FROM health_contacts WHERE customer_id=? ORDER BY id DESC LIMIT 50`, req.params.id)
      .map(c => ({ ...c, method_label: METHODS[c.method] || c.method, status_label: CONTACT_STATUS[c.contact_status] || c.contact_status })),
    open_issues: q.all(`SELECT id, category, status, created_at FROM customer_issues WHERE customer_id=? AND status!='resolved' ORDER BY id DESC`, req.params.id).map(i => issueView(i, false)),
    statuses: CONTACT_STATUS, methods: METHODS,
  }));
}
async function issueCreateHandler(req, res) {
  const out = createIssue(custId(req), req.body || {});
  if (out.error) return res.status(out.status).json({ error: out.error });
  q.run(`INSERT INTO issue_messages(issue_id,author_role,author_name,body) VALUES (?,?,?,?)`, out.id, 'customer', req.user.name || 'Customer', String(req.body.description).trim().slice(0, 1500));
  try { growth.recalcCustomer(custId(req)); } catch { /* ignore */ }
  res.json(out);
}

ensureSchema();
// Mounted ahead of the global text-length guard in index.js (the photo is a long data URL).
const issueRoute = [cust, issueCreateHandler];

module.exports = { mountCareRoutes, issueRoute, visitHistory, visitCategory, createIssue, logContact, seedCareDemo, clearCareDemo, ISSUE_CATS, CONTACT_STATUS };
