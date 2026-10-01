/* まいにこ Service Worker (2026-09-29 オフライン対応)
   - 通信できるときは常に最新を取りに行き、取れたものを端末に控えておく(ネット優先)。
   - 電波がないときは控えを使う。アプリの画面が開けないときは offline.html(もしもの控え)を出す。
   - 共有記録(Firestore)の通信は控えない。控えるのは画面の部品だけ。 */
const CACHE = 'mainico-shell-v2';  /* 2026-10-01 作り直し */
const SHELL = [
  './', 'index.html', 'offline.html', 'help.html', 'privacy.html', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'ueda-centers.js', 'mainico-config.js', 'consent.js', 'consent-ui.js', 'account-recovery.js',
  'account-deletion.js', 'household-deletion.js', 'household-ui.js', 'medicine-notebook.js',
  'medicine-notebook.css', 'notebook-integration.js', 'person-speech.js', 'person-button-feedback.js',
  'family-connection.js', 'person-tasks.js', 'line-notify.js', 'hitokoe.js'
];
/* 他のサイトから読む部品のうち、控えてよいもの(Firebaseの部品とフォント) */
const CROSS_OK = [/^https:\/\/www\.gstatic\.com\/firebasejs\//, /^https:\/\/fonts\.(googleapis|gstatic)\.com\//];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){
    /* 1つ取れなくても全体を失敗にしない */
    return Promise.all(SHELL.map(function(u){ return c.add(new Request(u, {cache:'reload'})).catch(function(){}); }));
  }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf('mainico-shell-')===0 && k!==CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return clients.claim(); }));
});

function cacheable(req){
  if(req.method!=='GET') return false;
  const url=req.url;
  if(url.indexOf(self.location.origin)===0) return true;
  return CROSS_OK.some(function(r){ return r.test(url); });
}
function isAppPage(req){
  if(req.mode!=='navigate') return false;
  const p=new URL(req.url).pathname;
  return /\/$/.test(p) || /\/index\.html$/.test(p);
}

self.addEventListener('fetch', function(e){
  const req=e.request;
  if(!cacheable(req)) return;   /* 共有記録などの通信はそのまま */
  /* アプリ本体の画面はブラウザーの一時保存を使わず、毎回通信で確かめる(電波がない時に古い画面が出ないように) */
  const net=isAppPage(req)?fetch(req.url,{cache:'no-store',credentials:'same-origin'}):fetch(req);
  e.respondWith(
    net.then(function(res){
      if(res && (res.ok || res.type==='opaque')){
        const copy=res.clone();
        caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
      }
      return res;
    }).catch(function(){
      /* アプリ本体の画面は、電波がないと共有記録を確かめられないため「もしもの控え」を出す */
      if(isAppPage(req)) return caches.match('offline.html', {ignoreSearch:true});
      return caches.match(req, {ignoreSearch:true}).then(function(hit){
        if(hit) return hit;
        if(req.mode==='navigate') return caches.match('offline.html', {ignoreSearch:true});
        return Response.error();
      });
    })
  );
});
