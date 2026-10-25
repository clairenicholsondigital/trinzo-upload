'use strict';
function response(data){return {requestId:data.requestId,decisions:[
 {kind:'source',rows:data.sourceRows.map(row=>({rowId:row.rowId,basis:row.rowId===data.selectedSurvivor?'commitment':'required_component',checks:row.requests.map(check=>({id:check.id,status:'supported',reason:'Synthetic contract fixture.',refs:data.sourceCatalog.filter(ref=>ref.field==='text').map(ref=>ref.id)}))}))},
 {kind:'retention',checks:data.retentionRequests.map(check=>({id:check.id,status:'retained',reason:'Synthetic contract fixture.',refs:[check.allowedRefs[0]]}))},
 {kind:'relationship',relation:'discarded_requirement_of_survivor',reason:'Synthetic contract fixture.',refs:data.sourceCatalog.filter(ref=>ref.field==='text').map(ref=>ref.id)}]};}
module.exports=response;
