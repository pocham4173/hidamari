/* LINEでログインの画面側(line-login.js・line-login-ui.js・household-ui.js の起動)の検査。
   本物の index.html の画面部品を使い、Firebaseと送信役は偽物に差し替える。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const core = require('../line-login.js');
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const html = read('index.html'), householdUi = read('household-ui.js'), coreSrc = read('line-login.js'), uiSrc = read('line-login-ui.js');
const scheduleSrc = html.slice(html.indexOf('/* LINE通知の行き先はURLに残し'), html.indexOf('/* ===== 画面遷移 ===== */'));
const BASE = 'https://mainico-line.example.workers.dev';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeToken = (uid) => b64u({ alg: 'RS256' }) + '.' + b64u({ uid, aud: 'x' }) + '.sig';
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) { if (check()) return; await wait(10); }
  assert.fail('timed out: ' + label);
}

/* ===== 1. 中身(line-login.js) ===== */
function memoryStorage() { const m = new Map(); return { m, getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function fakeServer() {
  const calls = [];
  const server = { calls, reply: {} };
  server.fetch = async (url, opt) => {
    const route = url.slice((BASE + '/auth/line/').length), body = JSON.parse(opt.body);
    calls.push({ route, body, headers: opt.headers, opt });
    const r = server.reply[route] ? server.reply[route](body) : { status: 200, data: {} };
    return { ok: r.status < 300, status: r.status, json: async () => r.data };
  };
  return server;
}
{
  assert.equal(core.create({ baseUrl: '', fetch: () => {}, storage: memoryStorage(), crypto: webcrypto }).enabled(), false, '未設定なら使わない');
  assert.equal(core.create({ baseUrl: 'http://insecure.example', fetch: () => {}, storage: memoryStorage(), crypto: webcrypto }).enabled(), false, 'httpsだけ');
  assert.deepEqual(core.readReturn('#line-auth=' + 'a'.repeat(32) + '&c=123456'), { tx: 'a'.repeat(32), code: '123456' });
  assert.deepEqual(core.readReturn('#line-auth=' + 'a'.repeat(32) + '&c=12x'), { tx: 'a'.repeat(32), code: '' });
  assert.equal(core.readReturn('#line-auth=../x&c=123456'), null);
  assert.equal(core.readReturn('#schedule=y1&group=g1'), null);
  assert.equal(core.tokenUid(fakeToken('うい')), 'うい');
  assert.equal(core.tokenUid('bad'), '');

  const server = fakeServer(), storage = memoryStorage();
  const svc = core.create({ baseUrl: BASE + '/', fetch: server.fetch, storage, crypto: webcrypto,
    getIdToken: async () => 'ID.TOKEN.X', getAppCheckToken: async () => 'AC.TOKEN.X' });
  const TX = 'b'.repeat(32);
  server.reply.start = () => ({ status: 200, data: { tx: TX, authorizeUrl: 'https://access.line.me/oauth2/v2.1/authorize?x=1', expiresAt: Date.now() + 600000 } });
  const started = await svc.startLogin({ returnHash: 'schedule=y1&group=g1', persist: true });
  assert.equal(started.tx, TX);
  const startCall = server.calls.at(-1);
  assert.equal(startCall.headers['x-firebase-appcheck'], 'AC.TOKEN.X', 'ログイン開始はApp Checkつき');
  assert.equal(startCall.headers.authorization, undefined, 'ログイン開始にFirebaseのトークンは送らない');
  assert.equal(startCall.opt.credentials, 'omit');
  const saved = JSON.parse(storage.getItem(core.KEY));
  assert.match(saved.secret, /^[0-9a-f]{64}$/);
  assert.notEqual(startCall.body.secretHash, saved.secret, '送るのは合言葉のハッシュだけ');
  assert.equal(startCall.body.secretHash, Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.secret))).toString('hex'));
  // 番号違いは手続きを残す・時間切れは消す
  server.reply.exchange = () => ({ status: 400, data: { error: 'wrong-code' } });
  await assert.rejects(svc.exchange('111111'), { code: 'wrong-code' });
  assert.ok(svc.pending('login'));
  await assert.rejects(svc.exchange('12'), { code: 'bad-code' });
  server.reply.exchange = (b) => (assert.equal(b.secret, saved.secret), { status: 200, data: { customToken: fakeToken('anon') } });
  const done = await svc.exchange('123456');
  assert.deepEqual({ uid: done.uid, returnHash: done.returnHash }, { uid: 'anon', returnHash: 'schedule=y1&group=g1' });
  assert.equal(storage.getItem(core.KEY), null, '使ったら消す');
  await assert.rejects(svc.exchange('123456'), { code: 'no-pending' });
  // つなぐ: Firebaseのトークンつき
  await svc.startLink({ uid: 'anon' });
  assert.equal(server.calls.at(-1).headers.authorization, 'Bearer ID.TOKEN.X');
  server.reply.confirm = () => ({ status: 409, data: { error: 'conflict' } });
  await assert.rejects(svc.confirmLink('123456'), { code: 'conflict' });
  assert.equal(svc.pending(), null, '上書きできない相手なら手続きを終える');
  // 期限切れの保存は読まない
  storage.setItem(core.KEY, JSON.stringify({ ...saved, exp: Date.now() - 1 }));
  assert.equal(svc.pending(), null);
  // 通信できないとき
  const offline = core.create({ baseUrl: BASE, fetch: async () => { throw new Error('x'); }, storage, crypto: webcrypto, getAppCheckToken: async () => '' });
  await assert.rejects(offline.startLogin({}), { code: 'network' });
  // 永続の保存ができないSafariでは始めない(戻ってきても続けられないため)
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const noStore = core.create({ baseUrl: BASE, fetch: server.fetch, storage: broken, crypto: webcrypto, getAppCheckToken: async () => '' });
  await assert.rejects(noStore.startLogin({ persist: true }), { code: 'storage' });
  // 取り消しの結果を区別し、確定するまで手続きを残す
  {
    const st = memoryStorage(), srv = fakeServer();
    const c = core.create({ baseUrl: BASE, fetch: srv.fetch, storage: st, crypto: webcrypto, getAppCheckToken: async () => '' });
    srv.reply.start = () => ({ status: 200, data: { tx: TX, authorizeUrl: 'https://access.line.me/x', expiresAt: Date.now() + 600000 } });
    await c.startLogin({ persist: true });
    for (const [reply, result, kept] of [
      [{ status: 200, data: { cancelled: false, status: 'retry' } }, 'retry', true],
      [{ status: 503, data: { error: 'server' } }, 'retry', true],
      [{ status: 200, data: { cancelled: false, status: 'done' } }, 'done', false],
    ]) {
      srv.reply.cancel = () => reply;
      assert.equal((await c.cancel()).result, result);
      assert.equal(!!c.pending(), kept, result);
      if (!kept) await c.startLogin({ persist: true });
    }
    srv.reply.cancel = () => ({ status: 200, data: { cancelled: false, status: 'expired' } });
    assert.equal((await c.cancel()).result, 'expired'); assert.equal(c.pending(), null);
    await c.startLogin({ persist: true });
    srv.reply.cancel = () => ({ status: 404, data: { error: 'not-found' } });
    assert.equal((await c.cancel()).result, 'expired');
    await c.startLogin({ persist: true });
    const off = core.create({ baseUrl: BASE, fetch: async () => { throw new Error('x'); }, storage: st, crypto: webcrypto, getAppCheckToken: async () => '' });
    assert.equal((await off.cancel()).result, 'unknown'); assert.ok(off.pending(), '通信できないときは手続きを残す');
    srv.reply.cancel = () => ({ status: 200, data: { cancelled: true, status: 'cancelled' } });
    assert.equal((await c.cancel()).result, 'cancelled'); assert.equal(c.pending(), null);
    assert.equal((await c.cancel()).result, 'none');
  }
  for (const code of ['wrong-code', 'not-linked', 'conflict', 'device-in-use', 'xxx']) assert.match(core.message({ code }), /[ぁ-ん]/);
  assert.match(core.message({ code: 'not-linked' }), /新しい登録はしていません/);
  console.log('line-login.js: 設定・戻り先・合言葉・App Check・一回限り・番号・期限・保存 passed');
}

/* ===== 2. 画面と起動(line-login-ui.js + household-ui.js) ===== */
function app({ hash = '', enabled = true, user = null, storage = {}, standalone = false, serverDocs = {} } = {}) {
  const dom = new JSDOM(html, { url: 'https://pocham4173.github.io/hidamari/' + hash, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, c = dom.getInternalVMContext();
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const state = { anon: 0, customTokens: [], boots: 0, started: 0, consentChoice: 0, server: fakeServer(), assigned: [] };
  const auth = { currentUser: user, languageCode: '',
    signInAnonymously: async () => { state.anon++; },
    signInWithCustomToken: async (t) => { state.customTokens.push(t); } };
  const docs = { ...serverDocs };
  const snap = (path) => ({ exists: path in docs, data: () => docs[path], metadata: { fromCache: false, hasPendingWrites: false } });
  const ref = (path) => ({ get: async () => snap(path), set: async (v) => { docs[path] = v; }, update: async () => {}, delete: async () => {},
    onSnapshot: () => () => {}, collection: (n) => ({ doc: (id) => ref(path + '/' + n + '/' + id) }) });
  const db = { collection: (n) => ({ doc: (id) => ref(n + '/' + id), where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) }) };
  Object.assign(c, {
    MAINICO_LINE_AUTH_URL: enabled ? BASE : '', auth, db, firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } },
    previewApp: { appCheck: () => ({ getToken: async () => ({ token: 'AC.TOKEN.X' }) }) },
    previewStorage: w.localStorage, fetch: state.server.fetch, TextEncoder,
    gid: () => w.localStorage.getItem('mainicoGid') || '', uid: () => auth.currentUser ? auth.currentUser.uid : '',
    grp: () => ref('groups/' + c.gid()), col: (n) => ({ doc: (id) => ref('groups/' + c.gid() + '/' + n + '/' + id), onSnapshot: () => () => {} }),
    showPage: (id) => { w.document.querySelectorAll('.page').forEach((p) => p.classList.remove('active')); w.document.getElementById(id).classList.add('active'); },
    startMode: () => { state.started++; }, showPending() {}, isKOnly: () => w.localStorage.getItem('mainicoMode') === 'kazoku' && w.localStorage.getItem('kazokuOnly') === '1',
    clearConsentSession() {}, ensureConsentForMode: async () => true, showConsentModeChoice: () => { state.consentChoice++; },
    isStandalone: () => standalone, appConfirm: async () => true, alert: () => {},
    showStartupProblem: (m) => { state.problem = m; }, MainicoRecovery: { message: (e) => String(e) },
    MainicoDeletion: { create: () => ({ getPending: () => null }) },
    memWatchUnsub: null, honninUnsub: null, yoteiUnsub: null, evUnsub: null, ytListUnsub: null, watchTagUnsub: null,
    medicineInfoUnsub: null, personHistoryUnsub: null, pendingUnsub: null, familyOnlyUnsubs: [], clockTimer: null,
  });
  Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
  c.window.MAINICO_LINE_AUTH_URL = c.MAINICO_LINE_AUTH_URL;
  vm.runInContext(coreSrc, c);
  vm.runInContext(uiSrc, c);
  c.lineNavigate = (u) => state.assigned.push(u);
  vm.runInContext(scheduleSrc, c);
  vm.runInContext(householdUi, c);
  vm.runInContext('window.bootHouseholdUser=bootHouseholdUser;', c);
  return { dom, w, c, auth, state, docs, doc: w.document };
}
const TX = 'c'.repeat(32), SECRET = 'd'.repeat(64);
const pendingLogin = (extra = {}) => JSON.stringify({ tx: TX, secret: SECRET, purpose: 'login', uid: '', returnHash: '', exp: Date.now() + 600000, ...extra });

// 2-1. 設定がないときは、これまで通り(自動で始める)
{
  const a = app({ enabled: false });
  await a.c.bootHouseholdUser(null);
  assert.equal(a.state.anon, 1);
  assert.equal(a.doc.getElementById('welcome').classList.contains('active'), false);
}
// 2-2. 設定があると、未ログインでは勝手に新規登録せず「すでに使っている方/はじめて使う」
{
  const a = app();
  assert.match(a.doc.getElementById('loading').textContent, /まいにこを開いています/);
  await a.c.bootHouseholdUser(null);
  assert.equal(a.state.anon, 0, '新しいアカウントを作らない');
  assert.ok(a.doc.getElementById('welcome').classList.contains('active'));
  assert.match(a.doc.getElementById('welcome').textContent, /すでに使っている方[\s\S]*LINEで続ける[\s\S]*はじめて使う/);
  assert.equal(a.doc.getElementById('loading').style.display, 'none');
  assert.equal(a.doc.getElementById('welcome-code').hidden, true);
  await a.c.startFirstUse();
  assert.equal(a.state.anon, 1, '「はじめて使う」を選んだときだけ登録');
  // LINEで続ける(Safari): 予定のリンクを覚えて、同じ画面のままLINEへ
  a.c.scheduleLink = { id: 'y1', group: 'g1' };
  vm.runInContext("scheduleLink={id:'y1',group:'g1'}", a.c);
  a.state.server.reply.start = () => ({ status: 200, data: { tx: TX, authorizeUrl: 'https://access.line.me/oauth2/v2.1/authorize?s=1', expiresAt: Date.now() + 600000 } });
  await a.c.lineLoginStart();
  assert.deepEqual(a.state.assigned, ['https://access.line.me/oauth2/v2.1/authorize?s=1'], a.doc.getElementById('welcome-state').textContent);
  const saved = JSON.parse(a.w.localStorage.getItem(core.KEY));
  assert.equal(saved.returnHash, 'schedule=y1&group=g1');
  a.dom.window.close();
}
// 2-3. LINEから戻った(同じ画面): 番号をアドレス欄から消し、まいにこを開いています → 同じUIDで入る → 予定へ
{
  const a = app({ hash: '#line-auth=' + TX + '&c=654321', storage: { [core.KEY]: pendingLogin({ returnHash: 'schedule=y9&group=g9' }) } });
  assert.equal(a.w.location.hash, '', '確認番号は、すぐにアドレス欄から消す');
  a.state.server.reply.exchange = (b) => { assert.equal(b.code, '654321'); assert.equal(b.secret, SECRET); return { status: 200, data: { customToken: fakeToken('anon') } }; };
  let hashChanged = 0;
  a.w.addEventListener('hashchange', () => hashChanged++);
  const took = a.c.bootHouseholdUser(null);
  assert.match(a.doc.getElementById('loading').textContent, /まいにこを開いています/);
  await took;
  assert.equal(a.state.anon, 0);
  assert.equal(a.state.customTokens.length, 1);
  assert.equal(a.doc.getElementById('welcome').classList.contains('active'), false, '入口や空の画面を先に出さない');
  assert.equal(a.doc.getElementById('entry').classList.contains('active'), false);
  assert.equal(a.w.location.hash, '#schedule=y9&group=g9', 'LINEのお知らせの予定を、ログインのあとに開く');
  assert.equal(hashChanged, 1);
  assert.equal(a.w.localStorage.getItem(core.KEY), null);
  a.dom.window.close();
}
// 2-4. 別の画面で始めた手続きの番号が来た: 何も変えず、元の画面に入れる番号として案内だけ
{
  const a = app({ hash: '#line-auth=' + 'e'.repeat(32) + '&c=111222' });
  await a.c.bootHouseholdUser(null);
  assert.equal(a.state.server.calls.length, 0, '合言葉のない画面は交換しない');
  assert.ok(a.doc.getElementById('welcome').classList.contains('active'));
  assert.ok(a.doc.getElementById('line-auth-modal').classList.contains('show'));
  assert.ok(!/111/.test(a.doc.getElementById('line-auth-body').textContent), '番号はもう一度表示しない');
  assert.match(a.doc.getElementById('line-auth-body').textContent, /誰にも伝えないでください/);
  a.dom.window.close();
}
// 2-5. 記録のある画面(別アカウント)は、LINEのアカウントに切り替えない
{
  const a = app({ hash: '#line-auth=' + TX + '&c=654321', user: { uid: 'other', getIdToken: async () => 'x' },
    storage: { [core.KEY]: pendingLogin(), mainicoGid: 'gx', mainicoMode: 'kazoku', mainicoModeChoiceV1: JSON.stringify(['other', 'gx', 'kazoku']) },
    serverDocs: { 'groups/gx/members/other': { status: 'approved', mode: 'kazoku' }, 'groups/gx': { createdBy: 'other' } } });
  a.state.server.reply.exchange = () => ({ status: 200, data: { customToken: fakeToken('anon') } });
  await a.c.bootHouseholdUser(a.auth.currentUser);
  assert.equal(a.state.customTokens.length, 0, '切り替えない');
  assert.equal(a.w.localStorage.getItem('mainicoGid'), 'gx', 'この画面の記録はそのまま');
  assert.equal(a.state.started, 1, 'いつもの画面を開く');
  assert.ok(a.doc.getElementById('line-auth-modal').classList.contains('show'), 'いつもの画面の上で知らせる');
  assert.match(a.doc.getElementById('line-auth-body').textContent, /別のアカウント/);
  a.dom.window.close();
}
// 2-5b. 交換を待つ間にログインが変わったら(別タブで既存アカウントに戻った等)、切り替えも保存情報の削除もしない
for (const [label, start] of [['未認証から', null], ['一時匿名から', { uid: 'tmp', getIdToken: async () => 'x' }]]) {
  const a = app({ hash: '#line-auth=' + TX + '&c=654321', user: start, storage: { [core.KEY]: pendingLogin(), mainicoSpeechOn: '0' } });
  a.state.server.reply.exchange = () => {
    // 交換の応答が届く前に、別タブで既存アカウント(家庭あり)に戻った
    a.auth.currentUser = { uid: 'owner', getIdToken: async () => 'y' };
    a.w.localStorage.setItem('mainicoGid', 'g-owner');
    vm.runInContext('householdBootGeneration++', a.c);
    return { status: 200, data: { customToken: fakeToken('anon') } };
  };
  const took = await vm.runInContext('lineAuthBeforeBoot', a.c)(start);
  assert.equal(took, false, label);
  assert.equal(a.state.customTokens.length, 0, label + ': LINE側アカウントに切り替えない');
  assert.equal(a.auth.currentUser.uid, 'owner', label);
  assert.equal(a.w.localStorage.getItem('mainicoGid'), 'g-owner', label + ': その時点の保存情報を残す');
  assert.equal(a.w.localStorage.getItem('mainicoSpeechOn'), '0', label + ': 保存情報を消さない');
  assert.match(vm.runInContext('lineLoginNotice', a.c), /切り替えを中止しました/, label);
  a.dom.window.close();
}
// 2-5c. 取り消し: 確定までは閉じない・手続きを残す・結果ごとに表示を分ける・やり直せる
{
  const open = (a) => { vm.runInContext("lineAuthFlow={purpose:'login',done:false}", a.c); a.doc.getElementById('line-auth-modal').classList.add('show'); };
  const body = (a) => a.doc.getElementById('line-auth-body').textContent;
  const shown = (a) => a.doc.getElementById('line-auth-modal').classList.contains('show');
  const pending = (a) => a.w.localStorage.getItem(core.KEY);
  // 競合(retry) → 閉じない・手続きを残す・「確認できませんでした」・やり直しで確定
  {
    const a = app({ user: { uid: 'anon', getIdToken: async () => 'x' }, storage: { [core.KEY]: pendingLogin() } });
    let n = 0;
    a.state.server.reply.cancel = () => (++n === 1 ? { status: 200, data: { cancelled: false, status: 'retry' } } : { status: 200, data: { cancelled: true, status: 'cancelled' } });
    open(a);
    await a.c.cancelLineAuth();
    assert.ok(shown(a), 'retry: 画面を閉じない');
    assert.ok(pending(a), 'retry: やり直しに必要な手続きを残す');
    assert.match(body(a), /取り消しを確認できませんでした/);
    assert.ok(!/取り消しました/.test(body(a)));
    const again = [...a.doc.querySelectorAll('#line-auth-body button')].find((b) => /もう一度取り消す/.test(b.textContent));
    assert.ok(again && [...a.doc.querySelectorAll('#line-auth-body button')].some((b) => /状態を確かめる/.test(b.textContent)));
    await a.c.cancelLineAuth();
    assert.equal(shown(a), false, '確定したら閉じる');
    assert.equal(pending(a), null, '確定したら手続きを消す');
    a.dom.window.close();
  }
  // 通信できず結果不明 → 閉じない・手続きを残す・状態を確かめられる
  {
    const a = app({ user: { uid: 'anon', getIdToken: async () => 'x' }, storage: { [core.KEY]: pendingLogin() } });
    a.c.fetch = async () => { throw new Error('offline'); };
    vm.runInContext('lineLoginSvc=null', a.c);
    open(a);
    await a.c.cancelLineAuth();
    assert.ok(shown(a), 'unknown: 画面を閉じない');
    assert.ok(pending(a), 'unknown: 手続きを残す');
    assert.match(body(a), /取り消しを確認できませんでした/);
    // 通信が戻ってから状態を確かめる → まだ有効なら、そう表示
    a.c.fetch = a.state.server.fetch; vm.runInContext('lineLoginSvc=null', a.c);
    a.state.server.reply.status = () => ({ status: 200, data: { purpose: 'login', status: 'ready' } });
    await a.c.checkLineAuthState(vm.runInContext('lineAuthFlow', a.c));
    assert.match(a.doc.getElementById('line-auth-state').textContent, /まだ有効です/);
    a.state.server.reply.status = () => ({ status: 200, data: { purpose: 'login', status: 'cancelled' } });
    await a.c.checkLineAuthState(vm.runInContext('lineAuthFlow', a.c));
    assert.equal(shown(a), false, '取り消し済みと分かったら閉じる');
    a.dom.window.close();
  }
  // 完了済み → 取り消せたように見せない
  for (const purpose of ['login', 'link']) {
    const a = app({ user: { uid: 'anon', getIdToken: async () => 'x' }, storage: { [core.KEY]: pendingLogin({ purpose, uid: 'anon' }) } });
    a.state.server.reply.cancel = () => ({ status: 200, data: { cancelled: false, status: 'done' } });
    vm.runInContext(`lineAuthFlow={purpose:'${purpose}',done:false}`, a.c);
    await a.c.cancelLineAuth();
    assert.ok(shown(a));
    assert.match(body(a), /完了していました/);
    assert.match(body(a), /取り消しはされていません/);
    assert.equal(pending(a), null);
    a.dom.window.close();
  }
  // 時間切れ・すでに終わっていた → その旨を表示
  {
    const a = app({ user: { uid: 'anon', getIdToken: async () => 'x' }, storage: { [core.KEY]: pendingLogin() } });
    a.state.server.reply.cancel = () => ({ status: 200, data: { cancelled: false, status: 'expired' } });
    open(a);
    await a.c.cancelLineAuth();
    assert.match(body(a), /時間切れなどで/);
    assert.equal(pending(a), null);
    a.dom.window.close();
  }
}
// 2-6. 記録のない一時的な匿名アカウントの画面からは、つないだアカウントに入れる(そのUIDは使わない)
{
  const a = app({ hash: '#line-auth=' + TX + '&c=654321', user: { uid: 'tmp', getIdToken: async () => 'x' }, storage: { [core.KEY]: pendingLogin() } });
  a.state.server.reply.exchange = () => ({ status: 200, data: { customToken: fakeToken('anon') } });
  await a.c.bootHouseholdUser(a.auth.currentUser);
  assert.equal(a.state.customTokens.length, 1);
  assert.equal(a.state.started, 0, '一時的な入口を先に出さない');
  a.dom.window.close();
}
// 2-7. はじめて開く画面(Safari)でも、サーバーの利用方法で開き、使い方の選び直しをさせない
for (const mode of ['honnin', 'kazoku', 'konly']) {
  const a = app({ user: { uid: 'anon', getIdToken: async () => 'x' },
    serverDocs: { 'accounts/anon': { groupId: 'g2' }, 'groups/g2/members/anon': { status: 'approved', mode, name: '匿名さん' }, 'groups/g2': { createdBy: 'owner' } } });
  await a.c.bootHouseholdUser(a.auth.currentUser);
  assert.equal(a.state.consentChoice, 0, mode + ': 使い方の選び直しをさせない');
  assert.equal(a.state.started, 1, mode);
  assert.equal(a.w.localStorage.getItem('mainicoGid'), 'g2');
  assert.equal(a.w.localStorage.getItem('mainicoMode'), mode === 'honnin' ? 'honnin' : 'kazoku');
  assert.equal(a.w.localStorage.getItem('kazokuOnly'), mode === 'konly' ? '1' : '');
  assert.equal(a.w.localStorage.getItem('mainicoModeChoiceV1'), JSON.stringify(['anon', 'g2', mode]));
  a.dom.window.close();
}
// 2-7b. サーバーに利用方法がない旧データは、推測せずに選んでもらう
{
  const a = app({ user: { uid: 'anon', getIdToken: async () => 'x' },
    serverDocs: { 'accounts/anon': { groupId: 'g2' }, 'groups/g2/members/anon': { status: 'approved' }, 'groups/g2': { createdBy: 'owner' } } });
  await a.c.bootHouseholdUser(a.auth.currentUser);
  assert.equal(a.state.consentChoice, 1);
  a.dom.window.close();
}
// 2-8. つなぐ(元の認証済み画面): 説明 → 開始 → 番号 → 確定。別アカウントになった画面では確定しない
{
  const a = app({ user: { uid: 'anon', getIdToken: async () => 'ID.T.X', providerData: [] },
    storage: { mainicoGid: 'g2', mainicoMode: 'kazoku', mainicoModeChoiceV1: JSON.stringify(['anon', 'g2', 'kazoku']) },
    serverDocs: { 'groups/g2/members/anon': { status: 'approved', mode: 'kazoku' }, 'groups/g2': { createdBy: 'anon' } } });
  await a.c.renderLineLoginSettings('settings-line-login-area');
  assert.match(a.doc.getElementById('settings-line-login-area').textContent, /LINEとつなぐ/);
  a.c.openLineLink('');
  const body = () => a.doc.getElementById('line-auth-body').textContent;
  assert.match(body(), /記録・家族・役割は、そのまま/);
  assert.match(body(), /予定のお知らせ（LINEで予定のお知らせ）とは別/);
  a.state.server.reply.start = () => ({ status: 200, data: { tx: TX, authorizeUrl: 'https://access.line.me/oauth2/v2.1/authorize?l=1', expiresAt: Date.now() + 600000 } });
  a.state.server.reply.status = () => ({ status: 200, data: { purpose: 'link', status: 'ready', lineName: '<b>りえ</b>' } });
  a.doc.getElementById('line-auth-start').click();
  await waitFor(() => a.doc.querySelector('#line-auth-body a'), 'LINEを開くボタン');
  const open = a.doc.querySelector('#line-auth-body a');
  assert.equal(open.href, 'https://access.line.me/oauth2/v2.1/authorize?l=1');
  assert.equal(open.target, '_blank', 'この画面を残したままLINEを開く');
  await waitFor(() => /確認したLINE/.test(body()), '確認したLINEの表示');
  assert.match(body(), /確認したLINE：<b>りえ<\/b>/, body());
  assert.equal(a.doc.querySelector('#line-auth-body b'), null);
  a.state.server.reply.confirm = (b) => { assert.equal(b.code, '123456'); return { status: 200, data: { linked: true } }; };
  a.doc.getElementById('line-auth-code').value = '１２３ ４５６';
  await a.c.submitLineAuthCode(vm.runInContext('lineAuthFlow', a.c));
  assert.equal(a.state.server.calls.at(-1).headers.authorization, 'Bearer ID.T.X');
  assert.match(a.doc.getElementById('line-auth-state').textContent, /つなぎました/);
  a.c.closeLineAuth();
  // 連携済みの表示: 解除はお知らせの解除と別・今の画面はそのまま・ほかの戻り方
  a.docs['lineLoginAccounts/anon'] = { lineKey: 'k', linkedAt: { toDate: () => new Date(2026, 9, 1) } };
  await a.c.renderLineLoginSettings('settings-line-login-area');
  const area = a.doc.getElementById('settings-line-login-area').textContent;
  assert.match(area, /10月1日から/);
  assert.match(area, /予定のお知らせ（LINEで予定のお知らせ）は止まりません/);
  assert.match(area, /そのまま使えます/);
  assert.match(area, /メールとパスワード/);
  let asked = '';
  a.c.appConfirm = async (t) => { asked = t; return true; };
  a.state.server.reply.unlink = () => ({ status: 200, data: { unlinked: true } });
  delete a.docs['lineLoginAccounts/anon'];
  await a.c.unlinkLineLogin('settings-line-login-area', a.doc.querySelector('#settings-line-login-area .warn'));
  assert.match(asked, /復旧用のメールとパスワードがまだ設定されていません/);
  assert.equal(a.state.server.calls.at(-1).route, 'unlink');
  assert.match(a.doc.getElementById('settings-line-login-area').textContent, /LINEとつなぐ/);
  a.dom.window.close();
}
// 2-9. つなぐ途中で同じ画面に戻った(Safariで始めた場合): 番号を入れた状態で確認画面を出す
{
  const a = app({ hash: '#line-auth=' + TX + '&c=246810', user: { uid: 'anon', getIdToken: async () => 'x' },
    storage: { [core.KEY]: JSON.stringify({ tx: TX, secret: SECRET, purpose: 'link', uid: 'anon', exp: Date.now() + 600000 }),
      mainicoGid: 'g2', mainicoMode: 'kazoku', mainicoModeChoiceV1: JSON.stringify(['anon', 'g2', 'kazoku']) },
    serverDocs: { 'groups/g2/members/anon': { status: 'approved', mode: 'kazoku' }, 'groups/g2': { createdBy: 'anon' } } });
  a.state.server.reply.status = () => ({ status: 200, data: { purpose: 'link', status: 'ready', lineName: 'りえ' } });
  await a.c.bootHouseholdUser(a.auth.currentUser);
  assert.equal(a.state.started, 1);
  assert.ok(a.doc.getElementById('line-auth-modal').classList.contains('show'));
  assert.equal(a.doc.getElementById('line-auth-code').value, '246810');
  assert.equal(a.state.server.calls.filter((x) => x.route === 'confirm').length, 0, '確定は利用者が押したときだけ');
  a.c.closeLineAuth();
  await wait(20);
  a.dom.window.close();
}
// 2-10. 入口(記録のない画面)にも「すでに使っている方」を出す。記録のある画面では出さない
{
  const page = html.slice(html.indexOf('function showPage(id){'), html.indexOf('/* ===== モード選択→同意→名前→接続 ===== */'));
  const a = app();
  a.w.scrollTo = () => {};
  vm.runInContext(page.replace('function resetFamilyScroll', 'function _unused'), a.c);
  a.c.showPage('entry');
  assert.equal(a.doc.getElementById('entry-line-login').hidden, false);
  a.w.localStorage.setItem('mainicoGid', 'g1');
  a.c.showPage('entry');
  assert.equal(a.doc.getElementById('entry-line-login').hidden, true);
  a.dom.window.close();
}
console.log('LINEでログインの画面: 未設定・入口の区別・同じ画面で戻る・別の画面の番号・切り替え防止・利用方法の復元・つなぐ・解除 passed');
