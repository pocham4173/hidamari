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
  addEventListener(name, handler) { if(name==='click') this._click=handler; }
  setAttribute(name,value) { this[name]=value; }
  focus() { this.focused=true; }
  scrollIntoView() { this.scrolled=true; }
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
assert.ok(html.indexOf('id="card-family-notes-preview"')<html.indexOf('id="card-next-yotei"'));
assert.ok(html.indexOf('id="card-next-yotei"')<html.indexOf('id="card-family-tasks-preview"'));
assert.match(html, /id="card-today-records" style="display:none;"[\s\S]*?ご本人からの連絡/);
assert.match(html, /今日の記録をふり返りで見る/);
assert.match(html, /id="watch-tag-history"/);
assert.match(html, /この端末で確認しました/);
assert.match(html, /get\(\{source:'server'\}\)/);
assert.match(html, /id="medicine-info-area"[\s\S]*?id="medicine-name"[\s\S]*?id="medicine-timing"/);
assert.match(html, /'medicine-info':1/);
assert.match(html, /function showTab\(t\)[\s\S]*?resetFamilyScroll\(\);\s*\}/);
assert.match(html, /id="card-care-quick"[\s\S]*?家族のワンタップ記録/);
assert.doesNotMatch(html, /家庭で選ぶ介護の記録|家族の介護記録/);
console.log('✅ 家族ホームはワンタップ記録を先に、補助入力を開閉式に表示');

{
  const familyBody={scrollTop:420};let top=-1;
  const context={document:{querySelector:()=>familyBody},window:{scrollTo:arg=>{top=typeof arg==='object'?arg.top:arg;}}};
  vm.runInNewContext(section('function resetFamilyScroll(){','function showPage(id){'),context);
  context.resetFamilyScroll();
  assert.equal(familyBody.scrollTop,0);
  assert.equal(top,0);
  console.log('✅ 家族・家族のみのタブは画面上部から開く');
}

{
  const ids=Object.fromEntries(['watch-tag-home','tag-unread-count','tag-seen-btn','home-watch-tag-status']
    .map(id=>[id,new Element()]));
  ids['watch-tag-home'].classList={add(){},remove(){}};
  const context={document:{getElementById:id=>ids[id]},previewStorage:{setItem(){}},Date};
  vm.runInNewContext(section('function tagLastSeen(){','function tagNotifySound(){'),context);
  context.tagApplyUnread(2);
  assert.equal(ids['watch-tag-home'].style.display,'block');
  context.tagMarkSeen();
  assert.equal(ids['watch-tag-home'].style.display,'none','確認済みのタグが未確認の伝言を押し下げない');
  console.log('✅ タグの最優先表示は未確認の間だけ');
}

{
  const ids=Object.fromEntries(['watch-tag-area','watch-tag-alerts','watch-tag-home',
    'home-watch-tag-status','watch-tag-history','tag-unread-count','tag-seen-btn']
    .map(id=>[id,new Element()]));
  ids['watch-tag-home'].classList={add(){},remove(){}};
  let listener,mirrored=0,notified=0;
  const context={
    document:{getElementById:id=>ids[id]},gid:()=> 'group',watchTagUnsub:null,
    col:()=>({doc:()=>({get:async()=>({exists:true,data:()=>({watchTagActive:true,watchTagId:'tag1'})})})}),
    db:{collection:()=>({doc:()=>({collection:()=>({orderBy(){return this;},limit(){return this;},
      onSnapshot(options,callback){assert.equal(options.includeMetadataChanges,true);listener=callback;return ()=>{};}})})})},
    renderWatchTag(){},tagLastSeen:()=>0,mirrorTagAlert(){mirrored++;},tagApplyUnread:n=>{ids['watch-tag-home'].style.display=n?'block':'none';},
    tagNotifySound(){notified++;},tagOsNotify(){},esc:v=>v,dateJp:()=> '9月12日',tagNotifiedThrough:0,
    console:{warn(){}},Date
  };
  vm.runInNewContext(section('async function loadWatchTag(){','function renderWatchTag(id){'),context);
  await context.loadWatchTag();
  const alert={id:'alert1',data:()=>({situation:'safe',createdAt:{toDate:()=>new Date()}})};
  listener({metadata:{fromCache:true},forEach:fn=>fn(alert)});
  assert.match(ids['home-watch-tag-status'].textContent,/今は判断できません/);
  assert.equal(ids['watch-tag-home'].style.display,'block');
  assert.equal(notified,0,'保存済みの通知で新しい警告音を鳴らさない');
  assert.equal(mirrored,0,'キャッシュだけの通知を確定した履歴として書かない');
  listener({metadata:{fromCache:false},forEach:fn=>fn(alert)});
  assert.equal(notified,1);
  assert.equal(mirrored,1);
  console.log('✅ タグも通信未確認と確定した通知を区別する');
}

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
  const sources = [];
  const context = {
    document: { getElementById: id => ids[id] },
    recY: 2026, recM: 8, recReq: 0,
    recDayStr: (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    recDrawSummary: () => { summarized = true; },
    recEvents: [], recPrevEvents: [], recPrevReady: false,
    col: () => ({ where() { return this; }, get(options) { sources.push(options?.source); return Promise.reject(new Error('offline')); } }),
    console: { warn() {} }, Date, Promise
  };
  vm.runInNewContext(section('function recShowLoading(m){', '/* 日ごとの件数 */'), context);
  context.recLoad();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(summarized, false);
  assert.deepEqual(sources,['server','server'],'キャッシュの0件を確定した0件として扱わない');
  assert.match(ids['rec-sum'].innerHTML, /0件という意味ではありません/);
  assert.match(ids['rec-sum'].innerHTML, /onclick="recLoad\(\)"/);
  assert.match(ids['rec-day'].innerHTML, /記録なしという意味ではありません/);
  console.log('✅ 通信失敗では0件と表示せず、再試行できる');
}

{
  const list = new Element();
  const preview = new Element();
  const previewCard = new Element();
  const data = {
    notes: [{ _id: 'note1', uid: 'author', name: '送り手', text: '連絡します', at: { seconds: 1 } }],
    noteAcks: [{ _id: 'ack1', replyTo: 'note1', uid: 'familyA', name: '家族A', at: { seconds: 2 } }],
    noteReplies: []
  };
  let viewer = 'familyB';
  const context = {
    document: { getElementById: id => id === 'family-notes-preview' ? preview : id === 'card-family-notes-preview' ? previewCard :
      id.startsWith('family-note-') && id !== 'family-note-list' ? list.children.find(x=>x.id===id) : list,
      createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    familyOnlyData: data, familyOnlyLoad: {notes:'ready',noteAcks:'ready',noteReplies:'ready'}, uid: () => viewer, foDateTime: () => '9月12日 10:00', foByNewest: (a,b) => b.at.seconds-a.at.seconds,
    ackFamilyNote() {}, replyFamilyNote() {}, deleteFamilyEvent() {}, Object
  };
  vm.runInNewContext(section('function renderFamilyNotes(){', 'async function ackFamilyNote(id){'), context);
  context.renderFamilyNotes();
  assert.match(preview.textContent, /確認が必要な伝言 1件/);
  assert.equal(previewCard.style.display, 'block');
  assert.match(preview.textContent, /連絡します/);
  const noteButton=preview.children.find(x=>x.className==='family-preview-link');
  assert.ok(noteButton,'未確認の伝言自体を押せる');
  noteButton._click();
  assert.equal(list.children[0].id,'family-note-note1');
  assert.equal(list.children[0].focused,true);
  assert.equal(list.children[0].scrolled,true);
  data.notes.push({_id:'note2',uid:'author',name:'送り手',text:'新しい確認済み',at:{seconds:3}});
  data.noteAcks.push({_id:'ack2',replyTo:'note2',uid:'familyB',name:'家族B',at:{seconds:4}});
  context.renderFamilyNotes();
  assert.equal(list.children[0].id,'family-note-note1','新しい確認済みより古い未確認を先に表示');
  assert.match(list.textContent, /確認した人: 家族Aさん/);
  assert.match(list.textContent, /表示されていない家族の確認状況は分かりません/);
  assert.match(list.textContent, /自分が確認しました/);
  viewer = 'familyA';
  context.renderFamilyNotes();
  assert.equal(previewCard.style.display, 'block','別の未確認の伝言を見逃さない');
  assert.doesNotMatch(preview.textContent, /連絡します/, '確認済みの伝言はホームで繰り返さない');
  assert.match(list.textContent, /あなたは確認済み/);
  assert.doesNotMatch(list.children.find(x=>x.id==='family-note-note1').textContent, /自分が確認しました/);
  viewer = 'author';
  context.renderFamilyNotes();
  assert.equal(previewCard.style.display, 'none');
  assert.match(list.textContent, /自分が書いた伝言/);
  assert.doesNotMatch(list.textContent, /自分が確認しました/);
  viewer = 'familyA';
  context.familyOnlyLoad.noteAcks='error';
  context.renderFamilyNotes();
  assert.match(preview.textContent, /読み込めませんでした/);
  assert.equal(previewCard.style.display, 'block');
  assert.doesNotMatch(preview.textContent, /0件/);
  context.familyOnlyLoad.noteAcks='cached';
  context.renderFamilyNotes();
  assert.match(preview.textContent, /今は判断できません/);
  assert.equal(previewCard.style.display,'block');
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
  const summary=new Element(), heading=new Element();
  const context={
    document:{getElementById:id=>id==='rec-sum'?summary:heading,createElement:tag=>new Element(tag)},
    recY:2026,recM:8,recPrevReady:false,recPrevEvents:[],
    recEvents:[
      {_id:'note',type:'family-note',date:'2026-09-12',at:{seconds:1},name:'家族A',text:'明日は通院'},
      {_id:'task',type:'family-task',date:'2026-09-12',at:{seconds:2},name:'家族B',text:'薬局に行く'}
    ],
    recVisible:v=>!['family-note','family-task'].includes(v.type),
    REC_LABEL:{'family-note':v=>['家族の伝言','','家族Aさん「'+v.text+'」'],
      'family-task':v=>['家族のやること','','家族Bさん「'+v.text+'」']},
    recTime:()=> '10:00',recReplyFor:()=>'',Date
  };
  vm.runInNewContext(section('function recDrawSummary(){','const AISATSU_BACK_WORDS='),context);
  context.recDrawSummary();
  assert.match(summary.textContent,/生活の記録 0件/);
  assert.match(summary.textContent,/家族間の共有は別に2件/);
  assert.match(summary.textContent,/家族間の共有履歴.*明日は通院.*薬局に行く/);
  assert.equal(summary.children[1].tagName,'details','記録からわかることは閉じて整理');
  assert.ok(summary.children.filter(x=>x.tagName==='details').length>=2,'詳しい一覧も押して開く');
  console.log('✅ 月のまとめに家族の伝言・やることを生活記録と区別して残す');
}

{
  const body=new Element();
  const context={
    document:{getElementById:()=>body},
    REC_LABEL:{aisatsu:v=>['本人の挨拶','','ご本人が「'+v.text+'」と挨拶しました']},
    recTime:()=> '7:30',esc:v=>String(v)
  };
  vm.runInNewContext(section('function rgRender(d){','function recOpen(){'),context);
  context.rgRender({periodDays:28,buckets:[{label:'8/17〜'},{label:'8/24〜'}],
    M:{aisatsu:[1,0],message:[0,0],kusuri:[0,0],kibun:[0,0],onegai:[0,0],care:[0,0]},
    D:{aisatsu:{'2026-08-17':1}},E:{aisatsu:[{type:'aisatsu',date:'2026-08-17',text:'おはよう',at:{seconds:1}}]}});
  assert.match(body.innerHTML,/<details class="rg-chart">/);
  assert.match(body.innerHTML,/8\/17〜：1件/);
  assert.match(body.innerHTML,/ご本人が「おはよう」と挨拶しました/);
  assert.doesNotMatch(body.innerHTML,/>服薬に関する記録</,'0件の項目を並べてごちゃつかせない');
  console.log('✅ 期間グラフは項目を押すと期間別件数と記録内容が分かる');
}

{
  const context = vm.createContext({});
  vm.runInContext(section('function homeAttentionRows(items,replies,kOnly){', "let familyYoteiStatus='loading';"), context);
  const events = [
    { _id:'answered', type:'onegai', text:'お願いA', at:{seconds:1} },
    { _id:'open', type:'onegai', text:'お願いB', at:{seconds:2} },
    { _id:'quiet', type:'onegai', text:'今日はそっとしておいて', at:{seconds:3} },
    { _id:'old-reply', type:'family-message-back', text:'前の返事', at:{seconds:4} },
    { _id:'new-reply', type:'family-message-back', text:'新しい返事', at:{seconds:5} },
    { _id:'ordinary', type:'aisatsu', at:{seconds:6} }
  ];
  assert.deepEqual(Array.from(context.homeAttentionRows(events,{answered:[{type:'onegai-back'}]},false),v=>v._id),
    ['open','quiet','new-reply']);
  assert.equal(context.homeAttentionRows(events,{},true).length,0);
  console.log('✅ ホームには未回答のお願いと直近の返事だけを残し、家族のみの全件記録を隠す');
}

{
  let removed;
  const context = {
    document: {createElement: tag => new Element(tag), createTextNode: text => ({textContent:text})},
    recTime: () => '10:00', eventWhoClass: () => 'from-family', uid: () => 'mine',
    todayStr: () => '2026-09-12', cancelEvent: (...args) => {removed=args;}
  };
  vm.runInNewContext(section('function recRow(v, kind, cls, text, isReply){', 'function recDrawDay(){'),context);
  const own=context.recRow({_id:'own1',uid:'mine',date:'2026-09-12',type:'kusuri-kakunin',slot:'asa'},'服薬','','朝',false);
  assert.match(own.textContent,/自分の記録をとりけす/);
  own.children[1].children.at(-1)._click();
  assert.deepEqual(removed,['own1','kusuri-kakunin','asa']);
  assert.doesNotMatch(context.recRow({_id:'other',uid:'another',date:'2026-09-12',type:'care-log'},'記録','','訪問',false).textContent,/とりけす/);
  assert.doesNotMatch(context.recRow({_id:'past',uid:'mine',date:'2026-09-11',type:'care-log'},'記録','','訪問',false).textContent,/とりけす/);
  console.log('✅ ふり返りで当日・自分の記録だけ取り消せる');
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
  let onNext,onError,changes=0;
  const context={
    document:{getElementById:()=>null},
    col:()=>({where(){return this;},onSnapshot(options,success,error){
      assert.equal(options.includeMetadataChanges,true);
      onNext=success;onError=error;return ()=>{};
    }}),
    familyOnlyData:{notes:[]},familyOnlyLoad:{notes:'loading'},familyOnlyUnsubs:[],foByNewest:()=>0,
    renderFamilyNotes:()=>{},renderFamilyTasks:()=>{},foState:()=>{}
  };
  vm.runInNewContext(section('function foWatch(type,key,draw){','function initFamilyOnlyTools(){'),context);
  context.foWatch('family-note','notes',()=>{changes++;});
  onNext({metadata:{fromCache:true},forEach:fn=>fn({id:'saved',data:()=>({text:'保存済み'})})});
  assert.equal(context.familyOnlyLoad.notes,'cached');
  onNext({metadata:{fromCache:false},forEach:()=>{}});
  assert.equal(context.familyOnlyLoad.notes,'ready');
  assert.equal(changes,2,'通信回復でデータが同じでも表示状態を更新');
  onError(new Error('offline'));
  assert.equal(context.familyOnlyLoad.notes,'error');
  console.log('✅ 家族の伝言は保存済み・最新確認済み・通信エラーを区別する');
}

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

{
  const ids=Object.fromEntries(['medicine-info-list','medicine-name','medicine-timing','medicine-note',
    'medicine-info-btn','medicine-info-compose'].map(id=>[id,new Element(id==='medicine-info-list'?'div':'input')]));
  ids['medicine-name'].value='血圧の薬';ids['medicine-timing'].value='朝食後';ids['medicine-note'].value='薬袋を確認';
  let listener,saved;
  const context={
    document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)},
    col:()=>({where(){return this;},onSnapshot(options,next){assert.equal(options.includeMetadataChanges,true);listener=next;return ()=>{};}}),
    medicineInfoUnsub:null,medicineInfoRows:[],medicineInfoStatus:'loading',foByNewest:()=>0,
    foDateTime:()=> '9月13日 8:00',uid:()=> 'mine',deleteFamilyEvent(){},myName:()=> '家族A',
    foState(){},addEvent:async v=>{saved=v;},Date
  };
  vm.runInNewContext(section('function initMedicineInfo(){','function foMillis(v){'),context);
  context.initMedicineInfo();
  listener({metadata:{fromCache:false},forEach:fn=>fn({id:'med1',data:()=>({uid:'mine',medicineName:'薬A',medicineTiming:'朝',note:'1錠',name:'家族A'})})});
  assert.match(ids['medicine-info-list'].textContent,/薬A.*飲む時間・回数：朝.*メモ：1錠/);
  await context.addMedicineInfo();
  assert.equal(saved.type,'medicine-info');
  assert.equal(saved.medicineName,'血圧の薬');
  assert.equal(saved.medicineTiming,'朝食後');
  assert.equal(saved.note,'薬袋を確認');
  console.log('✅ お薬情報は承認家族の共有データとして登録・確認できる');
}
