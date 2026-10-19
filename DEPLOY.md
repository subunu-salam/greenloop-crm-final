# GreenLoop / Majari — Deploy Guide

## Stack

| Layer | Service |
|-------|--------|
| **Frontend** | Cloudflare Pages (`crm-react/`) |
| **Backend** | Render (recommended) or Vercel |
| **Database** | MongoDB Atlas (free M0 cluster to start) |

---

## Step 1 — MongoDB Atlas

1. Create a free cluster at https://cloud.mongodb.com (region close to the UAE, e.g. Bahrain or Mumbai)
2. **Database Access** → add a database user with a strong password
3. **Network Access** → allow Render's outbound IPs (or `0.0.0.0/0` while testing)
4. **Connect → Drivers** → copy the string and add the database name `greenloop`:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/greenloop?retryWrites=true&w=majority`
5. Atlas is already a replica set, which Prisma needs. Nothing else to configure.

Existing data from the SQLite version? Run once on your computer with `DATABASE_URL` pointing at Atlas:
`npm run db:setup` then `npm run db:migrate-sqlite -- path/to/greenloop.sqlite`

---

## Step 2 — Render (Backend API)

1. https://render.com → **New** → **Web Service** (or Blueprint with `render.yaml`)  
2. Connect GitHub repo **subunu-salam/greenloop**  
3. Settings:
   - Build: `npm install && npm run db:setup`
   - Start: `node server/index.js`
   - Node 22
4. Environment variables:
   - `DATABASE_URL` = Atlas connection string
   - `JWT_SECRET` = long random string
   - `CORS_ORIGIN` = your Cloudflare URL, e.g. `https://greenloop-crm.pages.dev`
5. Deploy → copy the URL, e.g. `https://greenloop-api.onrender.com`

> Photos and receipts are still files: keep the Render disk (`UPLOAD_DIR=/var/data/uploads`) or move them to object storage.

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
cp .env.example .env         # DATABASE_URL → your local MongoDB (docs/MONGODB-SETUP.md)
npm install && npm run db:setup
npm start                    # backend http://localhost:3000
cd crm-react && npm run dev  # frontend http://localhost:5173
```

---

## Why not Vercel for the API?

Socket.IO + file uploads work more reliably on a long-lived Node process (Render). Vercel is fine for the frontend; Cloudflare Pages is already chosen for that.
