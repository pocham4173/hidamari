/* まいにこ: LINEでログイン・LINEとつなぐ(2026-10-01)。DOMには依存しない。
   - 本人確認と記録はすべて送信役(Cloudflare Worker)が行う。この画面はLINEの識別子を扱わない。
   - 手続きを始めた画面だけが「合言葉」を持つ(送るのはハッシュだけ)。LINEで確認したあとに表示される
     6けたの確認番号と合言葉がそろったときだけ、ログイン・つなぐが完了する。
   - Firebaseのトークンや合言葉はURLに載せない。戻り先URLの手続き番号と確認番号は、読んだらすぐ消す。 */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.MainicoLineLogin=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const KEY='mainico_line_auth_v1';
  const MAX_AGE=15*60*1000;
  const TX_RE=/^[0-9a-f]{32}$/,CODE_RE=/^[0-9]{6}$/;
  const FINAL=new Set(['expired','used','locked','not-linked','account-unavailable','conflict','wrong-account','not-found']);
  function problem(code){const e=new Error(code);e.code=code;return e;}
  function message(error){
    const code=error&&error.code||'';
    return ({
      'network':'通信できませんでした。電波の状態を確認して、もう一度お試しください。記録や設定は変わっていません。',
      'not-configured':'LINEでログインは準備中です。',
      'disabled':'LINEでログインは準備中です。',
      'app-check':'安全の確認ができませんでした。まいにこを開き直して、もう一度お試しください。',
      'auth-required':'ログインを確認できません。まいにこを開き直してください。',
      'account-unavailable':'このアカウントは、いまは使えません（削除・停止・終了手続き中など）。新しい登録はしていません。',
      'no-household':'家族への参加を確認できるアカウントでつないでください。招待の承認待ちのときは、承認後にお試しください。',
      'wrong-code':'番号がちがいます。LINEで確認したあとに表示された6けたの番号を入れてください。',
      'bad-code':'LINEで確認したあとに表示された、6けたの数字を入れてください。',
      'locked':'番号を何度もまちがえたため、この手続きは使えなくなりました。記録や設定は変わっていません。はじめからやり直してください。',
      'expired':'時間切れになりました。記録や設定は変わっていません。はじめからやり直してください。',
      'used':'この手続きは、すでに使われたか取り消されています。記録や設定は変わっていません。はじめからやり直してください。',
      'not-ready':'まだLINEでの確認が終わっていません。LINEの画面で確認してから、もう一度押してください。',
      'not-linked':'このLINEは、まいにこのアカウントとまだつながっていません。新しい登録はしていません。いつも使っているまいにこ（ホーム画面のアイコンなど）の設定「LINEでログイン」から、先につないでください。',
      'conflict':'このLINEは別のまいにこアカウントとつながっているか、このアカウントが別のLINEとつながっています。自動で付け替えたり、記録をまとめたりはしません。',
      'wrong-account':'この手続きは、別のアカウントで始めたものです。',
      'not-found':'この手続きは、この画面で始めたものではありません。「LINEで続ける」または「LINEとつなぐ」を押した画面に、番号を入れてください。',
      'no-pending':'この画面で始めた手続きが見つかりません。はじめからやり直してください。',
      'storage':'この画面では一時的な保存ができないため、LINEで続けられません。Safariの「プライベート」をやめるか、ホーム画面のまいにこから開いてください。',
      'device-in-use':'この画面は、すでに別のアカウントで使っています。記録が混ざらないよう、LINEのアカウントには切り替えていません。いつもの画面（ホーム画面のまいにこなど）から開いてください。',
      'setup-pending':'この画面で家庭の作成・参加が途中です。切り替えると途中の手続きがわからなくなるため、LINEのアカウントには切り替えていません。',
      'cancel-unconfirmed':'取り消しを確認できませんでした。手続きはまだ有効かもしれません。「もう一度取り消す」を押すか、「状態を確かめる」で確認してください。',
      'session-changed':'手続きの途中で、この画面のログインや家庭が変わったため、切り替えを中止しました。いま開いているアカウントと記録はそのままです。必要なら、もう一度「LINEで続ける」を押してください。',
      'deletion-pending':'この画面で削除の確認が残っています。先に削除画面で確認してください。',
      'bad-response':'LINEでログインの応答を確認できませんでした。記録や設定は変わっていません。',
      'retry':'混み合っています。少し待ってから、もう一度お試しください。'
    })[code]||'手続きを完了できませんでした。記録や設定は変わっていません。時間をおいて、もう一度お試しください。';
  }
  /* 戻り先URL(#line-auth=手続き番号&c=確認番号)を読む */
  function readReturn(hash){
    const params=new URLSearchParams(String(hash||'').replace(/^#/,''));
    const tx=params.get('line-auth'),code=params.get('c');
    if(!tx||!TX_RE.test(tx))return null;
    return {tx,code:code&&CODE_RE.test(code)?code:''};
  }
  /* カスタムトークンの宛先UID(切り替えてよいかを確かめるためだけに読む。正しさはFirebaseが確かめる) */
  function tokenUid(token){
    try{
      const part=String(token).split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      const json=decodeURIComponent(Array.from(atob(part+'==='.slice((part.length+3)%4)),c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join(''));
      const uid=JSON.parse(json).uid;
      return typeof uid==='string'&&uid?uid:'';
    }catch(e){return '';}
  }
  function cleanBase(value){
    const s=String(value||'').trim().replace(/\/+$/,'');
    return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(s)?s:'';
  }
  function create(options){
    const {fetch:doFetch,storage,crypto,getIdToken,getAppCheckToken}=options;
    const now=options.now||(()=>Date.now());
    const base=cleanBase(options.baseUrl);
    let memory=null;
    function enabled(){return !!base;}
    function load(){
      let value=null;
      try{value=JSON.parse(storage.getItem(KEY)||'null');}catch(e){value=null;}
      if(!value||!TX_RE.test(value.tx||'')||!/^[0-9a-f]{64}$/.test(value.secret||'')||!['login','link'].includes(value.purpose)||!(value.exp>now())){
        try{if(value)storage.removeItem(KEY);}catch(e){}
        return null;
      }
      return value;
    }
    function pending(purpose){
      const p=memory&&memory.exp>now()?memory:load();
      return p&&(!purpose||p.purpose===purpose)?p:null;
    }
    function clear(tx){
      if(!tx||(memory&&memory.tx===tx))memory=null;
      try{const saved=JSON.parse(storage.getItem(KEY)||'null');if(!tx||!saved||saved.tx===tx)storage.removeItem(KEY);}catch(e){}
    }
    async function hex(bytes){
      return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    }
    async function sha256(value){
      const d=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
      return Array.from(d,b=>b.toString(16).padStart(2,'0')).join('');
    }
    async function call(route,body,{idToken,appCheck}={}){
      if(!base)throw problem('disabled');
      const headers={'content-type':'application/json'};
      if(idToken){
        let token='';
        try{token=await getIdToken();}catch(e){throw problem('auth-required');}
        if(!token)throw problem('auth-required');
        headers.authorization='Bearer '+token;
      }
      if(appCheck){const token=await getAppCheckToken();if(token)headers['x-firebase-appcheck']=token;}
      let res;
      try{res=await doFetch(base+'/auth/line/'+route,{method:'POST',headers,body:JSON.stringify(body||{}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});}
      catch(e){throw problem('network');}
      let data=null;
      try{data=await res.json();}catch(e){data=null;}
      if(!res.ok)throw problem(data&&typeof data.error==='string'?data.error:'retry');
      if(!data||typeof data!=='object')throw problem('bad-response');
      return data;
    }
    async function start(purpose,extra={}){
      const secret=await hex(32);
      const data=await call('start',{purpose,secretHash:await sha256(secret)},{idToken:purpose==='link',appCheck:purpose==='login'});
      if(!TX_RE.test(data.tx||'')||typeof data.authorizeUrl!=='string'||data.authorizeUrl.indexOf('https://access.line.me/')!==0)throw problem('bad-response');
      const exp=Math.min(Number(data.expiresAt)||0,now()+MAX_AGE)||now()+MAX_AGE;
      const value={tx:data.tx,secret,purpose,uid:extra.uid||'',returnHash:extra.returnHash||'',exp};
      memory=value;
      try{storage.setItem(KEY,JSON.stringify(value));}
      catch(e){if(extra.persist){memory=null;throw problem('storage');}}
      return {tx:value.tx,authorizeUrl:data.authorizeUrl,expiresAt:exp};
    }
    function finalError(p,error){if(FINAL.has(error&&error.code))clear(p.tx);throw error;}
    return {
      enabled,pending,clear,
      startLogin:extra=>start('login',extra),
      startLink:extra=>start('link',extra),
      async status(){
        const p=pending();if(!p)throw problem('no-pending');
        try{
          const s=await call('status',{tx:p.tx,secret:p.secret},{idToken:p.purpose==='link',appCheck:p.purpose==='login'});
          if(!['waiting','ready'].includes(s.status))clear(p.tx);
          return s;
        }catch(error){return finalError(p,error);}
      },
      async confirmLink(code){
        const p=pending('link');if(!p)throw problem('no-pending');
        if(!CODE_RE.test(String(code||'')))throw problem('bad-code');
        try{const r=await call('confirm',{tx:p.tx,secret:p.secret,code:String(code)},{idToken:true});clear(p.tx);return r;}
        catch(error){return finalError(p,error);}
      },
      async exchange(code){
        const p=pending('login');if(!p)throw problem('no-pending');
        if(!CODE_RE.test(String(code||'')))throw problem('bad-code');
        let r;
        try{r=await call('exchange',{tx:p.tx,secret:p.secret,code:String(code)},{appCheck:true});}
        catch(error){return finalError(p,error);}
        clear(p.tx);
        const uid=tokenUid(r.customToken);
        if(!uid)throw problem('bad-response');
        return {customToken:r.customToken,uid,returnHash:p.returnHash||''};
      },
      /* 取り消し。結果は次のどれか(手続きの情報は、取り消しが確定した・終わっていたと分かったときだけ消す)
         cancelled: 取り消しが確定 / done: 取り消す前に完了していた / expired: 時間切れ・すでに終わっていた
         retry: 競合で確認できなかった(やり直せる) / unknown: 通信できず結果が分からない(やり直せる) / none: 手続きがない */
      async cancel(){
        const p=pending();if(!p)return {result:'none'};
        let r;
        try{r=await call('cancel',{tx:p.tx,secret:p.secret});}
        catch(error){
          if(error.code==='not-found'){clear(p.tx);return {result:'expired'};}
          return {result:error.code==='network'?'unknown':'retry'};
        }
        if(r.cancelled===true){clear(p.tx);return {result:'cancelled'};}
        if(r.status==='done'){clear(p.tx);return {result:'done',purpose:p.purpose};}
        if(r.status==='retry')return {result:'retry'};
        clear(p.tx);
        return {result:'expired',status:typeof r.status==='string'?r.status:''};
      },
      unlink:()=>call('unlink',{},{idToken:true})
    };
  }
  return {create,readReturn,tokenUid,message,KEY};
});
