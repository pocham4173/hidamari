#!/usr/bin/env node
/* 試験環境の Worker 設定(staging/wrangler.ci.toml)を、この実行だけのために作る。
   公開してよい設定値だけを [vars] に書く。秘密の値は入れない(wrangler secret put で別に入れる)。
   本番の Worker 名(mainiko-line)になっていたら止める。 */
import fs from 'node:fs';
const origin = String(process.env.STAGING_ORIGIN || '').replace(/\/+$/, '');
const channel = String(process.env.CHANNEL_ID || '');
if (!/^https:\/\/mainiko-line-staging\.[a-z0-9-]+\.workers\.dev$/.test(origin)) { console.error('MAINICO_STAGING_ORIGIN が試験環境のURLではありません'); process.exit(2); }
if (!/^\d{10}$/.test(channel)) { console.error('LINE_LOGIN_STAGING_CHANNEL_ID(10桁)を設定してください'); process.exit(2); }
const base = fs.readFileSync('staging/wrangler.toml', 'utf8');
if (!/^name = "mainiko-line-staging"$/m.test(base) || /^\[triggers\]/m.test(base)) { console.error('試験環境の設定ではありません(名前・Cron を確認)'); process.exit(2); }
const vars = { MAINICO_APP_URL: origin + '/', LINE_LOGIN_CALLBACK_URL: origin + '/auth/line/callback', LINE_LOGIN_CHANNEL_ID: channel, LINE_LOGIN_APP_CHECK: 'off' };
fs.writeFileSync('staging/wrangler.ci.toml', base + '\n[vars]\n' + Object.entries(vars).map(([k, v]) => k + ' = ' + JSON.stringify(v)).join('\n') + '\n');
console.log('staging/wrangler.ci.toml を作りました（' + origin + '）');
