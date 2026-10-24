/* 今日の上田：家庭の記録に触れない、公開情報だけの小さな欄。 */
(function(global){
  'use strict';
  const FORECAST='https://www.jma.go.jp/bosai/forecast/data/forecast/200000.json';
  const SOURCE='https://www.jma.go.jp/bosai/forecast/#area_type=class10s&area_code=200020';
  const HOUR=3600000, MAX_AGE=18*HOUR, REFRESH=30*60000;
  // JMA area.json: 上田市 2020300 → 上田地域 200021 → 中部 200020。
  // 気温の代表地点（松本等）を上田市の気温として表示しない。
  const day=ms=>new Date(ms+9*HOUR).toISOString().slice(0,10);
  const dateLabel=value=>{const d=new Date(value);return (d.getUTCMonth()+1)+'月'+d.getUTCDate()+'日';};
  const stamp=ms=>{const d=new Date(ms+9*HOUR);return dateLabel(d)+' '+d.getUTCHours()+':'+String(d.getUTCMinutes()).padStart(2,'0');};
  function timestamp(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
    return Date.parse(value);
  }
  function forecast(data,now){
    const report=Array.isArray(data)&&data[0],issued=timestamp(report&&report.reportDatetime);
    if(!Number.isFinite(issued)||issued>now+5*60000||now-issued>MAX_AGE)return null;
    const series=Array.isArray(report.timeSeries)&&report.timeSeries.find(s=>s&&Array.isArray(s.areas)&&s.areas.some(a=>a?.area?.code==='200020'&&Array.isArray(a.weathers)));
    if(!series||!Array.isArray(series.timeDefines))return null;
    const area=series.areas.find(a=>a?.area?.code==='200020'&&Array.isArray(a.weathers)),days=[];
    for(const [i,value] of series.timeDefines.entries()){
      const when=timestamp(value),text=area.weathers[i];
      if(!Number.isFinite(when)||typeof text!=='string'||!text.trim()||text.length>160)continue;
      days.push({date:day(when),text:text.replace(/[\s　]+/g,' ').trim()});
    }
    const today=days.find(d=>d.date===day(now)),tomorrow=days.find(d=>d.date===day(now+24*HOUR));
    return today?{issued,today,tomorrow}:null;
  }
  function topics(items,now){
    const seen=new Set();
    return (Array.isArray(items)?items:[]).filter(item=>{
      if(!item||typeof item.title!=='string'||!item.title.trim()||item.title.length>80||typeof item.when!=='string'||item.when.length>80)return false;
      let url;try{url=new URL(item.url);}catch(e){return false;}
      if(url.protocol!=='https:'||url.hostname!=='www.city.ueda.nagano.jp'||url.username||url.password||url.port||seen.has(url.href))return false;
      const checked=timestamp(item.checkedAt),end=timestamp(item.endsAt);
      // 開催終了、または公式案内を確かめて7日を過ぎたら、自動的に表から下げる。
      if(!Number.isFinite(checked)||!Number.isFinite(end)||checked>now||now>=end||now>=checked+7*24*HOUR)return false;
      seen.add(url.href);return true;
    }).slice(0,2);
  }
  function mount(doc,options={}){
    const win=doc.defaultView,now=options.now||Date.now,fetcher=options.fetch||win.fetch?.bind(win);
    const hosts=[...doc.querySelectorAll('[data-ueda-today]')];
    if(!hosts.length)return {destroy(){}};
    let raw=null,attempt=-Infinity,pending=false,controller=null,disposed=false,voice=null,voiceHost=null;
    const visible=host=>!doc.hidden&&host.isConnected&&!host.closest('[hidden]')&&!!host.closest('.page.active')&&(!host.closest('.ftab')||win.getComputedStyle(host.closest('.ftab')).display!=='none')&&(!host.closest('#home-main')||win.getComputedStyle(host.closest('#home-main')).display!=='none');
    const views=hosts.map(host=>{
      host.classList.add('ueda-today');
      host.innerHTML='<details><summary><strong>今日の上田</strong><span class="ut-weather">天気を確認しています</span><small class="ut-time"></small><span class="ut-open">天気・まちの話題を見る</span></summary><div class="ut-body"><p class="ut-area">上田市を含む、長野県中部の予報です。</p><p class="ut-tomorrow"></p><div class="ut-actions"><button type="button" class="ut-read">天気を聞く</button><button type="button" class="ut-stop" hidden>読み上げを止める</button><button type="button" class="ut-retry">もう一度確認する</button></div><p class="ut-status" role="status"></p><a class="ut-source" target="_blank" rel="noopener noreferrer" href="'+SOURCE+'">出典：気象庁の天気予報 ↗</a><p class="ut-note">予報の文を抜き出して表示しています。</p><section class="ut-topics"><h3>まちの話題</h3><div class="ut-items"></div><p class="ut-topic-note"></p><a class="ut-more" href="https://www.city.ueda.nagano.jp/calendar/" target="_blank" rel="noopener noreferrer">上田市の催しカレンダーを見る ↗</a></section><a class="ut-support" href="ueda-support.html">ごみ出しなど、上田の暮らしサポートへ →</a></div></details>';
      const get=s=>host.querySelector(s),view={host,get,newsKey:''};
      get('.ut-retry').addEventListener('click',()=>load(true));
      get('.ut-read').addEventListener('click',()=>read(view));
      get('.ut-stop').addEventListener('click',stop);
      get('details').addEventListener('toggle',()=>{if(!get('details').open&&voiceHost===host)stop();});
      return view;
    });
    function stop(){
      const wasSpeaking=!!voice;voice=null;
      if(wasSpeaking)win.speechSynthesis?.cancel();
      voiceHost=null;
      views.forEach(v=>{v.get('.ut-stop').hidden=true;v.get('.ut-status').textContent='';});
    }
    function read(view){
      stop();
      if(!visible(view.host))return;
      const value=forecast(raw,now());
      if(!value){render();view.get('.ut-status').textContent='今の予報を確認できません。気象庁の案内をご覧ください。';return;}
      if(!win.speechSynthesis||!win.SpeechSynthesisUtterance){view.get('.ut-status').textContent='このブラウザーでは声を再生できません。天気は文字で確認できます。';return;}
      const text='上田市を含む長野県中部の予報。'+stamp(value.issued)+'発表。今日、'+value.today.text+'。'+(value.tomorrow?'明日、'+value.tomorrow.text+'。':'');
      const utterance=new win.SpeechSynthesisUtterance(text);utterance.lang='ja-JP';utterance.rate=0.9;
      const finish=()=>{if(voice===utterance)stop();};
      utterance.onend=finish;utterance.onerror=()=>{if(voice!==utterance)return;stop();view.get('.ut-status').textContent='声を再生できませんでした。音量を確認してください。';};
      voice=utterance;voiceHost=view.host;view.get('.ut-stop').hidden=false;
      try{win.speechSynthesis.cancel();win.speechSynthesis.speak(utterance);}catch(e){utterance.onerror();}
    }
    function render(){
      if(disposed)return;
      const time=now(),value=forecast(raw,time),news=topics(options.topics||global.MAINICO_UEDA_TOPICS,time);
      views.forEach(v=>{
        v.get('.ut-weather').textContent=value?'今日：'+value.today.text:pending?'天気を確認しています':'今の天気予報を確認できません';
        v.get('.ut-time').textContent=value?'長野県中部・'+stamp(value.issued)+'発表':'長野県中部の予報';
        v.get('.ut-tomorrow').textContent=value?.tomorrow?'明日：'+value.tomorrow.text:'明日の予報は、気象庁の案内で確認できます。';
        v.get('.ut-read').disabled=!value;v.get('.ut-retry').disabled=pending;
        const key=JSON.stringify(news);
        if(v.newsKey!==key){
          v.newsKey=key;const box=v.get('.ut-items');box.replaceChildren();
          news.forEach(n=>{
            const article=doc.createElement('article'),a=doc.createElement('a'),date=doc.createElement('p'),checked=doc.createElement('small');
            a.textContent=n.title+' ↗';a.href=n.url;a.target='_blank';a.rel='noopener noreferrer';
            date.textContent=n.when;checked.textContent=stamp(timestamp(n.checkedAt)).split(' ')[0]+' 案内を確認';
            article.append(a,date,checked);box.append(article);
          });
          v.get('.ut-topic-note').textContent=news.length?'まいにこで選んだ案内です。開催の変更や申込みは、上田市の案内で確認できます。':'今掲載できる話題はありません。新しい催しは、市のカレンダーで見られます。';
        }
      });
    }
    async function load(force=false){
      if(disposed||pending||!views.some(v=>visible(v.host)))return;
      if(!force&&now()-attempt<(raw?REFRESH:5*60000))return;
      pending=true;attempt=now();controller=new win.AbortController();render();
      const timer=win.setTimeout(()=>controller?.abort(),8000);
      try{
        if(!fetcher)throw new Error('fetch unavailable');
        const response=await fetcher(FORECAST,{signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
        if(!response.ok)throw new Error('weather unavailable');
        const data=await response.json();
        raw=forecast(data,now())?data:null;
      }catch(e){raw=null;}
      finally{win.clearTimeout(timer);controller=null;pending=false;render();}
    }
    function refresh(){
      if(disposed)return;
      if(voiceHost&&(!visible(voiceHost)||!forecast(raw,now())))stop();
      render();void load();
    }
    const observer=new win.MutationObserver(refresh);
    for(const el of doc.querySelectorAll('#honnin,#kazoku,#t-home,#home-main'))observer.observe(el,{attributes:true,attributeFilter:['class','style','hidden']});
    doc.addEventListener('visibilitychange',refresh);win.addEventListener('pageshow',refresh);win.addEventListener('online',refresh);win.addEventListener('pagehide',stop);
    const timer=win.setInterval(refresh,60000);refresh();
    return {refresh,destroy(){disposed=true;stop();controller?.abort();observer.disconnect();win.clearInterval(timer);doc.removeEventListener('visibilitychange',refresh);win.removeEventListener('pageshow',refresh);win.removeEventListener('online',refresh);win.removeEventListener('pagehide',stop);}};
  }
  global.MainicoUedaToday={forecast,topics,mount};
  if(global.document){const boot=()=>mount(global.document);if(global.document.readyState==='loading')global.document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();}
})(typeof window!=='undefined'?window:globalThis);
