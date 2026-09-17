import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {classify}=require('../family-connection.js');
const unknown={status:'unknown',others:null,familyOthers:null,personOthers:null};
const member=(id,role='kazoku',status='approved')=>({id,data:()=>({role,status})});
const memberWithMode=(id,role,mode,status='approved')=>({id,data:()=>({role,mode,status})});
const snapshot=(docs,metadata={fromCache:false,hasPendingWrites:false})=>({metadata,forEach:fn=>docs.forEach(fn)});
const legacy=(id,role)=>({id,data:()=>({role})});

test('Server-authorized legacy members without status remain recipients in both directions',()=>{
  const docs=[legacy('family','kazoku'),legacy('person','honnin')];
  assert.deepEqual(classify(snapshot(docs),'family'),{status:'shared',others:1,familyOthers:0,personOthers:1});
  assert.deepEqual(classify(snapshot(docs),'person'),{status:'shared',others:1,familyOthers:1,personOthers:0});
  assert.deepEqual(classify(snapshot([member('family'),legacy('person','honnin')]),'family'),{status:'shared',others:1,familyOthers:0,personOthers:1});
  assert.deepEqual(classify(snapshot([legacy('family','kazoku'),member('person','honnin')]),'family'),{status:'shared',others:1,familyOthers:0,personOthers:1});
});
test('Only absent status is legacy approval; explicit invalid values never authorize',()=>{
  for(const status of [null,undefined,'','pending','rejected',false,0,{},[]]){
    const invalid={id:'person',data:()=>({role:'honnin',status})};
    assert.deepEqual(classify(snapshot([legacy('family','kazoku'),invalid]),'family'),{status:'solo',others:0,familyOthers:0,personOthers:0});
    assert.deepEqual(classify(snapshot([legacy('family','kazoku'),invalid]),'person'),unknown);
  }
});
test('Legacy approval never bypasses verified identity, cache or mode checks',()=>{
  const docs=[legacy('family','kazoku'),legacy('person','honnin')];
  assert.deepEqual(classify(snapshot(docs,{fromCache:true}),'family'),unknown);
  assert.deepEqual(classify(snapshot(docs,{fromCache:false,hasPendingWrites:true}),'family'),unknown);
  assert.deepEqual(classify(snapshot(docs),'absent'),unknown);
  assert.deepEqual(classify(snapshot([legacy('family','kazoku')]),'family'),{status:'solo',others:0,familyOthers:0,personOthers:0});
  for(const mode of ['konly',null]){
    const switched={id:'person',data:()=>({role:'honnin',mode})};
    assert.equal(classify(snapshot([legacy('family','kazoku'),switched]),'family').personOthers,0);
  }
});

test('Only a verified approved self with no other approved member is solo',()=>{
  assert.deepEqual(classify(snapshot([member('me')]),'me'),{status:'solo',others:0,familyOthers:0,personOthers:0});
  assert.deepEqual(classify(snapshot([member('me'),member('waiting','kazoku','pending')]),'me'),{status:'solo',others:0,familyOthers:0,personOthers:0});
});
test('Count distinct approved identities and distinguish family from person',()=>{
  const docs=[member('me','honnin'),member('family'),member('person','honnin'),member('waiting','kazoku','pending')];
  assert.deepEqual(classify(snapshot(docs),'me'),{status:'shared',others:2,familyOthers:1,personOthers:1});
  assert.deepEqual(classify(snapshot([...docs,member('family')]),'me'),{status:'shared',others:2,familyOthers:1,personOthers:1});
});
test('Unknown or legacy roles are connections but not confirmed family recipients',()=>{
  assert.deepEqual(classify(snapshot([member('me'),member('legacy',null)]),'me'),{status:'shared',others:1,familyOthers:0,personOthers:0});
});
test('Changing the selected screen changes its audience without changing the registration role',()=>{
  for(const originalRole of ['honnin','kazoku']){
    for(const [mode,familyOthers,personOthers] of [['honnin',0,1],['kazoku',1,0],['konly',1,0]]){
      assert.deepEqual(classify(snapshot([member('me'),memberWithMode('other',originalRole,mode)]),'me'),
        {status:'shared',others:1,familyOthers,personOthers});
    }
  }
});
test('A valid selected screen supplies the audience even when the old role is unknown',()=>{
  assert.deepEqual(classify(snapshot([member('me'),memberWithMode('person',null,'honnin'),memberWithMode('family',null,'konly')]),'me'),
    {status:'shared',others:2,familyOthers:1,personOthers:1});
});
test('Only absent mode falls back to role; an explicitly invalid mode cannot enable either recipient',()=>{
  assert.deepEqual(classify(snapshot([member('me'),member('family','kazoku'),member('person','honnin')]),'me'),
    {status:'shared',others:2,familyOthers:1,personOthers:1});
  for(const role of ['honnin','kazoku']){
    for(const mode of [null,undefined,'','unknown',0,{},[]]){
      assert.deepEqual(classify(snapshot([member('me'),memberWithMode('other',role,mode)]),'me'),
        {status:'shared',others:1,familyOthers:0,personOthers:0});
    }
  }
});
test('Selected screens never turn pending members or the current account into recipients',()=>{
  assert.deepEqual(classify(snapshot([memberWithMode('me','kazoku','honnin'),memberWithMode('waiting','kazoku','honnin','pending')]),'me'),
    {status:'solo',others:0,familyOthers:0,personOthers:0});
});
test('Cached empty and cached populated lists never assert zero or a known audience',()=>{
  for(const docs of [[],[member('me')],[member('me'),member('family')]]){
    assert.deepEqual(classify(snapshot(docs,{fromCache:true}),'me'),unknown);
  }
});
test('Missing, unapproved, or mismatched current identity stays unknown',()=>{
  for(const docs of [[],[member('other')],[member('me','honnin','pending')]]){
    assert.deepEqual(classify(snapshot(docs),'me'),unknown);
  }
  for(const uid of [null,undefined,'',' ',42])assert.deepEqual(classify(snapshot([member('me')]),uid),unknown);
});
test('Unconfirmed local writes cannot declare a new sharing arrangement',()=>{
  assert.deepEqual(classify(snapshot([member('me')],{fromCache:false,hasPendingWrites:true}),'me'),unknown);
  assert.deepEqual(classify(snapshot([{...member('me'),metadata:{hasPendingWrites:true}}]),'me'),unknown);
  const changedScreen=memberWithMode('other','kazoku','honnin');
  assert.deepEqual(classify(snapshot([member('me'),changedScreen],{fromCache:true}),'me'),unknown);
  assert.deepEqual(classify(snapshot([member('me'),{...changedScreen,metadata:{hasPendingWrites:true}}]),'me'),unknown);
});
test('Absent metadata, malformed documents, and failed snapshot access stay unknown',()=>{
  for(const source of [null,{},snapshot([member('me')],{}),snapshot([member('me')],null),snapshot([member('me'),{}]),snapshot([member('me'),{id:'x',data:()=>null}]),{metadata:{fromCache:false},forEach:()=>{throw Error('unavailable');}}]){
    assert.deepEqual(classify(source,'me'),unknown);
  }
});
