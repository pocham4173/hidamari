
/* LINE送信役(worker.js)の模擬テスト。
   LINEとFirestoreを偽物に差し替えて、連携・解除・予定のお知らせを確かめる。 */
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync, createHmac } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const worker = (await import('../worker.js')).default;

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
  if ('booleanValue' in a && 'booleanValue' in b) return a.booleanValue === b.booleanValue ? 0 : 1;
  if ('stringValue' in a && 'stringValue' in b) return a.stringValue < b.stringValue ? -1 : a.stringValue > b.stringValue ? 1 : 0;
  return NaN;
};
const pushes = [], replies = [], keys = [];
let pushFailure=false, lostResponse=false, requests=0;
let quota={type:'limited',value:200}, usage=0;
const acceptedKeys=new Set();
globalThis.fetch = async (url, opt = {}) => {
  requests++;
  url = String(url);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const body = opt.body ? (typeof opt.body === 'string' && opt.body.startsWith('{') ? JSON.parse(opt.body) : opt.body) : null;
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'gtok', expires_in: 3600 });
  if (url === 'https://api.line.me/v2/bot/message/quota') return json(quota);
  if (url === 'https://api.line.me/v2/bot/message/quota/consumption') return json({ totalUsage: usage });
  if (url === 'https://api.line.me/v2/bot/message/push') {
    keys.push(opt.headers['x-line-retry-key']);
    if(pushFailure) return json({},500);
    if(acceptedKeys.has(keys.at(-1))) return new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'accepted'}});
    acceptedKeys.add(keys.at(-1)); pushes.push(body); usage++;
    if(lostResponse) {lostResponse=false;throw new Error('lost response');}
    return json({});
  }
  if (url === 'https://api.line.me/v2/bot/message/reply') { replies.push(body); return json({}); }
  if (url.startsWith('https://api.line.me/v2/bot/profile/')) return url.endsWith('/Unf') ? json({}, 404) : json({ displayName: 'おばあ' });
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
      if(w.delete)db.delete(path);
      else if(w.updateMask)put(path,{...(db.get(path)?.fields||{}),...w.update.fields});
      else put(path,w.update.fields);}
    return json({});
  }
  if (rest.endsWith(':runQuery') || u.pathname.endsWith(':runQuery')) {
    rest = rest.replace(/:runQuery$/, '');
    const q = body.structuredQuery;
    const colPath = (rest ? rest + '/' : '') + q.from[0].collectionId;
    const f = q.where && q.where.fieldFilter;
    const out = [];
    for (const [p] of db) {
      const parts = p.split('/');
      if (q.from[0].allDescendants) { if (parts[parts.length - 2] !== q.from[0].collectionId) continue; }
      else if (parts.slice(0, -1).join('/') !== colPath) continue;
      if (!f) { out.push({ document: docJson(p) }); continue; }
      const v = db.get(p).fields[f.field.fieldPath];
      if (!v || 'nullValue' in v) continue;
      const c = cmp(v, f.value);
      if ((f.op === 'EQUAL' && c === 0) || (f.op === 'LESS_THAN_OR_EQUAL' && c <= 0)) out.push({ document: docJson(p) });
    }
    if(q.orderBy){const o=q.orderBy[0],sg=o.direction==='DESCENDING'?-1:1;out.sort((a,b)=>sg*cmp(a.document.fields[o.field.fieldPath],b.document.fields[o.field.fieldPath]));}
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
    // 本物のFirestoreと同じく、更新対象に挙げたのに値のない項目は消す
    for (const m of mask) if (!(m in (body.fields || {}))) delete fields[m];
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
assert.match(replies.at(-1).messages[0].text, /LINEとつなぐ/);
// 4. 正しいコードで連携(全角・小文字・空白でも受け付ける)
put('lineLinkCodes/ABCD2345', { uid: S('owner'), groupId: S('g1'), expiresAt: T(new Date(Date.now() + 5 * 60000)) });
await hook([{ type: 'message', replyToken: 'r2', source: user('Uowner'), message: { type: 'text', text: 'ａｂｃｄ ２３４５' } }]);
assert.match(replies.at(-1).messages[0].text, /理絵さん、LINE連携しました/);
assert.equal(db.get('lineLinks/owner').fields.lineUserId.stringValue, 'Uowner');
assert.equal(db.has('lineLinkCodes/ABCD2345'), false, '使ったコードは消える');
const linkLogs = (action) => [...db].filter(([p, d]) => p.startsWith('groups/g1/events/') && d.fields.type?.stringValue === 'line-link-log' && d.fields.action.stringValue === action).map(([, d]) => d.fields);
assert.equal(linkLogs('linked').length, 1, '連携の記録が家庭に残る');
assert.equal(linkLogs('linked')[0].uid.stringValue, 'owner');
assert.equal(linkLogs('linked')[0].name.stringValue, '理絵');
assert.ok(!JSON.stringify(linkLogs('linked')[0]).includes('Uowner'), '記録にLINEの利用者識別子は入れない');
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
const y1log = db.get('groups/g1/yotei/y1').fields.notifyLog.arrayValue.values;
assert.equal(y1log.length, 1, '送信の記録が予定に残る');
assert.equal(y1log[0].mapValue.fields.status.stringValue, 'accepted');
assert.equal(y1log[0].mapValue.fields.count.integerValue, '2');
assert.equal(db.get('groups/g1/yotei/yOld').fields.notifyLog.arrayValue.values[0].mapValue.fields.status.stringValue, 'expired');
assert.ok(db.get('groups/g2/yotei/yDel').fields.notifyAt.timestampValue, '削除中の家庭には触れない');
assert.ok(!pushes.some(p=>p.to==='Ugone'),'家庭から抜けた人には送らない');
assert.ok(!pushes.some(p=>['Udel','Uno'].includes(p.to)),'削除された家庭には送らない');
// Cleanup is bounded and may run after pending notifications finish.
// 9. 2回目の見回りでは二重に送らない
await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } });
await waiter;
assert.equal(pushes.length, 2);
// 9b. おまもりタグが読み取られたら、LINE連携した承認済みの「家族」へ1回だけ知らせる(ご本人には送らない)
put('groups/g1/members/hon', { name: S('本人'), status: S('approved'), role: S('honnin'), mode: S('honnin') });
put('consents/hon', { ...consent(), mode: S('honnin'), subjectBasis: S('self') });
put('lineLinks/hon', { lineUserId: S('Uhon'), groupId: S('g1') });
put('watchTags/tagA', { groupId: S('g1'), active: { booleanValue: true } });
put('watchTags/tagA/alerts/reader1', { type: S('found'), situation: S('lost'), count: { integerValue: '1' }, senderUid: S('reader1'), createdAt: T(new Date(Date.now() - 60000)), lineNotifiedAt: T(new Date(Date.now() - 30000)) });
put('watchTags/tagOld/alerts/reader2', { type: S('found'), situation: S('unwell'), count: { integerValue: '1' }, senderUid: S('reader2'), createdAt: T(new Date(Date.now() - 3 * 3600000)) });
await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } });
await waiter;
const tagPushes = pushes.slice(2);
assert.deepEqual(tagPushes.map((p) => p.to).sort(), ['Ufam', 'Uowner'], 'タグのお知らせは連携した家族へ(ご本人には送らない)');
assert.match(tagPushes[0].messages[0].text, /おまもりタグのお知らせ/);
assert.match(tagPushes[0].messages[0].text, /道に迷っているようです/);
assert.ok(!tagPushes[0].messages[0].text.includes('reader1'), '読み取った方の情報は送らない');
assert.ok(!('lineNotifiedAt' in db.get('watchTags/tagA/alerts/reader1').fields), '読み取り者の文書には印を残さない(再送を妨げない)');
assert.ok([...db.keys()].some((p) => p.startsWith('tagAlertReceipts/')), '送った印は別の置き場に残す');
await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } });
await waiter;
assert.equal(pushes.length, 4, 'タグのお知らせを二重に送らない・古い読み取りは送らない');
// 同じ読み取り者が10分後に状況を送り直したら、もう一度知らせる
put('watchTags/tagA/alerts/reader1', { type: S('found'), situation: S('called'), count: { integerValue: '2' }, senderUid: S('reader1'), createdAt: T(new Date(Date.now() - 1000)) });
await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } });
await waiter;
assert.equal(pushes.length, 6, '送り直した状況も届く');
assert.match(pushes.at(-1).messages[0].text, /警察・救急へ連絡しました/);
db.delete('lineLinks/hon');
// 10. 「解除」と送ると連携解除
await hook([{ type: 'message', replyToken: 'r6', source: user('Ufam'), message: { type: 'text', text: '解除' } }]);
assert.match(replies.at(-1).messages[0].text, /解除しました/);
assert.equal(db.has('lineLinks/fam'), false);
assert.ok(linkLogs('unlinked').some((f) => f.uid.stringValue === 'fam' && f.via.stringValue === 'line'), '「解除」の記録が残る');
// 11. ブロック(unfollow)でも連携解除
await hook([{ type: 'unfollow', source: user('Uowner') }]);
assert.equal(db.has('lineLinks/owner'), false);
assert.ok(linkLogs('unlinked').some((f) => f.uid.stringValue === 'owner' && f.via.stringValue === 'block'), 'ブロックでの解除も記録が残る');
// 12. 関係ない文は案内だけ返す
await hook([{ type: 'message', replyToken: 'r7', source: user('Ux'), message: { type: 'text', text: 'こんにちは' } }]);
assert.match(replies.at(-1).messages[0].text, /お返事や相談は届きません/);
// 14. 家族が招待した送信先(2026-10-04): LINEで招待コードを送ると登録され、選ばれた予定だけが届く
{
  const inv = (code, rid, minutes) => put('lineInvites/' + code, { groupId: S('g1'), recipientId: S(rid), createdBy: S('owner'), expiresAt: T(new Date(Date.now() + minutes * 60000)) });
  put('lineRecipients/r1', { groupId: S('g1'), name: S('おばあちゃん'), status: S('pending'), createdBy: S('owner') });
  put('lineRecipients/r2', { groupId: S('g1'), name: S('おじさん'), status: S('pending'), createdBy: S('owner') });
  inv('KNVT234567', 'r1', 60);
  await hook([{ type: 'message', replyToken: 'i1', source: user('Ugrand'), message: { type: 'text', text: 'まいにこ招待 knvt234567' } }]);
  assert.match(replies.at(-1).messages[0].text, /理絵さんのまいにこの予定のお知らせを受け取る登録をしました/);
  assert.ok(!/友だち追加が必要/.test(replies.at(-1).messages[0].text));
  assert.equal(db.get('lineRecipients/r1').fields.status.stringValue, 'joined');
  assert.equal(db.get('lineRecipients/r1').fields.lineName.stringValue, 'おばあ');
  assert.equal(db.get('lineRecipients/r1').fields.name.stringValue, 'おばあちゃん', '名前はそのまま');
  assert.ok(!('lineUserId' in db.get('lineRecipients/r1').fields), '家族が読む文書にLINEの利用者識別子を置かない');
  assert.equal(db.get('lineRecipientIds/r1').fields.lineUserId.stringValue, 'Ugrand');
  assert.equal(db.has('lineInvites/KNVT234567'), false, '使った招待は消える');
  // 使った招待・期限切れ・登録済みの送信先への招待は受け付けない
  await hook([{ type: 'message', replyToken: 'i2', source: user('Uother'), message: { type: 'text', text: '招待KNVT234567' } }]);
  assert.match(replies.at(-1).messages[0].text, /見つからないか/);
  inv('XPRD234567', 'r2', -1);
  await hook([{ type: 'message', replyToken: 'i3', source: user('Uother'), message: { type: 'text', text: '招待XPRD234567' } }]);
  assert.match(replies.at(-1).messages[0].text, /有効期限/);
  assert.equal(db.get('lineRecipients/r2').fields.status.stringValue, 'pending');
  inv('AGNN234567', 'r1', 60);
  await hook([{ type: 'message', replyToken: 'i4', source: user('Uother'), message: { type: 'text', text: '招待AGNN234567' } }]);
  assert.match(replies.at(-1).messages[0].text, /もう登録が済んでいます/);
  assert.equal(db.get('lineRecipientIds/r1').fields.lineUserId.stringValue, 'Ugrand', '別の人に乗っ取られない');
  // 友だち追加していない人には、追加の案内を付ける
  inv('FRND234567', 'r2', 60);
  await hook([{ type: 'message', replyToken: 'i5', source: user('Unf'), message: { type: 'text', text: '招待FRND234567' } }]);
  assert.match(replies.at(-1).messages[0].text, /友だち追加が必要/);
  db.delete('lineRecipients/r2'); db.delete('lineRecipientIds/r2');

  // 送る相手: notifyTo なし=つないだ家族全員(送信先へは送らない)、'r:'=選んだ送信先、'u:'=選んだ家族
  put('lineLinks/fam', { lineUserId: S('Ufam'), groupId: S('g1') });
  // 予定を登録した家族が同意していないと、招待した送信先へは送らない
  {
    const b0 = pushes.length;
    put('groups/g1/yotei/yNoConsent', { kind: S('📌'), date: S(ds), label: S('同意なし'), uid: S('owner'), notifyAt: T(new Date(Date.now() - 60000)), notifyTo: { arrayValue: { values: [S('r:r1')] } } });
    await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } }); await waiter;
    assert.equal(pushes.length, b0, '同意のない家族の予定は、招待した送信先へ送らない');
    db.delete('groups/g1/yotei/yNoConsent');
  }
  put('groups/g1/lineShareConsents/owner', { version: S('line-share-20261004'), honninAgreed: { booleanValue: true }, acceptedAt: T(new Date()) });
  const before = pushes.length;
  const past = T(new Date(Date.now() - 60000));
  const arr = (...v) => ({ arrayValue: { values: v.map(S) } });
  put('groups/g1/yotei/yAll', { kind: S('📌'), date: S(ds), label: S('家族みんな'), uid: S('owner'), notifyAt: past });
  put('groups/g1/yotei/yR', { kind: S('📌'), date: S(ds), label: S('おばあちゃんだけ'), uid: S('owner'), notifyAt: past, notifyTo: arr('r:r1') });
  put('groups/g1/yotei/yUR', { kind: S('📌'), date: S(ds), label: S('ふたり'), uid: S('owner'), notifyAt: past, notifyTo: arr('u:fam', 'r:r1', 'r:gone') });
  // 1回の見回りの通信には上限があるので、残りは次の回に送る
  for (let i = 0; i < 3; i++) { await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } }); await waiter; }
  const got = pushes.slice(before).map((p) => p.to + ':' + p.messages[0].text.split('\n').find((l) => /家族みんな|おばあちゃんだけ|ふたり/.test(l)));
  assert.deepEqual(got.sort(), ['Ufam:📌 ふたり', 'Ufam:📌 家族みんな', 'Ugrand:📌 おばあちゃんだけ', 'Ugrand:📌 ふたり']);
  // 同意をやめたら、その後は送らない
  {
    db.delete('groups/g1/lineShareConsents/owner');
    const b1 = pushes.length;
    put('groups/g1/yotei/yWithdrawn', { kind: S('📌'), date: S(ds), label: S('同意をやめた後'), uid: S('owner'), notifyAt: T(new Date(Date.now() - 60000)), notifyTo: arr('r:r1') });
    await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } }); await waiter;
    assert.equal(pushes.length, b1, '同意をやめた後は送らない');
    db.delete('groups/g1/yotei/yWithdrawn');
    put('groups/g1/lineShareConsents/owner', { version: S('line-share-20261004'), honninAgreed: { booleanValue: true }, acceptedAt: T(new Date()) });
  }
  // 家族が送信先を削除したら、その後は送らない(控えが残っていても)
  db.delete('lineRecipients/r1');
  const before2 = pushes.length;
  put('groups/g1/yotei/yR2', { kind: S('📌'), date: S(ds), label: S('削除後'), uid: S('owner'), notifyAt: past, notifyTo: arr('r:r1') });
  await worker.scheduled({}, env, { waitUntil: (p) => { waiter = p; } });
  await waiter;
  assert.deepEqual(pushes.slice(before2).map((p) => p.to + ' ' + p.messages[0].text.split('\n')[2]), [], '削除した送信先には送らない');
  // 送信先が「解除」と送ると、控えを消して「LINEで停止」にする
  put('lineRecipients/r3', { groupId: S('g1'), name: S('いとこ'), status: S('joined'), createdBy: S('owner') });
  put('lineRecipientIds/r3', { lineUserId: S('Ucousin'), groupId: S('g1') });
  await hook([{ type: 'message', replyToken: 'i6', source: user('Ucousin'), message: { type: 'text', text: '解除' } }]);
  assert.match(replies.at(-1).messages[0].text, /解除しました/);
  assert.equal(db.has('lineRecipientIds/r3'), false);
  assert.equal(db.get('lineRecipients/r3').fields.status.stringValue, 'stopped');
  // ブロックでも同じ
  put('lineRecipients/r4', { groupId: S('g1'), name: S('姉'), status: S('joined'), createdBy: S('owner') });
  put('lineRecipientIds/r4', { lineUserId: S('Usis'), groupId: S('g1') });
  await hook([{ type: 'unfollow', source: user('Usis') }]);
  assert.equal(db.has('lineRecipientIds/r4'), false);
  assert.equal(db.get('lineRecipients/r4').fields.status.stringValue, 'stopped');
  db.delete('lineLinks/fam'); db.delete('groups/g1/yotei/yR2');
}
// 13. 動作確認ページ
const res = await worker.fetch(new Request('https://w.example/'), env, {});
assert.match(await res.text(), /^まいにこ LINE送信役は動いています（版：2026-10-04 /);

console.log('line worker: 署名確認・友だち追加・連携(期限切れ/承認待ちは不可)・見回り送信(対象者/文面/二重送信なし/古い予定/削除中の家庭)・解除・ブロック・送信先の招待と予定ごとの相手 14項目 passed');

// Failure, consent withdrawal, closure, retries and request budget regressions.
async function tick(){requests=0;await worker.scheduled({},env,{waitUntil:p=>{waiter=p;}});await waiter;assert.ok(requests<=49,'strict request budget (無料プランの50回より手前)');}
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
await tick();assert.ok(requests>=45&&requests<=49);assert.ok([...db].some(([p,d])=>p.includes('/yotei/budget')&&d.fields.notifyAt.timestampValue));
console.log('atomic code consumption and budget exhaustion passed');

/* ===== 月200通を守る上限ガード(2026-10-01) ===== */
const ystat=(id)=>db.get('groups/g1/yotei/'+id).fields;
const lastLog=(id)=>ystat(id).notifyLog.arrayValue.values.at(-1).mapValue.fields;
// 残り通数が家族に見えるように書かれる
await tick();
assert.equal(db.get('lineStatus/quota').fields.limit.integerValue,'200');
assert.equal(Number(db.get('lineStatus/quota').fields.remaining.integerValue),200-usage,'残り通数を記録する');
// 月の残りがタグ用の確保分(50通)に近づいたら、予定のお知らせは送らずに理由を残す
usage=151;const b1=pushes.length;pending('lowQuota');await tick();
assert.equal(pushes.length,b1,'残りが少ないときは予定を送らない');
assert.equal(ystat('lowQuota').notificationStatus.stringValue,'limited');
assert.equal(lastLog('lowQuota').reason.stringValue,'monthly');
// …でも、おまもりタグは届く
put('watchTags/tagA/alerts/reader9',{type:S('found'),situation:S('unwell'),count:{integerValue:'1'},senderUid:S('reader9'),createdAt:T(new Date(Date.now()-2000))});
await tick();
assert.equal(pushes.length,b1+1,'タグは残りの確保分から届く');
// 月の上限まで使い切ったら、タグも送らない(課金はされず、アプリの中には出る)
db.delete('tagAlertCounters/tagA');
usage=200;put('watchTags/tagA/alerts/reader10',{type:S('found'),situation:S('lost'),count:{integerValue:'1'},senderUid:S('reader10'),createdAt:T(new Date(Date.now()-2000))});
const b2=pushes.length;await tick();assert.equal(pushes.length,b2,'使い切ったら送らない');
assert.ok([...db].some(([p,d])=>p.startsWith('tagAlertReceipts/')&&d.fields.result?.stringValue==='monthly'),'使い切った理由を残す');
usage=0;
// 家庭ごとの1日の上限: 今日の分を使い切った家庭の予定は送らない
put('lineUsage/g1',{day:S(new Date(Date.now()+9*3600000).toISOString().slice(0,10)),count:{integerValue:'20'}});
pending('homeLimit');const b3=pushes.length;await tick();
assert.equal(pushes.length,b3);assert.equal(lastLog('homeLimit').reason.stringValue,'household');
db.delete('lineUsage/g1');
// 送ったら家庭の今日の通数が増える
pending('countMe');await tick();
assert.equal(db.get('lineUsage/g1').fields.count.integerValue,'1','家庭の通数を数える');
// タグごとの上限: 1時間に3回まで(いたずら対策)
for(const id of Object.keys(Object.fromEntries(db)))if(id.startsWith('tagAlertCounters/'))db.delete(id);
const b4=pushes.length;
for(let i=0;i<5;i++){
  put('watchTags/tagA/alerts/burst'+i,{type:S('found'),situation:S('lost'),count:{integerValue:'1'},senderUid:S('burst'+i),createdAt:T(new Date(Date.now()+i))});
}
await tick();
assert.ok(pushes.length-b4>=1&&pushes.length-b4<=3,'1回の見回りで知らせるタグは3件まで');
await tick();await tick();await tick();
assert.equal(pushes.length-b4,3,'同じタグは1時間に3回まで');
assert.equal(db.get('tagAlertCounters/tagA').fields.hourCount.integerValue,'3');
// 古い読み取りが200件以上たまっても、新しい読み取りを拾える
db.delete('tagAlertCounters/tagA');
for(let i=0;i<600;i++)db.set('watchTags/tagA/alerts/old'+i,{fields:{type:S('found'),situation:S('safe'),count:{integerValue:'1'},senderUid:S('old'+i),createdAt:T(new Date(Date.now()-5*86400000-i*1000))},updateTime:new Date(Date.UTC(2026,0,1)).toISOString()});
put('watchTags/tagA/alerts/fresh',{type:S('found'),situation:S('safe'),count:{integerValue:'1'},senderUid:S('fresh'),createdAt:T(new Date())});
const b5=pushes.length;await tick();
assert.equal(pushes.length-b5,1,'古い記録が多くても新しい読み取りが届く');
assert.match(pushes.at(-1).messages[0].text,/安全な場所にいます/);
// 停止したタグは送らない
put('watchTags/tagA',{groupId:S('g1'),active:{booleanValue:false}});
put('watchTags/tagA/alerts/afterStop',{type:S('found'),situation:S('lost'),count:{integerValue:'1'},senderUid:S('afterStop'),createdAt:T(new Date())});
const b6=pushes.length;await tick();assert.equal(pushes.length,b6,'停止したタグは送らない');
console.log('LINE上限ガード(残り通数・タグの確保・家庭の上限・タグの上限・1回3件・古い記録・停止タグ) passed');
/* タグが多くても、2時間のうちに必ず順番が回ってくる・予定のお知らせも同じ回に送れる(2026-10-01 10人会議の指摘) */
{
  for (const k of [...db.keys()]) if (k.startsWith('watchTags/') || k.startsWith('tagAlertCounters/') || k.startsWith('lineUsage/')) db.delete(k);
  for (let i = 0; i < 16; i++) put('watchTags/many' + String(i).padStart(2, '0'), { groupId: S('g1'), active: { booleanValue: true } });
  put('watchTags/many15/alerts/lateReader', { type: S('found'), situation: S('lost'), count: { integerValue: '1' }, senderUid: S('lateReader'), createdAt: T(new Date()) });
  const before = pushes.length;
  const RealDate = Date;
  let shift = 0;
  class ShiftedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift); } static now() { return RealDate.now() + shift; } }
  globalThis.Date = ShiftedDate;
  let reached = -1;
  for (let run = 0; run < 3 && reached < 0; run++) {
    shift = run * 900000;
    await tick();
    if (pushes.length > before) reached = run;
  }
  globalThis.Date = RealDate;
  assert.ok(reached >= 0 && reached <= 1, '16件のタグでも30分以内に順番が回る (' + reached + ')');
  // タグの読み取りがたまっていても、同じ回で予定のお知らせを送れる
  for (let i = 0; i < 6; i++) put('watchTags/many0' + (i % 8) + '/alerts/r' + i, { type: S('found'), situation: S('lost'), count: { integerValue: '1' }, senderUid: S('r' + i), createdAt: T(new Date()) });
  pending('withTags');
  let runs = 0;
  while (!db.get('groups/g1/yotei/withTags').fields.notifiedAt?.timestampValue && runs < 3) { await tick(); runs++; }
  assert.ok(db.get('groups/g1/yotei/withTags').fields.notifiedAt?.timestampValue, 'タグの読み取りがたまっていても、予定のお知らせは次の回までに届く (' + runs + '回)');
  console.log('タグの順番(16件)・タグがたまっていても予定が届く passed');
}
/* 家族が多い家庭(6人がLINE連携): 1回で送り切れなくても、次の回で残りの人へ届き、同じ人には二重に届かない */
{
  for (const k of [...db.keys()]) if (k.startsWith('watchTags/') || k.startsWith('tagAlertCounters/') || k.startsWith('lineUsage/')) db.delete(k);
  put('groups/g3', { createdBy: S('b0') });
  for (let i = 0; i < 6; i++) {
    put('groups/g3/members/b' + i, { name: S('家族' + i), status: S('approved') });
    put('consents/b' + i, consent());
    put('lineLinks/b' + i, { lineUserId: S('Ub' + i), groupId: S('g3') });
  }
  put('watchTags/big', { groupId: S('g3'), active: { booleanValue: true } });
  put('watchTags/big/alerts/finder', { type: S('found'), situation: S('unwell'), count: { integerValue: '1' }, senderUid: S('finder'), createdAt: T(new Date()) });
  const start = pushes.length;
  for (let run = 0; run < 4; run++) await tick();
  const got = pushes.slice(start).filter((p) => /^Ub/.test(p.to)).map((p) => p.to).sort();
  assert.deepEqual(got, ['Ub0', 'Ub1', 'Ub2', 'Ub3', 'Ub4', 'Ub5'], '6人全員に1回ずつ届く');
  console.log('家族が多い家庭のタグのお知らせ(続きから・二重なし) passed');
}
/* ひと声のきっかけ(2026-10-04): 「LINEにも送る」をオンにし、ご本人が了解した家庭だけ、
   決めた時刻から3時間のうちに、ご本人の操作がない日に、その日の担当1人へ1日1通。名前・様子は書かない。 */
{
  // 前の検査で残った予定・タグ・家庭を片付ける(日付を進めると送信待ちになり、1回の通信の上限を使ってしまうため)
  for (const k of [...db.keys()]) if (/^(watchTags|tagAlertCounters|lineUsage|lineDeliveryReceipts|groups\/g3)\b|^groups\/g1\/yotei\//.test(k)) db.delete(k);
  put('groups/g4', { createdBy: S('f4') });
  put('groups/g4/members/h4', { name: S('花子'), role: S('honnin'), status: S('approved') });
  put('groups/g4/members/f4', { name: S('太郎'), role: S('kazoku'), status: S('approved') });
  put('groups/g4/members/f4b', { name: S('次子'), role: S('kazoku'), status: S('approved') });
  for (const id of ['h4', 'f4', 'f4b']) put('consents/' + id, consent());
  put('lineLinks/f4', { lineUserId: S('Uf4'), groupId: S('g4') });
  put('lineLinks/f4b', { lineUserId: S('Uf4b'), groupId: S('g4') });
  const RealDate = Date;
  let fixed = 0;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  // 日本時間 → UTC(9時間前)
  const at = (day, h, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return RealDate.UTC(y, mo - 1, d, h - 9, m); };
  let n = 0;
  const ev = (fields) => put('groups/g4/events/hk' + (n++), fields);
  const config = (extra = {}) => ev({ type: S('hitokoe-config'), enabled: { booleanValue: true }, line: { booleanValue: true },
    hour: { integerValue: '11' }, requestId: S('r1'), uid: S('f4'), at: T(new RealDate(at('2026-10-04', 8, n))), ...extra });
  // 場面ごとに初めからやり直す(LINE側が覚えている再送キーも忘れさせる。同じ日の同じ家庭は同じ再送キーのため)
  const clear = () => { for (const k of [...db.keys()]) if (/^(groups\/g4\/events|lineDeliveryReceipts|lineUsage)\//.test(k)) db.delete(k); acceptedKeys.clear();
    // 承認済みでない・削除中の場面のあと、見回りの後片付けがLINE連携を消すことがある(正しい動き)。つなぎ直す
    put('lineLinks/f4', { lineUserId: S('Uf4'), groupId: S('g4') }); put('lineLinks/f4b', { lineUserId: S('Uf4b'), groupId: S('g4') }); };
  const run = async (day, h, m = 0) => {
    fixed = at(day, h, m); globalThis.Date = FixedDate;
    const before = pushes.length;
    try { await tick(); } finally { globalThis.Date = RealDate; }
    return pushes.slice(before).filter((p) => /^Uf4/.test(p.to));
  };
  const yes = (requestId = 'r1') => ev({ type: S('hitokoe-consent'), uid: S('h4'), requestId: S(requestId), answer: S('yes'), at: T(new RealDate(at('2026-10-04', 9))) });
  quota = { type: 'limited', value: 200 }; usage = 0;

  // 1. 月曜11:30、ご本人の操作なし → 設定した太郎さんへ1通。文面に名前・様子は書かない
  clear(); config(); yes();
  let got = await run('2026-10-05', 11, 30);
  assert.equal(got.length, 1, 'ひと声のきっかけが届く');
  assert.equal(got[0].to, 'Uf4');
  const text = got[0].messages[0].text;
  assert.match(text, /ひと声のきっかけ（まいにこ）/);
  assert.match(text, /返事や対応は必要ありません/);
  assert.match(text, /安否確認・緊急通報ではありません/);
  assert.ok(!/花子|太郎|次子/.test(text), '名前を書かない');
  assert.equal(db.get('lineUsage/hitokoe-2026-10').fields.count.integerValue, '1', '月の数を数える');
  // 2. 同じ日の次の回には送らない(1日1通)
  assert.equal((await run('2026-10-05', 11, 45)).length, 0, '1日1通まで');
  // 3. 時刻前・3時間を過ぎた後は送らない
  clear(); config(); yes();
  assert.equal((await run('2026-10-05', 10, 45)).length, 0, '時刻前は送らない');
  assert.equal((await run('2026-10-05', 14, 0)).length, 0, '3時間を過ぎたら送らない');
  // 4. ご本人の操作が1つでもあれば送らない。家族の記録・了解の記録・前の日の記録は数えない
  clear(); config(); yes();
  ev({ type: S('aisatsu-back'), uid: S('f4'), date: S('2026-10-05') });
  ev({ type: S('hitokoe-consent'), uid: S('h4'), requestId: S('old'), answer: S('no'), date: S('2026-10-05') });
  ev({ type: S('aisatsu'), uid: S('h4'), date: S('2026-10-04') });
  ev({ type: S('kusuri'), uid: S('h4'), date: S('2026-10-05') });
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, 'ご本人の操作があれば送らない');
  db.delete('groups/g4/events/hk' + (n - 1));
  assert.equal((await run('2026-10-05', 11, 30)).length, 1, '家族の記録・了解・前の日は操作に数えない');
  // 5. 家族がもう「連絡しました」を押していれば送らない
  clear(); config(); yes();
  ev({ type: S('hitokoe-contacted'), uid: S('f4b'), target: S('h4'), date: S('2026-10-05') });
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, '連絡済みなら送らない');
  // 6. 「LINEにも送る」が切ってある・最新の設定で切った・了解がない・了解が古いお願いのもの・「やめておく」 → 送らない
  clear(); config({ line: { booleanValue: false } }); yes();
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, 'LINEにも送るが切ってある');
  clear(); config(); config({ enabled: { booleanValue: false } }); yes();
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, '最新の設定で切った');
  clear(); config();
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, 'ご本人の了解がない');
  clear(); config({ requestId: S('r2') }); yes('r1');
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, 'LINEにも送るにした後の了解がまだ');
  clear(); config(); yes(); ev({ type: S('hitokoe-consent'), uid: S('h4'), requestId: S('r1'), answer: S('no'), at: T(new RealDate(at('2026-10-04', 10))) });
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, 'ご本人があとから「やめておく」にした');
  // 7. お休み(毎週の曜日・期間)
  clear(); config({ offWeekdays: { arrayValue: { values: [{ integerValue: '1' }] } } }); yes();
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, '毎週のお休み(月曜)');
  clear(); config({ pauses: { arrayValue: { values: [{ mapValue: { fields: { from: S('2026-10-04'), to: S('2026-10-06') } } }] } } }); yes();
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, '期間のお休み');
  // 8. 曜日ごとの担当(火曜は次子さん)。担当がLINE連携していなければ送らない(アプリの中だけ)
  clear(); config({ assignees: { mapValue: { fields: { 2: S('f4b') } } } }); yes();
  got = await run('2026-10-06', 11, 30);
  assert.equal(got.length, 1); assert.equal(got[0].to, 'Uf4b', '火曜の担当へ');
  clear(); config({ assignees: { mapValue: { fields: { 2: S('f4b') } } } }); yes();
  const saved = db.get('lineLinks/f4b'); db.delete('lineLinks/f4b');
  assert.equal((await run('2026-10-06', 11, 30)).length, 0, '担当がLINE連携していなければ送らない');
  db.set('lineLinks/f4b', saved);
  // 9. 担当が承認済みでなくなった・ご本人だけの家庭 → 送らない
  clear(); config(); yes();
  put('groups/g4/members/f4', { name: S('太郎'), role: S('kazoku'), status: S('pending') });
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, '担当が承認済みでない');
  put('groups/g4/members/f4', { name: S('太郎'), role: S('kazoku'), status: S('approved') });
  // 10. 上限: ひと声だけで月90通・月の残りがタグの分(50通)だけ → 送らない(アプリの中だけ)
  clear(); config(); yes();
  put('lineUsage/hitokoe-2026-10', { month: S('2026-10'), count: { integerValue: '90' } });
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, 'ひと声は月90通まで');
  clear(); config(); yes();
  usage = 150;
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, 'タグの分は残す');
  usage = 149;
  assert.equal((await run('2026-10-05', 11, 30)).length, 1, '残りがあれば送る');
  // 11. 家庭を削除中なら送らない
  clear(); config(); yes();
  put('groups/g4', { createdBy: S('f4'), deletionState: S('deleting') });
  assert.equal((await run('2026-10-05', 11, 30)).length, 0, '削除中の家庭');
  put('groups/g4', { createdBy: S('f4') });
  // 12. 送信に失敗したら、次の回に同じ再送キーで送り直す(二重には届かない)
  clear(); config(); yes(); usage = 0;
  pushFailure = true;
  assert.equal((await run('2026-10-05', 11, 30)).length, 0);
  pushFailure = false;
  lostResponse = true;
  assert.equal((await run('2026-10-05', 11, 45)).length, 1, '次の回に届く');
  assert.equal((await run('2026-10-05', 12, 0)).length, 0, '受付済みの再送キーでは二重に届かない');
  console.log('ひと声のきっかけのLINE(1日1通・時刻・操作・連絡済み・了解・お休み・担当・上限・削除中・再送) passed');
}
/* 利用数の集計(2026-10-04): 日ごとに「ご本人の操作の数」と「家族の記録の数」だけを数え、運営者にだけ全体の数字を返す */
{
  for (const k of [...db.keys()]) if (/^(groups\/g[1-4]\/yotei|watchTags|tagAlertCounters|lineDeliveryReceipts|usageStats|ops)\//.test(k)) db.delete(k);
  for (const k of [...db.keys()]) if (/^groups\/g4\/events\//.test(k)) db.delete(k);
  put('groups/g5', { createdBy: S('f5') });
  put('groups/g5/members/h5', { name: S('ばあば'), role: S('honnin'), status: S('approved') });
  put('groups/g5/members/f5', { name: S('むすめ'), role: S('kazoku'), status: S('approved') });
  const RealDate = Date;
  let fixed = 0;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  const at = (day, h, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return RealDate.UTC(y, mo - 1, d, h - 9, m); };
  const run = async (day, h, m = 0) => { fixed = at(day, h, m); globalThis.Date = FixedDate; try { await tick(); } finally { globalThis.Date = RealDate; } };
  let n = 0;
  const ev = (uid, type, date) => put('groups/g5/events/u' + (n++), { uid: S(uid), type: S(type), date: S(date), memo: S('中身は読まない') });
  ev('h5', 'aisatsu', '2026-10-05'); ev('h5', 'kusuri', '2026-10-05'); ev('f5', 'aisatsu-back', '2026-10-05');
  ev('h5', 'hitokoe-consent', '2026-10-05'); ev('f5', 'hitokoe-config', '2026-10-05'); ev('f5', 'line-link-log', '2026-10-05');
  ev('h5', 'onegai', '2026-10-06');
  const statsOf = () => [...db].filter(([p, d]) => p.startsWith('usageStats/') && d.fields.groupId?.stringValue === 'g5').map(([p, d]) => ({ p, f: d.fields }))[0];
  // 1. その日の分は、翌日の朝5時を過ぎてから数える
  await run('2026-10-06', 4, 30);
  assert.ok(!statsOf() || statsOf().f.through.stringValue < '2026-10-05', '翌朝5時前は前の日を数えない');
  await run('2026-10-06', 5, 15);
  let st = statsOf();
  assert.ok(st, '集計ができる');
  assert.equal(st.f.through.stringValue, '2026-10-05');
  assert.equal(st.f.start.stringValue, '2026-10-05', '初めて操作があった日');
  const d5 = st.f.days.mapValue.fields['2026-10-05'].mapValue.fields;
  assert.equal(d5.h.integerValue, '2', 'ご本人の操作(挨拶・薬)。了解の記録は数えない');
  assert.equal(d5.f.integerValue, '1', '家族の記録(返事)。設定・連携の記録は数えない');
  assert.ok(!JSON.stringify(st.f).includes('ばあば') && !JSON.stringify(st.f).includes('中身'), '名前・中身は残さない');
  assert.ok(!/g5/.test(st.p), '文書の番号に家庭の番号をそのまま使わない');
  // 2. 同じ日は二度数えない。次の日の分は次の朝
  await run('2026-10-06', 5, 30);
  assert.equal(statsOf().f.through.stringValue, '2026-10-05');
  await run('2026-10-07', 5, 15);
  st = statsOf();
  assert.equal(st.f.through.stringValue, '2026-10-06');
  assert.equal(st.f.days.mapValue.fields['2026-10-06'].mapValue.fields.h.integerValue, '1');
  // 3. 運営者の登録: 合言葉が未設定なら案内だけ・違えば断る・合えば登録。運営者以外の「集計」には案内だけ
  const said = async (uid, text) => { await hook([{ type: 'message', replyToken: 'q' + uid, source: user(uid), message: { type: 'text', text } }]); return replies.at(-1).messages[0].text; };
  assert.match(await said('Uop', '運営者登録 さくら'), /お返事や相談は届きません/, '合言葉が未設定なら何もしない');
  env.OPERATOR_PASSPHRASE = 'さくら 2026';
  assert.match(await said('Uop', '運営者登録 もも'), /合言葉が違います/);
  assert.match(await said('Uop', '運営者登録 さくら２０２６'), /運営者として登録しました/, '全角・空白の違いは同じとみなす');
  assert.match(await said('Uother', '集計'), /お返事や相談は届きません/, '運営者以外には集計を返さない');
  fixed = at('2026-10-07', 9); globalThis.Date = FixedDate;
  let report;
  try { report = await said('Uop', '集計'); } finally { globalThis.Date = RealDate; }
  assert.match(report, /利用の集計（10月6日まで）/);
  assert.match(report, /直近7日に、ご本人の操作があった世帯：1\/1（100%）/);
  assert.match(report, /本人操作割合：75%（本人3件・家族1件）/);
  assert.match(report, /3日目にも、ご本人の操作があった世帯：対象なし/);
  assert.match(report, /8週目も続いている世帯：対象なし/);
  assert.match(report, /ご本人の操作があった日数）：2/);
  assert.ok(!/ばあば|むすめ|g5/.test(report), '名前・家庭の番号は返さない');
  // 4. 試せるのは1日5回まで
  for (let i = 0; i < 5; i++) await said('Ubad', '運営者登録 ちがう' + i);
  assert.match(await said('Ubad', '運営者登録 さくら2026'), /試せる回数を超えました/);
  assert.equal(db.get('ops/operator').fields.lineUserId.stringValue, 'Uop', '運営者は変わらない');
  delete env.OPERATOR_PASSPHRASE;
  // 5. 3日目・8週目の判定
  put('usageStats/uX', { groupId: S('g5'), honnin: { booleanValue: true }, start: S('2026-08-01'), through: S('2026-10-06'),
    days: { mapValue: { fields: { '2026-08-03': { mapValue: { fields: { h: { integerValue: '1' }, f: { integerValue: '0' } } } },
      '2026-09-22': { mapValue: { fields: { h: { integerValue: '2' }, f: { integerValue: '2' } } } } } } } });
  fixed = at('2026-10-07', 9); globalThis.Date = FixedDate;
  try { report = await said('Uop', '集計'); } finally { globalThis.Date = RealDate; }
  assert.match(report, /ご本人が参加している世帯：2/);
  assert.match(report, /3日目にも、ご本人の操作があった世帯：1\/1（100%）/);
  assert.match(report, /8週目も続いている世帯：1\/1（100%）/);
  assert.match(report, /直近7日に、ご本人の操作があった世帯：1\/2（50%）/);
  // 6. 家庭を削除中になったら、見回りの後片付けで集計を消す
  put('groups/g5', { createdBy: S('f5'), deletionState: S('deleting') });
  const g5Stats = () => [...db].filter(([p, d]) => p.startsWith('usageStats/') && d.fields.groupId?.stringValue === 'g5').length;
  for (let i = 0; i < 8 && g5Stats(); i++) await run('2026-10-07', 6, i * 15);
  assert.equal(g5Stats(), 0, '削除中の家庭の集計は消す');
  assert.ok([...db.keys()].some((k) => k.startsWith('usageStats/')), 'ほかの家庭の集計は残す');
  console.log('利用数の集計(朝5時以降・1日ずつ・数えない記録・名前を残さない・運営者の登録と回数制限・集計の返事・3日目と8週目・削除) passed');
}
