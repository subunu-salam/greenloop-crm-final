// ─────────────────────────────────────────────────────────────
// npm run db:migrate-sqlite -- [path/to/greenloop.sqlite] [--wipe]
//
// One-time copy of an existing GreenLoop SQLite database into MongoDB.
//   • every table becomes the collection of the same name
//   • ids are kept (so links, invoices and the apps keep working), and the
//     `counters` collection is set to the highest id of each collection
//   • values are converted to the types in prisma/schema.prisma
//     (e.g. a number stored as text "12" becomes the Int 12)
//
// Before you run it:
//   1. MongoDB is running as a replica set and DATABASE_URL is in .env
//   2. npm run db:setup          (creates the collections' indexes)
// The target database must be empty, or pass --wipe to empty it first.
// The SQLite file is only read, never changed.
// ─────────────────────────────────────────────────────────────
require('./load-env');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { base: prisma, MODELS, now } = require('../server/prisma');

const args = process.argv.slice(2);
const wipe = args.includes('--wipe');
const file = path.resolve(args.find(a => !a.startsWith('--')) || process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite'));
const TIMESTAMPS = ['created_at', 'updated_at', 'at', 'received_at', 'reported_at'];
const warnings = [];

function convert(model, row, rowNo) {
  const out = {};
  for (const f of Object.values(model.fields)) {
    let v = row[f.name];
    if (typeof v === 'bigint') v = Number(v);
    if (v === undefined || v === null || (v === '' && f.type !== 'String')) {
      if (f.optional) out[f.name] = null;
      else if (f.default !== undefined) out[f.name] = f.default;
      else if (TIMESTAMPS.includes(f.name)) out[f.name] = now();
      else throw new Error(`${model.collection} row ${rowNo}: required field "${f.name}" is empty`);
      continue;
    }
    if (f.type === 'Int') {
      let n = Number(v);
      if (!Number.isFinite(n)) { warnings.push(`${model.collection}.${f.name} row ${rowNo}: "${v}" is not a number → ${f.optional ? 'null' : 0}`); out[f.name] = f.optional ? null : 0; continue; }
      if (!Number.isInteger(n)) { warnings.push(`${model.collection}.${f.name} row ${rowNo}: ${n} rounded to ${Math.round(n)}`); n = Math.round(n); }
      out[f.name] = n;
    } else if (f.type === 'Float') {
      const n = Number(v);
      if (!Number.isFinite(n)) { warnings.push(`${model.collection}.${f.name} row ${rowNo}: "${v}" is not a number → ${f.optional ? 'null' : 0}`); out[f.name] = f.optional ? null : 0; continue; }
      out[f.name] = n;
    } else if (f.type === 'Boolean') {
      out[f.name] = !!v;
    } else {
      out[f.name] = String(v);
    }
  }
  return out;
}

(async () => {
  if (!fs.existsSync(file)) { console.error(`✖ SQLite file not found: ${file}\n  Usage: npm run db:migrate-sqlite -- path/to/greenloop.sqlite`); process.exit(1); }
  const sqlite = new DatabaseSync(file, { readOnly: true });
  const tables = new Set(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name));
  console.log(`Reading ${file}\nWriting ${String(process.env.DATABASE_URL || '').replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@')}\n`);

  const existing = await prisma.user.count();
  if (existing && !wipe) {
    console.error('✖ The MongoDB database already has data. Run with --wipe to empty it first (this deletes everything in it).');
    process.exit(1);
  }
  if (wipe) {
    for (const m of Object.values(MODELS)) await prisma[m.delegate].deleteMany({});
    console.log('• emptied the target database');
  }

  let total = 0;
  for (const m of Object.values(MODELS)) {
    if (m.name === 'Counter') continue;
    if (!tables.has(m.collection)) { console.log(`  ${m.collection.padEnd(28)} (no table in SQLite — skipped)`); continue; }
    const rows = sqlite.prepare(`SELECT * FROM "${m.collection}"`).all();
    // plan_skips had a two-column key and no id in SQLite: give each row a number
    const docs = rows.map((r, i) => convert(m, m.idField === 'id' && r.id == null ? { ...r, id: i + 1 } : r, i + 1));
    for (let i = 0; i < docs.length; i += 500) await prisma[m.delegate].createMany({ data: docs.slice(i, i + 500) });
    // next id for new documents = highest id + 1
    if (m.idField === 'id' && docs.length) {
      const max = Math.max(...docs.map(d => d.id));
      await prisma.counter.upsert({ where: { id: m.collection }, create: { id: m.collection, seq: max }, update: { seq: max } });
    }
    total += docs.length;
    console.log(`  ${m.collection.padEnd(28)} ${String(docs.length).padStart(7)} copied`);
  }
  console.log(`\n✔ ${total} documents copied.`);
  // Safety net: list any SQLite table that has no collection in prisma/schema.prisma,
  // so no existing records are left behind without you knowing.
  const known = new Set(Object.values(MODELS).map(m => m.collection));
  const leftOut = [...tables].filter(t => !t.startsWith('sqlite_') && !known.has(t))
    .map(t => ({ t, n: sqlite.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n }))
    .filter(x => Number(x.n) > 0);
  if (leftOut.length) {
    console.log('\n⚠ These SQLite tables have rows but no MongoDB collection, so they were NOT copied:');
    leftOut.forEach(x => console.log(`  - ${x.t} (${x.n} rows)`));
    console.log('  Add a model for them to prisma/schema.prisma and run the migration again with --wipe.');
  }
  if (warnings.length) { console.log(`\n${warnings.length} value(s) were adjusted:`); warnings.slice(0, 50).forEach(w => console.log('  - ' + w)); }
  console.log('\nNext: npm run db:check   then   npm start');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('\n✖ Migration stopped:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
