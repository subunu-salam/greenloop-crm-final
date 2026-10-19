// Loads the .env file in the project root into process.env (only keys that are not set yet).
// Node 22 can do this with `node --env-file=.env`, but this also works from npm scripts
// and keeps the scripts dependency-free.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
