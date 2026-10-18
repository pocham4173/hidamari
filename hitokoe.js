/* まいにこ「ひと声のきっかけ」(2026-10-01・2026-10-18 安全性の見直し)
 *
 * 押されなかった日は、心配の知らせではなく、声を聞くきっかけとして、家族の一人にそっと届きます。
 * まいにこやLINEに頼らず、家族が自分から声をかける(電話する・顔を見に行く)きっかけにするための機能です。
 * 安否確認・緊急通報ではありません。家族の対応・返事・報告は義務ではありません。
 *
 * しくみ(段階1: アプリの中。2026-10-04から「LINEにも送る」を選べる)
 *  - 家族が設定でオンにし、時刻(9・10・11・12時)を選ぶ。初めは切ってある。
 *  - オンにしたときだけ、ご本人のスマホに1回確認を出す。ご本人が「はい」を選ぶまでは動かない。
 *    ご本人があとから「やめる」を選んだら、家族が設定を変えても止まったまま(ご本人が自分で「使う」に戻すまで)。
 *  - 受け取る家族本人も「受け取る」を選ぶまでは、その人には届かない(2026-10-18)。設定した人・曜日の届け先に
 *    選ばれただけ・LINE連携しているだけでは了承とみなさない。家族はいつでも自分を届け先から外せる。
 *  - その時刻までにご本人の操作(挨拶・薬・体調・お願い・「今日はそっとしておいて」など)が1つもない日だけ、
 *    その日の届け先の家族1人のホームに出る。夜中0〜4時の操作は前の日の分に数える。日付と時刻は日本時間で判定する。
 *  - ご本人が了解した日・受け取る家族が了承した日(利用開始日)は出さない。
 *  - 設定・了解・その日の記録の3つを、すべてサーバーで確かめられたときだけ判定する。読み込み中・読み込み失敗・
 *    端末に残っていた古い控えだけのときは「判定できない」として、何も出さない(記録がないことにしない)。
 *  - 届け先は曜日ごとに決められる(日替わりの届け先。当番ではない)。決めていない曜日は、設定した人(了承している場合)。
 *  - 入院・旅行・デイサービスの日は「お休み」(毎週の曜日・期間)にできる。期間のお休みは終わった翌日から自動で再開する。
 *  - 受け取った人は、任意で「連絡しました」を押せる。押すと、ほかの家族にも「○○さんが11:20に連絡しました」と出る。
 *    押さなくてもよく、押していないことを確かめたり催促したりはしない。
 *  - ご本人の画面には、了解の確認と「その他の設定」のほかは何も出さない。催促も警告もしない。
 *  - 「LINEにも送る」をオンにすると、届け先の家族が「LINEでも受け取る」を選んでいて自分のLINEを登録しているとき、
 *    LINEにも1日1通届く(送るのはLINE送信役 worker.js。文面に名前・様子は書かない)。
 *    LINEへの送信の結果は、家族のホームに「送信を受け付けました(届いた・読まれたかは分かりません)」などと出す。
 *
 * 記録(家庭の events)
 *  hitokoe-config    家族の設定(最新1件が有効)。{enabled, line, hour, offWeekdays, pauses, assignees, requestId}
 *  hitokoe-consent   ご本人の了解。{requestId, answer:'yes'|'no', version}(ルールでご本人だけが書け、消せない)
 *  hitokoe-receive   家族本人の受け取りの了承。{answer:'yes'|'no', line:true|false}(ルールで家族本人だけが書け、消せない)
 *  hitokoe-contacted 家族の「連絡しました」(任意)。{target, date}
 *  hitokoe-sent      LINE送信役が書く、LINEへの送信の記録。{date, target, status:'accepted'|'unknown'|'failed'|'skipped'}
 */
(function(global){
  'use strict';
  var HOURS=[9,10,11,12], DEFAULT_HOUR=11;
  /* ご本人への説明の版(2026-10-18)。古い版への「はい」では動かず、新しい説明でもう一度聞く。「やめる」はどの版でも有効 */
  var CONSENT_VERSION='2026-10-18';
  var NOT_ACTIVITY={'hitokoe-consent':1,'hitokoe-receive':1,'hitokoe-sent':1,'device-recovery':1,'person-ui-config':1,'line-login-signin':1,'device-reconnect':1};
  var WD='日月火水木金土';

  function millis(v){
    if(!v) return 0;
    var a=v.at||v.createdAt;
    if(a&&typeof a.toMillis==='function') return a.toMillis();
    if(a&&a.seconds) return a.seconds*1000;
    return Number(v.clientAt)||0;
  }
  function newest(rows){ return rows.slice().sort(function(a,b){ return millis(b)-millis(a); })[0]||null; }
  function isHonnin(m){ return !!m&&(m.role==='honnin'||m.mode==='honnin'); }
  function approved(m){ return !!m&&(m.status===undefined||m.status==='approved'); }
  /* 日本時間の日付・時・曜日(端末の時間帯がずれていても、LINE送信役と同じ日付で判定する) */
  function jst(ms){ var d=new Date(ms+9*3600000); return {day:d.toISOString().slice(0,10),hour:d.getUTCHours()}; }
  function jstDayOf(ms){ return ms?jst(ms).day:''; }
  function weekdayOf(day){ var p=String(day).split('-'); return new Date(Date.UTC(+p[0],+p[1]-1,+p[2])).getUTCDay(); }
  function nextDay(day){ var p=String(day).split('-'); var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2]+1)); return d.toISOString().slice(0,10); }
  function mdText(day){ var p=String(day).split('-'); return Number(p[1])+'月'+Number(p[2])+'日'; }
  function hm(ms){ var j=new Date(ms+9*3600000); return j.getUTCHours()+':'+String(j.getUTCMinutes()).padStart(2,'0'); }

  /* 設定を正しい形にそろえる(壊れた値や古い形でも落ちないように) */
  function normalizeConfig(c){
    if(!c||c.type!=='hitokoe-config') return {enabled:false,line:false,hour:DEFAULT_HOUR,offWeekdays:[],pauses:[],assignees:{},requestId:'',uid:'',name:''};
    var hour=HOURS.indexOf(Number(c.hour))>=0?Number(c.hour):DEFAULT_HOUR;
    var off=Array.isArray(c.offWeekdays)?c.offWeekdays.map(Number).filter(function(n){return n>=0&&n<=6;}):[];
    var pauses=Array.isArray(c.pauses)?c.pauses.filter(function(p){return p&&/^\d{4}-\d{2}-\d{2}$/.test(p.from)&&/^\d{4}-\d{2}-\d{2}$/.test(p.to)&&p.from<=p.to;}).slice(0,10):[];
    var as={};
    if(c.assignees&&typeof c.assignees==='object') Object.keys(c.assignees).forEach(function(k){ if(/^[0-6]$/.test(k)&&typeof c.assignees[k]==='string') as[k]=c.assignees[k]; });
    return {enabled:c.enabled===true,line:c.line===true,hour:hour,offWeekdays:off,pauses:pauses,assignees:as,
      requestId:typeof c.requestId==='string'?c.requestId:'',uid:typeof c.uid==='string'?c.uid:'',name:typeof c.name==='string'?c.name:'',at:millis(c)};
  }
  function latestConfig(rows){ return normalizeConfig(newest((rows||[]).filter(function(v){ return v&&v.type==='hitokoe-config'; }))); }

  /* 家族本人の受け取りの了承(最新1件)。なければ null */
  function receiveFor(rows,u){
    return newest((rows||[]).filter(function(v){ return v&&v.type==='hitokoe-receive'&&v.uid===u&&(v.answer==='yes'||v.answer==='no'); }));
  }
  function receives(rows,u){ var r=receiveFor(rows,u); return !!r&&r.answer==='yes'; }
  /* その日に受け取る家族。届け先(なければ設定した人)のうち、承認済みの家族で、受け取りを了承している人。いなければ空 */
  function assigneeFor(cfg,day,members,receiveRows){
    var ok=function(u){ var m=members[u]; return u&&approved(m)&&!isHonnin(m)&&(receiveRows===undefined||receives(receiveRows,u))?u:''; };
    return ok(cfg.assignees[String(weekdayOf(day))]||'')||ok(cfg.uid)||'';
  }
  /* ご本人のいちばん新しい答え(どのお願いへの答えでも)。あとの「やめておく」は、家族が新しくお願いしても解除されない */
  function newestConsent(rows,target){
    return newest((rows||[]).filter(function(v){ return v&&v.type==='hitokoe-consent'&&v.uid===target&&(v.answer==='yes'||v.answer==='no'); }));
  }
  function pausedOn(cfg,day){
    if(cfg.offWeekdays.indexOf(weekdayOf(day))>=0) return true;
    return cfg.pauses.some(function(p){ return p.from<=day&&day<=p.to; });
  }
  /* 家族が受け取りに関わる人か(設定した人か、どこかの曜日の届け先) */
  function isCandidate(cfg,u){
    if(!u) return false;
    if(cfg.uid===u) return true;
    return Object.keys(cfg.assignees).some(function(k){ return cfg.assignees[k]===u; });
  }

  /* ご本人ごとに、今日のようすを判定する(画面に何を出すかの元)。
     o.ready が false のとき(設定・了解・その日の記録のどれかをサーバーで確かめられていない)は、すべて 'unknown'。 */
  function evaluate(o){
    var cfg=latestConfig(o.configRows), members=o.members||{}, out=[];
    var now=o.now instanceof Date?o.now:new Date(), j=jst(now.getTime()), day=o.day||j.day;
    var ready=o.ready!==false;
    Object.keys(members).forEach(function(target){
      var m=members[target];
      if(!approved(m)||!isHonnin(m)) return;
      var r={target:target,targetName:m.name||'ご本人',config:cfg,state:'off',assignee:'',assigneeName:'',contacted:null,sent:null};
      out.push(r);
      if(!ready){ r.state='unknown'; return; }
      if(!cfg.enabled) return;
      var consent=newestConsent(o.consentRows,target);
      if(consent&&consent.answer==='no'){ r.state='declined'; return; }
      if(!consent||consent.requestId!==cfg.requestId||consent.version!==CONSENT_VERSION){ r.state='waiting-consent'; return; }
      r.consentAt=millis(consent);
      var today=(o.todayRows||[]).filter(function(v){ return v&&v.date===day; });
      var contacted=newest(today.filter(function(v){ return v.type==='hitokoe-contacted'&&v.target===target; }));
      if(contacted) r.contacted={uid:contacted.uid,name:contacted.name||'家族',at:millis(contacted)};
      var sent=newest(today.filter(function(v){ return v.type==='hitokoe-sent'; }));
      if(sent) r.sent={target:sent.target,status:sent.status,name:(members[sent.target]||{}).name||'家族'};
      r.assignee=assigneeFor(cfg,day,members,o.receiveRows||[]);
      r.assigneeName=r.assignee&&members[r.assignee]?members[r.assignee].name||'家族':'';
      if(jstDayOf(r.consentAt)===day){ r.state='start-day'; return; }
      if(pausedOn(cfg,day)){ r.state='paused'; return; }
      var active=today.some(function(v){ return v.uid===target&&!NOT_ACTIVITY[v.type]; });
      if(active){ r.state='active'; return; }
      /* 夜中0〜4時は前の日の扱い。その時間には出さない(「今日はまだ」が昨日の話になるため) */
      if(j.day!==day||j.hour<cfg.hour){ r.state='before-time'; return; }
      if(!r.assignee){ r.state='no-receiver'; return; }
      var rec=receiveFor(o.receiveRows||[],r.assignee);
      if(rec&&jstDayOf(millis(rec))===day){ r.state='start-day'; return; }
      r.state=r.contacted?'contacted':'show';
    });
    return out;
  }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  var NOTES='「ひと声のきっかけ」は、安否確認・緊急通報ではありません。知らせがないことは無事の保証ではありません。心配なときは直接電話を。緊急時は119番へ。';
  var DUTY_NOTE='届け先は当番ではありません。対応・返事・報告は任意です。';
  var SENT_TEXT={
    accepted:function(n){ return '今日のお知らせを、'+n+'のLINEへ送る手続きが受け付けられました（届いたか・読まれたかは分かりません）'; },
    unknown:function(n){ return '今日の'+n+'へのLINEは、送信の結果が分かりませんでした（決めた時刻から3時間のうちは、同じお知らせを送り直すことがあります。二重には届きません）'; },
    failed:function(n){ return '今日の'+n+'へのLINEは、送れませんでした（アプリの中のお知らせだけです）'; },
    skipped:function(){ return '今日のLINEのお知らせは見送りました（アプリの中のお知らせだけです）'; }
  };

  /* ===== 家族ホームのカード ===== */
  function cardHtml(results,me){
    var html='';
    results.forEach(function(r){
      if(r.state==='unknown') return;
      if(r.state==='show'&&r.assignee===me){
        html+='<div class="card hitokoe-card" role="status">'+
          '<h3>🌼 ひと声のきっかけ</h3>'+
          '<p class="hitokoe-lead">今日はまだ'+esc(r.targetName)+'さんから届いていません。電話や顔を見に行くなど、あなたから声をかけるきっかけにどうぞ。</p>'+
          '<p class="note">押し忘れや外出のことも多くあります。電話では「押してないよ」とは言わず、「声が聞きたくて」でかけてみてください。'+esc(DUTY_NOTE)+'</p>'+
          '<button class="big-btn family" type="button" data-hitokoe-contacted="'+esc(r.target)+'">連絡しました（任意）</button>'+
          '<p class="note hitokoe-small">押さなくても大丈夫です。'+esc(NOTES)+'</p></div>';
      }else if(r.contacted&&(r.state==='contacted'||r.state==='show'||r.state==='active')){
        html+='<div class="card hitokoe-card done" role="status"><p class="hitokoe-done">🌼 '+
          (r.contacted.uid===me?'あなた':esc(r.contacted.name)+'さん')+'が'+hm(r.contacted.at)+'に'+esc(r.targetName)+'さんへ連絡しました</p></div>';
      }
      if(r.sent&&SENT_TEXT[r.sent.status]){
        html+='<p class="note hitokoe-small" data-hitokoe-sent>'+esc(SENT_TEXT[r.sent.status](r.sent.target===me?'あなた':r.sent.name+'さん'))+'</p>';
      }
    });
    return html;
  }

  /* ===== 家族の設定画面 ===== */
  function statusText(results,ready){
    if(ready===false) return '今の状態を確かめられませんでした。通信を確認して、開き直してください。';
    if(!results.length) return 'ご本人として参加している人がいないため、使えません。';
    return results.map(function(r){
      var n=esc(r.targetName)+'さん：';
      if(r.state==='unknown') return n+'今の状態を確かめています';
      if(r.state==='off') return n+'切っています';
      if(r.state==='waiting-consent') return n+'ご本人の了解待ちです（ご本人がまいにこを開くと、確認が1回だけ出ます）';
      if(r.state==='declined') return n+'ご本人が止めています。ご本人が「その他の設定」で「使う」を選ぶまで動きません';
      return n+'ご本人が了解しています'+(r.consentAt?'（'+mdText(jstDayOf(r.consentAt))+'）':'')+(r.config&&r.config.line?'。LINEにも送ります':'');
    }).join('<br>');
  }
  function receiveText(cfg,members,receiveRows){
    var fam=Object.keys(members).filter(function(u){ return approved(members[u])&&!isHonnin(members[u])&&isCandidate(cfg,u); });
    if(!fam.length) return '';
    return '受け取る家族の了承：'+fam.map(function(u){
      var r=receiveFor(receiveRows,u);
      var t=!r?'まだ答えていません':r.answer!=='yes'?'受け取らない':(r.line?'受け取る（LINEでも）':'受け取る（アプリの中だけ）');
      return esc(members[u].name||'家族')+'さん＝'+t;
    }).join('、')+'。了承していない人には届きません。';
  }
  function settingsHtml(cfg,members,results,receiveRows,me,ready){
    var fam=Object.keys(members).filter(function(u){ return approved(members[u])&&!isHonnin(members[u]); });
    var opt=function(sel){ return '<option value="">（設定した人）</option>'+fam.map(function(u){ return '<option value="'+esc(u)+'"'+(sel===u?' selected':'')+'>'+esc(members[u].name||'家族')+'</option>'; }).join(''); };
    var mine=receiveFor(receiveRows||[],me);
    var h='<p class="note">押されなかった日に、家族の1人へ「声をかけてみませんか」とそっと届きます。心配の知らせではありません。'+esc(DUTY_NOTE)+'</p>'+
      '<p class="note hitokoe-small">'+esc(NOTES)+'</p>'+
      '<p class="note" data-hitokoe-status>'+statusText(results,ready)+'</p>'+
      '<p class="note" data-hitokoe-receivers>'+receiveText(cfg,members,receiveRows||[])+'</p>'+
      '<label class="consent-item"><input type="checkbox" data-hk="enabled"'+(cfg.enabled?' checked':'')+'> 使う（オンにすると、ご本人のスマホに了解の確認が1回出ます）</label>'+
      '<label class="consent-item"><input type="checkbox" data-hk="line"'+(cfg.line?' checked':'')+'> LINEにも送る（1日1通・名前や様子は書きません）</label>'+
      '<label>お知らせする時刻<select data-hk="hour">'+HOURS.map(function(x){ return '<option value="'+x+'"'+(cfg.hour===x?' selected':'')+'>'+x+'時までに届かないとき</option>'; }).join('')+'</select></label>'+
      '<details><summary>曜日ごとの届け先（日替わり・受け取る家族は1人）</summary><p class="note">'+esc(DUTY_NOTE)+'届け先に選ばれた人が「受け取る」を選んでいない日は、受け取りを了承している設定した人に届きます。</p><div class="hitokoe-grid">';
    for(var i=0;i<7;i++) h+='<label>'+WD.charAt(i)+'曜<select data-hk-day="'+i+'">'+opt(cfg.assignees[String(i)]||'')+'</select></label>';
    h+='</div></details><details><summary>お休みの日（デイサービス・入院・旅行など）</summary><div class="note">毎週お休みの曜日</div><div class="hitokoe-week">';
    for(var j=0;j<7;j++) h+='<label><input type="checkbox" data-hk-off="'+j+'"'+(cfg.offWeekdays.indexOf(j)>=0?' checked':'')+'>'+WD.charAt(j)+'</label>';
    h+='</div><div class="note">期間でお休み（10件まで。終わった翌日から自動で再開します）</div><ul class="hitokoe-pauses">'+
      pauseItems(cfg.pauses)+
      '</ul><div class="yt-form-row"><label>から<input type="date" data-hk="from"></label><label>まで<input type="date" data-hk="to"></label></div>'+
      '<button class="set-btn" type="button" data-hk-act="pause">この期間をお休みにする</button></details>'+
      '<button class="big-btn family" type="button" data-hk-act="save">保存する</button>'+
      '<div class="save-state" data-hk-state aria-live="polite"></div>'+
      '<div class="set-sec" data-hk-mine><h4>あなたの受け取り</h4>'+
      '<p class="note">今の設定：'+(!mine?'まだ答えていません（受け取りません）':mine.answer!=='yes'?'受け取らない':(mine.line?'受け取る（LINEでも）':'受け取る（アプリの中だけ）'))+'</p>'+
      '<p class="note hitokoe-small">受け取ると、届け先の日に、あなたのホームにお知らせが出ます。'+esc(DUTY_NOTE)+'いつでもやめられます。</p>'+
      '<label class="consent-item"><input type="checkbox" data-hk-recv="line"'+(mine&&mine.answer==='yes'&&mine.line?' checked':'')+'> LINEでも受け取る（LINE連携している場合）</label>'+
      '<div class="yt-form-row"><button class="set-btn" type="button" data-hk-act="recv-yes">受け取る</button>'+
      '<button class="set-btn" type="button" data-hk-act="recv-no">受け取らない（届け先から外れる）</button></div>'+
      '<div class="save-state" data-hk-recv-state aria-live="polite"></div></div>';
    return h;
  }

  function pauseItems(list){
    return list.map(function(p,k){ return '<li>'+esc(p.from)+' 〜 '+esc(p.to)+'（'+esc(mdText(nextDay(p.to)))+'から再開） <button type="button" class="yt-del" data-hk-unpause="'+k+'">消す</button></li>'; }).join('');
  }
  function consentQuestion(hour,who,line){
    return '挨拶やお薬などの記録が'+hour+'時までに1つもない日は、'+who+'に「声をかけるきっかけ」のお知らせが届きます。'+
      (line?'お知らせは、まいにこの画面と、LINEにも届きます（LINEには名前や様子は書きません）。':'')+'よろしいですか。';
  }
  function receiveQuestion(cfg,targetName,line){
    return targetName+'さんの記録が'+cfg.hour+'時までに1つもない日に、あなたが届け先の日は「ひと声のきっかけ」のお知らせを受け取りますか。'+
      (line?'まいにこの画面と、LINEにも届きます（LINEには名前や様子は書きません）。':'まいにこの画面に出ます。')+
      DUTY_NOTE+'あとから設定でやめられます。';
  }

  /* ===== つなぎ込み ===== */
  function create(ctx){
    var st={configRows:[],consentRows:[],receiveRows:[],todayRows:[],unsubs:[],timer:null,cfgOk:false,todayOk:false,failed:false,
      pausesDraft:null,sending:{},asking:''};
    function members(){ return ctx.members()||{}; }
    function ready(){ return st.cfgOk&&st.todayOk&&!st.failed; }
    function results(){ return evaluate({configRows:st.configRows,consentRows:st.consentRows,receiveRows:st.receiveRows,todayRows:st.todayRows,
      members:members(),now:new Date(),day:ctx.day(),ready:ready()}); }
    function renderCard(){
      var box=ctx.document.getElementById(ctx.cardId);
      if(!box) return;
      box.innerHTML=ready()?cardHtml(results(),ctx.uid()):'';
      Array.prototype.forEach.call(box.querySelectorAll('[data-hitokoe-contacted]'),function(b){
        b.addEventListener('click',function(){ contacted(b.getAttribute('data-hitokoe-contacted'),b); });
      });
    }
    async function contacted(target,btn){
      if(st.sending[target]) return;
      st.sending[target]=true; if(btn) btn.disabled=true;
      try{ await ctx.addEvent({type:'hitokoe-contacted',target:target,date:ctx.day(),name:ctx.myName(),clientAt:Date.now()}); }
      catch(e){ if(btn){ btn.disabled=false; btn.textContent='記録できませんでした。もう一度押す'; } }
      finally{ st.sending[target]=false; }
    }
    function stop(){ st.unsubs.forEach(function(u){ try{u();}catch(e){} }); st.unsubs=[]; if(st.timer){ clearInterval(st.timer); st.timer=null; } }
    /* サーバーで確かめられた一覧だけを使う(端末に残った控え・書き込み途中のものは、判定の根拠にしない) */
    function confirmed(snap){ var m=snap&&snap.metadata; return !(m&&(m.fromCache||m.hasPendingWrites)); }
    function listen(q,next){
      var onNext=function(snap){ next(snap); };
      var onErr=function(){ st.failed=true; renderCard(); renderSettingsStatus(); };
      return q.onSnapshot({includeMetadataChanges:true},onNext,onErr);
    }
    function start(){
      stop(); st.cfgOk=false; st.todayOk=false; st.failed=false; st.configRows=[]; st.consentRows=[]; st.receiveRows=[]; st.todayRows=[];
      var day=ctx.day();
      st.unsubs.push(listen(ctx.col('events').where('type','in',['hitokoe-config','hitokoe-consent','hitokoe-receive']),function(snap){
        var c=[],k=[],r=[]; snap.forEach(function(d){ var v=d.data(); (v.type==='hitokoe-config'?c:v.type==='hitokoe-consent'?k:r).push(v); });
        st.configRows=c; st.consentRows=k; st.receiveRows=r; st.cfgOk=confirmed(snap);
        renderCard(); renderSettingsStatus(); askReceive();
      }));
      st.unsubs.push(listen(ctx.col('events').where('date','==',day),function(snap){
        var rows=[]; snap.forEach(function(d){ rows.push(d.data()); }); st.todayRows=rows; st.todayOk=confirmed(snap); renderCard();
      }));
      /* 時刻を過ぎたら出す・日付が変わったら読み直す */
      st.timer=setInterval(function(){ if(ctx.day()!==day) start(); else renderCard(); },60000);
    }
    /* 受け取りに関わる家族に、1回だけ「受け取りますか」と聞く。「受け取らない」と答えた人には、自分から変えるまで聞かない */
    function askReceive(){
      if(!st.cfgOk||st.failed||typeof ctx.confirm!=='function') return;
      var cfg=latestConfig(st.configRows), me=ctx.uid();
      if(!cfg.enabled||!cfg.requestId||!isCandidate(cfg,me)) return;
      var mine=receiveFor(st.receiveRows,me);
      if(mine&&(mine.answer==='no'||!cfg.line||mine.line)) return;
      var key='mainicoHitokoeRecv-'+cfg.requestId+(cfg.line?'-line':'');
      if(st.asking===key) return;
      try{ if(ctx.storage&&ctx.storage.getItem(key)) return; }catch(e){}
      st.asking=key;
      var mem=members(), target=Object.keys(mem).filter(function(u){ return approved(mem[u])&&isHonnin(mem[u]); })[0];
      var name=target&&mem[target].name?mem[target].name:'ご本人';
      Promise.resolve(ctx.confirm(receiveQuestion(cfg,name,cfg.line),cfg.line?'LINEでも受け取る':'受け取る')).then(function(yes){
        if(yes!==true&&yes!==false){ st.asking=''; return; }
        try{ if(ctx.storage) ctx.storage.setItem(key,'1'); }catch(e){}
        return ctx.addEvent({type:'hitokoe-receive',answer:yes?'yes':'no',line:!!(yes&&cfg.line),name:ctx.myName(),clientAt:Date.now()});
      }).catch(function(){ try{ if(ctx.storage) ctx.storage.removeItem(key); }catch(e){} st.asking=''; });
    }
    function renderSettingsStatus(){
      var el=ctx.document.querySelector('#'+ctx.settingsId+' [data-hitokoe-status]');
      if(el) el.innerHTML=statusText(results(),ready());
      var rv=ctx.document.querySelector('#'+ctx.settingsId+' [data-hitokoe-receivers]');
      if(rv) rv.innerHTML=receiveText(latestConfig(st.configRows),members(),st.receiveRows);
    }
    function renderSettings(){
      var box=ctx.document.getElementById(ctx.settingsId);
      if(!box) return;
      if(st.failed){ box.innerHTML='<p class="note">今の設定を読み込めませんでした。通信を確認して、開き直してください。</p>'; return; }
      if(!st.cfgOk){ box.innerHTML='<p class="note">今の設定を読み込んでいます…</p>'; return; }
      var cfg=latestConfig(st.configRows);
      st.pausesDraft=cfg.pauses.slice();
      box.innerHTML=settingsHtml(cfg,members(),results(),st.receiveRows,ctx.uid(),ready());
      bindSettings(box,cfg);
    }
    function bindSettings(box,cfg){
      var q=function(s){ return box.querySelector(s); };
      var state=function(t,err){ var e=q('[data-hk-state]'); if(e){ e.textContent=t; e.classList.toggle('err',!!err); } };
      /* お休みの一覧は、足したり消したりするたびに描き直す(消す位置がずれないように) */
      var drawPauses=function(){
        var ul=q('.hitokoe-pauses'); ul.innerHTML=pauseItems(st.pausesDraft);
        Array.prototype.forEach.call(ul.querySelectorAll('[data-hk-unpause]'),function(b){
          b.addEventListener('click',function(){ st.pausesDraft.splice(Number(b.getAttribute('data-hk-unpause')),1); drawPauses(); state('「保存する」を押すと反映されます'); });
        });
      };
      drawPauses();
      q('[data-hk-act="pause"]').addEventListener('click',function(){
        var f=q('[data-hk="from"]').value,t=q('[data-hk="to"]').value||f;
        if(!f||t<f){ state('お休みの期間を正しく選んでください',true); return; }
        if(st.pausesDraft.length>=10){ state('期間のお休みは10件までです。古いものを消してください',true); return; }
        st.pausesDraft.push({from:f,to:t}); drawPauses();
        state(mdText(f)+'から'+mdText(t)+'までお休みにし、'+mdText(nextDay(t))+'から自動で再開します。「保存する」を押すと反映されます');
      });
      q('[data-hk-act="save"]').addEventListener('click',async function(){
        var btn=this; var on=q('[data-hk="enabled"]').checked;
        /* 画面を開いた後にほかの家族が変えていても、最新の設定をもとに判断する */
        cfg=latestConfig(st.configRows);
        var as={}; for(var i=0;i<7;i++){ var v=q('[data-hk-day="'+i+'"]').value; if(v) as[String(i)]=v; }
        var off=[]; for(var j=0;j<7;j++) if(q('[data-hk-off="'+j+'"]').checked) off.push(j);
        var today=ctx.day();
        var line=on&&q('[data-hk="line"]').checked;
        var data={type:'hitokoe-config',enabled:on,line:line,hour:Number(q('[data-hk="hour"]').value)||DEFAULT_HOUR,
          assignees:as,offWeekdays:off,pauses:st.pausesDraft.filter(function(p){ return p.to>=today; }).slice(0,10),
          /* 切っている状態からオンにしたとき・LINEにも送るを新しく選んだときだけ、ご本人にもう一度了解を聞く */
          requestId:on?(cfg.enabled&&cfg.requestId&&(cfg.line||!line)?cfg.requestId:'r'+Date.now().toString(36)):'',
          name:ctx.myName(),clientAt:Date.now()};
        var ask=on&&data.requestId!==cfg.requestId;
        if(ask&&!await ctx.confirm((cfg.enabled?'LINEにも送るようにすると':'オンにすると')+'、ご本人のスマホに「'+consentQuestion(data.hour,'ご家族',line)+'」と1回だけ確認が出ます。ご本人が「はい」を選ぶまでは動きません。ご本人が「やめておく」を選んだら、その気持ちを大切にしてください（家族の設定では解除されません）。受け取る家族にも、受け取るかどうかを1回だけ聞きます。',cfg.enabled?'LINEにも送る':'オンにする')) return;
        btn.disabled=true; state('保存しています…');
        try{ await ctx.addEvent(data); state(on?(ask?'保存しました。ご本人の了解を待っています':'保存しました'):'切りました。お知らせは出ません'); }
        catch(e){ state('保存できませんでした。通信を確認してください',true); }
        finally{ btn.disabled=false; }
      });
      var recvState=function(t,err){ var e=q('[data-hk-recv-state]'); if(e){ e.textContent=t; e.classList.toggle('err',!!err); } };
      var sendReceive=async function(yes,btn){
        btn.disabled=true; recvState('保存しています…');
        try{
          await ctx.addEvent({type:'hitokoe-receive',answer:yes?'yes':'no',line:!!(yes&&q('[data-hk-recv="line"]').checked),name:ctx.myName(),clientAt:Date.now()});
          recvState(yes?'受け取るにしました（届け先の日に、あなたのホームに出ます）':'受け取らないにしました。あなたには届きません');
        }catch(e){ recvState('保存できませんでした。通信を確認してください',true); }
        finally{ btn.disabled=false; }
      };
      q('[data-hk-act="recv-yes"]').addEventListener('click',function(){ sendReceive(true,this); });
      q('[data-hk-act="recv-no"]').addEventListener('click',function(){ sendReceive(false,this); });
    }
    return {start:start,stop:stop,renderCard:renderCard,renderSettings:renderSettings,results:results};
  }

  /* ===== ご本人のスマホ: 了解の確認を1回だけ出す ===== */
  function createPersonPrompt(ctx){
    var st={configRows:[],mine:[],unsub:null,asking:''};
    function check(){
      var cfg=latestConfig(st.configRows);
      if(!cfg.enabled||!cfg.requestId||st.asking===cfg.requestId) return;
      var me=ctx.uid();
      if(st.mine.some(function(v){ return v.uid===me&&v.requestId===cfg.requestId&&v.version===CONSENT_VERSION; })) return;
      /* 一度「やめておく」を選んだご本人には、家族が設定を変えても聞き直さない(自分で「使う」に戻せる) */
      var last=newestConsent(st.mine,me);
      if(last&&last.answer==='no') return;
      var askedKey='mainicoHitokoeAsked-'+cfg.requestId+'-'+CONSENT_VERSION;
      try{ if(ctx.storage.getItem(askedKey)) return; }catch(e){}
      st.asking=cfg.requestId;
      var mem=ctx.members()||{};
      var names=[];
      [0,1,2,3,4,5,6].forEach(function(i){ var u=cfg.assignees[String(i)]||cfg.uid; var m=mem[u]; if(m&&m.name&&names.indexOf(m.name)<0) names.push(m.name); });
      if(!names.length&&mem[cfg.uid]&&mem[cfg.uid].name) names.push(mem[cfg.uid].name);
      var who=names.length?names.join('さん・')+'さん':'ご家族';
      var text=consentQuestion(cfg.hour,who,cfg.line)+'\n\n声をかけるきっかけにするためのものです。押し忘れても大丈夫です。あとから「その他の設定」でやめることもできます。';
      ctx.ask(text,'はい','やめておく').then(function(yes){
        /* 画面が切り替わって答えがなかったときは、記録せず次の機会にもう一度聞く */
        if(yes===null||yes===undefined){ st.asking=''; return; }
        try{ ctx.storage.setItem(askedKey,'1'); }catch(e){}
        return ctx.addEvent({type:'hitokoe-consent',requestId:cfg.requestId,answer:yes?'yes':'no',version:CONSENT_VERSION,clientAt:Date.now()})
          .then(function(){ ctx.speak(yes?'はい、に しました':'やめておく、に しました'); });
      }).catch(function(){ try{ ctx.storage.removeItem(askedKey); }catch(e){} st.asking=''; });
    }
    function start(){
      if(st.unsub){ try{st.unsub();}catch(e){} }
      st.unsub=ctx.col('events').where('type','in',['hitokoe-config','hitokoe-consent']).onSnapshot(function(snap){
        if(snap.metadata&&snap.metadata.fromCache) return;   /* サーバーで確かめてから聞く */
        var c=[],k=[]; snap.forEach(function(d){ var v=d.data(); (v.type==='hitokoe-config'?c:k).push(v); });
        st.configRows=c; st.mine=k; check();
      },function(){});
    }
    function stop(){ if(st.unsub){ try{st.unsub();}catch(e){} st.unsub=null; } }
    /* ご本人の「その他の設定」用: 今の状態と、あとから変える操作。止めている(最新の答えが「やめておく」)ときは 'no' */
    function status(){
      var cfg=latestConfig(st.configRows);
      if(!cfg.enabled||!cfg.requestId) return {enabled:false};
      var me=ctx.uid();
      var last=newestConsent(st.mine,me);
      var answer=last&&(last.answer==='no'||(last.requestId===cfg.requestId&&last.version===CONSENT_VERSION))?last.answer:'';
      return {enabled:true,hour:cfg.hour,line:cfg.line,answer:answer};
    }
    function answer(yes){
      var cfg=latestConfig(st.configRows);
      if(!cfg.enabled||!cfg.requestId) return Promise.resolve(false);
      return ctx.addEvent({type:'hitokoe-consent',requestId:cfg.requestId,answer:yes?'yes':'no',version:CONSENT_VERSION,clientAt:Date.now()}).then(function(){ return true; });
    }
    return {start:start,stop:stop,status:status,answer:answer};
  }

  global.MainicoHitokoe={evaluate:evaluate,latestConfig:latestConfig,normalizeConfig:normalizeConfig,assigneeFor:assigneeFor,receiveFor:receiveFor,
    cardHtml:cardHtml,settingsHtml:settingsHtml,statusText:statusText,create:create,createPersonPrompt:createPersonPrompt,NOTES:NOTES,CONSENT_VERSION:CONSENT_VERSION};
})(typeof window!=='undefined'?window:globalThis);
