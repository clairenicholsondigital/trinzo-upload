'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { evidenceSupportScore } = require('./meetingMinutesEvidenceContext');
const { hybridRecordText, hybridTokenOverlap, hybridContentTokenOverlap } = require('./meetingMinutesRecordMatching');
const { reconcileDetailedContacts } = require('./canonicalMinutes/detailedContactCoverage');
const { commitmentClausesRetained, commitmentDetailsCovered, reconcileCommitmentVariants, sourceBoundRoleClarificationDuplicate, sourceAwarePreferred, commitmentCanBeRepresented, commitmentScopeConflict, sourceAwareParaphraseDuplicate } = require('./canonicalMinutes/commitmentDuplicates');
const { sourceBoundReviewTimingContext, exactActionIdentityConflict, sourceBoundLiteralDependencyTiming, sourceBoundIdenticalActionTimingCompletion, actionContainmentConflict, timingsDifferOnlyByWeekdayPreposition, actionIsLosslesslyCovered, conflictingTimings } = require('./canonicalMinutes/actionDuplicateCoverage');
const { sameContactPurposeDeliverable, sameComplementaryDocumentDeliverable, sameReciprocalContactDeliverable, sameCanonicalDocumentWorkflow, conflictingActionRecipients, questionCommunicationFrame, mergeCanonicalDocumentWorkflowWording, complementaryDocumentRecipientHandoff, sameOrNestedActionDeliverable, sameQuestionCommunicationDeliverable, mergeComplementaryDocumentWording } = require('./canonicalMinutes/actionDeliverableIdentity');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');

// A published action reads as an instruction: it starts with a verb and is not
// a fragment of speech. The verb list is deliberately wide; the evidence gates
// decide whether the work is real, this only rejects wording.
const CLIENT_READY_ACTION_VERBS = new Set(('accept add address agree align analyse analyze apply approve arrange ask assess assign attach attend '
  + 'book brief build buy calculate call capture chase check circulate clarify close collate collect communicate compare compile complete '
  + 'conduct confirm consider consolidate contact continue coordinate correct create cross-check decide define deliver design determine develop '
  + 'discuss distribute document download draft email engage ensure escalate establish evaluate explore fill finalise finalize finish fit fix '
  + 'flag focus follow forward gather generate get hold host identify implement include incorporate inform input inspect introduce investigate '
  + 'invite issue launch liaise link list load log map measure meet merge monitor notify obtain order organise organize outline '
  + 'pay perform plan populate prepare present prioritise prioritize procure produce progress provide publish purchase raise '
  + 're-run rerun reconcile record redo refine register reissue remove replace reply report request resend resolve respond restart retest return '
  + 'review revise rework run save schedule scope seek select send set share sign source speak specify split standardise standardize start '
  + 'store submit summarise summarize supply support switch take talk test tidy trace track train transfer translate trial update upload '
  + 'validate verify visit walk write '
  // Everyday imperatives the models also use for real, specific work: "Put the
  // meeting in his diary", "Restore the animation", "Re-share the deck".
  + 'allocate amend archive back bring cancel clean configure copy delete demo deploy edit extend give hand install '
  + 'interview label message migrate move nominate phone pick post print proofread put quote rebook rebuild recheck '
  + 'recruit rehearse reinstate remind rename repair reschedule reserve reshare re-send re-share re-check re-test '
  + 'restore retrieve ring secure ship shortlist sort tell text upgrade').split(' '));
function isClientReadyActionWording(value = '') {
  const source = meetingMinutesAgentText(value, 1600);
  if (!source || /^(?:and|but|so|yeah|yes|no|okay|ok|well|i(?:'ll| will| am|'m)|we(?:'ll| will| are|'re)|you(?:'ll| will| are|'re))\b/i.test(source)) return false;
  const first = (source.toLowerCase().match(/^[a-z][a-z-]*/) || [''])[0];
  return CLIENT_READY_ACTION_VERBS.has(first);
}

function hybridActionType(value = '') {
  const verb = meetingMinutesAgentText(value, 300).toLowerCase().match(/^\s*(?:please\s+)?([a-z]+(?:\s+out)?)/)?.[1] || '';
  if (['confirm', 'clarify', 'determine', 'decide', 'resolve', 'figure out', 'work out'].includes(verb)) return 'decision';
  if (['trace', 'find', 'identify', 'investigate', 'source'].includes(verb)) return 'investigation';
  if (['fix', 'repair', 'remediate', 'correct'].includes(verb)) return 'remediation';
  if (['split', 'separate', 'divide', 'classify', 'categorise', 'categorize'].includes(verb)) return 'classification';
  if (['automate', 'script'].includes(verb)) return 'automation';
  if (['send', 'share', 'provide', 'forward', 'circulate', 'email', 'issue', 'deliver', 'submit'].includes(verb)) return 'transmission';
  if (['review', 'check', 'assess', 'inspect', 'evaluate', 'analyse', 'audit'].includes(verb)) return 'review';
  if (['create', 'produce', 'prepare', 'draft', 'develop', 'build', 'write', 'compile', 'document', 'record'].includes(verb)) return 'creation';
  if (['update', 'revise', 'amend', 'change', 'edit', 'add'].includes(verb)) return 'update';
  if (['complete', 'finish', 'finalise', 'finalize', 'close', 'sign', 'attest'].includes(verb)) return 'completion';
  if (['test', 'verify', 'validate', 'run', 'rerun'].includes(verb)) return 'testing';
  if (['schedule', 'arrange', 'book', 'organise', 'coordinate', 'plan'].includes(verb)) return 'planning';
  return verb;
}

function hybridActionTypes(value = '', { includeDocumentation = false } = {}) {
  const source = meetingMinutesAgentText(value, 1600).toLowerCase();
  const matches = source.matchAll(/(?:^|[,;:]\s*|\b(?:and|then|to)\s+)(ask|confirm|clarify|determine|decide|resolve|figure out|work out|trace|find|identify|investigate|source|fix|repair|remediate|split|separate|divide|classify|categorise|categorize|automate|script|send|share|provide|forward|circulate|email|issue|deliver|submit|review|check|assess|inspect|evaluate|analyse|audit|create|produce|prepare|draft|develop|build|write|compile|document|record|update|revise|amend|change|edit|add|correct|complete|finish|finalise|finalize|close|sign|attest|test|verify|validate|run|rerun|schedule|arrange|book|organise|coordinate|plan)\b/g);
  return new Set([...matches]
    .filter((match) => includeDocumentation || !['add', 'document', 'record'].includes(match[1]))
    .map((match) => hybridActionType(match[1])).filter(Boolean));
}

function strictActionDeliverableMatch(left = {}, right = {}, options = {}) {
  const leftOwners = (left.owners || []).map((owner) => String(owner).trim().toLowerCase()).filter(Boolean);
  const rightOwners = (right.owners || []).map((owner) => String(owner).trim().toLowerCase()).filter(Boolean);
  if (leftOwners.length && rightOwners.length && !leftOwners.some((owner) => rightOwners.includes(owner))) return false;
  if (conflictingActionRecipients(left, right)) return false;
  if (sameQuestionCommunicationDeliverable(left, right)) return true;
  const leftText = meetingMinutesAgentText(left.action, 1600);
  const rightText = meetingMinutesAgentText(right.action, 1600);
  if (leftText.toLowerCase() === rightText.toLowerCase()) return true;
  const leftTypes = hybridActionTypes(leftText, options);
  const rightTypes = hybridActionTypes(rightText, options);
  if (leftTypes.size && rightTypes.size
    && ![...leftTypes].some((type) => rightTypes.has(type))) return false;
  if (!leftTypes.size || !rightTypes.size) {
    const openingVerb = (value) => String(value || '').toLowerCase().match(/^\s*(?:please\s+)?([a-z]+(?:\s+out)?)/)?.[1] || '';
    if (openingVerb(leftText) !== openingVerb(rightText)) return false;
  }
  const overlap = hybridContentTokenOverlap(leftText, rightText);
  const sharedEvidence = (left.evidenceIds || []).some((id) => (right.evidenceIds || []).includes(id));
  return overlap >= 0.62 || (sharedEvidence && overlap >= 0.48);
}

// A possible relationship is useful for source corroboration, but cannot by
// itself justify deleting a candidate or claiming its complete publication.
function hybridCandidateMatchesRecord(candidate, record) {
  if (record?._recordType && candidate?.recordType && record._recordType !== candidate.recordType) return false;
  const candidateAction = candidate.record || { action: candidate?.text, evidenceIds: candidate?.evidenceIds };
  const candidateQuestionFrame = candidate?.recordType === 'action' && questionCommunicationFrame(candidateAction);
  const recordQuestionFrame = candidate?.recordType === 'action' && questionCommunicationFrame(record);
  const sameQuestionDeliverable = Boolean(candidateQuestionFrame && recordQuestionFrame
    && sameQuestionCommunicationDeliverable(candidateAction, record));
  // Once both rows identify a question-delivery frame, their recipient/topic
  // identity is authoritative. Generic word overlap must not merge different
  // question sets merely because both mention the same supplier.
  if (candidateQuestionFrame && recordQuestionFrame && !sameQuestionDeliverable) return false;
  if (candidate?.recordType === 'action' && conflictingActionRecipients(candidateAction, record)) return false;
  const candidateIds = new Set(candidate?.evidenceIds || []);
  const recordIds = Array.isArray(record?.evidenceIds) ? record.evidenceIds : [];
  const sharesEvidence = recordIds.some((id) => candidateIds.has(id));
  const score = Math.max(hybridTokenOverlap(candidate?.text, hybridRecordText(record)), evidenceSupportScore(candidate?.text || '', hybridRecordText(record)));
  if (!sameQuestionDeliverable && !sharesEvidence && score < 0.55) return false;
  if (!sameQuestionDeliverable && sharesEvidence && score < 0.25) return false;
  if (candidate?.recordType === 'action') {
    const candidateTypes = hybridActionTypes(candidate?.text || candidate?.record?.action);
    const recordTypes = hybridActionTypes(hybridRecordText(record));
    // Adjacent actions routinely cite the same exchange. Testing, sending and
    // deciding are separate accountability items even when their nouns and
    // evidence IDs overlap, so incompatible predicates can never cover one
    // another.
    if (!sameQuestionDeliverable && candidateTypes.size && recordTypes.size
      && ![...candidateTypes].some((type) => recordTypes.has(type))) return false;
    const candidateOwners = candidate?.record?.owners || [];
    const recordOwners = record?.owners || [];
    if (candidateOwners.length && recordOwners.length && !candidateOwners.some((owner) => recordOwners.some((other) => other.toLowerCase() === owner.toLowerCase()))) return false;
    if (sameQuestionDeliverable) return true;
  }
  return true;
}

// Two finished actions can cite one shared line and still be separate work:
// "Complete the standards list and provide it to Jacqui" and "Send Ingrid a
// proposal for the audit week" share an exchange, not a deliverable. The
// general matcher accepts a shared line plus incidental word overlap, so the
// publication deduper also requires the work itself to overlap, and never
// merges a step into the action that waits for it ("Re-share the deck once
// the animation updates are complete" is not "Restore the animation").
const ACTION_DEPENDENCY_CLAUSE = /\b(?:once|after|when|as soon as|following|until)\b(.+)$/i;
const GENERIC_DEPENDENCY_CLAUSE = /^(?:(?:it|that|this)(?:\s+is|['’]s)|(?:the work|the task|the job)\s+is)\s+(?:done|complete|completed|finished|ready)$/i;
function actionDependsOn(waiting = '', step = '') {
  const clause = String(waiting || '').match(ACTION_DEPENDENCY_CLAUSE)?.[1] || '';
  if (!clause) return false;
  const leadVerb = (value) => String(value || '').toLowerCase().match(/^\s*(?:please\s+)?([a-z]+(?:-[a-z]+)?)/)?.[1] || '';
  if (leadVerb(waiting) === leadVerb(step)) return false;
  // The step's own subject (everything after its verb) appears in the clause
  // the other action is waiting on.
  const stepSubject = String(step || '').replace(/^\s*(?:please\s+)?[a-z]+(?:-[a-z]+)?\s+/i, '');
  return hybridContentTokenOverlap(stepSubject, clause) > 0
    && hybridContentTokenOverlap(stepSubject, String(waiting).replace(ACTION_DEPENDENCY_CLAUSE, '')) === 0;
}

// A condition is part of the deliverable when it carries a real gate such as
// a meeting, approval, date or preceding work item. Do not make ordinary
// paraphrases distinct merely because one says "once it is done" and the
// other spells out the work that must be completed first.
function meaningfulActionDependency(value = '') {
  const match = String(value || '').match(ACTION_DEPENDENCY_CLAUSE);
  if (!match) return '';
  const clause = match[1].replace(/[.!?]+$/, '').trim().toLowerCase();
  return GENERIC_DEPENDENCY_CLAUSE.test(clause) ? '' : clause;
}

function meaningfulActionDependencyDiff(left = '', right = '') {
  const hasClause = (value) => ACTION_DEPENDENCY_CLAUSE.test(String(value || ''));
  const a = meaningfulActionDependency(left);
  const b = meaningfulActionDependency(right);
  // Both wordings still carry a dependency, so a generic pronoun form and a
  // fuller description are compatible paraphrases of the same wait condition.
  if (hasClause(left) && hasClause(right) && (!a || !b)) return false;
  // A meaningful gate cannot disappear during dedupe. If both actions have a
  // meaningful gate, only materially different gates make them distinct; a
  // generic "once it is done" clause remains compatible with either wording.
  if (!a && !b) return false;
  if (!a || !b) return true;
  return hybridContentTokenOverlap(a, b) < 0.5;
}

function distinctActionDeliverables(left = {}, right = {}) {
  const a = meetingMinutesAgentText(left.action, 1600);
  const b = meetingMinutesAgentText(right.action, 1600);
  if (!a || !b) return false;
  if (hybridContentTokenOverlap(a, b) === 0) return true;
  if (actionDependsOn(a, b) || actionDependsOn(b, a)) return true;
  if (meaningfulActionDependencyDiff(a, b)) return true;
  // "Ask Ravi whether the protocols are blocked" and "Ask Ravi about folder
  // access" share a verb and a person, not a deliverable. Compare what is
  // being done - the words after the lead verb, without people's names - and
  // keep the two apart when that barely overlaps and no specific phrase
  // ("standards list", "closing slide") is common to both.
  // The condition it waits on ("once it's done", "after the edits") is
  // timing, not the thing being done.
  const subject = (value) => value.replace(/^\s*(?:please\s+)?[A-Za-z]+(?:-[a-z]+)?\s+/, '')
    .replace(ACTION_DEPENDENCY_CLAUSE, '')
    .replace(/\b[A-Z][a-z'’]+(?:\s+[A-Z][a-z'’]+)*\b/g, ' ');
  return hybridContentTokenOverlap(subject(a), subject(b)) < 0.34 && !sharesDistinctivePhrase(subject(a), subject(b));
}

// A "figure out a way to ..." row against a concrete action for the same work.
function wayToParaphraseOf(loose = {}, concrete = {}) {
  return WAY_TO_ACTION.test(String(loose.action || ''))
    && !WAY_TO_ACTION.test(String(concrete.action || ''))
    && ownersOverlapOrOpen(loose, concrete)
    && hybridContentTokenOverlap(loose.action, concrete.action) >= 0.25;
}

// Is `part`'s work wholly contained in `whole`? Every content word of the
// shorter action appears in the longer one, the shorter is genuinely a part
// (well under the longer's length), and the same person owns both. Two
// actions of similar length are never nested, however much they overlap.
const NESTED_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'than',
  'their', 'there', 'will', 'would', 'could', 'should', 'have', 'has', 'been', 'was', 'were', 'are', 'any',
  'all', 'its', 'his', 'her', 'our', 'your', 'about', 'also', 'once', 'when', 'after', 'before', 'them']);
function nestedActionWork(part = {}, whole = {}) {
  if (!ownersOverlapOrOpen(part, whole)) return false;
  const words = (value) => new Set((meetingMinutesAgentText(value, 1600).toLowerCase()
    .match(/[a-z0-9][a-z0-9'’-]{2,}/g) || [])
    .filter((token) => !NESTED_STOP.has(token))
    .map((token) => token.replace(/(?:ing|ed|es|s)$/, '')));
  const shortWords = words(part.action);
  const longWords = words(whole.action);
  if (shortWords.size < 3 || longWords.size < shortWords.size * 1.6) return false;
  return [...shortWords].every((word) => longWords.has(word));
}

// Same kind of work: the same opening verb, or action types that overlap.
function sameActionApproach(left = {}, right = {}) {
  const verb = (value) => String(value || '').toLowerCase().match(/^\s*(?:please\s+)?([a-z]+(?:-[a-z]+)?)/)?.[1] || '';
  if (verb(left.action) && verb(left.action) === verb(right.action)) return true;
  const leftTypes = hybridActionTypes(left.action);
  const rightTypes = hybridActionTypes(right.action);
  if (!leftTypes.size || !rightTypes.size) return false;
  return [...leftTypes].some((type) => rightTypes.has(type));
}

const DELIVERY_BUNDLE_VERBS = new Set([
  'circulate', 'deliver', 'email', 'forward', 'issue', 'provide', 'send', 'share', 'submit'
]);
const DOCUMENT_WORKFLOW_VERBS = new Set([
  'complete', 'create', 'draft', 'finalise', 'finalize', 'prepare', 'review', 'revise', 'update'
]);
const DOCUMENT_WORKFLOW_OBJECTS = new Set([
  'checklist', 'contract', 'deck', 'document', 'file', 'form', 'invoice', 'manual', 'matrix',
  'minutes', 'pack', 'plan', 'presentation', 'proposal', 'report', 'schedule',
  'spreadsheet', 'tracker'
]);
const DELIVERY_NAME_WORD = String.raw`[A-Z][\p{L}\p{M}'’.-]*`;
const DELIVERY_NAME = String.raw`${DELIVERY_NAME_WORD}(?:\s+${DELIVERY_NAME_WORD}){0,3}`;
const DELIVERY_RECIPIENTS = String.raw`${DELIVERY_NAME}(?:\s*,\s*${DELIVERY_NAME})*(?:\s*,?\s+(?:and|&)\s+${DELIVERY_NAME})?`;

function exactActionOwners(record = {}) {
  return [...new Set((record.owners || []).map((owner) => meetingMinutesAgentText(owner, 160).toLowerCase()).filter(Boolean))].sort();
}

function sameExactActionOwners(left = {}, right = {}) {
  const a = exactActionOwners(left); const b = exactActionOwners(right);
  return a.length > 0 && a.length === b.length && a.every((owner, index) => owner === b[index]);
}

// A narrow structural parser for client-ready delivery actions. Named targets
// are required: grouping generic "send this to the team" work can hide separate
// responsibilities, whereas repeated hand-offs to one explicit person are the
// noisy pattern this pass is intended to compact.
function actionDeliveryFrame(record = {}) {
  const action = meetingMinutesAgentText(record.action || record.text, 1600).trim().replace(/[.?!]+$/, '');
  const rawVerb = action.match(/^([A-Za-z-]+)\b/)?.[1] || '';
  const verb = rawVerb.toLowerCase();
  if (!DELIVERY_BUNDLE_VERBS.has(verb)) return null;
  const escapedVerb = rawVerb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Parse recipient-first wording before object-first wording: an object's
  // initial capital is not evidence that it is a recipient's name.
  let match = action.match(new RegExp(`^${escapedVerb}\\s+(${DELIVERY_RECIPIENTS})\\s+(with\\s+|access\\s+to\\s+)(.+)$`, 'u'));
  if (match) {
    const recipient = meetingMinutesAgentText(match[1], 200).trim();
    let object = meetingMinutesAgentText(match[3], 1000).trim();
    if (/^access\s+to\s+/i.test(match[2])) object = `access to ${object}`;
    object = object.replace(/^access to (.+?) securely(?=,|$)/i, 'secure access to $1');
    return { verb, recipient, recipientKey: recipient.toLowerCase(), object, tail: '' };
  }
  match = action.match(new RegExp(`^${escapedVerb}\\s+(.+?)\\s+(?:to|with)\\s+(${DELIVERY_RECIPIENTS})(.*)$`, 'u'));
  if (match) {
    const object = meetingMinutesAgentText(match[1], 1000).trim();
    const recipient = meetingMinutesAgentText(match[2], 200).trim();
    const tail = meetingMinutesAgentText(match[3], 700).trim();
    if (/^(?:and\b|&|,\s*[A-Z])/u.test(tail)) return null;
    if (object && recipient) return { verb, recipient, recipientKey: recipient.toLowerCase(), object, tail };
  }
  return null;
}

function actionTimingClause(record = {}) {
  const timing = record.timing || {};
  if (!timing.kind || timing.kind === 'not_stated') return '';
  const wording = meetingMinutesAgentText(timing.wording, 300).trim().replace(/[.]+$/, '');
  if (wording) {
    const actionWords = new Set((meetingMinutesAgentText(record.action, 1600).toLowerCase().match(/[a-z0-9][a-z0-9'’-]+/g) || []));
    const timingWords = (wording.toLowerCase().match(/[a-z0-9][a-z0-9'’-]+/g) || []).filter((word) => word.length > 2);
    const alreadyPresent = timingWords.length && timingWords.filter((word) => actionWords.has(word)).length / timingWords.length >= 0.75;
    return alreadyPresent ? '' : lowerListItem(wording);
  }
  const exactDate = meetingMinutesAgentText(timing.exactDate, 20);
  return exactDate ? `by ${exactDate}` : '';
}

function lowerListItem(value = '') {
  const text = meetingMinutesAgentText(value, 1200).trim().replace(/[.]+$/, '');
  if (!text) return '';
  return /^[A-Z]{2,}\b/.test(text) ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function deliveryBundleItem(record = {}, frame = actionDeliveryFrame(record)) {
  if (!frame) return '';
  const tail = frame.tail ? `${/^[,;]/.test(frame.tail) ? '' : ' '}${frame.tail}` : '';
  const timing = actionTimingClause(record);
  return lowerListItem(`${frame.object}${tail}${timing ? ` ${timing}` : ''}`);
}

function joinedActionItems(items = []) {
  if (items.length < 2) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join('; ')}; and ${items.at(-1)}`;
}

function stableActionEvidence(records = [], limit = 24) {
  return [...new Set(records.flatMap((record) => record.evidenceIds || []))]
    .sort((left, right) => Number(String(left).match(/\d+/)?.[0] || Infinity)
      - Number(String(right).match(/\d+/)?.[0] || Infinity)).slice(0, limit);
}

// Compact multiple real deliverables without pretending they are duplicates.
// The exact owner and explicit named recipient must match, while timing stays
// beside its own item in the resulting sentence.
function bundleSameRecipientDeliveries(records = []) {
  const groups = new Map();
  (Array.isArray(records) ? records : []).forEach((record, index) => {
    if (isReviewerAuthored(record)) return;
    const frame = actionDeliveryFrame(record);
    const owners = exactActionOwners(record);
    if (!frame || !owners.length) return;
    // Refuse timing synthesis when the action already carries a condition
    // but its separate timing is not literally present. The timing kind may
    // be misclassified; before/after conditions can be deadlines or targets.
    // Keep this check local: the shared dependency parser also controls task
    // identity and must not change as part of a delivery-formatting fix.
    const timing = record.timing || {};
    const inlineCondition = /\b(?:once|before|after|when|as soon as|following|until|by)\b\s+\S/i.test(record.action || '');
    const timingWording = String(timing.wording || '').trim().replace(/[.]+$/, '').toLowerCase();
    if (timing.kind && timing.kind !== 'not_stated' && inlineCondition
      && (!timingWording || !String(record.action || '').toLowerCase().includes(timingWording))) return;
    const key = `${owners.join('|')}::${frame.recipientKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ record, frame, index });
  });
  const replacements = new Map(); const removed = new Set();
  for (const group of groups.values()) {
    if (group.length < 2 || group.length > 6) continue;
    // Two dated occurrences of the same instruction are distinct. Bundling
    // their displayed timing words could conceal different exact dates or turn
    // a target into a deadline after the duplicate guard kept them separate.
    if (group.some(({ record }, index) => group.slice(index + 1)
      .some(({ record: other }) => exactActionIdentityConflict(record, other)))) continue;
    // These are bundles of distinct documents, not a second deduper. Different
    // qualified versions of the same object need the conservative action checks
    // above; concatenating them duplicates work and can repeat timing clauses.
    if (group.some(({ frame }, index) => /;/.test(frame.object)
      || group.slice(index + 1).some(({ frame: other }) =>
        // Spelling normalisation only refuses bundling; it never authorises deduplication.
        hybridContentTokenOverlap(frame.object.replace(/[-‐‑‒–—]/g, ' '),
          other.object.replace(/[-‐‑‒–—]/g, ' ')) >= 0.5))) continue;
    const items = group.map(({ record, frame }) => deliveryBundleItem(record, frame)).filter(Boolean);
    if (items.length !== group.length || items.some((item) => item.split(/\s+/).length > 55)) continue;
    const [first] = group;
    const combined = {
      ...first.record,
      action: `Provide ${first.frame.recipient} with ${joinedActionItems(items)}.`,
      timing: { kind: 'not_stated', wording: '', exactDate: '' },
      evidenceIds: stableActionEvidence(group.map(({ record }) => record)),
      reviewFlagIds: [...new Set(group.flatMap(({ record }) => record.reviewFlagIds || []))].slice(0, 24)
    };
    actionDiagnostics.transition('bundled', group.map(({ record }) => record), [combined], { mechanism: 'same_recipient_deliveries' });
    replacements.set(first.index, combined);
    group.slice(1).forEach(({ index }) => removed.add(index));
  }
  return records.flatMap((record, index) => removed.has(index) ? [] : [replacements.get(index) || record]);
}

function documentWorkflowTokens(value = '') {
  const stop = new Set(['a', 'an', 'and', 'before', 'for', 'from', 'in', 'into', 'of', 'on', 'the', 'then', 'to', 'with',
    ...DELIVERY_BUNDLE_VERBS, ...DOCUMENT_WORKFLOW_VERBS, 'updated', 'revised', 'prepared', 'completed']);
  return new Set((meetingMinutesAgentText(value, 1600).toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || [])
    .filter((word) => !stop.has(word))
    .map((word) => word.replace(/(?:ing|ed|es|s)$/, ''))
    .filter((word) => !stop.has(word)));
}

function sameDocumentDeliveryWorkflow(left = {}, right = {}) {
  if (!sameExactActionOwners(left, right)) return false;
  const leftVerb = meetingMinutesAgentText(left.action, 1600).toLowerCase().match(/^([a-z-]+)/)?.[1] || '';
  const rightVerb = meetingMinutesAgentText(right.action, 1600).toLowerCase().match(/^([a-z-]+)/)?.[1] || '';
  const delivery = DELIVERY_BUNDLE_VERBS.has(leftVerb) ? left : (DELIVERY_BUNDLE_VERBS.has(rightVerb) ? right : null);
  const work = delivery === left ? right : left;
  const workVerb = meetingMinutesAgentText(work?.action, 1600).toLowerCase().match(/^([a-z-]+)/)?.[1] || '';
  if (!delivery || !work || !DOCUMENT_WORKFLOW_VERBS.has(workVerb) || !actionDeliveryFrame(delivery)) return false;
  const timingSignature = (record) => {
    const timing = record.timing || {};
    return !timing.kind || timing.kind === 'not_stated' ? ''
      : `${timing.kind}|${meetingMinutesAgentText(timing.wording, 300).toLowerCase()}|${meetingMinutesAgentText(timing.exactDate, 20)}`;
  };
  const workTiming = timingSignature(work); const deliveryTiming = timingSignature(delivery);
  if (workTiming && deliveryTiming && workTiming !== deliveryTiming) return false;
  // Compare the documents, not shared project/context wording or the named
  // recipient. A site visit can require several unrelated deliverables.
  const a = documentWorkflowTokens(work.action);
  const b = documentWorkflowTokens(actionDeliveryFrame(delivery).object);
  const shared = [...a].filter((word) => b.has(word));
  const sharedDocument = [...DOCUMENT_WORKFLOW_OBJECTS]
    .some((word) => shared.includes(word.replace(/(?:ing|ed|es|s)$/, '')));
  if (!sharedDocument) return false;
  // A common document noun and project words still do not identify two
  // differently qualified reports. Keep qualifiers when proving nesting.
  if (![...a].every((word) => b.has(word)) && ![...b].every((word) => a.has(word))) return false;
  if (shared.length >= 2) return true;
  const deliveryEvidence = new Set(delivery.evidenceIds || []);
  const sharedEvidence = (work.evidenceIds || []).some((id) => deliveryEvidence.has(id));
  return sharedEvidence && (a.size === 1 || b.size === 1);
}

function mergeDocumentDeliveryWorkflow(left = {}, right = {}) {
  const leftVerb = meetingMinutesAgentText(left.action, 1600).toLowerCase().match(/^([a-z-]+)/)?.[1] || '';
  const delivery = DELIVERY_BUNDLE_VERBS.has(leftVerb) ? left : right;
  const work = delivery === left ? right : left;
  const workText = meetingMinutesAgentText(work.action, 1600).trim().replace(/[.?!]+$/, '');
  const deliveryText = meetingMinutesAgentText(delivery.action, 1600).trim().replace(/[.?!]+$/, '');
  return `${workText}, then ${deliveryText.charAt(0).toLowerCase()}${deliveryText.slice(1)}.`;
}

function dedupeHybridActionRecords(records = [], options = {}) {
  const merged = [];
  const timingRank = { deadline: 4, target: 3, dependency: 2, not_stated: 1 };
  const wordingDetail = (value) => {
    const text = meetingMinutesAgentText(value, 1600);
    const qualifiers = (text.match(/\b(?:at|in|on|via|during|over|through|face[- ]?to[- ]?face|in person|online|on[- ]?site|weekend|morning|afternoon|evening|before|after|until|following)\b/gi) || []).length;
    const content = new Set((text.toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || [])).size;
    return (qualifiers * 2) + Math.min(content, 20) * 0.1;
  };
  const preference = (record = {}) => {
    const wording = meetingMinutesAgentText(record.action, 1600);
    const wordCount = wording.split(/\s+/).filter(Boolean).length;
    return Number(isClientReadyActionWording(wording)) * 100
      + Math.min(12, (record.evidenceIds || []).length) * 6
      + Math.min(4, (record.owners || []).length) * 4
      + Number(timingRank[record.timing?.kind] || 0) * 3
      + Math.min(35, wordCount)
      + wordingDetail(wording)
      - Math.max(0, wordCount - 45) * 2;
  };
  const stableEvidence = (rows) => [...new Set(rows.flatMap((record) => record.evidenceIds || []))]
    .sort((left, right) => Number(String(left).match(/\d+/)?.[0] || Infinity)
      - Number(String(right).match(/\d+/)?.[0] || Infinity)).slice(0, 12);
  const unitsById = new Map(normaliseSourceUnits(options.sourceUnits || []).map((unit) => [String(unit.id), unit]));
  const ownerEvidenceStrength = (record, owner) => {
    const wanted = meetingMinutesAgentText(owner, 160).toLowerCase();
    let score = 0;
    for (const id of record.evidenceIds || []) {
      const unit = unitsById.get(String(id));
      if (!unit || meetingMinutesAgentText(unit.speaker, 160).toLowerCase() !== wanted) continue;
      score = Math.max(score, 1);
      if (/\b(?:I['’]?ll|I\s+will|I\s+shall|I\s+can|I['’]?m\s+going\s+to|let\s+me)\b/i.test(unit.text || '')) score = 3;
    }
    return score;
  };
  const supportedOwner = (left, right) => {
    const leftOwners = left.owners || []; const rightOwners = right.owners || [];
    if (!leftOwners.length || !rightOwners.length) return null;
    if (leftOwners.some((owner) => rightOwners.some((other) => other.toLowerCase() === owner.toLowerCase()))) return null;
    const ranked = [
      ...leftOwners.map((owner) => ({ owner, score: ownerEvidenceStrength(left, owner) })),
      ...rightOwners.map((owner) => ({ owner, score: ownerEvidenceStrength(right, owner) }))
    ].sort((a, b) => b.score - a.score || a.owner.localeCompare(b.owner));
    return ranked[0]?.score >= 3 && ranked[0].score > (ranked[1]?.score || 0) ? ranked[0].owner : '';
  };
  for (const original of Array.isArray(records) ? records : []) {
    const record = structuredClone(original);
    const contactIndex = merged.findIndex(existing => reconcileDetailedContacts(existing, record));
    if (contactIndex >= 0) {
      merged[contactIndex] = reconcileDetailedContacts(merged[contactIndex], record).record;
      continue;
    }
    const candidate = { recordType: 'action', text: record.action, evidenceIds: record.evidenceIds, record };
    let complementaryDuplicate = null;
    let documentWorkflowDuplicate = null;
    let canonicalDocumentWorkflowDuplicate = null;
    let losslessPreferred = null;
    let sourceAwareDuplicate = null;
    let contextualReviewDuplicate = null;
    let completedTimingDuplicate = null;
    let roleClarificationDuplicate = null;
    let weekdayTimingReconciliation = null;
    const duplicate = merged.find((existing) => {
      if (sourceBoundIdenticalActionTimingCompletion(record, existing, options.sourceUnits || [])
        || sourceBoundLiteralDependencyTiming(record, existing, options.sourceUnits || [])) {
        completedTimingDuplicate = existing;
        return true;
      }
      if (sourceBoundReviewTimingContext(record, existing, options.sourceUnits || [])) {
        contextualReviewDuplicate = existing;
        return true;
      }
      if (isReviewerAuthored(record) || isReviewerAuthored(existing)
        || exactActionIdentityConflict(record, existing) || conflictingTimings(record, existing)) {
        actionDiagnostics.nomination(record, existing, 'local_dedupe', 'reviewer_identity_or_timing_conflict'); return false;
      }
      // Independent extraction IDs are local to each response. Keep distinct
      // review/document instructions intact for the later source-bound union;
      // broad containment can otherwise discard a mandatory operation here.
      if (options.independentDiscovery && record.action !== existing.action
        && [record, existing].every(row => /^review and (?:document|record|update|revise|amend|edit)\b/i.test(row.action))) return false;
      if (sourceBoundRoleClarificationDuplicate(record, existing, options.sourceUnits || [])) {
        roleClarificationDuplicate = existing;
        return true;
      }
      if (timingsDifferOnlyByWeekdayPreposition(record, existing)) {
        // Optional weekday wording may unblock a preserved instruction, but
        // must not admit a looser owner, operation or deliverable match.
        weekdayTimingReconciliation = reconcileCommitmentVariants(existing, record);
        if (weekdayTimingReconciliation) return true;
        if (!actionIsLosslesslyCovered(record, existing)
          && !actionIsLosslesslyCovered(existing, record)) return false;
      }
      if (sourceAwareParaphraseDuplicate(record, existing, { sourceUnits: options.sourceUnits })) {
        sourceAwareDuplicate = existing;
        return true;
      }
      if (actionContainmentConflict(record, existing)) { actionDiagnostics.nomination(record, existing, 'local_dedupe', 'local_containment_conflict'); return false; }
      // Existing document workflows construct a combined instruction rather
      // than dropping a step. They may retain one step's additional gate;
      // conflicting quantities, polarity or two different gates still block.
      const combinedDocumentWorkflow = sameComplementaryDocumentDeliverable(record, existing)
        || sameDocumentDeliveryWorkflow(record, existing) || sameCanonicalDocumentWorkflow(record, existing);
      if (commitmentScopeConflict(record, existing, { allowAdditionalScope: combinedDocumentWorkflow })) { actionDiagnostics.nomination(record, existing, 'local_dedupe', 'local_scope_conflict'); return false; }
      const recordCovered = actionIsLosslesslyCovered(record, existing);
      const existingCovered = actionIsLosslesslyCovered(existing, record);
      if (recordCovered || existingCovered) {
        losslessPreferred = recordCovered && !existingCovered ? existing
          : existingCovered && !recordCovered ? record
          : preference(record) > preference(existing) ? record : existing;
        return true;
      }
      const delivery = actionDeliveryFrame(record);
      const otherDelivery = actionDeliveryFrame(existing);
      // Unicode separators are not reliably tokenised by the loose matchers below.
      // Require the preserved-instruction proof above for those deliveries.
      if (delivery && otherDelivery && (/[‐‑‒–—]/u.test(String(record.action) + String(existing.action))
        || delivery.recipientKey !== otherDelivery.recipientKey
        || hybridContentTokenOverlap(delivery.object, otherDelivery.object) < 0.5)) return false;
      const workTypes = hybridActionTypes(record.action);
      const otherWorkTypes = hybridActionTypes(existing.action);
      if (workTypes.size && otherWorkTypes.size
        && ![...workTypes].some(type => otherWorkTypes.has(type))
        && !sameQuestionCommunicationDeliverable(record, existing)
        && !sameComplementaryDocumentDeliverable(record, existing)
        && !sameDocumentDeliveryWorkflow(record, existing)
        && !sameCanonicalDocumentWorkflow(record, existing)
        && !wayToParaphraseOf(record, existing) && !wayToParaphraseOf(existing, record)) return false;
      if (!options.independentDiscovery && sameCanonicalDocumentWorkflow(record, existing)) {
        canonicalDocumentWorkflowDuplicate = existing;
        return true;
      }
      const conventional = !distinctActionDeliverables(record, existing)
        && hybridCandidateMatchesRecord(candidate, existing)
        && hybridCandidateMatchesRecord({ recordType: 'action', text: existing.action, evidenceIds: existing.evidenceIds, record: existing }, record);
      if (conventional) return true;
      // The same thing said twice with no shared citation: "Hold a pre-audit
      // preparation meeting to review information" and "Hold a pre-audit
      // preparation meeting face to face at the hotel". Both must name the
      // same specific thing, have compatible owners, and do the same kind of
      // work - so "send the standards list" never merges with "review the
      // standards list".
      if (publishedActionNamesSameThing(record, existing) && sameActionApproach(record, existing)) return true;
      // One action's whole job sits inside another's: "Re-share the updated
      // deck" beside "Build the closing slide with the QR code and booking
      // link and re-share the updated deck". The longer row already commits
      // its owner to the shorter one's work.
      if (nestedActionWork(record, existing) || nestedActionWork(existing, record)) return true;
      // "Figure out a way to get her access" beside "Arrange secure
      // SharePoint access for her": the way-to row names no deliverable of
      // its own, so it is the same work however it is owned.
      if (wayToParaphraseOf(record, existing) || wayToParaphraseOf(existing, record)) return true;
      if (sameContactPurposeDeliverable(record, existing)) return true;
      // One conversation, one action, whichever side each wording was
      // written from. The owner is settled below.
      if (sameReciprocalContactDeliverable(record, existing)) return true;
      if (sameComplementaryDocumentDeliverable(record, existing)) {
        complementaryDuplicate = existing;
        return true;
      }
      if (sameDocumentDeliveryWorkflow(record, existing)) {
        documentWorkflowDuplicate = existing;
        return true;
      }
      if (!sameOrNestedActionDeliverable(record, existing)) return false;
      const recordQuestionFrame = questionCommunicationFrame(record);
      const existingQuestionFrame = questionCommunicationFrame(existing);
      if (recordQuestionFrame && existingQuestionFrame
        && !sameQuestionCommunicationDeliverable(record, existing)) return false;
      if (conflictingActionRecipients(record, existing)) return false;
      const recordOwners = record.owners || []; const existingOwners = existing.owners || [];
      const compatible = !recordOwners.length || !existingOwners.length
        || recordOwners.some((owner) => existingOwners.some((other) => other.toLowerCase() === owner.toLowerCase()));
      return compatible || Boolean(supportedOwner(record, existing));
    });
    if (!duplicate) {
      merged.push(record);
      continue;
    }
    const diagnosticInputs = actionDiagnostics.refs([duplicate, record]);
    const diagnosticIndex = merged.indexOf(duplicate);
    const traceLocalResult = () => actionDiagnostics.event(merged.includes(record) ? 'retained' : 'combined', diagnosticInputs,
      actionDiagnostics.refs([merged[diagnosticIndex], ...(merged.includes(record) ? [record] : [])]), { mechanism: 'local_dedupe' });
    if (completedTimingDuplicate === duplicate) {
      merged[merged.indexOf(duplicate)] = sourceBoundIdenticalActionTimingCompletion(
        record, duplicate, options.sourceUnits || [])
        || sourceBoundLiteralDependencyTiming(record, duplicate, options.sourceUnits || []);
      traceLocalResult();
      continue;
    }
    if (contextualReviewDuplicate === duplicate) {
      const preferred = sourceBoundReviewTimingContext(record, duplicate, options.sourceUnits || []);
      const recovery = {};
      for (const key of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
        if (Array.isArray(duplicate[key]) || Array.isArray(record[key])) {
          recovery[key] = [...new Set([...(duplicate[key] || []), ...(record[key] || [])])];
        }
      }
      for (const key of ['_timingPublicationIssue', '_timingClauseNote']) {
        if (duplicate[key] || record[key]) recovery[key] = preferred[key] || duplicate[key] || record[key];
      }
      Object.assign(duplicate, preferred, {
        evidenceIds: stableEvidence([duplicate, record]),
        reviewFlagIds: [...new Set([...(duplicate.reviewFlagIds || []), ...(record.reviewFlagIds || [])])].slice(0, 24),
        ...recovery
      });
      traceLocalResult();
      continue;
    }
    if (weekdayTimingReconciliation) {
      // Retain the proved winner's own timing and verification metadata,
      // together with both extractions' evidence, flags and timing warnings.
      merged[merged.indexOf(duplicate)] = weekdayTimingReconciliation.record;
      traceLocalResult();
      continue;
    }
    if (losslessPreferred) {
      // Keep the whole instruction, regardless of which extraction has more
      // citations. Reconciliation can verify the same complete-clause proof on
      // the final wording, so no removed-ID allowlist can hide later text loss.
      const evidenceIds = [...new Set([...(duplicate.evidenceIds || []), ...(record.evidenceIds || [])])];
      const reviewFlagIds = [...new Set([...(duplicate.reviewFlagIds || []), ...(record.reviewFlagIds || [])])];
      Object.assign(duplicate, losslessPreferred, { evidenceIds: evidenceIds.sort((left, right) =>
        Number(String(left).match(/\d+/)?.[0] || Infinity) - Number(String(right).match(/\d+/)?.[0] || Infinity)), reviewFlagIds });
      traceLocalResult();
      continue;
    }
    if (sourceAwareDuplicate === duplicate) {
      const preferred = sourceAwarePreferred(duplicate, record);
      const recovery = {};
      for (const key of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
        if (Array.isArray(duplicate[key]) || Array.isArray(record[key])) {
          recovery[key] = [...new Set([...(duplicate[key] || []), ...(record[key] || [])])];
        }
      }
      for (const key of ['_timingPublicationIssue', '_timingClauseNote']) {
        if (duplicate[key] || record[key]) recovery[key] = preferred[key] || duplicate[key] || record[key];
      }
      Object.assign(duplicate, preferred, {
        evidenceIds: stableEvidence([duplicate, record]),
        reviewFlagIds: [...new Set([...(duplicate.reviewFlagIds || []), ...(record.reviewFlagIds || [])])].slice(0, 24),
        ...recovery
      });
      traceLocalResult();
      continue;
    }
    if (roleClarificationDuplicate === duplicate) {
      // Either phrase carries the same instruction. Prefer the phrasing the
      // shared source itself uses, while retaining both citations and flags.
      const shared = new Set((record.evidenceIds || []).map(String));
      const sourceText = (options.sourceUnits || []).filter(unit => shared.has(String(unit.id))
        && (duplicate.evidenceIds || []).some(id => String(id) === String(unit.id)))
        .map(unit => String(unit.text || '')).join(' ');
      const sourceMatches = row => /\bin charge of\b/i.test(row.action || '')
        ? Number(/\bin charge of\b/i.test(sourceText))
        : Number(/\bresponsible for\b/i.test(sourceText));
      const preferred = sourceMatches(record) > sourceMatches(duplicate) ? record : duplicate;
      const recovery = {};
      for (const key of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
        if (Array.isArray(duplicate[key]) || Array.isArray(record[key])) {
          recovery[key] = [...new Set([...(duplicate[key] || []), ...(record[key] || [])])];
        }
      }
      for (const key of ['_timingPublicationIssue', '_timingClauseNote']) {
        if (duplicate[key] || record[key]) recovery[key] = preferred[key] || duplicate[key] || record[key];
      }
      Object.assign(duplicate, preferred, {
        evidenceIds: stableEvidence([duplicate, record]),
        reviewFlagIds: [...new Set([...(duplicate.reviewFlagIds || []), ...(record.reviewFlagIds || [])])].slice(0, 24),
        ...recovery
      });
      traceLocalResult();
      continue;
    }
    let preferred = preference(record) > preference(duplicate)
      || (preference(record) === preference(duplicate)
        && String(record.action || '').localeCompare(String(duplicate.action || '')) < 0)
      ? record : duplicate;
    const recordDetailsCovered = commitmentDetailsCovered(record, duplicate);
    const duplicateDetailsCovered = commitmentDetailsCovered(duplicate, record);
    if (recordDetailsCovered !== duplicateDetailsCovered) {
      preferred = recordDetailsCovered ? duplicate : record;
    }
    const recordCovered = commitmentCanBeRepresented(record, duplicate);
    const duplicateCovered = commitmentCanBeRepresented(duplicate, record);
    if (recordCovered !== duplicateCovered) preferred = recordCovered ? duplicate : record;
    if (complementaryDuplicate === duplicate) {
      preferred = { ...preferred, action: mergeComplementaryDocumentWording(record, duplicate) };
    }
    if (documentWorkflowDuplicate === duplicate) {
      preferred = { ...preferred, action: mergeDocumentDeliveryWorkflow(record, duplicate) };
    }
    if (canonicalDocumentWorkflowDuplicate === duplicate) {
      preferred = { ...preferred, action: mergeCanonicalDocumentWorkflowWording(record, duplicate) };
    }
    // Never let the vaguer "figure out a way to ..." wording win.
    if (wayToParaphraseOf(preferred, preferred === record ? duplicate : record)) {
      preferred = preferred === record ? duplicate : record;
    }
    if (!commitmentClausesRetained(record, preferred) || !commitmentClausesRetained(duplicate, preferred)) {
      merged.push(record);
      traceLocalResult();
      continue;
    }
    if (options.independentDiscovery && (!commitmentCanBeRepresented(record, preferred)
      || !commitmentCanBeRepresented(duplicate, preferred))) { merged.push(record); traceLocalResult(); continue; }
    const combinedEvidence = stableEvidence([duplicate, record]);
    const duplicateOwners = duplicate.owners || []; const recordOwners = record.owners || [];
    const ownersCompatible = !duplicateOwners.length || !recordOwners.length
      || duplicateOwners.some((owner) => recordOwners.some((other) => other.toLowerCase() === owner.toLowerCase()));
    const evidenceOwner = ownersCompatible ? null : supportedOwner(record, duplicate);
    // A reciprocal check-in that neither side clearly took on belongs to
    // both participants.
    const reciprocal = !ownersCompatible && !evidenceOwner && sameReciprocalContactDeliverable(record, duplicate);
    const documentHandoff = complementaryDocumentRecipientHandoff(record, duplicate);
    const combinedOwners = ownersCompatible || reciprocal || documentHandoff
      ? [...new Set([...duplicateOwners, ...recordOwners])].slice(0, 8)
      : evidenceOwner ? [evidenceOwner] : (preferred.owners || []);
    // Related or nested actions may legitimately dedupe, but a deadline may
    // travel only between strict versions of the same deliverable. This stops
    // a nearby task's date becoming authoritative on the retained wording.
    const sameDeliverable = (strictActionDeliverableMatch(record, duplicate)
      && strictActionDeliverableMatch(duplicate, record))
      || sameReciprocalContactDeliverable(record, duplicate);
    const timing = documentWorkflowDuplicate === duplicate
      ? (record.timing?.kind && record.timing.kind !== 'not_stated' ? record.timing : duplicate.timing)
      : sameDeliverable
      ? (Number(timingRank[record.timing?.kind] || 0) > Number(timingRank[duplicate.timing?.kind] || 0)
        ? record.timing : duplicate.timing)
      : preferred.timing;
    Object.assign(duplicate, preferred, {
      evidenceIds: combinedEvidence,
      owners: combinedOwners,
      timing,
      reviewFlagIds: [...new Set([...(duplicate.reviewFlagIds || []), ...(record.reviewFlagIds || [])])].slice(0, 24)
    });
    traceLocalResult();
  }
  const sorted = merged.sort((left, right) => {
    const first = (record) => Math.min(...(record.evidenceIds || []).map((id) => Number(String(id).match(/\d+/)?.[0] || Infinity)));
    return first(left) - first(right) || String(left.action || '').localeCompare(String(right.action || ''));
  });
  return bundleSameRecipientDeliveries(sorted);
}

// AI passes frequently phrase the same proposed deliverable differently and
// cite adjacent (rather than identical) turns. Keep this deliberately limited
// to proposals: automatic actions retain the stricter publication deduper.
// Predicate compatibility plus meaningful content overlap prevents a shared
// evidence window from collapsing distinct send/review/test/approve work.
function dedupeHybridActionProposals(records = []) {
  const merged = [];
  const evidenceSequence = (id) => Number(String(id || '').match(/\d+/)?.[0] || NaN);
  for (const original of Array.isArray(records) ? records : []) {
    const record = structuredClone(original);
    const owners = (record.owners || []).map((owner) => String(owner).trim().toLowerCase()).filter(Boolean);
    const types = hybridActionTypes(record.action);
    const duplicate = merged.find((existing) => {
      if (isReviewerAuthored(record) || isReviewerAuthored(existing)
        || commitmentScopeConflict(record, existing)) return false;
      const existingOwners = (existing.owners || []).map((owner) => String(owner).trim().toLowerCase()).filter(Boolean);
      if (owners.length && existingOwners.length && !owners.some((owner) => existingOwners.includes(owner))) return false;
      const contentOverlap = hybridContentTokenOverlap(record.action, existing.action);
      const evidence = new Set(existing.evidenceIds || []);
      const sharedEvidence = (record.evidenceIds || []).some((id) => evidence.has(id));
      const nearbyEvidence = (record.evidenceIds || []).some((id) =>
        (existing.evidenceIds || []).some((other) => {
          const left = evidenceSequence(id); const right = evidenceSequence(other);
          return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 4;
        }));
      const existingTypes = hybridActionTypes(existing.action);
      const hasCommonType = [...types].some((type) => existingTypes.has(type));
      const planningDecisionPair = [...types, ...existingTypes].every((type) => ['planning', 'decision'].includes(type));
      if (types.size && existingTypes.size && !hasCommonType
        && !(planningDecisionPair && sharedEvidence && contentOverlap >= 0.42)) return false;
      if (!commitmentCanBeRepresented(record, existing)
        && !commitmentCanBeRepresented(existing, record)) return false;
      return contentOverlap >= 0.56 || (sharedEvidence && contentOverlap >= 0.42)
        || (nearbyEvidence && contentOverlap >= 0.48);
    });
    if (!duplicate) {
      merged.push(record);
      continue;
    }
    // Select the covering wording before collecting metadata. A longer
    // sentence or more citations cannot displace an additional work step.
    const coveringRecord = commitmentCanBeRepresented(duplicate, record)
      && !commitmentCanBeRepresented(record, duplicate) ? record : duplicate;
    const evidenceIds = [...new Set([...(duplicate.evidenceIds || []), ...(record.evidenceIds || [])])];
    const reviewFlagIds = [...new Set([...(duplicate.reviewFlagIds || []), ...(record.reviewFlagIds || [])])];
    Object.assign(duplicate, coveringRecord, { evidenceIds, reviewFlagIds });
    duplicate.evidenceIds = [...new Set(duplicate.evidenceIds || [])]
      .sort((left, right) => Number(String(left).match(/\d+/)?.[0] || Infinity)
        - Number(String(right).match(/\d+/)?.[0] || Infinity));
  }
  return merged.sort((left, right) => {
    const first = (record) => Math.min(...(record.evidenceIds || []).map((id) => evidenceSequence(id)).filter(Number.isFinite));
    const leftFirst = first(left); const rightFirst = first(right);
    if (Number.isFinite(leftFirst) || Number.isFinite(rightFirst)) {
      if (!Number.isFinite(leftFirst)) return 1;
      if (!Number.isFinite(rightFirst)) return -1;
      if (leftFirst !== rightFirst) return leftFirst - rightFirst;
    }
    return String(left.action || '').localeCompare(String(right.action || ''));
  });
}

// Two adjacent content words that name a specific thing: "lot numbering",
// "standards list", "closing slide". Generic pairs ("next week", "the team",
// "further information") are not distinctive enough to identify a deliverable.
const DISTINCTIVE_PHRASE_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'those', 'these',
  'then', 'than', 'their', 'there', 'will', 'would', 'could', 'should', 'about', 'any', 'all', 'our', 'your', 'his',
  'her', 'its', 'are', 'was', 'were', 'has', 'have', 'had', 'been', 'not', 'can', 'may', 'also', 'once', 'when',
  'after', 'before', 'as', 'agreed', 'required', 'needed', 'relevant', 'related', 'including', 'regarding', 'whether']);
const DISTINCTIVE_PHRASE_GENERIC = new Set(['next', 'week', 'weeks', 'month', 'today', 'tomorrow', 'team', 'call', 'calls',
  'meeting', 'meetings', 'update', 'updates', 'information', 'details', 'plan', 'process', 'time', 'date', 'follow',
  'up', 'further', 'new', 'other', 'another', 'same', 'first', 'final', 'any', 'more', 'item', 'items', 'issue',
  'issues', 'point', 'points', 'thing', 'things', 'work', 'status', 'progress', 'questions', 'question', 'people',
  'everyone', 'client', 'relevant', 'current', 'latest', 'full', 'high', 'level', 'end', 'start', 'way']);
function distinctivePhrases(value = '') {
  const tokens = String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map((token) => (token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));
  const phrases = new Set();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const pair = [tokens[index], tokens[index + 1]];
    if (pair.some((token) => token.length < 3 || DISTINCTIVE_PHRASE_STOP.has(token) || DISTINCTIVE_PHRASE_GENERIC.has(token)
      || /^\d+$/.test(token))) continue;
    phrases.add(pair.join(' '));
  }
  return phrases;
}
function sharesDistinctivePhrase(left = '', right = '') {
  const other = distinctivePhrases(right);
  return [...distinctivePhrases(left)].some((phrase) => other.has(phrase));
}
function ownersOverlapOrOpen(left = {}, right = {}) {
  const a = (left.owners || []).map((owner) => String(owner).toLowerCase());
  const b = (right.owners || []).map((owner) => String(owner).toLowerCase());
  return !a.length || !b.length || a.some((owner) => b.includes(owner));
}
// The same thing already in Actions under a different verb: "Establish a
// system to implement lot numbering" beside "Implement a lot-numbering
// process". A suggestion adds nothing when a published action with a
// compatible owner already names the same specific thing and neither waits on
// the other.
function publishedActionNamesSameThing(published = {}, proposal = {}) {
  // "lot-numbering" and "lot numbering" are the same words.
  const unhyphen = (value) => String(value || '').replace(/(\w)-(\w)/g, '$1 $2');
  return ownersOverlapOrOpen(published, proposal)
    && sharesDistinctivePhrase(published.action, proposal.action)
    && hybridContentTokenOverlap(unhyphen(published.action), unhyphen(proposal.action)) >= 0.3
    && !distinctActionDeliverables(published, proposal);
}
const WAY_TO_ACTION = /^\s*(?:figure|work|find|sort)\s+(?:out\s+)?(?:a|some|the)\s+(?:\w+\s+)?way\b/i;

function sameActionPresentation(left = {}, right = {}) {
  const actionMatches = meetingMinutesAgentText(left.action || '', 1600).toLowerCase()
    === meetingMinutesAgentText(right.action || '', 1600).toLowerCase();
  const ownerKey = (record) => [...new Set((record.owners || []).map((owner) => String(owner).trim().toLowerCase()).filter(Boolean))]
    .sort().join('|');
  const timingKey = (record) => {
    const timing = record.timing || {};
    return [timing.kind || 'not_stated', timing.wording || '', timing.exactDate || '']
      .map((value) => String(value).trim().toLowerCase()).join('|');
  };
  return actionMatches && ownerKey(left) === ownerKey(right) && timingKey(left) === timingKey(right);
}

// Evidence is supporting metadata, not a user-facing rewrite. Later passes often
// find extra source turns for an action that is already published. Merge those
// citations (and their linked flags) into the existing row before calculating
// the proposal diff so the reviewer is not asked to approve an invisible edit.
function mergePublishedActionEvidence(published = [], complete = []) {
  return (Array.isArray(published) ? published : []).map((record) => {
    const matches = (Array.isArray(complete) ? complete : []).filter((candidate) => sameActionPresentation(record, candidate));
    if (!matches.length) return record;
    return {
      ...record,
      evidenceIds: [...new Set([...(record.evidenceIds || []), ...matches.flatMap((candidate) => candidate.evidenceIds || [])])].slice(0, 12),
      reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), ...matches.flatMap((candidate) => candidate.reviewFlagIds || [])])].slice(0, 24)
    };
  });
}

module.exports = {
  ACTION_DEPENDENCY_CLAUSE,
  NESTED_STOP,
  WAY_TO_ACTION,
  actionDeliveryFrame,
  bundleSameRecipientDeliveries,
  dedupeHybridActionProposals,
  dedupeHybridActionRecords,
  distinctActionDeliverables,
  hybridActionTypes,
  hybridCandidateMatchesRecord,
  isClientReadyActionWording,
  mergeDocumentDeliveryWorkflow,
  nestedActionWork,
  publishedActionNamesSameThing,
  sameActionApproach,
  sameDocumentDeliveryWorkflow,
  sharesDistinctivePhrase,
  strictActionDeliverableMatch,
  mergePublishedActionEvidence,
  sameActionPresentation
};
