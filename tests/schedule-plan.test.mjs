import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
/* 次の予定・くり返し登録・この日だけ変更(2026-10-13 ヒビルカから) */
const S=createRequire(import.meta.url)('../schedule-plan.js');
const at=s=>new Date(s); // UTC。日本時間は+9時間
const once=(v,from)=>v.date>=from?v.date:'';

/* 1. 次の予定: 日本時間で今日・明日。時間が過ぎた今日の予定は「次」にしない(終わったとは扱わない) */
{
  const list=[{_id:'a',label:'通院',date:'2026-10-13',time:'09:00'},{_id:'b',label:'買い物',date:'2026-10-13',time:'14:00'},
    {_id:'c',label:'デイサービス',date:'2026-10-14',time:'09:00'},{_id:'d',label:'訪問',date:'2026-10-14',time:''},{_id:'e',label:'昼食',date:'2026-10-14',time:'12:00'}];
  let n=S.nextUp(list,once,at('2026-10-13T02:30:00Z')); // 11:30 JST
  assert.equal(n.item._id,'b');assert.equal(n.when,'今日');assert.equal(n.days,0);
  n=S.nextUp(list,once,at('2026-10-13T06:00:00Z')); // 15:00 JST
  assert.equal(n.item._id,'c','time already passed today is not next');assert.equal(n.when,'明日');
  assert.deepEqual(n.others.map(x=>x._id),['e','d'],'same-day others in time order; no-time items last, time not invented');
  n=S.nextUp(list,once,at('2026-10-12T15:30:00Z')); // 10/13 0:30 JST (UTC is still 10/12)
  assert.equal(n.today,'2026-10-13','Tokyo date, not UTC');assert.equal(n.item._id,'a');
  assert.equal(S.nextUp([{label:'x',date:'2026-10-20',time:''}],once,at('2026-10-13T00:00:00Z')).when,'10月20日（火）');
  assert.equal(S.nextUp([{label:'x',date:'2026-10-20',time:''}],once,at('2026-10-13T00:00:00Z')).days,7);
  assert.equal(S.nextUp([{label:'old',date:'2026-10-01'}],once,at('2026-10-13T00:00:00Z')),null,'past events never stay as next');
  assert.equal(S.nextUp([],once,at('2026-10-13T00:00:00Z')),null);
}
/* 2. くり返しの日付 */
{
  assert.deepEqual(S.repeatDates('2026-10-14','weekly',{count:3}).dates,['2026-10-14','2026-10-21','2026-10-28']);
  assert.deepEqual(S.repeatDates('2026-10-14','weekly',{until:'2026-11-04'}).dates,['2026-10-14','2026-10-21','2026-10-28','2026-11-04'],'until is inclusive');
  assert.deepEqual(S.repeatDates('2026-01-31','monthly',{count:4},'last').dates,['2026-01-31','2026-02-28','2026-03-31','2026-04-30'],'month end');
  assert.deepEqual(S.repeatDates('2026-01-31','monthly',{count:4},'skip').dates,['2026-01-31','2026-03-31','2026-05-31','2026-07-31'],'skip months without the day');
  assert.deepEqual(S.repeatDates('2027-12-15','monthly',{count:3}).dates,['2027-12-15','2028-01-15','2028-02-15'],'year boundary');
  assert.equal(S.needsShortRule('2026-01-29','monthly'),true);assert.equal(S.needsShortRule('2026-01-28','monthly'),false);assert.equal(S.needsShortRule('2026-01-31','weekly'),false);
  assert.equal(S.repeatDates('2026-10-14','weekly',{count:61}).ok,false);assert.equal(S.repeatDates('2026-10-14','weekly',{count:1}).ok,false);
  assert.equal(S.repeatDates('2026-10-14','weekly',{until:'2026-10-01'}).ok,false);
  assert.match(S.repeatDates('2026-10-14','weekly',{until:'2028-10-01'}).message,/60回まで/);
  assert.equal(S.repeatDates('2026-10-14','weekly',{count:60}).dates.length,60);
  const id=S.docId(S.newSeries(),'2026-10-14');assert.match(id,/^s[a-z0-9]{10}_20261014$/);assert.equal(S.seriesOf(id),id.slice(0,11));assert.equal(S.seriesOf('Ab3xYZ'),'');
}

/* 3. 画面: 家族のくり返し登録・二重防止・失敗時の正直な表示・この日だけ・この日から後 */
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(from,to){const a=html.indexOf(from),b=html.indexOf(to,a);assert.ok(a>=0&&b>a,from);return html.slice(a,b);}
function setup(clock){
  const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'});
  const c=dom.getInternalVMContext(),d=dom.window.document;
  const RealDate=Date;
  class Clock extends RealDate{constructor(...a){super(...(a.length?a:[clock]));}static now(){return new RealDate(clock).getTime();}}
  const store=new Map(),writes=[],deletes=[];let failIds=new Set(),hang=false;
  class TS{constructor(dt){this.dt=dt;}toDate(){return new RealDate(this.dt);}static fromDate(dt){return new TS(dt);}}
  Object.assign(c,{Date:Clock,uid:()=> 'me',speak(){},feedback(){},esc:s=>String(s),appConfirm:async()=>true,
    firebase:{firestore:{FieldValue:{serverTimestamp:()=> 'NOW',delete:()=> 'DEL'},Timestamp:TS}},
    col:()=>({doc:id=>({set:row=>{writes.push({id,row});if(hang)return new Promise(()=>{});if(failIds.has(id))return Promise.reject(new Error('offline'));store.set(id,row);c.yoteiCache.push({...row,_id:id});return Promise.resolve();},
      update:()=>Promise.resolve(),delete:()=>{deletes.push(id);c.yoteiCache=c.yoteiCache.filter(x=>x._id!==id);return Promise.resolve();}})}),
    MainicoLine:{shiftForDate(){},renderWho(){},toInputValue:()=> '',describe:()=> ''},
    lineNotifyInput:()=>({ok:true,fields:c.__notify||{notifyAt:null}}),setYoteiCategory(){},renderFamilyCal(){},
    yoteiCache:[]});
  vm.runInContext(fs.readFileSync(new URL('../schedule-plan.js',import.meta.url),'utf8'),c);
  vm.runInContext(section('let editingYoteiId','function setYoteiColor(color){'),c);
  vm.runInContext(section('function setYoteiColor(color){','/* ===== 設定(家族) ===== */').replace(/^async function delYotei[\s\S]*?\n}\n/m,''),c);
  vm.runInContext(section('/* まとめて入れた予定を、この日から後だけ中止','/* ===== 設定(家族) ===== */'),c);
  return {c,d,store,writes,deletes,fail:ids=>{failIds=new Set(ids);},hang:v=>{hang=v;}};
}
{
  const {c,d,writes,store,fail}=setup('2026-10-13T00:00:00Z');
  const v=(id,val)=>{d.getElementById(id).value=val;};
  v('yt-label','デイサービス');v('yt-kind','🚐');v('yt-date','2026-10-14');v('yt-time','09:00');
  v('yt-repeat','weekly');c.renderYoteiRepeat();
  assert.equal(d.getElementById('yt-repeat-more').hidden,false);
  v('yt-repeat-count','3');c.renderYoteiRepeat();
  assert.match(d.getElementById('yt-repeat-preview').textContent,/全3回：10\/14（水）、10\/21（水）、10\/28（水）/);
  /* 1件目だけ通信で失敗 → 「保存しました」と出さず、件数を正直に */
  c.yoteiSaveSeries='';await c.saveYotei();
  const ids=writes.map(w=>w.id);
  assert.equal(ids.length,3);assert.equal(new Set(ids.map(i=>c.MainicoSchedule.seriesOf(i))).size,1,'one series');
  assert.ok(writes.every(w=>w.row.repeat==='none'&&w.row.uid==='me'&&w.row.notifyAt===null),'each day is its own one-time record; no LINE unless chosen');
  assert.match(d.getElementById('yt-save-state').textContent,/^3件をクラウドに保存しました$/);
  /* 同じ内容をもう一度(再読み込み後の押し直しなど) → 二重にしない */
  v('yt-label','デイサービス');v('yt-kind','🚐');v('yt-date','2026-10-14');v('yt-time','09:00');v('yt-repeat','weekly');v('yt-repeat-count','4');c.renderYoteiRepeat();
  writes.length=0;await c.saveYotei();
  assert.deepEqual(writes.map(w=>w.row.date),['2026-11-04'],'only the missing day is added');
  assert.equal(c.MainicoSchedule.seriesOf(writes[0].id),c.MainicoSchedule.seriesOf(ids[0]),'joins the same series');
  assert.match(d.getElementById('yt-save-state').textContent,/1件をクラウドに保存しました|クラウドに保存しました/);
  /* 一部失敗 */
  v('yt-label','訪問');v('yt-date','2026-10-31');v('yt-time','');v('yt-repeat','monthly');c.renderYoteiRepeat();
  assert.equal(d.getElementById('yt-repeat-short-wrap').hidden,false,'31st asks what to do in short months');
  v('yt-repeat-short','skip');v('yt-repeat-count','3');c.renderYoteiRepeat();
  assert.match(d.getElementById('yt-repeat-preview').textContent,/10\/31（土）、12\/31（木）、1\/31（日）/);
  writes.length=0;c.yoteiSaveSeries='';
  let firstSeries='';
  const target=()=>c.MainicoSchedule.docId(firstSeries,'2026-12-31');
  c.MainicoSchedule.newSeries=(o=>()=>{firstSeries=o();fail([target()]);return firstSeries;})(c.MainicoSchedule.newSeries);
  await c.saveYotei();
  assert.equal(writes.length,3);
  assert.match(d.getElementById('yt-save-state').textContent,/2件は保存しました。1件は保存できませんでした/,'never says saved for everything');
  assert.equal(d.getElementById('yt-label').value,'訪問','form is kept for retry');
  fail([]);writes.length=0;await c.saveYotei();
  assert.deepEqual(writes.map(w=>w.id),[target()],'retry adds only the failed day, with the same id');
  /* この日だけ中止 / この日から後をまとめて中止(前の日は残る・自分の分だけ) */
  const day=[...store.keys()].filter(k=>store.get(k).label==='デイサービス').sort();
  c.yoteiCache.push({_id:c.MainicoSchedule.docId(c.MainicoSchedule.seriesOf(day[0]),'2026-11-11'),uid:'someone',label:'デイサービス',date:'2026-11-11',repeat:'none'});
  await c.cancelSeriesFrom(day[1]);
  const left=c.yoteiCache.filter(x=>x.label==='デイサービス').map(x=>x.date).sort();
  assert.equal(day[1].slice(-8),'20261021');
  assert.deepEqual(left,['2026-10-14','2026-11-11'],'earlier day stays; other member\'s record untouched');
  assert.match(d.getElementById('yt-save-state').textContent,/3件を中止しました/);
}
/* 4. LINEのお知らせ: 選んだときだけ、日ごとに同じだけ前へ */
{
  const {c,d,writes}=setup('2026-10-13T00:00:00Z');
  const v=(id,val)=>{d.getElementById(id).value=val;};
  c.__notify={notifyAt:c.firebase.firestore.Timestamp.fromDate(new Date(2026,9,13,19,0)),notifyTo:null};
  v('yt-label','デイサービス');v('yt-date','2026-10-14');v('yt-time','09:00');v('yt-repeat','weekly');v('yt-repeat-count','2');c.renderYoteiRepeat();
  await c.saveYotei();
  assert.deepEqual(writes.map(w=>[w.row.date,w.row.notifyAt.toDate().getDate(),w.row.notifyAt.toDate().getHours()]),[['2026-10-14',13,19],['2026-10-21',20,19]],'the evening before each day');
}
/* 5. 通信待ちのあいだは「保存しました」と出さず、押し直しても二重にしない */
{
  const {c,d,writes,hang}=setup('2026-10-13T00:00:00Z');
  const v=(id,val)=>{d.getElementById(id).value=val;};
  v('yt-label','通院');v('yt-date','2026-10-20');hang(true);
  c.saveYotei();await new Promise(r=>setTimeout(r,0));
  assert.match(d.getElementById('yt-save-state').textContent,/保存中/);
  c.saveYotei();await new Promise(r=>setTimeout(r,0));
  assert.equal(writes.length,1,'double press while waiting does nothing');
}
/* 6. ご本人のホーム: 読み込み中・通信失敗・予定なしを分ける。押すと詳しく。ほか○件 */
{
  const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'});
  const c=dom.getInternalVMContext(),d=dom.window.document,spoken=[];
  const RealDate=Date,clock='2026-10-13T06:00:00Z'; // 15:00 JST
  class Clock extends RealDate{constructor(...a){super(...(a.length?a:[clock]));}static now(){return new RealDate(clock).getTime();}}
  Object.assign(c,{Date:Clock,speak:t=>spoken.push(t),feedback(){},todayStr:()=> '2026-10-13',dateYomi:s=>s,timeYomi:s=>s,hTodayItems:[],
    MainicoLine:{describe:()=> ''},yoteiNotes:[{yoteiId:'c',text:'保険証を持つ'}],openCal(){c.__cal=true;},
    yoteiCache:[{_id:'a',label:'通院',kind:'🏥',date:'2026-10-13',time:'09:00'},{_id:'c',label:'デイサービス',kind:'🚐',date:'2026-10-14',time:'09:00',place:'さくらの家'},{_id:'d',label:'訪問',kind:'🏠',date:'2026-10-14',time:''}]});
  vm.runInContext(fs.readFileSync(new URL('../schedule-plan.js',import.meta.url),'utf8'),c);
  vm.runInContext(section('function dateOnly(s){','function yoteiDetail('),c);
  vm.runInContext(section('let personYoteiStatus','function markAisatsuDone(){'),c);
  vm.runInContext(section('function speakNextYotei(){','function morningGreet(){'),c);
  const txt=id=>d.getElementById(id).textContent;
  c.renderNextYotei();assert.equal(txt('y-days'),'読み込み中…');
  vm.runInContext('personYoteiStatus="error"',c);c.renderNextYotei();assert.equal(txt('y-days'),'確認できません');assert.match(txt('y-label'),/読み込めませんでした/);
  c.toggleNextYotei();assert.match(spoken.at(-1),/読み込めませんでした/,'error is not reported as no events');
  vm.runInContext('personYoteiStatus="ready"',c);c.renderNextYotei();
  assert.equal(txt('y-days'),'明日　09:00','9:00 today already passed; not shown as next, not marked done');
  assert.equal(txt('y-label'),'デイサービス 🚐');
  assert.equal(d.getElementById('y-others').hidden,false);assert.match(txt('y-others'),/ほか1件/);
  assert.equal(d.getElementById('y-detail').hidden,true);
  c.toggleNextYotei();
  assert.equal(d.getElementById('y-card').getAttribute('aria-expanded'),'true');
  assert.match(txt('y-detail'),/09:00/);assert.match(txt('y-detail'),/さくらの家/);assert.match(txt('y-detail'),/保険証を持つ/);
  assert.match(spoken.at(-1),/次の予定は、明日、09:00に、デイサービスです。この日は、ほかに1件あります/);
  c.openNextYoteiDay();assert.equal(c.__cal,true);assert.equal(vm.runInContext('scheduleSelectedDay',c),'2026-10-14');
  vm.runInContext('yoteiCache=[{_id:"x",label:"訪問",date:"2026-10-30",time:""}]',c);c.renderNextYotei();
  assert.equal(txt('y-days'),'10月30日（金）','no time is not invented');assert.match(txt('y-sub'),/あと17日/);
  vm.runInContext('yoteiCache=[]',c);c.renderNextYotei();assert.equal(txt('y-days'),'予定はありません');assert.equal(txt('y-label'),'');
  c.speakNextYotei();assert.equal(spoken.at(-1),'これからの予定はありません');
  vm.runInContext('personYoteiStatus="cached"',c);c.renderNextYotei();
  assert.equal(txt('y-days'),'保存された予定はありません');assert.match(txt('y-sub'),/通信の確認待ち/);
  c.speakNextYotei();assert.match(spoken.at(-1),/最新の予定は確認できません/);
  vm.runInContext('yoteiCache=[{_id:"x",label:"訪問",date:"2026-10-30",time:""}]',c);c.renderNextYotei();
  c.speakNextYotei();assert.match(spoken.at(-1),/保存された予定です/);assert.match(spoken.at(-1),/訪問/);
  vm.runInContext('personYoteiStatus="ready"',c);c.renderNextYotei();
  assert.equal(txt('y-label'),'訪問');c.speakNextYotei();assert.doesNotMatch(spoken.at(-1),/保存された予定|最新の予定は確認できません/);
}
console.log('schedule: home card states, next event (Tokyo today/tomorrow, passed times, others), repeat dates (weekly/monthly/month end), series save without duplicates, honest partial failure, retry, this-day and from-this-day cancel, LINE offsets passed');
