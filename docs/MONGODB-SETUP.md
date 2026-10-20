# Setting up MongoDB for GreenLoop (Community Server + Compass)

This takes about 15 minutes the first time. You need:

- **MongoDB Community Server** 6.0 or newer (7.x or 8.x recommended): https://www.mongodb.com/try/download/community
- **MongoDB Compass** (the desktop app to look at your data; usually installed together with the server)
- **Node.js 22+**

> **Why the extra "replica set" step?** Prisma uses MongoDB *transactions* internally, and MongoDB only
> allows transactions on a **replica set**. A replica set can be a single server, so we turn your one
> local MongoDB into a one-member replica set called `rs0`. Without this step Prisma stops with the
> error *"Prisma needs to perform transactions, which requires your MongoDB server to be run as a replica set"* (code P2031).
> MongoDB Atlas (cloud) is always a replica set, so this step is only for local installs.

---

## 1. Install MongoDB Community Server

**Windows:** run the `.msi`, choose *Complete*, keep **"Install MongoDB as a Service"** ticked, and tick
**"Install MongoDB Compass"**.

**macOS (Homebrew):**
```bash
brew tap mongodb/brew
brew install mongodb-community
```

**Ubuntu / Debian:** follow https://www.mongodb.com/docs/manual/administration/install-on-linux/ (package `mongodb-org`).

You also want **mongosh** (the MongoDB shell). Compass has one built in: the **`>_ MONGOSH`** bar at the bottom of the
Compass window. You can use that for every command below.

---

## 2. Turn on the replica set (once)

### 2a. Add two lines to the MongoDB config file

Open the config file **as administrator**:

| System | Config file |
|---|---|
| Windows | `C:\Program Files\MongoDB\Server\<version>\bin\mongod.cfg` (open Notepad with *Run as administrator*) |
| macOS (Apple Silicon) | `/opt/homebrew/etc/mongod.conf` |
| macOS (Intel) | `/usr/local/etc/mongod.conf` |
| Linux | `/etc/mongod.conf` |

Find the line `#replication:` and replace it with (indentation matters: two spaces, no tabs):

```yaml
replication:
  replSetName: rs0
```

### 2b. Restart MongoDB

| System | Command |
|---|---|
| Windows | Open **Services** (`services.msc`), right-click **MongoDB Server** → *Restart*. Or in an *Administrator* terminal: `net stop MongoDB` then `net start MongoDB` |
| macOS | `brew services restart mongodb-community` |
| Linux | `sudo systemctl restart mongod` |

### 2c. Start the replica set

Open Compass, connect to `mongodb://127.0.0.1:27017/?directConnection=true`, click **`>_ MONGOSH`** at the bottom and run:

```js
rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })
```

You should see `{ ok: 1 }`. After a few seconds the prompt changes to `rs0 [direct: primary]`.
Check any time with:

```js
rs.status().ok        // 1 = fine
```

> Using `127.0.0.1` (not your computer's name) avoids the most common Windows problem, where the
> replica set advertises a host name your apps cannot resolve.

---

## 3. Connect Compass

New connection → paste:

```
mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true
```

Save it as a favourite ("GreenLoop local"). After the app's first start you will see a database called
**`greenloop`** with collections such as `pickups`, `customers`, `users`, `counters`.

Useful things to try in Compass:

- **Filter** box in a collection: `{ status: "pending", scheduled_date: "2026-10-20" }`
- **Sort**: `{ scheduled_date: -1 }`
- **Indexes** tab: shows the indexes `npm run db:setup` created
- **Explain plan** on a query: shows whether MongoDB used an index ("IXSCAN") or scanned everything ("COLLSCAN")

---

## 4. Connect GreenLoop

In the project folder:

```bash
cp .env.example .env          # Windows PowerShell: copy .env.example .env
```

`.env` already contains the local connection string:

```
DATABASE_URL="mongodb://127.0.0.1:27017/greenloop?replicaSet=rs0&directConnection=true"
```

`/greenloop` is the database name. MongoDB creates it on the first write, so you don't create it yourself.

Then:

```bash
npm install          # downloads Prisma and generates the Prisma Client from prisma/schema.prisma
npm run db:setup     # creates collections + indexes (prisma db push) and the partial unique indexes
npm run db:check     # prints "Connected to replica set rs0" and a count per collection
npm start            # http://localhost:3000/crm  →  admin / admin123
```

On the first start the server seeds demo data (2 trucks, 3 drivers, 36 customers, this month's schedule).
Refresh Compass and look at the `greenloop` database.

### Moving your existing SQLite data (optional)

If you have a `data.sqlite` / `greenloop.sqlite` from the old version:

```bash
npm run db:migrate-sqlite -- path/to/greenloop.sqlite          # into an EMPTY database
npm run db:migrate-sqlite -- path/to/greenloop.sqlite --wipe   # empties the MongoDB database first
```

It keeps every id, so invoice numbers, links and the mobile apps keep working. The SQLite file is only read.

---

## 5. Run the tests against your MongoDB

```bash
npm test             # fast, uses an in-memory stand-in (no database needed)
npm run test:mongo   # same tests on your real MongoDB, database "greenloop_test" (emptied each run)
npm run test:e2e     # boots the real server, database "greenloop_e2e"
```

Your normal `greenloop` database is never touched by the tests.

---

## Troubleshooting

| Message | Cause → fix |
|---|---|
| `P2031 … requires your MongoDB server to be run as a replica set` | Step 2 not done or MongoDB not restarted. Check `rs.status().ok` in mongosh. |
| `Server selection timeout` / `P1001 Can't reach database server` | MongoDB is not running (start the service) or `DATABASE_URL` is wrong. |
| Timeout only when `replicaSet=rs0` is in the URL | The replica set was initiated with a host name. Add `&directConnection=true` to the URL, or re-run step 2c with `127.0.0.1`. |
| `@prisma/client did not initialize yet. Please run "prisma generate"` | Run `npx prisma generate` (or `npm install` again). Needed after every change to `schema.prisma`. |
| `Unique constraint failed … ux_users_username` | Two admins with the same username. That's the partial unique index doing its job. |
| `Invalid value for argument … Expected Int` | A text value like `"12"` reached an Int field. In route code convert with `toId()` / `int()` from `server/db.js`. |
| Compass shows no `greenloop` database | The server hasn't started yet (MongoDB creates databases on the first write). |

Still stuck? Run `npm run db:check`: it tells you whether it can connect and whether the replica set is on.

## Team Atlas database: `greenloop_test`

The team has a MongoDB Atlas cluster with a database named **`greenloop_test`**
(Atlas project → Data Explorer → `greenloop_test`). To use it:

1. In Atlas open **Connect → Drivers** and copy the `mongodb+srv://` string.
2. Put it in your local `.env` (never in git), with `/greenloop_test` as the database:
   ```
   TEST_DATABASE_URL="mongodb+srv://USER:PASSWORD@CLUSTER_HOST.mongodb.net/greenloop_test?retryWrites=true&w=majority"
   ```
   then run `npm run test:mongo`. To run the app itself against it, set `DATABASE_URL` to the same string.
3. In **Atlas → Network Access**, allow your IP (or `0.0.0.0/0` for Render).
4. Ask the Atlas project owner to invite you under **Project → Access Manager** rather than sharing passwords in chat.

> ⚠️ `npm run test:mongo` **empties** the database it runs against. Use `greenloop_test`
> only for testing — production on Render must use a separate database (e.g. `greenloop`).
