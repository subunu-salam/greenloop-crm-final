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
const scheduler = require('./services/scheduler');
const sla = require('./services/sla');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((s) => s.trim()) },
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ORIGIN === '*' || (origin && CORS_ORIGIN.split(',').map((s) => s.trim()).includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '2mb' }));

const apiRouter = buildApi(io);
mountCustomerRoutes(apiRouter, io);
mountTrackingRoutes(apiRouter, io);
mountOpsFeatureRoutes(apiRouter, io);
mountAiRoutes(apiRouter);
mountPushRoutes(apiRouter);
app.use('/api/v1', apiRouter);

app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')));
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

app.get('/', (req, res) => res.redirect('/crm-v2'));

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(400).json({ error: err.message });
});

io.on('connection', (socket) => {
  socket.on('customer:join', (data) => {
    if (data && data.customer_id) socket.join('customer:' + data.customer_id);
  });
  socket.on('ops:join', () => socket.join('ops'));
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
