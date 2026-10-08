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
    if(sent) return '🔔 LINEに送信済み（'+jpDateTime(sent)+'）';
    return '';
  }

  /* ===== 設定画面のLINE欄（2026-10-04 ヒビルカと同じ形） =====
     カード1「自分のLINEを登録する」：ボタンを押すだけでつなぐ(LINEのトークにコードを入れた状態で開く)
     カード2「LINEの送信先を追加」 ：名前を入れて招待を送る。相手がLINEで送信すると「登録済み」になる
     カード3「LINEの送信先」       ：家族(アプリ)と招待した人の一覧。名前変更・招待の再送・削除
     カード4「家族に頼む」         ：アプリを使う家族へ、つなぎ方をLINEで送る
     招待した人(アプリを使わない人)には、予定ごとに「知らせる」と選んだ予定だけが届く。
     LINEの利用者識別子は画面に置かない(登録は送信役が、署名を確かめたLINEの受付から行う) */
  var renderSeq=0, linkWatch=null, recipientWatch=null, INVITE_DAYS=7;
  function stopWatch(){
    if(linkWatch){ try{ linkWatch(); }catch(e){} linkWatch=null; }
    if(recipientWatch){ try{ recipientWatch(); }catch(e){} recipientWatch=null; }
  }
  /* LINEのトーク画面を、文字を入れた状態で開くURL(送信を押すだけ) */
  function sendCodeUrl(code){ return 'https://line.me/R/oaMessage/'+encodeURIComponent(LINE_ID)+'/?'+encodeURIComponent(code); }
  function inviteUrl(code){ return sendCodeUrl('まいにこ招待 '+code); }
  function appUrl(){
    if(global.MAINICO_APP_URL) return String(global.MAINICO_APP_URL);
    var l=global.location; return l?l.origin+l.pathname.replace(/[^/]*$/,''):'';
  }
  var ICON={
    me:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    add:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M19 8v6M16 11h6"/></svg>',
    list:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
    send:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>'
  };
  function card(icon,cls,title,sub,body){
    return '<section class="ln-card"><div class="ln-head"><span class="ln-ic '+cls+'">'+ICON[icon]+'</span><div><h4>'+h(title)+'</h4>'+(sub?'<small>'+h(sub)+'</small>':'')+'</div></div>'+body+'</section>';
  }
  function newInviteCode(){
    var out='',buf=new Uint32Array(10);
    global.crypto.getRandomValues(buf);
    for(var i=0;i<10;i++) out+=CODE_CHARS[buf[i]%CODE_CHARS.length];
    return out;
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
    var share=await readShareConsent(myUid);
    if(seq!==renderSeq) return;
    var self;
    if(linked){
      self='<p class="ln-status ok">✓ 自分のLINEを登録済み。予定の「知らせる人」で自分を選べます。</p>'+
        '<a class="set-btn ln-soft" href="'+ADD_FRIEND_URL+'" target="_blank" rel="noopener noreferrer">まいにこを友だち追加</a>'+
        '<button class="set-btn ln-ghost" type="button" data-line-act="unlink">つなぐのをやめる</button>';
    }else{
      self='<p class="ln-status">最初に1回、自分のLINEを登録してください。</p>'+
        '<ol class="ln-steps"><li>まいにこ公式LINEを友だち追加します（追加済みなら飛ばしてOK）</li><li>「自分のLINEを登録する」を押し、開いたLINEで<b>送信</b>を押せば完了です</li></ol>'+
        '<a class="set-btn ln-soft" href="'+ADD_FRIEND_URL+'" target="_blank" rel="noopener noreferrer">まいにこを友だち追加</a>'+
        '<button class="set-btn ln-line" type="button" data-line-act="code">自分のLINEを登録する</button>'+
        '<div data-line-code></div>';
    }
    self+='<div class="save-state" data-line-state aria-live="polite"></div>';
    var askUrl='https://line.me/R/share?text='+encodeURIComponent('まいにこの予定のお知らせを、LINEで受け取れるようにしてね。\nまいにこを開いて「設定」→「LINEで予定のお知らせ」→「自分のLINEを登録する」を押すだけです。\n'+appUrl());
    area.innerHTML=
      card('me','me','自分のLINEを登録する','',self)+
      card('add','add','LINEの送信先を追加','予定をLINEで送れる人を増やす',
        '<p class="ln-sub">名前を入れて招待を送り、相手がLINEで<b>送信</b>を押したら登録完了です。ヘルパーさんやデイサービスなど、アプリを使わない人にも予定を伝えられます。</p>'+
        (share?
          '<label class="ln-label" for="'+h(areaId)+'-invite-name">通知する人の名前</label>'+
          '<input class="ln-input" id="'+h(areaId)+'-invite-name" maxlength="40" placeholder="例：お母さん、ヘルパーの山田さん" data-line-invite-name>'+
          '<button class="set-btn ln-line" type="button" data-line-act="invite">招待リンクを作る</button>'+
          '<div data-line-invite></div>'+
          '<p class="ln-sub">予定ごとに選んだ人にだけ、通知が届きます。届くのは予定の日付・時刻・場所・予定名・登録した人の名前です。</p>'+
          '<p class="ln-sub">✓ アプリを使わない人へ送ることに同意済み'+(toDate(share.acceptedAt)?'（'+h(jpDateTime(toDate(share.acceptedAt)))+'）':'')+
          ' <button type="button" class="ln-link" data-line-act="share-withdraw">同意をやめる</button></p>'
        :
          '<div class="ln-consent"><p><b>使う前に、確認してください</b></p><ul>'+
          '<li>招待した人には、あなたが予定ごとに「知らせる」と選んだ予定の<b>日付・時刻・場所・予定名・登録した人の名前</b>がLINEで届きます。</li>'+
          '<li>服薬・体調の記録、伝言、おまもりタグのお知らせは送りません。</li>'+
          '<li>LINEの通知として、相手のスマホのロック画面に出ることがあります。</li>'+
          '<li>招待した人は、LINEで「解除」と送ればいつでも止められます。あなたも送信先の削除や、この同意をやめることがいつでもできます。</li></ul>'+
          '<label class="ln-check"><input type="checkbox" data-share-ok> 上の内容で、アプリを使わない人に予定を送ることに同意します</label>'+
          '<label class="ln-check"><input type="checkbox" data-share-honnin> ご本人の予定を送るときは、ご本人の了解を得ます（ご本人が自分で使う場合は、自分で了解したことになります）</label>'+
          '<button class="set-btn ln-line" type="button" data-line-act="share-consent">同意して使い始める</button>'+
          '<div class="save-state" data-share-state aria-live="polite"></div></div>'
        ))+
      card('list','list','LINEの送信先','','<div data-line-family><p class="note">読み込んでいます…</p></div>')+
      card('send','send','家族に頼む','アプリを使う家族へ、つなぎ方を送る',
        '<p class="ln-sub">家族がアプリから自分のLINEを登録すると、「LINEの送信先」に✓が付きます。</p>'+
        '<a class="set-btn ln-soft" href="'+h(askUrl)+'" target="_blank" rel="noopener noreferrer">LINEで家族に頼む</a>')+
      '<details class="ln-more"><summary>LINEに届く内容</summary><p class="note">予定の日付・時刻・場所・予定名・登録した人の名前です。服薬・体調の記録や伝言は送りません。LINEヤフー株式会社のLINEを通じて届き、ロック画面に表示されることがあります。招待した人には、その人に知らせると選んだ予定だけが届きます（おまもりタグのお知らせは、アプリで登録した家族だけに届きます）。</p></details>';
    bind(area,areaId);
    watchFamily(area,areaId,myUid,linked,seq);
    if(!linked) watchLink(areaId,myUid,seq);
  }
  /* アプリを使わない人へ送る同意(この家族の中で、自分の同意)。読めないときは未同意として扱う */
  var SHARE_VERSION='line-share-20261004';
  async function readShareConsent(myUid){
    try{
      if(typeof global.col!=='function') return null;
      var snap=await global.col('lineShareConsents').doc(myUid).get();
      return snap.exists?(snap.data()||{}):null;
    }catch(e){ return null; }
  }
  async function giveShareConsent(area,areaId){
    var ok=area.querySelector('[data-share-ok]'), hon=area.querySelector('[data-share-honnin]'), st=area.querySelector('[data-share-state]');
    if(!ok||!hon||!ok.checked||!hon.checked){ if(st){ st.textContent='2つのチェックを入れてください'; st.classList.add('err'); } return; }
    if(st){ st.textContent='保存しています…'; st.classList.remove('err'); }
    try{
      await global.col('lineShareConsents').doc(global.uid()).set({version:SHARE_VERSION,acceptedAt:global.firebase.firestore.FieldValue.serverTimestamp(),honninAgreed:true,
        name:String(typeof global.myName==='function'?global.myName():'').slice(0,40)});
      render(areaId);
    }catch(e){ if(st){ st.textContent='保存できませんでした。通信を確認して、もう一度押してください'; st.classList.add('err'); } }
  }
  async function withdrawShareConsent(areaId){
    if(!await ask('アプリを使わない人へ予定を送る同意をやめますか？\nやめると、あなたが登録した予定は、招待した人に届かなくなります。送信先の一覧はそのまま残ります。','同意をやめる')) return;
    try{ await global.col('lineShareConsents').doc(global.uid()).delete(); render(areaId); }
    catch(e){ if(global.alert) global.alert('同意をやめられませんでした。通信を確認してください'); }
  }
  /* 家族と招待した人の一覧(家族の状態は連携の記録から。招待した人は送信先の文書を見守る) */
  var familyRows=[], recipientRows=[];
  async function watchFamily(area,areaId,myUid,selfLinked,seq){
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
      if(seq===renderSeq) box.innerHTML='<p class="note">送信先を読み込めませんでした。通信を確認してください。</p>';
      return;
    }
    if(seq!==renderSeq) return;
    members.sort(function(a,b){ return (a.id===myUid?-1:0)-(b.id===myUid?-1:0); });
    familyRows=members.map(function(m){ return {id:m.id,name:m.name,self:m.id===myUid,ok:m.id===myUid?selfLinked:!!(latest[m.id]&&latest[m.id].action==='linked')}; });
    var g=typeof global.gid==='function'?global.gid():'';
    var draw=function(){ if(seq===renderSeq){ box.innerHTML=familyHtml(); bindRows(box,areaId); } };
    try{
      recipientWatch=global.db.collection('lineRecipients').where('groupId','==',g).onSnapshot(function(snap){
        recipientRows=[]; snap.forEach(function(d){ var v=d.data()||{}; v.id=d.id; recipientRows.push(v); });
        recipientRows.sort(function(a,b){ return ms({at:a.createdAt})-ms({at:b.createdAt}); });
        draw();
      },function(){ recipientRows=[]; draw(); });
    }catch(e){ recipientRows=[]; draw(); }
    draw();
  }
  function familyHtml(){
    var html='<ul class="ln-family">';
    familyRows.forEach(function(m){
      html+='<li><div class="ln-who-name"><b>'+h(m.self?'自分':(m.name||'家族'))+'</b>'+(m.self&&m.name?'<small>（'+h(m.name)+'）</small>':'')+
        '<small>家族（アプリ）</small><small class="'+(m.ok?'ln-ok':'')+'">'+(m.ok?'✓ 登録済み':'まだ登録していません')+'</small></div></li>';
    });
    recipientRows.forEach(function(r){
      var st=r.status==='joined'?'<small class="ln-ok">✓ 登録済み</small>':r.status==='stopped'?'<small class="ln-ng">LINEで受け取りを停止しました</small>':'<small>相手の送信待ち（招待の文を送ると登録されます）</small>';
      var hist=[];
      var c=toDate(r.createdAt), j=toDate(r.joinedAt), s=toDate(r.stoppedAt);
      if(c) hist.push('招待を作成：'+jpDateTime(c));
      if(j) hist.push('登録：'+jpDateTime(j));
      if(s) hist.push('停止：'+jpDateTime(s));
      html+='<li><div class="ln-who-name"><b>'+h(r.name||'送信先')+'</b>'+(r.lineName?'<small>LINE名：'+h(r.lineName)+'</small>':'')+st+
        (hist.length?'<details class="ln-hist"><summary>招待の履歴</summary><small>'+hist.map(h).join('<br>')+'</small></details>':'')+
        '</div><div class="ln-row-actions">'+
        '<button type="button" class="ln-mini" data-rec-act="rename" data-rid="'+h(r.id)+'">名前変更</button>'+
        (r.status==='pending'?'<button type="button" class="ln-mini" data-rec-act="resend" data-rid="'+h(r.id)+'">招待を再送</button>':'')+
        '<button type="button" class="ln-mini" data-rec-act="delete" data-rid="'+h(r.id)+'">削除</button></div><div data-rec-box="'+h(r.id)+'"></div></li>';
    });
    html+='</ul>';
    var on=familyRows.filter(function(m){return m.ok;}).length+recipientRows.filter(function(r){return r.status==='joined';}).length;
    html+='<p class="ln-sub">'+(on?'LINEで受け取れる人：'+on+'人':'まだLINEで受け取れる人はいません。')+'（家族の✓は、2026年9月29日より前に登録した人だと出ないことがあります）</p>';
    return html;
  }
  function bindRows(box,areaId){
    box.querySelectorAll('[data-rec-act]').forEach(function(btn){
      btn.onclick=function(){
        var rid=btn.getAttribute('data-rid'), act=btn.getAttribute('data-rec-act');
        var r=recipientRows.find(function(x){return x.id===rid;});
        if(!r) return;
        if(act==='rename') renameRecipient(r);
        if(act==='resend') sendInvite(r, box.querySelector('[data-rec-box="'+rid+'"]'), btn);
        if(act==='delete') deleteRecipient(r);
      };
    });
  }
  async function ask(q,ok){ return typeof global.appConfirm==='function'?global.appConfirm(q,ok):global.confirm(q); }
  async function renameRecipient(r){
    var name=global.prompt?global.prompt('新しい名前（40文字まで）',r.name||''):null;
    if(name==null) return;
    name=String(name).trim().slice(0,40);
    if(!name) return;
    try{ await global.db.collection('lineRecipients').doc(r.id).update({name:name}); }
    catch(e){ if(global.alert) global.alert('名前を変えられませんでした。通信を確認してください'); }
  }
  async function deleteRecipient(r){
    if(!await ask((r.name||'この人')+'さんを、LINEの送信先から削除しますか？\nこの人には、予定のお知らせが届かなくなります。予定そのものは消えません。','削除する')) return;
    try{ await global.db.collection('lineRecipients').doc(r.id).delete(); }
    catch(e){ if(global.alert) global.alert('削除できませんでした。通信を確認してください'); }
  }
  /* 招待コード(10文字・7日間)を作り、LINEで送る文とリンクを出す */
  async function sendInvite(r,box,btn){
    if(!box) return;
    if(btn) btn.disabled=true;
    box.innerHTML='<p class="note">招待を作っています…</p>';
    var code='', ok=false;
    for(var i=0;i<3&&!ok;i++){
      code=newInviteCode();
      try{
        await global.db.collection('lineInvites').doc(code).set({
          groupId:r.groupId, recipientId:r.id, createdBy:global.uid(),
          createdAt:global.firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt:global.firebase.firestore.Timestamp.fromMillis(Date.now()+INVITE_DAYS*86400000)
        });
        ok=true;
      }catch(e){}
    }
    if(btn) btn.disabled=false;
    if(!ok){ box.innerHTML='<p class="note err">招待を作れませんでした。通信を確認して、もう一度押してください。</p>'; return; }
    var me=typeof global.myName==='function'?global.myName():'家族';
    var url=inviteUrl(code);
    var text=me+'さんから、まいにこの予定のお知らせの招待が届きました。\n'+
      '下のリンクを開くと、LINEのトークに招待の文が入っています。そのまま送信を押すと、'+me+'さんが「知らせる」と選んだ予定だけが、あなたのLINEに送られるようになります（'+INVITE_DAYS+'日間有効）。\n'+
      'やめるときは、トークで「解除」と送れば止まります。\n'+url;
    box.innerHTML='<div class="ln-share"><p><b>'+h(r.name||'送信先')+'さんへの招待リンクができました</b></p>'+
      '<a class="set-btn ln-line" href="https://line.me/R/share?text='+h(encodeURIComponent(text))+'" target="_blank" rel="noopener noreferrer">LINEで招待を送る</a>'+
      '<button class="set-btn ln-soft" type="button" data-copy>リンクをコピーする</button>'+
      '<p class="ln-sub">'+INVITE_DAYS+'日間・一度だけ使えます。相手が送信すると、一覧が「✓ 登録済み」に変わります。</p></div>';
    var copy=box.querySelector('[data-copy]');
    copy.onclick=async function(){
      try{ await global.navigator.clipboard.writeText(text); copy.textContent='コピーしました'; }
      catch(e){ copy.textContent='コピーできませんでした'; }
    };
  }
  async function createInvite(area){
    var input=area.querySelector('[data-line-invite-name]'), box=area.querySelector('[data-line-invite]');
    var name=String(input&&input.value||'').trim().slice(0,40);
    if(!name){ box.innerHTML='<p class="note err">通知する人の名前を入れてください。</p>'; if(input) input.focus(); return; }
    var g=global.gid();
    box.innerHTML='<p class="note">準備しています…</p>';
    var ref;
    try{
      ref=global.db.collection('lineRecipients').doc();
      await ref.set({groupId:g,name:name,status:'pending',createdBy:global.uid(),createdAt:global.firebase.firestore.FieldValue.serverTimestamp()});
    }catch(e){ box.innerHTML='<p class="note err">招待を作れませんでした。家族への参加が承認されているか、通信を確認してください。</p>'; return; }
    input.value='';
    await sendInvite({id:ref.id,groupId:g,name:name},box,null);
  }
  /* つなぐ途中: LINEで送信したら、この画面が自動で「登録済み」に変わる */
  function watchLink(areaId,myUid,seq){
    try{
      linkWatch=global.db.collection('lineLinks').doc(myUid).onSnapshot(function(snap){
        if(seq!==renderSeq||!snap.exists) return;
        var g=typeof global.gid==='function'?global.gid():'';
        if((snap.data()||{}).groupId===g){ stopWatch(); render(areaId); if(typeof renderLog==='function') renderLog('settings-line-log'); }
      },function(){
        /* 見張れないときは黙らない: 自動で変わらないことを知らせる */
        if(seq!==renderSeq) return;
        var a=global.document&&global.document.getElementById(areaId);
        if(a) setState(a,'登録できたかを自動で確かめられません。LINEで送ったあとは「つながったか確かめる」を押してください。',true);
      });
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
        if(act==='invite') createInvite(area);
        if(act==='share-consent') giveShareConsent(area,areaId);
        if(act==='share-withdraw') withdrawShareConsent(areaId);
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
    /* 10分を過ぎたら作り直せるように、ボタンは消さずに「作り直す」にする(2026-10-08 審査の指摘) */
    btn.textContent='10分たったとき：コードを作り直す';
    var box=area.querySelector('[data-line-code]');
    var until=new Date(Date.now()+CODE_MINUTES*60*1000);
    /* 友だち追加の前にLINEを開くと、トークが真っ暗のままになることがある(2026-10-08 理絵さんの実機確認) */
    box.innerHTML='<p class="ln-sub"><b>先に「まいにこを友だち追加」を済ませてから</b>、下のボタンを押してください。</p>'+
      '<a class="set-btn ln-line" href="'+h(sendCodeUrl(code))+'" target="_blank" rel="noopener noreferrer">LINEを開いて送る</a>'+
      '<p class="ln-sub">開いたLINEのトークに、つなぐためのコードが入っています。そのまま<b>送信</b>を押してください。送ると、この画面が自動で「登録済み」に変わります（'+h(two(until.getHours())+':'+two(until.getMinutes()))+'まで有効）。</p>'+
      '<details class="ln-more"><summary>うまく開かないとき</summary><p class="note">LINEのトークが真っ暗のまま動かないときは、LINEを一度閉じて開き直してください。コードが入ったまま出てくるので、<b>送信</b>を押します。</p><p class="note">それでもだめなときは、まいにこ公式LINEのトークに、次のコードを送ってください。他の人には見せないでください。</p><div class="code-show">'+h(code)+'</div>'+
      '</details>'+
      '<button class="set-btn" type="button" data-line-act="check">送ったのに変わらないとき：つながったか確かめる</button>';
    bind(area,areaId);
  }
  async function unlink(area,areaId,btn){
    var q='LINEとつなぐのをやめますか？\nこのLINEには、予定のお知らせが届かなくなります。予定そのものは消えません。\n「LINEでログイン」の連携は、この操作では解除されません。';
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

  /* ===== 予定ごとに「LINEで知らせる人」を選ぶ(2026-10-04) =====
     notifyTo: null = つないだ家族全員(今までどおり)。配列 = 選んだ人だけ('u:<uid>' 家族 / 'r:<id>' 招待した人) */
  var whoState={};
  async function renderWho(id,selected){
    var box=document.getElementById(id);
    if(!box) return;
    delete whoState[id];
    box.innerHTML='<p class="note">知らせる人を読み込んでいます…</p>';
    var items=[], me=typeof global.uid==='function'?global.uid():'';
    try{
      var ms_=await global.col('members').where('status','==','approved').get();
      ms_.forEach(function(d){ items.push({key:'u:'+d.id,label:d.id===me?'自分':((d.data()||{}).name||'家族'),family:true,self:d.id===me}); });
      var shareOk=!!(await readShareConsent(me));
      if(shareOk){
        var rs=await global.db.collection('lineRecipients').where('groupId','==',global.gid()).get();
        rs.forEach(function(d){ var v=d.data()||{}; if(v.status==='joined') items.push({key:'r:'+d.id,label:v.name||'送信先',family:false}); });
      }
    }catch(e){
      box.innerHTML='<p class="note">知らせる人を読み込めませんでした。このまま保存すると、LINEを登録した家族全員に届きます。</p>';
      return;
    }
    items.sort(function(a,b){ return (b.self?1:0)-(a.self?1:0); });
    var sel=Array.isArray(selected)?selected:null;
    items.forEach(function(it){ it.on=sel?sel.indexOf(it.key)>=0:it.family; });
    whoState[id]={items:items};
    var draw=function(){
      box.innerHTML='<div class="ln-ttl">知らせる人</div><div class="ln-chips">'+items.map(function(it,i){
        return '<button type="button" class="ln-chip'+(it.on?' on':'')+(it.family?'':' ext')+'" aria-pressed="'+(it.on?'true':'false')+'" data-who="'+i+'">'+(it.on?'✓ ':'')+h(it.label)+'</button>';
      }).join('')+'</div><p class="note">選んだ人にだけ届きます。LINEを登録していない人には届きません。'+(items.some(function(it){return !it.family;})?'':'ヘルパーさんなど、アプリを使わない人に届けるときは「設定 → LINEで予定のお知らせ」で同意して招待できます。')+'</p>';
      box.querySelectorAll('[data-who]').forEach(function(b){
        b.onclick=function(){ var it=items[+b.getAttribute('data-who')]; it.on=!it.on; draw(); };
      });
    };
    draw();
  }
  function readWho(id){
    var st=whoState[id];
    if(!st) return undefined;
    var fam=st.items.filter(function(i){return i.family;}), ext=st.items.filter(function(i){return !i.family;});
    if(fam.every(function(i){return i.on;}) && !ext.some(function(i){return i.on;})) return null;
    return st.items.filter(function(i){return i.on;}).map(function(i){return i.key;}).slice(0,20);
  }

  global.MainicoLine={
    renderLog:renderLog, sendLog:sendLog, shiftForDate:shiftForDate,
    readQuota:readQuota, quotaText:quotaText, renderQuota:renderQuota,
    LINE_ID:LINE_ID, ADD_FRIEND_URL:ADD_FRIEND_URL,
    render:render, preset:preset, readNotify:readNotify, renderWho:renderWho, readWho:readWho, inviteUrl:inviteUrl,
    toInputValue:toInputValue, fromInputValue:fromInputValue, describe:describe, newCode:newCode
  };
})(typeof window!=='undefined'?window:globalThis);
