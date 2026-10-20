const Module = require('module');
const path = require('path');
// Runs the real server modules against an in-memory stand-in for Prisma
// (test/fake-prisma.js — it follows prisma/schema.prisma and MongoDB's rules).
// Express, JWT, bcrypt, multer and web-push are replaced by tiny stand-ins too,
// so the suite needs no npm install, no MongoDB and no network (handy in CI).
// Each test file starts with `await ready` (the demo data is seeded asynchronously).
//
// TEST_MONGO=1 runs the same tests against a REAL MongoDB instead (npm run test:mongo):
// the database in TEST_DATABASE_URL is emptied at the start of every suite.
const os = require('os');
const TMP = require('fs').mkdtempSync(path.join(os.tmpdir(), 'greenloop-test-'));
process.env.DATA_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
const REAL_DB = process.env.TEST_MONGO === '1';
if (REAL_DB) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'mongodb://127.0.0.1:27017/greenloop_test?replicaSet=rs0';
const stubs = {
  ...(REAL_DB ? {} : { '@prisma/client': require('../fake-prisma') }),
  jsonwebtoken: { sign: (p) => 'T.' + Buffer.from(JSON.stringify(p)).toString('base64'), verify: (t) => { if (!t.startsWith('T.')) throw new Error('bad'); return JSON.parse(Buffer.from(t.slice(2), 'base64').toString()); } },
  bcryptjs: { hashSync: x => 'h:' + x, compareSync: (a, h) => h === 'h:' + a },
  multer: Object.assign(() => ({ single: () => (req, res, next) => next(), fields: () => (req, res, next) => next() }), { diskStorage: () => ({}) }),
  // records every push so tests can assert who was notified; an endpoint containing "gone" simulates an expired subscription
  'web-push': { sent: [], setVapidDetails() {}, generateVAPIDKeys: () => ({ publicKey: 'x', privateKey: 'y' }),
    sendNotification: async function (sub, body) { if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; } if (sub.endpoint.includes('boom')) { const e = new Error('server'); e.statusCode = 500; throw e; } this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) }); } },
  express: Object.assign(() => ({}), { Router: () => {
    const routes = [];
    const add = m => (p, ...h) => routes.push({ m, p, h });
    return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), use() {} };
  } }),
};
const orig = Module._load;
Module._load = function (req, ...a) { if (stubs[req]) return stubs[req]; return orig.call(this, req, ...a); };
const SRV = path.join(__dirname, '..', '..', 'server') + path.sep;
const db = require(SRV + 'db');
const { prisma } = db;
const emitted = [];
const io = { emit: (e, d) => emitted.push(e), to: (room) => ({ emit: (e, d) => emitted.push(room + '|' + e) }) };
const router = require(SRV + 'api')(io);
require(SRV + 'customer-api').mountCustomerRoutes(router, io);
require(SRV + 'ops-features').mountOpsFeatureRoutes(router, io);
const v3 = require(SRV + 'v3');
v3.mountV3Routes(router, io);
require(SRV + 'push-api').mountPushRoutes(router, io);
require(SRV + 'fleet-maintenance').mountFleetMaintenanceRoutes(router, io);
require(SRV + 'driver-shift').mountDriverShiftRoutes(router, io);
require(SRV + 'ai-api').mountAiRoutes(router, io);   // v3.5 AI insights
require(SRV + 'growth').mountGrowthRoutes(router, io);   // health score, rewards, waste scanner
require(SRV + 'care').mountCareRoutes(router, io);       // issues, visit history, follow-up
const tok = p => 'T.' + Buffer.from(JSON.stringify(p)).toString('base64');
function match(route, m, url) {
  if (route.m !== m) return null;
  const rp = route.p.split('/'), up = url.split('?')[0].split('/');
  if (rp.length !== up.length) return null;
  const params = {};
  for (let i = 0; i < rp.length; i++) { if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(up[i]); else if (rp[i] !== up[i]) return null; }
  return params;
}
async function call(m, url, { token, body, file, files, pre = [], ip = '10.0.0.1' } = {}) {
  const route = router.routes.find(r => match(r, m, url));
  if (!route) throw new Error('no route ' + m + ' ' + url);
  const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
  const req = { method: m, params: match(route, m, url), query, body: body || {}, headers: token ? { authorization: 'Bearer ' + token } : {}, file, files, ip, socket: { remoteAddress: ip }, protocol: 'http', get: () => 'localhost:3000' };
  return new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); }, send(o) { resolve({ status: this.statusCode, body: o }); }, type() { return this; }, on() {} };
    let i = 0;
    const next = async () => { const hnd = [...pre, ...route.h][i++]; if (hnd) await hnd(req, res, next); };
    next();
  });
}
// the same first-run steps server/index.js performs at boot
const ready = (async () => {
  if (REAL_DB) for (const m of Object.values(db.MODELS)) await db.base[m.delegate].deleteMany({});   // fresh database per suite
  await db.seed();
  await v3.init();
  await require(SRV + 'growth').init();
  await require(SRV + 'customer-api').seedPortalCodes();
})();
module.exports = { call, tok, db, prisma, v3, emitted, ready, webpush: stubs['web-push'] };
