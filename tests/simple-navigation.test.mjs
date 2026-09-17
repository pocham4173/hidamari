import assert from 'node:assert/strict';
import vm from 'node:vm';
import {homeFixture,html} from './helpers/home-conversation-fixture.mjs';

function before(a,b){
  assert.ok(a&&b,'both navigation destinations exist');
  assert.ok(a.compareDocumentPosition(b)&4,'daily action precedes secondary action');
}
function source(start,end){
  const i=html.indexOf(start),j=html.indexOf(end,i);
  assert.ok(i>=0&&j>i,'production source boundaries exist');
  return html.slice(i,j);
}
{
  const f=homeFixture(),entry=f.document.getElementById('entry');
  const modes=[...entry.querySelectorAll('#select-box button')];
  assert.equal(modes.length,3);
  for(const [i,mode] of ['honnin','kazoku','konly'].entries()){
    assert.equal(modes[i].getAttribute('onclick'),`pickMode('${mode}')`,'simplifying labels preserves mode choice');
  }
  assert.match(modes[1].textContent,/本人と家族が使う/);
  assert.match(modes[2].textContent,/家族だけで使う/);
  assert.doesNotMatch(entry.textContent,/家族が記録する/);
  const styles=modes.map(b=>f.dom.window.getComputedStyle(b));
  for(const style of styles){
    assert.equal(style.backgroundColor,styles[0].backgroundColor);
    assert.equal(style.boxShadow,styles[0].boxShadow);
    assert.equal(style.fontSize,styles[0].fontSize);
  }
  assert.doesNotMatch(entry.textContent,/本人も家族も、介護の不安/);
  const install=entry.querySelector('#install-main');
  const installStyle=f.dom.window.getComputedStyle(install);
  assert.equal(installStyle.boxShadow,'none','installation is visually secondary');
  assert.ok(['0px',''].includes(installStyle.borderTopWidth),'installation no longer has a prominent outlined border');
  assert.equal(install.getAttribute('onclick'),'installApp()');
  before(entry.querySelector('#select-box'),install);
  f.close();
}
{
  const f=homeFixture('honnin');
  const incoming={_id:'family-message',uid:'family',type:'family-message',text:'おやすみ',name:'家族',date:'2026-09-18',at:{seconds:1789722100}};
  const family={status:'shared',others:1,personOthers:0,familyOthers:1};
  const solo={status:'solo',others:0,personOthers:0,familyOthers:0};
  const unknown={status:'unknown',others:null,personOthers:null,familyOthers:null};
  f.state(family);f.events([incoming]);
  const grid=f.document.querySelector('#h-message-reply .kibun-grid');
  const retry=f.document.getElementById('person-conversation-retry');
  assert.ok(f.visible(grid));
  await f.click([...grid.querySelectorAll('button')].find(b=>b.textContent==='ありがとう'));
  const result=f.document.getElementById('h-message-reply-state');
  assert.ok(result.textContent);
  f.state(solo);
  assert.ok(f.visible(f.document.getElementById('h-incoming-message')),'past received message stays readable');
  assert.match(f.document.getElementById('h-incoming-message').textContent,/おやすみ/);
  assert.equal(f.visible(grid),false,'confirmed missing recipient does not present an unusable reply menu');
  assert.ok(f.visible(result),'hiding unavailable choices does not hide a saved reply result');
  assert.equal(f.visible(retry),false,'known absence does not ask the person to manage family membership');
  assert.ok([...grid.querySelectorAll('button')].every(b=>b.disabled),'hidden controls retain send authorization');
  f.state(unknown);f.events([incoming],'cached');
  assert.ok(f.visible(retry),'connectivity retry remains available');
  assert.ok(f.visible(grid),'temporary network uncertainty keeps familiar reply choices in place');
  assert.ok([...grid.querySelectorAll('button')].every(b=>b.disabled));
  assert.ok(f.visible(f.document.getElementById('h-incoming-message')));
  f.state(family);f.events([{...incoming,_id:'next-message'}]);
  assert.ok(f.visible(grid),'confirmed recipient restores direct replies');
  assert.ok([...grid.querySelectorAll('button')].every(b=>!b.disabled));
  f.close();
}
{
  const f=homeFixture();
  f.document.getElementById('t-home').style.display='none';
  f.document.getElementById('t-soudan').style.display='block';
  const home=f.document.getElementById('anshin-home');
  const notebook=home.querySelector('[onclick="openMedicineNotebook()"]');
  const contacts=f.document.getElementById('family-contact-area');
  const list=f.document.getElementById('family-contact-list');
  const form=contacts.querySelector('details');
  const consultation=home.querySelector('[onclick="openAnshin(\'soudan\')"]');
  const tag=home.querySelector('[onclick="openAnshin(\'tag\')"]');
  assert.ok(f.visible(notebook));
  before(notebook,contacts);before(contacts,consultation);before(contacts,tag);
  assert.equal(contacts.classList.contains('family-only-card'),false,'ordinary family mode also has phone contacts');
  assert.ok(form&&!form.open,'adding a contact does not occupy the everyday phone view');
  assert.equal(form.contains(list),false,'saved phone numbers are outside the collapsed editor');
  assert.ok(form.contains(f.document.getElementById('family-contact-btn')));
  const modeVisibility=source("document.querySelectorAll('.family-only-card').forEach",'/* おまもりタグ');
  vm.runInContext('const kOnly=false;\n'+modeVisibility,f.c);
  f.c.familyOnlyData={contacts:[{_id:'clinic',uid:'family',kind:'病院',contactName:'かかりつけ',phone:'03-1234-5678',name:'家族'}]};
  vm.runInContext(source('function renderFamilyContacts(){','async function deleteFamilyEvent('),f.c);
  f.c.renderFamilyContacts();
  const call=list.querySelector('a.contact-call');
  assert.ok(f.visible(contacts)&&f.visible(call),'actual mode visibility preserves registered telephone actions');
  assert.equal(call.getAttribute('href'),'tel:0312345678');
  assert.match(call.textContent,/電話する/);
  form.open=true;
  assert.ok(f.visible(f.document.getElementById('family-contact-btn')),'contact registration remains reachable');
  f.close();
}
console.log('Simple navigation: quiet entry, recipient-safe reply choices, retained result, everyday notebook and visible telephone actions passed');

// Exercise the real entry click, persistence and screen selection for all mode pairs.
for(const previous of ['honnin','kazoku','konly']){
  for(const selected of ['honnin','kazoku','konly']){
    const f=homeFixture(),saved=f.c.previewStorage,memberWrites=[];
    saved.setItem('mainicoPendingMode',previous);
    saved.setItem('mainicoName','テスト');
    saved.setItem('mainicoConsent-a','yes');saved.setItem('mainicoConsent-b','yes');
    f.dom.window.scrollTo=()=>{};
    let stopped=0,started='',finished;
    Object.assign(f.c,{
      refreshHousehold:async()=>({}),householdDeleting:false,
      col:()=>({doc:()=>({update:async data=>memberWrites.push(data)})}),
      saveRecoveryPointer:async()=>{},watchHouseholdAccess:()=>{},applyHouseholdPermissions:()=>{},
      stopHouseholdSubscriptions:()=>{stopped++;f.c.stopFamilyConnection();},
      showHouseholdBlocked:message=>{throw new Error(message);},
      initHonnin:()=>{started='honnin';f.c.renderFamilyConnection();},
      initKazoku:()=>{
        started=f.c.isKOnly()?'konly':'kazoku';
        vm.runInContext("{const kOnly=isKOnly();"+source("document.getElementById('card-krec').style.display",'/* おまもりタグ')+'}',f.c);
        f.c.renderFamilyConnection();
      }
    });
    vm.runInContext(source('function isKOnly(){','/* 画面表示用のエスケープ'),f.c);
    vm.runInContext(source('function resetFamilyScroll(){','/* ===== モード選択'),f.c);
    vm.runInContext(source('let pendingMode=null;','function agreeConsent('),f.c);
    vm.runInContext(source('function afterConsent(){','function setupConnectPage(){'),f.c);
    vm.runInContext(source('async function finishSetup(){','async function copyPendingHelp(){'),f.c);
    vm.runInContext(source('function startMode(){','function resetMode(){'),f.c);
    const finish=f.c.finishSetup;f.c.finishSetup=()=>{finished=finish();return finished;};
    saved.setItem('mainicoMode','honnin');saved.setItem('kazokuOnly','1');
    assert.equal(f.c.isKOnly(),false,'stale proxy flag never applies to the person');
    saved.setItem('mainicoMode',previous==='honnin'?'honnin':'kazoku');
    saved.setItem('kazokuOnly',previous==='konly'?'1':'');
    f.c.showPage('entry');
    await f.click(f.document.querySelector(`[onclick="pickMode('${selected}')"]`));await finished;
    assert.equal(started,selected,`${previous} -> ${selected} opens chosen mode`);
    assert.equal(memberWrites[0].mode,selected);
    assert.equal(stopped,1,'previous screen subscriptions are retired');
    assert.equal(f.visible(f.document.getElementById('btn-a')),selected==='honnin');
    assert.equal(f.visible(f.document.getElementById('btn-k-asa')),selected==='honnin');
    assert.equal(f.visible(f.document.getElementById('card-krec')),selected==='konly');
    assert.equal(f.visible(f.document.getElementById('card-care-quick')),selected==='konly');
    for(const status of ['unknown','solo','shared']){
      f.state({status,others:2,personOthers:1,familyOthers:1});
      f.c.testRows=[];vm.runInContext('familyHomeItems=testRows;renderFamilyConversation();',f.c);
      assert.equal(f.visible(f.document.getElementById('card-actions')),selected==='kazoku','membership updates respect the selected screen');
      assert.equal(f.visible(f.document.getElementById('person-conversation-panel')),selected==='honnin');
    }
    f.close();
  }
}
console.log('All 9 mode transitions: person buttons, family replies and proxy recording remain separate');

// An old greeting must not return to the home when the server replays history.
for(const status of ['ready','cached','error']){
  const f=homeFixture('honnin');let day='2026-09-18';f.c.todayStr=()=>day;
  f.state({status:'shared',others:1,personOthers:0,familyOthers:1});
  const at=(date)=>({seconds:new Date(date+'T08:00:00').getTime()/1000});
  const old=[
    {_id:'old-hello',type:'aisatsu-back',text:'おやすみ',date:'2026-09-17',at:at('2026-09-17')},
    {_id:'old-note',type:'family-message',text:'昨日の用事',date:'2026-09-17',at:at('2026-09-17')},
    {_id:'legacy-hello',type:'aisatsu-back',text:'以前の挨拶',at:at('2026-09-16')}
  ];
  f.events(old,status);
  assert.equal(f.c.currentFamilyMessageId,'');
  assert.equal(f.document.getElementById('h-incoming-message').textContent,'');
  assert.equal(f.visible(f.document.getElementById('h-message-reply')),false);
  assert.ok(f.visible(f.document.getElementById('person-history-open')));
  assert.equal(f.spoken.length,0,'old messages are not announced again');
  const today={_id:'today-hello',type:'aisatsu-back',text:'おはよう',date:day,at:at(day)};
  f.events([...old,today],status);
  assert.equal(f.c.currentFamilyMessageId,'today-hello');
  assert.match(f.document.getElementById('h-incoming-message').textContent,/おはよう/);
  f.c.testStatus=status;vm.runInContext('personConversationStatus=testStatus;',f.c);
  f.document.getElementById('person-message-reply-text').value='書きかけの返事';
  f.document.getElementById('person-message-reply-modal').classList.add('show');
  day='2026-09-19';f.c.hBootDay='2026-09-18';f.c.honninSending=true;
  // Run the actual timer body: even when a draft prevents reload, yesterday
  // must leave the home without turning a cache/error into a verified read.
  const init=source('function initHonnin(){','function markAisatsuDone(){');
  const begin=init.indexOf('  const upd=()=>{'),end=init.indexOf('  upd();',begin);
  assert.ok(begin>=0&&end>begin);
  vm.runInContext(init.slice(begin,end)+'upd();',f.c);
  assert.equal(f.c.currentFamilyMessageId,'');
  assert.equal(f.document.getElementById('h-incoming-message').textContent,'');
  assert.equal(f.document.getElementById('person-message-reply-text').value,'書きかけの返事');
  assert.equal(vm.runInContext('personConversationStatus',f.c),status);
  assert.equal(vm.runInContext('personConversationItems.length',f.c),4,'history remains available');
  assert.equal(f.writes.length,0,'expiry does not delete or write family records');
  f.events([...old,today],status);
  assert.equal(f.c.currentFamilyMessageId,'','server replay cannot revive yesterday');
  f.events([{...old[2],_id:'legacy-today',at:at(day)}],status);
  assert.equal(f.c.currentFamilyMessageId,'legacy-today','legacy records use their timestamp');
  vm.runInContext(source('  personDayVisibility=()=>{','  const s=slot();'),f.c);
  Object.defineProperty(f.document,'hidden',{configurable:true,value:false});
  day='2026-09-20';f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  assert.equal(f.c.currentFamilyMessageId,'','returning after midnight clears the old home immediately');
  f.close();
}
console.log('Today-only person home: old greetings expire, history and drafts stay, cached/error state preserved');
