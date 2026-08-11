'use strict';

const ACTION_CUE = /\b(?:action(?:s)?|will|i['’]?ll|we['’]?ll|can you|could you|please|need(?:s)? to|must|going to|hoping|follow[- ]?up|sign off|approve|review|complete|update|share|send|confirm|trace|generate|schedule|set up|add in)\b/i;
const FIRST_PERSON_COMMITMENT = /\b(?:i['’]?ll|i will|i can (?:review|send|share|update|complete|confirm|prepare|add)|i need to|i['’]?m going to|i was going to|i was in the middle of|i['’]?m (?:in the middle of|working on|hoping)|i am (?:in the middle of|working on|hoping|tidying|updating|reviewing|preparing|completing|sharing|sending|adding)|i go away|i['’]?ve sent|i sent)\b/i;
const PERSON_NAME = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,2}";

function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function speakerFromHeader(line) {
  const text = cleanLine(line);
  const teams = text.match(new RegExp(`^(${PERSON_NAME})\\s+(?:\\d{1,2}:)?\\d{1,2}[:.]\\d{2}$`));
  if (teams) return teams[1];
  const comma = text.match(/^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+),\s*([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)(?:\s+([A-Z]))?\s+(?:\d{1,2}:)?\d{1,2}[:.]\d{2}$/);
  return comma ? [comma[2], comma[3]].filter(Boolean).join(' ') : '';
}

function parseTranscriptTurns(transcriptText) {
  const turns = [];
  let current = null;

  function flush() {
    if (!current) return;
    const segments = current.lines.map(cleanLine).filter(Boolean);
    const text = cleanLine(segments.join(' '));
    if (text) turns.push({ speaker: current.speaker || 'Not stated', text, segments });
    current = null;
  }

  for (const rawLine of String(transcriptText || '').split(/\r?\n/)) {
    const line = cleanLine(rawLine);
    if (!line) continue;
    const speaker = speakerFromHeader(line);
    if (speaker) {
      flush();
      current = { speaker, lines: [] };
      continue;
    }
    if (!current) current = { speaker: 'Not stated', lines: [] };
    current.lines.push(line);
  }
  flush();
  return turns;
}

function deadlineFromEvidence(text, requiredPatterns = []) {
  const source = String(text || '');
  const match = source.match(/\b(?:today|tomorrow|before arrival|before [A-Z][a-z]+ arrives|before (?:the )?(?:audit|site visit|next review|client call|meeting)|next\s+(?:monday|tuesday|wednesday|thursday|friday|week|meeting)|this\s+week|end\s+of\s+(?:this\s+)?week|w\/e\s+\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+|end\s+of\s+[A-Z][a-z]+|monday|tuesday|wednesday|thursday|friday|\d{1,2}(?:st|nd|rd|th)(?:\s+of)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December))\b/i);
  if (!match) return 'Not stated';
  const actionCue = source.match(ACTION_CUE);
  const deadlineBeforeAction = actionCue && Number(match.index) < Number(actionCue.index);
  const explicitlyPrefixed = /\b(?:by|before|deadline(?: is| of|:)?|due(?: by| on)?)\s*$/i.test(source.slice(Math.max(0, Number(match.index) - 18), Number(match.index)));
  if (deadlineBeforeAction && !explicitlyPrefixed) return 'Not stated';
  const requiredIndexes = requiredPatterns
    .map((pattern) => source.search(pattern))
    .filter((index) => index >= 0);
  if (requiredIndexes.length && Number(match.index) < Math.max(...requiredIndexes) && !explicitlyPrefixed) return 'Not stated';
  return cleanLine(match[0])
    .replace(/^next\s+/i, 'Next ')
    .replace(/^w\/e\s+/i, 'W/E ')
    .replace(/^(monday|tuesday|wednesday|thursday|friday)$/i, (day) => day[0].toUpperCase() + day.slice(1).toLowerCase());
}

function directAssignedOwner(text) {
  const patterns = [
    new RegExp(`\\b(${PERSON_NAME})\\s+(?:will|needs? to|is going to|to)\\s+(?:review|complete|update|share|send|confirm|trace|generate|sign|approve|add|look)\\b`),
    new RegExp(`\\b(?:(?:A|a)ction(?:s)?(?:\\s+for)?|(?:O|o)wner)[:\\s]+(${PERSON_NAME})\\b`)
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return match[1];
  }
  return '';
}

function ownerFromEvidence(turn) {
  const assigned = directAssignedOwner(turn.text);
  if (assigned) return assigned;
  if (turn.speaker !== 'Not stated' && FIRST_PERSON_COMMITMENT.test(turn.text)) return turn.speaker;
  return 'Not stated';
}

function actionForRiskControls(text) {
  const lower = text.toLowerCase();
  const controls = [];
  if (/\b(?:usb|port lock)\b/.test(lower)) controls.push('USB port-lock controls');
  if (/\bgui\b/.test(lower)) controls.push('GUI security controls');
  else if (/\bscreen\b/.test(lower)) controls.push('screen-access controls');
  return `Update the risk management file to address ${controls.join(' and ')}`;
}

function minimalRuleEvidence(turn, rule) {
  const segments = Array.isArray(turn.segments) && turn.segments.length ? turn.segments : [turn.text];
  let best = '';
  for (let start = 0; start < segments.length; start += 1) {
    for (let end = start; end < Math.min(segments.length, start + 8); end += 1) {
      const candidate = cleanLine(segments.slice(start, end + 1).join(' '));
      if (!ACTION_CUE.test(candidate)) continue;
      if (!rule.required.every((pattern) => pattern.test(candidate))) continue;
      if (!best || candidate.length < best.length) best = candidate;
      break;
    }
  }
  return best;
}

function evidenceCandidateScore(candidate) {
  let score = 0;
  if (candidate.owner !== 'Not stated') score += 5;
  if (candidate.deadline !== 'Not stated') score += 3;
  if (FIRST_PERSON_COMMITMENT.test(candidate.evidence)) score += 4;
  if (/\b(?:need(?:s)? to|must|will|i['’]?ll|can you|could you|please|action(?:s)?|hoping)\b/i.test(candidate.evidence)) score += 3;
  if (/\?\s*$/.test(candidate.evidence)) score -= 3;
  return score;
}

function turnHasRuleContext(turn, rule) {
  return rule.required.some((pattern) => pattern.test(turn.text));
}

function ownerFromTurnGroup(turns, rule) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!turnHasRuleContext(turns[index], rule)) continue;
    const owner = ownerFromEvidence(turns[index]);
    if (owner !== 'Not stated') return owner;
  }
  return 'Not stated';
}

function deadlineFromTurnGroup(turns, rule) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!turnHasRuleContext(turns[index], rule) || !ACTION_CUE.test(turns[index].text)) continue;
    const focused = minimalRuleEvidence(turns[index], rule);
    const deadline = deadlineFromEvidence(focused || turns[index].text, rule.required);
    if (deadline !== 'Not stated') return deadline;
  }
  return 'Not stated';
}

function actionCandidate(rule, evidence, owner, deadline) {
  const action = cleanLine(rule.action(evidence)).replace(/[.]+$/, '');
  if (!action) return null;
  const candidate = {
    owner,
    action,
    deadline,
    source: 'evidence_bound_transcript_action',
    evidence,
    recoveryRule: rule.id
  };
  candidate.score = evidenceCandidateScore(candidate);
  return candidate;
}

const RECOVERY_RULES = [
  {
    id: 'dita_med_envoy_plan',
    required: [/\bmed\s*envoy\b/i, /\b(?:project plan|task list|plan of action|timeline|plan)\b/i, /\b(?:follow[- ]?up|oversight|status|send|share)\b/i],
    action: () => 'Follow up on the Med Envoy project plan or task list'
  },
  {
    id: 'dita_hpra_bill',
    required: [/\bhpra\b/i, /\b(?:bill|annual fee)\b/i, /\b(?:send|share|review|look at|have a look)\b/i],
    action: () => 'Review the HPRA authorised-representative bill'
  },
  {
    id: 'dita_doc_ppe_rationale',
    required: [/\bdeclarations? of conformity\b/i, /\bppe\b/i, /\brisk rationale\b/i, /\b(?:update|include|confirm|need to)\b/i],
    action: () => 'Update the declarations of conformity with the PPE risk rationale'
  },
  {
    id: 'dita_working_sessions',
    required: [/\bworking sessions?\b/i, /\bwednesday\b/i, /\bthursday\b/i, /\bfriday\b/i, /\b(?:set up|schedule|arrange|recurrence)\b/i],
    action: () => 'Set up working sessions with the client'
  },
  {
    id: 'mute_button_flash',
    required: [/\bmute button\b/i, /\b(?:flash|flashing|led)\b/i],
    action: () => 'Review the mute button flash behaviour against the existing setup'
  },
  {
    id: 'clinical_code_review',
    required: [/\b(?:clinical|clinician|nurs\w*)\b/i, /\breview\b/i, /\b(?:code|coding|sound|colour|flash)\b/i],
    action: () => 'Complete the clinical review of the code changes'
  },
  {
    id: 'change_request',
    required: [/\bchange (?:request|control)\b/i, /\b(?:approve|approved|sign off|signed off|close out)\b/i, /\b(?:alarm|language|version)\b/i],
    action: () => 'Complete and approve the change request covering the documented software changes'
  },
  {
    id: 'debug_screen',
    required: [/\bdebug\b/i, /\b(?:command|commands)\b/i, /\b(?:screen|displayed|visible)\b/i],
    action: () => 'Confirm which debug commands and outputs are visible on screen'
  },
  {
    id: 'graphics_language_symbols',
    required: [/\b(?:graphics display|graphics driver)\b/i, /\b(?:font|symbols?|characters?|arabic|vietnamese|greek)\b/i],
    action: () => 'Review the graphics driver as a possible route for supporting the required language symbols'
  },
  {
    id: 'iec60601_gaps',
    required: [/\b(?:iec\s*)?60601(?:-1)?\b/i, /\bmdd\b/i, /\b(?:gap|gaps|testing|compliance document)\b/i],
    action: () => 'Review IEC 60601-1 against the MDD documentation to identify electrical-compliance testing gaps'
  },
  {
    id: 'electrical_testing',
    required: [/\belectrical compliance testing\b/i, /\b(?:start|started|complete|within|by|date)\b/i],
    action: () => 'Complete the electrical compliance testing'
  },
  {
    id: 'software_version_traceability',
    required: [/\b17 changes\b/i, /\b(?:version\s*)?1[.]?0?1\b/i, /\b(?:version\s*)?1[.]?0?2\b/i, /\b(?:code|traceability|visible)\b/i],
    action: () => 'Trace and document the software changes between versions 1.01 and 1.02'
  },
  {
    id: 'retrospective_test_data',
    required: [/\bretrospectively generate test data|retrospective test data\b/i, /\b(?:traceability|support)\b/i],
    action: () => 'Generate retrospective test data if the software changes cannot be identified clearly'
  },
  {
    id: 'risk_controls',
    required: [/\brisk management (?:file|matrix|file sheet)\b/i, /\busb\b/i, /\bport lock\b/i, /\b(?:gui|screen)\b/i],
    action: actionForRiskControls
  },
  {
    id: 'security_standards',
    required: [/\b81001-5-1\b/i, /\b27427\b/i, /\b(?:send|sent|share|email)\b/i],
    action: () => 'Share standards 81001-5-1 and 27427 for review'
  },
  {
    id: 'fan_logic',
    required: [/\bfan logic\b/i, /\bcognidocs\b/i, /\breview(?:ed)?\b|needs? to probably be reviewed/i],
    action: () => 'Review the fan logic document and confirm whether it should be added to Cognidocs'
  }
];

function buildEvidenceBoundStagedActionInventory(transcriptText) {
  const turns = parseTranscriptTurns(transcriptText);
  const actions = [];

  for (const rule of RECOVERY_RULES) {
    let best = null;
    for (const turn of turns) {
      const evidence = minimalRuleEvidence(turn, rule);
      if (!evidence) continue;
      const candidate = actionCandidate(
        rule,
        evidence,
        ownerFromEvidence({ speaker: turn.speaker, text: evidence }),
        deadlineFromEvidence(evidence, rule.required)
      );
      if (!candidate) continue;
      if (!best || candidate.score > best.score) best = candidate;
    }
    for (let start = 0; start < turns.length; start += 1) {
      for (let end = start + 1; end < Math.min(turns.length, start + 3); end += 1) {
        const group = turns.slice(start, end + 1);
        const evidence = cleanLine(group.map((turn) => turn.text).join(' '));
        if (!ACTION_CUE.test(evidence) || !rule.required.every((pattern) => pattern.test(evidence))) continue;
        const candidate = actionCandidate(
          rule,
          evidence,
          ownerFromTurnGroup(group, rule),
          deadlineFromTurnGroup(group, rule)
        );
        if (candidate) candidate.score -= ((group.length - 1) * 2) + Math.floor(evidence.length / 600);
        if (candidate && (!best || candidate.score > best.score)) best = candidate;
      }
    }
    if (best) {
      delete best.score;
      actions.push(best);
    }
  }
  return actions;
}

module.exports = {
  buildEvidenceBoundStagedActionInventory,
  deadlineFromEvidence,
  ownerFromEvidence,
  parseTranscriptTurns
};
