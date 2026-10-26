#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const {prepare,validate,apply,digest}=require('../utils/internalAiTaskImport');
async function main(){
  const[mode,file,...args]=process.argv.slice(2);
  if(mode==='prepare'&&file&&args.length===0){const plan=prepare(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify({plan,approvalHash:digest(plan)},null,2)+'\n');return;}
  if(mode!=='apply'||!file||args[0]!=='--approved-plan-sha256'||!args[1]||args[2]!=='--actor-user-id'||!/^\d+$/.test(args[3]||'')||args.length!==4)throw Error('Usage: prepare docs/CURRENT_PROJECT_STATUS.md | apply approved-plan.json --approved-plan-sha256 HASH --actor-user-id ID');
  const document=JSON.parse(fs.readFileSync(file,'utf8')),plan=document.plan||document;validate(plan);
  if(digest(plan)!==args[1])throw Error('Import approval hash does not match the plan.');
  require('dotenv').config({quiet:true});const {Pool}=require('pg');
  const pool=new Pool({connectionString:process.env.DATABASE_URL||undefined,host:process.env.PGHOST,port:process.env.PGPORT,database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD,connectionTimeoutMillis:5000});
  try{const user=(await pool.query('SELECT id AS "userId",full_name AS "fullName",email,role FROM auth_users WHERE id=$1 AND is_active=true',[args[3]])).rows[0];console.log(JSON.stringify(await apply(pool.query.bind(pool),plan,user,args[1])));}finally{await pool.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
