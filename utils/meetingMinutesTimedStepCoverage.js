'use strict';

const Timing = require('./meetingMinutesTiming');
const { actionEvidenceDisposition } = require('./meetingMinutesAgentV2');

// This is an accounting signal for the existing recovery pass, not an action
// extractor. Only already inventoried, accepted work can enter this check.
const TIME = /\b(?:today|tonight|tomorrow(?:\s+(?:morning|afternoon|evening))?|(?:this|next|last|every|each)\s+(?:week|weekend|month|quarter|year)|(?:(?:this|next|last|previous|every|each)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:by\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?|within\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:working|business)\s+)?(?:hours?|days?|weeks?|months?))\b|\b(?:daily|weekly|fortnightly|monthly|quarterly|annually|yearly)\b|\b(?:once|after|before|until|when|subject to|dependent on)\s+[^.;,!?]{2,90}|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?:\s*(?:am|pm|gmt|bst|utc|cet|cest))?\b/gi;
const canon = value => String(value || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();

function timingExpressions(value) {
  return [...new Set([...String(value || '').matchAll(TIME)].map(match => canon(match[0])))];
}

// A period, its more precise day and a qualification can describe one step
// ("this weekend, Saturday morning probably, before it gets busy"). Keep
// those constraints together, but do not cross text describing another
// operation. In particular, "Friday and email the supplier Monday" remains
// two checks even when the inventory did not split the speaking turn.
function focusedTimingGroups(value) {
  const source = String(value || '');
  // "Back to last week's actions" is a historical agenda reference, not
  // this task's due date. An explicitly overdue/past-due obligation remains
  // in the inventory, including a source-stated deadline of last week.
  const pastDue = /\b(?:due|deadline|overdue|outstanding|unfinished|still\s+(?:need|have\s+to)|not\s+yet\s+(?:done|completed|finished))\b/i.test(source);
  const matches = [...source.matchAll(TIME)].filter(match => pastDue
    || !/^last\s+(?:week|weekend|month|quarter|year)$/i.test(match[0]));
  const groups = [];
  const temporalJoin = /^[\s,()/:–—-]*(?:(?:morning|afternoon|evening|night|probably|possibly|perhaps|ideally|at|on|by|the|latest|around|roughly|approximately|early|late|end|of|start|in|this|same|week|weekend|day|time)\b[\s,()/:–—-]*)*$/i;
  for (const match of matches) {
    const previous = groups[groups.length - 1];
    const between = previous ? source.slice(previous.end, match.index) : '';
    const expression = canon(match[0]);
    if (previous && temporalJoin.test(between)) {
      if (!previous.expressions.includes(expression)) previous.expressions.push(expression);
      previous.end = match.index + match[0].length;
    } else groups.push({ expressions: [expression], end: match.index + match[0].length });
  }
  return groups.map(group => group.expressions);
}

// Discovery deliberately favours recall. Bare "is to" / "are to" also
// nominate descriptions, however; those alone cannot establish timed work.
// Reassess only the two unambiguous descriptive constructions, leaving the
// inventory, original evidence and every independently accepted cue intact.
function descriptiveCommitmentOnly(candidate) {
  if (!Array.isArray(candidate.cueKinds) || candidate.cueKinds.length !== 1
    || candidate.cueKinds[0] !== 'commitment') return false;
  const original = String(candidate.focusText || '');
  const descriptive = original
    .replace(/\b(?:is|are)\s+to\s+do\s+with\b/gi, 'relates to')
    .replace(/\b((?:purpose|aim|function|role|part)\s+of\s+[^.;!?]{1,100}?)\s+(?:is|are)\s+to\b/gi, '$1 describes');
  if (descriptive === original) return false;
  // A description may still define future work ("the purpose of the review
  // is to send the report Friday"). Exclude only wholly retrospective timing;
  // any date, future condition or ambiguous expression keeps its check.
  const expressions = [...original.matchAll(TIME)];
  const historicalWhen = /^when\b.*\b(?:talked|discussed|spoke|said|met|reviewed)\b.*\b(?:earlier|previously)\b/i;
  const priorExperience = /\b(?:have|has|had|[a-z]+['’]ve|[a-z]+['’]d)\s+(?:\w+\s+){0,4}(?:done|seen|used|reviewed|discussed)(?:\s+\w+){0,4}\s*$/i;
  if (!expressions.length || !expressions.every(match => historicalWhen.test(match[0])
    || /^before\s+(?:and|but)\b/i.test(match[0])
      && priorExperience.test(original.slice(0, match.index)))) return false;
  // A genuine assignment elsewhere in the same focus must still be checked.
  return !['committed', 'accepted_request', 'conditional_commitment']
    .includes(actionEvidenceDisposition(descriptive, descriptive));
}

function timedStepCoverage(candidates = [], actions = [], units = [], options = {}) {
  const included = new Map(units.filter(unit => unit.classification !== 'remove' || unit.restored).map(unit => [unit.id, unit]));
  const accepted = candidates.filter(candidate => included.has(candidate.focusEvidenceId)
    // Generated discussion prose may paraphrase several source turns or even
    // add a date. It is useful to action discovery, but cannot become an
    // independent source-stated timed step merely by citing a nearby turn.
    && candidate.sourcePass !== 'discussion_row' && !/^candidate-discussion-/.test(candidate.candidateId || '')
    && canon(candidate.focusText) && canon(included.get(candidate.focusEvidenceId).text).includes(canon(candidate.focusText))
    && ['committed', 'accepted_request', 'conditional_commitment'].includes(candidate.dispositionHint)
    && !descriptiveCommitmentOnly(candidate));
  // The inventory also contains whole turns. Prefer its existing focused
  // clauses so a compound turn is not counted again as another missing action.
  const clauseFocus = new Set(accepted.filter(candidate => /^candidate-clause-/.test(candidate.candidateId || '')).map(candidate => candidate.focusEvidenceId));
  const focused = accepted.filter(candidate => !clauseFocus.has(candidate.focusEvidenceId)
    || /^candidate-clause-/.test(candidate.candidateId || ''));
  const unique = new Map();
  for (const candidate of focused) for (const expressions of focusedTimingGroups(candidate.focusText)) {
    const key = `${candidate.focusEvidenceId}|${canon(candidate.focusText)}|${expressions.join('|')}`;
    if (!unique.has(key)) unique.set(key, { candidate, expressions });
  }
  const items = [...unique.values()].map(({ candidate, expressions }, index) => {
    const expression = expressions.join('; ');
    const represented = actions.filter(action => (action.evidenceIds || []).includes(candidate.focusEvidenceId));
    const carrying = represented.filter(action => {
      const wording = canon(action.timing?.wording);
      if (action.timing?.kind === 'not_stated' || !wording && !action.timing?.exactDate) return false;
      const carriedExpressions = timingExpressions(wording);
      const sameTime = expressions.every(part => {
        const date = Timing.resolveExactDate(part, options.meetingDate);
        return carriedExpressions.includes(part)
          || date && Timing.classifyTimingWording(part).kind !== 'dependency'
            && (Timing.resolveExactDate(wording, options.meetingDate) || action.timing?.exactDate) === date;
      });
      if (!sameTime) return false;
      const binding = Timing.assessTimingSourceBinding(action, units, options);
      const focus = units.find(unit => unit.id === candidate.focusEvidenceId);
      const focusedBinding = Timing.assessTimingSourceBinding({ ...action, evidenceIds: [candidate.focusEvidenceId] },
        [{ ...focus, text: candidate.focusText }], options);
      return binding.status === 'supported' && binding.matchedSourceIds.includes(candidate.focusEvidenceId)
        && focusedBinding.status === 'supported'
        && !['unresolved', 'rejected'].includes(action.timingDecision?.status);
    });
    return { id: `timed-step-${index + 1}`, candidateId: candidate.candidateId,
      focusEvidenceId: candidate.focusEvidenceId, expression, expressions, focusText: candidate.focusText,
      status: carrying.length ? 'covered' : 'unresolved',
      reason: carrying.length ? 'source_bound_timed_work_present' : represented.length ? 'timed_step_not_established' : 'timed_work_not_represented',
      actionIds: carrying.map(action => action.id).filter(Boolean) };
  });
  const missingIds = new Set(items.filter(item => item.status !== 'covered').map(item => item.candidateId));
  return { expected: items.length, complete: !missingIds.size,
    covered: items.filter(item => item.status === 'covered').length,
    unresolved: items.filter(item => item.status !== 'covered').length,
    items, uncovered: focused.filter(candidate => missingIds.has(candidate.candidateId)) };
}

function mergeTimedStepRecovery(decision, coverage) {
  const candidates = new Map((decision.uncovered || []).map(candidate => [candidate.candidateId, candidate]));
  for (const candidate of coverage.uncovered) candidates.set(candidate.candidateId, candidate);
  return { ...decision, needed: decision.needed || coverage.unresolved > 0,
    uncovered: [...candidates.values()], timedStepUnresolved: coverage.unresolved };
}

module.exports = { timingExpressions, timedStepCoverage, mergeTimedStepRecovery };
