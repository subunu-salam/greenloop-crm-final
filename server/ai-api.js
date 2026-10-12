const { buildOpsBrief, customerRiskHints } = require('./ai');
const insights = require('./insights');   // v3.5 AI insights and performance reports
const jwt = require('jsonwebtoken');
require('./security').ensureSecret();
const SECRET = process.env.JWT_SECRET;

function authAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const p = jwt.verify(token, SECRET);
    if (p.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = p;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function mountAiRoutes(r) {
  mountInsightRoutes(r);
  r.get('/ai/ops-brief', authAdmin, async (req, res) => {
    try {
      const brief = await buildOpsBrief();
      res.json(brief);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/ai/customer-risk/:id', authAdmin, (req, res) => {
    try {
      res.json({ customer_id: Number(req.params.id), risks: customerRiskHints(Number(req.params.id)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// v3.5: AI insights. ?source=auto (default: your data when there is enough of it, else demo) | live | demo
const src = req => (['live', 'demo'].includes(req.query.source) ? req.query.source : 'auto');
function mountInsightRoutes(r) {
  const run = fn => (req, res) => { try { res.json(fn(req)); } catch (e) { console.error('insights:', e); res.status(500).json({ error: 'Could not build the insights: ' + e.message }); } };
  r.get('/ai/insights', authAdmin, run(req => insights.overview(src(req))));
  r.get('/ai/reports/daily', authAdmin, run(req => insights.dailyReport(src(req), req.query.date)));
  r.get('/ai/reports/weekly', authAdmin, run(req => insights.weeklyReport(src(req), req.query.end)));
}

module.exports = { mountAiRoutes, mountInsightRoutes };
