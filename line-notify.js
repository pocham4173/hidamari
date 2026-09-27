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
  /* 予定一覧に出す短い説明 */
  function describe(v){
    var d=toDate(v&&v.notifyAt);
    if(d) return '🔔 LINEで知らせる：'+jpDateTime(d);
    var sent=toDate(v&&v.notifiedAt);
    if(sent) return '🔔 LINEでお知らせ済み（'+jpDateTime(sent)+'）';
    return '';
  }

  /* ===== 設定画面の連携欄 ===== */
  var renderSeq=0;
  async function render(areaId){
    var area=document.getElementById(areaId);
    if(!area) return;
    var seq=++renderSeq;
    var myUid=typeof global.uid==='function'?global.uid():'';
    if(!myUid){ area.innerHTML='<p class="note">ログインを確認できません。アプリを開き直してください。</p>'; return; }
    area.innerHTML='<p class="note">LINE連携の状態を確認しています…</p>';
    var link=null, failed=false;
    try{
      var snap=await global.db.collection('lineLinks').doc(myUid).get({source:'server'});
      if(snap.exists) link=snap.data();
    }catch(e){ failed=true; }
    if(seq!==renderSeq) return;
    if(failed){
      area.innerHTML='<p class="note">LINE連携の状態を確認できませんでした。通信を確認してください。</p>'+
        '<button class="set-btn" type="button" data-line-act="reload">もう一度確認する</button>';
    }else if(link && link.groupId===(typeof global.gid==='function'?global.gid():'')){
      var at=toDate(link.linkedAt);
      area.innerHTML='<p class="note"><b>✅ このアカウントはLINEと連携しています</b>'+(at?'（'+h(jpDateTime(at))+'から）':'')+'</p>'+
        '<p class="note">「LINEで知らせる日時」を入れた予定が、決めた日時にLINEで届きます。15分ほど遅れることがあります。</p>'+
        '<a class="set-btn" href="'+ADD_FRIEND_URL+'" target="_blank" rel="noopener noreferrer">まいにこ公式LINEを開く</a>'+
        '<button class="set-btn warn" type="button" data-line-act="unlink">LINE連携を解除する</button>'+
        '<div class="save-state" data-line-state aria-live="polite"></div>';
    }else{
      area.innerHTML=intro()+
        '<button class="set-btn" type="button" data-line-act="code">LINE連携コードを作る</button>'+
        '<div data-line-code></div>'+
        '<div class="save-state" data-line-state aria-live="polite"></div>';
    }
    bind(area,areaId);
  }
  function intro(){
    return '<p class="note">まいにこ公式LINEを友だち追加して連携すると、「LINEで知らせる日時」を入れた予定が、その日時にLINEで届きます。連携は一人ずつ行います。</p>'+
      '<p class="note">届く内容：予定の日付・時刻・場所・予定名・登録した人の名前。LINEヤフー株式会社のLINEを通じて届き、ロック画面に表示されることがあります。連携しない人には届きません。</p>';
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
    if(!myUid||!g){ setState(area,'家族とつながってから連携してください',true); return; }
    btn.disabled=true;
    setState(area,'コードを作っています…');
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
      setState(area,(lastErr&&lastErr.code==='permission-denied')?'コードを作れませんでした。家族への参加が承認されているか確認してください':'コードを作れませんでした。通信を確認して、もう一度押してください',true);
      return;
    }
    setState(area,'');
    var box=area.querySelector('[data-line-code]');
    var until=new Date(Date.now()+CODE_MINUTES*60*1000);
    box.innerHTML='<div class="code-show">'+h(code)+'</div>'+
      '<div class="code-exp">'+h(two(until.getHours())+':'+two(until.getMinutes()))+'まで（10分間）・一度だけ使えます</div>'+
      '<ol class="note line-steps">'+
        '<li>下の「友だち追加する」を押して、まいにこ公式LINEを友だち追加します（追加済みなら開くだけ）</li>'+
        '<li>トーク画面に、上の8文字のコードを送ります</li>'+
        '<li>「連携しました」と返事が届いたら完了です</li>'+
      '</ol>'+
      '<a class="set-btn line-add" href="'+ADD_FRIEND_URL+'" target="_blank" rel="noopener noreferrer">友だち追加する（まいにこ公式LINE）</a>'+
      '<button class="set-btn" type="button" data-line-act="check">連携できたか確認する</button>'+
      '<p class="note">このコードは、他の人に見せたり送ったりしないでください。</p>';
    bind(area,areaId);
  }
  async function unlink(area,areaId,btn){
    if(!global.confirm('LINE連携を解除しますか？\nこのLINEには、予定のお知らせが届かなくなります。予定そのものは消えません。')) return;
    btn.disabled=true;
    setState(area,'解除しています…');
    try{
      await global.db.collection('lineLinks').doc(global.uid()).delete();
      render(areaId);
    }catch(e){
      btn.disabled=false;
      setState(area,'解除できませんでした。通信を確認して、もう一度押してください',true);
    }
  }

  global.MainicoLine={
    LINE_ID:LINE_ID, ADD_FRIEND_URL:ADD_FRIEND_URL,
    render:render, preset:preset, readNotify:readNotify,
    toInputValue:toInputValue, fromInputValue:fromInputValue, describe:describe, newCode:newCode
  };
})(typeof window!=='undefined'?window:globalThis);
