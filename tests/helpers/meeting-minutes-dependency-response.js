'use strict';
module.exports=data=>({requestId:data.requestId,decisions:[
 {kind:'source',rows:data.sourceRows.map(row=>({rowId:row.rowId,basis:'commitment',checks:row.requests.map(check=>({id:check.id,status:'supported',reason:'Synthetic dependency contract fixture.',refs:data.sourceCatalog.filter(ref=>ref.field==='text').map(ref=>ref.id)}))}))},
 {kind:'retention',checks:data.retentionRequests.map(check=>({id:check.id,status:'retained',reason:'Synthetic dependency contract fixture.',refs:check.field==='timing'?data.survivorCatalog.filter(ref=>['timing.kind','timing.wording'].includes(ref.field)).map(ref=>ref.id):[check.allowedRefs[0]]}))},
 {kind:'relationship',relation:'same_obligation',reason:'Synthetic dependency contract fixture.',refs:data.sourceCatalog.filter(ref=>ref.field==='text').map(ref=>ref.id)}]});
