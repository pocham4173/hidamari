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
  const errors = [], calls = { prints: 0, network: 0, utterance: null, spoken: [] };
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
        w.speechSynthesis = { speak(u) { calls.utterance = u; calls.spoken.push(u.text); u.onstart(); }, cancel() {} };
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

test('familiar era display is labeled as a fixed example and read aloud on request', () => {
  const t = setup({ speech: true });
  assert.match(t.el('speak-date').textContent, /令和8年.*昭和101年・平成38年/);
  assert.match(t.el('speak-date').textContent, /固定の例/);
  t.click('speak-date');
  for (const part of ['令和8年', '昭和で101年', '平成で38年', '2026年10月18日', '午前9時5分']) {
    assert.ok(t.calls.utterance.text.includes(part));
  }
  t.click('stop-speech');
  assert.equal(t.el('stop-speech').hidden, true);
  t.check('[data-scene="family"]');
  assert.equal(t.el('speak-date').hidden, true);
  t.check('[data-scene="person"]');
  assert.equal(t.el('speak-date').hidden, false);
  t.close();
});

test('morning greeting and each medicine slot are reversible person records, not family contact', () => {
  const t = setup();
  t.click('greeting');
  for (const key of ['asa', 'hiru', 'yoru']) {
    t.click('medicine-' + key); t.click('medicine-' + key);
    assert.equal(t.el('medicine-' + key).disabled, true);
  }
  t.check('[data-scene="family"]');
  assert.match(t.el('family-greeting').textContent, /おはよう.*10月18日.*春子さん（本人）/s);
  assert.equal(t.el('family-medicine-list').children.length, 3);
  assert.match(t.el('family-medicine').textContent, /実際に飲んだことの確認ではありません/);
  assert.equal(t.el('last-title').textContent, '娘が電話しました');
  assert.match(t.el('last-time').textContent, /10月17日/);
  t.check('[data-scene="consult"]');
  assert.equal(t.doc.querySelectorAll('[name="consult-record"]').length, 7);
  assert.equal(t.doc.querySelectorAll('[name="consult-record"]:checked').length, 0);
  t.check('[name="consult-record"][value="greeting-18"]');
  t.check('[name="consult-record"][value="medicine-asa"]');
  t.check('[name="question"]'); t.click('preview-sheet');
  assert.equal(t.el('sheet-records').children.length, 2);
  assert.match(t.el('sheet-records').textContent, /おはよう/);
  assert.match(t.el('sheet-records').textContent, /朝の薬.*証明するものではありません.*春子さん（本人）/s);
  assert.doesNotMatch(t.el('sheet-records').textContent, /昼の薬|夜の薬|買い物の荷物/);
  t.check('[data-scene="person"]'); t.click('undo-medicine-asa');
  assert.equal(t.el('print-sheet').hidden, true);
  assert.equal(t.el('medicine-asa').disabled, false);
  t.click('undo-greeting'); t.click('undo-medicine-hiru'); t.click('undo-medicine-yoru');
  assert.equal(t.el('family-medicine').hidden, true);
  t.check('[data-scene="consult"]');
  assert.equal(t.doc.querySelectorAll('[name="consult-record"]').length, 3);
  assert.equal(t.doc.querySelectorAll('[name="consult-record"]:checked').length, 0);
  t.close();
});

test('read-aloud covers messages and recording results, and mute suppresses automatic replies', () => {
  const t = setup({ speech: true });
  t.click('speak-message'); assert.match(t.calls.utterance.text, /娘からの連絡.*お茶/);
  t.click('greeting'); assert.match(t.calls.utterance.text, /おはよう.*残しました/);
  t.click('medicine-asa'); assert.match(t.calls.utterance.text, /朝の薬.*残しました/);
  t.click('undo-medicine-asa'); assert.match(t.calls.utterance.text, /取り消しました/);
  t.click('toggle-voice');
  assert.equal(t.el('toggle-voice').getAttribute('aria-pressed'), 'false');
  const count = t.calls.spoken.length;
  t.click('medicine-hiru'); assert.equal(t.calls.spoken.length, count);
  assert.equal(t.el('medicine-hiru').disabled, true);
  t.click('speak-message'); assert.equal(t.calls.spoken.length, count + 1);
  t.click('toggle-voice'); assert.equal(t.el('toggle-voice').getAttribute('aria-pressed'), 'true');
  t.close();
});

test('speech errors do not remove records and stale callbacks do not interrupt newer speech', () => {
  const t = setup({ speech: true });
  t.click('speak'); const old = t.calls.utterance;
  t.click('medicine-yoru');
  old.onerror(); old.onend();
  assert.equal(t.el('stop-speech').hidden, false);
  assert.match(t.el('speech-status').textContent, /読み上げています/);
  t.calls.utterance.onerror();
  assert.match(t.el('speech-status').textContent, /文字で確認/);
  assert.equal(t.el('medicine-yoru').disabled, true);
  assert.equal(t.el('family-medicine-list').children.length, 1);
  t.dom.window.speechSynthesis.speak = () => { throw new Error('Playback unavailable'); };
  t.click('greeting');
  assert.equal(t.el('family-greeting').hidden, false);
  assert.match(t.el('speech-status').textContent, /文字で確認/);
  t.click('open-reset'); t.click('confirm-reset');
  assert.equal(t.el('family-medicine').hidden, true);
  assert.equal(t.el('medicine-yoru').disabled, false);
  t.close();
});

test('regional entry leads to the shared support page', () => {
  const t = setup();
  const link = t.el('ueda-life');
  assert.equal(link.getAttribute('href'), './ueda-support.html');
  assert.match(link.textContent, /上田の暮らしサポート/);
  assert.equal(t.doc.querySelectorAll('a[href*="city.ueda.nagano.jp"]').length, 0);
  t.close();
});

function setExample(t, value) {
  t.el('connection-example').value=value;
  t.el('connection-example').dispatchEvent(new t.dom.window.Event('change'));
}

test('the original request choices coexist and cancellation removes only the chosen request', () => {
  const t=setup();
  const choices=[...t.doc.querySelectorAll('[data-request]')];
  assert.deepEqual(choices.map(b=>b.dataset.request),['話したい','買い物をお願い','予定を確認したい','少し困っている','あとで連絡して','今日はそっとしておいて']);
  t.click('request-call');choices[1].click();choices[1].click();choices[5].click();
  assert.equal(t.el('family-request-list').children.length,3);
  assert.match(t.el('family-request-list').textContent,/電話してほしい.*買い物をお願い.*今日はそっとしておいて/);
  t.el('request-undo-list').firstElementChild.click();
  assert.doesNotMatch(t.el('family-request-list').textContent,/買い物/);
  assert.match(t.el('family-request-list').textContent,/電話してほしい.*今日はそっとしておいて/);
  assert.equal(choices[1].disabled,false);
  t.close();
});

test('a connected family with no incoming content gets no invented message or visit', () => {
  const t=setup({speech:true});
  setExample(t,'quiet');
  assert.equal(t.el('message-content').hidden,true);
  assert.equal(t.el('message-empty').hidden,false);
  assert.match(t.el('message-empty').textContent,/伝言は、まだありません/);
  assert.equal(t.el('next-visit').hidden,true);
  assert.equal(t.el('no-visit').hidden,false);
  assert.equal(t.el('family-next-visit').hidden,true);
  assert.equal(t.el('family-no-visit').hidden,false);
  t.click('speak');
  assert.doesNotMatch(t.calls.utterance.text,/娘が会いに来/);
  assert.match(t.calls.utterance.text,/まだ登録されていません/);
  const count=t.calls.spoken.length;t.click('speak-message');
  assert.equal(t.calls.spoken.length,count);
  t.check('[data-reply="ありがとう"]');
  assert.equal(t.el('family-reply').hidden,true);
  t.click('request-call');assert.equal(t.el('family-call').hidden,false);
  t.check('[data-scene="family"]');assert.equal(t.el('family').hidden,false);
  t.close();
});

test('unconnected people keep their own records without implying delivery or sharing on connection', () => {
  const t=setup();setExample(t,'solo');
  assert.match(t.el('message-empty').textContent,/家族とまだつながっていません/);
  assert.equal(t.el('request-call').hidden,true);
  assert.equal(t.el('request-more').hidden,true);
  assert.equal(t.el('local-record-note').hidden,false);
  t.click('request-call');t.check('[data-request="買い物をお願い"]');
  assert.equal(t.el('family-call').hidden,true);
  t.check('[data-scene="family"]');assert.equal(t.el('family').hidden,true);
  t.click('greeting');t.click('medicine-asa');
  assert.match(t.el('word-status').textContent,/自分用.*共有されません/);
  assert.match(t.el('medicine-status-asa').textContent,/家族には共有されません/);
  assert.equal(t.el('family-greeting').hidden,true);
  assert.equal(t.el('family-medicine').hidden,true);
  assert.equal(t.el('greeting').disabled,true);
  setExample(t,'connected');
  assert.equal(t.el('greeting').disabled,true);assert.equal(t.el('medicine-asa').disabled,true);
  assert.equal(t.el('family-greeting').hidden,true);assert.equal(t.el('family-medicine').hidden,true);
  t.click('medicine-hiru');
  assert.match(t.el('family-medicine-list').textContent,/昼の薬/);
  assert.doesNotMatch(t.el('family-medicine-list').textContent,/朝の薬/);
  t.close();
});

test('changing examples stops old speech and invalidates old replies and print selections; reset restores the example', () => {
  const t=setup({speech:true});t.check('[data-reply="ありがとう"]');t.click('request-call');
  t.check('[data-scene="consult"]');t.check('[name="consult-record"][value="phone-17"]');t.check('[name="question"]');t.click('preview-sheet');
  t.click('speak-message');const old=t.calls.utterance;
  setExample(t,'solo');old.onend();
  assert.equal(t.el('person').hidden,false);
  assert.equal(t.el('family-reply').hidden,true);assert.equal(t.el('family-call').hidden,true);
  assert.equal(t.el('print-sheet').hidden,true);assert.equal(t.el('consult-records').children.length,0);
  t.click('print');assert.equal(t.calls.prints,0);
  assert.match(t.el('speech-status').textContent,/止めました/);
  t.click('open-reset');t.click('confirm-reset');
  assert.equal(t.el('connection-example').value,'connected');
  assert.equal(t.el('message-content').hidden,false);assert.equal(t.el('next-visit').hidden,false);
  assert.equal(t.el('family-request-list').children.length,0);
  t.close();
});
