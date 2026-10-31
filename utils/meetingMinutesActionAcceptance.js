'use strict';

const { ACTION_ACCEPTANCE_PATTERN } = require('./meetingMinutesActionEvidence');
const { ANSWER_TIMING, ASKS_WHEN, UNKNOWN_TIMING_ANSWER, answerNamesSubject, sharesSubjectWord } = require('./meetingMinutesActionTimingInference');
const { evidenceContextFor } = require('./meetingMinutesEvidenceContext');
const { hasTimingSignal } = require('./meetingMinutesTimingPublication');
const { speakerIsOwner } = require('./meetingMinutesPeopleEvidence');
const { text } = require('./meetingMinutesText');

const ASKS_FOR_WORK = /\b(?:please|can (?:you|somebody|someone)|could (?:you|somebody|someone)|would (?:you|somebody|someone)|will (?:you|somebody|someone)|(?:is|are) (?:that|this|it|they) something (?:you|we) (?:can|could)|(?:are|would) you (?:able|happy|ok|okay) to|you (?:can|could) (?:write|send|draft|check|find|look|do|put|pull|get|sort|chase|update|prepare|review)\b|(?:do|can) you (?:want|mind) to)\b/i;

const DECLINES_WORK = /\b(?:can't|cannot|couldn't|won't|not me|not (?:my|mine)|i don't think i can|i'm not (?:able|sure i can)|no,? (?:i|we) (?:can't|won't|don't))\b/i;

function speakerIsOwnerName(speaker = '', owners = []) {
  const names = (Array.isArray(owners) ? owners : []).map((owner) => String(owner || '').trim().toLowerCase()).filter(Boolean);
  if (!names.length) return true;
  return speakerIsOwner(speaker, owners);
}

function acceptanceAroundEvidenceDetail(action = {}, units = []) {
  const none = { disposition: '', evidenceIds: [] };
  const rows = evidenceContextFor(units).rows;
  const wanted = new Set((Array.isArray(action?.evidenceIds) ? action.evidenceIds : []).map((id) => text(id, 30)));
  const cited = rows.map((unit, index) => (wanted.has(unit.id) ? index : -1)).filter((index) => index >= 0);
  if (!cited.length) return none;
  const owners = Array.isArray(action?.owners) ? action.owners : [];
  // Accepted by whom? Without a named owner there is nobody for the reply
  // to tie the work to, and an ownerless "accepted" row was being restored to
  // the published list and then absorbing the suggestion it came from.
  if (!owners.length) return none;
  const first = Math.min(...cited);
  const last = Math.max(...cited);
  const declinedAfter = (index) => rows.slice(index + 1, index + 3).some((row) => DECLINES_WORK.test(String(row?.text || '')));
  // Rule 1: a request or when-question answered, within two rows, by someone
  // else with a time or a yes. The answerer must be the owner when one is named.
  for (const index of new Set([...cited, ...cited.map((value) => value + 1)])) {
    const row = rows[index];
    if (!row) continue;
    const spoken = String(row.text || '');
    if (!ASKS_FOR_WORK.test(spoken) && !ASKS_WHEN.test(spoken)) continue;
    for (const reply of rows.slice(index + 1, index + 3)) {
      if (!reply || reply.speaker === row.speaker) continue;
      const answer = String(reply.text || '');
      if (DECLINES_WORK.test(answer) || UNKNOWN_TIMING_ANSWER.test(answer)) break;
      if (!hasTimingSignal(answer) && !ACTION_ACCEPTANCE_PATTERN.test(answer)) continue;
      if (!speakerIsOwnerName(reply.speaker, owners)) continue;
      // "The three new DIs, this week" answers for the DIs, not for whatever
      // else was asked about nearby; a bare "Friday" or "yes" answers for it.
      const timed = answer.match(ANSWER_TIMING);
      const lead = timed ? answer.slice(0, timed.index) : '';
      if (timed && answerNamesSubject(lead) && !sharesSubjectWord(action.action, answer)) continue;
      return { disposition: 'accepted_request', evidenceIds: [row.id, reply.id] };
    }
  }
  // Rule 2: the chair hands the work to the person who just raised it. The
  // request comes from someone else within three rows of the owner's cited
  // line, nobody but the requester speaks in between, and nobody declines.
  if (owners.length) {
    for (let index = first; index <= Math.min(rows.length - 1, last + 3); index += 1) {
      const row = rows[index];
      if (!row || !ASKS_FOR_WORK.test(String(row.text || '')) || speakerIsOwner(row.speaker, owners)) continue;
      const ownerBefore = rows.slice(Math.max(0, index - 3), index).map((unit, offset) => ({ unit, at: Math.max(0, index - 3) + offset }))
        .filter(({ unit }) => speakerIsOwner(unit.speaker, owners)).pop();
      if (!ownerBefore) continue;
      const between = rows.slice(ownerBefore.at + 1, index);
      if (between.some((unit) => unit.speaker !== row.speaker)) continue;
      if (declinedAfter(index)) continue;
      return { disposition: 'accepted_request', evidenceIds: [rows[ownerBefore.at].id, row.id] };
    }
  }
  // Rule 3: later on, the owner answers a when-question about the same work
  // with a time. "And Sanjay, timeline on that?" "The three new DIs, this week."
  if (owners.length) {
    for (let index = last + 1; index <= Math.min(rows.length - 1, last + 12); index += 1) {
      const row = rows[index];
      if (!row || !speakerIsOwner(row.speaker, owners)) continue;
      const spoken = String(row.text || '');
      if (!hasTimingSignal(spoken) || !sharesSubjectWord(action.action, spoken)) continue;
      const asked = rows.slice(Math.max(0, index - 2), index).some((unit) => unit.speaker !== row.speaker && ASKS_WHEN.test(String(unit.text || '')));
      if (asked) return { disposition: 'committed', evidenceIds: [rows[index - 1].id, row.id] };
    }
  }
  return none;
}

function acceptanceAroundEvidence(action = {}, units = []) {
  return acceptanceAroundEvidenceDetail(action, units).disposition;
}

module.exports = {
  ASKS_FOR_WORK,
  DECLINES_WORK,
  speakerIsOwnerName,
  acceptanceAroundEvidenceDetail,
  acceptanceAroundEvidence
};
