const { buildOpsBrief, customerRiskHints } = require('./ai');
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

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

module.exports = { mountAiRoutes };
