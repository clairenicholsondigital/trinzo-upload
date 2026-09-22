'use strict';

// Publication-time guard for routine mechanics of running the call.  Keep this
// deliberately narrower than generic words such as "wait" or "start": those are
// also valid in project dependencies and operational instructions.
const ADMINISTRATIVE_WAIT_PATTERNS = [
  /\b(?:meeting|call|session)\s+(?:started|began|opened)\s+(?:with\s+)?(?:a\s+)?(?:brief|short|slight|temporary)?\s*(?:wait|pause|delay)\s+(?:for|while)\b/i,
  /\b(?:wait(?:ed|ing)?|pause[ds]?|hold(?:ing)?)\s+(?:briefly\s+)?for\s+(?:(?:an?|the|another)\s+)?(?:attendee|participant|guest|someone|everybody|everyone)\s+to\s+(?:join|arrive|connect|come\s+on(?:line)?)\b/i,
  /\b(?:wait(?:ed|ing)?|pause[ds]?|hold(?:ing)?)\b[^.!?]{0,90}\b\d+\s*(?:seconds?|minutes?)\b[^.!?]{0,90}\bbefore\s+(?:continu(?:e|ed|ing)|resum(?:e|ed|ing)|start(?:ed|ing)?|begin(?:ning)?)\s+(?:the\s+)?(?:meeting|call|session|discussion)\b/i,
  /\bgive\s+(?:him|her|them|[A-Z][A-Za-z'’.-]+)\s+(?:(?:another|one|a|an)\s+|\d+\s*)(?:seconds?|minutes?)\b[^.!?]{0,100}\b(?:before|then)\b[^.!?]{0,80}\b(?:continu(?:e|ed|ing)|resum(?:e|ed|ing)|start(?:ed|ing)?|begin(?:ning)?|proceed(?:ed|ing)?)\b/i
];

function isRoutineMeetingAdministrationText(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return Boolean(text) && ADMINISTRATIVE_WAIT_PATTERNS.some((pattern) => pattern.test(text));
}

function removeRoutineMeetingAdministrationSentences(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && !isRoutineMeetingAdministrationText(sentence))
    .join(' ')
    .trim();
}

module.exports = {
  isRoutineMeetingAdministrationText,
  removeRoutineMeetingAdministrationSentences
};
