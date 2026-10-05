/* 再接続QR(worker.js /auth/reconnect・2026-10-05)の模擬テスト。
   偽物の作りは line-login-worker.test.mjs と同じ(Google・App Check・Firestore)。
   ご本人の新しいスマホが、家族の出したコードで、同じUIDに1回だけ入れること・前のログインを無効にすることを確かめる。 */
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync, createSign, createHmac, createVerify } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const worker = (await import('../worker.js')).default;

const APP = 'https://pocham4173.github.io';
const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { project_id: 'demo', client_email: 'sa@demo.iam.gserviceaccount.com',
  private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const base = { LINE_CHANNEL_SECRET: 'secret123', LINE_CHANNEL_ACCESS_TOKEN: 'tok', FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA) };
const env = { ...base, LINE_LOGIN_CHANNEL_ID: '2000000001', LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
  LINE_LOGIN_CALLBACK_URL: 'https://w.example/auth/line/callback' };
const ROOT = 'projects/demo/databases/(default)/documents';

/* ---- 鍵(Firebase認証・App Check・LINEのES256) ---- */
const fbKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const acKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const lineEc = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), kid });
const b64u = (v) => Buffer.from(v).toString('base64url');
function jwt(header, claims, signer) {
  const unsigned = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(claims));
  return unsigned + '.' + signer(unsigned);
}
const rs = (key) => (u) => createSign('RSA-SHA256').update(u).sign(key.privateKey).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const idToken = (uid, extra = {}) => jwt({ alg: 'RS256', kid: 'fb1' },
  { iss: 'https://securetoken.google.com/demo', aud: 'demo', sub: uid, iat: now() - 10, exp: now() + 3000, auth_time: now() - 10, ...extra }, rs(fbKey));
const appCheck = (extra = {}) => jwt({ alg: 'RS256', kid: 'ac1', typ: 'JWT' },
  { iss: 'https://firebaseappcheck.googleapis.com/565713968884', aud: ['projects/565713968884', 'projects/demo'],
    sub: '1:565713968884:web:0a9665d1fe5e0fa161c8a1', iat: now(), exp: now() + 3000, ...extra }, rs(acKey));
let lineAlg = 'HS256';
const lineIdToken = (claims) => lineAlg === 'HS256'
  ? jwt({ alg: 'HS256', typ: 'JWT' }, claims, (u) => createHmac('sha256', env.LINE_LOGIN_CHANNEL_SECRET).update(u).digest('base64url'))
  : jwt({ alg: 'ES256', typ: 'JWT', kid: 'le1' }, claims, (u) => createSign('SHA256').update(u).sign({ key: lineEc.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'));

/* ---- 偽Firestore(既存の模擬テストと同じ作り) ---- */
const db = new Map();
let clock = 1;
const put = (path, fields) => db.set(path, { fields, updateTime: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString() });
const S = (v) => ({ stringValue: v }), T = (d) => ({ timestampValue: d.toISOString() }), B = (v) => ({ booleanValue: v });
const docJson = (path) => ({ name: ROOT + '/' + path, fields: db.get(path).fields, updateTime: db.get(path).updateTime });

/* ---- 偽の認証利用者(Identity Toolkit) ---- */
const authUsers = new Map([['owner', {}], ['fam', {}], ['anon', {}], ['solo', {}]]);
/* ---- 偽LINE: 認可コード → 利用者 ---- */
const lineCodes = new Map();   // code -> { sub, name, verifier challenge check, nonce override }
const calls = [], queries = [], txns = new Map(), hooks = {}, revoked = [];
let revokeFail = false;
let txnSeq = 0;
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  calls.push(url);
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
  const body = opt.body ? (typeof opt.body === 'string' && opt.body.startsWith('{') ? JSON.parse(opt.body) : opt.body) : null;
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'gtok', expires_in: 3600 });
  if (url === 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com') return json({ keys: [jwk(fbKey, 'fb1')] }, 200, { 'cache-control': 'public, max-age=100' });
  if (url === 'https://firebaseappcheck.googleapis.com/v1/jwks') return json({ keys: [jwk(acKey, 'ac1')] });
  if (url === 'https://api.line.me/oauth2/v2.1/certs') return json({ keys: [jwk(lineEc, 'le1')] });
  if (url === 'https://identitytoolkit.googleapis.com/v1/projects/demo/accounts:lookup') {
    assert.equal(opt.headers.authorization, 'Bearer gtok');
    const id = body.localId[0], u = authUsers.get(id);
    return json(u ? { users: [{ localId: id, ...u }] } : {});
  }
  if (url === 'https://api.line.me/oauth2/v2.1/token') {
    const p = new URLSearchParams(body);
    const c = lineCodes.get(p.get('code'));
    if (!c || p.get('client_secret') !== env.LINE_LOGIN_CHANNEL_SECRET || p.get('redirect_uri') !== env.LINE_LOGIN_CALLBACK_URL) return json({ error: 'invalid_grant' }, 400);
    lineCodes.delete(p.get('code'));   // LINEの認可コードも一回限り
    const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.get('code_verifier')))).toString('base64url');
    if (expected !== c.challenge) return json({ error: 'invalid_grant' }, 400);
    return json({ access_token: 'line-at', id_token: lineIdToken({ iss: 'https://access.line.me', aud: env.LINE_LOGIN_CHANNEL_ID,
      sub: c.sub, name: c.name, nonce: c.nonce, iat: now(), exp: now() + 3600, ...(c.claims || {}) }) });
  }
  if (url === 'https://identitytoolkit.googleapis.com/v1/projects/demo/accounts:update') {
    assert.equal(opt.headers.authorization, 'Bearer gtok');
    revoked.push(body);
    if (revokeFail) return json({}, 500);
    return json({ localId: body.localId });
  }
  const fsBase = 'https://firestore.googleapis.com/v1/' + ROOT;
  assert.ok(url.startsWith(fsBase), url);
  const u = new URL(url);
  let rest = decodeURIComponent(u.pathname).slice(('/v1/' + ROOT).length).replace(/^\//, '');
  if (rest === ':beginTransaction') { const id = 'txn' + (++txnSeq); txns.set(id, new Map()); return json({ transaction: id }); }
  if (rest === ':rollback') { txns.delete(body.transaction); return json({}); }
  if (rest === ':batchGet') {
    const out = [];
    for (const name of body.documents) {
      const path = name.slice(ROOT.length + 1);
      if (body.transaction && txns.has(body.transaction)) txns.get(body.transaction).set(path, db.get(path)?.updateTime ?? null);
      out.push(db.has(path) ? { found: docJson(path) } : { missing: name });
      if (body.transaction && hooks.onTxnRead) await hooks.onTxnRead(path);
    }
    return json(out);
  }
  if (rest === ':commit') {
    if (body.transaction) {
      // 本物と同じく、トランザクションで読んだ文書が確定までに変わっていたら失敗(ABORTED)
      const reads = txns.get(body.transaction);
      txns.delete(body.transaction);
      if (!reads) return json({}, 400);
      for (const [path, ut] of reads) if ((db.get(path)?.updateTime ?? null) !== ut) return json({}, 409);
    }
    for (const w of body.writes) {
      const path = (w.delete || w.update.name).slice(ROOT.length + 1), pre = w.currentDocument;
      if (pre && ((pre.updateTime && db.get(path)?.updateTime !== pre.updateTime) || (pre.exists === false && db.has(path)))) return json({}, 409);
    }
    const writeResults = [];
    for (const w of body.writes) {
      const path = (w.delete || w.update.name).slice(ROOT.length + 1);
      if (w.delete) { db.delete(path); writeResults.push({}); continue; }
      // updateMask があれば本物と同じく、その項目だけを書き換える
      const fields = w.updateMask ? { ...(db.get(path)?.fields || {}) } : {};
      for (const k of w.updateMask ? w.updateMask.fieldPaths : Object.keys(w.update.fields)) { if (k in w.update.fields) fields[k] = w.update.fields[k]; else delete fields[k]; }
      put(path, fields); writeResults.push({ updateTime: db.get(path).updateTime });
    }
    return json({ writeResults });
  }
  if (rest.endsWith(':runQuery')) {
    const q = body.structuredQuery, f = q.where && q.where.fieldFilter;
    let out = [...db.keys()].filter((p) => p.split('/').length === 2 && p.split('/')[0] === q.from[0].collectionId).filter((p) => {
      if (!f) return true;
      const v = db.get(p).fields[f.field.fieldPath];
      return v && v.timestampValue && f.op === 'LESS_THAN_OR_EQUAL' && Date.parse(v.timestampValue) <= Date.parse(f.value.timestampValue);
    });
    out.sort((a, b) => Date.parse(db.get(a).fields.expiresAt?.timestampValue || 0) - Date.parse(db.get(b).fields.expiresAt?.timestampValue || 0));
    if (q.limit) out = out.slice(0, q.limit);
    queries.push(q.from[0].collectionId);
    return json(out.length ? out.map((p) => ({ document: docJson(p) })) : [{ readTime: 'x' }]);
  }
  const method = opt.method || 'GET';
  if (method === 'GET' && rest.split('/').length % 2 === 1) {
    return json({ documents: [...db.keys()].filter((p) => p.split('/').slice(0, -1).join('/') === rest).map(docJson) });
  }
  if (method === 'GET') {
    const txn = u.searchParams.get('transaction');
    if (txn && txns.has(txn)) txns.get(txn).set(rest, db.get(rest)?.updateTime ?? null);
    if (txn && hooks.onTxnRead) await hooks.onTxnRead(rest);
    return db.has(rest) ? json(docJson(rest)) : json({ error: {} }, 404);
  }
  if (method === 'DELETE') { db.delete(rest); return json({}); }
  if (method === 'PATCH') {
    const pre = u.searchParams.get('currentDocument.updateTime');
    if (pre && (!db.has(rest) || db.get(rest).updateTime !== pre)) return json({ error: {} }, 400);
    const mask = u.searchParams.getAll('updateMask.fieldPaths');
    const fields = mask.length ? { ...(db.get(rest)?.fields || {}), ...body.fields } : body.fields;
    for (const m of mask) if (!(m in (body.fields || {}))) delete fields[m];
    put(rest, fields);
    return json(docJson(rest));
  }
  throw new Error('unexpected ' + method + ' ' + url);
};

/* ---- 家庭の準備 ---- */
const consent = () => ({ version: S('2026-09-19.1'), mode: S('kazoku'), privacyAccepted: B(true), sensitiveAccepted: B(true), sharingAccepted: B(true), subjectBasis: S('explained-and-agreed'), acceptedAt: T(new Date()) });
for (const id of ['owner', 'fam', 'anon', 'solo']) put('consents/' + id, consent());
put('groups/g1', { createdBy: S('owner') });
put('groups/g2', { createdBy: S('anon') });
for (const id of ['owner', 'fam']) { put('groups/g1/members/' + id, { name: S(id), status: S('approved'), mode: S('kazoku') }); put('accounts/' + id, { groupId: S('g1') }); }
put('groups/g2/members/anon', { name: S('匿名さん'), status: S('approved'), mode: S('kazoku') });
put('accounts/anon', { groupId: S('g2') });
// 予定のお知らせ用の連携(ログインの根拠にはしない)
put('lineLinks/fam', { lineUserId: S('U' + 'f'.repeat(32)), groupId: S('g1'), linkedAt: T(new Date()) });

const acH = (extra) => ({ 'x-firebase-appcheck': appCheck(extra) });
/* ---- 再接続の準備: 家庭g1に、ご本人 hon を足す ---- */
authUsers.set('hon', {}); put('consents/hon', consent());
put('groups/g1/members/hon', { name: S('ほんにん'), status: S('approved'), role: S('honnin'), mode: S('honnin') });
put('accounts/hon', { groupId: S('g1') });
const later = (m) => T(new Date(Date.now() + m * 60000));
let seq = 0;
const newCode = (extra = {}) => {
  const c = ('RECNCT' + String(++seq).padStart(10, '2')).replace(/[01]/g, '2').replace(/[IO]/g, 'A').slice(0, 16);
  put('reconnectCodes/' + c, { groupId: S('g1'), targetUid: S('hon'), createdBy: S('owner'), createdAt: T(new Date()), expiresAt: later(10), ...extra });
  return c;
};
const rc = (body, headers = acH(), origin = APP) => worker.fetch(new Request('https://w.example/auth/reconnect', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, ...headers } }), base, {});
const parse = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const tokenUid = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).uid;

// 1. まいにこ以外のサイトからは呼べない・App Check がなければ断る・形のちがうコードは断る
{
  const c = newCode();
  assert.equal((await rc({ code: c }, acH(), 'https://evil.example')).status, 403);
  assert.equal((await parse(await rc({ code: c }, {}))).body.error, 'app-check');
  assert.equal((await parse(await rc({ code: 'short' }))).status, 400);
  assert.ok(db.has('reconnectCodes/' + c), '断ったときはコードを使わない');
  // LINEでログインが未設定(本番の今の状態)でも使える
  const r = await parse(await rc({ code: c }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(tokenUid(r.body.customToken), 'hon', 'ご本人と同じUIDに入る');
  assert.equal(r.body.uid, 'hon');
  assert.ok(!db.has('reconnectCodes/' + c), 'コードは使ったら消える');
  assert.equal(revoked.at(-1).localId, 'hon', '前のスマホのログインを無効にする');
  assert.ok(Math.abs(Number(revoked.at(-1).validSince) - now()) <= 2);
  // 2. 同じコードは2回使えない
  assert.equal((await parse(await rc({ code: c }))).body.error, 'used');
}
// 3. 期限切れは使えない(消す)
{
  const c = newCode({ expiresAt: T(new Date(Date.now() - 1000)) });
  assert.equal((await parse(await rc({ code: c }))).body.error, 'expired');
  assert.ok(!db.has('reconnectCodes/' + c));
}
// 4. 作った家族が承認済みでなくなった・相手がご本人でない・家庭が削除中・終了手続き中 → 入れない
{
  const tries = [
    ['作った家族が承認待ち', () => put('groups/g1/members/fam', { name: S('fam'), status: S('pending'), mode: S('kazoku') }), { createdBy: S('fam') },
      () => put('groups/g1/members/fam', { name: S('fam'), status: S('approved'), mode: S('kazoku') })],
    ['相手が家族(ご本人でない)', () => {}, { targetUid: S('fam') }, () => {}],
    ['作った人がご本人', () => {}, { createdBy: S('hon'), targetUid: S('hon') }, () => {}],
    ['家庭が削除中', () => put('groups/g1', { createdBy: S('owner'), deletionState: S('deleting') }), {}, () => put('groups/g1', { createdBy: S('owner') })],
    ['ご本人が終了手続き中', () => put('accountClosures/hon', { requestedAt: T(new Date()) }), {}, () => db.delete('accountClosures/hon')],
    ['作った家族が終了手続き中', () => put('accountClosures/owner', { requestedAt: T(new Date()) }), {}, () => db.delete('accountClosures/owner')],
    ['ご本人の認証が停止', () => authUsers.set('hon', { disabled: true }), {}, () => authUsers.set('hon', {})],
    ['別の家庭のコード', () => {}, { groupId: S('g2') }, () => {}],
  ];
  for (const [name, setup, extra, undo] of tries) {
    const c = newCode(extra); setup();
    const before = revoked.length;
    const r = await parse(await rc({ code: c }));
    undo();
    assert.ok(r.status >= 400 && !r.body.customToken, name + ' のときは入れない (' + r.status + ')');
    assert.equal(revoked.length, before, name + ' のときは前のログインも無効にしない');
  }
}
// 5. 確かめたあとに、家族がコードを取り消したら(確定の前)、入れない
{
  const c = newCode();
  hooks.onTxnRead = async (path) => { if (path === 'reconnectCodes/' + c) { db.delete(path); hooks.onTxnRead = null; } };
  const r = await parse(await rc({ code: c }));
  hooks.onTxnRead = null;
  assert.ok(!r.body.customToken, '取り消しが先なら入れない');
}
// 6. 確かめたあとに、家庭の削除が始まったら(確定の前)、入れない
{
  const c = newCode();
  hooks.onTxnRead = async (path) => { if (path === 'groups/g1') { put('groups/g1', { createdBy: S('owner'), deletionState: S('deleting') }); hooks.onTxnRead = null; } };
  const r = await parse(await rc({ code: c }));
  hooks.onTxnRead = null; put('groups/g1', { createdBy: S('owner') });
  assert.ok(!r.body.customToken, '削除が先なら入れない');
}
// 7. 前のログインを無効にできなかったら、トークンを出さない(コードは使ったことになる)
{
  const c = newCode(); revokeFail = true;
  const r = await parse(await rc({ code: c }));
  revokeFail = false;
  assert.equal(r.status, 503); assert.ok(!r.body.customToken);
}
// 8. 見回りで、期限切れのコードを片付ける
{
  const c = newCode({ expiresAt: T(new Date(Date.now() - 60000)) });
  await worker.scheduled({}, base, { waitUntil: () => {} });
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 20 && db.has('reconnectCodes/' + c); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!db.has('reconnectCodes/' + c), '期限切れのコードは見回りで消す');
}
// 9. LINEでログインをつないでいたら、なくしたスマホのLINEから入り直せないよう、つながりも外す(ほかの人のつながりは残す)
{
  put('lineLoginAccounts/hon', { lineKey: S('k-hon'), linkedAt: T(new Date()) });
  put('lineLoginLinks/k-hon', { uid: S('hon'), linkedAt: T(new Date()) });
  put('lineLoginAccounts/owner', { lineKey: S('k-owner'), linkedAt: T(new Date()) });
  put('lineLoginLinks/k-owner', { uid: S('owner'), linkedAt: T(new Date()) });
  const r = await parse(await rc({ code: newCode() }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lineLoginRemoved, true);
  assert.ok(!db.has('lineLoginAccounts/hon') && !db.has('lineLoginLinks/k-hon'), 'ご本人のつながりは外す');
  assert.ok(db.has('lineLoginAccounts/owner') && db.has('lineLoginLinks/k-owner'), 'ほかの家族のつながりは残す');
  const again = await parse(await rc({ code: newCode() }));
  assert.equal(again.body.lineLoginRemoved, false, 'つないでいなければ何もしない');
}
console.log('再接続QR(worker): まいにこの画面だけ・App Check・同じUID・1回だけ・前のログインを無効・期限・承認/ご本人/削除中/終了手続き/停止/別の家庭・確定前の取り消しと削除・無効化の失敗・片付け・LINEでログインのつながりを外す passed');
