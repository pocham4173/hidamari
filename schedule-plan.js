/* 予定の分かりやすさと入力の簡単さ(2026-10-13 ヒビルカから)
   - nextUp: ご本人の「次の予定」。日本時間で今日・明日を決める。時間が過ぎた今日の予定は「次」にしない(終わったとは扱わない)。
   - repeatDates: 毎週・毎月の日付を作る。1回ずつ別の予定として保存するので、「この日だけ変更・中止」はその1件だけを直せばよい。
   - seriesOf: まとめて登録した予定の番号(文書の名前 s<10文字>_<日付>)。 */
(function(root){
  'use strict';
  const MAX=60;
  const DAY=/^(\d{4})-(\d{2})-(\d{2})$/;
  const WD=['日','月','火','水','木','金','土'];
  function two(n){return String(n).padStart(2,'0');}
  function parse(ds){const m=DAY.exec(ds||'');return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3])):null;}
  function fmt(d){return d.getUTCFullYear()+'-'+two(d.getUTCMonth()+1)+'-'+two(d.getUTCDate());}
  function addDays(ds,n){const d=parse(ds);d.setUTCDate(d.getUTCDate()+n);return fmt(d);}
  function lastDay(y,m){return new Date(Date.UTC(y,m+1,0)).getUTCDate();}
  /* 日本時間の今日と今の時刻 */
  function tokyoNow(now){
    const p={};
    for(const x of new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now||new Date()))p[x.type]=x.value;
    return {date:p.year+'-'+p.month+'-'+p.day,time:p.hour+':'+p.minute};
  }
  function dayLabel(ds,today){
    if(ds===today)return '今日';
    if(ds===addDays(today,1))return '明日';
    const d=parse(ds);
    return (d.getUTCMonth()+1)+'月'+d.getUTCDate()+'日（'+WD[d.getUTCDay()]+'）';
  }
  function daysUntil(ds,today){return Math.round((parse(ds)-parse(today))/86400000);}
  /* 次の予定。nextDate(v,from) は予定ごとの次の日(以前の繰り返し予定にも対応)。
     返すもの: {item,date,others:[同じ日のほかの予定]} か null */
  function nextUp(list,nextDate,now){
    const t=tokyoNow(now),rows=[];
    for(const v of list||[]){
      let d=nextDate(v,t.date);
      /* 今日の、時間が過ぎた予定は「次」にしない。繰り返しなら次の回を見る */
      if(d===t.date&&v.time&&v.time<t.time)d=nextDate(v,addDays(t.date,1));
      if(d)rows.push({item:v,date:d});
    }
    /* 日付順。同じ日は時間順で、時間のない予定はその日の最後 */
    const key=r=>r.date+' '+(r.item.time||'99:99');
    rows.sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
    if(!rows.length)return null;
    const first=rows[0];
    return {item:first.item,date:first.date,today:t.date,when:dayLabel(first.date,t.date),days:daysUntil(first.date,t.date),
      others:rows.slice(1).filter(r=>r.date===first.date).map(r=>r.item)};
  }
  /* くり返しの日付。kind: weekly|monthly。end: {count} か {until}。short(毎月で、その月にない日): last=月末に入れる / skip=その月は入れない */
  function repeatDates(start,kind,end,short){
    const s=parse(start);
    if(!s)return {ok:false,message:'日付を選んでください'};
    if(kind!=='weekly'&&kind!=='monthly')return {ok:true,dates:[start]};
    const count=end&&end.count!=null?Number(end.count):null;
    const until=end&&end.until||'';
    if(count!=null&&!(Number.isInteger(count)&&count>=2&&count<=MAX))return {ok:false,message:'回数は2〜'+MAX+'回で入れてください'};
    if(count==null){
      if(!parse(until))return {ok:false,message:'終わる日を選んでください'};
      if(until<start)return {ok:false,message:'終わる日は、始まる日より後にしてください'};
    }
    const dates=[],want=s.getUTCDate();
    for(let i=0;i<MAX*3&&dates.length<(count||MAX+1);i++){
      let ds;
      if(kind==='weekly')ds=addDays(start,7*i);
      else{
        const y=s.getUTCFullYear(),m=s.getUTCMonth()+i,yy=y+Math.floor(m/12),mm=m%12,last=lastDay(yy,mm);
        if(want>last&&short==='skip')continue;
        ds=yy+'-'+two(mm+1)+'-'+two(Math.min(want,last));
      }
      if(count==null&&ds>until)break;
      dates.push(ds);
    }
    if(dates.length>MAX)return {ok:false,message:'一度に入れられるのは'+MAX+'回までです。終わる日を早めてください'};
    if(dates.length<2)return {ok:false,message:'くり返しは2回以上になるように、終わる日を選んでください'};
    return {ok:true,dates};
  }
  /* 毎月で、ある月にない日(29〜31日)を使うか */
  function needsShortRule(start,kind){const s=parse(start);return kind==='monthly'&&!!s&&s.getUTCDate()>28;}
  function newSeries(){
    const a='abcdefghijkmnpqrstuvwxyz23456789',b=new Uint8Array(10);
    (root.crypto||{getRandomValues:x=>{for(let i=0;i<x.length;i++)x[i]=Math.floor(Math.random()*256);return x;}}).getRandomValues(b);
    return 's'+Array.from(b,x=>a[x%a.length]).join('');
  }
  function docId(series,ds){return series+'_'+ds.replace(/-/g,'');}
  function seriesOf(id){const m=/^(s[a-z0-9]{10})_\d{8}$/.exec(id||'');return m?m[1]:'';}
  function shortDate(ds){const d=parse(ds);return (d.getUTCMonth()+1)+'/'+d.getUTCDate()+'（'+WD[d.getUTCDay()]+'）';}
  const api={MAX,tokyoNow,dayLabel,daysUntil,nextUp,repeatDates,needsShortRule,newSeries,docId,seriesOf,shortDate,addDays};
  root.MainicoSchedule=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
