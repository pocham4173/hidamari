import assert from 'node:assert/strict';
import {audit,applyManifest,manifestHash,PROJECT} from '../scripts/legacy-data-cleanup.mjs';

function fixture(initial = {}, users = []) {
  const docs = new Map(Object.entries(initial).map(([p,data]) => [p,{data,version:1}]));
  const state = {docs,deleted:[],beforeTransaction:null,failPath:null};
  const snap = path => ({ref:ref(path),exists:docs.has(path),data:()=>docs.get(path)?.data,updateTime:{seconds:docs.get(path)?.version || 0,nanoseconds:0}});
  const collections = path => [...new Set([...docs.keys()].filter(p => !path || p.startsWith(path+'/')).map(p => p.split('/').slice(0,path ? path.split('/').length+1 : 1).join('/')))];
  const col = path => ({path,id:path.split('/').at(-1),
    listDocuments:async()=>[...new Set([...docs.keys()].filter(p=>p.startsWith(path+'/')).map(p=>p.split('/').slice(0,path.split('/').length+1).join('/')))].map(ref),
    limit:()=>({query:path})});
  function ref(path) { return {path,id:path.split('/').at(-1),get:async()=>snap(path),listCollections:async()=>collections(path).filter(p=>p.split('/').length===path.split('/').length+1).map(col),collection:name=>col(path+'/'+name)}; }
  state.db = {doc:ref,listCollections:async()=>collections('').map(col),runTransaction:async action=>{
    if(state.beforeTransaction) {const fn=state.beforeTransaction;state.beforeTransaction=null;fn();}
    const pending=[];
    const result=await action({get:async target=>target.query?{empty:![...docs.keys()].some(p=>p.startsWith(target.query+'/'))}:snap(target.path),delete:(r,pre)=>{
      if(state.failPath===r.path) throw new Error('failure');
      assert.equal(pre.lastUpdateTime.seconds,docs.get(r.path).version);pending.push(r.path);
    }});
    for(const p of pending) {docs.delete(p);state.deleted.push(p);}return result;
  }};
  state.auth = {getUser:async uid=>{if(users.includes(uid))return {uid};throw Object.assign(new Error('not found'),{code:'auth/user-not-found'});}};
  return state;
}
async function apply(s,m,extra={}) {return applyManifest(s.db,s.auth,m,{project:PROJECT,confirmHash:manifestHash(m),groupIds:['gone'],closureUids:['closed'],now:300000000,...extra});}

{
  const s=fixture({'groups/live':{createdBy:'u'},'groups/live/events/e':{secret:'do not log'}});
  const m=await audit(s.db,s.auth);assert.equal(m.count,0);assert.equal((await apply(s,m)).complete,true);
  assert(!JSON.stringify(m).includes('secret'));
}
{
  const s=fixture({'groups/gone/events/e':{private:'hello'},'groups/gone/yotei/y':{},'groups/gone/members/m':{},'groups/gone/settings/watchTag':{},'watchTags/t':{groupId:'gone'},'watchTags/t/alerts/a':{groupId:'gone'},'invites/i':{groupId:'gone'},'accounts/a':{groupId:'gone'}});
  const m=await audit(s.db,s.auth);assert.equal(m.count,8);assert(m.complete);
  await assert.rejects(()=>apply(s,m,{groupIds:[]}),/confirmation/);
  await assert.rejects(()=>apply(s,m,{confirmHash:'wrong'}),/hash/);
  await assert.rejects(()=>apply(s,m,{project:'wrong'}),/project/);
  const r=await apply(s,m);assert(r.complete);assert.equal(s.docs.size,0);
  assert(s.deleted.indexOf('watchTags/t/alerts/a')<s.deleted.indexOf('watchTags/t'));
  assert(!JSON.stringify(m).includes('hello'));
}
{
  const s=fixture({'watchTags/missing/alerts/a':{groupId:'gone'}});
  const m=await audit(s.db,s.auth);assert.equal(m.count,1);assert((await apply(s,m)).complete);
}
{
  const s=fixture({'groups/gone/events/e':{}});const m=await audit(s.db,s.auth);
  s.beforeTransaction=()=>s.docs.set('groups/gone',{data:{createdBy:'owner'},version:1});
  const r=await apply(s,m);assert(!r.complete);assert.equal(r.results[0].status,'skipped-parent-restored');assert.equal(s.deleted.length,0);
}
{
  const s=fixture({'groups/gone/events/e':{}});const m=await audit(s.db,s.auth);
  s.beforeTransaction=()=>s.docs.get('groups/gone/events/e').version++;
  const r=await apply(s,m);assert(!r.complete);assert.equal(r.results[0].status,'skipped-updated');
}
{
  const s=fixture({'watchTags/t':{groupId:'gone'},'watchTags/t/alerts/a':{groupId:'gone'}});
  const m=await audit(s.db,s.auth);s.failPath='watchTags/t/alerts/a';
  const r=await apply(s,m);assert(!r.complete);assert.equal(s.deleted.length,0);assert.equal(r.results[1].status,'skipped-child-remains');
}
for(const path of ['unknown/x','groups/gone/private/x','groups/gone/events/e/extra/x','groups/gone/settings/unknown']) {
  const s=fixture({[path]:{}});const m=await audit(s.db,s.auth);assert(!m.complete);
  await assert.rejects(()=>apply(s,m),/unverified/);assert.equal(s.deleted.length,0);
}
{
  const s=fixture({'groups/gone/events/e':{}});const m=await audit(s.db,s.auth);
  s.docs.set('newSchema/x',{data:{},version:1});
  await assert.rejects(()=>apply(s,m),/schema/);assert.equal(s.deleted.length,0);
}
{
  const old={requestedAt:{toMillis:()=>1}};
  const s=fixture({'accountClosures/closed':old,'accountClosures/live':old},['live']);
  const m=await audit(s.db,s.auth,{now:200000000});assert.equal(m.count,1);
  const immediate=await apply(s,m,{now:200000001});assert(!immediate.complete);
  assert.equal(immediate.results[0].status,'skipped-auth-absence-wait');
  assert(s.docs.has('accountClosures/closed'));
  assert((await apply(s,m)).complete);assert(s.docs.has('accountClosures/live'));
}
{
  // A closure requested days earlier is NOT evidence that Auth was deleted then.
  const s=fixture({'accountClosures/closed':{requestedAt:{toMillis:()=>1}}});
  const m=await audit(s.db,s.auth,{now:200000000});
  assert.equal(m.entries[0].authAbsenceObservedAt,200000000);
  const waiting=await apply(s,m,{now:200000000+86400000-1});assert(!waiting.complete);assert.equal(s.deleted.length,0);
  assert((await apply(s,m,{now:200000000+86400000})).complete);
}
{
  const s=fixture({'accountClosures/closed':{requestedAt:{toMillis:()=>1}},'accounts/closed':{groupId:'live'},'groups/live':{}});
  const m=await audit(s.db,s.auth,{now:200000000});const r=await apply(s,m);
  assert(!r.complete);assert.equal(r.results[0].status,'skipped-account-pointer-remains');
}
{
  const s=fixture({'accountClosures/closed':{requestedAt:{toMillis:()=>1}}});
  const m=await audit(s.db,s.auth,{now:200000000});
  let calls=0;
  s.auth.getUser=async()=>{if(++calls===1)throw Object.assign(new Error(),{code:'auth/user-not-found'});return {uid:'closed'};};
  const r=await apply(s,m);assert(!r.complete);assert.equal(s.deleted.length,0);
}
{
  const s=fixture({'watchTags/t/alerts/a':{}});const m=await audit(s.db,s.auth);
  assert(!m.complete);assert.equal(m.count,0);assert.equal(m.issues[0].reason,'missing-or-invalid-group-id');
}
{
  const s=fixture({'invites/i':{groupId:'gone'},'accounts/a':{groupId:'gone'}});const m=await audit(s.db,s.auth);s.failPath='invites/i';
  const r=await apply(s,m);assert(!r.complete);assert.equal(s.deleted.length,1);
  s.failPath=null;const retry=await audit(s.db,s.auth);assert((await apply(s,retry)).complete);
  await assert.rejects(()=>audit(fixture({'groups/gone/events/a':{}}).db,s.auth,{maxDocuments:1}),/limit/);
}
console.log('legacy cleanup: missing ancestors, no-content report, explicit approval, safe order, races, partial retry, unknown schema and closure lock gates passed');
