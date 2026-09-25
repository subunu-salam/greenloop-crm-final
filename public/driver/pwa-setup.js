// First-time Home Screen card + free Web Push for Driver
(function () {
  const API = '/api/v1';
  const LS_CARD = 'gl_drv_install_card_done';
  const LS_PUSH = 'gl_drv_push_done';

  function token() {
    return localStorage.getItem('gl_drv_token');
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
    if (localStorage.getItem(LS_CARD) || isStandalone()) return;
    if (document.getElementById('gl-install-card')) return;

    const card = document.createElement('div');
    card.id = 'gl-install-card';
    card.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:flex;align-items:flex-end;justify-content:center;padding:16px">
        <div style="background:#16202a;border:1px solid #263847;border-radius:16px;padding:18px;max-width:400px;width:100%;color:#e8eef2;font-family:system-ui,sans-serif">
          <div style="font-weight:700;font-size:17px;margin-bottom:8px">Add Driver to Home Screen</div>
          <p style="font-size:13px;color:#8aa0b0;margin:0 0 12px;line-height:1.45">
            Install once for faster access and <strong style="color:#e8eef2">free push alerts</strong>
            (route updates, office messages). No App Store download.
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
        'iPhone: Safari → Share button → <b>Add to Home Screen</b> → open the icon → then tap Enable notifications.';
    } else {
      steps.innerHTML =
        'Android/Chrome: browser menu → <b>Add to Home Screen</b> / Install app → open the icon → Enable notifications.';
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
      if (ok) alert('Notifications enabled. Keep the Home Screen icon for best results.');
      else alert('Could not enable notifications. Check browser permission settings.');
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

  function bootUi() {
    // Show after login
    const tryShow = () => {
      if (token()) {
        setTimeout(showCard, 1200);
        if (!localStorage.getItem(LS_PUSH) && isStandalone()) {
          setupPush().then((ok) => {
            if (ok) localStorage.setItem(LS_PUSH, '1');
          });
        }
      }
    };
    tryShow();
    const prev = window.enterApp;
    if (typeof prev === 'function') {
      window.enterApp = async function () {
        await prev.apply(this, arguments);
        setTimeout(showCard, 800);
      };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUi);
  else bootUi();
})();
