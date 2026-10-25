'use strict';
const V=require('../../utils/meetingMinutesAgentV2');
const sourceUnits=V.normaliseSourceUnits([{id:'T0001',speaker:'Sam Lee',text:'I will generate the validation reports to resolve the remaining dataset cleanup issues. This depends on obtaining access to the reporting service through the operations team.'}]);
const row=(id,action,full)=>({id,action,owners:['Sam Lee'],evidenceIds:['T0001'],reviewFlagIds:[],timing:{kind:'dependency',wording:'Dependent on obtaining access to the reporting service'+(full?' through the operations team':'')+'.',exactDate:''},timingDecision:{status:'unresolved',reason:'timing_source_unresolved',binding:{status:'unresolved',conflictingSourceIds:[]},meetingDate:'2026-10-25',rejectedExactDates:[],rejectedWordings:[]}});
const original=()=>[row('full','Resolve remaining dataset issues by generating the required validation reports.',true),row('short','Complete remaining dataset cleanup by generating the required validation reports.',false)];

module.exports={sourceUnits,original};
