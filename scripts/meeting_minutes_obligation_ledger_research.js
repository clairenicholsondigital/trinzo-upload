#!/usr/bin/env node
'use strict';
// Offline preparation/validation only. This command never contacts a provider
// or modifies the library, production cache, actions or review decisions.
const fs=require('node:fs'),path=require('node:path');
const L=require('./lib/minutes_obligation_ledger_research');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function write(dir,name,value){fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,name),value,{flag:'wx',mode:0o600});}
function json(value){return JSON.stringify(value,null,2)+'\n';}
try{
 const [mode,...args]=process.argv.slice(2);
 if(mode==='prepare-source'&&args.length===2){
  const p=L.inventoryPacket(read(args[0]));
  // Check input without claiming that an empty invented response is evidence.
  const error=L.inventoryError(p,{requestId:p.requestId,decisions:[{kind:'source_obligation_ledger',records:[]}]});
  if(error)throw Error(error);
  write(args[1],'source-packet.json',json(p));write(args[1],'source-prompt.txt',L.inventoryPrompt(p));
  process.stdout.write(json({prepared:true,requestId:p.requestId,automaticClosureAllowed:false}));
 }else if(mode==='prepare-review'&&args.length===3){
  const p=L.reviewPacket(read(args[0]),read(args[1]));
  write(args[2],'review-packet.json',json(p));write(args[2],'review-prompt.txt',L.reviewPrompt(p));
  process.stdout.write(json({prepared:true,requestId:p.requestId,automaticClosureAllowed:false}));
 }else if(mode==='validate-review'&&args.length===2){
  const p=read(args[0]),e=read(args[1]),error=L.reviewError(p,e),complete=!error&&L.reviewAccepted(p,e);
  process.stdout.write(json({valid:!error,complete,error:error||null,automaticClosureAllowed:false}));
  process.exitCode=error?1:complete?0:2;
 }else throw Error('Usage: prepare-source input.json output-dir | prepare-review source-packet.json inventory-response.json output-dir | validate-review review-packet.json review-response.json');
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
