'use strict';

const crypto = require('node:crypto');
const { explicitCalendarDate, isValidCalendarDate } = require('./meetingMinutesTiming');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY = `(?:${WEEKDAYS.join('|')})`;
const MONTH = '(?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)';
const ORDINAL = '(?:twenty[ -](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirty[ -]first|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)';
const DAY = `(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL})`;
const DATE = `(?:(?:the\\s+)?${DAY}\\s+(?:of\\s+)?${MONTH}\\.?|${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?)(?:,?\\s+\\d{4})?`;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

function dateMentions(value, anchor) {
  return [...String(value || '').matchAll(new RegExp(`\\b${DATE}\\b`, 'gi'))].map(match => ({
    quote: match[0], explicitYear: /\b\d{4}\b/.test(match[0]),
    date: explicitCalendarDate(match[0], anchor)
  }));
}

function weekdayDateIssues(value, meetingDate) {
  const source = String(value || '');
  const anchor = isValidCalendarDate(meetingDate) ? meetingDate : '';
  const patterns = [
    new RegExp(`\\b(${WEEKDAY})\\s*[,:(-]?\\s*(${DATE})\\b`, 'gi'),
    // A following weekday must be a parenthetical/appositive date label, not
    // the start of the next entry in a list of separately dated events.
    new RegExp(`\\b(${DATE})\\s*(?:,\\s*|\\(\\s*)(${WEEKDAY})\\b(?=\\s*(?:\\)|[.!?;]|$))`, 'gi')
  ];
  return patterns.flatMap((pattern, patternIndex) => [...source.matchAll(pattern)].flatMap(match => {
    const weekday = patternIndex === 0 ? match[1] : match[2];
    const dateWords = patternIndex === 0 ? match[2] : match[1];
    const explicitYear = /\b\d{4}\b/.test(dateWords);
    if (!explicitYear && !anchor) return [];
    // These relative years require their own source interpretation. Do not
    // replace them with the meeting year merely to make a calendar check.
    const nearby = source.slice(Math.max(0, match.index - 18), match.index + match[0].length + 22);
    if (!explicitYear && /\b(?:next|last|previous|following)\s+year\b/i.test(nearby)) return [];
    const date = explicitCalendarDate(dateWords, anchor);
    if (!isValidCalendarDate(date)) return [];
    const saidDay = WEEKDAYS.findIndex(day => day.toLowerCase() === weekday.toLowerCase());
    const actualDay = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (saidDay === actualDay) return [];
    return [{ quote: clean(match[0]), weekday: WEEKDAYS[saidDay], actualWeekday: WEEKDAYS[actualDay], date, explicitYear }];
  }));
}

// This is a source-review warning, not a calendar correction. Only retained
// discussion records that actually repeat the cited date receive a link. A
// year supplied by the caller is a conditional comparison, never inserted into
// the source or the minutes. Callers must supply only a trusted meeting anchor.
function reviewDiscussionCalendarDates(discussion = [], sourceUnits = [], options = {}) {
  const anchor = isValidCalendarDate(options.meetingDate) ? options.meetingDate : '';
  const units = new Map((Array.isArray(sourceUnits) ? sourceUnits : [])
    .filter(unit => unit && (unit.classification !== 'remove' || unit.restored))
    .map(unit => [String(unit.id), unit]));
  const flagsByKey = new Map();
  const explicitYearKeys = new Set();
  const messageFor = issue => issue.explicitYear
    ? `The cited source says "${issue.quote}", but that calendar date falls on ${issue.actualWeekday}. Confirm the intended weekday and date; the minutes wording has not been changed.`
    : `The cited source says "${issue.quote}" without a year. Its weekday does not match that date in the confirmed meeting year (${issue.date.slice(0, 4)}). Confirm the intended weekday, date and year; the minutes wording has not been changed.`;
  const review = record => {
    const directIds = Array.isArray(record?.primaryEvidenceIds) && record.primaryEvidenceIds.length
      ? record.primaryEvidenceIds : record?.evidenceIds;
    const issues = (Array.isArray(directIds) ? directIds : []).flatMap(id => {
      const unit = units.get(String(id));
      return unit ? weekdayDateIssues(unit.text, anchor).map(issue => ({ ...issue, evidenceId: String(id) })) : [];
    });
    if (!issues.length) return record;
    const linked = [];
    for (const issue of issues) {
      const visibleDates = dateMentions(record?.text, issue.date);
      if (!visibleDates.some(visible => visible.date && visible.date.slice(5) === issue.date.slice(5)
        && (!visible.explicitYear || visible.date === issue.date))) continue;
      const key = [issue.weekday, issue.date].join('|');
      let flag = flagsByKey.get(key);
      if (!flag) {
        const id = 'flag-source-calendar-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 14);
        flag = {
          id, kind: 'timing', status: 'open', correctionNote: '', evidenceIds: [],
          message: messageFor(issue)
        };
        flagsByKey.set(key, flag);
      } else if (issue.explicitYear && !explicitYearKeys.has(key)) {
        flag.message = messageFor(issue);
      }
      if (issue.explicitYear) explicitYearKeys.add(key);
      if (!flag.evidenceIds.includes(issue.evidenceId)) flag.evidenceIds.push(issue.evidenceId);
      linked.push(flag.id);
    }
    if (!linked.length) return record;
    return { ...record, reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), ...linked])] };
  };
  const reviewed = (Array.isArray(discussion) ? discussion : []).map(topic => ({
    ...topic,
    ...Object.fromEntries(['points', 'decisions', 'openQuestions'].map(kind => [
      kind, (Array.isArray(topic?.[kind]) ? topic[kind] : []).map(review)
    ]))
  }));
  const positions = new Map((Array.isArray(sourceUnits) ? sourceUnits : []).map((unit, index) => [String(unit.id), index]));
  const flags = [...flagsByKey.values()].map(flag => ({ ...flag, evidenceIds: [...flag.evidenceIds]
    .sort((left, right) => (positions.get(left) ?? Infinity) - (positions.get(right) ?? Infinity)) }));
  return { discussion: reviewed, flags };
}

module.exports = { reviewDiscussionCalendarDates };
