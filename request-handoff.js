/* Existing onegai / onegai-back events; no subscriptions, permissions or notifications here.
   A response is a family member's statement, not proof of delivery or actual care. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MainicoRequestHandoff=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const quiet='今日はそっとしておいて';
  const compare=(a,b)=>(a.at?.seconds||0)-(b.at?.seconds||0)||(a.at?.nanoseconds||0)-(b.at?.nanoseconds||0)||String(a._id).localeCompare(String(b._id));
  function stamp(row){
    const d=new Date((row.at?.seconds||0)*1000);
    return row.at?.seconds?`${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`:'日時の確認待ち';
  }
  function plans(text){
    const later='電話できる時間を、あとで伝えるね';
    if(text===quiet)return ['わかったよ。今日はそっとしておくね'];
    if(text==='電話してほしい'||text==='話したい')return ['今から電話するね',later];
    if(text==='あとで連絡して')return [later];
    if(text==='買い物をお願い')return ['買い物を手伝うね。品物と時間は電話で相談しよう'];
    if(text==='予定を確認したい')return ['一緒に予定を確認するね。時間は電話で相談しよう'];
    if(text==='少し困っている')return ['今から電話で話を聞くね'];
    return ['話を聞くね。時間は電話で相談しよう'];
  }
  function create(options){
    const doc=options.document;
    let scope='',generation=0,data={person:[],family:[]},status={person:'loading',family:'loading'};
    const busy=new Set(),saved=new Map(),messages=new Map(),drafts=new Map(),expanded=new Set();
    const el=id=>doc.getElementById(id);
    const context=()=>options.context();
    const key=c=>[c.uid,c.gid,c.generation,c.mode,c.kOnly].join(':');
    function reset(){
      generation++;scope='';data={person:[],family:[]};status={person:'loading',family:'loading'};
      busy.clear();saved.clear();messages.clear();drafts.clear();expanded.clear();
      for(const role of ['person','family']){const summary=el(role+'-request-summary');if(summary)summary.textContent='';}
      for(const role of ['person','family']){const list=el(role+'-requests-list');if(list)list.replaceChildren();const panel=el(role+'-requests-panel');if(panel){panel.hidden=true;if(role==='family')panel.open=false;}}
      try{options.stopSpeech?.();}catch(_){}
    }
    function ensure(){const next=key(context());if(scope!==next){reset();scope=next;}}
    function all(role){
      const rows=data[role].slice(),ids=new Set(rows.map(x=>x._id));
      for(const row of saved.values())if(!ids.has(row._id)&&rows.some(x=>x._id===row.replyTo))rows.push(row);
      return rows;
    }
    function responses(id,role){
      const latest=new Map();
      all(role).filter(v=>v.type==='onegai-back'&&v.replyTo===id&&v.uid).sort(compare).forEach(v=>latest.set(v.uid,v));
      const commitments=new Map();
      all(role).filter(v=>v.type==='onegai-back'&&v.replyTo===id&&v.uid&&['planned','done','noted','withdrawn'].includes(v.requestStage)).sort(compare).forEach(v=>commitments.set(v.uid,v));
      const result=[...latest.values()];
      commitments.forEach(v=>{if(!result.some(r=>r._id===v._id))result.push(v);});
      return result.sort(compare);
    }
    function request(id,role='family'){return data[role].find(v=>v.type==='onegai'&&v._id===id);}
    function ready(){const c=context();return c.mode==='kazoku'&&!c.kOnly&&c.familyReady&&status.family==='ready';}
    function node(parent,tag,text,cls){const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;parent.appendChild(n);return n;}
    function button(parent,label,id,action,disabled,run){
      const b=node(parent,'button',label);b.type='button';b.dataset.handoffKey=id+':'+action;b.disabled=disabled;
      b.addEventListener('click',run);return b;
    }
    function label(row){return row.requestStage==='planned'?'対応予定':row.requestStage==='done'?'対応した報告':row.requestStage==='noted'?'気持ちを確認':row.requestStage==='withdrawn'?'予定の取り消し':'返事';}
    function refresh(){ensure();const c=context();if(c.familyStatus)status.family=c.familyStatus;if(c.personStatus)status.person=c.personStatus;render('person');render('family');}
    function update(role,items,state){
      ensure();data[role]=items;status[role]=state;
      for(const [id,v] of saved){if(items.some(x=>x._id===v._id)||!items.some(x=>x._id===v.replyTo))saved.delete(id);}
      render(role);
    }
    // Only opaque event IDs/versions are stored, scoped to this account and household.
    function hiddenKey(){const c=context();return 'mainicoRequestHidden-v1:'+JSON.stringify([c.uid,c.gid]);}
    function hiddenRows(){
      try{const rows=JSON.parse(options.storage?.getItem(hiddenKey())||'[]');
        return new Map(Array.isArray(rows)?rows.filter(v=>Array.isArray(v)&&v.length===2&&v.every(x=>typeof x==='string')):[]);
      }catch(_){return new Map();}
    }
    function version(id){return JSON.stringify(all('family').filter(v=>v._id===id||(v.type==='onegai-back'&&v.replyTo===id))
      .map(v=>v._id).sort());}
    async function dismiss(id,restore=false){
      ensure();if(!ready()||busy.has(id)||!request(id))return false;
      const token=generation,scopeKey=scope,before=version(id);busy.add(id);render('family');
      const current=()=>token===generation&&scope===scopeKey&&key(context())===scopeKey;
      try{
        if(!restore&&!await options.confirmDismiss('このスマホのホームから、このお願いを消しますか？\n本人やほかの家族の記録は残ります。\n「消したお願い」から戻せます。新しい返事が届くと、再び表示します。'))return false;
        if(!current()||!ready()||!request(id))return false;
        if(version(id)!==before){messages.set(id,'返事が更新されました。内容を確認してから、もう一度お試しください。');return false;}
        const entries=hiddenRows();if(restore)entries.delete(id);else{entries.delete(id);entries.set(id,before);}
        options.storage.setItem(hiddenKey(),JSON.stringify([...entries].slice(-300)));
        messages.delete(id);expanded.delete(id);
        render('family');
        const panel=el('family-requests-panel');if(!restore&&el('family-requests-label')?.textContent.startsWith('消したお願い'))panel.open=false;
        el('family-requests-heading')?.focus({preventScroll:true});
        return true;
      }catch(_){if(current())messages.set(id,'このスマホに保存できなかったため、表示は変更していません。もう一度お試しください。');return false;}
      finally{if(current()){busy.delete(id);render('family');}}
    }
    function render(role){
      const panel=el(role+'-requests-panel'),list=el(role+'-requests-list'),state=el(role+'-requests-state');
      if(!panel||!list)return;
      const c=context(),allRows=data[role].filter(v=>v.type==='onegai'&&(role==='family'||v.uid===c.uid)).sort((a,b)=>compare(b,a));
      const hidden=role==='family'?hiddenRows():new Map();
      const archived=allRows.filter(v=>hidden.get(v._id)===version(v._id));
      const rows=allRows.filter(v=>!archived.includes(v));
      // The family-only recording mode has no inbox from a person using the app.
      panel.hidden=!allRows.length||(role==='family'&&c.kOnly);
      const active=doc.activeElement,focusKey=list.contains(active)?active.dataset.handoffKey:null;
      const selection=focusKey&&active.tagName==='INPUT'?[active.selectionStart,active.selectionEnd]:null;
      list.querySelectorAll('details[data-open-key]').forEach(d=>{if(d.open)expanded.add(d.dataset.openKey);else expanded.delete(d.dataset.openKey);});
      list.replaceChildren();
      if(role==='person'){
        const summary=el('person-request-summary');
        if(summary){
          const replies=rows.flatMap(req=>responses(req._id,'person')).sort(compare),latest=replies.at(-1);
          summary.textContent=!rows.length?'':status.person!=='ready'?'お願いの返事は、最新の確認ができていません。':
            latest?'お願いへの返事：'+stamp(latest)+' · '+(latest.name||'家族')+'さん':
            '表示中のお願いには、まだ返事がありません。';
        }
      }
      if(role==='family'){
        const summary=el('family-request-summary'),latest=rows[0];
        const title=el('family-requests-label');if(title)title.textContent=rows.length?'お願い・返事を確認する':archived.length?'消したお願いを見る（'+archived.length+'件）':'お願い・返事を確認する';
        if(summary)summary.textContent=!latest?'':(status.family!=='ready'?'最新の確認ができていません。':'')+
          stamp(latest)+' · 「'+(latest.text||'お願い')+'」'+(rows.length>1?' ほか'+(rows.length-1)+'件':'')+
          (rows.some(req=>responses(req._id,'family').length)?' · 返事があります':'');
      }
      if(panel.hidden)return;
      const connected=role==='family'?c.familyReady:c.personReady;
      state.textContent=(status[role]!=='ready'?'最新の確認ができていません。保存済みの内容です。':!connected?'今は家族と返事をやりとりできません。以前の内容を表示しています。':'')+
        '最近読み込んだ100件の記録の中のお願いです。保存は、相手が読んだことを意味しません。';
      let more;
      rows.forEach((req,index)=>{
        let parent=list;
        if(index>=3){if(!more){more=node(list,'details');more.dataset.openKey=role;more.open=expanded.has(role);const summary=node(more,'summary','ほかのお願いを見る（'+(rows.length-3)+'件）');summary.dataset.handoffKey=role+':more';more.addEventListener('toggle',()=>{if(!more.isConnected)return;if(more.open)expanded.add(role);else expanded.delete(role);});}parent=more;}
        const row=node(parent,'article',undefined,'request-item');row.dataset.requestId=req._id;
        node(row,'div',stamp(req)+(role==='family'?' · '+(req.name||'ご本人'):''),'request-meta');
        const heading=node(row,'h3','「'+(req.text||'お願い')+'」');heading.tabIndex=-1;heading.dataset.handoffKey=req._id+':heading';
        const replies=responses(req._id,role);
        if(!replies.length)node(row,'p','返事はまだ記録されていません。');
        replies.forEach(reply=>{node(row,'p',(reply.name||'家族')+'さん · '+label(reply)+'\n'+stamp(reply)+'\n'+(reply.text||''),'request-response');});
        const actions=node(row,'div',undefined,'request-actions');
        if(role==='person'){
          button(actions,'🔊 お願いと返事を聞く',req._id,'read',false,()=>{
            const current=request(req._id,'person');if(!current)return;
            const text='お願い、'+current.text+'。'+responses(req._id,'person').map(r=>(r.name||'家族')+'さん、'+stamp(r)+'、'+r.text).join('。');
            options.speak(text);
          });
          button(actions,'読み上げを止める',req._id,'stop',false,()=>options.stopSpeech?.());
        }else{
          const mine=replies.filter(v=>v.uid===c.uid&&['planned','done','noted','withdrawn'].includes(v.requestStage)).sort(compare).pop(),locked=!ready()||busy.has(req._id);
          const isQuiet=req.text===quiet;
          if(!mine||mine.requestStage==='withdrawn'){
            plans(req.text).forEach((text,i)=>button(actions,text,req._id,'plan-'+i,locked,()=>send(req._id,text,isQuiet?'noted':'planned')));
          }
          if(mine?.requestStage==='planned'){
            button(actions,'対応したことを本人へ伝える',req._id,'done',locked,async()=>{
              const text=['電話してほしい','話したい','あとで連絡して','少し困っている'].includes(req.text)?'電話で話しました。':req.text==='買い物をお願い'?'買い物を手伝いました。':req.text==='予定を確認したい'?'一緒に予定を確認しました。':'お願いに対応しました。';
              const token=generation;
              if(await options.confirm('実際に対応したあとに伝えてください。\n\n「'+req.text+'」について\n'+text+'\n\n電話の内容・様子は「様子を記録する」から別に残せます。')&&token===generation)await send(req._id,text,'done',mine._id);
            });
            button(actions,'自分の対応予定を取り消す',req._id,'withdraw',locked,()=>send(req._id,'対応の予定を取り消しました。別の方法で相談します。','withdrawn',mine._id));
          }
          if(mine?.requestStage==='done'){
            button(actions,'対応した報告を訂正する',req._id,'correct',locked,async()=>{
              const token=generation;
              if(await options.confirm('対応した報告を訂正し、「まだ対応していません」と本人へ伝えますか？')&&token===generation)await send(req._id,'先ほどの報告を訂正します。まだ対応していません。時間は改めて相談します。','planned',mine._id);
            });
          }
          // A free reply remains a reply, never silently accepted as a commitment.
          if(!isQuiet){
            const details=node(actions,'details');details.dataset.openKey=req._id;details.open=expanded.has(req._id);node(details,'summary','言葉を書いて返す');
            details.addEventListener('toggle',()=>{if(!details.isConnected)return;if(details.open)expanded.add(req._id);else expanded.delete(req._id);});
            const input=node(details,'input');input.type='text';input.maxLength=60;input.setAttribute('aria-label','「'+req.text+'」への返事');input.dataset.handoffKey=req._id+':draft';input.value=drafts.get(req._id)||'';input.disabled=busy.has(req._id);
            input.addEventListener('input',()=>drafts.set(req._id,input.value));
            button(details,'この返事を送る',req._id,'reply',locked,()=>send(req._id,input.value,'reply'));
          }
        }
        if(role==='family')button(actions,'ホームから消す',req._id,'dismiss',!ready()||busy.has(req._id),()=>dismiss(req._id));
        node(row,'p',messages.get(req._id)||'','request-result').setAttribute('role','status');
      });
      if(role==='family'&&archived.length){
        let parent=list;
        if(rows.length){parent=node(list,'details');parent.dataset.openKey='archived';parent.open=expanded.has('archived');node(parent,'summary','消したお願いを見る（'+archived.length+'件）');}
        node(parent,'p','このスマホのホームから消したお願いです。本人やほかの家族の記録には影響しません。','request-note');
        archived.forEach(req=>{
          const row=node(parent,'article',undefined,'request-item');row.dataset.archivedRequestId=req._id;
          node(row,'p',stamp(req)+' · 「'+(req.text||'お願い')+'」');
          const actions=node(row,'div',undefined,'request-actions');
          button(actions,'ホームに戻す',req._id,'restore',!ready()||busy.has(req._id),()=>dismiss(req._id,true));
          node(row,'p',messages.get(req._id)||'','request-result').setAttribute('role','status');
        });
      }
      if(focusKey){const targets=[...list.querySelectorAll('[data-handoff-key]')];const target=targets.find(n=>n.dataset.handoffKey===focusKey)||targets.find(n=>n.dataset.handoffKey===focusKey.split(':')[0]+':heading');if(target&&!target.disabled){target.focus({preventScroll:true});if(selection)target.setSelectionRange(...selection);}}
    }
    async function send(id,text,stage,expected){
      ensure();text=String(text||'').trim();const original=request(id),own=responses(id,'family').filter(v=>v.uid===context().uid).sort(compare).pop();
      if(!ready()||busy.has(id)||!original)return false;
      if(!text||text.length>60){messages.set(id,'返事を1〜60文字で入力してください。');render('family');return false;}
      if(expected&&responses(id,'family').filter(v=>v.uid===context().uid&&['planned','done','noted','withdrawn'].includes(v.requestStage)).sort(compare).pop()?._id!==expected){messages.set(id,'返事が更新されました。内容を確認してください。');render('family');return false;}
      if(own?.text===text&&own?.requestStage===stage)return false;
      const token=generation,c=context();busy.add(id);messages.set(id,'保存しています…');render('family');
      const current=()=>token===generation&&scope===key(context());
      try{
        const fresh=await options.readRequest(id);
        if(!current()||!ready())return false;
        if(expected&&responses(id,'family').filter(v=>v.uid===context().uid&&['planned','done','noted','withdrawn'].includes(v.requestStage)).sort(compare).pop()?._id!==expected){messages.set(id,'返事が更新されました。内容を確認してください。');return false;}
        if(!fresh||fresh.type!=='onegai'||fresh.uid!==original.uid||fresh.text!==original.text||!request(id)){
          messages.set(id,'元のお願いが確認できません。画面を開き直してください。');return false;
        }
        // Own commitments survive additional free replies. Only an explicit action changes the stage.
        const payload={type:'onegai-back',text,name:options.name(),replyTo:id,requestStage:stage};
        const ref=await options.write(payload);
        if(!current())return false;
        const row={...payload,uid:c.uid,_id:ref?.id||'confirmed-'+Date.now(),at:{seconds:Date.now()/1000}};
        if(!data.family.some(v=>v._id===row._id))saved.set(row._id,row);
        messages.set(id,'返事を保存しました。本人が読んだかは、この表示では分かりません。');
        if(stage==='reply'&&drafts.get(id)?.trim()===text)drafts.delete(id);
        return true;
      }catch(error){if(current())messages.set(id,'保存できませんでした。入力は残っています。通信を確認して、もう一度お試しください。');return false;}
      finally{if(current()){busy.delete(id);render('family');}}
    }
    return {update,refresh,reset,send};
  }
  return {create,plans};
});
