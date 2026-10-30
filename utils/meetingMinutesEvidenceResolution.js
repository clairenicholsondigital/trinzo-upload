'use strict';

const { text } = require('./meetingMinutesText');
const { evidenceContextFor, resolutionTokens, evidenceScoreProfile, explicitValuePresent, evidenceSupportScoreFromProfiles } = require('./meetingMinutesEvidenceContext');
const { actionEvidenceFits } = require('./meetingMinutesActionEvidence');
const TimingIntegrity = require('./meetingMinutesTiming');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');


function resolveEvidence(value, units = [], supplied = [], options = {}) {
  const context = evidenceContextFor(units);
  const { rows, known, indexById } = context;
  const claimTokens = resolutionTokens(value);
  const claimProfile = evidenceScoreProfile(value);
  const claimedCalendarDate = TimingIntegrity.explicitCalendarDate(value, options.meetingDate);
  const maximumDistinctiveFrequency = Math.max(3, Math.ceil(rows.length * 0.04));
  const distinctiveClaimTokens = claimTokens.filter((token) => {
    const frequency = context.documentFrequency.get(token) || 0;
    return frequency > 0 && frequency <= maximumDistinctiveFrequency;
  });
  const resolutionScore = (windowProfile) => {
    // Distinctive-word overlap must not bypass the value check performed by
    // the base scorer. Otherwise a fee/count claim can acquire unrelated
    // supplier citations even though none contains its numbers.
    const supportedYear = claimedCalendarDate && TimingIntegrity.isValidCalendarDate(options.meetingDate)
      && TimingIntegrity.explicitCalendarDates(windowProfile.value, options.meetingDate, { requireYearContext: true }).includes(claimedCalendarDate)
      ? claimedCalendarDate.slice(0, 4) : '';
    const scoreProfile = supportedYear ? { ...claimProfile, values: claimProfile.values.filter(value => String(value) !== supportedYear) } : claimProfile;
    if (scoreProfile.values.some((value) => !explicitValuePresent(value, windowProfile.lower))) return 0;
    const base = evidenceSupportScoreFromProfiles(scoreProfile, windowProfile);
    if (distinctiveClaimTokens.length < 2) return base;
    const distinctiveCoverage = distinctiveClaimTokens.filter((token) => windowProfile.resolutionTokenSet.has(token)).length / distinctiveClaimTokens.length;
    return (base * 0.25) + (distinctiveCoverage * 0.75);
  };
  const windowProfileFor = (ids) => {
    const indexes = [...new Set((ids || []).map((id) => indexById.get(id)).filter((index) => Number.isInteger(index))
      .flatMap((index) => [index - 1, index, index + 1]).filter((index) => index >= 0 && index < rows.length))].sort((a, b) => a - b);
    if (indexes.length === 3 && indexes[1] === indexes[0] + 1 && indexes[2] === indexes[1] + 1) {
      const centre = indexes[1];
      if (context.windowProfiles[centre]?.value === indexes.map((index) => context.directTexts[index]).join(' ')) return context.windowProfiles[centre];
    }
    return evidenceScoreProfile(indexes.map((index) => context.directTexts[index]).join(' '));
  };
  const suppliedIds = [...new Set((Array.isArray(supplied) ? supplied : []).map((id) => text(id, 30)).filter(Boolean))];
  const cacheKey = `${TimingIntegrity.TIMING_POLICY_VERSION}|${options.meetingDate || ''}|${options.action ? 'a' : 'p'}|${options.preserveDiscussionEvidence === true ? '12' : '8'}|${text(value, 5000)}|${suppliedIds.join(',')}`;
  const traceResolution = (result, reason, metrics = {}) => {
    if (options.action) actionDiagnostics.resolution(value, suppliedIds, result, reason, metrics);
  };
  const cached = context.resolutionCache.get(cacheKey);
  if (cached) { traceResolution(cached, 'resolution_cache_hit'); return { ...cached, evidenceIds: [...cached.evidenceIds], invalidIds: [...cached.invalidIds], weakIds: [...cached.weakIds] }; }
  const finish = (result, reason, metrics) => {
    traceResolution(result, reason, metrics);
    if (context.resolutionCache.size >= 2000) context.resolutionCache.clear();
    context.resolutionCache.set(cacheKey, result);
    return { ...result, evidenceIds: [...result.evidenceIds], invalidIds: [...result.invalidIds], weakIds: [...result.weakIds] };
  };
  const invalidIds = suppliedIds.filter((id) => !known.has(id));
  const validIds = suppliedIds.filter((id) => known.has(id));
  const selectedSuppliedIds = () => {
    if (!claimedCalendarDate) return validIds.slice(0, options.preserveDiscussionEvidence === true ? 12 : 8);
    const defining = validIds.filter(id => TimingIntegrity.explicitCalendarDates(rows[indexById.get(id)]?.text, options.meetingDate).includes(claimedCalendarDate));
    const qualifications = validIds.filter(id => /\b(?:prefer(?:red|ably)?|ideally|fallback|contingency|hard stop|instead)\b/i.test(rows[indexById.get(id)]?.text || '')
      && defining.some(anchor => Math.abs(indexById.get(id) - indexById.get(anchor)) <= 16));
    return [...new Set([...defining, ...qualifications, ...validIds])].slice(0, 8);
  };
  const claimWordSet = claimProfile.tokenSet;
  const speakersSupported = (profile) => context.speakerTokens.every((speakerWords) => {
    const mentioned = speakerWords.length === 1
      ? claimWordSet.has(speakerWords[0])
      : speakerWords.every((word) => claimWordSet.has(word));
    return !mentioned || speakerWords.some((word) => profile.tokenSet.has(word));
  });
  const scoreWindow = (profile) => {
    if (!speakersSupported(profile)) return 0;
    const lexicalScore = resolutionScore(profile);
    // The action classifier contains deliberately broad conversational
    // patterns. Running it over every unrelated transcript window is both
    // wasteful and susceptible to pathological regex work. A window with no
    // plausible lexical support cannot become evidence regardless.
    if (lexicalScore < 0.12) return 0;
    if (options.action && !actionEvidenceFits(value, profile.value)) return 0;
    return lexicalScore;
  };
  const suppliedWindow = windowProfileFor(validIds);
  const suppliedScore = scoreWindow(suppliedWindow);
  // Score each supplied anchor independently as well as their combined window.
  // Concatenating several adjacent but generic passages can inflate token
  // overlap and conceal a clearly better workstream elsewhere.
  const suppliedAnchorScore = validIds.reduce((best, id) => Math.max(best, scoreWindow(windowProfileFor([id]))), 0);
  const ranked = rows.map((unit, index) => {
    const window = context.windowProfiles[index];
    return {
      id: unit.id,
      index: indexById.get(unit.id),
      score: scoreWindow(window)
    };
  }).filter((item) => item.score >= 0.24).sort((a, b) => b.score - a.score);
  const bestScore = ranked[0]?.score || 0;
  const supportingRanked = options.action ? rows.map((unit, index) => {
    const window = context.windowProfiles[index];
    return {
      id: unit.id,
      index: indexById.get(unit.id),
      score: speakersSupported(window) ? resolutionScore(window) : 0
    };
  }).filter((item) => item.score >= 0.24).sort((a, b) => b.score - a.score) : ranked;
  // A valid ID is not necessarily the right evidence. Long transcripts often
  // contain an earlier passage with the same generic verbs and participant
  // names as a later deliverable. Previously any supplied window scoring 0.20
  // was accepted immediately, so an early "determine the calendar" passage
  // could remain attached to a later decision about a different workstream.
  // Keep a plausible supplied citation unless the transcript contains a
  // materially stronger passage; this preserves exact Agent citations while
  // allowing the server to repair clear workstream drift.
  const strongerAlternative = bestScore >= 0.28 && bestScore > suppliedAnchorScore + 0.08;
  if (validIds.length && suppliedScore >= 0.2 && !strongerAlternative) {
    return finish({ evidenceIds: selectedSuppliedIds(), invalidIds, weakIds: [], supportScore: suppliedScore }, 'supplied_evidence_retained', { suppliedScore, suppliedAnchorScore, bestScore, strongerAlternative });
  }

  // When remapping, do not return the three highest-scoring anchors from
  // unrelated parts of the meeting. Retain only anchors close to the best
  // score, then cite the most directly supportive turn inside each anchor's
  // context window. This keeps multi-part evidence (for example a constraint
  // followed by the commitment that resolves it) without pulling in a weaker
  // lookalike workstream elsewhere in the transcript.
  const remapBestScore = Math.max(bestScore, supportingRanked[0]?.score || 0);
  const remapFloor = Math.max(0.24, remapBestScore - 0.15);
  const remapAnchors = [...new Map([...ranked, ...supportingRanked]
    .filter((item) => item.score >= remapFloor)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => [item.id, item])).values()].slice(0, 6);
  const remappedEvidence = remapAnchors.map((anchor) => {
    const nearby = [anchor.index - 1, anchor.index, anchor.index + 1]
      .filter((index) => index >= 0 && index < rows.length)
      .map((index) => {
        const unit = rows[index];
        return {
          id: unit.id,
          index,
          // The surrounding anchor has already established named speakers.
          // Score the direct turn on its content here so a commitment using
          // "you" is not discarded merely because the addressee's full name
          // appears in the immediately preceding turn rather than this one.
          score: resolutionScore(context.directProfiles[index])
        };
      }).sort((left, right) => right.score - left.score || left.index - right.index);
    return nearby[0] || { id: anchor.id, index: anchor.index, score: anchor.score };
  });
  const strongestById = new Map();
  for (const item of remappedEvidence) {
    const prior = strongestById.get(item.id);
    if (!prior || item.score > prior.score) strongestById.set(item.id, item);
  }
  // Select by evidence strength before restoring transcript order. Slicing
  // after an order-only sort previously discarded a later, stronger turn in
  // favour of an earlier contextual question.
  const remappedIds = [...strongestById.values()]
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.id);
  // Lexical context alone is not an action-support verdict. If no window
  // passed the action check, do not replace valid supplied references with
  // uncited background. Retain provenance as uncertain; downstream action,
  // ownership and timing checks still decide whether the instruction stands.
  if (options.action && !ranked.length && validIds.length
    && remappedIds.some(id => !validIds.includes(id))) {
    const evidenceIds = selectedSuppliedIds();
    return finish({ evidenceIds, invalidIds, weakIds: [...evidenceIds], supportScore: 0 },
      'supplied_evidence_unverified_no_action_match', { suppliedScore, suppliedAnchorScore, bestScore, strongerAlternative });
  }
  return finish({
    evidenceIds: remappedIds,
    invalidIds,
    weakIds: suppliedScore >= 0.2 || (remappedIds.length && remapBestScore >= 0.28) ? [] : validIds,
    supportScore: bestScore
  }, 'lexical_evidence_remapped', { suppliedScore, suppliedAnchorScore, bestScore, strongerAlternative });
}

module.exports = { resolveEvidence };
