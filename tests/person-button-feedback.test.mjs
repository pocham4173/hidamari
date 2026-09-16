import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../person-button-feedback.js',import.meta.url),'utf8');
function fixture(){
 const handlers={},timers=new Map(),classes=new Set();let id=0,writes=0,current='me',active=true;
 const button={disabled:false,isConnected:true,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},click(){const e=event();handlers.click(e);if(!e.stopped)writes++;}};
 function event(){return {target:{closest:()=>button},button:0,isPrimary:true,preventDefault(){},stopImmediatePropagation(){this.stopped=true;}};}
 const doc={hidden:false,getElementById:()=>({classList:{contains:()=>active}}),addEventListener:(n,f)=>handlers[n]=f};
 vm.runInNewContext(source,{WeakSet,document:doc,window:{uid:()=>current,gid:()=> 'group',addEventListener:(n,f)=>handlers[n]=f},setTimeout:(f,ms)=>{assert.equal(ms,650);timers.set(++id,f);return id;},clearTimeout:id=>timers.delete(id)});
 return {button,doc,handlers,classes,event,timers,flush(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(f=>f());},writes:()=>writes,switchUid:()=>current='other',leave:()=>active=false};
}
{
 const e=fixture();e.handlers.pointerdown(e.event());assert.ok(e.classes.has('person-press-held'));e.handlers.pointercancel();assert.equal(e.classes.size,0);assert.equal(e.timers.size,0);
 e.button.click();assert.equal(e.writes(),0);assert.ok(e.classes.has('person-press-latched'));e.button.click();assert.equal(e.timers.size,1);e.flush();assert.equal(e.writes(),1);assert.equal(e.classes.size,0);
}
for(const change of [e=>e.switchUid(),e=>e.leave(),e=>e.button.isConnected=false,e=>e.button.disabled=true,e=>e.doc.hidden=true,e=>e.handlers.blur()]){const e=fixture();e.button.click();change(e);e.flush();assert.equal(e.writes(),0);}
console.log('press delay: action waits, exactly once, scroll cancel and context cancellation passed');
