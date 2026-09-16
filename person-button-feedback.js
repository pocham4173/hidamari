/* Let the press remain visible before the person's main action runs. */
(function(){
  'use strict';
  const replaying=new WeakSet();
  let held=null,pending=null;
  const selector='#btn-a,.kibun-btn,.kusuri-btn,.onegai-btn,.onegai-item,.cal-open,#onegai-free-btn';
  function context(){return [typeof window.uid==='function'?window.uid():'',typeof window.gid==='function'?window.gid():''].join(':');}
  function buttonFor(event){
    const button=event.target.closest&&event.target.closest(selector);
    if(!button||button.disabled)return null;
    const person=document.getElementById('honnin');
    return person&&person.classList.contains('active')?button:null;
  }
  function release(){if(held)held.classList.remove('person-press-held');held=null;}
  function cancel(){
    release();if(!pending)return;
    clearTimeout(pending.timer);pending.button.classList.remove('person-press-latched');pending=null;
  }
  document.addEventListener('pointerdown',function(event){
    release();if(event.isPrimary===false||event.button>0||pending)return;
    held=buttonFor(event);if(held)held.classList.add('person-press-held');
  },true);
  document.addEventListener('pointerup',release,true);
  document.addEventListener('pointercancel',release,true);
  window.addEventListener('blur',cancel);
  document.addEventListener('visibilitychange',function(){if(document.hidden)cancel();});
  document.addEventListener('click',function(event){
    const button=buttonFor(event);if(!button||replaying.has(button))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(pending)return;
    button.classList.add('person-press-latched');
    const item={button:button,context:context(),timer:null};pending=item;
    item.timer=setTimeout(function(){
      if(pending!==item)return;
      pending=null;button.classList.remove('person-press-latched');
      if(!button.isConnected||document.hidden||context()!==item.context||!buttonFor(event))return;
      replaying.add(button);
      try{button.click();}finally{replaying.delete(button);}
    },650);
  },true);
})();
