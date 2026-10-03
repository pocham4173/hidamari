/* LINEでログインの交換を、本物のFirestore REST API(エミュレーター または 隔離したテスト用プロジェクト)で確かめる。
   偽物にするのは LINE・Google の公開鍵・App Check・Identity Toolkit の照会だけ。Firestore の読み書き・トランザクションは本物。
   確かめること:
     1. 正常な交換
     2. 連携解除との競合
     3. accountClosures の新規作成との競合
     4. 取り消しとの競合
     5. 確定に失敗したときにトークンを出さず、rollback していること(ロックが残らないこと)
   競合は「Workerがトランザクションで読んだ直後」に別の操作を割り込ませて起こす。
   Firestore は、ロック待ちで割り込み側を待たせる(交換が先)か、交換の確定を失敗させる(割り込みが先)。
   どちらの場合も「割り込みが先に確定したのにトークンが出る」ことがないかを調べる。 */
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync, createSign, createHmac } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const APP = 'https://pocham4173.github.io';
const b64u = (v) => Buffer.from(v).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
const sha = async (v) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))).toString('hex');
const hex = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* target: { mode:'emulator', host:'127.0.0.1:8080', projectId } または { mode:'real', serviceAccount } */
export async function runScenarios(target, log = console.log) {
  const realFetch = globalThis.fetch;
  const emulator = target.mode === 'emulator';
  const sa = emulator
    ? (() => { const k = generateKeyPairSync('rsa', { modulusLength: 2048 }); return { project_id: target.projectId, client_email: 'itest@' + target.projectId + '.iam.gserviceaccount.com', private_key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }; })()
    : target.serviceAccount;
  const projectId = sa.project_id;
  if (!emulator && projectId === 'hidamari-5f8de') throw new Error('本番プロジェクトでは実行しません。隔離したテスト用プロジェクトを使ってください。');
  const run = 'itest' + hex(4);   // このときだけの名前(他の記録と混ざらない)
  const env = { LINE_CHANNEL_SECRET: 'x', LINE_CHANNEL_ACCESS_TOKEN: 'x', FIREBASE_SERVICE_ACCOUNT: JSON.stringify(sa),
    LINE_LOGIN_CHANNEL_ID: '2000000001', LINE_LOGIN_CHANNEL_SECRET: 'login-secret-' + run, LINE_LOGIN_CALLBACK_URL: 'https://w.example/auth/line/callback' };
  const fbKey = generateKeyPairSync('rsa', { modulusLength: 2048 }), acKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), kid });
  const jwt = (h, c, signer) => { const u = b64u(JSON.stringify(h)) + '.' + b64u(JSON.stringify(c)); return u + '.' + signer(u); };
  const rs = (k) => (u) => createSign('RSA-SHA256').update(u).sign(k.privateKey).toString('base64url');
  const idToken = (uid) => jwt({ alg: 'RS256', kid: 'fb1' }, { iss: 'https://securetoken.google.com/' + projectId, aud: projectId, sub: uid, iat: nowS() - 5, exp: nowS() + 3000, auth_time: nowS() - 5 }, rs(fbKey));
  const appCheck = () => jwt({ alg: 'RS256', kid: 'ac1' }, { iss: 'https://firebaseappcheck.googleapis.com/565713968884', aud: ['projects/565713968884'], sub: '1:565713968884:web:0a9665d1fe5e0fa161c8a1', exp: nowS() + 3000 }, rs(acKey));
  const lineCodes = new Map(), authUsers = new Set();
  const created = new Set();       // 片付けのため、作った文書を覚える
  const trace = { rollbacks: [], txnCommits: [] };
  let afterTxnRead = null;         // (path) => Promise : トランザクションで読んだ直後に割り込む
  const docsBase = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents';
  const toTarget = (url) => emulator ? url.replace('https://firestore.googleapis.com', 'http://' + target.host) : url;

  globalThis.fetch = async (url, opt = {}) => {
    url = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    // Worker 自身の Google 認証(Firestore.token())。エミュレーターでは偽の値、クラウドではこのURLだけ本物へ通す
    if (url === 'https://oauth2.googleapis.com/token') return emulator ? json({ access_token: 'owner', expires_in: 3600 }) : realFetch(url, opt);
    if (url === 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com') return json({ keys: [jwk(fbKey, 'fb1')] });
    if (url === 'https://firebaseappcheck.googleapis.com/v1/jwks') return json({ keys: [jwk(acKey, 'ac1')] });
    if (url.endsWith('/accounts:lookup')) {
      const id = JSON.parse(opt.body).localId[0];
      return json(authUsers.has(id) ? { users: [{ localId: id }] } : {});
    }
    if (url === 'https://api.line.me/oauth2/v2.1/token') {
      const p = new URLSearchParams(opt.body), c = lineCodes.get(p.get('code'));
      lineCodes.delete(p.get('code'));
      if (!c) return json({ error: 'invalid_grant' }, 400);
      const claims = { iss: 'https://access.line.me', aud: env.LINE_LOGIN_CHANNEL_ID, sub: c.sub, name: 'テスト', nonce: c.nonce, iat: nowS(), exp: nowS() + 600 };
      return json({ id_token: jwt({ alg: 'HS256' }, claims, (u) => createHmac('sha256', env.LINE_LOGIN_CHANNEL_SECRET).update(u).digest('base64url')) });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) {
      const headers = { ...(opt.headers || {}) };
      if (emulator) headers.authorization = 'Bearer owner';
      if (url.endsWith(':rollback')) trace.rollbacks.push(JSON.parse(opt.body).transaction);
      if (url.endsWith(':commit')) {
        const b = JSON.parse(opt.body);
        for (const w of b.writes || []) if (w.update) created.add(w.update.name.split('/documents/')[1]);
        if (b.transaction) trace.txnCommits.push(Date.now());
      }
      const res = await realFetch(toTarget(url), { ...opt, headers });
      if (url.endsWith(':batchGet') && afterTxnRead) {
        const b = JSON.parse(opt.body);
        if (b.transaction) for (const name of b.documents) await afterTxnRead(name.split('/documents/')[1]);
      }
      return res;
    }
    throw new Error('unexpected fetch ' + url);
  };

  const worker = (await import('../../worker.js?itest=' + run)).default;
  const api = (route, body, headers = {}) => worker.fetch(new Request('https://w.example/auth/line/' + route, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: APP, ...headers } }), env, {});
  const write = async (path, fields) => {
    created.add(path);
    const res = await globalThis.fetch(docsBase + '/' + path, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await adminToken() }, body: JSON.stringify({ fields }) });
    assert.ok(res.ok, 'seed ' + path + ' ' + res.status);
  };
  const read = async (path) => {
    const res = await globalThis.fetch(docsBase + '/' + path, { headers: { authorization: 'Bearer ' + await adminToken() } });
    return res.status === 404 ? null : res.json();
  };
  const remove = async (path) => globalThis.fetch(docsBase + '/' + path, { method: 'DELETE', headers: { authorization: 'Bearer ' + await adminToken() } });
  let cachedAdmin = '';
  async function adminToken() {
    if (emulator) return 'owner';
    if (cachedAdmin) return cachedAdmin;
    const u = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: nowS(), exp: nowS() + 3600 }));
    const assertion = u + '.' + createSign('RSA-SHA256').update(u).sign(sa.private_key).toString('base64url');
    const res = await realFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + assertion });
    const data = res.ok ? await res.json() : null;
    if (!data || typeof data.access_token !== 'string') throw new Error('テスト用プロジェクトのGoogle認証に失敗しました: ' + res.status);
    cachedAdmin = data.access_token;
    return cachedAdmin;
  }
  const S = (v) => ({ stringValue: v }), B = (v) => ({ booleanValue: v }), T = (d) => ({ timestampValue: d.toISOString() });

  /* 隔離したテストデータ: このときだけのUID・家庭 */
  const uid = run + '-user', group = run + '-home', sub = 'U' + hex(16);
  const lineKey = await sha('line-user|' + sub);

  async function begin(purpose) {
    const secret = hex(32);
    const res = await api('start', { purpose, secretHash: await sha(secret) }, purpose === 'link' ? { authorization: 'Bearer ' + idToken(uid) } : { 'x-firebase-appcheck': appCheck() });
    assert.equal(res.status, 200, 'start ' + purpose);
    const data = await res.json();
    created.add('lineAuthTx/' + data.tx);
    const q = new URL(data.authorizeUrl).searchParams, code = 'c' + hex(6);
    lineCodes.set(code, { sub, nonce: q.get('nonce') });
    const page = await (await worker.fetch(new Request('https://w.example/auth/line/callback?code=' + code + '&state=' + q.get('state')), env, {})).text();
    const m = /class="code"[^>]*>(\d{3}) (\d{3})</.exec(page);
    assert.ok(m, 'callback で確認番号が出る: ' + page.replace(/<style[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').slice(0, 400));
    return { tx: data.tx, secret, code: m[1] + m[2] };
  }
  async function link() {
    const r = await begin('link');
    const res = await api('confirm', { tx: r.tx, secret: r.secret, code: r.code }, { authorization: 'Bearer ' + idToken(uid) });
    assert.equal(res.status, 200, 'つなぐ');
    created.add('lineLoginLinks/' + lineKey); created.add('lineLoginAccounts/' + uid);
  }
  const exchange = (r) => api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, { 'x-firebase-appcheck': appCheck() });
  /* 交換のトランザクションの読み取り直後に、別の操作を割り込ませる。待ちすぎたら(ロック待ち)先に進める */
  async function race(name, interfere) {
    const r = await begin('login');
    let interferedAt = 0, interference = null, blocked = false;
    afterTxnRead = async (path) => {
      if (interference || !path.startsWith('lineLoginLinks/')) return;
      interference = interfere().then((v) => { interferedAt = Date.now(); return v; });
      const settled = await Promise.race([interference.then(() => true), sleep(3000).then(() => false)]);
      blocked = !settled;
    };
    const res = await exchange(r);
    afterTxnRead = null;
    const out = await res.json();
    const interferenceStatus = await interference;
    const interfered = interferenceStatus === 200;   // 割り込みが本当に確定したか
    const commitAt = trace.txnCommits.at(-1) || 0;
    if (out.customToken) {
      // トークンが出たなら、割り込みは確定していない(拒否された)か、交換の確定より後に確定していなければならない
      assert.ok(!interfered || (blocked && interferedAt >= commitAt), name + ': 割り込みが先に確定したのにトークンが出た (割り込み ' + interferenceStatus + ', 待ち ' + blocked + ')');
      log(`  ${name}: ${interfered ? '割り込みはロック待ちになり、交換が先に確定（その後に割り込みが確定）' : '割り込みは ' + interferenceStatus + ' で拒否され、交換が確定'}`);
    } else {
      assert.notEqual(res.status, 200, name);
      log(`  ${name}: 割り込みが先に確定し、交換は ${res.status} ${out.error}（トークンなし）`);
    }
    return { out, blocked };
  }

  let scenarioError = null;
  const cleanupFailures = [];
  try {
    // テストデータの作成も try の中: 途中で失敗しても、作った分は下で片付ける
    log('0. テストデータを作る（' + run + '）');
    authUsers.add(uid);
    await write('consents/' + uid, { version: S('2026-09-19.1'), mode: S('kazoku'), privacyAccepted: B(true), sensitiveAccepted: B(true), sharingAccepted: B(true), subjectBasis: S('explained-and-agreed'), acceptedAt: T(new Date()) });
    await write('groups/' + group, { createdBy: S(uid) });
    await write('groups/' + group + '/members/' + uid, { name: S('テスト'), status: S('approved'), mode: S('kazoku') });
    await write('accounts/' + uid, { groupId: S(group) });
    log('1. 正常な交換');
    await link();
    const ok = await exchange(await begin('login'));
    assert.equal(ok.status, 200);
    const token = (await ok.json()).customToken;
    assert.equal(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).uid, uid);
    log('  200・同じUIDのカスタムトークン');

    log('2. 連携解除との競合');
    const unlinked = await race('解除', () => api('unlink', {}, { authorization: 'Bearer ' + idToken(uid) }).then((r) => r.status));
    if (!unlinked.out.customToken) assert.equal(await read('lineLoginLinks/' + lineKey), null);
    if (await read('lineLoginLinks/' + lineKey) === null) await link();

    log('3. accountClosures の新規作成との競合');
    created.add('accountClosures/' + uid);
    const closureWrite = () => globalThis.fetch(docsBase.replace(/\/documents$/, '/documents:commit'), { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (emulator ? 'owner' : cachedAdmin) },
      body: JSON.stringify({ writes: [{ update: { name: 'projects/' + projectId + '/databases/(default)/documents/accountClosures/' + uid, fields: { requestedAt: T(new Date()) } }, currentDocument: { exists: false } }] }) }).then((r) => r.status);
    await adminToken();
    await race('終了手続き', closureWrite);
    await remove('accountClosures/' + uid);

    log('4. 取り消しとの競合');
    let cancelTx = null;
    const r4 = await begin('login');
    afterTxnRead = async (path) => {
      if (cancelTx || !path.startsWith('lineLoginLinks/')) return;
      cancelTx = api('cancel', { tx: r4.tx, secret: r4.secret }).then((x) => x.json());
      await Promise.race([cancelTx, sleep(3000)]);
    };
    const res4 = await exchange(r4);
    afterTxnRead = null;
    const out4 = await res4.json(), cancelled = await cancelTx;
    assert.ok(!(out4.customToken && cancelled.cancelled), '取り消しが確定し、かつトークンも出た');
    log(`  交換 ${res4.status}${out4.customToken ? '（トークンあり）' : '（トークンなし）'}・取り消し ${JSON.stringify(cancelled)}`);

    log('5. 確定に失敗したらトークンを出さず rollback する');
    const noLock = async (label) => {
      // ロックが残っていないこと: トランザクションで読んだ文書へ、すぐに書き込める
      const t0 = Date.now();
      await write('lineLoginLinks/' + lineKey, { uid: S(uid), linkedAt: T(new Date()) });
      await write('accountClosures/' + uid + '-probe', { requestedAt: T(new Date()) });
      await remove('accountClosures/' + uid + '-probe');
      assert.ok(Date.now() - t0 < 3000, label + ': rollback 後にロックが残っていない');
    };
    {
      // 5a. トランザクションの中の確認で止まる(終了手続きが先にある) → 確定せず rollback
      const r = await begin('login');
      created.add('accountClosures/' + uid);
      await write('accountClosures/' + uid, { requestedAt: T(new Date()) });
      const before = trace.rollbacks.length, commits = trace.txnCommits.length;
      const res = await exchange(r);
      const out = await res.json();
      assert.equal(res.status, 403); assert.equal(out.customToken, undefined);
      assert.equal(trace.txnCommits.length, commits, '確定(commit)していない');
      assert.equal(trace.rollbacks.length, before + 1, 'rollback した');
      await remove('accountClosures/' + uid);
      await noLock('5a');
      log('  5a: 確認で止まった → 403・トークンなし・rollback 済み・ロックなし');
    }
    {
      // 5b. 確定(commit)そのものが失敗する(読んだあとに終了手続きが作られた) → トークンなし
      // 本物のFirestoreでは、終了手続きの作成が交換のロック待ちになり、交換の確定より後に確定することがある。
      // そのため「文書があるか」ではなく「どちらが先に確定したか」で判定する(race と同じ考え方)
      const r = await begin('login');
      let closure = null, closureAt = 0, blocked = false;
      afterTxnRead = async (path) => {
        if (!path.startsWith('accountClosures/')) return;
        afterTxnRead = null;
        closure = closureWrite().then((status) => { closureAt = Date.now(); return status; });
        blocked = !(await Promise.race([closure.then(() => true), sleep(3000).then(() => false)]));
      };
      const commits = trace.txnCommits.length;
      const res = await exchange(r);
      afterTxnRead = null;
      const out = await res.json();
      const closureStatus = closure ? await closure : 0;
      const closed = closureStatus === 200;   // 終了手続きが本当に確定したか
      const commitAt = trace.txnCommits.at(-1) || 0;
      assert.ok(closure, '5b: 終了手続きの割り込みが行われた');
      assert.ok(trace.txnCommits.length > commits, '5b: 確定(commit)を試みた');
      if (out.customToken) {
        assert.ok(!closed || (blocked && closureAt >= commitAt), '5b: 終了手続きが先に確定したのにトークンが出た (終了手続き ' + closureStatus + ', 待ち ' + blocked + ')');
        log(`  5b: ${closed ? '終了手続きの作成はロック待ちになり、交換が先に確定（その後に終了手続きが確定）' : '終了手続きの作成は ' + closureStatus + ' で拒否され、交換が確定'}`);
      } else {
        assert.notEqual(res.status, 200, '5b');
        log(`  5b: 終了手続きが先に確定し、交換の確定が失敗 → ${res.status} ${out.error}・トークンなし`);
      }
      await remove('accountClosures/' + uid);
      await noLock('5b');
      log('  5b: ロックなし');
    }
    log('すべて期待どおりでした（' + (emulator ? 'Firestore エミュレーター' : 'テスト用プロジェクト ' + projectId) + '）');
  } catch (e) {
    scenarioError = e;
  } finally {
    afterTxnRead = null;
    // 片付け: 応答を確かめる(fetch は 403・500 でも例外にならない)。消せなかった文書はすべて報告する
    for (const path of created) {
      let status = 0, reason = '';
      try { status = (await remove(path)).status; } catch (e) { reason = e && e.message || String(e); }
      if (!((status >= 200 && status < 300) || status === 404)) cleanupFailures.push({ path, status, reason });
    }
    globalThis.fetch = realFetch;
    if (cleanupFailures.length) {
      log('片付けできなかった文書が ' + cleanupFailures.length + ' 件あります。手で削除してください:');
      for (const f of cleanupFailures) log('  - ' + f.path + '（' + (f.status ? 'HTTP ' + f.status : f.reason) + '）');
    } else if (created.size) {
      log('作ったテスト用の文書 ' + created.size + ' 件は、すべて片付けました');
    }
  }
  if (scenarioError || cleanupFailures.length) {
    const error = scenarioError || new Error('テスト用の文書の片付けに失敗しました');
    error.cleanupFailures = cleanupFailures;
    throw error;
  }
}
