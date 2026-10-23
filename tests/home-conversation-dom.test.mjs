import assert from 'node:assert/strict';
import {homeFixture,html} from './helpers/home-conversation-fixture.mjs';
const person={status:'shared',others:1,personOthers:1,familyOthers:0};
const family={status:'shared',others:1,personOthers:0,familyOthers:1};
const solo={status:'solo',others:0,personOthers:0,familyOthers:0};
const unknown={status:'unknown',others:null,personOthers:null,familyOthers:null};
const greeting={_id:'hello',uid:'person',type:'aisatsu',text:'おはよう',slot:'asa',date:'2026-09-17',at:{seconds:1789635600}};
const reply={_id:'reply',uid:'family',name:'家族',type:'aisatsu-back',text:'おはよう',replyTo:'hello',date:'2026-09-17',at:{seconds:1789635610}};
const thanks={_id:'thanks',uid:'person',name:'本人',type:'family-message-back',text:'ありがとう',replyTo:'reply',date:'2026-09-18',at:{seconds:1789722000}};
{
 const f=homeFixture();f.state(person);
 const types=['aisatsu','kibun','kusuri','family-message-back','aisatsu-back','ask-kusuri','family-message','onegai-back'];
 const rows=types.map((type,i)=>({...greeting,type,_id:'source-'+i,text:'記録'+i,at:{seconds:i+1}}));
 f.events(rows);
 const fromPerson=f.document.getElementById('conversation-from-person');
 const fromFamily=f.document.getElementById('conversation-from-family');
 assert.equal(fromPerson.querySelector('h5').textContent,'本人から');
 assert.equal(fromFamily.querySelector('h5').textContent,'家族から');
 for(let i=0;i<types.length;i++){
   assert.ok((i<4?fromPerson:fromFamily).textContent.includes('記録'+i)||types[i]==='kusuri'||types[i]==='ask-kusuri');
 }
 assert.equal(fromPerson.querySelectorAll('.ev').length,4);
 assert.equal(fromFamily.querySelectorAll('.ev').length,4,'orphan request replies remain visible in family frame');
 assert.equal(fromPerson.querySelectorAll(':scope > .ev').length,2);
 assert.equal(fromFamily.querySelectorAll(':scope > .ev').length,2);
 assert.equal(fromFamily.querySelectorAll('[data-person-reply]').length,0,'family outgoing records do not request a reply to oneself');
 const history=f.document.getElementById('family-earlier-conversation-family');history.open=true;history.querySelector('summary').focus();
 f.events([...rows,{...reply,_id:'new-family',text:'また電話するね',at:{seconds:100}}]);
 assert.equal(f.document.querySelector('#conversation-from-family > .ev').textContent.includes('また電話するね'),true);
 assert.equal(f.document.getElementById('family-earlier-conversation-family').open,true);
 assert.equal(f.document.activeElement.closest('details').id,'family-earlier-conversation-family','live update preserves history focus');
 f.events([greeting]);assert.match(f.document.getElementById('conversation-from-family').textContent,/今日・昨日の記録はありません/);
 f.events([],'error');assert.match(f.document.getElementById('conversation-from-person').textContent,/通信を確認/);
 assert.doesNotMatch(f.document.getElementById('conversation-from-person').textContent,/記録はまだありません/,'failure must not become empty-success');
 assert.equal(f.writes.length,0);f.close();
}
{
 const f=homeFixture();f.state(person);
 const at=(hour,minute)=>({seconds:new Date(2026,8,18,hour,minute).getTime()/1000});
 const morning={_id:'med-am',uid:'person',type:'kusuri',slot:'asa',date:'2026-09-18',at:at(7,5)};
 const noon={...morning,_id:'med-noon',slot:'hiru',at:at(12,3)};
 const proxy={...morning,_id:'proxy',type:'kusuri-kakunin',at:at(13,0)};
 f.events([noon,{...morning,_id:'yesterday',date:'2026-09-17',at:at(23,0)},morning,proxy]);
 const glance=f.document.getElementById('today-glance');
 assert.match(glance.textContent,/お薬の記録 2回/);
 assert.match(glance.querySelector('.medicine-latest').textContent,/最新のお薬：昼の記録 · 12:03/);
 assert.match(glance.textContent,/記録が保存された時刻です。飲んだ時刻の確認ではありません/);
 f.events([morning]);assert.match(glance.textContent,/朝の記録 · 7:05/,'removed records do not stay in the summary');
 f.events([morning],'cached');assert.equal(glance.querySelector('.medicine-latest'),null,'cached records are not presented as latest');
 f.events([]);assert.doesNotMatch(glance.textContent,/7:05/);
 f.c.renderTodayGlance([{...morning,at:null}]);assert.match(glance.textContent,/記録時刻を確認できません/);
 f.c.isKOnly=()=>true;f.events([morning]);assert.equal(glance.hidden,true);
 f.c.isKOnly=()=>false;f.events([morning],'loading');assert.equal(glance.hidden,true);
 assert.equal(f.writes.length,0,'showing a timestamp never writes or sends anything');
 f.close();
}
{
 const f=homeFixture();
 for(const state of [unknown,solo,person]){
   f.state(state);f.events([]);
   assert.ok(f.visible(f.document.getElementById('card-actions')),'empty or unconfirmed membership cannot hide the entire conversation');
 }
 f.state(person);f.events([greeting,reply,thanks]);
 const row=f.document.querySelector('#conversation-from-person > .ev');
 assert.match(row.textContent,/本人からの返事：「ありがとう」/,'latest incoming reply is first, not nested below an old greeting');
 const button=row.querySelector('[onclick^="replyToPersonEvent"]');
 assert.equal(f.visible(button),false,'reply choices stay closed until requested');
 assert.equal(f.writes.length,0,'reading does not send a reply');
 button.closest('details').open=true;
 f.events([greeting,reply,thanks]);
 assert.ok(f.document.querySelector('[data-person-reply="thanks"]').open,'live update keeps the chosen reply open');
 await f.click(f.document.querySelector('[data-person-reply="thanks"] [onclick^="replyToPersonEvent"]'));assert.equal(f.writes[0].replyTo,'thanks');assert.equal(f.writes[0].text,'ありがとう');
 f.events([greeting,reply,thanks],'cached');
 assert.ok(f.visible(f.document.querySelector('#conversation-from-person > .ev')),'cached conversation remains readable');
 assert.ok([...f.document.querySelectorAll('#ev-list [data-send-audience]')].every(b=>b.disabled));
 f.state(unknown);assert.ok(f.visible(f.document.getElementById('family-conversation-retry')));
 assert.equal(f.document.getElementById('conversation-setup-entry'),null,'no explanation button replaces the conversation');
 f.close();
}
{
 const f=homeFixture();f.state(person);
 const rows=Array.from({length:8},(_,i)=>({...greeting,_id:'greet-'+i,text:'挨拶'+i,at:{seconds:i+1}}));
 f.events(rows);
 assert.equal(f.document.querySelectorAll('#conversation-from-person > .ev').length,2,'each source stays short');
 const details=f.document.getElementById('family-earlier-conversation-person');assert.equal(details.open,false);
 assert.equal(f.visible(details.querySelector('.ev')),false);details.open=true;
 f.events([...rows,{...thanks,at:{seconds:9}}]);assert.equal(f.document.getElementById('family-earlier-conversation-person').open,true,'arrival does not close expanded history');
 f.events([{...thanks,text:'<img src=x onerror=alert(1)>'}]);assert.equal(f.document.querySelector('#ev-list img'),null,'message content cannot create markup');
 f.close();
}
{
 const f=homeFixture('honnin');f.state(family);f.events([greeting,reply]);
 const panel=f.document.getElementById('person-conversation-panel');assert.ok(f.visible(panel));
 // 受け取った招待・参加を待っている人・つながっている人の1行・ホーム画面に追加・安全のお知らせのカード(ふだんは空か隠れている)は、ホームの一番上に置く。それ以外で数える
 const bodyKids=[...f.document.querySelector('.h-body').children].filter(el=>!['invite-switch','h-approve','next-invite-h','person-security-notices'].includes(el.id)&&!el.hasAttribute('data-install-card')&&!el.hasAttribute('data-connected-people'));
 const hTodayIndex=bodyKids.indexOf(f.document.getElementById('h-today'));
 assert.ok(hTodayIndex>=0&&hTodayIndex<=1,'今日の予定は本人画面の最上部側（初回案内の次まで）にある');
 assert.equal(bodyKids[0],f.document.querySelector('.person-welcome'),'日付の次は、本人の今日と押して聞ける挨拶');
 assert.ok(bodyKids.indexOf(f.document.getElementById('speech-notice'))>bodyKids.indexOf(f.document.getElementById('kusuri-box')),'声の説明は毎日の記録の下に置く');
 assert.ok(bodyKids.indexOf(f.document.getElementById('btn-a'))<bodyKids.indexOf(panel),'毎日の挨拶ボタンがやりとりより先に来る');
 assert.equal(f.document.getElementById('h-incoming-message').textContent,'','yesterday is kept off today’s home');
 assert.equal(panel.open,false);assert.equal(f.visible(f.document.getElementById('person-history-open')),false);
 panel.open=true;assert.ok(f.visible(f.document.getElementById('person-history-open')));
 f.events([greeting,{...reply,date:'2026-09-18',at:{seconds:1789722010}}]);
 assert.match(f.document.getElementById('h-incoming-message').textContent,/9月18日.*おはよう/);
 const button=[...f.document.querySelectorAll('#h-message-reply button')].find(b=>b.textContent==='ありがとう');
 await f.click(button);assert.equal(f.writes[0].replyTo,'reply');assert.equal(f.writes[0].text,'ありがとう');
 f.state(unknown);assert.ok(f.visible(panel));assert.ok(button.disabled);
 f.close();
}
{
 const f=homeFixture('honnin');f.state(family);
 const question={...reply,_id:'question',type:'ask-kusuri',text:'',slot:'asa',date:'2026-09-18',at:{seconds:1789722100}};
 f.events([reply,question]);assert.match(f.document.getElementById('h-incoming-message').textContent,/朝の薬は飲みましたか/);
 f.document.getElementById('person-conversation-panel').open=true;
 await f.click(f.document.querySelector('#h-message-reply button'));
 assert.equal(f.writes[0].replyTo,'question');assert.equal(f.writes[0].type,'family-message-back','acknowledgement is a reply, not a medication record');
 f.events([reply,{...question,date:'2026-09-17'}]);assert.equal(f.document.getElementById('h-incoming-message').textContent,'','neither yesterday’s greeting nor its medication question stays on home');
 f.close();
}
{
 const f=homeFixture();f.state(person);f.events([greeting]);
 const details=f.document.querySelector('[data-person-reply="hello"]');details.open=true;
 details.querySelector('summary').focus();
 f.events([{...greeting,text:'こんにちは'}]);
 assert.equal(f.document.activeElement.tagName,'SUMMARY','live update preserves the focused disclosure');
 f.c.addEvent=async()=>{throw new Error('isolated rejection');};
 await f.click(f.document.querySelector('[onclick^="replyToPersonEvent"]'));
 const current=f.document.querySelector('[data-person-reply="hello"]');
 assert.ok(current.open);assert.ok(f.visible(current.querySelector('button')),'failure leaves retry reachable');
 assert.ok(f.document.querySelector('#person-reply-state-hello').textContent.length>0);
 assert.equal(f.writes.length,0);f.close();
}
// 家族のホーム(2026-10-10): 「今日見ること」の中に、今日の様子・やりとり → 「記録する」
assert.ok(html.indexOf('id="family-handoff-heading"')<html.indexOf('id="card-actions"'));
assert.ok(html.indexOf('id="card-actions"')<html.indexOf('id="home-record-heading"'));
console.log('Production DOM: visible home conversations, latest reply first, inline continuation, today-only contact and previous-day history access, hidden ancestors, bounded home, retry and XSS passed');

{
 const f=homeFixture();f.state(person);
 const ids=['card-person-today','card-next-yotei','family-requests-panel','card-today-records'];
 for(let i=1;i<ids.length;i++)assert.ok(f.document.getElementById(ids[i-1]).compareDocumentPosition(f.document.getElementById(ids[i])) & 4,'summary, schedule, request, history follow reading order');
 const at={seconds:new Date(2026,8,18,7,10).getTime()/1000};
 f.events([{...greeting,date:'2026-09-18',at}]);
 const glance=f.document.getElementById('today-glance');
 assert.equal(glance.querySelectorAll('.glance-row').length,3);
 assert.match(glance.querySelector('.glance-row').textContent,/7:10/);
 assert.equal(glance.querySelectorAll('button').length,0,'reading the summary requires no reply');
 f.events([],'error');assert.doesNotMatch(glance.textContent,/まだ今日の記録はありません/);
 f.events([],'cached');assert.match(glance.textContent,/確認できません/);
 f.events([]);assert.match(glance.textContent,/まだ今日の記録はありません/);
 f.c.isKOnly=()=>true;f.state(person);assert.equal(f.visible(f.document.getElementById('card-person-today')),false);
 assert.equal(f.writes.length,0);f.close();
}

{
 const f=homeFixture();f.state(person);
 f.events([{...greeting,_id:'old',date:'2026-09-16',text:'古い挨拶'},{...reply,_id:'old-reply',date:'2026-09-16',text:'古い返事'},{...greeting,_id:'yesterday',date:'2026-09-17',text:'昨日の挨拶'}]);
 const box=f.document.getElementById('ev-list');
 assert.doesNotMatch(box.textContent,/古い挨拶|古い返事/);
 assert.match(box.textContent,/昨日の挨拶/);
 f.c.todayStr=()=> '2026-09-19';f.c.renderFamilyConversation();assert.doesNotMatch(box.textContent,/昨日の挨拶/,'age out without deleting saved records');
 assert.equal(f.c.recentHomeRecord({date:'2026-09-30'},'2026-10-01'),true);
 assert.equal(f.c.recentHomeRecord({date:'2025-12-31'},'2026-01-01'),true);
 assert.equal(f.c.recentHomeRecord({date:'2026-10-02'},'2026-10-01'),false);
 assert.equal(f.writes.length,0);f.close();
}
