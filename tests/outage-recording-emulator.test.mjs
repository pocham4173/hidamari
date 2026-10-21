// Local emulator only: real Firestore SDK/rules, production handlers and markup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {consentFixture} from './helpers/consent-fixture.mjs';
const html=fs.readFileSync('index.html','utf8');
const baseline=process.env.EXPECT_BASELINE==='1';
const env=await initializeTestEnvironment({projectId:'demo-mainico-outage',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
const fixtures=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(label,fn){for(let i=0;i<400;i++){if(await fn())return;await delay(25);}assert.fail(label);}
function section(a,b){const i=html.indexOf(a),j=html.indexOf(b,i);assert.ok(i>=0&&j>i,a);return html.slice(i,j);}
function make(id){
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://example.invalid'}),w=dom.window,db=env.authenticatedContext(id).firestore();
 const alerts=[];const state=w.document.getElementById('care-log-state');
 Object.assign(w,{firebase,uid:()=>id,todayStr:()=> '2026-10-16',myName:()=>id,feedback(){},alert:t=>alerts.push(t),col:n=>({add:data=>db.collection('groups').doc('home').collection(n).add({...data})}),currentCareItems:()=>[{key:'call',label:'電話で確認した'},{key:'visit',label:'訪問した'}],foState:(name,t)=>{const el=w.document.getElementById(name);if(el)el.textContent=t;}});
 // Shorten only the waiting notice timer, never Firestore's network behavior.
 const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>timer(fn,ms===10000?100:ms);
 vm.runInContext(section('function addEvent(data){','let familyConnection='),dom.getInternalVMContext());
 vm.runInContext(section(html.includes('let memoSending=false;')?'let memoSending=false;':'function sendMemo(){','/* ===== 家族のみモード:'),dom.getInternalVMContext());
 vm.runInContext(section('let careLogSending=false;','async function addFamilyNote(){'),dom.getInternalVMContext());
 const f={dom,w,db,alerts,state,input:w.document.getElementById('in-memo')};fixtures.push(f);return f;
}
try{
 await env.clearFirestore();
 await env.withSecurityRulesDisabled(async c=>{
  const seed=c.firestore();
  for(const id of ['A','B','pending'])await seed.doc('consents/'+id).set(consentFixture(firebase.firestore.Timestamp.now()));
  await seed.doc('groups/home').set({createdBy:'A'});
  for(const id of ['A','B','pending'])await seed.doc('groups/home/members/'+id).set({name:id,role:'kazoku',mode:'kazoku-only',status:id==='pending'?'pending':'approved'});
 });
 const a=make('A'),b=make('B');
 const rows=async()=> (await b.db.collection('groups').doc('home').collection('events').get({source:'server'})).docs.map(d=>({id:d.id,...d.data()}));
 await a.db.disableNetwork();a.input.value='10月16日9時に電話。元気だった';a.w.sendMemo();a.w.sendMemo();
 await delay(200);assert.equal((await rows()).length,0);assert.equal(a.input.value,'10月16日9時に電話。元気だった');
 if(!baseline){assert.equal(a.w.document.getElementById('memo-save-btn').disabled,true);assert.match(a.w.document.getElementById('memo-save-state').textContent,/まだ確認できていません/);}
 console.log('PASS offline: no server record, draft retained, no success acknowledgement');
 await a.db.enableNetwork();await until('memo reaches second identity',async()=> (await rows()).length===(baseline?2:1));await until('confirmed draft cleared',()=>a.input.value==='');
 const memos=await rows();assert.equal(memos.length,baseline?2:1);for(const r of memos){assert.equal(r.uid,'A');assert.equal(r.name,'A');assert.equal(r.date,'2026-10-16');assert.equal(r.text,'10月16日9時に電話。元気だった');assert.ok(r.at.toMillis()>0);}
 console.log(baseline?'REPRODUCED BUG: two clicks while offline create two memo documents after reconnection':'PASS retry clicks blocked; one memo reaches approved family B with author/date/text');
 await a.db.disableNetwork();a.input.value='送信中のメモ';a.w.sendMemo();a.input.value='次に書いたメモ';await a.db.enableNetwork();await until('new memo committed',async()=> (await rows()).some(r=>r.text==='送信中のメモ'));await delay(100);assert.equal(a.input.value,'次に書いたメモ');assert.equal(a.w.document.getElementById('memo-save-btn').disabled,false);console.log('PASS newer draft survives previous write acknowledgement');
 for(const key of ['call','visit']){
  await a.db.disableNetwork();const first=a.w.addCareLog(key);await a.w.addCareLog(key);await delay(200);assert.doesNotMatch(a.state.textContent,/記録しました/);
  if(!baseline)assert.match(a.state.textContent,/まだ確認できていません/);
  await a.db.enableNetwork();await first;const care=(await rows()).filter(r=>r.careKey===key);assert.equal(care.length,1);assert.equal(care[0].uid,'A');assert.match(a.state.textContent,/記録しました/);
 }
 console.log('PASS call/visit: pending clicks create one record each, confirmed only after recovery');
 const denied=make('pending');denied.input.value='失敗しても残す';denied.w.sendMemo();await until('rules denial reaches UI',()=>denied.alerts.length||denied.w.document.getElementById('memo-save-state')?.textContent.includes('保存できませんでした'));assert.equal(denied.input.value,'失敗しても残す');assert.equal(denied.w.document.getElementById('memo-save-btn').disabled,false);assert.equal((await rows()).some(r=>r.uid==='pending'),false);console.log('PASS actual rules rejection retains draft and displays failure');
 console.log('LIMIT: no iPhone, real server outage, reload recovery or full backup restoration tested');
}finally{for(const f of fixtures)f.dom.window.close();await env.cleanup();}
