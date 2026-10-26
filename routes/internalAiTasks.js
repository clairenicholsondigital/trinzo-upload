'use strict';
const express=require('express');
const {actor,scope,createStore}=require('../utils/internalAiTasks');
module.exports=function internalAiTasksRouter(store=createStore(require('../utils/db').query)) {
  const router=express.Router({mergeParams:true});
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    try {actor(req.authUser);scope(req.params.projectId);}
    catch(e){return res.status(e.statusCode).json({ok:false,error:e.message});}
    if (['POST','PATCH'].includes(req.method)&&!req.is('application/json')) return res.status(415).json({ok:false,error:'Send task changes as JSON.'});
    next();
  });
  const run=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){const code=e.statusCode||500;res.status(code).json({ok:false,error:code===500?'Tasks could not be loaded or saved. Please retry; contact support if the problem continues.':e.message});}};
  router.get('/access',run(async(req,res)=>{await store.access();res.json({ok:true,projectId:req.params.projectId});}));
  router.get('/',run(async(req,res)=>res.json({ok:true,...await store.list(req.query)})));
  router.post('/',run(async(req,res)=>res.status(201).json({ok:true,task:await store.create(req.body,req.authUser)})));
  router.get('/:taskId',run(async(req,res)=>res.json({ok:true,task:await store.get(req.params.taskId)})));
  router.patch('/:taskId',run(async(req,res)=>res.json({ok:true,task:await store.update(req.params.taskId,req.body,req.authUser)})));
  router.post('/:taskId/comments',run(async(req,res)=>res.status(201).json({ok:true,task:await store.comment(req.params.taskId,req.body,req.authUser)})));
  return router;
};
