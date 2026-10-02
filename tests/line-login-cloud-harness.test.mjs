/* クラウド用の結合確認スクリプト(tests/helpers/line-login-firestore-scenarios.mjs のクラウドモード)そのものの検査。
   クラウドには接続しない。元の fetch を記録用の偽物にして、次を確かめる:
   - Worker 自身の Google 認証(https://oauth2.googleapis.com/token)が元の fetch まで渡ること
   - 決めた通信以外は元の fetch へ渡さないこと
   - 片付けで削除に失敗した文書(403 など)を、もれなく報告すること
   - テストデータの作成が途中で失敗しても、作った分を片付けること
   - 本番プロジェクトでは動かないこと
   これはクラウドの Firestore での結合確認の代わりではありません。 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { runScenarios } from './helpers/line-login-firestore-scenarios.mjs';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = (project) => ({ project_id: project, client_email: 'itest@' + project + '.iam.gserviceaccount.com',
  private_key: key.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const payload = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
function recorder({ seedFailAt = 0, deleteStatus = () => 200 } = {}) {
  const rec = { calls: [], tokenScopes: [], seeded: [], deleted: [] };
  rec.fetch = async (url, opt = {}) => {
    url = String(url);
    rec.calls.push(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token') {
      rec.tokenScopes.push(payload(new URLSearchParams(opt.body).get('assertion')).scope);
      return json({ access_token: 'tok' + rec.tokenScopes.length, expires_in: 3600 });
    }
    if (url.startsWith('https://firestore.googleapis.com/v1/projects/itest-proj/databases/(default)/documents')) {
      const path = decodeURIComponent(new URL(url).pathname).split('/documents/')[1];
      const method = opt.method || 'GET';
      if (method === 'PATCH') {
        rec.seeded.push(path);
        if (seedFailAt && rec.seeded.length === seedFailAt) return json({ error: 'seed' }, 500);
        return json({ name: 'projects/itest-proj/databases/(default)/documents/' + path, fields: JSON.parse(opt.body).fields, updateTime: new Date().toISOString() });
      }
      if (method === 'DELETE') { rec.deleted.push(path); return json({}, deleteStatus(path)); }
      // Worker の読み書き: クラウドへは行かず、ここで止める(Worker の認証が先に通っていることを確かめるため)
      return json({ error: 'stopped in harness test' }, 503);
    }
    throw new Error('元の fetch に予定外の通信が来ました: ' + url);
  };
  return rec;
}
async function run(rec, project = 'itest-proj') {
  const logs = [], saved = globalThis.fetch;
  globalThis.fetch = rec.fetch;
  try { await runScenarios({ mode: 'real', serviceAccount: sa(project) }, (l) => logs.push(l)); return { logs, error: null }; }
  catch (error) { return { logs, error }; }
  finally { globalThis.fetch = saved; }
}

// 1. Worker 自身のトークン取得が元の fetch まで届く・予定外の通信は来ない・削除の失敗を報告する
{
  const rec = recorder({ deleteStatus: (p) => (p.startsWith('groups/') && p.split('/').length === 2 ? 403 : 200) });
  const { logs, error } = await run(rec);
  assert.ok(error, 'クラウドへ行かないので、検査は失敗で終わる');
  assert.ok(rec.tokenScopes.some((s) => s.includes('identitytoolkit')), 'Worker の Firestore.token() が元の fetch まで届いた');
  assert.ok(rec.tokenScopes.some((s) => s === 'https://www.googleapis.com/auth/datastore'), 'テストデータ用の認証も届いた');
  assert.ok(rec.calls.every((u) => u === 'https://oauth2.googleapis.com/token' || u.startsWith('https://firestore.googleapis.com/')),
    '偽物にした LINE・公開鍵・App Check・Identity Toolkit は元の fetch へ渡さない');
  assert.equal(rec.seeded.length, 4);
  for (const p of rec.seeded) assert.ok(rec.deleted.includes(p), '作った文書をすべて消そうとした: ' + p);
  assert.equal(error.cleanupFailures.length, 1);
  assert.match(error.cleanupFailures[0].path, /^groups\/itest[0-9a-f]+-home$/);
  assert.equal(error.cleanupFailures[0].status, 403);
  assert.ok(logs.some((l) => /片付けできなかった文書が 1 件/.test(l)), '片付けの失敗を表示する');
  assert.ok(logs.some((l) => /HTTP 403/.test(l)));
}
// 2. テストデータの作成が途中で失敗しても、作った分を片付ける
{
  const rec = recorder({ seedFailAt: 3 });
  const { logs, error } = await run(rec);
  assert.ok(error);
  assert.equal(rec.seeded.length, 3, '3件目で止まった');
  for (const p of rec.seeded) assert.ok(rec.deleted.includes(p), '作りかけの文書も消す: ' + p);
  assert.equal(error.cleanupFailures.length, 0);
  assert.ok(logs.some((l) => /すべて片付けました/.test(l)));
}
// 3. 片付けの通信そのものが例外になっても、報告する
{
  const rec = recorder();
  const base = rec.fetch;
  rec.fetch = async (url, opt = {}) => ((opt.method === 'DELETE' && String(url).includes('/accounts/')) ? Promise.reject(new Error('network down')) : base(url, opt));
  const { error } = await run(rec);
  assert.ok(error.cleanupFailures.some((f) => f.path.startsWith('accounts/') && /network down/.test(f.reason)));
}
// 4. 本番プロジェクトでは、通信する前に止まる
{
  const rec = recorder();
  const { error } = await run(rec, 'hidamari-5f8de');
  assert.match(error.message, /本番プロジェクトでは実行しません/);
  assert.equal(rec.calls.length, 0);
}
console.log('クラウド用結合確認スクリプトの検査: Workerの認証が元のfetchへ届く・予定外の通信なし・削除失敗の報告・作りかけの片付け・本番拒否 passed');
