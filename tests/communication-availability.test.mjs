import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(process.env.MAINICO_TEST_HTML||new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf("function canUseFamilyFeature("),html.indexOf('function requireFamilyFeature('));
assert.ok(source.includes('function showCommunication('));
function fixture(){
  const gates=['person','family'].map(kind=>({dataset:{communicationGate:kind},hidden:true}));
  const buttons=[
    {dataset:{sendAudience:'person',replyTo:'greeting'},disabled:true},
    {dataset:{sendAudience:'person',replyTo:'greeting',replyAgain:'true'},disabled:true},
    {dataset:{sendAudience:'family',replyTo:'message',replyAgain:'true'},disabled:true}
  ];
  const states={'person-contact-state':{textContent:''},'h-contact-state':{textContent:''}};
  const c={familyConnection:{status:'unknown',others:null,personOthers:null,familyOthers:null},lastFamilyAudience:null,
    familyHomeItems:[],personConversationItems:[],familyHomeEventStatus:'ready',personConversationStatus:'ready',personIncomingShown:false,
    familyReplyStates:new Map(),familyQuickReplySending:new Set(),aisatsuBackSending:false,askKusuriSending:false,
    familyMessageSending:false,personMessageReplySending:false,uid:()=> 'self',isKOnly:()=>true,currentFamilyMessageId:'',
    personReplyDone:()=>false,document:{getElementById:id=>states[id],querySelectorAll:selector=>selector==='[data-communication-gate]'?gates:selector==='[data-send-audience]'?buttons:[]}};
  vm.createContext(c);vm.runInContext(source,c);return {c,gates,buttons,states};
}
const solo={status:'solo',others:0,personOthers:0,familyOthers:0};
const withPerson={status:'shared',others:1,personOthers:1,familyOthers:0};
const withFamily={status:'shared',others:1,personOthers:0,familyOthers:1};
{
  const f=fixture();f.c.familyHomeItems=[{uid:'person',type:'aisatsu'}];f.c.updateCommunicationAvailability();
  assert.equal(f.gates[0].hidden,false,'初回の参加確認中でも取得済みの本人連絡を隠さない');
  assert.ok(f.buttons.every(v=>v.disabled));assert.match(f.states['person-contact-state'].textContent,/通信を確認/);
  f.c.familyConnection=withFamily;f.c.updateCommunicationAvailability();
  assert.equal(f.gates[0].hidden,false,'相手が家族用へ変更しても本人との過去の会話は残る');
  assert.equal(f.buttons[0].disabled,true);assert.equal(f.buttons[1].disabled,true);
  assert.match(f.states['person-contact-state'].textContent,/本人用の参加者はいません/);
  f.c.familyConnection=solo;f.c.updateCommunicationAvailability();
  assert.equal(f.gates[0].hidden,false,'相手が退出しても共有されていた会話は読める');
  f.c.familyHomeItems=[];f.c.updateCommunicationAvailability();assert.equal(f.gates[0].hidden,true);
}
{
  const f=fixture();f.c.familyConnection=solo;
  for(const row of [{uid:'self',type:'aisatsu'},{uid:'other',type:'memo'},{type:'aisatsu'}]){
    f.c.familyHomeItems=[row];f.c.updateCommunicationAvailability();
    assert.equal(f.gates[0].hidden,true,'自分の生活記録や会話以外の記録で家族欄を復活させない');
  }
  f.c.familyHomeItems=[];f.c.personConversationItems=[{uid:'family',type:'family-message'}];f.c.updateCommunicationAvailability();
  assert.equal(f.gates[1].hidden,false);assert.equal(f.buttons[2].disabled,true);
  assert.match(f.states['h-contact-state'].textContent,/家族用の参加者はいません/);
}
{
  const f=fixture();f.c.familyConnection=withPerson;f.c.familyReplyStates.set('greeting',{status:'sent'});
  f.c.updateCommunicationAvailability();assert.equal(f.buttons[0].disabled,true);assert.equal(f.buttons[1].disabled,false,'自由に書き足す入口だけは返信後も使える');
  for(const status of ['cached','error','loading']){
    f.c.familyHomeEventStatus=status;f.c.updateCommunicationAvailability();assert.equal(f.buttons[1].disabled,true,'自由返信にも元の連絡の通信確認が必要');
  }
  f.c.familyHomeEventStatus='ready';f.c.familyMessageSending=true;f.c.updateCommunicationAvailability();assert.equal(f.buttons[1].disabled,true);
  f.c.familyMessageSending=false;f.c.familyConnection=withFamily;f.c.personReplyDone=()=>true;f.c.updateCommunicationAvailability();
  assert.equal(f.buttons[2].disabled,true,'本人側のreplyAgain指定で重複防止を解除しない');
}
console.log('communication availability: retained history, quiet solo, confirmed recipients, follow-up writing and source status passed');
