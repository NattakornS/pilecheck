/* Service Worker: ตรวจระยะจมเข็ม
 * - ไฟล์แอป: ดึงจากเน็ตก่อน (ได้เวอร์ชันล่าสุด) ถ้าออฟไลน์ใช้ที่เก็บไว้
 * - Leaflet / ฟอนต์: เก็บไว้ใช้ซ้ำ
 * - ภาพแผนที่: เก็บเฉพาะที่เคยเปิดดู จำกัดจำนวน
 * - การเรียก Google Apps Script ไม่ผ่านแคช
 * เปลี่ยน VERSION ทุกครั้งที่แก้ไฟล์แอป
 */
const VERSION = 'pilecheck-v1.1.0';
const TILES = 'pilecheck-tiles';
const MAX_TILES = 400;

const SHELL = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await c.addAll(SHELL);
    await Promise.all(CDN.map((u) => c.add(u).catch(() => null)));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Apps Script API: ไม่แคช
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(url.hostname) || url.hostname.endsWith('googleusercontent.com')) return;

  // ไฟล์ของแอปเอง: เน็ตก่อน แล้วค่อยใช้แคช
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw err;
      }
    })());
    return;
  }

  // ภาพแผนที่ OpenStreetMap: ใช้แคชก่อน
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch (err) { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // CDN / ฟอนต์: ใช้แคชก่อน
  if (url.hostname === 'cdnjs.cloudflare.com' || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') (await caches.open(VERSION)).put(req, res.clone());
        return res;
      } catch (err) { return new Response('', { status: 504 }); }
    })());
  }
});
