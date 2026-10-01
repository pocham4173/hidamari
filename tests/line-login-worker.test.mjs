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
const calls = [];
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
  if (rest === ':commit') {
    for (const w of body.writes) {
      const path = (w.delete || w.update.name).slice(ROOT.length + 1), pre = w.currentDocument;
      if (pre && ((pre.updateTime && db.get(path)?.updateTime !== pre.updateTime) || (pre.exists === false && db.has(path)))) return json({}, 409);
    }
    for (const w of body.writes) { const path = (w.delete || w.update.name).slice(ROOT.length + 1); if (w.delete) db.delete(path); else put(path, w.update.fields); }
    return json({});
  }
  if (rest.endsWith(':runQuery')) return json([{ readTime: 'x' }]);
  const method = opt.method || 'GET';
  if (method === 'GET' && rest.split('/').length % 2 === 1) {
    return json({ documents: [...db.keys()].filter((p) => p.split('/').slice(0, -1).join('/') === rest).map(docJson) });
  }
  if (method === 'GET') return db.has(rest) ? json(docJson(rest)) : json({ error: {} }, 404);
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
  assert.match(cb.html, /http-equiv="refresh" content="0;url=https:\/\/pocham4173\.github\.io\/hidamari\/#line-auth=[0-9a-f]{32}&amp;c=\d{6}"/);
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
  assert.deepEqual(await (await api('cancel', { tx: a.data.tx, secret: a.secret })).json(), { cancelled: true });
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

/* 14. 見回りで、削除済みアカウントのつながりを片付ける */
{
  authUsers.delete('anon');
  for (let i = 0; i < 3; i++) await worker.scheduled({}, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.has('lineLoginAccounts/anon'), false);
  assert.equal(db.has('lineLoginLinks/' + await sha('line-user|' + LINE_A)), false);
  authUsers.set('anon', {});
}

/* 15. 記録・応答に秘密の値を出さない */
{
  const dump = JSON.stringify([...db.entries()]);
  assert.ok(!dump.includes('login-secret') && !dump.includes('PRIVATE KEY'), '秘密の値は保存しない');
}
console.log('LINEでログイン: 設定・送り元・つなぐ・番号・上書き防止・ログイン・未連携・停止/削除・LINE確認の不正・取り消し・期限・同時送信・解除・片付け passed');
