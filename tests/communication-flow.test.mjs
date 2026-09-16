import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(a,b){const i=html.indexOf(a),j=html.indexOf(b,i);assert.ok(i>=0&&j>i,a);return html.slice(i,j);}
class Element{
 constructor(){this._text='';this._html='';this.value='';this.style={};this.hidden=false;this.disabled=false;this.dataset={};this.classList={add(){},remove(){}};}
 set textContent(v){this._text=String(v);this._html='';}get textContent(){return this._text;}
 set innerHTML(v){this._html=String(v);this._text='';}get innerHTML(){return this._html;}
 focus(){this.focused=true;}scrollIntoView(){}
}
function fixture(){
 const els=new Map(),writes=[],alerts=[],spoken=[];let account='family',group='home',kOnly=false;
 const el=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);};
 el('card-actions').dataset.communicationGate='person';el('h-message-reply').dataset.communicationGate='family';
 const personSend=el('btn-ab-asa');personSend.dataset.sendAudience='person';
 const familySend=el('person-thanks');familySend.dataset.sendAudience='family';
 const c={document:{getElementById:el,querySelectorAll:sel=>sel==='[data-communication-gate]'?[el('card-actions'),el('h-message-reply')]:sel==='[data-send-audience]'?[personSend,familySend]:[]},uid:()=>account,gid:()=>group,isKOnly:()=>kOnly,householdBootGeneration:1,
   currentFamilyMessageId:'',hMsgSpokenThrough:0,aisatsuBackSending:false,askKusuriSending:false,familyMessageSending:false,
   personMessageReplySending:false,onegaiBackFreeId:'',previewStorage:{getItem:()=>null,setItem(){}},todayStr:()=> '2026-09-17',feedback(){},speak:t=>spoken.push(t),timeYomi:v=>v,
   validKusuriSlot:k=>['asa','hiru','yoru'].includes(k),kusuriSlotName:k=>({asa:'朝',hiru:'昼',yoru:'夜'}[k]||''),slot:()=>({key:'asa'}),
   jsArg:v=>String(v||'').replace(/[^A-Za-z0-9_-]/g,''),esc:v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),eventWhoClass:()=> 'who-honnin',myName:()=> 'テスト家族',alert:t=>alerts.push(t),addEvent:async payload=>{writes.push({...payload});},console};
 vm.createContext(c);
 vm.runInContext(section('let familyConnection={','let personTasksController=null;'),c);
 vm.runInContext(section('/* Conversation state is scoped','/* ===== 家族 ===== */'),c);
 vm.runInContext(section('function renderFamilyConversation(){',"let familyYoteiStatus='loading';"),c);
 vm.runInContext(section('function renderPersonConversation(', 'function initHonnin(){'),c);
 vm.runInContext(section('let familyMessageSending=false;',"let onegaiBackFreeId='';"),c);
 vm.runInContext(section('let personMessageReplySending=false;', 'function recKibun(text)'),c);
 function state(value){c.nextConnection=value;vm.runInContext('familyConnection=nextConnection;renderFamilyConnection();',c);}
 function events(rows,status='ready'){c.nextRows=rows;c.nextStatus=status;vm.runInContext('familyHomeItems=nextRows;familyHomeEventStatus=nextStatus;renderFamilyConversation();',c);}
 return {c,el,writes,alerts,spoken,state,events,setAccount:v=>account=v,setGroup:v=>group=v,setKOnly:v=>kOnly=v};
}
const connected={status:'shared',others:1,personOthers:1,familyOthers:0};
const family={status:'shared',others:1,personOthers:0,familyOthers:1};
const solo={status:'solo',others:0,personOthers:0,familyOthers:0};
const unknown={status:'unknown',others:null,personOthers:null,familyOthers:null};
const greeting={_id:'hello-1',type:'aisatsu',text:'おはよう',slot:'asa',uid:'person',at:{seconds:1}};
{
 const f=fixture();f.state(connected);f.events([greeting]);
 assert.match(f.el('ev-list').innerHTML,/おはよう.*を返す/);
 const click=f.el('ev-list').innerHTML.match(/onclick="(replyToPersonEvent[^\"]+)"/)[1];
 await vm.runInContext(click,f.c);assert.equal(f.writes.length,1);
 assert.equal(f.writes[0].text,'おはよう','生成したonclickを実行しても日本語が失われない');
 assert.equal(f.writes[0].replyTo,'hello-1');assert.equal(f.writes[0].type,'aisatsu-back');
 const response={...f.writes[0],_id:'response-1',uid:'family',at:{seconds:2}};
 f.events([greeting,response]);assert.match(f.el('ev-list').innerHTML,/あなたは返事を送りました/);
 assert.doesNotMatch(f.el('ev-list').innerHTML,/onclick="replyToPersonEvent/);
 f.setAccount('person');f.state(family);f.c.renderPersonConversation([response],{fromCache:false});
 assert.equal(f.c.currentFamilyMessageId,'response-1');assert.equal(f.el('h-message-reply').style.display,'block');
 assert.match(f.el('h-reply-context').textContent,/おはよう/);
 await f.c.sendFamilyMessageBack('ありがとう');assert.equal(f.writes.at(-1).text,'ありがとう');assert.equal(f.writes.at(-1).replyTo,'response-1');
 f.setAccount('family');f.state(connected);f.events([greeting,response,{...f.writes.at(-1),_id:'thanks-1',uid:'person',at:{seconds:3}}]);
 assert.match(f.el('ev-list').innerHTML,/ご本人からの返事：「ありがとう」/);
}
{
 const f=fixture();f.state(unknown);assert.equal(f.el('card-actions').hidden,false);assert.equal(f.el('btn-ab-asa').disabled,true);
 f.state(connected);f.events([greeting]);assert.equal(f.el('card-actions').hidden,false);assert.equal(f.el('btn-ab-asa').disabled,false);
 f.state(unknown);assert.equal(f.el('card-actions').hidden,false);assert.equal(f.el('btn-ab-asa').disabled,true);
 const before=f.el('ev-list').innerHTML;await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,0);assert.equal(f.el('ev-list').innerHTML,before);
 f.state(solo);assert.equal(f.el('card-actions').hidden,true);f.state(unknown);assert.equal(f.el('card-actions').hidden,true,'確認済み一人の家庭には通信待ちで家族欄を復活させない');
 f.state(connected);f.setKOnly(true);f.events([greeting]);assert.equal(f.el('card-actions').hidden,false,'後から本人参加しても家族のみモードのstyleで隠さない');
 f.events([greeting],'cached');await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,0,'未確認の元連絡へは返信しない');
}
{
 const f=fixture();f.state(connected);f.events([greeting]);let release;
 f.c.addEvent=payload=>{f.writes.push(payload);return new Promise(resolve=>release=resolve);};
 const pending=f.c.replyToPersonEvent('hello-1');await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,1);release();await pending;
 f.c.addEvent=async()=>{throw Error('offline');};await f.c.replyToPersonEvent('hello-1');assert.match(f.el('person-reply-state-hello-1').textContent,/送れません/);
 f.c.addEvent=async p=>f.writes.push(p);await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,2,'失敗後に再試行できる');
}
{
 const f=fixture();f.state(connected);f.events([greeting]);f.c.openPersonContactReply('hello-1');f.el('in-family-message').value='おはよう、また電話するね';
 f.events([greeting,{...greeting,_id:'hello-2',text:'こんにちは',at:{seconds:2}}]);await f.c.sendFamilyMessage();
 assert.equal(f.writes[0].replyTo,'hello-1','入力中に新しい挨拶が来ても返信先を変更しない');assert.equal(f.writes[0].text,'おはよう、また電話するね');
 f.c.openPersonContactReply('hello-1');f.el('in-family-message').value='消さないで';f.c.addEvent=async()=>{throw Error('offline');};await f.c.sendFamilyMessage();
 assert.equal(f.el('in-family-message').value,'消さないで');assert.match(f.el('family-message-state').textContent,/入力は残っています/);
}
{
 const f=fixture();f.state(family);f.setAccount('person');const msg={_id:'back',type:'aisatsu-back',text:'おはよう',name:'家族',at:{seconds:2}};
 f.c.renderPersonConversation([msg,{_id:'joined',type:'member-joined',text:'追加の人',at:{seconds:3}}],{fromCache:false});
 assert.equal(f.c.currentFamilyMessageId,'back','参加のお知らせで挨拶の返信先を消さない');
 f.c.renderPersonConversation([],{fromCache:false});assert.equal(f.c.currentFamilyMessageId,'');assert.equal(f.el('h-message-reply').style.display,'none');assert.equal(f.el('pop-msg').textContent,'');
 f.c.renderPersonConversation([msg],{fromCache:true});assert.equal(f.spoken.filter(t=>t.includes('おはよう')).length,0,'キャッシュを新着として読み上げない');
}
{
 const f=fixture();f.state(connected);f.events([greeting]);const session=f.c.communicationSession();
 f.setGroup('other-home');assert.equal(session(),false);
 f.c.resetCommunication();f.c.renderFamilyConversation();assert.doesNotMatch(f.el('ev-list').innerHTML,/hello-1/);
 f.state(solo);await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,0);
}
{
 const f=fixture();f.state(connected);f.events([greeting]);let releaseOld,releaseNew;
 f.c.addEvent=()=>new Promise(resolve=>releaseOld=resolve);
 const old=f.c.replyToPersonEvent('hello-1');assert.equal(f.el('btn-ab-asa').disabled,true);
 f.setGroup('new-home');f.c.resetCommunication();f.state(connected);f.events([greeting]);
 assert.equal(f.el('btn-ab-asa').disabled,false,'旧家庭の送信中を引き継がない');
 f.c.addEvent=()=>new Promise(resolve=>releaseNew=resolve);
 const fresh=f.c.replyToPersonEvent('hello-1');assert.equal(f.el('btn-ab-asa').disabled,true);
 releaseOld();await old;assert.equal(f.el('btn-ab-asa').disabled,true,'旧finallyが新送信のbusyを解除しない');
 releaseNew();await fresh;assert.equal(f.el('btn-ab-asa').disabled,false);
}
{
 const f=fixture();f.state(connected);f.events([greeting]);f.el('in-family-message').value='旧家庭へのメッセージ';let reject;
 f.c.addEvent=()=>new Promise((resolve,fail)=>reject=fail);const old=f.c.sendFamilyMessage();
 f.setGroup('new-home');f.c.resetCommunication();f.state(connected);f.el('family-message-state').textContent='新家庭の表示';
 reject(Error('offline'));await old;assert.equal(f.el('family-message-state').textContent,'新家庭の表示','旧家庭の失敗で新しい画面を上書きしない');
}
assert.doesNotMatch(html,/試験運用中｜実名・住所・電話・病歴は入力しないでください/);
assert.ok(html.indexOf('id="card-actions"')<html.indexOf('id="card-next-yotei"'));
assert.doesNotMatch(html,/<details[^>]*id="family-person-contact"/);
assert.match(html,/onSnapshot\(\{includeMetadataChanges:true\},snap=>\{\s*if\(!conversationCurrent\(\)\)return/);
assert.match(html,/onSnapshot\(\{includeMetadataChanges:true\},snap=>\{\s*if\(!personConversationCurrent\(\)\)return/);
console.log('communication flow: generated greeting button → family reply → person thanks, cache/approval, drafts, errors, stale household passed');
