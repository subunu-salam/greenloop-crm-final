// ─────────────────────────────────────────────────────────────
// Security helpers: secret bootstrap, login throttling, signed
// photo links, upload filtering and input validation.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

/* ── 1. JWT secret ───────────────────────────────────────────
   Never fall back to a public default. If JWT_SECRET is not set we
   create a random one and keep it in DATA_DIR so sessions survive
   restarts (on a disk-less host they simply reset). Must run before
   any module that reads process.env.JWT_SECRET is required. */
function ensureSecret() {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16 && s !== 'change-me-in-production') return 'env';
  const file = path.join(DATA_DIR, 'jwt-secret');
  let secret = null;
  try { secret = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!secret || secret.length < 32) {
    secret = crypto.randomBytes(48).toString('hex');
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, secret, { mode: 0o600 }); } catch {}
  }
  process.env.JWT_SECRET = secret;
  if (IS_PROD) console.warn('⚠ JWT_SECRET not set — using a generated secret stored in ' + file + '. Set JWT_SECRET in your host settings.');
  return 'generated';
}

/* ── 2. Login throttling ─────────────────────────────────────
   Counts FAILED attempts (HTTP 400/401) per IP and per identifier.
   After `max` failures inside `windowMs` further attempts get 429
   until the window passes. A success clears the identifier's count. */
const buckets = new Map();            // key -> { n, until, first }
function hitBucket(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.first > windowMs) b = { n: 0, first: now, until: 0 };
  b.n++; buckets.set(key, b); return b;
}
function lockedFor(key) {
  const b = buckets.get(key); if (!b) return 0;
  return b.until > Date.now() ? Math.ceil((b.until - Date.now()) / 1000) : 0;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.first > 3600e3 && b.until < now) buckets.delete(k); }, 600e3).unref?.();

const clientIp = (req) => String((req.headers && (req.headers['x-forwarded-for'] || '')).split(',')[0].trim() || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');

function loginThrottle(name, { max = 5, windowMs = 15 * 60e3, lockMs = 15 * 60e3, idFrom = () => '' } = {}) {
  return (req, res, next) => {
    const ipKey = `${name}:ip:${clientIp(req)}`;
    const id = String(idFrom(req) || '').toLowerCase().replace(/\s+/g, '');
    const idKey = id ? `${name}:id:${id}` : null;
    const wait = Math.max(lockedFor(ipKey), idKey ? lockedFor(idKey) : 0);
    if (wait) {
      if (res.setHeader) res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
    }
    const json = res.json;
    res.json = function (body) {
      const code = this.statusCode || 200;
      if (code === 401 || code === 400) {
        for (const k of [ipKey, idKey].filter(Boolean)) {
          const b = hitBucket(k, windowMs);
          if (b.n >= max) b.until = Date.now() + lockMs;
        }
      } else if (code < 300 && idKey) buckets.delete(idKey);
      return json.call(this, body);
    };
    next();
  };
}

// Simple request-rate limit (counts every request), used for OTP sending.
function rateLimit(name, { max, windowMs, idFrom = () => '' }) {
  return (req, res, next) => {
    const keys = [`${name}:ip:${clientIp(req)}`];
    const id = String(idFrom(req) || '').toLowerCase().replace(/\s+/g, '');
    if (id) keys.push(`${name}:id:${id}`);
    for (const k of keys) {
      const b = hitBucket(k, windowMs);
      if (b.n > max) {
        const wait = Math.ceil((b.first + windowMs - Date.now()) / 1000);
        if (res.setHeader) res.setHeader('Retry-After', String(wait));
        return res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(wait / 60)} min.` });
      }
    }
    next();
  };
}
const _resetThrottles = () => buckets.clear();   // tests only

/* ── 3. Signed photo links ───────────────────────────────────
   Proof photos are private. API responses get links with an expiry
   and HMAC signature; /uploads only serves correctly signed links. */
const LINK_TTL_S = 12 * 3600;
const sigFor = (file, exp) => crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(`${file}|${exp}`).digest('base64url').slice(0, 32);
function signUploadUrl(url) {
  const m = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!m) return url;
  const exp = Math.floor(Date.now() / 1000 / 3600) * 3600 + LINK_TTL_S;   // hour-aligned → cache friendly
  return `${url}?exp=${exp}&sig=${sigFor(m[1], exp)}`;
}
function signDeep(v, depth = 0) {
  if (depth > 8 || v == null) return v;
  if (typeof v === 'string') return v.startsWith('/uploads/') ? signUploadUrl(v) : v;
  if (Array.isArray(v)) return v.map((x) => signDeep(x, depth + 1));
  if (typeof v === 'object') { const o = {}; for (const k in v) o[k] = signDeep(v[k], depth + 1); return o; }
  return v;
}
// Rewrites /uploads/… links in JSON and HTML responses of the API.
function signUploadLinks(req, res, next) {
  const json = res.json, send = res.send;
  res.json = function (body) { return json.call(this, signDeep(body)); };
  res.send = function (body) {
    if (typeof body === 'string' && body.includes('/uploads/'))
      body = body.replace(/(["'(])(\/uploads\/[A-Za-z0-9._-]+)(?=["')])/g, (_, q, u) => q + signUploadUrl(u));
    return send.call(this, body);
  };
  next();
}
function uploadsGate(req, res, next) {
  const file = decodeURIComponent((req.path || '').replace(/^\//, ''));
  const exp = Number(req.query && req.query.exp), sig = String((req.query && req.query.sig) || '');
  const good = /^[A-Za-z0-9._-]+$/.test(file) && exp > Date.now() / 1000 && sig.length === 32 &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sigFor(file, exp)));
  if (!good) return res.status(403).send('Forbidden');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

/* ── 4. Upload filtering ─────────────────────────────────────
   Only real image types; the stored name is random and its extension
   comes from the type, never from the phone's file name. */
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };
const imageFileFilter = (req, file, cb) => {
  if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
  const err = new Error('Only photos (JPEG, PNG, WebP, HEIC) can be uploaded'); err.status = 415; cb(err);
};
const safeImageName = (prefix) => (req, file, cb) =>
  cb(null, `${prefix}_${crypto.randomBytes(12).toString('hex')}${IMAGE_TYPES[file.mimetype] || '.jpg'}`);

/* ── 5. Input validation ─────────────────────────────────────*/
const MAX_TEXT = 5000;
function findLongString(v, depth = 0) {
  if (depth > 8 || v == null) return null;
  if (typeof v === 'string') return v.length > MAX_TEXT ? v : null;
  if (typeof v === 'object') for (const k in v) { const hit = findLongString(v[k], depth + 1); if (hit) return k; }
  return null;
}
// Rejects any request whose JSON body carries a text field over 5,000 characters.
function limitTextFields(req, res, next) {
  const hit = req.body && findLongString(req.body);
  if (hit) return res.status(400).json({ error: `A text field is too long (max ${MAX_TEXT} characters)` });
  next();
}
// Real calendar date in YYYY-MM-DD form.
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// Date is real and within [today - pastDays, today + futureDays].
function dateInRange(s, { pastDays = 0, futureDays = 366 } = {}) {
  if (!isRealDate(s)) return 'Enter a valid date (YYYY-MM-DD)';
  const today = new Date().toISOString().slice(0, 10);
  const shift = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  if (s < shift(-pastDays)) return pastDays ? `Date cannot be more than ${pastDays} days in the past` : 'Date cannot be in the past';
  if (s > shift(futureDays)) return `Date cannot be more than ${futureDays} days ahead`;
  return null;
}
// "HH:MM-HH:MM" with the end after the start.
function windowError(w) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(w || ''));
  if (!m) return 'Time window must look like 07:00-12:00';
  if (Number(m[3]) * 60 + Number(m[4]) <= Number(m[1]) * 60 + Number(m[2])) return 'Time window must end after it starts';
  return null;
}
// UAE-friendly phone check: optional +, 7–15 digits after removing spaces, dashes and brackets.
const phoneDigits = (p) => String(p || '').replace(/[\s\-().]/g, '');
const isPhone = (p) => /^\+?\d{7,15}$/.test(phoneDigits(p));
const isEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(e || ''));
// Last 9 digits — matches 050…, +97150…, 0097150… as the same number.
const phoneKey = (p) => phoneDigits(p).replace(/\D/g, '').slice(-9);

/* ── 6. Driver job rules ─────────────────────────────────────
   A driver may act only on a job assigned to them (or, if no driver is
   set, to their truck), and only on or after its scheduled day.
   "Today" is the later of the UAE date and the UTC date. */
const APP_TZ = process.env.APP_TZ || 'Asia/Dubai';
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function driverJobError(p, user) {
  const mine = p.driver_id ? Number(p.driver_id) === Number(user.id)
    : !!(user.vehicle_id && Number(p.vehicle_id) === Number(user.vehicle_id));
  if (!mine) return [403, 'This job is not assigned to you'];
  const today = [localToday(), new Date().toISOString().slice(0, 10)].sort()[1];
  if (p.scheduled_date > today) return [409, `This job is scheduled for ${p.scheduled_date} and can only be done on that day`];
  return null;
}

module.exports = { driverJobError, localToday,
  IS_PROD, ensureSecret, loginThrottle, rateLimit, clientIp, _resetThrottles,
  signUploadUrl, signUploadLinks, uploadsGate, imageFileFilter, safeImageName, IMAGE_TYPES,
  limitTextFields, isRealDate, dateInRange, windowError, isPhone, isEmail, phoneKey, MAX_TEXT,
};
