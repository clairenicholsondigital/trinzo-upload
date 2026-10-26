'use strict';
// Offline planning only. Never writes data or runs during report generation.
const { isDeepStrictEqual: same } = require('node:util');
const clone = value => JSON.parse(JSON.stringify(value));
const rules = [
  { section:'milestones', identity:'milestone', metadata:['trend'], enums:{delivery_status:['','not_started','on_track','at_risk','delayed','blocked','completed','unknown'],agreed_rag_status:['','on_track','at_risk','off_track','blocked','completed','green','amber','red']} },
  { section:'risks', identity:'riskTitle', metadata:['confidence'], enums:{} },
  { section:'healthAreas', metadata:[], enums:{status:['','on_track','at_risk','off_track','blocked','completed','green','amber','red'],trend:['','stable','improving','deteriorating','replanned','new_update','unknown']} }
];
function planRecovery(report) {
  if (report.reportStatus !== 'draft') throw Error('Historical editor recovery requires an unapproved draft.');
  const versions=[...(report.versions||[])].sort((a,b)=>a.versionNumber-b.versionNumber),latest=versions.at(-1);
  if (!latest?.payload?.projectReport) throw Error('No report version available.');
  const output=clone(latest.payload.projectReport),changes=[],blocked=[];
  for(let v=0;v<versions.length-1;v++) {
    const before=versions[v].payload?.projectReport||{},after=versions[v+1].payload?.projectReport||{};
    if(!['user_edit','autosave'].includes(versions[v+1].changeType))continue;
    for(const rule of rules) {
      const entries=rule.identity?(before[rule.section]||[]).map(row=>[row[rule.identity],row]):Object.entries(before[rule.section]||{});
      const find=(data,id)=>rule.identity?(data[rule.section]||[]).filter(row=>row[rule.identity]===id):data[rule.section]?.[id]?[data[rule.section][id]]:[];
      for(const [identity,old] of entries) {
        if(!identity)continue;
        const lostRows=find(after,identity),nowRows=find(latest.payload.projectReport,identity),sourceRows=find(before,identity);
        if(sourceRows.length!==1||lostRows.length!==1||nowRows.length!==1) { blocked.push({section:rule.section,identity,reason:'Ambiguous or removed row identity'});continue; }
        const lost=lostRows[0],now=nowRows[0],target=find(output,identity)[0];
        const removed=rule.metadata.filter(key=>Object.hasOwn(old,key)&&!Object.hasOwn(lost,key)&&!Object.hasOwn(now,key));
        const blanked=Object.entries(rule.enums).filter(([key,allowed])=>old[key]&&!allowed.includes(old[key])&&lost[key]===''&&now[key]==='').map(([key])=>key);
        const candidates=[...removed,...blanked].filter(key=>!Object.hasOwn(target,key)||target[key]==='');
        if(!candidates.length)continue;
        // Require no later row edits, and no simultaneous meaning change at loss.
        const expected=clone(old);
        for(const key of rule.metadata)if(!Object.hasOwn(lost,key))delete expected[key];
        for(const key of blanked)expected[key]='';
        if(rule.section==='healthAreas'&&!Object.hasOwn(expected,'evidenceNotes'))expected.evidenceNotes=(old.evidence||[]).map(e=>e.text||e.source||'').filter(Boolean).join('\n');
        if(!same(lost,now)||!same(expected,lost)) { blocked.push({section:rule.section,identity,fields:candidates,reason:'Other row changes require reviewer judgement'});continue; }
        for(const key of candidates) {target[key]=clone(old[key]);changes.push({section:rule.section,identity,field:key,value:clone(old[key]),sourceVersionId:versions[v].versionId});}
      }
    }
  }
  return {reportId:report.reportId,baseVersionId:latest.versionId,baseVersionNumber:latest.versionNumber,projectReport:output,changes,blocked};
}
module.exports={planRecovery};
