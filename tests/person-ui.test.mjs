/* ご本人の画面に出すもの（作り直し第2回）: お薬の朝昼夜・新しい家庭の初期設定 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=(a,b)=>{const i=html.indexOf(a),j=html.indexOf(b,i);assert.ok(i>=0&&j>i,a);return html.slice(i,j);};
const dom=new JSDOM(html,{url:'https://example.invalid/hidamari/',runScripts:'outside-only'});
const c=dom.getInternalVMContext(),d=dom.window.document;
let listener=null;const written=[];
Object.assign(c,{previewStorage:dom.window.localStorage,gid:()=>'home',personDay:()=>'2026-10-02',todayStr:()=>'2026-10-02',
  col:()=>({where:()=>({onSnapshot:(ok)=>{listener=ok;return()=>{};}})}),
  foByNewest:(a,b)=>(b.clientAt||0)-(a.clientAt||0),foState(){},myName:()=>'太郎',addEvent:async e=>{written.push(e);}});
vm.runInContext(source('const PERSON_UI_KEYS=','/* 家族の名簿'),c);
const snap=rows=>({metadata:{fromCache:false},forEach:fn=>rows.forEach(v=>fn({data:()=>v}))});
const shown=id=>d.getElementById(id).style.display!=='none';
c.initPersonUiConfig();
// 1. 設定の記録がない家庭（今まで使っている家庭）は、全部出す
listener(snap([]));
for(const id of ['h-open-cal','h-open-tasks','h-open-yotei','btn-k-asa','btn-k-hiru','btn-k-yoru','kusuri-box'])assert.ok(shown(id),id);
// 2. お薬は朝・昼・夜ごとに隠せる
listener(snap([{type:'person-ui-config',hide:['k-hiru'],clientAt:1}]));
assert.ok(shown('btn-k-asa'));assert.ok(!shown('btn-k-hiru'));assert.ok(shown('btn-k-yoru'));assert.ok(shown('kusuri-box'));
assert.ok(!shown('btn-ask-hiru'),'家族の「昼の薬 飲んだ？」も隠す(ご本人が答えられない問いを送らない)');assert.ok(shown('btn-ask-asa'));
// 3. 3つとも隠すと、お薬の欄ごと隠れる
listener(snap([{type:'person-ui-config',hide:['k-asa','k-hiru','k-yoru'],clientAt:2}]));
assert.ok(!shown('kusuri-box'));
// 4. 新しい家庭の初期設定（カレンダー・やること・予定を入れる を隠す）。お薬はそのまま
listener(snap([{type:'person-ui-config',hide:vm.runInContext('PERSON_UI_NEW_HOUSEHOLD_HIDE',c),initial:true,clientAt:3}]));
assert.deepEqual([...vm.runInContext('PERSON_UI_NEW_HOUSEHOLD_HIDE',c)],['cal','tasks','yotei']);
for(const id of ['h-open-cal','h-open-tasks','h-open-yotei'])assert.ok(!shown(id),id);
for(const id of ['btn-k-asa','btn-k-hiru','btn-k-yoru','kusuri-box'])assert.ok(shown(id),id);
// 5. 家族の設定画面のチェックに反映され、保存すると隠すものだけ記録する
c.renderPersonUiConfig();
const box=[...d.querySelectorAll('#pui-checks input')];
assert.deepEqual(box.map(x=>x.value),['kibun','cal','tasks','yotei','k-asa','k-hiru','k-yoru']);
assert.deepEqual(box.filter(x=>!x.checked).map(x=>x.value),['cal','tasks','yotei']);
d.querySelector('#pui-checks input[value="cal"]').checked=true;d.querySelector('#pui-checks input[value="k-yoru"]').checked=false;
await c.savePersonUiConfig();
assert.deepEqual([...written.at(-1).hide],['tasks','yotei','k-yoru']);
// 6. 知らない値は無視する
listener(snap([{type:'person-ui-config',hide:['x','k-asa'],clientAt:4}]));
assert.ok(!shown('btn-k-asa'));assert.ok(shown('h-open-cal'));
// 7. 初期設定を書くのは「この端末で新しく作った家庭」だけ。家族だけの家庭には書かない
const finish=source('async function finishSetup(){','async function copyPendingHelp(');
assert.match(finish,/previewStorage\.getItem\('mainicoNewHouseholdUi'\)===groupId/,'途中で読み込み直しても、新しい家庭の初期設定を書く');
assert.match(source('const ref=old?db.collection','let joiningGroup=false;'),/previewStorage\.setItem\('mainicoNewHouseholdUi',ref\.id\)/);
assert.match(finish,/newHouseholdId===groupId[\s\S]*m!=='konly'[\s\S]*type:'person-ui-config',hide:PERSON_UI_NEW_HOUSEHOLD_HIDE\.slice\(\),initial:true/);
assert.match(source('const ref=old?db.collection','let joiningGroup=false;'),/await batch\.commit\(\);\s*assertSameAccount\(\);\s*newHouseholdId=ref\.id;/);
assert.doesNotMatch(source('async function joinByCode(){','async function finishSetup(){'),/newHouseholdId=/,'招待で参加した人は初期設定を書かない');
console.log('ご本人の画面に出すもの: 今までの家庭・お薬の朝昼夜・欄ごと隠す・新しい家庭の初期設定・設定画面・知らない値・書く条件 7項目 passed');
