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
