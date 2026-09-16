import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../person-button-feedback.js',import.meta.url),'utf8');
function fixture(){
 const handlers={},timers=new Map(),classes=new Set(),sent=[];let id=0,now=0,current='me',group='home',active=true,parentHidden=false,cssHidden=false;
 const status={textContent:''};
 const button={disabled:false,hidden:false,isConnected:true,dataset:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},
   closest:sel=>sel==='[hidden]'?(parentHidden?{}:null):button,getClientRects:()=>cssHidden?[]:[{}],
   click(detail=0){const e=event(detail);handlers.click(e);if(!e.stopped)sent.push(button.dataset.replyTo??'action');}};
 function event(detail=1){return {target:button,detail,button:0,isPrimary:true,preventDefault(){},stopImmediatePropagation(){this.stopped=true;}};}
 const doc={hidden:false,getElementById:id=>id==='h-message-reply-state'?status:{classList:{contains:()=>active}},addEventListener:(n,f)=>handlers[n]=f};
 vm.runInNewContext(source,{WeakSet,document:doc,window:{uid:()=>current,gid:()=>group,addEventListener:(n,f)=>handlers[n]=f},setTimeout:(f,ms)=>{assert.equal(ms,650);timers.set(++id,{f,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)});
 function advance(ms){now+=ms;for(const [key,timer] of [...timers]){if(timer.at<=now){timers.delete(key);timer.f();}}}
 return {button,doc,handlers,classes,event,timers,status,sent,advance,flush(){advance(650);},writes:()=>sent.length,switchUid:()=>current='other',switchGroup:()=>group='other-home',leave:()=>active=false,hideParent:()=>parentHidden=true,hideCss:()=>cssHidden=true};
}
{
 const e=fixture();e.handlers.pointerdown(e.event());assert.ok(e.classes.has('person-press-held'));e.handlers.pointercancel();assert.equal(e.classes.size,0);assert.equal(e.timers.size,0);
 e.button.click();assert.equal(e.writes(),0);assert.ok(e.classes.has('person-press-latched'));e.button.click();assert.equal(e.timers.size,1);e.flush();assert.equal(e.writes(),1);assert.equal(e.classes.size,0);
}
for(const change of [e=>e.switchUid(),e=>e.switchGroup(),e=>e.leave(),e=>e.button.isConnected=false,e=>e.button.disabled=true,e=>e.button.hidden=true,e=>e.hideParent(),e=>e.hideCss(),e=>e.doc.hidden=true,e=>e.handlers.blur()]){const e=fixture();e.button.click();change(e);e.flush();assert.equal(e.writes(),0);}
{
 const e=fixture();e.button.dataset.replyTo='message-A';e.button.click();
 e.advance(649);assert.equal(e.writes(),0,'the actual action must wait through 649ms');
 e.advance(1);assert.deepEqual(e.sent,['message-A'],'the delayed onclick uses the intended explicit reply target');
}
{
 const e=fixture();e.button.dataset.replyTo='message-A';e.button.click();e.advance(649);
 e.button.dataset.replyTo='message-B';e.advance(1);
 assert.equal(e.writes(),0,'a new arrival during the 650ms delay must never receive the old reply');
 assert.match(e.status.textContent,/新しい連絡.*確認/);assert.equal(e.classes.size,0);
 e.button.click();e.flush();assert.deepEqual(e.sent,['message-B'],'a fresh deliberate press may reply to the new message');
}
{
 const e=fixture();e.button.dataset.replyTo='message-A';e.handlers.pointerdown(e.event());
 e.button.dataset.replyTo='message-B';e.handlers.pointerup();e.button.click(1);e.flush();
 assert.equal(e.writes(),0,'changing the target while the finger is down must also cancel');
 assert.match(e.status.textContent,/新しい連絡/);
}
{
 const e=fixture();e.button.dataset.replyTo='message-A';e.handlers.pointerdown(e.event());e.handlers.pointercancel();
 e.button.dataset.replyTo='message-B';e.button.click(0);e.flush();
 assert.deepEqual(e.sent,['message-B'],'a canceled pointer press must not contaminate a later keyboard action');
}
{
 const e=fixture();e.button.click();e.button.dataset.unrelated='new date';e.advance(650);
 assert.deepEqual(e.sent,['action'],'reading and other buttons without a reply target retain their existing action');
}
console.log('press delay: 650ms replay, reply target pinning, pointer/keyboard, hidden/disabled and household cancellation passed');
