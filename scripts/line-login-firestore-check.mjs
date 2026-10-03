#!/usr/bin/env node
/* LINEでログインの交換を、本物の Firestore REST API で確かめる(手動で実行)。
   - 本番(hidamari-5f8de)では実行しません。隔離したテスト用の Firebase プロジェクトを使ってください。
   - そのときだけの名前(itest〜)の文書を作り、終わったら消します。実際の利用者の記録には触れません。
   - LINE・Google の公開鍵・App Check・Identity Toolkit は偽物です。Firestore の読み書きとトランザクションだけが本物です。
   使い方:
     MAINICO_TEST_SERVICE_ACCOUNT=/path/to/test-project-sa.json \
       node scripts/line-login-firestore-check.mjs --project <テスト用プロジェクトID>
   サービスアカウントには、テスト用プロジェクトの Firestore の読み書き権限(Cloud Datastore ユーザー)が必要です。 */
import fs from 'node:fs';
import { runScenarios } from '../tests/helpers/line-login-firestore-scenarios.mjs';

const file = process.env.MAINICO_TEST_SERVICE_ACCOUNT;
const i = process.argv.indexOf('--project');
const confirm = i > 0 ? process.argv[i + 1] : '';
if (!file) { console.error('MAINICO_TEST_SERVICE_ACCOUNT にテスト用プロジェクトのサービスアカウントJSONのパスを指定してください。'); process.exit(2); }
const sa = JSON.parse(fs.readFileSync(file, 'utf8'));
if (sa.project_id === 'hidamari-5f8de') { console.error('本番プロジェクトでは実行しません。'); process.exit(2); }
if (!confirm || confirm !== sa.project_id) { console.error('確認のため --project にサービスアカウントと同じテスト用プロジェクトID(' + sa.project_id + ')を指定してください。'); process.exit(2); }
await runScenarios({ mode: 'real', serviceAccount: sa });
