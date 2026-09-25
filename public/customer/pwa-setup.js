// First-time Home Screen card + free Web Push for Customer portal
(function () {
  const API = '/api/v1';
  const LS_CARD = 'gl_cust_install_card_done';
  const LS_PUSH = 'gl_cust_push_done';

  function token() {
    return sessionStorage.getItem('gl_cust_token');
  }

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function showCard() {
    if (localStorage.getItem(LS_CARD) || isStandalone()) {
      if (isStandalone() && token() && !localStorage.getItem(LS_PUSH)) setupPush();
      return;
    }
    if (!token()) return;
    if (document.getElementById('gl-install-card')) return;

    const card = document.createElement('div');
    card.id = 'gl-install-card';
    card.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:flex;align-items:flex-end;justify-content:center;padding:16px">
        <div style="background:#16202a;border:1px solid #263847;border-radius:16px;padding:18px;max-width:400px;width:100%;color:#e8eef2;font-family:system-ui,sans-serif">
          <div style="font-weight:700;font-size:17px;margin-bottom:8px">Add Store Portal to Home Screen</div>
          <p style="font-size:13px;color:#8aa0b0;margin:0 0 12px;line-height:1.45">
            Install once to get <strong style="color:#e8eef2">free alerts</strong> when the driver is on the way,
            arrives, or completes pickup — no App Store, no SMS fees.
          </p>
          <div id="gl-install-steps" style="font-size:12px;color:#8aa0b0;margin-bottom:14px;line-height:1.5"></div>
          <button type="button" id="gl-enable-push" style="width:100%;padding:12px;border:0;border-radius:10px;background:#0f766e;color:#fff;font-weight:700;margin-bottom:8px">
            Enable notifications
          </button>
          <button type="button" id="gl-install-dismiss" style="width:100%;padding:10px;border:0;border-radius:10px;background:transparent;color:#8aa0b0;font-size:13px">
            Not now
          </button>
        </div>
      </div>`;
    document.body.appendChild(card);

    const steps = card.querySelector('#gl-install-steps');
    if (isIos()) {
      steps.innerHTML =
        'iPhone: Safari → Share → <b>Add to Home Screen</b> → open the new icon → Enable notifications.';
    } else {
      steps.innerHTML =
        'Android: menu → <b>Add to Home Screen</b> → open the icon → Enable notifications.';
    }

    card.querySelector('#gl-install-dismiss').onclick = () => {
      localStorage.setItem(LS_CARD, '1');
      card.remove();
    };
    card.querySelector('#gl-enable-push').onclick = async () => {
      const ok = await setupPush();
      localStorage.setItem(LS_CARD, '1');
      if (ok) localStorage.setItem(LS_PUSH, '1');
      card.remove();
      alert(ok ? 'Notifications enabled.' : 'Could not enable notifications. Check permissions.');
    };
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function setupPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const t = token();
    if (!t) return false;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
      const keyRes = await fetch(API + '/push/vapid-public-key');
      const { publicKey } = await keyRes.json();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      await fetch(API + '/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + t,
        },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      return true;
    } catch (e) {
      console.warn('push setup', e);
      return false;
    }
  }

  const prevBoot = window.boot;
  // Hook after customer login via polling token
  setInterval(() => {
    if (token() && !document.getElementById('gl-install-card') && !localStorage.getItem(LS_CARD)) {
      showCard();
    }
  }, 2500);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(showCard, 1500));
  } else setTimeout(showCard, 1500);
})();
