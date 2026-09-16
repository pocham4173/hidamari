import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf("let familyConnection={"),html.indexOf('let personTasksController=null;'));
const labels=[{textContent:''}],requests=[{textContent:''}],people=[{textContent:''}];
const gates=['family','person','shared'].map(kind=>({dataset:{shareGate:kind},hidden:true}));
const els=Object.fromEntries(['home-summary-description','home-record-heading','family-task-kind-family','family-task-sharing-note','family-task-kind'].map(id=>[id,{textContent:'',value:'self',hidden:false,disabled:false}]));
const selectors={'[data-connection-state]':labels,'[data-request-audience]':requests,'[data-person-audience]':people,'[data-share-gate]':gates};
let account='me',group='home',listeners=[],stops=0,refreshes=0;
const c={document:{querySelectorAll:sel=>selectors[sel]||[],getElementById:id=>els[id]||null},uid:()=>account,gid:()=>group,householdBootGeneration:1,MainicoFamilyConnection:require('../family-connection.js'),col:()=>({onSnapshot:(opt,ok,err)=>{listeners.push({ok,err});return ()=>stops++;}}),familyTaskListMode:'all',changeFamilyTaskList:()=>refreshes++,alert:()=>{}};
vm.createContext(c);vm.runInContext(source,c);
const snap=(members,cache=false,pending=false)=>({metadata:{fromCache:cache,hasPendingWrites:pending},forEach:fn=>members.forEach(([id,role,status='approved'])=>fn({id,data:()=>({role,status})}))});
const hidden=(family,person,shared)=>assert.deepEqual(gates.map(v=>v.hidden),[family,person,shared]);
c.startFamilyConnection();assert.match(labels[0].textContent,/確認できません/);hidden(true,true,true);
listeners[0].ok(snap([['me','kazoku']]));assert.match(labels[0].textContent,/ほかの承認済み参加者はいません/);hidden(true,true,true);
assert.equal(els['family-task-kind-family'].disabled,true);
assert.doesNotMatch(els['home-summary-description'].textContent,/家族/);
// Code redeemed, but not approved: no premature collaboration UI.
listeners[0].ok(snap([['me','kazoku'],['invited','kazoku','pending']]));hidden(true,true,true);
assert.equal(c.requireFamilyFeature(),false);
listeners[0].ok(snap([['me','kazoku'],['family','kazoku']]));hidden(false,true,false);
assert.equal(c.requireFamilyFeature(),true);assert.equal(els['family-task-kind-family'].disabled,false);
assert.match(labels[0].textContent,/1人/);assert.match(requests[0].textContent,/確認や対応は保証されません/);
assert.match(els['home-summary-description'].textContent,/家族の伝言/);
// A person recipient and a family recipient enable their respective controls.
listeners[0].ok(snap([['me','kazoku'],['person','honnin']]));hidden(true,false,false);
listeners[0].ok(snap([['me','kazoku'],['person','honnin'],['family','kazoku']]));hidden(false,false,false);
// Membership removal updates the open page and preserves an unfinished request draft.
els['family-task-kind'].value='family';listeners[0].ok(snap([['me','kazoku']]));hidden(true,true,true);
assert.equal(els['family-task-kind'].value,'family');assert.equal(els['family-task-kind-family'].hidden,false);assert.match(els['family-task-sharing-note'].textContent,/入力は残っています/);
assert.equal(c.requireFamilyFeature(),false);
for(const state of [snap([['me','kazoku'],['family','kazoku']],true),snap([['me','kazoku'],['family','kazoku']],false,true)]){
 listeners[0].ok(state);hidden(true,true,true);assert.doesNotMatch(labels[0].textContent,/参加者はいません/);
}
listeners[0].err();hidden(true,true,true);assert.match(labels[0].textContent,/確認できません/);
c.startFamilyConnection();assert.equal(stops,1);listeners[0].ok(snap([['me','honnin'],['old','kazoku']]));hidden(true,true,true);
account='new';group='newhome';listeners[1].ok(snap([['me','honnin'],['old','kazoku']]));hidden(true,true,true);
c.stopFamilyConnection();assert.equal(stops,2);assert.ok(refreshes>=10,'参加状況の変化でやることも更新する');
// Static default is closed, even before the first verified snapshot.
assert.match(html,/\[data-share-gate\]\[hidden\]\{display:none!important;/);
for(const tag of html.match(/<[^>]+data-share-gate[^>]*>/g))assert.match(tag,/ hidden(?:[ >])/);
for(const id of ['card-family-notes','card-family-notes-preview','family-task-filter'])assert.match(html,new RegExp('id="'+id+'" data-share-gate="family" hidden'));
const home=html.slice(html.indexOf('<div class="ftab" id="t-home">'),html.indexOf('<!-- 予定',html.indexOf('<div class="ftab" id="t-home">')));
assert.doesNotMatch(home,/data-connection-state|home-operator-note/);
assert.match(html,/以前の共有記録を見る/);assert.match(html,/以前の家族からの伝言を見る/);
assert.match(html,/onclick="openPersonTasks\(\)"/);
assert.match(html,/招待せずに一人で始められます/);
assert.match(html,/あとから参加を承認した家族には、これまでの予定・記録・やることも共有/);
assert.doesNotMatch(html,/家族の画面に届けました|家族の画面に記録されました|家族へ伝言を共有しました/);
assert.match(html,/function initHonnin\(\)\{\s*startFamilyConnection/);
assert.match(html,/function initKazoku\(\)\{\s*startFamilyConnection/);
const lifecycle=fs.readFileSync(new URL('../household-ui.js',import.meta.url),'utf8');
assert.match(lifecycle,/function stopHouseholdSubscriptions\(\)\{[\s\S]*?stopFamilyConnection\(\);[\s\S]*?closePersonTasks\(\);/);
console.log('solo integration: invite/pending/approval/recipient/leave/cache/error/stale callbacks and quiet home passed');
