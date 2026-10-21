'use strict';

const crypto = require('node:crypto');
const Timing = require('./meetingMinutesTiming');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { isRawTranscriptDiscussionPoint } = require('./stagedEditorial');
const { temporalClaim, temporalMeaningRetained } = require('./meetingMinutesTemporalReview');
const { timingExpressions } = require('./meetingMinutesTimedStepCoverage');
const { reviewDiscussionCalendarDates } = require('./meetingMinutesDateReview');

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
const SCHEDULE = /\b(?:(?:is|are|will be|has been|have been)\s+(?:(?:currently|provisionally|tentatively)\s+)?(?:scheduled|planned|expected)|(?:will|shall|should)\s+(?:start|begin|commence|end|finish|become available|be available)|(?:is|are|will be|should be)\s+(?:available|unavailable))\b/i;
const UNACCEPTED_SCHEDULE = /\b(?:maybe|perhaps|might|could|suggest(?:s|ed|ion)?|propos(?:e|es|ed|al)|consider(?:ing)?|option|alternative|possible|possibility|what if)\b/i;

// Keep identity, roles, grammar and order intact. These phase verbs are the
// only lexical alternatives accepted here; broader paraphrases need review.
const phaseWording = value => canonical(value)
  .replace(/\b(?:start|begin|commence)\b/g, 'start')
  .replace(/\b(?:end|finish)\b/g, 'finish');

function supportedScheduledTiming(detail, cited, options) {
  const value = String(detail.text || '');
  if (!SCHEDULE.test(value) || UNACCEPTED_SCHEDULE.test(value)) return false;
  const durations = value.match(/\b(?:for|over|last(?:s)?(?:\s+for)?)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:working|business)\s+)?(?:hours?|days?|weeks?|months?)\b/gi) || [];
  const expressions = [...new Set([...timingExpressions(value), ...durations])];
  if (!expressions.length) return false;
  return cited.some(unit => String(unit.text || '').split(/;|(?<=[.!?])\s+/).some(source => {
    if (!SCHEDULE.test(source) || UNACCEPTED_SCHEDULE.test(source) || /\?/.test(source)
      || phaseWording(value) !== phaseWording(source)
      || !temporalMeaningRetained(value, source, options)) return false;
    // Use this single carrying clause rather than a window of neighbouring
    // owners/work. Every stated period/date must bind to the same claim.
    const sourceUnit = { ...unit, text: source };
    if (reviewDiscussionCalendarDates([{ points: [detail] }], [sourceUnit], options).flags.length) return false;
    return expressions.every(expression => Timing.assessTimingSourceBinding({
      action: value, owners: detail.owners || [], evidenceIds: [unit.id],
      timing: { kind: 'target', wording: expression, exactDate: '' }
    }, [sourceUnit], options).status === 'supported');
  }));
}

function supportedMaterialTiming(detail, units, options = {}) {
  const value = String(detail?.text || '').trim();
  if (!value || isReviewerAuthored(detail) || isRawTranscriptDiscussionPoint(value) || /\?/.test(value)
    || !(TEMPORAL.test(value) || temporalClaim(value))) return false;
  const cited = units.filter(unit => (detail.evidenceIds || []).includes(unit.id)
    && (unit.classification !== 'remove' || unit.restored));
  if (supportedScheduledTiming(detail, cited, options)) return true;
  if (!REQUIREMENT.test(value)) return false;
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
