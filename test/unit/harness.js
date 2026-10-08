const Module = require('module');
const path = require('path');
// Runs the real server modules against a throwaway SQLite file. Express, JWT,
// bcrypt, multer and web-push are replaced by tiny stand-ins so the suite
// needs no npm install and no network (handy in CI).
const os = require('os');
const TMP = require('fs').mkdtempSync(path.join(os.tmpdir(), 'greenloop-test-'));
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.DATA_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
require('fs').rmSync(process.env.DB_PATH, { force: true });
const stubs = {
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
db.seed();
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
module.exports = { call, tok, db, v3, emitted, webpush: stubs['web-push'] };
