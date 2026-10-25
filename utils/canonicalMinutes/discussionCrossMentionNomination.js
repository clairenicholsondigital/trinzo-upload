'use strict';
// Comparison only: no relationship here authorises rewriting or deletion.
const safety=require('./discussionMergeSafety');
const {encodeViaWorker,cosine}=require('./semanticDedupe');
const future=/\b(?:will|shall|scheduled|tomorrow|yesterday|completed yesterday|has been completed|was completed|is now completed)\b/i;
const words=s=>new Set((s.toLowerCase().match(/[a-z]{4,}/g)||[]).filter(w=>!['that','with','from','this','there','were','have','been','will','would'].includes(w)));
async function nominate(discussion,sourceUnits,{eligible,encode}={}){
 const counts=safety.identityCounts(discussion),positions=new Map(),duplicate=new Set();
 sourceUnits.forEach((u,i)=>{if(positions.has(u.id))duplicate.add(u.id);positions.set(u.id,i);});
 const pairs=[];
 discussion.forEach((topic,ti)=>{if(safety.protectedTopic(topic))return;
  for(let ri=0;ri+1<(topic.points||[]).length;ri++){
   const a=topic.points[ri],b=topic.points[ri+1];
   if(!eligible(a)||!eligible(b)||counts.get(a.id)!==1||counts.get(b.id)!==1||future.test(a.text)||future.test(b.text)
    ||a.evidenceIds.some(id=>b.evidenceIds.includes(id)))continue;
   const ids=[...new Set([...a.evidenceIds,...b.evidenceIds])];
   if(ids.some(id=>duplicate.has(id)||!positions.has(id)))continue;
   const indices=ids.map(id=>positions.get(id));if(Math.max(...indices)-Math.min(...indices)>23)continue;
   const x=words(a.text),y=words(b.text),common=[...x].filter(w=>y.has(w)).length;
   const lexical=common/Math.max(1,Math.min(x.size,y.size));if(common<4||lexical<0.35)continue;
   pairs.push({rows:[{path:[ti,'points',ri],record:a},{path:[ti,'points',ri+1],record:b}],lexical});
  }
 });
 if(!pairs.length)return [];
 const texts=[...new Set(pairs.flatMap(p=>p.rows.map(r=>r.record.text)))];let vectors;
 try{vectors=await(encode||encodeViaWorker)(texts,{timeoutMs:4000});}catch{}
 const byText=new Map(texts.map((t,i)=>[t,vectors?.[i]]));
 return pairs.map(p=>({...p,semantic:cosine(...p.rows.map(r=>byText.get(r.record.text)))}))
  .filter(p=>p.semantic>=0.70||p.lexical>=0.82).sort((a,b)=>b.semantic+b.lexical-a.semantic-a.lexical).slice(0,1);
}
module.exports={nominate};
