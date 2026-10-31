'use strict';

const { meetingAgentTimingAnchor } = require('./meetingMinutesDraftContext');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { comparisonText, materialTokens } = require('./meetingMinutesEvidenceContext');
const TimingIntegrity = require('./meetingMinutesTiming');
const { normaliseFlag } = require('./meetingMinutesReviewFlags');
const { text } = require('./meetingMinutesText');
const { commitmentCanBeRepresented } = require('./canonicalMinutes/commitmentDuplicates');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { nameParts, speakerIsOwner } = require('./meetingMinutesPeopleEvidence');
const { contentTokens } = require('./meetingMinutesRecordMatching');
const { ACTION_VERB_GROUPS, actionPredicateSupported } = require('./meetingMinutesActionEvidence');
const { dateWordingVariants } = require('./meetingMinutesActionTimingInference');
const { actionTimingIssueFlag } = require('./meetingMinutesTimingFlags');

function sameTimingWork(left = {}, right = {}) {
  const owners = row => [...new Set((row.owners || []).map(owner => comparisonText(owner)))].sort().join('|');
  if (!owners(left) || owners(left) !== owners(right)) return false;
  const shared = new Set(left.evidenceIds || []);
  if (!(right.evidenceIds || []).some(id => shared.has(id))) return false;
  const wording = row => comparisonText(row.action).replace(/[.!;]+$/, '')
    .replace(/^(?:complete|finish)\s+(?:the\s+)?updates?\s+to\s+/, 'update ')
    .replace(/^(?:update|revise|amend|edit)\s+(?:the\s+)?/, 'update ');
  const a = wording(left), b = wording(right);
  if (a === b) return true;
  // Mutual retention is much narrower than related work. Do not use a
  // one-way contained step or overlapping transcript window to erase timing
  // for a different operation or a larger workflow.
  const untimed = row => ({ ...row, timing: { kind: 'not_stated', wording: '', exactDate: '' } });
  return commitmentCanBeRepresented(untimed(left), untimed(right))
    && commitmentCanBeRepresented(untimed(right), untimed(left));
}

function reconcileSiblingTimingDecisions(actions = [], units = [], options = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const flags = [];
  const actionsAfter = list.map(action => {
    if (isReviewerAuthored(action)) return action;
    const wording = comparisonText(action.timing?.wording || '');
    const date = action.timing?.exactDate || '';
    const rejectedSibling = list.find(other => other !== action && !isReviewerAuthored(other)
      && TimingIntegrity.assessmentMatches(other, units, options.meetingDate, other.timingDecision)
      && sameTimingWork(action, other)
      // A shared context line is not the source of a rejected deadline. An
      // equivalent task may be restated with genuinely new timing evidence.
      && (other.timingDecision.sourceEvidenceIds || []).length > 0
      && other.timingDecision.sourceEvidenceIds.every(id => (action.evidenceIds || []).includes(id))
      && !timingBoundToActionSteps(action, units.filter(unit => (action.evidenceIds || []).includes(unit.id)
        && !other.timingDecision.sourceEvidenceIds.includes(unit.id)), options)
      && (date && (other.timingDecision.rejectedExactDates || []).includes(date)
        || wording && (other.timingDecision.rejectedWordings || []).some(value => comparisonText(value) === wording)));
    if (!rejectedSibling) return action;
    const rejectWording = wording && (rejectedSibling.timingDecision.rejectedWordings || [])
      .some(value => comparisonText(value) === wording);
    const next = TimingIntegrity.rejectActionTiming(action, units, {
      meetingDate: options.meetingDate, field: rejectWording ? 'all' : 'exactDate', reason: 'equivalent_work_source_rejection'
    });
    const flag = normaliseFlag({ kind: 'timing',
      message: `The timing for "${text(action.action, 200)}" conflicts with a source-reviewed equivalent instruction; the rejected ${rejectWording ? 'timing' : 'exact date'} is not repeated. Confirm the source timing.`,
      evidenceIds: [...new Set([...(action.evidenceIds || []), ...(rejectedSibling.evidenceIds || [])])] }, flags.length);
    flags.push(flag);
    next.reviewFlagIds = [...new Set([...(next.reviewFlagIds || []), flag.id])];
    return next;
  });
  return { actions: actionsAfter, flags };
}

const ACTION_VERBS = new Set(ACTION_VERB_GROUPS.flat());

function compoundActionClauses(value = '') {
  const source = text(value, 1200).replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const verbPattern = [...ACTION_VERBS].sort((left, right) => right.length - left.length)
    .map((verb) => verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const clauses = source.split(new RegExp(`\\s+(?:and|then)\\s+(?=(?:${verbPattern})\\b)`, 'ig'))
    .map((clause) => clause.trim().replace(/[.;]+$/, '')).filter(Boolean);
  return clauses.length > 1 && clauses.every((clause) => ACTION_VERBS.has(contentTokens(clause)[0])) ? clauses : [];
}

function sourceInstructionClauses(value = '') {
  const verbs = [...new Set(ACTION_VERB_GROUPS.flat())].sort((a, b) => b.length - a.length)
    .map(verb => verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return String(value).split(new RegExp(`[.;!?]+|[,;]\\s*(?:and\\s+|then\\s+|but\\s+)?(?=(?:${verbs})\\b)|\\s+(?:and|then|but)\\s+(?=(?:(?:I|we)\\s+(?:will|'ll)\\s+)?(?:${verbs})\\b)`, 'i'))
    .map(clause => clause.trim()).filter(Boolean);
}

function sourceBindsTimingToStep(step, source, timing, options = {}) {
  const canonical = value => comparisonText(value).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const sourceTiming = clause => {
    if (timing.wording && canonical(clause).includes(canonical(timing.wording))) return true;
    if (!timing.exactDate) return false;
    return TimingIntegrity.resolveExactDate(clause, options.meetingDate) === timing.exactDate
      || dateWordingVariants(timing.exactDate).some(phrase => canonical(clause).includes(canonical(phrase)));
  };
  const stepWords = new Set(materialTokens(step).filter(word => !ACTION_VERBS.has(word)));
  const about = clause => {
    if (!actionPredicateSupported(step, clause)) return false;
    const words = new Set(materialTokens(clause));
    const shared = [...stepWords].filter(word => words.has(word)).length;
    return stepWords.size > 0 && shared >= Math.min(2, stepWords.size)
      && shared / stepWords.size >= 0.6;
  };
  return sourceInstructionClauses(source).some(clause =>
    !/\b(?:not|never|cannot|can't|won't|instead|except|excluding|unless)\b/i.test(clause)
      && sourceTiming(clause) && about(clause));
}

function timingBoundToActionSteps(action = {}, units = [], options = {}) {
  if (!action.timing || action.timing.kind === 'not_stated') return true;
  const cited = new Set(action.evidenceIds || []);
  const source = normaliseSourceUnits(units).filter(unit => cited.has(unit.id));
  const steps = compoundActionClauses(action.action);
  const required = steps.length ? steps : [action.action];
  const owned = unit => {
    if (!(action.owners || []).length) return false;
    const lower = comparisonText(unit.text);
    const otherFutureSubject = [...String(unit.text || '').matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:will|shall|must|is\s+going\s+to)\b/g)]
      .some(match => !/^(?:We|They|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(match[1])
        && !(action.owners || []).some(owner => nameParts(match[1]).every(part => nameParts(owner).includes(part))));
    if (otherFutureSubject) return false;
    return speakerIsOwner(unit.speaker, action.owners)
      || (action.owners || []).some(owner => {
        const name = comparisonText(owner).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${name}\\s+(?:will|shall|must|is\\s+to|to)\\b`).test(lower);
      });
  };
  return required.every(step => source.some(unit => owned(unit) && sourceBindsTimingToStep(step, unit.text, action.timing, options)));
}

function finaliseActionTimings(actions = [], units = [], options = {}) {
  const flags = [];
  const assessments = [];
  const checked = (Array.isArray(actions) ? actions : []).map((row) => {
    const result = TimingIntegrity.assessActionTiming(row, units, options);
    if (result.assessment) assessments.push(result.assessment);
    const issues = [...result.issues, ...(row.timing?.kind === 'not_stated' ? row._timingRecoveryIssues || [] : [])];
    const assessedAction = { ...result.action };
    delete assessedAction._timingRecoveryIssues;
    if (!issues.length) return assessedAction;
    const rowFlags = issues.map(issue => {
      const removed = row.timing?.wording && !assessedAction.timing?.wording
        && (assessedAction.timingDecision?.rejectedWordings || []).includes(row.timing.wording);
      const message = /^timing_inference_/.test(issue.code) ? issue.message
        : `${issue.message} ${isReviewerAuthored(row) ? 'Confirm the reviewer-entered timing.' : issue.preserveValue ? 'The stated date was retained for review.' : removed ? 'The unsupported timing was removed; confirm this work’s own timing.' : 'The exact date was removed; confirm the retained source wording.'}`;
      return normaliseFlag(actionTimingIssueFlag({ code: removed ? 'timing_value_removed' : issue.code }, row, message), flags.length);
    });
    flags.push(...rowFlags);
    return { ...assessedAction, reviewFlagIds: [...new Set([...(assessedAction.reviewFlagIds || []), ...rowFlags.map(flag => flag.id)])] };
  });
  return { actions: checked, flags, assessments };
}

function finaliseMeetingAgentTimingProposal(proposal = {}, draft = {}) {
  if (proposal.stage !== 'actions') return { proposal, flags: [], assessments: [] };
  const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
  const current = Array.isArray(draft.actions) ? draft.actions : [];
  const rows = changes.filter(change => change.after).map(change => change.after);
  const options = { meetingDate: meetingAgentTimingAnchor(draft),
    assessments: draft.qualityState?.actions?.timingAssessments || [] };
  const siblings = reconcileSiblingTimingDecisions([...current, ...rows], draft.sourceUnits || [], options);
  const checked = finaliseActionTimings(siblings.actions.slice(current.length), draft.sourceUnits || [], options);
  let index = 0;
  return { proposal: { ...proposal, changes: changes.map(change => change.after
    ? { ...change, after: checked.actions[index++] } : change) },
    flags: [...siblings.flags, ...checked.flags], assessments: checked.assessments };
}

module.exports = {
  finaliseMeetingAgentTimingProposal,
  reconcileSiblingTimingDecisions,
  sameTimingWork,
  timingBoundToActionSteps,
  compoundActionClauses,
  ACTION_VERBS,
  sourceBindsTimingToStep,
  sourceInstructionClauses,
  finaliseActionTimings
};
