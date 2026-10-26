'use strict';
const F = require('../../utils/meetingMinutesActionPhaseCorrection');
module.exports = function provider(fixture, mutate=()=>{}) {
  return async prompt => {
    const data=JSON.parse(prompt.split('\nDATA\n').at(-1));
    const packet=data.packet||data, [broad,narrow]=['a','b'].map(id=>packet.originalActions.find(a=>a.id===id));
    const witness={sourceId:'T0003',quote:fixture.units.find(u=>u.id==='T0003').text};
    let result,part;
    if (data.selected) {
      part='verification'; const selected=data.selected;
      result={version:F.VERSION,packetHash:packet.packetHash,selectionHash:F.hash(selected),
        checks:Object.fromEntries(F.checks.map(k=>[k,true])),
        claimChecks:selected.claims.map(c=>({claimId:c.id,retainedOrCorrected:true,sourceSupportsPhase:true,sourceWitnesses:[witness]})),
        outputChecks:selected.rows.map(r=>({id:r.id,supported:true,sameOwner:true,correctPhase:true,noNewWork:true,sourceWitnesses:[witness]})),
        assignmentWitnesses:[witness]};
    } else {
      part='proposal';const rows=[
        {id:broad.id,phase:'later_addition',action:'Add thermal and flow-control considerations to the quality review checklist afterwards.'},
        {id:narrow.id,phase:'initial_handoff',action:'Tidy and share the quality review checklist for review.'}];
      result={version:F.VERSION,packetHash:packet.packetHash,decision:'correct',rows,
        claims:[
          {id:'c1',originalId:'a',originalQuote:'Update',outputId:'b',outputQuote:'Tidy',sourceWitnesses:[witness]},
          {id:'c2',originalId:'a',originalQuote:'share the quality review checklist',outputId:'b',outputQuote:'share the quality review checklist',sourceWitnesses:[witness]},
          {id:'c3',originalId:'a',originalQuote:'thermal and flow-control considerations',outputId:'a',outputQuote:'thermal and flow-control considerations',sourceWitnesses:[witness]},
          {id:'c4',originalId:'b',originalQuote:narrow.action,outputId:'b',outputQuote:rows[1].action,sourceWitnesses:[witness]}
        ],originalChecks:packet.originalActions.map(a=>({id:a.id,allClaimsListed:true}))};
    }
    mutate(part,result);return {result:{results:[result]}};
  };
};
