'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{EventEmitter}=require('node:events');
test('only an explicit Agent prepared-stage option enables parallel short repairs',async()=>{
 const filename=path.resolve(__dirname,'../utils/stagedMiniLmTrooper.js'),mod=new Module(filename,module),seen=[];
 mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));const load=mod.require.bind(mod);
 mod.require=name=>name==='child_process'?{spawn:(_bin,_args,options)=>{
  seen.push([options.env.STAGED_ACTION_SHORT_REPAIR_CONCURRENCY,options.env.STAGED_ACTION_SELECTOR_BATCH_CONCURRENCY]);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
  setImmediate(()=>{child.stdout.emit('data',JSON.stringify({actions:[],turnCount:1}));child.emit('close',0);});return child;
 }}:load(name);
 mod._compile(fs.readFileSync(filename,'utf8'),filename);
 const original=process.env.STAGED_ACTION_SHORT_REPAIR_CONCURRENCY,selector=process.env.STAGED_ACTION_SELECTOR_BATCH_CONCURRENCY;
 await mod.exports.generatePreparedTrooperStage('actions','Reviewer   0:00 Please send the report.');
 await mod.exports.generatePreparedTrooperStage('actions','Reviewer   0:00 Please send the report.',{shortRepairConcurrency:3});
 await mod.exports.generatePreparedTrooperStage('actions','Reviewer   0:00 Please send the report.',{shortRepairConcurrency:99});
 await mod.exports.generatePreparedTrooperStage('actions','Reviewer   0:00 Please send the report.',{shortRepairConcurrency:3,selectorBatchConcurrency:2});
 assert.deepEqual(seen,[[original,selector],['3',selector],[original,selector],['3','2']]);assert.equal(process.env.STAGED_ACTION_SELECTOR_BATCH_CONCURRENCY,selector);assert.equal(process.env.STAGED_ACTION_SHORT_REPAIR_CONCURRENCY,original);
});
