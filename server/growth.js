// ─────────────────────────────────────────────────────────────
// GreenLoop growth modules (add-ons, nothing existing is changed)
//   1. Customer Health Score  — nightly 0-100 score per site, at-risk alerts
//   2. Green Rewards          — driver rates segregation, customer earns points,
//                               redeems for invoice discounts, zone leaderboard
//   3. AI Waste Scanner       — customer photographs waste, gets type, tips and an
//                               estimate, sends a pre-filled quote request (lead)
// SQLite (node:sqlite) like the rest of v3.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const security = require('./security');
const { q, getSetting, setSetting } = require('./db');
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
const owner = need('admin');
const cust = need('customer');
const driver = need('driver');
const custId = req => Number(req.user.customer_id || req.user.id);

// ── schema (idempotent) ──────────────────────────────────────
function tryRun(sql) { try { q.run(sql); } catch { /* exists */ } }
function ensureSchema() {
  const { db } = require('./db');
  db.exec(`
CREATE TABLE IF NOT EXISTS health_scores (
  customer_id INTEGER PRIMARY KEY,
  score INTEGER NOT NULL, band TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]',
  factors TEXT NOT NULL DEFAULT '{}', prev_band TEXT, band_since TEXT,
  computed_at TEXT NOT NULL, contacted_at TEXT, contacted_by TEXT, contact_note TEXT
);
CREATE TABLE IF NOT EXISTS reward_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, pickup_id INTEGER, points INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('earn','redeem','refund','adjust')),
  reason TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rewards_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, points_cost INTEGER NOT NULL, discount_aed REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reward_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, reward_id INTEGER NOT NULL, reward_name TEXT NOT NULL,
  points INTEGER NOT NULL, discount_aed REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','applied','rejected')),
  note TEXT, decided_by TEXT, decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS waste_scan_rules (
  category TEXT PRIMARY KEY, label TEXT NOT NULL, service_code TEXT NOT NULL,
  hazardous INTEGER NOT NULL DEFAULT 0, tip TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS waste_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'ai',
  categories TEXT NOT NULL DEFAULT '[]', volume TEXT, tips TEXT NOT NULL DEFAULT '[]',
  summary TEXT, service_code TEXT, est_price REAL, hazardous INTEGER NOT NULL DEFAULT 0,
  photo_url TEXT, lead_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  tryRun(`ALTER TABLE pickups ADD COLUMN segregation_rating TEXT`);
  tryRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_reward_earn_pickup ON reward_points(pickup_id) WHERE kind='earn' AND pickup_id IS NOT NULL`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_reward_points_customer ON reward_points(customer_id, created_at)`);
  tryRun(`CREATE INDEX IF NOT EXISTS ix_waste_scans_customer ON waste_scans(customer_id)`);

  if (!getSetting('rewards_points_good', '')) setSetting('rewards_points_good', '10');
  if (!getSetting('rewards_points_average', '')) setSetting('rewards_points_average', '5');
  if (!getSetting('rewards_points_poor', '')) setSetting('rewards_points_poor', '0');
  if (!getSetting('rewards_monthly_cap', '')) setSetting('rewards_monthly_cap', '200');
  if (!q.get(`SELECT id FROM rewards_catalog LIMIT 1`)) {
    [['AED 25 off your next invoice', 250, 25], ['AED 60 off your next invoice', 500, 60], ['One free extra pickup', 800, 150]]
      .forEach(([n, p, d]) => q.run(`INSERT INTO rewards_catalog(name,points_cost,discount_aed) VALUES (?,?,?)`, n, p, d));
  }
  if (!q.get(`SELECT category FROM waste_scan_rules LIMIT 1`)) {
    [
      ['plastic', 'Plastic', 'WASTE', 0, 'Rinse bottles and containers, flatten them and keep them out of food waste.'],
      ['cardboard', 'Cardboard and paper', 'WASTE', 0, 'Flatten boxes and keep them dry; wet cardboard cannot be recycled.'],
      ['organic', 'Food and organic', 'WASTE', 0, 'Keep food waste in sealed bags, separate from packaging.'],
      ['glass', 'Glass', 'WASTE', 0, 'Keep glass in its own container so it does not break into other waste.'],
      ['metal', 'Metal and cans', 'WASTE', 0, 'Empty and crush cans; keep metal separate from food waste.'],
      ['mixed', 'Mixed general waste', 'WASTE', 0, 'Pull out cardboard and plastic first; it lowers your mixed-waste volume.'],
      ['bulky', 'Bulky items (furniture, pallets)', 'WASTE_BULK', 0, 'Stack bulky items near the collection point so the crew can load quickly.'],
      ['e_waste', 'Electronic waste', 'WASTE_BULK', 1, 'Keep electronics and batteries apart; they need special handling.'],
      ['hazardous', 'Hazardous (chemicals, oil, batteries)', 'WASTE_BULK', 1, 'Do not mix with other waste. Keep containers closed and labelled.'],
    ].forEach(r => q.run(`INSERT INTO waste_scan_rules(category,label,service_code,hazardous,tip) VALUES (?,?,?,?,?)`, ...r));
  }
}

// ═════════════ 1. CUSTOMER HEALTH SCORE ═════════════════════
const BAND = s => (s >= 70 ? 'healthy' : s >= 40 ? 'watch' : 'at_risk');
const BAND_LABEL = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk' };

function scoreCustomer(c, today = ymd()) {
  const acct = c.account_id || c.id;
  const d30 = addDays(today, -30), d60 = addDays(today, -60), d90 = addDays(today, -90);
  const missed = q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=? AND scheduled_date BETWEEN ? AND ?
      AND (status='overdue' OR (status='canceled' AND COALESCE(confirmation_status,'') IN ('confirmed','auto_confirmed','awaiting','')))`, c.id, d60, today).n;
  const complaints = q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=? AND confirmation_status='disputed' AND scheduled_date>=?`, c.id, d90).n;
  const inv = q.all(`SELECT i.id, i.amount, i.due_date, COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id=i.id),0) paid
      FROM invoices i WHERE i.customer_id=? AND i.status!='void'`, acct);
  const overdueInv = inv.filter(i => i.due_date < today && i.amount - i.paid > 0.004);
  const overdueAmt = money(overdueInv.reduce((a, i) => a + i.amount - i.paid, 0));
  const recent = q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=? AND status='collected' AND scheduled_date>? AND scheduled_date<=?`, c.id, d30, today).n;
  const before = q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=? AND status='collected' AND scheduled_date>? AND scheduled_date<=?`, c.id, d90, d30).n;
  const usual = before / 2;                      // collected per 30 days over the 60 days before
  const drop = usual >= 2 ? Math.round(100 * (usual - recent) / usual) : 0;
  const goodRatings = q.get(`SELECT COUNT(*) n FROM pickups WHERE customer_id=? AND segregation_rating='good' AND scheduled_date>?`, c.id, d30).n;
  const redeemed = q.get(`SELECT COUNT(*) n FROM reward_redemptions WHERE customer_id=? AND created_at>=?`, c.id, d90).n;

  let score = 100; const reasons = [];
  const take = (pts, why) => { if (pts > 0) { score -= pts; reasons.push(why); } };
  take(Math.min(30, missed * 10), `${missed} missed pickup${missed === 1 ? '' : 's'} in 60 days`);
  take(Math.min(30, complaints * 15), `${complaints} disputed visit${complaints === 1 ? '' : 's'} in 90 days`);
  if (overdueInv.length) take(Math.min(30, 15 + (overdueInv.length - 1) * 8 + Math.floor(overdueAmt / 500) * 2),
    `${overdueInv.length} overdue invoice${overdueInv.length === 1 ? '' : 's'} (AED ${overdueAmt.toFixed(2)})`);
  if (drop >= 40) take(15, `Pickups down ${drop}% on their usual`);
  else if (drop >= 20) take(8, `Pickups down ${drop}% on their usual`);
  let bonus = 0;
  if (goodRatings >= 2) bonus += 5;
  if (redeemed) bonus += 3;
  score = clamp(Math.round(score + bonus), 0, 100);
  return { score, band: BAND(score), reasons,
    factors: { missed_60d: missed, disputes_90d: complaints, overdue_invoices: overdueInv.length, overdue_aed: overdueAmt,
      collected_30d: recent, usual_per_30d: Math.round(usual * 10) / 10, drop_pct: drop, good_segregation_30d: goodRatings, bonus } };
}

function recalcHealth({ notify = true } = {}) {
  const now = new Date().toISOString(), today = ymd();
  const rows = q.all(`SELECT id, name, branch, account_id FROM customers WHERE is_active=1`);
  let newlyAtRisk = 0;
  for (const c of rows) {
    const r = scoreCustomer(c, today);
    const old = q.get(`SELECT band, band_since FROM health_scores WHERE customer_id=?`, c.id);
    const changed = !old || old.band !== r.band;
    q.run(`INSERT INTO health_scores(customer_id,score,band,reasons,factors,prev_band,band_since,computed_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET score=excluded.score, band=excluded.band, reasons=excluded.reasons, factors=excluded.factors,
        prev_band=CASE WHEN health_scores.band!=excluded.band THEN health_scores.band ELSE health_scores.prev_band END,
        band_since=CASE WHEN health_scores.band!=excluded.band THEN excluded.band_since ELSE health_scores.band_since END,
        computed_at=excluded.computed_at,
        contacted_at=CASE WHEN health_scores.band!=excluded.band AND excluded.band='at_risk' THEN NULL ELSE health_scores.contacted_at END`,
      c.id, r.score, r.band, JSON.stringify(r.reasons), JSON.stringify(r.factors), old ? old.band : null, changed ? now : (old.band_since || now), now);
    if (changed && old && r.band === 'at_risk') {
      newlyAtRisk++;
      if (notify) try { v3.alertCrm('HEALTH', 'warning', `At risk: ${c.name} (${c.branch || ''}) — ${r.reasons.join('; ') || 'score ' + r.score}`); } catch { /* ignore */ }
    }
  }
  setSetting('health_last_run', today);
  return { customers: rows.length, newly_at_risk: newlyAtRisk, computed_at: now };
}

let healthTimer = null;
function startHealth() {
  const tick = () => {
    try {
      const h = new Date().getHours();
      const never = !getSetting('health_last_run', '');
      if (never || (getSetting('health_last_run', '') !== ymd() && h >= 2)) recalcHealth({ notify: !never });
    } catch (e) { console.warn('Health score:', e.message); }
  };
  tick();
  if (!healthTimer) { healthTimer = setInterval(tick, 30 * 60 * 1000); if (healthTimer.unref) healthTimer.unref(); }
}

// ═════════════ 2. GREEN REWARDS ═════════════════════════════
const RATINGS = ['good', 'average', 'poor'];
const pointsFor = rating => Number(getSetting('rewards_points_' + rating, rating === 'good' ? '10' : rating === 'average' ? '5' : '0')) || 0;
const balanceOf = cid => q.get(`SELECT COALESCE(SUM(points),0) b FROM reward_points WHERE customer_id=?`, cid).b;
const earnedThisMonth = cid => q.get(`SELECT COALESCE(SUM(points),0) s FROM reward_points WHERE customer_id=? AND kind='earn' AND created_at LIKE ?`, cid, ymd().slice(0, 7) + '%').s;

function rateSegregation(pickupId, rating, by) {
  const p = q.get(`SELECT p.*, c.name, c.branch FROM pickups p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`, pickupId);
  if (!p) return { status: 404, error: 'Not found' };
  if (p.status !== 'collected') return { status: 409, error: 'Rate segregation after the pickup is finished' };
  if (p.segregation_rating) return { status: 200, ok: true, already: true, rating: p.segregation_rating, points: 0 };
  q.run(`UPDATE pickups SET segregation_rating=? WHERE id=?`, rating, p.id);
  const cap = Number(getSetting('rewards_monthly_cap', '200')) || 0;
  let pts = pointsFor(rating);
  if (cap > 0) pts = Math.max(0, Math.min(pts, cap - earnedThisMonth(p.customer_id)));
  if (pts > 0) {
    q.run(`INSERT INTO reward_points(customer_id,pickup_id,points,kind,reason,created_by) VALUES (?,?,?,?,?,?)`,
      p.customer_id, p.id, pts, 'earn', `${rating[0].toUpperCase() + rating.slice(1)} segregation on ${v3.dmy(p.scheduled_date)}`, by);
    v3.notifyCustomer(p.customer_id, 'rewards', `+${pts} Green points`, `Thanks for separating your waste well on ${v3.dmy(p.scheduled_date)}. Balance: ${balanceOf(p.customer_id)} points.`, '/customer/#home');
  }
  return { status: 200, ok: true, rating, points: pts, balance: balanceOf(p.customer_id) };
}

function leaderboard(cid) {
  const month = ymd().slice(0, 7);
  const sites = q.all(`SELECT c.id, c.zone, COALESCE(SUM(CASE WHEN rp.kind='earn' AND rp.created_at LIKE ? THEN rp.points END),0) pts
      FROM customers c LEFT JOIN reward_points rp ON rp.customer_id=c.id WHERE c.is_active=1 GROUP BY c.id`, month + '%');
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

// ═════════════ 3. AI WASTE SCANNER ══════════════════════════
const VOLUMES = ['small', 'medium', 'large'];
const rules = () => q.all(`SELECT * FROM waste_scan_rules ORDER BY rowid`);
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
  const cats = rules().map(r => r.category);
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
function estimate(categories, volume, aiTips = []) {
  const R = Object.fromEntries(rules().map(r => [r.category, r]));
  const cats = (Array.isArray(categories) ? categories : [])
    .map(c => (typeof c === 'string' ? { category: c, share_pct: null } : c))
    .filter(c => c && R[c.category])
    .slice(0, 4)
    .map(c => ({ category: c.category, label: R[c.category].label, share_pct: c.share_pct == null ? null : clamp(Math.round(Number(c.share_pct) || 0), 0, 100), hazardous: !!R[c.category].hazardous }));
  const vol = VOLUMES.includes(volume) ? volume : 'medium';
  const hazardous = cats.some(c => c.hazardous);
  let code = cats.some(c => R[c.category].service_code === 'WASTE_BULK') || vol === 'large' ? 'WASTE_BULK' : 'WASTE';
  let st = q.get(`SELECT code, name, default_price FROM service_types WHERE code=? AND is_active=1`, code)
    || q.get(`SELECT code, name, default_price FROM service_types WHERE category='waste' AND is_active=1 ORDER BY default_price LIMIT 1`);
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
  const est = estimate(categories, volume, aiTips);
  if (!est.categories.length) return res.status(422).json({ error: source === 'ai' ? 'No waste could be seen in this photo. Try a clearer photo.' : 'Choose at least one waste type' });
  const info = q.run(`INSERT INTO waste_scans(customer_id,source,categories,volume,tips,summary,service_code,est_price,hazardous,photo_url) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    cid, source, JSON.stringify(est.categories), est.volume, JSON.stringify(est.tips), summary, est.service_code, est.est_price, est.hazardous ? 1 : 0, photo);
  res.json({ id: Number(info.lastInsertRowid), source, summary, ...est });
}

// ═════════════ ROUTES ═══════════════════════════════════════
function mountGrowthRoutes(r, io) {
  // ── Health score ──
  r.get('/health-scores', staff, (req, res) => {
    if (!getSetting('health_last_run', '')) recalcHealth({ notify: false });
    const rows = q.all(`SELECT h.*, c.name, c.branch, c.zone, c.contact_phone FROM health_scores h JOIN customers c ON c.id=h.customer_id
      WHERE c.is_active=1 ORDER BY h.score ASC, c.name`).map(h => ({ ...h, reasons: J(h.reasons, []), factors: J(h.factors, {}), band_label: BAND_LABEL[h.band] }));
    const summary = { healthy: 0, watch: 0, at_risk: 0 };
    rows.forEach(h => { summary[h.band]++; });
    res.json({ rows, summary, last_run: getSetting('health_last_run', null) });
  });
  r.post('/health-scores/recalculate', staff, (req, res) => res.json({ ok: true, ...recalcHealth() }));
  r.post('/health-scores/:id/contacted', staff, (req, res) => {
    const h = q.get(`SELECT * FROM health_scores WHERE customer_id=?`, req.params.id);
    if (!h) return res.status(404).json({ error: 'Not found' });
    const note = String((req.body || {}).note || '').slice(0, 500);
    q.run(`UPDATE health_scores SET contacted_at=datetime('now'), contacted_by=?, contact_note=? WHERE customer_id=?`, req.user.name || 'staff', note, h.customer_id);
    res.json({ ok: true });
  });

  // ── Rewards: driver ──
  r.post('/pickups/:id/segregation', driver, (req, res) => {
    const rating = String((req.body || {}).rating || '');
    if (!RATINGS.includes(rating)) return res.status(400).json({ error: 'Rating must be good, average or poor' });
    const p = q.get(`SELECT * FROM pickups WHERE id=?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const denied = security.driverJobError(p, req.user);
    if (denied) return res.status(denied[0]).json({ error: denied[1] });
    const out = rateSegregation(p.id, rating, req.user.name);
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (io && out.points) io.to('staff').emit('rewards:changed', {});
    res.json(out);
  });

  // ── Rewards: customer ──
  r.get('/customer/rewards', cust, (req, res) => {
    const cid = custId(req);
    res.json({
      balance: balanceOf(cid), earned_this_month: earnedThisMonth(cid), monthly_cap: Number(getSetting('rewards_monthly_cap', '200')) || 0,
      points: { good: pointsFor('good'), average: pointsFor('average'), poor: pointsFor('poor') },
      history: q.all(`SELECT points, kind, reason, created_at FROM reward_points WHERE customer_id=? ORDER BY id DESC LIMIT 20`, cid),
      catalog: q.all(`SELECT id, name, points_cost, discount_aed FROM rewards_catalog WHERE is_active=1 ORDER BY points_cost`),
      redemptions: q.all(`SELECT id, reward_name, points, discount_aed, status, created_at FROM reward_redemptions WHERE customer_id=? ORDER BY id DESC LIMIT 10`, cid),
      leaderboard: leaderboard(cid),
    });
  });
  r.post('/customer/rewards/redeem', cust, (req, res) => {
    const cid = custId(req);
    const rw = q.get(`SELECT * FROM rewards_catalog WHERE id=? AND is_active=1`, (req.body || {}).reward_id);
    if (!rw) return res.status(404).json({ error: 'Reward not found' });
    const bal = balanceOf(cid);
    if (bal < rw.points_cost) return res.status(409).json({ error: `You need ${rw.points_cost - bal} more points for this reward` });
    const info = q.run(`INSERT INTO reward_redemptions(customer_id,reward_id,reward_name,points,discount_aed) VALUES (?,?,?,?,?)`, cid, rw.id, rw.name, rw.points_cost, rw.discount_aed);
    q.run(`INSERT INTO reward_points(customer_id,points,kind,reason,created_by) VALUES (?,?,?,?,?)`, cid, -rw.points_cost, 'redeem', `Redeemed: ${rw.name}`, 'customer');
    const c = q.get(`SELECT name, branch FROM customers WHERE id=?`, cid);
    try { v3.alertCrm('REWARD', 'info', `Reward request: ${c.name} (${c.branch || ''}) — ${rw.name}`); } catch { /* ignore */ }
    if (io) io.to('staff').emit('rewards:changed', {});
    res.json({ ok: true, id: Number(info.lastInsertRowid), balance: balanceOf(cid) });
  });

  // ── Rewards: office ──
  r.get('/rewards/overview', staff, (req, res) => {
    const month = ymd().slice(0, 7);
    res.json({
      redemptions: q.all(`SELECT rr.*, c.name, c.branch FROM reward_redemptions rr JOIN customers c ON c.id=rr.customer_id
        ORDER BY rr.status='requested' DESC, rr.status='approved' DESC, rr.id DESC LIMIT 200`),
      catalog: q.all(`SELECT * FROM rewards_catalog ORDER BY is_active DESC, points_cost`),
      settings: { good: pointsFor('good'), average: pointsFor('average'), poor: pointsFor('poor'), monthly_cap: Number(getSetting('rewards_monthly_cap', '200')) || 0 },
      top: q.all(`SELECT c.id, c.name, c.branch, c.zone, SUM(rp.points) points FROM reward_points rp JOIN customers c ON c.id=rp.customer_id
        WHERE rp.kind='earn' AND rp.created_at LIKE ? GROUP BY c.id ORDER BY points DESC LIMIT 10`, month + '%'),
      ratings: q.get(`SELECT SUM(segregation_rating='good') good, SUM(segregation_rating='average') average, SUM(segregation_rating='poor') poor,
        SUM(segregation_rating IS NULL AND status='collected') unrated FROM pickups WHERE scheduled_date LIKE ?`, month + '%'),
      issued_this_month: q.get(`SELECT COALESCE(SUM(points),0) s FROM reward_points WHERE kind='earn' AND created_at LIKE ?`, month + '%').s,
    });
  });
  r.post('/rewards/redemptions/:id/decide', owner, (req, res) => {
    const rr = q.get(`SELECT * FROM reward_redemptions WHERE id=?`, req.params.id);
    if (!rr) return res.status(404).json({ error: 'Not found' });
    const action = String((req.body || {}).action || '');
    const next = { approve: 'approved', reject: 'rejected', applied: 'applied' }[action];
    if (!next) return res.status(400).json({ error: 'Action must be approve, reject or applied' });
    const allowed = { requested: ['approved', 'rejected'], approved: ['applied', 'rejected'] }[rr.status] || [];
    if (!allowed.includes(next)) return res.status(409).json({ error: `This request is already ${rr.status}` });
    const note = String((req.body || {}).note || '').slice(0, 300);
    q.run(`UPDATE reward_redemptions SET status=?, note=?, decided_by=?, decided_at=datetime('now') WHERE id=?`, next, note, req.user.name || 'owner', rr.id);
    if (next === 'rejected') {
      q.run(`INSERT INTO reward_points(customer_id,points,kind,reason,created_by) VALUES (?,?,?,?,?)`, rr.customer_id, rr.points, 'refund', `Returned: ${rr.reward_name}${note ? ' (' + note + ')' : ''}`, req.user.name || 'owner');
      v3.notifyCustomer(rr.customer_id, 'rewards', 'Reward request declined', `${rr.reward_name}: your ${rr.points} points were returned.${note ? ' ' + note : ''}`, '/customer/#home');
    } else if (next === 'approved') {
      v3.notifyCustomer(rr.customer_id, 'rewards', 'Reward approved', `${rr.reward_name} will be taken off your next invoice.`, '/customer/#home');
    }
    res.json({ ok: true, status: next });
  });
  r.post('/rewards/catalog', owner, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120), cost = Math.round(Number(b.points_cost)), disc = money(b.discount_aed);
    if (!name || !(cost > 0) || !(disc >= 0)) return res.status(400).json({ error: 'Name, points (above 0) and discount are required' });
    const info = q.run(`INSERT INTO rewards_catalog(name,points_cost,discount_aed) VALUES (?,?,?)`, name, cost, disc);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
  r.put('/rewards/catalog/:id', owner, (req, res) => {
    const rw = q.get(`SELECT * FROM rewards_catalog WHERE id=?`, req.params.id);
    if (!rw) return res.status(404).json({ error: 'Not found' });
    const b = { ...rw, ...(req.body || {}) };
    const cost = Math.round(Number(b.points_cost)), disc = money(b.discount_aed);
    if (!String(b.name || '').trim() || !(cost > 0) || !(disc >= 0)) return res.status(400).json({ error: 'Name, points (above 0) and discount are required' });
    q.run(`UPDATE rewards_catalog SET name=?, points_cost=?, discount_aed=?, is_active=? WHERE id=?`, String(b.name).trim().slice(0, 120), cost, disc, b.is_active ? 1 : 0, rw.id);
    res.json({ ok: true });
  });
  r.put('/rewards/settings', owner, (req, res) => {
    const b = req.body || {};
    for (const k of ['good', 'average', 'poor']) if (b[k] != null && !(Number(b[k]) >= 0 && Number(b[k]) <= 1000)) return res.status(400).json({ error: `Points for ${k} must be 0 to 1000` });
    if (b.monthly_cap != null && !(Number(b.monthly_cap) >= 0)) return res.status(400).json({ error: 'Monthly cap must be 0 or more (0 = no cap)' });
    for (const k of ['good', 'average', 'poor']) if (b[k] != null) setSetting('rewards_points_' + k, String(Math.round(Number(b[k]))));
    if (b.monthly_cap != null) setSetting('rewards_monthly_cap', String(Math.round(Number(b.monthly_cap))));
    res.json({ ok: true });
  });

  // ── Waste scanner: customer ──
  r.get('/customer/scan/options', cust, (req, res) => res.json({
    ai: !!aiProvider(), volumes: VOLUMES, categories: rules().map(x => ({ category: x.category, label: x.label, hazardous: !!x.hazardous })),
  }));
  r.post('/customer/scan', cust, scanHandler);
  r.post('/customer/scans/:id/request-quote', cust, (req, res) => {
    const cid = custId(req);
    const s = q.get(`SELECT * FROM waste_scans WHERE id=? AND customer_id=?`, req.params.id, cid);
    if (!s) return res.status(404).json({ error: 'Scan not found' });
    if (s.lead_id) return res.json({ ok: true, lead_id: s.lead_id, already: true });
    const c = q.get(`SELECT * FROM customers WHERE id=?`, cid);
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
    const info = q.run(`INSERT INTO leads(contact,company,phone,email,service_type,sites,frequency,source,stage,follow_up_at,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      c.name, c.name, c.contact_phone || '', c.email || '', s.service_code || 'WASTE', JSON.stringify(site), '', 'ai_scan', 'new', addDays(ymd(), 1), lines);
    const leadId = Number(info.lastInsertRowid);
    q.run(`UPDATE waste_scans SET lead_id=? WHERE id=?`, leadId, s.id);
    try { v3.alertCrm('QUOTE_REQUEST', sv.hazardous ? 'warning' : 'info', `Quote request from ${c.name} (${c.branch || ''}) via waste scan${sv.hazardous ? ' — special handling' : ''}`); } catch { /* ignore */ }
    if (io) io.to('staff').emit('lead:changed', {});
    res.json({ ok: true, lead_id: leadId });
  });

  // ── Waste scanner: office ──
  r.get('/waste-scans', staff, (req, res) => {
    res.json({
      rows: q.all(`SELECT s.*, c.name, c.branch, c.zone, l.stage lead_stage FROM waste_scans s JOIN customers c ON c.id=s.customer_id
        LEFT JOIN leads l ON l.id=s.lead_id ORDER BY s.id DESC LIMIT 200`).map(scanView),
      rules: rules().map(x => ({ ...x, hazardous: !!x.hazardous })),
      services: q.all(`SELECT code, name, default_price FROM service_types WHERE is_active=1 AND category='waste' ORDER BY name`),
      ai: aiProvider(),
    });
  });
  r.put('/waste-scan-rules/:category', owner, (req, res) => {
    const rule = q.get(`SELECT * FROM waste_scan_rules WHERE category=?`, req.params.category);
    if (!rule) return res.status(404).json({ error: 'Not found' });
    const b = { ...rule, ...(req.body || {}) };
    if (!q.get(`SELECT code FROM service_types WHERE code=?`, b.service_code)) return res.status(400).json({ error: 'Unknown service' });
    q.run(`UPDATE waste_scan_rules SET label=?, service_code=?, hazardous=?, tip=? WHERE category=?`,
      String(b.label || rule.label).slice(0, 80), b.service_code, b.hazardous ? 1 : 0, String(b.tip || '').slice(0, 300), rule.category);
    res.json({ ok: true });
  });
}

ensureSchema();

// Mounted ahead of the global text-length guard in index.js (the photo is a long data URL).
const scanRoute = [cust, scanHandler];

module.exports = { mountGrowthRoutes, scanRoute, startHealth, recalcHealth, scoreCustomer, rateSegregation, estimate, leaderboard };
