#!/usr/bin/env node
/* 試験環境に配る前の確認(外部への変更を始める前に必ず実行する)。
   次の3つが空でなく、すべて同じテスト用プロジェクトで、本番(hidamari-5f8de)でないことを確かめる。
     - TEST_PROJECT            GitHub Variables の MAINICO_TEST_PROJECT_ID
     - STAGING_FIREBASE_CONFIG 画面用のウェブ設定(JSON)の projectId
     - SA_JSON                 Worker に登録するサービスアカウント鍵(JSON)の project_id(と client_email のプロジェクト)
   鍵の中身は表示しない。1つでも合わなければ、何も変えずに止まる(終了コード 2)。 */
const PROD = 'hidamari-5f8de';
const problems = [];
const project = String(process.env.TEST_PROJECT || '').trim();
let web = null, sa = null;
try { web = JSON.parse(process.env.STAGING_FIREBASE_CONFIG || ''); } catch (e) { problems.push('画面用のウェブ設定(MAINICO_STAGING_FIREBASE_CONFIG)が JSON として読めません'); }
try { sa = JSON.parse(process.env.SA_JSON || ''); } catch (e) { problems.push('サービスアカウント鍵(MAINICO_TEST_SERVICE_ACCOUNT)が JSON として読めません'); }
const webProject = web && typeof web.projectId === 'string' ? web.projectId.trim() : '';
const keyProject = sa && typeof sa.project_id === 'string' ? sa.project_id.trim() : '';
const emailProject = sa && typeof sa.client_email === 'string' ? (/@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/.exec(sa.client_email) || [])[1] || '' : '';
if (!project) problems.push('MAINICO_TEST_PROJECT_ID が空です');
if (web && !webProject) problems.push('ウェブ設定に projectId がありません');
if (sa && !keyProject) problems.push('サービスアカウント鍵に project_id がありません');
if (sa && (typeof sa.private_key !== 'string' || !sa.private_key.includes('PRIVATE KEY'))) problems.push('サービスアカウント鍵の形ではありません');
for (const [label, value] of [['MAINICO_TEST_PROJECT_ID', project], ['ウェブ設定の projectId', webProject], ['鍵の project_id', keyProject], ['鍵の client_email のプロジェクト', emailProject]]) {
  if (value === PROD) problems.push(label + ' が本番(' + PROD + ')です');
}
const values = [project, webProject, keyProject].filter(Boolean);
if (values.length === 3 && new Set(values).size !== 1) problems.push('プロジェクトが一致しません（MAINICO_TEST_PROJECT_ID=' + project + '・ウェブ設定=' + webProject + '・鍵=' + keyProject + '）');
if (emailProject && keyProject && emailProject !== keyProject) problems.push('鍵の client_email のプロジェクト(' + emailProject + ')が project_id と違います');
if (problems.length) {
  console.error('試験環境への配信を止めました（まだ何も変えていません）:');
  for (const p of problems) console.error('- ' + p);
  process.exit(2);
}
console.log('確認しました: 3つともテスト用プロジェクト ' + project + '（本番ではありません）');
