// ─────────────────────────────────────────────────────────────
// npm run test:mongo
//
// Runs the whole unit-test suite against your REAL MongoDB instead of the
// in-memory test database. It uses a separate database, greenloop_test
// (or TEST_DATABASE_URL), which is emptied at the start of every suite —
// your normal GreenLoop data is never touched.
// ─────────────────────────────────────────────────────────────
require('./load-env');
const { execSync, spawnSync } = require('child_process');
const path = require('path');

const testUrl = process.env.TEST_DATABASE_URL || (() => {
  // same server as DATABASE_URL, database name "greenloop_test"
  const u = process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/greenloop?replicaSet=rs0';
  return u.replace(/\/([^/?]+)(\?|$)/, '/greenloop_test$2');
})();
if (!/greenloop_test|test/i.test(testUrl)) { console.error('✖ TEST_DATABASE_URL must point at a test database (its name should contain "test").'); process.exit(1); }

const env = { ...process.env, DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl, TEST_MONGO: '1' };
const root = path.join(__dirname, '..');
console.log('Test database:', testUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@'));
execSync('npx prisma db push --skip-generate', { cwd: root, env, stdio: 'inherit' });
execSync('node scripts/create-indexes.js', { cwd: root, env, stdio: 'inherit' });
const r = spawnSync(process.execPath, [path.join(root, 'test', 'run.js')], { cwd: root, env, stdio: 'inherit' });
process.exit(r.status);
