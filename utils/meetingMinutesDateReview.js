'use strict';

const crypto = require('node:crypto');
const { explicitCalendarDate, isValidCalendarDate } = require('./meetingMinutesTiming');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY = `(?:${WEEKDAYS.join('|')})`;
const MONTH = '(?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)';
const ORDINAL = '(?:twenty[ -](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirty[ -]first|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)';
const DAY = `(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL})`;
const OCCURRENCE = '(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)';
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
  const adjacent = patterns.flatMap((pattern, patternIndex) => [...source.matchAll(pattern)].flatMap(match => {
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
  // The month and its asserted day may be joined by an explicit apposition,
  // rather than occurring side by side: "second Friday in March, which is
  // the twentieth this year". Keep this bound to one nth-weekday expression;
  // a later event/date or a bare day elsewhere in the turn is not a date label.
  const apposition = new RegExp(`\\b(${OCCURRENCE})\\s+(${WEEKDAY})\\s+(?:in|of)\\s+(${MONTH})\\.?\\s*,?\\s*(?:which\\s+is|that\\s+is|that's|namely|specifically)\\s+(?:the\\s+)?(${DAY})(?:\\s+(?:of\\s+)?(${MONTH})\\.?)?(?:\\s+(?:(this|next|last|previous)\\s+year|(\\d{4})))?\\b`, 'gi');
  const ordinal = [...source.matchAll(apposition)].flatMap(match => {
    const [, occurrence, weekday, month, day, repeatedMonth, relativeYear, literalYear] = match;
    if (repeatedMonth && repeatedMonth.slice(0, 3).toLowerCase() !== month.slice(0, 3).toLowerCase()) return [];
    if (!literalYear && !anchor) return [];
    const yearWords = literalYear || (relativeYear ? `${relativeYear} year` : '');
    const date = explicitCalendarDate(`${day} ${month} ${yearWords}`, anchor);
    if (!isValidCalendarDate(date)) return [];
    const parsed = new Date(`${date}T12:00:00Z`);
    const saidDay = WEEKDAYS.findIndex(value => value.toLowerCase() === weekday.toLowerCase());
    const actualDay = parsed.getUTCDay();
    const which = occurrence.toLowerCase();
    const wanted = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }[which] || Number.parseInt(which, 10);
    const nextWeek = new Date(parsed.getTime() + 7 * 86400000);
    const occurrenceMatches = which === 'last' ? nextWeek.getUTCMonth() !== parsed.getUTCMonth()
      : Math.floor((parsed.getUTCDate() - 1) / 7) + 1 === wanted;
    if (saidDay === actualDay && occurrenceMatches) return [];
    return [{ quote: clean(match[0]), weekday: WEEKDAYS[saidDay], actualWeekday: WEEKDAYS[actualDay],
      date, explicitYear: Boolean(literalYear), ordinalOccurrence: occurrence, month }];
  });
  return adjacent.concat(ordinal);
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
  const messageFor = issue => issue.ordinalOccurrence
    ? `The cited source says "${issue.quote}", but the stated date is not the ${issue.ordinalOccurrence} ${issue.weekday} of ${issue.month} in ${issue.date.slice(0, 4)}${issue.explicitYear ? '' : ' under the confirmed meeting-year context'}. Confirm the intended weekday, date and year; the minutes wording has not been changed.`
    : issue.explicitYear
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
      const key = [issue.evidenceId, issue.weekday, issue.date].join('|');
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
      kind, (Array.isArray(topic?.[kind]) ? topic[kind] : []).map(function visit(record) {
        const next = review(record);
        return Array.isArray(next?.supportingDetails)
          ? { ...next, supportingDetails: next.supportingDetails.map(visit) } : next;
      })
    ]))
  }));
  const positions = new Map((Array.isArray(sourceUnits) ? sourceUnits : []).map((unit, index) => [String(unit.id), index]));
  const flags = [...flagsByKey.values()].map(flag => ({ ...flag, evidenceIds: [...flag.evidenceIds]
    .sort((left, right) => (positions.get(left) ?? Infinity) - (positions.get(right) ?? Infinity)) }));
  return { discussion: reviewed, flags };
}

// Actions, objectives and summary prose can repeat the same source conflict.
// Reuse the exact same warning identity; no published wording is rewritten.
function reviewMeetingCalendarDates(content = {}, sourceUnits = [], options = {}) {
  const discussion = reviewDiscussionCalendarDates(content.discussion, sourceUnits, options);
  const actions = Array.isArray(content.actions) ? content.actions : [];
  const objectives = Array.isArray(content.meetingObjectives) ? content.meetingObjectives : [];
  const records = [];
  const append = record => {
    if (!record || typeof record !== 'object') return;
    records.push(record);
    (record.supportingDetails || []).forEach(append);
  };
  (content.discussion || []).forEach(topic => ['points', 'decisions', 'openQuestions']
    .forEach(kind => (topic[kind] || []).forEach(append)));
  actions.forEach(action => append({ ...action, text: `${action.action || ''} ${action.timing?.wording || ''}` }));
  // Uncited prose inherits candidates only from the confirmed records whose
  // substantive subject it repeats. A matching date alone is not a subject.
  const subject = value => new Set((String(value || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
    .filter(word => !/^(?:the|and|for|with|that|this|will|was|were|are|has|have|from|before|after|meeting|week|year|month|next|last|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(word)));
  const inheritedEvidence = value => {
    const claim = subject(value);
    return [...new Set(records.flatMap(record => {
      const tokens = subject(record.text);
      const shared = [...claim].filter(word => tokens.has(word)).length;
      return shared >= 2 && shared / Math.max(1, Math.min(claim.size, tokens.size)) >= 0.5
        ? record.primaryEvidenceIds?.length ? record.primaryEvidenceIds : record.evidenceIds || [] : [];
    }))];
  };
  const extra = reviewDiscussionCalendarDates([{ points: [
    ...actions.map(action => ({ ...action, text: `${action.action || ''} ${action.timing?.wording || ''}` })),
    ...objectives.map(value => typeof value === 'string'
      ? { text: value, evidenceIds: inheritedEvidence(value) } : value),
    { text: content.executiveSummary || '', evidenceIds: inheritedEvidence(content.executiveSummary) }
  ] }], sourceUnits, options);
  const points = extra.discussion[0].points;
  const nextActions = actions.map((action, index) => points[index]?.reviewFlagIds?.length
    ? { ...action, reviewFlagIds: points[index].reviewFlagIds } : action);
  const nextObjectives = objectives.map((objective, index) => typeof objective === 'string' ? objective
    : points[actions.length + index]);
  const byId = new Map([...discussion.flags, ...extra.flags].map(flag => [flag.id, flag]));
  return { ...content, discussion: discussion.discussion, actions: nextActions,
    meetingObjectives: nextObjectives, flags: [...byId.values()] };
}

module.exports = { reviewDiscussionCalendarDates, reviewMeetingCalendarDates };
