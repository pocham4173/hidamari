import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createRequire} from 'node:module';
const api=createRequire(import.meta.url)('../medicine-notebook.js');
const pdf=(size=20)=>new Blob(['%PDF-',new Uint8Array(size-5)],{type:'application/pdf'});
const input=(extra={})=>({uid:'u1',groupId:'g1',title:'控え',recordDate:'2026-09-27',consent:true,blob:pdf(),...extra});
const store=()=>api.createStore({indexedDB,dbName:crypto.randomUUID()});
test('保存した原本を復元し、利用者・家庭ごとに隔離する',async()=>{
 const s=store(),r=await s.save(input());
 assert.equal((await s.list('u1','g1'))[0].blob.size,r.size);
 assert.equal((await s.list('u2','g1')).length,0);assert.equal((await s.list('u1','g2')).length,0);
 await assert.rejects(s.setOld('u2','g1',r.id,true));
 assert.equal(await s.remove('u2','g1',r.id),0);
 await s.setOld('u1','g1',r.id,true);assert.equal((await s.list('u1','g1'))[0].old,true);
});
test('偽形式・不正日付・同意なし・接続変更時は保存しない',async()=>{
 const s=store();
 for(const change of [{blob:new Blob(['not pdf'],{type:'application/pdf'})},{recordDate:'2026-02-30'},{consent:false}])await assert.rejects(s.save(input(change)));
 await assert.rejects(s.save(input(),()=>false));assert.equal((await s.list('u1','g1')).length,0);
});
test('1件10MBと端末全体50MBの容量制限を守る',async()=>{
 const s=store();await assert.rejects(s.save(input({blob:pdf(api.FILE_MAX+1)})));
 for(let i=0;i<5;i++)await s.save(input({groupId:'g'+i,blob:pdf(api.FILE_MAX)}));
 await assert.rejects(s.save(input()));assert.equal((await s.list('u1','g0')).length,1);
});
test('削除範囲は家庭・利用者・端末全体を区別する',async()=>{
 const s=store();await s.save(input());await s.save(input({groupId:'g2'}));await s.save(input({uid:'u2'}));
 assert.equal(await s.clearScope('u1','g1'),1);assert.equal((await s.list('u1','g2')).length,1);
 assert.equal(await s.clearUid('u1'),1);assert.equal((await s.list('u2','g1')).length,1);
 assert.equal(await s.clearAll(),1);
});
