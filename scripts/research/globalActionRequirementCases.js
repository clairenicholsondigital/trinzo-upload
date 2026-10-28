'use strict';
const cases=structuredClone(require('./globalActionFacetCases'));
function add(id,fuller,other,text,expectedModelPass){
 const sourceUnits=[{id:id+'-S1',sequence:1,speaker:'Sam Lee',text}];
 const make=(action,i)=>({id:id+'-'+i,action,owners:['Sam Lee'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:[sourceUnits[0].id],reviewFlagIds:[]});
 cases.push({id,actions:[make(fuller,0),make(other,1)],sourceUnits,expectedModelPass,expectedConsolidation:expectedModelPass,policyProtected:false,survivorIndex:0,heldOut:true,newRequirementHoldout:true});
}
add('new-notice-content','Prepare the safety notice including evacuation routes and the assembly point.','Include the assembly point in the safety notice.','I will prepare the safety notice. It needs to include the evacuation routes and the assembly point.',true);
add('new-notice-separate-review','Prepare the safety notice including evacuation routes and the assembly point.','Review the assembly point arrangements with facilities.','I will prepare the safety notice with the evacuation routes and assembly point. I will also meet facilities separately to review the assembly point arrangements.',false);
add('new-register-content','Compile the monthly invoice register with missing invoice numbers flagged.','Flag missing invoice numbers in the monthly invoice register.','I will compile the monthly invoice register and flag missing invoice numbers in that register as part of compiling it.',true);
add('new-register-separate-request','Compile the monthly invoice register with missing invoice numbers flagged.','Request missing invoices from the supplier.','I will compile the monthly register and flag missing invoice numbers in it. I will separately request the missing invoices from the supplier.',false);
add('new-release-content','Write the release notes describing the known limitations.','Describe the known limitations in the release notes.','I will write the release notes. They need to describe the known limitations.',true);
add('new-release-separate-presentation','Write the release notes describing the known limitations.','Explain the known limitations to customers in a webinar.','I will write the release notes describing the known limitations. I will also present a separate customer webinar to explain those limitations.',false);
module.exports=cases;
