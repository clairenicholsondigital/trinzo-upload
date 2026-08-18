'use strict';

const { clean } = require('./evidence');

const HEADLINE_WEAK_TOKENS = new Set([
  'about', 'actually', 'again', 'also', 'anything', 'because', 'been', 'being',
  'could', 'does', 'doing', 'done', 'from', 'going', 'guess', 'have', 'having',
  'into', 'just', 'kind', 'know', 'like', 'maybe', 'more', 'much', 'need',
  'only', 'really', 'right', 'say', 'see', 'should', 'some', 'something',
  'sort', 'still', 'that', 'their', 'them', 'then', 'there', 'these', 'they',
  'thing', 'think', 'this', 'those', 'trying', 'very', 'want', 'well', 'what',
  'when', 'where', 'which', 'with', 'would', 'yeah', 'yes', 'your'
]);

function headlineContentTokens(value) {
  return (clean(value).toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || [])
    .map((token) => token.replace(/[^a-z0-9'’-]/g, ''))
    .filter((token) => token && !HEADLINE_WEAK_TOKENS.has(token));
}

function isTranscriptMetaText(value) {
  const text = clean(value);
  if (!text) return true;
  return /\[\s*(?:barking|laughter|coughing|doorbell|music|background noise|inaudible)\s*\]/i.test(text)
    || /\b(?:start(?:ed|ing)?|stop(?:ped|ping)?|pause(?:d|ing)?|resume(?:d|ing)?)\s+(?:the\s+)?transcription\b/i.test(text)
    || /\b(?:transcription|recording)\s+(?:has\s+)?(?:start(?:ed)?|stop(?:ped)?|pause(?:d)?|resume(?:d)?)\b/i.test(text)
    || /\b(?:can (?:everyone|you) hear me|you(?:'re| are) muted|unmute|mute button|share my screen|camera (?:is|isn't|is not)|microphone|mic (?:is|isn't|is not)|teams (?:has|is)|zoom (?:has|is)|connection (?:dropped|froze|has dropped)|sorry[, ]+carry on|go ahead[, ]+sorry)\b/i.test(text)
    || /^(?:hello|hi|morning|afternoon|thanks? (?:all|everyone)|cheers|bye|see you|speak soon)[.! ]*$/i.test(text);
}

function isCorrectionOrAcknowledgementFragment(value) {
  const text = clean(value);
  if (!text) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 10 && /^(?:no|sorry|no[, ]+sorry|actually[, ]+no|yes|yeah|yep|right|okay|ok|exactly|agreed|correct|fine|perfect|great)[,;:.!? ]/i.test(`${text} `)) {
    if (/\b(?:not correct|that's not|that is not|I meant|you mean|exactly|agreed|correct|fine|perfect|great|sorted|okay|ok)\b/i.test(text) || words.length <= 4) return true;
  }
  return false;
}

function isContextDependentText(value) {
  const text = clean(value);
  if (!text) return true;
  if (/^(?:and|but|so)\s+(?:then\s+)?(?:as a consequence (?:to|of) that[, ]*)?(?:does|do|did|is|are|would|could|can|will)\s+(?:that|this|it)\b/i.test(text)) return true;
  if (/^(?:and|but|so)\s+(?:then\s+)?(?:what|where|when|how|why)\b/i.test(text) && /\b(?:that|this|it|there|then)\b/i.test(text)) return true;
  if (/^(?:does|do|did|is|are|would|could|can|will)\s+(?:that|this|it)\b/i.test(text)) return true;
  if (/^(?:if|when|unless|assuming|provided)\s+(?:that|this|it|that's|that is|this is|it is)\b/i.test(text)) return true;
  if (/^(?:that|this|it)\s+(?:means?|would mean|is|was|will|would|could|can)\b/i.test(text) && text.split(/\s+/).length < 14) return true;
  if (/\b(?:what you were talking about|what we were talking about|what you mean|what that means|as a consequence to that)\b/i.test(text)) return true;
  return false;
}

function isConditionalLead(value) {
  return /^(?:if|unless|assuming|provided|subject to)\b/i.test(clean(value));
}

function isMalformedTranscriptText(value) {
  const text = clean(value);
  if (!text) return true;
  if (/[a-z]['’]?[A-Z][a-z]+/.test(text)) return true;
  if (/\b(?:you're getting ties time|youre getting ties time)\b/i.test(text)) return true;
  if (/^(?:potential|possible)\s+the\s+(?:discussion|meeting|team)\b/i.test(text)) return true;
  if (/(?:\b(?:and|but|because|that|which|with|from|to|for|of|the|a|an)|[,;:])$/i.test(text)) return true;
  return false;
}

function canStandAloneAsMinutesEvidence(value, options = {}) {
  const text = clean(value);
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (isTranscriptMetaText(text) || isCorrectionOrAcknowledgementFragment(text) || isContextDependentText(text) || isMalformedTranscriptText(text)) return false;
  if (!options.allowConditional && isConditionalLead(text)) return false;
  return true;
}

function canHeadlineTopic(value) {
  const text = clean(value);
  if (!canStandAloneAsMinutesEvidence(text)) return false;
  if (headlineContentTokens(text).length < 2) return false;
  if (/^(?:and|but|because|when|presumably|interesting|so|well|yeah|yes|okay|right|like)\b/i.test(text)) return false;
  if (/\?$/.test(text)) return false;
  if (/^(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?[,/ &-]*)+$/i.test(text)) return false;
  if (/^(?:that|this|it)\b/i.test(text) && text.split(/\s+/).length < 12) return false;
  return true;
}

function canSupportPurposeDimension(value) {
  const text = clean(value);
  if (!text) return false;
  return !isTranscriptMetaText(text)
    && !isCorrectionOrAcknowledgementFragment(text)
    && !isContextDependentText(text)
    && !isMalformedTranscriptText(text);
}

module.exports = {
  isTranscriptMetaText,
  isCorrectionOrAcknowledgementFragment,
  isContextDependentText,
  isConditionalLead,
  isMalformedTranscriptText,
  canStandAloneAsMinutesEvidence,
  canHeadlineTopic,
  canSupportPurposeDimension
};
