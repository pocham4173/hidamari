/* 公式LINEを利用開始・毎日の入口に(2026-10-11)。メニューのリンク先・あいさつ・QRの一文・すでに使っている方への案内 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const NEED = '予定のお知らせを受け取るには、友だち追加後に、まいにこでLINE連携の設定が必要です。';
// メニュー②「はじめての方」: 本人も家族も使える・始め方・LINE連携が別に要ること。本人／家族はアプリの入口で選ぶ
const start = read('start.html');
assert.match(start, /<title>まいにこ はじめての方へ<\/title>/);
assert.match(start, /ご本人も、ご家族も使えます/);
assert.ok(start.includes(NEED), 'はじめての方: LINE連携が別に必要');
assert.match(start, /友だち追加だけでは、まいにこへの登録や家族への参加は完了しません/);
assert.match(start, /<a class="open" href="\.\/">まいにこを開く<\/a>/);
assert.match(start, /href="guide\/"/);
assert.match(start, /使っていた記録に戻る/, 'すでに使っている方は復旧へ');
assert.doesNotMatch(start, /onclick=/, 'LINEのページでは本人／家族を選ばせない(アプリの入口で選ぶ)');
// メニュー③「使い方」: 写真つきガイド。今の入口・家族のホーム・LINEの言葉
const guide = read('guide/index.html'), lineGuide = read('guide/line.html');
assert.match(guide, /招待から参加する<\/span> → <span class="btnlike or">本人<\/span>/);
assert.match(guide, /「今日見ること」/);
assert.doesNotMatch(guide, /本人が使う<\/span>|ご本人と一緒に初期設定する/);
assert.ok(lineGuide.includes('予定のお知らせを受け取るには、友だち追加後に、まいにこでLINE連携の設定が必要です。'));
assert.doesNotMatch(lineGuide, /LINEの送信先を追加|登録できました。」/);
// アプリの「自分のLINE」でも、友だち追加だけでは連携しないことを言う(QRの画像 line-qr.png にも同じ一文が入っている)
assert.ok(read('line-notify.js').includes('友だち追加だけでは、まだつながっていません'));
// すでに使っている方への案内: 記録が見つからないときは新しく始めずに「使っていた記録に戻る」
assert.match(read('index.html'), /記録が見つからないときは、新しく始めずに、下の「使っていた記録に戻る」を押してください/);
// 設定に「まいにこを紹介する」: ご本人・家族の両方の設定で、公式LINEのQRコードとLINEで送るを出す(2026-10-12)
{
  const html = read('index.html');
  const person = html.slice(html.indexOf('id="person-settings-modal"'), html.indexOf('id="person-settings-modal"') + 20000);
  const family = html.slice(html.indexOf('id="settings-modal"'));
  for (const [name, part] of [['ご本人', person], ['家族', family]]) {
    assert.match(part, /まいにこを紹介する/, name + 'の設定に「まいにこを紹介する」');
    assert.match(part, /<img src="line-qr\.png"/, name + 'の設定に公式LINEのQRコード');
    assert.match(part, /LINEで紹介を送る/, name + 'の設定にLINEで送る');
  }
  assert.match(html, /紹介するだけでは、相手はあなたの家庭には入りません/, '紹介と招待の違い');
}
// ご本人の「その他の設定」のLINEは長いので、ふだん閉じておく(ボタンの形の開け閉め)
assert.match(read('index.html'), /<details class="person-line-menu"><summary>LINEの設定を見る（登録・やめる）<\/summary>\s*<div id="person-line-area"><\/div>/);
console.log('公式LINEの入口: はじめての方・使い方・QRの一文・すでに使っている方への案内 passed');
