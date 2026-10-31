'use strict';

const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { commitmentQuoteTiesOwner } = require('./meetingMinutesActionSourceMatching');
const { readInventory: inventory } = require('./meetingMinutesActionInventory');
const B=require('./canonicalMinutes/discussionBoundedRewrite'),T=require('./meetingMinutesTiming');
const {hash}=require('./meetingMinutesProofHash'),{isReviewerAuthored}=require('./canonicalMinutes/state');
const VERSION='compilation-union-v1',clone=x=>structuredClone(x),fields=new Set(['id','occurrenceId','action','owners','evidenceIds','reviewFlagIds','timing','timingDecision']);
const checks=['sameWorkEvent','explicitOutstandingWork','sameOwners','sameRecipient','allOperationsRetained','allScopeRetained','noNewWork'];
const canon=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
function eligible(row,protectedIds=[]){const t=row?.timing,d=row?.timingDecision;return row&&!isReviewerAuthored(row)&&Object.keys(row).every(k=>fields.has(k))
 &&typeof row.id==='string'&&row.id&&!protectedIds.includes(row.occurrenceId)&&!protectedIds.includes(row.id)&&typeof row.action==='string'&&row.action.length<=800
 &&!/[.!?]/.test(row.action.replace(/[.!?]+$/,''))&&/^compile\b/i.test(row.action)&&!/\b(?:or|either|unless|if|not|only|never|after|before|once|when|until|tomorrow|today|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b|[;?\n/|]|\band\s+(?:send|share|provide|approve|test|review|write|update)\b/i.test(row.action)
 &&row.owners?.length===1&&typeof row.owners[0]==='string'&&row.owners[0].trim()&&Array.isArray(row.evidenceIds)&&row.evidenceIds.length>0&&row.evidenceIds.length<=8
 &&new Set(row.evidenceIds).size===row.evidenceIds.length&&(row.reviewFlagIds===undefined||Array.isArray(row.reviewFlagIds)&&row.reviewFlagIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=80))&&(row.reviewFlagIds||[]).length<=24
 &&t&&!t.exactDate&&((t.kind==='not_stated'&&!t.wording)||t.kind==='dependency'&&typeof t.wording==='string'&&t.wording.trim()&&d?.status==='unresolved')
 &&!['rejected','needs_rebind'].includes(d?.status)&&!d?.rejectedExactDates?.length&&!d?.rejectedWordings?.length;}
function prepare(actions,units,meetingDate='',protectedIds=[]){units=normaliseSourceUnits(units);const count=id=>actions.filter(r=>r.id===id).length;
 for(let i=0;i<actions.length;i++)for(let j=i+1;j<actions.length;j++){
  const x=actions[i],y=actions[j];if(!eligible(x,protectedIds)||!eligible(y,protectedIds)||count(x.id)!==1||count(y.id)!==1
   ||canon(x.owners[0])!==canon(y.owners[0])||x.action===y.action)continue;
  if(x.timing.wording&&y.timing.wording&&hash(x.timing)!==hash(y.timing))continue;
  const figures=s=>[...new Set(s.match(/\d+(?:\.\d+)?/g)||[])].sort(),a=figures(x.action),b=figures(y.action);
  if(a.length&&b.length&&hash(a)!==hash(b))continue;
  const words=s=>new Set(canon(s).match(/[a-z]{4,}/g)||[]),wx=words(x.action),wy=words(y.action);
  if([...wx].filter(w=>wy.has(w)).length<4||[...wx].filter(w=>wy.has(w)).length/Math.min(wx.size,wy.size)<0.5)continue;
  const shared=x.evidenceIds.filter(id=>y.evidenceIds.includes(id));if(shared.length<2||shared.length/Math.min(x.evidenceIds.length,y.evidenceIds.length)<0.5)continue;
  const evidenceIds=[...new Set([...x.evidenceIds,...y.evidenceIds])],flags=[...new Set([...(x.reviewFlagIds||[]),...(y.reviewFlagIds||[])])];if(evidenceIds.length>8||flags.length>24)continue;
  const positions=evidenceIds.map(id=>units.findIndex(u=>u.id===id));if(positions.some(at=>at<0)||evidenceIds.some(id=>units.filter(u=>u.id===id).length!==1||units.some(u=>u.id===id&&u.classification==='remove'&&!u.restored)))continue;
  const selected=new Set();for(const at of positions)for(let n=Math.max(0,at-4);n<=Math.min(units.length-1,at+4);n++)selected.add(n);
  const sourceUnits=units.filter((unit,at)=>selected.has(at)&&(unit.classification!=='remove'||unit.restored));if(sourceUnits.length>32||JSON.stringify(sourceUnits).length>48000||sourceUnits.some(u=>!u.text||u.text.length>12000||sourceUnits.filter(other=>other.id===u.id).length!==1))continue;
  // The row carrying unresolved timing is the immutable metadata donor. An
  // unstated value in a paraphrase is not contradictory timing evidence.
  const originalActions=clone(x.timing.kind==='dependency'?[x,y]:y.timing.kind==='dependency'?[y,x]:[x,y].sort((a,b)=>hash(a).localeCompare(hash(b))));
  const rows=originalActions.map((row,index)=>({path:[0,'points',index],record:{id:row.id,text:row.action,evidenceIds:row.evidenceIds,reviewFlagIds:[],supportingDetails:[]},sentences:[row.action]}));
  const candidate={id:'compilation-'+hash(originalActions).slice(0,24),rows,sourceUnits,metadata:{evidenceIds:[...new Set(originalActions.flatMap(r=>r.evidenceIds))],reviewFlagIds:[...new Set(originalActions.flatMap(r=>r.reviewFlagIds||[]))]},nominationKind:'partial_overlap'};
  const body={version:B.VERSION,inputHash:hash(actions),sourceHash:hash(units),meetingDate,originalActions,candidates:[candidate]};return {...body,packetHash:hash(body)};
 }return null;}

function vocabulary(packet,text){const words=s=>canon(s).match(/[\p{L}\p{N}]+/gu)||[],original=new Set(words(packet.originalActions.map(r=>r.action).join(' ')));return /^Compile\b/.test(text)&&words(text).every(w=>original.has(w));}
function workPrompt(packet,candidate){return 'ACTION_CRITIC_COMPILATION_UNION_VERIFICATION\nIndependently assess whether BOTH original instructions and the proposed rewrite describe ONE source-supported outstanding compilation deliverable for the SAME assignee, recipient, material and work occurrence. Same wording/owner/citations is never proof. Decline separate reports, review execution, submissions or versions. Preserve all quantities, scope and relationships; no invented work. Timing metadata is deliberately UNCHANGED and may be unresolved: do not verify it, infer it, remove it or treat its absence on one paraphrase as a separate work event. Quote the actual assignment/acceptance tying this work to its owner. Return only {results:[{version:"'+VERSION+'",packetHash:"'+packet.packetHash+'",checks:{'+checks.map(k=>k+':boolean').join(',')+'},assignmentWitnesses:[{sourceId,quote}]}]}.\nDATA\n'+JSON.stringify({packetHash:packet.packetHash,originalActions:packet.originalActions,text:candidate.text,sourceUnits:candidate.sourceUnits});}
function workValid(packet,response){if(response?.version!==VERSION||response.packetHash!==packet.packetHash||!checks.every(k=>response.checks?.[k]===true)||!response.assignmentWitnesses?.length||response.assignmentWitnesses.length>12)return false;
 const owner=packet.originalActions[0].owners[0],sources=packet.candidates[0].sourceUnits,first=owner.split(/\s+/)[0].toLowerCase(),names=[...new Set(sources.map(u=>u.speaker).filter(s=>s?.split(/\s+/)[0].toLowerCase()===first))];
 if(names.length!==1||names[0]!==owner)return false;
 return response.assignmentWitnesses.every(w=>{const rows=sources.filter(u=>u.id===w?.sourceId);return rows.length===1&&typeof w.quote==='string'&&w.quote.trim()&&rows[0].text.includes(w.quote)&&commitmentQuoteTiesOwner(w.quote,[owner],rows[0].speaker+': '+rows[0].text);});}
function assessment(packet,responses){const inv=inventory(packet,responses.inventory);if(inv?.length!==1)return null;const proposal=B.proposals(packet,inv,responses.proposal);if(proposal?.length!==1||!vocabulary(packet,proposal[0].text))return null;const verified=B.verified(packet,proposal,responses.verification);return verified?.accepted?.length===1&&workValid(packet,responses.work)?verified.accepted[0]:null;}
function expected(packet,candidate,units){const a=packet.originalActions[0],row={...clone(a),action:candidate.text,evidenceIds:clone(candidate.metadata.evidenceIds),reviewFlagIds:clone(candidate.metadata.reviewFlagIds)};
 if(a.timingDecision)row.timingDecision={...clone(a.timingDecision),...T.timingAssessmentKey(row,units,packet.meetingDate)};return row;}
const frame=row=>{const {id,occurrenceId,...rest}=row;return rest;};
function valid(receipt,original,survivor,units,date=receipt?.packet?.meetingDate){try{const p=receipt.packet;if(receipt.version!==VERSION||p.sourceHash!==hash(normaliseSourceUnits(units))||p.meetingDate!==date)return false;const {packetHash,...body}=p;if(hash(body)!==packetHash)return false;
 const reconstructed=prepare(p.originalActions,units,p.meetingDate);if(!reconstructed||hash(reconstructed.originalActions)!==hash(p.originalActions)||hash(reconstructed.candidates)!==hash(p.candidates))return false;
 const accepted=assessment(p,receipt.responses);return !!accepted&&p.originalActions.some(r=>hash(r)===hash(original))&&hash(frame(survivor))===hash(frame(expected(p,accepted,units)))&&hash(survivor)===hash(receipt.final);
 }catch{return false;}}
async function rewrite(actions,units,options={}){const original=clone(actions),packet=prepare(actions,units,options.meetingDate||'',options.protectedIds||[]),audit={version:VERSION,original,originalHash:hash(original),applied:false,reason:packet?'assessment_unavailable':'no_candidates',calls:0,receipts:[]};if(!packet||typeof options.ask!=='function')return {actions:original,audit};const responses={},deadline=Date.now()+120000;
 const ask=async(part,prompt)=>{const budget=Math.min(45000,deadline-Date.now());if(budget<10000)throw Error('budget_exhausted');audit.calls++;const reply=await options.ask(prompt,{responseKind:'correction_check',maxAttempts:1,attemptTimeoutMs:budget,deadlineAt:deadline});responses[part]=part==='work'?(reply.result?.results?.length===1?reply.result.results[0]:null):reply.result;return responses[part];};
 try{const intro='ACTION_CRITIC_COMPILATION_UNION\nEdit only the original work INSTRUCTIONS into ONE grammatical imperative sentence starting Compile. Retain all original instruction claims, quantities and scope. Do not add work or merge distinct deliverables. The metadata (including any unresolved dependency/warnings) is preserved separately by the server; do not treat it as verified or add it to the instruction. ';
  const inv=inventory(packet,await ask('inventory',intro+B.inventoryPrompt(packet)));if(inv?.length!==1)return {actions:original,audit:{...audit,reason:'inventory_declined',responses}};
  const proposed=B.proposals(packet,inv,await ask('proposal',intro+B.proposalPrompt(packet,inv)));if(proposed?.length!==1||!vocabulary(packet,proposed[0].text))return {actions:original,audit:{...audit,reason:'no_safe_proposal',responses}};
  const review=B.verified(packet,proposed,await ask('verification',intro+B.verificationPrompt(packet,proposed)));if(review?.accepted?.length!==1)return {actions:original,audit:{...audit,reason:'coverage_rejected',responses}};
  await ask('work',workPrompt(packet,review.accepted[0]));const accepted=assessment(packet,responses);if(!accepted)return {actions:original,audit:{...audit,reason:'work_event_not_proved',responses}};
  if(hash(actions)!==packet.inputHash||hash(normaliseSourceUnits(units))!==packet.sourceHash)throw Error('stale_input');
  const final=expected(packet,accepted,units),receipt={version:VERSION,packet,responses,final:clone(final)};
  if(!valid(receipt,packet.originalActions[0],final,units,packet.meetingDate))throw Error('invalid_receipt');
  const [a,b]=packet.originalActions,output=original.filter(r=>r.id!==b.id).map(r=>r.id===a.id?final:r);
  return {actions:output,audit:{...audit,applied:true,reason:'verified_compilation',receipts:[receipt],responses,finalHash:hash(output)}};
 }catch(error){return {actions:original,audit:{...audit,reason:'assessment_failed',errorCode:error.code||error.message,responses}};}}
function restore(actions,audit,units,date=audit?.receipts?.[0]?.packet?.meetingDate){return audit?.version===VERSION&&audit.applied&&hash(audit.original)===audit.originalHash&&hash(actions)===audit.finalHash&&audit.receipts?.length&&audit.receipts.every(r=>actions.some(a=>valid(r,r.packet.originalActions[0],a,units,date)))?clone(audit.original):null;}
module.exports={VERSION,prepare,rewrite,valid,restore,checks,workPrompt,workValid,assessment};
