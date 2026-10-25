'use strict';

// The provider chooses references and clause/source mappings. Immutable row
// text, hashes, protected fields and exact quote offsets are server facts, not
// generative tasks. Expansion never fills a missing member or clause mapping.
function materializeSemanticDecisions(packet, response, stage) {
  const rows=new Map(packet.rows.map(row=>[row.ref,row]));
  const units=new Map();
  for(const unit of packet.sourceUnits || []) {
    if(units.has(unit.id)) units.set(unit.id,null); else units.set(unit.id,unit);
  }
  function spans(ids) {
    if(!Array.isArray(ids) || !ids.length || new Set(ids).size!==ids.length) return null;
    const selected=ids.map(id=>units.get(id));
    if(selected.some(unit=>!unit || !String(unit.text || '').trim())) return null;
    return selected.map(unit=>({unitId:unit.id,start:0,end:String(unit.text).length,quote:String(unit.text)}));
  }
  function expand(proof) {
    if(stage==='actions') {
      if(proof&&typeof proof==='object'){proof={...proof};delete proof.containedRequirement;delete proof.qualifiedDependency;delete proof.contactParaphrase;}
      if(proof?.semanticProof) {
        const copied=structuredClone(proof);
        delete copied.containedRequirement;delete copied.qualifiedDependency;delete copied.contactParaphrase;
        if(Array.isArray(copied.semanticProof.clauses)) copied.semanticProof.clauses=copied.semanticProof.clauses.map(mapping=>{
          if(!mapping || typeof mapping!=='object') return mapping;
          const {sourceOperationReview: _untrustedReview,...rest}=mapping; return rest;
        });
        return copied;
      }
      const original=rows.get(proof?.originalRef),survivor=rows.get(proof?.survivorRef);
      const sourceSpans=spans(proof?.sourceIds);
      if(!original || !survivor || !sourceSpans || !Array.isArray(proof?.clauseMap)) return proof;
      const clauses=proof.clauseMap.map(mapping=>{
        const originalClause=original.clauses[mapping?.originalClauseIndex];
        const survivorClause=survivor.clauses[mapping?.survivorClauseIndex];
        const source=spans(mapping?.sourceIds);
        if(typeof originalClause!=='string' || typeof survivorClause!=='string' || !source) return null;
        const words=value=>String(value).normalize('NFKC').replace(/[’]/g,"'").replace(/\s+/g,' ').trim().toLowerCase()
          .replace(/(\w)-(\w)/g,'$1 $2').match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)?|[£€$%°<>≤≥]/gu) || [];
        const from=words(originalClause),to=words(survivorClause);
        return {originalClause,survivorClause,facets:{operation:{original:from[0] || '',survivor:to[0] || '',sourceSpans:source},
          object:{original:from.slice(1).join(' '),survivor:to.slice(1).join(' '),sourceSpans:source}}};
      });
      if(clauses.some(clause=>!clause)) return proof;
      return {originalRef:original.ref,survivorRef:survivor.ref,sourceSpans,
        semanticProof:{originalAction:original.action.action,survivorAction:survivor.action.action,
          originalFacets:original.facets,survivorFacets:survivor.facets,clauses}};
    }
    if(proof?.protectedFacets) return proof;
    const original=rows.get(proof?.fromRef),survivor=rows.get(proof?.toRef),sourceSpans=spans(proof?.sourceIds);
    if(!original || !survivor || !sourceSpans || !Array.isArray(proof?.clauseMap)) return proof;
    const clauseMap=proof.clauseMap.map(mapping=>({fromClauseId:mapping?.fromClauseId,toClauseIds:mapping?.toClauseIds,
      sourceSpans:spans(mapping?.sourceIds)}));
    if(clauseMap.some(mapping=>!mapping.sourceSpans)) return proof;
    return {fromRef:original.ref,toRef:survivor.ref,sourceSpans,protectedFacets:original.protectedFacets,
      preservedFacets:['subject','predicate','object','actors','recipients','quantities','units','polarity','modality','conditions',
        'dependencies','temporalOccurrence','questionAnswerRole','causality'],clauseMap};
  }
  return {...response,decisions:(response.decisions || []).map(decision=>{
    if(!['equivalent','left_covered_by_right','right_covered_by_left'].includes(decision.relation)) return decision;
    return {...decision,...(Array.isArray(decision.coverage)?{coverage:decision.coverage.map(expand)}:{})};
  })};
}
module.exports={materializeSemanticDecisions};
