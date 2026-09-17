import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
export const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function section(a,b){const i=html.indexOf(a),j=html.indexOf(b,i);assert.ok(i>=0&&j>i,a);return html.slice(i,j);}

// Execute production functions against the complete production markup, including
// ancestors, details, CSS visibility and real generated onclick attributes.
export function homeFixture(screen='kazoku',identity=screen==='kazoku'?'family':'person'){
  const dom=new JSDOM(html,{url:'https://example.invalid/hidamari/',runScripts:'outside-only'});
  const c=dom.getInternalVMContext(),document=dom.window.document,writes=[],alerts=[],spoken=[],storage=new Map();
  let account=identity,group='home';
  Object.assign(c,{uid:()=>account,gid:()=>group,householdBootGeneration:1,isKOnly:()=>false,
    MainicoFamilyConnection:require('../../family-connection.js'),
    currentFamilyMessageId:'',aisatsuBackSending:false,askKusuriSending:false,familyMessageSending:false,
    personMessageReplySending:false,honninSending:false,onegaiBackFreeId:'',honninUnsub:null,evUnsub:null,
    feedback(){},speak:t=>spoken.push(t),timeYomi:t=>t,validKusuriSlot:k=>['asa','hiru','yoru'].includes(k),
    kusuriSlotName:k=>({asa:'朝',hiru:'昼',yoru:'夜'}[k]||''),kusuriQuestion:()=> '朝の薬は飲みましたか？',slot:()=>({key:'asa'}),
    todayStr:()=> '2026-09-18',myName:()=>identity==='family'?'家族':'本人',
    esc:v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
    jsArg:v=>String(v??'').replace(/[^A-Za-z0-9_-]/g,''),eventWhoClass:()=> 'who-honnin',
    previewStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},alert:t=>alerts.push(t),
    closePersonHistory(){},familyTaskListMode:'all',changeFamilyTaskList(){},renderTodayQuickRecords(){},
    addEvent:async payload=>{writes.push({...payload,uid:account});},
  });
  dom.window.HTMLElement.prototype.scrollIntoView=function(){};
  vm.runInContext(section('let familyConnection={','let personTasksController=null;'),c);
  vm.runInContext(section('/* Conversation state is scoped','/* ===== 家族 ===== */'),c);
  vm.runInContext(section('function renderFamilyConversation(){',"let familyYoteiStatus='loading';"),c);
  vm.runInContext(section('function subscribeFamilyConversation(){','function initKazoku(){'),c);
  vm.runInContext(section('function renderPersonConversation(', 'function initHonnin(){'),c);
  vm.runInContext(section('let familyMessageSending=false;',"let onegaiBackFreeId='';"),c);
  vm.runInContext(section('let personMessageReplySending=false;', 'function recKibun(text)'),c);
  document.querySelectorAll('.page').forEach(el=>el.classList.remove('active'));
  document.getElementById(screen).classList.add('active');
  document.getElementById('t-home').style.display='block';
  function state(value){c.testConnection=value;vm.runInContext('familyConnection=testConnection;renderFamilyConnection();',c);}
  function events(rows,status='ready'){
    if(screen==='honnin')c.renderPersonConversation(rows,{fromCache:status!=='ready'});
    else{c.testRows=rows;c.testStatus=status;vm.runInContext('familyHomeItems=testRows;familyHomeEventStatus=testStatus;renderFamilyConversation();',c);}
  }
  function visible(el){
    if(!el)return false;
    for(let node=el;node&&node.nodeType===1;node=node.parentElement){
      const style=dom.window.getComputedStyle(node);
      if(node.hidden||style.display==='none'||style.visibility==='hidden')return false;
      if(node.tagName==='DETAILS'&&!node.open&&el!==node&&!node.querySelector('summary')?.contains(el))return false;
    }
    return true;
  }
  async function click(el){assert.ok(visible(el),'button and all its ancestors are visible');assert.equal(el.disabled,false,'button is enabled');const handler=vm.runInContext('(function(){return '+el.getAttribute('onclick')+';})',c);return await handler.call(el);}
  function close(){if(c.evUnsub)c.evUnsub();if(c.honninUnsub)c.honninUnsub();c.stopFamilyConnection();dom.window.close();}
  return {c,document,dom,writes,alerts,spoken,state,events,visible,click,close,setGroup:v=>group=v,setAccount:v=>account=v};
}
