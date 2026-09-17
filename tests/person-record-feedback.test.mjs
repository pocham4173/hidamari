import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(process.env.MAINICO_PERSON_SENDS_SOURCE||new URL('../index.html',import.meta.url),'utf8');
function section(a,b){const i=html.indexOf(a),j=html.indexOf(b,i);assert.ok(i>=0&&j>i,a);return html.slice(i,j);}
function fixture(){
 let account='person',group='home',generation=1,day='2026-09-17',timerId=0,confirmed=true,reloads=0;
 const els=new Map(),cache=new Map(),timers=new Map(),writes=[],listReads=[],deleted=[],rows=new Map(),alerts=[],confirms=[];
 const doc={activeElement:null,getElementById:id=>el(id)};
 const el=id=>{if(!els.has(id))els.set(id,{textContent:'',innerHTML:'',value:'',hidden:false,disabled:false,isConnected:true,style:{},attrs:{},classList:{add(){},remove(){}},setAttribute(k,v){this.attrs[k]=v;},focus(){doc.activeElement=this;},addEventListener(k,fn){this[k]=fn;},querySelectorAll(){return this.targets||[];}});return els.get(id);};
 const c={document:doc,uid:()=>account,gid:()=>group,todayStr:()=>day,slot:()=>({key:'asa',tx:'おはよう'}),
  communicationSession:()=>{const a=account,g=group,v=generation;return ()=>a===account&&g===group&&v===generation;},
  setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
  previewStorage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v),removeItem:k=>cache.delete(k)},
  validKusuriSlot:k=>['asa','hiru','yoru'].includes(k),kusuriSlotName:k=>({asa:'朝',hiru:'昼',yoru:'夜'}[k]),recSlot:k=>'（'+k+'）',kusuriQuestion:()=> '薬は飲みましたか',
  feedback(){},speak(){},markAisatsuDone(){},markKusuriDone(){},refreshSlotUI(){},requireFamilyFeature:()=>true,closeOnegai(){},console,
  esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),jsArg:s=>String(s||'').replace(/[^A-Za-z0-9_-]/g,''),
  addEvent:payload=>new Promise((resolve,reject)=>writes.push({payload,resolve,reject})),
  alert:t=>alerts.push(t),confirm:t=>{confirms.push(t);return confirmed;},location:{reload:()=>reloads++},
  col:()=>({where:()=>({get:options=>{assert.equal(options.source,'server');return new Promise((resolve,reject)=>listReads.push({resolve,reject}));}}),doc:id=>({
   get:async options=>{assert.equal(options.source,'server');return {exists:rows.has(id),data:()=>rows.get(id),metadata:{fromCache:false}};},delete:async()=>{deleted.push(id);rows.delete(id);}})})};
 vm.createContext(c);
 vm.runInContext(section('function compareConversationEvents(a,b){','function personReplyDone(id){')+section('let honninSending=false;','function skipKibun(')+section('function sendKusuri(slotKey){','/* ちょっとお願い */')+section('function sendOnegai(text, inputId){','/* カレンダー */')+section('function cancelRecordLabel(v){','/* つながっている家族(本人側・閲覧) */'),c);
 return {c,el,doc,timers,writes,listReads,deleted,rows,alerts,confirms,cache,busy:()=>vm.runInContext('honninSending',c),reloads:()=>reloads,confirm:v=>confirmed=v,day:v=>day=v,switchSession(){account='new-person';group='new-home';generation++;c.resetPersonRecordFeedback();}};
}
const cases=[
 [f=>f.c.sendAisatsu(),/「おはよう」を記録しました/],
 [f=>f.c.sendKibun('元気','🙂'),/調子「元気」を記録しました/],
 [f=>f.c.sendKusuri('asa'),/「朝の薬を飲みました」を記録しました/],
 [f=>f.c.sendOnegai('お話ししたい'),/お願い「お話ししたい」を記録しました/]
];
for(const [send,result] of cases){
 const f=fixture(),pending=send(f);assert.equal(f.el('person-record-actions').hidden,true);
 f.writes[0].resolve();await pending;assert.match(f.el('pop-msg').textContent,result);assert.equal(f.el('person-record-actions').hidden,false);assert.equal(f.timers.size,0);
 if(f.writes[0].payload.type==='kibun')assert.equal(f.el('kibun-box').style.display,'none','調子欄を閉じても結果は別枠に残る');
}
{
 const f=fixture(),pending=f.c.sendKusuri('asa'),timer=[...f.timers.values()][0];assert.equal(timer.ms,10000);timer.fn();
 assert.equal(f.el('pop-msg').textContent,'保存できたか確認しています…');assert.equal(f.busy(),true);f.c.sendKusuri('asa');assert.equal(f.writes.length,1,'待機表示に変わっても二重送信しない');
 f.writes[0].resolve();await pending;assert.match(f.el('pop-msg').textContent,/「朝の薬を飲みました」を記録しました/);timer.fn();assert.doesNotMatch(f.el('pop-msg').textContent,/確認しています/);
}
{
 const f=fixture();f.el('onegai-free').value='話したい';const pending=f.c.sendOnegai('話したい','onegai-free');[...f.timers.values()][0].fn();
 assert.equal(f.el('onegai-free-state').textContent,'保存できたか確認しています…');assert.equal(f.el('onegai-free-btn').disabled,true);
 f.writes[0].reject(Error('offline'));await pending;assert.equal(f.el('onegai-free').value,'話したい');assert.match(f.el('pop-msg').textContent,/保存できません/);assert.equal(f.el('person-record-actions').hidden,true);assert.equal(f.busy(),false);
}
{
 const f=fixture(),pending=f.c.sendAisatsu(),oldTimer=[...f.timers.values()][0];f.switchSession();f.el('pop-msg').textContent='新しい家庭';oldTimer.fn();f.writes[0].resolve();await pending;
 assert.equal(f.el('pop-msg').textContent,'新しい家庭');assert.equal(f.el('person-record-actions').hidden,true);
}
{
 const f=fixture(),pending=f.c.sendAisatsu();f.day('2026-09-18');f.writes[0].resolve();await pending;assert.equal(f.el('person-record-actions').hidden,true,'前日の保存結果から今日の取消一覧に誘導しない');
}
const snap=data=>({metadata:{fromCache:false},forEach:fn=>data.forEach(v=>fn({id:v.id,data:()=>v}))});
{
 const f=fixture(),opener=f.el('person-record-correct');opener.focus();const pending=f.c.openCancel();assert.equal(f.doc.activeElement,f.el('cancel-title'));assert.equal(f.deleted.length,0,'近くの入口を開くだけでは削除しない');
 f.listReads[0].resolve(snap([{id:'mine',uid:'person',date:'2026-09-17',type:'kibun',text:'元気',at:{seconds:1}},{id:'other',uid:'family',date:'2026-09-17',type:'aisatsu',text:'他人'},{id:'yesterday',uid:'person',date:'2026-09-16',type:'aisatsu',text:'昨日'}]));await pending;
 assert.match(f.el('cancel-list').innerHTML,/元気/);assert.doesNotMatch(f.el('cancel-list').innerHTML,/他人|昨日/);assert.equal(f.deleted.length,0);
 const first=f.el('first'),last=f.el('last');f.el('cancel-modal').targets=[first,last];let prevented=false;last.focus();f.c.cancelDialogKeydown({key:'Tab',shiftKey:false,preventDefault:()=>prevented=true});assert.equal(prevented,true);assert.equal(f.doc.activeElement,first);
 f.c.cancelDialogKeydown({key:'Escape',preventDefault(){}});assert.equal(f.doc.activeElement,opener,'閉じたら入口にフォーカスを戻す');
}
{
 const f=fixture(),pending=f.c.openCancel();f.c.closeCancel();f.el('cancel-list').textContent='閉じた画面';f.listReads[0].reject(Error('offline'));await pending;assert.equal(f.el('cancel-list').textContent,'閉じた画面','閉じた後の応答で表示を書き換えない');
}
{
 const f=fixture();f.rows.set('own',{uid:'person',date:'2026-09-17',type:'kusuri',slot:'asa'});f.rows.set('other',{uid:'family',date:'2026-09-17',type:'kusuri',slot:'asa'});f.rows.set('old',{uid:'person',date:'2026-09-16',type:'kusuri',slot:'asa'});
 await f.c.cancelEvent('other','kusuri','asa');await f.c.cancelEvent('old','kusuri','asa');assert.equal(f.deleted.length,0);assert.equal(f.confirms.length,0,'自分以外・過去日の記録を取り消さない');
 f.confirm(false);await f.c.cancelEvent('own','kusuri','asa');assert.equal(f.deleted.length,0,'確認でやめた場合は削除しない');
 f.confirm(true);f.cache.set('kusuri-2026-09-17-asa','1');await f.c.cancelEvent('own','aisatsu','yoru');assert.deepEqual(f.deleted,['own']);assert.equal(f.cache.has('kusuri-2026-09-17-asa'),false,'引数でなく実際に削除した記録の表示印を消す');assert.equal(f.reloads(),1);
}
assert.match(html,/id="person-record-correct"[^>]*onclick="openCancel\(\)"/);
assert.match(html,/<div[^>]*id="cancel-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
console.log('person record feedback: explicit results, slow-save lock, retry, session isolation, nearby correction, own-today cancellation and dialog focus passed');
