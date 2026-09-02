#!/usr/bin/env node
/*
 * まいにこ 基本検査
 *
 * Pull Request ごとに、アプリが「基本的なところで壊れていないか」を機械的に確かめます。
 * 追加のパッケージは使わず、Node.js の標準機能だけで動きます。
 *
 * 確認するのは次の6点です。
 *   1. index.html の中の JavaScript に構文エラーがない
 *   2. onclick から呼ばれる関数が、すべて定義されている
 *   3. manifest.json が正しい JSON として読める
 *   4. sw.js に構文エラーがない
 *   5. tasks.html(チーム状況ボード)の JavaScript に構文エラーがない
 *   6. QRおまもりタグ画面の JavaScript に構文エラーがない
 *   7. 公開に必要なファイル(アイコンなど)が実際に存在する
 *
 * これは「明らかな壊れ方」を見つけるための検査です。
 * 実機での画面確認や、Firestore を使った通し確認の代わりにはなりません。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = [];

/* ---------- 表示まわり ---------- */

function record(title, ok, detail = '') {
  results.push({ title, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${title}${detail ? `\n   ${detail.replace(/\n/g, '\n   ')}` : ''}`);
  if (!ok) console.log(`::error::${title}${detail ? ` — ${detail.split('\n')[0]}` : ''}`);
}

function read(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

/* ---------- 共通の部品 ---------- */

/** index.html の中から、外部ファイルではないスクリプト部分を、行番号つきで取り出す */
function inlineScripts(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue; // 外部ファイルの読み込みは対象外
    const startLine = html.slice(0, m.index).split('\n').length;
    blocks.push({ code: m[2], startLine });
  }
  return blocks;
}

/** 構文だけを確かめる(中身は実行しない) */
function syntaxError(code, filename, lineOffset = 0) {
  try {
    new vm.Script(code, { filename, lineOffset });
    return null;
  } catch (e) {
    return `${e.message}${e.stack && e.stack.includes(filename) ? `\n   ${e.stack.split('\n')[0]}` : ''}`;
  }
}

/** HTML ファイルの中に直接書かれた JavaScript の構文を確かめる */
function checkHtmlSyntax(html, name) {
  const blocks = inlineScripts(html);
  if (blocks.length === 0) {
    record(`${name} の JavaScript に構文エラーがない`, false, 'スクリプト部分が1つも見つかりませんでした');
    return;
  }
  const errors = blocks
    .map((b) => syntaxError(b.code, name, b.startLine - 1))
    .filter(Boolean);
  record(
    `${name} の JavaScript に構文エラーがない (${blocks.length}か所を確認)`,
    errors.length === 0,
    errors.join('\n')
  );
}

/* ---------- 1. index.html の JavaScript 構文 ---------- */

const html = read('index.html');
if (html === null) {
  record('index.html がある', false, 'index.html が見つかりません');
} else {
  checkHtmlSyntax(html, 'index.html');
}

/* ---------- 2. onclick から呼ばれる関数が定義されている ---------- */

if (html !== null) {
  const js = inlineScripts(html).map((b) => b.code).join('\n');

  const defined = new Set();
  for (const m of js.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  for (const m of js.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/g)) defined.add(m[1]);
  for (const m of js.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);

  /* onclick="なまえ(" の形を、HTML 全体から拾う。
     画面を作るときに JavaScript の中で組み立てているボタンも、
     文字列としてこのファイルに書かれているため一緒に拾えます。 */
  const called = new Set();
  for (const m of html.matchAll(/\bonclick\s*=\s*"\s*([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);

  const missing = [...called].filter((n) => !defined.has(n)).sort();
  record(
    `onclick から呼ばれる関数が定義されている (${called.size}種類を確認)`,
    missing.length === 0,
    missing.length ? `定義が見つからない関数: ${missing.join(', ')}` : ''
  );
}

/* ---------- 3. manifest.json が正しい JSON ---------- */

let manifest = null;
const manifestText = read('manifest.json');
if (manifestText === null) {
  record('manifest.json が正しい JSON として読める', false, 'manifest.json が見つかりません');
} else {
  try {
    manifest = JSON.parse(manifestText);
    const isObject = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest);
    record('manifest.json が正しい JSON として読める', isObject, isObject ? '' : '中身が「{ }」の形になっていません');
    if (!isObject) manifest = null;
  } catch (e) {
    record('manifest.json が正しい JSON として読める', false, e.message);
  }
}

/* ---------- 4. sw.js の構文 ---------- */

const sw = read('sw.js');
if (sw === null) {
  record('sw.js に構文エラーがない', false, 'sw.js が見つかりません');
} else {
  const err = syntaxError(sw, 'sw.js');
  record('sw.js に構文エラーがない', err === null, err || '');
}

/* ---------- 5. tasks.html の JavaScript 構文 ---------- */

/* チーム状況ボード。アプリ本体とは別のページですが、同じ場所に公開するため
   ここでも「明らかな壊れ方」を確かめます。 */
const tasksHtml = read('tasks.html');
if (tasksHtml === null) {
  record('tasks.html がある', false, 'tasks.html が見つかりません');
} else {
  checkHtmlSyntax(tasksHtml, 'tasks.html');
}

/* ---------- 6. tag.html の JavaScript 構文 ---------- */

const tagHtml = read('tag.html');
if (tagHtml === null) {
  record('tag.html がある', false, 'tag.html が見つかりません');
} else {
  checkHtmlSyntax(tagHtml, 'tag.html');
}

/* ---------- 7. 公開に必要なファイルが存在する ---------- */

const needed = new Map(); // ファイル名 -> どこから参照されているか

function need(ref, from) {
  if (ref === undefined || ref === null) return;
  const raw = String(ref).trim();
  if (raw.startsWith('#') || raw.startsWith('?')) return; // ページ内リンクは対象外
  let clean = raw.split(/[?#]/)[0];
  // 外部URL(https: data: mailto: など)は対象外
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return;
  // 「/」から始まる指定はサーバーの置き場所しだいなので対象外
  if (clean.startsWith('/')) return;
  clean = clean.replace(/^(?:\.\/)+/, '');
  if (clean === '.') clean = '';
  /* 「./」「」「sub/」のようにフォルダを指す書き方は、
     そのフォルダの入口ファイル index.html を確かめます。
     start_url: "./" は公開の入口 index.html を指すため、ここで拾われます。 */
  if (clean === '' || clean.endsWith('/')) clean += 'index.html';
  needed.set(clean, [...(needed.get(clean) || []), from]);
}

if (manifest) {
  // start_url の記載がないときは、公開の入口(index.html)が既定の入口になります
  need(manifest.start_url === undefined ? './' : manifest.start_url, 'manifest.json の start_url');
  for (const icon of manifest.icons || []) need(icon.src, 'manifest.json のアイコン');
}
/** HTML から、同じ場所に置いたファイルへの参照(href / src)を拾う */
function collectRefs(html, from) {
  // スクリプト部分を除いた HTML から、href / src の参照を拾う
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const m of markup.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/g)) need(m[1], from);
}

if (html !== null) {
  collectRefs(html, 'index.html');
  for (const m of html.matchAll(/serviceWorker\.register\(\s*'([^']+)'/g)) need(m[1], 'index.html の Service Worker 登録');
}
if (tagHtml !== null) collectRefs(tagHtml, 'tag.html');
/* tasks.html が読み込むアイコンなども、同じように存在を確かめます */
if (tasksHtml !== null) collectRefs(tasksHtml, 'tasks.html');

const missingFiles = [...needed.entries()].filter(([f]) => !fs.existsSync(path.join(ROOT, f)));
record(
  `公開に必要なファイルが存在する (${needed.size}件を確認)`,
  missingFiles.length === 0,
  missingFiles.length
    ? missingFiles.map(([f, froms]) => `${f} が見つかりません(${[...new Set(froms)].join(' / ')})`).join('\n')
    : [...needed.keys()].sort().join(', ')
);

/* ---------- まとめ ---------- */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '-'.repeat(50));
console.log(`${results.length}件中 ${results.length - failed.length}件が成功`);
console.log(failed.length === 0
  ? '基本検査はすべて通りました。'
  : '基本検査で問題が見つかりました。上の ❌ の内容を確認してください。');
console.log('※ この検査は、実機での画面確認や Firestore を使った通し確認の代わりにはなりません。');

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) =>
    `| ${r.ok ? '✅ 成功' : '❌ 失敗'} | ${r.title} | ${r.detail ? r.detail.replace(/\n/g, '<br>').replace(/\|/g, '\\|') : ''} |`
  );
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    ['## 基本検査の結果', '', '| 結果 | 検査した内容 | 内訳 |', '| --- | --- | --- |', ...rows, '',
     failed.length === 0 ? '**すべて通りました。**' : `**${failed.length}件が失敗しました。**`, '',
     '※ この検査は、実機での画面確認や Firestore を使った通し確認の代わりにはなりません。', ''].join('\n'));
}

process.exit(failed.length === 0 ? 0 : 1);
