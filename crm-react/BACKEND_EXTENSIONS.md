# Backend Extensions for React CRM v2

## New tables (see server/migrations/002_companies_maintenance.sql)

- `companies` — multi-company support for Majari group
- `branches` — branches under companies
- `vehicle_maintenance` — service, RTA registration, insurance tracking

## Suggested new API routes (add to server/api.js)

```
GET/POST /api/v1/companies
GET/PUT  /api/v1/companies/:id
GET/POST /api/v1/branches?company_id=
GET/POST /api/v1/maintenance
GET/PUT  /api/v1/maintenance/:vehicleId
GET      /api/v1/drivers/scorecards   # for gamification
```

The React CRM already has UI pages for these. Wire the endpoints and the pages will come alive with real data.

## How to apply migration

For SQLite (dev):
```js
// in server/db.js after existing CREATE TABLE blocks
db.exec(fs.readFileSync('server/migrations/002_companies_maintenance.sql', 'utf8'));
```

For Postgres: convert types (SERIAL, BOOLEAN, TIMESTAMPTZ) as in deploy/schema.postgres.sql.
