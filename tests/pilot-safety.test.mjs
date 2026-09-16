import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);}
class Element {
  constructor(){this.value='';this.checked=false;this.textContent='';this.innerHTML='';this.children=[];this.style={};this.classList={add(){},remove(){},toggle(){}};}
  appendChild(c){this.children.push(c);return c;}
  replaceChildren(...children){this.children=children;this.textContent='';}
  addEventListener(event,fn){this[event]=fn;}
  setAttribute(){}
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

let listens=[],unsubscribed=0,received=[],resolveWrite;
const historyContext={requireFamilyFeature:()=>true,document:{getElementById:el,createElement:()=>new Element()},todayStr:()=> '2026-09-15',col:()=>({where:()=>({onSnapshot:(options,ok,error)=>{assert.equal(options.includeMetadataChanges,true);listens.push({ok,error});return ()=>unsubscribed++;}})}),kusuriQuestion:()=> '薬は飲みましたか',speak(){},addEvent:payload=>{received.push(payload);return new Promise(resolve=>resolveWrite=resolve);}};
vm.createContext(historyContext);vm.runInContext(section('let personHistoryUnsub=', '/* 出典 https://www.city.ueda'),historyContext);
historyContext.openPersonHistory();const snap=(data,cached=false)=>({metadata:{fromCache:cached},forEach:fn=>data.forEach(v=>fn({id:v.id,data:()=>v}))});
listens[0].ok(snap([],true));assert.match(el('person-history-list').textContent,/分かりません/);
el('person-history-date').value='2026-09-14';historyContext.loadPersonHistory();assert.equal(unsubscribed,1);listens[0].ok(snap([]));assert.equal(el('person-history-state').textContent,'伝言を読み込んでいます…','旧日付の応答は表示しない');
listens[1].ok(snap([{id:'old-message',type:'family-message',text:'昨日の伝言',at:{seconds:1}}]));assert.equal(el('person-history-list').children.length,1);
const button=new Element(),state=new Element();const pending=historyContext.replyToHistory('old-message',button,state);await historyContext.replyToHistory('other',button,state);assert.equal(received.length,1);assert.equal(received[0].replyTo,'old-message');resolveWrite();await pending;assert.equal(button.disabled,false);
listens[1].error();assert.equal(el('person-history-list').children.length,0);assert.match(el('person-history-state').textContent,/読み込めません/);historyContext.closePersonHistory();assert.equal(unsubscribed,2);
console.log('✅ 日付別伝言は古い応答・キャッシュ・通信失敗を区別し、返信先を固定して連打を防ぐ');

let replyPayload,replyFailure=false;
const replies={communicationSession:()=>()=>true,requireFamilyFeature:()=>true,updateCommunicationAvailability(){},document:{getElementById:el},currentFamilyMessageId:'original-message',feedback(){},speak(){},addEvent:async payload=>{if(replyFailure)throw Error('offline');replyPayload=payload;}};
vm.createContext(replies);vm.runInContext(section('let personMessageReplySending=false;', 'function recKibun(text)'),replies);
replies.openPersonMessageReply();replies.currentFamilyMessageId='new-message';el('person-message-reply-text').value='ありがとう';
await replies.sendPersonMessageReply();assert.equal(replyPayload.replyTo,'original-message');
replies.openPersonMessageReply();el('person-message-reply-text').value='入力を残す';replyFailure=true;
await replies.sendPersonMessageReply();assert.match(el('person-message-reply-state').textContent,/入力は残っています/);assert.equal(el('person-message-reply-text').value,'入力を残す');
console.log('✅ 自由返信は入力開始時の伝言に届き、失敗時は入力画面にエラーを表示する');

// 開始ボタンは確認画面を開くだけ。削除の実行は別の明示操作に限る。
let opened=0;const deleting={openHouseholdDeletion:()=>opened++,col:()=>{throw Error('must not delete');},db:{batch:()=>{throw Error('must not mutate');}}};
vm.createContext(deleting);vm.runInContext(section('async function deleteAllData(){','/* 日付単位で伝言を読む。'),deleting);
await deleting.deleteAllData();assert.equal(opened,1);
console.log('✅ 全体削除の入口は確認画面だけを開き、その場ではデータを変更しない');
