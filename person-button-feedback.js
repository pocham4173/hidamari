/* Let the press remain visible before the person's main action runs. */
(function(){
  'use strict';
  const replaying=new WeakSet();
  let held=null,pressed=null,pending=null;
  const selector='#btn-a,.kibun-btn,.kusuri-btn,.onegai-btn,.onegai-item,.cal-open,#onegai-free-btn,.person-press-target,.ht-yomi';
  function context(){return [typeof window.uid==='function'?window.uid():'',typeof window.gid==='function'?window.gid():''].join(':');}
  function buttonFor(event){
    const button=event.target.closest&&event.target.closest(selector);
    if(!button||button.disabled||button.hidden||button.closest('[hidden]'))return null;
    if(typeof button.getClientRects==='function'&&!button.getClientRects().length)return null;
    const person=document.getElementById('honnin');
    return person&&person.classList.contains('active')?button:null;
  }
  function release(){if(held)held.classList.remove('person-press-held');held=null;}
  function capture(button){
    return {button:button,context:context(),replyTo:button.dataset&&typeof button.dataset.replyTo==='string'?button.dataset.replyTo:null,timer:null};
  }
  function replyChanged(item){
    return item.replyTo!==null&&item.replyTo!==item.button.dataset.replyTo;
  }
  function explainChangedReply(){
    const state=document.getElementById('h-message-reply-state');
    if(state)state.textContent='新しい連絡が届きました。内容を確認してから押してください';
    if(typeof window.speak==='function')window.speak('新しい連絡が届きました。内容を確認してから押してください');
  }
  function cancel(){
    release();pressed=null;if(!pending)return;
    clearTimeout(pending.timer);pending.button.classList.remove('person-press-latched');pending=null;
  }
  document.addEventListener('pointerdown',function(event){
    release();pressed=null;if(event.isPrimary===false||event.button>0||pending)return;
    held=buttonFor(event);if(held){pressed=capture(held);held.classList.add('person-press-held');}
  },true);
  document.addEventListener('pointerup',release,true);
  document.addEventListener('pointercancel',cancel,true);
  window.addEventListener('blur',cancel);
  document.addEventListener('visibilitychange',function(){if(document.hidden)cancel();});
  document.addEventListener('keydown',function(event){
    if(event.key!=='Enter'&&event.key!==' ')return;
    const target=buttonFor(event);
    if(!target||target!==event.target||target.getAttribute('role')!=='button')return;
    event.preventDefault();if(!event.repeat)target.click();
  },true);
  document.addEventListener('click',function(event){
    const button=buttonFor(event);if(!button||replaying.has(button))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(pending)return;
    // Pointer presses belong to the message shown when the finger went down.
    // Keyboard/programmatic clicks (detail 0) start their own captured action.
    const item=pressed&&pressed.button===button&&event.detail!==0?pressed:capture(button);
    pressed=null;
    if(context()!==item.context)return;
    if(replyChanged(item)){explainChangedReply();return;}
    // Start the voice inside the user's click, before the visual press delay.
    // This cue never performs a write or claims that a write has completed.
    try{if(typeof window.announcePersonPress==='function')window.announcePersonPress(button);}catch(e){}
    button.classList.add('person-press-latched');
    pending=item;
    item.timer=setTimeout(function(){
      if(pending!==item)return;
      pending=null;button.classList.remove('person-press-latched');
      if(!button.isConnected||document.hidden||context()!==item.context||!buttonFor(event))return;
      if(replyChanged(item)){explainChangedReply();return;}
      replaying.add(button);
      try{button.click();}finally{replaying.delete(button);}
    },650);
  },true);
})();
