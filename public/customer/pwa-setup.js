// ─────────────────────────────────────────────────────────────
// GreenLoop Customer — push notifications + Home Screen install (v3.2)
//
// Fixes over v3.1:
//  • the device is (re)registered on EVERY sign-in and site switch, so pushes always
//    go to whoever is signed in on this phone now;
//  • signing out removes this device from the server;
//  • no longer limited to "installed" mode — any browser that supports Web Push works
//    (iPhone still needs Add to Home Screen first: Apple's rule);
//  • nothing is remembered as "done" in localStorage, so a failed first attempt retries.
// Exposes window.GLPush = { state(), enable(), sync(), signOut(), test() }.
// ─────────────────────────────────────────────────────────────
(function () {
  const API = '/api/v1';
  const TOKEN_KEY = 'gl_cust_token';
  const LS_CARD = 'gl_cust_push_card_v2';   // "not now" on the first-time card
  const APP_NAME = 'GreenLoop';
  const WHY = 'Get an alert when your driver is on the way, when a visit is completed, and when a new invoice is ready — free, no SMS.';

  const token = () => localStorage.getItem(TOKEN_KEY);
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); else if (typeof window.glToast === 'function') window.glToast(msg); };
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // 'granted' | 'default' | 'denied' | 'ios-install' | 'unsupported'
  function state() {
    if (!supported()) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
    return Notification.permission;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  const sameKey = (sub, key) => {
    try {
      const cur = new Uint8Array(sub.options.applicationServerKey);
      return cur.length === key.length && cur.every((b, i) => b === key[i]);
    } catch { return true; }
  };

  let lastSynced = null; // token the current subscription was registered with
  // Registers this device for the signed-in user. Safe to call any time; only does
  // work when permission is already granted (never prompts by itself).
  async function sync(force) {
    const t = token();
    if (!t || !supported() || Notification.permission !== 'granted') return false;
    if (!force && lastSynced === t) return true;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      const { publicKey } = await (await fetch(API + '/push/vapid-public-key')).json();
      const key = urlBase64ToUint8Array(publicKey);
      let sub = await reg.pushManager.getSubscription();
      // server keys were rotated → the old subscription can never be delivered to
      if (sub && !sameKey(sub, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const res = await fetch(API + '/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error('subscribe ' + res.status);
      lastSynced = t;
      return true;
    } catch (e) {
      console.warn('push sync', e);
      return false;
    }
  }

  // Must be called from a tap (browsers only show the permission prompt on a user gesture).
  async function enable() {
    const st = state();
    if (st === 'ios-install') { say('On iPhone: tap Share → Add to Home Screen, open the new icon, then enable notifications.'); return false; }
    if (st === 'unsupported') { say('This browser does not support notifications. Use Chrome, Edge, Firefox or Safari.'); return false; }
    if (st === 'denied') { say('Notifications are blocked for this site. Allow them in the browser / phone settings, then try again.'); return false; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { say('Notifications were not allowed.'); return false; }
    const ok = await sync(true);
    say(ok ? 'Notifications are on for this device.' : 'Could not finish setting up notifications — check your connection and try again.');
    return ok;
  }

  // Called by the app before it clears the token.
  async function signOut() {
    const t = token();
    lastSynced = null;
    try {
      if (!t || !supported()) return;
      const reg = await navigator.serviceWorker.getRegistration('./');
      const sub = reg && (await reg.pushManager.getSubscription());
      if (!sub) return;
      await fetch(API + '/push/unsubscribe', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
    } catch { /* offline — the server drops dead endpoints on its own */ }
  }

  async function test() {
    const t = token(); if (!t) return false;
    if (!(await sync(true))) { say('Turn notifications on first.'); return false; }
    try {
      const r = await (await fetch(API + '/push/test', { method: 'POST', headers: { Authorization: 'Bearer ' + t } })).json();
      say(r.ok ? 'Test sent — it should appear in a moment.' : 'The test could not be delivered to this device.');
      return !!r.ok;
    } catch { say('Could not send the test — check your connection.'); return false; }
  }

  // ── first-time card (glass, bottom sheet) ──
  function showCard() {
    if (!token() || document.getElementById('gl-install-card')) return;
    if (localStorage.getItem(LS_CARD)) return;
    const st = state();
    if (st === 'granted' || st === 'denied' || st === 'unsupported') return;
    const card = document.createElement('div');
    card.id = 'gl-install-card';
    card.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(2,12,10,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:100;display:flex;align-items:flex-end;justify-content:center;padding:16px">
        <div role="dialog" aria-modal="true" aria-label="Turn on notifications" style="background:rgba(8,40,35,.86);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);box-shadow:0 20px 60px -14px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.1);border-radius:22px;padding:20px;max-width:420px;width:100%;color:#f1faf7;font-family:inherit">
          <div style="font-weight:800;font-size:18px;margin-bottom:8px">Turn on notifications</div>
          <p style="font-size:14px;color:#9dbdb4;margin:0 0 12px;line-height:1.5">${WHY}</p>
          <div id="gl-install-steps" style="font-size:13px;color:#9dbdb4;margin-bottom:14px;line-height:1.5"></div>
          <button type="button" id="gl-enable-push" style="width:100%;padding:14px;border:0;border-radius:14px;background:linear-gradient(135deg,#2dd4bf,#0d9488);color:#032620;font-weight:800;font-size:15px;margin-bottom:8px;cursor:pointer">Enable notifications</button>
          <button type="button" id="gl-install-dismiss" style="width:100%;padding:11px;border:0;border-radius:12px;background:transparent;color:#9dbdb4;font-size:14px;cursor:pointer">Not now</button>
        </div>
      </div>`;
    document.body.appendChild(card);
    const steps = card.querySelector('#gl-install-steps');
    const btn = card.querySelector('#gl-enable-push');
    if (st === 'ios-install') {
      steps.innerHTML = '<b style="color:#f1faf7">iPhone / iPad:</b> tap the Share button in Safari → <b style="color:#f1faf7">Add to Home Screen</b> → open ' + APP_NAME + ' from the new icon → Enable notifications.';
      btn.textContent = 'OK, I will add it';
    } else if (!isStandalone()) {
      steps.innerHTML = 'Tip: add ' + APP_NAME + ' to your Home Screen (browser menu → <b style="color:#f1faf7">Add to Home Screen / Install app</b>) for the most reliable alerts.';
    }
    card.querySelector('#gl-install-dismiss').onclick = () => { localStorage.setItem(LS_CARD, '1'); card.remove(); };
    btn.onclick = async () => {
      if (st === 'ios-install') { card.remove(); return; }   // asked again next time, once installed
      btn.disabled = true;
      await enable();
      localStorage.setItem(LS_CARD, '1');
      card.remove();
      document.dispatchEvent(new CustomEvent('glpush:change'));
    };
  }

  // Follow sign-in / sign-out / site switch by watching the token.
  let seen = null;
  function tick() {
    const t = token();
    if (t === seen) return;
    seen = t;
    if (!t) { lastSynced = null; const c = document.getElementById('gl-install-card'); if (c) c.remove(); return; }
    sync(true);
    setTimeout(showCard, 1500);
  }
  setInterval(tick, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick); else tick();
  // the service worker asks for a re-sync when the browser replaces the subscription
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'gl-push-resync') sync(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

  window.GLPush = { state, enable, sync, signOut, test, showCard: () => { localStorage.removeItem(LS_CARD); showCard(); } };
})();
