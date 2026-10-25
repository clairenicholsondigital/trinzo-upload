'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../utils/canonicalMinutes/discussionMainPointCoverage');
const C=require('../utils/canonicalMinutes/discussionClaimConsolidation');
const D=require('../utils/canonicalMinutes/discussionDirectionalCoverage');
const copy=value=>structuredClone(value);
function fixture(){
 const parent='The core issue is overloaded storage racks; the paint proposal does not address the problem.';
 const row=(id,text)=>({id,text,evidenceIds:['T0001'],reviewFlagIds:[],supportingDetails:[]});
 return {discussion:[{id:'topic',topic:'Storage',points:[row('full',parent),row('short','The core issue is overloaded storage racks.')],decisions:[],openQuestions:[]}],sourceUnits:[{id:'T0001',speaker:'Chair',text:parent}]};
}
function inventory(packet){return {version:M.VERSION,packetHash:packet.packetHash,results:packet.candidates.map(c=>({id:c.id,decision:'covered',claims:c.originalSentences.map((quote,i)=>({id:'claim-'+i,text:quote,originalQuote:quote,survivorQuote:c.survivor.text.split(';')[0].trim(),sourceWitnesses:[{sourceId:'T0001',quote:c.sourceUnits.find(s=>s.id==='T0001').text}]}))}))};}
function verification(packet,selected){return {version:M.VERSION,packetHash:packet.packetHash,results:selected.map(c=>({id:c.id,survivorSupported:true,survivorWitnesses:[{sourceId:'T0001',quote:c.sourceUnits.find(s=>s.id==='T0001').text}],sameOccurrence:true,noContradiction:true,
 claimChecks:c.claims.map(claim=>({claimId:claim.id,supported:true,retained:true,survivorQuote:c.survivor.text.split(';')[0].trim(),sourceWitnesses:[{sourceId:'T0001',quote:c.sourceUnits.find(s=>s.id==='T0001').text}]})),
 sentenceChecks:c.originalSentences.map((_,i)=>({sentenceIndex:i,allClaimsListed:true,supported:true,retained:true,survivorQuote:c.survivor.text.split(';')[0].trim(),sourceWitnesses:[{sourceId:'T0001',quote:c.sourceUnits.find(s=>s.id==='T0001').text}]}))}))};}
const options=()=>({inventory:async(_prompt,p)=>inventory(p),verify:async(_prompt,p,s)=>verification(p,s)});
test('a separate negative clause no longer prevents independently quoted main-point coverage',async()=>{
 const f=fixture(),before=copy(f.discussion);assert.equal(D.prepare(f.discussion,f.sourceUnits).candidates.length,0);
 const p=M.prepare(f.discussion,f.sourceUnits);assert.equal(p.candidates.length,1);
 const result=await M.consolidate(f.discussion,f.sourceUnits,options());
 assert.equal(result.audit.applied,true);assert.equal(result.audit.method,M.VERSION);assert.equal(result.discussion[0].points.length,1);
 assert.equal(result.discussion[0].points[0].text,before[0].points[0].text);assert.deepEqual(result.discussion[0].points[0].mergedFromIds,['short']);
 assert.deepEqual(C.restore(result.discussion,f.sourceUnits,result.audit),before);assert.deepEqual(f.discussion,before);
});
for(const [name,mutate]of[
 ['original warning',f=>f.discussion[0].points[1].reviewFlagIds=['warning']],
 ['survivor warning',f=>f.discussion[0].points[0].reviewFlagIds=['warning']],
 ['reviewer row',f=>f.discussion[0].points[1].reviewerAuthored=true],
 ['reviewer topic',f=>f.discussion[0].reviewerAuthored=true],
 ['manual identity',f=>f.discussion[0].points[1].id='manual-unique'],
 ['unknown metadata',f=>f.discussion[0].points[0].unknown='keep'],
 ['original children',f=>f.discussion[0].points[1].supportingDetails=[{id:'child',text:'Keep this unique detail.',evidenceIds:['T0001']}]],
 ['survivor children',f=>f.discussion[0].points[0].supportingDetails=[{id:'child',text:'Keep this unique detail.',evidenceIds:['T0001']}]],
 ['question',f=>f.discussion[0].points[1].text+='?'],
 ['condition anywhere',f=>f.discussion[0].points[0].text+=' Only if funding is approved.'],
 ['split governing condition',f=>f.discussion[0].points[0].text='If approved; '+f.discussion[0].points[0].text],
 ['different topic',f=>f.discussion.push({topic:'Other',points:[f.discussion[0].points.pop()]} )],
 ['duplicate row identity',f=>f.discussion[0].points[1].id='full'],
 ['duplicate source identity',f=>f.sourceUnits.push({...f.sourceUnits[0]})],
 ['missing evidence',f=>f.discussion[0].points[1].evidenceIds=['missing']],
 ['source overflow',f=>f.sourceUnits[0].text='x'.repeat(12001)]
])test('protected nomination: '+name,async()=>{
 const f=fixture();mutate(f);let calls=0;
 const result=await M.consolidate(f.discussion,f.sourceUnits,{inventory:async()=>{calls++;throw Error('unexpected');}});
 assert.equal(result.audit.applied,false);assert.equal(result.audit.reason,'no_candidates');assert.equal(calls,0);assert.deepEqual(result.discussion,f.discussion);
});
for(const [name,stage,mutate]of[
 ['missing claim','inventory',r=>r.results[0].claims=[]],
 ['invented original quote','inventory',r=>r.results[0].claims[0].originalQuote='The racks are safe.'],
 ['clipped survivor quote','inventory',r=>r.results[0].claims[0].survivorQuote='overloaded storage racks'],
 ['clipped source negation','inventory',r=>r.results[0].claims[0].sourceWitnesses[0].quote='overloaded storage racks'],
 ['unknown fields','inventory',r=>r.results[0].deleteDecision=true],
 ['missing original sentence','verify',r=>r.results[0].sentenceChecks=[]],
 ['duplicate sentence','verify',r=>r.results[0].sentenceChecks.push(r.results[0].sentenceChecks[0])],
 ['unsupported survivor','verify',r=>r.results[0].survivorSupported=false],
 ['different occurrence','verify',r=>r.results[0].sameOccurrence=false],
 ['contradiction elsewhere','verify',r=>r.results[0].noContradiction=false],
 ['lost unique meaning','verify',r=>r.results[0].claimChecks[0].retained=false],
 ['uninventoried assertion','verify',r=>r.results[0].sentenceChecks[0].allClaimsListed=false],
 ['unknown context donation','verify',r=>r.results[0].claimChecks[0].sourceWitnesses[0].sourceId='T9999'],
 ['stale proof','verify',r=>r.packetHash='different'],
 ['missing same-event proof','verify',r=>delete r.results[0].sameOccurrence]
])test('proof veto: '+name,async()=>{
 const f=fixture(),o=options(),base=o[stage];o[stage]=async(...args)=>{const response=await base(...args);mutate(response);return response;};
 const r=await M.consolidate(f.discussion,f.sourceUnits,o);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
test('negation governing the assertion cannot be clipped even by positive model replies',async()=>{
 const f=fixture();f.discussion[0].points[0].text='The core issue is not overloaded storage racks; the paint proposal does not address the problem.';
 f.sourceUnits[0].text=f.discussion[0].points[0].text;
 const r=await M.consolidate(f.discussion,f.sourceUnits,options());assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
test('changed source, reviewer edits, provider failure and shadow assessment retain all originals',async()=>{
 for(const mode of ['source','row','failure','shadow']){
  const f=fixture(),before=copy(f.discussion),o=options(),base=o.verify;
  if(mode==='shadow')o.shadow=true;
  o.verify=async(...args)=>{if(mode==='failure')throw Error('unavailable');if(mode==='source')f.sourceUnits[0].text+=' Changed.';if(mode==='row')f.discussion[0].points[0].text+=' Reviewer edit.';return base(...args);};
  const r=await M.consolidate(f.discussion,f.sourceUnits,o);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,before);
 }
});
test('one candidate maximum and audit chaining preserve earlier cleanup and unrelated reviewer work',async()=>{
 const f=fixture(),other=copy(f.discussion[0]);other.id='second';other.points.forEach(r=>r.id+='-2');f.discussion.push(other);
 assert.equal(M.prepare(f.discussion,f.sourceUnits,{maxCandidates:100}).candidates.length,1);
 const a=await M.consolidate(f.discussion,f.sourceUnits,options()),b=await M.consolidate(a.discussion,f.sourceUnits,options());
 const combined=M.combine(a,b,f.sourceUnits);assert.deepEqual(C.restore(combined.discussion,f.sourceUnits,combined.audit),f.discussion);
 const edited=copy(combined.discussion);edited[0].points[0].text+=' Reviewer changes.';assert.equal(C.canRestore(edited,f.sourceUnits,combined.audit),false);
 const stale=copy(b);stale.audit.inputHash='stale';assert.deepEqual(M.combine(a,stale,f.sourceUnits),a);
});

test('span indexes materialize exact immutable clauses and cannot carry a conflicting quote or invalid index',async()=>{
 for(const invalid of [false,'range','fraction','conflict']){
  const f=fixture(),o=options();
  for(const stage of ['inventory','verify']){
   const base=o[stage];o[stage]=async(...args)=>{const response=await base(...args);
    const groups=stage==='inventory'?[response.results[0].claims]:[response.results[0].claimChecks,response.results[0].sentenceChecks];
    for(const group of groups)for(const check of group){delete check.survivorQuote;check.survivorSpanIndex=0;}
    if(invalid&&stage==='inventory'){
     const claim=groups[0][0];if(invalid==='range')claim.survivorSpanIndex=50;if(invalid==='fraction')claim.survivorSpanIndex=0.5;if(invalid==='conflict')claim.survivorQuote='conflicting text';
    }return response;};
  }
  const result=await M.consolidate(f.discussion,f.sourceUnits,o);assert.equal(result.audit.applied,!invalid);
  if(!invalid)assert.equal(result.audit.ledger[0].checks.claimChecks[0].survivorQuote,f.discussion[0].points[0].text.split(';')[0]);
 }
});
test('independent witness allocation adds only explicitly checked full source units and preserves every original citation',async()=>{
 const f=fixture(),o=options();f.sourceUnits.push({id:'T0002',speaker:'Chair',text:'The racks are overloaded.'});
 const base=o.verify;o.verify=async(...args)=>{const r=await base(...args);r.results[0].survivorWitnesses.push({sourceId:'T0002',quote:f.sourceUnits[1].text});return r;};
 const result=await M.consolidate(f.discussion,f.sourceUnits,o);assert.equal(result.audit.applied,true);
 assert.deepEqual(result.discussion[0].points[0].evidenceIds,['T0001','T0002']);
 assert.deepEqual(result.audit.ledger[0].citationAllocation.originalEvidenceIds,['T0001']);
 assert.deepEqual(C.restore(result.discussion,f.sourceUnits,result.audit),f.discussion);
});
test('a citation allocation exceeding publication capacity stays rejected, without trimming witnesses',async()=>{
 const f=fixture(),o=options();
 for(let i=2;i<=13;i++)f.sourceUnits.push({id:'T'+String(i).padStart(4,'0'),speaker:'Chair',text:'The storage racks issue has supporting context '+i+'.'});
 const base=o.verify;o.verify=async(...args)=>{const r=await base(...args),first=r.results[0];
  first.survivorWitnesses=f.sourceUnits.slice(0,12).map(s=>({sourceId:s.id,quote:s.text}));
  first.claimChecks[0].sourceWitnesses=[{sourceId:'T0013',quote:f.sourceUnits[12].text}];return r;};
 const result=await M.consolidate(f.discussion,f.sourceUnits,o);assert.equal(result.audit.applied,false);assert.deepEqual(result.discussion,f.discussion);
});
test('a null retaining-span index on a genuine independent veto is retained as a veto, not a repair opportunity',async()=>{
 const f=fixture(),o=options(),base=o.verify;o.verify=async(...args)=>{const r=await base(...args),check=r.results[0].claimChecks[0];delete check.survivorQuote;check.survivorSpanIndex=null;check.retained=false;return r;};
 const result=await M.consolidate(f.discussion,f.sourceUnits,o);assert.equal(result.audit.reason,'coverage_rejected');assert.deepEqual(result.discussion,f.discussion);
});

test('malformed claim objects and malformed neighboring source text fail closed without throwing',async()=>{
 const f=fixture(),packet=M.prepare(f.discussion,f.sourceUnits),bad=inventory(packet);bad.results[0].claims=[null];
 assert.equal(M.inventories(packet,bad),null);
 const malformed=fixture();malformed.sourceUnits.push({id:'T0002',text:123});
 assert.equal(M.prepare(malformed.discussion,malformed.sourceUnits).candidates.length,0);
});
