/* 実SDKで同意の境界、撤回と同時書込、QR発行・停止を検証。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {consentFixture} from './helpers/consent-fixture.mjs';
const Consent=createRequire(import.meta.url)('../consent.js');
const env=await initializeTestEnvironment({projectId:'demo-mainico-consent',firestore:{rules:fs.readFileSync('firestore.rules','utf8'),host:'127.0.0.1',port:8080}});
const db=env.authenticatedContext('owner').firestore(),other=env.authenticatedContext('other').firestore(),finder=env.authenticatedContext('finder').firestore();
const stamp=()=>firebase.firestore.FieldValue.serverTimestamp();
const auth={currentUser:{uid:'owner'}},service=Consent.create({db,auth,serverTimestamp:stamp});
const checks={privacy:true,sensitive:true,sharing:true,subject:true,disclaimer:true};
const consent=db.doc('consents/owner'),record=db.doc('groups/home/events/new'),tag='C'.repeat(32);
async function seed(data){await env.withSecurityRulesDisabled(async ctx=>{for(const [path,value]of Object.entries(data))await ctx.firestore().doc(path).set(value);});}
try{
 await env.clearFirestore();
 await seed({'groups/home':{createdBy:'owner'},'groups/home/members/owner':{status:'approved',role:'kazoku'},'groups/home/events/old':{uid:'owner',text:'test'}});
 assert.equal((await service.read('kazoku')).valid,false);
 await assertFails(record.set({uid:'owner',text:'without consent'}));
 await assertFails(db.doc('groups/home/events/old').get({source:'server'}));
 await assertFails(consent.set({...consentFixture(stamp()),sensitiveAccepted:false}));
 await assertFails(consent.set({...consentFixture(stamp()),version:'2026-09-18.1'}));
 await assertFails(consent.set({...consentFixture(stamp()),subjectBasis:'self'}));
 await assertFails(consent.set({...consentFixture(stamp()),acceptedAt:firebase.firestore.Timestamp.now()}));
 await assertFails(consent.set({...consentFixture(stamp()),name:'personal information'}));
 await assertFails(other.doc('consents/owner').set(consentFixture(stamp())));
 await assertFails(env.unauthenticatedContext().firestore().doc('consents/owner').get());
 await assert.rejects(service.accept('kazoku',{...checks,subject:false}),/incomplete/);
 assert.equal((await consent.get()).exists,false);
 assert.equal((await service.accept('kazoku',checks)).valid,true);
 await assertSucceeds(record.set({uid:'owner',text:'consented'}));
 await assertSucceeds(db.collection('groups/home/events').get());
 await assertFails(other.doc('consents/owner').get());
 await assertFails(db.collection('consents').get());
 await assertFails(other.doc('groups/home/events/old').get());
 console.log('OK 実SDK同意: 未同意・不完全・旧版・他UIDを拒否、transactionの同意後のみ記録利用');

 const tagData={groupId:'home',active:true,createdBy:'owner',createdAt:stamp()};
 await assertFails(db.doc('watchTags/'+tag).set(tagData));
 const issue=db.batch();
 issue.set(db.doc('watchTags/'+tag),{...tagData,consentVersion:Consent.VERSION,consentedAt:stamp()});
 issue.set(db.doc('groups/home/settings/watchTag'),{watchTagId:tag,watchTagActive:true,watchTagUpdatedAt:stamp()});
 await assertSucceeds(issue.commit());
 await assertFails(finder.doc('watchTags/'+tag).get());
 const alert={type:'found',situation:'safe',count:1,senderUid:'finder',createdAt:stamp()};
 await assertFails(finder.doc('watchTags/'+tag+'/alerts/finder').set({...alert,phone:'private'}));
 await assertSucceeds(finder.doc('watchTags/'+tag+'/alerts/finder').set(alert));
 await assertSucceeds(db.collection('watchTags/'+tag+'/alerts').get());
 console.log('OK QR: 発行時の個別同意、発見者には個人情報の読取権限なし、通知項目限定');

 const revokeAndWrite=db.batch();revokeAndWrite.delete(consent);revokeAndWrite.set(db.doc('groups/home/events/revoke-bypass'),{uid:'owner',text:'bypass'});
 await assertFails(revokeAndWrite.commit());
 assert.equal((await service.read('kazoku')).valid,true,'失敗batchでは撤回自体も確定しない');
 await service.revoke();assert.equal((await service.read('kazoku')).valid,false);
 await assertFails(record.set({uid:'owner',text:'after revoke'}));
 await assertFails(db.collection('groups/home/events').get());
 await assertFails(db.collection('watchTags/'+tag+'/alerts').get());
 await assertSucceeds(db.doc('watchTags/'+tag).update({active:false,stoppedAt:stamp()}));
 await assertFails(env.authenticatedContext('finder2').firestore().doc('watchTags/'+tag+'/alerts/finder2').set({...alert,senderUid:'finder2'}));
 await assertSucceeds(db.doc('groups/home').update({deletionState:'deleting',deletionStartedAt:stamp()}));
 await assertSucceeds(db.collection('groups/home/events').get());
 await assertSucceeds(record.delete());
 console.log('OK 撤回: 同時書込も拒否、取得停止、タグ停止と本人の削除処理は継続可能');

 await db.disableNetwork();
 await assert.rejects(service.accept('kazoku',checks),/offline|unavailable|transaction/i);
 await db.enableNetwork();
 assert.equal((await service.read('kazoku')).valid,false,'オフラインで同意の保留書込を残さない');
 console.log('OK 通信切断: オフライン同意を保存せず、再接続しても勝手に同意しない');
}finally{await env.cleanup();}
