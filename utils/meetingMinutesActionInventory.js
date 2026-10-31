'use strict';

const B = require('./canonicalMinutes/discussionBoundedRewrite');
const crypto = require('node:crypto');

const clone = v => structuredClone(v);

const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
 ? Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,stable(v[k])])) : v;

const hash = v => crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

function readInventory(packet, raw) {
 if(!raw||!Array.isArray(raw.results))return null;
 const normalized=clone(raw);
 for(const result of normalized.results)for(const record of result.records||[]) {
  if(!Array.isArray(record.claims))return null;
  const ids=record.claims.map(c=>c?.id);
  if(ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length)return null;
  for(const claim of record.claims)claim.id='claim-'+hash([record.recordId,claim.id]).slice(0,24);
 }
 return B.inventories(packet,normalized);
}

module.exports = {
  readInventory,
  clone,
  hash,
  stable
};
