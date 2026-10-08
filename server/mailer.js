// ─────────────────────────────────────────────────────────────
// Gmail mailer (v3.2) — quotations go out by email, not WhatsApp.
// No extra npm packages. Two free ways to connect a Gmail account:
//
//   A) Gmail API (OAuth)      GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//   B) Gmail SMTP app password GMAIL_USER, GMAIL_APP_PASSWORD
//
// Common:  GMAIL_USER (the sending address), MAIL_FROM_NAME (default "GreenLoop").
// If neither is configured the CRM falls back to opening a pre-filled Gmail
// compose window (composeUrl) so the workflow still works on day one.
// ─────────────────────────────────────────────────────────────
const tls = require('tls');
const crypto = require('crypto');

const env = (k) => (process.env[k] || '').trim();

function mode() {
  if (env('GMAIL_CLIENT_ID') && env('GMAIL_CLIENT_SECRET') && env('GMAIL_REFRESH_TOKEN')) return 'api';
  if (env('GMAIL_USER') && env('GMAIL_APP_PASSWORD')) return 'smtp';
  return null;
}
function status() {
  const m = mode();
  return { configured: !!m, mode: m, sender: env('GMAIL_USER') || null, from_name: env('MAIL_FROM_NAME') || 'GreenLoop' };
}

const isEmail = (s) => /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(String(s || ''));
// header values must never contain line breaks (header injection)
const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const b64Lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

function buildMime({ to, subject, text, html, replyTo }) {
  const st = status();
  const from = st.sender ? `${encWord(oneLine(st.from_name))} <${st.sender}>` : encWord(oneLine(st.from_name));
  const boundary = 'gl_' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${from}`,
    `To: ${oneLine(to)}`,
    `Subject: ${encWord(oneLine(subject))}`,
    replyTo && isEmail(replyTo) ? `Reply-To: ${oneLine(replyTo)}` : null,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@greenloop>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Lines(body)}\r\n`;
  return headers.join('\r\n') + '\r\n\r\n' + part('text/plain', text || '') + (html ? part('text/html', html) : '') + `--${boundary}--\r\n`;
}

// ── A) Gmail API ─────────────────────────────────────────────
let cachedToken = null; // { token, exp }
async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60e3) return cachedToken.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GMAIL_CLIENT_ID'), client_secret: env('GMAIL_CLIENT_SECRET'),
      refresh_token: env('GMAIL_REFRESH_TOKEN'), grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error('Gmail sign-in failed: ' + (data.error_description || data.error || res.status));
  cachedToken = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3000) * 1000 };
  return cachedToken.token;
}
async function sendViaApi(mime) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (await accessToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Gmail refused the message: ' + ((data.error && data.error.message) || res.status));
  return { id: data.id || null };
}

// ── B) Gmail SMTP (smtp.gmail.com:465, implicit TLS, AUTH LOGIN) ──
function sendViaSmtp(mime, to) {
  const user = env('GMAIL_USER'), pass = env('GMAIL_APP_PASSWORD').replace(/\s+/g, '');
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: env('SMTP_HOST') || 'smtp.gmail.com', port: Number(env('SMTP_PORT')) || 465, servername: env('SMTP_HOST') || 'smtp.gmail.com' });
    let buf = '', step = 0, done = false;
    const fail = (e) => { if (done) return; done = true; try { sock.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    // dot-stuffing: a line starting with "." must be doubled inside DATA
    const data = mime.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const script = [
      [220, () => `EHLO greenloop`],
      [250, () => `AUTH LOGIN`],
      [334, () => Buffer.from(user).toString('base64')],
      [334, () => Buffer.from(pass).toString('base64')],
      [235, () => `MAIL FROM:<${user}>`],
      [250, () => `RCPT TO:<${to}>`],
      [250, () => `DATA`],
      [354, () => data + '\r\n.'],
      [250, () => `QUIT`],
    ];
    sock.setTimeout(20000, () => fail(new Error('Gmail SMTP timed out')));
    sock.on('error', fail);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // a reply is complete when its last line is "NNN <text>" (space, not dash)
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last) || !buf.endsWith('\r\n')) return;
      const code = Number(last.slice(0, 3)); buf = '';
      if (step >= script.length) { done = true; sock.end(); return resolve({ id: null }); }
      const [expect, next] = script[step];
      if (code !== expect) {
        const hint = code === 535 ? ' — check GMAIL_USER and the 16-character app password' : '';
        return fail(new Error(`Gmail SMTP error ${last}${hint}`));
      }
      step++;
      sock.write(next() + '\r\n');
    });
    sock.on('close', () => { if (!done) fail(new Error('Gmail SMTP connection closed early')); });
  });
}

async function send({ to, subject, text, html, replyTo }) {
  to = oneLine(to);
  if (!isEmail(to)) { const e = new Error('The recipient has no valid email address'); e.status = 400; throw e; }
  const m = mode();
  if (!m) { const e = new Error('Gmail is not connected on the server yet'); e.status = 503; e.code = 'MAIL_NOT_CONFIGURED'; throw e; }
  const mime = buildMime({ to, subject, text, html, replyTo });
  const out = m === 'api' ? await sendViaApi(mime) : await sendViaSmtp(mime, to);
  return { ok: true, mode: m, ...out };
}

// Zero-setup fallback: opens Gmail in the browser with everything filled in.
function composeUrl({ to, subject, text }) {
  const p = new URLSearchParams({ view: 'cm', fs: '1', to: oneLine(to || ''), su: oneLine(subject || ''), body: String(text || '').slice(0, 1800) });
  return 'https://mail.google.com/mail/?' + p.toString();
}

module.exports = { send, status, composeUrl, isEmail, buildMime, mode };
