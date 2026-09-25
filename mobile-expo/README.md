# GreenLoop Driver — Native App (Expo / React Native)

Native iOS/Android version of the driver app. Identical flow and API contract to the PWA (`/driver`), so the backend needs no changes — run whichever client suits deployment.

## Run it

```bash
cd mobile-expo
npm install
npx expo start
```

Scan the QR code with the **Expo Go** app on any phone.

**Before first run:** edit `src/config.js` and set `API_BASE` to your server's LAN IP
(e.g. `http://192.168.1.50:3000/api/v1`) — phones can't reach `localhost`.

## What it does
- 4-digit PIN pad login (zero text inputs anywhere)
- Today's route, geographically pre-sorted, color-coded status cards
- TAKE PICKUP PHOTO → native camera → silent GPS + ISO timestamp → multipart upload
- NO PICKUP TODAY → Bin Empty / Access Blocked / Manager Said No
- Offline queue in AsyncStorage with 60-second auto-retry; duplicate submits deduped server-side

## Ship to stores
```bash
npm install -g eas-cli
eas build -p android   # .aab for Play Store (or --profile preview for .apk)
eas build -p ios       # requires Apple Developer account
```
Camera and location permission strings are already configured in `app.json`.
