/* まいにこ LINEで予定のお知らせ（2026-09-26）
   - 設定画面の「LINEで予定のお知らせ」欄の表示と操作
   - 予定入力欄の「LINEで知らせる日時」の読み書き補助
   連携コードの照合とLINEへの送信は、送信役（Cloudflare Worker）が行います。
   この画面から書き込めるのは、10分だけ有効な連携コードの作成と、自分の連携の解除だけです。 */
(function(global){
  'use strict';
  var LINE_ID='@187mrwbk';
  var ADD_FRIEND_URL='https://line.me/R/ti/p/'+encodeURIComponent(LINE_ID);
  var CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_MINUTES=10;

  function h(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function newCode(){
    var out='',buf=new Uint32Array(8);
    global.crypto.getRandomValues(buf);
    for(var i=0;i<8;i++) out+=CODE_CHARS[buf[i]%CODE_CHARS.length];
    return out;
  }
  function two(n){ return (n<10?'0':'')+n; }
  function jpDateTime(d){
    var w='日月火水木金土'.charAt(d.getDay());
    return (d.getMonth()+1)+'月'+d.getDate()+'日（'+w+'）'+two(d.getHours())+':'+two(d.getMinutes());
  }
  function toDate(v){
    if(!v) return null;
    if(typeof v.toDate==='function') return v.toDate();
    if(v instanceof Date) return v;
    return null;
  }
  /* datetime-local の値 ⇔ Date（端末の時刻＝日本時間として扱う） */
  function toInputValue(v){
    var d=toDate(v); if(!d) return '';
    return d.getFullYear()+'-'+two(d.getMonth()+1)+'-'+two(d.getDate())+'T'+two(d.getHours())+':'+two(d.getMinutes());
  }
  function fromInputValue(s){
    if(!s) return null;
    var m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if(!m) return null;
    return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],0,0);
  }
  /* 予定日を元に「前日の夜7時」「当日の朝7時」を入れる */
  function preset(inputId,dateInputId,kind){
    var input=document.getElementById(inputId);
    var dateEl=document.getElementById(dateInputId);
    var ds=(dateEl&&dateEl.value)||'';
    var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(ds);
    if(!input) return;
    if(!m){ if(global.alert) global.alert('先に予定の日付を選んでください'); return null; }
    var d=new Date(+m[1],+m[2]-1,+m[3],7,0,0,0);
    if(kind==='eve'){ d.setDate(d.getDate()-1); d.setHours(19); }
    input.value=toInputValue(d);
    return d;
  }
  /* 保存用の値を作る。空欄=知らせない(null)。
     過去の日時はエラー(unchangedは、修正時に元のまま残す場合)。 */
  function readNotify(inputId,originalValue){
    var input=document.getElementById(inputId);
    var s=input?input.value:'';
    if(!s) return {ok:true,value:null};
    var d=fromInputValue(s);
    if(!d) return {ok:false,message:'LINEで知らせる日時を正しく入れてください'};
    if(originalValue && toInputValue(originalValue)===s && d.getTime()>Date.now()){
      return {ok:true,value:toDate(originalValue)?global.firebase.firestore.Timestamp.fromDate(toDate(originalValue)):null};
    }
    if(d.getTime()<Date.now()+60*1000) return {ok:false,message:'LINEで知らせる日時が、もう過ぎています。これから先の日時を入れてください'};
    return {ok:true,value:global.firebase.firestore.Timestamp.fromDate(d)};
  }
  /* 予定の日付を変えたとき、LINEで知らせる日時を手で直していなければ、同じ日数だけずらす(2026-09-30)。
     例: 10/6の「前日の夜7時」→ 日付を10/13に直すと 10/12の夜7時になる */
  function shiftForDate(inputId,originalValue,oldDate,newDate){
    var input=document.getElementById(inputId);
    if(!input||!input.value||!originalValue||!oldDate||!newDate||oldDate===newDate) return false;
    if(input.value!==toInputValue(originalValue)) return false;
    var a=/^(\d{4})-(\d{2})-(\d{2})$/.exec(oldDate), b=/^(\d{4})-(\d{2})-(\d{2})$/.exec(newDate);
    var d=fromInputValue(input.value);
    if(!a||!b||!d) return false;
    var days=Math.round((new Date(+b[1],+b[2]-1,+b[3])-new Date(+a[1],+a[2]-1,+a[3]))/86400000);
    d.setDate(d.getDate()+days);
    input.value=toInputValue(d);
    return true;
  }
  /* 予定一覧に出す短い説明 */
  function describe(v){
    var d=toDate(v&&v.notifyAt);
    if(d) return '🔔 LINEで知らせる：'+jpDateTime(d);
    if(v&&v.notificationStatus==='expired') return '🔔 LINEのお知らせ期限が過ぎました（送信完了は未確認）';
    if(v&&v.notificationStatus==='limited') return '🔔 LINEで送れる数の上限のため、この予定は送りませんでした';
    var sent=toDate(v&&v.notifiedAt);
    if(sent) return '🔔 LINEでお知らせ済み（'+jpDateTime(sent)+'）';
    return '';
  }

  /* ===== 設定画面の連携欄（2026-10-03 作り直し：ヒビルカと同じカード形式） =====
     カード1「自分のLINE」  ：状態と、ボタンを押すだけのつなぎ方(LINEのトークにコードを入れた状態で開く)
     カード2「家族のLINE」  ：家族のだれがLINEで受け取っているか(連携の記録から)
     カード3「家族に頼む」  ：まだの家族へ、つなぎ方をLINEで送る
     つなげるのは、この家族に参加が承認された本人だけ(今までと同じ。照合は送信役が行う) */
  var renderSeq=0, linkWatch=null;
  function stopWatch(){ if(linkWatch){ try{ linkWatch(); }catch(e){} linkWatch=null; } }
  /* LINEのトーク画面を、コードを入れた状態で開くURL(送信を押すだけで連携できる) */
  function sendCodeUrl(code){ return 'https://line.me/R/oaMessage/'+encodeURIComponent(LINE_ID)+'/?'+encodeURIComponent(code); }
  function appUrl(){
    if(global.MAINICO_APP_URL) return String(global.MAINICO_APP_URL);
    var l=global.location; return l?l.origin+l.pathname.replace(/[^/]*$/,''):'';
  }
  function card(title,sub,body){
    return '<section class="ln-card"><h4>'+h(title)+'</h4>'+(sub?'<p class="ln-sub">'+h(sub)+'</p>':'')+body+'</section>';
  }
  async function render(areaId){
    var area=document.getElementById(areaId);
    if(!area) return;
    var seq=++renderSeq;
    stopWatch();
    var myUid=typeof global.uid==='function'?global.uid():'';
    if(!myUid){ area.innerHTML='<p class="note">ログインを確認できません。アプリを開き直してください。</p>'; return; }
    area.innerHTML='<p class="note">LINEの状態を確認しています…</p>';
    var link=null, failed=false;
    try{
      var snap=await global.db.collection('lineLinks').doc(myUid).get({source:'server'});
      if(snap.exists) link=snap.data();
    }catch(e){ failed=true; }
    if(seq!==renderSeq) return;
    if(failed){
      area.innerHTML='<p class="note">LINEの状態を確認できませんでした。通信を確認してください。</p>'+
        '<button class="set-btn" type="button" data-line-act="reload">もう一度確認する</button>';
      bind(area,areaId); return;
    }
    var linked=!!(link && link.groupId===(typeof global.gid==='function'?global.gid():''));
    var self;
    if(linked){
      var at=toDate(link.linkedAt);
      self='<p class="ln-status ok">✓ 自分のLINEを登録済み'+(at?'（'+h(jpDateTime(at))+'から）':'')+'</p>'+
        '<p class="ln-sub">「LINEで知らせる日時」を入れた予定が、このLINEに届きます。</p>'+
        '<a class="set-btn ln-soft" href="'+ADD_FRIEND_URL+'" target="_blank" rel="noopener noreferrer">まいにこ公式LINEを開く</a>'+
        '<button class="set-btn ln-ghost" type="button" data-line-act="unlink">つなぐのをやめる</button>';
    }else{
      self='<p class="ln-status">まだつながっていません。</p>'+
        '<ol class="ln-steps"><li>まいにこ公式LINEを友だち追加します（追加済みなら飛ばしてOK）</li><li>「LINEとつなぐ」を押し、開いたLINEで<b>送信</b>を押せば完了です</li></ol>'+
        '<a class="set-btn ln-soft" href="'+ADD_FRIEND_URL+'" target="_blank" rel="noopener noreferrer">まいにこを友だち追加</a>'+
        '<button class="set-btn ln-line" type="button" data-line-act="code">LINEとつなぐ</button>'+
        '<div data-line-code></div>';
    }
    self+='<div class="save-state" data-line-state aria-live="polite"></div>'+
      '<details class="ln-more"><summary>LINEに届く内容</summary><p class="note">予定の日付・時刻・場所・予定名・登録した人の名前です。LINEヤフー株式会社のLINEを通じて届き、ロック画面に表示されることがあります。つないでいない人には届きません。</p></details>';
    var share='https://line.me/R/share?text='+encodeURIComponent('まいにこの予定のお知らせを、LINEで受け取れるようにしてね。\nまいにこを開いて「設定」→「LINEで予定のお知らせ」→「LINEとつなぐ」を押すだけです。\n'+appUrl());
    area.innerHTML=
      card('自分のLINE','予定のお知らせを、自分のLINEで受け取る',self)+
      card('家族のLINE','予定に「LINEで知らせる日時」を入れると、✓の人全員に届きます','<div data-line-family><p class="note">読み込んでいます…</p></div>')+
      card('家族に頼む','まだの家族に、つなぎ方をLINEで送る',
        '<p class="ln-sub">LINEのお知らせは、一人ずつ自分のスマホでつなぎます。下のボタンで、つなぎ方を家族に送れます。</p>'+
        '<a class="set-btn ln-line" href="'+h(share)+'" target="_blank" rel="noopener noreferrer">LINEで家族に頼む</a>');
    bind(area,areaId);
    renderFamily(area,myUid,linked,seq);
    if(!linked) watchLink(areaId,myUid,seq);
  }
  /* 家族の一覧と、だれがLINEで受け取っているか(自分は実際の連携、家族は連携の記録から) */
  async function renderFamily(area,myUid,selfLinked,seq){
    var box=area.querySelector('[data-line-family]');
    if(!box||typeof global.col!=='function') return;
    var members=[], latest={};
    try{
      var ms_=await global.col('members').where('status','==','approved').get();
      ms_.forEach(function(d){ members.push({id:d.id,name:(d.data()||{}).name||''}); });
      var logs=await global.col('events').where('type','==','line-link-log').get();
      var rows=[]; logs.forEach(function(d){ rows.push(d.data()); });
      rows.sort(function(a,b){ return ms(b)-ms(a); });
      rows.forEach(function(v){ if(v.uid&&!latest[v.uid]) latest[v.uid]=v; });
    }catch(e){
      if(seq===renderSeq) box.innerHTML='<p class="note">家族の状態を読み込めませんでした。通信を確認してください。</p>';
      return;
    }
    if(seq!==renderSeq) return;
    members.sort(function(a,b){ return (a.id===myUid?-1:0)-(b.id===myUid?-1:0); });
    if(!members.length){ box.innerHTML='<p class="note">まだ家族がいません。</p>'; return; }
    var on=0;
    box.innerHTML='<ul class="ln-family">'+members.map(function(m){
      var ok=m.id===myUid?selfLinked:!!(latest[m.id]&&latest[m.id].action==='linked');
      if(ok) on++;
      return '<li><span class="ln-name">'+h(m.name||'家族')+(m.id===myUid?'<small>（自分）</small>':'')+'</span>'+
        '<span class="ln-badge'+(ok?' ok':'')+'">'+(ok?'✓ 受け取る':'まだ')+'</span></li>';
    }).join('')+'</ul>'+
    '<p class="ln-sub">'+(on?'今は '+on+'人 に届きます。':'まだだれにも届きません。')+'2026年9月29日より前につないだ家族は「まだ」と出ることがあります。</p>';
  }
  /* つなぐ途中: LINEで送信したら、この画面が自動で「登録済み」に変わる */
  function watchLink(areaId,myUid,seq){
    try{
      linkWatch=global.db.collection('lineLinks').doc(myUid).onSnapshot(function(snap){
        if(seq!==renderSeq||!snap.exists) return;
        var g=typeof global.gid==='function'?global.gid():'';
        if((snap.data()||{}).groupId===g){ stopWatch(); render(areaId); if(typeof renderLog==='function') renderLog('settings-line-log'); }
      },function(){});
    }catch(e){ linkWatch=null; }
  }
  function bind(area,areaId){
    area.querySelectorAll('[data-line-act]').forEach(function(btn){
      btn.onclick=function(){
        var act=btn.getAttribute('data-line-act');
        if(act==='reload') render(areaId);
        if(act==='code') makeCode(area,areaId,btn);
        if(act==='unlink') unlink(area,areaId,btn);
        if(act==='check') render(areaId);
      };
    });
  }
  function setState(area,text,isErr){
    var el=area.querySelector('[data-line-state]');
    if(el){ el.textContent=text||''; el.classList.toggle('err',!!isErr); }
  }
  async function makeCode(area,areaId,btn){
    var myUid=global.uid(), g=global.gid();
    if(!myUid||!g){ setState(area,'家族とつながってから、LINEとつないでください',true); return; }
    btn.disabled=true;
    setState(area,'準備しています…');
    var code='', ok=false, lastErr=null;
    for(var i=0;i<3&&!ok;i++){
      code=newCode();
      try{
        await global.db.collection('lineLinkCodes').doc(code).set({
          uid:myUid, groupId:g,
          createdAt:global.firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt:global.firebase.firestore.Timestamp.fromMillis(Date.now()+CODE_MINUTES*60*1000)
        });
        ok=true;
      }catch(e){ lastErr=e; }
    }
    btn.disabled=false;
    if(!ok){
      setState(area,(lastErr&&lastErr.code==='permission-denied')?'準備できませんでした。家族への参加が承認されているか確認してください':'準備できませんでした。通信を確認して、もう一度押してください',true);
      return;
    }
    setState(area,'');
    btn.hidden=true;
    var box=area.querySelector('[data-line-code]');
    var until=new Date(Date.now()+CODE_MINUTES*60*1000);
    box.innerHTML='<a class="set-btn ln-line" href="'+h(sendCodeUrl(code))+'" target="_blank" rel="noopener noreferrer">LINEを開いて送る</a>'+
      '<p class="ln-sub">開いたLINEのトークに、つなぐためのコードが入っています。そのまま<b>送信</b>を押してください。送ると、この画面が自動で「登録済み」に変わります（'+h(two(until.getHours())+':'+two(until.getMinutes()))+'まで有効）。</p>'+
      '<details class="ln-more"><summary>うまく開かないとき</summary><p class="note">まいにこ公式LINEのトークに、次のコードを送ってください。他の人には見せないでください。</p><div class="code-show">'+h(code)+'</div>'+
      '<button class="set-btn" type="button" data-line-act="check">つながったか確かめる</button></details>';
    bind(area,areaId);
  }
  async function unlink(area,areaId,btn){
    var q='LINEとつなぐのをやめますか？\nこのLINEには、予定のお知らせが届かなくなります。予定そのものは消えません。';
    if(!(typeof global.appConfirm==='function'?await global.appConfirm(q,'解除する'):global.confirm(q))) return;
    btn.disabled=true;
    setState(area,'解除しています…');
    try{
      await global.db.collection('lineLinks').doc(global.uid()).delete();
      /* 家族が見られる「LINE連携の記録」に残す。残せなくても解除は済んでいる */
      try{ if(typeof global.addEvent==='function') await global.addEvent({type:'line-link-log',action:'unlinked',via:'app',name:typeof global.myName==='function'?global.myName():'',clientAt:Date.now()}); }catch(ignore){}
      render(areaId);
      renderLog('settings-line-log');
    }catch(e){
      btn.disabled=false;
      setState(area,'解除できませんでした。通信を確認して、もう一度押してください',true);
    }
  }

  /* ===== 家族のLINE連携の記録(2026-09-29) =====
     連携・解除のたびに events へ type:'line-link-log' で残る(連携は送信役、アプリからの解除はアプリが書く)。 */
  var VIA={code:'連携コードで',app:'アプリから',line:'LINEで「解除」と送って',block:'公式LINEをブロックして'};
  function ms(v){ var d=toDate(v&&v.at); return d?d.getTime():(Number(v&&v.clientAt)||0); }
  async function renderLog(boxId){
    var box=document.getElementById(boxId);
    if(!box) return;
    if(typeof global.col!=='function'){ box.innerHTML=''; return; }
    box.innerHTML='<p class="note">記録を読み込んでいます…</p>';
    var rows=[];
    try{
      var snap=await global.col('events').where('type','==','line-link-log').get();
      snap.forEach(function(d){ rows.push(d.data()); });
    }catch(e){ box.innerHTML='<p class="note">記録を読み込めませんでした。通信を確認してください。</p>'; return; }
    rows.sort(function(a,b){ return ms(b)-ms(a); });
    var head='<p class="note">家族のだれが、いつLINEと連携・解除したかの記録です（2026年9月29日以降の分から残ります）。</p>';
    if(!rows.length){ box.innerHTML=head+'<p class="note">まだ記録はありません。</p>'; return; }
    var latest={}, order=[];
    rows.forEach(function(v){ if(v.uid&&!latest[v.uid]){ latest[v.uid]=v; order.push(v.uid); } });
    var now=order.filter(function(u){ return latest[u].action==='linked'; }).map(function(u){ return h(latest[u].name||'家族')+'さん'; });
    var html=head+'<div class="line-log-now"><b>記録上、LINEで受け取っている人：</b>'+(now.length?now.join('、'):'いません')+'</div><ul class="line-log-list">';
    rows.slice(0,30).forEach(function(v){
      var d=new Date(ms(v));
      var who=h(v.name||'家族')+'さん';
      var what=v.action==='linked'?'✅ 連携しました':'⏹ 解除しました';
      var how=VIA[v.via]?'（'+VIA[v.via]+'）':'';
      html+='<li><span class="line-log-when">'+(ms(v)?h(jpDateTime(d)):'')+'</span>'+who+' '+what+'<small>'+h(how)+'</small></li>';
    });
    box.innerHTML=html+'</ul>';
  }
  /* 今月のLINEの残り通数(2026-10-01)。送信役が lineStatus/quota に書く。まいにこ全体で共通の数 */
  async function readQuota(){
    try{
      var snap=await global.db.collection('lineStatus').doc('quota').get();
      return snap.exists?snap.data():null;
    }catch(e){ return null; }
  }
  function quotaText(q){
    if(!q) return '';
    var at=toDate(q.checkedAt);
    if(q.limit===null||q.limit===undefined) return '今月のLINEのお知らせ：上限なしのプランです'+(at?'（'+jpDateTime(at)+' 時点）':'');
    var rest=Math.max(0,Number(q.remaining)||0);
    var line='今月のLINEの残り：'+rest+'通（まいにこ全体で月'+q.limit+'通まで）'+(at?'・'+jpDateTime(at)+' 時点':'');
    if(rest<=0) line+='\n今月はもう送れません。来月1日に戻ります。アプリの中のお知らせは今まで通り届きます。';
    else if(rest<=(Number(q.reserve)||50)) line+='\n残りが少ないため、予定のお知らせは止めて、おまもりタグの分を残しています。';
    return line;
  }
  async function renderQuota(boxId){
    var box=document.getElementById(boxId);
    if(!box) return;
    var q=await readQuota();
    box.textContent=q?quotaText(q):'今月のLINEの残り通数は、まだ確認できていません（送信役が15分ごとに記録します）。';
    box.style.whiteSpace='pre-line';
  }
  /* 予定ごとのLINE送信の記録(送信役が notifyLog に残す) */
  function sendLog(v){
    var list=Array.isArray(v&&v.notifyLog)?v.notifyLog:[];
    return list.map(function(e){
      var at=toDate(e&&e.at), sch=toDate(e&&e.scheduledAt);
      if(e&&e.status==='accepted') return {ok:true,at:at,text:'✅ '+(at?jpDateTime(at):'')+' に送信済み'+(e.count?'（'+e.count+'人）':'')};
      if(e&&e.status==='expired') return {ok:false,at:at,text:'⚠ '+(sch?jpDateTime(sch):'')+' の分は送れないまま期限が過ぎました'};
      if(e&&e.status==='limited') return {ok:false,at:at,text:'⚠ '+(sch?jpDateTime(sch):'')+' の分は、'+(e.reason==='household'?'今日この家族で送れる数（20通）に達したため':'今月のLINEの残りが少ないため（おまもりタグの分を残しています）')+'送りませんでした'};
      return null;
    }).filter(Boolean).reverse();
  }

  global.MainicoLine={
    renderLog:renderLog, sendLog:sendLog, shiftForDate:shiftForDate,
    readQuota:readQuota, quotaText:quotaText, renderQuota:renderQuota,
    LINE_ID:LINE_ID, ADD_FRIEND_URL:ADD_FRIEND_URL,
    render:render, preset:preset, readNotify:readNotify,
    toInputValue:toInputValue, fromInputValue:fromInputValue, describe:describe, newCode:newCode
  };
})(typeof window!=='undefined'?window:globalThis);
