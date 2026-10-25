'use strict';
// Synthetic qualification cases only. No transcript-specific production rules.
const make = (id, action, extra={}) => ({ id, action, owners:['Sam Lee'],
  timing:{kind:'not_stated',wording:'',exactDate:''}, evidenceIds:[], reviewFlagIds:[], ...extra });
const cases=[];
function add(id, left, right, text, allow, extra={}) {
 const sourceUnits=(Array.isArray(text)?text:[text]).map((text,i)=>({id:`${id}-S${i+1}`,sequence:i+1,speaker:'Sam Lee',text}));
 const actions=[make(`${id}-left`,left,extra.left),make(`${id}-right`,right,extra.right)].map(a=>({...a,evidenceIds:sourceUnits.map(s=>s.id)}));
 cases.push({id,actions,sourceUnits,expectedConsolidation:allow,survivorIndex:extra.survivorIndex??0,policyProtected:extra.policyProtected===true});
}
add('reordered-same-work','Send the updated equipment list to Riley Park.','Send Riley Park the updated equipment list.','I will send Riley Park the updated equipment list.',true);
add('content-within-deliverable','Draft the renewal notice explaining the annual fee increase from £20 to £24 effective January.','Explain the annual fee increase in the renewal notice.','I will draft the renewal notice and explain in that notice that the annual fee rises from twenty pounds to twenty-four pounds effective January. There is no separate explanation task.',true);
add('same-driver-deliverable','Complete the outstanding language support by generating drivers for the remaining languages.','Resolve the remaining language-character issues by generating those language drivers.','I will generate the drivers for all remaining languages to resolve the missing characters. That is the remaining language support work; it is one driver deliverable.',true);
add('same-dependency','Generate the remaining display drivers.','Generate drivers for the outstanding display languages.','I will generate the remaining display-language drivers once IT grants access to the creation tool.',true,{left:{timing:{kind:'dependency',wording:'After IT grants access to the creation tool.',exactDate:''}},right:{timing:{kind:'dependency',wording:'After IT grants access to the creation tool.',exactDate:''}}});
add('review-vs-send','Review the supplier register.','Send the supplier register to Riley Park.','I will review the supplier register, then send the register to Riley Park. Both steps need doing.',false);
add('buy-vs-fit','Buy the replacement pump.','Fit the replacement pump.','I will buy a replacement pump and then fit it. Track purchase and fitting separately.',false);
add('prepare-vs-approve','Prepare the inspection report.','Approve the inspection report.','I will prepare the inspection report and separately approve it after the checks have been completed.',false);
add('different-recipients','Send the inspection report to Riley Park.','Send the inspection report to Taylor Green.','I will send the inspection report to Riley Park and separately send it to Taylor Green.',false);
add('different-deadlines','Review the safety register.','Review the safety register.','I will review the safety register on Monday and perform a separate review on Friday.',false,{left:{timing:{kind:'target',wording:'Monday',exactDate:''}},right:{timing:{kind:'target',wording:'Friday',exactDate:''}}});
add('lost-dependency','Generate the display drivers.','Generate the display drivers after IT grants access.','I will generate the display drivers, but only after IT grants access. Do not treat this as an unconditional instruction.',false);
add('different-quantities','Order four replacement seals.','Order six replacement seals.','I will place one order for four replacement seals for the west unit and another order for six for the east unit.',false);
add('lost-condition','Book the inspection.','Book the inspection only if the trial fails.','If the trial fails, I will book the inspection. Otherwise no inspection is needed.',false);
add('different-scope','Review the entire supplier register.','Review only the three overdue supplier entries.','I will review the entire supplier register and separately recheck the three overdue entries after their documents arrive.',false);
add('separate-occurrences','Send the status report.','Send the status report.','I will send a status report for the morning shift and a separate status report for the evening shift.',false,{left:{occurrenceId:'morning-shift',timing:{kind:'target',wording:'After the morning shift',exactDate:''}},right:{occurrenceId:'evening-shift',timing:{kind:'target',wording:'After the evening shift',exactDate:''}}});
add('different-owners','Review the inspection checklist.','Review the inspection checklist.','I will review the inspection checklist independently from Riley Park.',false,{right:{owners:['Riley Park']}});
// Give the second owner their own explicit turn rather than infer joint work.
cases.at(-1).sourceUnits.push({id:'different-owners-S2',sequence:2,speaker:'Riley Park',text:'I will do my own independent review of the inspection checklist.'});
cases.at(-1).actions.forEach(a=>a.evidenceIds.push('different-owners-S2'));
add('lost-uncertainty','Contact the supplier.','Consider contacting the supplier if the fault returns.','I might contact the supplier if the fault returns. I am not committing to contact them now.',false);
add('corrected-quantity','Order five replacement seals.','Order eight replacement seals.',['I will order five replacement seals.','Correction: make that eight seals, not five. The earlier quantity is withdrawn.'],false);
add('ambiguous-acceptance','Review the calibration report.','Review the validation report.',['The calibration report and the validation report both need attention.','I will look at that one, but I have not said which report.'],false);
add('content-vs-separate-conversation','Draft the renewal notice explaining the annual fee increase.','Explain the annual fee increase to members in a separate phone call.','I will draft the renewal notice with the fee explanation, and I will also call the members separately to explain the change. The phone call is separate work.',false);
add('effective-date-vs-deadline','Draft the renewal notice explaining the fee increase effective January.','Draft the renewal notice by January.','I will draft the renewal notice. The fee increase takes effect in January; January is not a deadline for writing the notice.',false,{right:{timing:{kind:'target',wording:'by January',exactDate:''}}});
add('recipient-within-content','Draft the report describing the supplier response.','Send the report to the supplier.','I will draft the report describing what the supplier said, and later send the report to the supplier as a separate step.',false);
add('reviewer-protected','Send the updated register to Riley Park.','Send Riley Park the updated register.','I will send Riley Park the updated register.',false,{left:{reviewerAuthored:true},policyProtected:true});
module.exports=cases;
