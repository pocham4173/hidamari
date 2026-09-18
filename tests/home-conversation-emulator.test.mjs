import {consentFixture} from './helpers/consent-fixture.mjs';
/* Complete HTML + production subscription/render/send functions + actual Firestore
   compat SDK/rules. Two independent authenticated identities; no live user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {homeFixture} from './helpers/home-conversation-fixture.mjs';
const env=await initializeTestEnvironment({projectId:'demo-mainico-home-conversation',
  firestore:{rules:fs.readFileSync('firestore.rules','utf8'),host:'127.0.0.1',port:8080}});
const fixtures=[];
async function until(name,check){
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,25));}
  assert.ok(check(),name);
}
function connect(screen,uid){
  const f=homeFixture(screen,uid),db=env.authenticatedContext(uid).firestore();fixtures.push(f);
  f.c.col=name=>db.collection('groups').doc('home').collection(name);
  f.c.addEvent=data=>f.c.col('events').add({...data,uid,date:f.c.todayStr(),at:firebase.firestore.FieldValue.serverTimestamp()});
  f.c.startFamilyConnection();
  if(screen==='honnin')f.c.subscribePersonConversation();else f.c.subscribeFamilyConversation();
  return {f,db};
}
const first=f=>f.document.querySelector('#ev-list > .ev');
const quick=f=>first(f)?.querySelector('[onclick^="replyToPersonEvent"]');
try{
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx=>{
    for(const id of ['family','person'])await ctx.firestore().doc('consents/'+id).set(consentFixture(firebase.firestore.Timestamp.now()));
    const home=ctx.firestore().collection('groups').doc('home');
    await home.set({createdBy:'family'});
    await home.collection('members').doc('family').set({name:'家族',role:'kazoku',mode:'kazoku',status:'approved'});
    await home.collection('members').doc('person').set({name:'本人',role:'honnin'}); // old registration
    await home.collection('members').doc('waiting').set({name:'承認待ち',role:'honnin',status:'pending'});
    await home.collection('events').doc('yesterday').set({type:'aisatsu',text:'おはよう',slot:'asa',uid:'person',
      date:'2026-09-16',at:firebase.firestore.Timestamp.fromMillis(Date.now()-86400000)});
  });
  const {f:family,db:familyDb}=connect('kazoku','family');
  const {f:person}=connect('honnin','person');
  await until('previous-day greeting appears on family home with an enabled reply',()=>quick(family)&&!quick(family).disabled);
  assert.ok(family.visible(first(family)));assert.match(first(family).textContent,/おはよう/);
  await family.click(quick(family));
  await until('family reply arrives on person home',()=>person.c.currentFamilyMessageId&&person.visible(person.document.querySelector('#h-message-reply button'))&&!person.document.querySelector('#h-message-reply button').disabled);
  assert.match(person.document.getElementById('h-incoming-message').textContent,/おはよう/);
  const replyId=person.c.currentFamilyMessageId;
  const thanks=[...person.document.querySelectorAll('#h-message-reply button')].find(b=>b.textContent==='ありがとう');
  await person.click(thanks);
  await until('person thanks is first on family home and can be answered',()=>first(family)?.textContent.includes('ご本人からの返事：「ありがとう」')&&quick(family)&&!quick(family).disabled);
  assert.ok(family.visible(first(family)));await family.click(quick(family));
  await until('continued reply returns to person home',()=>person.c.currentFamilyMessageId!==replyId&&person.document.getElementById('h-incoming-message').textContent.includes('ありがとう'));
  console.log('PASS actual two-identity home roundtrip: yesterday greeting → family reply → person thanks → continued reply');

  family.document.getElementById('in-family-message').value='入力は残す';
  await familyDb.disableNetwork();
  await until('offline reply buttons are disabled',()=>[...family.document.querySelectorAll('#ev-list [data-send-audience]')].every(b=>b.disabled)&&family.visible(family.document.getElementById('family-conversation-retry')));
  assert.ok(family.visible(first(family)),'offline must not erase readable conversation');
  await family.click(family.document.getElementById('family-conversation-retry'));
  assert.equal(family.document.getElementById('in-family-message').value,'入力は残す');
  await familyDb.enableNetwork();
  await until('retry recovers the conversation subscription',()=>!family.document.querySelector('#ev-list [data-reply-again="true"]').disabled);
  console.log('PASS real offline/cache/retry retains visible content and typed draft');

  const {f:waiting}=connect('kazoku','waiting');
  await until('pending participant receives a connection error',()=>waiting.visible(waiting.document.getElementById('family-conversation-retry')));
  const read=await env.authenticatedContext('waiting').firestore().collection('groups').doc('home').collection('events').get().then(()=>true,()=>false);
  assert.equal(read,false);assert.doesNotMatch(waiting.document.getElementById('ev-list').textContent,/おはよう|ありがとう/);
  assert.ok([...waiting.document.querySelectorAll('[data-send-audience]')].every(b=>b.disabled));
  console.log('PASS pending participant cannot read conversations or send replies');
}finally{
  fixtures.forEach(f=>f.close());await env.cleanup();
}
