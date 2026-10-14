(function () {
  'use strict';
  const categories = {food:'ごはん・買い物',travel:'通院・おでかけ',home:'家のことを頼む',watch:'見守り・備え',care:'介護・家族の相談',community:'地域とつながる'};
  const data = Array.isArray(window.UEDA_SERVICES) ? window.UEDA_SERVICES : [];
  const section = document.getElementById('results-section');
  const heading = document.getElementById('results-title');
  const results = document.getElementById('results');
  const input = document.getElementById('query');
  function el(tag, cls, text) { const node = document.createElement(tag); if(cls) node.className=cls; if(text) node.textContent=text; return node; }
  function link(label, href, cls) { const a=el('a',cls,label); a.href=href; if(href.startsWith('https://')){a.target='_blank';a.rel='noopener noreferrer';} return a; }
  function render(category, query, focus) {
    const terms=query.normalize('NFKC').toLocaleLowerCase('ja').trim().split(/\s+/).filter(Boolean);
    const matches=data.filter(item=>{
      if(category && item.category!==category)return false;
      const text=[item.name,item.description,item.conditions,item.kind,categories[item.category]].join(' ').normalize('NFKC').toLocaleLowerCase('ja');
      return terms.every(term=>text.includes(term));
    });
    section.hidden=false;
    heading.textContent=query ? '「'+query+'」の検索結果' : categories[category] || 'すべてのサービス';
    results.replaceChildren();
    document.getElementById('result-count').textContent=matches.length+'件の案内';
    if(!matches.length)results.appendChild(el('p','notice','見つかりませんでした。「弁当」「掃除」「介護」など、短い言葉でもう一度探してください。下の相談先からも相談できます。'));
    matches.forEach(item=>{
      const card=el('article','service');
      card.append(el('span','kind',item.kind),el('h3','',item.name),el('p','',item.description));
      const details=el('details');details.append(el('summary','','対象・料金など'),el('p','',item.conditions),el('p','verified','公開情報の確認：'+item.checkedAt));card.appendChild(details);
      const actions=el('div','actions');
      if(item.phone){const a=link('電話する','tel:'+item.phone.replace(/-/g,''),'action');a.setAttribute('aria-label',item.name+'に電話する '+item.phone);actions.append(a);}
      const official=link('公式案内を見る ↗',item.url,'action secondary');official.setAttribute('aria-label',item.name+'の公式案内を見る（別画面）');actions.append(official);card.append(actions);results.append(card);
    });
    document.querySelectorAll('[data-category]').forEach(a=>{if(a.dataset.category===category)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current');});
    if(focus){heading.focus({preventScroll:true});section.scrollIntoView({block:'start',behavior:'auto'});}
  }
  function route(focus){
    const key=location.hash.slice(1);
    if(Object.prototype.hasOwnProperty.call(categories,key)){input.value='';render(key,'',focus);}
    else if(key==='search'){render('',input.value.trim(),focus);}
    else {section.hidden=true;document.querySelectorAll('[data-category]').forEach(a=>a.removeAttribute('aria-current'));}
  }
  document.getElementById('search-form').addEventListener('submit',function(e){e.preventDefault();if(location.hash==='#search')render('',input.value.trim(),true);else location.hash='search';});
  document.querySelectorAll('[data-category]').forEach(a=>a.addEventListener('click',function(){if(location.hash===a.getAttribute('href'))render(a.dataset.category,'',true);}));
  document.getElementById('all-categories').addEventListener('click',function(){input.value='';document.querySelector('[data-category]').focus();});
  window.addEventListener('hashchange',()=>route(true));
  route(false);
})();
