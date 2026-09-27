import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(from,to){const a=html.indexOf(from),b=html.indexOf(to,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
for(const mode of ['family','person']){
  const dom=new JSDOM(html,{url:'https://example.test/#schedule=oct&group=g1',runScripts:'outside-only'});
  const c=dom.getInternalVMContext(),d=dom.window.document,edits=[];
  const RealDate=Date;
  class Clock extends RealDate{constructor(...args){super(...(args.length?args:['2026-09-30T03:00:00Z']));}static now(){return new RealDate('2026-09-30T03:00:00Z').getTime();}}
  Object.assign(c,{Date:Clock,gid:()=> 'g1',uid:()=> 'me',familyYoteiStatus:'ready',
    speak(){},showTab(){},dateJp:v=>v.getFullYear()+'年'+(v.getMonth()+1)+'月'+v.getDate()+'日',dateYomi:s=>s,timeYomi:s=>s,
    todayStr:()=> '2026-09-30',esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),yoteiColor:()=> '#4F7FD3',
    editYotei:id=>edits.push(id),openHYotei:id=>edits.push(id),delYotei(){},MainicoLine:{describe:()=> 'LINEでお知らせ済み'},
    yoteiCache:[{_id:'oct',uid:'me',date:'2026-10-06',label:'通院 <img src=x onerror=bad()>',time:'09:00',place:'病院'},
      {_id:'other',uid:'someone',date:'2026-10-06',label:'家族の予定'},
      {_id:'repeat',uid:'me',date:'2026-01-31',repeat:'monthly',label:'月末の予定'}]});
  vm.runInContext(section('/* LINE通知の行き先はURLに残し','/* ===== 画面遷移 ===== */'),c);
  vm.runInContext(section('function dateOnly(s){','function yoteiNextDate('),c);
  vm.runInContext(section('/* カレンダー */','/* 承認待ちカード'),c);
  vm.runInContext(section('function renderFamilyCal(){','/* 今日の記録のとりけし'),c);
  d.getElementById(mode==='family'?'kazoku':'honnin').classList.add('active');
  const prefix=mode==='family'?'f-':'';
  const title=()=>d.getElementById(prefix+'cal-ttl').textContent;
  const table=()=>d.getElementById(prefix+'cal-table');
  const draw=()=>mode==='family'?c.renderFamilyCal():c.openCal();
  const press=(selector)=>{const button=d.querySelector(selector);assert.ok(button);vm.runInContext(button.getAttribute('onclick'),c);};
  draw();assert.match(title(),/2026年9月/);assert.equal(table().querySelectorAll('[aria-current="date"]').length,1);
  press('#'+prefix+'cal-ttl + .schedule-month-nav button:last-child');
  assert.match(title(),/2026年10月/);assert.equal(table().querySelectorAll('[aria-current="date"]').length,0,'same day number in another month is not today');
  press('#'+prefix+'cal-table [aria-label="2026年10月6日、予定2件"]');
  const detail=d.getElementById(prefix+'cal-day-detail');
  assert.match(detail.textContent,/通院/);assert.match(detail.textContent,/09:00/);assert.match(detail.textContent,/病院/);assert.match(detail.textContent,/LINEでお知らせ済み/);
  assert.equal(detail.querySelector('img'),null,'event labels are text');
  assert.equal(detail.querySelectorAll('button').length,mode==='family'?2:1,'another member cannot edit');
  detail.querySelector('button').click();assert.deepEqual(edits,['oct']);
  c.changeScheduleMonth(1,mode);assert.equal(detail.style.display,'none','old day detail clears on month change');
  c.changeScheduleMonth(1,mode);assert.match(title(),/2026年12月/);
  c.changeScheduleMonth(1,mode);assert.match(title(),/2027年1月/);
  c.changeScheduleMonth(-1,mode);assert.match(title(),/2026年12月/);
  c.changeScheduleMonth(0,mode);assert.match(title(),/2026年9月/);
  vm.runInContext('scheduleCalendarDate=new Date(2028,0,31)',c);
  c.changeScheduleMonth(1,mode);assert.match(title(),/2028年2月/);assert.equal(table().querySelectorAll('button').length,29);
  assert.match(table().querySelector('[aria-label^="2028年2月29日"]').getAttribute('aria-label'),/予定1件/,'month-end recurrence still appears');
  c.changeScheduleMonth(-12,mode);assert.match(title(),/2027年2月/);assert.equal(table().querySelectorAll('button').length,28);
  vm.runInContext('scheduleLinkOpened=false;scheduleLinkDismissed=false;scheduleSelectedDay=""',c);
  c.openScheduleLink();c.renderScheduleLink(true);assert.match(title(),/2026年10月/);
  c.changeScheduleMonth(1,mode);c.renderScheduleLink(true);assert.match(title(),/2026年11月/,'later snapshots do not undo manual month navigation');
  draw();assert.match(title(),/2026年11月/,'re-render retains the selected month');
  dom.window.close();
}
console.log('calendar: both modes, real buttons, year boundaries, leap days, recurrence, day details, permissions and LINE navigation passed');
