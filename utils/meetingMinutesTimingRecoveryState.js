'use strict';

const crypto = require('crypto');

const VERSION='agent-timing-recovery-v1';

const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

const copy=v=>JSON.parse(JSON.stringify(v));

const normal=v=>String(v||'').replace(/[’]/g,"'").toLowerCase().replace(/\s+/g,' ').trim().replace(/[.!]+$/,'');

const frame=a=>({action:a.action,owners:a.owners,evidenceIds:a.evidenceIds,timing:a.timing});

const checks=['allOriginalClaimsListed','wholeActionSupported','sameWork','sameOwner','sameRecipient','samePurposeAndDirection','sameConditions','sameQuantities','sameTimingAndQualifications','explicitOutstandingAssignment'];

function packet(action,item,units,meetingDate){
 if(action.owners?.length!==1 || action.timing?.exactDate || !action.timing?.wording || action.reviewerAuthored
   || /^(?:manual-|reviewer-)/.test(action.id||'') || item.contextCoverage?.omittedAnchorIds?.length)return null;
 const owner=normal(action.owners[0]),first=owner.split(/\s+/)[0];
 const matches=[...new Set(units.map(u=>normal(u.speaker)).filter(name=>name.split(/\s+/)[0]===first))];
 if(matches.length!==1 || matches[0]!==owner)return null;
 const selected=units.filter(u=>action.evidenceIds.includes(u.id));
 if(JSON.stringify(selected).length>48000 || selected.length!==new Set(action.evidenceIds).size || selected.length>12 || selected.some(u=>!u.text||u.text.length>12000))return null;
 const p={version:VERSION,action:copy(frame(action)),sourceHash:hash(units),meetingDate,sourceUnits:copy(selected)};return {...p,packetHash:hash(p)};
}

function validateProposal(p,r){
 if(!r||r.packetHash!==p.packetHash||r.version!==VERSION||r.decision!=='supported'||!Array.isArray(r.claims)||!r.claims.length||r.claims.length>20)return false;
 const witness=w=>w && p.sourceUnits.filter(u=>u.id===w.sourceId).length===1
   && typeof w.quote==='string'&&w.quote.trim()&&p.sourceUnits.find(u=>u.id===w.sourceId).text.includes(w.quote);
 if(!r.claims.every(c=>typeof c.originalQuote==='string'&&c.originalQuote.trim()&&p.action.action.includes(c.originalQuote)&&witness(c))
   || !['owner','work','timing'].every(k=>witness(r[k])) || new Set(['owner','work','timing'].map(k=>r[k].sourceId)).size!==1)return false;
 const covered=new Uint8Array(p.action.action.length);
 for(const c of r.claims){let i=p.action.action.indexOf(c.originalQuote);while(i>=0){covered.fill(1,i,i+c.originalQuote.length);i=p.action.action.indexOf(c.originalQuote,i+1);}}
 if([...p.action.action].some((ch,i)=>/[\p{L}\p{N}]/u.test(ch)&&!covered[i]))return false;
 const source=p.sourceUnits.find(u=>u.id===r.owner.sourceId).text;
 const first=p.action.owners[0].split(/\s+/)[0];
 if(!first || !normal(r.owner.quote).includes(normal(first)) || !/\b(?:action|task|priority|focus)\b/i.test(source) || /[?？]/.test(source)
   || normal(r.timing.quote)!==normal(p.action.timing.wording))return false;
 return true;
}

function preserveUnchangedActions(normalised,originals,submitted,proofs,units,date){
 return normalised.map(row=>{
  const old=originals.filter(a=>a.id===row.id),sent=(submitted||originals).filter(a=>a.id===row.id);
  if(old.length!==1||sent.length!==1||hash(frame(sent[0]))!==hash(frame(old[0])))return row;
  return (proofs||[]).some(p=>validProof(p,old[0],units,date))?copy(old[0]):row;
 });
}

function validProof(proof,action,units,date){
 if(!proof?.packet||proof.packet.sourceHash!==hash(units)||proof.packet.meetingDate!==date||hash(frame(action))!==hash(proof.packet.action))return false;
 const p=packet(action,{contextCoverage:{}},units,date);
 return p&&p.packetHash===proof.packet.packetHash&&validateProposal(p,proof.proposal)
   && proof.verification?.packetHash===p.packetHash&&proof.verification.proposalHash===hash(proof.proposal)
   && checks.every(k=>proof.verification.checks?.[k]===true);
}

function bindingReader(proofs,units,date){return action=>{
 const p=(proofs||[]).find(p=>validProof(p,action,units,date));
 return p?{status:'supported',reason:VERSION,sourceEvidenceIds:[...action.evidenceIds],matchedSourceIds:[p.proposal.work.sourceId],conflictingSourceIds:[],qualifiers:[]}:null;
};}

module.exports = { VERSION, hash, copy, normal, frame, checks, packet, validateProposal, preserveUnchangedActions, validProof, bindingReader };
