# GreenLoop CRM v2 — React Edition (Majari UAE)

Modern React + TypeScript CRM for **Majari vehicle business day-to-day operations** in the UAE.

## Features

- **Full React rebuild** of the original vanilla JS CRM
- **Interactive maps** (Leaflet) for Dubai / Abu Dhabi route visualization
- **Arabic + English** bilingual UI with full RTL support
- **Vehicle maintenance & compliance** tracking (service, RTA registration, insurance)
- **Advanced analytics** with Recharts
- **Multi-company / multi-branch** support
- **Driver performance scorecards** & gamification
- **Mobile-optimized** responsive design

## Quick start

```bash
# 1. Start the existing GreenLoop backend
cd ..   # root of greenloop repo
npm start

# 2. In another terminal, start the React CRM
cd crm-react
npm install
npm run dev
```

Open http://localhost:5173  
Login: `admin` / `admin123`

The Vite dev server proxies `/api` and `/socket.io` to the backend on port 3000.

## Build for production

```bash
npm run build
```

Serve the `dist/` folder from the Express server (or replace `public/crm`).

## Project structure

```
src/
  api/          API client
  components/   Layout + shared UI
  pages/        Dashboard, Ledger (map), Maintenance, Companies, Users (scorecards), ...
  store/        Zustand auth
  i18n.ts       English + Arabic translations
```

## Backend extensions

See `server/migrations/002_companies_maintenance.sql` and `crm-react/BACKEND_EXTENSIONS.md` for the new companies + vehicle_maintenance tables and suggested API routes.

Built for Majari day-to-day fleet & logistics operations in the UAE.
