// Isolated demo: these tests never connect to Firebase, LINE or real accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');
const html = readFileSync(new URL('../prototype-family-flow.html', import.meta.url), 'utf8');

function setup({ speech = false } = {}) {
  const errors = [], calls = { prints: 0, network: 0, utterance: null };
  const console = new VirtualConsole();
  console.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://prototype.invalid/prototype-family-flow.html',
    runScripts: 'dangerously', virtualConsole: console,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.print = () => { calls.prints++; };
      const deny = () => { calls.network++; throw new Error('Unexpected external operation'); };
      w.fetch = deny; w.XMLHttpRequest = deny; w.WebSocket = deny;
      Object.defineProperty(w, 'localStorage', { get: deny });
      Object.defineProperty(w, 'sessionStorage', { get: deny });
      Object.defineProperty(w, 'indexedDB', { get: deny });
      if (speech) {
        w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        w.speechSynthesis = { speak(u) { calls.utterance = u; u.onstart(); }, cancel() {} };
      }
    }
  });
  const doc = dom.window.document;
  return {
    dom, doc, calls, errors,
    el: id => doc.getElementById(id),
    click: id => doc.getElementById(id).click(),
    check(selector) { const input = doc.querySelector(selector); assert.ok(input, selector); input.click(); },
    close() { assert.equal(calls.network, 0); assert.deepEqual(errors, []); dom.window.close(); }
  };
}

test('self-contained demo allows its exact script and blocks data connections', () => {
  const doc = new JSDOM(html).window.document;
  const csp = doc.querySelector('[http-equiv="Content-Security-Policy"]').content;
  const script = doc.querySelector('script').textContent;
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`));
  assert.ok(csp.includes("connect-src 'none'"));
  assert.ok(csp.includes("form-action 'none'"));
  assert.equal(doc.querySelectorAll('script[src],iframe,form,input[type="text"],textarea').length, 0);
  assert.equal(doc.querySelector('meta[name="robots"]').content, 'noindex,nofollow');
  assert.match(doc.body.textContent, /すべて架空の内容/);
});

test('reply, greeting and request appear only in the demo family view and can be undone', () => {
  const t = setup();
  t.check('[data-reply="ありがとう"]');
  t.click('greeting'); t.click('request-call');
  t.check('[data-scene="family"]');
  assert.equal(t.el('person').hidden, true);
  assert.equal(t.el('family').hidden, false);
  assert.equal(t.doc.activeElement.id, 'family-heading');
  assert.equal(t.el('family-reply-text').textContent, 'ありがとう');
  for (const id of ['family-reply', 'family-greeting', 'family-call']) assert.equal(t.el(id).hidden, false);
  assert.match(t.el('family-reply').textContent, /読んだかは未確認/);
  t.check('[data-scene="person"]');
  t.click('undo-reply'); t.click('undo-greeting'); t.click('undo-call');
  for (const id of ['family-reply', 'family-greeting', 'family-call']) assert.equal(t.el(id).hidden, true);
  t.close();
});

test('phone record requires a choice, is not duplicated and disappears after undo', () => {
  const t = setup();
  t.check('[data-scene="family"]'); t.click('open-record'); t.click('save-record');
  assert.match(t.el('record-error').textContent, /ひとつ以上/);
  t.check('[name="phone-detail"]'); t.click('save-record');
  assert.equal(t.el('last-title').textContent, '息子が電話しました');
  t.click('save-record'); // Guard even against a second invocation.
  t.check('[data-scene="consult"]');
  assert.equal(t.doc.querySelectorAll('[name="consult-record"]').length, 4);
  t.check('[data-scene="family"]'); t.click('undo-record');
  assert.equal(t.el('last-title').textContent, '娘が電話しました');
  t.check('[data-scene="consult"]');
  assert.equal(t.doc.querySelectorAll('[name="consult-record"]').length, 3);
  t.close();
});

test('assignee memo does not imply acceptance or completion; each transition is reversible', () => {
  const t = setup();
  assert.equal(t.el('task-tag').textContent, '引受け待ち');
  t.click('accept-task');
  assert.equal(t.el('task-tag').textContent, '息子が引受け');
  assert.equal(t.el('task-completion').textContent, '完了の記録はありません。');
  t.click('complete-task');
  assert.equal(t.el('task-tag').textContent, '完了の記録あり');
  assert.equal(t.el('cancel-task').hidden, true);
  t.click('undo-complete');
  assert.equal(t.el('task-tag').textContent, '息子が引受け');
  t.click('cancel-task');
  assert.equal(t.el('task-tag').textContent, '引受け待ち');
  t.close();
});

test('consultation includes only explicitly selected records and questions, with provenance', () => {
  const t = setup();
  t.check('[data-scene="consult"]'); t.click('preview-sheet');
  assert.equal(t.el('print-sheet').hidden, true);
  assert.match(t.el('consult-error').textContent, /それぞれひとつ以上/);
  t.check('[name="consult-record"][value="phone-17"]'); t.check('[name="question"]');
  t.click('preview-sheet');
  assert.equal(t.el('print-sheet').hidden, false);
  assert.equal(t.el('sheet-records').children.length, 1);
  assert.match(t.el('sheet-records').textContent, /10月17日.*記録した人：娘/);
  assert.doesNotMatch(t.el('sheet-records').textContent, /一緒にお茶/);
  assert.equal(t.el('sheet-questions').children.length, 1);
  t.click('print'); assert.equal(t.calls.prints, 1);
  t.check('[name="consult-record"][value="phone-17"]');
  assert.equal(t.el('print-sheet').hidden, true); // Do not print a stale selection.
  t.click('print'); assert.equal(t.calls.prints, 1);
  t.close();
});

test('cancel reset retains the trial; confirm reset and a new page start empty', () => {
  const t = setup();
  t.click('greeting'); t.click('accept-task');
  t.click('open-reset'); t.click('cancel-reset');
  assert.equal(t.el('family-greeting').hidden, false);
  t.click('open-reset'); t.click('confirm-reset');
  assert.equal(t.el('person').hidden, false);
  assert.equal(t.el('family-greeting').hidden, true);
  assert.equal(t.el('task-tag').textContent, '引受け待ち');
  assert.equal(t.doc.querySelectorAll('input:checked').length, 0);
  t.close();
  const fresh = setup();
  assert.equal(fresh.el('family-reply').hidden, true);
  fresh.close();
});

test('speech starts only on request, stops on navigation and keeps text when unavailable', () => {
  const t = setup({ speech: true });
  assert.equal(t.calls.utterance, null);
  t.click('speak');
  assert.match(t.calls.utterance.text, /10月19日/);
  assert.match(t.el('speech-status').textContent, /読み上げています/);
  t.check('[data-scene="family"]');
  assert.match(t.el('speech-status').textContent, /止めました/);
  t.calls.utterance.onend(); // A late callback must not overwrite the stopped state.
  assert.match(t.el('speech-status').textContent, /止めました/);
  t.close();
  const fallback = setup(); fallback.click('speak');
  assert.match(fallback.el('speech-status').textContent, /文字で確認/);
  assert.match(fallback.el('person').textContent, /午後2時/);
  fallback.close();
});
