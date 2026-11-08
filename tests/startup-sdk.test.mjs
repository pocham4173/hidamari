import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const base='https://www.gstatic.com/firebasejs/10.14.1/firebase-';
async function check(url,hit,expected,destination='script'){
 let handler,network=0,out,stored=0;
 const response={ok:true,clone(){return this;}},cached={cached:true,ok:true};
 const req={url,method:'GET',mode:'cors',destination};
 const cache={match:async key=>(key.url===url&&hit)?cached:undefined,put:async()=>{stored++}};
 vm.runInNewContext(src,{URL,Response,self:{location:{origin:'https://example.test'},addEventListener(k,f){if(k==='fetch')handler=f;}},
 caches:{open:async()=>cache,match:cache.match},fetch:async()=>{network++;return response;}});
 handler({request:req,respondWith(p){out=p;},waitUntil(){}});
 if(expected==='pass'){assert.equal(out,undefined);assert.equal(network,0);return;}
 assert.equal(await out,expected==='cache'?cached:response);assert.equal(network,expected==='cache'?0:1);
}
for(const part of ['app','auth','firestore','app-check']){
 await check(base+part+'-compat.js',true,'cache');await check(base+part+'-compat.js',false,'net');
}
await check(base+'auth-compat.js?v=other',true,'net');
await check('https://example.test/index.html',true,'net','document');
await check('https://firestore.googleapis.com/example',true,'pass','');
console.log('PASS: four versioned SDK cache hits avoid network, misses fetch, other requests unchanged');
