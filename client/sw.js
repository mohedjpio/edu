// client/sw.js — Service Worker for PWA offline support
const CACHE = 'smartshare-v1';
const ASSETS = ['/', '/index.html', '/styles/main.css',
  '/src/app.js', '/src/network/socket.js',
  '/src/webrtc/connection.js', '/src/webrtc/channels.js',
  '/src/modules/chat.js', '/src/modules/files.js',
  '/src/modules/clipboard.js', '/src/modules/qr.js',
  '/src/ui/layout.js', '/manifest.json'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));

self.addEventListener('activate', e =>
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
