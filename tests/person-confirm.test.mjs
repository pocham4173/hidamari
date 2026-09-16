import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fixture(){
 const elements=new Map(),writes=[];let currentUid='one',currentGid='group';
 const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:'',style:{},classList:{add(){},remove(){}},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(id);};
 const c={document:{getElementById:el},honninSending:false,uid:()=>currentUid,gid:()=>currentGid,speak(){},closeOnegai(){},feedback(){},beginSend:()=>true,endSend(){},previewStorage:{getItem:()=>null,setItem(){}},todayStr:()=> '2026-09-16',slot:()=>({key:'asa',tx:'おはよう'}),markAisatsuDone(){},validKusuriSlot:()=>true,kusuriSlotName:()=> '朝',markKusuriDone(){},honninSendFail(){},addEvent:async v=>writes.push(v)};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('let pendingPersonAction=null;'),html.indexOf('/* ちょっとお願い */')),c);
 vm.runInContext(html.slice(html.indexOf('function sendOnegai(text, inputId,confirmed){'),html.indexOf('\n/*',html.indexOf('function sendOnegai(text, inputId,confirmed){'))),c);
 return {c,el,writes,switchUser:()=>{currentUid='two';},switchGroup:()=>{currentGid='other';}};
}
for(const invoke of [c=>c.sendAisatsu(),c=>c.sendKibun('元気',''),c=>c.sendKusuri('asa'),c=>c.sendOnegai('話したい')]){
 const e=fixture();invoke(e.c);assert.equal(e.writes.length,0);assert.equal(e.el('person-confirm-dialog').open,true);e.c.cancelPersonAction();assert.equal(e.writes.length,0);
 invoke(e.c);e.c.confirmPersonAction();e.c.confirmPersonAction();assert.equal(e.writes.length,1);await new Promise(r=>setImmediate(r));
}
for(const key of ['switchUser','switchGroup']){const e=fixture();e.c.sendKibun('元気','');e[key]();e.c.confirmPersonAction();assert.equal(e.writes.length,0);}
{
 const e=fixture();e.c.sendKibun('元気','');e.el('person-confirm-dialog').oncancel();e.c.confirmPersonAction();assert.equal(e.writes.length,0);
}
console.log('person confirmation: cancel, double tap, four entry points and context isolation passed');
