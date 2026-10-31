'use strict';
// Actual preparation and nomination authority shared by receipt and review consumers.
const {hash}=require('../meetingMinutesProofHash');
const {isReviewerAuthored}=require('./state');
const qualifiedRepeat=require('./qualifiedRepeatShape');
const exactRepeat=require('./exactInstructionRepeat');

const FIELDS=new Set(['id','occurrenceId','action','owners','timing','timingDecision','evidenceIds','reviewFlagIds']);
const calendar=/\b(?:today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|daily|weekly|monthly|quarterly|annually|yearly|morning|afternoon|evening|noon|midnight|next\s+(?:day|week|month|year))\b|\d{1,2}:\d{2}/i;
const guarded=/\b(?:if|unless|after|before|once|when|until|pending|following|without|never|not|only|either|maybe|perhaps|probably|possibly|tentatively|deadline|due|by|no later)\b/i;
const canonical=value=>String(value||'').normalize('NFKC').replace(/[’]/g,"'").toLowerCase().replace(/\s+/g,' ').trim();
const tokens=value=>(canonical(value).match(/[\p{L}\p{N}]+/gu)||[]).filter(word=>!new Set(['a','an','the','of','in','within','for','to','and','with']).has(word)).map(word=>word.length>3&&!word.endsWith('ss')?word.replace(/s$/,''):word);
function eligible(row){
 const t=row?.timing,decision=row?.timingDecision;
 return row&&Object.keys(row).every(key=>FIELDS.has(key))&&!isReviewerAuthored(row)&&row.owners?.length===1&&String(row.owners[0]).trim()
  &&t?.kind==='not_stated'&&!t.wording&&!t.exactDate&&!row.reviewFlagIds?.length
  &&Array.isArray(row.evidenceIds)&&row.evidenceIds.length>0&&row.evidenceIds.length<=8&&new Set(row.evidenceIds).size===row.evidenceIds.length
  &&(!decision||decision.reason==='no_timing_value'&&decision.binding?.status==='not_stated'&&!['rejected','unresolved','needs_rebind'].includes(decision.status)
   &&!decision.rejectedExactDates?.length&&!decision.rejectedWordings?.length)
  &&!/[.!?]/.test(String(row.action).replace(/[.!?]+$/, ''))
  &&!/[;?\n]|\b(?:and|then)\s+(?:send|share|provide|review|check|approve|buy|purchase|fit|install|call|email|submit|publish)\b/i.test(row.action);
}
function legacyShape(parent,child){
 if(!eligible(parent)||!eligible(child)||canonical(parent.owners[0])!==canonical(child.owners[0]))return null;
 const a=String(parent.action||'').match(/^\s*(?:draft|write|prepare|compile|create)\s+(.+?)\s+(?:including|with|communicating|describing|explaining|containing|showing|flagging|outlining|setting out)\s+(.+?)[.!]?\s*$/i);
 const b=String(child.action||'').match(/^\s*(?:include|describe|explain|list|state|flag|communicate|outline)\s+(.+)\s+(?:in|within)\s+(.+?)[.!]?\s*$/i);
 if(!a||!b||/\b(?:19|20)\d{2}\b|\d{1,2}[/-]\d{1,2}/.test(parent.action+' '+child.action)||guarded.test(parent.action)||guarded.test(child.action)||calendar.test(a[1])||calendar.test(child.action))return null;
 const container=tokens(a[1]),other=tokens(b[2]),required=tokens(b[1]),content=tokens(a[2]);
 if(container.length<2||hash(container)!==hash(other)||required.length<2||!required.every(word=>content.includes(word)))return null;
 if(calendar.test(parent.action)&&!(/\b(?:effective|starting|beginning|takes? effect|applicable from)\b/i.test(a[2])))return null;
 if(!parent.evidenceIds.some(id=>child.evidenceIds.includes(id))||new Set([...parent.evidenceIds,...child.evidenceIds]).size>8)return null;
 return {container:container.join(' '),requiredContent:required.join(' '),contentTiming:calendar.test(parent.action)};
}
function boundedShape(parent,child){
 if(!eligible(parent)||!eligible(child)||canonical(parent.owners[0])!==canonical(child.owners[0])
  ||guarded.test(parent.action)||guarded.test(child.action)||calendar.test(parent.action+' '+child.action)
  ||/\b(?:19|20)\d{2}\b|\d{1,2}[/-]\d{1,2}/.test(parent.action+' '+child.action)
  ||!parent.evidenceIds.some(id=>child.evidenceIds.includes(id))||new Set([...parent.evidenceIds,...child.evidenceIds]).size>8)return null;
 const clean=value=>canonical(value).replace(/[.!]+$/,'').trim();
 const a=clean(parent.action),b=clean(child.action);
 // Stable existing fuller survivor, independent of incoming row order.
 if(a.length<=b.length)return null;
 const issue=value=>value.match(/^(?:bring (.+) to (.+?)(?: for review)?|raise (.+) with (.+))$/);
 const x=issue(a),y=issue(b);
 if(x&&y){
  const object=m=>tokens(m[1]||m[3]),recipient=m=>tokens(m[2]||m[4]);
  if(object(x).length>=3&&recipient(x).length>=1&&hash(object(x))===hash(object(y))&&hash(recipient(x))===hash(recipient(y)))
   return {kind:'issue_paraphrase'};
 }
 const content=value=>value.match(/^(?:include|describe|explain|list|state|flag|communicate|outline) (.+) (?:in|within) (.+?)(?: and explain (?:the )?(?:change|increase|decrease|difference))?$/);
 const p=content(a),c=content(b);if(!p||!c)return null;
 const required=tokens(c[1]),full=tokens(p[1]),container=tokens(p[2]),other=tokens(c[2]);
 const common=container.filter(word=>other.includes(word));
 if(required.length<3||!required.every(word=>full.includes(word))||common.length<2
  ||common.length/Math.max(container.length,other.length)<0.66)return null;
 return {kind:'content_instruction'};
}
function listDeliverableShape(parent,child){
 if(!eligible(parent)||!eligible(child)||canonical(parent.owners[0])!==canonical(child.owners[0])
  ||guarded.test(parent.action+' '+child.action)||calendar.test(parent.action+' '+child.action)
  ||/\b(?:or|either|neither|review|approve|send|share|email|submit|publish)\b|\d/i.test(parent.action+' '+child.action)
  ||new Set([...parent.evidenceIds,...child.evidenceIds]).size>8
  ||!(parent.evidenceIds.every(id=>child.evidenceIds.includes(id))
    ||child.evidenceIds.every(id=>parent.evidenceIds.includes(id))))return null;
 const parse=(value,verb)=>String(value).trim().replace(/[.!]+$/,'')
  .match(new RegExp('^'+verb+'\\s+(?:a|the|one)\\s+list\\s+of\\s+(.+?)\\s+for\\s+(.+)$','i'));
 const a=parse(parent.action,'provide'),b=parse(child.action,'(?:prepare|compile)');if(!a||!b)return null;
 const objectA=tokens(a[1]),objectB=tokens(b[1]),purposeA=tokens(a[2]),purposeB=tokens(b[2]);
 if(objectA.length<2||objectB.length<2||hash(objectA.slice(0,2))!==hash(objectB.slice(0,2))
  ||purposeA.length<2||hash(purposeA)!==hash(purposeB))return null;
 return {kind:'list_deliverable'};
}
function shape(parent,child){return legacyShape(parent,child)||boundedShape(parent,child)||listDeliverableShape(parent,child)||qualifiedRepeat.shape(parent,child)||exactRepeat.shape(parent,child);}
function direction(left,right,all=[left,right]){
 for(const [parent,child] of [[left,right],[right,left]]){
  const match=shape(parent,child);if(!match)continue;
  if(all.filter(row=>shape(row,child)).length!==1||all.filter(row=>hash(row)===hash(child)).length!==1)continue;
  return {parent,child,...match};
 }
 return null;
}

module.exports = { FIELDS, calendar, guarded, canonical, tokens, eligible, legacyShape, boundedShape, listDeliverableShape, shape, direction };
