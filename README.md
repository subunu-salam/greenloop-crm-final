# GreenLoop — Automated Waste Logistics & Fleet Management System

Complete working product per the PRD: a **Driver PWA** (zero-text, visual-first) and an **Owner CRM Control Center**, connected in real time over WebSockets, backed by a Node.js API with an intelligent scheduling and rescheduling engine.

## Quick start (2 minutes)

Requires **Node.js 22+** (nothing else — the database is built in).

```bash
npm install
npm start
```

| App | URL | Login |
|---|---|---|
| Owner CRM | http://localhost:3000/crm | `admin` / `admin123` |
| Driver App | http://localhost:3000/driver | PIN `1111` (Ali · TRUCK-01), `2222` (Ramesh · TRUCK-02) |

On first boot the system seeds 36 demo supermarket clients across 3 Dubai zones, 2 trucks, 3 drivers, and **auto-generates the current month's schedule** (2–3 visits per client, 8–12 day gaps, ≤15 stops/vehicle/day).

> Use the driver app from a phone on the same network (`http://<your-ip>:3000/driver`) to get real camera + GPS. On desktop, the photo button opens a file picker.

## What's inside

### Driver PWA (`/driver`)
- 4-digit PIN pad login — no typing anywhere in the app
- Today's route, pre-sorted geographically, color-coded status cards (min 64px targets)
- **TAKE PICKUP PHOTO** (green) → camera → silent GPS + ISO timestamp capture → multipart upload
- **NO PICKUP TODAY** (red) → 3 icon reasons: Bin Empty / Access Blocked / Manager Refused
- Offline queue in localStorage with 60-second auto-retry; installable PWA with offline shell

### Owner CRM (`/crm`)
- **Dashboard** — live KPIs + real-time activity feed with photo proofs (WebSocket)
- **Daily Route Ledger Matrix** — per-vehicle stop order, status, GPS verification, photo proof, any date
- **Active Fleet Load Tracker** — 7-day utilisation bars vs. capacity per vehicle
- **Rescheduling module** — one click runs the engine: zone filter → capacity check → mileage deviation → top 3 slots → dispatch (driver queue updates live)
- **Customers** — CRUD, zone, 2–3×/month frequency, month-to-date compliance
- **Users** — create/edit drivers (PIN) and admins (username/password), enable/disable, vehicle assignment
- **Vehicles** — onboard TRUCK-03 and the next generation rebalances loads automatically
- **Reports** — client compliance, driver performance, anomaly breakdown, full ledger — all CSV-exportable
- **Alerts** — SLA breach (pending after shift cutoff → flashing OVERDUE + critical alert), anomalies, reschedules

### Native driver app (`mobile-expo/`)
Expo / React Native version of the driver app — same API contract, installable from the app stores. See `mobile-expo/README.md` (set your server IP in `src/config.js`, then `npx expo start`).

### Engines (`server/services/`)
- `scheduler.js` — monthly frequency scheduler (PRD §3.1)
- `rescheduler.js` — conflict-free rescheduling engine (PRD §3.2)
- `sla.js` — SLA time-window breach monitor, runs every 60 s (PRD §3.3)
- `geo.js` — haversine, cheapest-insertion, nearest-neighbour route ordering

## Demo walkthrough (5 minutes)
1. Open the CRM, log in, look at **Dashboard** and **Daily Route Ledger**.
2. In another tab/phone, open the driver app, PIN `1111`.
3. Tap a client → **TAKE PICKUP PHOTO** → pick any image → watch the CRM feed update instantly.
4. Tap another client → **NO PICKUP TODAY** → *Manager Said No* → a warning alert pops in the CRM.
5. Go to **Rescheduling** → *Find slots* → see the top-3 ranked options with km deviation → *Dispatch*.
6. Go to **Vehicles** → *Onboard vehicle* (TRUCK-03, zone Downtown, capacity 15) → **Ledger** → *Generate month schedule* (next month, or force) → loads rebalance across 3 trucks.
7. **Dashboard** → *run SLA check now* (after the 12:00 cutoff) → pending stops flip to OVERDUE with critical alerts.

## Configuration
- `PORT` (default 3000), `JWT_SECRET` (set in production!), `DB_PATH` (SQLite file location)
- Shift cutoff: `PUT /api/v1/settings { "shift_cutoff": "12:00" }` (also drives the SLA monitor)

## Production notes
- `deploy/schema.postgres.sql` — identical schema for PostgreSQL; the query layer in `server/db.js` is isolated so swapping the driver (e.g. `pg`) is a contained change.
- `deploy/docker-compose.yml` — app + Postgres containers.
- Photo uploads land in `uploads/`; in production point this at S3/object storage.
- HTTPS is required in production for camera + geolocation APIs on phones.

## API surface (summary)
`POST /auth/driver-login` · `POST /auth/admin-login` · `GET /driver/jobs` ·
`POST /pickups/:id/complete` (multipart) · `POST /pickups/:id/cancel` ·
`GET /dashboard` · `GET /ledger` · `GET /fleet/load` · `POST /schedule/generate` ·
`GET /reschedule/pending|options/:id` · `POST /reschedule/apply` ·
`GET/POST/PUT /customers|users|vehicles` · `GET /reports/compliance|drivers|anomalies|ledger[?format=csv]` ·
`GET /alerts` · `GET/PUT /settings` · Socket.IO events: `pickup:completed`, `pickup:canceled`, `alert`, `ledger:refresh`, `driver:queue-updated`
