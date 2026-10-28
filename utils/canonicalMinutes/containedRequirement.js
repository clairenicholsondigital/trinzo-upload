'use strict';
const {hash}=require('../meetingMinutesProofHash');
const {actionProvenanceSignature}=require('../meetingMinutesActionIdentity');
const {isReviewerAuthored}=require('./state');
const VERSION='contained-content-v1';
const qualifiedRepeat=require('./qualifiedRepeatShape');
const exactRepeat=require('./exactInstructionRepeat');
const qualified=match=>['qualified_repeat','exact_instruction_repeat'].includes(match?.kind);
const rolePassed=(match,assessment,parent,child)=>match.kind==='exact_instruction_repeat'
 ?exactRepeat.reviewRolePassed(assessment,parent,child):qualifiedRepeat.reviewRolePassed(assessment,parent,child);
const FIELDS=new Set(['id','occurrenceId','action','owners','timing','timingDecision','evidenceIds','reviewFlagIds']);
const ALLOWED=new Set(['different_operation','different_destination','different_inline_temporal_occurrence']);
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
// These shapes NOMINATE only. Two independent source/retention reviews must
// prove every original obligation in one unchanged existing survivor.
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
// Nomination only: one list with a shared purpose and nested source refs.
// A separate source review must establish that preparing/compiling and providing it are
// one obligation, rather than independent preparation and delivery steps.
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
function reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge,reviewOptions={}){
 const variant=boundedShape(parent,child)||listDeliverableShape(parent,child)||qualifiedRepeat.shape(parent,child)||exactRepeat.shape(parent,child);
 const cited=new Set([...parent.evidenceIds,...child.evidenceIds]);
 if(variant&&sourceUnits.some(unit=>cited.has(unit.id)&&/\b(?:withdrawn|cancelled|canceled|no action|no longer (?:required|needed))\b/i.test(String(unit.text||''))))throw Error('contained_source_withdrawal');
 const context=sourceUnits.filter(unit=>contextSourceIds.includes(unit.id));
 if(context.length!==contextSourceIds.length||new Set(contextSourceIds).size!==contextSourceIds.length)throw Error('contained_context_changed');
 if(context.length>32||context.reduce((n,unit)=>n+JSON.stringify(unit).length,0)>48000||[...parent.evidenceIds,...child.evidenceIds].some(id=>!contextSourceIds.includes(id)))throw Error('contained_incomplete_or_oversized_context');
 // Only the newly nominated shapes may use nearby identity context when
 // their original citations lack a name witness. Keep old packets/receipts
 // unchanged. This supplies identity, never evidence of commitment by itself.
 const nearbyIdentity=variant?.kind==='list_deliverable'
  &&(/^compile\b/i.test(child.action)||hash([...parent.evidenceIds].sort())!==hash([...child.evidenceIds].sort()))
  ||variant?.kind==='qualified_repeat'&&qualifiedRepeat.completionDetail(parent,child);
 const ownerContext=nearbyIdentity?[parent,child].map(row=>{
  const anchors=sourceUnits.flatMap((unit,index)=>row.evidenceIds.includes(unit.id)?[index]:[]);
  return {recordHash:hash(row),sourceIds:sourceUnits
   .filter((unit,index)=>contextSourceIds.includes(unit.id)&&unit.text?.trim()
    &&(unit.classification!=='remove'||unit.restored)&&anchors.some(at=>Math.abs(at-index)<=2))
   .map(unit=>unit.id)};
 }):undefined;
 const register=require('../meetingMinutesActionReviewRegister').prepare({actions:[parent,child],sourceUnits:context});
 return require('../meetingMinutesActionReferenceReview').prepare(register,register.comparisons[0].comparisonId,register.rows[0].ref,{challenge,...(variant?{instructionComparison:variant.kind}:{}),...(ownerContext?{ownerContext}:{}),...reviewOptions});
}
function sourceIds(packet,response){
 const sections=response.decisions||[];
 const ids=sections.flatMap(section=>section.kind==='source'?section.rows.flatMap(row=>row.checks.flatMap(check=>check.refs))
  :section.kind==='relationship'?section.refs:[]);
 return [...new Set(ids.map(id=>packet.sourceCatalog.find(ref=>ref.id===id)?.unitId).filter(Boolean))];
}
function certify(parent,child,sourceUnits,contextSourceIds,primary,challenge,options={}){
 const match=shape(parent,child);if(!match)throw Error('contained_shape_not_eligible');
 const atomic=require('./actionSemanticReconciliation').prepareActionReconciliation({actions:[parent,child],sourceUnits});
 if(atomic.rows.some(row=>row.clauses.length!==1))throw Error('contained_compound_instruction');
 const N=require('../meetingMinutesActionReferenceReview');
 const reviewOptions=options.contextualUnits===true?{contextualUnits:true}:{};
 const first=reviewPacket(parent,child,sourceUnits,contextSourceIds,false,reviewOptions),second=reviewPacket(parent,child,sourceUnits,contextSourceIds,true,reviewOptions);
 for(const [packet,response] of [[first,primary],[second,challenge]]){
  const assessment=N.assess(packet,response);
  if(qualified(match)&&assessment.modelPassed&&!rolePassed(match,assessment,parent,child))
   throw Error('qualified_repeat_source_role_conflict');
  if(qualified(match)) {
   if(assessment.contractError||!rolePassed(match,assessment,parent,child))throw Error(assessment.contractError||'contained_independent_veto');
   continue;
  }
  if(assessment.contractError||!assessment.modelPassed||!(['issue_paraphrase','list_deliverable','qualified_repeat'].includes(match.kind)?['same_obligation']:match.kind==='content_instruction'?['same_obligation','discarded_requirement_of_survivor']:['discarded_requirement_of_survivor']).includes(assessment.relationship?.relation)
   ||['issue_paraphrase','list_deliverable','qualified_repeat'].includes(match.kind)&&response.decisions.find(section=>section.kind==='source').rows.some(row=>row.basis!=='commitment'))throw Error(assessment.contractError||'contained_independent_veto');
 }
 const evidenceIds=[...new Set([...parent.evidenceIds,...child.evidenceIds,...sourceIds(first,primary),...sourceIds(second,challenge)])].sort();
 if(evidenceIds.length>8)throw Error('contained_evidence_capacity');
 if(evidenceIds.some(id=>sourceUnits.filter(unit=>unit.id===id).length!==1||sourceUnits.some(unit=>unit.id===id&&unit.classification==='remove'&&!unit.restored)))throw Error('contained_ineligible_source');
 if(qualified(match))for(const [packet,response] of [[first,primary],[second,challenge]]){
  const timing=packet.survivorCatalog.find(ref=>ref.field==='timing.wording');
  if(!timing||packet.retentionRequests.filter(request=>request.field==='timing').some(request=>
   !response.decisions.find(section=>section.kind==='retention').checks.find(check=>check.id===request.id)?.refs.includes(timing.id)))
   throw Error('qualified_repeat_timing_wording_not_retained');
 }
 const expected={...structuredClone(parent),evidenceIds,reviewFlagIds:qualified(match)
  ?[...new Set([...parent.reviewFlagIds,...child.reviewFlagIds])].sort():[]};
 if(qualified(match))for(const field of ['rejectedExactDates','rejectedWordings'])
  if([parent,child].some(row=>Array.isArray(row.timingDecision?.[field])))
   expected.timingDecision[field]=[...new Set([parent,child].flatMap(row=>row.timingDecision[field]||[]))].sort();
 const body={version:VERSION,...(options.contextualUnits===true?{unitContextVersion:1}:{}),sourceHash:hash(sourceUnits),parent:structuredClone(parent),child:structuredClone(child),contextSourceIds:[...contextSourceIds],
  primary:structuredClone(primary),challenge:structuredClone(challenge),expectedSurvivor:expected};
 return {...body,reviewHash:hash(body)};
}
function valid(packet,certificate,original,survivor){
 if(!certificate||certificate.unitContextVersion!==undefined&&certificate.unitContextVersion!==1||certificate.version!==VERSION||certificate.sourceHash!==hash(packet.sourceUnits||[]))return false;
 const {reviewHash,...body}=certificate;if(hash(body)!==reviewHash)return false;
 if(![certificate.parent,certificate.child].some(row=>hash(row)===hash(original.action)))return false;
 if(![certificate.parent,certificate.expectedSurvivor].some(row=>actionProvenanceSignature(row)===actionProvenanceSignature(survivor.action)))return false;
 try{return certify(certificate.parent,certificate.child,packet.sourceUnits,certificate.contextSourceIds,certificate.primary,certificate.challenge,{contextualUnits:certificate.unitContextVersion===1}).reviewHash===reviewHash;}catch{return false;}
}
function conflicts(packet,proof,original,survivor,reasons){
 if(!proof?.containedRequirement)return reasons;
 if(!valid(packet,proof.containedRequirement,original,survivor))return [...reasons,'invalid_contained_requirement_review'];
 const match=shape(proof.containedRequirement.parent,proof.containedRequirement.child);
 const allowed=qualified(match)?new Set(['different_timing','different_condition_or_dependency']):match?.kind==='list_deliverable'?new Set(['different_operation','operation_would_be_lost']):ALLOWED;
 return reasons.filter(reason=>!allowed.has(reason));
}
function coverage(packet,parentRow,childRow,certificate){
 if([parentRow,childRow].some(row=>row.clauses.length!==1))throw Error('contained_compound_instruction');
 const ids=certificate.expectedSurvivor.evidenceIds;
 const response={decisions:[{relation:'equivalent',coverage:[parentRow,childRow].map(row=>({originalRef:row.ref,survivorRef:parentRow.ref,sourceIds:ids,
  clauseMap:[{originalClauseIndex:0,survivorClauseIndex:0,sourceIds:ids}]}))}]};
 return require('../meetingMinutesSemanticProofTransport').materializeSemanticDecisions(packet,response,'actions').decisions[0].coverage
  .map(proof=>({...proof,containedRequirement:certificate}));
}
function validMapping(packet,proof,original,survivor){
 if(!valid(packet,proof.containedRequirement,original,survivor))return false;
 const certificate=proof.containedRequirement;
 const atomic=require('./actionSemanticReconciliation').prepareActionReconciliation({actions:[survivor.action,original.action],sourceUnits:packet.sourceUnits});
 const [parentRow,originalRow]=atomic.rows.map((row,index)=>({...row,ref:index===0?survivor.ref:original.ref}));
 const expected=coverage({...packet,rows:[parentRow,originalRow]},parentRow,originalRow,certificate)[1];
 return hash(proof.semanticProof)===hash(expected.semanticProof)&&hash(proof.sourceSpans)===hash(expected.sourceSpans);
}
module.exports={VERSION,eligible,shape,direction,reviewPacket,certify,valid,conflicts,coverage,validMapping,sourceIds};
