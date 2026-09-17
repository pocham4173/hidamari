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
 const f=homeFixture();
 for(const state of [unknown,solo,person]){
   f.state(state);f.events([]);
   assert.ok(f.visible(f.document.getElementById('card-actions')),'empty or unconfirmed membership cannot hide the entire conversation');
 }
 f.state(person);f.events([greeting,reply,thanks]);
 const row=f.document.querySelector('#ev-list > .ev');
 assert.match(row.textContent,/本人からの返事：「ありがとう」/,'latest incoming reply is first, not nested below an old greeting');
 const button=row.querySelector('[onclick^="replyToPersonEvent"]');
 await f.click(button);assert.equal(f.writes[0].replyTo,'thanks');assert.equal(f.writes[0].text,'ありがとう');
 f.events([greeting,reply,thanks],'cached');
 assert.ok(f.visible(f.document.querySelector('#ev-list > .ev')),'cached conversation remains readable');
 assert.ok([...f.document.querySelectorAll('#ev-list [data-send-audience]')].every(b=>b.disabled));
 f.state(unknown);assert.ok(f.visible(f.document.getElementById('family-conversation-retry')));
 assert.equal(f.document.getElementById('conversation-setup-entry'),null,'no explanation button replaces the conversation');
 f.close();
}
{
 const f=homeFixture();f.state(person);
 const rows=Array.from({length:8},(_,i)=>({...greeting,_id:'greet-'+i,text:'挨拶'+i,at:{seconds:i+1}}));
 f.events(rows);
 assert.equal(f.document.querySelectorAll('#ev-list > .ev').length,3,'home stays short');
 const details=f.document.getElementById('family-earlier-conversation');assert.equal(details.open,false);
 assert.equal(f.visible(details.querySelector('.ev')),false);details.open=true;
 f.events([...rows,{...thanks,at:{seconds:9}}]);assert.equal(f.document.getElementById('family-earlier-conversation').open,true,'arrival does not close expanded history');
 f.events([{...thanks,text:'<img src=x onerror=alert(1)>'}]);assert.equal(f.document.querySelector('#ev-list img'),null,'message content cannot create markup');
 f.close();
}
{
 const f=homeFixture('honnin');f.state(family);f.events([greeting,reply]);
 const panel=f.document.getElementById('person-conversation-panel');assert.ok(f.visible(panel));
 assert.equal(f.document.querySelector('.h-body').firstElementChild,panel,'person conversation precedes schedules');
 assert.match(f.document.getElementById('h-incoming-message').textContent,/9月17日.*おはよう/,'yesterday is clearly dated on home');
 const button=[...f.document.querySelectorAll('#h-message-reply button')].find(b=>b.textContent==='ありがとう');
 await f.click(button);assert.equal(f.writes[0].replyTo,'reply');assert.equal(f.writes[0].text,'ありがとう');
 f.state(unknown);assert.ok(f.visible(panel));assert.ok(button.disabled);
 f.close();
}
{
 const f=homeFixture('honnin');f.state(family);
 const question={...reply,_id:'question',type:'ask-kusuri',text:'',slot:'asa',date:'2026-09-18',at:{seconds:1789722100}};
 f.events([reply,question]);assert.match(f.document.getElementById('h-incoming-message').textContent,/朝の薬は飲みましたか/);
 await f.click(f.document.querySelector('#h-message-reply button'));
 assert.equal(f.writes[0].replyTo,'question');assert.equal(f.writes[0].type,'family-message-back','acknowledgement is a reply, not a medication record');
 f.events([reply,{...question,date:'2026-09-17'}]);assert.match(f.document.getElementById('h-incoming-message').textContent,/おはよう/,'old medication question is not shown as a current instruction');
 f.close();
}
assert.ok(html.indexOf('id="card-actions"')<html.indexOf('id="family-handoff-heading"'));
console.log('Production DOM: visible home conversations, latest reply first, inline continuation, previous-day contact, hidden ancestors, bounded home, retry and XSS passed');
