'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const { hybridContentTokenOverlap, hybridRecordText, hybridTokenOverlap } = require('./meetingMinutesRecordMatching');
const { gateEnabled: transcriptTextGateEnabled, transcriptTextIssue } = require('./actionTextGate');
const { dedupeHybridActionProposals, dedupeHybridActionRecords, hybridCandidateMatchesRecord } = require('./meetingMinutesActionDuplicatePolicy');
const { requiresDocumentReferenceReview } = require('./meetingMinutesAssessmentEvidence');
const { refereeActionMaterializationIssues } = require('./meetingMinutesResponseContracts');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const { evidenceSupportScore, surroundingEvidence } = require('./meetingMinutesEvidenceContext');
const { actionDispositionWithContext, hybridActionsEquivalent } = require('./meetingMinutesProposalSelection');
const { normaliseSourceUnits } = require('./meetingMinutesSource');

// The candidate the referee publishes is not always the one that carried the
// owner. Discovery finds "Andrew will complete the MDD review" with Andrew
// named; recovery, citing only the line where Jacqui says "your review",
// finds the same deliverable with nobody; the referee is shown the second and
// publishes it. Across twenty live drafts 20 of 23 unowned published actions
// had an owned twin somewhere in the ensemble. When the published candidate
// names nobody, take the owner - and the lines that name them - from a twin
// that does; the evidence guard downstream still decides whether it stands.
function candidateOwnersOf(candidate = {}) {
  const owners = Array.isArray(candidate?.record?.owners) && candidate.record.owners.length ? candidate.record.owners
    : Array.isArray(candidate?.owners) ? candidate.owners : [];
  return owners.map((owner) => meetingMinutesAgentText(owner, 120)).filter(Boolean);
}

function borrowOwnersFromTwin(selected = {}, pool = []) {
  const action = meetingMinutesAgentText(selected?.record?.action || selected?.text, 1200);
  if (!action) return null;
  const evidence = new Set([...(selected.evidenceIds || []), ...(selected.record?.evidenceIds || [])]);
  const twins = (Array.isArray(pool) ? pool : []).filter((candidate) => candidate && candidate !== selected
    && candidate.candidateId !== selected.candidateId
    && ['action', 'action_chain', 'action_thread'].includes(String(candidate.recordType || ''))
    && candidateOwnersOf(candidate).length);
  const rank = { primary: 4, 'primary-2': 4, recovery: 3, salvage: 2, staged: 1 };
  const scored = twins.map((candidate) => {
    const text = meetingMinutesAgentText(candidate.record?.action || candidate.text, 1200);
    const overlap = hybridContentTokenOverlap(action, text);
    const shared = [...(candidate.evidenceIds || []), ...(candidate.record?.evidenceIds || [])].some((id) => evidence.has(id));
    const match = overlap >= 0.62 || (shared && overlap >= 0.48);
    return match ? { candidate, score: overlap + (shared ? 0.25 : 0) + (rank[candidate.sourcePass] || 0) * 0.01 } : null;
  }).filter(Boolean).sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  const twin = scored[0].candidate;
  actionDiagnostics.transition('owner_borrow_proposed', [selected.record || { action, evidenceIds: selected.evidenceIds || [] },
    twin.record || { action: twin.text, owners: candidateOwnersOf(twin), evidenceIds: twin.evidenceIds || [] }], [],
    { mechanism: 'borrowOwnersFromTwin', selectedCandidate: selected.candidateId, donorCandidate: twin.candidateId, donorPass: twin.sourcePass });
  return {
    owners: candidateOwnersOf(twin),
    evidenceIds: [...new Set([...(twin.evidenceIds || []), ...(twin.record?.evidenceIds || [])])]
  };
}

function reconstructRefereeActions(dispositions = [], candidates = [], sourceUnits = [], options = {}) {
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.candidateId)
    .map((candidate) => [String(candidate.candidateId), candidate]));
  const ownerPool = [...(Array.isArray(candidates) ? candidates : []), ...(Array.isArray(options.ownerPool) ? options.ownerPool : [])];
  // Referee contracts deliberately compact away records and review flags.
  // Recover the restriction by exact candidate ID from the server's ledger,
  // not from model wording or an inferred twin.
  const documentReviewRecords = new Map(ownerPool
    .filter(candidate => candidate?.candidateId && requiresDocumentReferenceReview(candidate.record))
    .map(candidate => [String(candidate.candidateId), candidate.record]));
  const unresolvedMaterializations = refereeActionMaterializationIssues(dispositions, candidates);
  const unresolvedIds = new Set(unresolvedMaterializations.map((item) => item.candidateId));
  let borrowedOwners = 0;
  const evidenceByTarget = new Map();
  const rows = [];
  const dispositionKind = (value) => ({ core: 'publish', keep: 'publish' }[value] || value);
  for (const disposition of Array.isArray(dispositions) ? dispositions : []) {
    const kind = dispositionKind(disposition?.disposition || disposition?.classification);
    const candidateId = String(disposition?.candidateId || '');
    if (unresolvedIds.has(candidateId)) continue;
    const candidate = candidatesById.get(candidateId);
    const targetId = meetingMinutesAgentText(disposition?.targetId || disposition?.mergeTarget, 160);
    const targetCandidate = targetId ? candidatesById.get(targetId) : null;
    const selected = kind === 'merge' ? targetCandidate : candidate;
    const evidenceKey = targetId || candidateId;
    if (evidenceKey) {
      const evidence = evidenceByTarget.get(evidenceKey) || [];
      evidenceByTarget.set(evidenceKey, [...new Set([
        ...evidence,
        ...(candidate?.evidenceIds || candidate?.record?.evidenceIds || []),
        ...(Array.isArray(disposition?.evidenceIds) ? disposition.evidenceIds : [])
      ])]);
    }
    if (!['publish', 'proposal'].includes(kind) || !selected || selected.recordType !== 'action') continue;
    const action = meetingMinutesAgentText(selected.record?.action || selected.text, 1200);
    if (!action) continue;
    // A referee verdict cannot settle a document association or acceptance
    // that source-context recovery explicitly left for a human. Keep that
    // restriction through reconstruction, before any owner inference.
    const documentReviewRecord = documentReviewRecords.get(String(selected.candidateId));
    const documentReviewRequired = Boolean(documentReviewRecord);
    const materializedKind = documentReviewRequired ? 'proposal' : kind;
    let owners = documentReviewRequired ? [...(documentReviewRecord.owners || [])] : candidateOwnersOf(selected);
    if (!documentReviewRequired && !owners.length && Array.isArray(disposition?.owners)) {
      owners = disposition.owners.map((owner) => meetingMinutesAgentText(owner, 120)).filter(Boolean);
    }
    let borrowedEvidence = [];
    if (!documentReviewRequired && !owners.length && kind === 'publish') {
      const borrowed = borrowOwnersFromTwin(selected, ownerPool);
      if (borrowed) { owners = borrowed.owners; borrowedEvidence = borrowed.evidenceIds; borrowedOwners += 1; }
    }
    const diagnosticSource = selected.record || { action, owners: candidateOwnersOf(selected), evidenceIds: selected.evidenceIds || [] };
    rows.push({
      kind: materializedKind,
      targetId: targetId || candidateId,
      record: {
        id: meetingMinutesAgentText(selected.record?.id || targetId || candidateId, 160),
        action,
        owners,
        timing: selected.record?.timing || selected.timing
          || { kind: 'not_stated', wording: '', exactDate: '' },
        evidenceIds: [...new Set([
          ...(selected.evidenceIds || selected.record?.evidenceIds || []),
          ...(Array.isArray(disposition?.evidenceIds) ? disposition.evidenceIds : []),
          ...borrowedEvidence
        ])],
        reviewFlagIds: documentReviewRequired ? [...documentReviewRecord.reviewFlagIds] : []
      }
    });
    actionDiagnostics.transition(borrowedEvidence.length ? 'owner_borrowed' : 'referee_materialised', [diagnosticSource], [rows.at(-1).record],
      { mechanism: 'reconstructRefereeActions', candidateId, disposition: kind,
        ...(documentReviewRequired ? { materializedDisposition: materializedKind, documentReviewRequired: true } : {}) });
  }
  const writtenRows = rows.filter((item) => !(transcriptTextGateEnabled()
    && transcriptTextIssue(item.record.action, sourceUnits)));
  if (writtenRows.length !== rows.length) {
    console.log(JSON.stringify({
      event: 'meeting_agent_transcript_text_gate', stage: 'referee_reconstruction',
      removed: rows.length - writtenRows.length,
      items: rows.filter((item) => !writtenRows.includes(item)).map((item) => ({
        reason: transcriptTextIssue(item.record.action, sourceUnits),
        action: meetingMinutesAgentText(item.record.action, 160)
      }))
    }));
  }
  rows.splice(0, rows.length, ...writtenRows);
  const withMergedEvidence = rows.map((item) => ({
    ...item.record,
    evidenceIds: [...new Set([
      ...(item.record.evidenceIds || []),
      ...(evidenceByTarget.get(item.targetId) || [])
    ])].slice(0, 12)
  }));
  const published = withMergedEvidence.filter((record, index) => rows[index].kind === 'publish');
  const proposed = withMergedEvidence.filter((record, index) => rows[index].kind === 'proposal');
  if (borrowedOwners) {
    console.info(JSON.stringify({ event: 'meeting_agent_owner_borrowed', journeyId: options.journeyId || '', borrowed: borrowedOwners, published: published.length }));
  }
  return {
    actions: dedupeHybridActionRecords(normaliseAgentResult(
      { actions: published }, sourceUnits, 'actions', { meetingDate: options.meetingDate }
    ).actions),
    actionProposals: dedupeHybridActionProposals(normaliseAgentResult(
      { actions: proposed }, sourceUnits, 'actions', { enforceEvidence: false, meetingDate: options.meetingDate }
    ).actions),
    ...(unresolvedMaterializations.length ? { unresolvedMaterializations } : {})
  };
}

// A referee is another probabilistic pass, so it can occasionally omit a
// deliverable which two independent discovery passes both found. Do not publish
// that work automatically: recover it into the existing accept/reject proposal
// UI. Single-source staged rows deliberately do not qualify here.
function corroboratedOmittedActionProposals(candidates = [], records = [], sourceUnits = [], options = {}) {
  const eligible = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
    candidate?.recordType === 'action'
    && ['staged', 'primary', 'primary-2', 'recovery'].includes(candidate?.sourcePass)
    && hybridRecordText(candidate?.record || candidate)
    && Array.isArray(candidate?.evidenceIds)
    && candidate.evidenceIds.length
  );
  const groups = [];
  for (const candidate of eligible) {
    const group = groups.find((items) => items.some((other) =>
      hybridCandidateMatchesRecord(candidate, other.record || other)
      || hybridCandidateMatchesRecord(other, candidate.record || candidate)
    ));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const sourceRank = { primary: 3, 'primary-2': 3, recovery: 2, staged: 1 };
  const proposed = [];
  for (const group of groups) {
    const sources = [...new Set(group.map((candidate) => candidate.sourcePass))];
    if (sources.length < 2) continue;
    if (group.some((candidate) => (records || []).some((record) => hybridCandidateMatchesRecord(candidate, record)))) continue;
    const ordered = [...group].sort((left, right) => Number(sourceRank[right.sourcePass] || 0) - Number(sourceRank[left.sourcePass] || 0)
      || hybridRecordText(right.record || right).length - hybridRecordText(left.record || left).length);
    const preferred = ordered[0];
    // Ownership or timing reported by only one pass is not corroborated. The
    // normal evidence validator remains the final authority even when fields do
    // agree across sources.
    const ownerCounts = new Map();
    const timingCounts = new Map();
    for (const candidate of group) {
      for (const owner of candidate.record?.owners || []) {
        const key = String(owner).trim().toLowerCase();
        if (key) ownerCounts.set(key, { owner, sources: new Set([...(ownerCounts.get(key)?.sources || []), candidate.sourcePass]) });
      }
      const timing = candidate.record?.timing;
      if (timing && timing.kind && timing.kind !== 'not_stated') {
        const key = JSON.stringify(timing);
        timingCounts.set(key, { timing, sources: new Set([...(timingCounts.get(key)?.sources || []), candidate.sourcePass]) });
      }
    }
    const owners = [...ownerCounts.values()].filter((entry) => entry.sources.size >= 2).map((entry) => entry.owner);
    const timing = [...timingCounts.values()].find((entry) => entry.sources.size >= 2)?.timing
      || { kind: 'not_stated', wording: '', exactDate: '' };
    proposed.push({
      ...(preferred.record || {}),
      action: hybridRecordText(preferred.record || preferred),
      owners,
      timing,
      evidenceIds: [...new Set(group.flatMap((candidate) => candidate.evidenceIds || []))].slice(0, 8)
    });
  }
  return normaliseAgentResult({ actions: proposed }, sourceUnits, 'actions', {
    meetingDate: options.meetingDate
  }).actions.slice(0, 8);
}

function strongOmittedDiscoveryProposals(candidates = [], records = [], sourceUnits = [], options = {}) {
  const deterministic = (candidates || []).filter((candidate) => candidate.sourcePass === 'deterministic'
    && candidate.recordType === 'action'
    && ['committed', 'accepted_request', 'conditional_commitment'].includes(candidate.dispositionHint));
  const proposals = [];
  for (const candidate of (candidates || []).filter((item) => ['primary', 'recovery'].includes(item.sourcePass)
    && item.recordType === 'action' && item.record?.action && item.evidenceIds?.length)) {
    if ((records || []).some((record) => hybridCandidateMatchesRecord(candidate, record))) continue;
    if (!deterministic.some((cue) => hybridCandidateMatchesRecord(cue, candidate.record))) continue;
    const evidence = surroundingEvidence(sourceUnits, candidate.evidenceIds).filter((unit) => unit.cited)
      .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
    if (evidenceSupportScore(candidate.record.action, evidence) < 0.3) continue;
    if (!['committed', 'accepted_request', 'conditional_commitment'].includes(actionDispositionWithContext(candidate.record, sourceUnits, evidence))) continue;
    proposals.push(candidate.record);
  }
  return dedupeHybridActionRecords(normaliseAgentResult({ actions: proposals }, sourceUnits, 'actions', {
    meetingDate: options.meetingDate
  }).actions).slice(0, 8);
}

// A concrete volunteered visit followed immediately by the requester defining
// the checks is a complete accepted assignment even without a literal “yes”.
// This is a general discourse pattern (offer -> scope acceptance), not a
// meeting-type rule. Keep its wording close to the cited request.
function acceptedVisitAssignmentActions(sourceUnits = [], records = [], options = {}) {
  const units = normaliseSourceUnits(sourceUnits).filter((unit) => unit.classification !== 'remove' || unit.restored);
  const offer = /\bI\s+(?:can|could|would be able to)\s+(?:go|visit|attend)\b/i;
  const request = /\b(?:can|could|would)\s+(?:somebody|someone|you)\s+(?:go|visit|attend|look|inspect|check)\b/i;
  const scopedCheck = /^\s*(?:(?:and|then|also)\s+)?(?:(?:when|once|after)\b.{0,100}?,\s*)?(?:please\s+)?(?:check|inspect|verify|test)\b/i;
  const results = [];
  for (let index = 0; index < units.length; index += 1) {
    const offered = units[index];
    if (!offer.test(offered.text || '')) continue;
    const prior = units.slice(Math.max(0, index - 2), index).reverse().find((unit) => request.test(unit.text || ''));
    const scope = units.slice(index + 1, Math.min(units.length, index + 3)).find((unit) => scopedCheck.test(unit.text || ''));
    if (!prior || !scope) continue;
    const object = meetingMinutesAgentText(String(prior.text || '').match(/\b(?:look at|visit|inspect|check)\s+(?:the\s+)?([^?.!,]{2,80})/i)?.[1], 100);
    const checks = meetingMinutesAgentText(String(scope.text || '')
      .replace(/^\s*(?:(?:and|then|also)\s+)?(?:(?:when|once|after)\b.{0,100}?,\s*)?/i, ''), 700)
      .replace(/[.]+$/, '');
    if (!checks || !object) continue;
    // Only the owner's own visit clause may supply its timing. A different
    // task in the same turn (or a date inside its dependency) is not a visit
    // date. Keep a complete temporal tail, including its qualifiers/bounds.
    const temporalWords = new Set('today tonight tomorrow monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december this next last previous week weeks day days month months year years weekend morning afternoon evening noon midnight early mid late end start of the on at in by before after within until from to or and not no earlier later than probably presumably possibly maybe perhaps hopefully ideally preferably approximately roughly around about if possible all being well least latest first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth one two three four five six seven eight nine ten eleven twelve every each weekly daily monthly am pm utc gmt bst cet cest'.split(' '));
    const ownClause = String(offered.text || '').split(/[;!?]|\.(?!\d)|\b(?:and|but|then)\s+(?=(?:I|we|[A-Z][a-z]+)\s+(?:will|shall|can|could|must|need(?:s)? to|have to|am going to|is going to|are going to)|I['’](?:ll|m going to)|we['’]re going to)/i)
      .map(value => value.trim()).find(value => /^(?:(?:yes|yeah|okay|ok|sure|well|right)[, ]+)*I\s+(?:can|could|would be able to)\s+(?:go|visit|attend)\b/i.test(value));
    const ownOffer = ownClause?.match(offer);
    let tail = meetingMinutesAgentText(ownOffer ? ownClause.slice(ownOffer.index + ownOffer[0].length) : '', 220)
      .replace(/[.!?]+$/, '');
    // A destination can repeat the request or refer back as "down there".
    // Strip only that source-bound location, never an arbitrary new object.
    tail = tail.replace(/^(?:(?:down|up|over|out|back)\s+)?(?:there|here)\b\s*/i, '');
    const objectWords = object.split(/\s+/).filter(Boolean);
    for (let offset = 0; offset < objectWords.length; offset += 1) {
      const destination = objectWords.slice(offset).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      tail = tail.replace(new RegExp(`^(?:(?:down|up|over|out|back)\\s+)?(?:(?:to|at)\\s+)?(?:the\\s+)?${destination}\\b\\s*`, 'i'), '')
        .replace(new RegExp(`\\s+to\\s+(?:the\\s+)?${destination}$`, 'i'), '').trim();
    }
    const words = tail.toLowerCase().match(/[a-z]+/g) || [];
    const hasCalendar = /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(tail);
    const timingWord = hasCalendar && words.every(word => temporalWords.has(word)) ? tail : '';
    const action = {
      id: `accepted-visit-${offered.id}`,
      action: `Visit the ${object} and ${checks.charAt(0).toLowerCase()}${checks.slice(1)}.`,
      owners: [offered.speaker].filter(Boolean),
      timing: timingWord ? { kind: 'target', wording: timingWord, exactDate: '' } : { kind: 'not_stated', wording: '', exactDate: '' },
      evidenceIds: [prior.id, offered.id, scope.id]
    };
    if (!(records || []).some((record) => hybridCandidateMatchesRecord({ recordType: 'action', text: action.action, evidenceIds: action.evidenceIds, record: action }, record))) results.push(action);
  }
  const normalised = normaliseAgentResult({ actions: results }, sourceUnits, 'actions', {
    enforceEvidence: false, meetingDate: options.meetingDate
  }).actions;
  const validIds = new Set(units.map((unit) => unit.id));
  for (const action of normalised) {
    const source = results.find((candidate) => candidate.id === action.id);
    if (source) action.evidenceIds = (source.evidenceIds || []).filter((id) => validIds.has(id));
  }
  return normalised;
}

function operationalGapActionText(questionText = '') {
  const clean = meetingMinutesAgentText(questionText, 1200).replace(/[?.!]+$/, '');
  if (/^how\s+/i.test(clean)) {
    // Turn question word order into minute/action word order.  Leaving the
    // auxiliary in front of the subject produced text such as "Clarify how is
    // feedback captured", which is needlessly awkward in the review UI.
    const inverted = clean.match(/^how\s+(is|are|was|were|do|does|did|has|have|had|can|could|will|would|should)\s+(.+)$/i);
    if (inverted) {
      const [, auxiliary, remainder] = inverted;
      const words = remainder.split(/\s+/);
      const boundary = words.findIndex((word, index) => index > 0 && /^(?:being|captured|recorded|tracked|logged|documented|reported|stored|routed|monitored|provided|handled|managed|processed|working|work|operate|operating)$/i.test(word));
      if (boundary > 0) {
        return `Clarify how ${words.slice(0, boundary).join(' ')} ${auxiliary.toLowerCase()} ${words.slice(boundary).join(' ')}`
          .replace(/\b(currently|usually|normally|consistently)\s+(is|are|was|were|has|have|had)\b/i, '$2 $1');
      }
    }
    return clean.replace(/^how\s+/i, 'Clarify how ');
  }
  if (/^whether\s+/i.test(clean)) return clean.replace(/^whether\s+/i, 'Determine whether ');
  if (/^who\s+/i.test(clean)) return clean.replace(/^who\s+/i, 'Confirm who ');
  if (/^what\s+/i.test(clean)) return clean.replace(/^what\s+/i, 'Define what ');
  return `Resolve: ${clean}`;
}

function sourceOperationalGapActionText(questionText = '', gapText = '') {
  const combined = `${questionText} ${gapText}`;
  const verbs = [];
  if (/\bcaptur(?:e|ed|ing)\b/i.test(combined)) verbs.push('capturing');
  if (/\btrack(?:ed|ing)?\b/i.test(combined)) verbs.push('tracking');
  if (/\brecord(?:ed|ing)?\b/i.test(combined)) verbs.push('recording');
  if (/\breport(?:ed|ing)?\b/i.test(combined)) verbs.push('reporting');
  if (/\bmonitor(?:ed|ing)?\b/i.test(combined)) verbs.push('monitoring');
  const object = combined.match(/\b(?:client(?:[- ]delivery)?|customer|project|quality|staff|consultant)?\s*(?:feedback|information|data|issues|requests|leads?|opportunities|decisions|actions)\b/i)?.[0]?.trim();
  const activities = [...new Set(verbs)].slice(0, 3);
  if (!activities.length) return 'Clarify the current operational process described in the cited passages.';
  const activityText = activities.length === 1 ? activities[0] : `${activities.slice(0, -1).join(', ')} and ${activities.at(-1)}`;
  return `Clarify the current process for ${activityText} ${object || 'the relevant information'}.`;
}

// An unresolved operational question is not an agreed action. When its nearby
// evidence explicitly describes a current process gap, however, it is useful to
// offer an ownerless follow-up for human acceptance rather than silently lose
// the issue. This path can never auto-publish an action.
function unresolvedOperationalGapProposals(discussion = [], records = [], sourceUnits = [], options = {}) {
  const units = normaliseSourceUnits(sourceUnits);
  const byId = new Map(units.map((unit, index) => [unit.id, { unit, index }]));
  const operational = /\b(?:captur(?:e|ed|ing)|record(?:ed|ing)?|track(?:ed|ing)?|log(?:ged|ging)?|document(?:ed|ing)?|monitor(?:ed|ing)?|measure(?:d|ment|ing)?|store(?:d|ing)?|rout(?:e|ed|ing)|report(?:ed|ing)?|workflow|process)\b/i;
  const currentStateQuestion = /^(?:how|what)\b[\s\S]*\b(?:current|currently|today|at present|now)\b/i;
  const sourceCurrentState = /\b(?:current|currently|today|at present|at the moment|until now|now)\b/i;
  const gap = /\b(?:not always|not consistently|inconsisten(?:t|tly)|var(?:y|ies|ied|ying)|depends? on|not yet|unclear|ad[ -]?hoc|no (?:clear|consistent|formal)|without (?:a )?(?:clear|consistent|formal))\b/i;
  const proposed = [];
  for (const topic of Array.isArray(discussion) ? discussion : []) {
    for (const question of topic?.openQuestions || []) {
      if (!operational.test(question?.text || '') || !currentStateQuestion.test(question?.text || '')) continue;
      const anchorIndexes = (question.evidenceIds || []).map((id) => byId.get(id)?.index).filter(Number.isInteger);
      if (!anchorIndexes.length) continue;
      const nearby = units.filter((_unit, index) => anchorIndexes.some((anchor) => Math.abs(index - anchor) <= 10));
      const gapUnits = nearby.filter((unit) => gap.test(unit.text || ''));
      if (!gapUnits.length) continue;
      const evidenceIds = [...new Set([...(question.evidenceIds || []), ...gapUnits.map((unit) => unit.id)])].slice(0, 8);
      const proposal = {
        action: operationalGapActionText(question.text), owners: [],
        timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds
      };
      if ((records || []).some((record) => hybridTokenOverlap(proposal.action, hybridRecordText(record)) >= 0.55)) continue;
      proposed.push(proposal);
      if (proposed.length >= 4) break;
    }
    if (proposed.length >= 4) break;
  }
  // The referee may compress or omit the current-state question. Fall back to
  // the source exchange itself: a question about the present process followed
  // nearby by an explicit inconsistency is strong enough for a proposal, but
  // never for automatic publication.
  for (let index = 0; index < units.length && proposed.length < 4; index += 1) {
    const questionUnit = units[index];
    if (!questionUnit.text?.includes('?') || !operational.test(questionUnit.text) || !sourceCurrentState.test(questionUnit.text)) continue;
    if (proposed.some((record) => (record.evidenceIds || []).includes(questionUnit.id))) continue;
    const nearby = units.slice(Math.max(0, index - 2), Math.min(units.length, index + 11));
    const gapUnits = nearby.filter((unit) => gap.test(unit.text || ''));
    if (!gapUnits.length) continue;
    const proposal = {
      action: sourceOperationalGapActionText(questionUnit.text, gapUnits.map((unit) => unit.text).join(' ')),
      owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' },
      evidenceIds: [...new Set([questionUnit.id, ...gapUnits.map((unit) => unit.id)])].slice(0, 8)
    };
    if ([...(records || []), ...proposed].some((record) => hybridTokenOverlap(proposal.action, hybridRecordText(record)) >= 0.55)) continue;
    proposed.push(proposal);
  }
  // These are intentionally allowed to retain a question/status evidence
  // disposition because acceptance by the reviewer is what promotes them.
  const normalised = normaliseAgentResult({ actions: proposed }, sourceUnits, 'actions', {
    enforceEvidence: false, meetingDate: options.meetingDate
  }).actions;
  const validIds = new Set(units.map((unit) => unit.id));
  for (const action of normalised) {
    const source = proposed.find((candidate) => candidate.action === action.action);
    if (source) action.evidenceIds = [...new Set([
      ...(action.evidenceIds || []), ...(source.evidenceIds || []).filter((id) => validIds.has(id))
    ])].slice(0, 8);
  }
  return normalised;
}

// Recover two common multi-turn commitments which do not contain the simple
// "we need to do that" wording handled below:
//   1. a concrete question whose answer is explicitly deferred until a known
//      meeting/check ("I'll know after Wednesday"); and
//   2. a proposed option followed by a first-person commitment to work through
//      the criteria needed to decide it.
// These are deliberately proposals, never automatic actions. The goal is to
// keep strongly evidenced work reviewable when an optional discovery source
// times out without weakening the publication threshold.
function deferredCommitmentThreadProposal(thread, evidenceUnits = [], resolveSpeaker = (value) => value) {
  const ordered = [...evidenceUnits].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const replacePerspective = (value, referencedSpeaker, addressedSpeaker = referencedSpeaker) => meetingMinutesAgentText(value, 300)
    .replace(/\b(?:I|me)\b/gi, referencedSpeaker || 'the requester')
    .replace(/\bmy\b/gi, referencedSpeaker ? `${referencedSpeaker}'s` : "the requester's")
    .replace(/\bhaving\s+you\b/i, referencedSpeaker ? `${referencedSpeaker} should be` : 'the requester should be')
    .replace(/\bputting\s+you\b/i, referencedSpeaker ? `put ${referencedSpeaker}` : 'put the requester')
    .replace(/\bassigning\s+you\b/i, referencedSpeaker ? `assign ${referencedSpeaker}` : 'assign the requester')
    .replace(/\bmoving\s+you\b/i, referencedSpeaker ? `move ${referencedSpeaker}` : 'move the requester')
    .replace(/\bkeeping\s+you\b/i, referencedSpeaker ? `keep ${referencedSpeaker}` : 'keep the requester')
    .replace(/\byou\b/gi, addressedSpeaker || 'the other participant')
    .replace(/\byour\b/gi, addressedSpeaker ? `${addressedSpeaker}'s` : "the other participant's")
    .replace(/\s+/g, ' ').trim();

  const deferredAnswer = /\b(?:i|we)\s*(?:['’]ll|will)\s+(?:know|confirm|find out|have (?:an? )?answer|be able to confirm)\b/i;
  const resolution = ordered.find((unit) => deferredAnswer.test(unit.text || ''));
  const earlierQuestions = resolution ? ordered.filter((unit) =>
    Number(unit.sequence || 0) < Number(resolution.sequence || 0) && /\?\s*$/.test(unit.text || '')
  ) : [];
  const question = earlierQuestions.find((unit) => /^\s*(?:so\s+)?(?:will|can|could|would|do|does|is|are)\b/i.test(unit.text || ''))
    || earlierQuestions.at(-1);
  if (resolution && question) {
    const rewrittenQuestion = replacePerspective(String(question.text || '').replace(/\?+$/, ''), question.speaker, resolution.speaker)
      .replace(/^so\s+/i, '').trim();
    const auxiliary = rewrittenQuestion.match(/^(will|can|could|would|is|are|do|does)\s+(.+)$/i);
    let subject = auxiliary?.[2] || rewrittenQuestion.replace(/^whether\s+/i, '');
    if (auxiliary && question.speaker) {
      const escapedSpeaker = question.speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const remainder = subject.replace(new RegExp(`^${escapedSpeaker}\\s+`, 'i'), '');
      if (remainder !== subject) {
        const verb = auxiliary[1].toLowerCase();
        subject = /^(?:do|does)$/i.test(verb) ? `${question.speaker} ${remainder}` : `${question.speaker} ${verb} ${remainder}`;
      }
      subject = subject.replace(new RegExp(`\\bso that ${escapedSpeaker} can\\b`, 'i'), 'so that they can');
    }
    subject = subject.trim();
    // The knowledge answer, not any earlier timed task in the thread, owns
    // this proposal's timing. Copy an explicit relation from that same clause;
    // implicit "know then" references remain untimed rather than borrowing a date.
    const clauses = String(resolution.text || '').split(/[;!?]|\.(?!\d)|\b(?:and|but|then)\s+(?=(?:I|we|[A-Z][a-z]+)\s+(?:will|shall|can|could|must|need(?:s)? to|have to|am going to|is going to|are going to)|I['’](?:ll|m going to)|we['’]re going to)/i).map(value => value.trim()).filter(Boolean);
    const knowledge = clauses.find(value => /^(?:(?:so|and|well|yes|yeah|okay|ok)[, ]+)*(?:I|we)\s*(?:['’]ll|will)\s+(?:know|confirm|find out|have (?:an? )?answer|be able to confirm)\b/i.test(value))
      || clauses.find(value => /,\s*so\s+(?:I|we)\s*(?:['’]ll|will)\s+(?:know|confirm|find out|have (?:an? )?answer|be able to confirm)\b/i.test(value));
    let timingWord = '';
    const answer = knowledge?.match(deferredAnswer);
    if (answer) {
      const tail = knowledge.slice(answer.index + answer[0].length).trim().replace(/^(?:more|that|the answer)\s+/i, '').replace(/[.!?]+$/, '');
      if (/^(?:(?:probably|presumably|possibly|maybe|hopefully|ideally|roughly|approximately)\s+)*(?:after|before|on|by|once|when|until|following|within)\b/i.test(tail)) {
        timingWord = tail;
      } else if (/^(?:(?:probably|presumably|possibly|maybe|hopefully|ideally|roughly|approximately|early|late)\s+)*(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)(?:\s+(?:morning|afternoon|evening|if possible|all being well))?$/i.test(tail)) {
        timingWord = tail;
      }
      // A meeting followed by "I'll know then" is useful source context,
      // but does not state when the follow-up confirmation itself is due.
      // Keep that proposal and its citations without inventing a deadline.
    }
    // A copied dependency must not carry an independent next obligation.
    // Withhold an ambiguous coordinated tail instead of donating its date or
    // dropping one of the source conditions to manufacture a shorter timing.
    if (/\b(?:and|but)\s+(?:(?:I|we)\s+)?(?:will|shall|can|could|must|need(?:s)?\s+to|have\s+to|want(?:s)?\s+to|am\s+going\s+to)\b|\bthen\s+[a-z]+\b/i.test(timingWord)) timingWord = '';
    timingWord = meetingMinutesAgentText(timingWord, 220);
    if (timingWord) timingWord = timingWord.charAt(0).toUpperCase() + timingWord.slice(1);
    if (subject.split(/\s+/).length >= 3) return {
      action: `Confirm whether ${subject}${timingWord ? ` ${timingWord.charAt(0).toLowerCase()}${timingWord.slice(1)}` : ''}.`,
      owners: [resolveSpeaker(resolution.speaker)].filter(Boolean),
      timing: timingWord ? { kind: /^(?:after|before|once|when|until|following)\b/i.test(timingWord) ? 'dependency' : 'target', wording: timingWord, exactDate: '' } : { kind: 'not_stated', wording: '', exactDate: '' },
      evidenceIds: [...new Set([question.id, resolution.id])].slice(0, 8)
    };
  }

  const pendingResolution = /\b(?:i(?:'m| am) trying to|i(?:'ve| have) (?:just )?got to|i (?:need|have) to|we (?:need|have) to)\s+(?:work (?:out|through)|decide|determine|resolve|check|review)\b/i;
  const resolver = ordered.find((unit) => pendingResolution.test(unit.text || ''));
  const optionPattern = /\b(?:i(?:'m| am)\s+)?(?:thinking|considering)\s+(?:about\s+|of\s+)?((?:having|putting|using|running|splitting|assigning|allocating|keeping|moving|making)\b.{3,150}?)(?=,|\bbut\b|\bwhich\b|\bso\b|\.|$)/i;
  const optionUnit = resolver && ordered.find((unit) => Math.abs(Number(unit.sequence || 0) - Number(resolver.sequence || 0)) <= 2
    && optionPattern.test(unit.text || ''));
  const option = String(optionUnit?.text || '').match(optionPattern)?.[1];
  if (!resolver || !optionUnit || !option) return null;
  const referencedSpeaker = ordered.filter((unit) =>
    Number(unit.sequence || 0) < Number(resolver.sequence || 0) && unit.speaker && unit.speaker !== resolver.speaker
  ).at(-1)?.speaker || '';
  let optionText = replacePerspective(option, referencedSpeaker)
    .replace(/^having\s+/i, '')
    .replace(/^using\s+/i, 'use ')
    .replace(/^running\s+/i, 'run ')
    .replace(/^splitting\s+/i, 'split ')
    .replace(/^allocating\s+/i, 'allocate ')
    .trim();
  if (optionText.split(/\s+/).length < 3) return null;
  const combined = ordered.map((unit) => unit.text || '').join(' ');
  const criteria = [];
  if (/\blogistics\b/i.test(combined)) criteria.push('logistics');
  const risk = combined.match(/\brisk (?:analysis|assessment)\b/i)?.[0]?.toLowerCase();
  if (risk) criteria.push(risk);
  const criteriaText = criteria.length ? ` based on ${criteria.length === 1 ? criteria[0] : `${criteria[0]} and ${criteria[1]}`}` : '';
  return {
    action: `Determine whether ${optionText}${criteriaText}.`,
    owners: [resolveSpeaker(resolver.speaker)].filter(Boolean),
    timing: criteria.length ? { kind: 'dependency', wording: `Based on ${criteria.length === 1 ? criteria[0] : `${criteria[0]} and ${criteria[1]}`}`, exactDate: '' } : { kind: 'not_stated', wording: '', exactDate: '' },
    evidenceIds: [...new Set([resolver.id, optionUnit.id, ...(thread.dependencyEvidenceIds || [])])].slice(0, 8)
  };
}

function commitmentThreadBackstopProposals(candidates = [], records = [], sourceUnits = [], options = {}) {
  const units = normaliseSourceUnits(sourceUnits).filter((unit) => unit.classification !== 'remove' || unit.restored);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const speakers = [...new Set(units.map((unit) => meetingMinutesAgentText(unit.speaker, 180)).filter(Boolean))];
  const resolveSpeaker = (name) => {
    const wanted = meetingMinutesAgentText(name, 180).toLowerCase();
    if (!wanted) return '';
    const exact = speakers.find((speaker) => speaker.toLowerCase() === wanted);
    if (exact) return exact;
    const firstMatches = speakers.filter((speaker) => speaker.toLowerCase().split(/[\s,]+/)[0] === wanted.split(/\s+/)[0]);
    return firstMatches.length === 1 ? firstMatches[0] : '';
  };
  const acceptedReference = /\bwe\s+(?:probably\s+)?need to\s+(plan|review|check|resolve|decide|determine|sort out|work through)\s+(?:through\s+)?(?:that|this)\b/i;
  const antecedentObject = /\b(?:have a look at|look at|look into|review|check|resolve|plan|decide|determine|sort out|work through)\s+(?:just\s+)?(?:the\s+)?(.{3,100}?)(?=,|\.|\s+in terms of|$)/i;
  const proposals = [];
  // Do not discard a whole thread merely because one deliverable within its
  // evidence window is already represented. A deferred confirmation and the
  // contingent work that follows it, for example, are separate accountability
  // items even though they share adjacent turns. The final action-level
  // similarity check below still removes genuine duplicates.
  const unresolvedThreads = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.recordType === 'action_thread'
      && Number(candidate.priority || 0) >= 10
      && (candidate.cueKinds || []).includes('decision_resolution')
      && ['accepted_request', 'committed', 'conditional_commitment'].includes(candidate.dispositionHint));
  for (const thread of unresolvedThreads) {
    const evidenceUnits = (thread.evidenceIds || []).map((id) => byId.get(id)).filter(Boolean)
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    const acceptance = evidenceUnits.find((unit) => acceptedReference.test(unit.text || ''));
    if (!acceptance) {
      const deferred = deferredCommitmentThreadProposal(thread, evidenceUnits, resolveSpeaker);
      if (!deferred) continue;
      const proposal = normaliseAgentResult({ actions: [{
        id: `thread-proposal-${thread.candidateId}`,
        ...deferred
      }] }, sourceUnits, 'actions', { enforceEvidence: false, meetingDate: options.meetingDate }).actions[0];
      if (!proposal) continue;
      if ([...(records || []), ...proposals].some((record) => hybridActionsEquivalent(proposal.action, hybridRecordText(record)))) continue;
      proposals.push(proposal);
      continue;
    }
    const referenceMatch = String(acceptance.text || '').match(acceptedReference);
    const earlier = evidenceUnits.filter((unit) => Number(unit.sequence || 0) < Number(acceptance.sequence || 0)).reverse();
    let antecedent = null;
    let object = '';
    for (const unit of earlier) {
      const match = String(unit.text || '').match(antecedentObject);
      const cleaned = meetingMinutesAgentText(match?.[1], 100)
        .replace(/\s+(?:for|around|about)\s+(?:that|this)$/i, '')
        .replace(/^(?:a|an|the)\s+/i, '')
        .trim();
      if (cleaned.split(/\s+/).length >= 1 && !/^(?:it|that|this|them|things?)$/i.test(cleaned)) {
        antecedent = unit;
        object = cleaned;
        break;
      }
    }
    if (!antecedent || !object) continue;
    const verb = String(referenceMatch?.[1] || 'resolve').toLowerCase().replace('sort out', 'resolve');
    const availabilityEvidenceIds = (thread.dependencyEvidenceIds || []).filter((id) =>
      /\b(?:unavailable|won't be (?:available|around)|not be (?:available|around))\b/i.test(byId.get(id)?.text || ''));
    const hasAvailabilityConstraint = availabilityEvidenceIds.length > 0;
    const action = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} the ${object}${hasAvailabilityConstraint ? ' around the recorded availability constraint' : ''}.`;
    const acceptancePrefix = String(acceptance.text || '').split(/\bwe\s+(?:probably\s+)?need to\b/i)[0];
    const addressed = speakers.filter((speaker) => {
      const first = speaker.split(/[\s,]+/)[0];
      return first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(acceptancePrefix);
    });
    const owners = [...new Set([resolveSpeaker(acceptance.speaker), ...addressed.map(resolveSpeaker)].filter(Boolean))];
    const evidenceIds = [...new Set([
      antecedent.id, acceptance.id,
      ...(hasAvailabilityConstraint ? availabilityEvidenceIds : [])
    ])].slice(0, 8);
    const proposal = normaliseAgentResult({ actions: [{
      id: `thread-proposal-${thread.candidateId}`,
      action, owners, timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds
    }] }, sourceUnits, 'actions', { enforceEvidence: false, meetingDate: options.meetingDate }).actions[0];
    if (!proposal) continue;
    if ([...(records || []), ...proposals].some((record) => hybridActionsEquivalent(proposal.action, hybridRecordText(record)))) continue;
    proposals.push(proposal);
  }
  return proposals;
}

module.exports = {
  reconstructRefereeActions,
  borrowOwnersFromTwin,
  candidateOwnersOf,
  corroboratedOmittedActionProposals,
  strongOmittedDiscoveryProposals,
  acceptedVisitAssignmentActions,
  unresolvedOperationalGapProposals,
  operationalGapActionText,
  sourceOperationalGapActionText,
  commitmentThreadBackstopProposals,
  deferredCommitmentThreadProposal
};
