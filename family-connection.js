/* Membership is not delivery: this module only classifies a verified member list. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MainicoFamilyConnection=api;
})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  function unknown(){return {status:'unknown',others:null,familyOthers:null,personOthers:null};}
  function classify(snapshot,ownUid){
    // Cached or locally pending membership must not claim that nobody else is connected.
    if(typeof ownUid!=='string'||!ownUid.trim()||!snapshot||
       typeof snapshot.forEach!=='function'||!snapshot.metadata||
       snapshot.metadata.fromCache!==false||snapshot.metadata.hasPendingWrites===true)return unknown();
    let ownApproved=false,invalid=false;
    const approved=new Map();
    try{
      snapshot.forEach(doc=>{
        if(!doc||typeof doc.id!=='string'||!doc.id||typeof doc.data!=='function'){
          invalid=true;return;
        }
        if(doc.metadata&&doc.metadata.hasPendingWrites===true){invalid=true;return;}
        const member=doc.data();
        if(!member||typeof member!=='object'){invalid=true;return;}
        if(member.status!=='approved')return;
        if(doc.id===ownUid){ownApproved=true;return;}
        approved.set(doc.id,member.role);
      });
    }catch(_){return unknown();}
    if(invalid||!ownApproved)return unknown();
    let familyOthers=0,personOthers=0;
    approved.forEach(role=>{
      if(role==='kazoku')familyOthers++;
      else if(role==='honnin')personOthers++;
    });
    return {status:approved.size?'shared':'solo',others:approved.size,familyOthers,personOthers};
  }
  return {classify};
});
