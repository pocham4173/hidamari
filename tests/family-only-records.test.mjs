import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('var recY = 0'),html.indexOf('const AISATSU_BACK_WORDS='));
const dom=new JSDOM(html,{runScripts:'outside-only'}),w=dom.window;
let only=true,printed='',source=[],pending=[];
const day='2026-09-17';
const person=['aisatsu','kibun','kusuri','onegai','family-message-back','aisatsu-back','ask-kusuri','family-message','onegai-back'];
const family=['kibun-kazoku','kusuri-kakunin','care-log','memo','tag-alert','disaster-safe'];
const shared=['family-note','family-note-reply','family-task','family-task-help','family-task-done'];
const events=[...person,...family,...shared].map((type,i)=>({type,_id:'e'+i,uid:'author',name:'家族A',text:type==='memo'?'<img src=x onerror=alert(1)>':`内容${i}`,date:day,slot:'asa',at:{seconds:1789628400+i}}));
const original=JSON.stringify(events);
const snap=rows=>({forEach(fn){rows.forEach(v=>fn({id:v._id,data:()=>({...v})}));}});
Object.assign(w,{
 isKOnly:()=>only,uid:()=> 'viewer',todayStr:()=>day,dateJp:d=>`${d.getMonth()+1}月${d.getDate()}日`,
 esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 kusuriSlotName:()=> '朝',kusuriQuestion:()=> '朝のお薬は飲みましたか',yoteiCache:[],
 openPrintWindow:(title,text)=>printed=text,
 col:()=>({filters:[],where(...args){this.filters.push(args);return this;},get(options){assert.equal(options.source,'server');source.push(this.filters);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}})
});
assert.equal(w.document.querySelector('script[src*="qrcode-generator"]').hasAttribute('async'),true);
assert.equal(w.document.querySelector('link[href*="fonts.googleapis"]').media,'print');
vm.runInContext(code,dom.getInternalVMContext());
const tick=()=>new Promise(r=>setImmediate(r));
function render(){w.recEvents=events;w.recPrevEvents=events;w.recPrevReady=true;w.recY=2026;w.recM=8;w.recSel=day;w.recDrawDay();w.recDrawSummary();w.recDrawCal();w.recRenderArchive();}
render();
const text=id=>w.document.getElementById(id).textContent;
assert.equal(w.recCountByDay()[day],6);
assert.match(text('rec-sum'),/生活の記録 6件/);
assert.match(text('rec-sum'),/共有は別に5件/);
assert.match(text('rec-sum'),/やることの引受け/);
assert.match(text('rec-sum'),/6件 → 6件/);
for(const id of ['rec-day','rec-sum']){
 assert.doesNotMatch(text(id),/本人の服薬|ご本人が|メッセージと返事|ちょっとお願い|本人からの返事|本人と家族のやり取り|本人0件/);
 assert.match(text(id),/家族の服薬確認/);
 assert.equal(w.document.getElementById(id).querySelector('img'),null,'untrusted text is never HTML');
}
assert.match(text('rec-person-archive-list'),/本人の服薬：ご本人が/);
assert.match(text('rec-person-archive-list'),/2026-09-17/);
assert.equal(w.document.getElementById('rec-person-archive').hidden,false);
assert.equal(w.document.getElementById('rec-person-archive').open,false);
assert.equal(w.document.querySelectorAll('#rec-person-archive-list .range-row').length,9);
assert.equal(JSON.stringify(events),original,'no original record is rewritten');
for(const period of [1,6,12]){
 w.rgLoad(period);pending.shift().resolve(snap(events));await tick();
 assert.doesNotMatch(text('rg-body'),/挨拶|メッセージと返事|ちょっとお願い|ご本人が/);
 assert.match(text('rg-body'),/家族の服薬確認/);
 assert.match(text('rg-body'),/家族が記録した体調/);
}
w.document.getElementById('rec-range-from').value='2026-09-01';w.document.getElementById('rec-range-to').value=day;
w.recLoadRange();assert.deepEqual(source.at(-1),[['date','>=','2026-09-01'],['date','<=',day]]);
pending.shift().resolve(snap(events));await tick();
assert.equal(w.document.querySelectorAll('#rec-range-results .range-row').length,6);
w.printRecords();assert.doesNotMatch(printed,/本人の服薬|ご本人が|メッセージ|お願い/);assert.match(printed,/家族の服薬確認/);
// Switching modes restores the unchanged originals to the ordinary view.
only=false;render();assert.equal(w.recCountByDay()[day],15);assert.match(text('rec-day'),/本人の服薬/);assert.match(text('rec-sum'),/生活の記録 15件/);assert.equal(w.document.getElementById('rec-person-archive').hidden,true);
only=true;w.recEvents=events.filter(v=>family.includes(v.type));w.recRenderArchive();assert.equal(w.document.getElementById('rec-person-archive').hidden,true,'no empty archive');
// The production stop helper invalidates every outstanding report request.
w.recLoadRange();w.rgLoad(1);w.recLoad();
assert.equal(pending.length,4);
w.resetRecordViews();for(const p of pending.splice(0))p.resolve(snap(events));await tick();
for(const id of ['rec-day','rec-sum','rg-body','rec-range-results','rec-person-archive-list'])assert.equal(text(id),'',id+' ignores old responses');
assert.equal(w.document.getElementById('rec-person-archive').hidden,true);
assert.match(fs.readFileSync(new URL('../household-ui.js',import.meta.url),'utf8'),/function stopHouseholdSubscriptions\(\)\{[^]*?resetRecordViews\(\)/);
console.log('✅ 家族だけの日別・合計・前月比較・全グラフ・期間印刷を分離し、元の履歴・共有記録を保持。モード変更後の遅延応答も破棄');
dom.window.close();
