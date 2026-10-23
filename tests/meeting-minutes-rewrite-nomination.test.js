'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const B=require('../utils/canonicalMinutes/discussionBoundedRewrite');
const C=require('../utils/canonicalMinutes/discussionClaimConsolidation');
const a='The team planned supplier upload oversight and clear registration responsibilities, with a documented plan.';
const b='The team planned supplier upload oversight and clear registration responsibilities; a gap could remain if audited.';
const output='The team planned supplier upload oversight and clear registration responsibilities, with a documented plan; a gap could remain if audited.';
const encode=async texts=>texts.map(()=>[1,0]);
function fixture(){
 const sources=Array.from({length:30},(_,i)=>({id:'U'+i,speaker:'Morgan Lee',text:'Adjacent source context.'}));
 sources[8].text=a;sources[9].text='A gap could remain if audited.';
 const record=(id,text)=>({id,text,evidenceIds:['U8','U9'],reviewFlagIds:[],supportingDetails:[]});
 return {discussion:[{id:'topic',topic:'Supplier registration',points:[record('left',a),record('right',b)],decisions:[],openQuestions:[]}],sources};
}
const opts={partialOverlap:true,encode};
const witnesses=c=>c.sourceUnits.filter(s=>['U8','U9'].includes(s.id)).map(s=>({sourceId:s.id,quote:s.text}));
const inventory=p=>({version:B.VERSION,packetHash:p.packetHash,results:p.candidates.map(c=>({id:c.id,decision:'inventory',
 records:c.rows.map((r,i)=>({recordId:r.record.id,claims:[{id:'claim'+i,text:r.record.text,originalQuote:r.record.text,sourceWitnesses:witnesses(c)}]}))}))});
const proposal=(p,listed,text=output)=>({version:B.VERSION,packetHash:p.packetHash,results:listed.map(c=>({id:c.id,decision:'rewrite',text}))});
const verification=(p,selected)=>({version:B.VERSION,packetHash:p.packetHash,results:selected.map(c=>({id:c.id,selectionHash:c.selectionHash,
 claimChecks:c.inventory.flatMap(r=>r.claims.map(claim=>({claimId:claim.id,supported:true,retained:true,outputQuote:c.text,sourceWitnesses:witnesses(c)}))),
 originalChecks:c.rows.flatMap(r=>r.sentences.map((_,sentenceIndex)=>({recordId:r.record.id,sentenceIndex,allClaimsListed:true,supported:true,retained:true,sourceWitnesses:witnesses(c)}))),
 outputChecks:c.outputSentences.map((_,sentenceIndex)=>({sentenceIndex,supported:true,noNewClaims:true,sourceWitnesses:witnesses(c)}))}))});
function providers(extra={}){return {...opts,inventory:async(_,p)=>inventory(p),propose:async(_,p,listed)=>proposal(p,listed),verify:async(_,p,selected)=>verification(p,selected),...extra};}

test('partial overlap is opt-in and never changes existing-survivor deletion nomination',async()=>{
 const f=fixture();
 assert.equal((await B.prepare(f.discussion,f.sources,{encode})).candidates.length,0);
 assert.equal((await C.prepare(f.discussion,f.sources,{encode})).candidates.length,0);
 const p=await B.prepare(f.discussion,f.sources,opts);
 assert.equal(p.candidates.length,1);assert.equal(p.candidates[0].nominationKind,'partial_overlap');
 assert.equal((await C.prepare(f.discussion,f.sources,{encode})).candidates.length,0);
});
test('the complete bounded source exchange is supplied without becoming automatic output claims',async()=>{
 const f=fixture(),p=await B.prepare(f.discussion,f.sources,opts),c=p.candidates[0];
 assert.deepEqual(c.sourceUnits.map(s=>s.id),Array.from({length:18},(_,i)=>'U'+i));
 assert.deepEqual(c.metadata.evidenceIds,['U8','U9']);
 assert.equal(c.sourceUnits.some(s=>s.id==='U29'),false);
});
test('a fully verified partial rewrite preserves qualifications, originals and usable restoration',async()=>{
 const f=fixture(),original=structuredClone(f.discussion);
 const r=await B.consolidate(f.discussion,f.sources,providers());
 assert.equal(r.audit.applied,true);assert.equal(r.discussion[0].points.length,1);
 assert.equal(r.discussion[0].points[0].text,output);
 assert.equal(r.audit.ledger[0].nominationKind,'partial_overlap');
 assert.deepEqual(C.restore(r.discussion,f.sources,r.audit),original);
 assert.deepEqual(f.discussion,original);
});
for(const [label,text] of [['uncertainty',output.replace('could ','')],['audit condition',output.replace(' if audited','')],
 ['distinct plan detail',output.replace(', with a documented plan','')]])test('a model cannot approve loss of '+label,async()=>{
 const f=fixture();let checks=0;
 const r=await B.consolidate(f.discussion,f.sources,providers({propose:async(_,p,s)=>proposal(p,s,text),verify:async()=>{checks++;throw Error('Should not reach verifier');}}));
 assert.equal(checks,0);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
for(const [label,mutate] of [
 ['unsupported original',r=>{r.results[0].originalChecks[0].supported=false;}],
 ['unlisted qualification',r=>{r.results[0].originalChecks[1].allClaimsListed=false;}],
 ['lost distinct claim',r=>{r.results[0].claimChecks[0].retained=false;}],
 ['new adjacent-source claim',r=>{r.results[0].outputChecks[0].noNewClaims=false;}],
 ['unverified output',r=>{r.results[0].outputChecks[0].supported=false;}]
])test(label+' keeps both originals after independent review',async()=>{
 const f=fixture();
 const r=await B.consolidate(f.discussion,f.sources,providers({verify:async(_,p,s)=>{const v=verification(p,s);mutate(v);return v;}}));
 assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
for(const [label,mutate] of [
 ['different quantities',f=>{f.discussion[0].points[1].text+=' Five records remain.';}],
 ['different bounds',f=>{f.discussion[0].points[1].text+=' At most five records remain.';f.discussion[0].points[0].text+=' At least five records remain.';}],
 ['opposite polarity',f=>{f.discussion[0].points[1].text+=' The plan was not approved.';}],
 ['different phase',f=>{f.discussion[0].points[1].text+=' Uploads are completed.';}],
 ['single shared source',f=>{f.discussion[0].points[1].evidenceIds=['U9'];}],
 ['remote source span',f=>{f.discussion[0].points.forEach(r=>r.evidenceIds=['U8','U19']);}],
 ['nonadjacent records',f=>{f.discussion[0].points.splice(1,0,{id:'middle',text:'Independent delivery issue.',evidenceIds:['U25'],reviewFlagIds:[]});}],
 ['reviewer content',f=>{f.discussion[0].points[1].reviewerAuthored=true;}],
 ['review warning',f=>{f.discussion[0].points[1].reviewFlagIds=['warning'];}],
 ['nested content',f=>{f.discussion[0].points[1].supportingDetails=[{id:'child',text:'Keep context.',evidenceIds:['U8']}];}],
 ['unknown metadata',f=>{f.discussion[0].points[1].customState='retain';}],
 ['ambiguous source identity',f=>{f.sources.push({...f.sources[0]});}],
 ['duplicate record identity',f=>{f.discussion[0].points[1].id='left';}],
 ['oversized source context',f=>{f.sources[0].text='x'.repeat(12001);}],
 ['oversized total context',f=>{f.sources.forEach(s=>s.text+='x'.repeat(3000));}]
])test(label+' stays outside the new nomination path',async()=>{
 const f=fixture();mutate(f);
 const p=await B.prepare(f.discussion,f.sources,opts);
 assert.equal(p.candidates.filter(c=>c.nominationKind==='partial_overlap').length,0);
});
test('without usable embeddings the existing strict lexical threshold still applies',async()=>{
 const f=fixture();f.discussion[0].points[1].text='Supplier registration responsibilities were planned; upload oversight could leave a gap if audited.';
 assert.equal((await B.prepare(f.discussion,f.sources,{partialOverlap:true,encode:async()=>null})).candidates.length,0);
});
test('the new path cannot nominate more than one pair or bypass within-record-only mode',async()=>{
 const f=fixture();f.discussion.push({...structuredClone(f.discussion[0]),id:'other',points:f.discussion[0].points.map(r=>({...r,id:'other-'+r.id}))});
 assert.equal((await B.prepare(f.discussion,f.sources,opts)).candidates.filter(c=>c.nominationKind==='partial_overlap').length,1);
 assert.equal((await B.prepare(f.discussion,f.sources,{...opts,withinRecordOnly:true})).candidates.length,0);
});
test('failed services, changed sources and shadow mode preserve the input',async()=>{
 const f=fixture();
 const failed=await B.consolidate(f.discussion,f.sources,providers({inventory:async()=>{throw Error('Offline');}}));
 assert.deepEqual(failed.discussion,f.discussion);
 const shadow=await B.consolidate(f.discussion,f.sources,providers({shadow:true}));
 assert.deepEqual(shadow.discussion,f.discussion);assert.equal(shadow.audit.applied,false);
 assert.equal(shadow.audit.proposed[0].points.length,1);
 const changed=structuredClone(f.sources);
 const stale=await B.consolidate(f.discussion,changed,providers({verify:async(_,p,s)=>{const r=verification(p,s);changed[0].text+=' Changed.';return r;}}));
 assert.equal(stale.audit.reason,'stale_input');assert.deepEqual(stale.discussion,f.discussion);
});
