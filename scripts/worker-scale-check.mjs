
/* LINE送信役(worker.js)の模擬テスト。
   LINEとFirestoreを偽物に差し替えて、連携・解除・予定のお知らせを確かめる。 */
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync, createHmac } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const worker = (await import(process.env.WORKER_FILE ? pathToFileURL(resolve(process.env.WORKER_FILE)).href : '../worker.js')).default;

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
let pushFailure=false, lostResponse=false, requests=0, failTo='';
const seen=[];   // 見回りで読み書きした文書の場所(通信の節約の確認用)
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
    if(pushFailure || (failTo && body.to===failTo)) return json({},500);
    if(acceptedKeys.has(keys.at(-1))) return new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'accepted'}});
    acceptedKeys.add(keys.at(-1)); pushes.push(body); usage++;
    if(lostResponse) {lostResponse=false;throw new Error('lost response');}
    return json({});
  }
  if (url === 'https://api.line.me/v2/bot/message/reply') { replies.push(body); return json({}); }
  if (url.startsWith('https://api.line.me/v2/bot/profile/')) {
    if (url.endsWith('/Uerr')) return json({}, 500);           // LINE側の一時的な失敗
    if (url.endsWith('/Unet')) throw new Error('network');     // 通信の失敗
    return url.endsWith('/Unf') ? json({}, 404) : json({ displayName: 'おばあ' });
  }
  const base = 'https://firestore.googleapis.com/v1/' + ROOT;
  assert.ok(url.startsWith(base), url);
  assert.equal(opt.headers.authorization, 'Bearer gtok');
  const u = new URL(url);
  let rest = decodeURIComponent(u.pathname).slice(('/v1/' + ROOT).length).replace(/^\//, '');
  seen.push((opt.method || 'GET') + ' ' + rest);
  if (rest === ':batchGet') {
    // 本物と同じく、文書ごとに found(ある)か missing(ない)を返す
    return json(body.documents.map((name) => { const path = name.slice(ROOT.length + 1); return db.has(path) ? { found: docJson(path) } : { missing: name }; }));
  }
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
    const valueOf = (d, field) => field === '__name__' ? { stringValue: d.name } : d.fields[field];
    const order = (a, b) => { for (const o of q.orderBy || []) { const c = cmp(valueOf(a, o.field.fieldPath), valueOf(b, o.field.fieldPath)); if(c) return (o.direction === 'DESCENDING' ? -1 : 1) * c; } return 0; };
    if(q.orderBy) out.sort((a,b)=>order(a.document,b.document));
    if(q.startAt) {
      const cursor = { name: q.startAt.values[1].referenceValue, fields: { [q.orderBy[0].field.fieldPath]: q.startAt.values[0] } };
      for(let i=out.length-1;i>=0;i--) if(order(out[i].document,cursor) <= 0) out.splice(i,1);
    }
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


// Production Worker entry point, fake Firestore/LINE only. No real account or delivery.
const RealDate = Date;
let fixed;
class FixedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [fixed])); }
  static now() { return fixed; }
}
const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
let warnings = 0;
const results = [];
for (const households of [5, 12, 18, 35, 100]) {
  db.clear(); pushes.length = 0; acceptedKeys.clear(); usage = 0;
  quota = { type: 'limited', value: 100000 }; // isolate scheduling, not the monthly LINE cap
  const start = RealDate.parse('2026-10-25T15:00:00Z'); // Oct 26, 00:00 JST
  const day = '2026-10-26';
  fixed = start;
  const dueByUser = new Map();
  for (let i = 0; i < households; i++) {
    const gid = 'g' + String(i).padStart(3, '0'), uid = 'f' + i, honnin = 'h' + i;
    const at = new RealDate(start + (7 + i % 12) * 3600000);
    put('groups/' + gid, { createdBy: S(uid) });
    put('groups/' + gid + '/members/' + uid, { name: S('家族'), role: S('kazoku'), status: S('approved') });
    put('groups/' + gid + '/members/' + honnin, { name: S('本人'), role: S('honnin'), status: S('approved') });
    put('consents/' + uid, { version: S('2026-09-19.1'), mode: S('kazoku'), privacyAccepted: { booleanValue: true },
      sensitiveAccepted: { booleanValue: true }, sharingAccepted: { booleanValue: true },
      subjectBasis: S('explained-and-agreed'), acceptedAt: T(new RealDate(start)) });
    put('lineLinks/' + uid, { groupId: S(gid), lineUserId: S('U' + uid), friend: { booleanValue: true } });
    put('groups/' + gid + '/yotei/one', { label: S('試験予定'), uid: S(uid), date: S(day), notifyAt: T(at) });
    dueByUser.set('U' + uid, at.getTime());
    put('groups/' + gid + '/events/config', { type: S('hitokoe-config'), enabled: { booleanValue: true }, line: { booleanValue: true },
      hour: { integerValue: '11' }, requestId: S('r1'), uid: S(uid), at: T(new RealDate(start)) });
    put('groups/' + gid + '/events/yes', { type: S('hitokoe-consent'), uid: S(honnin), requestId: S('r1'), answer: S('yes'), at: T(new RealDate(start)) });
    if (i % 2 === 0) put('groups/' + gid + '/events/hello', { type: S('aisatsu'), uid: S(honnin), date: S(day) });
  }
  globalThis.Date = FixedDate;
  console.log = () => {}; console.warn = () => { warnings++; }; console.error = () => { warnings++; };
  let maxRequests = 0, totalRequests = 0;
  const schedules = [], hitokoe = [];
  try {
    for (let tick = 0; tick < 96; tick++) {
      fixed = start + tick * 900000;
      requests = 0;
      const before = pushes.length;
      let waiting;
      await worker.scheduled({}, env, { waitUntil: p => { waiting = p; } });
      await waiting;
      maxRequests = Math.max(maxRequests, requests); totalRequests += requests;
      for (const push of pushes.slice(before)) {
        if (push.messages[0].text.includes('ひと声のきっかけ')) hitokoe.push(push.to);
        else schedules.push({ to: push.to, delayMinutes: (fixed - dueByUser.get(push.to)) / 60000 });
      }
    }
  } finally { globalThis.Date = RealDate; console.log = originalLog; console.warn = originalWarn; console.error = originalError; }
  const result = { households, schedules: schedules.length, within15Minutes: schedules.filter(s => s.delayMinutes <= 15).length,
    maxDelayMinutes: Math.max(0, ...schedules.map(s => s.delayMinutes)), hitokoe: hitokoe.length,
    eligibleHitokoe: Math.floor(households / 2), maxRequests, totalRequests,
    expired: [...db.values()].filter(d => d.fields.notificationStatus?.stringValue === 'expired').length };
  results.push(result);
  assert.ok(maxRequests <= 49, 'hard request cap');
  assert.equal(new Set(schedules.map(s => s.to)).size, schedules.length, 'no duplicate schedules');
  assert.equal(new Set(hitokoe).size, hitokoe.length, 'no duplicate hitokoe');
  assert.ok(hitokoe.every(to => Number(to.slice(2)) % 2 === 1), 'no prompt for an active person');
}
console.log(JSON.stringify({ fakeServices: true, results }, null, 2));
if (!process.argv.includes('--report-only')) {
  const r = results.find(r => r.households === 18);
  assert.equal(r.hitokoe, r.eligibleHitokoe, '18 households: hitokoe is no longer starved');
  for (const r of results) assert.equal(r.schedules, r.households, 'all scheduled notices processed within the simulated day');
}
