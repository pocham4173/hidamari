import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {homeFixture,html} from './helpers/home-conversation-fixture.mjs';
const require=createRequire(import.meta.url),handoff=require('../request-handoff.js');
const connection={status:'shared',others:2,familyOthers:1,personOthers:1};
const req={_id:'request-1',type:'onegai',text:'電話してほしい',uid:'person',date:'2026-09-18',at:{seconds:1789722000}};
const response={_id:'response-1',type:'onegai-back',text:'今から電話するね',name:'花子',uid:'family',replyTo:req._id,requestStage:'planned',at:{seconds:1789722010}};
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(screen='kazoku'){
 const f=homeFixture(screen),{c,document}=f,server=new Map([[req._id,req]]);let count=0;
 Object.assign(c,{MainicoRequestHandoff:handoff,stopPersonSpeech(){},appConfirm:async()=>true,
   col:()=>({doc:id=>({get:async()=>({exists:server.has(id),id,data:()=>server.get(id),metadata:{fromCache:false}})})}),
   addEvent:async p=>{f.writes.push({...p,uid:c.uid()});return {id:'saved-'+(++count)};}});
 c.previewStorage.setItem('mainicoMode',screen);
 f.state(connection);f.events([req]);
 const role=screen==='honnin'?'person':'family',panel=()=>document.getElementById(role+'-requests-panel');
 const buttons=()=>[...panel().querySelectorAll('button')];
 async function click(label){const button=buttons().find(b=>b.textContent===label);assert.ok(button,label);assert.equal(button.disabled,false,label);button.click();await flush();}
 return {...f,server,panel,buttons,click,ctl:()=>c.getRequestHandoff()};
}

test('production: date, read-only named greeting, record buttons and optional condition remain separate',async()=>{
 const f=fixture('honnin');
 const a=html.indexOf('function personWelcomeText(){'),b=html.indexOf('function speakElement(',a);vm.runInContext(html.slice(a,b),f.c);
 f.c.slot=()=>({tx:'おはよう'});f.c.previewStorage.setItem('mainicoName','春子');f.c.previewStorage.setItem('mainicoSpeechOn','0');
 const spoken=[];f.c.speak=(...args)=>spoken.push(args);
 f.c.speakPersonWelcome();assert.deepEqual(spoken,[['春子さん、おはよう。',true]]);assert.equal(f.writes.length,0);
 assert.equal(f.document.querySelector('#person-welcome-text').textContent,'春子さん、おはよう。');
 f.c.slot=()=>({tx:'こんにちは'});f.c.speakPersonWelcome();assert.match(spoken.at(-1)[0],/こんにちは/);
 f.c.previewStorage.setItem('mainicoName','<img src=x>');f.c.renderPersonWelcome();assert.equal(f.document.querySelector('#person-welcome-read img'),null);
 assert.equal(f.document.querySelector('#btn-a').getAttribute('onclick'),'sendAisatsu()');
 for(const slot of ['asa','hiru','yoru'])assert.equal(f.document.querySelector('#btn-k-'+slot).getAttribute('onclick'),`sendKusuri('${slot}')`);
 assert.equal(f.document.querySelectorAll('#kibun-box .kibun-btn').length,5);assert.match(f.document.querySelector('#kibun-box .skip').textContent,/答えない/);
 assert.ok(html.indexOf('id="h-date"')<html.indexOf('id="person-welcome-read"'));
 for(const era of ['令和','昭和','平成','西暦'])assert.ok(html.includes(era));f.close();
});

test('production: request → dated family plan → person reads, with no delivery claim',async()=>{
 const f=fixture();await f.click('今から電話するね');assert.equal(f.writes.length,1);
 assert.deepEqual(f.writes[0],{type:'onegai-back',text:'今から電話するね',name:'家族',replyTo:req._id,requestStage:'planned',uid:'family'});
 assert.match(f.panel().textContent,/対応予定/);assert.match(f.panel().textContent,/本人が読んだか/);
 const p=fixture('honnin');p.events([req,response]);assert.match(p.panel().textContent,/花子さん.*対応予定/s);assert.match(p.panel().textContent,/2026年9月18日/);
 await p.click('🔊 お願いと返事を聞く');assert.match(p.spoken.at(-1),/電話してほしい.*花子さん.*今から電話/s);assert.equal(p.writes.length,0);
 f.close();p.close();
});

test('completion is explicit, free replies preserve commitment, correction and withdrawal are separate events',async()=>{
 const f=fixture();f.events([req,response]);f.c.appConfirm=async()=>false;await f.click('対応したことを本人へ伝える');assert.equal(f.writes.length,0);
 f.c.appConfirm=async()=>true;await f.ctl().send(req._id,'もう少し待っていてね','reply');
 assert.ok(f.buttons().some(b=>b.textContent==='対応したことを本人へ伝える'),'free reply keeps the existing plan');
 await f.click('対応したことを本人へ伝える');assert.equal(f.writes.at(-1).requestStage,'done');assert.equal(f.writes.at(-1).text,'電話で話しました。');
 assert.match(f.panel().textContent,/対応した報告/);assert.ok(f.writes.every(v=>v.type==='onegai-back'),'does not invent phone observation or medication records');
 await f.click('対応した報告を訂正する');assert.equal(f.writes.at(-1).requestStage,'planned');assert.match(f.writes.at(-1).text,/まだ対応していません/);
 await f.click('自分の対応予定を取り消す');assert.equal(f.writes.at(-1).requestStage,'withdrawn');assert.ok(f.buttons().some(b=>b.textContent==='今から電話するね'));f.close();
});

test('unconfirmed feed, unavailable membership and family-only mode never send',async()=>{
 const f=fixture();
 for(const status of ['cached','loading','error']){f.events([req],status);assert.ok(f.buttons().every(b=>b.disabled));await f.ctl().send(req._id,'今から電話するね','planned');}
 f.events([req]);
 for(const state of [{status:'solo',others:0,familyOthers:0,personOthers:0},{status:'unknown',others:null},{status:'shared',personOthers:0}]){
   f.state(state);await f.ctl().send(req._id,'今から電話するね','planned');assert.match(f.panel().textContent,/今は家族/);
 }
 f.c.isKOnly=()=>true;f.state(connection);assert.equal(f.panel().hidden,true);await f.ctl().send(req._id,'今から電話するね','planned');assert.equal(f.writes.length,0);f.close();
});

test('missing, modified, or unconfirmed original is not answered',async()=>{
 const f=fixture();f.server.delete(req._id);await f.ctl().send(req._id,'今から電話するね','planned');assert.equal(f.writes.length,0);assert.match(f.panel().textContent,/元のお願い/);
 f.server.set(req._id,{...req,text:'変更後'});await f.ctl().send(req._id,'今から電話するね','planned');assert.equal(f.writes.length,0);
 f.c.col=()=>({doc:()=>({get:async()=>({exists:true,data:()=>req,metadata:{fromCache:true}})})});
 await f.ctl().send(req._id,'今から電話するね','planned');assert.equal(f.writes.length,0);assert.match(f.panel().textContent,/保存できません/);f.close();
});

test('double press and success-before-snapshot cannot duplicate; incoming request cannot replace target',async()=>{
 const f=fixture(),pending=deferred();f.c.addEvent=async p=>{f.writes.push(p);await pending.promise;return {id:'saved'};};
 const first=f.ctl().send(req._id,'今から電話するね','planned');await flush();
 await f.ctl().send(req._id,'今から電話するね','planned');assert.equal(f.writes.length,1);
 f.events([req,{...req,_id:'new',text:'買い物をお願い',at:{seconds:1789722100}}]);pending.resolve();await first;
 assert.equal(f.writes[0].replyTo,req._id);await f.ctl().send(req._id,'今から電話するね','planned');assert.equal(f.writes.length,1);f.close();
});

test('household change during server read or save cannot show old success or write into new household',async()=>{
 for(const phase of ['read','write']){
   const f=fixture(),pending=deferred();
   if(phase==='read')f.c.col=()=>({doc:()=>({get:()=>pending.promise})});
   else f.c.addEvent=async p=>{f.writes.push(p);await pending.promise;return {id:'saved-old'};};
   const saving=f.ctl().send(req._id,'今から電話するね','planned');await flush();f.setGroup('new-household');f.c.resetCommunication();
   pending.resolve({exists:true,data:()=>req,metadata:{fromCache:false}});await saving;
   assert.equal(f.writes.length,phase==='read'?0:1);assert.equal(f.panel().hidden,true);assert.doesNotMatch(f.panel().textContent,/返事を保存しました/);f.close();
 }
});

test('free text failure retains draft, retry escapes markup, preserves plan and focus across snapshot',async()=>{
 const f=fixture();f.events([req,response]);const details=f.panel().querySelector('.request-actions details');details.open=true;await flush();
 let input=f.panel().querySelector('input');input.value='<img src=x onerror=bad>';input.dispatchEvent(new f.dom.window.Event('input'));input.focus();input.setSelectionRange(3,3);
 f.events([req,response]);input=f.panel().querySelector('input');assert.equal(input.value,'<img src=x onerror=bad>');assert.equal(f.document.activeElement,input);assert.equal(input.selectionStart,3);
 f.c.addEvent=async()=>{throw Error('offline');};await f.click('この返事を送る');assert.equal(f.panel().querySelector('input').value,'<img src=x onerror=bad>');assert.match(f.panel().textContent,/入力は残っています/);
 f.c.addEvent=async p=>{f.writes.push(p);return {id:'free'};};await f.click('この返事を送る');assert.equal(f.panel().querySelector('img'),null);assert.equal(f.writes[0].requestStage,'reply');
 assert.equal(f.panel().querySelector('input').value,'');assert.match(f.panel().textContent,/対応予定/);f.close();
});

test('quiet request is acknowledged without a call or completion action',async()=>{
 const f=fixture(),q={...req,text:'今日はそっとしておいて'};f.server.set(q._id,q);f.events([q]);await f.click('わかったよ。今日はそっとしておくね');
 assert.equal(f.writes[0].requestStage,'noted');assert.doesNotMatch(f.buttons().map(b=>b.textContent).join(' '),/電話|対応した|取り消す/);f.close();
});

test('multiple family replies remain named and only own commitment exposes changes',async()=>{
 const f=fixture();const other={...response,_id:'other',uid:'sibling',name:'太郎'};f.events([req,other]);
 assert.match(f.panel().textContent,/太郎さん/);assert.ok(!f.buttons().some(b=>b.textContent==='自分の対応予定を取り消す'));
 f.events([req,response,other]);assert.match(f.panel().textContent,/花子さん/);assert.match(f.panel().textContent,/太郎さん/);
 await f.click('自分の対応予定を取り消す');assert.equal(f.writes[0].uid,'family');assert.match(f.panel().textContent,/太郎さん · 対応予定/);f.close();
});

test('request removal drops prior response and person view excludes other people requests',async()=>{
 const f=fixture();await f.click('今から電話するね');f.events([]);assert.equal(f.panel().hidden,true);assert.equal(f.panel().querySelectorAll('.request-item').length,0);
 const p=fixture('honnin');p.events([req,response,{...req,_id:'someone',uid:'other',text:'別の本人'}]);assert.doesNotMatch(p.panel().textContent,/別の本人/);
 p.events([]);assert.equal(p.panel().hidden,true);f.close();p.close();
});

test('stored replies survive reload; three latest requests stay short and expanded history stays open',async()=>{
 const f=fixture(),rows=Array.from({length:6},(_,i)=>({...req,_id:'r'+i,at:{seconds:1789722000+i}}));f.events(rows);
 assert.equal(f.panel().querySelectorAll('#family-requests-list > .request-item').length,3);
 const more=f.panel().querySelector('#family-requests-list > details');more.open=true;await flush();f.events(rows);assert.equal(f.panel().querySelector('#family-requests-list > details').open,true);
 f.events([req,response]);assert.ok(f.buttons().some(b=>b.textContent==='対応したことを本人へ伝える'));f.close();
 const fresh=fixture();fresh.events([req,response]);assert.match(fresh.panel().textContent,/花子さん · 対応予定/);assert.equal(fresh.writes.length,0);fresh.close();
});

 test('subscription error after a ready snapshot disables actions before any new snapshot',async()=>{
 const f=fixture();assert.ok(f.buttons().some(b=>!b.disabled));
 vm.runInContext("familyHomeEventStatus='error';updateCommunicationAvailability();",f.c);
 assert.ok(f.buttons().every(b=>b.disabled));await f.ctl().send(req._id,'今から電話するね','planned');assert.equal(f.writes.length,0);
 assert.match(f.panel().textContent,/最新の確認ができていません/);f.close();
});


test('person home: one collapsed contact entrance after schedule; opening preserves requests and replies',()=>{
 const f=fixture('honnin'),d=f.document,contact=d.getElementById('person-conversation-panel');
 assert.equal(contact.tagName,'DETAILS');assert.equal(contact.open,false);
 assert.ok(d.getElementById('y-card').compareDocumentPosition(contact)&4);
 assert.ok(contact.contains(f.panel()));assert.ok(contact.contains(d.getElementById('h-incoming-message')));
 assert.equal(f.visible(f.panel()),false);assert.equal(f.visible(d.getElementById('y-card')),true);
 contact.open=true;f.events([req,response]);assert.equal(contact.open,true);assert.equal(f.visible(f.panel()),true);
 assert.match(f.panel().textContent,/今から電話するね/);
 contact.open=false;f.events([req,response]);assert.equal(contact.open,false);assert.equal(f.writes.length,0);
 assert.match(d.getElementById('h-contact-state').textContent,/今日の家族からの連絡/);
 f.close();
});


test('person contact summary: own request replies, freshness, deletion and household reset stay accurate',()=>{
 const f=fixture('honnin'),summary=f.document.getElementById('person-request-summary');
 assert.match(summary.textContent,/まだ返事がありません/);
 f.events([req,response]);assert.match(summary.textContent,/2026年9月18日.*花子さん/);
 assert.equal(f.document.getElementById('person-conversation-panel').open,false);
 f.events([req,response],'cached');assert.match(summary.textContent,/最新の確認ができていません/);
 f.events([req,{...response,name:'<img src=x>'}]);assert.equal(summary.querySelector('img'),null);
 f.events([response]);assert.equal(summary.textContent,'');
 f.events([{...req,uid:'someone-else'},response]);assert.equal(summary.textContent,'');
 f.events([req,response]);f.ctl().reset();assert.equal(summary.textContent,'');
 const record=f.document.getElementById('btn-a'),note=f.document.getElementById('person-record-sharing');
 assert.ok(record.compareDocumentPosition(note)&4,'record action precedes the long sharing explanation');
 assert.equal(record.getAttribute('onclick'),'sendAisatsu()');assert.equal(f.writes.length,0);f.close();
});


test('family request entrance stays compact, keeps dates and does not send by opening',()=>{
 const f=fixture(),panel=f.panel(),summary=f.document.getElementById('family-request-summary');
 assert.equal(panel.tagName,'DETAILS');assert.equal(panel.open,false);
 assert.match(summary.textContent,/2026年9月18日.*電話してほしい/);
 assert.equal(f.visible(f.buttons()[0]),false);
 panel.open=true;f.events([req,response]);assert.equal(panel.open,true);
 assert.ok(f.visible(f.buttons()[0]));assert.equal(f.writes.length,0);
 assert.match(summary.textContent,/返事があります/);
 assert.doesNotMatch(f.document.getElementById('ev-list').textContent,/電話してほしい|今から電話するね/,'request and its reply appear in the request panel only');
 f.events([response]);assert.match(f.document.getElementById('ev-list').textContent,/今から電話するね/,'orphan reply remains readable');
 panel.open=false;f.events([req,response]);assert.equal(panel.open,false);
 f.events([req],'cached');assert.match(summary.textContent,/最新の確認ができていません/);
 f.events([{...req,text:'<img src=x>'}]);assert.equal(summary.querySelector('img'),null);
 f.events([]);assert.equal(panel.hidden,true);assert.equal(summary.textContent,'');
 panel.open=true;f.ctl().reset();assert.equal(panel.open,false);assert.equal(f.writes.length,0);f.close();
});


test('later-call choices do not invent a date or an evening promise',()=>{
 for(const text of ['電話してほしい','話したい','あとで連絡して']){
  const choices=handoff.plans(text,new Date(2026,9,21,20,12));
  assert.ok(choices.includes('電話できる時間を、あとで伝えるね'));
  assert.ok(choices.every(choice=>!/[0-9]|夕方/.test(choice)));
 }
});


test('dismiss hides only this account/home view, survives controller reset and can be restored without server writes',async()=>{
 const f=fixture();f.panel().open=true;f.events([req,response]);
 await f.click('ホームから消す');
 assert.equal(f.panel().querySelector('[data-request-id]'),null);
 assert.equal(f.panel().open,false);assert.match(f.document.getElementById('family-requests-label').textContent,/消したお願いを見る/);
 assert.equal(f.writes.length,0);assert.equal(f.server.has(req._id),true);
 f.c.resetRequestHandoff();f.events([req,response]);assert.equal(f.panel().querySelector('[data-request-id]'),null);
 f.setAccount('other-family');f.events([req,response]);assert.ok(f.panel().querySelector('[data-request-id]'));
 f.setAccount('family');f.setGroup('other-home');f.events([req,response]);assert.ok(f.panel().querySelector('[data-request-id]'));
 f.setGroup('home');f.events([req,response]);assert.equal(f.panel().querySelector('[data-request-id]'),null);
 f.panel().open=true;await f.click('ホームに戻す');assert.ok(f.panel().querySelector('[data-request-id]'));assert.equal(f.writes.length,0);f.close();
});

test('new reply or new request resurfaces; hidden item never suppresses a new message',async()=>{
 const f=fixture();f.events([req,response]);await f.click('ホームから消す');
 f.events([req,response,{...response,_id:'new-reply',text:'電話したよ',at:{seconds:1789723000}}]);
 assert.ok(f.panel().querySelector('[data-request-id="request-1"]'));assert.match(f.panel().textContent,/電話したよ/);
 f.events([req,response]);await f.click('ホームに戻す');await f.click('ホームから消す');
 f.events([req,response,{...req,_id:'new-request',text:'買い物をお願い'}]);
 assert.ok(f.panel().querySelector('[data-request-id="new-request"]'));assert.equal(f.panel().querySelector('[data-request-id="request-1"]'),null);
 assert.equal(f.writes.length,0);f.close();
});

test('dismiss cancel, storage failure, changed conversation and household switch do not hide a request',async()=>{
 for(const failure of ['cancel','storage','reply','group']){
  const f=fixture(),pending=deferred();
  if(failure==='cancel')f.c.appConfirm=async()=>false;
  if(failure==='storage')f.c.previewStorage.setItem=()=>{throw Error('quota');};
  if(['reply','group'].includes(failure))f.c.appConfirm=()=>pending.promise;
  const b=f.buttons().find(b=>b.textContent==='ホームから消す');b.click();await flush();
  if(failure==='reply'){f.events([req,response]);pending.resolve(true);await flush();}
  if(failure==='group'){f.setGroup('new-home');f.c.resetCommunication();f.events([req]);pending.resolve(true);await flush();}
  assert.ok(f.panel().querySelector('[data-request-id]'),failure);
  if(failure==='storage')assert.match(f.panel().textContent,/表示は変更していません/);
  if(failure==='reply')assert.match(f.panel().textContent,/返事が更新されました/);
  assert.equal(f.writes.length,0);f.close();
 }
});

test('old requests stay folded; a recent reply resurfaces the source without writes',()=>{
 const f=fixture();const old={...req,date:'2026-09-10',at:{seconds:1}};
 f.events([old]);assert.equal(f.panel().open,false);
 assert.equal(f.document.getElementById('family-requests-label').textContent,'以前のお願いを見る');
 f.panel().open=true;const older=f.panel().querySelector('[data-open-key="family:older"]');assert.equal(older.open,false);
 assert.equal(f.visible(older.querySelector('article')),false);
 f.events([old,{...response,date:'2026-09-18'}]);
 assert.equal(f.document.getElementById('family-requests-label').textContent,'お願い・返事を確認する');
 f.panel().open=true;assert.equal(f.visible(f.panel().querySelector('article')),true);
 assert.equal(f.writes.length,0);f.close();
});

test('schedule review shows today/yesterday only until older schedules are opened or searched',()=>{
 const f=fixture();Object.assign(f.c,{familyYoteiStatus:'ready',yoteiReviewCat:'',yoteiReviewShown:15,yoteiNotes:[],
  yoteiCache:[{_id:'old',date:'2026-09-01',label:'古い予定'},{_id:'yesterday',date:'2026-09-17',label:'昨日の予定'}],
  renderReviewCategoryChips(){},yoteiColor:()=> '#000',yoteiDateJp:v=>v.date});
 const a=html.indexOf('function renderYoteiReview(){'),b=html.indexOf('function openYoteiReview(',a);vm.runInContext(html.slice(a,b),f.c);
 f.document.getElementById('t-home').style.display='none';f.document.getElementById('t-kiroku').style.display='block';
 f.c.renderYoteiReview();const older=f.document.getElementById('yr-older');
 assert.equal(older.open,false);assert.equal(f.visible(older.querySelector('button')),false);
 assert.equal(f.visible(f.document.querySelector('#yr-list > button')),true);
 f.document.getElementById('yr-search').value='古い';f.c.renderYoteiReview();assert.equal(f.document.getElementById('yr-older').open,true);
 assert.equal(f.writes.length,0);f.close();
});
