const CACHE = 'tache-v1';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});

/* ---------- rappels (notifications push) ---------- */
function idbGet(store, key) {
  return new Promise(resolve => {
    try {
      const r = indexedDB.open('tache', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('meta'); r.result.createObjectStore('blobs'); } catch (e) {} };
      r.onsuccess = () => {
        try {
          const g = r.result.transaction(store, 'readonly').objectStore(store).get(key);
          g.onsuccess = () => resolve(g.result);
          g.onerror = () => resolve(undefined);
        } catch (e) { resolve(undefined); }
      };
      r.onerror = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  });
}
function dueMs(t) {
  const d = t.date.split('-').map(Number), hm = (t.time || '09:00').split(':').map(Number);
  return new Date(d[0], d[1] - 1, d[2], hm[0] || 0, hm[1] || 0).getTime();
}
async function handlePush() {
  const tasks = (await idbGet('meta', 'tasks')) || [];
  const testAt = await idbGet('meta', 'testAt');
  const now = Date.now();
  const due = tasks.filter(t => !t.done && !t.paused && t.date && dueMs(t) <= now).sort((a, b) => dueMs(a) - dueMs(b));
  const base = { icon: 'icon-192.png', badge: 'icon-192.png', lang: 'fr' };
  if (!due.length) {
    if (testAt && now - testAt < 180000) {
      return self.registration.showNotification('Tâche', Object.assign({}, base, { body: 'Test réussi : les rappels fonctionnent ✓', tag: 'tache-test', vibrate: [250, 120, 250] }));
    }
    await self.registration.showNotification('Tâche', Object.assign({}, base, { body: 'Rien à faire pour le moment', tag: 'tache-none', silent: true }));
    const l = await self.registration.getNotifications({ tag: 'tache-none' });
    l.forEach(n => n.close());
    return;
  }
  const show = due.slice(0, 5);
  for (const t of show) {
    const late = new Date(t.date + 'T00:00:00').getTime() < new Date(new Date().toDateString()).getTime();
    await self.registration.showNotification(t.title || 'Tâche', Object.assign({}, base, {
      body: (t.kind === 'rdv' ? 'Rendez-vous' : 'À faire') + (t.time ? ' · ' + t.time : '') + (late ? ' · en retard' : ''),
      tag: 'tache-' + t.id, renotify: true, requireInteraction: true, vibrate: [400, 200, 400, 200, 400], data: { id: t.id }
    }));
  }
  if (due.length > show.length) {
    await self.registration.showNotification('Tâche', Object.assign({}, base, { body: (due.length - show.length) + ' autre(s) tâche(s) à faire', tag: 'tache-plus', renotify: true }));
  }
}
self.addEventListener('push', e => { e.waitUntil(handlePush()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./' + (id ? '?task=' + encodeURIComponent(id) : ''));
  }));
});
