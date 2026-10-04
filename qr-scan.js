/* まいにこ：アプリの中でQRを読み取る(2026-10-04・作り直し設計書 A4)
 *
 * iPhoneでは、ホーム画面に追加したまいにことSafariで保存場所が分かれるため、
 * 標準のカメラアプリで招待QRを読むと、ホーム画面のまいにこに招待コードが入らないことがある。
 * そこで、まいにこの中のカメラで読み取れるようにする。
 *  - 読み取りは、使える端末では BarcodeDetector(Android の Chrome など)、使えない端末(iPhone)では jsQR を使う。
 *    jsQR は、読み取りを始めたときだけ読み込む(改ざん検知の integrity 付き)。
 *  - カメラの映像は端末の中だけで使い、保存も送信もしない。読み取りが終わったら、すぐカメラを止める。
 *  - まいにこの招待QR(まいにこのアドレス＋?invite=コード)か、招待コードの文字そのものだけを受け付ける。
 *    ほかのQR(おまもりタグ・もしもの控えなど)は「招待QRではありません」と出して読み続ける。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MainicoQrScan = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const APP_ORIGIN = 'https://pocham4173.github.io';
  const APP_PATH = '/hidamari/';
  const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
  const JSQR_SRC = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  const JSQR_SRI = 'sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx';
  const SCAN_EVERY_MS = 250;

  /* 読み取った文字から招待コードを取り出す。まいにこの招待でなければ null */
  function parseInvite(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const bare = raw.replace(/[\s-]/g, '').toUpperCase();
    if (CODE_RE.test(bare)) return bare;
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.origin !== APP_ORIGIN || (u.pathname !== APP_PATH && u.pathname !== APP_PATH + 'index.html')) return null;
    const code = String(u.searchParams.get('invite') || '').trim().toUpperCase();
    return CODE_RE.test(code) ? code : null;
  }

  function cameraMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError')
      return 'カメラを使えませんでした。スマホの設定で、このアプリ（Safari・ブラウザー）のカメラを「許可」にしてから、もう一度押してください。読み取れないときは、コードの文字を入力してください。';
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      return 'カメラが見つかりませんでした。コードの文字を入力してください。';
    if (name === 'NotReadableError')
      return 'カメラをほかのアプリが使っています。ほかのアプリを閉じてから、もう一度押してください。';
    return 'カメラを開けませんでした。コードの文字を入力してください。';
  }

  /* jsQR を1回だけ読み込む */
  let jsqrLoading = null;
  function loadJsQR(doc) {
    const g = doc.defaultView || globalThis;
    if (typeof g.jsQR === 'function') return Promise.resolve(g.jsQR);
    if (jsqrLoading) return jsqrLoading;
    jsqrLoading = new Promise((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = JSQR_SRC; s.integrity = JSQR_SRI; s.crossOrigin = 'anonymous'; s.async = true;
      s.onload = () => (typeof g.jsQR === 'function' ? resolve(g.jsQR) : reject(new Error('jsqr-missing')));
      s.onerror = () => reject(new Error('jsqr-load'));
      doc.head.appendChild(s);
    }).catch((e) => { jsqrLoading = null; throw e; });
    return jsqrLoading;
  }

  /* 端末に合う読み取り方を選ぶ。戻り値は (画像の元) => Promise<文字の配列> */
  async function makeDetector(doc, deps) {
    const g = doc.defaultView || globalThis;
    const BD = deps && 'BarcodeDetector' in deps ? deps.BarcodeDetector : g.BarcodeDetector;
    if (typeof BD === 'function') {
      try {
        const formats = typeof BD.getSupportedFormats === 'function' ? await BD.getSupportedFormats() : ['qr_code'];
        if (formats.includes('qr_code')) {
          const bd = new BD({ formats: ['qr_code'] });
          return async (video) => (await bd.detect(video)).map((r) => r.rawValue);
        }
      } catch (e) { /* jsQR に切り替える */ }
    }
    const jsQR = deps && deps.jsQR ? deps.jsQR : await loadJsQR(doc);
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return async (video) => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return [];
      // 大きすぎる映像は縮めて読む(古いスマホでも重くならないように)
      const scale = Math.min(1, 800 / Math.max(w, h));
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      return r && r.data ? [r.data] : [];
    };
  }

  /* 読み取り画面を開く。招待コードが読めたら onCode(code) を呼んで閉じる。
     戻り値: { close } 。deps はテスト用(getUserMedia・BarcodeDetector・jsQR を差し替える) */
  function open(opts) {
    const doc = opts.document || document;
    const deps = opts.deps || {};
    const g = doc.defaultView || globalThis;
    const nav = deps.navigator || g.navigator;
    let stream = null, timer = null, closed = false, busy = false;

    const wrap = doc.createElement('div');
    wrap.className = 'qr-scan';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '招待QRを読み取る');
    wrap.innerHTML =
      '<div class="qr-scan-box">' +
      '<div class="qr-scan-ttl">招待QRを読み取る</div>' +
      '<div class="qr-scan-view"><video playsinline muted autoplay></video><div class="qr-scan-frame" aria-hidden="true"></div></div>' +
      '<p class="qr-scan-msg" role="status" aria-live="polite">カメラを準備しています…</p>' +
      '<p class="qr-scan-note">ご家族の画面に出ている招待QRを、四角の中に映してください。カメラの映像は保存も送信もしません。</p>' +
      '<button type="button" class="entry-btn sub qr-scan-close">やめる（コードを入力する）</button>' +
      '</div>';
    doc.body.appendChild(wrap);
    const video = wrap.querySelector('video');
    const msg = wrap.querySelector('.qr-scan-msg');
    const say = (t) => { msg.textContent = t; };

    function stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {} stream = null; }
      try { video.srcObject = null; } catch (e) {}
    }
    function close() {
      if (closed) return;
      closed = true; stop();
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (typeof opts.onClose === 'function') opts.onClose();
    }
    wrap.querySelector('.qr-scan-close').addEventListener('click', close);

    (async () => {
      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
        say('このスマホ・ブラウザーでは、まいにこの中からカメラを使えません。コードの文字を入力してください。');
        return;
      }
      try {
        stream = await nav.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) { say(cameraMessage(e)); return; }
      if (closed) { stop(); return; }
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* 自動再生できなくても、映像が来れば読める */ }
      let detect;
      try { detect = await makeDetector(doc, deps); }
      catch (e) { stop(); say('読み取りの準備ができませんでした。通信を確認して、もう一度押すか、コードの文字を入力してください。'); return; }
      if (closed) return;
      say('QRを四角の中に映してください');
      const tick = async () => {
        timer = null;
        if (closed || busy) return;
        busy = true;
        try {
          for (const text of await detect(video)) {
            const code = parseInvite(text);
            if (code) { close(); opts.onCode(code); return; }
            say('まいにこの招待QRではありません。ご家族の「家族を追加する」で出したQRを映してください。');
          }
        } catch (e) { /* 1枚読めなくても続ける */ }
        finally { busy = false; }
        if (!closed) timer = setTimeout(tick, SCAN_EVERY_MS);
      };
      tick();
    })();

    return { close };
  }

  return { parseInvite, open, cameraMessage, JSQR_SRC, JSQR_SRI };
});
