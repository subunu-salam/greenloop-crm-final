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

---

## v3 — PRD v1.0 implementation

New server module: `server/v3.js` (schema migrations run automatically on start, SQLite only).

**CRM** (glassmorphism theme, role-aware navigation): sales pipeline & lead kanban, quotation builder (5% VAT, versioning, WhatsApp share via `wa.me`, public accept link `/q/:token`, printable PDF), convert quote → customer (multi-site, plans, portal code), service catalogue, recurring service plans (daily / weekly / monthly nth-weekday, time windows, pause/resume), ad-hoc orders, booking requests, not-picked-up confirmations & disputes, invoices & payments with balances, customer 360 view with risk score, "clients needing attention", ops-staff role (blocked from billing/settings), audit log.

**Driver app:** live camera only (no gallery), on-device stamp with date/time/GPS/customer, server rejects photos >150 m from site or with >5 min clock skew (CRM alert, override possible), not-picked-up flow with 4 reasons + mandatory photo, pest-control checklist, per-stop countdown & at-risk warning, Google Maps "Navigate" deep link (no Maps API cost), EN/HI/UR/AR, offline queue.

**Customer app:** store code or OTP login, site switcher, today/live tracking, plans (change/pause/resume), one-off booking, invoices & balance, confirm/dispute missed visits within 24 h, quotations, notifications, filtered proof history + PDF report.

**Background jobs (every 60 s):** nightly 14-day job generation (skips UAE holidays and paused dates, zone + capacity allocation with overflow, pest jobs only to pest-tagged vehicles), 17:00 day-before reminders, 24 h auto-confirm, at-risk alerts 30 min before window close.

### Environment variables
| Var | Default | Purpose |
|---|---|---|
| `OTP_DEV` | off | Set `OTP_DEV=1` only for local testing: it shows the one-time code on screen. Never set it on a live site. |
| `SEED_DEMO` | on | Seeds demo leads + a sent quotation. Set `0` to disable. |
| `PROOF_RADIUS_M` | 150 | Max photo distance from site. |

### Notes / open items
- "PDFs" (quotes, invoices, history) are print-ready HTML pages — use the browser's Save as PDF.
- The UAE holiday list for 2026 is approximate; edit it in CRM → Settings.
- The Postgres mode (`db-pg.js`) does not support the v3 module.
- Open PRD questions: SMS/email provider for OTP, payment gateway, final holiday calendar, VAT registration number on documents.

---

## v3.1 — security, performance and reliability fixes

Result of a full QA pass (regression, edge-case, load and A/B performance testing).

### What changed for users
- **Customer sign-in is now mobile number + store code.** The number must match the
  one on the customer's account in the CRM. New store codes are 6 digits; existing
  4-digit codes keep working. Demo: mobile **050 000 1001** + code **1001** (also …1002, …1003).
- Drivers can only act on their own jobs, and not before the scheduled day.
- Proof photos must be taken within 15 minutes of upload. Photos sent later from the
  driver app's offline queue are accepted but raise a **LATE_PROOF** alert for review.
- The CRM warns while an account still uses the default `admin123` password.
- "Service tomorrow" reminders go out at 17:00 UAE time (previously 21:00).

### Security
- Sign-in lockout: 5 wrong attempts (8 for driver PINs) → 15-minute lockout per IP and
  per account. One-time codes: max 3 requests per 15 minutes.
- No built-in JWT secret: if `JWT_SECRET` is not set, a random one is generated and kept
  in `DATA_DIR/jwt-secret`. Set `JWT_SECRET` on the host so sessions survive restarts.
- Proof photos are private: `/uploads` only serves time-limited signed links that the API
  adds to its responses. Uploads must be JPEG/PNG/WebP/HEIC and get random file names.
- Live updates (Socket.IO) require a valid login; office events go to staff only and each
  customer only receives their own events.
- CORS no longer combines a wildcard origin with credentials.
- Input validation: real dates (≤ 1 year ahead), time windows that end after they start,
  phone/email formats, text fields ≤ 5,000 characters, sane quotation quantities and prices.

### Performance & reliability
- New database indexes (customers list 7 → 160 req/s on 500 customers / 26k jobs),
  prepared-statement cache, index-friendly month filters.
- Nightly plan generation runs in batches (300 plans: 4.4 s freeze → 0.6 s, longest pause 0.1 s).
- Daily SQLite backup (`VACUUM INTO`) next to the database, last 14 days kept.
- Quote and invoice numbers can no longer repeat (database-enforced for invoices).

### New / changed settings
| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | generated | Login signing secret — set it on the host |
| `APP_TZ` | `Asia/Dubai` | Business time zone for "today" and reminder time |
| `PHOTO_MAX_AGE_MIN` | `15` | Max minutes between taking and uploading a proof photo |
| `BACKUP_DAYS` | `14` | Daily backups to keep (`BACKUP_DIR` to change location, `BACKUP_DISABLED=1` to turn off) |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins if the API is called from another site |

### Tests
- `npm test` — regression suite + 50 edge-case/security checks (no install or network needed;
  runs on every GitHub push via `.github/workflows/test.yml`).
- `npm run test:load` — load test on 500 customers, 15 trucks, 26k jobs.

---

## v3.2 — fleet maintenance, capacity moderation, Gmail quotations, push

Full requirements: `docs/PRD-Fleet-Tracker-v3.2.md`.

### What changed for users
- **Driver app → new Vehicle tab.** Report tyre damage, oil change, service, brakes… with urgency, photo, odometer and — if the driver paid — amount + receipt photo (payment proof is mandatory).
- **CRM → Fleet maintenance.** Live reports, moderation, costs, payment proof, per-vehicle service history with CSV export, next-due reminders, driver reimbursements.
- **CRM → Fleet Load Tracker.** Capacity is no longer fixed at 15: change a vehicle's default, or a single day (with a reason). Dates read `DD/MM/YYYY` with the month spelled out underneath.
- **CRM → Push notifications.** Send an announcement to all customers, all drivers or everyone and see how many devices received it.
- **Quotations go out by Gmail** (WhatsApp is a fallback button). Converting an accepted quote emails the app access. **Invoices are delivered in the customer app** with push; "Send to app" resends.
- **System messages appear at the top** of the screen in CRM, driver and customer apps.
- All dates are shown as **DD/MM/YYYY**.

### Gmail (free) — pick one
| Option | Environment variables | Notes |
|---|---|---|
| A. App password (easiest) | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Google Account → Security → 2-Step Verification → App passwords. Sends through `smtp.gmail.com:465`. |
| B. Gmail API | `GMAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | OAuth client with the `gmail.send` scope. Use this if your host blocks outbound SMTP. |

Optional: `MAIL_FROM_NAME` (default `GreenLoop`). Check the connection in CRM → Settings → *Send test*.
With neither option set, "Send via Gmail" opens a pre-written Gmail message for the user to send by hand.
Free Gmail accounts are limited to roughly 500 recipients/day.

### Push notifications — what was fixed
- The customer app looked for its sign-in token in the wrong place, so **customer devices were never registered**. Fixed.
- Devices were registered once and remembered forever; a second person signing in on the same phone, or a site switch, kept sending to the old account. Devices now re-register on every sign-in / site switch and are removed on sign-out.
- Invoice alerts are addressed to the account while devices were registered per site → multi-site customers missed them. Alerts now reach every device on the account.
- The driver app's icon file was missing (blocked "Add to Home Screen" on some phones). Added.
- There was no admin-wide send. Added, with a delivery report.

Requirements that have not changed: HTTPS in production; on iPhone the app must be added to the Home Screen before notifications can be enabled (Apple's rule); keep `data/vapid.json` (or `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`) stable across deploys — if the keys change, every device re-registers the next time the app is opened.

### New API
`POST /driver/vehicle-reports` (multipart: photo, receipt) · `GET /driver/vehicle-reports` · `GET/POST /fleet/maintenance` · `PUT /fleet/maintenance/:id` · `POST /fleet/maintenance/:id/proof` · `GET /fleet/maintenance/vehicle/:id` ·
`PUT /fleet/capacity/default` · `PUT/DELETE /fleet/capacity/override` · `POST /push/broadcast` · `GET /push/stats|status` · `POST /push/test` ·
`POST /quotations/:id/send {via: gmail|whatsapp}` · `GET /mail/status` · `POST /mail/test` · `POST /invoices/:id/send`

### Not changed in this build
`crm-react/` (the experimental CRM v2) and `mobile-expo/` (native driver app) do not have the new screens yet.

---

## v3.4: Aura glow-up and new logo

A visual release: same screens and features as v3.3, restyled after the "Aura · Glass & Light" UI kit in GreenLoop's green, with a new logo. Each app loads one extra stylesheet, `aura.css`, after `styles.css` and `fx.css`. The file list is in `docs/CHANGES-v3.4.md`. v3.4.1 fixes three display issues found in the end-to-end test pass (same file). v3.4.2 tightens the phone rules per country, makes email failures explain themselves and stops false Overdue alerts for stops added after the cutoff.

**Email on a free host.** Gmail with an app password uses mail ports 465 and 587. Some hosts block them (Render free web services have done so since September 2025). There, connect Gmail through the Gmail API instead (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`), which uses the normal web port, or use a paid instance.

## v3.3 — unique contacts, frequency pricing, quotation preview, driver shift clock

### What changed for users
- **One phone format everywhere** (CRM and customer app): a country-code list (+971 UAE / Dubai, +966, +974, +968, +965, +973) and the local number, the same as the DevX Nexus sign-in. Numbers are stored as `+971501234567`.
- **No duplicate contacts.** A mobile number or email that is already on a lead or a customer cannot be saved again. The CRM names the existing record and offers to open it. For a new customer it can add the entry as another site of the existing customer instead.
- **Quotations are priced by frequency.** Each line is "N times a day / week / month". Visits a month and the amount are worked out by the server: daily = N × 30, weekly = N × 52 ÷ 12 rounded (3 a week = 13), monthly = N. The typed "Visits" box is gone. On registration every service is scheduled by its own frequency.
- **Preview before sending.** A quotation email can only be sent after its preview has been opened: recipient, subject, the email body and the quotation page it links to, followed by a confirmation. The server refuses a send without a preview, and refuses it if the quotation or recipient changed after the preview.
- **Quotation screens redesigned**: the quotation opens as the actual document the customer receives; the list is one row per quotation; the document and email use a plain letterhead layout.
- **Driver app: shift clock.** Clock in → Start job (navigation) → Arrive (one GPS-stamped photo) → Finish or Report issue. The arrival photo is the proof for the stop, so there is no second photo. A shift timer and per-job timers run in the app; the office sees clock-in/out, drive time and time on site in the Daily Route Ledger.
- **4-digit customer app code** (was 6). The code signs in as soon as the fourth digit is typed. Codes issued earlier still work on the server; reset them from Customer 360 to give the customer a 4-digit one.
- **One-time sign-in codes are emailed through Gmail** (free). A customer who types their mobile number receives the code at the email saved on their account. If the account has no email, the office gets an alert.

### Settings
| Variable | Default | Purpose |
|---|---|---|
| `OTP_DEV` | off | `1` shows the one-time code on screen, for local testing only. Leave it off (or `0`) on a live site. |
| `GMAIL_USER` + `GMAIL_APP_PASSWORD` | — | Now also used for one-time codes and welcome emails, not only quotations. |

No new npm packages. New tables and columns are created on start; existing data is kept.

### New / changed API
`GET /contacts/check` · `GET /pricing/frequency` · `POST /quotations/:id/preview` · `POST /quotations/:id/send` now needs `preview_token` for Gmail ·
`GET /driver/shift` · `POST /driver/shift/clock-in|clock-out` · `POST /pickups/:id/arrive-proof` (multipart) · `POST /pickups/:id/finish` · `POST /pickups/:id/issue` · `GET /shifts?date=`
`POST /pickups/:id/complete` and `/cancel` are unchanged and still used by the native app.

### Testing on phones
Camera, GPS and notifications only work over HTTPS (or `localhost`). Test the driver and customer apps on real phones against the deployed HTTPS address, not `http://<laptop-ip>:3000`.

### Tests
`npm test` now runs four suites: the regression walk-through plus 220 individual checks (edge cases 50, v3.2 78, v3.3 92).

### Not changed in this build
`mobile-expo/` (native driver app) and `crm-react/` still use the older screens. There is no SMS provider: one-time codes go by email only.
