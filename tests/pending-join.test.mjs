import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('let pendingUnsub=null;');
const end=html.indexOf('function startMode(){',start);
assert.ok(start>=0&&end>start);
const source=html.slice(start,end);
const snap=(status='pending',cached=false,local=false)=>({exists:status!==null,data:()=>({status}),metadata:{fromCache:cached,hasPendingWrites:local}});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
  const data=new Map(Object.entries({mainicoGid:'home',mainicoMode:'kazoku',mainicoPendingMode:'kazoku',mainico_join_pending_v1:JSON.stringify({uid:'me',groupId:'home',code:'ABCDEFGH'}),notebook:'keep'}));
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,style:{}});return elements.get(id);};
  const state={uid:'me',doc:snap(),group:snap('active'),listeners:[],stops:0,pages:[],finished:0,reloads:0,confirms:0,transactions:0,deleted:[],reads:[],hooks:{}};
  const ref=path=>({path,collection:name=>collection(path+'/'+name),get:async options=>{
    assert.equal(options.source,'server');await state.hooks.beforeGroupGet?.();return state.group;
  },onSnapshot:(options,ok,error)=>{
    assert.equal(options.includeMetadataChanges,true,'cacheからserver確認だけの変化も受け取る');
    state.listeners.push({path,ok,error});return ()=>state.stops++;
  }});
  const collection=path=>({doc:id=>ref(path+'/'+id)});
  const ctx={
    document:{getElementById:el},uid:()=>state.uid,gid:()=>data.get('mainicoGid')||'',householdBootGeneration:1,
    showPage:page=>state.pages.push(page),finishSetup:async()=>state.finished++,
    location:{reload:()=>state.reloads++},confirm:()=>{state.confirms++;return true;},
    previewStorage:{getItem:key=>data.get(key)||null,removeItem:key=>{state.hooks.remove?.(key);data.delete(key);}},
    db:{collection,runTransaction:async work=>{
      state.transactions++;
      if(state.hooks.failTransaction)throw Error('unavailable');
      let writes=[];
      const transaction={get:async target=>{state.reads.push(target.path);await state.hooks.beforeGet?.();return state.doc;},delete:target=>writes.push(target.path)};
      let result=await work(transaction);
      if(state.hooks.approveOnConflict&&writes.length){
        // A real transaction retries if the administrator approves after its first read.
        state.doc=snap('approved');writes=[];result=await work(transaction);
      }
      state.deleted.push(...writes);
      if(writes.length)state.doc=snap(null);
      return result;
    }}
  };
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const deliver=(value=state.doc)=>state.listeners.at(-1).ok(value);
  return {ctx,state,data,el,deliver};
}

{
  const f=fixture();f.ctx.showPending();
  assert.equal(f.el('pending-cancel').disabled,true);
  f.deliver(snap('approved',true));assert.equal(f.state.finished,0);
  f.deliver(snap('approved',false,true));assert.equal(f.state.finished,0);
  f.deliver(snap('approved'));assert.equal(f.state.finished,1);
  assert.equal(f.el('pending-cancel').disabled,true);assert.equal(f.state.stops,1);
  assert.equal(f.data.get('mainicoGid'),'home');
}
console.log('OK 承認のキャッシュ・未確定書込では開始せずサーバー確認後に開始');
{
  const f=fixture();f.ctx.showPending();f.deliver();
  assert.match(f.el('pending-state').textContent,/受け付けました/);
  assert.equal(f.el('pending-cancel').disabled,false);
  const before=[...f.data];
  f.state.listeners.at(-1).error(Error('permission-denied'));
  assert.match(f.el('pending-err').textContent,/取り下げたり.*必要はありません/);
  assert.equal(f.el('pending-cancel').disabled,true);
  await f.ctx.cancelJoinRequest();
  assert.equal(f.state.transactions,0);assert.deepEqual([...f.data],before);
  f.ctx.retryPendingStatus();assert.equal(f.state.listeners.length,2);
  f.deliver();assert.equal(f.el('pending-cancel').disabled,false);
}
console.log('OK 通信・権限エラーでは申請を保持し再確認で待機を再開');
{
  const f=fixture();f.ctx.showPending();const before=[...f.data];
  f.deliver(snap(null,true));assert.equal(f.state.reloads,0);
  f.deliver(snap(null));assert.match(f.el('pending-state').textContent,/申請は終了/);
  assert.doesNotMatch(f.el('pending-state').textContent,/認められません|拒否/);
  assert.equal(f.el('pending-cancel').textContent,'入口に戻る');
  assert.deepEqual([...f.data],before);assert.equal(f.state.reloads,0);
  f.state.doc=snap(null);await f.ctx.cancelJoinRequest();
  assert.equal(f.state.deleted.length,0);assert.equal(f.state.reloads,1);
  assert.equal(f.data.has('mainicoGid'),false);assert.equal(f.data.has('mainico_join_pending_v1'),false);
  assert.equal(f.data.get('notebook'),'keep');
}
console.log('OK サーバーの申請不存在は拒否と断定せず明示操作まで接続情報を保持');
{
  for(const change of [f=>{f.state.uid='different';},f=>f.data.set('mainicoGid','other-home'),f=>{f.ctx.householdBootGeneration++;},f=>f.ctx.retryPendingStatus()]){
    const f=fixture();f.ctx.showPending();const listener=f.state.listeners[0];
    change(f);f.el('pending-state').textContent='現在の画面';const before=[...f.data];
    listener.ok(snap('approved'));listener.ok(snap(null));listener.error(Error('old'));
    assert.equal(f.el('pending-state').textContent,'現在の画面');
    assert.equal(f.state.finished,0);assert.equal(f.state.reloads,0);assert.deepEqual([...f.data],before);
  }
}
console.log('OK 旧UID・家庭・起動世代・再確認前の応答は現在の画面を変更しない');
{
  const f=fixture(),gate=deferred();f.ctx.showPending();f.deliver();
  f.state.hooks.beforeGet=()=>gate.promise;
  const first=f.ctx.cancelJoinRequest();await f.ctx.cancelJoinRequest();f.ctx.retryPendingStatus();
  assert.equal(f.state.confirms,1);assert.equal(f.state.transactions,1);
  assert.equal(f.el('pending-cancel').disabled,true);assert.equal(f.el('pending-retry').disabled,true);
  gate.resolve();await first;
  assert.deepEqual(f.state.deleted,['groups/home/members/me']);assert.equal(f.state.reloads,1);
  assert.equal(f.data.get('notebook'),'keep');
}
console.log('OK 取消しの連打を抑えtransaction内でpendingを確認した1件だけ削除');
{
  for(const concurrent of [false,true]){
    const f=fixture();f.ctx.showPending();f.deliver();
    if(concurrent)f.state.hooks.approveOnConflict=true;else f.state.doc=snap('approved');
    await f.ctx.cancelJoinRequest();
    assert.equal(f.state.deleted.length,0);assert.equal(f.state.finished,1);assert.equal(f.state.reloads,0);
    assert.equal(f.data.get('mainicoGid'),'home');assert.match(f.el('pending-state').textContent,/取り下げず/);
  }
}
console.log('OK 取消し直前・transaction再試行時に承認された参加を削除しない');
{
  const f=fixture();f.ctx.showPending();f.deliver(snap(null));f.state.doc=snap();
  await f.ctx.cancelJoinRequest();assert.equal(f.state.deleted.length,0);
  assert.equal(f.state.reloads,0);assert.equal(f.data.get('mainicoGid'),'home');
  assert.match(f.el('pending-state').textContent,/取り下げていません/);
}
console.log('OK 終了表示後に新しい申請が見つかった場合は削除せず保持');
{
  for(const failure of ['offline','cache','unknown']){
    const f=fixture();f.ctx.showPending();f.deliver();const before=[...f.data];
    if(failure==='offline')f.state.hooks.failTransaction=true;
    if(failure==='cache')f.state.doc=snap('pending',true);
    if(failure==='unknown')f.state.doc=snap('unexpected');
    await f.ctx.cancelJoinRequest();assert.equal(f.state.deleted.length,0);
    assert.equal(f.state.reloads,0);assert.deepEqual([...f.data],before);
    assert.match(f.el('pending-state').textContent,/完了を確認できません/);
  }
}
console.log('OK offline・未検証・不明状態では取消しや端末整理をしない');
{
  const f=fixture(),gate=deferred();f.ctx.showPending();f.deliver();
  f.state.hooks.beforeGet=()=>gate.promise;const work=f.ctx.cancelJoinRequest();
  f.state.uid='new';f.data.set('mainicoGid','new-home');f.ctx.showPending();
  f.el('pending-state').textContent='新しい申請';gate.resolve();await work;
  assert.equal(f.state.deleted.length,0);assert.equal(f.state.reloads,0);
  assert.equal(f.data.get('mainicoGid'),'new-home');assert.equal(f.el('pending-state').textContent,'新しい申請');
}
console.log('OK 取消し読込中の家庭切替では旧申請を削除せず新画面を保持');
{
  const f=fixture();f.ctx.showPending();f.deliver();
  const other=JSON.stringify({uid:'someone-else',groupId:'elsewhere',code:'OTHER123'});
  f.data.set('mainico_join_pending_v1',other);await f.ctx.cancelJoinRequest();
  assert.equal(f.data.get('mainico_join_pending_v1'),other);
  assert.equal(f.state.reloads,1);
}
console.log('OK 申請終了の整理で別アカウントの再開情報を消さない');
{
  const f=fixture();f.ctx.showPending();f.state.group=snap(null);
  await f.state.listeners.at(-1).error(Error('permission-denied'));
  assert.match(f.el('pending-state').textContent,/接続は終了/);
  assert.equal(f.data.get('mainicoGid'),'home');assert.equal(f.state.reloads,0);
  f.state.hooks.failTransaction=true;
  await f.ctx.cancelJoinRequest();
  assert.equal(f.state.deleted.length,0);assert.equal(f.state.reloads,1);
  assert.equal(f.data.has('mainicoGid'),false);assert.equal(f.data.get('notebook'),'keep');
}
console.log('OK 家庭全体の削除でmember読取不可でもサーバーの家庭不存在を確認して終了できる');
{
  for(const group of [snap(null,true),snap(null,false,true),snap('active')]){
    const f=fixture();f.ctx.showPending();f.state.group=group;
    await f.state.listeners.at(-1).error(Error('permission-denied'));
    assert.match(f.el('pending-state').textContent,/確認できません/);
    assert.equal(f.el('pending-cancel').disabled,true);assert.equal(f.data.get('mainicoGid'),'home');
  }
  const f=fixture(),gate=deferred();f.ctx.showPending();f.state.group=snap(null);f.state.hooks.beforeGroupGet=()=>gate.promise;
  const old=f.state.listeners.at(-1).error(Error('permission-denied'));
  f.data.set('mainicoGid','new-home');f.ctx.showPending();f.el('pending-state').textContent='新しい接続';gate.resolve();await old;
  assert.equal(f.el('pending-state').textContent,'新しい接続');assert.equal(f.data.get('mainicoGid'),'new-home');
}
console.log('OK 家庭終了もキャッシュ・ローカル書込・旧家庭応答では確定しない');
{
  const f=fixture();f.ctx.showPending();f.deliver();
  let fail=true;f.state.hooks.remove=key=>{if(fail&&key==='mainicoMode')throw Error('storage unavailable');};
  await f.ctx.cancelJoinRequest();
  assert.equal(f.state.deleted.length,1);assert.equal(f.state.reloads,0);
  assert.equal(f.data.get('mainicoGid'),'home');assert.match(f.el('pending-err').textContent,/整理を完了できません/);
  assert.equal(f.el('pending-cancel').textContent,'入口に戻る');
  fail=false;await f.ctx.cancelJoinRequest();
  assert.equal(f.state.deleted.length,1,'cleanup再試行で別の申請を取り下げない');assert.equal(f.state.reloads,1);
}
console.log('OK 取消し成功後の端末整理失敗は成功を取り消さず明示的に整理を再試行');
