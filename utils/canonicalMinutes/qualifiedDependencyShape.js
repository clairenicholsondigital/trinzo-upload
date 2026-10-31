'use strict';
// Actual preparation and nomination authority shared by receipt and review consumers.
const {hash}=require('../meetingMinutesProofHash');
const {isReviewerAuthored}=require('./state');

const FIELDS=new Set(['id','occurrenceId','action','owners','timing','timingDecision','evidenceIds','reviewFlagIds']);
const canonical=value=>String(value||'').normalize('NFKC').replace(/[’]/g,"'").toLowerCase().replace(/\s+/g,' ').trim().replace(/[.!]+$/,'').trim();
const prohibited=/\b(?:if|unless|after|before|once|when|until|pending|following|without|never|not|only|either|or|maybe|perhaps|probably|possibly|tentatively|deadline|due|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|next|last|previous|each|every)\b|\d|[;?\n"“”:()[\]{}]/i;
const words=value=>(canonical(value).match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>!['a','an','the','to','of','for','in','with','by','required'].includes(w)).map(w=>w.length>3?w.replace(/s$/,''):w);
function eligible(row){
 const decision=row?.timingDecision;
 return row&&Object.keys(row).every(key=>FIELDS.has(key))&&!isReviewerAuthored(row)&&row.owners?.length===1&&String(row.owners[0]).trim()
  &&row.timing?.kind==='dependency'&&!row.timing.exactDate&&/^Dependent on\s+\S/i.test(row.timing.wording||'')&&!row.reviewFlagIds?.length
  &&Array.isArray(row.evidenceIds)&&row.evidenceIds.length>0&&row.evidenceIds.length<=8&&new Set(row.evidenceIds).size===row.evidenceIds.length
  &&!decision?.checkerStatus&&decision?.status==='unresolved'&&decision.reason==='timing_source_unresolved'&&decision.binding?.status==='unresolved'
  &&!decision.binding.conflictingSourceIds?.length&&!decision.rejectedExactDates?.length&&!decision.rejectedWordings?.length
  &&!prohibited.test(row.action+' '+row.timing.wording)
  &&!/[.!?]/.test(String(row.action).replace(/[.!?]+$/,''))
  &&!/[.!?]/.test(String(row.timing.wording).replace(/[.!?]+$/,''))
  &&!/\b(?:and|then)\s+(?:send|share|provide|review|check|approve|buy|purchase|fit|install|call|email|submit|publish|generate|create|prepare|compile|update|test)\b/i.test(row.action);
}
function method(row){return String(row.action).match(/^\s*(?:complete|finish|resolve)\s+(.+?)\s+by\s+(generating|creating|compiling|updating|preparing|testing)\s+(.+?)[.!]?\s*$/i);}
function shape(parent,child){
 if(!eligible(parent)||!eligible(child)||canonical(parent.owners[0])!==canonical(child.owners[0])
  ||String(parent.timingDecision.meetingDate||'')!==String(child.timingDecision.meetingDate||''))return null;
 const a=method(parent),b=method(child);if(!a||!b||a[2].toLowerCase()!==b[2].toLowerCase())return null;
 const full=canonical(parent.timing.wording),short=canonical(child.timing.wording);
 // A strict literal dependency prefix, with only a route/provider extension,
 // chooses the fuller existing row. Same-length or competing conditions hold.
 if(!full.startsWith(short+' ')||! /^(?:through|via|from)\s+[\p{L}\s-]+$/u.test(full.slice(short.length+1)))return null;
 const left=[...new Set(words(a[3]))],right=[...new Set(words(b[3]))],common=left.filter(w=>right.includes(w));
 if(common.length<2||common.length/Math.max(1,Math.min(left.length,right.length))<0.6)return null;
 if(!parent.evidenceIds.some(id=>child.evidenceIds.includes(id))||new Set([...parent.evidenceIds,...child.evidenceIds]).size>8)return null;
 return {method:a[2].toLowerCase(),dependency:full};
}
function direction(left,right,all=[left,right]){
 for(const [parent,child]of[[left,right],[right,left]])if(shape(parent,child)
  &&all.filter(row=>shape(row,child)).length===1&&all.filter(row=>hash(row)===hash(child)).length===1)return {parent,child};
 return null;
}

module.exports = { FIELDS, canonical, prohibited, words, eligible, method, shape, direction };
