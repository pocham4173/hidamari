import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(start,end){
  const from=html.indexOf(start),to=html.indexOf(end,from);
  assert.ok(from>=0&&to>from,`missing source: ${start}`);
  return html.slice(from,to);
}
function fixture(){
  const elements=new Map();
  function element(id){
    if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',style:{},contains:()=>false});
    return elements.get(id);
  }
  const replies=new Map();
  const context={
    familyHomeItems:[],familyHomeEventStatus:'ready',familyReplyStates:replies,
    uid:()=> 'family-A',eventWhoClass:v=>v.type==='family-message-back'||['aisatsu','kibun','kusuri','onegai'].includes(v.type)?'who-honnin':'who-kazoku',
    kusuriSlotName:key=>({asa:'朝',hiru:'昼',yoru:'夜'}[key]||''),kusuriQuestion:()=> '朝の薬は飲みましたか？',
    esc:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    jsArg:value=>String(value??'').replace(/[^A-Za-z0-9_-]/g,''),
    document:{getElementById:element,activeElement:null},updateCommunicationAvailability(){},
  };
  vm.createContext(context);
  vm.runInContext(section('function compareConversationEvents(', 'function personReplyDone('),context);
  vm.runInContext(section('function renderFamilyConversation(){',"let familyYoteiStatus='loading';"),context);
  return {
    context,replies,
    render(rows){context.familyHomeItems=rows;context.renderFamilyConversation();return element('ev-list').innerHTML;},
  };
}
const greeting=(id,text,seconds,person='person-A')=>({_id:id,type:'aisatsu',text,slot:'asa',uid:person,date:'2026-09-17',at:{seconds}});
const message=(id,type,text,seconds,replyTo,owner='family-A')=>({_id:id,type,text,uid:owner,name:owner==='family-A'?'理絵':'本人',date:'2026-09-17',at:{seconds},...(replyTo?{replyTo}:{})});

{
  const f=fixture();
  const morning=greeting('morning-A','おはよう',1);
  const noon=greeting('noon-A','こんにちは',2);
  const response=message('noon-reply','aisatsu-back','こんにちは',3,'noon-A');
  const rendered=f.render([morning,noon,response]);
  assert.match(rendered,/onclick="replyToPersonEvent\('morning-A'\)"/,'unanswered morning retains its own reply control after a newer greeting');
  assert.match(rendered,/class="reply-btn reply-primary"[^>]*data-reply-to="morning-A"/);
  assert.doesNotMatch(rendered,/onclick="replyToPersonEvent\('noon-A'\)"/,'sent preset does not become another send action');
  assert.match(rendered,/disabled aria-disabled="true">返事を送りました/);
  assert.match(rendered,/data-reply-to="noon-A" data-reply-again="true"[^>]*>続けて言葉を送る/);
}
{
  const f=fixture();
  const rows=[greeting('morning-A','おはよう',1),greeting('morning-B','おはよう',2,'person-B'),
    {...greeting('condition-A','元気です',3),type:'kibun'},
    {...greeting('medicine-A','',4),type:'kusuri',slot:'asa'},
    {...greeting('medicine-B','',5,'person-B'),type:'kusuri',slot:'asa'}];
  const rendered=f.render(rows);
  for(const row of rows)assert.ok(rendered.includes(`replyToPersonEvent('${row._id}')`),`${row._id} keeps a distinct reply target`);
  assert.match(rendered,/本人の記録「朝の薬を飲みました」/,'medication remains a person-entered record');
}
{
  const f=fixture();
  const outgoing=message('hello-from-family','aisatsu-back','おはよう',1);
  const written=message('note-from-family','family-message','あとで電話するね',2);
  const rendered=f.render([outgoing,written]);
  assert.match(rendered,/理絵さんが「おはよう」と挨拶しました/,'family can see their own spontaneous greeting');
  assert.match(rendered,/理絵さんからのメッセージ：「あとで電話するね」/);
  assert.match(rendered,/理絵さん（家族）/,'sender and audience role are explicit');
}
{
  const f=fixture();
  const original=greeting('greet-A','おはよう',1);
  const response=message('family-response','aisatsu-back','おはようございます',2,'greet-A');
  const thanks=message('person-thanks','family-message-back','ありがとう',3,'family-response','person-A');
  const rendered=f.render([original,response,thanks]);
  assert.equal((rendered.match(/おはようございます/g)||[]).length,1,'family reply is grouped once under the original greeting');
  assert.equal((rendered.match(/ご本人からの返事：「ありがとう」/g)||[]).length,1,'person response stays visible once in the same conversation');
  assert.ok(rendered.indexOf('と挨拶しました')<rendered.indexOf('おはようございます'));
  assert.ok(rendered.indexOf('おはようございます')<rendered.indexOf('ご本人からの返事'));
}
{
  const f=fixture();
  const orphan=message('reply-to-yesterday','aisatsu-back','今日もおはよう',5,'not-in-today');
  const rendered=f.render([orphan]);
  assert.match(rendered,/今日もおはよう/,'a reply whose original is outside today remains visible');
  const repliedRequest={...greeting('request-A','電話してほしい',1),type:'onegai'};
  const answer=message('request-answer','onegai-back','あとで連絡するね',2,'request-A');
  const requestRendered=f.render([repliedRequest,answer]);
  assert.match(requestRendered,/電話してほしい/,'answered request remains in the conversation');
  assert.match(requestRendered,/あとで連絡するね/);
  assert.doesNotMatch(requestRendered,/onclick="openOnegaiBackFree/,'existing request reply eligibility is unchanged');
  const quiet={...greeting('quiet-A','今日はそっとしておいて',1),type:'onegai'};
  assert.doesNotMatch(f.render([quiet]),/onclick=/,'request for quiet is not a prompt to reply');
}
{
  const f=fixture();
  const rendered=f.render([message('unsafe-label','family-message','<img onerror="bad()">',1)]);
  assert.doesNotMatch(rendered,/<img/);assert.match(rendered,/&lt;img/);
}
console.log('conversation discovery: morning/noon, multiple people, own sends, reply chains, continuation, orphan replies and escaping passed');
