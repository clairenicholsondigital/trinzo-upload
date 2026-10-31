'use strict';

const { clean } = require('./canonicalMinutes/evidence');

const crypto = require('node:crypto');
const { text } = require('./meetingMinutesText');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');

const COMMON_SPEECH_WORDS = new Set([
  'get', 'got', 'let', 'say', 'one', 'make', 'made', 'take', 'put', 'going', 'think', 'know', 'want', 'like',
  'yeah', 'yes', 'sure', 'okay', 'well', 'right', 'thing', 'things', 'bit', 'kind', 'sort', 'really',
  'actually', 'maybe', 'now', 'see', 'look', 'come', 'back', 'way', 'lot', 'time', 'good', 'fine', 'sorry',
  'hang', 'yep', 'probably', 'still', 'even', 'much', 'many', 'thank', 'thanks'
]);

function stableId(prefix, value, index = 0) {
  return `${prefix}-${crypto.createHash('sha1').update(`${index}|${text(value, 4000)}`).digest('hex').slice(0, 10)}`;
}

function contentTokens(value) {
  const stop = new Set(['about', 'after', 'again', 'also', 'been', 'being', 'could', 'from', 'have', 'into', 'just', 'more', 'only', 'over', 'said', 'that', 'their', 'there', 'they', 'this', 'with', 'would']);
  return [...new Set(text(value, 10000).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])].filter((token) => !stop.has(token));
}

function tokenOverlap(left, right) {
  const a = contentTokens(left);
  const b = new Set(contentTokens(right));
  if (!a.length || !b.size) return 0;
  return a.filter((token) => b.has(token)).length / Math.min(a.length, b.size);
}


function hybridRecordText(record = {}) {
  return meetingMinutesAgentText(record.action || record.text || '', 1600);
}

function hybridTokenOverlap(left, right) {
  const tokens = (value) => new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || []);
  const a = tokens(left); const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function hybridContentTokenOverlap(left, right) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'those', 'these', 'then', 'than', 'their', 'there', 'will', 'would', 'could', 'should']);
  const stem = (token) => {
    if (token.length > 6 && /ing$/.test(token)) return token.slice(0, -3);
    if (token.length > 5 && /ed$/.test(token)) return token.slice(0, -2);
    if (token.length > 5 && /es$/.test(token)) return token.slice(0, -2);
    if (token.length > 4 && /s$/.test(token)) return token.slice(0, -1);
    return token;
  };
  const tokens = (value) => new Set((String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || [])
    .filter((token) => !stop.has(token)).map(stem));
  const a = tokens(left); const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function tokenSet(value) {
  return new Set(clean(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3 && !['team', 'reviewed', 'specific', 'regarding', 'including'].includes(token)));
}

function nearDuplicate(left, right) {
  const a = tokenSet(left); const b = tokenSet(right);
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((token) => b.has(token)).length;
  return shared / Math.min(a.size, b.size) >= 0.72;
}

module.exports = {
  stableId,
  contentTokens,
  tokenOverlap,
  COMMON_SPEECH_WORDS,
  hybridRecordText,
  hybridTokenOverlap,
  hybridContentTokenOverlap,
  nearDuplicate
};
