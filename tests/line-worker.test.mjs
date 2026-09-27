/* LINE送信役(line-worker/worker.js)の模擬テスト。
   LINEとFirestoreを偽物に差し替えて、連携・解除・予定のお知らせを確かめる。 */
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync, createHmac } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const worker = (await import('../line-worker/worker.js')).default;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { project_id: 'demo', client_email: 'sa@demo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const env = { LINE_CHANNEL_SECRET: 'secret123', LINE_CHANNEL_ACCESS_TOKEN: 'tok', FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA) };
const ROOT = 'projects/demo/databases/(default)/documents';

/* ---- 偽Firestore ---- */
const db = new Map(); // path -> {fields(REST形式), updateTime}
let clock = 1;
const put = (path, fields) => db.set(path, { fields, updateTime: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString() });
const S = (v) => ({ stringValue: v }), T = (d) => ({ timestampValue: d.toISOString() });
const docJson = (path) => ({ name: ROOT + '/' + path, fields: db.get(path).fields, updateTime: db.get(path).updateTime });
const cmp = (a, b) => {
  if (a.timestampValue && b.timestampValue) return Date.parse(a.timestampValue) - Date.parse(b.timestampValue);
  if ('stringValue' in a && 'stringValue' in b) return a.stringValue < b.stringValue ? -1 : a.stringValue > b.stringValue ? 1 : 0;
  return NaN;
};
const pushes = [], replies = [], keys = [];
let pushFailure=false, lostResponse=false, requests=0;
const acceptedKeys=new Set();
globalThis.fetch = async (url, opt = {}) => {
  requests++;
  url = String(url);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const body = opt.body ? (typeof opt.body === 'string' && opt.body.startsWith('{') ? JSON.parse(opt.body) : opt.body) : null;
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'gtok', expires_in: 3600 });
  if (url === 'https://api.line.me/v2/bot/message/push') {
    keys.push(opt.headers['x-line-retry-key']);
    if(pushFailure) return json({},500);
    if(acceptedKeys.has(keys.at(-1))) return new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'accepted'}});
    acceptedKeys.add(keys.at(-1)); pushes.push(body);
    if(lostResponse) {lostResponse=false;throw new Error('lost response');}
    return json({});
  }
  if (url === 'https://api.line.me/v2/bot/message/reply') { replies.push(body); return json({}); }
  const base = 'https://firestore.googleapis.com/v1/' + ROOT;
  assert.ok(url.startsWith(base), url);
  assert.equal(opt.headers.authorization, 'Bearer gtok');
  const u = new URL(url);
  let rest = decodeURIComponent(u.pathname).slice(('/v1/' + ROOT).length).replace(/^\//, '');
  if (rest === ':commit') {
    for(const w of body.writes){
      const path=(w.delete||w.update.name).slice(ROOT.length+1), pre=w.currentDocument;
      if(pre && ((pre.updateTime && db.get(path)?.updateTime!==pre.updateTime) ||
        (pre.exists===false && db.has(path)))) return json({},409);
    }
    for(const w of body.writes){const path=(w.delete||w.update.name).slice(ROOT.length+1);
      if(w.delete)db.delete(path);else put(path,w.update.fields);}
    return json({});
  }
  if (rest.endsWith(':runQuery') || u.pathname.endsWith(':runQuery')) {
    rest = rest.replace(/:runQuery$/, '');
    const q = body.structuredQuery;
    const colPath = (rest ? rest + '/' : '') + q.from[0].collectionId;
    const f = q.where.fieldFilter;
    const out = [];
    for (const [p] of db) {
      const parts = p.split('/');
      if (parts.slice(0, -1).join('/') !== colPath) continue;
      const v = db.get(p).fields[f.field.fieldPath];
      if (!v || 'nullValue' in v) continue;
      const c = cmp(v, f.value);
      if ((f.op === 'EQUAL' && c === 0) || (f.op === 'LESS_THAN_OR_EQUAL' && c <= 0)) out.push({ document: docJson(p) });
    }
    if(q.orderBy)out.sort((a,b)=>cmp(a.document.fields[q.orderBy[0].field.fieldPath],b.document.fields[q.orderBy[0].field.fieldPath]));
    const limited=q.limit?out.slice(0,q.limit):out;
    return json(limited.length ? limited : [{readTime:'x'}]);
  }
  const method = opt.method || 'GET';
  const isCollection = rest.split('/').length % 2 === 1;
  if (method === 'GET' && isCollection) {
    const docs = [...db.keys()].filter((p) => p.split('/').slice(0, -1).join('/') === rest).map(docJson);
    return json({ documents: docs });
  }
  if (method === 'GET') return db.has(rest) ? json(docJson(rest)) : json({ error: {} }, 404);
  if (method === 'DELETE') { db.delete(rest); return json({}); }
  if (method === 'PATCH') {
    const pre = u.searchParams.get('currentDocument.updateTime');
    if (pre && (!db.has(rest) || db.get(rest).updateTime !== pre)) return json({ error: { status: 'FAILED_PRECONDITION' } }, 400);
    const mask = u.searchParams.getAll('updateMask.fieldPaths');
    const fields = mask.length ? { ...(db.get(rest)?.fields || {}), ...body.fields } : body.fields;
    put(rest, fields);
    return json(docJson(rest));
  }
  throw new Error('unexpected ' + method + ' ' + url);
};

const sign = (b) => createHmac('sha256', env.LINE_CHANNEL_SECRET).update(b).digest('base64');
async function hook(events, badSig) {
  const b = JSON.stringify({ events });
  return worker.fetch(new Request('https://w.example/line', { method: 'POST', body: b,
    headers: { 'x-line-signature': badSig ? 'AAAA' : sign(b) } }), env, {});
}
const user = (id) => ({ type: 'user', userId: id });

const consent=()=>({version:S('2026-09-19.1'),mode:S('kazoku'),privacyAccepted:{booleanValue:true},sensitiveAccepted:{booleanValue:true},sharingAccepted:{booleanValue:true},subjectBasis:S('explained-and-agreed'),acceptedAt:T(new Date())});
for(const id of ['owner','fam','wait'])put('consents/'+id,consent());
/* ---- 家庭の準備 ---- */
put('groups/g1', { createdBy: S('owner') });
put('groups/g1/members/owner', { name: S('理絵'), status: S('approved') });
put('groups/g1/members/fam', { name: S('ゆきこ'), status: S('approved') });
put('groups/g1/members/wait', { name: S('承認待ち'), status: S('pending') });
put('groups/g2', { createdBy: S('x'), deletionState: S('deleting') });

// 1. 署名が違う受付は拒否
assert.equal((await hook([], true)).status, 401);
// 2. LINEの接続確認(空のイベント)は200
assert.equal((await hook([])).status, 200);
// 3. 友だち追加 → 案内を返事
await hook([{ type: 'follow', replyToken: 'r1', source: user('Uowner') }]);
assert.match(replies.at(-1).messages[0].text, /8文字のコード/);
// 4. 正しいコードで連携(全角・小文字・空白でも受け付ける)
put('lineLinkCodes/ABCD2345', { uid: S('owner'), groupId: S('g1'), expiresAt: T(new Date(Date.now() + 5 * 60000)) });
await hook([{ type: 'message', replyToken: 'r2', source: user('Uowner'), message: { type: 'text', text: 'ａｂｃｄ ２３４５' } }]);
assert.match(replies.at(-1).messages[0].text, /理絵さん、LINE連携しました/);
assert.equal(db.get('lineLinks/owner').fields.lineUserId.stringValue, 'Uowner');
assert.equal(db.has('lineLinkCodes/ABCD2345'), false, '使ったコードは消える');
// 5. 期限切れのコードは連携しない
put('lineLinkCodes/EFGH6789', { uid: S('fam'), groupId: S('g1'), expiresAt: T(new Date(Date.now() - 1000)) });
await hook([{ type: 'message', replyToken: 'r3', source: user('Ufam'), message: { type: 'text', text: 'EFGH6789' } }]);
assert.match(replies.at(-1).messages[0].text, /有効期限/);
assert.equal(db.has('lineLinks/fam'), false);
// 6. 承認待ちの人のコードは連携しない
put('lineLinkCodes/WAKT2345', { uid: S('wait'), groupId: S('g1'), expiresAt: T(new Date(Date.now() + 60000)) });
await hook([{ type: 'message', replyToken: 'r4', source: user('Uwait'), message: { type: 'text', text: 'WAKT2345' } }]);
assert.match(replies.at(-1).messages[0].text, /承認されていない/);
assert.equal(db.has('lineLinks/wait'), false);
// 7. 家族も連携
put('lineLinkCodes/FAMM2345', { uid: S('fam'), groupId: S('g1'), expiresAt: T(new Date(Date.now() + 60000)) });
await hook([{ type: 'message', replyToken: 'r5', source: user('Ufam'), message: { type: 'text', text: 'famm2345' } }]);
assert.ok(db.has('lineLinks/fam'));
// 承認待ちの人の連携が(何かの理由で)残っていても送らない
put('lineLinks/wait', { lineUserId: S('Uwait'), groupId: S('g1') });
// 抜けた人の連携は片付けられる
put('lineLinks/gone', { lineUserId: S('Ugone'), groupId: S('g1') });

// 8. 見回り: 時刻を過ぎた予定だけ、連携した承認済みの人へ送る
const now = new Date();
const jst = new Date(now.getTime() + 9 * 3600000);
const tomorrow = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1));
const ds = tomorrow.toISOString().slice(0, 10);
put('groups/g1/yotei/y1', { kind: S('🏥'), date: S(ds), time: S('13:30'), label: S('通院'), place: S('上田市サントミューゼ'), uid: S('owner'), notifyAt: T(new Date(now.getTime() - 60000)) });
put('groups/g1/yotei/y2', { kind: S('📌'), date: S(ds), time: S(''), label: S('まだ先'), uid: S('fam'), notifyAt: T(new Date(now.getTime() + 3600000)) });
put('groups/g1/yotei/y3', { kind: S('📌'), date: S(ds), label: S('知らせない'), uid: S('fam'), notifyAt: { nullValue: null } });
put('groups/g1/yotei/yOld', { kind: S('📌'), date: S('2026-01-01'), label: S('古い'), uid: S('fam'), notifyAt: T(new Date(now.getTime() - 13 * 3600000)) });
put('groups/g2/yotei/yDel', { label: S('削除中の家庭'), date: S(ds), notifyAt: T(new Date(now.getTime() - 60000)) });
put('lineLinks/delHome', { lineUserId: S('Udel'), groupId: S('g2') });
put('lineLinks/noHome', { lineUserId: S('Uno'), groupId: S('gX') });
put('lineLinkCodes/OLDD2345', { uid: S('fam'), groupId: S('g1'), expiresAt: T(new Date(now.getTime() - 2 * 3600000)) });
let waiter;
await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } });
await waiter;
assert.equal(pushes.length, 2, '連携した承認済みの2人だけに1通ずつ');
assert.deepEqual(pushes.map((p) => p.to).sort(), ['Ufam', 'Uowner']);
const text = pushes[0].messages[0].text;
const wd = '日月火水木金土'.charAt(tomorrow.getUTCDay());
assert.equal(text, '📅 予定のお知らせ（まいにこ）\n明日 ' + (tomorrow.getUTCMonth() + 1) + '月' + tomorrow.getUTCDate() + '日（' + wd + '） 13:30\n📍 上田市サントミューゼ\n🏥 通院\n（登録：理絵）\n\nカレンダーでこの予定を確認する\nhttps://pocham4173.github.io/hidamari/?openExternalBrowser=1#schedule=y1&group=g1');
assert.ok('nullValue' in db.get('groups/g1/yotei/y1').fields.notifyAt, '送ったら印を付ける');
assert.ok(db.get('groups/g1/yotei/y1').fields.notifiedAt.timestampValue);
assert.ok(db.get('groups/g1/yotei/y2').fields.notifyAt.timestampValue, 'まだ先の予定はそのまま');
assert.ok('nullValue' in db.get('groups/g1/yotei/yOld').fields.notifyAt, '古すぎる予定は送らずに印だけ');
assert.ok(db.get('groups/g2/yotei/yDel').fields.notifyAt.timestampValue, '削除中の家庭には触れない');
assert.ok(!pushes.some(p=>p.to==='Ugone'),'家庭から抜けた人には送らない');
assert.ok(!pushes.some(p=>['Udel','Uno'].includes(p.to)),'削除された家庭には送らない');
// Cleanup is bounded and may run after pending notifications finish.
// 9. 2回目の見回りでは二重に送らない
await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } });
await waiter;
assert.equal(pushes.length, 2);
// 10. 「解除」と送ると連携解除
await hook([{ type: 'message', replyToken: 'r6', source: user('Ufam'), message: { type: 'text', text: '解除' } }]);
assert.match(replies.at(-1).messages[0].text, /解除しました/);
assert.equal(db.has('lineLinks/fam'), false);
// 11. ブロック(unfollow)でも連携解除
await hook([{ type: 'unfollow', source: user('Uowner') }]);
assert.equal(db.has('lineLinks/owner'), false);
// 12. 関係ない文は案内だけ返す
await hook([{ type: 'message', replyToken: 'r7', source: user('Ux'), message: { type: 'text', text: 'こんにちは' } }]);
assert.match(replies.at(-1).messages[0].text, /お返事や相談は届きません/);
// 13. 動作確認ページ
const res = await worker.fetch(new Request('https://w.example/'), env, {});
assert.equal(await res.text(), 'まいにこ LINE送信役は動いています');

console.log('line worker: 署名確認・友だち追加・連携(期限切れ/承認待ちは不可)・見回り送信(対象者/文面/二重送信なし/古い予定/削除中の家庭)・解除・ブロック 13項目 passed');

// Failure, consent withdrawal, closure, retries and request budget regressions.
async function tick(){requests=0;await worker.scheduled({},env,{waitUntil:p=>{waiter=p;}});await waiter;assert.ok(requests<=45,'strict request budget');}
function pending(id){put('groups/g1/yotei/'+id,{date:S(ds),label:S(id),uid:S('owner'),notifyAt:T(new Date(Date.now()-60000))});}
put('lineLinks/owner',{lineUserId:S('Uowner'),groupId:S('g1')});
put('consents/owner',consent());
pending('retry');pushFailure=true;const before=pushes.length;
await tick();assert.equal(pushes.length,before);assert.ok(db.get('groups/g1/yotei/retry').fields.notifyAt.timestampValue);
const retryKey=keys.at(-1);pushFailure=false;await tick();assert.equal(pushes.length,before+1);assert.equal(keys.at(-1),retryKey);
assert.ok(db.get('groups/g1/yotei/retry').fields.notifiedAt.timestampValue);
pending('lost');lostResponse=true;await tick();const lostKey=keys.at(-1),afterLost=pushes.length;
await tick();assert.equal(keys.at(-1),lostKey);assert.equal(pushes.length,afterLost,'409 accepted does not duplicate');
assert.ok(db.get('groups/g1/yotei/lost').fields.notifiedAt.timestampValue);
pending('withdrawn');db.delete('consents/owner');await tick();assert.equal(pushes.length,afterLost);
assert.ok(db.get('groups/g1/yotei/withdrawn').fields.notifyAt.timestampValue);
put('consents/owner',consent());put('accountClosures/owner',{requestedAt:T(new Date())});
put('lineLinks/owner',{lineUserId:S('Uowner'),groupId:S('g1')});await tick();assert.equal(pushes.length,afterLost,'closed account cannot receive');
assert.ok(!db.get('groups/g1/yotei/yOld').fields.notifiedAt?.timestampValue,'expired is not sent');
console.log('additional safety and retry regressions passed');
// One-time codes remain single-use even when two webhook requests overlap.
db.delete('accountClosures/owner');put('consents/owner',consent());
put('lineLinkCodes/RACE2345',{uid:S('owner'),groupId:S('g1'),expiresAt:T(new Date(Date.now()+60000))});
const previousReplies=replies.length;
await Promise.all(['Urace1','Urace2'].map(id=>hook([{type:'message',source:user(id),replyToken:id,message:{type:'text',text:'RACE2345'}}])));
assert.equal(replies.slice(previousReplies).filter(r=>r.messages[0].text.includes('LINE連携しました')).length,1);
// Several pending schedules exhaust the budget without losing the remainder.
for(let i=0;i<10;i++)pending('budget'+i);
await tick();assert.equal(requests,45);assert.ok([...db].some(([p,d])=>p.includes('/yotei/budget')&&d.fields.notifyAt.timestampValue));
console.log('atomic code consumption and budget exhaustion passed');
