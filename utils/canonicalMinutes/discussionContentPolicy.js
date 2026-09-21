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

// Brief social/AOB remarks sometimes survive because they sit beside genuine
// agenda content. Limit this to reporting wrappers that carry no decision,
// commitment, operational consequence or work-product language. The rule is
// deliberately domain- and noun-agnostic: it does not know what was joked
// about in any particular transcript.
const OVERT_SOCIAL_REPORTING = /\b(?:joked|quipped|chatted)\b/i;
const INCIDENTAL_ACTIVITY_REPORTING = /\b(?:mentioned|remarked|recalled)\b.{0,90}\b(?:bringing|taking|wearing|eating|drinking|weather|holiday|weekend|hobb(?:y|ies))\b/i;
const MATERIAL_CONTENT = /\b(?:agreed|decided|approved|rejected|confirmed|committed|assigned|action(?:ed)?|will|shall|must|required|needs?\s+to|follow[- ]?up|outstanding|unresolved|blocked|dependency|deadline|target|risk|issue|problem|impact|affect(?:s|ed|ing)?|because|therefore|cost|budget|invoice|order|client|customer|supplier|audit|compliance|test|report|document|evidence|plan|procedure|policy|requirement|design|specification|review|schedule|delivery)\b/i;

function valueText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function isPersonalAside(value) {
  const wording = valueText(value);
  if (!wording || (!PERSONAL_TIME_AWAY.test(wording) && !PERSONAL_STATE.test(wording))) return false;
  return !((FORMAL_ARRANGEMENT.test(wording) && OPERATIONAL_ANCHOR.test(wording))
    || OPERATIONAL_IMPACT.test(wording));
}

function isPeripheralAside(value) {
  const wording = valueText(value);
  if (!wording || wording.split(/\s+/).length > 28
    || (!OVERT_SOCIAL_REPORTING.test(wording) && !INCIDENTAL_ACTIVITY_REPORTING.test(wording))) return false;
  return !MATERIAL_CONTENT.test(wording);
}

function removePersonalAsides(topics = []) {
  return (Array.isArray(topics) ? topics : []).map((topic) => {
    const cleaned = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      cleaned[kind] = (Array.isArray(topic?.[kind]) ? topic[kind] : [])
        .filter((record) => !isPersonalAside(record?.text) && !isPeripheralAside(record?.text))
        .map((record) => ({
          ...record,
          supportingDetails: (Array.isArray(record?.supportingDetails) ? record.supportingDetails : [])
            .filter((detail) => !isPersonalAside(detail?.text) && !isPeripheralAside(detail?.text))
        }));
    }
    return cleaned;
  }).filter((topic) => ['points', 'decisions', 'openQuestions'].some((kind) => cleanedLength(topic, kind)));
}

function cleanedLength(topic, kind) {
  return Array.isArray(topic?.[kind]) ? topic[kind].length : 0;
}

module.exports = { isPersonalAside, isPeripheralAside, removePersonalAsides };
