'use strict';
const S=require('../../utils/canonicalMinutes/discussionActionSeparation');
function fixture(warned=true){
  const original='Morgan Taylor and Priya Shah discuss the need for Morgan Taylor to contact Sam Jones to clarify the calibration codes before the maintenance procedure can be documented.';
  const output="Morgan Taylor and Priya Shah noted unclear calibration codes requiring Sam Jones's clarification before the maintenance procedure can be documented.";
  const sourceUnits=[{id:'T0001',speaker:'Morgan Taylor',text:'The calibration codes need clarification before we document the maintenance procedure.'},
    {id:'T0002',speaker:'Priya Shah',text:'Morgan, please contact Sam Jones to clarify the calibration codes before we document the maintenance procedure.'},
    {id:'T0003',speaker:'Morgan Taylor',text:'Yes, I will contact Sam Jones to clarify the calibration codes before we document the maintenance procedure.'}];
  const discussion=[{topic:'Calibration codes',points:[{id:'mixed',text:original,evidenceIds:['T0001','T0002'],primaryEvidenceIds:['T0001','T0002'],reviewFlagIds:warned?['who']:[],supportingDetails:[]}],decisions:[],openQuestions:[]}];
  const actions=[{id:'action',action:'Contact Sam Jones to clarify the calibration codes before the maintenance procedure can be documented.',owners:['Morgan Taylor'],evidenceIds:['T0002','T0003'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}}];
  const reviewFlags=warned?[{id:'who',kind:'attribution',message:'Confirm Sam Jones as the recipient.',status:'open',correctionNote:'',evidenceIds:['T0002']}]:[];
  const witness=[{sourceId:'T0002',quote:sourceUnits[1].text}];
  const options={propose:async(_,p)=>({version:S.VERSION,packetHash:p.packetHash,results:p.candidates.map(c=>({id:c.id,decision:'rewrite',text:output,outputKind:'openQuestions',claims:[
    {id:'unknown',text:'The calibration codes need clarification before maintenance documentation.',kind:'discussion',originalQuote:original,sourceWitnesses:witness},
    {id:'followup',text:'Morgan contacts Sam for clarification before documentation.',kind:'follow_up',actionId:'action',originalQuote:original,sourceWitnesses:witness}
  ]}))}),verify:async(_,p,selected)=>({version:S.VERSION,packetHash:p.packetHash,results:selected.map(c=>({id:c.id,selectionHash:c.selectionHash,
    claimChecks:c.claims.map(ch=>({claimId:ch.id,supported:true,correctKind:true,retained:true,retainedQuote:ch.kind==='discussion'?output:actions[0].action,sourceWitnesses:witness})),
    originalChecks:[{sentenceIndex:0,allClaimsListed:true,retained:true}],outputChecks:[{sentenceIndex:0,supported:true,noNewClaims:true,noTaskRecap:true,sourceWitnesses:witness}],
    warningChecks:c.warnings.map(flag=>({flagId:flag.id,sameMeaning:true,stillApplicable:true,originalQuote:'Sam Jones',outputQuote:'Sam Jones'}))
  }))})};
  return{discussion,actions,sourceUnits,reviewFlags,output,options};
}
module.exports={fixture};
function pairedFixture(){
 const f=fixture();f.actions[0].action='Contact Sam Jones for review of the calibration codes before the maintenance procedure can be documented.';
 const corrected='Contact Sam Jones to clarify the calibration codes before the maintenance procedure can be documented.';
 const oldPropose=f.options.propose,oldVerify=f.options.verify;
 const claims=[{id:'operation',text:'Contact Sam Jones.',originalQuote:'Contact Sam Jones',disposition:'retain'},
 {id:'intent',text:'Review of calibration codes.',originalQuote:' for review of the calibration codes',disposition:'correct'},
 {id:'condition',text:'Before maintenance documentation.',originalQuote:' before the maintenance procedure can be documented.',disposition:'retain'}]
 .map(c=>({...c,sourceWitnesses:[{sourceId:'T0002',quote:f.sourceUnits[1].text}]}));
 f.options.propose=async(...args)=>{const r=await oldPropose(...args);r.results[0].actionRevision={actionId:'action',text:corrected,claims};return r;};
 f.options.verify=async(...args)=>{const r=await oldVerify(...args),row=r.results[0];row.claimChecks.find(ch=>ch.claimId==='followup').retainedQuote=corrected;
 row.actionClaimChecks=claims.map(ch=>({claimId:ch.id,originalSupported:ch.disposition==='retain',retainedOrCorrected:true,retainedQuote:corrected,sourceWitnesses:ch.sourceWitnesses}));
 row.actionOutputCheck={supported:true,sameWork:true,noNewWork:true,sameRoles:true,allOriginalClaimsListed:true,sourceWitnesses:[{sourceId:'T0002',quote:f.sourceUnits[1].text}]};return r;};
 f.correctedAction=corrected;return f;
}
module.exports.pairedFixture=pairedFixture;
