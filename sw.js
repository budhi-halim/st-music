/* RETIRED. No page in this version registers this file.
   Kept at the old URL so existing installations can update and retire safely.
   No fetch interception, no cache creation, no port/host/server changes. */
'use strict';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('sweet-times-music-shell-')).map(key => caches.delete(key)));
    await self.registration.unregister();
    // Deliberately do not reload open clients or interrupt their audio.
  })());
});
