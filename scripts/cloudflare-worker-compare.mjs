#!/usr/bin/env node
/* 稼働中のCloudflare Workerのコード・Cron・設定名を読み取り専用で取得し、リポジトリのファイルと比べる。
   - 読み取り専用のAPIトークン(権限: Workers Scripts: Read)だけを使う。書き込みはしない。
   - シークレットの「値」は取得しない(Cloudflareも返さない)。表示するのは設定の名前と種類だけ。
   - 結果は標準出力と OUT_DIR/report.md、取得したコードは OUT_DIR/live-<名前>.js に保存する。
   環境変数:
     CF_API_TOKEN   読み取り専用トークン(GitHub の Secrets から渡す。表示しない)
     CF_ACCOUNT_ID  アカウントID
     SCRIPT_NAME    Worker名(既定: mainiko-line)
     COMPARE_FILES  比べるファイル。「名前=パス」をカンマ区切り(例: main=/tmp/main-worker.js,PR=worker.js)
     OUT_DIR        出力先(既定: worker-compare) */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const token = process.env.CF_API_TOKEN || '', account = process.env.CF_ACCOUNT_ID || '';
const name = process.env.SCRIPT_NAME || 'mainiko-line';
const outDir = process.env.OUT_DIR || 'worker-compare';
const compare = (process.env.COMPARE_FILES || 'repo=worker.js').split(',').filter(Boolean).map((x) => { const [label, file] = x.split('='); return { label, file }; });
if (!token || !account) { console.error('CF_API_TOKEN と CF_ACCOUNT_ID が必要です(GitHub の Secrets / Variables)。'); process.exit(2); }
if (!/^[a-z0-9-]{1,63}$/.test(name)) { console.error('Worker名が正しくありません'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const api = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(account) + '/workers/scripts/' + name;
async function get(suffix, raw) {
  const res = await fetch(api + suffix, { headers: { authorization: 'Bearer ' + token } });
  if (raw) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.success === false) {
    const why = data && Array.isArray(data.errors) ? data.errors.map((e) => e.code + ' ' + e.message).join(' / ') : 'HTTP ' + res.status;
    throw new Error(suffix + ': ' + why);
  }
  return data.result;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');

/* コード本体: まず main モジュールの中身(content/v2)、だめならモジュール一式(multipart)から js を取り出す */
async function liveCode() {
  let res = await get('/content/v2', true);
  if (res.ok) {
    const type = res.headers.get('content-type') || '';
    if (!type.includes('multipart')) return { files: { [res.headers.get('cf-entrypoint') || 'worker.js']: await res.text() }, via: 'content/v2' };
    const form = await res.formData();
    return { files: Object.fromEntries(await Promise.all([...form.entries()].filter(([, v]) => typeof v !== 'string').map(async ([k, v]) => [v.name || k, await v.text()]))), via: 'content/v2 multipart' };
  }
  res = await get('', true);
  if (!res.ok) throw new Error('コードを取得できません: HTTP ' + res.status + '（トークンに Workers Scripts: Read の権限があるか確認してください）');
  const form = await res.formData();
  const files = {};
  for (const [k, v] of form.entries()) if (typeof v !== 'string') files[v.name || k] = await v.text();
  return { files, via: 'scripts multipart' };
}

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
out('# 稼働中Workerとリポジトリの比較（' + name + '）');
out('');
out('取得日時：' + new Date().toISOString());
let failed = false;
try {
  const { files, via } = await liveCode();
  const names = Object.keys(files);
  out('取得方法：' + via + '／モジュール：' + names.join('、'));
  const mainName = names.find((n) => /worker\.js$|index\.js$|\.mjs$/.test(n)) || names[0];
  const live = files[mainName] || '';
  for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(outDir, 'live-' + n.replace(/[^A-Za-z0-9._-]/g, '_')), text);
  fs.writeFileSync(path.join(outDir, 'live-main.js'), live);   // 差分を見るための、本体モジュールの写し
  const verLine = (live.match(/const VERSION_TEXT = '([^']*)'/) || [])[1] || '（版表示なし）';
  out('稼働中の版表示：' + verLine);
  out('稼働中のコード：' + live.split('\n').length + '行・SHA-256 ' + sha(live).slice(0, 16) + '…（改行・行末空白をそろえた値 ' + sha(norm(live)).slice(0, 16) + '…）');
  out('');
  out('| 比べた相手 | 完全一致 | 改行・行末空白をそろえて一致 | 行数 |');
  out('| --- | --- | --- | --- |');
  for (const c of compare) {
    if (!fs.existsSync(c.file)) { out('| ' + c.label + ' | （ファイルなし: ' + c.file + '） | | |'); continue; }
    const repo = fs.readFileSync(c.file, 'utf8');
    out('| ' + c.label + '（' + c.file + '） | ' + (repo === live ? '✅' : '❌') + ' | ' + (norm(repo) === norm(live) ? '✅' : '❌') + ' | ' + repo.split('\n').length + ' |');
    fs.copyFileSync(c.file, path.join(outDir, 'repo-' + c.label + '.js'));
  }
} catch (e) { failed = true; out('コードの取得に失敗：' + e.message); }
out('');
// Cron・設定・デプロイ情報も、取れなければ「確認済み」にしない(レポートは残して失敗で終わる)
const missing = [];
try {
  const s = await get('/schedules');
  if (!s || !Array.isArray(s.schedules)) throw new Error('応答に schedules がありません');
  out('Cron：' + (s.schedules.length ? s.schedules.map((x) => '`' + x.cron + '`').join('、') : 'なし（Cronは設定されていません）'));
} catch (e) { missing.push('Cron'); out('Cron の取得に失敗：' + e.message); }
try {
  const st = await get('/settings');
  if (!st || !Array.isArray(st.bindings)) throw new Error('応答に bindings がありません');
  const b = st.bindings;
  out('設定（名前と種類だけ。値は表示しません）：');
  for (const x of b) out('- ' + x.name + '（' + x.type + '）');
  if (!b.length) out('- なし');
  out('互換日付：' + (st && st.compatibility_date || '不明'));
} catch (e) { missing.push('設定'); out('設定の取得に失敗：' + e.message); }
try {
  const d = await get('/deployments');
  const dep = d && Array.isArray(d.deployments) ? d.deployments[0] : null;
  const versions = dep && Array.isArray(dep.versions) ? dep.versions.filter((v) => v && v.version_id) : [];
  if (!versions.length) throw new Error('有効なデプロイ（バージョン）が見つかりません');
  out('有効なデプロイ：' + (dep.created_on || '') + '／バージョン ' + versions.map((v) => String(v.version_id).slice(0, 8) + '（' + v.percentage + '%）').join('、'));
} catch (e) { missing.push('デプロイ情報'); out('デプロイ情報の取得に失敗：' + e.message); }
if (failed) missing.unshift('コード');
out('');
out(missing.length ? '**結果：取得できなかった情報があります（' + missing.join('・') + '）。照合は完了していません。**' : '結果：コード・Cron・設定・デプロイ情報をすべて取得しました（一致したかは上の表を見てください）。');
fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n') + '\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(missing.length ? 1 : 0);
