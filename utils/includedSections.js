'use strict';

// Which optional sections the reviewer wants in these minutes.
//
// Both default to on: a draft saved before this existed, and a reviewer who
// never touches the checkboxes, should get what they got before. Only an
// explicit false turns one off.
//
// Turning a section off is a decision about the document, not a display
// preference: the section is not generated, not rendered and not exported.

function includedSections(draft = {}) {
  const raw = draft && typeof draft.includeSections === 'object' && draft.includeSections ? draft.includeSections : {};
  return {
    meetingObjectives: raw.meetingObjectives !== false,
    executiveSummary: raw.executiveSummary !== false
  };
}

// True when neither section is wanted, so the summary stage has nothing to ask
// the model for and should not call it at all.
function summaryStageIsEmpty(draft = {}) {
  const include = includedSections(draft);
  return !include.meetingObjectives && !include.executiveSummary;
}

// Blank whatever the reviewer excluded, whoever produced it.
function applyIncludedSections(draft = {}, values = {}) {
  const include = includedSections(draft);
  return {
    executiveSummary: include.executiveSummary ? (values.executiveSummary || '') : '',
    meetingObjectives: include.meetingObjectives ? (Array.isArray(values.meetingObjectives) ? values.meetingObjectives : []) : []
  };
}

module.exports = { includedSections, summaryStageIsEmpty, applyIncludedSections };
