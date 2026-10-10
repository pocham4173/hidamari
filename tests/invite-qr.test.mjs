/* 招待QR(2026-10-01): QRのアドレスから招待コードを受け取り、入口で案内し、参加したら消す */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const a = html.indexOf('/* ===== 招待QR(2026-10-01)'), b = html.indexOf('captureInviteFromUrl();\n', a);
assert.ok(a > 0 && b > a);
function fixture(href, ua = 'Android', standalone = false) {
  const store = new Map(), box = { hidden: true, innerHTML: '', textContent: '' };
  let replaced = null;
  const ctx = {
    URL, JSON, Date, Promise, encodeURIComponent,
    location: { href }, history: { replaceState: (s, t, u) => { replaced = u; } },
    navigator: { userAgent: ua, platform: '', maxTouchPoints: 0 },
    window: {}, previewStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    document: { getElementById: (id) => (id === 'invite-note' ? box : null) },
    gid: () => '', isStandalone: () => standalone, esc: (s) => String(s),
    qrcode: () => ({ addData(d) { this.d = d; }, make() {}, createImgTag() { return '<img data-url="' + this.d + '">'; } }),
  };
  vm.createContext(ctx); vm.runInContext(html.slice(a, b), ctx);
  return { ctx, store, box, replaced: () => replaced };
}
{
  const f = fixture('https://pocham4173.github.io/hidamari/?invite=abcd2345#schedule=x');
  f.ctx.captureInviteFromUrl();
  assert.equal(f.replaced(), '/hidamari/#schedule=x', 'アドレスから招待コードを消す(ほかの印は残す)');
  assert.equal(f.ctx.readInvite().code, 'ABCD2345', '小文字でも受け取る');
  f.ctx.renderInviteNote();
  assert.equal(f.box.hidden, false); assert.match(f.box.innerHTML, /ABCD2345/); assert.match(f.box.innerHTML, /招待から参加する/);
  f.ctx.clearInvite(); assert.equal(f.ctx.readInvite(), null, '参加したら消す');
}
{
  const f = fixture('https://pocham4173.github.io/hidamari/?invite=ABCD2345', 'iPhone');
  f.ctx.captureInviteFromUrl(); f.ctx.renderInviteNote();
  assert.match(f.box.innerHTML, /先にこの画面を「ホーム画面に追加」/, 'iPhoneのSafariでは先にホーム画面へ追加するよう案内');
}
{
  const f = fixture('https://pocham4173.github.io/hidamari/?invite=bad!');
  f.ctx.captureInviteFromUrl(); assert.equal(f.ctx.readInvite(), null, '形の違うコードは受け取らない');
  f.store.set('mainicoInviteCode', JSON.stringify({ code: 'ABCD2345', at: Date.now() - 25 * 3600000 }));
  assert.equal(f.ctx.readInvite(), null, '24時間を過ぎたコードは使わない');
}
{
  const f = fixture('https://pocham4173.github.io/hidamari/');
  assert.match(f.ctx.inviteQrHtml('ABCD2345'), /hidamari\/\?invite=ABCD2345/, 'QRにはアドレスと招待コードだけを入れる');
}
console.log('招待QR: 受け取り・案内・iPhoneの案内・形と期限・参加後に消す・QRの中身 passed');
