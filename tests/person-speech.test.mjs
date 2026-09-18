import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {homeFixture,html} from './helpers/home-conversation-fixture.mjs';

const require=createRequire(import.meta.url);
const speech=require('../person-speech.js');
const pressSource=fs.readFileSync(new URL('../person-button-feedback.js',import.meta.url),'utf8');
const shared={status:'shared',others:1,familyOthers:1,personOthers:0};
const message={_id:'message-A',type:'family-message',name:'家族',text:'おはよう',date:'2026-09-18',at:{seconds:1789718400},uid:'family'};
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,start);return html.slice(a,b);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}

// Keep the production markup, communication handlers, speech module and press
// controller together. The fake platform records requests; it cannot certify
// that a physical iPhone speaker produced sound or grant trusted user activation.
function fixture({press=false}={}){
  const f=homeFixture('honnin'),{c,document,dom}=f;
  const calls=[],effects=[],writes=[],pending=[],listeners=[],timers=new Map();
  let now=0,timerId=0,inClickTask=false,holdWrites=false,engineFailure=false;
  const engine={
    cancel(){effects.push({kind:'cancel',at:now});},
    getVoices(){return [{name:'Kyoko',lang:'ja-JP'}];},
    speak(utterance){calls.push({utterance,at:now,inClickTask});if(engineFailure)throw Error('audio unavailable');utterance.onstart?.();}
  };
  function write(payload){writes.push(payload);if(!holdWrites)return Promise.resolve();const d=deferred();pending.push(d);return d.promise;}
  Object.assign(c,{
    MainicoPersonSpeech:speech,speechSynthesis:engine,
    SpeechSynthesisUtterance:function(text){this.text=text;},yoteiCache:[],
    YOBI_KANJI:['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'],rokuyoOf:()=>'',
    firebase:{firestore:{FieldValue:{serverTimestamp:()=>({serverTimestamp:true})}}},
    addEvent:payload=>write({collection:'events',...payload}),
    col:name=>({
      add:payload=>write({collection:name,...payload}),
      doc:id=>({
        update:payload=>write({collection:name,id,...payload}),
        get:async()=>({exists:id===message._id,data:()=>message,metadata:{fromCache:false,hasPendingWrites:false}})
      }),
      where:()=>({
        onSnapshot:(_options,ok,error)=>{listeners.push({ok,error});return ()=>{};},
        get:async()=>({metadata:{fromCache:false,hasPendingWrites:false},forEach(){}})
      })
    })
  });
  c.previewStorage.setItem('mainicoMode','honnin');
  vm.runInContext(section('/* ===== 読み上げ(こえの おへんじ) ===== */','/* ===== きょうの予定 ===== */'),c);
  vm.runInContext(section('function speakDateHeader(){','function speakNextYotei(){'),c);
  vm.runInContext(section('/* ===== 本人の予定入力 ===== */','async function hyDelete(){'),c);
  vm.runInContext(section('let personHistoryUnsub=null,','const UEDA_CENTERS='),c);
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  dom.window.HTMLElement.prototype.getClientRects=function(){return f.visible(this)?[{}]:[];};
  f.state(shared);f.events([message]);
  function clearSpeech(){c.stopPersonSpeech();calls.length=0;effects.length=0;}
  clearSpeech();
  if(press){
    c.setTimeout=(fn,ms)=>{timers.set(++timerId,{fn,at:now+ms});return timerId;};
    c.clearTimeout=id=>timers.delete(id);
    vm.runInContext(pressSource,c);
    // outside-only JSDOM does not install inline handlers. Dispatch the actual
    // production attribute only after the real capturing controller permits it.
    document.addEventListener('click',event=>{
      const button=event.target.closest('[onclick]');if(!button||button.disabled)return;
      const handler=vm.runInContext('(function(event){return '+button.getAttribute('onclick')+';})',c);
      handler.call(button,event);
    });
  }
  return {...f,calls,effects,writes,pending,
    clearSpeech,last:()=>calls.at(-1)?.utterance.text||'',
    hold:()=>{holdWrites=true;},failEngine:()=>{engineFailure=true;},
    press(button){assert.ok(f.visible(button));assert.equal(button.disabled,false);inClickTask=true;button.click();inClickTask=false;},
    keyPress(target,key){inClickTask=true;target.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));inClickTask=false;},
    advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}},
    history(rows=[message]){listeners.at(-1).ok({metadata:{fromCache:false,hasPendingWrites:false},forEach:fn=>rows.forEach(row=>fn({id:row._id,data:()=>row}))});},
    close(){c.stopPersonSpeech();f.close();}
  };
}

{
  const f=fixture({press:true});
  const button=f.document.querySelector('[onclick="openHYotei()"]');
  f.press(button);
  assert.match(f.last(),/予定.*入力/);
  assert.equal(f.calls[0].inClickTask,true,'navigation voice starts in the original click task, before the delayed action');
  assert.equal(f.document.getElementById('h-yotei-modal').classList.contains('show'),false);
  f.advance(649);assert.equal(f.calls.length,1);assert.equal(f.writes.length,0);
  f.advance(1);
  assert.equal(f.document.getElementById('h-yotei-modal').classList.contains('show'),true);
  assert.equal(f.calls.length,1,'650ms replay does not restart the same ongoing cue');
  assert.equal(f.calls[0].utterance.lang,'ja-JP');
  f.close();
}
{
  const f=fixture({press:true});f.hold();
  const button=[...f.document.querySelectorAll('#h-message-reply button')].find(b=>b.textContent==='ありがとう');
  f.press(button);
  assert.equal(f.calls[0].inClickTask,true);assert.match(f.last(),/ありがとう.*送ります/);
  assert.equal(f.writes.length,0,'press cue never sends the message');
  f.advance(650);await flush();
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].replyTo,message._id);
  assert.equal(f.calls.length,1,'the delayed send reuses its ongoing preparation cue');
  assert.ok(!f.calls.some(v=>v.utterance.text.includes('送りました')),'pending write must not announce success');
  await f.c.sendFamilyMessageBack('ありがとう',message._id);assert.equal(f.writes.length,1,'duplicate invocation does not duplicate write');
  f.pending[0].resolve();await flush();
  assert.match(f.last(),/ありがとう.*送りました/);
  f.close();
}
{
  const f=fixture({press:true}),date=f.document.querySelector('.h-date-wrap');
  f.keyPress(date,'Enter');assert.equal(f.calls.length,1);assert.equal(f.calls[0].inClickTask,true,'keyboard activation starts voice before delayed replay');
  assert.match(f.last(),/今日は.*現在の時刻/);assert.ok(date.classList.contains('person-press-latched'));
  f.advance(649);assert.equal(f.calls.length,1);f.advance(1);
  assert.equal(f.calls.length,1);assert.ok(!date.classList.contains('person-press-latched'));assert.equal(f.writes.length,0);f.close();
}
{
  const f=fixture({press:true});f.state({status:'solo',others:0,familyOthers:0,personOthers:0});f.clearSpeech();
  const reply=[...f.document.querySelectorAll('#h-message-reply button')].find(b=>b.textContent==='ありがとう');
  assert.equal(reply.disabled,true);reply.click();f.advance(650);
  assert.equal(f.calls.length,0,'disabled reply does not start a misleading send cue');assert.equal(f.writes.length,0);f.close();
}
{
  const f=fixture();
  f.c.speak('操作の結果です');const active=f.calls[0].utterance,cancelCount=f.effects.length;
  f.c.speak('家族からの新着です',false,true);
  assert.equal(f.calls.length,1,'background arrival does not interrupt the current operation');
  assert.equal(f.effects.length,cancelCount);
  active.onend();assert.match(f.last(),/家族からの新着/);
  f.c.speak('次の新着です',false,true);
  const previous=f.calls.at(-1).utterance;
  f.c.toggleSpeech();const count=f.calls.length;
  assert.equal(f.c.previewStorage.getItem('mainicoSpeechOn'),'0');
  assert.equal(f.effects.at(-1).kind,'cancel','turning speech off cancels active audio');
  previous.onend();f.c.speak('通常操作です');assert.equal(f.calls.length,count,'off also clears queued background audio');
  f.c.speak('自分で選んだ読み上げです',true);assert.match(f.last(),/自分で選んだ/);
  f.c.toggleSpeech();assert.match(f.last(),/オンにしました/);
  f.close();
}
{
  const f=fixture();f.c.speak('送信しています');const old=f.calls.at(-1).utterance;
  f.c.speak('家族からの新着です',false,true);f.c.speak('返事を送りました');
  assert.match(f.last(),/返事を送りました/);
  old.onend();assert.equal(f.calls.length,2,'a canceled foreground callback does not drain the queue');
  f.calls.at(-1).utterance.onend();assert.match(f.last(),/家族からの新着です/,'new arrival survives replacement of progress speech with success');
  f.close();
}
{
  const f=fixture();f.c.speak('家族の連絡');const old=f.calls.at(-1).utterance;
  f.c.speak('次の連絡',false,true);
  Object.defineProperty(f.document,'hidden',{configurable:true,value:true});
  f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  const count=f.calls.length;old.onend();
  assert.equal(f.calls.length,count,'moving the page to the background clears queued private speech');
  f.events([{...message,_id:'message-B',text:'非表示中に届いた連絡',at:{seconds:message.at.seconds+10}}]);
  assert.equal(f.calls.length,count,'a fresh real conversation arrival while hidden must remain silent');
  f.c.speak('非表示中の読み上げ',true);assert.equal(f.calls.length,count,'forced playback also respects page visibility');
  assert.equal(f.effects.at(-1).kind,'cancel');f.close();
}
{
  const timers=new Map(),calls=[];let id=0,unavailable=0;
  const controller=speech.create({
    allowed:()=>true,enabled:()=>true,scope:()=> 'person:home',
    engine:{cancel(){},speak:utterance=>calls.push(utterance)},Utterance:function(text){this.text=text;},
    unavailable:()=>unavailable++,setTimeout:(fn,ms)=>{assert.equal(ms,3000);timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key)
  });
  controller.say('もう一度聞きます');assert.equal(calls.length,1);
  controller.say('もう一度聞きます');assert.equal(calls.length,1,'an ongoing cue does not restart prematurely');
  [...timers.values()][0]();assert.equal(unavailable,1,'silent failure to start becomes a visible-retry condition');
  controller.say('もう一度聞きます');assert.equal(calls.length,2,'same-text deliberate retry works after the start watchdog');
  calls[1].onstart();assert.equal(timers.size,0,'successful start clears its watchdog');controller.stop();
}
{
  const f=fixture();f.c.speak('以前の家庭の連絡');const old=f.calls.at(-1).utterance;
  f.c.speak('以前の家庭の続き',false,true);f.setGroup('another-home');
  f.c.resetCommunication();const count=f.calls.length;
  old.onend();assert.equal(f.calls.length,count,'reset cancels queued private content from the old household');
  assert.equal(f.effects.at(-1).kind,'cancel');
  f.c.previewStorage.setItem('mainicoMode','kazoku');f.c.speak('本人以外の画面',true);
  assert.equal(f.calls.length,count,'person speech does not start on another screen');
  f.close();
}
for(const failure of [false,true]){
  const f=fixture();f.hold();f.c.openHYotei();
  await f.c.hySave();assert.match(f.last(),/予定の名前/);assert.equal(f.writes.length,0);
  f.document.getElementById('hy-free').value='買い物';
  const saving=f.c.hySave();await f.c.hySave();assert.equal(f.writes.length,1);
  assert.match(f.last(),/保存しています/);assert.ok(!f.last().includes('ほぞんしました'));
  if(failure)f.pending[0].reject(Error('offline'));else f.pending[0].resolve();
  await saving;
  assert.match(f.last(),failure?/保存できません/:/買い物.*ほぞんしました/);
  assert.equal(f.document.getElementById('hy-save-btn').disabled,false);
  if(failure){assert.equal(f.document.getElementById('hy-free').value,'買い物');assert.equal(f.document.getElementById('h-yotei-modal').classList.contains('show'),true);}
  f.close();
}
{
  const f=fixture();f.hold();f.c.openHYotei();f.document.getElementById('hy-free').value='旧家庭の予定';
  const saving=f.c.hySave();f.setGroup('next');f.c.resetCommunication();f.clearSpeech();
  f.pending[0].resolve();await saving;
  assert.equal(f.calls.length,0,'old household completion must not speak on the current screen');
  assert.equal(f.document.getElementById('pop-msg').textContent,'');f.close();
}
for(const failure of [false,true]){
  const f=fixture();f.hold();f.c.openPersonMessageReply(message._id);
  assert.match(f.last(),/返事.*書く画面/);
  await f.c.sendPersonMessageReply();assert.match(f.last(),/返事を書いて/);assert.equal(f.writes.length,0);
  const input=f.document.getElementById('person-message-reply-text');input.value='明日会いに行くね';
  const sending=f.c.sendPersonMessageReply();assert.match(f.last(),/明日会いに行くね.*送ります/);
  if(failure)f.pending[0].reject(Error('offline'));else f.pending[0].resolve();
  await sending;
  assert.match(f.last(),failure?/送信できません/:/明日会いに行くね.*送りました/);
  assert.equal(f.document.getElementById('person-message-reply-modal').classList.contains('show'),failure);
  assert.equal(input.value,failure?'明日会いに行くね':'');
  if(failure){f.c.closePersonMessageReply();f.c.openPersonMessageReply(message._id);assert.equal(input.value,'明日会いに行くね','reopening the same unsent reply retains the draft');}
  f.close();
}
for(const failure of [false,true]){
  const f=fixture();f.hold();f.c.openPersonHistory();assert.match(f.last(),/前の連絡をひらきます/);
  f.history();const item=f.document.querySelector('#person-history-list section');
  const read=[...item.querySelectorAll('button')].find(b=>b.textContent==='声で読む');
  f.c.toggleSpeech();read.click();assert.match(f.last(),/9月18日.*おはよう/,'explicit history playback reads its date and content even when automatic speech is off');
  f.c.toggleSpeech();
  const reply=[...item.querySelectorAll('button')].find(b=>b.textContent.includes('返す'));
  const sending=f.c.replyToHistory(message._id,reply,item.querySelector('[role="status"]'));
  await flush();assert.equal(f.writes.length,1);assert.match(f.last(),/読んだよ.*送ります/);
  if(failure)f.pending[0].reject(Error('offline'));else f.pending[0].resolve();
  await sending;assert.match(f.last(),failure?/送信できません/:/読んだよ.*送りました/);
  f.close();
}
{
  const f=fixture();f.failEngine();
  const sent=await f.c.sendFamilyMessageBack('ありがとう',message._id);
  assert.equal(sent,true,'speech engine exception cannot turn a successful write into failure');
  assert.equal(f.writes.length,1);assert.match(f.document.getElementById('h-message-reply-state').textContent,/返事を送りました/);
  assert.match(f.document.getElementById('person-speech-status').textContent,/声を再生できません/);
  f.close();
}
{
  const f=fixture();f.state({status:'solo',others:0,familyOthers:0,personOthers:0});
  const sent=await f.c.sendFamilyMessageBack('ありがとう',message._id);
  assert.equal(sent,false);assert.equal(f.writes.length,0,'speech support never bypasses approved-family requirements');
  assert.match(f.last(),/参加が承認/);f.close();
}
console.log('person speech: original click task before 650ms, async outcomes, off/queue/privacy, schedule/reply/history voice, draft retention and engine failure isolation passed');
