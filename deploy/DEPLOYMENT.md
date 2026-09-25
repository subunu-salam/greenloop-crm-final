# GreenLoop — Production Deployment Guide

Go from zero to a live, HTTPS-secured system in about 30 minutes. No DevOps experience needed.

## What you need
1. **A cloud server** — any provider (DigitalOcean, Hetzner, AWS Lightsail, local UAE providers). Smallest tier is fine: 1–2 vCPU, 2 GB RAM, Ubuntu 22.04+. Cost: roughly AED 25–50/month.
2. **A domain or subdomain** — e.g. `ops.yourcompany.ae`.
3. This project folder.

## Step 1 — Point your domain at the server
In your domain provider's DNS panel, create an **A record** for your chosen name (e.g. `ops`) pointing to the server's public IP. Wait a few minutes for it to propagate.

## Step 2 — Install Docker on the server
SSH in, then:
```bash
curl -fsSL https://get.docker.com | sh
```

## Step 3 — Upload the project
From your computer:
```bash
scp -r waste-management-system root@YOUR_SERVER_IP:/opt/greenloop
```
(or use any SFTP tool such as FileZilla)

## Step 4 — Configure
On the server:
```bash
cd /opt/greenloop/deploy
cp .env.example .env
nano .env        # set DOMAIN=ops.yourcompany.ae and paste a random JWT_SECRET
```
Generate a strong secret with `openssl rand -hex 48`.

## Step 5 — Launch
```bash
docker compose -f docker-compose.prod.yml up -d
```
Caddy obtains a free HTTPS certificate automatically — no certificate setup required. After a minute:

- CRM: `https://ops.yourcompany.ae/crm`
- Driver app: `https://ops.yourcompany.ae/driver`

## Step 6 — Secure the accounts (IMPORTANT)
1. Log into the CRM with `admin / admin123`.
2. Go to **Users** → edit the admin → **set a strong new password immediately**.
3. Create your real drivers with their own PINs; disable the demo drivers.

## Step 7 — Load your real clients
1. Fill in `GreenLoop_Client_Import_Template.xlsx` (one row per store; instructions inside).
2. Save it as CSV, then in the CRM: **Customers → Import CSV**.
3. **Vehicles** → set your trucks' real zones and plates.
4. **Daily Route Ledger → Generate month schedule** (use *force* to replace the demo schedule, or wait for the 1st — it runs automatically).

## Step 8 — Put the app on drivers' phones
Open `https://ops.yourcompany.ae/driver` in the phone browser → menu → **Add to Home Screen**. It installs like a normal app, works offline, and uses the phone's real camera and GPS. (The native Expo app in `mobile-expo/` is the app-store alternative.)

## Day-2 operations
| Task | Command (in /opt/greenloop/deploy) |
|---|---|
| View logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| Restart | `docker compose -f docker-compose.prod.yml restart` |
| Update code | upload new files, then restart |
| Backup | copy the `appdata` volume: `docker run --rm -v deploy_appdata:/d -v $(pwd):/b alpine cp /d/greenloop.sqlite /b/backup-$(date +%F).sqlite` |

Schedule the backup command in cron (e.g. daily at 02:00) and keep copies off the server.

## Checklist before going live
- [ ] Admin password changed from admin123
- [ ] Demo drivers disabled, real drivers created with unique PINs
- [ ] Real clients imported, zones matching vehicle zones
- [ ] Vehicles updated with real plates/zones/capacity
- [ ] Schedule generated and reviewed in the Ledger
- [ ] Shift cutoff set to your real deadline (Settings API or ask your developer)
- [ ] Daily backup cron in place
- [ ] Test: one driver completes one pickup with photo on their real phone
