import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
const data=createRequire(import.meta.url)('../ueda-centers.js'),html=fs.readFileSync('index.html','utf8');
assert.equal(data.centers.length,10);
assert.deepEqual(data.centers.map(x=>x.phone),['0268-29-2266','0268-26-7788','0268-71-5712','0268-22-2360','0268-27-2881','0268-37-1537','0268-26-1172','0268-42-0015','0268-72-8055','0268-41-4055']);
assert.deepEqual(data.centers.filter(x=>x.hours===null).map(x=>x.name),['丸子','真田','武石']);
assert.equal(data.centers[1].address,'上田市中央1-3-3 上田病院複合施設1階');
assert.equal(data.centers[4].hours,'月〜金 8:30〜18:00／土 8:30〜12:30');
assert.equal(data.centers[5].hours,'月〜金 8:40〜17:30');
assert.match(data.centers[3].area,/泉田地区（半過・下之条・川辺町）/);assert.match(data.centers[6].area,/半過・下之条・川辺町以外/);
assert.match(data.centers[7].area,/東内・西内・腰越以外/);assert.match(data.centers[9].area,/丸子地域（東内・西内・腰越）/);
const dom=new JSDOM(html,{runScripts:'outside-only'}),c=dom.getInternalVMContext();
Object.assign(c,{MainicoUedaCenters:data,SOUDAN_SAKI:{houkatsu:{url:data.source}},sdEl:(tag,cl,text)=>{const el=c.document.createElement(tag);el.className=cl;el.textContent=text||'';return el;},sdTel:(phone,text,note)=>{const el=c.document.createElement('a');el.href='tel:'+phone;el.textContent=text+note;return el;},sdLink:(url,text)=>{const el=c.document.createElement('a');el.href=url;el.textContent=text;return el;}});
vm.runInContext(html.slice(html.indexOf('const UEDA_CENTERS='),html.indexOf('/* ===== 起動 ===== */')),c);
const view=c.uedaCenterPicker(),select=view.querySelector('select');assert.equal(select.options.length,11);
for(let i=0;i<10;i++){select.value=String(i);select.dispatchEvent(new dom.window.Event('change'));assert.ok(view.textContent.includes(data.centers[i].address));assert.ok(view.textContent.includes(data.centers[i].hours||'電話でご確認ください'));assert.ok(view.querySelector('[href="tel:'+data.centers[i].phone+'"]'));}
vm.runInContext(html.slice(html.indexOf('function randWatchTagId(){'),html.indexOf('function watchTagQr(')),c);
const tag=c.randWatchTagId();assert.match(tag,/^[A-Za-z0-9_-]{32}$/);
// Use a separate VM with a public URL; no medical/person information is allowed in payload.
const qr={URL,location:{href:'https://example.invalid/hidamari/?person=private#private'}};vm.createContext(qr);vm.runInContext(html.slice(html.indexOf('function watchTagUrl('),html.indexOf('function watchTagQr(')),qr);
assert.equal(qr.watchTagUrl(tag),'https://example.invalid/hidamari/tag.html?id='+tag);
dom.window.close();console.log('ueda/tag: 10 centers, exact numbers/boundaries, unknown hours, all detail/phone displays and QR payload passed');
