# MongoDB + Prisma in GreenLoop — a beginner's guide

This guide explains how GreenLoop stores its data, using real code from this project. Read it top to
bottom once, then keep the cheat sheet (section 5) open while you code.

**Contents**
1. The big picture
2. MongoDB in 5 minutes
3. Prisma in 5 minutes
4. How GreenLoop is wired
5. Cheat sheet: SQL → Prisma (with examples from this code)
6. "JOINs" without SQL
7. async / await — the rule you cannot skip
8. The gotchas we hit while converting (read this!)
9. Speed: indexes, groupBy and the N+1 problem
10. Tools: Compass, Prisma Studio, query logging
11. Testing
12. Practice exercises
13. Where to read more

---

## 1. The big picture

```
 CRM / driver app / customer app / Expo app
                 │  HTTP (JSON)  — unchanged
                 ▼
 server/*.js  (Express routes, business rules)
                 │  await prisma.pickup.findMany({ … })
                 ▼
 Prisma Client  (generated from prisma/schema.prisma)
                 │  MongoDB wire protocol
                 ▼
 MongoDB  (database "greenloop", 31 collections + "counters")
```

Before v4 the routes wrote SQL text (`SELECT * FROM pickups WHERE id=?`) for SQLite. Now they call
**Prisma Client** methods, and Prisma talks to **MongoDB**. The front-ends did not change. Every API
response has exactly the same fields as before.

---

## 2. MongoDB in 5 minutes

MongoDB is a **document database**. Instead of tables with fixed columns it stores JSON-like documents.

| SQL (SQLite/Postgres) | MongoDB | In GreenLoop |
|---|---|---|
| database | database | `greenloop` |
| table | **collection** | `pickups`, `customers`, … |
| row | **document** | one pickup: `{ _id: 812, customer_id: 4, status: "pending", … }` |
| column | **field** | `status`, `scheduled_date` |
| primary key | **`_id`** (every document has one) | our numeric ids are stored in `_id` |
| `NULL` | `null` **or the field is missing** | see gotcha 8.1 |
| index | index | same idea, see section 9 |
| JOIN | `$lookup` (aggregation) or a 2nd query | we use a 2nd query, see section 6 |
| AUTOINCREMENT | does not exist | we use a `counters` collection |

A pickup document, as you will see it in Compass:

```json
{
  "_id": 812,
  "customer_id": 4,
  "vehicle_id": 1,
  "driver_id": 2,
  "scheduled_date": "2026-10-20",
  "status": "pending",
  "seq": 3,
  "time_window": "07:00-12:00",
  "photo_url": null,
  "created_at": "2026-10-19 06:30:12"
}
```

**Replica set:** MongoDB only allows *transactions* (several writes that succeed or fail together) on a
replica set. Prisma needs them, so even your laptop runs a one-member replica set (`rs0`). See
`docs/MONGODB-SETUP.md`.

---

## 3. Prisma in 5 minutes

Prisma is an **ORM** (Object-Relational Mapper): you describe your data once in `prisma/schema.prisma`,
and Prisma generates a JavaScript client with one object per model.

```prisma
model Pickup {
  id             Int     @id @map("_id")      // primary key, stored as MongoDB's _id
  customer_id    Int                          // required number
  vehicle_id     Int?                         // ? = may be null
  scheduled_date String                       // 'YYYY-MM-DD'
  status         String  @default("pending")  // value used when you don't give one
  …
  @@index([scheduled_date, status])           // index for fast lookups
  @@map("pickups")                            // the real collection name
}
```

becomes

```js
await prisma.pickup.findMany({ where: { status: 'pending' } })
//          ^^^^^^ the model name with a small first letter
```

Three commands to remember:

| Command | When |
|---|---|
| `npx prisma generate` | After **every** change to `schema.prisma`. Rebuilds the client in `node_modules/@prisma/client` (`npm install` runs it for you). |
| `npx prisma db push` | Applies the schema to MongoDB: creates collections and indexes. `npm run db:setup` = this + our partial indexes. |
| `npx prisma studio` | A browser UI to view and edit data (`npm run db:studio`). |

> With SQL databases Prisma uses `prisma migrate` (migration files). **MongoDB has no migrations in
> Prisma**: documents have no fixed columns, so adding a field is just editing the schema and running
> `db push`. Old documents simply don't have the new field until you write it (gotcha 8.1).

---

## 4. How GreenLoop is wired

| File | Job |
|---|---|
| `prisma/schema.prisma` | Every collection, its fields, defaults and indexes. **Start reading here.** |
| `server/prisma.js` | Creates the **one** Prisma client the app uses, and adds three automatic steps to every create (below). Also `getSetting`/`setSetting`. |
| `server/db.js` | Re-exports `prisma` plus helpers: `join`, `findById`, `toId`, `int`, `num`, `str`, `sortBy`, `desc`, `groupBy`, `statusCounts`, `now`, and `seed()` for demo data. |
| `server/mongo-indexes.js` | Unique rules that apply to *some* documents only (partial indexes). |
| `server/schema-info.js` | Reads `schema.prisma` so `prisma.js` knows each model's fields. |
| `scripts/*.js` | `db:indexes`, `db:check`, `db:migrate-sqlite`, `test:mongo`. |
| `test/fake-prisma.js` | An in-memory stand-in for Prisma so `npm test` runs without a database. |

**What `server/prisma.js` adds automatically** (a Prisma *client extension*):

1. **Numeric ids.** MongoDB has no auto-increment. Before each `create`, it takes the next number from
   the `counters` collection with one atomic `$inc`:
   ```js
   const c = await base.counter.upsert({
     where: { id: 'pickups' }, create: { id: 'pickups', seq: 1 }, update: { seq: { increment: 1 } },
   });   // c.seq is the new id
   ```
   We kept numbers (1, 2, 3 …) because every app uses them in URLs like `/pickups/812/complete`.
   (The usual MongoDB choice is an `ObjectId` such as `"6717a…"`. That would have meant changing every app.)
2. **`created_at` / `updated_at`** are filled in on create, as `'YYYY-MM-DD HH:MM:SS'` UTC text, exactly
   what SQLite's `datetime('now')` produced. On updates, set `updated_at: now()` yourself where it matters.
3. **Missing optional fields are stored as `null`**, so `where: { invoice_id: null }` works like SQL's
   `IS NULL` (gotcha 8.1).

**Other decisions** (so nothing in the front-ends had to change):
field names stay `snake_case`; dates stay text (`'2026-10-20'` sorts and compares correctly as text);
yes/no flags stay `0` / `1`; lists stored as JSON text (`items`, `lines`, `recurrence`) stay JSON text.
These are fine choices for a migration. In a brand-new project you would probably use `DateTime`,
`Boolean` and `Json` types and camelCase names.

**One request, end to end**: the driver taps *Finish* → `POST /api/v1/pickups/812/finish` →
`server/driver-shift.js`:

```js
r.post('/pickups/:id/finish', auth('driver'), async (req, res) => {
  const p = await arrivedJob(req, res); if (!p) return;              // findById('pickup', req.params.id)
  await prisma.pickup.update({                                        // UPDATE pickups SET … WHERE id=?
    where: { id: p.id },
    data: { status: 'collected', stage: 'completed', completed_at: ts, … , updated_at: sqlNow() },
  });
  const info = await stopInfo(p);                                     // customer name + fleet number
  io.to('staff').emit('pickup:completed', { … });                     // live update to the CRM
  try { await v3.onPickupCompleted(p.id); } catch (e) { … }           // notify customer, per-visit invoice
  res.json({ ok: true, status: 'collected', … });
});
```

---

## 5. Cheat sheet: SQL → Prisma

Every example is from this codebase (file in brackets).

### Reading

```js
// SELECT * FROM pickups WHERE id = ?                                              (many files)
await prisma.pickup.findUnique({ where: { id: 812 } })        // → object or null
// findUnique only accepts unique fields (id, @unique, @@unique). For anything else:

// SELECT * FROM users WHERE role='admin' AND username=? AND is_active=1 LIMIT 1     [api.js]
await prisma.user.findFirst({ where: { role: 'admin', username, is_active: 1 } })

// SELECT id, status, seq … FROM pickups WHERE scheduled_date=? AND driver_id=?
//        AND status != 'rescheduled' ORDER BY seq                                   [api.js /driver/jobs]
await prisma.pickup.findMany({
  where: { scheduled_date: today, driver_id: req.user.id, status: { not: 'rescheduled' } },
  select: { id: true, status: true, seq: true, customer_id: true },   // only these fields
  orderBy: [{ seq: 'asc' }, { id: 'asc' }],                           // several sort keys
})

// … ORDER BY id DESC LIMIT 100                                                    [v3.js /audit]
await prisma.auditLog.findMany({ orderBy: { id: 'desc' }, take: 100 })   // take = LIMIT, skip = OFFSET
```

### Filters (the `where` object)

| SQL | Prisma |
|---|---|
| `status = 'pending'` | `{ status: 'pending' }` |
| `status != 'void'` | `{ status: { not: 'void' } }` ⚠ also matches `null`, gotcha 8.2 |
| `status IN ('a','b')` | `{ status: { in: ['a', 'b'] } }` |
| `id NOT IN (…)` | `{ id: { notIn: [1, 2] } }` |
| `x IS NULL` / `IS NOT NULL` | `{ x: null }` / `{ x: { not: null } }` |
| `date BETWEEN ? AND ?` | `{ date: { gte: from, lte: to } }` (also `gt`, `lt`) |
| `date LIKE '2026-10%'` | `{ date: { startsWith: '2026-10' } }` (also `endsWith`, `contains`) |
| `lower(email) = ?` | `{ email: { equals: e, mode: 'insensitive' } }` |
| `a = 1 OR b = 2` | `{ OR: [{ a: 1 }, { b: 2 }] }` |
| `NOT (a = 1)` | `{ NOT: { a: 1 } }` |
| several conditions | just more keys: `{ a: 1, b: 2 }` (= AND) |

```js
// overdue, or "not picked up" that was confirmed/auto-confirmed/awaiting       [growth.js scoreCustomer]
where: {
  customer_id: c.id,
  scheduled_date: { gte: d60, lte: today },
  OR: [
    { status: 'overdue' },
    { status: 'canceled', OR: [{ confirmation_status: null }, { confirmation_status: { in: ['confirmed', 'auto_confirmed', 'awaiting', ''] } }] },
  ],
}
```

### Writing

```js
// INSERT INTO alerts(type,severity,message,pickup_id) VALUES (…)                 (many files)
const a = await prisma.alert.create({ data: { type: 'ANOMALY', severity: 'warning', message: msg, pickup_id: p.id } });
a.id;   // the new id (was info.lastInsertRowid)

// many rows at once — one round trip                                          [services/scheduler.js]
await prisma.pickup.createMany({ data: toInsert });   // returns { count }

// UPDATE pickups SET stage='arrived' WHERE id=?                               [ops-features.js]
await prisma.pickup.update({ where: { id }, data: { stage: 'arrived', updated_at: sqlNow() } });
//   ⚠ update() THROWS if no document matches (error P2025) — gotcha 8.5

// UPDATE alerts SET is_read=1 WHERE is_read=0                                 [api.js]
await prisma.alert.updateMany({ where: { is_read: 0 }, data: { is_read: 1 } });   // { count }, never throws

// UPDATE invoices SET sent_count = sent_count + 1                             [v3.js]
data: { sent_count: { increment: 1 } }      // also decrement, multiply, divide — atomic in MongoDB

// INSERT … ON CONFLICT(key) DO UPDATE SET value=excluded.value                [prisma.js setSetting]
await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });

// compound unique key: @@unique([vehicle_id, date]) is addressed as vehicle_id_date   [capacity.js]
await prisma.vehicleCapacityOverride.findUnique({ where: { vehicle_id_date: { vehicle_id: 2, date: '2026-10-21' } } });

// DELETE FROM otp_codes WHERE customer_id=?                                   [v3.js]
await prisma.otpCode.deleteMany({ where: { customer_id: acct } });   // delete() = one, by unique field
```

### Counting and GROUP BY

```js
// SELECT COUNT(*) FROM customers WHERE is_active=1                            [api.js /dashboard]
await prisma.customer.count({ where: { is_active: 1 } })

// SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=?             [v3.js invoiceView]
const agg = await prisma.payment.aggregate({ where: { invoice_id: inv.id }, _sum: { amount: true } });
const paid = agg._sum.amount || 0;          // _sum is null when there are no documents
// also _avg, _min, _max, _count

// SELECT customer_id, COUNT(*) FROM pickups WHERE status='collected' AND … GROUP BY customer_id   [api.js /customers]
const done = await prisma.pickup.groupBy({
  by: ['customer_id'],
  where: { status: 'collected', scheduled_date: { startsWith: month } },
  _count: { _all: true },
});
// → [{ customer_id: 4, _count: { _all: 2 } }, …]

// SELECT zone, AVG(lat), AVG(lng) FROM customers GROUP BY zone               [v3.js zoneCentroids]
await prisma.customer.groupBy({ by: ['zone'], _avg: { lat: true, lng: true } });

// SELECT DISTINCT customer_id FROM service_plans WHERE status='active'      [services/scheduler.js]
await prisma.servicePlan.findMany({ where: { status: 'active' }, select: { customer_id: true }, distinct: ['customer_id'] });
```

### Raw MongoDB commands (rarely needed)

```js
await prisma.$runCommandRaw({ createIndexes: 'pickups', indexes: [ … ] });   // scripts/create-indexes.js
await prisma.$runCommandRaw({ hello: 1 });                                   // scripts/check-db.js
```

---

## 6. "JOINs" without SQL

MongoDB has no `JOIN`. The simplest replacement is **one extra query for all related documents**, then
matching them up in JavaScript. That's what `join()` in `server/db.js` does:

```js
// SQL:  SELECT p.id, p.status, c.name, c.branch, v.fleet_number
//       FROM pickups p JOIN customers c ON c.id = p.customer_id
//       LEFT JOIN vehicles v ON v.id = p.vehicle_id WHERE p.scheduled_date = ?
let rows = await prisma.pickup.findMany({ where: { scheduled_date: date } });
rows = await join(rows, 'customer_id', 'customer', ['name', 'branch'], { inner: true });   // JOIN
rows = await join(rows, 'vehicle_id', 'vehicle', ['fleet_number']);                         // LEFT JOIN
rows = await join(rows, 'driver_id', 'user', { driver: 'full_name' });                      // … AS driver
rows = await join(rows, 'service_type', 'serviceType', ['category'], { key: 'code' });      // ON st.code = p.service_type
```

Each `join()` is **one** query (`id IN [all the ids]`), no matter how many rows. Read its source: it's 20 lines.

Two other ways you will meet later:
- **Prisma relations**: add `customer Customer @relation(fields: [customer_id], references: [id])`
  to the model and use `include: { customer: true }`. Prisma then does the same "2nd query" for you.
  We didn't add relations in this conversion to keep the schema a 1:1 copy of the old tables, but they are
  a good next step (exercise 4).
- **Aggregation pipelines** with `$lookup` through `prisma.pickup.aggregateRaw({ pipeline: [...] })`.
  These are powerful but MongoDB-specific. Learn them after the basics.

---

## 7. async / await — the rule you cannot skip

SQLite in Node was **synchronous**: `q.get(...)` returned the row immediately. Prisma is
**asynchronous**: every call returns a **Promise**, a value that arrives later.

```js
// ✗ WRONG — p is a Promise, not a pickup. p.status is undefined. No error is shown!
const p = prisma.pickup.findUnique({ where: { id } });

// ✓ RIGHT — inside an async function
const p = await prisma.pickup.findUnique({ where: { id } });
```

So in this conversion:
- every route handler became `async (req, res) => { … }` (Express 5 sends errors thrown there to the error handler),
- every function that touches the database became `async`, and **every caller awaits it**:
  `await v3.notifyCustomer(...)`, `await capacity.capacityFor(v, date)`, `await growth.tierOf(cid)` …
- loops that query use `for … of` with `await` (`array.forEach(async …)` does **not** wait!),
- "fire and forget" work that must not delay the reply ends with `.catch(...)` so a failure can't crash
  the server (example: the audit log in `v3.js guard()`).

Forgotten `await` is the #1 bug after a conversion like this. Symptoms: `undefined` values, `{}` in
JSON responses, or *"UnhandledPromiseRejection"* in the terminal.

---

## 8. The gotchas we hit while converting (read this!)

These are real problems from this project, not theory.

### 8.1 "missing" is not the same as `null`
In MongoDB a field can be `null` **or not exist at all**. Prisma's `where: { photo_url: null }` matches
only real `null`s. That's why `server/prisma.js` writes `null` for every optional field you don't set on
create, so `IS NULL` queries keep working. Documents written by other tools (or before you added a field)
may lack the field. Prisma has `{ field: { isSet: false } }` to find those.

### 8.2 `not` / `notIn` also match `null`
SQL: `WHERE plan_id != 5` **skips** rows where `plan_id` is NULL. MongoDB/Prisma: `{ plan_id: { not: 5 } }`
**includes** them. When the old SQL relied on that, add the null check yourself:
```js
AND: [{ plan_id: { not: null } }, { plan_id: { not: job.plan_id } }]      // test/unit/regression.test.js
```

### 8.3 Unique indexes and many `null`s
SQL lets many rows have `NULL` in a UNIQUE column. MongoDB counts `null` as a value, so a normal
unique index on `users.username` would allow only **one** driver without a username. Solution: a
**partial** unique index that only checks documents where the field is set (`server/mongo-indexes.js`):
```js
{ key: { username: 1 }, partialFilterExpression: { username: { $type: 'string' } } }
```
Prisma's schema can't express that, so `npm run db:indexes` creates it with `$runCommandRaw`.

### 8.4 Types are strict
SQLite happily stored `"2"` (text) in an INTEGER column. Prisma rejects it:
*Invalid value … Expected Int, provided String*. URL params and form fields are **always strings**, so
convert first: `toId(req.params.id)`, `int(body.capacity, 15)`, `num(body.lat)` (all in `server/db.js`).
`Int` must also be a whole number (`Math.round` distances before saving), and `NaN` is not a valid `Float`.

### 8.5 `update` / `delete` throw when nothing matches
SQL `UPDATE … WHERE id=999` silently changes 0 rows. `prisma.x.update({ where: { id: 999 } })` throws
**P2025**. Either check first (`findById` → 404), or use `updateMany`/`deleteMany` when "nothing to do"
is a normal outcome. Catch errors by code with `isNotFound(e)` / `isUniqueError(e)` (`server/prisma.js`):
```js
try { await prisma.vehicle.create({ data }); }
catch (e) { if (isUniqueError(e)) return res.status(409).json({ error: 'Fleet number already exists' }); throw e; }
```

### 8.6 You can't compare two fields in a normal `where`
SQL: `WHERE account_id IS NULL OR account_id = id`. Prisma's `where` compares a field with a **value**,
not with another field. We load the documents and filter in JS (`push-api.js accountHolders()`).
For big collections use an aggregation with `$expr`.

### 8.7 Sorting text and nulls
`sortBy(rows, r => r.zone, r => r.name)` in `server/db.js` sorts like SQL (`null` first, plain character
order). `localeCompare` would order some strings differently from the old SQL.

### 8.8 Upsert races
Two requests may both try to *create* the same unique document at the same moment. One gets P2002.
`server/prisma.js reserveIds()` simply retries. Remember this pattern for counters and settings.

---

## 9. Speed: indexes, groupBy and the N+1 problem

- **Indexes** make lookups fast. Every `@@index([...])` in `schema.prisma` becomes a MongoDB index on
  `db push`. Add one when you filter or sort a big collection by a field often. Example:
  `@@index([scheduled_date, status])` serves the ledger, dashboard and SLA monitor. Check with
  Compass → *Explain plan* (`IXSCAN` good, `COLLSCAN` = no index used).
- **Let MongoDB count.** `groupBy`/`count`/`aggregate` return a few small rows. Loading 30,000 pickups
  into Node to count them is slow. `/stats/overview` and `/fleet/load` in `api.js` show the difference:
  `/fleet/load` went from one query per vehicle per day (15 trucks × 7 days = 210 queries) to **two** queries.
- **N+1 queries**: a loop that runs one query per row (`for (const c of customers) await prisma.x.count(...)`)
  makes N extra round trips. Fine for 36 customers, slow for 5,000. Fix it with one `findMany({ where: { id: { in: ids } } })`
  or a `groupBy` (that's what `join()` does). Places that still loop and could be improved later:
  `growth.recalcHealth` (nightly, ~10 queries per customer) and `/rewards/overview`.

---

## 10. Tools

| Tool | Use it for |
|---|---|
| **MongoDB Compass** | Browse collections, filter (`{ status: "pending" }`), check indexes, explain plans, edit a document |
| **Prisma Studio** (`npm run db:studio`) | A quick table-like view of every model, straight from the schema |
| **`PRISMA_LOG=1`** in `.env` | Prints every query Prisma sends: the best way to *see* what your code does |
| **`npm run db:check`** | Connection + replica set + document counts |

---

## 11. Testing

- `npm test`: all 8 suites (the same checks that passed on SQLite) run against `test/fake-prisma.js`, an in-memory imitation
  of Prisma + MongoDB. It reads `schema.prisma` and is deliberately strict (wrong types, unknown fields,
  unique violations and missing documents throw like real Prisma). It needs no database, so it's fast and works in CI.
- `npm run test:mongo`: the **same** tests against your real MongoDB (database `greenloop_test`).
  Run this after any schema change. It is the final word.
- `npm run test:e2e`: boots the real server against MongoDB and walks through the main flows.

---

## 12. Practice exercises

Do them on a branch, in order. Each one uses one idea from this guide.

1. **Read & filter.** Add `GET /api/v1/vehicles/:id/today` returning that truck's stops for today, sorted
   by `seq`, with customer name (use `findMany` + `join`). Check the result in Compass.
2. **Add a field.** Add `notes_internal String?` to `Vehicle` in `schema.prisma`, run `npx prisma generate`
   and `npm run db:push`, then allow it in `PUT /vehicles/:id`. Notice that old vehicles show `null`
   (or no field at all in Compass, gotcha 8.1).
3. **groupBy.** Add `GET /api/v1/reports/zones?month=2026-10` with pickups per zone and status, using
   `groupBy` like `/stats/overview`. No `findMany` of all pickups allowed!
4. **Relations.** Add `customer Customer @relation(fields: [customer_id], references: [id])` to `Pickup`
   (and `pickups Pickup[]` to `Customer`), then rewrite one `join()` call as `include: { customer: { select: { name: true } } }`.
   Compare both with `PRISMA_LOG=1`.
5. **Aggregation pipeline.** Rewrite exercise 3 with `prisma.pickup.aggregateRaw({ pipeline: [ { $match: … }, { $lookup: … }, { $group: … } ] })`.
6. **Test it.** Add a check for exercise 1 to a file in `test/unit/` and run `npm test` and `npm run test:mongo`.

---

## 13. Where to read more

- Prisma + MongoDB: https://www.prisma.io/docs/orm/overview/databases/mongodb
- Prisma Client queries (CRUD, filters, aggregation): https://www.prisma.io/docs/orm/prisma-client/queries
- Prisma schema reference: https://www.prisma.io/docs/orm/reference/prisma-schema-reference
- Client extensions (what `server/prisma.js` uses): https://www.prisma.io/docs/orm/prisma-client/client-extensions
- MongoDB University (free courses, start with "MongoDB Basics"): https://learn.mongodb.com
- MongoDB data modelling: https://www.mongodb.com/docs/manual/data-modeling/
- Replica sets: https://www.mongodb.com/docs/manual/replication/

> Version note: this project uses **Prisma 6** (`^6.16.0` in `package.json`). Prisma 7 changed how
> MongoDB is supported, so don't upgrade the major version without checking Prisma's MongoDB docs first.
