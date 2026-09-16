(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.MainicoPersonTasks=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function create(options){
    var doc=options.document, generation=0, context=null, unsubs=[], rows=[], done=[];
    var fresh={tasks:false,done:false}, saving=false, finishing=new Set();
    function el(id){return doc.getElementById(id);}
    function valid(token){var now=options.getContext();return token===generation&&context&&now&&now.uid===context.uid&&now.gid===context.gid;}
    function ready(){return fresh.tasks&&fresh.done;}
    function state(message){el('person-task-state').textContent=message;}
    function render(){
      var list=el('person-task-list');list.textContent='';
      el('person-task-save').disabled=!ready()||saving;
      var own=rows.filter(function(v){return v.uid===context.uid&&v.taskKind==='self';});
      own.sort(function(a,b){var ad=done.some(function(v){return v.replyTo===a._id;}),bd=done.some(function(v){return v.replyTo===b._id;});return Number(ad)-Number(bd)||(a.due||'9999-12-31').localeCompare(b.due||'9999-12-31');});
      if(!own.length){var empty=doc.createElement('p');empty.textContent=ready()?'やることはまだありません。':'最新のやることを確認しています。';list.appendChild(empty);}
      own.forEach(function(task){
        var row=doc.createElement('div');row.className='family-tool-row';
        var title=doc.createElement('strong');title.textContent=task.text||'やること';row.appendChild(title);
        if(task.due){var date=doc.createElement('div');date.textContent='日付：'+task.due;row.appendChild(date);}
        var complete=done.some(function(v){return v.replyTo===task._id;});
        var label=doc.createElement('p');label.textContent=complete?'できました':'これから';row.appendChild(label);
        if(!complete){var button=doc.createElement('button');button.type='button';button.className='set-btn person-press-target';button.textContent='できた';button.disabled=!ready()||finishing.has(task._id);button.addEventListener('click',function(){finish(task._id);});row.appendChild(button);}
        list.appendChild(row);
      });
    }
    async function save(){
      var token=generation;
      if(!valid(token)||!ready()||saving)return;
      var input=el('person-task-input'),date=el('person-task-date'),text=input.value.trim(),due=date.value;
      if(!text){state('やることを入力してください。');return;}
      if(text.length>80){state('やることは80文字以内で入力してください。');return;}
      if(due&&!/^\d{4}-\d{2}-\d{2}$/.test(due)){state('期限を確認してください。');return;}
      saving=true;render();state('保存しています…');
      try{
        await options.addEvent({type:'family-task',text:text,due:due,taskKind:'self',assignee:'',clientAt:Date.now()});
        if(!valid(token))return;
        if(input.value.trim()===text&&date.value===due){input.value='';date.value='';}
        state('やることを保存しました。');
      }catch(error){if(valid(token))state('保存できませんでした。入力は残っています。');}
      finally{if(valid(token)){saving=false;render();}}
    }
    async function finish(id){
      var token=generation;
      if(!valid(token)||!ready()||finishing.has(id)||done.some(function(v){return v.replyTo===id;}))return;
      if(!rows.some(function(v){return v._id===id&&v.uid===context.uid&&v.taskKind==='self';}))return;
      finishing.add(id);var succeeded=false;render();state('記録しています…');
      try{await options.addEvent({type:'family-task-done',replyTo:id,clientAt:Date.now()});succeeded=true;if(valid(token))state('できたことを記録しました。');}
      catch(error){if(valid(token))state('記録できませんでした。通信を確認して、もう一度押してください。');}
      finally{if(valid(token)){if(!succeeded)finishing.delete(id);render();}}
    }
    function close(){
      generation++;context=null;unsubs.splice(0).forEach(function(unsub){try{unsub();}catch(error){}});
      el('person-tasks-modal').classList.remove('show');
      el('person-task-save').removeEventListener('click',save);el('person-task-close').removeEventListener('click',close);
      rows=[];done=[];fresh={tasks:false,done:false};saving=false;finishing.clear();
      el('person-task-list').textContent='';el('person-task-input').value='';el('person-task-date').value='';state('');
    }
    function open(){
      close();var current=options.getContext();if(!current||!current.uid||!current.gid)return;
      context={uid:current.uid,gid:current.gid};var token=generation;
      el('person-tasks-modal').classList.add('show');
      el('person-task-save').addEventListener('click',save);el('person-task-close').addEventListener('click',close);
      state('最新の記録を確認しています…');render();
      [['family-task','tasks'],['family-task-done','done']].forEach(function(entry){
        try{var unsubscribe=options.subscribe(entry[0],function(data,metadata){
          if(!valid(token))return;
          if(entry[1]==='tasks')rows=data;else done=data;
          fresh[entry[1]]=!!metadata&&metadata.fromCache===false&&metadata.hasPendingWrites!==true;
          state(ready()?'': '保存済みの表示です。最新の確認が終わるまで操作できません。');render();
        },function(){if(!valid(token))return;fresh[entry[1]]=false;state('最新の記録を確認できません。通信を確認して開き直してください。');render();});
        if(typeof unsubscribe==='function')unsubs.push(unsubscribe);
        }catch(error){if(valid(token)){fresh[entry[1]]=false;state('記録を読み込めませんでした。開き直してください。');render();}}
      });
    }
    return {open:open,close:close};
  }
  return {create:create};
});
