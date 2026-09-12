import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function section(from, to) {
  const start = html.indexOf(from), end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing section: ${from}`);
  return html.slice(start, end);
}

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.style = {}; this._text = ''; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  addEventListener() {}
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this._text = String(value); this.children = []; }
  get innerHTML() { return this._text; }
}

assert.match(html, /id="card-family-notes"[\s\S]*?<details class="family-compose" id="family-note-compose"/);
assert.match(html, /id="card-family-tasks"[\s\S]*?<details class="family-compose" id="family-task-compose"/);
assert.match(html, /insertBefore\([\s\S]*?'card-care-quick'[\s\S]*?'card-krec'/);
assert.match(html, /id="card-family-notes-preview"[\s\S]*?onclick="openFamilyNotes\(\)"/);
assert.match(html, /id="card-next-yotei"[\s\S]*?id="family-today-tomorrow"[\s\S]*?onclick="showTab\('t-yotei'\)"/);
assert.match(html, /id="card-family-tasks-preview"[\s\S]*?onclick="openFamilyTasks\(\)"/);
assert.ok(html.indexOf('id="card-next-yotei"')<html.indexOf('id="card-family-notes-preview"'));
assert.ok(html.indexOf('id="card-family-notes-preview"')<html.indexOf('id="card-family-tasks-preview"'));
assert.match(html, /id="card-care-quick"[\s\S]*?家族のワンタップ記録/);
assert.doesNotMatch(html, /家庭で選ぶ介護の記録|家族の介護記録/);
console.log('✅ 家族ホームはワンタップ記録を先に、補助入力を開閉式に表示');

{
  const loading = new Element();
  let delayed;
  const stage = { addEventListener: (name, fn) => { if (name === 'error') stage.onError = fn; } };
  const watchdog = section("window.mainicoStartupStage='必要なファイルの読み込み中';", '</script>');
  vm.runInNewContext(watchdog, {
    document: { getElementById: () => loading, createElement: tag => new Element(tag) },
    window: stage,
    setTimeout: (fn, ms) => { assert.equal(ms, 15000); delayed = fn; },
    console: { warn() {} }
  });
  stage.mainicoStartupStage = 'ログインの応答待ち';
  delayed();
  assert.match(loading.textContent, /ログインの応答待ち/);
  assert.match(loading.textContent, /もう一度読み込む/);
  assert.match(loading.textContent, /Safariで開く/);
  assert.equal(loading.children.length, 3, '縦並びの案内と再試行ボタンを表示');
  stage.onError({ target: { tagName: 'SCRIPT' } });
  assert.match(loading.textContent, /外部ファイルを読み込めませんでした/);
  loading.style.display = 'none';
  loading.innerHTML = '画面を開きました';
  delayed();
  assert.equal(loading.innerHTML, '画面を開きました');
  console.log('✅ 起動が止まれば縦並びの再試行と段階を表示し、起動済みの画面は妨げない');
}
assert.match(html, /window\.mainicoStartupStage='ログインの応答待ち';/);
assert.match(html, /try\{ navigator\.serviceWorker\.register\('sw\.js'\)\.catch/);
assert.match(html, /window\.showStartupProblem\('ログインできませんでした'\)/);

{
  const ids = Object.fromEntries(['rec-cal', 'rec-sum', 'rec-day', 'rec-day-note', 'rec-sum-ttl', 'rec-day-ttl', 'rec-ttl']
    .map(id => [id, new Element()]));
  let summarized = false;
  const context = {
    document: { getElementById: id => ids[id] },
    recY: 2026, recM: 8, recReq: 0,
    recDayStr: (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    recDrawSummary: () => { summarized = true; },
    recEvents: [], recPrevEvents: [], recPrevReady: false,
    col: () => ({ where() { return this; }, get() { return Promise.reject(new Error('offline')); } }),
    console: { warn() {} }, Date, Promise
  };
  vm.runInNewContext(section('function recShowLoading(m){', '/* 日ごとの件数 */'), context);
  context.recLoad();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(summarized, false);
  assert.match(ids['rec-sum'].innerHTML, /0件という意味ではありません/);
  assert.match(ids['rec-sum'].innerHTML, /onclick="recLoad\(\)"/);
  assert.match(ids['rec-day'].innerHTML, /記録なしという意味ではありません/);
  console.log('✅ 通信失敗では0件と表示せず、再試行できる');
}

{
  const list = new Element();
  const preview = new Element();
  const data = {
    notes: [{ _id: 'note1', uid: 'author', name: '送り手', text: '連絡します', at: { seconds: 1 } }],
    noteAcks: [{ _id: 'ack1', replyTo: 'note1', uid: 'familyA', name: '家族A', at: { seconds: 2 } }],
    noteReplies: []
  };
  let viewer = 'familyB';
  const context = {
    document: { getElementById: id => id === 'family-notes-preview' ? preview : list,
      createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    familyOnlyData: data, familyOnlyLoad: {notes:'ready',noteAcks:'ready'}, uid: () => viewer, foDateTime: () => '9月12日 10:00',
    ackFamilyNote() {}, replyFamilyNote() {}, deleteFamilyEvent() {}, Object
  };
  vm.runInNewContext(section('function renderFamilyNotes(){', 'async function ackFamilyNote(id){'), context);
  context.renderFamilyNotes();
  assert.match(preview.textContent, /自分の確認記録がない伝言 1件/);
  assert.match(preview.textContent, /連絡します/);
  assert.match(list.textContent, /確認した人: 家族Aさん/);
  assert.match(list.textContent, /表示されていない家族の確認状況は分かりません/);
  assert.match(list.textContent, /自分が確認しました/);
  viewer = 'familyA';
  context.renderFamilyNotes();
  assert.match(preview.textContent, /自分の確認記録がない伝言 0件/);
  assert.doesNotMatch(preview.textContent, /連絡します/, '確認済みの伝言はホームで繰り返さない');
  assert.match(list.textContent, /あなたは確認済み/);
  assert.doesNotMatch(list.textContent, /自分が確認しました/);
  viewer = 'author';
  context.renderFamilyNotes();
  assert.match(preview.textContent, /自分の確認記録がない伝言 0件/);
  assert.match(list.textContent, /自分が書いた伝言/);
  assert.doesNotMatch(list.textContent, /自分が確認しました/);
  viewer = 'familyA';
  context.familyOnlyLoad.noteAcks='error';
  context.renderFamilyNotes();
  assert.match(preview.textContent, /読み込めませんでした/);
  assert.doesNotMatch(preview.textContent, /0件/);
  let sent = 0;
  const ackContext = {
    familyOnlyData: data, uid: () => viewer, myName: () => '家族B',
    addEvent: async () => { sent++; }, Date, Set,
    alert: () => { throw new Error('unexpected send failure'); }
  };
  vm.runInNewContext(section('const familyAckSending=new Set();', 'async function replyFamilyNote('), ackContext);
  await ackContext.ackFamilyNote('note1');
  assert.equal(sent, 0, '同じ家族による二度目の確認は送らない');
  viewer = 'familyB';
  await ackContext.ackFamilyNote('note1');
  assert.equal(sent, 1, '別の家族なら確認を記録できる');
  console.log('✅ 伝言の確認は家族ごとに区別し、他人の確認で自分を確認済みにしない');
}

{
  const schedule = new Element(), next = new Element();
  const context = vm.createContext({
    document: { getElementById: id => id === 'family-today-tomorrow' ? schedule : next,
      createElement: tag => new Element(tag) },
    isKOnly: () => true, todayStr: () => '2026-09-12', dateOnly: s => new Date(s+'T00:00:00'),
    dateString: d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
    dateJp: d => `${d.getMonth()+1}月${d.getDate()}日`,
    yoteiOccursOn: (v,s) => v.date===s, yoteiNextDate: (v,s) => v.date>=s?v.date:'',
    yoteiColor: () => '#4F7FD3', Date,
    yoteiCache: [{date:'2026-09-12',label:'通院',time:'09:00'},
      {date:'2026-09-13',label:'買い物'}, {date:'2026-09-14',label:'電話'}]
  });
  vm.runInContext(section("let familyYoteiStatus='loading';", 'function initKazoku(){'), context);
  context.renderFamilySchedule();
  assert.match(schedule.textContent, /読み込んでいます/);
  vm.runInContext("familyYoteiStatus='ready'",context);
  context.renderFamilySchedule();
  assert.match(schedule.textContent, /今日.*通院.*明日.*買い物/);
  assert.match(next.textContent, /電話/);
  vm.runInContext("familyYoteiStatus='cached'",context);
  context.renderFamilySchedule();
  assert.match(schedule.textContent, /保存済みの予定です/);
  vm.runInContext("familyYoteiStatus='error'",context);
  context.renderFamilySchedule();
  assert.match(schedule.textContent, /読み込めませんでした/);
  assert.doesNotMatch(schedule.textContent, /登録された予定はありません/);
  console.log('✅ 家族のみホームの今日・明日とその後の予定、通信失敗を区別する');
}
assert.match(html, /onSnapshot\(\{includeMetadataChanges:true\},snap=>/);

{
  const preview = new Element();
  const context = {
    document: {getElementById: () => preview, createElement: tag => new Element(tag)},
    familyOnlyLoad: {tasks:'ready',taskDone:'ready'},
    familyOnlyData: {tasks:[{_id:'late',text:'薬局',due:'2026-09-11'},
      {_id:'done',text:'完了した用事',due:'2026-09-12'},
      {_id:'later',text:'訪問',due:'2026-09-14'}]},
    todayStr: () => '2026-09-12',dateOnly: s => new Date(s+'T00:00:00'),
    dateJp: d => `${d.getMonth()+1}月${d.getDate()}日`,foByNewest: () => 0
  };
  vm.runInNewContext(section('function renderFamilyTasksPreview(done){','async function finishFamilyTask(id){'),context);
  context.renderFamilyTasksPreview({done:true});
  assert.match(preview.textContent,/未完了 2件/);
  assert.match(preview.textContent,/薬局.*期限が過ぎています.*訪問/);
  assert.doesNotMatch(preview.textContent,/完了した用事/);
  context.familyOnlyLoad.taskDone='error';
  context.renderFamilyTasksPreview({});
  assert.match(preview.textContent,/読み込めませんでした/);
  assert.doesNotMatch(preview.textContent,/0件/);
  console.log('✅ 家族のみホームの未完了・期限超過・通信失敗を区別する');
}

{
  const today = new Element();
  const context = {
    document: { getElementById: () => today, createElement: tag => new Element(tag),
      createTextNode: text => ({ textContent: text }) },
    foDateTime: () => '9月12日 14:20'
  };
  vm.runInNewContext(section('function renderTodayQuickRecords(items){', 'async function saveCareConfig(){'), context);
  context.renderTodayQuickRecords([{ type: 'care-log', text: '訪問した', name: '家族A' }]);
  assert.match(today.textContent, /訪問した ・ 家族Aさん ・ 9月12日 14:20/);
  console.log('✅ ワンタップ記録の結果はその場で名前と時刻を確認できる');
}
