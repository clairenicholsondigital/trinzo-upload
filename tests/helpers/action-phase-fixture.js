'use strict';
const V=require('../../utils/meetingMinutesAgentV2');
module.exports=function fixture(){
 const units=V.normaliseSourceUnits([
  {id:'T0001',speaker:'Morgan Lee',text:'The quality review checklist needs thermal and flow-control considerations.'},
  {id:'T0002',speaker:'Casey Green',text:'What do we need to do to progress that?'},
  {id:'T0003',speaker:'Morgan Lee',text:"I am in the middle of tidying up the quality review checklist to share with the team for review and then I will add those considerations."},
  {id:'T0004',speaker:'Morgan Lee',text:"I am hoping done for Tuesday for our review meeting."}
 ]);
 const row=(id,action,wording,refs)=>({id,action,owners:['Morgan Lee'],evidenceIds:refs,reviewFlagIds:[id+'-source',id+'-date',id+'-binding'],
  timing:{kind:'target',wording,exactDate:''},timingDecision:{version:4,status:'rejected',checkerStatus:'rejected',
   reason:'timing_source_unresolved',rejectedExactDates:['2026-06-16'],rejectedWordings:[]}});
 const actions=[row('a','Update and share the quality review checklist including thermal and flow-control considerations.','for Tuesday',['T0001','T0003','T0004']),
  row('b','Complete the quality review checklist updates and share the updated material for review.','hoping done for Tuesday',['T0003','T0004'])];
 return {actions,units};
};
