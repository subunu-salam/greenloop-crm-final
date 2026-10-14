// ─────────────────────────────────────────────────────────────
// GreenLoop customer engagement (v3.8, add-on)
//   1. Visit ratings   customer rates a finished visit 1-5 with a comment; low
//                      ratings alert the office, feed health and driver scores
//   2. Busy periods    "Expecting more waste" for Ramadan, Eid, a sale …: extra
//                      visits are planned automatically (price shown first)
//   3. Weekly email    Sunday morning summary to each account's email address
// SQLite (node:sqlite) like the rest of v3.
// ─────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const security = require('./security');
const { q, getSetting, setSetting } = require('./db');
const v3 = require('./v3');
const mailer = require('./mailer');

security.ensureSecret();
const SECRET = process.env.JWT_SECRET;
const TZ = process.env.APP_TZ || 'Asia/Dubai';
const ymd = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const localYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const J = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const money = n => Math.round(Number(n || 0) * 100) / 100;
const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const nice = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const h = s => String(s ?? '').replace(/[&<>"]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));

const need = (...roles) => (req, res, next) => {
  const a = req.headers.authorization || '';
  const t = a.startsWith('Bearer ') ? a.slice(7) : (req.query && req.query.t) || null;
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
const custId = req => Number(req.user.customer_id || req.user.id);
const accountOf = cid => { const c = q.get(`SELECT id, account_id FROM customers WHERE id=?`, cid); return c ? (c.account_id || c.id) : cid; };
const accountSites = cid => { const a = accountOf(cid); return q.all(`SELECT id FROM customers WHERE id=? OR account_id=?`, a, a).map(x => x.id); };

// ── schema ───────────────────────────────────────────────────
function tryRun(sql) { try { q.run(sql); } catch { /* exists */ } }
function ensureSchema() {
  const { db } = require('./db');
  db.exec(`
CREATE TABLE IF NOT EXISTS visit_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL UNIQUE, customer_id INTEGER NOT NULL, driver_id INTEGER,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5), comment TEXT,
  followed_up_at TEXT, followed_up_by TEXT, follow_up_note TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS waste_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, level TEXT NOT NULL, per_week INTEGER NOT NULL,
  job_ids TEXT NOT NULL DEFAULT '[]', unallocated INTEGER NOT NULL DEFAULT 0, price_per_visit REAL NOT NULL DEFAULT 0,
  note TEXT, status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','cancelled')), is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS weekly_email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, week TEXT NOT NULL, to_email TEXT, status TEXT NOT NULL, error TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  tryRun(`ALTER TABLE customers ADD COLUMN weekly_email INTEGER DEFAULT 1`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_ratings_customer ON visit_ratings(customer_id, created_at)`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_events_customer ON waste_events(customer_id, start_date)`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_weekly_log ON weekly_email_log(week, customer_id)`);
  if (!getSetting('weekly_email_enabled', '')) setSetting('weekly_email_enabled', '1');
  if (!getSetting('uae_event_dates', '')) {
    // Approximate (lunar dates move): editable in Settings when announced.
    setSetting('uae_event_dates', JSON.stringify({
      ramadan: ['2027-02-08', '2027-03-09'], eid_fitr: ['2027-03-09', '2027-03-12'],
      eid_adha: ['2027-05-15', '2027-05-19'], national_day: ['2026-12-01', '2026-12-03'],
    }));
  }
}

// ═════════════ 1. VISIT RATINGS ═════════════════════════════
const LOW = 2;
function rateVisit(cid, pickupId, b, { demo = false, at = null } = {}) {
  const stars = Math.round(Number(b.stars));
  if (!(stars >= 1 && stars <= 5)) return { status: 400, error: 'Choose 1 to 5 stars' };
  const p = q.get(`SELECT p.*, c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, pickupId);
  if (!p || !accountSites(cid).includes(p.customer_id)) return { status: 404, error: 'Visit not found' };
  if (p.status !== 'collected') return { status: 409, error: 'You can rate a visit once it is completed' };
  if (!demo && p.scheduled_date < addDays(ymd(), -30)) return { status: 409, error: 'Visits can be rated up to 30 days after they happen' };
  if (q.get(`SELECT id FROM visit_ratings WHERE pickup_id=?`, p.id)) return { status: 409, error: 'You have already rated this visit' };
  const comment = String(b.comment || '').trim().slice(0, 600);
  q.run(`INSERT INTO visit_ratings(pickup_id,customer_id,driver_id,stars,comment,is_demo,created_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))`,
    p.id, p.customer_id, p.driver_id, stars, comment, demo ? 1 : 0, at);
  if (!demo && stars <= LOW) {
    try { v3.alertCrm('RATING', 'warning', `${stars}★ rating from ${p.name} (${p.branch || ''}) for ${dmy(p.scheduled_date)}${comment ? ': "' + comment.slice(0, 120) + '"' : ''}`, p.id); } catch { /* ignore */ }
  }
  if (!demo) try { require('./growth').recalcCustomer(p.customer_id); } catch { /* ignore */ }
  return { status: 200, ok: true, stars, low: stars <= LOW };
}
function ratingSummary(where = '1=1', ...args) {
  const r = q.get(`SELECT COUNT(*) n, AVG(stars) avg, SUM(stars>=4) good, SUM(stars<=${LOW}) low FROM visit_ratings WHERE ${where}`, ...args) || {};
  return { count: r.n || 0, avg: r.n ? Math.round(r.avg * 10) / 10 : null, happy_pct: r.n ? Math.round(100 * (r.good || 0) / r.n) : null, low: r.low || 0 };
}

// ═════════════ 2. BUSY PERIODS ══════════════════════════════
const EVENT_KINDS = {
  ramadan: 'Ramadan', eid_fitr: 'Eid al-Fitr', eid_adha: 'Eid al-Adha', national_day: 'UAE National Day',
  sale: 'Store sale or promotion', stocktake: 'Stock clearance / stocktake', other: 'Something else',
};
const LEVELS = { more: { label: 'A bit more than usual', per_week: 1 }, much_more: { label: 'A lot more than usual', per_week: 2 } };
const holidays = () => new Set(J(getSetting('uae_holidays', '[]'), []));
function pricePerVisit(cid) {
  const plan = q.get(`SELECT unit_price FROM service_plans WHERE customer_id=? AND status='active' AND service_code LIKE 'WASTE%' ORDER BY id LIMIT 1`, cid);
  if (plan && plan.unit_price > 0) return money(plan.unit_price);
  const st = q.get(`SELECT default_price FROM service_types WHERE code='WASTE'`);
  return st ? money(st.default_price) : 0;
}
// Spread the extra visits evenly; skip holidays and days the site already has a visit.
function planEventDates(cid, start, end, perWeek) {
  const hol = holidays();
  const taken = new Set(q.all(`SELECT scheduled_date d FROM pickups WHERE customer_id=? AND scheduled_date BETWEEN ? AND ? AND status IN ('pending','overdue','collected')`, cid, start, end).map(r => r.d));
  const days = []; for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const free = days.filter(d => !hol.has(d) && !taken.has(d));
  const want = Math.max(1, Math.round(days.length / 7 * perWeek));
  const n = Math.min(want, free.length);
  if (!n) return [];
  const step = free.length / n;
  return Array.from({ length: n }, (_, i) => free[Math.min(free.length - 1, Math.floor(i * step + step / 2))]);
}
function validateEvent(b) {
  const kind = EVENT_KINDS[b.kind] ? b.kind : null;
  if (!kind) return { error: 'Choose what is happening' };
  const level = LEVELS[b.level] ? b.level : null;
  if (!level) return { error: 'Choose how much more waste you expect' };
  const tomorrow = addDays(localYmd(), 1);
  if (!security.isRealDate(b.start_date) || !security.isRealDate(b.end_date)) return { error: 'Choose the start and end dates' };
  if (b.start_date < tomorrow) return { error: 'The busy period must start tomorrow or later' };
  if (b.end_date < b.start_date) return { error: 'The end date is before the start date' };
  if (b.start_date > addDays(tomorrow, 180)) return { error: 'Busy periods can be planned up to 6 months ahead' };
  if (addDays(b.start_date, 45) < b.end_date) return { error: 'A busy period can be at most 45 days' };
  const label = kind === 'other' || kind === 'sale' ? (String(b.label || '').trim().slice(0, 80) || EVENT_KINDS[kind]) : EVENT_KINDS[kind];
  return { kind, level, label, per_week: LEVELS[level].per_week };
}
function eventPreview(cid, b) {
  const v = validateEvent(b); if (v.error) return { status: 400, error: v.error };
  const dates = planEventDates(cid, b.start_date, b.end_date, v.per_week);
  if (!dates.length) return { status: 409, error: 'You already have a visit on every free day in this period' };
  const price = pricePerVisit(cid);
  return { status: 200, ...v, start_date: b.start_date, end_date: b.end_date, dates, price_per_visit: price, est_total: money(dates.length * price), vat_rate: 0.05 };
}
function createEvent(cid, b, by = 'customer') {
  const pv = eventPreview(cid, b); if (pv.error) return pv;
  const c = q.get(`SELECT * FROM customers WHERE id=?`, cid);
  const jobs = []; let unallocated = 0;
  for (const d of pv.dates) {
    const out = v3.createJob({ customer: c, date: d, serviceCode: 'WASTE', note: `Extra visit: ${pv.label}`, quiet: true });
    jobs.push(out.id); if (out.unallocated) unallocated++;
  }
  const info = q.run(`INSERT INTO waste_events(customer_id,kind,label,start_date,end_date,level,per_week,job_ids,unallocated,price_per_visit,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    cid, pv.kind, pv.label, pv.start_date, pv.end_date, pv.level, pv.per_week, JSON.stringify(jobs), unallocated, pv.price_per_visit, String(b.note || '').slice(0, 300));
  try {
    v3.alertCrm('EVENT', unallocated ? 'warning' : 'info', `Busy period: ${c.name} (${c.branch || ''}) — ${pv.label}, ${dmy(pv.start_date)} to ${dmy(pv.end_date)}, ${jobs.length} extra visit${jobs.length === 1 ? '' : 's'}${unallocated ? `, ${unallocated} need a vehicle` : ''} (by ${by})`);
  } catch { /* ignore */ }
  return { status: 200, ok: true, id: Number(info.lastInsertRowid), ...pv, created: jobs.length, unallocated };
}
function cancelEvent(ev, by) {
  const ids = J(ev.job_ids, []);
  let removed = 0;
  if (ids.length) {
    const left = q.all(`SELECT id FROM pickups WHERE id IN (${ids.join(',')}) AND status='pending' AND stage IS NULL AND scheduled_date>?`, localYmd()).map(r => r.id);
    if (left.length) { q.run(`DELETE FROM pickups WHERE id IN (${left.join(',')})`); removed = left.length; }
  }
  q.run(`UPDATE waste_events SET status='cancelled' WHERE id=?`, ev.id);
  try { v3.alertCrm('EVENT', 'info', `Busy period cancelled by ${by}: ${ev.label} — ${removed} extra visit${removed === 1 ? '' : 's'} removed`); } catch { /* ignore */ }
  return { ok: true, removed };
}
const eventView = e => {
  const ids = J(e.job_ids, []);
  const jobs = ids.length ? q.all(`SELECT id, scheduled_date, status FROM pickups WHERE id IN (${ids.join(',')}) ORDER BY scheduled_date`) : [];
  return { ...e, kind_label: EVENT_KINDS[e.kind] || e.kind, level_label: (LEVELS[e.level] || {}).label, visits: jobs,
    done: jobs.filter(j => j.status === 'collected').length, est_total: money(jobs.length * e.price_per_visit) };
};

// ═════════════ 3. WEEKLY EMAIL ══════════════════════════════
// The week = the 7 days ending yesterday (sent Sunday morning → Sunday to Saturday).
function weekKey(d = localYmd()) { return addDays(d, -1); }
function weeklySummary(acctId, endDate = weekKey()) {
  const a = q.get(`SELECT * FROM customers WHERE id=?`, acctId);
  const sites = q.all(`SELECT id, branch FROM customers WHERE (id=? OR account_id=?) AND is_active=1`, acctId, acctId);
  const ids = sites.map(s => s.id).join(',') || '0';
  const from = addDays(endDate, -6);
  const v = q.get(`SELECT SUM(status='collected') done, SUM(status='canceled') npu, SUM(status='overdue' OR (status='pending' AND scheduled_date<?)) missed
    FROM pickups WHERE customer_id IN (${ids}) AND scheduled_date BETWEEN ? AND ?`, localYmd(), from, endDate) || {};
  let issuesOpen = 0, issuesNew = 0, issuesResolved = 0;
  try {
    issuesOpen = q.get(`SELECT COUNT(*) n FROM customer_issues WHERE customer_id IN (${ids}) AND status!='resolved'`).n;
    issuesNew = q.get(`SELECT COUNT(*) n FROM customer_issues WHERE customer_id IN (${ids}) AND substr(created_at,1,10) BETWEEN ? AND ?`, from, endDate).n;
    issuesResolved = q.get(`SELECT COUNT(*) n FROM customer_issues WHERE customer_id IN (${ids}) AND substr(resolved_at,1,10) BETWEEN ? AND ?`, from, endDate).n;
  } catch { /* care module not loaded */ }
  const rated = q.get(`SELECT SUM(segregation_rating='good') g, COUNT(segregation_rating) n FROM pickups WHERE customer_id IN (${ids}) AND scheduled_date BETWEEN ? AND ?`, from, endDate) || {};
  let points = 0; try { points = q.get(`SELECT COALESCE(SUM(points),0) s FROM reward_points WHERE customer_id IN (${ids}) AND kind='earn' AND substr(created_at,1,10) BETWEEN ? AND ?`, from, endDate).s; } catch { /* */ }
  const next = q.get(`SELECT p.scheduled_date, p.time_window, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id
    WHERE p.customer_id IN (${ids}) AND p.status='pending' AND p.scheduled_date>=? ORDER BY p.scheduled_date, p.time_window LIMIT 1`, localYmd());
  const upcoming = q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id IN (${ids}) AND status='pending' AND scheduled_date BETWEEN ? AND ?`, localYmd(), addDays(localYmd(), 6)).n;
  const event = q.get(`SELECT label, start_date, end_date FROM waste_events WHERE customer_id IN (${ids}) AND status='planned' AND end_date>=? ORDER BY start_date LIMIT 1`, localYmd());
  return { account: a, sites: sites.length, from, to: endDate, done: v.done || 0, not_picked_up: v.npu || 0, missed: v.missed || 0,
    issues_open: issuesOpen, issues_new: issuesNew, issues_resolved: issuesResolved,
    separation_pct: rated.n ? Math.round(100 * (rated.g || 0) / rated.n) : null, points, next, upcoming, event };
}
function weeklyEmail(acctId, endDate) {
  const s = weeklySummary(acctId, endDate);
  const a = s.account;
  const company = getSetting('company_name', 'Majari / GreenLoop');
  const appUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '') + '/customer/';
  const line = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const subject = `Your week with GreenLoop: ${line(s.done, 'pickup', 'pickups')} done${s.next ? `, next ${nice(s.next.scheduled_date)}` : ''}`;
  const bullets = [
    `${line(s.done, 'pickup', 'pickups')} completed${s.sites > 1 ? ` across ${s.sites} sites` : ''}`,
    s.not_picked_up || s.missed ? `${line(s.not_picked_up + s.missed, 'visit', 'visits')} not completed (${s.missed ? s.missed + ' missed, ' : ''}${s.not_picked_up} not picked up at the site)` : 'No missed visits',
    s.issues_open ? `${line(s.issues_open, 'issue', 'issues')} still open${s.issues_resolved ? `, ${s.issues_resolved} resolved this week` : ''}` : s.issues_resolved ? `${line(s.issues_resolved, 'issue', 'issues')} resolved this week, none open` : 'No open issues',
    s.separation_pct != null ? `Waste separation: ${s.separation_pct}% of pickups rated Good${s.points ? ` (+${s.points} Green points)` : ''}` : null,
    s.next ? `Next pickup: ${nice(s.next.scheduled_date)}${s.next.time_window ? ', ' + s.next.time_window.replace('-', ' to ') : ''}${s.sites > 1 ? ' at ' + (s.next.branch || '') : ''} (${line(s.upcoming, 'visit', 'visits')} in the next 7 days)` : 'No pickup scheduled in the coming days',
    s.event ? `Busy period planned: ${s.event.label}, ${dmy(s.event.start_date)} to ${dmy(s.event.end_date)}` : null,
  ].filter(Boolean);
  const text = `Hello ${a.name},\n\nHere is your GreenLoop summary for ${dmy(s.from)} to ${dmy(s.to)}:\n\n${bullets.map(b => '• ' + b).join('\n')}\n\n` +
    `See photos of every visit, report an issue or book an extra pickup in the GreenLoop customer app${appUrl.startsWith('http') ? ': ' + appUrl : '.'}\n\n${company}\n\nYou get this email every Sunday. To stop it, switch it off in the app under More.`;
  const tile = (n, l, c) => `<td style="padding:12px;background:#f2f7f5;border-radius:10px;text-align:center;width:33%"><div style="font-size:24px;font-weight:800;color:${c}">${n}</div><div style="font-size:12px;color:#5b7a71">${l}</div></td>`;
  const html = `<!doctype html><html><body style="margin:0;background:#eef5f1;font-family:Segoe UI,Arial,sans-serif;color:#12312a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0f766e;padding:18px 24px;color:#fff"><div style="font-size:20px;font-weight:800">GreenLoop</div><div style="font-size:13px;opacity:.85">Your week: ${dmy(s.from)} to ${dmy(s.to)}</div></td></tr>
<tr><td style="padding:22px 24px"><p style="margin:0 0 14px">Hello ${h(a.name)},</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>${tile(s.done, 'Pickups done', '#0f766e')}${tile(s.not_picked_up + s.missed, 'Not completed', s.not_picked_up + s.missed ? '#be123c' : '#0f766e')}${tile(s.issues_open, 'Open issues', s.issues_open ? '#b45309' : '#0f766e')}</tr></table>
<ul style="padding-left:18px;margin:16px 0;line-height:1.6;font-size:14px">${bullets.map(b => `<li>${h(b)}</li>`).join('')}</ul>
${s.next ? `<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:12px 14px;font-size:14px"><b>Next pickup:</b> ${h(nice(s.next.scheduled_date))}${s.next.time_window ? ', ' + h(s.next.time_window.replace('-', ' to ')) : ''}. Please keep the bins accessible.</div>` : ''}
${appUrl.startsWith('http') ? `<p style="margin:18px 0 0"><a href="${h(appUrl)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px">Open the GreenLoop app</a></p>` : ''}
</td></tr><tr><td style="padding:14px 24px;border-top:1px solid #e5eee9;font-size:11.5px;color:#5b7a71">${h(company)} · You get this every Sunday. Switch it off in the app under More.</td></tr>
</table></td></tr></table></body></html>`;
  return { to: a.email, subject, text, html, summary: s };
}
const eligibleAccounts = () => q.all(`SELECT id, name, branch, email FROM customers WHERE is_active=1 AND (account_id IS NULL OR account_id=id)
  AND COALESCE(weekly_email,1)=1 AND email IS NOT NULL AND email!=''`);
async function sendWeekly({ force = false } = {}) {
  const week = weekKey();
  if (!force && getSetting('weekly_email_last', '') === week) return { skipped: true, week };
  setSetting('weekly_email_last', week);
  const st = mailer.status();
  const list = eligibleAccounts();
  let sent = 0, failed = 0;
  for (const a of list) {
    if (q.get(`SELECT id FROM weekly_email_log WHERE customer_id=? AND week=? AND status='sent'`, a.id, week)) continue;
    const m = weeklyEmail(a.id, week);
    if (!st.configured) { q.run(`INSERT INTO weekly_email_log(customer_id,week,to_email,status,error) VALUES (?,?,?,?,?)`, a.id, week, a.email, 'skipped', 'Email is not connected on the server'); continue; }
    try { await mailer.send({ to: m.to, subject: m.subject, text: m.text, html: m.html }); sent++; q.run(`INSERT INTO weekly_email_log(customer_id,week,to_email,status) VALUES (?,?,?,?)`, a.id, week, a.email, 'sent'); }
    catch (e) { failed++; q.run(`INSERT INTO weekly_email_log(customer_id,week,to_email,status,error) VALUES (?,?,?,?,?)`, a.id, week, a.email, 'failed', String(e.message).slice(0, 300)); }
  }
  if (!st.configured && list.length) try { v3.alertCrm('MAIL', 'warning', `Weekly summary emails were not sent: email is not connected on the server (${list.length} customers waiting).`); } catch { /* */ }
  return { week, accounts: list.length, sent, failed, mail_configured: st.configured };
}
let weeklyTimer = null;
function startWeekly() {
  const tick = () => {
    try {
      if (getSetting('weekly_email_enabled', '1') !== '1') return;
      const now = new Date();
      const wd = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' }).format(now);
      const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
      if (wd === 'Sun' && hr >= 8) sendWeekly().catch(e => console.warn('Weekly email:', e.message));
    } catch (e) { console.warn('Weekly email:', e.message); }
  };
  tick();
  if (!weeklyTimer) { weeklyTimer = setInterval(tick, 30 * 60 * 1000); if (weeklyTimer.unref) weeklyTimer.unref(); }
}

// ═════════════ DEMO (called from growth.seedDemo) ═══════════
const DEMO_TAG = '[growth-demo]';
function clearEngageDemo() {
  q.run(`DELETE FROM visit_ratings WHERE is_demo=1`);
  q.run(`DELETE FROM waste_events WHERE is_demo=1`);
}
function seedEngageDemo(cs, { risk }) {
  const today = localYmd();
  // demo visits were created without a driver: spread them over the active drivers so driver averages show
  const drivers = q.all(`SELECT id FROM users WHERE role='driver' AND is_active=1 ORDER BY id`).map(d => d.id);
  if (drivers.length) q.all(`SELECT id FROM pickups WHERE notes=? AND driver_id IS NULL`, DEMO_TAG).forEach((p, k) => q.run(`UPDATE pickups SET driver_id=? WHERE id=?`, drivers[k % drivers.length], p.id));
  const comments = { 5: ['Quick and tidy, thank you', 'Driver was very polite', ''], 4: ['Good, a bit later than usual', ''], 3: ['OK, some cardboard left behind'], 2: ['Came 2 hours late and left a mess at the gate'], 1: ['Bins were not emptied fully'] };
  cs.forEach((c, i) => {
    const visits = q.all(`SELECT id, scheduled_date FROM pickups WHERE customer_id=? AND notes=? AND status='collected' ORDER BY scheduled_date DESC LIMIT 4`, c.id, DEMO_TAG);
    visits.forEach((v, k) => {
      if ((i + k) % 3 === 2 || (i === 0 && k === 0)) return;   // not every visit gets rated; the demo customer's latest is left for the live demo
      const stars = risk.includes(c) ? [2, 3, 1, 3][k % 4] : [5, 5, 4, 5, 3, 4][(i + k) % 6];
      const list = comments[stars];
      rateVisit(c.id, v.id, { stars, comment: list[(i + k) % list.length] }, { demo: true, at: v.scheduled_date + ' 12:00:00' });
    });
  });
  // one low rating already followed up
  const low = q.get(`SELECT id FROM visit_ratings WHERE is_demo=1 AND stars<=2 ORDER BY id LIMIT 1`);
  if (low) q.run(`UPDATE visit_ratings SET followed_up_at=datetime('now','-1 day'), followed_up_by='Ops team', follow_up_note='Called the manager and apologised; driver briefed.' WHERE id=?`, low.id);
  // busy periods: demo customer has a sale next week, another site has Ramadan
  const ins = (c, kind, label, start, end, level, perWeek, days) => {
    const jobs = days.map(d => Number(q.run(`INSERT INTO pickups(customer_id,scheduled_date,status,time_window,notes,billable) VALUES (?,?,'pending','07:00-12:00',?,0)`, c.id, d, DEMO_TAG).lastInsertRowid));
    q.run(`INSERT INTO waste_events(customer_id,kind,label,start_date,end_date,level,per_week,job_ids,price_per_visit,is_demo,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,datetime('now','-1 day'))`,
      c.id, kind, label, start, end, level, perWeek, JSON.stringify(jobs), pricePerVisit(c.id));
  };
  const s1 = addDays(today, 5);
  ins(cs[0], 'sale', 'Weekend mega sale', s1, addDays(s1, 9), 'much_more', 2, [addDays(s1, 1), addDays(s1, 4), addDays(s1, 8)]);
  const r = J(getSetting('uae_event_dates', '{}'), {}).ramadan || [addDays(today, 40), addDays(today, 69)];
  ins(cs[5 % cs.length], 'ramadan', 'Ramadan', r[0], r[1], 'more', 1, [addDays(r[0], 3), addDays(r[0], 10), addDays(r[0], 17), addDays(r[0], 24)]);
  ins(cs[9 % cs.length], 'national_day', 'UAE National Day', addDays(today, 12), addDays(today, 15), 'more', 1, [addDays(today, 13)]);
}

// ═════════════ ROUTES ═══════════════════════════════════════
function mountEngageRoutes(r, io) {
  // ── ratings: customer ──
  r.post('/customer/visits/:id/rate', cust, (req, res) => {
    const out = rateVisit(custId(req), Number(req.params.id), req.body || {});
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (io && out.low) io.to('staff').emit('ratings:changed', {});
    res.json(out);
  });
  r.get('/customer/ratings/pending', cust, (req, res) => {
    const ids = accountSites(custId(req)).join(',');
    const v = q.get(`SELECT p.id, p.scheduled_date, p.completed_at, c.branch, u.full_name driver FROM pickups p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.driver_id
      WHERE p.customer_id IN (${ids}) AND p.status='collected' AND p.scheduled_date>=? AND NOT EXISTS (SELECT 1 FROM visit_ratings vr WHERE vr.pickup_id=p.id)
      ORDER BY p.scheduled_date DESC, p.id DESC LIMIT 1`, addDays(ymd(), -7));
    res.json({ visit: v || null });
  });
  r.get('/customer/ratings', cust, (req, res) => {
    const ids = accountSites(custId(req)).join(',');
    res.json(q.all(`SELECT pickup_id, stars, comment, created_at FROM visit_ratings WHERE customer_id IN (${ids}) ORDER BY id DESC LIMIT 100`));
  });

  // ── ratings: office ──
  r.get('/ratings', staff, (req, res) => {
    const since = addDays(ymd(), -30);
    const filter = req.query.filter === 'low' ? `AND vr.stars<=${LOW}` : req.query.filter === 'todo' ? `AND vr.stars<=${LOW} AND vr.followed_up_at IS NULL` : '';
    res.json({
      rows: q.all(`SELECT vr.*, c.name, c.branch, c.zone, p.scheduled_date, u.full_name driver FROM visit_ratings vr JOIN customers c ON c.id=vr.customer_id
        JOIN pickups p ON p.id=vr.pickup_id LEFT JOIN users u ON u.id=vr.driver_id WHERE 1=1 ${filter}
        ORDER BY (vr.stars<=${LOW} AND vr.followed_up_at IS NULL) DESC, vr.id DESC LIMIT 300`),
      summary: { all: ratingSummary(), last30: ratingSummary(`created_at>=?`, since), to_follow_up: q.get(`SELECT COUNT(*) n FROM visit_ratings WHERE stars<=${LOW} AND followed_up_at IS NULL`).n,
        rated_share: (() => { const d = q.get(`SELECT COUNT(*) n FROM pickups WHERE status='collected' AND scheduled_date>=?`, since).n; return d ? Math.round(100 * ratingSummary(`created_at>=?`, since).count / d) : null; })() },
      drivers: q.all(`SELECT u.id, u.full_name name, COUNT(*) n, ROUND(AVG(vr.stars),1) avg, SUM(vr.stars<=${LOW}) low, SUM(vr.stars=5) five
        FROM visit_ratings vr JOIN users u ON u.id=vr.driver_id WHERE vr.created_at>=? GROUP BY u.id ORDER BY avg DESC`, addDays(ymd(), -90)),
    });
  });
  r.post('/ratings/:id/follow-up', staff, (req, res) => {
    const vr = q.get(`SELECT * FROM visit_ratings WHERE id=?`, req.params.id);
    if (!vr) return res.status(404).json({ error: 'Not found' });
    q.run(`UPDATE visit_ratings SET followed_up_at=datetime('now'), followed_up_by=?, follow_up_note=? WHERE id=?`, req.user.name || 'staff', String((req.body || {}).note || '').slice(0, 500), vr.id);
    res.json({ ok: true });
  });

  // ── busy periods: customer ──
  r.get('/customer/events/options', cust, (req, res) => res.json({
    kinds: Object.entries(EVENT_KINDS).map(([k, l]) => ({ key: k, label: l })), levels: Object.entries(LEVELS).map(([k, v]) => ({ key: k, ...v })),
    suggested: J(getSetting('uae_event_dates', '{}'), {}), price_per_visit: pricePerVisit(custId(req)), min_date: addDays(localYmd(), 1),
  }));
  r.post('/customer/events/preview', cust, (req, res) => { const out = eventPreview(custId(req), req.body || {}); if (out.error) return res.status(out.status).json({ error: out.error }); res.json(out); });
  r.post('/customer/events', cust, (req, res) => {
    const out = createEvent(custId(req), req.body || {}, 'customer');
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (io) { io.to('staff').emit('ledger:refresh', {}); io.to('staff').emit('events:changed', {}); }
    res.json(out);
  });
  r.get('/customer/events', cust, (req, res) => {
    const ids = accountSites(custId(req)).join(',');
    res.json(q.all(`SELECT * FROM waste_events WHERE customer_id IN (${ids}) AND (status='planned' AND end_date>=?) ORDER BY start_date`, localYmd()).map(eventView));
  });
  r.delete('/customer/events/:id', cust, (req, res) => {
    const ev = q.get(`SELECT * FROM waste_events WHERE id=? AND status='planned'`, req.params.id);
    if (!ev || !accountSites(custId(req)).includes(ev.customer_id)) return res.status(404).json({ error: 'Not found' });
    const out = cancelEvent(ev, 'customer');
    if (io) io.to('staff').emit('ledger:refresh', {});
    res.json(out);
  });

  // ── busy periods: office ──
  r.get('/events', staff, (req, res) => {
    const all = req.query.all === '1';
    const rows = q.all(`SELECT e.*, c.name, c.branch, c.zone FROM waste_events e JOIN customers c ON c.id=e.customer_id
      ${all ? '' : `WHERE e.status='planned' AND e.end_date>=?`} ORDER BY e.start_date LIMIT 300`, ...(all ? [] : [localYmd()])).map(eventView);
    res.json({ rows, summary: { active: rows.filter(e => e.status === 'planned').length, extra_visits: rows.reduce((a, e) => a + (e.status === 'planned' ? e.visits.filter(v => v.status === 'pending').length : 0), 0),
      unallocated: rows.reduce((a, e) => a + (e.status === 'planned' ? e.unallocated : 0), 0) }, suggested: J(getSetting('uae_event_dates', '{}'), {}), kinds: EVENT_KINDS });
  });
  r.post('/events', staff, (req, res) => {
    const c = q.get(`SELECT id FROM customers WHERE id=? AND is_active=1`, (req.body || {}).customer_id);
    if (!c) return res.status(400).json({ error: 'Choose a customer' });
    const out = createEvent(c.id, req.body || {}, req.user.name || 'office');
    if (out.error) return res.status(out.status).json({ error: out.error });
    v3.notifyCustomer(c.id, 'event', 'Extra visits planned', `${out.label}: ${out.created} extra pickup${out.created === 1 ? '' : 's'} from ${dmy(out.start_date)} to ${dmy(out.end_date)}.`, '/customer/#home');
    if (io) io.to('staff').emit('ledger:refresh', {});
    res.json(out);
  });
  r.delete('/events/:id', staff, (req, res) => {
    const ev = q.get(`SELECT * FROM waste_events WHERE id=? AND status='planned'`, req.params.id);
    if (!ev) return res.status(404).json({ error: 'Not found' });
    const out = cancelEvent(ev, req.user.name || 'office');
    v3.notifyCustomer(ev.customer_id, 'event', 'Busy period cancelled', `${ev.label}: ${out.removed} extra pickup${out.removed === 1 ? '' : 's'} removed.`, '/customer/#home');
    if (io) io.to('staff').emit('ledger:refresh', {});
    res.json(out);
  });
  r.put('/events/dates', owner, (req, res) => {
    const b = req.body || {}, out = {};
    for (const k of ['ramadan', 'eid_fitr', 'eid_adha', 'national_day']) {
      if (!b[k]) continue;
      const [s, e] = b[k];
      if (!security.isRealDate(s) || !security.isRealDate(e) || e < s) return res.status(400).json({ error: `Check the dates for ${EVENT_KINDS[k]}` });
      out[k] = [s, e];
    }
    setSetting('uae_event_dates', JSON.stringify({ ...J(getSetting('uae_event_dates', '{}'), {}), ...out }));
    res.json({ ok: true });
  });

  // ── weekly email: customer ──
  r.get('/customer/weekly-email', cust, (req, res) => {
    const a = q.get(`SELECT email, COALESCE(weekly_email,1) on_ FROM customers WHERE id=?`, accountOf(custId(req)));
    res.json({ enabled: !!a.on_, email: a.email || null, office_enabled: getSetting('weekly_email_enabled', '1') === '1' });
  });
  r.put('/customer/weekly-email', cust, (req, res) => {
    q.run(`UPDATE customers SET weekly_email=? WHERE id=?`, (req.body || {}).enabled ? 1 : 0, accountOf(custId(req)));
    res.json({ ok: true });
  });

  // ── weekly email: office ──
  r.get('/weekly-email', staff, (req, res) => {
    const total = q.get(`SELECT COUNT(*) n FROM customers WHERE is_active=1 AND (account_id IS NULL OR account_id=id)`).n;
    const noEmail = q.get(`SELECT COUNT(*) n FROM customers WHERE is_active=1 AND (account_id IS NULL OR account_id=id) AND (email IS NULL OR email='')`).n;
    const optedOut = q.get(`SELECT COUNT(*) n FROM customers WHERE is_active=1 AND (account_id IS NULL OR account_id=id) AND weekly_email=0`).n;
    res.json({ enabled: getSetting('weekly_email_enabled', '1') === '1', mail: mailer.status(), last_week: getSetting('weekly_email_last', null),
      accounts: { total, eligible: eligibleAccounts().length, no_email: noEmail, opted_out: optedOut },
      log: q.all(`SELECT l.*, c.name, c.branch FROM weekly_email_log l JOIN customers c ON c.id=l.customer_id ORDER BY l.id DESC LIMIT 100`),
      customers: q.all(`SELECT id, name, branch, email, COALESCE(weekly_email,1) weekly_email FROM customers WHERE is_active=1 AND (account_id IS NULL OR account_id=id) ORDER BY name LIMIT 500`) });
  });
  r.get('/weekly-email/preview/:id', staff, (req, res) => {
    if (!q.get(`SELECT id FROM customers WHERE id=?`, req.params.id)) return res.status(404).send('Not found');
    const m = weeklyEmail(accountOf(Number(req.params.id)));
    res.json({ to: m.to, subject: m.subject, html: m.html, text: m.text });
  });
  r.post('/weekly-email/test', owner, async (req, res) => {
    const b = req.body || {};
    const c = q.get(`SELECT id FROM customers WHERE id=?`, b.customer_id);
    if (!c) return res.status(400).json({ error: 'Choose a customer' });
    const m = weeklyEmail(accountOf(c.id));
    const to = String(b.to || m.to || '').trim();
    try { await mailer.send({ to, subject: '[Test] ' + m.subject, text: m.text, html: m.html }); res.json({ ok: true, to }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message, code: e.code }); }
  });
  r.post('/weekly-email/send-now', owner, async (req, res) => res.json(await sendWeekly({ force: true })));
  r.put('/weekly-email/settings', owner, (req, res) => { setSetting('weekly_email_enabled', (req.body || {}).enabled ? '1' : '0'); res.json({ ok: true }); });
  r.put('/customers/:id/weekly-email', staff, (req, res) => {
    q.run(`UPDATE customers SET weekly_email=? WHERE id=?`, (req.body || {}).enabled ? 1 : 0, accountOf(Number(req.params.id)));
    res.json({ ok: true });
  });
}

ensureSchema();

module.exports = { mountEngageRoutes, startWeekly, sendWeekly, weeklyEmail, weeklySummary, rateVisit, ratingSummary, planEventDates, eventPreview, createEvent,
  seedEngageDemo, clearEngageDemo, EVENT_KINDS };
