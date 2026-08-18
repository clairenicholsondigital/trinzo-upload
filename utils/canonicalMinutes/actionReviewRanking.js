'use strict';

const { clean } = require('./evidence');

const STOP_WORDS = new Set([
  'about','after','again','also','and','are','because','been','being','before','but','can','could','did','does','for','from','had','has','have','into','just','like','need','needs','only','out','over','really','should','that','the','their','then','there','they','this','those','through','with','would','you','your'
]);

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function tokens(value) {
  return clean(value).toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g)?.map((token) => token.replace(/(?:ing|ed|es|s)$/i, '')).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)) || [];
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  leftTokens.forEach((token) => { if (rightTokens.has(token)) shared += 1; });
  return shared / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function hasOutstandingArtifactDependency(value) {
  const text = clean(value);
  const artifact = /\b(?:copy of|project plan|task list|plan of action|timeline|status update|latest version|access to|list of|information|evidence|document|manual|file|record|tracker|summary|report)\b/i.test(text);
  const stillNeeded = /\b(?:need(?:s)?|required|can you|could you|please|ask|mention|follow[- ]?up|go back|send|share|provide|confirm|request|help us understand|avoid duplication|without it|struggle|pending|outstanding|still|waiting|depend(?:s|ency)?)\b/i.test(text);
  return artifact && stillNeeded;
}

function candidateEvidenceText(candidate = {}, options = {}) {
  if (clean(candidate.evidence)) return clean(candidate.evidence);
  const byId = new Map((options.evidence?.events || []).map((event) => [event.id, event]));
  return uniqueStrings(candidate.evidenceIds || []).map((id) => byId.get(id)?.text || '').filter(Boolean).join(' ');
}

function hasImporterProcedureContext(value) {
  return /\b(?:importer|importer-obligation|importer obligation|QMS|quality manual|procedure(?:s)?|procedure-design|goods flow|operational details?|operational process(?:es)?|ERP|order flow|warehouse|scanner|barcode|document control|manual process(?:es)?)\b/i.test(clean(value));
}

function reviewedWorkstreamContexts(state = {}) {
  const contexts = [];
  for (const topic of Array.isArray(state.topics) ? state.topics : []) {
    const heading = clean(topic?.text || topic?.topic || topic);
    if (!heading) continue;
    contexts.push({
      topicId: clean(topic?.topicId),
      heading,
      point: '',
      evidenceIds: uniqueStrings(topic?.evidenceIds || []),
      source: 'confirmed_summary'
    });
  }
  for (const card of Array.isArray(state.discussion) ? state.discussion : []) {
    const heading = clean(card?.topic) || 'Discussion';
    const cardEvidenceIds = uniqueStrings(card?.evidenceIds || []);
    const points = Array.isArray(card?.points) ? card.points : [];
    // Card provenance safely supports the reviewed heading. Point wording only
    // receives evidence authority when the confirmed UI supplied point-level
    // provenance; this prevents newly typed prose inheriting the whole card.
    contexts.push({ topicId: clean(card?.topicId), heading, point: '', evidenceIds: cardEvidenceIds, source: 'confirmed_discussion' });
    for (const point of points) {
      const text = clean(point?.text || point);
      if (!text) continue;
      const pointEvidenceIds = uniqueStrings(typeof point === 'string' ? [] : point?.evidenceIds || []);
      contexts.push({
        topicId: clean(card?.topicId),
        heading,
        point: text,
        evidenceIds: pointEvidenceIds,
        source: 'confirmed_discussion'
      });
    }
  }
  return contexts;
}

function evidenceOverlap(leftIds = [], rightIds = []) {
  const left = new Set(uniqueStrings(leftIds));
  const right = new Set(uniqueStrings(rightIds));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const id of left) if (right.has(id)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function strongestWorkstream(candidate = {}, options = {}) {
  const haystack = `${candidate.action || ''} ${candidate.suggestedAction || ''} ${candidateEvidenceText(candidate, options)}`;
  const candidateTopicId = clean(candidate.topicId || candidate.workstreamId);
  let best = { label: '', score: 0, matchType: 'none', evidenceOverlap: 0, topicId: '', evidenceIds: [] };
  for (const context of reviewedWorkstreamContexts(options.state || {})) {
    const label = [context.heading, context.point].filter(Boolean).join(': ');
    const overlap = evidenceOverlap(candidate.evidenceIds || [], context.evidenceIds || []);
    const sameTopic = Boolean(candidateTopicId && context.topicId && candidateTopicId === context.topicId);
    const lexicalScore = tokenSimilarity(haystack, label);
    const pointSpecificity = context.point ? 0.02 : 0;
    // Evidence provenance is the strongest relationship, existing stable topic
    // identity is second, and the old lexical path remains the compatibility
    // fallback for historical drafts without provenance.
    const score = overlap > 0
      ? Math.max(0.72, Math.min(1, 0.72 + (overlap * 0.2) + (lexicalScore * 0.08) + pointSpecificity))
      : sameTopic
        ? Math.max(0.52, Math.min(0.7, 0.52 + (lexicalScore * 0.18)))
        : lexicalScore;
    if (score > best.score) best = {
      label,
      score,
      matchType: overlap > 0 ? 'evidence_overlap' : sameTopic ? 'topic_identity' : lexicalScore > 0 ? 'lexical' : 'none',
      evidenceOverlap: Number(overlap.toFixed(4)),
      topicId: context.topicId,
      evidenceIds: context.evidenceIds,
      source: context.source
    };
  }
  return best;
}

function classificationForCandidate(candidate = {}, options = {}) {
  const action = clean(candidate.suggestedAction || candidate.action);
  const evidence = candidateEvidenceText(candidate, options);
  const combined = `${action} ${evidence}`;
  const regulatory = /\b(?:must|has to|have to|required|requirement|regulation|MDR|PPE|declaration(?:s)? of conformity|EUDAMED|HPRA|SRN|language|translation|IFU|label)\b/i.test(combined);
  const explicitRequest = /\b(?:can|could|will|would)\s+you\b|\bplease\b|\bask\b|\brequest\b/i.test(evidence);
  const explicitCommitment = /\b(?:I|we)\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\b/i.test(evidence);
  const followUpVerb = /^(?:confirm|provide|send|share|review|update|prepare|arrange|schedule|follow up|request|complete|draft|submit|create|develop|document|obtain|resend)\b/i.test(action);
  const concreteArtefact = /\b(?:manual|document|file|record|invoice|bill|fee|registration|SRN|project plan|task list|label|IFU|countries|languages|declaration(?:s)? of conformity|risk rationale|procedure(?:s)?|session(?:s)?|meeting|call|evidence|confirmation)\b/i.test(combined);
  const dependency = /\b(?:before|so that|so|in order to|depends?|dependency|align(?:ed|ment)?|input|access|confirm|provide|send|share|follow[- ]?up|further|next|working session(?:s)?)\b/i.test(combined);
  const completed = /\b(?:already|previously|last\s+(?:week|month|year)|yesterday)\b[^.]{0,140}\b(?:sent|shared|reviewed|completed|finished|closed|followed up|did follow up)\b|\bno action\b/i.test(combined)
    && !hasOutstandingArtifactDependency(combined);
  const hypothetical = /\b(?:might|may|perhaps|maybe|if you wanted|if required|could have a look|would be able to)\b/i.test(combined) && !/\b(?:agreed|confirmed|yes[,.;]?\s+I['’]ll|leave that with me)\b/i.test(combined);
  const fragmentary = action.split(/\s+/).filter(Boolean).length < 4
    || /^(?:do|like|do or like|review that document as well|review that|send that|share that|do it|do that|handle that)$/i.test(action)
    || /^(?:and then|um,?\s+would just|would just|but yeah|there['’]s one to)\b/i.test(action)
    || /^just\s+understand\b/i.test(action)
    || /\b(?:it|that|this)\s+(?:as well)?[.!?]*$/i.test(action)
    || /\b(?:have a look at it|look at it|talk to .+ what that['’]?s about|what that['’]?s about)\b/i.test(action)
    || /\b(\w+)\s+\1\b/i.test(action);
  const currentState = /\b(?:is|are|was|were|will be|puts?|checks?|does|do)\b/i.test(action)
    && !/\b(?:confirm|provide|send|share|review|update|prepare|arrange|schedule|follow|request|complete|draft|submit|create|develop|document)\b/i.test(action);
  const operationalNarrative = /\b(?:units?|orders?|boxes?|warehouse|handheld devices?|scanner|scanners|barcode|barcodes|pick(?:ing)?|picked|pack(?:ing)?|packed|label(?:ling|ing)?|stored?|storage|shel(?:f|ves)|dispatch|courier|NetSuite|ERP|order flow)\b/i.test(combined)
    && /\b(?:we|they|team|staff|warehouse)\b/i.test(combined)
    && !/\b(?:confirm|provide|send|share|review|update|prepare|arrange|schedule|follow|request|complete|draft|submit|create|develop|document|need(?:s)? to|required|requirement)\b/i.test(action);
  const processDescription = /\b(?:will have|we['’]?ll have|can directly|will place|have to pick|have to store|has to meet|incorporated in the procedure|understand how the business works|applicable reg requirements|lot numbering process)\b/i.test(combined)
    && !followUpVerb
    && !explicitRequest;
  const completeReviewableProposition = Boolean(
    candidate.reviewDisposition === 'requirement'
    || followUpVerb
    || explicitRequest
    || (explicitCommitment && concreteArtefact)
    || (dependency && concreteArtefact && !operationalNarrative && !processDescription)
  );
  return {
    regulatory,
    explicitRequest,
    explicitCommitment,
    concreteArtefact,
    dependency,
    completed,
    hypothetical,
    fragmentary,
    currentState,
    followUpVerb,
    operationalNarrative,
    processDescription,
    completeReviewableProposition,
    informational: currentState || processDescription || operationalNarrative || (regulatory && !explicitRequest && !explicitCommitment && !dependency && !followUpVerb)
  };
}

function ownerEvidenceType(candidate = {}, options = {}) {
  const owner = clean(candidate.owner);
  if (!owner || owner === 'Not stated') return 'unknown';
  const evidence = candidateEvidenceText(candidate, options);
  const first = owner.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${first}\\b[^.?!]{0,80}\\b(?:will|shall|need(?:s)? to|must|has to|is going to|to)\\b`, 'i').test(evidence)) return 'direct_request';
  if (new RegExp(`\\bI\\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\\b`, 'i').test(evidence)) return 'self_commitment';
  if (new RegExp(`\\b${first}\\b[^.?!]{0,120}\\b(?:manual|document|file|invoice|bill|label|project plan|task list|evidence)\\b|\\b(?:manual|document|file|invoice|bill|label|project plan|task list|evidence)\\b[^.?!]{0,120}\\b${first}\\b`, 'i').test(evidence)) return 'artifact_provider';
  if (new RegExp(`\\b${first}\\b`, 'i').test(evidence)) return 'mentioned_only';
  return 'unknown';
}

function reviewerFacingActionText(candidate = {}, options = {}) {
  const original = clean(candidate.suggestedAction || candidate.action);
  const evidence = candidateEvidenceText(candidate, options);
  const combined = `${original} ${evidence}`;
  if (/\bMed\s*Envoy\b/i.test(combined) && /\b(?:project plan|task list|plan of action|timeline)\b/i.test(combined)) {
    return 'Confirm the Med Envoy project plan or task list so the importer-obligation work can be aligned with existing activity';
  }
  if (/\b(?:countries|country)\b/i.test(combined) && /\b(?:language|translation|IFU|label|manufacturer information)\b/i.test(combined)) {
    return 'Provide the country and language information needed to assess translation, IFU and label requirements';
  }
  if (/\bdeclarations? of conformity\b/i.test(combined) && /\b(?:PPE|risk rationale|sunglasses)\b/i.test(combined)) {
    return 'Confirm whether the PPE/sunglasses declarations of conformity need updating with the Category I risk rationale';
  }
  if (hasImporterProcedureContext(combined)
      && /\bworking sessions?\b|\bprocess discovery\b|\b(?:ERP|order flow|warehouse|scanner|barcode|document control|manual process)\b/i.test(combined)
      && /\b(?:set up|schedule|arrange|further|next|continue|working sessions?)\b/i.test(combined)) {
    return 'Arrange further process-discovery working sessions to confirm the operational details needed for importer-obligation procedures';
  }
  if (/\bQMS\b|\bquality manual\b/i.test(combined)) {
    if (/\b(?:send|share|access|resend|confirm)\b/i.test(combined)) {
      return 'Confirm access to the QMS Manual so it can be used as the procedure-design reference';
    }
    return 'Review whether the QMS Manual needs to be used as the procedure-design reference';
  }
  if (/\bHPRA\b/i.test(combined) && /\b(?:bill|invoice|fee)\b/i.test(combined)) {
    if (/\b(?:SRN|registration|payment|pay|Colm|Jacqui)\b/i.test(combined)) {
      return 'Review the HPRA authorised-representative invoice and related registration evidence before payment';
    }
    return 'Review the HPRA authorised-representative invoice or bill';
  }
  if (/\blabel(?:ling|ing)?\b/i.test(combined) && /\bimporter\b/i.test(combined)) {
    return 'Review the updated label from the importer perspective';
  }
  if (/\bcompile\b/i.test(combined) && /\b(?:design changes|technical file|tech file|summary report)\b/i.test(combined)) {
    return 'Compile the design-change and technical-file updates into the summary report';
  }
  return original;
}

function clusterKey(candidate = {}, options = {}) {
  const text = `${candidate.suggestedAction || ''} ${candidate.action || ''} ${candidateEvidenceText(candidate, options)}`.toLowerCase();
  const patterns = [
    ['qms_manual', /\bqms\b|\bquality manual\b/],
    ['hpra_invoice_registration', /\bhpra\b|\bsrn\b|\bauthori[sz]ed representative\b|\bregistration\b/],
    ['ppe_doc_rationale', /\bppe\b|\bsunglasses?\b|\bdeclarations? of conformity\b|\brisk rationale\b/],
    ['country_language', /\bcountr(?:y|ies)\b|\blanguage\b|\btranslation\b|\bIFU\b/],
    ['importer_label', /\blabel(?:ling|ing)?\b.*\bimporter\b|\bimporter\b.*\blabel(?:ling|ing)?\b/],
    ['process_discovery', /\bworking sessions?\b|\bprocess discovery\b|\bfurther process\b|\banother call\b|\boperational details?\b|\bERP\b|\border flow\b|\bwarehouse\b|\bscanner\b|\bbarcode\b|\bdocument control\b|\bmanual process\b/],
    ['medenvoy_project_plan', /\bmed\s*envoy\b|\bcody\b|\bproject plan\b|\btask list\b/]
  ];
  for (const [key, pattern] of patterns) {
    if (pattern.test(text)) return key;
  }
  return tokens(text).slice(0, 6).sort().join('_') || stableKey(candidate);
}

function stableKey(candidate = {}) {
  return `${clean(candidate.owner)}|${clean(candidate.suggestedAction || candidate.action)}|${uniqueStrings(candidate.evidenceIds || []).join(',')}`.toLowerCase();
}

function reviewerUsefulness(candidate = {}, options = {}) {
  const cls = classificationForCandidate(candidate, options);
  const workstream = strongestWorkstream(candidate, options);
  const purpose = clean(options.state?.meeting?.purpose || options.state?.meetingUnderstanding?.meetingPurpose || '');
  const purposeScore = purpose ? tokenSimilarity(`${candidate.suggestedAction || candidate.action} ${candidateEvidenceText(candidate, options)}`, purpose) : 0;
  let score = 0.18;
  if (cls.explicitCommitment && !cls.processDescription) score += 0.22;
  if (cls.explicitRequest) score += 0.22;
  if (cls.concreteArtefact) score += 0.18;
  if (cls.dependency && (cls.followUpVerb || cls.explicitRequest || candidate.reviewDisposition === 'requirement')) score += 0.16;
  if (cls.regulatory && cls.concreteArtefact) score += 0.13;
  if (candidate.reviewDisposition === 'requirement') score += 0.18;
  if (candidate.owner && candidate.owner !== 'Not stated') score += 0.06;
  if (workstream.score >= 0.18) score += Math.min(0.18, workstream.score * 0.35);
  if (purposeScore >= 0.12) score += Math.min(0.12, purposeScore * 0.3);
  if (/\b(?:project plan|task list|country|countries|language|declaration|QMS|manual|invoice|bill|registration|SRN|label|working sessions?|process discovery)\b/i.test(`${candidate.action || ''} ${candidateEvidenceText(candidate, options)}`)) score += 0.08;
  if (cls.fragmentary) score -= 0.42;
  if (cls.informational) score -= 0.28;
  if (cls.currentState) score -= 0.18;
  if (cls.processDescription) score -= 0.38;
  if (cls.operationalNarrative) score -= 0.3;
  if (cls.completed && !/\b(?:project plan|task list|follow[- ]?up|pending|outstanding|still|align)\b/i.test(`${candidate.action || ''} ${candidateEvidenceText(candidate, options)}`)) score -= 0.55;
  else if (cls.completed) score -= 0.18;
  if (cls.hypothetical && !cls.dependency) score -= 0.22;
  if (!cls.concreteArtefact && !cls.dependency) score -= 0.16;
  if (/^(?:do or like|do|like)$/i.test(clean(candidate.action))) score -= 0.65;
  if (cls.fragmentary) score = Math.min(score, 0.24);
  if (cls.informational && candidate.reviewDisposition !== 'requirement') score = Math.min(score, 0.32);
  if (cls.processDescription && candidate.reviewDisposition !== 'requirement') score = Math.min(score, 0.32);
  if (!cls.completeReviewableProposition && candidate.reviewDisposition !== 'requirement') score = Math.min(score, 0.33);
  return {
    reviewerUsefulnessScore: Number(clamp(score).toFixed(4)),
    reviewerUsefulnessTier: score >= 0.62 ? 'high' : score >= 0.34 ? 'medium' : 'low',
    actionClassification: cls.completed ? 'completed_history'
      : cls.fragmentary ? 'fragment'
      : candidate.reviewDisposition === 'requirement' ? 'requirement'
      : !cls.completeReviewableProposition ? 'incomplete_proposition'
      : cls.informational ? 'informational'
      : cls.explicitCommitment ? 'commitment'
      : cls.explicitRequest ? 'request'
      : cls.dependency ? 'dependency_follow_up'
      : 'possible_follow_up',
    workstreamRelevance: workstream,
    ownerEvidenceType: ownerEvidenceType(candidate, options)
  };
}

function enrichActionReviewCandidate(candidate = {}, options = {}) {
  const usefulness = reviewerUsefulness(candidate, options);
  const suggestedAction = reviewerFacingActionText(candidate, options);
  const existingScore = Number(candidate.reviewerUsefulnessScore);
  const preserveExisting = options.preserveExistingUsefulness && Number.isFinite(existingScore) && existingScore > 0;
  const reviewerUsefulnessScore = preserveExisting
    ? Number(clamp(existingScore).toFixed(4))
    : usefulness.reviewerUsefulnessScore;
  const reviewerUsefulnessTier = reviewerUsefulnessScore >= 0.62 ? 'high' : reviewerUsefulnessScore >= 0.34 ? 'medium' : 'low';
  return {
    ...candidate,
    suggestedAction,
    reviewerUsefulnessScore,
    reviewerUsefulnessTier: preserveExisting && clean(candidate.reviewerUsefulnessTier) ? clean(candidate.reviewerUsefulnessTier) : reviewerUsefulnessTier,
    actionClassification: preserveExisting && clean(candidate.actionClassification) ? clean(candidate.actionClassification) : clean(candidate.actionClassification) || usefulness.actionClassification,
    workstreamRelevance: candidate.workstreamRelevance || usefulness.workstreamRelevance,
    ownerEvidenceType: clean(candidate.ownerEvidenceType) || usefulness.ownerEvidenceType,
    clusterKey: clusterKey({ ...candidate, suggestedAction }, options)
  };
}

function rankAndClusterActionReviewCandidates(candidates = [], options = {}) {
  const enriched = (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => ({ ...enrichActionReviewCandidate(candidate, options), originalCandidateIndex: Number.isInteger(candidate.originalCandidateIndex) ? candidate.originalCandidateIndex : index }));
  const clusters = new Map();
  for (const candidate of enriched) {
    const key = candidate.clusterKey || stableKey(candidate);
    const group = clusters.get(key) || [];
    group.push(candidate);
    clusters.set(key, group);
  }
  return [...clusters.entries()].map(([key, group]) => {
    const sorted = group.slice().sort((left, right) =>
      right.reviewerUsefulnessScore - left.reviewerUsefulnessScore
      || clean(right.suggestedAction || right.action).length - clean(left.suggestedAction || left.action).length
      || left.originalCandidateIndex - right.originalCandidateIndex);
    const representative = sorted[0];
    const evidenceIds = uniqueStrings(sorted.flatMap((item) => item.evidenceIds || []));
    return {
      ...representative,
      evidenceIds,
      clusterKey: key,
      clusterSize: group.length,
      alternateCandidateIds: uniqueStrings(sorted.slice(1).map((item) => item.id || item.key || stableKey(item))).slice(0, 12),
      duplicateOfStrongerCandidate: false
    };
  }).sort((left, right) => {
    const tierRank = { high: 0, medium: 1, low: 2 };
    return (tierRank[left.reviewerUsefulnessTier] ?? 3) - (tierRank[right.reviewerUsefulnessTier] ?? 3)
      || right.reviewerUsefulnessScore - left.reviewerUsefulnessScore
      || left.originalCandidateIndex - right.originalCandidateIndex;
  });
}

module.exports = {
  enrichActionReviewCandidate,
  rankAndClusterActionReviewCandidates,
  reviewerFacingActionText,
  reviewerUsefulness,
  hasImporterProcedureContext,
  ownerEvidenceType,
  clusterKey,
  reviewedWorkstreamContexts,
  strongestWorkstream
};
