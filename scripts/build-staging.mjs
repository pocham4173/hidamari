#!/usr/bin/env node
/* 試験環境(mainiko-line-staging)で配るアプリのファイルを dist-staging/ に作る。
   - 本番(GitHub Pages)のファイルは変えない。mainico-config.js だけ、試験用の内容に差し替える。
   - Firebase はテスト用プロジェクト(本番 hidamari-5f8de は拒否)。App Check は使わない。
   環境変数:
     STAGING_FIREBASE_CONFIG  テスト用プロジェクトのウェブ設定(JSON。公開してよい値。GitHub の Variables から)
     STAGING_ORIGIN           試験環境のURL(例: https://mainiko-line-staging.okm-co.workers.dev) */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'dist-staging');
let config;
try { config = JSON.parse(process.env.STAGING_FIREBASE_CONFIG || ''); } catch (e) { config = null; }
const origin = String(process.env.STAGING_ORIGIN || '').replace(/\/+$/, '');
if (!config || typeof config.projectId !== 'string' || typeof config.apiKey !== 'string') {
  console.error('STAGING_FIREBASE_CONFIG にテスト用プロジェクトのウェブ設定(JSON)を入れてください。'); process.exit(2);
}
if (config.projectId === 'hidamari-5f8de') { console.error('本番プロジェクトの設定では試験環境を作りません。'); process.exit(2); }
if (!/^https:\/\/mainiko-line-staging\.[a-z0-9-]+\.workers\.dev$/.test(origin)) {
  console.error('STAGING_ORIGIN は https://mainiko-line-staging.〈アカウント〉.workers.dev の形にしてください。'); process.exit(2);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const skip = new Set(['worker.js', 'check-basics.mjs', 'mainico-config.js']);
let n = 0;
for (const f of fs.readdirSync(root)) {
  const p = path.join(root, f);
  if (!fs.statSync(p).isFile() || skip.has(f) || f.startsWith('.')) continue;
  if (!/\.(html|js|css|png|json|webmanifest|ico|svg)$/.test(f) || /\.test\.mjs$/.test(f) || f === 'package.json') continue;
  fs.copyFileSync(p, path.join(out, f)); n++;
}
const allowed = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
const web = Object.fromEntries(allowed.filter((k) => typeof config[k] === 'string').map((k) => [k, config[k]]));
fs.writeFileSync(path.join(out, 'mainico-config.js'),
  '/* 試験環境(mainiko-line-staging)用。scripts/build-staging.mjs が作る。本番では使わない */\n' +
  'window.MAINICO_STAGING = true;\n' +
  'window.MAINICO_FIREBASE_CONFIG = ' + JSON.stringify(web) + ';\n' +
  "window.MAINICO_RECAPTCHA_SITE_KEY = '';\n" +
  'window.MAINICO_LINE_AUTH_URL = ' + JSON.stringify(origin) + ';\n' +
  'window.MAINICO_RECONNECT_URL = ' + JSON.stringify(origin) + ';\n');
// 試験環境だと一目で分かるようにする
const idx = path.join(out, 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<body', '<body data-staging="1"').replace('</body>',
  '<div style="position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#B3261E;color:#fff;text-align:center;font:700 13px system-ui;padding:4px" aria-hidden="true">試験環境（本番ではありません）</div></body>'));
console.log('試験環境のファイルを作りました: ' + n + ' 件 + mainico-config.js（' + web.projectId + '）→ ' + out);
