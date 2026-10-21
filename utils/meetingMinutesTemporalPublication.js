'use strict';

const crypto = require('node:crypto');
const Timing = require('./meetingMinutesTiming');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { isRawTranscriptDiscussionPoint } = require('./stagedEditorial');

const KINDS = ['points', 'decisions', 'openQuestions'];
const REQUIREMENT = /\b(?:must|shall|required|requires?|mandatory|deadline|due|needs? to|has to|have to)\b/i;
const TEMPORAL = /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weeks|month|months|year|years|before|after|within|until|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const QUALIFIED = /\b(?:maybe|perhaps|might|could|possibly|probably|presumably|hopefully|ideally|preferably|if|unless|subject to)\b/i;
const NEGATIVE = /\b(?:not|never|no longer|except|excluding)\b/i;
const IDENTITY_MODIFIERS = /\b(?:new|existing|current|previous|former|external|internal|incoming|outgoing)\b/gi;
const STOP = new Set('the and for with that this those these from into will would should shall must required requires require needs need have has been being are was were before after within until month months year years week weeks this next last previous by'.split(' '));
const tokens = value => new Set((String(value || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
  .filter(word => !STOP.has(word)).map(word => word.replace(/(?:ing|ed|s)$/, '')));
const canonical = value => String(value || '').toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();

function supportedMaterialTiming(detail, units, options = {}) {
  const value = String(detail?.text || '').trim();
  if (!value || isReviewerAuthored(detail) || isRawTranscriptDiscussionPoint(value) || /\?/.test(value)
    || !TEMPORAL.test(value) || !REQUIREMENT.test(value)) return false;
  const cited = units.filter(unit => (detail.evidenceIds || []).includes(unit.id)
    && (unit.classification !== 'remove' || unit.restored));
  const dates = Timing.explicitCalendarDates(value, options.meetingDate);
  if (!dates.length) return false;
  const binding = Timing.assessTimingSourceBinding({ action: value, owners: [], evidenceIds: detail.evidenceIds || [],
    timing: { kind: 'deadline', wording: dates[0], exactDate: dates[0] } }, units, options);
  if (binding.status !== 'supported') return false;
  const claim = tokens(value);
  const modifiers = [...value.matchAll(IDENTITY_MODIFIERS)].map(match => match[0].toLowerCase());
  return cited.flatMap(unit => String(unit.text || '').split(/[;.!?]+|\b(?:whereas|but)\b/i)).some(source => {
    if (!REQUIREMENT.test(source) || QUALIFIED.test(source) && !QUALIFIED.test(value)
      || NEGATIVE.test(source) !== NEGATIVE.test(value)
      || modifiers.some(word => !new RegExp(`\\b${word}\\b`, 'i').test(source))) return false;
    const sourceDates = Timing.explicitCalendarDates(source, options.meetingDate);
    if (!dates.every(date => sourceDates.includes(date))) return false;
    const words = tokens(source);
    return [...claim].filter(word => words.has(word)).length / Math.max(1, claim.size) >= 0.55;
  });
}

// Move an already evidenced material deadline into ordinary publication. This
// never writes a new claim or changes a deadline, ownership or source wording.
function promoteMaterialTimingDetails(discussion = [], sourceUnits = [], options = {}) {
  const result = structuredClone(Array.isArray(discussion) ? discussion : []);
  const visible = result.flatMap(topic => KINDS.flatMap(kind => topic[kind] || []));
  const ids = new Set(visible.map(record => String(record.id || '')).filter(Boolean));
  let promoted = 0;
  for (const topic of result) {
    if (isReviewerAuthored(topic)) continue;
    const additions = [];
    for (const kind of KINDS) for (const record of topic[kind] || []) {
      if (isReviewerAuthored(record)) continue;
      const retained = [];
      for (const detail of record.supportingDetails || []) {
        const covered = visible.some(other => canonical(other.text) === canonical(detail.text));
        if (covered || !supportedMaterialTiming(detail, sourceUnits, options)) { retained.push(detail); continue; }
        const id = detail.id && !ids.has(String(detail.id)) ? detail.id
          : `timing-detail-${crypto.createHash('sha1').update(JSON.stringify([detail.text, detail.evidenceIds])).digest('hex').slice(0, 14)}`;
        const next = { ...detail, id, supportingDetails: [], materialTimingParentId: record.id || '' };
        ids.add(String(id)); additions.push(next); visible.push(next); promoted += 1;
      }
      if (Array.isArray(record.supportingDetails)) record.supportingDetails = retained;
    }
    if (additions.length) topic.points = [...(topic.points || []), ...additions];
  }
  return { discussion: result, promoted };
}

module.exports = { supportedMaterialTiming, promoteMaterialTimingDetails };
