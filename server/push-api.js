const push = require('./push');
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function authAny(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function mountPushRoutes(r) {
  r.get('/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: push.getPublicKey() });
  });

  r.post('/push/subscribe', authAny, (req, res) => {
    try {
      const subscription = (req.body || {}).subscription;
      if (!subscription) return res.status(400).json({ error: 'subscription required' });
      const role = req.user.role;
      const user_ref =
        role === 'customer'
          ? String(req.user.customer_id || req.user.id)
          : String(req.user.id);
      push.saveSubscription({ role, user_ref, subscription });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/push/unsubscribe', authAny, (req, res) => {
    const endpoint = (req.body || {}).endpoint;
    if (endpoint) push.removeSubscription(endpoint);
    res.json({ ok: true });
  });
}

module.exports = { mountPushRoutes };
