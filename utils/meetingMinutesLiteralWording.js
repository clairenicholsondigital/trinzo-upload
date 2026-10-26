'use strict';
// A narrow, necessary retention check for explicitly named words/terms and
// quoted phrases. No inferred requirements, synonym matching or merge authority.
const canonical=value=>String(value||'').normalize('NFKC').replace(/[’]/g,"'").replace(/\s+/gu,' ').trim().toLowerCase();
const wordEdge=/[\p{L}\p{N}\p{M}_]/u;
const references=new Set(['that','this','it','which','what','whatever','we','you','they','a','an','the','and','or']);
function requiredLiteralWording(value){
 const text=String(value||''),terms=[];
 const pattern=/\b(?:use|using|include|including)\s+the\s+(word|term|phrase)\s+/giu;
 for(const match of text.matchAll(pattern)){
  const before=text.slice(Math.max(0,match.index-50),match.index);
  // Prohibitions are not positive requirements to insert a word. They retain
  // the existing condition/negation checks instead of being inverted here.
  if(/\b(?:not|never|without|avoid|avoiding)\s*(?:(?:to|ever|again|actually)\s+)*$/iu.test(before))continue;
  const tail=text.slice(match.index+match[0].length),pairs={'"':'"','“':'”',"'":"'",'‘':'’'},close=pairs[tail[0]];
  let term='';
  if(close){
   for(let at=1;at<tail.length&&at<=130;at++){
    if(/[\r\n]/u.test(tail[at]))break;
    if(tail[at]!==close)continue;
    // An apostrophe inside a word does not terminate its surrounding quote.
    if(/[’']/u.test(close)&&wordEdge.test(tail[at-1]||'')&&wordEdge.test(tail[at+1]||''))continue;
    if(wordEdge.test(tail[at+1]||''))break;
    term=tail.slice(1,at);break;
   }
  }else if(match[1].toLowerCase()!=='phrase'){
   const token=tail.match(/^[\p{L}\p{N}]+(?:[-_’'][\p{L}\p{N}]+)*/u)?.[0];
   if(token&&!references.has(canonical(token))&&/^\s*(?:[.,;!?]|$|\b(?:and|in|on|for|because|when|after|before)\b)/iu.test(tail.slice(token.length)))term=token;
  }
  term=canonical(term);
  if(term&&term.length<=128&&!terms.includes(term))terms.push(term);
 }
 return terms;
}
function containsLiteralWording(value,term){
 const text=canonical(value),literal=canonical(term);
 if(!literal)return false;
 for(let at=text.indexOf(literal);at>=0;at=text.indexOf(literal,at+1)){
  const left=[...text.slice(0,at)].at(-1)||'',right=[...text.slice(at+literal.length)][0]||'';
  if(!wordEdge.test(left)&&!wordEdge.test(right))return true;
 }
 return false;
}
function missingRequiredLiteralWording(original,target){return requiredLiteralWording(original).filter(term=>!containsLiteralWording(target,term));}
module.exports={requiredLiteralWording,containsLiteralWording,missingRequiredLiteralWording};
