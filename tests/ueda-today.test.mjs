import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const context={URL};
vm.runInNewContext(fs.readFileSync(new URL('../ueda-today.js',import.meta.url),'utf8'),context);
const {forecast,topics,mount}=context.MainicoUedaToday;
let now=Date.parse('2026-10-24T17:30:00+09:00');
const report=(issued='2026-10-24T17:00:00+09:00')=>[{reportDatetime:issued,timeSeries:[
  {timeDefines:['2026-10-24T17:00:00+09:00','2026-10-25T00:00:00+09:00','2026-10-26T00:00:00+09:00'],areas:[
    {area:{code:'200010'},weathers:['北部だけの予報']},
    {area:{code:'200020'},weathers:['くもり　所により　雨','雨　のち　くもり','晴れ']}]}]}];
assert.equal(forecast(report(),now).today.text,'くもり 所により 雨');
assert.equal(forecast(report(),now).tomorrow.text,'雨 のち くもり');
assert.equal(forecast(report(),Date.parse('2026-10-25T00:01:00+09:00')).today.text,'雨 のち くもり','日本時間で日を切り替える');
assert.equal(forecast(report(),Date.parse('2026-10-25T11:00:01+09:00')),null,'18時間を超えた予報を隠す');
assert.equal(forecast(report('2026-10-24T18:00:00+09:00'),now),null,'未来の発表を採用しない');
for(const bad of [null,{},[],[{}],[{reportDatetime:'2026-10-24T17:00:00+09:00',timeSeries:[]}],report('not a date')])assert.equal(forecast(bad,now),null);
const wrong=report();wrong[0].timeSeries[0].areas.pop();assert.equal(forecast(wrong,now),null,'別地域で補完しない');
const missing=report();missing[0].timeSeries[0].areas[1].weathers=[];assert.equal(forecast(missing,now),null);
const topic={title:'地域の催し',when:'11月1日 開催予定',url:'https://www.city.ueda.nagano.jp/example/',checkedAt:'2026-10-24T17:00:00+09:00',endsAt:'2026-11-02T00:00:00+09:00'};
assert.equal(topics([topic,topic],now).length,1,'重複しない');
assert.equal(topics([topic,{...topic,url:topic.url+'2'},{...topic,url:topic.url+'3'}],now).length,2);
assert.equal(topics([topic],Date.parse('2026-10-31T17:00:00+09:00')).length,0,'確認から7日で下げる');
assert.equal(topics([{...topic,endsAt:'2026-10-24T17:30:00+09:00'}],now).length,0,'終了時刻で下げる');
for(const url of ['javascript:alert(1)','https://www.city.ueda.nagano.jp.evil.test/','https://user:pass@www.city.ueda.nagano.jp/','http://www.city.ueda.nagano.jp/'])assert.equal(topics([{...topic,url}],now).length,0);
assert.equal(topics([{...topic,checkedAt:'2026-10-25T17:00:00+09:00'}],now).length,0);

const dom=new JSDOM('<div class="page" id="honnin"><div data-ueda-today></div></div><div class="page" id="kazoku"><div class="ftab" id="t-home"><div id="home-main"><div data-ueda-today></div></div></div></div>',{url:'https://example.test/',pretendToBeVisual:true});
const {window:w}=dom,d=w.document;let calls=[],voices=[],cancelled=0,fail=false,deferred=null;
w.speechSynthesis={cancel(){cancelled++;},speak(u){voices.push(u);}};w.SpeechSynthesisUtterance=function(text){this.text=text;};
const client=mount(d,{now:()=>now,topics:[{...topic,title:'<img src=x onerror=alert(1)>'}],fetch:async(url,options)=>{calls.push({url,options});if(deferred)return deferred;if(fail)throw Error('offline');return {ok:true,json:async()=>report()};}});
const tick=()=>new Promise(r=>w.setTimeout(r,10));
await tick();assert.equal(calls.length,0,'入口では外部予報を取得しない');
d.querySelector('#honnin').classList.add('active');await tick();
assert.equal(calls.length,1);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.referrerPolicy,'no-referrer');
assert.equal(voices.length,0,'画面を開いても自動では読み上げない');
const h=d.querySelector('#honnin'),f=d.querySelector('#kazoku');
assert.match(h.querySelector('.ut-weather').textContent,/くもり/);assert.match(h.querySelector('.ut-time').textContent,/10月24日 17:00発表/);
assert.equal(h.querySelector('details').open,false,'最初は小さく閉じる');
assert.equal(h.querySelector('.ut-items img'),null,'外部の文はHTMLとして実行しない');
h.querySelector('details').open=true;await tick();h.querySelector('.ut-read').click();assert.equal(voices.length,1);assert.match(voices[0].text,/長野県中部/);assert.equal(h.querySelector('.ut-read').textContent,'読み上げを止める'); h.querySelector('.ut-read').click(); assert.equal(h.querySelector('.ut-read').textContent,'天気を聞く'); h.querySelector('.ut-read').click();
h.querySelector('details').open=false;await tick();assert.equal(h.querySelector('.ut-read').textContent,'天気を聞く');assert.ok(cancelled>0);
h.classList.remove('active');f.classList.add('active');await tick();assert.equal(calls.length,1,'同じ予報を家族にも使い、連続取得しない');
now=Date.parse('2026-10-25T00:01:00+09:00');client.refresh();await tick();assert.match(f.querySelector('.ut-weather').textContent,/雨 のち くもり/);
fail=true;f.querySelector('.ut-retry').click();await tick();assert.match(f.querySelector('.ut-weather').textContent,/確認できません/);assert.equal(f.querySelector('.ut-read').disabled,true,'通信失敗を過去の予報で隠さない');
fail=false;let resolve;deferred=new Promise(r=>resolve=r);f.querySelector('.ut-retry').click();await tick();assert.equal(f.querySelector('.ut-retry').disabled,true);const before=calls.length;client.refresh();await tick();assert.equal(calls.length,before,'同時取得を重ねない');resolve({ok:false});await tick();assert.equal(f.querySelector('.ut-retry').disabled,false);deferred=null;
now=Date.parse('2026-10-31T17:01:00+09:00');client.refresh();await tick();assert.equal(f.querySelectorAll('.ut-items article').length,0);assert.match(f.querySelector('.ut-topic-note').textContent,/今掲載できる話題はありません/);
client.destroy();w.close();
console.log('今日の上田：地域・日本時間の日替わり・鮮度・失敗・期限・安全な表示・任意の音声・共有取得 OK');

assert.equal(h.querySelector('.ut-note'),null); assert.equal(h.querySelector('article small'),null); assert.equal(h.querySelector('.ut-stop'),null);
