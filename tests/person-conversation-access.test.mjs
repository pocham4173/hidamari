import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
function fixture(){
  let generation=1;
  const elements=new Map(),spoken=[],listeners=[];
  const document={activeElement:null,getElementById:id=>el(id)};
  function el(id){
    if(elements.has(id))return elements.get(id);
    const classes=new Set(),attrs=new Map(),events=new Map();
    const element={id,children:[],parent:null,hidden:false,disabled:false,isConnected:true,tabIndex:0,value:'',textContent:'',
      classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},
      setAttribute:(name,value)=>attrs.set(name,value),getAttribute:name=>attrs.get(name),
      addEventListener:(name,fn)=>events.set(name,fn),appendChild(child){child.parent=element;element.children.push(child);},
      replaceChildren(){element.children.forEach(child=>child.parent=null);element.children=[];},
      focus(){document.activeElement=element;},contains(child){for(let node=child;node;node=node.parent)if(node===element)return true;return false;},
      closest(selector){for(let node=element;node;node=node.parent)if(selector==='[hidden]'&&node.hidden)return node;return null;},
      getClientRects(){for(let node=element;node;node=node.parent)if(node.hidden||node.id.endsWith('-modal')&&!node.classList.contains('show'))return [];return [{}];},
      querySelectorAll(){const result=[];function collect(node){node.children.forEach(child=>{result.push(child);collect(child);});}collect(element);return result;},
      key(key,shiftKey=false){const event={key,shiftKey,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};events.get('keydown')?.(event);return event;},events};
    elements.set(id,element);return element;
  }
  let created=0;document.createElement=tag=>{const node=el('generated-'+(++created));node.tagName=tag.toUpperCase();node.tabIndex=['button','input'].includes(tag)?0:-1;return node;};
  const home=el('honnin');home.classList.add('active');home.appendChild(el('opener'));home.appendChild(el('btn-a'));
  for(const [id,title,inputs] of [
    ['person-message-reply-modal','person-message-reply-title',['person-message-reply-text','person-message-reply-send','person-reply-close']],
    ['person-history-modal','person-history-title',['person-history-date','person-history-state','person-history-list','person-history-close']]
  ]){
    const modal=el(id);modal.setAttribute('aria-labelledby',title);modal.appendChild(el(title));el(title).tabIndex=-1;
    inputs.forEach(name=>modal.appendChild(el(name)));
  }
  el('person-history-list').tabIndex=-1;el('person-history-state').tabIndex=-1;
  const c={document,Map,Set,WeakSet,Date,console,
    communicationSession:()=>{const captured=generation;return ()=>captured===generation;},
    uid:()=> 'person',gid:()=> 'family',todayStr:()=> '2026-09-17',currentFamilyMessageId:'message',
    familyMessageTarget:id=>({id}),personReplyDone:()=>false,speak:(...args)=>spoken.push(args),
    canUseFamilyFeature:()=>true,compareConversationEvents:(a,b)=>(a.at?.seconds||0)-(b.at?.seconds||0),
    kusuriQuestion:()=>'',col:()=>({where:()=>({onSnapshot:(_opts,ok)=>{listeners.push(ok);return ()=>{};}})})};
  vm.createContext(c);
  vm.runInContext(section('/* Focus changes only when a person opens','async function sendPersonMessageReply(){'),c);
  vm.runInContext(section('let personHistoryUnsub=null,','async function replyToHistory('),c);
  return {c,document,el,spoken,listeners,nextSession:()=>generation++};
}

{
  const f=fixture();f.el('opener').focus();f.c.openPersonMessageReply();
  assert.equal(f.document.activeElement,f.el('person-message-reply-text'),'自由返信は入力欄から始める');
  const modal=f.el('person-message-reply-modal');
  assert.equal(modal.key('Tab',true).prevented,true);assert.equal(f.document.activeElement,f.el('person-reply-close'),'先頭から逆Tabは閉じるへ');
  assert.equal(modal.key('Tab').prevented,true);assert.equal(f.document.activeElement,f.el('person-message-reply-text'),'末尾Tabは先頭へ');
  f.el('person-message-reply-text').value='書きかけの言葉';
  assert.equal(modal.key('Escape').prevented,true);assert.equal(modal.classList.contains('show'),false);
  assert.equal(f.document.activeElement,f.el('opener'),'閉じると元のボタンへ戻る');
}
{
  const f=fixture();f.el('opener').focus();f.c.openPersonHistory();
  assert.equal(f.document.activeElement,f.el('person-history-title'),'履歴は見出しから始める');
  f.el('person-history-modal').key('Tab');assert.equal(f.document.activeElement,f.el('person-history-date'));
  f.c.closePersonHistory();assert.equal(f.document.activeElement,f.el('opener'));
}
for(const reason of ['new-session','explicit-reset','other-focus','different-page']){
  const f=fixture();f.el('opener').focus();f.c.openPersonHistory();
  if(reason==='new-session')f.nextSession();
  if(reason==='other-focus')f.el('elsewhere').focus();
  if(reason==='different-page')f.el('honnin').classList.remove('active');
  const before=f.document.activeElement;
  f.c.closePersonHistory(reason!=='explicit-reset');
  assert.equal(f.document.activeElement,before,'旧家庭・リセット・別操作のフォーカスを奪わない: '+reason);
}
{
  const f=fixture();f.el('opener').focus();f.c.openPersonMessageReply();f.el('opener').disabled=true;
  f.c.closePersonMessageReply();assert.equal(f.document.activeElement,f.el('btn-a'),'元のボタンが無効になったら本人のホームへ戻る');
}
{
  const f=fixture();f.el('opener').focus();f.c.openPersonHistory();f.el('person-history-date').focus();
  const snapshot={metadata:{fromCache:false,hasPendingWrites:false},forEach:fn=>fn({id:'message',data:()=>({type:'family-message',name:'家族',text:'おはよう',at:{seconds:1}})})};
  f.listeners[0](snapshot);
  assert.equal(f.document.activeElement,f.el('person-history-date'),'新着や再描画ではフォーカスを移さない');
  const read=f.el('person-history-list').children[0].children.find(item=>item.textContent==='声で読む');
  read.events.get('click')();assert.equal(f.spoken.at(-1)[1],true,'自分で押した声で読むは自動読み上げオフでも動く');
  assert.match(f.spoken.at(-1)[0],/おはよう/);
  read.focus();f.el('person-history-modal').key('Escape');
  assert.equal(f.document.activeElement,f.el('opener'),'動的な履歴のボタンから閉じても、履歴を消す前に起点へ戻る');
}
for(const id of ['person-message-reply','person-history']){
  assert.match(html,new RegExp('id="'+id+'-modal" role="dialog" aria-modal="true" aria-labelledby="'+id+'-title"'));
}
assert.match(html,/closePersonHistory\(false\)/);assert.match(html,/closePersonMessageReply\(false\)/);
console.log('person conversation access: dialog focus, keyboard containment, explicit speech, and stale-session focus protection passed');
