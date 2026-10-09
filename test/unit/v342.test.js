// v3.4.2 — phone rules per country, readable email errors, no false Overdue for stops added after the cutoff
const { call, db } = require('./harness');
const contacts = require('../../server/contacts');
const mailer = require('../../server/mailer');
const sla = require('../../server/services/sla');
const { q, getSetting, setSetting } = require('../../server/db');

const results = [];
const rec = (area, name, ok, note = '') => { results.push({ area, name, ok: !!ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${note ? ' → ' + note : ''}`); };

(async () => {
  // ── phone numbers ──
  const good = [
    ['+971501234567', 'mobile', '+971 50 123 4567'], ['0561234567', 'mobile', '+971 56 123 4567'], ['+97141234567', 'landline', '+971 4 123 4567'], ['+97167564326', 'landline', '+971 6 756 4326'],
    ['+966501234567', 'mobile', '+966 50 123 4567'], ['+966112345678', 'landline', '+966 11 234 5678'],
    ['+97433123456', 'mobile', '+974 3312 3456'], ['+97444123456', 'landline', '+974 4412 3456'],
    ['+96892123456', 'mobile', '+968 9212 3456'], ['+96824123456', 'landline', '+968 2412 3456'],
    ['+96550123456', 'mobile', '+965 5012 3456'], ['+96522123456', 'landline', '+965 2212 3456'],
    ['+97336123456', 'mobile', '+973 3612 3456'], ['+97317123456', 'landline', '+973 1712 3456'],
  ];
  const badGood = good.filter(([n, kind, fmt]) => { const p = contacts.parsePhone(n); return !p.ok || p.kind !== kind || contacts.formatPhone(n) !== fmt; });
  rec('Phone', 'Valid mobile and landline numbers are accepted for all six countries', !badGood.length, badGood.length ? 'wrong: ' + badGood.map(x => x[0]).join(', ') : `${good.length} numbers`);
  const bad = ['+971675643267', '+971401234567', '+97150123456', '+9715012345678', '+97181234567', '+966612345678', '+96650123456', '+97423123456', '+9743312345', '+96852123456', '+96532123456', '+97352123456', '+97312'];
  const accepted = bad.filter(n => contacts.parsePhone(n).ok);
  rec('Phone', 'Numbers with the wrong length or first digit are refused', !accepted.length, accepted.length ? 'accepted: ' + accepted.join(', ') : `${bad.length} numbers`);
  const e1 = contacts.parsePhone('+971675643267').error || '';
  rec('Phone', 'The refusal explains the rule and gives an example', /cannot start with 6/.test(e1) && /start with 5/.test(e1) && /50 123 4567/.test(e1) && /Landlines have 8 digits/.test(e1), e1.slice(0, 110));
  const e2 = contacts.parsePhone('+97312').error || '';
  rec('Phone', 'A number that is too short says how many digits it has and how many are needed', /has 2 digits/.test(e2) && /8 digits/.test(e2), e2.slice(0, 90));
  const A = (await call('POST', '/auth/admin-login', { body: { username: 'admin', password: 'admin123' } })).body.token;
  let r = await call('POST', '/leads', { token: A, body: { contact: 'Dev', company: 'XYZ', phone: '+971675643267', email: 'dev@example.com', sites: [] } });
  rec('Phone', 'The lead form refuses 67 564 3267 with the explanation', r.status === 400 && /cannot start with 6/.test(r.body.error || ''), `${r.status} ${String(r.body.error).slice(0, 70)}`);
  r = await call('POST', '/leads', { token: A, body: { contact: 'Dev', company: 'XYZ Sharjah', phone: '+97167564326', email: 'dev2@example.com', sites: [] } });
  rec('Phone', 'The 8-digit Sharjah landline 6 756 4326 is accepted', r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);

  // ── email errors ──
  const agg = new AggregateError([Object.assign(new Error(''), { code: 'ETIMEDOUT' })], ''); agg.code = 'ETIMEDOUT';
  rec('Email', 'A network error with an empty message still gets a readable reason', mailer.describe(agg).includes('ETIMEDOUT'), mailer.describe(agg));
  rec('Email', 'An unknown error object never produces an empty reason', mailer.describe({}) === 'unknown error' && !!mailer.describe(new Error('')), mailer.describe(new Error('')));

  // ── overdue check ──
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const cid = q.get(`SELECT id FROM customers LIMIT 1`).id, vid = q.get(`SELECT id FROM vehicles LIMIT 1`).id;
  const old = getSetting('shift_cutoff', '12:00');
  setSetting('shift_cutoff', '00:01');
  const sql = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
  const add = (date, created) => Number(q.run(`INSERT INTO pickups(customer_id,vehicle_id,scheduled_date,status,created_at) VALUES (?,?,?,'pending',?)`, cid, vid, date, sql(created)).lastInsertRowid);
  const before = add(today, new Date(`${today}T00:00:00`).getTime() - 3600e3);   // planned before today's cutoff
  const after = add(today, Date.now());                                           // added just now, after the cutoff
  const lateYesterday = add(yesterday, new Date(`${yesterday}T15:00:00`).getTime());
  const oldPlanned = add(yesterday, new Date(`${yesterday}T00:00:00`).getTime() - 5 * 864e5);  // planned days ahead, untouched history
  const out = sla.checkNow(null);
  const st = id => q.get(`SELECT status FROM pickups WHERE id=?`, id).status;
  rec('Overdue', 'A stop planned before the cutoff still turns Overdue', st(before) === 'overdue', st(before));
  rec('Overdue', 'A stop added after the cutoff stays pending and raises no alert', st(after) === 'pending' && !q.get(`SELECT id FROM alerts WHERE pickup_id=?`, after), `${st(after)}; counted as added after cutoff: ${out.added_after_cutoff}`);
  rec('Overdue', 'That late-added stop turns Overdue the next day if nobody did it', st(lateYesterday) === 'overdue', st(lateYesterday));
  rec('Overdue', 'Older pending stops from past days are left exactly as they were', st(oldPlanned) === 'pending', st(oldPlanned));
  const again = sla.checkNow(null);
  rec('Overdue', 'Running the check again raises nothing new', again.breaches === 0, `${again.breaches} new`);
  setSetting('shift_cutoff', old);
  q.run(`DELETE FROM alerts WHERE pickup_id IN (?,?,?,?)`, before, after, lateYesterday, oldPlanned); q.run(`DELETE FROM pickups WHERE id IN (?,?,?,?)`, before, after, lateYesterday, oldPlanned);

  const f = results.filter(x => !x.ok).length;
  console.log(`\nSUMMARY: ${results.length - f} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
