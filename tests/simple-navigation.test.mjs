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
  assert.match(modes[1].textContent,/家族が使う/);
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
