import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {create}=require('../person-tasks.js');
class Element {
  constructor(){this.children=[];this.listeners={};this.value='';this.disabled=false;this._text='';this.classList={add(){},remove(){}};}
  set textContent(v){this._text=v;this.children=[];} get textContent(){return this._text;}
  appendChild(v){this.children.push(v);return v;}
  addEventListener(k,f){(this.listeners[k]??=new Set()).add(f);}
  removeEventListener(k,f){this.listeners[k]?.delete(f);}
  async click(){await Promise.all([...(this.listeners.click||[])].map(f=>f()));}
}
function fixture(voice=true){
  const elements={},subs=[],writes=[],spoken=[];let ctx={uid:'one',gid:'home'},unsubscribed=0,writer=async()=>{};
  const document={getElementById:id=>elements[id]??=new Element(),createElement:()=>new Element()};
  const app=create({document,getContext:()=>ctx,speak:voice===false?undefined:typeof voice==='function'?voice:message=>spoken.push(message),subscribe:(type,data,error)=>{subs.push({type,data,error});return ()=>unsubscribed++;},addEvent:async v=>{writes.push(v);await writer(v);}});
  const push=(i,rows=[],meta={fromCache:false,hasPendingWrites:false})=>subs[i].data(rows,meta);
  return {app,e:id=>document.getElementById('person-task-'+id),subs,writes,spoken,push,context:v=>ctx=v,writer:v=>writer=v,unsubs:()=>unsubscribed};
}
const task={_id:'a',uid:'one',taskKind:'self',text:'買い物'};
{
 const f=fixture();f.app.open();f.push(0,[task,{...task,_id:'b',uid:'other'},{...task,_id:'c',taskKind:'family'}]);
 assert.equal(f.e('save').disabled,true);f.push(1);assert.equal(f.e('save').disabled,false);assert.equal(f.e('list').children.length,1);
 f.push(0,[task],{fromCache:true});assert.equal(f.e('save').disabled,true);assert.equal(f.e('list').children[0].children.at(-1).disabled,true);
 console.log('PASS only own self tasks; both subscriptions require server freshness');
}
{
 const f=fixture();f.app.open();f.push(0);f.push(1);f.e('input').value='買い物';f.e('date').value='2026-09-17';
 let reject;f.writer(()=>new Promise((_,r)=>reject=r));const pending=f.e('save').click();await f.e('save').click();assert.equal(f.writes.length,1);
 reject(new Error('offline'));await pending;assert.equal(f.e('input').value,'買い物');assert.equal(f.e('save').disabled,false);
 f.writer(async()=>{});await f.e('save').click();assert.equal(f.e('input').value,'');assert.equal(f.writes[1].taskKind,'self');assert.equal(f.writes[1].due,'2026-09-17');
 console.log('PASS duplicate save blocked and failed input retained');
}
{
 const f=fixture();f.app.open();f.push(0,[task]);f.push(1);const b=f.e('list').children[0].children.at(-1);
 await b.click();await b.click();assert.equal(f.writes.length,1);assert.equal(f.writes[0].type,'family-task-done');assert.equal(f.writes[0].replyTo,'a');
 f.push(1,[{replyTo:'a'}]);assert.equal(f.e('list').children[0].children.at(-1).textContent,'できました');
 console.log('PASS completion deduplicated until acknowledgement');
}
{
 const f=fixture();f.app.open();f.push(0,[task]);f.push(1);f.e('input').value='秘密';f.context({uid:'two',gid:'other'});await f.e('save').click();assert.equal(f.writes.length,0);
 f.app.close();assert.equal(f.unsubs(),2);f.push(0,[task]);assert.equal(f.e('list').children.length,0);assert.equal(f.e('input').value,'');
 f.app.open();assert.equal(f.e('save').listeners.click.size,1);f.push(0,[task]);assert.equal(f.e('list').children[0].textContent,'最新のやることを確認しています。');
 console.log('PASS context changes and old callbacks cannot mutate reopened view');
}
{
 const f=fixture();f.app.open();f.push(0,[],{});f.push(1);assert.equal(f.e('save').disabled,true,'metadataが不足する場合は書込不可');
 f.push(0);f.e('input').value='あ'.repeat(81);await f.e('save').click();assert.equal(f.writes.length,0);
 f.e('input').value='買い物';f.e('date').value='bad';await f.e('save').click();assert.equal(f.writes.length,0);
 f.app.close();f.push(0,[task]);assert.equal(f.e('list').children.length,0);
 console.log('PASS unknown metadata and invalid inputs fail closed');
}
{
 const f=fixture();f.app.open();assert.match(f.spoken[0],/自分のやることをひらきました/);
 f.push(0);f.push(1);f.push(0,[],{fromCache:true});f.push(0);assert.equal(f.spoken.length,1,'自動更新では繰り返し読み上げない');
 await f.e('save').click();assert.equal(f.spoken.at(-1),'やることを入力してください。');
 f.e('input').value='あ'.repeat(81);await f.e('save').click();assert.match(f.spoken.at(-1),/80文字以内/);
 f.e('input').value='買い物';f.e('date').value='bad';await f.e('save').click();assert.equal(f.spoken.at(-1),'期限を確認してください。');
 f.e('date').value='';let resolve;f.writer(()=>new Promise(r=>resolve=r));const pending=f.e('save').click();
 assert.equal(f.spoken.at(-1),'保存しています…');assert.equal(f.spoken.some(message=>message.includes('保存しました')),false,'完了前に保存したとは読み上げない');
 const count=f.spoken.length;await f.e('save').click();assert.equal(f.spoken.length,count,'処理中の連打では読み上げも重複しない');
 resolve();await pending;assert.equal(f.spoken.at(-1),'やること「買い物」を保存しました。');
 assert.equal(f.spoken.at(-1),f.e('state').textContent,'音声と画面の保存結果が一致する');
 f.e('input').value='通院の準備';f.writer(async()=>{throw new Error('offline');});await f.e('save').click();
 assert.equal(f.spoken.at(-1),'保存できませんでした。入力は残っています。');assert.equal(f.e('input').value,'通院の準備');
 console.log('PASS task open, validation, saving and failed drafts have accurate speech without snapshot chatter');
}
{
 const f=fixture();f.app.open();f.push(0,[task]);f.push(1);let resolve;f.writer(()=>new Promise(r=>resolve=r));
 const pending=f.e('list').children[0].children.at(-1).click();assert.equal(f.spoken.at(-1),'記録しています…');
 resolve();await pending;assert.equal(f.spoken.at(-1),'「買い物」ができたことを記録しました。');
 assert.equal(f.spoken.at(-1),f.e('state').textContent);
 const g=fixture();g.app.open();g.push(0,[task]);g.push(1);g.writer(async()=>{throw new Error('offline');});
 await g.e('list').children[0].children.at(-1).click();assert.match(g.spoken.at(-1),/記録できませんでした/);
 assert.equal(g.e('list').children[0].children.at(-1).disabled,false,'失敗時には再試行できる');
 console.log('PASS completion speech waits for the saved result and failures remain retryable');
}
for(const reason of ['close','different-household']){
 const f=fixture();f.app.open();f.push(0);f.push(1);f.e('input').value='家族の用事';let resolve;
 f.writer(()=>new Promise(r=>resolve=r));const pending=f.e('save').click();const count=f.spoken.length;
 if(reason==='close')f.app.close();else f.context({uid:'two',gid:'other'});
 resolve();await pending;assert.equal(f.spoken.length,count,'古い画面・家庭の保存結果を読み上げない: '+reason);
}
for(const voice of [false,()=>{throw new Error('voice unavailable');}]){
 const f=fixture(voice);f.app.open();f.push(0);f.push(1);f.e('input').value='買い物';await f.e('save').click();
 assert.equal(f.writes.length,1);assert.match(f.e('state').textContent,/保存しました/);assert.equal(f.e('input').value,'');
 assert.equal(f.e('save').disabled,false,'音声がなくても正常に操作を続けられる');
}
console.log('PASS stale speech is suppressed and unavailable speech cannot turn a saved task into failure');
