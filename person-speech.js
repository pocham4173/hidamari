/* Speech is a second indication of a result; it must never decide whether a write succeeded. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MainicoPersonSpeech=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function create(options){
    let active=null,waiting=null,generation=0,startTimer=null;
    const later=options.setTimeout||setTimeout,cancelLater=options.clearTimeout||clearTimeout;
    function clearStartTimer(){if(startTimer!==null)cancelLater(startTimer);startTimer=null;}
    function allowed(force){return options.allowed()&&(force||options.enabled());}
    function stop(){
      generation++;active=null;waiting=null;clearStartTimer();
      try{options.engine?.cancel();}catch(e){}
    }
    function say(text,force=false,background=false){
      text=String(text||'').trim();
      if(!text||!allowed(force))return false;
      const scope=options.scope();
      if(active&&active.scope!==scope)stop();
      if(active&&background){waiting={text,scope};return true;}
      // The 650ms visual replay repeats the same cue; leave the original voice running.
      if(active&&active.text===text)return true;
      const retained=waiting&&waiting.scope===scope?waiting:null;
      stop();
      waiting=retained;
      const current=++generation;
      const unavailable=()=>{try{options.unavailable?.();}catch(e){}};
      try{
        if(!options.engine||!options.Utterance){unavailable();return false;}
        const utterance=new options.Utterance(text);
        utterance.lang='ja-JP';utterance.rate=0.95;utterance.pitch=0.92;
        const voice=options.voice?.();if(voice)utterance.voice=voice;
        active={text,scope,utterance}; // Retain until end/error, including asynchronous platform speech.
        const finish=error=>{
          if(current!==generation)return;
          clearStartTimer();
          active=null;
          if(error&&!['canceled','interrupted'].includes(error))unavailable();
          const next=waiting;waiting=null;
          if(next&&next.scope===options.scope()&&allowed(false))say(next.text,false,true);
        };
        utterance.onend=()=>finish();
        utterance.onerror=event=>finish(event.error||'unavailable');
        utterance.onstart=()=>{if(current===generation){clearStartTimer();try{options.available?.();}catch(e){}}};
        // Some browsers reject first speech silently. A later deliberate tap must be able to retry.
        startTimer=later(()=>{if(current===generation){stop();unavailable();}},3000);
        options.engine.speak(utterance);
        return true;
      }catch(e){stop();unavailable();return false;}
    }
    return {say,stop};
  }
  return {create};
});
