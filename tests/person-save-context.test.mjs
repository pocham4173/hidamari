import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync(process.env.MAINICO_PERSON_SENDS_SOURCE||new URL('../index.html',import.meta.url),'utf8');
function section(start,end){const i=html.indexOf(start),j=html.indexOf(end,i);assert.ok(i>=0&&j>i,start);return html.slice(i,j);}
function fixture(){
  let day='2026-09-17',currentSlot='yoru',account='person',group='home',generation=1;
  const elements=new Map(),cache=new Map(),writes=[],spoken=[],marks=[],warnings=[];
  const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:'',disabled:false,style:{},classList:{add(){},remove(){}}});return elements.get(id);};
  let refreshes=0,closed=0,authorized=true;
  const c={document:{getElementById:el},todayStr:()=>day,slot:()=>({key:currentSlot,tx:currentSlot==='yoru'?'おやすみ':'おはよう'}),
    communicationSession:()=>{const captured=[account,group,generation];return()=>captured[0]===account&&captured[1]===group&&captured[2]===generation;},
    previewStorage:{getItem:key=>cache.get(key),setItem:(key,value)=>cache.set(key,value)},
    validKusuriSlot:key=>['asa','hiru','yoru'].includes(key),kusuriSlotName:key=>({asa:'朝',hiru:'昼',yoru:'夜'}[key]),
    feedback(){},speak:text=>spoken.push(text),markAisatsuDone:()=>marks.push('greeting'),markKusuriDone:key=>marks.push(key),
    refreshSlotUI:()=>refreshes++,requireFamilyFeature:()=>authorized,requestAudienceText:()=> '家族が開いて確認できます。',closeOnegai:()=>closed++,
    console:{warn:(...args)=>warnings.push(args)},addEvent:payload=>new Promise((resolve,reject)=>writes.push({payload,resolve,reject}))};
  vm.createContext(c);
  vm.runInContext(section('let honninSending=false;','function skipKibun(')+
    section('function sendKusuri(slotKey){','/* ちょっとお願い */')+
    section('function sendOnegai(text, inputId){','/* カレンダー */'),c);
  return{c,el,cache,writes,spoken,marks,warnings,refreshes:()=>refreshes,closed:()=>closed,
    busy:()=>vm.runInContext('honninSending',c),day:value=>day=value,slot:value=>currentSlot=value,authorize:value=>authorized=value,
    switchSession(){account='new-person';group='new-home';generation++;vm.runInContext('honninSending=false',c);el('onegai-free-btn').disabled=false;}};
}
const cases=[
  ['greeting',f=>f.c.sendAisatsu(),'aisatsu-2026-09-17-yoru'],
  ['condition',f=>f.c.sendKibun('いい感じ','🙂'),'kibun-2026-09-17'],
  ['medicine',f=>f.c.sendKusuri('yoru'),'kusuri-2026-09-17-yoru'],
  ['request',f=>{f.el('onegai-free').value='お願い';return f.c.sendOnegai('お願い','onegai-free');},null]
];
for(const [name,send,key] of cases){
  const f=fixture(),pending=send(f);assert.equal(f.writes[0].payload.date,'2026-09-17',name);
  send(f);assert.equal(f.writes.length,1,'A pending '+name+' cannot be sent twice');
  f.writes[0].resolve();await pending;assert.equal(f.busy(),false);
  if(key)assert.equal(f.cache.get(key),'1');
}
for(const [name,send,key] of cases){
  const f=fixture(),pending=send(f);f.day('2026-09-18');f.slot('asa');
  f.writes[0].resolve();await pending;
  assert.equal(f.writes[0].payload.date,'2026-09-17',name+' retains the original event date');
  if(key)assert.equal(f.cache.get(key),'1');
  assert.ok([...f.cache.keys()].every(key=>!key.includes('2026-09-18')),'No next-day completion cache');
  assert.equal(f.marks.length,0,'No completion mark on the new day');
  assert.match(f.el('pop-msg').textContent,/2026-09-17/);
  if(key)assert.equal(f.refreshes(),1);
}
{
  const f=fixture(),pending=f.c.sendAisatsu();f.slot('asa');f.writes[0].resolve();await pending;
  assert.deepEqual(f.marks,[]);assert.equal(f.refreshes(),1,'A new greeting slot keeps its own button state');
}
for(const [name,send] of cases){
  for(const failOld of [false,true]){
    const f=fixture(),old=send(f);f.switchSession();const fresh=send(f);
    f.el('pop-msg').textContent='新しい家庭の送信中';
    const before={spoken:f.spoken.length,marks:f.marks.length,closed:f.closed()};
    if(failOld)f.writes[0].reject(Error('old offline'));else f.writes[0].resolve();
    await old;
    assert.equal(f.busy(),true,'Old '+name+' completion cannot clear a new send');
    assert.equal(f.el('pop-msg').textContent,'新しい家庭の送信中');
    assert.equal(f.cache.size,0);assert.equal(f.spoken.length,before.spoken);assert.equal(f.marks.length,before.marks);assert.equal(f.closed(),before.closed);
    if(name==='request')assert.equal(f.el('onegai-free-btn').disabled,true,'Old finally cannot unlock a new request');
    f.writes[1].resolve();await fresh;assert.equal(f.busy(),false);
  }
}
for(const [name,send] of cases){
  const f=fixture(),failed=send(f);f.writes[0].reject(Error('offline'));await failed;
  assert.equal(f.busy(),false,name+' releases its own lock after failure');assert.equal(f.cache.size,0);
  if(name==='request'){assert.equal(f.el('onegai-free').value,'お願い');assert.equal(f.el('onegai-free-btn').disabled,false);}
  const retry=send(f);assert.equal(f.writes.length,2);f.writes[1].resolve();await retry;
}
{
  const f=fixture();f.el('onegai-free').value='最初のお願い';
  const pending=f.c.sendOnegai('最初のお願い','onegai-free');f.el('onegai-free').value='次のお願い';
  f.writes[0].resolve();await pending;assert.equal(f.el('onegai-free').value,'次のお願い');assert.equal(f.closed(),0);
}
for(const [,send,key] of cases.filter(row=>row[2])){
  const f=fixture();f.c.previewStorage.setItem=()=>{throw Error('quota');};const pending=send(f);f.writes[0].resolve();await pending;
  assert.equal(f.busy(),false);assert.equal(f.warnings.length,1);assert.doesNotMatch(f.el('pop-msg').textContent,/電波が届きません/,'A successful server save is not relabeled as a network failure');
}
{
  const f=fixture();f.authorize(false);f.c.sendOnegai('お願い');assert.equal(f.writes.length,0);
}
console.log('person saves: original date/slot, session isolation, stale success/failure, duplicate taps, retry and request drafts passed');
