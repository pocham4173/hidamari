/* アプリの中で招待QRを読み取る(qr-scan.js・2026-10-04)の検査。jsdom を使う。
   カメラ(getUserMedia)と読み取り(BarcodeDetector・jsQR)は偽物に差し替える。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

await import('../qr-scan.js');
const Q = globalThis.MainicoQrScan;

// 1. 招待コードの取り出し
assert.equal(Q.parseInvite('https://pocham4173.github.io/hidamari/?invite=abcd2345'), 'ABCD2345', 'まいにこの招待QR');
assert.equal(Q.parseInvite('https://pocham4173.github.io/hidamari/index.html?invite=ABCD2345&openExternalBrowser=1'), 'ABCD2345');
assert.equal(Q.parseInvite(' abcd-2345 '), 'ABCD2345', 'コードの文字だけでもよい');
assert.equal(Q.parseInvite('https://evil.example/hidamari/?invite=ABCD2345'), null, 'ほかのサイトは受け付けない');
assert.equal(Q.parseInvite('https://pocham4173.github.io/other/?invite=ABCD2345'), null, 'まいにこ以外のページは受け付けない');
assert.equal(Q.parseInvite('https://pocham4173.github.io/hidamari/tag.html?t=xyz'), null, 'おまもりタグのQRは招待ではない');
assert.equal(Q.parseInvite('https://pocham4173.github.io/hidamari/?invite=ABCD234I'), null, '使わない文字(I)を含むコード');
assert.equal(Q.parseInvite('まいにこ もしもの控え'), null);
assert.equal(Q.parseInvite(''), null);
assert.match(Q.JSQR_SRI, /^sha384-/, 'jsQR は改ざん検知付きで読み込む');

function setup(deps) {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const stopped = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push(1) }] };
  dom.window.HTMLMediaElement.prototype.play = async () => {};
  const navigator = deps.navigator === undefined
    ? { mediaDevices: { getUserMedia: async (c) => { setup.constraints = c; if (deps.deny) throw Object.assign(new Error('x'), { name: deps.deny }); return stream; } } }
    : deps.navigator;
  return { dom, doc, stopped, stream, navigator };
}
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const msg = (doc) => doc.querySelector('.qr-scan-msg')?.textContent || '';

// 2. BarcodeDetector がある端末: ほかのQRは案内して読み続け、招待QRで閉じてコードを渡す。カメラは止める
{
  const reads = [['https://pocham4173.github.io/hidamari/tag.html?t=1'], [], ['https://pocham4173.github.io/hidamari/?invite=WXYZ6789']];
  class BD { static async getSupportedFormats() { return ['qr_code']; } async detect() { return (reads.shift() || []).map((rawValue) => ({ rawValue })); } }
  const s = setup({});
  const got = [];
  Q.open({ document: s.doc, deps: { navigator: s.navigator, BarcodeDetector: BD }, onCode: (c) => got.push(c) });
  assert.ok(s.doc.querySelector('.qr-scan[role="dialog"]'), '読み取り画面が開く');
  await wait(20);
  assert.equal(setup.constraints.audio, false, '音は使わない');
  assert.deepEqual(setup.constraints.video.facingMode, { ideal: 'environment' }, '外側のカメラ');
  assert.match(msg(s.doc), /まいにこの招待QRではありません/);
  await wait(700);
  assert.deepEqual(got, ['WXYZ6789']);
  assert.equal(s.doc.querySelector('.qr-scan'), null, '読めたら閉じる');
  assert.equal(s.stopped.length, 1, 'カメラを止める');
}

// 3. BarcodeDetector がない端末(iPhone): jsQR で読む
{
  const s = setup({});
  const realCreate = s.doc.createElement.bind(s.doc);
  s.doc.createElement = (tag) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) }) }
    : realCreate(tag);
  const video = Object.getOwnPropertyDescriptor(s.dom.window.HTMLVideoElement.prototype, 'videoWidth');
  Object.defineProperty(s.dom.window.HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280, configurable: true });
  Object.defineProperty(s.dom.window.HTMLVideoElement.prototype, 'videoHeight', { get: () => 720, configurable: true });
  const sizes = [];
  const jsQR = (data, w, h, o) => { sizes.push([w, h, o.inversionAttempts]); return { data: 'ABCD2345' }; };
  const got = [];
  Q.open({ document: s.doc, deps: { navigator: s.navigator, BarcodeDetector: undefined, jsQR }, onCode: (c) => got.push(c) });
  await wait(50);
  assert.deepEqual(got, ['ABCD2345']);
  assert.deepEqual(sizes[0], [800, 450, 'dontInvert'], '大きな映像は縮めて読む');
  assert.equal(s.stopped.length, 1);
  if (video) Object.defineProperty(s.dom.window.HTMLVideoElement.prototype, 'videoWidth', video);
}

// 4. カメラを許可しなかった → 設定の案内とコード入力の案内。画面は開いたまま「やめる」で閉じる
{
  const s = setup({ deny: 'NotAllowedError' });
  let closed = 0;
  const h = Q.open({ document: s.doc, deps: { navigator: s.navigator, BarcodeDetector: undefined, jsQR: () => null }, onCode: () => assert.fail(), onClose: () => closed++ });
  await wait(20);
  assert.match(msg(s.doc), /カメラを「許可」にしてから/);
  assert.match(msg(s.doc), /コードの文字を入力してください/);
  s.doc.querySelector('.qr-scan-close').click();
  assert.equal(s.doc.querySelector('.qr-scan'), null);
  assert.equal(closed, 1);
  h.close(); assert.equal(closed, 1, '2回閉じても1回だけ');
}

// 5. カメラが使えないブラウザー → コード入力の案内
{
  const s = setup({ navigator: {} });
  Q.open({ document: s.doc, deps: { navigator: s.navigator }, onCode: () => assert.fail() });
  await wait(10);
  assert.match(msg(s.doc), /まいにこの中からカメラを使えません/);
}

// 6. 読み取り中に「やめる」→ カメラを止め、その後に読めても参加に進まない
{
  let release;
  const s = setup({});
  s.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { release = () => r(s.stream); });
  const h = Q.open({ document: s.doc, deps: { navigator: s.navigator, jsQR: () => ({ data: 'ABCD2345' }) }, onCode: () => assert.fail('閉じた後は進まない') });
  await wait(5);
  h.close();
  release();
  await wait(30);
  assert.equal(s.stopped.length, 1, '遅れて開いたカメラもすぐ止める');
}

// 7. 入口の「家族とつながる」: ボタンがあり、読めたらコードを入れて参加の手続きに進む
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /onclick="scanInviteQr\(\)">📷 招待QRを読み取る/);
  assert.match(html, /<script src="qr-scan\.js\?v=\d+"><\/script>/);
  const a = html.indexOf('function scanInviteQr(){'), b = html.indexOf('function saveName(){', a);
  const box = { value: '' };
  let joined = 0, opened;
  const ctx = { document: { getElementById: (id) => (id === 'in-code' ? box : null) }, joinByCode: () => { joined++; },
    MainicoQrScan: { open: (o) => { opened = o; } }, alert: () => assert.fail() };
  vm.createContext(ctx); vm.runInContext(html.slice(a, b), ctx);
  ctx.scanInviteQr();
  opened.onCode('ABCD2345');
  assert.equal(box.value, 'ABCD2345');
  assert.equal(joined, 1, '読めたら「招待コードで参加」と同じ手続きへ');
  const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'qr-scan\.js'/, '電波がないときも画面の部品として控える');
}
console.log('アプリの中で招待QRを読み取る: コードの取り出し・BarcodeDetector・jsQR・カメラ不許可・非対応・途中でやめる・入口のボタン 7項目 passed');
