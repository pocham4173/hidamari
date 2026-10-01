/* まいにこ「ひと声のきっかけ」(2026-10-01)
 *
 * 押されなかった日は、心配の知らせではなく、声を聞くきっかけとして、家族の一人にそっと届きます。
 * まいにこやLINEに頼らず、家族が自分から声をかける(電話する・顔を見に行く)きっかけにするための機能です。
 *
 * しくみ(段階1: アプリの中だけ。LINEには送らない)
 *  - 家族が設定でオンにし、時刻(9・10・11・12時)を選ぶ。初めは切ってある。
 *  - オンにしたときだけ、ご本人のスマホに1回確認を出す。ご本人が「はい」を選ぶまでは動かない。
 *  - その時刻までにご本人の操作(挨拶・薬・体調・お願いなど)が1つもない日だけ、担当の家族1人のホームに出る。
 *    夜中0〜4時の操作は前の日の分に数える。
 *  - 担当は曜日ごとに決められる。決めていない曜日は、設定した人が受け取る。
 *  - 入院・旅行・デイサービスの日は「お休み」(毎週の曜日・期間)にできる。
 *  - 受け取った人が「連絡しました」を押すと、ほかの家族にも「○○さんが11:20に連絡しました」と出る。
 *  - ご本人の画面には、了解の確認のほかは何も出さない。催促も警告もしない。
 *
 * 記録(家庭の events)
 *  hitokoe-config    家族の設定(最新1件が有効)。{enabled, hour, offWeekdays, pauses, assignees, requestId}
 *  hitokoe-consent   ご本人の了解。{requestId, answer:'yes'|'no'}(ルールでご本人だけが書ける)
 *  hitokoe-contacted 家族の「連絡しました」。{target, date}
 */
(function(global){
  'use strict';
  var HOURS=[9,10,11,12], DEFAULT_HOUR=11;
  var NOT_ACTIVITY={'hitokoe-consent':1,'device-recovery':1,'person-ui-config':1};
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
  function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function weekdayOf(day){ var p=String(day).split('-'); return new Date(+p[0],+p[1]-1,+p[2]).getDay(); }
  function hm(ms){ var d=new Date(ms); return d.getHours()+':'+String(d.getMinutes()).padStart(2,'0'); }

  /* 設定を正しい形にそろえる(壊れた値や古い形でも落ちないように) */
  function normalizeConfig(c){
    if(!c||c.type!=='hitokoe-config') return {enabled:false,hour:DEFAULT_HOUR,offWeekdays:[],pauses:[],assignees:{},requestId:'',uid:'',name:''};
    var hour=HOURS.indexOf(Number(c.hour))>=0?Number(c.hour):DEFAULT_HOUR;
    var off=Array.isArray(c.offWeekdays)?c.offWeekdays.map(Number).filter(function(n){return n>=0&&n<=6;}):[];
    var pauses=Array.isArray(c.pauses)?c.pauses.filter(function(p){return p&&/^\d{4}-\d{2}-\d{2}$/.test(p.from)&&/^\d{4}-\d{2}-\d{2}$/.test(p.to)&&p.from<=p.to;}).slice(0,10):[];
    var as={};
    if(c.assignees&&typeof c.assignees==='object') Object.keys(c.assignees).forEach(function(k){ if(/^[0-6]$/.test(k)&&typeof c.assignees[k]==='string') as[k]=c.assignees[k]; });
    return {enabled:c.enabled===true,hour:hour,offWeekdays:off,pauses:pauses,assignees:as,
      requestId:typeof c.requestId==='string'?c.requestId:'',uid:typeof c.uid==='string'?c.uid:'',name:typeof c.name==='string'?c.name:'',at:millis(c)};
  }
  function latestConfig(rows){ return normalizeConfig(newest((rows||[]).filter(function(v){ return v&&v.type==='hitokoe-config'; }))); }

  /* その日に受け取る家族(担当が抜けていたら設定した人、その人もいなければ空) */
  function assigneeFor(cfg,day,members){
    var fam=function(u){ var m=members[u]; return approved(m)&&!isHonnin(m)?u:''; };
    return fam(cfg.assignees[String(weekdayOf(day))]||'')||fam(cfg.uid)||'';
  }
  function consentFor(cfg,rows,target){
    if(!cfg.requestId) return null;
    return newest((rows||[]).filter(function(v){ return v&&v.type==='hitokoe-consent'&&v.uid===target&&v.requestId===cfg.requestId&&(v.answer==='yes'||v.answer==='no'); }));
  }
  function pausedOn(cfg,day){
    if(cfg.offWeekdays.indexOf(weekdayOf(day))>=0) return true;
    return cfg.pauses.some(function(p){ return p.from<=day&&day<=p.to; });
  }

  /* ご本人ごとに、今日のようすを判定する(画面に何を出すかの元) */
  function evaluate(o){
    var cfg=latestConfig(o.configRows), members=o.members||{}, out=[];
    var now=o.now instanceof Date?o.now:new Date(), day=o.day||ymd(now);
    Object.keys(members).forEach(function(target){
      var m=members[target];
      if(!approved(m)||!isHonnin(m)) return;
      var r={target:target,targetName:m.name||'ご本人',config:cfg,state:'off',assignee:'',assigneeName:'',contacted:null};
      out.push(r);
      if(!cfg.enabled) return;
      var consent=consentFor(cfg,o.consentRows,target);
      if(!consent){ r.state='waiting-consent'; return; }
      if(consent.answer!=='yes'){ r.state='declined'; return; }
      r.consentAt=millis(consent);
      r.assignee=assigneeFor(cfg,day,members);
      r.assigneeName=r.assignee&&members[r.assignee]?members[r.assignee].name||'家族':'';
      var today=(o.todayRows||[]).filter(function(v){ return v&&v.date===day; });
      var contacted=newest(today.filter(function(v){ return v.type==='hitokoe-contacted'&&v.target===target; }));
      if(contacted) r.contacted={uid:contacted.uid,name:contacted.name||'家族',at:millis(contacted)};
      if(pausedOn(cfg,day)){ r.state='paused'; return; }
      var active=today.some(function(v){ return v.uid===target&&!NOT_ACTIVITY[v.type]; });
      if(active){ r.state='active'; return; }
      /* 夜中0〜4時は前の日の扱い。その時間には出さない(「今日はまだ」が昨日の話になるため) */
      if(ymd(now)!==day||now.getHours()<cfg.hour){ r.state='before-time'; return; }
      r.state=r.contacted?'contacted':'show';
    });
    return out;
  }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  var NOTES='「ひと声のきっかけ」は、安否確認・緊急通報ではありません。知らせがないことは無事の保証ではありません。心配なときは直接電話を。緊急時は119番へ。';

  /* ===== 家族ホームのカード ===== */
  function cardHtml(results,me){
    var html='';
    results.forEach(function(r){
      if(r.state==='show'&&r.assignee===me){
        html+='<div class="card hitokoe-card" role="status">'+
          '<h3>🌼 ひと声のきっかけ</h3>'+
          '<p class="hitokoe-lead">今日はまだ'+esc(r.targetName)+'さんから届いていません。電話や顔を見に行くなど、あなたから声をかけるきっかけにどうぞ。</p>'+
          '<p class="note">押し忘れや外出のことも多くあります。電話では「押してないよ」とは言わず、「声が聞きたくて」でかけてみてください。</p>'+
          '<button class="big-btn family" type="button" data-hitokoe-contacted="'+esc(r.target)+'">連絡しました</button>'+
          '<p class="note hitokoe-small">'+esc(NOTES)+'</p></div>';
      }else if(r.contacted&&(r.state==='contacted'||r.state==='show'||r.state==='active')){
        html+='<div class="card hitokoe-card done" role="status"><p class="hitokoe-done">🌼 '+
          (r.contacted.uid===me?'あなた':esc(r.contacted.name)+'さん')+'が'+hm(r.contacted.at)+'に'+esc(r.targetName)+'さんへ連絡しました</p></div>';
      }
    });
    return html;
  }

  /* ===== 家族の設定画面 ===== */
  function statusText(results){
    if(!results.length) return 'ご本人として参加している人がいないため、使えません。';
    return results.map(function(r){
      var n=esc(r.targetName)+'さん：';
      if(r.state==='off') return n+'切っています';
      if(r.state==='waiting-consent') return n+'ご本人の了解待ちです（ご本人がまいにこを開くと、確認が1回だけ出ます）';
      if(r.state==='declined') return n+'ご本人が「やめておく」を選びました。動いていません';
      return n+'ご本人が了解しています'+(r.consentAt?'（'+(new Date(r.consentAt).getMonth()+1)+'月'+new Date(r.consentAt).getDate()+'日）':'');
    }).join('<br>');
  }
  function settingsHtml(cfg,members,results){
    var fam=Object.keys(members).filter(function(u){ return approved(members[u])&&!isHonnin(members[u]); });
    var opt=function(sel){ return '<option value="">（設定した人）</option>'+fam.map(function(u){ return '<option value="'+esc(u)+'"'+(sel===u?' selected':'')+'>'+esc(members[u].name||'家族')+'</option>'; }).join(''); };
    var h='<p class="note">押されなかった日は、心配の知らせではなく、声を聞くきっかけとして、家族の一人にそっと届きます。まいにこやLINEに頼らず、自分から声をかけるための機能です。お知らせはアプリの中だけに出ます（LINEには送りません）。</p>'+
      '<p class="note hitokoe-small">'+esc(NOTES)+'</p>'+
      '<p class="note" data-hitokoe-status>'+statusText(results)+'</p>'+
      '<label class="consent-item"><input type="checkbox" data-hk="enabled"'+(cfg.enabled?' checked':'')+'> 使う（オンにすると、ご本人のスマホに了解の確認が1回出ます）</label>'+
      '<label>お知らせする時刻<select data-hk="hour">'+HOURS.map(function(x){ return '<option value="'+x+'"'+(cfg.hour===x?' selected':'')+'>'+x+'時までに届かないとき</option>'; }).join('')+'</select></label>'+
      '<details><summary>曜日ごとの担当（受け取る家族は1人）</summary><div class="hitokoe-grid">';
    for(var i=0;i<7;i++) h+='<label>'+WD.charAt(i)+'曜<select data-hk-day="'+i+'">'+opt(cfg.assignees[String(i)]||'')+'</select></label>';
    h+='</div></details><details><summary>お休みの日（デイサービス・入院・旅行など）</summary><div class="note">毎週お休みの曜日</div><div class="hitokoe-week">';
    for(var j=0;j<7;j++) h+='<label><input type="checkbox" data-hk-off="'+j+'"'+(cfg.offWeekdays.indexOf(j)>=0?' checked':'')+'>'+WD.charAt(j)+'</label>';
    h+='</div><div class="note">期間でお休み（10件まで）</div><ul class="hitokoe-pauses">'+
      pauseItems(cfg.pauses)+
      '</ul><div class="yt-form-row"><label>から<input type="date" data-hk="from"></label><label>まで<input type="date" data-hk="to"></label></div>'+
      '<button class="set-btn" type="button" data-hk-act="pause">この期間をお休みにする</button></details>'+
      '<button class="big-btn family" type="button" data-hk-act="save">保存する</button>'+
      '<div class="save-state" data-hk-state aria-live="polite"></div>';
    return h;
  }

  function pauseItems(list){
    return list.map(function(p,k){ return '<li>'+esc(p.from)+' 〜 '+esc(p.to)+' <button type="button" class="yt-del" data-hk-unpause="'+k+'">消す</button></li>'; }).join('');
  }
  function consentQuestion(hour,who){
    return '挨拶やお薬などの記録が'+hour+'時までに1つもない日は、'+who+'に「声をかけるきっかけ」のお知らせが届きます。よろしいですか。';
  }

  /* ===== つなぎ込み ===== */
  function create(ctx){
    var st={configRows:[],consentRows:[],todayRows:[],unsubs:[],timer:null,loaded:false,pausesDraft:null,sending:{}};
    function members(){ return ctx.members()||{}; }
    function results(){ return evaluate({configRows:st.configRows,consentRows:st.consentRows,todayRows:st.todayRows,members:members(),now:new Date(),day:ctx.day()}); }
    function renderCard(){
      var box=ctx.document.getElementById(ctx.cardId);
      if(!box) return;
      box.innerHTML=st.loaded?cardHtml(results(),ctx.uid()):'';
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
    function start(){
      stop(); st.loaded=false; st.configRows=[]; st.consentRows=[]; st.todayRows=[];
      var day=ctx.day();
      st.unsubs.push(ctx.col('events').where('type','in',['hitokoe-config','hitokoe-consent']).onSnapshot(function(snap){
        var c=[],k=[]; snap.forEach(function(d){ var v=d.data(); (v.type==='hitokoe-config'?c:k).push(v); });
        st.configRows=c; st.consentRows=k; st.loaded=true; renderCard(); renderSettingsStatus();
      },function(){}));
      st.unsubs.push(ctx.col('events').where('date','==',day).onSnapshot(function(snap){
        var rows=[]; snap.forEach(function(d){ rows.push(d.data()); }); st.todayRows=rows; renderCard();
      },function(){}));
      /* 時刻を過ぎたら出す・日付が変わったら読み直す */
      st.timer=setInterval(function(){ if(ctx.day()!==day) start(); else renderCard(); },60000);
    }
    function renderSettingsStatus(){
      var el=ctx.document.querySelector('#'+ctx.settingsId+' [data-hitokoe-status]');
      if(el) el.innerHTML=statusText(results());
    }
    function renderSettings(){
      var box=ctx.document.getElementById(ctx.settingsId);
      if(!box) return;
      if(!st.loaded){ box.innerHTML='<p class="note">今の設定を読み込んでいます…</p>'; return; }
      var cfg=latestConfig(st.configRows);
      st.pausesDraft=cfg.pauses.slice();
      box.innerHTML=settingsHtml(cfg,members(),results());
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
        state('「保存する」を押すと反映されます');
      });
      q('[data-hk-act="save"]').addEventListener('click',async function(){
        var btn=this; var on=q('[data-hk="enabled"]').checked;
        /* 画面を開いた後にほかの家族が変えていても、最新の設定をもとに判断する */
        cfg=latestConfig(st.configRows);
        var as={}; for(var i=0;i<7;i++){ var v=q('[data-hk-day="'+i+'"]').value; if(v) as[String(i)]=v; }
        var off=[]; for(var j=0;j<7;j++) if(q('[data-hk-off="'+j+'"]').checked) off.push(j);
        var today=ctx.day();
        var data={type:'hitokoe-config',enabled:on,hour:Number(q('[data-hk="hour"]').value)||DEFAULT_HOUR,
          assignees:as,offWeekdays:off,pauses:st.pausesDraft.filter(function(p){ return p.to>=today; }).slice(0,10),
          /* 切っている状態からオンにしたときだけ、ご本人にもう一度了解を聞く */
          requestId:on?(cfg.enabled&&cfg.requestId?cfg.requestId:'r'+Date.now().toString(36)):'',
          name:ctx.myName(),clientAt:Date.now()};
        if(on&&!cfg.enabled&&!await ctx.confirm('オンにすると、ご本人のスマホに「'+consentQuestion(data.hour,'ご家族')+'」と1回だけ確認が出ます。ご本人が「はい」を選ぶまでは動きません。ご本人が「やめておく」を選んだら、その気持ちを大切にしてください。','オンにする')) return;
        btn.disabled=true; state('保存しています…');
        try{ await ctx.addEvent(data); state(on?(cfg.enabled?'保存しました':'保存しました。ご本人の了解を待っています'):'切りました。お知らせは出ません'); }
        catch(e){ state('保存できませんでした。通信を確認してください',true); }
        finally{ btn.disabled=false; }
      });
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
      if(st.mine.some(function(v){ return v.uid===me&&v.requestId===cfg.requestId; })) return;
      try{ if(ctx.storage.getItem('mainicoHitokoeAsked-'+cfg.requestId)) return; }catch(e){}
      st.asking=cfg.requestId;
      var mem=ctx.members()||{}, day=ctx.day();
      var names=[];
      [0,1,2,3,4,5,6].forEach(function(i){ var u=cfg.assignees[String(i)]||cfg.uid; var m=mem[u]; if(m&&m.name&&names.indexOf(m.name)<0) names.push(m.name); });
      if(!names.length&&mem[cfg.uid]&&mem[cfg.uid].name) names.push(mem[cfg.uid].name);
      var who=names.length?names.join('さん・')+'さん':'ご家族';
      var text=consentQuestion(cfg.hour,who)+'\n\n声をかけるきっかけにするためのものです。押し忘れても大丈夫です。あとから「その他の設定」でやめることもできます。';
      ctx.ask(text,'はい','やめておく').then(function(yes){
        /* 画面が切り替わって答えがなかったときは、記録せず次の機会にもう一度聞く */
        if(yes===null||yes===undefined){ st.asking=''; return; }
        try{ ctx.storage.setItem('mainicoHitokoeAsked-'+cfg.requestId,'1'); }catch(e){}
        return ctx.addEvent({type:'hitokoe-consent',requestId:cfg.requestId,answer:yes?'yes':'no',clientAt:Date.now()})
          .then(function(){ ctx.speak(yes?'はい、に しました':'やめておく、に しました'); });
      }).catch(function(){ try{ ctx.storage.removeItem('mainicoHitokoeAsked-'+cfg.requestId); }catch(e){} st.asking=''; });
      void day;
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
    /* ご本人の「その他の設定」用: 今の状態と、あとから変える操作 */
    function status(){
      var cfg=latestConfig(st.configRows);
      if(!cfg.enabled||!cfg.requestId) return {enabled:false};
      var me=ctx.uid();
      var mine=newest(st.mine.filter(function(v){ return v.uid===me&&v.requestId===cfg.requestId&&(v.answer==='yes'||v.answer==='no'); }));
      return {enabled:true,hour:cfg.hour,answer:mine?mine.answer:''};
    }
    function answer(yes){
      var cfg=latestConfig(st.configRows);
      if(!cfg.enabled||!cfg.requestId) return Promise.resolve(false);
      return ctx.addEvent({type:'hitokoe-consent',requestId:cfg.requestId,answer:yes?'yes':'no',clientAt:Date.now()}).then(function(){ return true; });
    }
    return {start:start,stop:stop,status:status,answer:answer};
  }

  global.MainicoHitokoe={evaluate:evaluate,latestConfig:latestConfig,normalizeConfig:normalizeConfig,assigneeFor:assigneeFor,
    cardHtml:cardHtml,settingsHtml:settingsHtml,statusText:statusText,create:create,createPersonPrompt:createPersonPrompt,NOTES:NOTES};
})(typeof window!=='undefined'?window:globalThis);
