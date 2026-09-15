import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function addFamilyTask(){'),html.indexOf('async function addFamilyContact(){'));
class Element{
 constructor(){this.children=[];this._text='';this.value='';this.style={};this.disabled=false;this.open=true;}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
 appendChild(v){this.children.push(v);return v;}addEventListener(k,v){this[k]=v;}
}
function fixture(){
 const els=new Map(),writes=[],messages=[];
 const el=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);};
 const c={document:{getElementById:el,createElement:()=>new Element(),createTextNode:t=>Object.assign(new Element(),{textContent:t})},familyOnlyData:{tasks:[],taskDone:[]},familyOnlyLoad:{tasks:'ready',taskDone:'ready'},foState:(id,text)=>messages.push(text),myName:()=> '記録者',uid:()=> 'me',foDateTime:v=>v.time||'',foByNewest:(a,b)=>b.n-a.n,todayStr:()=> '2026-09-15',dateOnly:v=>v,dateJp:v=>v,addEvent:async v=>writes.push(v),alert:m=>messages.push(m),deleteFamilyEvent:()=>{}};
 vm.createContext(c);vm.runInContext(source,c);return{c,el,writes,messages};
}
{
 const e=fixture();e.el('family-task-input').value=' 薬局へ行く ';e.el('family-task-assignee').value=' 相談済みの家族 ';e.el('family-task-date').value='2026-09-20';await e.c.addFamilyTask();
 assert.equal(e.writes[0].assignee,'相談済みの家族');assert.equal(e.writes[0].type,'family-task');assert.equal(e.el('family-task-assignee').value,'');
}
{
 const e=fixture();e.el('family-task-input').value='買い物';await e.c.addFamilyTask();assert.equal(e.writes[0].assignee,'');
 e.el('family-task-input').value='次の用事';e.el('family-task-assignee').value='担当';e.c.addEvent=async()=>{throw Error('offline');};await e.c.addFamilyTask();assert.equal(e.el('family-task-input').value,'次の用事');assert.equal(e.el('family-task-assignee').value,'担当');
}
{
 const e=fixture();e.c.familyOnlyData.tasks=[{_id:'one',text:'用事',uid:'me',assignee:'<img onerror=bad>',due:'2026-09-14',time:'9月15日 10:00'},{_id:'old',text:'古い用事',uid:'other'}];e.c.familyOnlyData.taskDone=[{replyTo:'one',name:'対応者',time:'9月15日 11:00'}];e.c.renderFamilyTasks();
 assert.match(e.el('family-task-list').textContent,/担当メモ：<img onerror=bad>/);assert.match(e.el('family-task-list').textContent,/対応者さんが対応済み・9月15日 11:00/);assert.match(e.el('family-tasks-preview').textContent,/担当メモ：未定/);
 assert.equal(e.el('family-task-list').children[0].children[0].textContent,'□ 古い用事');
}
{
 const e=fixture();e.c.familyOnlyData.tasks=Array.from({length:35},(_,i)=>({_id:String(i),text:'用事'+i,n:35-i}));e.c.familyOnlyData.taskDone=e.c.familyOnlyData.tasks.slice(0,34).map(v=>({replyTo:v._id}));e.c.renderFamilyTasks();assert.equal(e.el('family-task-list').children[0].children[0].textContent,'□ 用事34');
}
{
 const e=fixture();e.c.familyOnlyLoad.tasks='cached';e.c.renderFamilyTasks();assert.match(e.el('family-tasks-preview').textContent,/件数は今は判断できません/);await e.c.finishFamilyTask('x');assert.equal(e.writes.length,0);
}
{
 const e=fixture();e.c.familyOnlyData.tasks=[{_id:'x'}];let release;e.c.addEvent=()=>new Promise(r=>release=r);const first=e.c.finishFamilyTask('x');await e.c.finishFamilyTask('x');release();await first;
 // Completion retry after a failed request must remain possible.
 e.c.addEvent=async()=>{throw Error('offline');};await e.c.finishFamilyTask('x');e.c.addEvent=async v=>e.writes.push(v);await e.c.finishFamilyTask('x');assert.equal(e.writes.length,1);
}
for(const id of ['card-family-notes-preview','card-family-tasks-preview','card-family-notes','card-family-tasks'])assert.match(html,new RegExp('class="card dom-record family-shared-card" id="'+id+'"'));
assert.match(html,/\n  initFamilyOnlyTools\(\);/);assert.doesNotMatch(html,/if\(kOnly\)renderFamilySchedule\(\)/);assert.doesNotMatch(html,/function renderFamilySchedule\(\)\{\s*if\(!isKOnly\(\)\)/);
console.log('handoff summary: 7 groups passed');
