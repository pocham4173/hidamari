/* はじめての道案内（家族の画面だけ・3つの手順）の検査 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
await import('../family-guide.js');
const G = globalThis.MainicoFamilyGuide;
class El {
  constructor(id){ this.id=id; this.children=[]; this.attrs={}; this.listeners={}; this.innerHTML=''; this.parentNode=null; this.scrolled=0;
    const set=new Set(); this.classList={add:c=>set.add(c),remove:c=>set.delete(c),contains:c=>set.has(c)}; }
  setAttribute(k,v){ this.attrs[k]=v; } getAttribute(k){ return this.attrs[k]??null; }
  addEventListener(t,f){ this.listeners[t]=f; } appendChild(c){ c.parentNode=this; this.children.push(c); }
  removeChild(c){ this.children=this.children.filter(x=>x!==c); c.parentNode=null; } scrollIntoView(){ this.scrolled++; }
}
function setup({ kOnly=false, tag=false, stored } = {}){
  const els={}; for(const id of ['card-record-actions','family-handoff-heading','nav-settings']) els[id]=new El(id);
  const body=new El('body'); const store=new Map(stored?[[G.DONE_KEY,stored]]:[]);
  const doc={ body, getElementById:id=>els[id]||null, createElement:()=>new El('') };
  const storage={ getItem:k=>store.get(k)??null, setItem:(k,v)=>store.set(k,v), removeItem:k=>store.delete(k) };
  const g=G.create({ doc, storage, isKOnly:()=>kOnly, tagAlert:()=>tag });
  const click=(what)=>{ const box=body.children[0]; box.listeners.click({ target:{ getAttribute:()=>what } }); };
  return { g, els, body, store, click, box:()=>body.children[0] };
}
// 1. 初めての端末では出る。1つ目は「今日見ること」を光らせる(2026-10-10)
let t=setup();
assert.equal(t.g.start(), true);
assert.match(t.box().innerHTML, /はじめての方へ（1\/3）/);
assert.match(t.box().innerHTML, /今日見ること/);
assert.ok(t.els['family-handoff-heading'].classList.contains('guide-focus'));
// 2. 次へ → 記録する → 設定。光る場所が移る
t.click('next');
assert.match(t.box().innerHTML, /記録する/);
assert.ok(!t.els['family-handoff-heading'].classList.contains('guide-focus'));
assert.ok(t.els['card-record-actions'].classList.contains('guide-focus'));
t.click('next');
assert.match(t.box().innerHTML, /ひと声のきっかけやLINEのお知らせは、ここから始められます/);assert.match(t.box().innerHTML, />もう大丈夫</); assert.match(t.box().innerHTML, />はじめる</);
// 3. 最後で閉じると、見終わった印が残り、二度と自動では出ない
t.click('next');
assert.equal(t.body.children.length, 0); assert.equal(t.store.get(G.DONE_KEY), '1');
assert.ok(!t.els['nav-settings'].classList.contains('guide-focus'));
assert.equal(t.g.start(), false);
// 4. 「もう大丈夫」も見終わった扱い。設定の「もう一度見る」なら出し直せる
t=setup(); t.g.start(); t.click('skip');
assert.equal(t.store.get(G.DONE_KEY), '1');
assert.equal(t.g.start({ force:true }), true);
// 5. 家族だけで使う家庭は、本人のボタン操作を待つ説明をしない(家族が確認・記録したこと)
t=setup({ kOnly:true }); t.g.start();
assert.match(t.box().innerHTML, /家族が確認・記録したこと/);
assert.doesNotMatch(t.box().innerHTML, /ご本人が押したこと/);
// 6. おまもりタグの未確認の知らせがあるときは出さない。途中で届いたら下げる（見終わった扱いにしない）
t=setup({ tag:true }); assert.equal(t.g.start(), false);
t=setup(); t.g.start(); t.g.interrupt();
assert.equal(t.body.children.length, 0); assert.equal(t.store.get(G.DONE_KEY), undefined);
// 7. 二重に開かない
t=setup(); t.g.start(); assert.equal(t.g.start({ force:true }), false); assert.equal(t.body.children.length, 1);
// 8. ?guide=1 で見終わった印を消す
{ const store=new Map([[G.DONE_KEY,'1']]); let replaced='';
  const ok=G.captureReplay({ href:'https://x.example/hidamari/index.html?guide=1#a' }, { removeItem:k=>store.delete(k) }, { replaceState:(a,b,u)=>{ replaced=u; } });
  assert.equal(ok, true); assert.equal(store.has(G.DONE_KEY), false); assert.equal(replaced, '/hidamari/index.html#a');
  assert.equal(G.captureReplay({ href:'https://x.example/?invite=AB' }, { removeItem(){ throw 0; } }, null), false); }
// 9. 画面への組み込み: 家族の画面だけで始め、タグの知らせ・画面の切り替えで下げる
const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const fn=(name)=>{ const i=html.indexOf('function '+name+'('); return html.slice(i, html.indexOf('\n}\n', i)); };
assert.match(fn('initKazoku'), /scheduleFamilyGuide\(\)/);
assert.doesNotMatch(fn('initHonnin')||'', /scheduleFamilyGuide/);
assert.match(fn('scheduleFamilyGuide'), /classList\.contains\('active'\)/);
assert.match(fn('scheduleFamilyGuide'), /tag-unread/);
assert.match(fn('tagApplyUnread'), /familyGuide\.interrupt\(\)/);
assert.match(fn('resetCommunication'), /familyGuide\.interrupt\(\)/);
assert.match(html, /<script src="family-guide\.js\?v=/);
assert.match(fn('openSettings'), /familyGuide\.close\(familyGuide\.step\(\)===2\)/, '設定を開いたら道案内を下げる(3つ目なら見終わった扱い)');
assert.match(html, /\.family-guide\{[^}]*z-index:45;/, '道案内は確認の画面(z-index:50)より下');
assert.match(html, /id="settings-modal"[\s\S]*id="guide-replay-btn"[\s\S]*onclick="replayFamilyGuide\(\)"/);
assert.ok(html.indexOf('id="guide-replay-btn"') > html.indexOf('id="settings-modal"') && html.indexOf('id="person-settings-modal"') < html.indexOf('id="settings-modal"'), '道案内の出し直しは家族の設定だけ');
const helpHtml=fs.readFileSync(new URL('../help.html', import.meta.url),'utf8');
assert.match(helpHtml, /使い方の道案内をもう一度見る/);
console.log('はじめての道案内: 3つの手順・見終わった印・家族だけの家庭・タグ優先・出し直し・画面への組み込み 9項目 passed');
