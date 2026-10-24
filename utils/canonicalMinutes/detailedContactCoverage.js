'use strict';
// Exact instruction proof, not a contact-purpose similarity matcher.
const { isReviewerAuthored } = require('./state');
const fields = new Set(['id','action','owners','timing','evidenceIds','reviewFlagIds','occurrenceId','timingDecision','mergedFromIds','disposition']);
const normal = v => String(v || '').normalize('NFKC').replace(/[’]/g,"'").replace(/\s+/g,' ').trim().toLowerCase();
const key = values => [...new Set(values.map(normal))].sort().join('|');
const ids = (v,max) => Array.isArray(v) && v.length <= max && v.every(s=>typeof s==='string' && s.trim()===s && s && s.length<=220);
function frame(value) {
  const text=String(value||'').normalize('NFKC').replace(/[’]/g,"'").replace(/\s+/g,' ').trim().replace(/[.!]+$/,'');
  if(text.length>1600 || /[;:"“”()[\]{}?&]/.test(text)
    || /\b(?:if|unless|after|before|once|when|until|pending|without|not|never|again|another|next)\b/i.test(text))return null;
  const lead=text.match(/^(?:Discuss with|(?:Speak|Talk) (?:to|with))\s+/i);
  if(!lead)return null;
  const rest=text.slice(lead[0].length);
  const name=rest.match(/^([\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*){0,11})\s+(?=(?:about|regarding|concerning|the|a|an)\b)/u);
  if(!name || /\b(?:and|or|to|with|about|regarding|concerning)\b/i.test(name[1]))return null;
  let body=rest.slice(name[0].length);
  const connector=body.match(/^(?:about|regarding|concerning)\s+/i);
  if(!/^Discuss /i.test(text) && !connector)return null;
  if(connector)body=body.slice(connector[0].length);
  if(body.length<12 || /^(?:and|or)\b/i.test(body))return null;
  return {recipient:normal(name[1]),body:normal(body)};
}
function eligible(r) {
  return r && Object.keys(r).every(k=>fields.has(k)) && !isReviewerAuthored(r) && !/^(?:manual-|reviewer-)/.test(r.id||'')
    && ids([r.id],1) && ids(r.owners,8) && r.owners.length && ids(r.evidenceIds,12) && r.evidenceIds.length
    && (r.reviewFlagIds===undefined || ids(r.reviewFlagIds,0)) && (r.mergedFromIds===undefined || ids(r.mergedFromIds,1000))
    && r.timing?.kind==='not_stated' && !r.timing.wording && !r.timing.exactDate
    && Object.keys(r.timing).every(k=>['kind','wording','exactDate'].includes(k))
    && !['unresolved','rejected','needs_rebind'].includes(r.timingDecision?.status)
    && (r.disposition===undefined || ['committed','accepted_request','conditional_commitment'].includes(r.disposition));
}
function timingHistory(r){
 if(!r.timingDecision)return null;
 const {actionKey,...rest}=r.timingDecision;
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 return JSON.stringify(stable(rest));
}
function reconcileDetailedContacts(a,b) {
  if(!eligible(a)||!eligible(b)||key(a.owners)!==key(b.owners)||key(a.evidenceIds)!==key(b.evidenceIds)
    || (a.occurrenceId||'')!==(b.occurrenceId||'') || a.disposition!==b.disposition || timingHistory(a)!==timingHistory(b))return null;
  const x=frame(a.action),y=frame(b.action);
  if(!x||!y||x.recipient!==y.recipient||x.body!==y.body)return null;
  const [winner,loser]=[a,b].sort((l,r)=>normal(l.action).localeCompare(normal(r.action)) || String(l.id).localeCompare(String(r.id)) || JSON.stringify(l).localeCompare(JSON.stringify(r)));
  const history=[...new Set([...(winner.mergedFromIds||[]),loser.id,...(loser.mergedFromIds||[])])].filter(id=>id!==winner.id);
  if(history.length>1000)return null;
  return {record:{...winner,...(history.length?{mergedFromIds:history}:{})},absorbedIds:[loser.id],reason:'identical complete detailed-contact instruction'};
}
module.exports={frame,reconcileDetailedContacts};
