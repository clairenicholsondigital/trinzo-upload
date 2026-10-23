'use strict';

// A nomination frame, never permission to delete. Keep contact, enquiry and
// execution separate; unfamiliar grammar stays with the existing review path.
const canonical = value => String(value || '').normalize('NFKC').replace(/[’]/g, "'")
  .replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').toLowerCase();
const UNSAFE = /[\d"“”:;()[\]{}?]|\b(?:if|unless|after|before|once|when|until|pending|following|without|not|never|only|either|or|maybe|perhaps|probably|possibly|presumably|ideally|tentatively|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|week|month|year|morning|afternoon|evening)\b|\band\s+(?:check|confirm|clarify|send|share|provide|obtain|request|review|prepare|create|compile|translate|update|approve|implement)\b/i;
function enquiryFrame(value) {
  const text = String(value || '').normalize('NFKC').trim().replace(/[.!]+$/, '');
  if (!text || UNSAFE.test(text)) return null;
  const match = text.match(/^check\s+with\s+(.+?)\s+(?:regarding|about|on)\s+(.+)$/i)
    || text.match(/^(?:speak|talk)\s+(?:to|with)\s+(.+?)\s+to\s+check\s+(?:on|about|regarding)\s+(.+)$/i);
  if (!match || !/^[\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*){0,3}$/u.test(match[1])) return null;
  const purpose = canonical(match[2]);
  if (purpose.length < 8 || purpose.length > 400) return null;
  return { recipient: canonical(match[1]), purpose, operation: 'review' };
}
const FIELDS = new Set(['id', 'action', 'owners', 'timing', 'evidenceIds', 'occurrenceId', 'reviewFlagIds', 'timingDecision']);
const purposeWords = text => new Set((text.match(/[\p{L}]{3,}/gu) || [])
  .filter(word => !['the', 'and', 'for', 'with', 'from', 'regarding', 'about'].includes(word)));
function enquiryPurposeRetained(part, whole) {
  const a=enquiryFrame(part),b=enquiryFrame(whole);
  return Boolean(a && b && a.recipient===b.recipient
    && [...purposeWords(a.purpose)].every(word=>purposeWords(b.purpose).has(word)));
}
function eligible(record) {
  return record && Object.keys(record).every(key => FIELDS.has(key))
    && record.owners?.length === 1 && record.timing?.kind === 'not_stated'
    && !record.reviewFlagIds?.length && Array.isArray(record.evidenceIds)
    && record.evidenceIds.length > 0 && record.evidenceIds.length <= 8
    && enquiryFrame(record.action);
}
function sameEnquiryPair(left, right) {
  if (!eligible(left) || !eligible(right)) return false;
  const a = enquiryFrame(left.action), b = enquiryFrame(right.action);
  if (a.recipient !== b.recipient || canonical(left.owners[0]) !== canonical(right.owners[0])
    || !left.evidenceIds.some(id => right.evidenceIds.includes(id))
    || new Set([...left.evidenceIds,...right.evidenceIds]).size > 8) return false;
  const x = purposeWords(a.purpose), y = purposeWords(b.purpose);
  const common = [...x].filter(word => y.has(word)).length;
  return common >= 2 && common / Math.min(x.size, y.size) >= 0.6;
}
module.exports = { enquiryFrame, sameEnquiryPair, enquiryPurposeRetained };
