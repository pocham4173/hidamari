/* LINEでログインの交換を、Firestoreエミュレーターの本物のREST API(トランザクション・rollback)で確かめる。
   firebase emulators:exec --only firestore の中で実行する。 */
import { runScenarios } from './helpers/line-login-firestore-scenarios.mjs';
await runScenarios({ mode: 'emulator', host: '127.0.0.1:8080', projectId: 'demo-mainico-line' });
console.log('LINEでログイン(エミュレーターのREST): 正常・解除/終了手続き/取り消しとの競合・確定失敗時のrollback passed');
