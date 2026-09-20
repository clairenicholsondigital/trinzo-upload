'use strict';

// Personal wellbeing and social asides can be true to the transcript without
// being suitable meeting minutes. Keep this rule semantic and name-agnostic:
// it is about the kind of statement, not who happened to say it in one file.
const PERSONAL_TIME_AWAY = /\b(?:(?:needs?|deserves?|could use|should|ought to)\s+(?:(?:have|take|get)\s+)?|(?:take|get|have|book)\s+)(?:(?:a\s+|some\s+)?(?:proper\s+|short\s+|long\s+|well[- ]earned\s+)?(?:break(?![- ](?:even|in|down|out|point))|rest|downtime|time\s+off|holidays?|sleep)|(?:some|annual)\s+leave)\b/i;
const PERSONAL_STATE = /\b(?:looks?|seems?|appears?|is|was)\s+(?:really\s+|very\s+|quite\s+)?(?:tired|exhausted|burnt?\s+out|overworked)\b|\b(?:has|have|had)\s+been\s+working\s+too\s+hard\b/i;

// A formal break arrangement or a fatigue-related safety control is useful
// operational information. Requiring both an arrangement/control cue and an
// operational anchor avoids preserving a casual "X will take a break" aside.
const FORMAL_ARRANGEMENT = /\b(?:agreed|scheduled|arranged|staggered|must|required|policy|rota|will\s+(?:take|be\s+unavailable)|fatigue\s+(?:risk|control)|safety\s+(?:risk|control))\b/i;
const OPERATIONAL_ANCHOR = /\b(?:\d+(?:\.\d+)?\s*(?:minutes?|hours?)|\d{1,2}:\d{2}|coverage|cover(?:s|ed|ing)?|handover|shift|rota|session|continuity|working\s+(?:time|hours?)|policy|safety\s+risk|fatigue\s+risk|break\s+from\s+(?:testing|production|development|the\s+review|the\s+project|the\s+workstream))\b/i;
const OPERATIONAL_IMPACT = /\b(?:putting|creating|causing|affecting|threatening|poses?)\b.{0,80}\b(?:safety|delivery|schedule|deadline|quality|compliance|capacity|continuity)\b/i;

function valueText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function isPersonalAside(value) {
  const wording = valueText(value);
  if (!wording || (!PERSONAL_TIME_AWAY.test(wording) && !PERSONAL_STATE.test(wording))) return false;
  return !((FORMAL_ARRANGEMENT.test(wording) && OPERATIONAL_ANCHOR.test(wording))
    || OPERATIONAL_IMPACT.test(wording));
}

function removePersonalAsides(topics = []) {
  return (Array.isArray(topics) ? topics : []).map((topic) => {
    const cleaned = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      cleaned[kind] = (Array.isArray(topic?.[kind]) ? topic[kind] : [])
        .filter((record) => !isPersonalAside(record?.text))
        .map((record) => ({
          ...record,
          supportingDetails: (Array.isArray(record?.supportingDetails) ? record.supportingDetails : [])
            .filter((detail) => !isPersonalAside(detail?.text))
        }));
    }
    return cleaned;
  }).filter((topic) => ['points', 'decisions', 'openQuestions'].some((kind) => cleanedLength(topic, kind)));
}

function cleanedLength(topic, kind) {
  return Array.isArray(topic?.[kind]) ? topic[kind].length : 0;
}

module.exports = { isPersonalAside, removePersonalAsides };
