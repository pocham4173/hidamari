import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../ueda-support.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://example.test/ueda-support.html',runScripts:'outside-only'});
const {window:w}=dom,d=w.document;
w.HTMLElement.prototype.scrollIntoView=function(){};
for(const file of ['ueda-services.js','ueda-support.js'])w.eval(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'));
assert.equal(d.querySelector('#results-section').hidden,true);
const tick=()=>new Promise(resolve=>w.setTimeout(resolve,20));
for(const a of d.querySelectorAll('[data-category]')){
 a.click();await tick();
 assert.equal(d.querySelector('#results-section').hidden,false);
 assert.ok(d.querySelectorAll('.service').length>0);
 assert.equal(d.activeElement.id,'results-title');
}
d.querySelector('#query').value='草取り';d.querySelector('#search-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
assert.equal(d.querySelectorAll('.service').length,1);
assert.match(d.querySelector('.service h3').textContent,/シルバー/);
d.querySelector('#query').value='<img src=x onerror=alert(1)>';d.querySelector('#search-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
assert.equal(d.querySelectorAll('.service').length,0);assert.equal(d.querySelector('#results-section img'),null);
d.querySelector('[data-category="food"]').click();await tick();
assert.equal(d.querySelector('.service a[href^="tel:"]').getAttribute('href'),'tel:0268235131');
for(const a of d.querySelectorAll('.service a[href^="https:"]'))assert.equal(a.rel,'noopener noreferrer');
d.querySelector('#all-categories').click();await tick();assert.equal(d.querySelector('#results-section').hidden,true);
for(const s of w.UEDA_SERVICES){assert.equal(new URL(s.url).protocol,'https:');if(s.phone)assert.match(s.phone,/^\d[\d-]+$/);}
assert.equal(new Set(w.UEDA_SERVICES.map(s=>s.name)).size,w.UEDA_SERVICES.length);
assert.equal(d.querySelectorAll('script[src*="firebase"]').length,0);
console.log('上田サポート：6分類・検索・該当なし・安全な文字表示・電話・外部リンク・戻る操作 passed');w.close();
