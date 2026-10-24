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
d.querySelector('#query').value='ごみ';d.querySelector('#search-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
assert.ok([...d.querySelectorAll('.service h3')].some(h=>h.textContent==='上田市のごみ収集カレンダー'));
assert.ok([...d.querySelectorAll('.service h3')].some(h=>h.textContent==='ご用聞きサービス'));
d.querySelector('[data-category="home"]').click();await tick();
assert.equal(d.querySelector('.service h3').textContent,'上田市のごみ収集カレンダー');
assert.equal(d.querySelector('.service a').href,'https://www.city.ueda.nagano.jp/soshiki/haiki/53555.html');
assert.match(d.querySelector('.service').textContent,/同じ自治会でも/);
const guide=d.getElementById('waste-guide'),area=d.getElementById('waste-area'),calendar=d.getElementById('waste-calendar');
assert.equal(guide.hidden,false);assert.equal(calendar.hidden,true);assert.equal(calendar.hasAttribute('href'),false);
assert.equal(area.options.length,17,'placeholder and all 16 official district PDFs, including Maruko');
const NativeDate=w.Date;w.Date=class extends NativeDate{getFullYear(){return 2026;}};
for(const option of [...area.options].slice(1)){
 area.value=option.value;area.dispatchEvent(new w.Event('change'));
 assert.equal(calendar.hidden,false);assert.equal(calendar.href,option.value);
 assert.match(calendar.textContent,/2026年・PDF/);assert.equal(calendar.rel,'noopener noreferrer');
}
area.value='';area.dispatchEvent(new w.Event('change'));assert.equal(calendar.hasAttribute('href'),false);
area.selectedIndex=1;area.dispatchEvent(new w.Event('change'));
w.Date=class extends NativeDate{getFullYear(){return 2027;}};w.dispatchEvent(new w.Event('pageshow'));
assert.equal(area.disabled,true);assert.equal(calendar.hidden,true);assert.equal(calendar.hasAttribute('href'),false);
assert.match(d.getElementById('waste-year-note').textContent,/最新年度/);
w.Date=NativeDate;

d.querySelector('#query').value='<img src=x onerror=alert(1)>';d.querySelector('#search-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
assert.equal(d.querySelectorAll('.service').length,0);assert.equal(guide.hidden,true);assert.equal(d.querySelector('#results-section img'),null);
d.querySelector('[data-category="food"]').click();await tick();
assert.equal(d.querySelector('.service a[href^="tel:"]').getAttribute('href'),'tel:0268235131');
for(const a of d.querySelectorAll('.service a[href^="https:"]'))assert.equal(a.rel,'noopener noreferrer');
d.querySelector('#all-categories').click();await tick();assert.equal(d.querySelector('#results-section').hidden,true);
for(const s of w.UEDA_SERVICES){assert.equal(new URL(s.url).protocol,'https:');if(s.phone)assert.match(s.phone,/^\d[\d-]+$/);}
assert.equal(new Set(w.UEDA_SERVICES.map(s=>s.name)).size,w.UEDA_SERVICES.length);
assert.equal(d.querySelectorAll('script[src*="firebase"]').length,0);
console.log('上田サポート：6分類・検索・該当なし・安全な文字表示・電話・外部リンク・戻る操作 passed');w.close();
// 同じ上田の公開情報の検査として、既存CIから「今日の上田」も実行する。
await import('./ueda-today.test.mjs');
