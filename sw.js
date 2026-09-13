/* まいにこ Service Worker: 起動に必要な画面を保持し、FCMの背景通知を受け取ります。 */
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:'AIzaSyA3bGGlSk_btdBP5i0XWg0VidskwviHR3A',
  authDomain:'hidamari-5f8de.firebaseapp.com',
  projectId:'hidamari-5f8de',
  messagingSenderId:'565713968884',
  appId:'1:565713968884:web:0a9665d1fe5e0fa161c8a1'
});
try{ firebase.messaging(); }catch(e){ /* 通知非対応端末でもオフライン起動は維持する */ }

var CACHE='mainico-shell-v66';
var SHELL=['./','./index.html','./manifest.json','./mainico-config.js','./icon-192.png','./icon-512.png'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(cache){return cache.addAll(SHELL);}).catch(function(){}).then(function(){return self.skipWaiting();}));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return clients.claim();}));
});
self.addEventListener('fetch', function(e){
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
  e.respondWith(
    fetch(e.request).then(function(response){
      var copy=response.clone();caches.open(CACHE).then(function(cache){cache.put(e.request,copy);});return response;
    }).catch(function(){ return caches.match(e.request).then(function(hit){return hit||caches.match('./index.html');}); })
  );
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){if('focus' in list[i])return list[i].focus();}
    return clients.openWindow('./index.html');
  }));
});
