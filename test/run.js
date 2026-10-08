// Runs every unit suite in its own process (each gets a fresh database).
// Usage: npm test        (load test: npm run test:load)
const { spawnSync } = require('child_process');
const path = require('path');
const suites = ['regression.test.js', 'edge-cases.test.js', 'v32.test.js'];
let failed = 0;
for (const s of suites) {
  console.log(`\n▶ ${s}`);
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'unit', s)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`✖ ${s} failed`); }
}
console.log(failed ? `\n✖ ${failed} suite(s) failed` : '\n✔ All suites passed');
process.exit(failed ? 1 : 0);
