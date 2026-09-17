import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(a,b,from=0){const start=html.indexOf(a,from),end=html.indexOf(b,start);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
const els=new Map(),el=id=>{if(!els.has(id))els.set(id,{textContent:'',value:'',style:{},classList:{remove(){},add(){}}});return els.get(id);};
let day='2026-09-17',generation=1,timer,visibility,unsubscribed=0,rendered=0,schedules=0,tasks=0,kOnly=false;
const listeners=[];
const c={document:{getElementById:el,querySelectorAll:()=>[],hidden:false,addEventListener:(type,fn)=>{assert.equal(type,'visibilitychange');visibility=fn;}},
 familyConversationDay:'',familyConversationRequest:0,familyDayVisibility:null,familyHomeItems:[],familyHomeEventStatus:'loading',
 evUnsub:null,clockTimer:null,aisatsuBackSending:false,askKusuriSending:false,
 communicationSession:()=>{const captured=generation;return ()=>captured===generation;},todayStr:()=>day,isKOnly:()=>kOnly,
 renderFamilyConversation:()=>rendered++,renderFamilySchedule:()=>schedules++,renderFamilyTasks:()=>tasks++,
 renderTodayQuickRecords:items=>el('care-today').textContent=JSON.stringify(items),
 updateCommunicationAvailability(){},validKusuriSlot:()=>true,kusuriSlotName:x=>x,slot:()=>({key:'asa'}),dateJp:()=>day,
 compareConversationEvents:(a,b)=>(a.at?.seconds||0)-(b.at?.seconds||0),
 setInterval:(fn,delay)=>{assert.equal(delay,15000);timer=fn;return 1;},clearInterval(){},
 col:()=>({orderBy:(field,direction)=>{assert.equal(field,'at');assert.equal(direction,'desc');return {limit:count=>{assert.equal(count,100);return {onSnapshot:(metadata,ok,error)=>{assert.equal(metadata.includeMetadataChanges,true);listeners.push({ok,error});return ()=>unsubscribed++;}};}};}}),console:{warn(){}}};
vm.createContext(c);
vm.runInContext(section('function subscribeFamilyConversation(){','function initKazoku(){'),c);
vm.runInContext(section('  subscribeFamilyConversation();','  if(ytListUnsub) ytListUnsub();',html.indexOf('function initKazoku(){')),c);
const snap=items=>({metadata:{fromCache:false,hasPendingWrites:false},forEach:fn=>items.forEach(v=>fn({id:v.id,data:()=>v}))});
assert.equal(listeners.length,1);
listeners[0].ok(snap([{id:'yesterday',type:'aisatsu-back',text:'こんばんは',date:'2026-09-17',at:{seconds:1}}]));
assert.match(el('note-aisatsu-back').textContent,/こんばんは/);
el('in-family-message').value='書いている途中';
el('family-message-target').textContent='元の連絡への返事';
day='2026-09-18';timer();
assert.equal(listeners.length,2,'日付が変わったら当日の購読を開始する');assert.equal(unsubscribed,1);
assert.equal(el('note-aisatsu-back').textContent,'','昨日の本日送信済み表示を残さない');
assert.equal(el('in-family-message').value,'書いている途中');assert.equal(el('family-message-target').textContent,'元の連絡への返事','日付更新で入力対象を勝手に変更しない');
assert.equal(c.familyHomeEventStatus,'loading');
const before=rendered;listeners[0].ok(snap([{id:'late-old-day',at:{seconds:2}}]));listeners[0].error(Error('old'));
assert.equal(rendered,before);assert.equal(c.familyHomeEventStatus,'loading','旧日の遅延イベント/エラーを破棄する');
listeners[1].ok(snap([{id:'today',type:'aisatsu',text:'おはよう',at:{seconds:3}}]));
assert.equal(c.familyHomeItems[0]._id,'today');assert.equal(c.familyHomeEventStatus,'ready');
assert.equal(schedules,1);assert.equal(tasks,1);
timer();visibility();assert.equal(listeners.length,2,'同じ日には購読を重複させない');
day='2026-09-19';kOnly=true;c.document.hidden=true;visibility();assert.equal(listeners.length,2);
c.document.hidden=false;visibility();assert.equal(listeners.length,3,'画面復帰でも日付を更新する');
assert.match(el('care-today').textContent,/読み込んでいます/);
const old= listeners.at(-1);generation++;day='2026-09-20';timer();visibility();
assert.equal(listeners.length,3,'旧家庭のタイマーは新家庭を購読しない');old.ok(snap([{id:'wrong-home',at:{seconds:4}}]));assert.equal(c.familyHomeItems[0]._id,'today','切替前の受信を上書きしない');
assert.ok(html.indexOf('onclick="openCal()"')<html.indexOf('onclick="openPersonTasks()"'),'本人の自分のやることはカレンダーの下');
console.log('conversation date: midnight and visibility resubscription, stale callback rejection, drafts and old-day status passed');
