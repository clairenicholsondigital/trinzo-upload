'use strict';

const { text } = require('./meetingMinutesText');
const { contentTokens } = require('./meetingMinutesRecordMatching');
const { materialTokens } = require('./meetingMinutesEvidenceContext');



const ACTION_VERB_GROUPS = [
  ['send', 'share', 'provide', 'forward', 'circulate', 'email', 'issue', 'deliver', 'submit'],
  ['review', 'check', 'assess', 'inspect', 'evaluate', 'analyse', 'audit'],
  ['create', 'produce', 'prepare', 'draft', 'develop', 'build', 'write', 'compile'],
  ['update', 'revise', 'amend', 'change', 'edit', 'correct'],
  ['complete', 'finish', 'finalise', 'close'],
  ['confirm', 'clarify', 'determine', 'decide', 'agree', 'resolve', 'figure'],
  ['test', 'verify', 'validate', 'run', 'rerun'],
  ['contact', 'call', 'message', 'speak', 'follow', 'chase'],
  ['schedule', 'arrange', 'book', 'organise', 'coordinate'],
  ['sign', 'attest', 'acknowledge', 'accept'],
  ['trace', 'find', 'identify', 'investigate', 'source'],
  ['fix', 'repair', 'remediate'],
  ['split', 'separate', 'divide', 'classify', 'categorise', 'categorize'],
  ['automate', 'script']
];


function actionPredicateSupported(action, evidence) {
  const actionTokens = contentTokens(action);
  const first = actionTokens[0];
  if (!first) return false;
  // Formal minutes often replace a conversational execution verb with a
  // grammatical lead such as "conduct" or "perform": "manually do it ...
  // then test it" becomes "Conduct a manual test". Resolve the predicate from
  // the concrete operation named later in the action before comparing it with
  // the evidence. Treating every execution verb as universally equivalent
  // would be unsafe ("conduct a review" is not "send a review"), so this only
  // selects the specific verb family also present in the action itself.
  const genericExecution = new Set(['conduct', 'perform', 'execute', 'undertake', 'carry', 'do']);
  const source = String(evidence || '').toLowerCase();
  const groupSupported = (candidates) => candidates.some((verb) => {
    const irregular = { send: 'send|sends|sent|sending', write: 'write|writes|wrote|written|writing', speak: 'speak|speaks|spoke|spoken|speaking' }[verb];
    const forms = irregular || (verb.endsWith('e')
      ? `${verb}|${verb}s|${verb}d|${verb.slice(0, -1)}ing`
      : `${verb}|${verb}s|${verb}ed|${verb}ing`);
    return new RegExp(`\\b(?:${forms})\\b`, 'i').test(source);
  });
  const firstGroup = ACTION_VERB_GROUPS.find((values) => values.includes(first));
  if (firstGroup && groupSupported(firstGroup)) return true;
  // Conversational commitments to resolve a decision commonly use "work
  // out" or "work through" where formal minutes use determine, decide or
  // resolve. Treat that as a predicate match only when the evidence also
  // passes the commitment/status classifier; a bare speculative discussion
  // about working something out must not ground an action.
  const decisionVerbs = new Set(['confirm', 'clarify', 'determine', 'decide', 'agree', 'resolve', 'figure']);
  if (decisionVerbs.has(first) && ACTION_DECISION_RESOLUTION_PATTERN.test(source)
    && ['committed', 'accepted_request', 'conditional_commitment'].includes(actionEvidenceDisposition(action, evidence))) return true;

  // Some formalised records use "complete" as a wrapper around the actual
  // evidenced operation (for example, "complete and sign the forms"). In that
  // construction, validate the concrete conjunct as well. This is deliberately
  // limited to recognised action verbs in the opening phrase, so a matching
  // noun later in an unrelated generated sentence cannot launder the action.
  if (genericExecution.has(first) || first === 'complete') {
    const concreteGroups = ACTION_VERB_GROUPS.filter((values) => actionTokens.slice(1, 7).some((token) => values.includes(token)));
    if (concreteGroups.some(groupSupported)) return true;
  }
  return groupSupported([first]);
}


const ACTION_DECISION_RESOLUTION_PATTERN = /\b(?:try(?:ing)? to work out|(?:have|has|got|need(?:s)?) to (?:work (?:out|through)|decide|determine|resolve|plan through)|need(?:s)? to (?:confirm|clarify)|figure out)\b/i;

function actionPredicateGroupIndexes(value = '') {
  const words = contentTokens(value).slice(0, 10);
  return new Set(ACTION_VERB_GROUPS.map((group, index) => words.some((word) => group.includes(word)) ? index : -1)
    .filter((index) => index >= 0));
}

function actionPredicatesCompatible(left = '', right = '') {
  const a = actionPredicateGroupIndexes(left);
  const b = actionPredicateGroupIndexes(right);
  if (!a.size || !b.size) return true;
  return [...a].some((index) => b.has(index));
}

function actionEvidenceFits(action, evidence) {
  if (actionPredicateSupported(action, evidence)) return true;
  const objectTokens = materialTokens(action).slice(1);
  if (objectTokens.length < 3) return false;
  const evidenceWords = new Set(contentTokens(evidence));
  const coverage = objectTokens.filter((token) => evidenceWords.has(token)).length / objectTokens.length;
  return coverage >= 0.5 && ['committed', 'accepted_request', 'conditional_commitment'].includes(actionEvidenceDisposition(action, evidence));
}

// How the meeting was run, not what it decided. These lines are real speech and
// often survive denoising, but they are not minutes content, so they must never
// be inventoried as an important detail and surfaced as something to check.
// "I've got a delivery arriving, I need to shoot" is someone leaving the call,
// not a commitment, even though "need to" is a commitment cue. Leaving verbs
// are only treated as leaving when nothing is being shot/sent *to* anyone.
const LEAVING_REMARK_PATTERN = /\b(?:(?:need|needs|have|got|going|about|time) to (?:shoot|dash|go|run|head (?:off|out)|get off|leave|be off)\b(?!\s+(?:you|it|that|this|the|a|an|over|across|through|them))|i(?:'ll| will) (?:shoot|dash|head off|be off)\b(?!\s+(?:you|it|that|this|the|a|an|over|across|through|them))|let you go|gotta go|got to go|delivery(?:'s| is)? (?:here|arriving|at the door)|someone(?:'s| is)? at the door|catch you later|see you (?:later|then|soon|all)|speak (?:later|soon))\b/i;
const DELIVERABLE_CONTEXT_PATTERN = /\b(?:action|approval|audit|assessment|CAPA|change|compliance|decision|document|file|finding|plan|procedure|report|review|risk|scope|software|standard|submission|test|tracker|training|translation|validation|version)\b/i;

const ACTION_COMMITMENT_PATTERN = /\b(?:i|we)\s*(?:'ll|will|shall|can do|am going to|are going to)|\b(?:he|she|they)\s+(?:will|shall)|\b(?:agreed|committed|assigned|action(?:\s+for)?|need(?:s)? to|must|shall|is to|are to|due to)\b/i;
const ACTION_CONCRETE_INTENTION_PATTERN = /\b(?:(?:i|we)\s+(?:want|intend|plan|expect)\s+to|what\s+(?:i|we)\s+want\s+to\s+do\s+is(?:\s+to)?)\s+(?:arrange|assess|book|build|check|clarify|complete|confirm|contact|create|decide|define|determine|document|draft|email|establish|finalise|finalize|fix|forward|investigate|issue|message|prepare|provide|record|resolve|review|run|schedule|send|share|submit|take|test|track|update|validate|verify|write)\b/i;
const ACTION_JOINT_INTENTION_PATTERN = /\b(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s+and\s+I|I\s+and\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,})\s+(?:am\s+|are\s+)?going\s+to\s+(?:arrange|assess|book|build|check|clarify|complete|confirm|contact|create|decide|define|determine|document|draft|email|establish|finalise|finalize|fix|forward|investigate|issue|message|prepare|provide|record|resolve|review|run|schedule|send|share|submit|take|test|track|update|validate|verify|write)\b/i;
const ACTION_SCHEDULED_DELIVERABLE_PATTERN = /\b(?:assessment|audit|call|check|follow[- ]?up|inspection|review|session|test|testing|validation|workshop)\s+(?:is|are|has been|have been|was|were)\s+(?:agreed|booked|planned|scheduled)\s+(?:for|to|on)\b/i;
const NAMED_WILL_PATTERN = /\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s+will\b/;
const ACTION_REQUEST_PATTERN = /\b(?:please|can (?:you|somebody|someone)|could (?:you|somebody|someone)|would (?:you|somebody|someone)|will (?:you|somebody|someone))\b/i;
const ACTION_ACCEPTANCE_PATTERN = /\b(?:yes|yeah|yep|okay|ok|sure|happy to|will do|can do|i can|we can|that's fine|that works)\b/i;
const ACTION_SUGGESTION_PATTERN = /\b(?:perhaps|maybe|might|may|could|should|consider|considering|possible|potentially|it would be good|worth thinking)\b/i;
const ACTION_COMPLETED_PATTERN = /\b(?:already|previously|last (?:week|month)|has been|have been|was|were)\b[^.]{0,100}\b(?:completed|finished|sent|shared|issued|approved|closed|done|delivered|submitted)\b/i;
const ACTION_STATUS_PATTERN = /\b(?:currently|ongoing|in progress|remains|status is|has been|have been|was|were)\b/i;
// Minute preparation/delivery belongs to the recoverable minute-instruction
// check below. A prefix such as "send minutes" also names genuine later work.
const ACTION_ADMIN_PATTERN = /\b(?:attend (?:the )?(?:call|meeting)|join (?:the )?(?:call|meeting)|meeting invite|(?:for|in|into|update|take|record|write)\s+(?:the\s+|these\s+|this\s+|that\s+)?(?:new\s+)?set\s+of\s+minutes|(?:for|in|into)\s+(?:the|these|this)\s+minutes|share\s+(?:your|my|his|her|their|the)?\s*screen|screen\s*share|put\s+away\s+(?:the\s+|this\s+|that\s+)?(?:on[- ]screen\s+)?(?:pdf|pdf\s+copy|document\s+copy)|close\s+(?:the\s+|this\s+|that\s+)?(?:browser\s+)?(?:tab|window)\s*(?:now|for\s+now)?)\b/i;
// A short first-person "quickly/briefly/just share" line is often the chair
// moving the meeting along, rather than work that remains after the call. Keep
// this separate from ACTION_ADMIN_PATTERN: a normal "share the report" remains
// a possible deliverable, and explicit recipients, deliverables or timing keep
// the line eligible as a real action.
const MEETING_ADMIN_SHARE_PATTERN = /\b(?:i|we)\s+(?:'ll|will|shall|am going to|are going to)\s+(?:just|quickly|briefly)\s+share\b/i;
const SHARE_DELIVERABLE_CONTEXT = /\b(?:by|before|until|tomorrow|today|next\s+(?:week|month)|deadline|due|client|customer|supplier|stakeholder|external|team|colleagues?|board|committee|report|document|proposal|draft|result|results|data|link|file|presentation|deck|slides?|agenda|minutes|action\s+points?|findings?|quote|invoice|contract|formal\s+record)\b/i;
// ---- Running the call itself --------------------------------------------------
// "I'll give it thirty seconds for Dermot and then we'll just crack on, because
// I know Ffion has to drop at half past." (draft 1055, the chair's first line)
// became the published action "give it thirty seconds for Dermot and then".
// This is someone running the call: waiting for a latecomer, getting started,
// someone leaving early, audio and screen trouble, a parcel at the door. What
// separates it from planned work that mentions the same equipment ("Start the
// recording when Priya begins speaking" is a real task for next week's
// webinar) is that each of these is a spoken idiom of call management with no
// deliverable in it, said about this meeting as it happens.
const LIVE_CALL_CONDUCT = new RegExp([
  // waiting for people to arrive
  String.raw`\b(?:give|allow)\s+(?:it|him|her|them|[\p{Lu}][\p{L}'’-]+)\s+(?:a\s+)?(?:few\s+(?:more\s+)?|couple\s+(?:more\s+)?(?:of\s+)?|another\s+|(?:thirty|twenty|fifteen|ten|five|two|one|\d+)\s+(?:more\s+)?)?(?:seconds?|secs?|minutes?|mins?|moments?|tick)\b`,
  String.raw`\bwait(?:ing)?\s+(?:a\s+(?:few|couple)\s+(?:more\s+)?(?:seconds|secs|minutes|mins)|another\s+(?:minute|couple)|for\s+(?:[\p{Lu}][\p{L}'’-]+|everyone|everybody|the\s+others|others)\s+to\s+(?:join|arrive|dial\s+in|come\s+on|log\s+on|get\s+on|turn\s+up))\b`,
  // getting started, moving on, wrapping up this call
  String.raw`\b(?:just\s+)?(?:crack\s+on|make\s+a\s+start|get\s+(?:started|going|cracking|underway)|kick\s+(?:things\s+)?off|press\s+on|get\s+(?:through|round)\s+(?:the\s+)?agenda|step\s+(?:down\s+)?through\s+the\s+(?:core\s+areas|agenda|tracker|list)|wrap\s+(?:it\s+|this\s+)?up|call\s+it\s+(?:a\s+day|there)|leave\s+it\s+there)\b`,
  // leaving early, time pressure on this call
  String.raw`\b(?:has|have|had|need|needs|got|going)\s+to\s+(?:drop|leave|go|shoot|dash|jump|hop)(?:\s+off|\s+out)?\s+(?:at|by|in|for|before|around|about)\b`,
  String.raw`\b(?:hard\s+stop|drop(?:ping)?\s+off|be\s+done|finish(?:ed|ing)?\s+up|wrap(?:ped)?\s+up)\s+(?:well\s+)?(?:at|by|before)\s+(?:that|then|half\s+past|quarter|\d{1,2}(?::\d{2})?|the\s+hour|the\s+(?:half|quarter))\b`,
  String.raw`\b(?:it(?:'s| is)\s+getting\s+late|(?:mindful|conscious)\s+of\s+(?:the\s+)?time|time\s+check|(?:we(?:'ve| have)\s+got|there(?:'s| is))\s+(?:about\s+|only\s+|just\s+)?(?:\d+|five|ten|fifteen|twenty)\s+minutes\s+(?:left|to\s+go))\b`,
  // audio, video, screen
  String.raw`\b(?:you(?:'re| are)|i(?:'m| am)|(?:he|she)(?:'s| is)|we(?:'re| are))\s+(?:a\s+bit\s+|still\s+|all\s+)?(?:on\s+mute|muted|frozen|breaking\s+up|cutting\s+out|echoing|lagging)\b`,
  String.raw`\bcan\s+(?:you|everyone|everybody|anyone|people)\s+(?:all\s+)?(?:hear|see)\s+(?:me|us|my\s+screen|that|this|the\s+screen)\b`,
  String.raw`\b(?:let\s+me|i(?:'ll| will| am going to|'m going to)|i(?:'m| am)\s+just\s+going\s+to)\s+(?:just\s+)?(?:share|stop\s+sharing|put\s+up|bring\s+up)\s+(?:my|the)\s+screen\b`,
  String.raw`\b(?:my|the|your)\s+(?:internet|connection|wifi|wi-fi|bandwidth|camera|mic|microphone|audio|sound|video)\s+(?:is|was|keeps|has|went|has\s+gone|is\s+going)\b`,
  // interruptions at home
  String.raw`\b(?:someone(?:'s| is)\s+at\s+(?:my|the)\s+door|(?:sorry|hang\s+on)[,.]?\s+(?:parcel|delivery|doorbell|the\s+dog|my\s+dog|the\s+kids|one\s+sec|two\s+secs|back\s+in\s+a\s+(?:sec|second|minute|tick)))\b`
].join('|'), 'iu');
// One turn can run the call and still promise something: "Sorry, you're on
// mute. Right, so I'll send the deck tomorrow." Judge the pieces, not the
// whole: it is conduct only when nothing with work in it is left over.
const CONDUCT_PIECE_SPLIT = /(?<=[.!?;])\s+|,\s*(?=(?:and\s+then|then|but|so|because|and)\b)|\s+(?=(?:and\s+then|and|but|so|because)\s+(?:i|we|you|he|she|they)\b)|(?=\b(?:i|we)\s*(?:['’]ll|will|shall|am going to|are going to)\s+)/iu;
function isLiveCallConduct(value = '') {
  const source = text(value, 1200);
  if (!source || !LIVE_CALL_CONDUCT.test(source)) return false;
  const rest = source.split(CONDUCT_PIECE_SPLIT).map((piece) => String(piece || '').trim()).filter(Boolean)
    .filter((piece) => !LIVE_CALL_CONDUCT.test(piece));
  return !rest.some((piece) => contentTokens(piece).length >= 3);
}
function isMeetingAdminShare(value = '', context = '') {
  const source = `${text(value, 1200)} ${text(context, 15000)}`;
  return MEETING_ADMIN_SHARE_PATTERN.test(source) && !SHARE_DELIVERABLE_CONTEXT.test(source);
}

function isDecisionResolutionCommitment(value) {
  const source = text(value, 2000);
  if (!ACTION_DECISION_RESOLUTION_PATTERN.test(source)) return false;
  // Questions about whether clarification is needed are not themselves an
  // accepted task. The surrounding acceptance machinery can still promote a
  // request when a later turn genuinely accepts it.
  return !/\?\s*$/.test(source) && !/^\s*(?:who|what|when|where|why|how|do|does|did|is|are|can|could|would|will|anything)\b/i.test(source);
}

function actionNegatedByEvidence(action, evidence) {
  const source = text(evidence, 15000);
  if (!source) return false;
  const actionTokens = contentTokens(action).slice(0, 12);
  const predicateGroups = ACTION_VERB_GROUPS.filter((group) => actionTokens.some((token) => group.includes(token)));
  const predicateWords = [...new Set(predicateGroups.flat())];
  const actionObjectWords = new Set(actionTokens.filter((token) => !ACTION_VERB_GROUPS.flat().includes(token)));
  return source.split(/(?<=[.!?;])\s+|\n+/).some((clause) => {
    const hasSharedObject = contentTokens(clause).some((token) => actionObjectWords.has(token));
    if (!hasSharedObject) return false;
    return predicateWords.some((verb) => new RegExp(
      `\\b(?:will not|won't|shall not|do not|don't|must not|should not|cannot|can't|(?:is|are|was|were|we're|they're)\\s+not|neither\\b[^.;]{0,60}\\b(?:is|are|was|were)?\\s*(?:authorised|authorized)|not\\s+(?:authorised|authorized)\\s+to)\\b(?:\\s+[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,8}\\s+${verb}(?:s|ed|ing)?\\b`, 'i'
    ).test(clause) || (predicateGroups.some((group) => group.includes('confirm'))
      && /\bleave\b[^.;]{0,60}\bunconfirmed\b/i.test(clause)));
  });
}

function actionEvidenceDisposition(action, evidence) {
  const source = text(evidence, 15000);
  // A leaving remark grounds no work. Guard on the action too so a genuine
  // "shoot the report over" survives.
  if (LEAVING_REMARK_PATTERN.test(source) && !DELIVERABLE_CONTEXT_PATTERN.test(action)
    && !/\b(?:send|email|order|book|confirm|ring|call|contact|arrange|prepare|review|update|write|share|forward|submit)\b/i.test(action)) return 'meeting_admin';
  if (!source) return 'unclear';
  if (isMeetingAdminShare(action, source)) return 'meeting_admin';
  const directlyNegatedPredicate = actionNegatedByEvidence(action, source);
  // Negation belongs to its clause. An availability constraint such as “I
  // won't be around” can be the reason another person must plan or reschedule;
  // it must not reject every action in the surrounding evidence window.
  if (/\b(?:no action|do not need to|does not need to)\b/i.test(source) || directlyNegatedPredicate) return 'rejected';
  const accepted = ACTION_ACCEPTANCE_PATTERN.test(source);
  const requested = ACTION_REQUEST_PATTERN.test(source);
  const hasCommitment = ACTION_COMMITMENT_PATTERN.test(source) || ACTION_CONCRETE_INTENTION_PATTERN.test(source) || NAMED_WILL_PATTERN.test(source)
    || ACTION_JOINT_INTENTION_PATTERN.test(source) || ACTION_SCHEDULED_DELIVERABLE_PATTERN.test(source)
    || isDecisionResolutionCommitment(source) || accepted;
  if (isMeetingAdminAction(action) && !/\b(?:client deliverable|contract|required|formal record)\b/i.test(source)) return 'meeting_admin';
  if (ACTION_COMPLETED_PATTERN.test(source) && !hasCommitment) return 'completed';
  if (requested && !accepted
    && !ACTION_COMMITMENT_PATTERN.test(source.replace(ACTION_REQUEST_PATTERN, ''))
    && !ACTION_CONCRETE_INTENTION_PATTERN.test(source.replace(ACTION_REQUEST_PATTERN, ''))
    && !NAMED_WILL_PATTERN.test(source)) return 'unaccepted_request';
  if (ACTION_SUGGESTION_PATTERN.test(source) && !hasCommitment) return 'suggestion';
  if (ACTION_STATUS_PATTERN.test(source) && !hasCommitment) return 'status_only';
  if (/\b(?:if|once|after|when|subject to|dependent on|depends on|cannot .* until)\b/i.test(source) && hasCommitment) return 'conditional_commitment';
  if (hasCommitment) return accepted ? 'accepted_request' : 'committed';
  return 'unclear';
}

// ---- Commitment check -----------------------------------------------------
// Model-extracted actions that the keyword reading vetoed get one second look.
// An action comes back only when the model quotes the words where someone
// commits to it, is assigned it or agrees to it, and the quote is in the
// passage. Owners the model cannot tie to those words are removed.
function isMeetingAdminAction(value = '') {
  return ACTION_ADMIN_PATTERN.test(String(value || '')) || isLiveCallConduct(value);
}

module.exports = {
  ACTION_ACCEPTANCE_PATTERN,
  ACTION_COMMITMENT_PATTERN,
  ACTION_COMPLETED_PATTERN,
  ACTION_CONCRETE_INTENTION_PATTERN,
  ACTION_JOINT_INTENTION_PATTERN,
  ACTION_REQUEST_PATTERN,
  ACTION_SCHEDULED_DELIVERABLE_PATTERN,
  ACTION_VERB_GROUPS,
  DELIVERABLE_CONTEXT_PATTERN,
  LEAVING_REMARK_PATTERN,
  NAMED_WILL_PATTERN,
  actionEvidenceDisposition,
  actionEvidenceFits,
  actionNegatedByEvidence,
  actionPredicateSupported,
  actionPredicatesCompatible,
  isDecisionResolutionCommitment,
  isLiveCallConduct,
  isMeetingAdminAction,
  isMeetingAdminShare
};
