import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);}
class Element {
  constructor(){this.value='';this.checked=false;this.textContent='';this.innerHTML='';this.children=[];this.style={};const classes=new Set();this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)};}
  appendChild(c){this.children.push(c);return c;}
  replaceChildren(...children){this.children=children;this.textContent='';}
  addEventListener(event,fn){this[event]=fn;}
  setAttribute(){}
  focus(){this.focused=true;}
  contains(el){return this===el||this.children.some(c=>c.contains(el));}
  querySelectorAll(){return [];}
}
const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
let saved=null,writes=0,failSave=false,failQr=false,clock='2026年9月15日';
const qr={addData(){},make(){if(failQr)throw Error('QR failed');},createImgTag(){return '<img alt="test QR">';}};
const context={document:{getElementById:el},localStorage:{getItem:()=>saved,setItem:(key,value)=>{if(failSave)throw Error('quota');writes++;saved=value;},removeItem:()=>{throw Error('blocked');}},DISASTER_QR_KEY:'test',qrcode:()=>qr,esc:v=>String(v),confirm:()=>true};
vm.createContext(context);
vm.runInContext(section('function resetDisasterConsent(){','\n\n</script>'),context);
context.disasterUpdatedAt=()=>clock;
el('disaster-name').value='テスト';el('disaster-phone').value='000-0000-0000';el('disaster-relation').value='家族';el('disaster-help').value='ゆっくり話してください';
el('disaster-consent').checked=true;
context.makeDisasterQr();assert.equal(writes,0);assert.match(el('disaster-qr-state').textContent,/両方/);
el('disaster-contact-consent').checked=true;failQr=true;context.makeDisasterQr();assert.equal(writes,0,'QR生成失敗は保存しない');failQr=false;
failSave=true;context.makeDisasterQr();assert.equal(writes,0);assert.equal(el('disaster-name').value,'テスト');assert.match(el('disaster-qr-state').textContent,/保存できません/);failSave=false;
context.makeDisasterQr();assert.equal(writes,1);const original=JSON.parse(saved);assert.equal(original.consentVersion,2);assert.equal(original.createdAt,clock);assert.equal(el('disaster-consent').checked,false);
clock='2026年9月16日';el('disaster-consent').checked=true;el('disaster-contact-consent').checked=true;context.makeDisasterQr();assert.equal(JSON.parse(saved).createdAt,original.createdAt);assert.equal(JSON.parse(saved).updatedAt,clock);
context.deleteDisasterQr();assert.ok(saved);assert.equal(el('disaster-name').value,'テスト');assert.match(el('disaster-qr-state').textContent,/削除できません/);
saved=JSON.stringify({name:'旧QR',updatedAt:'2026年9月1日'});el('disaster-consent').checked=true;el('disaster-contact-consent').checked=true;context.makeDisasterQr();assert.equal(JSON.parse(saved).createdAt,'記録なし（旧QR）');
console.log('✅ 災害QRは双方の同意・保存失敗・削除失敗・日付継承・旧形式を処理する');

function historyFixture(){
  const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const listens=[],received=[],originals=new Map(),serverReplies=[];let unsubscribed=0,resolveWrite,rejectWrite,writeFailure=false,account='person',group='home',generation=1,connected=true,holdRead=null;
  const c={canUseFamilyFeature:()=>connected,requireFamilyFeature:()=>connected,uid:()=>account,gid:()=>group,
    communicationSession:()=>{const a=account,g=group,v=generation;return ()=>a===account&&g===group&&v===generation;},
    document:{getElementById:el,createElement:()=>new Element()},todayStr:()=> '2026-09-15',
    col:()=>({doc:id=>({get:async options=>{assert.equal(options.source,'server');if(holdRead)await holdRead;return {exists:originals.has(id),data:()=>originals.get(id),metadata:{fromCache:false}};}}),
      where:(field,op,value)=>({onSnapshot:(options,ok,error)=>{assert.equal(options.includeMetadataChanges,true);listens.push({ok,error});return ()=>unsubscribed++;},
        get:async options=>{assert.equal(field,'replyTo');assert.equal(options.source,'server');return {metadata:{fromCache:false},forEach:fn=>serverReplies.filter(v=>v.replyTo===value).forEach(v=>fn({data:()=>v}))};}})}),
    kusuriQuestion:()=> '薬は飲みましたか',speak(){},addEvent:payload=>{received.push(payload);return writeFailure?Promise.reject(Error('offline')):new Promise((resolve,reject)=>{resolveWrite=resolve;rejectWrite=reject;});}};
  vm.createContext(c);vm.runInContext(section('function compareConversationEvents(a,b){','function personReplyDone(id){'),c);
  vm.runInContext(section('/* Focus changes only when a person opens', 'let personMessageReplyTargetId='),c);
  vm.runInContext(section('let personHistoryUnsub=', '/* 出典 https://www.city.ueda'),c);
  const snap=(data,cached=false,pending=false)=>({metadata:{fromCache:cached,hasPendingWrites:pending},forEach:fn=>data.forEach(v=>fn({id:v.id,data:()=>v}))});
  const deliver=(data,cached=false,pending=false)=>{data.forEach(v=>originals.set(v.id,v));listens.at(-1).ok(snap(data,cached,pending));};
  const controls=()=>{const row=el('person-history-list').children.find(x=>x.children.some(c=>c.textContent==='この伝言に「読んだよ」と返す'));return row?{button:row.children[3],state:row.children[4]}:null;};
  return {c,el,listens,received,originals,serverReplies,snap,deliver,controls,get unsubscribed(){return unsubscribed;},release:()=>resolveWrite(),reject:()=>rejectWrite(Error('offline')),setFailure:v=>writeFailure=v,setGroup:v=>group=v,setAccount:v=>account=v,bumpGeneration:()=>generation++,setConnected:v=>connected=v,holdRead:v=>holdRead=v};
}
const oldMessage={id:'old-message',uid:'family',type:'family-message',text:'昨日の伝言',at:{seconds:1}};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
{
  const f=historyFixture();f.c.openPersonHistory();f.deliver([],true);assert.match(f.el('person-history-list').textContent,/分かりません/);
  f.el('person-history-date').value='2026-09-14';f.c.loadPersonHistory();assert.equal(f.unsubscribed,1);
  f.listens[0].ok(f.snap([]));assert.equal(f.el('person-history-state').textContent,'伝言を読み込んでいます…','旧日付の応答は表示しない');
  f.deliver([oldMessage],true);assert.equal(f.controls().button.disabled,true);await f.c.replyToHistory(oldMessage.id,f.controls().button,f.controls().state);assert.equal(f.received.length,0,'キャッシュからは返信しない');
  f.deliver([oldMessage],false,true);assert.equal(f.controls().button.disabled,true,'未確定書き込み中も返信しない');
  f.deliver([oldMessage]);const {button,state}=f.controls();const pending=f.c.replyToHistory(oldMessage.id,button,state);await flush();
  await f.c.replyToHistory(oldMessage.id,button,state);assert.equal(f.received.length,1);assert.equal(f.received[0].replyTo,oldMessage.id);f.release();await pending;
  assert.equal(button.disabled,true,'成功済み返信をそのまま再送しない');await f.c.replyToHistory(oldMessage.id,button,state);assert.equal(f.received.length,1);
  f.listens.at(-1).error();assert.equal(f.el('person-history-list').children.length,0);assert.match(f.el('person-history-state').textContent,/読み込めません/);
  f.c.closePersonHistory();assert.equal(f.unsubscribed,2);f.listens.at(-1).ok(f.snap([oldMessage]));assert.equal(f.el('person-history-list').children.length,0,'閉じた後の応答を破棄する');
}
{
  const f=historyFixture();f.c.openPersonHistory();f.deliver([oldMessage]);const {button,state}=f.controls();
  f.serverReplies.push({type:'family-message-back',replyTo:oldMessage.id,uid:'person',date:'2026-09-15'});
  await f.c.replyToHistory(oldMessage.id,button,state);assert.equal(f.received.length,0,'別の日付に送った自分の返事もサーバー確認して重複させない');assert.equal(button.disabled,true);
}
{
  const f=historyFixture();f.c.openPersonHistory();f.deliver([oldMessage]);const {button,state}=f.controls();f.originals.delete(oldMessage.id);
  await f.c.replyToHistory(oldMessage.id,button,state);assert.equal(f.received.length,0,'表示後に削除された元伝言には返信しない');assert.match(state.textContent,/送信できません/);
  f.deliver([oldMessage]);f.setFailure(true);const fresh=f.controls();await f.c.replyToHistory(oldMessage.id,fresh.button,fresh.state);assert.equal(fresh.button.disabled,false,'書き込み失敗後は再試行できる');
}
for(const switchContext of [f=>f.setGroup('other-home'),f=>f.setAccount('other-person'),f=>f.bumpGeneration()]){
  const f=historyFixture();f.c.openPersonHistory();f.deliver([oldMessage]);const {button,state}=f.controls();let release;
  f.holdRead(new Promise(resolve=>release=resolve));const pending=f.c.replyToHistory(oldMessage.id,button,state);switchContext(f);release();await pending;
  assert.equal(f.received.length,0,'確認中にUID/GID/世代が変わった返信を書かない');const before=f.el('person-history-state').textContent;f.listens[0].error();assert.equal(f.el('person-history-state').textContent,before,'別セッションのエラーで上書きしない');
}
{
  const f=historyFixture();f.c.openPersonHistory();f.deliver([oldMessage]);const {button,state}=f.controls();const pending=f.c.replyToHistory(oldMessage.id,button,state);await flush();
  f.c.closePersonHistory();f.c.openPersonHistory();f.el('person-history-state').textContent='新しく開いた画面';f.release();await pending;
  assert.equal(f.el('person-history-state').textContent,'新しく開いた画面','旧送信完了が新画面を変更しない');
}
{
  const f=historyFixture();f.c.openPersonHistory();f.deliver([oldMessage]);f.setConnected(false);f.c.refreshPersonHistoryReplyButtons();assert.equal(f.controls().button.disabled,true,'参加状態変更を反映する');
}
{
  const f=historyFixture();f.c.openPersonHistory();f.deliver([oldMessage]);const {button,state}=f.controls();const pending=f.c.replyToHistory(oldMessage.id,button,state);await flush();
  f.deliver([oldMessage]);assert.notEqual(f.controls().state,state);assert.match(f.controls().state.textContent,/送信しています/,'再描画しても送信中の状態を残す');
  f.reject();await pending;assert.match(f.controls().state.textContent,/送信できません/,'送信中の再描画後も現在の行に失敗を表示する');assert.equal(f.controls().button.disabled,false);
  f.deliver([oldMessage]);assert.match(f.controls().state.textContent,/送信できません/,'次の再描画でも失敗理由を消さない');
}
console.log('✅ 日付別伝言はUID/GID/世代・日付・キャッシュ・元伝言削除・別日付の返信重複・旧送信完了を安全に扱う');

let replyPayload,replyFailure=false,replyWrites=0;
const replies={communicationSession:()=>()=>true,requireFamilyFeature:()=>true,uid:()=> 'person',alert(){},updateCommunicationAvailability(){},document:{getElementById:el},currentFamilyMessageId:'original-message',feedback(){},speak(){},addEvent:async payload=>{replyWrites++;if(replyFailure)throw Error('offline');replyPayload=payload;}};
vm.createContext(replies);
vm.runInContext(section('/* Conversation state is scoped','function communicationSession(){'),replies);
vm.runInContext(section('let personMessageReplySending=false;', 'function recKibun(text)'),replies);
vm.runInContext("personConversationStatus='ready';personConversationItems=[{_id:'original-message',type:'family-message'},{_id:'new-message',type:'aisatsu-back'}];",replies);
replies.openPersonMessageReply();replies.currentFamilyMessageId='new-message';el('person-message-reply-text').value='ありがとう';
await replies.sendPersonMessageReply();assert.equal(replyPayload.replyTo,'original-message');
assert.equal(el('h-message-reply-state').textContent,'','旧伝言の送信結果を新着の返事として表示しない');
await replies.sendFamilyMessageBack('ありがとう','original-message');assert.equal(replyWrites,1,'成功した返事を同じ画面から重複送信しない');
replies.openPersonMessageReply();el('person-message-reply-text').value='入力を残す';replyFailure=true;
await replies.sendPersonMessageReply();assert.match(el('person-message-reply-state').textContent,/入力は残っています/);assert.equal(el('person-message-reply-text').value,'入力を残す');
const writesBefore=replyWrites;
vm.runInContext("personConversationStatus='cached';",replies);await replies.sendPersonMessageReply();assert.equal(replyWrites,writesBefore,'未確認データには返信しない');
vm.runInContext("personConversationStatus='ready';personConversationItems=[];",replies);await replies.sendPersonMessageReply();assert.equal(replyWrites,writesBefore,'入力中に消えた元伝言には返信しない');assert.equal(el('person-message-reply-text').value,'入力を残す');
console.log('✅ 自由返信は対象を固定し、新着との表示混同・重複・削除済みへの返信を防ぎ、失敗時は入力を保持する');

// 開始ボタンは確認画面を開くだけ。削除の実行は別の明示操作に限る。
let opened=0;const deleting={openHouseholdDeletion:()=>opened++,col:()=>{throw Error('must not delete');},db:{batch:()=>{throw Error('must not mutate');}}};
vm.createContext(deleting);vm.runInContext(section('async function deleteAllData(){','/* 日付単位で伝言を読む。'),deleting);
await deleting.deleteAllData();assert.equal(opened,1);
console.log('✅ 全体削除の入口は確認画面だけを開き、その場ではデータを変更しない');
