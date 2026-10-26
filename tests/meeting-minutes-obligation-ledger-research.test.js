'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const L=require('../scripts/lib/minutes_obligation_ledger_research');
function fixture(){
 const input={sourceHash:'frozen-full-source-hash',meetingDate:'2026-10-26',
  sourceUnits:[{id:'T1',speaker:'Lee Chen',text:'Could you send the register to Sam, Nora?'},{id:'T2',speaker:'Nora Patel',text:'Yes, I will.'},{id:'T3',speaker:'Chair',text:'Some neighbouring background.'}],
  members:[{ref:'M1',focusEvidenceId:'T1',focusMode:'whole_unit',text:'A generated interpretation that must not bias the inventory.',candidateId:'private-1'},{ref:'M2',focusEvidenceId:'T2',focusMode:'whole_unit',text:'Another generated interpretation.',candidateId:'private-2'}]};
 const p=L.inventoryPacket(input),e={requestId:p.requestId,decisions:[{kind:'source_obligation_ledger',records:[{ref:'O1',sourceStatus:'outstanding',sourceSpans:[{unitId:'T1',quote:input.sourceUnits[0].text},{unitId:'T2',quote:input.sourceUnits[1].text}],reason:'Request accepted by the assignee.'}]}]};
 const cp=L.reviewPacket(p,e),ce={requestId:cp.requestId,decisions:[{kind:'source_ledger_completeness',memberChecks:p.members.map(m=>({memberRef:m.ref,verdict:'complete',sourceIds:['T1','T2'],reason:'The accepted request is accounted for.'})),recordChecks:[{recordRef:'O1',supported:true,sourceStatusCorrect:true,allQualifications:true,sourceIds:['T1','T2'],reason:'Same obligation and correct final status.'}]}]};
 return {input,p,e,cp,ce};
}
test('one obligation can represent request and acceptance without generated candidate text or duplicate context records',()=>{
 const {input,p,e,cp,ce}=fixture();
 assert.deepEqual(p.members.map(({ref,focusEvidenceId})=>({ref,focusEvidenceId})),[{ref:'M1',focusEvidenceId:'T1'},{ref:'M2',focusEvidenceId:'T2'}]);
 assert.equal(p.members[0].focus.quote,input.sourceUnits[0].text);
 assert.ok(!JSON.stringify(p).includes('generated interpretation'));
 assert.equal(L.inventoryError(p,e),'');assert.equal(e.decisions[0].records.length,1);
 assert.equal(L.reviewError(cp,ce),'');assert.equal(L.reviewAccepted(cp,ce),true);
 p.sourceUnits[0].text='Mutated copy';assert.notEqual(p.sourceUnits[0].text,input.sourceUnits[0].text);
});
test('changed source, focus, status or quoted inventory invalidates an existing packet',()=>{
 const {p,e,cp,ce}=fixture();
 for(const mutate of [v=>v.sourceUnits[0].text+=' changed',v=>v.members[0].focusEvidenceId='T2',v=>v.sourceHash='another-source']){
  const bad=structuredClone(p);mutate(bad);assert.equal(L.inventoryError(bad,e),'changed_inventory_packet');
 }
 const stale=structuredClone(cp);stale.inventory.records[0].sourceStatus='not_outstanding';
 assert.equal(L.reviewError(stale,ce),'changed_review_packet');assert.equal(L.reviewAccepted(stale,ce),false);
});
test('ambiguous source IDs, duplicate member refs and missing focus evidence cannot enter the inventory',()=>{
 const {input,e}=fixture();
 for(const mutate of [v=>v.sourceUnits.push(v.sourceUnits[0]),v=>v.members[1].ref='M1',v=>v.members[0].focusEvidenceId='absent']){
  const changed=structuredClone(input);mutate(changed);assert.throws(()=>L.inventoryPacket(changed));
 }
});
test('invented quotes, neighbour-only work and duplicate obligation refs remain blocked',()=>{
 const {p,e}=fixture();
 for(const mutate of [v=>v.decisions[0].records[0].sourceSpans[0].quote='invented',v=>v.decisions[0].records[0].sourceSpans=[{unitId:'T3',quote:'Some neighbouring background.'}],v=>v.decisions[0].records.push(v.decisions[0].records[0]),v=>v.decisions[0].records[0].sourceStatus='committed']){
  const bad=structuredClone(e);mutate(bad);assert.notEqual(L.inventoryError(p,bad),'');assert.throws(()=>L.reviewPacket(p,bad));
 }
});
test('completed and uncertain records retain explicit status for independent review without becoming current commitments',()=>{
 for(const status of ['not_outstanding','uncertain']){
  const {p,e}=fixture();e.decisions[0].records[0].sourceStatus=status;
  assert.equal(L.inventoryError(p,e),'');const review=L.reviewPacket(p,e);
  assert.equal(review.inventory.records[0].sourceStatus,status);
 }
});
test('an empty inventory still requires every original member to be independently checked',()=>{
 const {p,e,ce}=fixture();e.decisions[0].records=[];const cp=L.reviewPacket(p,e),response=structuredClone(ce);
 response.requestId=cp.requestId;response.decisions[0].recordChecks=[];
 assert.equal(L.reviewAccepted(cp,response),true);
 response.decisions[0].memberChecks.pop();assert.equal(L.reviewAccepted(cp,response),false);
});
test('missing, duplicated or foreign member and record checks cannot certify completeness',()=>{
 const {cp,ce}=fixture();
 for(const mutate of [v=>v.decisions[0].memberChecks.pop(),v=>v.decisions[0].memberChecks[1].memberRef='M1',v=>v.decisions[0].recordChecks=[],v=>v.decisions[0].recordChecks[0].recordRef='foreign',v=>v.decisions[0].memberChecks[0].sourceIds=['T2'],v=>v.decisions[0].recordChecks[0].sourceIds=['absent']]){
  const bad=structuredClone(ce);mutate(bad);assert.notEqual(L.reviewError(cp,bad),'');assert.equal(L.reviewAccepted(cp,bad),false);
 }
});
test('valid semantic vetoes stay valid vetoes, not formatting repairs or approval',()=>{
 const {cp,ce}=fixture();
 for(const field of ['supported','sourceStatusCorrect','allQualifications']){
  const veto=structuredClone(ce);veto.decisions[0].recordChecks[0][field]=false;
  assert.equal(L.reviewError(cp,veto),'');assert.equal(L.reviewAccepted(cp,veto),false);
 }
 const unresolved=structuredClone(ce);unresolved.decisions[0].memberChecks[1].verdict='unresolved';
 assert.equal(L.reviewError(cp,unresolved),'');assert.equal(L.reviewAccepted(cp,unresolved),false);
});
test('a neighbour-only record check cannot witness the focused work',()=>{
 const {cp,ce}=fixture();ce.decisions[0].recordChecks[0].sourceIds=['T3'];
 assert.equal(L.reviewError(cp,ce),'bad_record_check');
});
test('packets and evidence survive serialization without changing decisions or granting mutation authority',()=>{
 const {p,e,cp,ce}=fixture(),copy=x=>JSON.parse(JSON.stringify(x));
 assert.equal(L.inventoryError(copy(p),copy(e)),'');assert.equal(L.reviewAccepted(copy(cp),copy(ce)),true);
 assert.ok(!Object.keys(L).some(k=>/apply|merge|close|publish|save|ask/i.test(k)));
});

test('two clauses in one source turn have distinct verified spans and full context remains available',()=>{
 const text='I will write the letter, and I will take a photograph tomorrow.';
 const p=L.inventoryPacket({sourceHash:'full-source',sourceUnits:[{id:'T1',text}],members:[
  {ref:'M1',focusEvidenceId:'T1',focusQuote:'write the letter'},
  {ref:'M2',focusEvidenceId:'T1',focusQuote:'take a photograph tomorrow'}]});
 assert.equal(p.sourceUnits[0].text,text);
 assert.equal(p.members[0].focus.start,text.indexOf('write the letter'));
 assert.equal(p.members[1].focus.end,text.indexOf('take a photograph tomorrow')+'take a photograph tomorrow'.length);
 assert.notDeepEqual(p.members[0].focus,p.members[1].focus);
 const quote='take a photograph tomorrow';
 const response={requestId:p.requestId,decisions:[{kind:'source_obligation_ledger',records:[{ref:'R1',sourceStatus:'outstanding',sourceSpans:[{unitId:'T1',quote}],reason:'Separate photograph task.'}]}]};
 assert.equal(L.inventoryError(p,response),'');
 const onlyLetter=L.inventoryPacket({sourceHash:'full-source',sourceUnits:p.sourceUnits,members:[{ref:'M1',focusEvidenceId:'T1',focusQuote:'write the letter'}]});
 response.requestId=onlyLetter.requestId;
 assert.equal(L.inventoryError(onlyLetter,response),'neighbour_only_obligation');
});
test('generated descriptions, failed quotes and ambiguous occurrences never fall back to a whole turn',()=>{
 const input={sourceHash:'full-source',sourceUnits:[{id:'T1',text:'I will send it. I will send it.'}],members:[{ref:'M1',focusEvidenceId:'T1',text:'I will send it.'}]};
 assert.throws(()=>L.inventoryPacket(input),/explicit_focus_required/);
 for(const quote of ['', 'send it.', 'Generated summary', 'I WILL SEND IT.']){
  assert.throws(()=>L.inventoryPacket({...input,members:[{...input.members[0],focusQuote:quote}]}),/missing_or_ambiguous_focus_quote/);
 }
 assert.throws(()=>L.inventoryPacket({...input,members:[{...input.members[0],focusMode:'whole_unit',focusQuote:'I will send it.'}]}),/explicit_focus_required/);
 const p=L.inventoryPacket({...input,members:[{...input.members[0],focusMode:'whole_unit'}]});
 assert.equal(p.members[0].focus.quote,input.sourceUnits[0].text);
 const e={requestId:p.requestId,decisions:[{kind:'source_obligation_ledger',records:[{ref:'R1',sourceStatus:'uncertain',sourceSpans:[{unitId:'T1',quote:'send it.'}],reason:'Ambiguous repeated quote.'}]}]};
 assert.equal(L.inventoryError(p,e),'invented_or_ambiguous_source_span');
});
test('source offsets preserve UTF-16, Unicode spelling and whitespace without normalization',()=>{
 const text='😀 I will send José’s  résumé. Then I will archive it.';
 const quote='send José’s  résumé';
 const p=L.inventoryPacket({sourceHash:'full-source',sourceUnits:[{id:'T1',text}],members:[{ref:'M1',focusEvidenceId:'T1',focusQuote:quote}]});
 const focus=p.members[0].focus;
 assert.equal(text.slice(focus.start,focus.end),quote);
 assert.equal(focus.start,10);
 assert.throws(()=>L.inventoryPacket({sourceHash:'full-source',sourceUnits:[{id:'T1',text}],members:[{ref:'M1',focusEvidenceId:'T1',focusQuote:'send José’s résumé'}]}));
});
test('focus context retains preceding negation, subsequent withdrawal and a neighbouring literal directive',()=>{
 const text='I will not send the register. I will write the letter using the word hazard. Actually, cancel the letter.';
 const p=L.inventoryPacket({sourceHash:'full-source',sourceUnits:[{id:'T1',text}],members:[{ref:'M1',focusEvidenceId:'T1',focusQuote:'send the register'}]});
 assert.equal(p.sourceUnits[0].text,text);
 assert.equal(p.members[0].focus.quote,'send the register');
 const prompt=L.inventoryPrompt(p),reviewPrompt=L.reviewPrompt(L.reviewPacket(p,{requestId:p.requestId,decisions:[{kind:'source_obligation_ledger',records:[]}]}));
 assert.match(prompt,/negation outside the span/);
 assert.match(reviewPrompt,/clipped span must never discard a negation/);
 assert.equal(p.sourceUnits[0].text.includes('using the word hazard'),true);
});
test('a legacy response cannot be reused against the new exact-focus packet',()=>{
 const {input,p,e,cp,ce}=fixture();
 const legacy=structuredClone(p);legacy.version='source-obligation-ledger-v1';
 assert.equal(L.inventoryError(legacy,e),'changed_inventory_packet');
 const changed=L.inventoryPacket({...input,members:[{ref:'M1',focusEvidenceId:'T1',focusQuote:'send the register'}]});
 assert.notEqual(changed.requestId,p.requestId);
 assert.equal(L.inventoryError(changed,e),'incomplete_inventory');
 const oldReview=structuredClone(cp);oldReview.version='source-ledger-completeness-v1';
 assert.equal(L.reviewError(oldReview,ce),'changed_review_packet');
});
test('malformed provider records and spans fail validation without crashing the audit',()=>{
 const {p,e,cp,ce}=fixture();
 for(const record of [null,{...e.decisions[0].records[0],sourceSpans:[null]}]){
  const bad=structuredClone(e);bad.decisions[0].records=[record];
  assert.notEqual(L.inventoryError(p,bad),'');
 }
 const bad=structuredClone(ce);bad.decisions[0].memberChecks[0]=null;
 assert.equal(L.reviewError(cp,bad),'bad_member_check');
});
test('offline CLI preserves private artifacts, refuses overwrite and distinguishes veto from invalid evidence',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minutes-exact-focus-'));
 try{
  const {input,e}=fixture(),cli=path.resolve(__dirname,'../scripts/meeting_minutes_obligation_ledger_research.js');
  const write=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value));return file;};
  const run=(...args)=>cp.spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
  const inputFile=write('input.json',input),sourceDir=path.join(dir,'source'),reviewDir=path.join(dir,'review');
  assert.equal(run('prepare-source',inputFile,sourceDir).status,0);
  const packetFile=path.join(sourceDir,'source-packet.json'),packet=JSON.parse(fs.readFileSync(packetFile));
  assert.equal(fs.statSync(packetFile).mode&0o777,0o600);
  assert.equal(fs.statSync(sourceDir).mode&0o777,0o700);
  assert.equal(packet.members[0].focus.quote,input.sourceUnits[0].text);
  assert.equal(run('prepare-source',inputFile,sourceDir).status,1);
  const responseFile=write('inventory.json',e);
  assert.equal(run('prepare-review',packetFile,responseFile,reviewDir).status,0);
  const reviewFile=path.join(reviewDir,'review-packet.json'),review=JSON.parse(fs.readFileSync(reviewFile));
  const response={requestId:review.requestId,decisions:[{kind:'source_ledger_completeness',memberChecks:review.members.map(m=>({memberRef:m.ref,verdict:'unresolved',sourceIds:['T1','T2'],reason:'Unresolved source meaning.'})),recordChecks:[{recordRef:'O1',supported:false,sourceStatusCorrect:false,allQualifications:false,sourceIds:['T1','T2'],reason:'Cannot certify this record.'}]}]};
  let outcome=run('validate-review',reviewFile,write('veto.json',response));
  assert.equal(outcome.status,2);assert.equal(JSON.parse(outcome.stdout).automaticClosureAllowed,false);
  response.decisions[0].recordChecks=[];
  outcome=run('validate-review',reviewFile,write('invalid.json',response));
  assert.equal(outcome.status,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
