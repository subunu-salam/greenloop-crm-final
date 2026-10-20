// ─────────────────────────────────────────────────────────────
// In-memory stand-in for @prisma/client, used ONLY by the unit tests so they
// run with no MongoDB server and no `npm install` (handy in CI).
//
// It reads prisma/schema.prisma and server/mongo-indexes.js and behaves like
// Prisma does with MongoDB — strictly, so mistakes surface in tests:
//   • unknown fields / wrong types (a "2" string for an Int) throw
//   • Int must be a 32-bit whole number, like Prisma's Int
//   • unique rules (@unique, @@unique, partial indexes) throw P2002
//   • update/delete of a missing document throws P2025
//   • findUnique must name a unique field
// Supported: findMany/findFirst/findUnique(+OrThrow), create, createMany,
// update, updateMany, upsert, delete, deleteMany, count, aggregate, groupBy,
// $transaction, $extends (query hooks), $runCommandRaw (no-op).
// ─────────────────────────────────────────────────────────────
const { parseSchema } = require('../server/schema-info');
const PARTIAL = require('../server/mongo-indexes');

class PrismaError extends Error {
  constructor(code, msg, meta) { super(msg); this.code = code; this.meta = meta; this.name = 'PrismaClientKnownRequestError'; }
}
const fail = (msg) => { const e = new Error(msg); e.name = 'PrismaClientValidationError'; throw e; };
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

function checkValue(model, f, v, where) {
  if (v === null) { if (!f.optional && !where) fail(`${model.name}.${f.name} must not be null`); return; }
  const t = f.type;
  if (t === 'String' && typeof v !== 'string') fail(`${model.name}.${f.name}: expected String, got ${typeof v} (${JSON.stringify(v)})`);
  if (t === 'Int' && !(typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647)) fail(`${model.name}.${f.name}: expected Int, got ${typeof v} (${JSON.stringify(v)})`);
  if (t === 'Float' && !(typeof v === 'number' && Number.isFinite(v))) fail(`${model.name}.${f.name}: expected Float, got ${typeof v} (${JSON.stringify(v)})`);
  if (t === 'Boolean' && typeof v !== 'boolean') fail(`${model.name}.${f.name}: expected Boolean`);
}

function cmp(a, b) { // MongoDB order: null/missing first, numbers, then strings
  const rank = (x) => (x == null ? 0 : typeof x === 'number' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a == null) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchField(model, fname, doc, cond) {
  const f = model.fields[fname];
  if (!f) fail(`Unknown field ${model.name}.${fname} in where`);
  const v = doc[fname] === undefined ? null : doc[fname];
  if (cond === null || typeof cond !== 'object') { if (cond !== null) checkValue(model, f, cond, true); return cond === null ? v === null : v === cond; }
  const ci = cond.mode === 'insensitive';
  const norm = (x) => (ci && typeof x === 'string' ? x.toLowerCase() : x);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case 'mode': break;
      case 'equals': if (norm(v) !== norm(arg) && !(arg === null && v === null)) return false; break;
      case 'not':
        if (arg !== null && typeof arg === 'object') { if (matchField(model, fname, doc, arg)) return false; }
        else if (arg === null ? v === null : (v !== null && norm(v) === norm(arg))) return false;
        // Prisma/MongoDB: { not: 'x' } also matches null values
        break;
      case 'in': if (!Array.isArray(arg)) fail('in needs an array'); arg.forEach(x => checkValue(model, f, x, true)); if (!arg.map(norm).includes(norm(v))) return false; break;
      case 'notIn': if (!Array.isArray(arg)) fail('notIn needs an array'); if (arg.map(norm).includes(norm(v))) return false; break;
      case 'lt': checkValue(model, f, arg, true); if (!(v !== null && cmp(v, arg) < 0)) return false; break;
      case 'lte': checkValue(model, f, arg, true); if (!(v !== null && cmp(v, arg) <= 0)) return false; break;
      case 'gt': checkValue(model, f, arg, true); if (!(v !== null && cmp(v, arg) > 0)) return false; break;
      case 'gte': checkValue(model, f, arg, true); if (!(v !== null && cmp(v, arg) >= 0)) return false; break;
      case 'contains': if (typeof v !== 'string' || !norm(v).includes(norm(arg))) return false; break;
      case 'startsWith': if (typeof v !== 'string' || !norm(v).startsWith(norm(arg))) return false; break;
      case 'endsWith': if (typeof v !== 'string' || !norm(v).endsWith(norm(arg))) return false; break;
      case 'isSet': if ((doc[fname] !== undefined) !== arg) return false; break;
      default: fail(`Unsupported filter ${op} on ${model.name}.${fname}`);
    }
  }
  return true;
}

function matches(model, doc, where) {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue; // Prisma ignores undefined
    if (k === 'AND') { if (!(Array.isArray(cond) ? cond : [cond]).every(w => matches(model, doc, w))) return false; continue; }
    if (k === 'OR') { if (!cond.some(w => matches(model, doc, w))) return false; continue; }
    if (k === 'NOT') { if ((Array.isArray(cond) ? cond : [cond]).some(w => matches(model, doc, w))) return false; continue; }
    const compound = model.uniques.find(u => u.length > 1 && u.join('_') === k);
    if (compound) { if (!compound.every(f => matchField(model, f, doc, cond[f]))) return false; continue; }
    if (!matchField(model, k, doc, cond)) return false;
  }
  return true;
}

function requireUnique(model, where, op) {
  if (!where) fail(`${op} needs where`);
  const keys = Object.keys(where).filter(k => where[k] !== undefined);
  const ok = keys.some(k => k === model.idField || model.uniques.some(u => (u.length === 1 && u[0] === k) || (u.length > 1 && u.join('_') === k)));
  if (!ok) fail(`${model.name}.${op}: where must include a unique field (got ${keys.join(',')})`);
  for (const k of keys) if (where[k] === null || (typeof where[k] === 'object' && !model.uniques.some(u => u.join('_') === k) && k !== 'AND' && k !== 'OR' && k !== 'NOT' && (k === model.idField || model.uniques.some(u => u[0] === k && u.length === 1)))) fail(`${model.name}.${op}: unique field ${k} needs a plain value`);
}

function sortDocs(docs, orderBy) {
  if (!orderBy) return docs;
  const list = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap(o => Object.entries(o));
  return docs.sort((a, b) => {
    for (const [f, dir] of list) {
      const d = typeof dir === 'object' ? dir.sort : dir;
      const c = cmp(a[f] ?? null, b[f] ?? null);
      if (c) return d === 'desc' ? -c : c;
    }
    return 0;
  });
}

function project(model, doc, select) {
  if (!select) return clone(doc);
  const out = {};
  for (const [k, on] of Object.entries(select)) {
    if (!on) continue;
    if (!model.fields[k]) fail(`Unknown field ${model.name}.${k} in select`);
    out[k] = doc[k] === undefined ? null : clone(doc[k]);
  }
  return out;
}

function partialMatch(doc, filter) {
  return Object.entries(filter).every(([k, c]) => {
    const v = doc[k];
    if (c && typeof c === 'object' && c.$type) return c.$type === 'number' || c.$type === 'int' ? typeof v === 'number' : c.$type === 'string' ? typeof v === 'string' : false;
    return v === c;
  });
}

function makeDelegate(model, store) {
  const all = () => [...store.values()];
  const uniqueSets = [...model.uniques.map(u => ({ fields: u, filter: null })), ...PARTIAL.filter(p => p.model === model.name).map(p => ({ fields: Object.keys(p.key), filter: p.partialFilterExpression, name: p.name }))];

  function validateData(data, isCreate) {
    if (!data || typeof data !== 'object') fail('data required');
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = model.fields[k];
      if (!f) fail(`Unknown argument \`${k}\` for ${model.name}`);
      if (!isCreate && v && typeof v === 'object') {
        const ops = Object.keys(v);
        if (!ops.every(o => ['set', 'increment', 'decrement', 'multiply', 'divide'].includes(o))) fail(`Bad update op on ${model.name}.${k}`);
        for (const o of ops) checkValue(model, f, v[o], false);
        continue;
      }
      checkValue(model, f, v, false);
    }
  }
  function checkUnique(doc, selfKey) {
    for (const u of uniqueSets) {
      if (u.filter && !partialMatch(doc, u.filter)) continue;
      if (!u.filter && u.fields.some(f => doc[f] == null)) { /* Mongo would index null too */ }
      for (const other of store.values()) {
        if (other[model.idField] === selfKey) continue;
        if (u.filter && !partialMatch(other, u.filter)) continue;
        if (u.fields.every(f => (other[f] ?? null) === (doc[f] ?? null))) throw new PrismaError('P2002', `Unique constraint failed on the constraint: \`${u.name || u.fields.join('_')}\``, { target: u.fields });
      }
    }
  }
  function applyDefaults(data) {
    const doc = {};
    for (const f of Object.values(model.fields)) {
      if (data[f.name] !== undefined) doc[f.name] = clone(data[f.name]);
      else if (f.default !== undefined) doc[f.name] = f.default;
      else if (f.optional) { /* left unset, like Prisma */ }
      else fail(`Argument \`${f.name}\` is missing for ${model.name}.create`);
    }
    return doc;
  }
  function insert(data) {
    validateData(data, true);
    const doc = applyDefaults(data);
    const key = doc[model.idField];
    if (key === undefined) fail(`${model.name}: id missing`);
    if (store.has(key)) throw new PrismaError('P2002', `Unique constraint failed on the constraint: \`_id_\``, { target: ['_id'] });
    checkUnique(doc, Symbol('new'));
    store.set(key, doc);
    return doc;
  }
  function applyUpdate(doc, data) {
    validateData(data, false);
    const next = { ...doc };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v !== null && typeof v === 'object') {
        if ('set' in v) next[k] = v.set;
        if ('increment' in v) next[k] = (next[k] ?? 0) + v.increment;
        if ('decrement' in v) next[k] = (next[k] ?? 0) - v.decrement;
        if ('multiply' in v) next[k] = (next[k] ?? 0) * v.multiply;
        if ('divide' in v) next[k] = (next[k] ?? 0) / v.divide;
      } else next[k] = v;
    }
    if (next[model.idField] !== doc[model.idField]) fail('changing the id is not supported');
    checkUnique(next, doc[model.idField]);
    return next;
  }
  function find(args = {}) {
    let docs = all().filter(d => matches(model, d, args.where));
    docs = sortDocs(docs, args.orderBy);
    if (args.distinct) { const seen = new Set(); docs = docs.filter(d => { const k = JSON.stringify((Array.isArray(args.distinct) ? args.distinct : [args.distinct]).map(f => d[f] ?? null)); if (seen.has(k)) return false; seen.add(k); return true; }); }
    if (args.skip) docs = docs.slice(args.skip);
    if (args.take != null) docs = args.take >= 0 ? docs.slice(0, args.take) : docs.slice(args.take);
    return docs;
  }
  const knownArgs = (args, allowed, op) => { for (const k of Object.keys(args || {})) if (!allowed.includes(k)) fail(`${model.name}.${op}: unknown argument ${k}`); };

  return {
    async findMany(args = {}) { knownArgs(args, ['where', 'orderBy', 'take', 'skip', 'select', 'distinct'], 'findMany'); return find(args).map(d => project(model, d, args.select)); },
    async findFirst(args = {}) { knownArgs(args, ['where', 'orderBy', 'take', 'skip', 'select', 'distinct'], 'findFirst'); const d = find({ ...args, take: 1 })[0]; return d ? project(model, d, args.select) : null; },
    async findFirstOrThrow(args = {}) { const r = await this.findFirst(args); if (!r) throw new PrismaError('P2025', 'No record found'); return r; },
    async findUnique(args = {}) { knownArgs(args, ['where', 'select'], 'findUnique'); requireUnique(model, args.where, 'findUnique'); const d = find({ where: args.where })[0]; return d ? project(model, d, args.select) : null; },
    async findUniqueOrThrow(args = {}) { const r = await this.findUnique(args); if (!r) throw new PrismaError('P2025', 'No record found'); return r; },
    async create(args) { knownArgs(args, ['data', 'select'], 'create'); return project(model, insert(args.data), args.select); },
    async createMany(args) {
      knownArgs(args, ['data', 'skipDuplicates'], 'createMany');
      if (args.skipDuplicates) fail('skipDuplicates is not supported on MongoDB');
      const rows = Array.isArray(args.data) ? args.data : [args.data];
      for (const r of rows) insert(r);
      return { count: rows.length };
    },
    async update(args) {
      knownArgs(args, ['where', 'data', 'select'], 'update'); requireUnique(model, args.where, 'update');
      const d = find({ where: args.where })[0];
      if (!d) throw new PrismaError('P2025', `${model.name}.update: record to update not found`);
      const next = applyUpdate(d, args.data); store.set(d[model.idField], next); return project(model, next, args.select);
    },
    async updateMany(args) {
      knownArgs(args, ['where', 'data'], 'updateMany');
      const docs = find({ where: args.where });
      const nexts = docs.map(d => applyUpdate(d, args.data));
      nexts.forEach(n => store.set(n[model.idField], n));
      return { count: docs.length };
    },
    async upsert(args) {
      knownArgs(args, ['where', 'create', 'update', 'select'], 'upsert'); requireUnique(model, args.where, 'upsert');
      const d = find({ where: args.where })[0];
      validateData(args.create, true); applyDefaults(args.create);   // Prisma validates `create` either way
      if (d) { const next = applyUpdate(d, args.update); store.set(d[model.idField], next); return project(model, next, args.select); }
      return project(model, insert(args.create), args.select);
    },
    async delete(args) {
      knownArgs(args, ['where', 'select'], 'delete'); requireUnique(model, args.where, 'delete');
      const d = find({ where: args.where })[0];
      if (!d) throw new PrismaError('P2025', `${model.name}.delete: record to delete does not exist`);
      store.delete(d[model.idField]); return project(model, d, args.select);
    },
    async deleteMany(args = {}) { knownArgs(args, ['where'], 'deleteMany'); const docs = find({ where: args.where }); docs.forEach(d => store.delete(d[model.idField])); return { count: docs.length }; },
    async count(args = {}) { knownArgs(args, ['where', 'select'], 'count'); return find({ where: args.where }).length; },
    async aggregate(args = {}) {
      knownArgs(args, ['where', '_sum', '_avg', '_min', '_max', '_count', 'orderBy', 'take'], 'aggregate');
      return aggregateDocs(model, find({ where: args.where, orderBy: args.orderBy, take: args.take }), args);
    },
    async groupBy(args = {}) {
      knownArgs(args, ['by', 'where', '_sum', '_avg', '_min', '_max', '_count', 'orderBy', 'take', 'skip', 'having'], 'groupBy');
      if (args.having) fail('having not supported in test double');
      if ((args.take != null || args.skip != null) && !args.orderBy) fail('groupBy with take/skip needs orderBy');
      const by = Array.isArray(args.by) ? args.by : [args.by];
      by.forEach(b => { if (!model.fields[b]) fail(`groupBy: unknown field ${b}`); });
      const groups = new Map();
      for (const d of find({ where: args.where })) {
        const k = JSON.stringify(by.map(b => d[b] ?? null));
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(d);
      }
      let out = [...groups.values()].map(docs => ({ ...Object.fromEntries(by.map(b => [b, docs[0][b] ?? null])), ...aggregateDocs(model, docs, args) }));
      if (args.orderBy) {
        const list = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]).flatMap(o => Object.entries(o));
        out.sort((a, b) => { for (const [f, dir] of list) { let av, bv; if (f.startsWith('_')) { const [[ff, dd]] = Object.entries(dir); av = a[f]?.[ff]; bv = b[f]?.[ff]; const c = cmp(av ?? null, bv ?? null); if (c) return dd === 'desc' ? -c : c; } else { const c = cmp(a[f], b[f]); if (c) return dir === 'desc' ? -c : c; } } return 0; });
      }
      if (args.skip) out = out.slice(args.skip);
      if (args.take != null) out = out.slice(0, args.take);
      return out;
    },
  };
}

function aggregateDocs(model, docs, args) {
  const out = {};
  const nums = (f) => { if (!model.fields[f]) fail(`aggregate: unknown field ${f}`); return docs.map(d => d[f]).filter(v => v != null); };
  if (args._count) {
    if (args._count === true) out._count = docs.length;
    else { out._count = {}; for (const f of Object.keys(args._count)) out._count[f] = f === '_all' ? docs.length : docs.filter(d => d[f] != null).length; }
  }
  if (args._sum) { out._sum = {}; for (const f of Object.keys(args._sum)) { const v = nums(f); out._sum[f] = v.length ? v.reduce((a, b) => a + b, 0) : null; } }
  if (args._avg) { out._avg = {}; for (const f of Object.keys(args._avg)) { const v = nums(f); out._avg[f] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; } }
  if (args._min) { out._min = {}; for (const f of Object.keys(args._min)) { const v = nums(f); out._min[f] = v.length ? v.reduce((a, b) => (cmp(a, b) <= 0 ? a : b)) : null; } }
  if (args._max) { out._max = {}; for (const f of Object.keys(args._max)) { const v = nums(f); out._max[f] = v.length ? v.reduce((a, b) => (cmp(a, b) >= 0 ? a : b)) : null; } }
  return out;
}

class PrismaClient {
  constructor() {
    const models = parseSchema();
    const stores = (globalThis.__fakePrismaStores ||= {});
    this._models = models;
    for (const m of Object.values(models)) {
      stores[m.name] ||= new Map();
      this[m.delegate] = makeDelegate(m, stores[m.name]);
    }
  }
  async $connect() {}
  async $disconnect() {}
  async $runCommandRaw() { return { ok: 1 }; }
  async $transaction(arg) {
    if (Array.isArray(arg)) return Promise.all(arg);
    // No rollback in the double; real MongoDB (replica set) rolls back on throw.
    return arg(this);
  }
  $extends(ext) {
    const hooks = ext.query?.$allModels || {};
    const parent = this;
    const ext2 = Object.create(parent);
    for (const m of Object.values(this._models)) {
      const baseDel = parent[m.delegate];
      const d = { ...baseDel };
      for (const [op, fn] of Object.entries(hooks)) {
        d[op] = (args = {}) => fn({ model: m.name, operation: op, args, query: (a) => baseDel[op](a) });
      }
      ext2[m.delegate] = d;
    }
    ext2.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(ext2));
    return ext2;
  }
}

/** Test helper: wipe every collection. */
function resetFakeDb() { for (const s of Object.values(globalThis.__fakePrismaStores || {})) s.clear(); }

module.exports = { PrismaClient, Prisma: { PrismaClientKnownRequestError: PrismaError }, resetFakeDb };
