import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
const Closure=createRequire(import.meta.url)('../account-deletion.js');
const env=await initializeTestEnvironment({projectId:'demo-mainico-closure',firestore:{rules:fs.readFileSync('firestore.rules','utf8'),host:'127.0.0.1',port:8080}});
const stamp=()=>firebase.firestore.FieldValue.serverTimestamp();
const db=env.authenticatedContext('self').firestore();
const other=env.authenticatedContext('other').firestore();
const tag='A'.repeat(32);
async function seed(data){await env.withSecurityRulesDisabled(async ctx=>{for(const [path,value]of Object.entries(data))await ctx.firestore().doc(path).set(value);});}
function createHome(id){const batch=db.batch();batch.set(db.doc(`groups/${id}`),{createdBy:'self',createdAt:stamp()});batch.set(db.doc(`groups/${id}/members/self`),{name:'試験',role:'kazoku',mode:'konly',status:'approved',joinedAt:stamp()});batch.set(db.doc('accounts/self'),{groupId:id,updatedAt:stamp()});return batch;}
try{
 await env.clearFirestore();
 await seed({'groups/other-home':{createdBy:'other'},'groups/other-home/members/self':{status:'approved'},[`watchTags/${tag}`]:{groupId:'other-home',active:true}});
 await assertFails(db.collection('groups').get());
 await assertFails(db.collection('groups').where('createdBy','==','other').get());
 await assertSucceeds(db.collection('groups').where('createdBy','==','self').limit(1).get());
 await assertFails(db.doc('accountClosures/other').set({requestedAt:stamp()}));
 let deleted=false;
 const auth={currentUser:{uid:'self',isAnonymous:true,delete:async()=>{deleted=true;}}};
 const service=Closure.create({db,auth,serverTimestamp:stamp});
 await service.prepare('');
 await assertFails(db.doc('accountClosures/self').delete());
 await assertFails(db.doc('accountClosures/self').update({requestedAt:stamp()}));
 await assertFails(other.doc('accountClosures/self').get());
 await assertFails(createHome('after-close').commit());
 await assertFails(db.doc('groups/other-home/events/new').set({uid:'self'}));
 await assertFails(db.doc('accounts/self').set({groupId:'other-home',updatedAt:stamp()}));
 await assertFails(db.doc(`watchTags/${tag}/alerts/self`).set({type:'found',situation:'safe',count:1,senderUid:'self',createdAt:stamp()}));
 await assertSucceeds(db.doc('groups/other-home/members/self').delete());
 await service.finish(Closure.CONFIRMATION);assert.equal(deleted,true);
 console.log('OK 実SDK自己削除: owner限定検索、閉鎖ロック、旧tokenの新世帯/記録/復旧先/外部通知を拒否、退会は可能');
 await env.clearFirestore();
 const batch=createHome('race');batch.set(db.doc('accountClosures/self'),{requestedAt:stamp()});await assertFails(batch.commit());
 console.log('OK 同一batchの閉鎖開始+新世帯作成はgetAfterで拒否');
 await seed({'groups/legacy-owned':{createdBy:'self'}});
 const second=Closure.create({db,auth,serverTimestamp:stamp});
 await assert.rejects(second.prepare(''),{code:'closure/owned-household'});
 await seed({'accountClosures/self':{requestedAt:firebase.firestore.Timestamp.now()}});
 await assertSucceeds(db.doc('groups/legacy-owned').update({deletionState:'deleting',deletionStartedAt:stamp()}));
 await assertSucceeds(db.doc('groups/legacy-owned').delete());
 console.log('OK 復旧先のない旧管理世帯もAuth削除前に発見し、閉鎖中でも整理可能');
}finally{await env.cleanup();}
