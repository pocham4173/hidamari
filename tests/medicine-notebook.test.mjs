import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {indexedDB}=require('fake-indexeddb');
const {createStore,validateFile,FILE_MAX,TOTAL_MAX}=require('../medicine-notebook.js');
const jpeg=()=>new Blob([new Uint8Array([255,216,255,224,0,1])],{type:'image/jpeg'});
const sample=(extra={})=>({uid:'u1',groupId:'g1',title:'ダミー資料',recordDate:'2026-09-15',consent:true,blob:jpeg(),...extra});
const store=()=>createStore({indexedDB,dbName:'test-'+crypto.randomUUID()});
test('Magic bytes: valid JPEG/PDF; reject disguised HTML and mismatched MIME',async()=>{
 assert.equal(await validateFile(jpeg()),'image/jpeg');
 assert.equal(await validateFile(new Blob(['%PDF-1.7\nfixture'],{type:'application/pdf'})),'application/pdf');
 await assert.rejects(validateFile(new Blob(['<html>x</html>'],{type:'image/jpeg'})));
 await assert.rejects(validateFile(new Blob(['%PDF-1.7'],{type:'image/png'})));
 await assert.rejects(validateFile(new Blob([])));
 await assert.rejects(validateFile(new Blob([new Uint8Array(FILE_MAX+1)])));
});
test('Persist original bytes and segregate same user across families and other users',async()=>{
 const s=store();await s.save(sample());await s.save(sample({groupId:'g2'}));await s.save(sample({uid:'u2'}));
 const rows=await s.list('u1','g1');assert.equal(rows.length,1);assert.deepEqual(await rows[0].blob.arrayBuffer(),await jpeg().arrayBuffer());
 assert.equal((await s.list('u2','g1')).length,1);assert.equal((await s.list('u1','g2')).length,1);
});
test('Invalid date, no consent, and context change must not persist',async()=>{
 const s=store();await assert.rejects(s.save(sample({recordDate:'2026-02-30'})));await assert.rejects(s.save(sample({consent:false})));
 await assert.rejects(s.save(sample(),()=>false));let calls=0;await assert.rejects(s.save(sample(),()=>++calls===1));
 assert.equal((await s.list('u1','g1')).length,0);
});
test('Wrong-scope removal cannot remove another family original',async()=>{
 const s=store(),r=await s.save(sample());assert.equal(await s.remove('u2','g1',r.id),0);assert.equal(await s.remove('u1','g2',r.id),0);
 assert.equal((await s.list('u1','g1')).length,1);assert.equal(await s.remove('u1','g1',r.id),1);
});
test('Scope and UID cleanup preserve unrelated copies, clearAll deletes remainder',async()=>{
 const s=store();await s.save(sample());await s.save(sample({groupId:'g2'}));await s.save(sample({uid:'u2'}));
 assert.equal(await s.clearScope('u1','g1'),1);assert.equal((await s.list('u1','g2')).length,1);
 assert.equal(await s.clearUid('u1'),1);assert.equal((await s.list('u2','g1')).length,1);
 assert.equal(await s.clearAll(),1);assert.equal((await s.list('u2','g1')).length,0);
});
test('50MB total quota is atomic across concurrent uploads and families',async()=>{
 const s=store(),big=new Blob([new Uint8Array([255,216,255]),new Uint8Array(FILE_MAX-3)],{type:'image/jpeg'});
 const results=await Promise.allSettled(Array.from({length:6},(_,i)=>s.save(sample({groupId:'g'+i,blob:big}))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,TOTAL_MAX/FILE_MAX);assert.equal(results.filter(r=>r.status==='rejected').length,1);
});
test('Missing storage is a visible failure, never an empty successful list',async()=>{
 const s=createStore({indexedDB:null});await assert.rejects(s.list('u1','g1'),/端末保存/);
});
test('Old versions retain their label and record-date order',async()=>{
 const s=store();await s.save(sample({old:true,recordDate:'2025-01-01'}));await s.save(sample());
 const rows=await s.list('u1','g1');assert.equal(rows[0].recordDate,'2026-09-15');assert.equal(rows[1].old,true);
});
test('Edition update is guarded and cannot cross household/user boundaries',async()=>{
 const s=store(),r=await s.save(sample());
 await assert.rejects(s.setOld('u2','g1',r.id,true));await assert.rejects(s.setOld('u1','g2',r.id,true));
 await assert.rejects(s.setOld('u1','g1',r.id,true,()=>false));assert.equal((await s.list('u1','g1'))[0].old,false);
 await s.setOld('u1','g1',r.id,true);assert.equal((await s.list('u1','g1'))[0].old,true);
 await s.setOld('u1','g1',r.id,false);assert.equal((await s.list('u1','g1'))[0].old,false);
});
test('Concurrent removal and edition update never resurrect a deleted copy',async()=>{
 const s=store(),r=await s.save(sample());
 const results=await Promise.allSettled([s.remove('u1','g1',r.id),s.setOld('u1','g1',r.id,true)]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal((await s.list('u1','g1')).length,0);
});
