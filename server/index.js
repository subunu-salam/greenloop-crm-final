// Security bootstrap must run first: it guarantees a strong JWT secret
// before any module reads process.env.JWT_SECRET.
const security = require('./security');
security.ensureSecret();
const jwt = require('jsonwebtoken');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const dbMod = require('./db');
const buildApi = require('./api');
const { mountCustomerRoutes } = require('./customer-api');
const { mountTrackingRoutes } = require('./tracking-api');
const { mountOpsFeatureRoutes } = require('./ops-features');
const { mountAiRoutes } = require('./ai-api');
const { mountPushRoutes } = require('./push-api');
const { mountFleetMaintenanceRoutes } = require('./fleet-maintenance');
const v3 = require('./v3');
const scheduler = require('./services/scheduler');
const sla = require('./services/sla');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((s) => s.trim()) },
});

// CORS: the API uses bearer tokens (no cookies), so credentials are never needed.
// With CORS_ORIGIN='*' we send a literal '*'; otherwise only listed origins are echoed.
const ALLOWED = CORS_ORIGIN === '*' ? null : CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!ALLOWED) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '2mb' }));

const apiRouter = buildApi(io);
mountCustomerRoutes(apiRouter, io);
mountTrackingRoutes(apiRouter, io);
mountOpsFeatureRoutes(apiRouter, io);
mountAiRoutes(apiRouter);
mountPushRoutes(apiRouter, io);
mountFleetMaintenanceRoutes(apiRouter, io);
v3.mountV3Routes(apiRouter, io);
// Brute-force protection on every sign-in route (failed attempts → lockout).
const L = (name, opts) => security.loginThrottle(name, opts);
app.use('/api/v1/auth/admin-login', L('admin', { max: 5, idFrom: (r) => r.body && r.body.username }));
app.use('/api/v1/auth/driver-login', L('driver', { max: 8 }));
app.use('/api/v1/auth/customer-login', L('customer', { max: 5, idFrom: (r) => r.body && r.body.phone }));
app.use('/api/v1/auth/customer-otp/verify', L('otp', { max: 5, idFrom: (r) => r.body && r.body.identifier }));
app.use('/api/v1/auth/customer-otp/request', security.rateLimit('otpsend', { max: 3, windowMs: 15 * 60e3, idFrom: (r) => r.body && r.body.identifier }));
app.use('/api/v1', security.limitTextFields, security.signUploadLinks, v3.guard, apiRouter);
// public quotation link used in quotation emails (and WhatsApp fallback)
app.get('/q/:token', (req, res) => res.redirect('/api/v1/public/quotations/' + encodeURIComponent(req.params.token)));
app.use(express.urlencoded({ extended: false }));

// Proof photos are private: only links signed by the API are served.
app.use('/uploads', security.uploadsGate, express.static(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), { index: false, dotfiles: 'deny' }));
app.use('/crm', express.static(path.join(__dirname, '..', 'public', 'crm')));
app.use('/driver', express.static(path.join(__dirname, '..', 'public', 'driver')));
app.use('/customer', express.static(path.join(__dirname, '..', 'public', 'customer')));

const crmV2 = path.join(__dirname, '..', 'public', 'crm-v2');
app.use('/crm-v2', express.static(crmV2));
app.get('/crm-v2/*splat', (req, res) => {
  res.sendFile(path.join(crmV2, 'index.html'), (err) => {
    if (err) res.redirect('/crm');
  });
});

app.get('/', (req, res) => res.redirect('/crm'));

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

// Live updates require a valid login. Each user only joins their own rooms:
// staff (office + drivers) get operational events, a customer only their site's.
io.use((socket, next) => {
  try {
    const t = (socket.handshake.auth && socket.handshake.auth.token) || '';
    socket.data.user = jwt.verify(String(t), process.env.JWT_SECRET);
    next();
  } catch { next(new Error('unauthorized')); }
});
io.on('connection', (socket) => {
  const u = socket.data.user || {};
  if (u.role === 'admin') socket.join(['staff', 'ops']);
  else if (u.role === 'driver') socket.join(['staff', 'driver:' + u.id]);
  else if (u.role === 'customer' && u.customer_id) socket.join('customer:' + u.customer_id);
  // kept for older app versions: a customer may only (re)join their own room
  socket.on('customer:join', (data) => {
    if (u.role === 'customer' && data && Number(data.customer_id) === Number(u.customer_id)) socket.join('customer:' + u.customer_id);
  });
  socket.on('ops:join', () => { if (u.role === 'admin') socket.join('ops'); });
});

async function boot() {
  if (dbMod.isPg && dbMod.ensureSchema) {
    console.log('✔ Using Neon / PostgreSQL');
    await dbMod.ensureSchema();
    const seeded = await dbMod.seed();
    if (seeded) console.log('✔ Seeded demo data');
  } else {
    const seeded = dbMod.seed();
    if (seeded) console.log('✔ Seeded SQLite demo');
    require('./customer-api').seedPortalCodes();
  }
  try {
    require('./push');
    console.log('✔ Web Push (VAPID) ready');
  } catch (e) {
    console.warn('Push:', e.message);
  }
  try {
    const now = new Date();
    const gen = scheduler.generateMonth(now.getFullYear(), now.getMonth() + 1);
    if (gen && !gen.skipped) console.log(`✔ Generated ${gen.created} pickups`);
  } catch (e) {
    console.warn('Scheduler:', e.message);
  }
  try {
    sla.start(io);
    v3.start(io);
  } catch (e) {
    console.warn('SLA:', e.message);
  }
  server.listen(PORT, () => {
    console.log(`GreenLoop on :${PORT} · PWA push enabled`);
  });
}

boot().catch((e) => {
  console.error('Boot failed:', e);
  process.exit(1);
});
