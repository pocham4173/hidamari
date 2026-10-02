/* まいにこ LINE送信役（Cloudflare Workers・無料プラン用）2026-10-01 作り直し版
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
 *     - おまもりタグが読み取られたら、LINE連携した家族(ご本人以外)へ知らせる。
 *  3. 月200通(無料プラン)を守る上限ガード
 *     - 残りが TAG_RESERVE 通以下になったら予定のお知らせを止め、タグの分を残す
 *     - 家庭ごとに1日 HOUSEHOLD_DAILY_LIMIT 通まで(タグは止めずに数だけ数える)
 *     - タグごとに1時間 TAG_HOURLY_LIMIT 回・1日 TAG_DAILY_LIMIT 回まで
 *     - 1回の見回りで知らせるタグの読み取りは TAGS_PER_RUN 件まで(残りは次の回)
 *     - 残り通数は lineStatus/quota に書き、家族が設定画面で見られる
 *  4. LINEでログイン(2026-10-01追加・/auth/line/〜)
 *     - 既存のまいにこアカウント(Firebase UID)に、LINEログイン用のつながりを本人確認のうえで結びつける
 *     - つないだLINEで本人確認できたら、同じUIDでまいにこに入れる(新しいUIDや家庭は作らない)
 *     - 予定のお知らせ用の連携(lineLinks)とは別の記録で、お知らせ用の連携だけではログインできない
 *
 * 設定する秘密の値（Cloudflareの「設定 → 変数とシークレット」に、種類「シークレット」で登録）
 *  LINE_CHANNEL_SECRET        … LINE Developers の チャネルシークレット
 *  LINE_CHANNEL_ACCESS_TOKEN  … LINE Developers の チャネルアクセストークン（長期）
 *  FIREBASE_SERVICE_ACCOUNT   … Firebase の サービスアカウント秘密鍵（JSONファイルの中身をまるごと）
 *  LINE_LOGIN_CHANNEL_SECRET  … LINEログイン用チャネルの チャネルシークレット(LINEでログインを使うときだけ)
 * 設定する変数（種類「テキスト」。秘密ではない値）
 *  LINE_LOGIN_CHANNEL_ID      … LINEログイン用チャネルの チャネルID
 *  LINE_LOGIN_CALLBACK_URL    … LINE Developers に登録したコールバックURL（https://〜.workers.dev/auth/line/callback）
 *  LINE_LOGIN_APP_CHECK       … 通常は設定しない。"off" のときだけ App Check の確認を省く(障害調査用)
 * LINEでログインの3つが未設定のときは、ログイン機能だけが「準備中」になり、お知らせはこれまで通り動く。
 *
 * 送る内容は、予定の日付・時刻・場所・予定名・登録した人の名前だけ。
 * 服薬・体調・伝言などの記録は読みにも行かない。
 */

const APP_URL = 'https://pocham4173.github.io/hidamari/';
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const LATE_LIMIT_MS = 12 * 60 * 60 * 1000;   // 12時間以上遅れた通知は送らずに印だけ付ける
const CONSENT_VERSION = '2026-09-19.1';
const SUBREQUEST_BUDGET = 45;                // 無料プランの上限(50)より少し手前で止める
const HARD_BUDGET = 49;                      // 数の記録など、最後の後片付けだけはここまで使える
const TAG_RESERVE = 50;                      // 毎月、タグのお知らせ用に残す通数
const HOUSEHOLD_DAILY_LIMIT = 20;            // 1家庭1日あたりの通数(予定のお知らせを止める目安)
const TAG_HOURLY_LIMIT = 3, TAG_DAILY_LIMIT = 10;
const TAGS_PER_RUN = 3;                      // 1回の見回りで知らせるタグの読み取り
const TAG_SCAN_PER_RUN = 8;                  // 1回の見回りで調べる使用中のタグ(多いときは8件ずつ順番に)
const TAG_REQUEST_BUDGET = 30;               // タグの処理に使う通信の上限。残りは予定のお知らせに回す
                                             // (途中で止まった読み取りは、次の回に同じ再送キーで続きから送る)
const VERSION_TEXT = '版：2026-10-01 作り直し・上限ガードつき・LINEでログイン';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/line' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (url.pathname.startsWith('/auth/line/')) {
      return handleLineAuth(request, env, url);
    }
    if (url.pathname === '/' || url.pathname === '/line') {
      const missing = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'FIREBASE_SERVICE_ACCOUNT']
        .filter((k) => !env[k]);
      const loginMissing = LINE_LOGIN_SETTINGS.filter((k) => !env[k]);
      const body = (missing.length
        ? 'まいにこ LINE送信役：まだ設定が足りません → ' + missing.join('、')
        : 'まいにこ LINE送信役は動いています（' + VERSION_TEXT + '）') +
        '\nLINEでログイン：' + (loginMissing.length ? '準備中（未設定 → ' + loginMissing.join('、') + '）' : '設定済み');
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
    await removeLinksFor(fs, lineUserId, 'block');
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') {
    if (ev.replyToken) return reply(env, ev.replyToken, MSG_HELP);
    return;
  }
  const raw = String(ev.message.text || '');
  const text = raw.normalize('NFKC').toUpperCase().replace(/[\s\-ー－_]/g, '');
  if (text === '解除' || text === '連携解除') {
    const n = await removeLinksFor(fs, lineUserId, 'line');
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
  const now = new Date();
  const consumed = await fs.commit([
    {delete: fs.root + '/lineLinkCodes/' + code, currentDocument: {updateTime: c.updateTime}},
    {update: {name: fs.root + '/lineLinks/' + uid,
      fields: toFields({lineUserId, groupId, linkedAt: now})}},
    linkLogWrite(fs, groupId, uid, member.name, 'linked', 'code', now)
  ]);
  if (!consumed) return NG;
  const name = typeof member.name === 'string' && member.name ? member.name + 'さん、' : '';
  return name + 'LINE連携しました。\n\nまいにこで「LINEで知らせる日時」を入れた予定が、このLINEに届きます。\n' +
    'やめるときは、アプリの設定で解除するか、「解除」と送ってください。';
}

async function removeLinksFor(fs, lineUserId, via) {
  const docs = await fs.query('', {
    from: [{ collectionId: 'lineLinks' }],
    where: fieldEq('lineUserId', { stringValue: lineUserId }),
  });
  for (const d of docs) {
    const uid = d.id, groupId = d.fields.groupId;
    const group = typeof groupId === 'string' && groupId ? await fs.get('groups/' + groupId) : null;
    if (!group || group.fields.deletionState === 'deleting') { await fs.delete(d.path); continue; }
    const m = await fs.get('groups/' + groupId + '/members/' + uid);
    // 解除と「解除した記録」は一緒に書く(片方だけ残らない)
    const ok = await fs.commit([
      {delete: fs.root + '/' + d.path, currentDocument: {updateTime: d.updateTime}},
      linkLogWrite(fs, groupId, uid, m && m.fields.name, 'unlinked', via, new Date())
    ]);
    if (!ok) await fs.delete(d.path);
  }
  return docs.length;
}

/* LINE連携の記録(2026-09-29): 家庭の events に type:'line-link-log' で残す。家族全員が設定画面で見られる。
   LINEの利用者識別子は記録に入れない。 */
function jstDateString(d) { return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
function linkLogWrite(fs, groupId, uid, name, action, via, at) {
  const id = 'line' + crypto.randomUUID().replace(/-/g, '');
  return {update: {name: fs.root + '/groups/' + groupId + '/events/' + id,
    fields: toFields({type: 'line-link-log', action, via, uid, name: typeof name === 'string' ? name : '',
      date: jstDateString(at), at, clientAt: at.getTime()})},
    currentDocument: {exists: false}};
}

/* 承認済みで、退会処理中でもなく、家庭が削除中でもない人だけ */
async function approvedMember(fs, groupId, uid, groupCache) {
  // groupCache: 同じ見回りの中で家庭の文書を読み直さないための控え(タグの処理だけで使う)
  let group;
  if (groupCache && groupCache.has(groupId)) group = groupCache.get(groupId);
  else { group = await fs.get('groups/' + groupId); if (groupCache) groupCache.set(groupId, group); }
  if (!group || group.fields.deletionState === 'deleting') return null;
  const m = await fs.get('groups/' + groupId + '/members/' + uid);
  if (!m) return null;
  const status = m.fields.status === undefined ? 'approved' : m.fields.status;
  if (status !== 'approved') return null;
  if (await fs.get('accountClosures/' + uid)) return null;
  const consent = await fs.get('consents/' + uid);
  if (!validConsent(consent && consent.fields)) return null;
  return { ...m.fields, consentMode: consent.fields.mode };
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
  const book = new UsageBook(fs, now);
  try {
    // 期限切れの手続きの片付けは、通知より先に、決まった通信回数だけで行う(忙しい回でも後回しにならない)
    await cleanupAuthTx(fs, now);
    book.quota = await lineQuota(env, fs);
    // おまもりタグのお知らせを先に送る(予定のお知らせより急ぐため)。失敗しても予定の送信は続ける。
    fs.softLimit = TAG_REQUEST_BUDGET;
    try { sent += await runTagAlerts(env, fs, now, book); }
    catch (e) { if (e.message === 'request-budget' && fs.count >= SUBREQUEST_BUDGET) throw e; console.error('tag alerts', e.message); }
    finally { fs.softLimit = 0; }
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
          await fs.patch(y.path, {notifyAt:null, notifiedAt:null, notificationStatus:'expired',
            notifyLog: appendNotifyLog(y.fields.notifyLog, {status:'expired', at:now, scheduledAt:at})},
            ['notifyAt','notifiedAt','notificationStatus','notifyLog'], y.updateTime);
          continue;
        }
        const links = await fs.query('', {from:[{collectionId:'lineLinks'}],
          where:fieldEq('groupId',{stringValue:g.id})});
        // 上限ガード: 月の残りが少ない・この家庭の今日の分を使い切ったときは送らず、理由を記録に残す
        const recipients = new Set(links.map(l => l.fields.lineUserId).filter(v => typeof v === 'string' && v)).size;
        const blocked = recipients ? await book.scheduleBlocked(g.id, recipients) : '';
        if (blocked) {
          await fs.patch(y.path, {notifyAt:null, notifiedAt:null, notificationStatus:'limited',
            notifyLog: appendNotifyLog(y.fields.notifyLog, {status:'limited', reason:blocked, at:now, scheduledAt:at})},
            ['notifyAt','notifiedAt','notificationStatus','notifyLog'], y.updateTime);
          continue;
        }
        const members = await fs.list(g.path + '/members', ['name']);
        const owner = members.find(m => m.id === y.fields.uid);
        const text = buildMessage(y.fields, owner && owner.fields.name || '', now, g.id, y.id);
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
          const r = await push(env, fs, to, receipt.fields.text, key);
          if (!r) {complete=false;continue;}
          if (r === 'sent') { sent++; await book.count(g.id); }
          accepted++;
          // A crash before this write is safe: LINE recognizes the same retry key.
          await fs.set(receiptPath, {acceptedAt:new Date(), expiresAt:new Date(at.getTime()+13*3600000)});
        }
        if (complete && accepted > 0) {
          const sentAt = new Date();
          await fs.patch(y.path, {notifyAt:null, notifiedAt:sentAt, notificationStatus:'accepted',
            notifyLog: appendNotifyLog(y.fields.notifyLog, {status:'accepted', at:sentAt, scheduledAt:at, count:accepted})},
            ['notifyAt','notifiedAt','notificationStatus','notifyLog'], y.updateTime);
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
    // LINEでログインのつながりのうち、削除済み・終了手続き中のアカウントの分を1時間に1件だけ片付ける
    // (読み取り回数を抑えるため毎回は見ない。つなぎ直しのときは callback でもその場で片付ける)
    if (Math.floor(now.getTime() / 900000) % 4 === 0) await cleanupLoginLink(fs, now);
    // Bounded maintenance. Never infer a deleted household from a partial list.
    for (const collectionId of ['lineLinkCodes','lineDeliveryReceipts','tagAlertReceipts','tagAlertCounters','lineUsage']) {
      const expired = await fs.query('', {from:[{collectionId}],
        where:{fieldFilter:{field:{fieldPath:'expiresAt'},op:'LESS_THAN_OR_EQUAL',value:{timestampValue:now.toISOString()}}},limit:3});
      for (const d of expired) await fs.delete(d.path);
    }
  } catch (e) {
    if (e.message !== 'request-budget') throw e;
    // Pending schedules retain their notifyAt and receipts for the next run.
  } finally {
    // 数えた通数と残り通数は、途中で止まっても必ず書き残す(最後の後片付け枠を使う)
    try { await book.flush(); } catch (e) { console.error('usage flush', e.message); }
  }
  console.log('notifications accepted:', sent, 'requests:', fs.count);
}

/* ================= 月200通を守る上限ガード(2026-10-01) =================
 * 残り通数は LINE から取得する。取れないときは止めない(無料プランは超えても課金されず、送れなくなるだけ)。
 * 家庭ごとの通数は lineUsage/{家庭}、タグごとの回数は tagAlertCounters/{タグ} に、日本時間の日付ごとに数える。 */
async function lineQuota(env, fs) {
  try {
    const get = async (path) => {
      fs.reserve();
      const res = await fetch('https://api.line.me/v2/bot/message/' + path,
        { headers: { authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN } });
      return res.ok ? res.json() : null;
    };
    const q = await get('quota');
    if (!q) return null;
    const c = await get('quota/consumption');
    if (!c || !Number.isFinite(Number(c.totalUsage))) return null;
    const used = Number(c.totalUsage);
    if (q.type !== 'limited' || !Number.isFinite(Number(q.value))) return { limit: null, used };
    return { limit: Number(q.value), used };
  } catch (e) {
    if (e.message === 'request-budget') throw e;
    return null;
  }
}
function jstHourString(d) { return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 13); }
class UsageBook {
  constructor(fs, now) { this.fs = fs; this.now = now; this.day = jstDateString(now); this.quota = null; this.homes = new Map(); this.dirty = new Set(); this.quotaDirty = false; }
  remaining() { return this.quota && this.quota.limit !== null ? this.quota.limit - this.quota.used : Infinity; }
  async home(groupId) {
    if (!this.homes.has(groupId)) {
      const d = await this.fs.get('lineUsage/' + groupId);
      const f = d ? d.fields : {};
      this.homes.set(groupId, f.day === this.day && Number.isFinite(f.count) ? f.count : 0);
    }
    return this.homes.get(groupId);
  }
  /* 予定のお知らせを止める理由(止めないときは空文字) */
  async scheduleBlocked(groupId, recipients) {
    if (this.remaining() - recipients < TAG_RESERVE) return 'monthly';
    if (await this.home(groupId) + recipients > HOUSEHOLD_DAILY_LIMIT) return 'household';
    return '';
  }
  canSendTag(recipients) { return this.remaining() >= Math.max(1, recipients || 1); }
  async count(groupId) {
    this.homes.set(groupId, await this.home(groupId) + 1);
    this.dirty.add(groupId);
    if (this.quota) { this.quota.used++; this.quotaDirty = true; }
  }
  async flush() {
    for (const groupId of this.dirty) {
      await this.fs.set('lineUsage/' + groupId, { day: this.day, count: this.homes.get(groupId), updatedAt: new Date(), expiresAt: new Date(this.now.getTime() + 2 * 86400000) }, true);
    }
    this.dirty.clear();
    if (this.quota) {
      const remaining = this.quota.limit === null ? null : Math.max(0, this.quota.limit - this.quota.used);
      await this.fs.set('lineStatus/quota', { limit: this.quota.limit, used: this.quota.used, remaining,
        reserve: TAG_RESERVE, checkedAt: new Date() }, true);
    }
  }
}

/* ================= おまもりタグのお知らせ(2026-09-30) =================
 * 読み取った方が状況を選ぶと watchTags/{tagId}/alerts/{送った人} が書かれる(同じ人は10分ごと)。
 * まだLINEで知らせていないものを、その家庭でLINE連携した承認済みの家族へ送る。
 * 送る内容は「状況」と「時刻」だけ。読み取った方の情報や本人の名前は送らない。 */
const TAG_SITUATIONS = { lost: '道に迷っているようです', unwell: '体調が心配です', safe: '安全な場所にいます', called: '警察・救急へ連絡しました' };
const TAG_WINDOW_MS = 2 * 60 * 60 * 1000;   // 2時間より前の読み取りは送らない
async function runTagAlerts(env, fs, now, book) {
  let sent = 0, handled = 0;
  // 同じ見回りの中では、家族の承認状態の確認を使い回す(通信回数を節約)
  const memberCache = new Map(), groupCache = new Map();
  const checkMember = async (groupId, uid) => {
    const k = groupId + '/' + uid;
    if (!memberCache.has(k)) memberCache.set(k, await approvedMember(fs, groupId, uid, groupCache));
    return memberCache.get(k);
  };
  // 使用中のタグごとに、新しい読み取りから5件だけ見る(古い記録がいくら増えても新しい分を拾える)
  const tags = await fs.query('', { from: [{ collectionId: 'watchTags' }], where: fieldEq('active', { booleanValue: true }), limit: 100 });
  // 8件ずつ順番に調べる(16件あれば30分ごとに一巡。1件ずつずらすと、読み取りの2時間を過ぎてしまうため)
  const offset = tags.length ? (Math.floor(now.getTime() / 900000) * TAG_SCAN_PER_RUN) % tags.length : 0;
  const scan = [...tags.slice(offset), ...tags.slice(0, offset)].slice(0, TAG_SCAN_PER_RUN);
  for (const tag of scan) {
    if (handled >= TAGS_PER_RUN || fs.count >= TAG_REQUEST_BUDGET) break;
    const groupId = tag.fields.groupId;
    const rows = await fs.query(tag.path, { from: [{ collectionId: 'alerts' }],
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }], limit: 5 });
    for (const a of rows) {
      if (handled >= TAGS_PER_RUN || fs.count >= TAG_REQUEST_BUDGET) break;
      // 9/30版の名残: 読み取り者の文書に付けた印は、読み取りページの再送を妨げるので取り除く
      if ('lineNotifiedAt' in a.fields) await fs.patch(a.path, {}, ['lineNotifiedAt'], a.updateTime);
      const at = a.fields.createdAt;
      if (!(at instanceof Date) || now.getTime() - at.getTime() > TAG_WINDOW_MS) continue;
      // 送った印は、読み取り者の文書ではなく別の置き場(tagAlertReceipts)に残す
      const receiptPath = 'tagAlertReceipts/' + await deliveryKey(a.path);
      const receipt = await fs.get(receiptPath);
      const done = receipt && receipt.fields.notifiedCreatedAt;
      if (done instanceof Date && done.getTime() >= at.getTime()) continue;
      handled++;
      const mark = (result) => fs.set(receiptPath, { notifiedCreatedAt: at, result, expiresAt: new Date(at.getTime() + TAG_WINDOW_MS + 3600000) });
      if (typeof groupId !== 'string' || !groupId) { await mark('no-home'); continue; }
      // 前の回で途中まで送った読み取りなら、送り終えた相手を控えから続ける(家族が多いと1回で送り切れないため)
      const started = receipt && receipt.fields.pendingAt instanceof Date && receipt.fields.pendingAt.getTime() === at.getTime();
      const sentTo = new Set(started && Array.isArray(receipt.fields.sentTo) ? receipt.fields.sentTo : []);
      // タグごとの上限(いたずらで通数を使い切らないように)。超えた分はアプリの中だけに出る。続きの送信は止めない
      const counter = await tagCounter(fs, tag.id, now);
      if (!started && (counter.hourCount >= TAG_HOURLY_LIMIT || counter.dayCount >= TAG_DAILY_LIMIT)) { await mark('tag-limit'); continue; }
      const links = await fs.query('', { from: [{ collectionId: 'lineLinks' }], where: fieldEq('groupId', { stringValue: groupId }) });
      // 月の残りが、この家族へ送る人数に足りないときは送らない(途中まで届いて残りが毎回やり直しになるのを防ぐ)
      const linked = new Set(links.map((l) => l.fields.lineUserId).filter((v) => typeof v === 'string' && v)).size;
      if (!started && !book.canSendTag(linked)) { await mark('monthly'); continue; }
      const text = buildTagMessage(a.fields, at);
      let complete = true, reached = 0;
      const seen = new Set();
      try {
        for (const link of links) {
          const to = link.fields.lineUserId;
          if (typeof to !== 'string' || !to || seen.has(to)) continue;
          // 同じ読み取り・同じ相手には同じ再送キーを使う(LINE側で二重送信を防ぐ)
          const key = await deliveryKey(a.path + '\n' + at.toISOString() + '\n' + to);
          if (sentTo.has(key)) { seen.add(to); reached++; continue; }
          const member = await checkMember(groupId, link.id);
          if (!member) continue;
          // ご本人には送らない(「ご本人に電話して」という家族向けの知らせのため)
          if (member.mode === 'honnin' || member.role === 'honnin' || member.consentMode === 'honnin') continue;
          seen.add(to);
          const r = await push(env, fs, to, text, key);
          if (!r) { complete = false; continue; }
          reached++; sentTo.add(key);
          if (r === 'sent') { sent++; await book.count(groupId); }
        }
      } catch (e) {
        // 通信の上限で止まったら、送り終えた相手を控えて次の回に続きから送る(後片付け枠で書く)
        if (e.message === 'request-budget' && sentTo.size) {
          try { await fs.set(receiptPath, { pendingAt: at, sentTo: [...sentTo], expiresAt: new Date(at.getTime() + TAG_WINDOW_MS + 3600000) }, true); } catch (ignore) {}
        }
        throw e;
      }
      if (complete) {
        if (reached) await fs.set('tagAlertCounters/' + tag.id, {
          day: counter.day, dayCount: counter.dayCount + 1, hour: counter.hour, hourCount: counter.hourCount + 1,
          expiresAt: new Date(now.getTime() + 2 * 86400000) });
        await mark(reached ? 'sent' : 'no-recipient');
      }
    }
  }
  return sent;
}
async function tagCounter(fs, tagId, now) {
  const day = jstDateString(now), hour = jstHourString(now);
  const d = await fs.get('tagAlertCounters/' + tagId);
  const f = d ? d.fields : {};
  return { day, hour,
    dayCount: f.day === day && Number.isFinite(f.dayCount) ? f.dayCount : 0,
    hourCount: f.hour === hour && Number.isFinite(f.hourCount) ? f.hourCount : 0 };
}
function buildTagMessage(f, at) {
  const j = new Date(at.getTime() + 9 * 3600 * 1000);
  const when = (j.getUTCMonth() + 1) + '月' + j.getUTCDate() + '日 ' + String(j.getUTCHours()).padStart(2, '0') + ':' + String(j.getUTCMinutes()).padStart(2, '0');
  const situation = TAG_SITUATIONS[f.situation] || '読み取られました';
  return ['🔔 おまもりタグのお知らせ（まいにこ）',
    '読み取った方から「' + situation + '」と届きました（' + when + '）。',
    'まず、ご本人に電話などで連絡してみてください。',
    '急ぐとき・危ないときは、119番・110番へ。',
    '', 'まいにこで確認する', APP_URL + '?openExternalBrowser=1'].join('\n');
}

async function deliveryKey(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}

function buildMessage(y, ownerName, now, groupId, scheduleId) {
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
  const url = APP_URL + '?openExternalBrowser=1#schedule=' + encodeURIComponent(scheduleId) + '&group=' + encodeURIComponent(groupId);
  lines.push('', 'カレンダーでこの予定を確認する', url);
  return lines.join('\n');
}
function clip(v, n) { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) + '…' : s; }

/* ================= LINEでログイン(2026-10-01) =================
 * 予定のお知らせ用の連携(lineLinks)とは別に、ログイン用のつながりをサーバーだけが記録する。
 *  lineLoginLinks/{LINEの鍵}   … { uid, linkedAt }      LINE → まいにこのUID(1つのLINEは1つのUIDだけ)
 *  lineLoginAccounts/{uid}     … { lineKey, linkedAt }  UID → LINE(1つのUIDは1つのLINEだけ)。本人は見るだけ
 *  lineAuthTx/{手続き番号}      … 10分だけ有効な一回限りの手続き(state・nonce・PKCE・確認番号)
 * LINEの鍵は LINEの利用者識別子のハッシュ。識別子そのものは保存しない。
 *
 * 手順(つなぐ): 認証済みの画面 → start(Firebaseの確認) → LINEで本人確認 → callback で6桁の確認番号
 *   → 元の認証済み画面で確認番号を入れて confirm(Firebaseの確認・LINEの確認・番号がすべてそろったときだけ記録)
 * 手順(ログイン): start(App Check) → LINEで本人確認 → callback で確認番号
 *   → 手続きを始めた画面だけが持つ合言葉と確認番号の両方で exchange → そのUIDのカスタムトークン(1回だけ)
 * Firebaseのトークンや合言葉はURLに載せない。確認番号は callback を開いた画面にだけ表示し、
 * 同じ画面(同じ保存領域)なら自動で、別の画面なら利用者が手で入れる。 */
const LINE_LOGIN_SETTINGS = ['LINE_LOGIN_CHANNEL_ID', 'LINE_LOGIN_CHANNEL_SECRET', 'LINE_LOGIN_CALLBACK_URL'];
const APP_ORIGIN = 'https://pocham4173.github.io';
const FIREBASE_PROJECT_NUMBER = '565713968884';
const FIREBASE_WEB_APP_ID = '1:565713968884:web:0a9665d1fe5e0fa161c8a1';
const LINE_AUTH_TTL_MS = 10 * 60 * 1000;    // LINEで確認するまでの時間
const LINE_CODE_TTL_MS = 5 * 60 * 1000;     // 確認番号を入れるまでの時間
const LINE_CODE_ATTEMPTS = 5;               // 確認番号の入力は5回まで(超えたら手続きごと無効)
const CUSTOM_TOKEN_TTL_S = 300;
const TX_RE = /^[0-9a-f]{32}$/, SECRET_RE = /^[0-9a-f]{64}$/, CODE6_RE = /^[0-9]{6}$/;

class AuthProblem extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status || 400; }
}

function lineLoginConfigured(env) { return LINE_LOGIN_SETTINGS.every((k) => typeof env[k] === 'string' && env[k]); }
function corsHeaders() {
  return { 'access-control-allow-origin': APP_ORIGIN, 'vary': 'Origin',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-firebase-appcheck',
    'access-control-max-age': '600' };
}
function apiJson(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200,
    headers: { ...corsHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function handleLineAuth(request, env, url) {
  const route = url.pathname.slice('/auth/line/'.length);
  try {
    if (route === 'callback' && request.method === 'GET') return await lineCallback(env, url);
    if (route === 'callback-cancel' && request.method === 'POST') return await lineCallbackCancel(request, env);
    // ここから下はまいにこの画面からの呼び出しだけ(他サイトからの呼び出しは受けない)
    if ((request.headers.get('origin') || '') !== APP_ORIGIN) return new Response('forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== 'POST') return apiJson({ error: 'method' }, 405);
    if (!lineLoginConfigured(env)) return apiJson({ error: 'not-configured' }, 503);
    let body;
    try { body = await request.json(); } catch (e) { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiJson({ error: 'bad-request' }, 400);
    const fs = new Firestore(env);
    if (route === 'start') return apiJson(await lineStart(env, fs, request, body));
    if (route === 'status') return apiJson(await lineTxStatus(env, fs, request, body));
    if (route === 'confirm') return apiJson(await lineConfirmLink(env, fs, request, body));
    if (route === 'exchange') return apiJson(await lineExchange(env, fs, request, body));
    if (route === 'cancel') return apiJson(await lineCancel(env, fs, request, body));
    if (route === 'unlink') return apiJson(await lineUnlink(env, fs, request));
    return apiJson({ error: 'not-found' }, 404);
  } catch (e) {
    if (e instanceof AuthProblem) {
      return route === 'callback' || route === 'callback-cancel'
        ? authPage(e.status, 'LINEでの確認', ['手続きを続けられませんでした。まいにこを開き直して、もう一度お試しください。'])
        : apiJson({ error: e.code }, e.status);
    }
    // 秘密の値やトークンは記録に出さない(種類だけ)
    console.error('line auth failed', route, e && e.name);
    return route === 'callback' || route === 'callback-cancel'
      ? authPage(503, 'LINEでの確認', ['通信の確認ができませんでした。まいにこの記録や設定は変わっていません。時間をおいて、もう一度お試しください。'])
      : apiJson({ error: 'server' }, 503);
  }
}

/* ---- 開始 ---- */
async function lineStart(env, fs, request, body) {
  const purpose = body.purpose;
  if (purpose !== 'login' && purpose !== 'link') throw new AuthProblem('bad-request');
  if (typeof body.secretHash !== 'string' || !SECRET_RE.test(body.secretHash)) throw new AuthProblem('bad-request');
  let uid = null;
  if (purpose === 'link') {
    uid = (await verifyFirebaseUser(env, fs, request)).uid;
    await requireHousehold(fs, uid);
  } else {
    await verifyAppCheck(env, fs, request);
  }
  const tx = randomHex(16), state = tx + randomHex(16), nonce = randomHex(16);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const now = new Date(), expiresAt = new Date(now.getTime() + LINE_AUTH_TTL_MS);
  const ok = await fs.commit([{ update: { name: fs.root + '/lineAuthTx/' + tx, fields: toFields({
    purpose, uid, secretHash: body.secretHash, stateHash: await sha256Hex(state), nonce, verifier,
    status: 'started', attempts: 0, createdAt: now, expiresAt }) }, currentDocument: { exists: false } }]);
  if (!ok) throw new AuthProblem('retry', 503);
  const q = new URLSearchParams({ response_type: 'code', client_id: env.LINE_LOGIN_CHANNEL_ID,
    redirect_uri: env.LINE_LOGIN_CALLBACK_URL, state, scope: 'openid profile', nonce,
    code_challenge: challenge, code_challenge_method: 'S256', ui_locales: 'ja-JP' });
  return { tx, authorizeUrl: 'https://access.line.me/oauth2/v2.1/authorize?' + q.toString(), expiresAt: expiresAt.getTime() };
}

/* ---- LINEから戻ったところ(この画面だけに確認番号を出す) ---- */
async function lineCallback(env, url) {
  if (!lineLoginConfigured(env)) return authPage(503, 'LINEでの確認', ['LINEでログインは準備中です。']);
  const state = url.searchParams.get('state') || '';
  if (!/^[0-9a-f]{64}$/.test(state)) throw new AuthProblem('bad-state');
  const fs = new Firestore(env);
  const tx = state.slice(0, 32), path = 'lineAuthTx/' + tx;
  const t = await fs.get(path);
  if (!t || !safeEqual(t.fields.stateHash, await sha256Hex(state))) throw new AuthProblem('bad-state');
  const f = t.fields;
  const appLink = APP_URL + '#line-auth=' + tx;
  if (f.status !== 'started') {
    return authPage(409, 'LINEでの確認', ['この手続きは、すでに使われたか、取り消されています。まいにこを開き直して、もう一度お試しください。'], appLink);
  }
  // state は一度だけ使える(同じ戻り先を2回開いても、2回目は使えない)。以後の書き込みはこの版を条件にする
  let cur = await fs.patchDoc(path, { status: 'exchanging' }, ['status'], t.updateTime);
  if (!cur) {
    return authPage(409, 'LINEでの確認', ['この手続きは、すでに使われています。まいにこを開き直して、もう一度お試しください。'], appLink);
  }
  // 途中で取り消された・消された手続きを、あとから書き戻さない(条件が合わなければ何もしない)
  const finish = async (status, http, lines) => {
    if (cur) await fs.patch(path, { status, finishedAt: new Date() }, ['status', 'finishedAt'], cur.updateTime).catch(() => {});
    return authPage(http, 'LINEでの確認', lines, appLink);
  };
  try {
    return await lineCallbackVerified(env, fs, url, tx, path, f, appLink, finish, (doc) => { cur = doc; }, () => cur);
  } catch (e) {
    console.error('line callback failed', e && e.name);
    return finish('error', 503, ['確認の途中で通信がうまくいきませんでした。まいにこの記録や設定は変わっていません。時間をおいて、もう一度お試しください。']);
  }
}

async function lineCallbackVerified(env, fs, url, tx, path, f, appLink, finish, setCur, getCur) {
  if (!(f.expiresAt instanceof Date) || f.expiresAt.getTime() < Date.now()) {
    return finish('expired', 410, ['時間切れになりました（10分）。まいにこの記録や設定は変わっていません。まいにこを開き直して、もう一度お試しください。']);
  }
  const code = url.searchParams.get('code') || '';
  if (url.searchParams.get('error') || !code) {
    return finish('cancelled', 200, ['LINEでの確認を取り消しました。まいにこの記録や設定は変わっていません。']);
  }
  let claims;
  try {
    fs.reserve();
    const res = await fetch('https://api.line.me/oauth2/v2.1/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.LINE_LOGIN_CALLBACK_URL,
        client_id: env.LINE_LOGIN_CHANNEL_ID, client_secret: env.LINE_LOGIN_CHANNEL_SECRET, code_verifier: f.verifier }).toString() });
    if (!res.ok) throw new AuthProblem('line-token', 502);
    const token = await res.json();
    claims = await verifyLineIdToken(env, fs, token && token.id_token, f.nonce);
  } catch (e) {
    if (e && e.message === 'request-budget') throw e;
    return finish('error', 502, ['LINEでの本人確認を確かめられませんでした。まいにこの記録や設定は変わっていません。もう一度お試しください。']);
  }
  const lineKey = await sha256Hex('line-user|' + claims.sub);
  const confirmCode = randomDigits(6);
  const ready = { lineKey, codeHash: await sha256Hex(tx + '|' + confirmCode), attempts: 0,
    authenticatedAt: new Date(), expiresAt: new Date(Date.now() + LINE_CODE_TTL_MS) };
  const markReady = async (extra) => {
    const doc = await fs.patchDoc(path, { ...ready, ...extra, status: 'authenticated' }, [...Object.keys(ready), ...Object.keys(extra), 'status'], getCur().updateTime);
    if (!doc) return false;
    setCur(doc);
    return true;
  };
  const usedPage = () => authPage(409, 'LINEでの確認', ['この手続きは、途中で取り消されたか、時間切れになりました。まいにこの記録や設定は変わっていません。'], appLink);
  if (f.purpose === 'link') {
    let byLine = await fs.get('lineLoginLinks/' + lineKey);
    const byUid = await fs.get('lineLoginAccounts/' + f.uid);
    // 削除済み・終了手続き中のアカウントに残ったつながりは、生きている相手の上書きではないので片付けてよい
    if (byLine && byLine.fields.uid !== f.uid && await staleLoginLink(fs, byLine)) byLine = null;
    if (byLine && byLine.fields.uid !== f.uid) {
      return finish('conflict', 409, ['このLINEは、別のまいにこアカウントとつながっています。自動で付け替えたり、記録をまとめたりはしません。',
        'いつも使っているまいにこの設定で、どのLINEとつながっているかを確認してください。まいにこの記録や設定は変わっていません。']);
    }
    if (byUid && byUid.fields.lineKey !== lineKey) {
      return finish('conflict', 409, ['このまいにこアカウントは、別のLINEとつながっています。つなぎ直すときは、先にまいにこの設定で「LINEでログイン」を解除してください。まいにこの記録や設定は変わっていません。']);
    }
    const lineName = typeof claims.name === 'string' ? claims.name.slice(0, 40) : '';
    if (!await markReady({ lineName })) return usedPage();
    return authPage(200, 'LINEの確認ができました', [
      (lineName ? '確認したLINE：' + lineName + '\n' : '') + 'まいにこの「LINEとつなぐ」を押した画面に戻り、次の番号を入れて「このLINEとつなぐ」を押すと完了します（5分以内）。'],
      appLink + '&c=' + confirmCode, { code: confirmCode, tx, cancel: true,
        note: 'この番号を入れた画面のまいにこに、このLINEがつながります。ご自身で「LINEとつなぐ」を押していない場合や、人から頼まれた場合は、番号を誰にも伝えず、下の「取り消す」を押してください。',
        appLabel: 'この画面でまいにこを開く' });
  }
  const link = await fs.get('lineLoginLinks/' + lineKey);
  if (!link || typeof link.fields.uid !== 'string' || !link.fields.uid) {
    return finish('not-linked', 200, ['このLINEは、まいにこのアカウントとまだつながっていません。新しい登録はしていません。',
      'いつも使っているまいにこ（ホーム画面のアイコンなど）を開き、設定の「LINEでログイン」から「LINEとつなぐ」を押してください。',
      'はじめて使う方は、まいにこを開いて「はじめて使う」を選んでください。']);
  }
  if (!await accountUsable(fs, link.fields.uid)) {
    return finish('unavailable', 403, ['このLINEにつながっているまいにこアカウントは、いまはログインできません（削除・停止・終了手続き中など）。新しい登録はしていません。']);
  }
  if (!await markReady({ uid: link.fields.uid })) return usedPage();
  // 自動では移動しない: 番号を入れた人があなたのまいにこに入れるため、必ず本人が見て進む
  return authPage(200, 'LINEの確認ができました', [
    'この画面でまいにこを使うときは、下の「この画面でまいにこを開く」を押してください。',
    '別の画面（ホーム画面のまいにこなど）で「LINEで続ける」を押した場合は、その画面に戻って次の番号を入れてください（5分以内）。'],
    appLink + '&c=' + confirmCode, { code: confirmCode, tx, cancel: true,
      note: 'この番号を入れた人は、あなたのまいにこに入れます。ご自身で「LINEで続ける」を押していない場合や、電話・メッセージで番号を聞かれた場合は、誰にも伝えず、下の「取り消す」を押してください。',
      appLabel: 'この画面でまいにこを開く', cancelLabel: '取り消す（ログインしない）' });
}

/* 削除済み・終了手続き中のアカウントのつながりなら、条件つきで両方消して true */
async function staleLoginLink(fs, link) {
  const uid = link.fields.uid;
  if (typeof uid === 'string' && uid && await lookupAuthUser(fs, uid) && !await fs.get('accountClosures/' + uid)) return false;
  const writes = [{ delete: fs.root + '/' + link.path, currentDocument: { updateTime: link.updateTime } }];
  const acc = typeof uid === 'string' && uid ? await fs.get('lineLoginAccounts/' + uid) : null;
  if (acc && acc.fields.lineKey === link.id) writes.push({ delete: fs.root + '/' + acc.path, currentDocument: { updateTime: acc.updateTime } });
  return fs.commit(writes);
}

/* LINEから戻ったページの「取り消す」(番号を表示した画面からだけ取り消せる。つなぐ・ログインのどちらも) */
async function lineCallbackCancel(request, env) {
  if (!lineLoginConfigured(env)) throw new AuthProblem('not-configured', 503);
  const form = await request.formData();
  const tx = String(form.get('tx') || ''), code = String(form.get('c') || '');
  if (!TX_RE.test(tx) || !CODE6_RE.test(code)) throw new AuthProblem('bad-request');
  const fs = new Firestore(env);
  const t0 = await fs.get('lineAuthTx/' + tx);
  const gone = () => authPage(409, 'LINEでの確認', ['この手続きは、すでに終わっているか取り消されています。まいにこの記録や設定は変わっていません。']);
  if (!t0 || txState(t0) !== 'ready') return gone();
  let t;
  try { t = await checkConfirmCode(fs, t0, code); } catch (e) { if (e instanceof AuthProblem) return gone(); throw e; }
  const result = await cancelTx(fs, t);
  if (result === 'done') {
    return authPage(409, 'LINEでの確認', [t.fields.purpose === 'link'
      ? '取り消す前に、つなぐ手続きが完了していました。ご自身でつないでいない場合は、まいにこの設定「LINEでログイン」から解除してください。'
      : '取り消す前に、この番号でのログインが完了していました。心当たりがない場合は、まいにこの設定「LINEでログイン」の解除と、復旧用パスワードの変更をしてください。']);
  }
  if (result !== 'cancelled') return gone();
  return authPage(200, 'LINEでの確認', [t.fields.purpose === 'link'
    ? '取り消しました。このLINEは、まいにこにつながっていません。まいにこの記録や設定は変わっていません。'
    : '取り消しました。この番号では、まいにこに入れません。まいにこの記録や設定は変わっていません。']);
}

/* ---- 手続きの状態(始めた画面が合言葉で確かめる) ---- */
async function loadTx(fs, body, purpose) {
  if (typeof body.tx !== 'string' || !TX_RE.test(body.tx) || typeof body.secret !== 'string' || !SECRET_RE.test(body.secret)) {
    throw new AuthProblem('bad-request');
  }
  const t = await fs.get('lineAuthTx/' + body.tx);
  if (!t || !safeEqual(t.fields.secretHash, await sha256Hex(body.secret))) throw new AuthProblem('not-found', 404);
  if (purpose && t.fields.purpose !== purpose) throw new AuthProblem('not-found', 404);
  return t;
}
function txState(t) {
  const f = t.fields, s = f.status;
  if (['started', 'exchanging', 'authenticated'].includes(s) && (!(f.expiresAt instanceof Date) || f.expiresAt.getTime() < Date.now())) return 'expired';
  if (s === 'started' || s === 'exchanging') return 'waiting';
  if (s === 'authenticated') return 'ready';
  return s;   // done / cancelled / expired / conflict / not-linked / unavailable / locked / error
}
async function lineTxStatus(env, fs, request, body) {
  const t = await loadTx(fs, body);
  if (t.fields.purpose === 'link') {
    const user = await verifyFirebaseUser(env, fs, request);
    if (user.uid !== t.fields.uid) throw new AuthProblem('wrong-account', 403);
  } else {
    await verifyAppCheck(env, fs, request);
  }
  const state = txState(t);
  const out = { purpose: t.fields.purpose, status: state, expiresAt: t.fields.expiresAt instanceof Date ? t.fields.expiresAt.getTime() : 0 };
  if (t.fields.purpose === 'link' && state === 'ready') out.lineName = typeof t.fields.lineName === 'string' ? t.fields.lineName : '';
  return out;
}
/* 確認番号を1回試す。先に試行回数を条件つきで1つ増やし、増やせたときだけ番号を比べる
   (同時にたくさん送っても、比べた回数は必ず数えられる)。成功したら更新後の手続きを返す */
async function checkConfirmCode(fs, t, code) {
  const attempts = Number.isFinite(t.fields.attempts) ? t.fields.attempts : 0;
  if (attempts >= LINE_CODE_ATTEMPTS) throw new AuthProblem('locked', 429);
  const n = attempts + 1;
  const counted = await fs.patchDoc(t.path, { attempts: n }, ['attempts'], t.updateTime);
  if (!counted) throw new AuthProblem('retry', 409);
  const ok = typeof code === 'string' && CODE6_RE.test(code)
    && safeEqual(t.fields.codeHash, await sha256Hex(t.id + '|' + code));
  if (ok) return counted;
  if (n >= LINE_CODE_ATTEMPTS) {
    await fs.patch(counted.path, { status: 'locked' }, ['status'], counted.updateTime);
    throw new AuthProblem('locked', 429);
  }
  throw new AuthProblem('wrong-code', 400);
}
function requireReady(t) {
  const state = txState(t);
  if (state === 'ready') return;
  throw new AuthProblem(state === 'waiting' ? 'not-ready' : state === 'expired' ? 'expired' : 'used', state === 'waiting' ? 409 : 410);
}
function txDone(fs, t, status) {
  return { update: { name: fs.root + '/' + t.path, fields: toFields({ ...t.fields, status, finishedAt: new Date() }) },
    currentDocument: { updateTime: t.updateTime } };
}

/* ---- つなぐ(元の認証済み画面で確定) ---- */
async function lineConfirmLink(env, fs, request, body) {
  const user = await verifyFirebaseUser(env, fs, request);
  const t0 = await loadTx(fs, body, 'link');
  if (t0.fields.uid !== user.uid) throw new AuthProblem('wrong-account', 403);
  requireReady(t0);
  const t = await checkConfirmCode(fs, t0, body.code);
  await requireHousehold(fs, user.uid);
  const lineKey = t.fields.lineKey, now = new Date();
  if (typeof lineKey !== 'string' || !/^[0-9a-f]{64}$/.test(lineKey)) throw new AuthProblem('used', 410);
  const ok = await fs.commit([
    txDone(fs, t, 'done'),
    { update: { name: fs.root + '/lineLoginLinks/' + lineKey, fields: toFields({ uid: user.uid, linkedAt: now }) }, currentDocument: { exists: false } },
    { update: { name: fs.root + '/lineLoginAccounts/' + user.uid, fields: toFields({ lineKey, linkedAt: now }) }, currentDocument: { exists: false } },
  ]);
  if (ok) return { linked: true };
  // 何もしていない。すでに同じ組み合わせで記録済みなら完了扱い、違う相手なら止める(上書き・統合はしない)
  const [byLine, byUid] = [await fs.get('lineLoginLinks/' + lineKey), await fs.get('lineLoginAccounts/' + user.uid)];
  if (byLine && byUid && byLine.fields.uid === user.uid && byUid.fields.lineKey === lineKey) {
    const latest = await fs.get(t.path);
    if (latest && latest.fields.status === 'authenticated') await fs.commit([txDone(fs, latest, 'done')]);
    return { linked: true, already: true };
  }
  if ((byLine && byLine.fields.uid !== user.uid) || (byUid && byUid.fields.lineKey !== lineKey)) {
    const latest = await fs.get(t.path);
    if (latest && latest.fields.status === 'authenticated') await fs.commit([txDone(fs, latest, 'conflict')]);
    throw new AuthProblem('conflict', 409);
  }
  throw new AuthProblem('retry', 409);
}

/* ---- ログイン(始めた画面の合言葉 + 確認番号 → 1回だけのカスタムトークン) ---- */
async function lineExchange(env, fs, request, body) {
  await verifyAppCheck(env, fs, request);
  const t0 = await loadTx(fs, body, 'login');
  requireReady(t0);
  const t = await checkConfirmCode(fs, t0, body.code);
  const uid = t.fields.uid, lineKey = t.fields.lineKey;
  if (typeof lineKey !== 'string' || !/^[0-9a-f]{64}$/.test(lineKey)) throw new AuthProblem('used', 410);
  if (!await authUserState(fs, uid)) throw new AuthProblem('account-unavailable', 403);
  // つながり・終了手続き・手続きの状態の確認と、交換の確定を1つのトランザクションで行う。
  // 確認のあとに解除・終了手続き・取り消しが先に確定したら、この確定は失敗し、トークンは発行しない。
  const txn = await fs.beginTransaction();
  let committed = false;
  try {
    const cur = await fs.get(t.path, txn);
    const link = await fs.get('lineLoginLinks/' + lineKey, txn);
    const closure = await fs.get('accountClosures/' + uid, txn);
    if (!cur || cur.updateTime !== t.updateTime || cur.fields.status !== 'authenticated') throw new AuthProblem('used', 410);
    if (!link || link.fields.uid !== uid) throw new AuthProblem('not-linked', 403);
    if (closure) throw new AuthProblem('account-unavailable', 403);
    committed = await fs.commit([txDone(fs, t, 'done')], txn);
  } finally {
    if (!committed) await fs.rollback(txn);
  }
  if (!committed) {
    const link = await fs.get('lineLoginLinks/' + lineKey);
    if (!link || link.fields.uid !== uid) throw new AuthProblem('not-linked', 403);
    throw new AuthProblem('used', 410);
  }
  return { customToken: await mintCustomToken(fs, uid) };
}

/* ---- 取り消し(データは何も変えない) ---- */
async function lineCancel(env, fs, request, body) {
  const result = await cancelTx(fs, await loadTx(fs, body));
  return { cancelled: result === 'cancelled', status: result };
}
/* 取り消しを条件つきで書く。書けなければ読み直して、まだ有効ならやり直す。
   'cancelled' は取り消しが確定したときだけ。ほかは実際の状態(done など)を返す */
async function cancelTx(fs, t) {
  for (let i = 0; i < 3 && t; i++) {
    if (t.fields.status === 'cancelled') return 'cancelled';
    if (!['started', 'exchanging', 'authenticated'].includes(t.fields.status)) return t.fields.status || 'unknown';
    if (await fs.patchDoc(t.path, { status: 'cancelled', finishedAt: new Date() }, ['status', 'finishedAt'], t.updateTime)) return 'cancelled';
    t = await fs.get(t.path);
  }
  return t ? 'retry' : 'gone';
}

/* ---- LINEでログインの解除(予定のお知らせの連携とは別) ---- */
async function lineUnlink(env, fs, request) {
  const user = await verifyFirebaseUser(env, fs, request, { allowClosing: true });
  const acc = await fs.get('lineLoginAccounts/' + user.uid);
  if (!acc) return { unlinked: true, already: true };
  const writes = [{ delete: fs.root + '/' + acc.path, currentDocument: { updateTime: acc.updateTime } }];
  const link = typeof acc.fields.lineKey === 'string' ? await fs.get('lineLoginLinks/' + acc.fields.lineKey) : null;
  if (link && link.fields.uid === user.uid) writes.push({ delete: fs.root + '/' + link.path, currentDocument: { updateTime: link.updateTime } });
  if (!await fs.commit(writes)) throw new AuthProblem('retry', 409);
  return { unlinked: true };
}

/* 期限切れのLINEでログインの手続きを片付ける(TTLは使わない: 無料プランでは使えないため)。
   1回の見回りで「検索1回 + まとめて削除1回」= 通信2回・最大 AUTH_TX_CLEANUP_LIMIT 件。
   古いものから消すので、途中で止まっても次の回にそのまま続く。期限切れの拒否は文書が残っていても txState で行う */
const AUTH_TX_CLEANUP_LIMIT = 20;
async function cleanupAuthTx(fs, now) {
  try {
    const expired = await fs.query('', { from: [{ collectionId: 'lineAuthTx' }],
      where: { fieldFilter: { field: { fieldPath: 'expiresAt' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: now.toISOString() } } },
      orderBy: [{ field: { fieldPath: 'expiresAt' }, direction: 'ASCENDING' }], limit: AUTH_TX_CLEANUP_LIMIT });
    if (!expired.length) return 0;
    // 調べたあとに更新された文書は消さない(条件つき)。1件でも条件が合わなければ全体が失敗するので、そのときは1件ずつ
    const writes = expired.map((d) => ({ delete: fs.root + '/' + d.path, currentDocument: { updateTime: d.updateTime } }));
    if (await fs.commit(writes)) return expired.length;
    let n = 0;
    for (const w of writes.slice(0, 3)) if (await fs.commit([w])) n++;
    return n;
  } catch (e) {
    if (e.message === 'request-budget') throw e;
    console.error('auth tx cleanup', e && e.name);
    return 0;
  }
}

/* 削除済み・終了手続き中のアカウントのつながりを片付ける(見回りで1回1件) */
async function cleanupLoginLink(fs, now) {
  try {
    const accounts = await fs.list('lineLoginAccounts', ['lineKey']);
    if (!accounts.length) return;
    const acc = accounts[Math.floor(now.getTime() / 3600000) % accounts.length];
    const user = await lookupAuthUser(fs, acc.id);
    if (user && !await fs.get('accountClosures/' + acc.id)) return;
    const writes = [{ delete: fs.root + '/' + acc.path, currentDocument: { updateTime: acc.updateTime } }];
    const link = typeof acc.fields.lineKey === 'string' ? await fs.get('lineLoginLinks/' + acc.fields.lineKey) : null;
    if (link && link.fields.uid === acc.id) writes.push({ delete: fs.root + '/' + link.path, currentDocument: { updateTime: link.updateTime } });
    await fs.commit(writes);
  } catch (e) {
    if (e.message === 'request-budget') throw e;
    console.error('login link cleanup', e && e.name);
  }
}

/* ---- 確認の部品 ---- */
async function requireHousehold(fs, uid) {
  const pointer = await fs.get('accounts/' + uid);
  const groupId = pointer && pointer.fields.groupId;
  if (typeof groupId !== 'string' || !groupId || !await approvedMember(fs, groupId, uid)) throw new AuthProblem('no-household', 403);
  return groupId;
}
async function lookupAuthUser(fs, uid) {
  const res = await fs.call('POST', 'https://identitytoolkit.googleapis.com/v1/projects/' + fs.sa.project_id + '/accounts:lookup', { localId: [uid] });
  if (!res.ok) throw new Error('auth lookup ' + res.status);
  const data = await res.json();
  const u = data && Array.isArray(data.users) ? data.users.find((x) => x && x.localId === uid) : null;
  return u || null;
}
/* 認証自体が有効か: 存在する・停止されていない・(claimsがあれば)失効していない。
   失効の判定は Firebase Admin SDK と同じく auth_time と validSince(tokensValidAfterTime)で比べる */
async function authUserState(fs, uid, claims) {
  if (typeof uid !== 'string' || !uid || uid.length > 128) return null;
  const user = await lookupAuthUser(fs, uid);
  if (!user || user.disabled === true) return null;
  if (claims && user.validSince !== undefined && !(Number(claims.auth_time) >= Number(user.validSince))) return null;
  return user;
}
/* 認証が有効で、終了手続き中(accountClosures)でもない */
async function accountUsable(fs, uid, claims) {
  const user = await authUserState(fs, uid, claims);
  if (!user || await fs.get('accountClosures/' + uid)) return null;
  return user;
}
async function verifyFirebaseUser(env, fs, request, opts) {
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') || '');
  if (!m) throw new AuthProblem('auth-required', 401);
  const projectId = fs.sa.project_id;
  const claims = await verifyJwt(fs, m[1], { alg: 'RS256',
    jwks: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com' }).catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  if (!claims || claims.aud !== projectId || claims.iss !== 'https://securetoken.google.com/' + projectId
    || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128
    || !(claims.exp > now) || !(claims.iat <= now + 60) || !(claims.auth_time <= now + 60)) {
    throw new AuthProblem('auth-required', 401);
  }
  // 認証自体の有効性(存在・停止・失効)は、どの操作でも必ず確かめる
  if (!await authUserState(fs, claims.sub, claims)) throw new AuthProblem('account-unavailable', 403);
  // 終了手続き中でも許すのは、つながりを減らす操作(解除)だけ
  if (!(opts && opts.allowClosing) && await fs.get('accountClosures/' + claims.sub)) throw new AuthProblem('account-unavailable', 403);
  return { uid: claims.sub, claims };
}
async function verifyAppCheck(env, fs, request) {
  if (env.LINE_LOGIN_APP_CHECK === 'off') return;
  const token = request.headers.get('x-firebase-appcheck') || '';
  const claims = token ? await verifyJwt(fs, token, { alg: 'RS256', jwks: 'https://firebaseappcheck.googleapis.com/v1/jwks' }).catch(() => null) : null;
  const now = Math.floor(Date.now() / 1000);
  const aud = claims && (Array.isArray(claims.aud) ? claims.aud : [claims.aud]);
  if (!claims || claims.iss !== 'https://firebaseappcheck.googleapis.com/' + FIREBASE_PROJECT_NUMBER
    || !aud.includes('projects/' + FIREBASE_PROJECT_NUMBER) || claims.sub !== FIREBASE_WEB_APP_ID || !(claims.exp > now)) {
    throw new AuthProblem('app-check', 401);
  }
}
async function verifyLineIdToken(env, fs, idToken, nonce) {
  if (typeof idToken !== 'string') throw new Error('no id token');
  const claims = await verifyJwt(fs, idToken, { hsSecret: env.LINE_LOGIN_CHANNEL_SECRET, jwks: 'https://api.line.me/oauth2/v2.1/certs' });
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== 'https://access.line.me' || String(claims.aud) !== String(env.LINE_LOGIN_CHANNEL_ID)
    || !(claims.exp > now) || !(claims.iat <= now + 60) || !(claims.iat >= now - LINE_AUTH_TTL_MS / 1000)
    || typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)
    || typeof claims.sub !== 'string' || !/^U[0-9a-f]{32}$/.test(claims.sub)) {
    throw new Error('bad id token');
  }
  return claims;
}

/* JWTの署名確認(RS256・ES256は公開鍵の一覧から、HS256はチャネルシークレットで) */
const jwksCache = new Map();   // url -> { keys, exp, fetchedAt }
async function fetchJwks(fs, url, force) {
  const hit = jwksCache.get(url);
  if (hit && hit.exp > Date.now() && (!force || Date.now() - hit.fetchedAt < 60000)) return hit.keys;   // 知らない鍵でも1分は取り直さない
  fs.reserve();
  const res = await fetch(url);
  if (!res.ok) throw new Error('jwks ' + res.status);
  const data = await res.json();
  const keys = Array.isArray(data.keys) ? data.keys : [];
  const age = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  jwksCache.set(url, { keys, fetchedAt: Date.now(), exp: Date.now() + Math.min(age ? Number(age[1]) : 3600, 6 * 3600) * 1000 });
  return keys;
}
async function verifyJwt(fs, token, opt) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('jwt');
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const sig = b64urlDecode(parts[2]);
  if (opt.alg && header.alg !== opt.alg) throw new Error('jwt alg');
  let ok = false;
  if (header.alg === 'HS256' && opt.hsSecret) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(opt.hsSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('HMAC', key, sig, data);
  } else if ((header.alg === 'RS256' || header.alg === 'ES256') && opt.jwks && typeof header.kid === 'string') {
    let jwk = (await fetchJwks(fs, opt.jwks)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await fetchJwks(fs, opt.jwks, true)).find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('jwt kid');
    const rsa = header.alg === 'RS256';
    if (jwk.kty !== (rsa ? 'RSA' : 'EC')) throw new Error('jwt kty');
    const algo = rsa ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' };
    const key = await crypto.subtle.importKey('jwk', rsa ? { kty: 'RSA', n: jwk.n, e: jwk.e } : { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      algo, false, ['verify']);
    ok = await crypto.subtle.verify(rsa ? algo : { name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
  } else {
    throw new Error('jwt alg');
  }
  if (!ok) throw new Error('jwt signature');
  return claims;
}
async function mintCustomToken(fs, uid) {
  const now = Math.floor(Date.now() / 1000);
  return signServiceJwt(fs.sa, { alg: 'RS256', typ: 'JWT' }, { iss: fs.sa.client_email, sub: fs.sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + CUSTOM_TOKEN_TTL_S, uid });
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
function randomDigits(n) {
  let out = '';
  while (out.length < n) {
    const v = crypto.getRandomValues(new Uint8Array(1))[0];
    if (v < 250) out += String(v % 10);   // 偏りが出ないように250以上は捨てる
  }
  return out;
}
async function sha256Hex(value) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function b64urlDecode(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
/* LINEから戻ったときの案内ページ。外部の読み込みもスクリプトも使わない */
function authPage(status, title, lines, appLink, extra) {
  const x = extra || {};
  const body = lines.map((l) => '<p>' + escHtml(l).replace(/\n/g, '<br>') + '</p>').join('') +
    (x.code ? '<p class="label">確認番号</p><p class="code" aria-label="確認番号 ' + escHtml(x.code.split('').join(' ')) + '">' +
      escHtml(x.code.slice(0, 3) + ' ' + x.code.slice(3)) + '</p>' : '') +
    (x.note ? '<p class="note">' + escHtml(x.note) + '</p>' : '') +
    (appLink ? '<a class="btn" href="' + escHtml(appLink) + '">' + escHtml(x.appLabel || 'まいにこを開く') + '</a>' : '') +
    (x.cancel ? '<form method="post" action="callback-cancel"><input type="hidden" name="tx" value="' + escHtml(x.tx) +
      '"><input type="hidden" name="c" value="' + escHtml(x.code) + '"><button class="sub" type="submit">' + escHtml(x.cancelLabel || '取り消す（つながない）') + '</button></form>' : '');
  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<title>まいにこ｜' + escHtml(title) + '</title><style>body{font-family:system-ui,sans-serif;background:#FFF8EE;color:#243747;margin:0;line-height:1.8;font-size:18px}' +
    'main{max-width:560px;margin:auto;padding:28px 20px}h1{font-size:1.4rem}.label{margin-bottom:0;font-weight:700}.code{font-size:2.6rem;font-weight:900;letter-spacing:.12em;margin:4px 0 12px;color:#1D4E9E}' +
    '.note{font-size:.95rem;color:#516170}.btn,button{display:block;width:100%;box-sizing:border-box;text-align:center;margin:14px 0;padding:16px;border-radius:14px;font-size:1.1rem;font-weight:900;text-decoration:none}' +
    '.btn{background:#1D4E9E;color:#fff}button.sub{background:#fff;color:#8A3B12;border:2px solid #8A3B12}</style></head><body><main><h1>' +
    escHtml(title) + '</h1>' + body + '</main></body></html>';
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}

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
  if (res.ok) return 'sent';
  // 同じ再送キーで受付済み(前の回で送れていた)。二重には届かず、通数も増えない
  if (res.status === 409 && res.headers.get('x-line-accepted-request-id')) return 'dup';
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
    this.softLimit = 0;
  }
  reserve(limit) {
    // softLimit: タグの処理中だけ使う低めの上限(予定のお知らせの分を残す)。後片付けの HARD_BUDGET はこれより優先
    if (this.count >= (limit || this.softLimit || SUBREQUEST_BUDGET)) throw new Error('request-budget');
    this.count++;
  }
  async beginTransaction() {
    const res = await this.call('POST', this.base + ':beginTransaction', { options: { readWrite: {} } });
    if (!res.ok) throw new Error('begin transaction ' + res.status);
    const data = await res.json();
    if (!data || typeof data.transaction !== 'string') throw new Error('begin transaction');
    return data.transaction;
  }
  async rollback(transaction) {
    try { await this.call('POST', this.base + ':rollback', { transaction }, true); } catch (e) { /* 期限で自然に終わる */ }
  }
  async commit(writes, transaction) {
    const res = await this.call('POST',this.base+':commit',transaction ? {writes, transaction} : {writes});
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
      // 認証の照会(LINEでログイン)にも使う。権限はサービスアカウントの役割で決まる
      scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    };
    const jwt = await signServiceJwt(this.sa, header, claims);
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
  async call(method, url, body, hard) {
    const token = await this.token();
    this.reserve(hard ? HARD_BUDGET : 0);
    const res = await fetch(url, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }
  async get(path, transaction) {
    const res = await this.call('GET', this.base + '/' + path + (transaction ? '?transaction=' + encodeURIComponent(transaction) : ''));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('get ' + path + ' ' + res.status + ' ' + await res.text());
    return parseDoc(await res.json(), this.root);
  }
  async set(path, obj, hard) {
    const res = await this.call('PATCH', this.base + '/' + path, { fields: toFields(obj) }, hard);
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
  /* patch と同じ。成功したら更新後の文書(新しい updateTime つき)を返し、条件が合わなければ null */
  async patchDoc(path, obj, fieldPaths, updateTime) {
    let url = this.base + '/' + path + '?' + fieldPaths.map((f) => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
    if (updateTime) url += '&currentDocument.updateTime=' + encodeURIComponent(updateTime);
    const res = await this.call('PATCH', url, { fields: toFields(obj) });
    if (res.ok) return parseDoc(await res.json(), this.root);
    if (res.status === 400 || res.status === 409 || res.status === 412 || res.status === 404) return null;
    throw new Error('patch ' + path + ' ' + res.status);
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
/* 予定ごとのLINE送信の記録(新しい20件まで)。送った人の数だけを残し、LINEの利用者識別子は残さない。 */
function appendNotifyLog(prev, entry) {
  const list = Array.isArray(prev) ? prev.filter((e) => e && typeof e === 'object' && !Array.isArray(e)) : [];
  list.push(entry);
  return list.slice(-20);
}
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  throw new Error('unsupported value');
}

async function signServiceJwt(sa, header, claims) {
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64url(new Uint8Array(sig));
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
