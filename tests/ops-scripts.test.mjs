/* 照合・試験環境づくりのスクリプトの検査(外部には接続しない)。
   - cloudflare-worker-compare.mjs: 読み取りだけ・一致/不一致の判定・Cron・設定は名前と種類だけ(値は出さない)
   - build-staging.mjs: 本番のFirebase設定を拒否・試験用の設定だけを差し替える
   - staging-wrangler-config.mjs: 本番のWorker名・Cronつき設定・不正なURLを拒否 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
const run = (script, env, args = []) => spawnSync(process.execPath, [...args, script], { env: { ...process.env, ...env }, encoding: 'utf8', cwd: process.cwd() });
const mock = path.resolve('tests/helpers/mock-cloudflare.mjs');

// 1. 稼働中Workerとの照合
const repo = fs.readFileSync('worker.js', 'utf8');
fs.writeFileSync(path.join(tmp, 'same.js'), repo);
fs.writeFileSync(path.join(tmp, 'crlf.js'), repo.replace(/\n/g, '\r\n'));
fs.writeFileSync(path.join(tmp, 'diff.js'), repo.replace('作り直し', 'つくりなおし'));
for (const [file, mode, exact, normalized] of [['same.js', 'raw', '✅', '✅'], ['crlf.js', 'raw', '❌', '✅'], ['diff.js', 'multipart', '❌', '❌']]) {
  const out = path.join(tmp, 'out-' + file);
  const r = run('scripts/cloudflare-worker-compare.mjs', { CF_API_TOKEN: 'read-only-token', CF_ACCOUNT_ID: 'acc123', MOCK_LIVE_FILE: path.join(tmp, file), MOCK_MODE: mode, COMPARE_FILES: 'repo=worker.js', OUT_DIR: out }, ['--import', mock]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp('\\| repo（worker.js） \\| ' + exact + ' \\| ' + normalized), file);
  assert.match(r.stdout, /Cron：`\*\/15 \* \* \* \*`/);
  assert.match(r.stdout, /FIREBASE_SERVICE_ACCOUNT（secret_text）/);
  assert.ok(!r.stdout.includes('SHOULD-NOT-PRINT') && !fs.readFileSync(path.join(out, 'report.md'), 'utf8').includes('SHOULD-NOT-PRINT'), 'シークレットの値は表示しない');
  assert.ok(!r.stdout.includes('read-only-token'), 'トークンは表示しない');
  assert.match(r.stdout, /バージョン 8b690aa7（100%）/);
  assert.equal(fs.readFileSync(path.join(out, 'live-main.js'), 'utf8'), fs.readFileSync(path.join(tmp, file), 'utf8'));
}
{
  const r = run('scripts/cloudflare-worker-compare.mjs', { CF_API_TOKEN: 'wrong', CF_ACCOUNT_ID: 'acc123', MOCK_LIVE_FILE: path.join(tmp, 'same.js'), OUT_DIR: path.join(tmp, 'o403') }, ['--import', mock]);
  assert.equal(r.status, 1, '権限がなければ失敗で終わる');
  assert.match(r.stdout, /Workers Scripts: Read/);
}
assert.equal(run('scripts/cloudflare-worker-compare.mjs', { CF_API_TOKEN: '', CF_ACCOUNT_ID: '' }).status, 2);
// 1b. 一部の API だけが失敗(403・500)・有効なデプロイが空 → レポートは残して失敗で終わる(確認済みにしない)
for (const [label, env] of [
  ['Cron 403', { MOCK_FAIL: 'schedules:403' }], ['Cron 500', { MOCK_FAIL: 'schedules:500' }],
  ['設定 403', { MOCK_FAIL: 'settings:403' }], ['設定 500', { MOCK_FAIL: 'settings:500' }],
  ['デプロイ 403', { MOCK_FAIL: 'deployments:403' }], ['デプロイ 500', { MOCK_FAIL: 'deployments:500' }],
  ['デプロイが空', { MOCK_EMPTY_DEPLOYMENTS: '1' }], ['コード 500', { MOCK_FAIL: 'content/v2:500' }],
]) {
  const out = path.join(tmp, 'part-' + label.replace(/\s/g, '-'));
  const r = run('scripts/cloudflare-worker-compare.mjs', { CF_API_TOKEN: 'read-only-token', CF_ACCOUNT_ID: 'acc123', MOCK_LIVE_FILE: path.join(tmp, 'same.js'), OUT_DIR: out, COMPARE_FILES: 'repo=worker.js', ...env }, ['--import', mock]);
  assert.equal(r.status, 1, label + ': 失敗で終わる');
  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(report, /照合は完了していません/, label + ': レポートを残す');
  assert.ok(!/すべて取得しました/.test(report), label);
}
{
  // すべて取れたときだけ成功
  const out = path.join(tmp, 'all-ok');
  const r = run('scripts/cloudflare-worker-compare.mjs', { CF_API_TOKEN: 'read-only-token', CF_ACCOUNT_ID: 'acc123', MOCK_LIVE_FILE: path.join(tmp, 'same.js'), OUT_DIR: out }, ['--import', mock]);
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /すべて取得しました/);
}

// 2. 試験環境のファイル
{
  const env = { STAGING_ORIGIN: 'https://mainiko-line-staging.okm-co.workers.dev' };
  assert.equal(run('scripts/build-staging.mjs', { ...env, STAGING_FIREBASE_CONFIG: JSON.stringify({ apiKey: 'k', projectId: 'hidamari-5f8de' }) }).status, 2, '本番のFirebaseは拒否');
  assert.equal(run('scripts/build-staging.mjs', { STAGING_ORIGIN: 'https://mainiko-line.okm-co.workers.dev', STAGING_FIREBASE_CONFIG: JSON.stringify({ apiKey: 'k', projectId: 't' }) }).status, 2, '本番のWorkerのURLは拒否');
  const r = run('scripts/build-staging.mjs', { ...env, STAGING_FIREBASE_CONFIG: JSON.stringify({ apiKey: 'k', projectId: 'mainico-test', extra: 'x' }) });
  assert.equal(r.status, 0, r.stderr);
  const cfg = fs.readFileSync('dist-staging/mainico-config.js', 'utf8');
  assert.match(cfg, /MAINICO_STAGING = true/);
  assert.match(cfg, /"projectId":"mainico-test"/);
  assert.ok(!cfg.includes('extra'), '決まった項目だけを書く');
  assert.match(cfg, /MAINICO_LINE_AUTH_URL = "https:\/\/mainiko-line-staging\.okm-co\.workers\.dev"/);
  assert.ok(!fs.existsSync('dist-staging/worker.js'), 'Worker のコードは画面として配らない');
  assert.match(fs.readFileSync('dist-staging/index.html', 'utf8'), /試験環境（本番ではありません）/);
  assert.ok(!fs.readFileSync('index.html', 'utf8').includes('試験環境（本番ではありません）'), '本番の index.html は変えない');
  assert.ok(!fs.readFileSync('mainico-config.js', 'utf8').match(/^window\.MAINICO_STAGING/m), '本番の設定は変えない');
  fs.rmSync('dist-staging', { recursive: true, force: true });
}

// 2b. 配る前の確認: プロジェクトID・ウェブ設定・鍵の3つが同じテスト用プロジェクトでなければ止める
{
  const keyObj = (project, email = 'firebase-adminsdk-x@' + project + '.iam.gserviceaccount.com') => ({ type: 'service_account', project_id: project, client_email: email, private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' });
  const key = (project, email) => JSON.stringify(keyObj(project, email));
  const without = (field) => { const k = keyObj('mainico-test'); delete k[field]; return JSON.stringify(k); };
  const API_KEY = 'AIza' + 'x'.repeat(35);
  const web = (project, apiKey = API_KEY) => JSON.stringify({ apiKey, projectId: project });
  const pre = (TEST_PROJECT, cfg, sa) => run('scripts/staging-preflight.mjs', { TEST_PROJECT, STAGING_FIREBASE_CONFIG: cfg, SA_JSON: sa });
  const ok = pre('mainico-test', web('mainico-test'), key('mainico-test'));
  assert.equal(ok.status, 0, ok.stderr);
  for (const [label, args, why] of [
    ['鍵だけ本番', ['mainico-test', web('mainico-test'), key('hidamari-5f8de')], /鍵の project_id が本番|一致しません/],
    ['鍵だけ別のプロジェクト', ['mainico-test', web('mainico-test'), key('other-test')], /一致しません/],
    ['鍵のメールだけ本番', ['mainico-test', web('mainico-test'), key('mainico-test', 'firebase-adminsdk-x@hidamari-5f8de.iam.gserviceaccount.com')], /本番/],
    ['ウェブ設定だけ別', ['mainico-test', web('other-test'), key('mainico-test')], /一致しません/],
    ['プロジェクトIDが本番', ['hidamari-5f8de', web('hidamari-5f8de'), key('hidamari-5f8de')], /本番/],
    ['プロジェクトIDが空', ['', web('mainico-test'), key('mainico-test')], /MAINICO_TEST_PROJECT_ID がありません/],
    ['鍵が空', ['mainico-test', web('mainico-test'), ''], /JSON として読めません/],
    ['鍵に project_id がない', ['mainico-test', web('mainico-test'), without('project_id')], /project_id がありません/],
    ['ウェブ設定が空', ['mainico-test', '', key('mainico-test')], /JSON として読めません/],
    // JSON としては読めるが、オブジェクトでない(再審査 2026-10-02 の再現: SA_JSON=null で通ってしまっていた)
    ['鍵が null', ['mainico-test', web('mainico-test'), 'null'], /オブジェクトではありません（null）/],
    ['鍵が false', ['mainico-test', web('mainico-test'), 'false'], /オブジェクトではありません（boolean）/],
    ['鍵が配列', ['mainico-test', web('mainico-test'), JSON.stringify([keyObj('mainico-test')])], /オブジェクトではありません（配列）/],
    ['鍵が文字列', ['mainico-test', web('mainico-test'), JSON.stringify('mainico-test')], /オブジェクトではありません（string）/],
    ['鍵が数値', ['mainico-test', web('mainico-test'), '0'], /オブジェクトではありません（number）/],
    ['ウェブ設定が null', ['mainico-test', 'null', key('mainico-test')], /オブジェクトではありません（null）/],
    ['ウェブ設定が false', ['mainico-test', 'false', key('mainico-test')], /オブジェクトではありません（boolean）/],
    ['ウェブ設定が配列', ['mainico-test', JSON.stringify([{ projectId: 'mainico-test' }]), key('mainico-test')], /オブジェクトではありません（配列）/],
    ['ウェブ設定に projectId がない', ['mainico-test', JSON.stringify({ apiKey: 'k' }), key('mainico-test')], /ウェブ設定の projectId がありません/],
    ['ウェブ設定の apiKey が伏せ字', ['mainico-test', web('mainico-test', 'AIzaSyAc' + '•'.repeat(31)), key('mainico-test')], /apiKey がFirebaseのAPIキーの形ではありません/],
    ['ウェブ設定の apiKey がない', ['mainico-test', JSON.stringify({ projectId: 'mainico-test' }), key('mainico-test')], /apiKey がFirebaseのAPIキーの形ではありません/],
    ['ウェブ設定の apiKey が短い', ['mainico-test', web('mainico-test', 'AIzaSyAc'), key('mainico-test')], /apiKey がFirebaseのAPIキーの形ではありません/],
    ['ウェブ設定の projectId が空', ['mainico-test', web(''), key('mainico-test')], /ウェブ設定の projectId がありません/],
    // client_email
    ['鍵のメールがない', ['mainico-test', web('mainico-test'), without('client_email')], /client_email がありません/],
    ['鍵のメールが空', ['mainico-test', web('mainico-test'), key('mainico-test', '')], /client_email がありません/],
    ['鍵のメールが別の形', ['mainico-test', web('mainico-test'), key('mainico-test', 'someone@example.com')], /サービスアカウントの形/],
    ['鍵のメールの後ろが違う', ['mainico-test', web('mainico-test'), key('mainico-test', 'firebase-adminsdk-x@mainico-test.iam.gserviceaccount.com.evil.example')], /サービスアカウントの形/],
    ['鍵のメールが別プロジェクト', ['mainico-test', web('mainico-test'), key('mainico-test', 'firebase-adminsdk-x@other-test.iam.gserviceaccount.com')], /一致しません/],
    ['鍵が service_account でない', ['mainico-test', web('mainico-test'), JSON.stringify({ ...keyObj('mainico-test'), type: 'authorized_user' })], /type が service_account/],
    ['鍵に private_key がない', ['mainico-test', web('mainico-test'), without('private_key')], /private_key がありません/],
    ['プロジェクトIDが形でない', ['Mainico Test', web('mainico-test'), key('mainico-test')], /プロジェクトIDの形ではありません/],
  ]) {
    const r = pre(...args);
    assert.equal(r.status, 2, label + ': 止める');
    assert.match(r.stderr, why, label);
    assert.ok(!r.stderr.includes('PRIVATE KEY') && !r.stdout.includes('PRIVATE KEY'), label + ': 鍵の中身を表示しない');
  }
  // ワークフローでは、この確認が配信・ルール変更・秘密の値の登録より前にある
  const wf = fs.readFileSync('.github/workflows/line-login-ops.yml', 'utf8');
  const job = wf.slice(wf.indexOf('  staging-deploy:'));
  const at = (t) => { const i = job.indexOf(t); assert.ok(i > 0, t); return i; };
  const preflight = at('node scripts/staging-preflight.mjs');
  for (const later of ['firebase-tools@13 deploy', 'wrangler@4 deploy', 'wrangler@4 secret put']) assert.ok(preflight < at(later), '確認は「' + later + '」より前');
  // 前の手順で外部を変えていない(checkout と setup-node だけ)
  const before = job.slice(0, preflight);
  assert.ok(!/wrangler|firebase-tools|curl/.test(before), '確認より前に外部へ書く手順がない');
}

// 3. 試験環境の Worker 設定
{
  const ok = run('scripts/staging-wrangler-config.mjs', { STAGING_ORIGIN: 'https://mainiko-line-staging.okm-co.workers.dev', CHANNEL_ID: '2000000001' });
  assert.equal(ok.status, 0, ok.stderr);
  const t = fs.readFileSync('staging/wrangler.ci.toml', 'utf8');
  assert.match(t, /^name = "mainiko-line-staging"$/m);
  assert.ok(!/\[triggers\]|crons/.test(t), '試験環境に Cron はない');
  assert.match(t, /LINE_LOGIN_APP_CHECK = "off"/);
  assert.ok(!/SECRET|private_key/i.test(t.split('[vars]')[1]), '秘密の値は書かない');
  fs.rmSync('staging/wrangler.ci.toml');
  assert.equal(run('scripts/staging-wrangler-config.mjs', { STAGING_ORIGIN: 'https://mainiko-line.okm-co.workers.dev', CHANNEL_ID: '2000000001' }).status, 2);
  assert.equal(run('scripts/staging-wrangler-config.mjs', { STAGING_ORIGIN: 'https://mainiko-line-staging.okm-co.workers.dev', CHANNEL_ID: 'x' }).status, 2);
}
console.log('照合・試験環境のスクリプト: 読み取りのみ・一致判定・値を出さない・本番の拒否・Cronなし passed');
