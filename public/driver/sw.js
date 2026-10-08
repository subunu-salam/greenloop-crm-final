/* GreenLoop Driver — service worker (push notifications) v3.2 */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = { title: 'GreenLoop', body: '', url: '/driver/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try { data.body = event.data.text(); } catch {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'GreenLoop Driver', {
      body: data.body || '',
      icon: '/driver/icons.svg',
      badge: '/driver/icons.svg',
      // one notification per kind of alert would hide earlier ones; time-based tag keeps each
      tag: 'gl-' + (data.ts || Date.now()),
      data: { url: data.url || '/driver/' },
      vibrate: [120, 60, 120],
    })
  );
});

// Tapping the notification opens the app on the right screen (e.g. #invoices).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/driver/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('/driver/') && 'focus' in c) {
          c.postMessage({ type: 'gl-open', url });
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// The browser replaced the subscription → ask an open page to register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: 'gl-push-resync' })))
  );
});
