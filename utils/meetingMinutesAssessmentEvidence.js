'use strict';

const { text } = require('./meetingMinutesText');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const {
  includedUnit, evidenceSupportScore, explicitValuePresent, explicitValues
} = require('./meetingMinutesEvidenceContext');
const { stableId } = require('./meetingMinutesRecordMatching');
const { actionEvidenceDisposition } = require('./meetingMinutesActionEvidence');

// A typed discovery warning is not an action. Preserve the source-backed
// question when no explicitly identified action exists; never manufacture its
// instruction or owner from the provider's explanation.
function assessmentOwnershipReviewNotice(flag, candidate, units) {
  if (!['unsupported_ownership', 'unsupported_owner'].includes(flag?.type || flag?.kind)) return flag;
  const message = text(flag.message || flag.text || flag.detail || flag.details, 500);
  if (!/\b(?:assessment|assess|review)\b/i.test(message)) return flag;
  const records = [...(candidate.actions || []), ...(candidate.actionProposals || [])];
  const linked = flag.actionId ? records.filter(record => record.id === flag.actionId) : [];
  if (linked.length === 1 && /^(?:assess|review|check|evaluate|determine whether)\b/i.test(linked[0].action || '')) return flag;
  const rows = normaliseSourceUnits(units);
  const suppliedIds = [...new Set((Array.isArray(flag.evidenceIds) ? flag.evidenceIds : []).filter(id => typeof id === 'string'))];
  if (!suppliedIds.length || suppliedIds.length > 8 || suppliedIds.some(id => rows.filter(row => row.id === id).length !== 1 || !includedUnit(rows.find(row => row.id === id)))) return flag;
  const evidence = rows.filter(row => suppliedIds.includes(row.id)).map(row => row.text).join(' ');
  if (!/\b(?:assessment|assess|review|having a look|looking at)\b/i.test(evidence)
    || !/\b(?:we can|we need|could|would|need to|get an assessment|have a look|having a look)\b/i.test(evidence)
    || /\b(?:already (?:completed|reviewed|assessed)|assessment (?:is|was) complete|no assessment|do not (?:assess|review)|not committing)\b/i.test(evidence)) return flag;
  return { ...flag, id: stableId('flag-assessment-review', `${message}|${suppliedIds.join('|')}`, 0),
    kind: 'possible_missed_follow_up',
    message: `Assessment to review: check whether the requested work should become an action and who accepted it. ${message}`,
    evidenceIds: suppliedIds, reviewDisposition: 'not_applied_addition',
    sourceReviewContext: { kind: 'assessment_ownership_notice', originalType: flag.type || flag.kind,
      originalMessage: message, originalEvidenceIds: suppliedIds }
  };
}

// A narrow proposal-only context repair. This nominates a source connection;
// it never certifies the document reference, ownership or commitment. The
// caller must retain an explicit human-review warning and the original anchors.
function documentReferenceContextEvidence(action, suppliedIds = [], units = []) {
  const wording = text(action, 1600);
  if (!/^(?:assess|review|check|evaluate|determine whether)\b/i.test(wording)) return null;
  const named = [...wording.matchAll(/\b(?:standard|document|protocol|procedure|specification|report|policy|guide|ISO|IEC|ASTM|EN|BS)\s+(?:(?:ISO|IEC|ASTM|EN|BS)\s+)?(\d{3,5}(?:[-–]\d{1,4})*(?::\d{4})?)\b/gi)];
  const identifiers = [...new Set(named.map(match => match[1]))];
  if (identifiers.length !== 1) return null;
  const identifier = identifiers[0];
  const rows = normaliseSourceUnits(units);
  const counts = new Map();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const ids = [...new Set(suppliedIds)];
  if (!ids.length || ids.length >= 8 || ids.some(id => counts.get(id) !== 1)) return null;
  const supplied = rows.filter(row => ids.includes(row.id));
  if (supplied.some(row => !includedUnit(row))) return null;
  const suppliedText = supplied.map(row => `${row.speaker}: ${row.text}`).join(' ');
  if (evidenceSupportScore(wording, suppliedText) >= 0.22
    || explicitValuePresent(identifier, suppliedText.toLowerCase())) return null;
  if (explicitValues(wording).some(value => value !== identifier && !explicitValuePresent(value, suppliedText.toLowerCase()))) return null;
  const connections = [];
  for (let index = 1; index < rows.length; index++) {
    const work = rows[index], identity = rows[index - 1];
    if (!ids.includes(work.id) || counts.get(identity.id) !== 1 || !includedUnit(identity)
      || work.speaker === 'Speaker' || identity.speaker !== work.speaker
      || Number(work.id.slice(1)) !== Number(identity.id.slice(1)) + 1) continue;
    const reference = work.text.match(/\b(?:that|this|the same|the above|the aforementioned)\s+(standard|document|protocol|procedure|specification|report|policy|guide)\b/i);
    if (!reference) continue;
    if ([...work.text.matchAll(/\b(?:standard|document|protocol|procedure|specification|report|policy|guide)\b/gi)].length !== 1) continue;
    const namedKind = /^(?:ISO|IEC|ASTM|EN|BS)\b/i.test(named[0][0]) ? 'standard' : named[0][0].split(/\s+/)[0].toLowerCase();
    if (namedKind !== 'document' && reference[1].toLowerCase() !== 'document' && reference[1].toLowerCase() !== namedKind) continue;
    if (explicitValues(work.text).some(value => /^\d{3,5}(?:[-–]\d{1,4})*(?::\d{4})?$/.test(value) && value !== identifier)) continue;
    if (/\b(?:different|unrelated|either|which one|not sure which|not (?:that|this)|instead)\b/i.test(work.text)) continue;
    // A neighbouring number, cost or list of documents is not an identity link.
    const identityValues = explicitValues(identity.text).filter(value => /^\d{3,5}(?:[-–]\d{1,4})*(?::\d{4})?$/.test(value));
    if (identityValues.length !== 1 || identityValues[0] !== identifier
      || /\b(?:standards|documents|protocols|procedures|specifications|reports|policies|guides|cost|price|budget|invoice|pounds|euros|dollars)\b|[£€$]/i.test(identity.text)) continue;
    if (!/\b(?:was|is|called|named|number|reference|identifier|standard|document|protocol|procedure|specification|report|policy|guide)\s+(?:(?:ISO|IEC|ASTM|EN|BS)\s+)?\d{3,5}\b/i.test(identity.text)) continue;
    const prefixes = [...wording.matchAll(/\b(ISO|IEC|ASTM|EN|BS)\s+\d{3,5}\b/gi)].map(match => match[1]);
    if (prefixes.some(prefix => !new RegExp(`\\b${prefix}\\s+${identifier.replace(/[-–]/g, '[-–]')}\\b`, 'i').test(identity.text))) continue;
    // The work passage itself must support the instruction without borrowing
    // its purpose or operation from the identity passage.
    if (!/\b(?:assess(?:ment|ing)?|review(?:ing)?|check(?:ing)?|evaluat(?:e|ion|ing)|looking at|applicab(?:le|ility))\b/i.test(work.text)
      || evidenceSupportScore(wording.replace(identifier, ''), work.text) < 0.22
      || ['completed', 'rejected', 'meeting_admin', 'status_only'].includes(actionEvidenceDisposition(wording, work.text))) continue;
    const evidenceIds = rows.filter(row => ids.includes(row.id) || row.id === identity.id).map(row => row.id);
    const evidence = rows.filter(row => evidenceIds.includes(row.id)).map(row => `${row.speaker}: ${row.text}`).join(' ');
    if (evidenceIds.length > 8 || evidenceSupportScore(wording, evidence) < 0.22) continue;
    connections.push({ evidenceIds, originalEvidenceIds: ids, addedEvidenceIds: [identity.id], workEvidenceIds: [work.id] });
  }
  return connections.length === 1 ? connections[0] : null;
}

module.exports = { assessmentOwnershipReviewNotice, documentReferenceContextEvidence };
