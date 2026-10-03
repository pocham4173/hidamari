#!/usr/bin/env node
/* 試験環境に配る前の確認(外部への変更を始める前に必ず実行する)。
   次の4つがすべてそろい、同じテスト用プロジェクトで、本番(hidamari-5f8de)でないことを確かめる。
     - TEST_PROJECT            GitHub Variables の MAINICO_TEST_PROJECT_ID
     - STAGING_FIREBASE_CONFIG 画面用のウェブ設定(staging/firebase-web-config.json。JSONのオブジェクト)の projectId
     - SA_JSON                 Worker に登録するサービスアカウント鍵(JSONのオブジェクト)の project_id
     - 同じ鍵の client_email   「〜@<プロジェクト>.iam.gserviceaccount.com」の形から取り出したプロジェクト
   null・false・配列・文字列など、オブジェクトでない JSON は受け付けない。どれか1つでも欠ける・形が違う・
   一致しない・本番のとき、ウェブ設定の apiKey がAPIキーの形でないときは、何も変えずに止まる(終了コード 2)。鍵の中身は表示しない。 */
const PROD = 'hidamari-5f8de';
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;                                  // Firebase/Google Cloud のプロジェクトIDの形
const SA_EMAIL_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const problems = [];

/* JSON として読めて、null・配列・プリミティブではないオブジェクトだけを返す */
function plainObject(text, label) {
  let value;
  try { value = JSON.parse(String(text || '')); } catch (e) { problems.push(label + ' が JSON として読めません'); return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(label + ' が JSON のオブジェクトではありません（' + (value === null ? 'null' : Array.isArray(value) ? '配列' : typeof value) + '）');
    return null;
  }
  return value;
}
/* 空でない、プロジェクトIDの形の文字列だけを受け付ける */
function projectId(value, label) {
  if (typeof value !== 'string' || !value.trim()) { problems.push(label + ' がありません'); return ''; }
  const v = value.trim();
  if (!PROJECT_RE.test(v)) { problems.push(label + ' がプロジェクトIDの形ではありません'); return ''; }
  return v;
}

const project = projectId(process.env.TEST_PROJECT, 'MAINICO_TEST_PROJECT_ID');
const web = plainObject(process.env.STAGING_FIREBASE_CONFIG, '画面用のウェブ設定(staging/firebase-web-config.json)');
const sa = plainObject(process.env.SA_JSON, 'サービスアカウント鍵(MAINICO_TEST_SERVICE_ACCOUNT)');
const webProject = web ? projectId(web.projectId, 'ウェブ設定の projectId') : '';
// ウェブ設定の apiKey は「AIza」で始まる39文字。コピーの途中で伏せ字(•)などに置き換わったものは、画面で auth/api-key-not-valid になる
if (web && (typeof web.apiKey !== 'string' || !/^AIza[0-9A-Za-z_-]{35}$/.test(web.apiKey))) problems.push('ウェブ設定の apiKey がFirebaseのAPIキーの形ではありません（伏せ字や途中切れの可能性）');
const keyProject = sa ? projectId(sa.project_id, 'サービスアカウント鍵の project_id') : '';
let emailProject = '';
if (sa) {
  if (sa.type !== 'service_account') problems.push('サービスアカウント鍵の type が service_account ではありません');
  if (typeof sa.private_key !== 'string' || !/-----BEGIN PRIVATE KEY-----/.test(sa.private_key)) problems.push('サービスアカウント鍵に private_key がありません');
  if (typeof sa.client_email !== 'string' || !sa.client_email.trim()) problems.push('サービスアカウント鍵に client_email がありません');
  else {
    const m = SA_EMAIL_RE.exec(sa.client_email.trim());
    if (!m) problems.push('サービスアカウント鍵の client_email がサービスアカウントの形（〜@プロジェクト.iam.gserviceaccount.com）ではありません');
    else emailProject = m[1];
  }
}
const all = [['MAINICO_TEST_PROJECT_ID', project], ['ウェブ設定の projectId', webProject], ['鍵の project_id', keyProject], ['鍵の client_email のプロジェクト', emailProject]];
for (const [label, value] of all) if (value === PROD) problems.push(label + ' が本番(' + PROD + ')です');
// 4つすべてがそろったときだけ一致を比べる(そろわないときは上で必ず止まる)
if (all.every(([, v]) => v) && new Set(all.map(([, v]) => v)).size !== 1) {
  problems.push('プロジェクトが一致しません（' + all.map(([l, v]) => l + '=' + v).join('・') + '）');
}
if (problems.length || !all.every(([, v]) => v)) {
  if (!problems.length) problems.push('必要なプロジェクトIDがそろっていません');
  console.error('試験環境への配信を止めました（まだ何も変えていません）:');
  for (const p of problems) console.error('- ' + p);
  process.exit(2);
}
console.log('確認しました: 4つともテスト用プロジェクト ' + project + '（本番ではありません）');
