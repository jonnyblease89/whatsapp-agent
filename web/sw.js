self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'CH Autoworks', {
      body:  data.body || '',
      icon:  '/whatsapp-agent/inbox/icon-192.png',
      badge: '/whatsapp-agent/inbox/icon-192.png',
      vibrate: [200, 100, 200],
      tag:  'ch-autoworks',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow('/whatsapp-agent/inbox/');
    })
  );
});
