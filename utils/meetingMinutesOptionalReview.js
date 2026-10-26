'use strict';
// Reviewer exclusion is occurrence/source bound; never an equivalence proof.
const { hash } = require('./meetingMinutesProofHash');
const clone = value => structuredClone(value);
function fingerprint(record, units = []) {
  if (!record || typeof record.text !== 'string' || !record.text.trim() || !record.id) return '';
  const ids = [...new Set(record.evidenceIds || [])].sort();
  const sources = ids.map(id => units.filter(unit => unit.id === id));
  if (sources.some(rows => rows.length !== 1)) return '';
  return hash({ record:{...record,evidenceIds:ids,reviewFlagIds:[...new Set(record.reviewFlagIds || [])].sort()},
    sources:sources.map(rows => ({ id:rows[0].id,text:rows[0].text,speaker:rows[0].speaker || '',
      classification:rows[0].classification || '',restored:rows[0].restored === true })) });
}
function entries(draft = {}) {
  return (Array.isArray(draft.excludedSupportingDetails) ? draft.excludedSupportingDetails : [])
    .filter(entry => entry && typeof entry.key === 'string' && /^[a-f0-9]{64}$/.test(entry.key)
      && entry.record && typeof entry.record.text === 'string').map(clone);
}
function active(rows = [], draft = {}) {
  const excluded = new Set(entries(draft).map(entry => entry.key));
  return rows.filter(row => !excluded.has(fingerprint(row,draft.sourceUnits || [])));
}
function selection(draft = {}, requested) {
  const prior = entries(draft), available = new Map(prior.map(entry => [entry.key,entry]));
  for (const record of draft.unassignedSupportingDetails || []) {
    const key = fingerprint(record,draft.sourceUnits || []);
    if (key) available.set(key,{ key,record:clone(record),sources:(draft.sourceUnits||[]).filter(unit=>(record.evidenceIds||[]).includes(unit.id)).map(clone) });
  }
  if (!Array.isArray(requested) || requested.length > 500) throw Object.assign(Error('Invalid optional-detail selection.'),{statusCode:400,code:'invalid_optional_review_selection'});
  const seen = new Set(), selected = [];
  for (const request of requested) {
    if (!request || typeof request.key !== 'string' || seen.has(request.key) || !available.has(request.key)) throw Object.assign(Error('This retained detail changed. Reload before leaving it out.'),{statusCode:409,code:'stale_optional_review_selection'});
    seen.add(request.key);selected.push(clone(available.get(request.key)));
  }
  if (Buffer.byteLength(JSON.stringify(selected),'utf8') > 2*1024*1024) throw Object.assign(Error('The retained-detail archive is full. Restore an entry before leaving out another.'),{statusCode:400,code:'optional_review_archive_capacity'});
  return selected;
}
function keys(draft = {}) { return (draft.unassignedSupportingDetails || []).map((record,index)=>({index,key:fingerprint(record,draft.sourceUnits || [])})); }
module.exports = { fingerprint,entries,active,selection,keys };
