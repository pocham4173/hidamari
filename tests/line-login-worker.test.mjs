/* LINEでログイン(worker.js /auth/line/〜)の模擬テスト。
   LINE・Google(Firebase認証/App Check)・Firestoreを偽物に差し替えて、
   つなぐ・ログイン・取り消し・期限・重複・他人のLINE・不正な交換・解除を確かめる。 */
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
const calls = [], queries = [], txns = new Map(), hooks = {};
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

/* ---- 呼び出しの部品 ---- */
const api = (route, body, headers = {}, origin = APP) => worker.fetch(new Request('https://w.example/auth/line/' + route, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, ...headers } }), env, {});
const authH = (uid, extra) => ({ authorization: 'Bearer ' + idToken(uid, extra) });
const acH = (extra) => ({ 'x-firebase-appcheck': appCheck(extra) });
const hex = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('hex');
const sha = async (v) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))).toString('hex');
async function begin(purpose, headers) {
  const secret = hex(32);
  const res = await api('start', { purpose, secretHash: await sha(secret) }, headers);
  const data = await res.json();
  return { res, data, secret };
}
let lineSeq = 0;
async function lineLogin(authorizeUrl, sub, name = 'LINEの名前', claims) {
  const q = new URL(authorizeUrl).searchParams;
  const code = 'lc' + (++lineSeq);
  lineCodes.set(code, { sub, name, nonce: q.get('nonce'), challenge: q.get('code_challenge'), claims });
  const res = await worker.fetch(new Request('https://w.example/auth/line/callback?code=' + code + '&state=' + q.get('state')), env, {});
  const html = await res.text();
  const m = /class="code"[^>]*>(\d{3}) (\d{3})</.exec(html);
  return { res, html, code: m ? m[1] + m[2] : '', state: q.get('state'), q };
}
const LINE_A = 'U' + 'a'.repeat(32), LINE_B = 'U' + 'b'.repeat(32), LINE_F = 'U' + 'f'.repeat(32);
const loginLinks = () => [...db.keys()].filter((p) => p.startsWith('lineLoginLinks/') || p.startsWith('lineLoginAccounts/'));

/* 0. 未設定ならログインだけ準備中(お知らせ用の表示は今まで通り) */
{
  const res = await worker.fetch(new Request('https://w.example/auth/line/start', { method: 'POST', body: '{}', headers: { origin: APP } }), base, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not-configured');
  const top = await (await worker.fetch(new Request('https://w.example/'), base, {})).text();
  assert.match(top, /LINEでログイン：準備中/);
  assert.match(await (await worker.fetch(new Request('https://w.example/'), env, {})).text(), /LINEでログイン：設定済み/);
}
/* 1. まいにこ以外のサイトからは呼べない・CORSはまいにこだけ */
assert.equal((await api('start', { purpose: 'login' }, acH(), 'https://evil.example')).status, 403);
{
  const pre = await worker.fetch(new Request('https://w.example/auth/line/start', { method: 'OPTIONS', headers: { origin: APP } }), env, {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), APP);
}

/* 2. つなぐ: Firebaseの確認がなければ始められない・家庭のないアカウントも不可 */
assert.equal((await begin('link', {})).res.status, 401);
assert.equal((await begin('link', { authorization: 'Bearer abc.def.ghi' })).res.status, 401);
assert.equal((await begin('link', authH('owner', { aud: 'other' }))).res.status, 401, '別のプロジェクトのトークン');
assert.equal((await begin('link', authH('owner', { exp: now() - 5 }))).res.status, 401, '期限切れのトークン');
assert.equal((await begin('link', authH('solo'))).res.status, 403, '家庭に参加していない');
authUsers.set('owner', { validSince: String(now() + 100) });
assert.equal((await begin('link', authH('owner'))).res.status, 403, '失効させたトークン');
authUsers.set('owner', {});

/* 3. 既存の匿名利用者が、同じUIDのままLINEとつなぐ */
{
  const { data, secret } = await begin('link', authH('anon'));
  assert.match(data.tx, /^[0-9a-f]{32}$/);
  const q = new URL(data.authorizeUrl).searchParams;
  assert.equal(new URL(data.authorizeUrl).origin + new URL(data.authorizeUrl).pathname, 'https://access.line.me/oauth2/v2.1/authorize');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('redirect_uri'), env.LINE_LOGIN_CALLBACK_URL);
  assert.equal(q.get('client_id'), env.LINE_LOGIN_CHANNEL_ID);
  assert.match(q.get('scope'), /openid/);
  assert.ok(!data.authorizeUrl.includes(secret), '合言葉はURLに載せない');
  const tx = db.get('lineAuthTx/' + data.tx).fields;
  assert.notEqual(tx.secretHash.stringValue, secret, '合言葉はハッシュだけ保存');
  // 待っている間の状態
  let st = await (await api('status', { tx: data.tx, secret }, authH('anon'))).json();
  assert.equal(st.status, 'waiting');
  assert.equal((await api('status', { tx: data.tx, secret }, authH('owner'))).status, 403, '別のアカウントからは見られない');
  assert.equal((await api('status', { tx: data.tx, secret: hex(32) }, authH('anon'))).status, 404, '合言葉が違う');
  // LINEで確認 → この画面にだけ確認番号
  const cb = await lineLogin(data.authorizeUrl, LINE_A, '匿名のLINE');
  assert.equal(cb.res.status, 200);
  assert.match(cb.code, /^\d{6}$/);
  assert.match(cb.html, /匿名のLINE/);
  assert.equal(cb.res.headers.get('cache-control'), 'no-store');
  assert.equal(cb.res.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(!/<script/i.test(cb.html), '戻り先ページにスクリプトは使わない');
  assert.ok(!/http-equiv="refresh"/.test(cb.html), 'つなぐときは自動で移動しない(元の画面で確定する)');
  assert.ok(!cb.html.includes(LINE_A), 'LINEの識別子はページに出さない');
  assert.ok(!JSON.stringify([...db.values()]).includes(LINE_A), 'LINEの識別子そのものは保存しない');
  assert.equal(loginLinks().length, 0, 'LINEで確認しただけでは、まだつながない');
  // 同じ戻り先をもう一度開いても使えない(state は一回限り)
  const again = await worker.fetch(new Request('https://w.example/auth/line/callback?code=lcx&state=' + cb.state), env, {});
  assert.equal(again.status, 409);
  st = await (await api('status', { tx: data.tx, secret }, authH('anon'))).json();
  assert.equal(st.status, 'ready');
  assert.equal(st.lineName, '匿名のLINE');
  // 番号違いは数えられる
  const wrong = await api('confirm', { tx: data.tx, secret, code: cb.code === '000000' ? '111111' : '000000' }, authH('anon'));
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'wrong-code');
  assert.equal(loginLinks().length, 0);
  // 別のアカウントは、番号を知っていても確定できない
  assert.equal((await api('confirm', { tx: data.tx, secret, code: cb.code }, authH('owner'))).status, 403);
  // 正しい組み合わせで確定
  const ok = await api('confirm', { tx: data.tx, secret, code: cb.code }, authH('anon'));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { linked: true });
  const key = await sha('line-user|' + LINE_A);
  assert.equal(db.get('lineLoginLinks/' + key).fields.uid.stringValue, 'anon');
  assert.equal(db.get('lineLoginAccounts/anon').fields.lineKey.stringValue, key);
  assert.equal(db.get('accounts/anon').fields.groupId.stringValue, 'g2', '家庭はそのまま');
  assert.equal(db.get('groups/g2/members/anon').fields.mode.stringValue, 'kazoku', '役割はそのまま');
  // 再送しても二重にならない
  assert.equal((await api('confirm', { tx: data.tx, secret, code: cb.code }, authH('anon'))).status, 410);
  assert.equal(loginLinks().length, 2);
}

/* 4. 番号を5回まちがえたら、その手続きは使えない */
{
  const { data, secret } = await begin('link', authH('owner'));
  const cb = await lineLogin(data.authorizeUrl, LINE_B);
  const bad = cb.code === '999999' ? '888888' : '999999';
  for (let i = 0; i < 4; i++) assert.equal((await api('confirm', { tx: data.tx, secret, code: bad }, authH('owner'))).status, 400);
  assert.equal((await api('confirm', { tx: data.tx, secret, code: bad }, authH('owner'))).status, 429);
  assert.equal((await api('confirm', { tx: data.tx, secret, code: cb.code }, authH('owner'))).status, 410, 'ロック後は正しい番号でも不可');
  assert.equal(loginLinks().length, 2);
}

/* 4b. 同時にたくさんの番号を送っても、比べた回数は必ず数えられる(試行回数の上限をすり抜けない) */
{
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  const guesses = Array.from({ length: 30 }, (_, i) => String(100000 + i)).filter((g) => g !== cb.code);
  const res = await Promise.all(guesses.map((code) => api('exchange', { tx: data.tx, secret, code }, acH())));
  const compared = res.filter((r) => r.status === 400 || r.status === 429).length;
  const attempts = Number(db.get('lineAuthTx/' + data.tx).fields.attempts.integerValue);
  assert.ok(compared <= attempts && attempts <= 5, `比べた回数(${compared})は記録された回数(${attempts})以下`);
  assert.ok(res.every((r) => [400, 409, 429].includes(r.status)));
}

/* 5. 他人(別UID)とつながっているLINEは、上書き・統合しない */
{
  const { data, secret } = await begin('link', authH('owner'));
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  assert.equal(cb.res.status, 409);
  assert.match(cb.html, /別のまいにこアカウント/);
  assert.equal((await (await api('status', { tx: data.tx, secret }, authH('owner'))).json()).status, 'conflict');
  assert.equal(db.get('lineLoginLinks/' + await sha('line-user|' + LINE_A)).fields.uid.stringValue, 'anon', '元のつながりのまま');
}
/* 5b. すでに別のLINEとつないだアカウントに、2つ目のLINEはつながない */
{
  const { data } = await begin('link', authH('anon'));
  const cb = await lineLogin(data.authorizeUrl, LINE_B);
  assert.equal(cb.res.status, 409);
  assert.match(cb.html, /別のLINEとつながっています/);
}

/* 6. LINEで続ける: App Checkがない呼び出しは受けない */
assert.equal((await begin('login', {})).res.status, 401);
assert.equal((await begin('login', acH({ sub: 'other-app' }))).res.status, 401);
assert.equal((await begin('login', acH({ exp: now() - 1 }))).res.status, 401);

/* 7. LINEで続ける: つないだLINEで、同じUIDのカスタムトークン(1回だけ) */
{
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  assert.equal(cb.res.status, 200);
  assert.ok(!/http-equiv="refresh"/.test(cb.html), '自動では移動しない(番号を見た本人が進む)');
  assert.match(cb.html, /href="https:\/\/pocham4173\.github\.io\/hidamari\/#line-auth=[0-9a-f]{32}&amp;c=\d{6}"/);
  assert.match(cb.html, /番号を入れた人は、あなたのまいにこに入れます/);
  assert.match(cb.html, /取り消す（ログインしない）/);
  assert.ok(!/eyJ/.test(cb.html), 'トークンを戻り先ページやURLに載せない');
  const st = await (await api('status', { tx: data.tx, secret }, acH())).json();
  assert.equal(st.status, 'ready');
  assert.equal(st.lineName, undefined);
  // 合言葉がない(別の端末で始めた人)は、確認番号を知っていても交換できない
  assert.equal((await api('exchange', { tx: data.tx, secret: hex(32), code: cb.code }, acH())).status, 404);
  // 合言葉だけでは交換できない(確認番号が必要)
  assert.equal((await api('exchange', { tx: data.tx, secret, code: cb.code === '123456' ? '654321' : '123456' }, acH())).status, 400);
  assert.equal((await api('exchange', { tx: data.tx, secret, code: cb.code }, {})).status, 401, 'App Checkが必要');
  const res = await api('exchange', { tx: data.tx, secret, code: cb.code }, acH());
  assert.equal(res.status, 200);
  const { customToken } = await res.json();
  const [h, p, s] = customToken.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.uid, 'anon', '既存のUIDのまま');
  assert.equal(claims.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
  assert.equal(claims.iss, SA.client_email);
  assert.ok(claims.exp - claims.iat <= 300);
  assert.ok(createVerify('RSA-SHA256').update(h + '.' + p).verify(sa.publicKey, Buffer.from(s, 'base64url')), 'サービスアカウントの鍵で署名');
  // 再送・二重交換はできない
  assert.equal((await api('exchange', { tx: data.tx, secret, code: cb.code }, acH())).status, 410);
  assert.equal(authUsers.size, 4, '新しいアカウントは作らない');
}

/* 8. つないでいないLINE: 新規登録はせず案内だけ。お知らせ用の連携だけではログインできない */
for (const sub of [LINE_B, LINE_F]) {
  const before = db.size;
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, sub);
  assert.match(cb.html, /まだつながっていません/);
  assert.match(cb.html, /新しい登録はしていません/);
  assert.equal(cb.code, '');
  assert.equal((await (await api('status', { tx: data.tx, secret }, acH())).json()).status, 'not-linked');
  assert.equal((await api('exchange', { tx: data.tx, secret, code: '123456' }, acH())).status, 410);
  assert.equal(db.size, before + 1, '手続きの記録以外は増えない');
}

/* 9. 削除済み・停止中・終了手続き中のアカウントには入れない */
for (const [label, setup, undo] of [
  ['停止', () => authUsers.set('anon', { disabled: true }), () => authUsers.set('anon', {})],
  ['削除', () => authUsers.delete('anon'), () => authUsers.set('anon', {})],
  ['終了手続き', () => put('accountClosures/anon', { requestedAt: T(new Date()) }), () => db.delete('accountClosures/anon')],
]) {
  setup();
  const { data } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  assert.equal(cb.res.status, 403, label);
  assert.match(cb.html, /いまはログインできません/, label);
  undo();
}
/* 9b. LINEで確認したあと、交換の前に停止・解除されたら交換できない */
{
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  authUsers.set('anon', { disabled: true });
  assert.equal((await api('exchange', { tx: data.tx, secret, code: cb.code }, acH())).status, 403);
  authUsers.set('anon', {});
}

/* 10. LINE側の確認の不正(nonce違い・別チャネル宛て・期限切れ・ES256の署名)を拒否 */
for (const [label, claims] of [['nonce', { nonce: 'x' }], ['aud', { aud: '999' }], ['exp', { exp: now() - 10 }], ['iss', { iss: 'https://evil.example' }]]) {
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A, 'n', claims);
  assert.equal(cb.res.status, 502, label);
  assert.equal((await (await api('status', { tx: data.tx, secret }, acH())).json()).status, 'error', label);
}
lineAlg = 'ES256';
{
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  assert.equal(cb.res.status, 200, 'ES256でも確認できる');
  assert.equal((await api('exchange', { tx: data.tx, secret, code: cb.code }, acH())).status, 200);
}
lineAlg = 'HS256';
/* 10b. 違う state・作り物の state は受け付けない */
{
  const { data } = await begin('login', acH());
  const q = new URL(data.authorizeUrl).searchParams;
  const forged = q.get('state').slice(0, 32) + '0'.repeat(32);
  assert.equal((await worker.fetch(new Request('https://w.example/auth/line/callback?code=a&state=' + forged), env, {})).status, 400);
  assert.equal((await worker.fetch(new Request('https://w.example/auth/line/callback?code=a&state=..%2F'), env, {})).status, 400);
}

/* 11. 取り消し・LINE側でのキャンセル・期限切れでは何も変えない */
{
  const before = loginLinks().length;
  const a = await begin('link', authH('owner'));
  assert.deepEqual(await (await api('cancel', { tx: a.data.tx, secret: a.secret })).json(), { cancelled: true, status: 'cancelled' });
  const cb = await lineLogin(a.data.authorizeUrl, LINE_B);
  assert.equal(cb.res.status, 409, '取り消したあとはLINEから戻っても進まない');
  const b = await begin('link', authH('owner'));
  const q = new URL(b.data.authorizeUrl).searchParams;
  const res = await worker.fetch(new Request('https://w.example/auth/line/callback?error=access_denied&state=' + q.get('state')), env, {});
  assert.match(await res.text(), /取り消しました/);
  const c = await begin('link', authH('owner'));
  const path = 'lineAuthTx/' + c.data.tx;
  db.get(path).fields.expiresAt = T(new Date(Date.now() - 1000));
  assert.equal((await lineLogin(c.data.authorizeUrl, LINE_B)).res.status, 410);
  assert.equal((await (await api('status', { tx: c.data.tx, secret: c.secret }, authH('owner'))).json()).status, 'expired');
  // LINEの確認ページの「取り消す」
  const d = await begin('link', authH('owner'));
  const dcb = await lineLogin(d.data.authorizeUrl, LINE_B);
  const form = new FormData(); form.set('tx', d.data.tx); form.set('c', dcb.code);
  const cancelled = await worker.fetch(new Request('https://w.example/auth/line/callback-cancel', { method: 'POST', body: form }), env, {});
  assert.match(await cancelled.text(), /取り消しました/);
  assert.equal((await api('confirm', { tx: d.data.tx, secret: d.secret, code: dcb.code }, authH('owner'))).status, 410);
  assert.equal(loginLinks().length, before, '取り消し・期限切れでは何も変わらない');
}

/* 12. 確定を同時に2回送っても1回分だけ */
{
  const { data, secret } = await begin('link', authH('owner'));
  const cb = await lineLogin(data.authorizeUrl, LINE_B);
  const results = await Promise.all([1, 2].map(() => api('confirm', { tx: data.tx, secret, code: cb.code }, authH('owner'))));
  assert.ok(results.some((r) => r.status === 200));
  assert.equal(loginLinks().length, 4);
  assert.equal(db.get('lineLoginLinks/' + await sha('line-user|' + LINE_B)).fields.uid.stringValue, 'owner');
}

/* 13. LINEでログインの解除: お知らせ用の連携は残す。解除後はLINEで入れない */
{
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_B);
  assert.equal((await api('unlink', {}, {})).status, 401);
  assert.deepEqual(await (await api('unlink', {}, authH('owner'))).json(), { unlinked: true });
  assert.equal(db.has('lineLoginAccounts/owner'), false);
  assert.equal(db.has('lineLoginLinks/' + await sha('line-user|' + LINE_B)), false);
  assert.ok(db.has('lineLinks/fam'), 'お知らせ用の連携は別');
  assert.equal((await api('exchange', { tx: data.tx, secret, code: cb.code }, acH())).status, 403, '解除前に始めた手続きでも入れない');
  assert.deepEqual(await (await api('unlink', {}, authH('owner'))).json(), { unlinked: true, already: true });
  assert.ok(db.has('lineLoginAccounts/anon'), '他の人のつながりはそのまま');
}

/* 13b. ログインの戻り先ページの「取り消す」で、その番号は使えなくなる */
{
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  const form = new FormData(); form.set('tx', data.tx); form.set('c', cb.code);
  const res = await worker.fetch(new Request('https://w.example/auth/line/callback-cancel', { method: 'POST', body: form }), env, {});
  assert.match(await res.text(), /この番号では、まいにこに入れません/);
  assert.equal((await api('exchange', { tx: data.tx, secret, code: cb.code }, acH())).status, 410);
}
/* 13c. 戻り先の処理中に取り消された手続きを、あとから書き戻さない */
{
  const { data, secret } = await begin('login', acH());
  const q = new URL(data.authorizeUrl).searchParams;
  lineCodes.set('race', { sub: LINE_A, name: 'n', nonce: q.get('nonce'), challenge: q.get('code_challenge') });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url) === 'https://api.line.me/oauth2/v2.1/token') await api('cancel', { tx: data.tx, secret });
    return origFetch(url, opt);
  };
  const res = await worker.fetch(new Request('https://w.example/auth/line/callback?code=race&state=' + q.get('state')), env, {});
  globalThis.fetch = origFetch;
  assert.equal(res.status, 409);
  assert.equal(db.get('lineAuthTx/' + data.tx).fields.status.stringValue, 'cancelled');
  assert.ok(!/class="code"/.test(await res.text()), '取り消した手続きの番号は出さない');
}
/* 13d. 途中で照会に失敗しても「待っています」のまま残さない */
{
  const { data, secret } = await begin('login', acH());
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => String(url).includes('accounts:lookup') ? new Response('{}', { status: 403 }) : origFetch(url, opt);
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  globalThis.fetch = origFetch;
  assert.equal(cb.res.status, 503);
  assert.equal((await (await api('status', { tx: data.tx, secret }, acH())).json()).status, 'error');
}

/* 14. 見回りで、削除済みアカウントのつながりを片付ける(1時間に1回) */
{
  authUsers.delete('anon');
  const RealDate = Date, fixed = Math.floor(Date.now() / 3600000) * 3600000 + 3600000;
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
  try { await worker.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setTimeout(r, 50)); }
  finally { globalThis.Date = RealDate; }
  assert.equal(db.has('lineLoginAccounts/anon'), false);
  assert.equal(db.has('lineLoginLinks/' + await sha('line-user|' + LINE_A)), false);
  authUsers.set('anon', {});
}
/* 14b. 削除済みアカウントに残ったつながりは、つなぎ直しのときにその場で片付ける(生きている相手は上書きしない) */
{
  const key = await sha('line-user|' + LINE_A);
  put('lineLoginLinks/' + key, { uid: S('gone'), linkedAt: T(new Date()) });
  put('lineLoginAccounts/gone', { lineKey: S(key), linkedAt: T(new Date()) });
  const { data, secret } = await begin('link', authH('anon'));
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  assert.equal(cb.res.status, 200);
  assert.equal(db.has('lineLoginAccounts/gone'), false);
  assert.equal((await api('confirm', { tx: data.tx, secret, code: cb.code }, authH('anon'))).status, 200);
  assert.equal(db.get('lineLoginLinks/' + key).fields.uid.stringValue, 'anon');
}

/* ===== 再審査(2026-10-02)の指摘への再発防止 ===== */
const loginReady = async () => {
  const { data, secret } = await begin('login', acH());
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  assert.equal(cb.res.status, 200);
  return { tx: data.tx, secret, code: cb.code };
};
const relinkAnon = async () => {
  const { data, secret } = await begin('link', authH('anon'));
  const cb = await lineLogin(data.authorizeUrl, LINE_A);
  assert.equal((await api('confirm', { tx: data.tx, secret, code: cb.code }, authH('anon'))).status, 200);
};
/* R1. 交換の確認のあとに解除が先に確定したら、交換は確定せずトークンも出さない */
{
  const r = await loginReady();
  let unlinked = false;
  hooks.onTxnRead = async (path) => {
    if (!unlinked && path.startsWith('lineLoginLinks/')) { unlinked = true; assert.equal((await api('unlink', {}, authH('anon'))).status, 200); }
  };
  const res = await api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, acH());
  hooks.onTxnRead = null;
  assert.ok(unlinked, '解除が交換の途中に入った');
  assert.equal(res.status, 403);
  const out = await res.json();
  assert.equal(out.customToken, undefined, 'トークンを出さない');
  assert.equal(out.error, 'not-linked');
  assert.equal(db.has('lineLoginAccounts/anon'), false);
  assert.equal(txns.size, 0, 'トランザクションを残さない');
  await relinkAnon();
}
/* R1b. 交換の確認のあとに終了手続きが始まったら、交換しない */
{
  const r = await loginReady();
  let closed = false;
  hooks.onTxnRead = async (path) => {
    if (!closed && path.startsWith('lineLoginLinks/')) { closed = true; put('accountClosures/anon', { requestedAt: T(new Date()) }); }
  };
  const res = await api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, acH());
  hooks.onTxnRead = null;
  db.delete('accountClosures/anon');
  assert.notEqual(res.status, 200);
  assert.equal((await res.json()).customToken, undefined);
}
/* R2. 取り消しと番号入力の競合: 取り消しが確定したときだけ成功と表示し、交換はできない */
{
  // 交換の途中(確認のあと)に、アプリから取り消し
  const r = await loginReady();
  let cancel;
  hooks.onTxnRead = async (path) => {
    if (!cancel && path.startsWith('lineAuthTx/')) cancel = await (await api('cancel', { tx: r.tx, secret: r.secret })).json();
  };
  const res = await api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, acH());
  hooks.onTxnRead = null;
  assert.deepEqual(cancel, { cancelled: true, status: 'cancelled' });
  assert.equal(res.status, 410);
  assert.equal((await res.json()).customToken, undefined, '取り消しが確定したあとはトークンを出さない');
  assert.equal(db.get('lineAuthTx/' + r.tx).fields.status.stringValue, 'cancelled');
}
{
  // 交換が先に完了していたら、取り消しは「完了済み」と実際の状態を返す
  const r = await loginReady();
  assert.equal((await api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, acH())).status, 200);
  assert.deepEqual(await (await api('cancel', { tx: r.tx, secret: r.secret })).json(), { cancelled: false, status: 'done' });
}
{
  // 取り消しの書き込みが競合しても、読み直してやり直す(成功と表示したのに有効なまま、にならない)
  const r = await loginReady();
  const real = globalThis.fetch;
  let bumped = false;
  globalThis.fetch = async (url, opt) => {
    if (!bumped && opt && String(url).endsWith(':commit') && /"stringValue":"cancelled"/.test(opt.body) && opt.body.includes('/lineAuthTx/' + r.tx)) {
      bumped = true; const d = db.get('lineAuthTx/' + r.tx); put('lineAuthTx/' + r.tx, d.fields);   // 別処理が先に更新
    }
    return real(url, opt);
  };
  const out = await (await api('cancel', { tx: r.tx, secret: r.secret })).json();
  globalThis.fetch = real;
  assert.ok(bumped);
  assert.deepEqual(out, { cancelled: true, status: 'cancelled' });
  assert.equal(db.get('lineAuthTx/' + r.tx).fields.status.stringValue, 'cancelled');
  assert.equal((await api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, acH())).status, 410);
}
const callbackCancel = async (tx, c) => {
  const form = new FormData(); form.set('tx', tx); form.set('c', c);
  return worker.fetch(new Request('https://w.example/auth/line/callback-cancel', { method: 'POST', body: form }), env, {});
};
{
  // LINEの戻り先ページの「取り消す」: 交換の途中なら取り消しが勝ち、交換はできない
  const r = await loginReady();
  let page;
  hooks.onTxnRead = async (path) => { if (!page && path.startsWith('lineAuthTx/')) page = await (await callbackCancel(r.tx, r.code)).text(); };
  const res = await api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, acH());
  hooks.onTxnRead = null;
  assert.match(page, /取り消しました/);
  assert.equal(res.status, 410);
}
{
  // 交換が先に完了していたら、戻り先ページは「完了していました」と表示する(取り消したとは表示しない)
  const r = await loginReady();
  assert.equal((await api('exchange', { tx: r.tx, secret: r.secret, code: r.code }, acH())).status, 200);
  const html = await (await callbackCancel(r.tx, r.code)).text();
  assert.ok(!/取り消しました/.test(html), html);
  assert.match(html, /完了していました/);
  assert.match(html, /取り消しはされていません/);
  assert.ok(!/記録や設定は変わっていません/.test(html), '完了済みなのに「変わっていません」とは表示しない');
  // 番号が違えば、終わった手続きの状態は伝えない
  assert.match(await (await callbackCancel(r.tx, r.code === '000000' ? '111111' : '000000')).text(), /すでに使えなくなっています/);
}
{
  // つなぐ手続きの完了後に戻り先ページで取り消し
  const { data, secret } = await begin('link', authH('owner'));
  const cb = await lineLogin(data.authorizeUrl, LINE_F);
  assert.equal((await api('confirm', { tx: data.tx, secret, code: cb.code }, authH('owner'))).status, 200);
  const html = await (await callbackCancel(data.tx, cb.code)).text();
  assert.match(html, /つなぐ手続きが完了していました/);
  assert.ok(!/記録や設定は変わっていません/.test(html));
  assert.equal((await api('unlink', {}, authH('owner'))).status, 200);
}
{
  // すでに取り消した手続きをもう一度取り消す → 「すでに取り消されています」
  const r = await loginReady();
  assert.match(await (await callbackCancel(r.tx, r.code)).text(), /取り消しました/);
  assert.match(await (await callbackCancel(r.tx, r.code)).text(), /すでに取り消されています/);
}
/* R3. 失効・停止の確認(auth_time で判定・解除でも省かない) */
{
  authUsers.set('anon', { validSince: String(now() - 500) });
  const revoked = authH('anon', { auth_time: now() - 1000, iat: now() - 10 });   // auth_time < validSince < iat
  assert.equal((await begin('link', revoked)).res.status, 403, 'iat が新しくても auth_time が古ければ失効');
  assert.equal((await api('unlink', {}, revoked)).status, 403, '失効済みのトークンでは解除できない');
  assert.ok(db.has('lineLoginAccounts/anon'));
  assert.equal((await begin('link', authH('anon', { auth_time: now() - 100 }))).res.status !== 403, true, '失効後に入り直したトークンは使える');
  authUsers.set('anon', { disabled: true });
  assert.equal((await api('unlink', {}, authH('anon'))).status, 403, '停止中のユーザーは解除できない');
  assert.ok(db.has('lineLoginAccounts/anon'));
  authUsers.delete('anon');
  assert.equal((await api('unlink', {}, authH('anon'))).status, 403, '削除済みのユーザーのトークンでは解除できない');
  authUsers.set('anon', {});
  // 終了手続き中でも、有効な認証なら解除(つながりを減らす操作)はできる
  put('accountClosures/anon', { requestedAt: T(new Date()) });
  assert.equal((await api('unlink', {}, authH('anon'))).status, 200);
  db.delete('accountClosures/anon');
  await relinkAnon();
}
/* R5. 期限切れの手続きは、TTLなしで、見回りの最初に決まった回数だけ消す(続きは次の回) */
{
  for (const k of [...db.keys()]) if (k.startsWith('lineAuthTx/')) db.delete(k);
  for (let i = 0; i < 25; i++) put('lineAuthTx/' + String(i).padStart(32, '0'), { status: S('done'), expiresAt: T(new Date(Date.now() - 60000 - i)) });
  const live = await loginReady();
  const count = () => [...db.keys()].filter((k) => k.startsWith('lineAuthTx/')).length;
  queries.length = 0;
  const before = calls.length;
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(queries[0], 'lineAuthTx', '通知より先に片付ける');
  assert.equal(count(), 6, '1回で20件まで(残り5件と有効な1件)');
  assert.ok(calls.slice(before).filter((u) => u.endsWith(':commit')).length >= 1);
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count(), 1, '次の回で残りを消す');
  assert.ok(db.has('lineAuthTx/' + live.tx), '有効な手続きは消さない');
  // 文書が残っていても、期限切れは拒否する
  db.get('lineAuthTx/' + live.tx).fields.expiresAt = T(new Date(Date.now() - 1000));
  assert.equal((await api('exchange', { tx: live.tx, secret: live.secret, code: live.code }, acH())).status, 410);
}

/* 15. 記録・応答に秘密の値を出さない */
{
  const dump = JSON.stringify([...db.entries()]);
  assert.ok(!dump.includes('login-secret') && !dump.includes('PRIVATE KEY'), '秘密の値は保存しない');
}
/* 試験環境(mainiko-line-staging)だけの上書き。本番の設定(上書きなし)では今までどおり */
{
  const STG = 'https://mainiko-line-staging.okm-co.workers.dev';
  const served = [];
  const stg = { ...env, MAINICO_APP_URL: STG + '/', LINE_LOGIN_APP_CHECK: 'off', ASSETS: { fetch: async (req) => { served.push(new URL(req.url).pathname); return new Response('asset'); } } };
  // 画面は同じWorkerの ASSETS から
  assert.equal(await (await worker.fetch(new Request(STG + '/'), stg, {})).text(), 'asset');
  assert.equal(await (await worker.fetch(new Request(STG + '/index.html'), stg, {})).text(), 'asset');
  assert.match(await (await worker.fetch(new Request(STG + '/__status'), stg, {})).text(), /LINEでログイン：設定済み/);
  assert.deepEqual(served, ['/', '/index.html']);
  // 呼び出し元は試験環境の画面だけ。本番の画面からは呼べない
  const call = (origin) => worker.fetch(new Request(STG + '/auth/line/start', { method: 'POST', body: JSON.stringify({ purpose: 'login', secretHash: 'a'.repeat(64) }), headers: { 'content-type': 'application/json', origin } }), stg, {});
  assert.equal((await call(APP)).status, 403);
  const ok = await call(STG);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), STG);
  // LINEから戻ったページのリンクも試験環境の画面へ
  const { authorizeUrl } = await ok.json();
  const q = new URL(authorizeUrl).searchParams;
  lineCodes.set('stg', { sub: LINE_A, name: 'n', nonce: q.get('nonce'), challenge: q.get('code_challenge') });
  const page = await (await worker.fetch(new Request(STG + '/auth/line/callback?code=stg&state=' + q.get('state')), stg, {})).text();
  assert.match(page, new RegExp('href="' + STG + '/#line-auth='));
  assert.ok(!page.includes('pocham4173.github.io'));
  // 形の正しくない上書きは使わない(本番の値に戻る)
  const bad = { ...env, MAINICO_APP_URL: 'http://evil.example/' };
  assert.equal((await worker.fetch(new Request('https://w.example/auth/line/start', { method: 'OPTIONS', headers: { origin: APP } }), bad, {})).headers.get('access-control-allow-origin'), APP);
  // 本番(ASSETS なし)の '/' は今までどおり状態の表示
  assert.match(await (await worker.fetch(new Request('https://w.example/'), env, {})).text(), /LINE送信役/);
}
console.log('LINEでログイン: 設定・送り元・つなぐ・番号・上書き防止・ログイン・未連携・停止/削除・LINE確認の不正・取り消し・期限・同時送信・解除・片付け passed');
