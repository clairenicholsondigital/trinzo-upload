'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const O=require('../utils/canonicalMinutes/discussionOwnParentCoverage'),C=require('../utils/canonicalMinutes/discussionClaimConsolidation');
const parent='The maintenance team have not inspected the boundary wall for about four months, and a fallen section is considered a hazard.';
const child='The maintenance team have not inspected the boundary wall for approximately four months, and a section is down.';
const sourceUnits=[{id:'T0001',text:parent,speaker:'Alex Jones'}];
const fixture=()=>[{id:'topic',topic:'Maintenance',points:[{id:'parent',text:parent,evidenceIds:['T0001'],reviewFlagIds:[],supportingDetails:[{id:'child',text:child,evidenceIds:['T0001'],reviewFlagIds:[]}]}],decisions:[],openQuestions:[]}];
const childQuotes=[child.split(', and ')[0],'a section is down'];
const parentQuotes=[parent.split(', and ')[0],'a fallen section is considered a hazard'];
const witness=[{sourceId:'T0001',quote:parent}];
const wrap=(p,results)=>({version:O.VERSION,packetHash:p.packetHash,results});
const options=()=>({inventory:async(_,p)=>wrap(p,p.candidates.map(c=>({id:c.id,decision:'covered',claims:childQuotes.map((quote,i)=>({id:'c'+i,text:quote,childQuote:quote,parentQuote:parentQuotes[i],sourceWitnesses:witness}))}))),verify:async(_,p,selected)=>wrap(p,selected.map(c=>({id:c.id,claimChecks:c.claims.map((claim,i)=>({claimId:claim.id,supported:true,retained:true,parentQuote:parentQuotes[i],sourceWitnesses:witness})),sentenceChecks:[{sentenceIndex:0,allClaimsListed:true,supported:true,retained:true,parentQuote:parent,sourceWitnesses:witness}]})))});
test('atomic compound mapping removes only redundant child and restores exact records',async()=>{
 const d=fixture(),out=await O.consolidate(d,sourceUnits,options());assert.ok(out.audit.applied, out.audit.reason);assert.equal(out.discussion[0].points[0].text,parent);assert.equal(out.discussion[0].points[0].supportingDetails.length,0);assert.deepEqual(C.restore(out.discussion,sourceUnits,out.audit),d);
});
test('old whole-child-to-partial-parent mapping remains invalid',async()=>{
 const opts=options(),original=opts.inventory;opts.inventory=async(...args)=>{const r=await original(...args);r.results[0].claims.forEach(c=>c.childQuote=child);return r;};assert.equal((await O.consolidate(fixture(),sourceUnits,opts)).audit.applied,false);
});
for(const [name,mutate]of [
 ['partial sentence',r=>r.results[0].sentenceChecks[0].parentQuote=parentQuotes[0]],
 ['missing claim',r=>r.results[0].claimChecks.pop()],
 ['independent refusal',r=>r.results[0].sentenceChecks[0].allClaimsListed=false],
 ['unsupported claim',r=>r.results[0].claimChecks[1].supported=false]
])test(name+' retains complete original',async()=>{const d=fixture(),opts=options(),original=opts.verify;opts.verify=async(...args)=>{const r=await original(...args);mutate(r);return r;};const out=await O.consolidate(d,sourceUnits,opts);assert.equal(out.audit.applied,false);assert.deepEqual(out.discussion,d);});
for(const [name,change]of [
 ['unqualified duration',s=>s.replace('approximately ','')],['different duration',s=>s.replace('four','five')],['reversed polarity',s=>s.replace('not ','')],['unique quantity',s=>s.replace('a section','two sections')],['unique system',s=>s+' The ERP system is offline.'],['attributed child',s=>'Alex Jones reported that '+s[0].toLowerCase()+s.slice(1)]
])test(name+' cannot pass even with positive provider verdicts',async()=>{const d=fixture();d[0].points[0].supportingDetails[0].text=change(child);const opts=options(),original=opts.inventory;opts.inventory=async(...args)=>{const r=await original(...args);r.results[0].claims[0].childQuote=d[0].points[0].supportingDetails[0].text;return r;};const out=await O.consolidate(d,sourceUnits,opts);assert.equal(out.audit.applied,false);assert.deepEqual(out.discussion,d);});
test('prompt requests atomic inventory but independent full-sentence coverage',()=>{const p=O.prepare(fixture(),sourceUnits);assert.match(O.inventoryPrompt(p),/shortest exact contiguous child span/);const c=O.inventories(p,wrap(p,p.candidates.map(c=>({id:c.id,decision:'covered',claims:childQuotes.map((quote,i)=>({id:'c'+i,text:quote,childQuote:quote,parentQuote:parentQuotes[i],sourceWitnesses:witness}))}))));assert.equal(c.length,1);assert.match(O.verificationPrompt(p,c),/EVERY assertion and qualification of the COMPLETE child sentence/);});
