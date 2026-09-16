/* Acknowledges a button press, never claims a successful write. */
(function(){
  'use strict';
  const timers=new WeakMap();
  let held=null,badgeTimer=null;
  function buttonFor(event){
    const button=event.target.closest&&event.target.closest('button');
    if(!button||button.disabled)return null;
    const person=document.getElementById('honnin');
    return person&&person.classList.contains('active')?button:null;
  }
  function release(){if(held)held.classList.remove('person-press-held');held=null;}
  document.addEventListener('pointerdown',function(event){
    release();if(event.isPrimary===false||event.button>0)return;
    held=buttonFor(event);if(held)held.classList.add('person-press-held');
  },true);
  document.addEventListener('pointerup',release,true);
  document.addEventListener('pointercancel',release,true);
  window.addEventListener('blur',release);
  document.addEventListener('click',function(event){
    const button=buttonFor(event);if(!button)return;
    clearTimeout(timers.get(button));button.classList.add('person-press-latched');
    timers.set(button,setTimeout(function(){button.classList.remove('person-press-latched');timers.delete(button);},700));
    const badge=document.getElementById('person-tap-feedback');
    if(badge){
      clearTimeout(badgeTimer);badge.textContent='押しました';badge.hidden=false;
      badgeTimer=setTimeout(function(){badge.hidden=true;},1400);
    }
  },true);
})();
