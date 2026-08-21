/* ひだまり Service Worker (最小構成)
   PWAとしてホーム画面に追加できるようにするためのファイルです。
   キャッシュは最小限にし、常に最新を取りに行きます。 */
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(clients.claim()); });
self.addEventListener('fetch', function(e){
  e.respondWith(
    fetch(e.request).catch(function(){ return caches.match(e.request); })
  );
});
