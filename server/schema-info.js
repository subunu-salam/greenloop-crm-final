// ─────────────────────────────────────────────────────────────
// Reads prisma/schema.prisma and describes every model:
//   which collection it maps to, its fields, which are optional,
//   which have defaults, and which field is the id.
// server/prisma.js uses this to fill ids, timestamps and nulls on create.
// (Kept tiny on purpose — it only understands the syntax our schema uses.)
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', 'prisma', 'schema.prisma');

function parseDefault(raw, type) {
  if (raw == null) return undefined;
  if (/^".*"$/.test(raw)) return JSON.parse(raw);
  if (type === 'Int' || type === 'Float') return Number(raw);
  return raw; // functions like now()/auto() are not used in this schema
}

function parseSchema(text = fs.readFileSync(SCHEMA_PATH, 'utf8')) {
  const models = {};
  // drop // comments first, so example text in comments is never read as a model
  text = text.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)\n\}/gm;
  let m;
  while ((m = re.exec(text))) {
    const [, name, body] = m;
    const model = { name, delegate: name[0].toLowerCase() + name.slice(1), collection: name, fields: {}, idField: null, uniques: [], indexes: [] };
    for (let line of body.split('\n')) {
      line = line.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      let a;
      if ((a = line.match(/^@@map\("(\w+)"\)/))) { model.collection = a[1]; continue; }
      if ((a = line.match(/^@@unique\(\[([\w,\s]+)\]\)/))) { model.uniques.push(a[1].split(',').map(s => s.trim())); continue; }
      if ((a = line.match(/^@@index\(\[([\w,\s]+)\]\)/))) { model.indexes.push(a[1].split(',').map(s => s.trim())); continue; }
      if (line.startsWith('@@')) continue;
      const f = line.match(/^(\w+)\s+(String|Int|Float|Boolean)(\?)?(.*)$/);
      if (!f) continue;
      const [, fname, type, opt, rest] = f;
      const def = rest.match(/@default\(((?:"(?:[^"\\]|\\.)*")|[^)]*)\)/);
      const field = { name: fname, type, optional: !!opt, default: def ? parseDefault(def[1], type) : undefined, isId: /@id\b/.test(rest), unique: /@unique\b/.test(rest) };
      model.fields[fname] = field;
      if (field.isId) model.idField = fname;
      if (field.unique) model.uniques.push([fname]);
    }
    models[name] = model;
  }
  return models;
}

module.exports = { parseSchema, SCHEMA_PATH };
