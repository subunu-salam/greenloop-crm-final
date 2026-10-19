// ─────────────────────────────────────────────────────────────
// The ONE place the app connects to MongoDB.
//
//   const { prisma } = require('./prisma');
//   const user = await prisma.user.findUnique({ where: { id: 3 } });
//
// Every Prisma call returns a Promise, so always `await` it inside an
// `async` function. Express 5 forwards errors thrown in async routes to the
// error handler automatically.
//
// This file adds three conveniences on top of the plain Prisma client
// (a "client extension" — https://www.prisma.io/docs/orm/prisma-client/client-extensions):
//   1. Auto-increment ids. MongoDB has no AUTOINCREMENT, so before each create
//      we take the next number from the `counters` collection (atomic $inc).
//   2. created_at / updated_at are filled in on create, in the same
//      'YYYY-MM-DD HH:MM:SS' UTC text format SQLite used, so nothing in the
//      front-ends changes. (On update, set `updated_at: now()` yourself where
//      it matters — exactly like the old SQL did.)
//   3. Optional fields you leave out are stored as an explicit null. MongoDB
//      treats "missing" and "null" differently in filters; writing null keeps
//      `where: { invoice_id: null }` working the way SQL `IS NULL` did.
// ─────────────────────────────────────────────────────────────
const { PrismaClient } = require('@prisma/client');
const { parseSchema } = require('./schema-info');

const MODELS = parseSchema();
const TIMESTAMP_FIELDS = ['created_at', 'updated_at', 'at', 'received_at', 'reported_at'];

/** Current UTC time as 'YYYY-MM-DD HH:MM:SS' (same as SQLite datetime('now')). */
const now = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');

const base = new PrismaClient({
  log: process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

/** Reserve `n` ids for a collection and return the first one. */
async function reserveIds(collection, n = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await base.counter.upsert({
        where: { id: collection },
        create: { id: collection, seq: n },
        update: { seq: { increment: n } },
      });
      return c.seq - n + 1;
    } catch (e) {
      // two first-ever inserts racing to create the counter: retry once
      if (e.code === 'P2002' && attempt < 2) continue;
      throw e;
    }
  }
}
const nextId = async (collection) => reserveIds(collection, 1);

function needsAutoId(model) {
  return model.idField === 'id' && model.fields.id.type === 'Int';
}

/** Fill defaults that SQLite used to add for us. */
function prepareCreate(model, data, id) {
  const stamp = now();
  for (const f of Object.values(model.fields)) {
    if (data[f.name] !== undefined) continue;
    if (f.isId && id !== undefined) data[f.name] = id;
    else if (TIMESTAMP_FIELDS.includes(f.name) && !f.optional && f.default === undefined) data[f.name] = stamp;
    else if (f.optional && f.default === undefined) data[f.name] = null;
  }
  return data;
}
const prisma = base.$extends({
  name: 'greenloop-defaults',
  query: {
    $allModels: {
      async create({ model, args, query }) {
        const m = MODELS[model];
        const id = needsAutoId(m) && args.data.id === undefined ? await nextId(m.collection) : undefined;
        prepareCreate(m, args.data, id);
        return query(args);
      },
      async createMany({ model, args, query }) {
        const m = MODELS[model];
        const rows = Array.isArray(args.data) ? args.data : [args.data];
        const missing = needsAutoId(m) ? rows.filter(r => r.id === undefined).length : 0;
        let first = missing ? await reserveIds(m.collection, missing) : undefined;
        for (const r of rows) prepareCreate(m, r, needsAutoId(m) && r.id === undefined ? first++ : undefined);
        args.data = rows;
        return query(args);
      },
      async upsert({ model, args, query }) {
        const m = MODELS[model];
        // Only spend a new id if the document really is new. (Prisma checks the whole
        // `create` block even when it ends up updating, so it always needs an id.)
        if (needsAutoId(m) && args.create.id === undefined) {
          const exists = await base[m.delegate].findUnique({ where: args.where, select: { id: true } });
          args.create.id = exists ? exists.id : await nextId(m.collection);
        }
        prepareCreate(m, args.create);
        return query(args);
      },
    },
  },
});

/** true when a create/update broke a unique rule (Prisma error P2002). */
const isUniqueError = (e) => e && e.code === 'P2002';
/** true when update/delete found no document (Prisma error P2025). */
const isNotFound = (e) => e && e.code === 'P2025';

async function getSetting(key, fallback) {
  const r = await prisma.setting.findUnique({ where: { key } });
  return r ? r.value : fallback;
}
async function setSetting(key, value) {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: String(value) },
    update: { value: String(value) },
  });
}

/** Load documents by id and return a Map id → document (a manual "JOIN"). */
async function byIds(delegate, ids, select) {
  const list = [...new Set(ids.filter(x => x != null))];
  if (!list.length) return new Map();
  const rows = await prisma[delegate].findMany({ where: { id: { in: list } }, ...(select ? { select: { id: true, ...select } } : {}) });
  return new Map(rows.map(r => [r.id, r]));
}

module.exports = { prisma, base, now, nextId, reserveIds, isUniqueError, isNotFound, getSetting, setSetting, byIds, MODELS };
