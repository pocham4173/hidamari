/* iPhoneのSafariで開いたとき、ホーム画面のアイコンとは別の家庭を作ったり使ったりしない(2026-10-11) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pick = (re) => { const m = html.match(re); assert.ok(m, 'not found: ' + re); return m[0]; };
const code = [
  pick(/function isStandalone\(\)\{[\s\S]*?\n\}/),
  pick(/function isIosSafariTab\(\)\{[\s\S]*?\n\}/),
  pick(/const SAFARI_KEEP_KEY=[^\n]*/),
  pick(/function safariKept\(\)[^\n]*/),
  pick(/function updateSafariBar\(id\)\{[\s\S]*?\n\}/),
  pick(/function keepSafariUse\(\)\{[\s\S]*?\n\}/),
  pick(/async function entryStart\(\)\{[\s\S]*?\n\}/),
].join('\n') + '\n;globalThis.api={isIosSafariTab,updateSafariBar,keepSafariUse,entryStart};';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_LINE = IPHONE + ' Line/14.0.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
function env({ ua = IPHONE, standalone = false, kept = false, confirmAnswer = true, storageThrows = false } = {}) {
  const store = new Map(kept ? [['mainicoSafariKeep', '1']] : []);
  const bar = { hidden: true };
  const log = { confirms: [], shown: [] };
  const ctx = {
    navigator: { userAgent: ua, standalone, maxTouchPoints: 5 },
    window: { matchMedia: () => ({ matches: standalone }), navigator: { standalone } },
    localStorage: storageThrows
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { body: { style: {} }, getElementById: (id) => (id === 'safari-bar' ? bar : null) },
    appConfirm: async (text, ok) => { log.confirms.push({ text, ok }); return confirmAnswer; },
    setEntryIntent: (v) => log.shown.push('intent:' + v),
    entryShow: (v) => log.shown.push(v),
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { api: ctx.api, bar, log, store };
}

// 1. iPhoneのSafariで「はじめて使う」→ まずアイコンから開くよう確認する
{
  const e = env({ confirmAnswer: false });
  await e.api.entryStart();
  assert.equal(e.log.confirms.length, 1);
  assert.match(e.log.confirms[0].text, /ホーム画面に「まいにこ」のアイコンがある方は、ここで始めずに、アイコンから開いてください/);
  assert.deepEqual(e.log.shown, [], 'やめるを選ぶと、新しく始めない');
}
{
  const e = env({ confirmAnswer: true });
  await e.api.entryStart();
  assert.deepEqual(e.log.shown, ['intent:create', 'entry-who'], 'アイコンがない人は、そのまま始められる');
}
// ホーム画面のアイコン・Android・LINEの中では、確認を出さない(今までどおり)
for (const opt of [{ standalone: true }, { ua: ANDROID }, { ua: IPHONE_LINE }, { kept: true }]) {
  const e = env(opt);
  await e.api.entryStart();
  assert.equal(e.log.confirms.length, 0, JSON.stringify(opt));
  assert.deepEqual(e.log.shown, ['intent:create', 'entry-who']);
}

// 2. iPhoneのSafariで家庭が開いたら、上に「アイコンとは別」と出す。「このSafariで使う」で次から出ない
{
  const e = env();
  e.api.updateSafariBar('kazoku'); assert.equal(e.bar.hidden, false);
  e.api.updateSafariBar('entry'); assert.equal(e.bar.hidden, true, '入口では出さない(入口には別の案内がある)');
  e.api.updateSafariBar('honnin'); assert.equal(e.bar.hidden, false);
  e.api.keepSafariUse(); assert.equal(e.bar.hidden, true);
  e.api.updateSafariBar('kazoku'); assert.equal(e.bar.hidden, true, '一度選んだら次から出ない');
}
for (const opt of [{ standalone: true }, { ua: ANDROID }, { ua: IPHONE_LINE }]) {
  const e = env(opt); e.api.updateSafariBar('kazoku'); assert.equal(e.bar.hidden, true, JSON.stringify(opt));
}
// 保存が使えないSafari(プライベートなど)でも、止まらない
{
  const e = env({ storageThrows: true });
  e.api.updateSafariBar('kazoku'); assert.equal(e.bar.hidden, false);
  e.api.keepSafariUse(); assert.equal(e.bar.hidden, true);
}
// 画面の文言
assert.match(html, /<div id="safari-bar"[^>]*hidden><b>このSafariの記録は、ホーム画面の「まいにこ」アイコンとは別です。<\/b>/);
assert.match(html, /onclick="keepSafariUse\(\)">このSafariで使う<\/button>/);
assert.match(html, /updateSafariBar==='function'\)updateSafariBar\(id\);\n\}/, '画面を切り替えるたびに確かめる');
console.log('iPhoneのSafari: アイコンと別の家庭を作らない確認・家庭が開いたときの案内 passed');
