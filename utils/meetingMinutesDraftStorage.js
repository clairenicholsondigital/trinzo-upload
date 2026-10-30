'use strict';

// Stored payload version; independent of the provider response schema.
const PAYLOAD_VERSION = 5;

// Step indices changed meaning when the workflow gained a steer screen (1) and a
// summary screen (4): what was saved as "actions" (2) is now 3, and "final review"
// (3) is now 5. Remap anything below the current payload version so a draft opens
// where its owner left it - and so the client's furthest-step gate does not lock
// them out of every tab beyond it.
const STEP_V2_TO_V3 = Object.freeze({ 0: 0, 1: 2, 2: 3, 3: 5 });

function migrateDraftPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  // `Number(undefined) >= 3` is false, but be explicit: an absent version is 0.
  if ((Number(payload.payloadVersion) || 0) >= PAYLOAD_VERSION) return payload;
  const priorVersion = Number(payload.payloadVersion) || 0;
  const stored = Math.max(0, Math.min(3, Number(payload.currentStep) || 0));
  const discussion = (Array.isArray(payload.discussion) ? payload.discussion : []).map((topic) => ({
    ...topic,
    ...Object.fromEntries(['points', 'decisions', 'openQuestions'].map((key) => [key,
      (Array.isArray(topic?.[key]) ? topic[key] : []).map((record) => typeof record === 'string'
        ? record
        : { ...record, supportingDetails: Array.isArray(record?.supportingDetails) ? record.supportingDetails : [] })
    ]))
  }));
  return {
    ...payload,
    payloadVersion: PAYLOAD_VERSION,
    discussion,
    ...(priorVersion < 3 ? { currentStep: STEP_V2_TO_V3[stored] } : {})
  };
}

module.exports = { PAYLOAD_VERSION, migrateDraftPayload };
