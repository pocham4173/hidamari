/* まいにこ: LINEでログインの画面(2026-10-01)。手続きの中身は line-login.js と送信役が行う。
   - 未ログインの画面では「すでに使っている方」と「はじめて使う」を分ける。勝手に新規登録しない。
   - LINEから戻ったときは、ログインと家庭の確認が終わるまで「まいにこを開いています」を出す。
   - LINEでログインの解除は、予定のお知らせ(LINEで予定のお知らせ)の解除とは別。 */
'use strict';
let lineLoginSvc=null,lineReturn=null,lineReturnElsewhere=null,lineLinkResume=null,lineLoginNotice='';
let lineAuthFlow=null,lineAuthPollTimer=null,lineAuthBusy=false;

function lineLoginService(){
  if(!lineLoginSvc&&window.MainicoLineLogin)lineLoginSvc=MainicoLineLogin.create({
    baseUrl:window.MAINICO_LINE_AUTH_URL||'',fetch:(url,options)=>fetch(url,options),storage:localStorage,crypto:window.crypto,
    getIdToken:()=>auth.currentUser?auth.currentUser.getIdToken():Promise.reject(new Error('no-user')),
    getAppCheckToken:async()=>{try{return (await previewApp.appCheck().getToken(false)).token||'';}catch(e){return '';}}
  });
  return lineLoginSvc;
}
function lineLoginEnabled(){try{return !!lineLoginService()&&lineLoginService().enabled();}catch(e){return false;}}

/* 戻り先URLの手続き番号・確認番号は、読んだらすぐアドレス欄から消す(履歴や共有に残さない) */
(function(){
  try{
    const r=window.MainicoLineLogin&&MainicoLineLogin.readReturn(location.hash);
    if(r){lineReturn=r;history.replaceState(null,'',location.pathname+location.search);}
  }catch(e){}
})();

function lineEl(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function lineSetLoading(text){const l=document.getElementById('loading');if(l){l.textContent=text;l.style.display='flex';}}
/* LINEのお知らせから開いた予定は、ログインのあとまで覚えておく(表示するかは家族の権限を確かめてから) */
function lineReturnHashFromSchedule(){
  try{
    if(typeof scheduleLink!=='undefined'&&scheduleLink)return 'schedule='+encodeURIComponent(scheduleLink.id)+'&group='+encodeURIComponent(scheduleLink.group);
  }catch(e){}
  return '';
}
function lineRestoreReturnHash(hash){
  if(!hash||typeof readScheduleLink!=='function'||!readScheduleLink('#'+hash))return;
  try{history.replaceState(null,'',location.pathname+location.search+'#'+hash);window.dispatchEvent(new HashChangeEvent('hashchange'));}catch(e){}
}
function lineNavigate(url){location.assign(url);}
function lineProblem(code){const e=new Error(code);e.code=code;return e;}

/* ログインの仕上げ: 1回だけのカスタムトークンで、つないだアカウント(同じUID)に入る */
async function lineLoginFinish(code){
  const svc=lineLoginService();
  const current=auth.currentUser;
  // 記録のある画面を、別のアカウントに切り替えない
  let inUse=!!(current&&gid());
  if(current&&!inUse){
    try{inUse=(await db.collection('accounts').doc(current.uid).get({source:'server'})).exists;}
    catch(e){throw lineProblem('network');}
  }
  for(const key of ['mainico_group_setup_v1','mainico_join_pending_v1']){
    let pending=null;try{pending=JSON.parse(localStorage.getItem(key)||'null');}catch(e){}
    if(current&&pending&&pending.uid===current.uid)throw lineProblem('setup-pending');
  }
  if(typeof getDeletionService==='function'&&getDeletionService().getPending())throw lineProblem('deletion-pending');
  const result=await svc.exchange(code);
  if(current&&current.uid===result.uid){lineRestoreReturnHash(result.returnHash);return false;}
  if(inUse)throw lineProblem('device-in-use');
  // 記録のない一時的な状態だけを片付けてから入る(元のアカウントの記録はサーバーにそのまま)
  if(current&&typeof clearMainicoDeviceData==='function')clearMainicoDeviceData();
  lineRestoreReturnHash(result.returnHash);
  await auth.signInWithCustomToken(result.customToken);
  return true;
}

/* 起動の最初に呼ぶ。true のときは、ログインが切り替わったので起動をやり直す(この起動は終える) */
async function lineAuthBeforeBoot(user){
  if(!lineReturn)return false;
  const r=lineReturn;lineReturn=null;
  const svc=lineLoginService();
  const p=svc&&svc.enabled()?svc.pending():null;
  if(!p||p.tx!==r.tx){if(r.code)lineReturnElsewhere=r;return false;}
  if(p.purpose==='link'){if(user&&user.uid===p.uid)lineLinkResume={code:r.code};return false;}
  if(!r.code){
    try{await svc.status();}catch(e){lineLoginNotice=MainicoLineLogin.message(e);}
    if(!lineLoginNotice)lineLoginNotice='LINEでの確認は完了していません。もう一度「LINEで続ける」を押してください。';
    return false;
  }
  lineSetLoading('まいにこを開いています…');
  window.mainicoStartupStage='LINEで本人確認中';
  try{return await lineLoginFinish(r.code);}
  catch(error){lineLoginNotice=MainicoLineLogin.message(error);return false;}
}
/* 起動の最後(画面を開いたあと)に呼ぶ */
function lineAuthAfterBoot(){
  if(lineLinkResume&&uid()){const r=lineLinkResume;lineLinkResume=null;openLineLink(r.code);return;}
  if(lineReturnElsewhere){const r=lineReturnElsewhere;lineReturnElsewhere=null;showLineCodeElsewhere(r.code);return;}
  if(lineLoginNotice){const text=lineLoginNotice;lineLoginNotice='';showLineNotice(text);}
}
/* 入口ならその場に、いつもの画面なら小さな画面で知らせる */
function showLineNotice(text){
  const entry=document.getElementById('entry');
  if(entry&&entry.classList.contains('active')){const s=document.getElementById('entry-state');if(s)s.textContent=text;return;}
  const box=document.getElementById('line-auth-body');box.replaceChildren(lineEl('p','note',text));
  document.getElementById('line-auth-title').textContent='LINEで続ける';
  lineAuthFlow=null;
  document.getElementById('line-auth-modal').classList.add('show');
}

/* ===== 未ログインの入口 ===== */
function showWelcome(){
  if(typeof appDialogCancelAll==='function')appDialogCancelAll();
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.getElementById('loading').style.display='none';
  showPage('welcome');
  const state=document.getElementById('welcome-state');
  state.textContent=lineLoginNotice;lineLoginNotice='';
  const svc=lineLoginService(),p=svc&&svc.pending('login');
  document.getElementById('welcome-code').hidden=!p;
  if(lineReturnElsewhere){const r=lineReturnElsewhere;lineReturnElsewhere=null;showLineCodeElsewhere(r.code);}
}
async function lineLoginStart(){
  const state=document.getElementById(document.getElementById('welcome').classList.contains('active')?'welcome-state':'entry-state');
  if(!lineLoginEnabled()){if(state)state.textContent=MainicoLineLogin.message({code:'disabled'});return;}
  if(lineAuthBusy)return;
  if(gid()){if(state)state.textContent=MainicoLineLogin.message({code:'device-in-use'});return;}
  lineAuthBusy=true;
  if(state)state.textContent='LINEの画面を準備しています…';
  try{
    const standalone=typeof isStandalone==='function'&&isStandalone();
    const started=await lineLoginService().startLogin({returnHash:lineReturnHashFromSchedule(),persist:!standalone});
    if(standalone){openLineAuthModal('login',started);return;}
    // Safariなど: 同じ画面のままLINEへ。戻ってきたら自動で続ける
    lineNavigate(started.authorizeUrl);
  }catch(error){if(state)state.textContent=MainicoLineLogin.message(error);}
  finally{lineAuthBusy=false;}
}
function welcomeEnterCode(){
  const svc=lineLoginService();
  if(svc&&svc.pending('login'))openLineAuthModal('login',null);
  else{document.getElementById('welcome-code').hidden=true;document.getElementById('welcome-state').textContent=MainicoLineLogin.message({code:'no-pending'});}
}
async function startFirstUse(){
  const text='新しく登録して、はじめから使いますか？\nすでにまいにこを使っている方が新しく登録すると、今までの記録とは別のアカウントになります。いつもの記録に戻るときは「LINEで続ける」か「メールとパスワードで戻る」を選んでください。';
  if(!await (typeof appConfirm==='function'?appConfirm(text,'新しく登録する','もどる'):confirm(text)))return;
  document.getElementById('welcome-state').textContent='準備しています…';
  try{await auth.signInAnonymously();}
  catch(error){document.getElementById('welcome-state').textContent='登録を始められませんでした。電波の状態を確認して、もう一度お試しください。';}
}

/* ===== LINEとつなぐ・LINEで続ける(番号を入れる画面) ===== */
function stopLineAuthPoll(){if(lineAuthPollTimer){clearTimeout(lineAuthPollTimer);lineAuthPollTimer=null;}}
function closeLineAuth(){
  stopLineAuthPoll();
  const flow=lineAuthFlow;lineAuthFlow=null;
  document.getElementById('line-auth-modal').classList.remove('show');
  if(flow&&flow.purpose==='link'&&typeof renderLineLoginSettings==='function'){renderLineLoginSettings('settings-line-login-area');renderLineLoginSettings('person-line-login-area');}
}
async function cancelLineAuth(){
  const flow=lineAuthFlow;
  closeLineAuth();
  if(flow&&!flow.done){try{await lineLoginService().cancel();}catch(e){}}
}
function lineAuthState(text,error){
  const s=document.getElementById('line-auth-state');
  if(s){s.textContent=text||'';s.classList.toggle('err',!!error);}
}
function openLineAuthModal(purpose,started,code){
  stopLineAuthPoll();
  const flow={purpose,uid:uid(),started,done:false};
  lineAuthFlow=flow;
  const box=document.getElementById('line-auth-body');box.replaceChildren();
  document.getElementById('line-auth-title').textContent=purpose==='link'?'LINEとつなぐ':'LINEで続ける';
  if(purpose==='link'&&!started&&!lineLoginService().pending('link')){
    box.appendChild(lineEl('p','note','LINEで本人確認をして、このアカウントにつなぎます。つないだあとは、LINEの「まいにこを開く」や予定のお知らせのリンクから、いつもの画面に入れます。'));
    const ul=lineEl('ul','note');
    ['このアカウントの記録・家族・役割は、そのままです。新しいアカウントは作りません。',
     '予定のお知らせ（LINEで予定のお知らせ）とは別の設定です。こちらをつないでも、お知らせは増えません。',
     'LINEで確認したあとに出る6けたの番号を、この画面に入れて完了します。'].forEach(t=>ul.appendChild(lineEl('li','',t)));
    box.appendChild(ul);
    const go=lineEl('button','set-btn','LINEで本人確認をはじめる');go.type='button';go.id='line-auth-start';
    go.addEventListener('click',()=>startLineLink(flow));
    box.appendChild(go);
    const state=lineEl('div','save-state');state.id='line-auth-state';state.setAttribute('aria-live','polite');box.appendChild(state);
  }else renderLineAuthCodeStep(flow,code||'');
  document.getElementById('line-auth-modal').classList.add('show');
}
async function startLineLink(flow){
  if(lineAuthFlow!==flow||lineAuthBusy)return;
  const btn=document.getElementById('line-auth-start');if(btn)btn.disabled=true;
  lineAuthBusy=true;lineAuthState('準備しています…');
  try{
    flow.started=await lineLoginService().startLink({uid:flow.uid});
    if(lineAuthFlow===flow)renderLineAuthCodeStep(flow,'');
  }catch(error){if(lineAuthFlow===flow){lineAuthState(MainicoLineLogin.message(error),true);if(btn)btn.disabled=false;}}
  finally{lineAuthBusy=false;}
}
function renderLineAuthCodeStep(flow,code){
  const box=document.getElementById('line-auth-body');box.replaceChildren();
  if(flow.started&&flow.started.authorizeUrl){
    box.appendChild(lineEl('p','note','下のボタンでLINEを開き、本人確認をしてください。確認すると、6けたの番号が表示されます。この画面に戻って、番号を入れてください（10分以内）。'));
    const a=lineEl('a','set-btn line-add','LINEを開いて確認する');a.href=flow.started.authorizeUrl;a.target='_blank';a.rel='noopener noreferrer';
    box.appendChild(a);
  }else box.appendChild(lineEl('p','note','LINEで確認したあとに表示された、6けたの番号を入れてください。'));
  const who=lineEl('p','note');who.id='line-auth-who';box.appendChild(who);
  const label=lineEl('label','','6けたの番号');label.htmlFor='line-auth-code';box.appendChild(label);
  const input=lineEl('input','setup-input');input.id='line-auth-code';input.inputMode='numeric';input.autocomplete='one-time-code';input.maxLength=7;input.value=code||'';
  input.setAttribute('pattern','[0-9 ]*');box.appendChild(input);
  const ok=lineEl('button','set-btn',flow.purpose==='link'?'このLINEとつなぐ':'まいにこを開く');ok.type='button';ok.id='line-auth-ok';
  ok.addEventListener('click',()=>submitLineAuthCode(flow));box.appendChild(ok);
  const cancel=lineEl('button','set-btn warn','取り消す（何も変えない）');cancel.type='button';cancel.addEventListener('click',cancelLineAuth);box.appendChild(cancel);
  const state=lineEl('div','save-state');state.id='line-auth-state';state.setAttribute('aria-live','polite');box.appendChild(state);
  box.appendChild(lineEl('p','note','番号は、ご自身のまいにこの画面にだけ入れてください。電話やメッセージで人に聞かれても教えないでください。'));
  pollLineAuth(flow);
}
async function pollLineAuth(flow){
  stopLineAuthPoll();
  if(lineAuthFlow!==flow||flow.done)return;
  if(!document.hidden){
    try{
      const s=await lineLoginService().status();
      if(lineAuthFlow!==flow)return;
      if(s.status==='ready'){
        const who=document.getElementById('line-auth-who');
        if(who)who.textContent=flow.purpose==='link'?('LINEでの確認ができました'+(s.lineName?'（確認したLINE：'+s.lineName+'）':'')+'。番号を入れて「このLINEとつなぐ」を押すと完了します。'):'LINEでの確認ができました。番号を入れて「まいにこを開く」を押してください。';
      }else if(s.status!=='waiting'){
        lineAuthState(MainicoLineLogin.message({code:s.status==='done'?'used':s.status==='cancelled'?'used':s.status==='error'?'retry':s.status}),true);
        flow.done=true;return;
      }
    }catch(error){
      if(lineAuthFlow!==flow)return;
      if(error.code!=='network'){lineAuthState(MainicoLineLogin.message(error),true);if(!lineLoginService().pending()){flow.done=true;return;}}
    }
  }
  lineAuthPollTimer=setTimeout(()=>pollLineAuth(flow),4000);
}
async function submitLineAuthCode(flow){
  if(lineAuthFlow!==flow||lineAuthBusy||flow.done)return;
  const code=String(document.getElementById('line-auth-code').value||'').replace(/[\s-]/g,'').normalize('NFKC');
  const btn=document.getElementById('line-auth-ok');
  lineAuthBusy=true;btn.disabled=true;lineAuthState('確認しています…');
  try{
    if(flow.purpose==='link'){
      if(uid()!==flow.uid)throw lineProblem('wrong-account');
      await lineLoginService().confirmLink(code);
      flow.done=true;stopLineAuthPoll();
      lineAuthState('LINEとつなぎました。これからは、LINEの「まいにこを開く」やお知らせのリンクから、いつもの画面に入れます。');
      btn.hidden=true;
    }else{
      lineAuthState('まいにこを開いています…');
      const switched=await lineLoginFinish(code);
      flow.done=true;stopLineAuthPoll();
      document.getElementById('line-auth-modal').classList.remove('show');lineAuthFlow=null;
      if(switched)lineSetLoading('まいにこを開いています…');
      else if(auth.currentUser)await bootHouseholdUser(auth.currentUser);
    }
  }catch(error){
    if(lineAuthFlow===flow){
      lineAuthState(MainicoLineLogin.message(error),true);
      if(!lineLoginService().pending(flow.purpose)){flow.done=true;stopLineAuthPoll();}
    }
  }finally{lineAuthBusy=false;if(!flow.done||flow.purpose!=='link')btn.disabled=false;}
}
/* 別の画面で始めた手続きの番号が、この画面に戻ってきたとき */
function showLineCodeElsewhere(code){
  if(!code)return;
  const box=document.getElementById('line-auth-body');box.replaceChildren();
  document.getElementById('line-auth-title').textContent='LINEでの確認ができました';
  box.appendChild(lineEl('p','note','この画面は、手続きを始めた画面とは別のようです。「LINEとつなぐ」または「LINEで続ける」を押した画面（ホーム画面のまいにこなど）に戻り、次の番号を入れてください（5分以内）。'));
  box.appendChild(lineEl('p','line-auth-code',code.slice(0,3)+' '+code.slice(3)));
  box.appendChild(lineEl('p','note','この番号は、ご自身のまいにこの画面にだけ入れてください。人に教えないでください。心当たりがなければ、何もしなくてかまいません（5分で使えなくなります）。'));
  lineAuthFlow=null;
  document.getElementById('line-auth-modal').classList.add('show');
}
function openLineLink(code){
  if(!lineLoginEnabled()){alert(MainicoLineLogin.message({code:'disabled'}));return;}
  if(!uid()||!gid()){alert('家族とつながってから、LINEとつないでください。');return;}
  const p=lineLoginService().pending('link');
  if(p&&p.uid!==uid())lineLoginService().clear(p.tx);
  openLineAuthModal('link',null,code);
}

/* ===== 設定の「LINEでログイン」 ===== */
const lineLoginRender={};
async function renderLineLoginSettings(areaId){
  const area=document.getElementById(areaId);if(!area)return;
  const seq=lineLoginRender[areaId]=(lineLoginRender[areaId]||0)+1;
  area.replaceChildren();
  if(!lineLoginEnabled()){area.appendChild(lineEl('p','note','LINEでログインは準備中です。準備ができると、ここからLINEとつなげるようになります。'));return;}
  const me=uid();
  if(!me||!gid()){area.appendChild(lineEl('p','note','家族とつながってから設定できます。'));return;}
  area.appendChild(lineEl('p','note','確認しています…'));
  let linked=null,failed=false;
  try{const snap=await db.collection('lineLoginAccounts').doc(me).get({source:'server'});linked=snap.exists?snap.data():null;}
  catch(e){failed=true;}
  if(lineLoginRender[areaId]!==seq||uid()!==me)return;
  area.replaceChildren();
  if(failed){
    area.appendChild(lineEl('p','note','LINEでログインの状態を確認できませんでした。通信を確認してください。'));
    const again=lineEl('button','set-btn','もう一度確認する');again.type='button';again.addEventListener('click',()=>renderLineLoginSettings(areaId));area.appendChild(again);return;
  }
  if(linked){
    const at=linked.linkedAt&&typeof linked.linkedAt.toDate==='function'?linked.linkedAt.toDate():null;
    area.appendChild(lineEl('p','note','✅ このアカウントは、LINEでログインできます'+(at?'（'+(at.getMonth()+1)+'月'+at.getDate()+'日から）':'')+'。LINEの「まいにこを開く」やお知らせのリンクから、いつもの画面に入れます。'));
    const ul=lineEl('ul','note');
    ['解除すると、LINEからまいにこに入れなくなります。予定のお知らせ（LINEで予定のお知らせ）は止まりません。お知らせを止めるときは「LINEで予定のお知らせ」で解除してください。',
     '解除しても、いま開いているこの画面や、ホーム画面のまいにこは、そのまま使えます。',
     '解除したあとに別のスマホやSafariで戻るときは、「機種変更・アカウントの復旧」で設定したメールとパスワードを使います。'].forEach(t=>ul.appendChild(lineEl('li','',t)));
    area.appendChild(ul);
    const off=lineEl('button','set-btn warn','LINEでログインの連携を解除する');off.type='button';off.addEventListener('click',()=>unlinkLineLogin(areaId,off));area.appendChild(off);
  }else{
    area.appendChild(lineEl('p','note','LINEとつなぐと、LINEの「まいにこを開く」や予定のお知らせのリンクから、登録や使い方の選び直しなしで、いつもの画面に入れます。今の記録・家族・役割はそのままです。'));
    const on=lineEl('button','set-btn','LINEとつなぐ');on.type='button';on.addEventListener('click',()=>openLineLink(''));area.appendChild(on);
  }
  const state=lineEl('div','save-state');state.setAttribute('aria-live','polite');state.dataset.lineLoginState='1';area.appendChild(state);
}
async function unlinkLineLogin(areaId,btn){
  const user=auth.currentUser;
  const hasPassword=!!(user&&(user.providerData||[]).some(p=>p&&p.providerId==='password'));
  const text='LINEでログインの連携を解除しますか？\n・このLINEから、まいにこに入れなくなります。\n・予定のお知らせ（LINEで予定のお知らせ）は止まりません。\n・いま開いているこの画面は、そのまま使えます。'+
    (hasPassword?'':'\n・復旧用のメールとパスワードがまだ設定されていません。解除すると、この端末以外からこのアカウントに戻る方法がなくなります。');
  if(!await (typeof appConfirm==='function'?appConfirm(text,'解除する'):confirm(text)))return;
  const state=document.querySelector('#'+areaId+' [data-line-login-state]');
  btn.disabled=true;if(state)state.textContent='解除しています…';
  try{await lineLoginService().unlink();await renderLineLoginSettings(areaId);}
  catch(error){btn.disabled=false;if(state){state.textContent=MainicoLineLogin.message(error);state.classList.add('err');}}
}
