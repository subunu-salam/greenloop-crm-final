# GreenLoop / Majari — Deploy Guide

## Stack

| Layer | Service |
|-------|--------|
| **Frontend** | Cloudflare Pages (`crm-react/`) |
| **Backend** | Render (recommended) or Vercel |
| **Database** | Neon PostgreSQL |

---

## Step 1 — Neon

1. Create a project at https://neon.tech  
2. Copy the connection string (`postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`)  
3. Optional: run SQL from `deploy/schema.postgres.sql` and `server/migrations/002_companies_maintenance.pg.sql` in the Neon SQL editor  

---

## Step 2 — Render (Backend API)

1. https://render.com → **New** → **Web Service** (or Blueprint with `render.yaml`)  
2. Connect GitHub repo **subunu-salam/greenloop**  
3. Settings:
   - Build: `npm install`
   - Start: `node server/index.js`
   - Node 22
4. Environment variables:
   - `DATABASE_URL` = Neon connection string
   - `JWT_SECRET` = long random string
   - `CORS_ORIGIN` = your Cloudflare URL, e.g. `https://greenloop-crm.pages.dev`
5. Deploy → copy the URL, e.g. `https://greenloop-api.onrender.com`

> **Note:** Local SQLite path is fully working today. Neon schema + driver are ready; some API routes still use the sync SQLite helper. After first deploy with Neon, if any route errors, we finish the async migration of `server/api.js` next.

---

## Step 3 — Cloudflare Pages (Frontend)

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → Connect Git  
2. Repo: **subunu-salam/greenloop**  
3. Build config:
   - **Root directory:** `crm-react`
   - **Build command:** `npm install && npm run build`
   - **Output directory:** `dist`
4. Environment variable:
   - `VITE_API_URL` = `https://greenloop-api.onrender.com`  (no trailing slash)
5. Deploy

Open the Pages URL → **admin / admin123**

---

## Local

```bash
npm start                    # backend SQLite
cd crm-react && npm run dev  # frontend http://localhost:5173
```

With Neon locally:
```bash
export DATABASE_URL="postgresql://...@ep-xxx.neon.tech/neondb?sslmode=require"
npm start
```

---

## Why not Vercel for the API?

Socket.IO + file uploads work more reliably on a long-lived Node process (Render). Vercel is fine for the frontend; Cloudflare Pages is already chosen for that.
