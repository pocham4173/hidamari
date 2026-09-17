import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {classify}=createRequire(import.meta.url)('../family-connection.js');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(a,b){const i=html.indexOf(a),j=html.indexOf(b,i);assert.ok(i>=0&&j>i,a);return html.slice(i,j);}
function htmlText(value){return String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
class Element{
 constructor(){this._text='';this._html='';this._buttons=[];this.attributes={};this.value='';this.style={};this.hidden=false;this.disabled=false;this.dataset={};const classes=new Set();this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle:(name,on)=>{if(on)classes.add(name);else classes.delete(name);}};}
 set textContent(v){this._text=String(v);this._html='';this._buttons=[];}get textContent(){return this._text;}
 set innerHTML(v){
  this._html=String(v);this._text='';this._buttons=[];
  // Parse the actual generated controls, including data attributes and disabled.
  // The test must exercise the renderer's controls, not unrelated placeholder buttons.
  for(const match of this._html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)){
   const button=new Element();button.tagName='BUTTON';button.parentElement=this;
   for(const attr of match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g))button.setAttribute(attr[1],htmlText(attr[2]??''));
   button.disabled=Object.hasOwn(button.attributes,'disabled');button.textContent=htmlText(match[2].replace(/<[^>]*>/g,''));this._buttons.push(button);
  }
 }
 get innerHTML(){return this._html;}
 setAttribute(name,value){this.attributes[name]=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 addEventListener(name,handler){(this.handlers??={})[name]=handler;}
 focus(){this.focused=true;}scrollIntoView(){}contains(node){return this._buttons.includes(node);}
 querySelectorAll(selector){return selector==='button'?this._buttons:[];}
}
function fixture(){
 const els=new Map(),writes=[],alerts=[],spoken=[],storage=new Map();let account='family',group='home',kOnly=false;
 const el=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);};
 el('card-actions').dataset.communicationGate='person';el('h-message-reply').dataset.communicationGate='family';
 const personSend=el('btn-ab-asa');personSend.dataset.sendAudience='person';
 const familySend=el('person-thanks');familySend.dataset.sendAudience='family';
 const c={document:{getElementById:el,querySelectorAll:sel=>sel==='[data-communication-gate]'?[el('card-actions'),el('h-message-reply')]:sel==='[data-send-audience]'?[personSend,familySend,...el('ev-list').querySelectorAll('button').filter(button=>button.dataset.sendAudience)]:sel==='#h-message-reply [data-send-audience="family"]'?[familySend]:[],removeEventListener(){}},uid:()=>account,gid:()=>group,isKOnly:()=>kOnly,householdBootGeneration:1,honninSending:false,
   currentFamilyMessageId:'',hMsgSpokenThrough:0,aisatsuBackSending:false,askKusuriSending:false,familyMessageSending:false,
   personMessageReplySending:false,onegaiBackFreeId:'',previewStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},todayStr:()=> '2026-09-17',feedback(){},speak:t=>spoken.push(t),timeYomi:v=>v,
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
 function replyButtons(id){return el('ev-list').querySelectorAll('button').filter(button=>button.dataset.replyTo===id);}
 async function click(button){assert.ok(button,'generated button exists');assert.equal(button.disabled,false,'generated button is enabled');return await vm.runInContext(button.getAttribute('onclick'),c);}
 return {c,el,writes,alerts,spoken,storage,state,events,replyButtons,click,setAccount:v=>account=v,setGroup:v=>group=v,setKOnly:v=>kOnly=v};
}
const connected={status:'shared',others:1,personOthers:1,familyOthers:0};
const family={status:'shared',others:1,personOthers:0,familyOthers:1};
const solo={status:'solo',others:0,personOthers:0,familyOthers:0};
const unknown={status:'unknown',others:null,personOthers:null,familyOthers:null};
const greeting={_id:'hello-1',type:'aisatsu',text:'おはよう',slot:'asa',uid:'person',at:{seconds:1}};
const legacyMembers={metadata:{fromCache:false,hasPendingWrites:false},forEach:fn=>[['family','kazoku'],['person','honnin']].forEach(([id,role])=>fn({id,data:()=>({role})}))};
{
 const f=fixture();f.state(classify(legacyMembers,'family'));f.events([greeting]);
 assert.equal(f.el('card-actions').hidden,false,'旧い参加情報から実際の返信欄まで表示される');
 assert.match(f.el('ev-list').innerHTML,/おはよう.*を返す/);
 const quick=f.replyButtons('hello-1').find(button=>button.getAttribute('onclick').startsWith('replyToPersonEvent'));
 await f.click(quick);assert.equal(f.writes.length,1);
 assert.equal(f.writes[0].text,'おはよう','生成したonclickを実行しても日本語が失われない');
 assert.equal(f.writes[0].replyTo,'hello-1');assert.equal(f.writes[0].type,'aisatsu-back');
 const response={...f.writes[0],_id:'response-1',uid:'family',at:{seconds:2}};
 f.events([greeting,response]);assert.match(f.el('ev-list').innerHTML,/あなたは返事を送りました/);
 assert.ok(f.el('ev-list').querySelectorAll('button').some(button=>button.disabled&&button.textContent==='返事を送りました'),'返事済みはその場所に残す');
 const continuation=f.replyButtons('hello-1').find(button=>button.dataset.replyAgain==='true');
 assert.equal(continuation.textContent,'続けて言葉を送る');await f.click(continuation);
 f.el('in-family-message').value='午後に電話するね';await f.c.sendFamilyMessage();
 assert.equal(f.writes[1].replyTo,'hello-1','返事済みからの追伸も元の挨拶につながる');assert.equal(f.writes[1].text,'午後に電話するね');
 f.setAccount('person');f.state(classify(legacyMembers,'person'));f.c.renderPersonConversation([response],{fromCache:false});
 assert.equal(f.c.currentFamilyMessageId,'response-1');assert.equal(f.el('h-message-reply').style.display,'block');
 assert.match(f.el('h-incoming-message').textContent,/おはよう/);assert.equal(f.el('h-reply-context').textContent,'上の連絡への返事です。');
 await f.c.sendFamilyMessageBack('ありがとう');assert.equal(f.writes.at(-1).text,'ありがとう');assert.equal(f.writes.at(-1).replyTo,'response-1');
 f.setAccount('family');f.state(classify(legacyMembers,'family'));f.events([greeting,response,{...f.writes.at(-1),_id:'thanks-1',uid:'person',at:{seconds:3}}]);
 assert.match(f.el('ev-list').innerHTML,/ご本人からの返事：「ありがとう」/);
}
{
 const f=fixture();f.state(unknown);assert.equal(f.el('card-actions').hidden,false);assert.equal(f.el('btn-ab-asa').disabled,true);
 f.state(connected);f.events([greeting]);assert.equal(f.el('card-actions').hidden,false);assert.equal(f.el('btn-ab-asa').disabled,false);
 f.state(unknown);assert.equal(f.el('card-actions').hidden,false);assert.equal(f.el('btn-ab-asa').disabled,true);
 const before=f.el('ev-list').innerHTML;await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,0);assert.equal(f.el('ev-list').innerHTML,before);
 f.state(solo);assert.equal(f.el('card-actions').hidden,false,'以前の会話は相手不在でも読める');
 assert.ok(f.replyButtons('hello-1').every(button=>button.disabled),'相手不在では返信できない');
 f.events([]);assert.equal(f.el('card-actions').hidden,true);f.state(unknown);assert.equal(f.el('card-actions').hidden,true,'会話のない確認済み一人の家庭に家族欄を復活させない');
 f.state(connected);f.setKOnly(true);f.events([greeting]);assert.equal(f.el('card-actions').hidden,false,'後から本人参加しても家族のみモードのstyleで隠さない');
 f.events([greeting],'cached');assert.ok(f.replyButtons('hello-1').every(button=>button.disabled),'通信未確認は実際の返信ボタンを無効にする');await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,0,'未確認の元連絡へは返信しない');
}
{
 const f=fixture();f.state(connected);f.events([greeting]);let release;
 f.c.addEvent=payload=>{f.writes.push(payload);return new Promise(resolve=>release=resolve);};
 const pending=f.c.replyToPersonEvent('hello-1');assert.ok(f.replyButtons('hello-1').every(button=>button.disabled),'送信中の実ボタンは無効');await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,1);release();await pending;
 await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,1,'成功後はサーバー購読の返答を待たず重複送信を防ぐ');
 f.events([greeting]);assert.match(f.el('ev-list').innerHTML,/あなたは返事を送りました/);
 assert.ok(f.el('ev-list').querySelectorAll('button').some(button=>button.disabled&&button.textContent==='返事を送りました'));
 const continuation=f.replyButtons('hello-1').find(button=>button.dataset.replyAgain==='true');
 assert.ok(continuation);assert.equal(continuation.disabled,false,'購読反映前も続けて書くボタンは使える');
 assert.equal(f.replyButtons('hello-1').some(button=>button.getAttribute('onclick').startsWith('replyToPersonEvent')),false,'済んだ定型返信を再送する操作にはしない');
}
{
 const f=fixture();f.state(connected);f.events([greeting]);let reject;
 f.c.addEvent=()=>new Promise((resolve,fail)=>reject=fail);const pending=f.c.replyToPersonEvent('hello-1');
 f.events([greeting],'cached');assert.match(f.el('ev-list').innerHTML,/返事を送っています/);
 reject(Error('offline'));await pending;assert.match(f.el('ev-list').innerHTML,/save-state err[^>]*[\s\S]*?送れません/,'失敗は置き換え後のDOMにも出る');
 f.events([greeting]);assert.match(f.el('ev-list').innerHTML,/送れません/,'購読で再描画しても再試行の案内を失わない');
 f.c.addEvent=async p=>f.writes.push(p);await f.c.replyToPersonEvent('hello-1');assert.equal(f.writes.length,1,'失敗後に再試行できる');
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
 f.c.renderPersonConversation([],{fromCache:false});assert.equal(f.c.currentFamilyMessageId,'');assert.equal(f.el('h-message-reply').style.display,'none');assert.equal(f.el('h-incoming-message').textContent,'');
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
{
 const f=fixture();f.setAccount('person');f.state(family);
 f.c.setTimeout=()=>1;f.c.clearTimeout=()=>{};
 vm.runInContext(section('let personSendWaitTimer=','function sendAisatsu(){'),f.c);
 const message={_id:'earlier-message',type:'family-message',text:'前に届いた家族の連絡',name:'家族',at:{seconds:2}};
 f.c.renderPersonConversation([message],{fromCache:false});
 f.c.beginSend();assert.equal(f.el('pop-msg').textContent,'記録を保存しています…');
 f.c.renderPersonConversation([message],{fromCache:false});
 assert.equal(f.el('pop-msg').textContent,'記録を保存しています…','自分の保存中に旧受信内容で保存表示を上書きしない');
 assert.match(f.el('h-incoming-message').textContent,/前に届いた家族の連絡/);
 f.c.endSend(true);assert.equal(f.el('pop-msg').textContent,'記録しました。');
 f.c.renderPersonConversation([message],{fromCache:false});assert.equal(f.el('pop-msg').textContent,'記録しました。');
 f.c.renderPersonConversation([],{fromCache:false});assert.equal(f.el('h-incoming-message').textContent,'');assert.equal(f.el('pop-msg').textContent,'記録しました。','受信取消しで自分の保存結果を消さない');
}
for(const fail of [false,true]){
 const f=fixture();f.setAccount('person');f.state(family);
 const first={_id:'A',type:'family-message',text:'Aの連絡',name:'家族',at:{seconds:2}};
 const second={_id:'B',type:'family-message',text:'Bの連絡',name:'家族',at:{seconds:3}};
 f.c.renderPersonConversation([first],{fromCache:false});let complete;
 f.c.addEvent=payload=>{f.writes.push(payload);return new Promise((resolve,reject)=>complete=fail?()=>reject(Error('offline')):resolve);};
 const pending=f.c.sendFamilyMessageBack('ありがとう');assert.equal(f.writes[0].replyTo,'A');
 f.c.renderPersonConversation([first,second],{fromCache:false});assert.equal(f.c.currentFamilyMessageId,'B');
 assert.equal(f.el('person-thanks').dataset.replyTo,'B');assert.equal(f.el('h-message-reply-state').textContent,'');
 complete();await pending;
 assert.equal(f.el('h-message-reply-state').textContent,'','Aの送信結果をBの下に表示しない');
 assert.match(f.el('h-incoming-message').textContent,/Bの連絡/);assert.equal(f.el('person-thanks').disabled,false);
 f.c.renderPersonConversation([first],{fromCache:false});
 assert.match(f.el('h-message-reply-state').textContent,fail?/送信できません/:/この連絡には返事を送りました/,'元の連絡に戻れば対応する結果を表示する');
 if(!fail){await f.c.sendFamilyMessageBack('ありがとう');assert.equal(f.writes.length,1,'本人の成功も購読反映前の重複送信を防ぐ');}
}
{
 const f=fixture();f.setAccount('person');f.state(family);
 const earlier={_id:'z-early',type:'family-message',text:'同じ秒の先の連絡',at:{seconds:10,nanoseconds:100}};
 const later={_id:'a-later',type:'family-message',text:'同じ秒の後の連絡',at:{seconds:10,nanoseconds:200}};
 f.c.renderPersonConversation([earlier],{fromCache:false});
 f.c.renderPersonConversation([later,earlier],{fromCache:false});
 assert.equal(f.c.currentFamilyMessageId,'a-later');assert.match(f.el('h-incoming-message').textContent,/同じ秒の後/);
 assert.equal(f.spoken.length,2,'同じ秒でも後の新着は読み上げる');
 f.c.renderPersonConversation([earlier,later],{fromCache:false});assert.equal(f.spoken.length,2,'同じ新着を再読み上げしない');
 const saved=JSON.parse(f.storage.get('mainicoMessageCursor:home:person'));assert.equal(saved.at.nanoseconds,200);assert.equal(saved._id,'a-later');
 f.setAccount('family');f.state(connected);
 f.events([{...greeting,_id:'z-early',text:'早い挨拶',at:earlier.at},{...greeting,_id:'a-later',text:'遅い挨拶',at:later.at}]);
 assert.match(f.el('ev-list').innerHTML,/遅い挨拶/);assert.match(f.el('ev-list').innerHTML,/早い挨拶/,'新しい挨拶でも前の挨拶を消さない');
 assert.ok(f.el('ev-list').innerHTML.indexOf('遅い挨拶')<f.el('ev-list').innerHTML.indexOf('早い挨拶'),'ナノ秒を含めて新しい会話から表示する');
 assert.equal(f.replyButtons('z-early').length,2,'前の挨拶にも定型・自由文の返信がある');
}
for(const cached of [true,false]){
 const f=fixture();f.setAccount('person');f.state(family);
 const message={_id:'reply-original',type:'family-message',text:'元の連絡',at:{seconds:2}};
 f.c.renderPersonConversation([message],{fromCache:false});f.c.openPersonMessageReply();
 f.el('person-message-reply-text').value='書きかけの返事';
 f.c.renderPersonConversation(cached?[message]:[],{fromCache:cached});
 await f.c.sendPersonMessageReply();
 assert.equal(f.writes.length,0,cached?'通信未確認の元連絡へ送らない':'取り消された元連絡へ送らない');
 assert.equal(f.el('person-message-reply-text').value,'書きかけの返事');assert.equal(f.el('person-message-reply-modal').classList.contains('show'),true);
 assert.match(f.el('person-message-reply-state').textContent,/入力は残っています/);
 if(cached){assert.equal(f.el('person-thanks').disabled,true);assert.match(f.el('h-contact-state').textContent,/保存した連絡/);}
}
{
 const f=fixture();f.state(connected);f.events([greeting]);f.c.openPersonContactReply('hello-1');f.el('in-family-message').value='残したい返事';
 f.events([]);await f.c.sendFamilyMessage();assert.equal(f.writes.length,0);assert.equal(f.el('in-family-message').value,'残したい返事');
 assert.match(f.alerts.at(-1),/元の連絡を確認できません/);
}
{
 const f=fixture();f.setAccount('person');f.state(family);
 const message={_id:'before-error',type:'family-message',text:'通信前の連絡',at:{seconds:2}};
 f.c.renderPersonConversation([message],{fromCache:false});
 vm.runInContext("personConversationStatus='error';updateCommunicationAvailability();",f.c);
 f.state(family);assert.match(f.el('h-contact-state').textContent,/確認できませんでした/,'参加者の再取得で連絡の通信エラーを消さない');
 assert.equal(f.el('person-thanks').disabled,true);await f.c.sendFamilyMessageBack('ありがとう');assert.equal(f.writes.length,0);
}
assert.doesNotMatch(html,/試験運用中｜実名・住所・電話・病歴は入力しないでください/);
assert.ok(html.indexOf('id="card-actions"')<html.indexOf('id="card-next-yotei"'));
assert.doesNotMatch(html,/<details[^>]*id="family-person-contact"/);
assert.match(html,/onSnapshot\(\{includeMetadataChanges:true\},snap=>\{\s*if\(!conversationCurrent\(\)\)return/);
assert.match(html,/onSnapshot\(\{includeMetadataChanges:true\},snap=>\{\s*if\(!personConversationCurrent\(\)\)return/);
console.log('communication flow: greeting roundtrip, separate save/receive, target-bound status, nanosecond order, cached/deleted targets, redraw-safe retry, approval and stale household passed');

// Run the actual delayed press controller and the actual person reply onclick together.
{
 const f=fixture();f.state(family);f.setAccount('person');
 const a={_id:'press-A',type:'family-message',text:'Aの連絡',at:{seconds:20}},b={_id:'press-B',type:'family-message',text:'Bの連絡',at:{seconds:21}};
 const handlers={},timers=[];let completion;
 const button=f.el('person-thanks');button.isConnected=true;
 button.closest=selector=>selector==='[hidden]'?null:button;button.getClientRects=()=>[{}];
 const actualClick=html.match(/onclick="(sendFamilyMessageBack\('ありがとう'[^\"]+)"/)[1];
 button.click=()=>{const event={target:button,detail:0,preventDefault(){},stopImmediatePropagation(){this.stopped=true;}};handlers.click(event);if(!event.stopped)completion=vm.runInContext('(function(){'+actualClick.replace('sendFamilyMessageBack','return sendFamilyMessageBack')+'}).call(replyButton)',f.c);};
 f.c.replyButton=button;f.c.window={uid:f.c.uid,gid:f.c.gid,addEventListener:(name,fn)=>handlers[name]=fn};
 f.c.document.addEventListener=(name,fn)=>handlers[name]=fn;f.c.document.hidden=false;f.el('honnin').classList.add('active');
 f.c.setTimeout=(fn,ms)=>{assert.equal(ms,650);timers.push(fn);return timers.length;};f.c.clearTimeout=()=>{};
 vm.runInContext(fs.readFileSync(new URL('../person-button-feedback.js',import.meta.url),'utf8'),f.c);
 f.c.renderPersonConversation([a],{fromCache:false});button.click();
 assert.equal(f.writes.length,0);
 f.c.renderPersonConversation([a,b],{fromCache:false});timers.shift()();
 assert.equal(f.writes.length,0,'actual renderer + delayed controller must not send A response to new B');
 assert.match(f.el('h-message-reply-state').textContent,/新しい連絡/);
 button.click();timers.shift()();await completion;
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].replyTo,'press-B');assert.equal(f.writes[0].text,'ありがとう');
}
console.log('communication + press integration: new-arrival cancellation and deliberate next reply passed');

// Reloaded replies must also preserve a way to continue the same conversation.
{
 const f=fixture();f.state(connected);
 const savedReply={_id:'saved-reply',type:'aisatsu-back',text:'おはよう',replyTo:'hello-1',uid:'family',name:'家族',at:{seconds:2}};
 f.events([greeting,savedReply]);
 assert.ok(f.el('ev-list').querySelectorAll('button').some(button=>button.disabled&&button.textContent==='返事を送りました'));
 const continuation=f.replyButtons('hello-1').find(button=>button.dataset.replyAgain==='true');
 await f.click(continuation);f.el('in-family-message').value='朝の挨拶に追伸です';
 f.events([greeting,savedReply,{...greeting,_id:'later-greeting',text:'こんにちは',slot:'hiru',at:{seconds:3}}]);
 await f.c.sendFamilyMessage();
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].replyTo,'hello-1','再表示後も新着に返信先をすり替えない');
 assert.equal(f.writes[0].text,'朝の挨拶に追伸です');
}
console.log('conversation discovery integration: generated controls, completed markers, continuation and original reply target passed');

// The missing-conversation entry opens the actual settings section without changing data.
{
 const f=fixture();let opened=0;
 f.c.openSettings=()=>opened++;
 vm.runInContext(section('function openConversationConnection(){','async function renderSetMembers(){'),f.c);
 f.c.openConversationConnection();
 assert.equal(opened,1);assert.equal(f.el('conversation-connection-guide').open,true);
 assert.equal(f.el('settings-family-connection').focused,true);
 assert.equal(f.writes.length,0);
 assert.match(html,/id="conversation-setup-entry"[^>]*onclick="openConversationConnection\(\)"/);
}
// Settings identifies the current selected screen, including legacy registrations.
{
 const f=fixture();const rows=[
   {id:'family',data:()=>({name:'家族',role:'kazoku'})},
   {id:'person',data:()=>({name:'<本人>',role:'kazoku',mode:'honnin'})},
   {id:'switched',data:()=>({name:'変更した人',role:'honnin',mode:'konly'})},
 ];
 Object.assign(f.c,{MainicoFamilyConnection:createRequire(import.meta.url)('../family-connection.js'),
   col:()=>({get:async()=>({empty:false,forEach:fn=>rows.forEach(fn)})}),rememberMember:id=>id,isHouseholdOwner:()=>false,householdOwnerId:'family'});
 vm.runInContext(section('async function renderSetMembers(){','/* 家族の設定画面が開いているときだけ'),f.c);
 await f.c.renderSetMembers();
 assert.match(f.el('set-members').innerHTML,/家族 \(家族の画面\) \(このアカウント\)/);
 assert.match(f.el('set-members').innerHTML,/&lt;本人&gt; \(本人の画面\)/);
 assert.match(f.el('set-members').innerHTML,/変更した人 \(家族の画面\)/);
 assert.equal(f.writes.length,0);
}
console.log('connection discovery: settings entry, current screens and legacy identities passed');
