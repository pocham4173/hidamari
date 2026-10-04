/* まいにこ LINE送信役（Cloudflare Workers・無料プラン用）2026-10-01 作り直し版
 *
 * できること
 *  1. LINEからの受付（Webhook: https://〜.workers.dev/line）
 *     - 友だち追加 → 連携コードの送り方を返事
 *     - 8文字の連携コード → まいにこの家庭・アカウントとLINEを連携
 *     - 「まいにこ招待」＋10文字の招待コード → 家族が招待した送信先として登録(2026-10-04)
 *     - 「解除」 → このLINEの連携・送信先の登録を解除
 *     - ブロック → 自動で連携・送信先の登録を解除
 *  2. 15分ごとの見回り（Cron）
 *     - 「LINEで知らせる日時」を過ぎた予定を探し、その家庭でLINE連携した
 *       承認済みの人へ「予定のお知らせ」を送る。送ったら予定に送信済みの印を付ける。
 *       予定に notifyTo(知らせる相手)があれば、その人だけに送る。招待した送信先('r:〜')へは、
 *       notifyTo で選ばれた予定だけを送る(選んでいない予定・おまもりタグは送らない)。
 *       送るのは、予定を登録した家族が「アプリを使わない人へ送る」ことに同意しているときだけ。
 *     - おまもりタグが読み取られたら、LINE連携した家族(ご本人以外)へ知らせる。
 *     - 「ひと声のきっかけ」(2026-10-04): 家族が「LINEにも送る」をオンにし、ご本人が了解した家庭で、
 *       決めた時刻までにご本人の操作が1つもない日だけ、その日の担当の家族1人へ1日1通送る。
 *       文面に名前・様子は書かない。操作があったかは、その日の記録の「種類と書いた人」だけで判断する(中身は読まない)。
 *  3. 月200通(無料プラン)を守る上限ガード
 *     - 残りが TAG_RESERVE 通以下になったら予定のお知らせを止め、タグの分を残す
 *     - 家庭ごとに1日 HOUSEHOLD_DAILY_LIMIT 通まで(タグは止めずに数だけ数える)
 *     - タグごとに1時間 TAG_HOURLY_LIMIT 回・1日 TAG_DAILY_LIMIT 回まで
 *     - 1回の見回りで知らせるタグの読み取りは TAGS_PER_RUN 件まで(残りは次の回)
 *     - 残り通数は lineStatus/quota に書き、家族が設定画面で見られる
 *     - ひと声のきっかけは、まいにこ全体で月 HITOKOE_MONTHLY_LIMIT 通まで(タグの分は必ず残す)
 *
 * 設定する秘密の値（Cloudflareの「設定 → 変数とシークレット」に、種類「シークレット」で登録）
 *  LINE_CHANNEL_SECRET        … LINE Developers の チャネルシークレット
 *  LINE_CHANNEL_ACCESS_TOKEN  … LINE Developers の チャネルアクセストークン（長期）
 *  FIREBASE_SERVICE_ACCOUNT   … Firebase の サービスアカウント秘密鍵（JSONファイルの中身をまるごと）
 *
 * 送る内容は、予定の日付・時刻・場所・予定名・登録した人の名前だけ。
 * 服薬・体調・伝言などの記録の中身は読みにも行かない(ひと声のきっかけで、その日の記録の種類と書いた人だけを見る)。
 */

const APP_URL = 'https://pocham4173.github.io/hidamari/';
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const INVITE_RE = /^(?:まいにこ)?招待([A-HJ-NP-Z2-9]{10})$/;
const ADD_FRIEND_URL = 'https://line.me/R/ti/p/%40187mrwbk';
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
const HITOKOE_MONTHLY_LIMIT = 90;           // ひと声のきっかけのLINEは、まいにこ全体で月90通まで(無料の200通の内側)
const HITOKOE_WINDOW_HOURS = 3;              // 決めた時刻から3時間のうちだけ送る(遅れた知らせは送らない)
const HITOKOE_REQUEST_BUDGET = 36;           // ひと声の処理はここまで。残りは後片付けに回す
const HITOKOE_NOT_ACTIVITY = new Set(['hitokoe-consent', 'device-recovery', 'person-ui-config']); // hitokoe.js と同じ
const VERSION_TEXT = '版：2026-10-04 ひと声のきっかけをLINEにも';

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
        : 'まいにこ LINE送信役は動いています（' + VERSION_TEXT + '）';
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
  '予定のお知らせを受け取るには、まいにこアプリの\n「設定」→「LINEで予定のお知らせ」→「LINEとつなぐ」\nを押してください。家族から招待が届いた方は、招待のリンクを開いて送信を押してください。';
const MSG_HELP =
  'このトークでは、つなぐためのコード・招待の受け付けと、予定のお知らせだけを行っています。\n' +
  'お返事や相談は届きません。急ぐときは電話などで連絡してください。\n\n' +
  '受け取るのをやめるときは「解除」と送ってください。';

async function handleEvent(ev, env, fs) {
  const source = ev.source || {};
  if (source.type !== 'user' || !source.userId) return;
  const lineUserId = source.userId;

  if (ev.type === 'follow') {
    return reply(env, ev.replyToken, MSG_WELCOME);
  }
  if (ev.type === 'unfollow') {
    await removeLinksFor(fs, lineUserId, 'block');
    await removeRecipientsFor(fs, lineUserId);
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') {
    if (ev.replyToken) return reply(env, ev.replyToken, MSG_HELP);
    return;
  }
  const raw = String(ev.message.text || '');
  const text = raw.normalize('NFKC').toUpperCase().replace(/[\s\-ー－_]/g, '');
  if (text === '解除' || text === '連携解除') {
    const n = await removeLinksFor(fs, lineUserId, 'line') + await removeRecipientsFor(fs, lineUserId);
    return reply(env, ev.replyToken, n
      ? '解除しました。このLINEには予定のお知らせが届かなくなります。\nまた受け取るときは、アプリの「LINEとつなぐ」か、家族からの新しい招待で登録してください。'
      : 'このLINEは、まいにこと連携していません。');
  }
  const invite = INVITE_RE.exec(text);
  if (invite) {
    return reply(env, ev.replyToken, await acceptInvite(env, fs, invite[1], lineUserId));
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

/* 家族が招待した送信先の登録(2026-10-04)。
   LINEの利用者識別子は、署名を確かめた Webhook の送り主から取る(画面からの申告は使わない)。
   招待コードは7日間・一度だけ。登録できるのは「相手の承認待ち」の送信先だけ。 */
async function acceptInvite(env, fs, code, lineUserId) {
  const NG = 'この招待は見つからないか、有効期限（7日）が切れています。\n招待してくれた家族に、もう一度招待を送ってもらってください。';
  const inv = await fs.get('lineInvites/' + code);
  if (!inv) return NG;
  const exp = inv.fields.expiresAt, rid = inv.fields.recipientId, groupId = inv.fields.groupId;
  if (!(exp instanceof Date) || exp.getTime() < Date.now() || typeof rid !== 'string' || typeof groupId !== 'string') {
    await fs.delete('lineInvites/' + code).catch(() => {});
    return NG;
  }
  const rec = await fs.get('lineRecipients/' + rid);
  const group = await fs.get('groups/' + groupId);
  if (!rec || rec.fields.groupId !== groupId || !group || group.fields.deletionState === 'deleting') {
    await fs.delete('lineInvites/' + code).catch(() => {});
    return NG;
  }
  if (rec.fields.status !== 'pending') {
    await fs.delete('lineInvites/' + code).catch(() => {});
    return rec.fields.status === 'joined' ? 'この招待は、もう登録が済んでいます。' : NG;
  }
  // 表示名(家族の一覧に出す)と、友だち追加の有無。友だちでないと予定のお知らせは届かない
  let lineName = '', friend = true;
  try {
    fs.reserve();
    const res = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(lineUserId),
      { headers: { authorization: 'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN } });
    if (res.ok) lineName = String((await res.json()).displayName || '').slice(0, 40);
    else if (res.status === 404) friend = false;
  } catch (e) { if (e.message === 'request-budget') throw e; }
  const now = new Date();
  // 招待コードの使用・送信先の登録・送信役用の控えは、全部そろって確定する(どれか1つだけ残らない)
  const ok = await fs.commit([
    {delete: fs.root + '/lineInvites/' + code, currentDocument: {updateTime: inv.updateTime}},
    {update: {name: fs.root + '/lineRecipients/' + rid, fields: toFields({status: 'joined', lineName, joinedAt: now})},
      updateMask: {fieldPaths: ['status', 'lineName', 'joinedAt']}, currentDocument: {updateTime: rec.updateTime}},
    {update: {name: fs.root + '/lineRecipientIds/' + rid, fields: toFields({lineUserId, groupId, joinedAt: now})}}
  ]);
  if (!ok) return NG;
  const inviter = typeof rec.fields.createdBy === 'string' ? await fs.get('groups/' + groupId + '/members/' + rec.fields.createdBy) : null;
  const from = inviter && typeof inviter.fields.name === 'string' && inviter.fields.name ? clip(inviter.fields.name, 40) + 'さんの' : '';
  return from + 'まいにこの予定のお知らせを受け取る登録をしました。\n\n' +
    '家族が「この人に知らせる」と選んだ予定だけが、このLINEに届きます。\n' +
    'やめるときは「解除」と送ってください。' +
    (friend ? '' : '\n\n※ お知らせを受け取るには、まいにこ公式LINEの友だち追加が必要です。\n' + ADD_FRIEND_URL);
}

async function removeRecipientsFor(fs, lineUserId) {
  const docs = await fs.query('', {
    from: [{ collectionId: 'lineRecipientIds' }],
    where: fieldEq('lineUserId', { stringValue: lineUserId }),
  });
  for (const d of docs) {
    const rec = await fs.get('lineRecipients/' + d.id);
    // 家族の一覧に「LINEで停止」と残す。控えの削除と一緒に確定する
    const writes = [{delete: fs.root + '/' + d.path, currentDocument: {updateTime: d.updateTime}}];
    if (rec) writes.push({update: {name: fs.root + '/lineRecipients/' + d.id, fields: toFields({status: 'stopped', stoppedAt: new Date()})},
      updateMask: {fieldPaths: ['status', 'stoppedAt']}, currentDocument: {updateTime: rec.updateTime}});
    if (!await fs.commit(writes)) await fs.delete(d.path);
  }
  return docs.length;
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
        const allLinks = await fs.query('', {from:[{collectionId:'lineLinks'}],
          where:fieldEq('groupId',{stringValue:g.id})});
        // 知らせる相手(notifyTo)。無い・null = つないだ家族全員(今までどおり)。
        // 'u:<uid>' = 家族、'r:<送信先>' = 招待した送信先(選ばれた予定だけに送る)
        const notifyTo = Array.isArray(y.fields.notifyTo) ? y.fields.notifyTo.filter(v => typeof v === 'string') : null;
        const links = (notifyTo ? allLinks.filter(l => notifyTo.includes('u:' + l.id)) : allLinks)
          .map(l => ({kind:'u', id:l.id, path:l.path, fields:l.fields}));
        let wanted = notifyTo ? notifyTo.filter(v => v.startsWith('r:')).map(v => v.slice(2)) : [];
        // 招待した送信先へは、予定を登録した家族が「アプリを使わない人へ送る」ことに同意しているときだけ送る
        const shareConsentPath = g.path + '/lineShareConsents/' + String(y.fields.uid || '');
        if (wanted.length && !(typeof y.fields.uid === 'string' && y.fields.uid && await fs.get(shareConsentPath))) wanted = [];
        if (wanted.length) {
          const ids = await fs.query('', {from:[{collectionId:'lineRecipientIds'}],
            where:fieldEq('groupId',{stringValue:g.id})});
          for (const d of ids) if (wanted.includes(d.id)) links.push({kind:'r', id:d.id, path:d.path, fields:d.fields});
        }
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
          if (link.kind === 'r') {
            // 招待した送信先: 家族が削除・LINEで停止していないこと(登録済みの送信先の控えと同じ相手であること)
            const rec = await fs.get('lineRecipients/' + link.id);
            if (!rec || rec.fields.groupId !== g.id || rec.fields.status !== 'joined') continue;
            if (!await fs.get(shareConsentPath)) continue;   // 同意をやめた後は送らない
            const currentIds = await fs.get(link.path);
            if (!currentIds || currentIds.fields.groupId !== g.id || currentIds.fields.lineUserId !== to) continue;
          } else {
            if (!await approvedMember(fs, g.id, link.id)) continue;
            const currentLink = await fs.get(link.path);
            if (!currentLink || currentLink.fields.groupId !== g.id || currentLink.fields.lineUserId !== to) continue;
          }
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
    // ひと声のきっかけ(予定のお知らせの後。15分遅れても困らないため)
    fs.softLimit = HITOKOE_REQUEST_BUDGET;
    try { sent += await runHitokoe(env, fs, now, book, groups); }
    catch (e) { if (e.message !== 'request-budget') console.error('hitokoe', e.message); }
    finally { fs.softLimit = 0; }
    // Clean one verified orphan link per run without relying on a complete household list.
    const cleanupLinks = await fs.list('lineLinks', ['groupId']);
    if (cleanupLinks.length) {
      const link = cleanupLinks[Math.floor(now.getTime()/900000)%cleanupLinks.length];
      if (!await approvedMember(fs, link.fields.groupId, link.id)) await fs.delete(link.path);
    }
    // Bounded maintenance. Never infer a deleted household from a partial list.
    // 招待した送信先の控えを1件ずつ見直す(家族が削除した・家庭がなくなったものは消す)
    const recipientIds = await fs.list('lineRecipientIds', ['groupId']);
    if (recipientIds.length) {
      const d = recipientIds[Math.floor(now.getTime()/900000)%recipientIds.length];
      const rec = await fs.get('lineRecipients/' + d.id);
      const group = rec && typeof d.fields.groupId === 'string' ? await fs.get('groups/' + d.fields.groupId) : null;
      if (!rec || rec.fields.groupId !== d.fields.groupId || rec.fields.status !== 'joined') await fs.delete(d.path);
      else if (!group || group.fields.deletionState === 'deleting') { await fs.delete(d.path); await fs.delete('lineRecipients/' + d.id); }
    }
    for (const collectionId of ['lineLinkCodes','lineInvites','lineDeliveryReceipts','tagAlertReceipts','tagAlertCounters','lineUsage']) {
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
  /* ひと声のきっかけを止める理由(止めないときは空文字)。月の残りはタグの分を残し、ひと声だけの月の上限も守る */
  async hitokoeBlocked(groupId) {
    if (this.remaining() - 1 < TAG_RESERVE) return 'monthly';
    if (await this.hitokoeMonth() >= HITOKOE_MONTHLY_LIMIT) return 'hitokoe-monthly';
    if (await this.home(groupId) + 1 > HOUSEHOLD_DAILY_LIMIT) return 'household';
    return '';
  }
  async hitokoeMonth() {
    if (this.hitokoeCount === undefined) {
      const d = await this.fs.get('lineUsage/hitokoe-' + this.day.slice(0, 7));
      this.hitokoeCount = d && Number.isFinite(d.fields.count) ? d.fields.count : 0;
    }
    return this.hitokoeCount;
  }
  async countHitokoe(groupId) {
    this.hitokoeCount = await this.hitokoeMonth() + 1;
    this.hitokoeDirty = true;
    await this.count(groupId);
  }
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
    if (this.hitokoeDirty) {
      await this.fs.set('lineUsage/hitokoe-' + this.day.slice(0, 7), { month: this.day.slice(0, 7), count: this.hitokoeCount,
        limit: HITOKOE_MONTHLY_LIMIT, updatedAt: new Date(), expiresAt: new Date(this.now.getTime() + 40 * 86400000) }, true);
      this.hitokoeDirty = false;
    }
    if (this.quota) {
      const remaining = this.quota.limit === null ? null : Math.max(0, this.quota.limit - this.quota.used);
      await this.fs.set('lineStatus/quota', { limit: this.quota.limit, used: this.quota.used, remaining,
        reserve: TAG_RESERVE, checkedAt: new Date() }, true);
    }
  }
}

/* ================= ひと声のきっかけ(2026-10-04) =================
 * hitokoe.js(アプリ)と同じ判定で、LINEにも1日1通だけ送る。
 *  - 家族の最新の設定(hitokoe-config)が「使う」かつ「LINEにも送る」
 *  - ご本人がその設定のお願い(requestId)に「はい」と答えている
 *  - 今日(日本時間)がお休みの曜日・期間でない。決めた時刻から HITOKOE_WINDOW_HOURS 時間のうち
 *  - 今日、ご本人の操作が1つもなく、家族の「連絡しました」もまだない
 *  - その日の担当の家族(いなければ設定した人)が、承認済みでLINE連携している
 * 送る文面に名前・様子は書かない。家庭ごとに1日1通(同じ日の再送キーで二重に届かない)。 */
const HITOKOE_HOURS = [9, 10, 11, 12], HITOKOE_DEFAULT_HOUR = 11;
const HITOKOE_TEXT = ['🌼 ひと声のきっかけ（まいにこ）', '',
  '今日はまだ、まいにこの「おはよう」などが届いていません。よかったら、声をかけてみてください。', '',
  '押し忘れや外出のことも多くあります。返事や対応は必要ありません。',
  '安否確認・緊急通報ではありません。緊急のときは119番へ。', '',
  'まいにこを開く', APP_URL].join('\n');
function eventMillis(f) {
  const a = f.at instanceof Date ? f.at : f.createdAt instanceof Date ? f.createdAt : null;
  return a ? a.getTime() : Number(f.clientAt) || 0;
}
function newestEvent(rows) { return rows.slice().sort((a, b) => eventMillis(b.fields) - eventMillis(a.fields))[0] || null; }
function hitokoeConfig(f) {
  const hour = HITOKOE_HOURS.includes(Number(f.hour)) ? Number(f.hour) : HITOKOE_DEFAULT_HOUR;
  const off = Array.isArray(f.offWeekdays) ? f.offWeekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  const pauses = Array.isArray(f.pauses) ? f.pauses.filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(p.from)
    && /^\d{4}-\d{2}-\d{2}$/.test(p.to) && p.from <= p.to).slice(0, 10) : [];
  const assignees = {};
  if (f.assignees && typeof f.assignees === 'object') for (const k of Object.keys(f.assignees))
    if (/^[0-6]$/.test(k) && typeof f.assignees[k] === 'string') assignees[k] = f.assignees[k];
  return { enabled: f.enabled === true, line: f.line === true, hour, off, pauses, assignees,
    requestId: typeof f.requestId === 'string' ? f.requestId : '', uid: typeof f.uid === 'string' ? f.uid : '' };
}
const memberApproved = (m) => !!m && (m.status === undefined || m.status === 'approved');
const memberHonnin = (m) => !!m && (m.role === 'honnin' || m.mode === 'honnin');
async function runHitokoe(env, fs, now, book, groups) {
  const jst = new Date(now.getTime() + 9 * 3600000), hour = jst.getUTCHours();
  if (hour < HITOKOE_HOURS[0] || hour >= HITOKOE_HOURS[HITOKOE_HOURS.length - 1] + HITOKOE_WINDOW_HOURS) return 0;
  const day = jstDateString(now), weekday = jst.getUTCDay();
  let sent = 0;
  const offset = groups.length ? Math.floor(now.getTime() / 900000) % groups.length : 0;
  for (const g of [...groups.slice(offset), ...groups.slice(0, offset)]) {
    if (g.fields.deletionState === 'deleting') continue;
    const eventsOf = (type, fields) => fs.query(g.path, { from: [{ collectionId: 'events' }], where: fieldEq('type', { stringValue: type }),
      select: { fields: fields.map((fieldPath) => ({ fieldPath })) } });
    const newest = newestEvent(await eventsOf('hitokoe-config',
      ['type', 'enabled', 'line', 'hour', 'offWeekdays', 'pauses', 'assignees', 'requestId', 'uid', 'at', 'clientAt']));
    if (!newest) continue;
    const cfg = hitokoeConfig(newest.fields);
    if (!cfg.enabled || !cfg.line || !cfg.requestId) continue;
    if (hour < cfg.hour || hour >= cfg.hour + HITOKOE_WINDOW_HOURS) continue;
    if (cfg.off.includes(weekday) || cfg.pauses.some((p) => p.from <= day && day <= p.to)) continue;
    const key = await deliveryKey('hitokoe\n' + g.id + '\n' + day);
    const receiptPath = 'lineDeliveryReceipts/' + key;
    let receipt = await fs.get(receiptPath);
    if (receipt && receipt.fields.acceptedAt instanceof Date) continue;   // 今日はもう送った
    const memberDocs = await fs.list(g.path + '/members', ['name', 'role', 'mode', 'status']);
    const members = Object.fromEntries(memberDocs.map((m) => [m.id, m.fields]));
    const honnins = Object.keys(members).filter((u) => memberApproved(members[u]) && memberHonnin(members[u]));
    if (!honnins.length) continue;
    const consents = await eventsOf('hitokoe-consent', ['type', 'uid', 'requestId', 'answer', 'at', 'clientAt']);
    const agreed = honnins.filter((u) => {
      const c = newestEvent(consents.filter((d) => d.fields.uid === u && d.fields.requestId === cfg.requestId
        && (d.fields.answer === 'yes' || d.fields.answer === 'no')));
      return c && c.fields.answer === 'yes';
    });
    if (!agreed.length) continue;
    const todayRows = (await fs.query(g.path, { from: [{ collectionId: 'events' }], where: fieldEq('date', { stringValue: day }),
      select: { fields: [{ fieldPath: 'type' }, { fieldPath: 'uid' }, { fieldPath: 'target' }] } })).map((d) => d.fields);
    const quiet = agreed.filter((u) => !todayRows.some((v) => v.uid === u && !HITOKOE_NOT_ACTIVITY.has(v.type))
      && !todayRows.some((v) => v.type === 'hitokoe-contacted' && v.target === u));
    if (!quiet.length) continue;
    // その日の担当(承認済みの家族。ご本人は受け取らない)。いなければ設定した人
    const fam = (u) => (u && memberApproved(members[u]) && !memberHonnin(members[u]) ? u : '');
    const assignee = fam(cfg.assignees[String(weekday)] || '') || fam(cfg.uid);
    if (!assignee) continue;
    const link = await fs.get('lineLinks/' + assignee);
    const to = link && link.fields.groupId === g.id && typeof link.fields.lineUserId === 'string' ? link.fields.lineUserId : '';
    if (!to) continue;
    if (!await approvedMember(fs, g.id, assignee)) continue;
    if (!receipt) {
      if (await book.hitokoeBlocked(g.id)) continue;                     // 上限: アプリの中のお知らせだけになる
      await fs.commit([{ update: { name: fs.root + '/' + receiptPath,
        fields: toFields({ text: HITOKOE_TEXT, expiresAt: new Date(now.getTime() + 2 * 86400000) }) },
        currentDocument: { exists: false } }]);
      receipt = await fs.get(receiptPath);
      if (!receipt || receipt.fields.acceptedAt instanceof Date) continue;
    }
    const r = await push(env, fs, to, HITOKOE_TEXT, key);
    if (!r) continue;                                                      // 次の回に同じ再送キーで送り直す
    if (r === 'sent') { sent++; await book.countHitokoe(g.id); }
    await fs.set(receiptPath, { acceptedAt: new Date(), expiresAt: new Date(now.getTime() + 2 * 86400000) });
  }
  return sent;
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
  async get(path) {
    const res = await this.call('GET', this.base + '/' + path);
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
