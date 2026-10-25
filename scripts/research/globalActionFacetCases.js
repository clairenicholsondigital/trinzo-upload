'use strict';
const cases=structuredClone(require('./globalActionRegisterCases'));
for(const item of cases)item.expectedModelPass=item.expectedConsolidation||item.policyProtected;
function add(id,left,right,text,expectedModelPass,extra={}){
 const sources=[{id:`${id}-S1`,sequence:1,speaker:'Sam Lee',text}];
 const make=(action,index)=>({id:`${id}-${index}`,action,owners:['Sam Lee'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:sources.map(s=>s.id),reviewFlagIds:[],...(index===0?extra.left:extra.right)});
 cases.push({id,actions:[make(left,0),make(right,1)],sourceUnits:sources,expectedModelPass,
  expectedConsolidation:expectedModelPass&&!extra.policyProtected,policyProtected:extra.policyProtected===true,survivorIndex:extra.survivorIndex??0,heldOut:true});
}
add('heldout-register-entry','Update the equipment register with the latest calibration results.','Record the latest calibration results in the equipment register.','I will enter the latest calibration results into the equipment register. Updating that entry is the one task.',true);
add('heldout-separate-methods','Verify the seal pressure using the manual gauge.','Verify the seal pressure using the automated sensor.','I will verify the seal pressure twice: one check using the manual gauge and a separate check using the automated sensor. Both checks are required.',false);
add('heldout-conditional-branches','Email the supplier only if the pressure trial fails.','Call the engineer only if the pressure trial passes.','If the pressure trial fails I will email the supplier. If it passes I will instead call the engineer.',false);
add('heldout-rejected-history','Review the inspection register.','Review the inspection register.','I will review the inspection register. The previously suggested Friday deadline was withdrawn; no new date is agreed.',true,{left:{timingDecision:{status:'rejected',rejectedExactDates:[],rejectedWordings:['Friday']}},survivorIndex:1,policyProtected:true});
module.exports=cases;
