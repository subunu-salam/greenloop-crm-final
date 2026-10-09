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

// v3.4.3: two email services that work over the normal web port (HTTPS), so they also work on
// hosts that block mail ports 465/587 (for example free Render web services):
//   C) Resend   RESEND_API_KEY + MAIL_FROM (an address on a domain verified in Resend)
//   D) Brevo    BREVO_API_KEY  + MAIL_FROM (a sender verified in Brevo)
// The first one configured wins, in this order: Resend, Brevo, Gmail API, Gmail app password.
const LABELS = { resend: 'Resend', brevo: 'Brevo', api: 'Gmail API', smtp: 'Gmail SMTP' };
function mode() {
  if (env('RESEND_API_KEY')) return 'resend';
  if (env('BREVO_API_KEY')) return 'brevo';
  if (env('GMAIL_CLIENT_ID') && env('GMAIL_CLIENT_SECRET') && env('GMAIL_REFRESH_TOKEN')) return 'api';
  if (env('GMAIL_USER') && env('GMAIL_APP_PASSWORD')) return 'smtp';
  return null;
}
// the address customers see as the sender
function senderFor(m) {
  if (m === 'resend') return env('MAIL_FROM') || 'onboarding@resend.dev';   // resend.dev only delivers to the Resend account owner (testing)
  if (m === 'brevo') return env('MAIL_FROM') || env('GMAIL_USER') || null;
  return env('GMAIL_USER') || env('MAIL_FROM') || null;
}
function status() {
  const m = mode();
  const sender = senderFor(m);
  const out = { configured: !!m && !!sender, mode: m, provider: m ? LABELS[m] : null, sender, from_name: env('MAIL_FROM_NAME') || 'GreenLoop' };
  if (m === 'resend' && !env('MAIL_FROM')) out.note = 'Test mode: without MAIL_FROM, Resend only delivers to the email address of the Resend account. Verify a domain in Resend and set MAIL_FROM to an address on it.';
  if (m === 'brevo' && !sender) out.note = 'Set MAIL_FROM to a sender address verified in Brevo.';
  return out;
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

// ── C) Resend and D) Brevo: one HTTPS call each ──────────────
const fromHeader = () => { const st = status(); return `${oneLine(st.from_name)} <${st.sender}>`; };
async function sendViaResend({ to, subject, text, html, replyTo }) {
  const res = await fetch(env('RESEND_API_URL') || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromHeader(), to: [to], subject: oneLine(subject), text: text || '', ...(html ? { html } : {}), ...(replyTo && isEmail(replyTo) ? { reply_to: oneLine(replyTo) } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data.message || (data.error && data.error.message) || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' Check RESEND_API_KEY.'
      : res.status === 403 ? ' Resend only sends to other people from a verified domain: add your domain at resend.com/domains, then set MAIL_FROM to an address on it (for example quotes@yourdomain.com).'
      : res.status === 429 ? ' The free plan allows 100 emails a day.' : '';
    throw Object.assign(new Error(`Resend refused the message: ${why}.${hint}`), { status: 502, code: 'MAIL_REFUSED' });
  }
  return { id: data.id || null };
}
async function sendViaBrevo({ to, subject, text, html, replyTo }) {
  const st = status();
  const res = await fetch(env('BREVO_API_URL') || 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env('BREVO_API_KEY'), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: oneLine(st.from_name), email: st.sender }, to: [{ email: to }], subject: oneLine(subject), textContent: text || ' ', ...(html ? { htmlContent: html } : {}), ...(replyTo && isEmail(replyTo) ? { replyTo: { email: oneLine(replyTo) } } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data.message || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' Check BREVO_API_KEY.' : /sender/i.test(why) ? ' Verify the MAIL_FROM address under Senders in Brevo.' : '';
    throw Object.assign(new Error(`Brevo refused the message: ${why}.${hint}`), { status: 502, code: 'MAIL_REFUSED' });
  }
  return { id: data.messageId || null };
}

// ── B) Gmail SMTP with an app password ───────────────────────
// v3.4.2: tries port 465 (TLS from the start), then port 587 (STARTTLS), over IPv4 first.
// A failure always carries a readable reason: Node's own network errors can have an
// empty message (that is what produced the bare "Email not sent:" toast).
const net = require('net');
function describe(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code && !String(e.message || '').includes(e.code)) parts.push(e.code);
  if (Array.isArray(e.errors)) { const inner = [...new Set(e.errors.map(x => x && (x.code || x.message)).filter(Boolean))].join(', '); if (inner && !parts.join(' ').includes(inner)) parts.push(inner); }
  return parts.join(' · ') || e.name || 'unknown error';
}
// Runs one SMTP conversation on an open socket. script = [[expectedCode, textToSendNext | null], …]
// Resolves when the last expected reply arrived. A wrong reply code rejects with err.smtp = true.
function dialog(sock, script, first) {
  return new Promise((resolve, reject) => {
    let buf = '', step = 0, done = false;
    const finish = (err) => { if (done) return; done = true; sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('close', onClose); sock.setTimeout(0); err ? reject(err) : resolve(); };
    const onErr = (e) => finish(e instanceof Error ? e : new Error(String(e)));
    const onClose = () => finish(Object.assign(new Error('the mail server closed the connection early'), { code: 'ECONNRESET' }));
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // a reply is complete when its last line is "NNN <text>" (space, not dash)
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last) || !buf.endsWith('\r\n')) return;
      const code = Number(last.slice(0, 3)); buf = '';
      const [expect, next] = script[step];
      if (code !== expect) {
        const hint = code === 535 || code === 534 ? ' Gmail did not accept the sign-in: check GMAIL_USER, and that GMAIL_APP_PASSWORD is a 16-letter app password (Google Account → Security → 2-Step Verification → App passwords), not your normal password.' : '';
        return finish(Object.assign(new Error(`Gmail answered "${last}".${hint}`), { smtp: true, smtpCode: code }));
      }
      step++;
      if (next != null) sock.write(next + '\r\n');
      if (step >= script.length) finish();
    };
    sock.setTimeout(20000, () => finish(Object.assign(new Error('no answer from the mail server for 20 seconds'), { code: 'ETIMEDOUT' })));
    sock.on('data', onData); sock.on('error', onErr); sock.on('close', onClose);
    if (first != null) sock.write(first + '\r\n');
  });
}
// open a socket, failing with a real reason if it does not connect within 8 s
function connect(make, event) {
  return new Promise((resolve, reject) => {
    let sock, settled = false;
    const end = (err) => { if (settled) return; settled = true; clearTimeout(t); if (err) { try { sock && sock.destroy(); } catch {} reject(err); } else { sock.removeListener('error', end); resolve(sock); } };
    const t = setTimeout(() => end(Object.assign(new Error('no connection after 8 seconds'), { code: 'ETIMEDOUT' })), 8000);
    try { sock = make(); } catch (e) { return end(e); }
    sock.once('error', end);
    sock.once(event, () => end());
  });
}
async function smtpOnce({ host, port, startTls, family }, user, pass, to, data) {
  const fam = family ? { family, autoSelectFamily: false } : {};
  const tail = [
    [250, 'AUTH LOGIN'],
    [334, Buffer.from(user).toString('base64')],
    [334, Buffer.from(pass).toString('base64')],
    [235, `MAIL FROM:<${user}>`],
    [250, `RCPT TO:<${to}>`],
    [250, 'DATA'],
    [354, data + '\r\n.'],
    [250, 'QUIT'],
  ];
  let sock;
  try {
    if (!startTls) {
      sock = await connect(() => tls.connect({ host, port, servername: host, ...fam }), 'secureConnect');
      await dialog(sock, [[220, 'EHLO greenloop'], ...tail]);
    } else {
      const plain = await connect(() => net.connect({ host, port, ...fam }), 'connect');
      sock = plain;
      await dialog(plain, [[220, 'EHLO greenloop'], [250, 'STARTTLS'], [220, null]]);
      sock = await connect(() => tls.connect({ socket: plain, servername: host }), 'secureConnect');
      await dialog(sock, tail, 'EHLO greenloop');
    }
  } finally { try { sock && sock.end(); } catch {} }
  return { id: null, port };
}
async function sendViaSmtp(mime, to) {
  const user = env('GMAIL_USER'), pass = env('GMAIL_APP_PASSWORD').replace(/\s+/g, '');
  const host = env('SMTP_HOST') || 'smtp.gmail.com';
  // dot-stuffing: a line starting with "." must be doubled inside DATA
  const data = mime.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  const fixed = Number(env('SMTP_PORT'));
  const routes = fixed ? [{ host, port: fixed, startTls: fixed !== 465, family: 4 }, { host, port: fixed, startTls: fixed !== 465 }]
    : [{ host, port: 465, startTls: false, family: 4 }, { host, port: 587, startTls: true, family: 4 }, { host, port: 465, startTls: false }];
  const tried = [];
  for (const r of routes) {
    try { return await smtpOnce(r, user, pass, to, data); }
    catch (e) {
      if (e.smtp) throw e;                                   // Gmail answered and said no: another port will not help
      tried.push(`port ${r.port}${r.family ? '' : ' (IPv6)'}: ${describe(e)}`);
    }
  }
  const err = new Error(`Could not connect to Gmail's mail server (${host}) from this computer. ${[...new Set(tried)].join('; ')}. ` +
    'The network, an antivirus or the hosting provider is blocking outgoing mail ports 465 and 587. Try another network such as a phone hotspot, ' +
    'or connect Gmail through the Gmail API (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN), which uses the normal web port.');
  err.code = 'MAIL_NETWORK'; err.status = 502;
  throw err;
}

async function send({ to, subject, text, html, replyTo }) {
  to = oneLine(to);
  if (!isEmail(to)) { const e = new Error('The recipient has no valid email address'); e.status = 400; throw e; }
  const m = mode();
  if (!m || !status().configured) { const e = new Error(status().note || 'Email is not connected on the server yet'); e.status = 503; e.code = 'MAIL_NOT_CONFIGURED'; throw e; }
  let out;
  try {
    if (m === 'resend') out = await sendViaResend({ to, subject, text, html, replyTo });
    else if (m === 'brevo') out = await sendViaBrevo({ to, subject, text, html, replyTo });
    else { const mime = buildMime({ to, subject, text, html, replyTo }); out = m === 'api' ? await sendViaApi(mime) : await sendViaSmtp(mime, to); }
  }
  catch (e) {
    // never hand the caller an error without words
    if (!e.message || e.message === 'fetch failed') { const why = describe(e.cause || e); const x = new Error(`Could not reach ${LABELS[m]}: ${why}`); x.status = 502; x.code = 'MAIL_NETWORK'; throw x; }
    throw e;
  }
  return { ok: true, mode: m, ...out };
}

// Zero-setup fallback: opens Gmail in the browser with everything filled in.
function composeUrl({ to, subject, text }) {
  const p = new URLSearchParams({ view: 'cm', fs: '1', to: oneLine(to || ''), su: oneLine(subject || ''), body: String(text || '').slice(0, 1800) });
  return 'https://mail.google.com/mail/?' + p.toString();
}

module.exports = { send, status, composeUrl, isEmail, buildMime, mode, describe };
