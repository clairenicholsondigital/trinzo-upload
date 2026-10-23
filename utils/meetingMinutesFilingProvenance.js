'use strict';

// Review metadata only: these origins never grant evidence or authorship.
function filingProvenance(record = {}) {
  const result = {};
  if (record.filingMergeProtected === true) result.filingMergeProtected = true;
  if (Array.isArray(record.filingOrigins)) {
    const origins = record.filingOrigins.slice(0, 1000).filter(origin =>
      origin && typeof origin === 'object' && !Array.isArray(origin)
      && Object.keys(origin).every(key => ['id', 'originalTopic', 'placementReason'].includes(key))
      && typeof origin.id === 'string' && origin.id.length > 0 && origin.id.length <= 80
      && !/[\u0000-\u001f\u007f]/.test(origin.id)
      && ['originalTopic', 'placementReason'].every(key => origin[key] === undefined
        || (typeof origin[key] === 'string' && origin[key].length <= (key === 'originalTopic' ? 220 : 100))));
    if (origins.length) result.filingOrigins = origins.map(origin => ({ ...origin }));
    if (origins.length !== record.filingOrigins.length) result.filingMergeProtected = true;
  } else if (record.filingOrigins !== undefined) result.filingMergeProtected = true;
  return result;
}

module.exports = { filingProvenance };
