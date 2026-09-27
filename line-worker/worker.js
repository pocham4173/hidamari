/* まいにこ LINE送信役（Cloudflare Workers・無料プラン用）2026-09-26
 *
 * できること
 *  1. LINEからの受付（Webhook: https://〜.workers.dev/line）
 *     - 友だち追加 → 連携コードの送り方を返事
 *     - 8文字の連携コード → まいにこの家庭・アカウントとLINEを連携
 *     - 「解除」 → このLINEの連携を解除
 *     - ブロック → 自動で連携解除
 *  2. 15分ごとの見回り（Cron）
 *     - 「LINEで知らせる日時」を過ぎた予定を探し、その家庭でLINE連携した
 *       承認済みの人へ「予定のお知らせ」を送る。送ったら予定に送信済みの印を付ける。
 *
 * 設定する秘密の値（Cloudflareの「設定 → 変数とシークレット」に、種類「シークレット」で登録）
 *  LINE_CHANNEL_SECRET        … LINE Developers の チャネルシークレット
 *  LINE_CHANNEL_ACCESS_TOKEN  … LINE Developers の チャネルアクセストークン（長期）
 *  FIREBASE_SERVICE_ACCOUNT   … Firebase の サービスアカウント秘密鍵（JSONファイルの中身をまるごと）
 *
 * 送る内容は、予定の日付・時刻・場所・予定名・登録した人の名前だけ。
 * 服薬・体調・伝言などの記録は読みにも行かない。
 */

const APP_URL = 'https://pocham4173.github.io/hidamari/';
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const LATE_LIMIT_MS = 12 * 60 * 60 * 1000;   // 12時間以上遅れた通知は送らずに印だけ付ける
const CONSENT_VERSION = '2026-09-19.1';
const SUBREQUEST_BUDGET = 45;                // 無料プランの上限(50)より少し手前で止める

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/line' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (url.pathname === '/' || url.pathname === '/line') {
      const missing = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'FIREBASE_SERVICE_ACCOUNT']
        .filter((k) => !env[k]);
      const body = missing.length
        ? 'まいにこ LINE送信役：まだ設定が足りません → ' + missing.join('、')
        : 'まいにこ LINE送信役は動いています';
      return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotifications(env).catch((e) => console.error('notify failed', e && e.stack || e)));
  },
};

/* ================= LINE Webhook ================= */

async function handleWebhook(request, env) {
  const body = await request.text();
  const ok = await verifySignature(body, request.headers.get('x-line-signature') || '', env.LINE_CHANNEL_SECRET || '');
  if (!ok) return new Response('bad signature', { status: 401 });
  let events = [];
  try { events = JSON.parse(body).events || []; } catch (e) { return new Response('bad json', { status: 400 }); }
  const fs = new Firestore(env);
  let failed = false;
  for (const ev of events) {
    try { await handleEvent(ev, env, fs); }
    catch (e) { failed = true; console.error('event failed'); }
  }
  return new Response(failed ? 'retry later' : 'ok', {status: failed ? 503 : 200});
}

async function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = b64(new Uint8Array(mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

const MSG_WELCOME =
  'まいにこ公式LINEです。友だち追加ありがとうございます。\n\n' +
  '予定のお知らせを受け取るには、まいにこアプリの\n「設定」→「LINEで予定のお知らせ」→「LINE連携コードを作る」\nで表示される8文字のコードを、このトークに送ってください。';
const MSG_HELP =
  'このトークでは、連携コード（8文字）の受け付けと、予定のお知らせだけを行っています。\n' +
  'お返事や相談は届きません。急ぐときは電話などで連絡してください。\n\n' +
  '連携をやめるときは「解除」と送ってください。';

async function handleEvent(ev, env, fs) {
  const source = ev.source || {};
  if (source.type !== 'user' || !source.userId) return;
  const lineUserId = source.userId;

  if (ev.type === 'follow') {
    return reply(env, ev.replyToken, MSG_WELCOME);
  }
  if (ev.type === 'unfollow') {
    await removeLinksFor(fs, lineUserId);
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') {
    if (ev.replyToken) return reply(env, ev.replyToken, MSG_HELP);
    return;
  }
  const raw = String(ev.message.text || '');
  const text = raw.normalize('NFKC').toUpperCase().replace(/[\s\-ー－_]/g, '');
  if (text === '解除' || text === '連携解除') {
    const n = await removeLinksFor(fs, lineUserId);
    return reply(env, ev.replyToken, n
      ? 'LINE連携を解除しました。このLINEには予定のお知らせが届かなくなります。\nまた受け取るときは、アプリで新しい連携コードを作ってください。'
      : 'このLINEは、まいにこと連携していません。');
  }
  if (CODE_RE.test(text)) {
    return reply(env, ev.replyToken, await linkByCode(fs, text, lineUserId));
  }
  return reply(env, ev.replyToken, MSG_HELP);
}

async function linkByCode(fs, code, lineUserId) {
  const NG = 'コードが見つからないか、有効期限（10分）が切れています。\nまいにこアプリの「設定」→「LINEで予定のお知らせ」で、新しいコードを作ってください。';
  const c = await fs.get('lineLinkCodes/' + code);
  if (!c) return NG;
  const exp = c.fields.expiresAt;
  if (!(exp instanceof Date) || exp.getTime() < Date.now()) {
    await fs.delete('lineLinkCodes/' + code).catch(() => {});
    return NG;
  }
  const uid = c.fields.uid, groupId = c.fields.groupId;
  if (typeof uid !== 'string' || typeof groupId !== 'string') return NG;
  const member = await approvedMember(fs, groupId, uid);
  if (!member) {
    await fs.delete('lineLinkCodes/' + code).catch(() => {});
    return '家族への参加が承認されていないため、連携できませんでした。';
  }
  // Code consumption and link creation either both commit or neither does.
  const consumed = await fs.commit([
    {delete: fs.root + '/lineLinkCodes/' + code, currentDocument: {updateTime: c.updateTime}},
    {update: {name: fs.root + '/lineLinks/' + uid,
      fields: toFields({lineUserId, groupId, linkedAt: new Date()})}}
  ]);
  if (!consumed) return NG;
  const name = typeof member.name === 'string' && member.name ? member.name + 'さん、' : '';
  return name + 'LINE連携しました。\n\nまいにこで「LINEで知らせる日時」を入れた予定が、このLINEに届きます。\n' +
    'やめるときは、アプリの設定で解除するか、「解除」と送ってください。';
}

async function removeLinksFor(fs, lineUserId) {
  const docs = await fs.query('', {
    from: [{ collectionId: 'lineLinks' }],
    where: fieldEq('lineUserId', { stringValue: lineUserId }),
  });
  for (const d of docs) await fs.delete(d.path);
  return docs.length;
}

/* 承認済みで、退会処理中でもなく、家庭が削除中でもない人だけ */
async function approvedMember(fs, groupId, uid) {
  const group = await fs.get('groups/' + groupId);
  if (!group || group.fields.deletionState === 'deleting') return null;
  const m = await fs.get('groups/' + groupId + '/members/' + uid);
  if (!m) return null;
  const status = m.fields.status === undefined ? 'approved' : m.fields.status;
  if (status !== 'approved') return null;
  if (await fs.get('accountClosures/' + uid)) return null;
  const consent = await fs.get('consents/' + uid);
  if (!validConsent(consent && consent.fields)) return null;
  return m.fields;
}
function validConsent(c) {
  return !!c && c.version === CONSENT_VERSION && ['honnin','kazoku','konly'].includes(c.mode)
    && c.privacyAccepted === true && c.sensitiveAccepted === true && c.sharingAccepted === true
    && c.subjectBasis === (c.mode === 'honnin' ? 'self' : 'explained-and-agreed')
    && c.acceptedAt instanceof Date && Number.isFinite(c.acceptedAt.getTime());
}

/* ================= 15分ごとの見回り ================= */

async function runNotifications(env) {
  const fs = new Firestore(env);
  const now = new Date();
  let sent = 0;
  try {
    const groups = await fs.list('groups', ['deletionState']);
    // Rotate the starting household; a busy household cannot monopolize every run.
    const offset = groups.length ? Math.floor(now.getTime() / 900000) % groups.length : 0;
    for (const g of [...groups.slice(offset), ...groups.slice(0, offset)]) {
      if (g.fields.deletionState === 'deleting') continue;
      const due = await fs.query(g.path, {
        from: [{collectionId:'yotei'}],
        where: {fieldFilter:{field:{fieldPath:'notifyAt'},op:'LESS_THAN_OR_EQUAL',value:{timestampValue:now.toISOString()}}},
        orderBy: [{field:{fieldPath:'notifyAt'},direction:'ASCENDING'}], limit:10,
      });
      for (const y of due) {
        const at = y.fields.notifyAt;
        if (!(at instanceof Date)) continue;
        if (now.getTime() - at.getTime() > LATE_LIMIT_MS) {
          await fs.patch(y.path, {notifyAt:null, notifiedAt:null, notificationStatus:'expired'},
            ['notifyAt','notifiedAt','notificationStatus'], y.updateTime);
          continue;
        }
        const links = await fs.query('', {from:[{collectionId:'lineLinks'}],
          where:fieldEq('groupId',{stringValue:g.id})});
        const members = await fs.list(g.path + '/members', ['name']);
        const owner = members.find(m => m.id === y.fields.uid);
        const text = buildMessage(y.fields, owner && owner.fields.name || '', now);
        let complete = true, accepted = 0;
        const seen = new Set();
        const start = links.length ? Math.floor(now.getTime()/900000) % links.length : 0;
        for (const link of [...links.slice(start), ...links.slice(0,start)]) {
          const to = link.fields.lineUserId;
          if (typeof to !== 'string' || !to || seen.has(to)) continue;
          // The same schedule revision and recipient always reuse one retry key.
          const key = await deliveryKey(y.path + '\n' + y.updateTime + '\n' + to);
          const receiptPath = 'lineDeliveryReceipts/' + key;
          let receipt = await fs.get(receiptPath);
          if (receipt && receipt.fields.acceptedAt instanceof Date) {
            seen.add(to); accepted++; continue;
          }
          // Recheck server state immediately before each external transmission.
          if (!await approvedMember(fs, g.id, link.id)) continue;
          const currentLink = await fs.get(link.path);
          if (!currentLink || currentLink.fields.groupId !== g.id || currentLink.fields.lineUserId !== to) continue;
          const currentSchedule = await fs.get(y.path);
          if (!currentSchedule || currentSchedule.updateTime !== y.updateTime) {complete=false;break;}
          // Persist one immutable payload before sending, including across midnight/restarts.
          if (!receipt) {
            await fs.commit([{update:{name:fs.root+'/'+receiptPath,
              fields:toFields({text,expiresAt:new Date(at.getTime()+13*3600000)})},
              currentDocument:{exists:false}}]);
            receipt = await fs.get(receiptPath);
          }
          if (!receipt || typeof receipt.fields.text !== 'string') {complete=false;continue;}
          seen.add(to);
          if (!await push(env, fs, to, receipt.fields.text, key)) {complete=false;continue;}
          sent++; accepted++;
          // A crash before this write is safe: LINE recognizes the same retry key.
          await fs.set(receiptPath, {acceptedAt:new Date(), expiresAt:new Date(at.getTime()+13*3600000)});
        }
        if (complete && accepted > 0) {
          await fs.patch(y.path, {notifyAt:null, notifiedAt:new Date(), notificationStatus:'accepted'},
            ['notifyAt','notifiedAt','notificationStatus'], y.updateTime);
        }
        // No eligible recipient or failed delivery: keep notifyAt for the next run.
      }
    }
    // Clean one verified orphan link per run without relying on a complete household list.
    const cleanupLinks = await fs.list('lineLinks', ['groupId']);
    if (cleanupLinks.length) {
      const link = cleanupLinks[Math.floor(now.getTime()/900000)%cleanupLinks.length];
      if (!await approvedMember(fs, link.fields.groupId, link.id)) await fs.delete(link.path);
    }
    // Bounded maintenance. Never infer a deleted household from a partial list.
    for (const collectionId of ['lineLinkCodes','lineDeliveryReceipts']) {
      const expired = await fs.query('', {from:[{collectionId}],
        where:{fieldFilter:{field:{fieldPath:'expiresAt'},op:'LESS_THAN_OR_EQUAL',value:{timestampValue:now.toISOString()}}},limit:3});
      for (const d of expired) await fs.delete(d.path);
    }
  } catch (e) {
    if (e.message !== 'request-budget') throw e;
    // Pending schedules retain their notifyAt and receipts for the next run.
  }
  console.log('notifications accepted:', sent, 'requests:', fs.count);
}
async function deliveryKey(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}

function buildMessage(y, ownerName, now) {
  const WD = '日月火水木金土';
  const lines = ['📅 予定のお知らせ（まいにこ）'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(y.date || ''));
  let dateText = '';
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const todayJst = new Date(now.getTime() + 9 * 3600 * 1000);
    const today = Date.UTC(todayJst.getUTCFullYear(), todayJst.getUTCMonth(), todayJst.getUTCDate());
    const diff = Math.round((d.getTime() - today) / 86400000);
    const rel = diff === 0 ? '今日 ' : diff === 1 ? '明日 ' : diff === 2 ? 'あさって ' : '';
    dateText = rel + (+m[2]) + '月' + (+m[3]) + '日（' + WD.charAt(d.getUTCDay()) + '）';
  }
  const time = /^\d{2}:\d{2}$/.test(String(y.time || '')) ? ' ' + y.time : '';
  if (dateText || time) lines.push(dateText + time);
  if (y.place) lines.push('📍 ' + clip(y.place, 60));
  lines.push((y.kind ? clip(y.kind, 8) + ' ' : '') + clip(y.label || '予定', 60));
  if (ownerName) lines.push('（登録：' + clip(ownerName, 40) + '）');
  lines.push('', 'まいにこで確認する', APP_URL);
  return lines.join('\n');
}
function clip(v, n) { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) + '…' : s; }

/* ================= LINE送信 ================= */

async function reply(env, replyToken, text) {
  if (!replyToken) return;
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) console.error('reply failed', res.status);
}

async function push(env, fs, to, text, retryKey) {
  fs.reserve();
  try {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN,
      'x-line-retry-key': retryKey,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (res.ok || (res.status === 409 && res.headers.get('x-line-accepted-request-id'))) return true;
  console.error('push failed', res.status);
  return false;
  } catch (e) { console.error('push response unavailable'); return false; }
}

/* ================= Firestore（REST・サービスアカウント） ================= */

function fieldEq(path, value) {
  return { fieldFilter: { field: { fieldPath: path }, op: 'EQUAL', value } };
}

let cachedToken = null; // { token, exp, email }

class Firestore {
  constructor(env) {
    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT が未設定です');
    this.sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    this.root = 'projects/' + this.sa.project_id + '/databases/(default)/documents';
    this.base = 'https://firestore.googleapis.com/v1/' + this.root;
    this.count = 0;
  }
  reserve() {
    if (this.count >= SUBREQUEST_BUDGET) throw new Error('request-budget');
    this.count++;
  }
  async commit(writes) {
    const res = await this.call('POST',this.base+':commit',{writes});
    if (res.ok) return true;
    if ([400,404,409,412].includes(res.status)) return false;
    throw new Error('commit failed '+res.status);
  }
  async token() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.email === this.sa.client_email && cachedToken.exp - 60 > now) return cachedToken.token;
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.sa.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    };
    const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
    const key = await crypto.subtle.importKey('pkcs8', pemToBytes(this.sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const jwt = unsigned + '.' + b64url(new Uint8Array(sig));
    this.reserve();
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
    });
    if (!res.ok) throw new Error('Googleの認証に失敗しました: ' + res.status + ' ' + await res.text());
    const data = await res.json();
    cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600), email: this.sa.client_email };
    return cachedToken.token;
  }
  async call(method, url, body) {
    const token = await this.token();
    this.reserve();
    const res = await fetch(url, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }
  async get(path) {
    const res = await this.call('GET', this.base + '/' + path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('get ' + path + ' ' + res.status + ' ' + await res.text());
    return parseDoc(await res.json(), this.root);
  }
  async set(path, obj) {
    const res = await this.call('PATCH', this.base + '/' + path, { fields: toFields(obj) });
    if (!res.ok) throw new Error('set ' + path + ' ' + res.status + ' ' + await res.text());
  }
  /* 指定した項目だけ更新。updateTime を渡すと「その時点から変わっていない時だけ」更新し、失敗なら false */
  async patch(path, obj, fieldPaths, updateTime) {
    let url = this.base + '/' + path + '?' + fieldPaths.map((f) => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
    if (updateTime) url += '&currentDocument.updateTime=' + encodeURIComponent(updateTime);
    const res = await this.call('PATCH', url, { fields: toFields(obj) });
    if (res.ok) return true;
    if (res.status === 400 || res.status === 409 || res.status === 412 || res.status === 404) return false;
    throw new Error('patch ' + path + ' ' + res.status + ' ' + await res.text());
  }
  async delete(path) {
    const res = await this.call('DELETE', this.base + '/' + path);
    if (!res.ok && res.status !== 404) throw new Error('delete ' + path + ' ' + res.status);
  }
  async list(collectionPath, mask) {
    const out = [];
    let pageToken = '';
    do {
      let url = this.base + '/' + collectionPath + '?pageSize=300';
      for (const f of mask || []) url += '&mask.fieldPaths=' + encodeURIComponent(f);
      if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
      const res = await this.call('GET', url);
      if (!res.ok) throw new Error('list ' + collectionPath + ' ' + res.status + ' ' + await res.text());
      const data = await res.json();
      for (const d of data.documents || []) out.push(parseDoc(d, this.root));
      pageToken = data.nextPageToken || '';
    } while (pageToken && this.count < SUBREQUEST_BUDGET);
    return out;
  }
  async query(parentPath, structuredQuery) {
    const url = this.base + (parentPath ? '/' + parentPath : '') + ':runQuery';
    const res = await this.call('POST', url, { structuredQuery });
    if (!res.ok) throw new Error('query ' + parentPath + ' ' + res.status + ' ' + await res.text());
    const rows = await res.json();
    return rows.filter((r) => r.document).map((r) => parseDoc(r.document, this.root));
  }
}

function parseDoc(doc, root) {
  const path = doc.name.slice(doc.name.indexOf(root) + root.length + 1);
  return { path, id: path.split('/').pop(), updateTime: doc.updateTime, fields: fromFields(doc.fields || {}) };
}
function fromFields(fields) {
  const o = {};
  for (const k of Object.keys(fields)) o[k] = fromValue(fields[k]);
  return o;
}
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return undefined;
}
function toFields(obj) {
  const f = {};
  for (const k of Object.keys(obj)) f[k] = toValue(obj[k]);
  return f;
}
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  throw new Error('unsupported value');
}

function pemToBytes(pem) {
  const b = atob(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
