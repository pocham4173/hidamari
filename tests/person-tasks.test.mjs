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
function fixture(){
  const elements={},subs=[],writes=[];let ctx={uid:'one',gid:'home'},unsubscribed=0,writer=async()=>{};
  const document={getElementById:id=>elements[id]??=new Element(),createElement:()=>new Element()};
  const app=create({document,getContext:()=>ctx,subscribe:(type,data,error)=>{subs.push({type,data,error});return ()=>unsubscribed++;},addEvent:async v=>{writes.push(v);await writer(v);}});
  const push=(i,rows=[],meta={fromCache:false,hasPendingWrites:false})=>subs[i].data(rows,meta);
  return {app,e:id=>document.getElementById('person-task-'+id),subs,writes,push,context:v=>ctx=v,writer:v=>writer=v,unsubs:()=>unsubscribed};
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
