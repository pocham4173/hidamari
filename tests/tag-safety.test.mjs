import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../tag.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture({storageBlocked=false,sdkMissing=false,invalid=false,anonymous=false}={}){
  const dom=new JSDOM(html,{url:'https://example.test/tag.html?id='+(invalid?'bad':'A'.repeat(32)),runScripts:'outside-only'});
  const w=dom.window,d=w.document,writes=[];let authCalls=0;
  if(storageBlocked)Object.defineProperty(w,'localStorage',{get(){throw Error('storage blocked');}});
  const alertRef={set(payload,options){return new Promise((resolve,reject)=>writes.push({payload,options,resolve,reject}));}};
  const alerts={doc(uid){assert.equal(uid,'finder');return alertRef;}};
  const tag={collection(name){assert.equal(name,'alerts');return alerts;}};
  const tags={doc(id){assert.equal(id,'A'.repeat(32));return tag;}};
  const db={collection(name){assert.equal(name,'watchTags');return tags;}};
  const auth={currentUser:anonymous?null:{uid:'finder'},signInAnonymously:async()=>{authCalls++;return {user:{uid:'finder'}};}};
  if(!sdkMissing)w.firebase={initializeApp:()=>({firestore:()=>db,auth:()=>auth}),firestore:{FieldValue:{increment:n=>({increment:n}),serverTimestamp:()=>({serverTime:true})}}};
  for(const script of d.querySelectorAll('script:not([src])'))w.eval(script.textContent);
  const select=value=>{const input=d.querySelector('[value="'+value+'"]');input.checked=true;input.dispatchEvent(new w.Event('change'));};
  return {w,d,writes,select,button:d.querySelector('#notify'),status:d.querySelector('#status'),get authCalls(){return authCalls;},close:()=>w.close()};
}
{
  const f=fixture();assert.equal(f.writes.length,0);assert.equal(f.authCalls,0,'開くだけで認証・送信しない');
  f.select('lost');f.button.click();await tick();assert.equal(f.writes.length,1);
  f.select('unwell');f.button.click();await tick();assert.equal(f.writes.length,1,'送信中の状況変更で二重送信しない');
  assert.equal(f.writes[0].payload.situation,'lost');
  assert.deepEqual(Object.keys(f.writes[0].payload).sort(),['count','createdAt','senderUid','situation','type']);
  f.writes[0].resolve();await tick();assert.match(f.status.textContent,/記録しました/);
  f.select('safe');f.button.click();await tick();assert.equal(f.writes.length,1,'保存済みの短時間再送を防ぐ');
  assert.doesNotMatch(f.status.textContent,/お知らせ済み/,'保存を相手の受信と表現しない');
  const later=f.w.Date.now()+11*60*1000;f.w.Date.now=()=>later;f.button.click();await tick();assert.equal(f.writes.length,2,'10分後は新しい状況を記録できる');f.writes[1].resolve();await tick();f.close();
}
{
  const f=fixture({storageBlocked:true});f.select('safe');f.button.click();await tick();assert.equal(f.writes.length,1,'端末保存不可でも記録できる');
  f.writes[0].resolve();await tick();assert.match(f.status.textContent,/記録しました/,'端末保存失敗を送信失敗としない');
  f.select('lost');f.button.click();await tick();assert.equal(f.writes.length,1,'ページ内の再送抑制は残す');f.close();
}
{
  const f=fixture();f.select('lost');f.button.click();await tick();f.writes[0].reject(Error('offline'));await tick();
  assert.equal(f.button.disabled,false);assert.match(f.status.textContent,/送信できません/);f.button.click();await tick();assert.equal(f.writes.length,2);
  f.writes[1].reject({code:'permission-denied'});await tick();assert.match(f.status.textContent,/停止済み|停止されて/);f.close();
}
for(const options of [{sdkMissing:true},{invalid:true}]){
  const f=fixture(options);f.select('lost');f.button.click();await tick();assert.equal(f.writes.length,0);
  assert.equal(f.d.querySelector('[href="tel:119"]').textContent.includes('119'),true);
  assert.equal(f.d.querySelector('[href="tel:110"]').textContent.includes('110'),true);
  assert.equal(f.button.disabled,true);assert.match(f.status.textContent,/確認|通信/);f.close();
}
{
  const f=fixture({anonymous:true});assert.equal(f.authCalls,0);f.select('called');f.button.click();await tick();assert.equal(f.authCalls,1);assert.equal(f.writes.length,1,'明示送信時だけ従来の匿名認証を使う');f.writes[0].resolve();await tick();f.close();
}
// 紙の支援カードは、保存済みで双方同意済みの場合だけ、QR部品なしでも印刷できる。
const section=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
const els=new Map(),el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',style:{}});return els.get(id);};
let saved={name:'テスト',relation:'家族',phone:'000-0000-0000',help:'筆談をお願いします',free:'<img src=x>',createdAt:'2026年10月29日',updatedAt:'2026年10月29日',consentVersion:2},prints=[];
const c={document:{getElementById:el},DISASTER_QR_KEY:'test',localStorage:{getItem:()=>JSON.stringify(saved)},esc:v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;'),alert(){},openPrintWindow:(title,body)=>prints.push({title,body})};
vm.createContext(c);vm.runInContext(section('function printDisasterQr(){','function printWatchTag(){'),c);
vm.runInContext(section('function disasterQrText(v){','function makeDisasterQr(){'),c);
c.renderDisasterQr(saved);assert.match(el('disaster-qr-preview').innerHTML,/printDisasterQr/,'QRなしでも保存済みカードを印刷する入口');
c.printDisasterQr();assert.equal(prints.length,1);assert.match(prints[0].body,/筆談/);assert.match(prints[0].body,/000-0000-0000/);assert.match(prints[0].body,/QR.*なし/);assert.doesNotMatch(prints[0].body,/<img/,'入力をHTMLにしない');
c.qrcode=()=>({addData(){},make(){throw Error('QR failed');}});c.printDisasterQr();assert.equal(prints.length,2,'QR生成失敗でも保存済みの紙カードを印刷');
saved={...saved,consentVersion:1};c.printDisasterQr();assert.equal(prints.length,2,'旧同意のカードは印刷しない');
saved={...saved,consentVersion:2};c.qrcode=()=>({addData(){},make(){},createImgTag:()=>'<img alt="test QR">'});c.printDisasterQr();assert.equal(prints.length,3);assert.match(prints[2].body,/<img alt="test QR">/,'通常はQR付き印刷を維持');
const guide=new JSDOM(app).window;assert.equal(guide.document.querySelector('#tag-choice-guide').open,false,'比較の説明は日常画面で広げない');
assert.ok(guide.document.querySelector('#tag-choice-guide a[href="https://www.city.ueda.nagano.jp/soshiki/korei/2692.html"]'));guide.close();
console.log('タグ：二重送信・端末保存不可・SDK不調・再試行・無操作時の送信なし／支援カード：QRなし印刷・同意・HTML保護 OK');
