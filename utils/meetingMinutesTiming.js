(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeetingMinutesTiming = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const TIMING_POLICY_VERSION = 3;
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
  const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 };
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const ORDINAL_RE = '(?:twenty[ -](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirty[ -]first|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)';
  const clean = value => String(value == null ? '' : value).trim();
  const canonical = value => clean(value).normalize('NFKC').toLowerCase().replace(/[’]/g, "'").replace(/[–—]/g, '-').replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const reviewer = row => row?.reviewerAuthored === true || row?.confirmedTopic === true || /_human_confirmation$/.test(String(row?.source || ''));
  const tentative = value => /\b(?:presumably|probably|possibly|maybe|perhaps|hopefully|ideally|prefer|preferably|approximately|roughly|around|about|sometime|all being well|if possible|aim|aiming|try|trying|expected|provisional)\b/i.test(String(value || ''));
  function isValidCalendarDate(value) {
    const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return year >= 1 && month >= 1 && month <= 12 && day >= 1
      && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }
  function isoDate(year, month, day) {
    const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return isValidCalendarDate(value) ? value : '';
  }
  function offsetDate(anchor, count) {
    if (!isValidCalendarDate(anchor) || !Number.isInteger(count)) return '';
    const date = new Date(`${anchor}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + count);
    const value = date.toISOString().slice(0, 10);
    return isValidCalendarDate(value) ? value : '';
  }
  function dayNumber(value) {
    const word = canonical(value).replace(/ /g, '-');
    if (/^\d{1,2}(?:st|nd|rd|th)?$/.test(word)) return Number(word.replace(/\D/g, ''));
    if (ORDINALS[word]) return ORDINALS[word];
    if (/^twenty-/.test(word)) return 20 + (ORDINALS[word.slice(7)] || 0);
    if (word === 'thirty-first') return 31;
    return 0;
  }
  function explicitCalendarDate(wording, meetingDate) {
    const value = clean(wording).toLowerCase();
    const literal = value.match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (literal) return isValidCalendarDate(literal[0]) ? literal[0] : '';
    const dayFirst = value.match(new RegExp(`(?<![a-z-])(?:the\\s+)?(\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_RE})\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`));
    const monthFirst = value.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`));
    const match = dayFirst && (!monthFirst || dayFirst.index <= monthFirst.index) ? dayFirst : monthFirst;
    const found = match === dayFirst && match ? { day: match[1], month: match[2], year: match[3] }
      : match ? { day: match[2], month: match[1], year: match[3] } : null;
    if (!found) return '';
    let year = found.year ? Number(found.year) : isValidCalendarDate(meetingDate) ? Number(meetingDate.slice(0, 4)) : 0;
    // A relative year qualifies its own date, not every date in the passage.
    const suffix = value.slice(match.index + match[0].length).match(/^\s*(?:(?:of|in)\s+)?(?:the\s+)?(this|next|last|previous)\s+year\b/);
    const prefix = value.slice(0, match.index).match(/\b(this|next|last|previous)\s+year(?:['’]s)?(?:\s+(?:on|in))?\s*$/);
    const qualifier = (suffix || prefix)?.[1];
    if (!found.year && year) year += qualifier === 'next' ? 1 : /^(?:last|previous)$/.test(qualifier || '') ? -1 : 0;
    const month = MONTHS.findIndex(name => name.slice(0, 3) === found.month.slice(0, 3)) + 1;
    return year ? isoDate(year, month, dayNumber(found.day)) : '';
  }
  function explicitCalendarDates(wording, meetingDate, options) {
    const value = clean(wording), dates = [];
    const patterns = [
      /\b\d{4}-\d{2}-\d{2}\b/g,
      new RegExp(`(?<![a-z-])(?:the\\s+)?(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_RE})\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+\\d{4})?`, 'gi'),
      new RegExp(`\\b${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, 'gi')
    ];
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        // A year qualifier belongs to its own date, not the first date in an
        // entire multi-date passage. Keep unrelated numeric gates unchanged.
        const qualifier = value.slice(match.index + match[0].length).match(/^\s*(?:(?:of|in)\s+)?(?:the\s+)?(?:this|next|last|previous)\s+year\b/i)?.[0] || '';
        const prefix = value.slice(0, match.index).match(/\b(?:this|next|last|previous)\s+year(?:['’]s)?(?:\s+(?:on|in))?\s*$/i)?.[0] || '';
        if (options?.requireYearContext && !/\b\d{4}\b/.test(match[0]) && !qualifier && !prefix) continue;
        const date = explicitCalendarDate(`${prefix} ${match[0]}${qualifier}`, meetingDate);
        if (date) dates.push(date);
      }
    }
    return [...new Set(dates)];
  }
  function classifyTimingWording(wording) {
    const value = canonical(wording).replace(/\bnot later than\b/g, 'by');
    if (!value) return { kind: 'empty', qualified: false };
    if (/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/.test(String(wording || ''))) return { kind: 'ambiguous_numeric_date', qualified: true };
    const calendarExpression = /\b\d{4}-\d{2}-\d{2}\b/.test(value)
      || new RegExp(`\\b(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_RE})\\s+(?:of\\s+)?${MONTH_RE}\\b`).test(value)
      || new RegExp(`\\b${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`).test(value);
    if (new RegExp(`\\b(?:every|each)\\s+(?:(?:other|first|second|third|last|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+)?(?:${DAYS.join('|')}|days?|weeks?|months?|quarters?|years?|mornings?|afternoons?|evenings?)\\b`).test(value)
      || /\b(?:weekly|fortnightly|monthly|quarterly|annually|yearly|daily|recurring|recurrent|regularly)\b/.test(value)
      || new RegExp(`\\b(?:${DAYS.join('|')})s\\b`).test(value)) return { kind: 'recurrence', qualified: true };
    if (!calendarExpression && /\b(?:last|previous)\s+year\b/.test(value)) return { kind: 'past_period', qualified: true };
    if (/\b(?:(?:no|not) (?:earlier|sooner) than|not before|not until|at (?:the )?earliest|at least)\b/.test(value)) return { kind: 'bound', qualified: true };
    if (/\b(?:not|never|no longer|except|excluding|instead of|rather than)\b/.test(value)) return { kind: 'negated', qualified: true };
    if (new RegExp(`\\b(?:last|previous)\\s+(?:${DAYS.join('|')})\\b|\\b(?:${DAYS.join('|')})\\b[^.;!?]{0,15}\\blast week\\b`).test(value)) return { kind: 'past_period', qualified: true };
    if (new RegExp(`\\b(?:today|tonight|tomorrow|${DAYS.join('|')})\\b[^.;!?]{0,25}\\bor\\b[^.;!?]{0,25}\\b(?:today|tonight|tomorrow|${DAYS.join('|')})\\b`).test(value)) return { kind: 'range', qualified: true };
    if (!calendarExpression && DAYS.filter(day => new RegExp(`\\b${day}\\b`).test(value)).length > 1) return { kind: 'range', qualified: true };
    if (/\b(?:end of (?:the )?day|close of play|close of business)\b/.test(value)) return { kind: 'specific', qualified: false };
    const period = new RegExp(`\\b(?:the\\s+)?(?:\\d{1,2}(?:st|nd|rd|th)|${ORDINAL_RE})(?:\\s+(?!(?:and|or|but|so|then|before|after|until|by)\\b)[a-z][a-z'’-]*){0,4}\\s+(?:hours?|days?|weeks?|weekends?|months?|quarters?|years?|mornings?|afternoons?|evenings?|nights?)\\b`, 'i');
    if (period.test(value) && !calendarExpression) return { kind: 'ordinal_period', qualified: true };
    const rangeValue = value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'isodate');
    const endpoint = `(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_RE})(?:\\s+(?:of\\s+)?${MONTH_RE})?`;
    if (/\b(?:preferred|fallback|contingency|hard stop)\b/.test(value)
      || new RegExp(`\\b${endpoint}\\s*(?:-|to|through|until|or)\\s*(?:the\\s+)?${endpoint}\\b`).test(rangeValue)
      || /\bisodate\s*(?:-|to|through|or)\s*isodate\b/.test(rangeValue)
      || /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:-|to|through|until|or)\s*(?:the\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(rangeValue)
      || /\b(?:between|from)\b.+\b(?:and|to|through|until)\b/.test(value)
      || new RegExp(`\\b(?:${DAYS.join('|')})\\s+(?:or|to|through)\\s+(?:${DAYS.join('|')})\\b`).test(value)) return { kind: 'range', qualified: true };
    if (/\b(?:before|prior to|ahead of)\b/.test(value)
      && new RegExp(`\\b(?:${DAYS.join('|')}|${MONTHS.join('|')}|\\d{1,2}(?:st|nd|rd|th)|${ORDINAL_RE})\\b`).test(value)) return { kind: 'bound', qualified: tentative(value) };
    if (/\b(?:once|after|following|when|upon|subject to|dependent on|depends on|pending|until|unless|if|provided that|based on|contingent on|before|prior to|ahead of)\b/.test(value)) return { kind: 'dependency', qualified: true };
    const qualified = tentative(value) || /\b(?:early|mid|late)\b/.test(value);
    if (/\b(?:for|lasting|takes?|taking|over)\s+(?:\d+|[a-z]+)(?:[ -])(?:days?|weeks?|months?|years?)\b|\b(?:\d+|[a-z]+)[ -](?:day|week|month|year)s?\s+(?:pilot|trial|test|review|programme|program|project|phase|study|period|cycle|sprint)\b|\b(?:days?|weeks?|months?)\s+ago\b/.test(value)) return { kind: 'duration', qualified: true };
    if (/\b(?:business|working)\s+days?\b/.test(value)) return { kind: 'business_interval', qualified: true };
    const statedDay = new RegExp(`\\b(?:${DAYS.join('|')})\\b`).test(value)
      && !new RegExp(`\\bnext\\s+(?:${DAYS.join('|')})\\b`).test(value);
    const calendarDay = calendarExpression;
    // Confidence about doing work on Saturday is different from uncertainty
    // about which day in a week. Keep the calendar day and show the qualifier.
    if (statedDay || calendarDay) return { kind: 'specific', qualified };
    if (qualified) return { kind: 'approximate', qualified: true };
    if (/\b(?:this|next|the|coming)\s+(?:week|weekend|month|quarter|year)\b|\bend of\b/.test(value)) return { kind: 'period', qualified: true };
    if (new RegExp(`\\bnext\\s+(?:${DAYS.join('|')})\\b`).test(value)) return { kind: 'ambiguous_weekday', qualified: true };
    return { kind: 'specific', qualified: false };
  }
  function resolveExactDate(wording, meetingDate) {
    const value = canonical(wording);
    const meaning = classifyTimingWording(wording);
    if (meaning.kind === 'ambiguous_weekday' && isValidCalendarDate(meetingDate)) {
      const named = DAYS.findIndex(day => new RegExp(`\\bnext\\s+${day}\\b`).test(value));
      if (named === new Date(`${meetingDate}T12:00:00Z`).getUTCDay()) return offsetDate(meetingDate, 7);
    }
    if (!value || meaning.kind !== 'specific') return '';
    const explicit = explicitCalendarDate(wording, meetingDate);
    if (explicit) return explicit;
    // Invalid explicit dates must not fall through into a different inference.
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(value) || new RegExp(`\\b${MONTH_RE}\\b`).test(value)) return '';
    if (!isValidCalendarDate(meetingDate)) return '';
    if (/\b(?:today|tonight|this (?:morning|afternoon|evening|lunchtime)|later today|end of (?:the )?day|close of (?:play|business)|eod|cob)\b/.test(value)) return meetingDate;
    if (/\btomorrow\b/.test(value)) return offsetDate(meetingDate, 1);
    if (new RegExp(`\\bthe\\s+(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_RE})\\b`).test(value)) return '';
    const weekday = DAYS.findIndex(day => new RegExp(`\\b${day}\\b`).test(value));
    if (weekday >= 0) {
      const current = new Date(`${meetingDate}T12:00:00Z`).getUTCDay();
      const offset = (weekday - current + 7) % 7;
      if (!offset && !/\b(?:this|morning|afternoon|evening|tonight|today|first thing)\b/.test(value)) return '';
      return offsetDate(meetingDate, offset);
    }
    const interval = value.match(/\b(?:in|within)\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|\d{1,3})\s+(days?|weeks?)\b/);
    if (interval) return offsetDate(meetingDate, (NUMBERS[interval[1]] || Number(interval[1])) * (interval[2].startsWith('week') ? 7 : 1));
    // A day without its month is not a complete date. Standalone spans are
    // retained as wording unless a caller establishes their due-date anchor.
    return '';
  }
  function normaliseTimingValue(timing, options) {
    const value = timing && typeof timing === 'object' ? timing : {};
    const opts = options || {};
    const wording = clean(value.wording);
    let kind = ['deadline', 'target', 'dependency', 'not_stated'].includes(value.kind) ? value.kind : 'not_stated';
    let exactDate = clean(value.exactDate);
    // Validation reports invalid supplied dates before removing them; quietly
    // sanitising here would erase the evidence needed for a review flag.
    if (opts.mode === 'derive' && !opts.reviewerAuthored) {
      const meaning = classifyTimingWording(wording);
      if (meaning.kind === 'dependency') kind = wording ? 'dependency' : kind;
      else if (tentative(wording) && kind === 'deadline') kind = 'target';
      if (!exactDate) exactDate = resolveExactDate(wording, opts.meetingDate);
    }
    return { ...value, kind: wording || exactDate ? kind : 'not_stated', wording, exactDate };
  }
  function formatCalendarDate(value) {
    if (!isValidCalendarDate(value)) return '';
    const [year, month, day] = value.split('-').map(Number);
    const name = month === 9 ? 'Sept' : MONTHS[month - 1].slice(0, 3).replace(/^./, ch => ch.toUpperCase());
    return `${day} ${name} ${year}`;
  }
  function formatTimingLabel(timing, options) {
    const opts = options || {}, value = timing || {};
    const wording = clean(value.wording), date = formatCalendarDate(clean(value.exactDate));
    if ((!wording && !date) || value.kind === 'not_stated') return opts.emptyLabel || 'Not stated';
    const exactWording = explicitCalendarDate(wording, '') === value.exactDate && classifyTimingWording(wording).kind === 'specific'
      && !/\b(?:by|before|after|within|until|on|at|morning|afternoon|evening|noon)\b/i.test(wording);
    const label = date && wording && !exactWording ? `${wording} (${date})` : wording || date;
    const prefix = value.kind === 'dependency' ? 'Dependent on' : value.kind === 'deadline' ? 'Deadline' : 'Target';
    return opts.includeKind === false ? label : `${prefix}: ${label}`;
  }
  function fingerprint(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16);
  }
  function timingAssessmentKey(row, units, meetingDate) {
    const ids = [...new Set(row?.evidenceIds || [])].sort();
    const selected = (units || []).filter(unit => ids.includes(unit.id)).map(unit => [unit.id, unit.speaker || '', unit.text || '']);
    return { actionKey: canonical(row?.action), ownersKey: [...new Set((row?.owners || []).map(canonical))].sort().join('|'), sourceKey: fingerprint(JSON.stringify(selected)), meetingDate: clean(meetingDate), sourceEvidenceIds: ids };
  }
  function assessmentMatches(row, units, meetingDate, decision) {
    if (!decision || decision.version !== TIMING_POLICY_VERSION || decision.actionKey !== canonical(row?.action) || decision.meetingDate !== clean(meetingDate)
      || decision.ownersKey !== [...new Set((row?.owners || []).map(canonical))].sort().join('|')) return false;
    const ids = decision.sourceEvidenceIds || row?.evidenceIds || [];
    if (!ids.every(id => (row?.evidenceIds || []).includes(id))) return false;
    return timingAssessmentKey({ ...row, evidenceIds: ids }, units, meetingDate).sourceKey === decision.sourceKey;
  }
  function rejectActionTiming(row, units, options) {
    const opts = options || {}, prior = row?.timingDecision || {}, timing = row?.timing || {};
    const field = opts.field || 'all';
    const rejectedExactDates = [...new Set([...(prior.rejectedExactDates || []), ...(timing.exactDate ? [timing.exactDate] : [])])];
    const rejectedWordings = [...new Set([...(prior.rejectedWordings || []), ...((field === 'all' || field === 'wording') && timing.wording ? [timing.wording] : [])])];
    const next = field === 'exactDate' ? { ...timing, exactDate: '' } : { kind: 'not_stated', wording: '', exactDate: '' };
    return { ...row, timing: next, timingDecision: { version: TIMING_POLICY_VERSION, ...timingAssessmentKey(row, units, opts.meetingDate), status: 'rejected', rejectedExactDates, rejectedWordings, previousTiming: { ...timing }, reason: opts.reason || 'unsupported_timing' } };
  }
  const SUBJECT_STOP = new Set(('the and for with from into that this then than their there will would could should have has had been are was were can need needs must shall please complete finish finalise finalize prepare arrange send share provide conduct do carry out before after once when today tomorrow morning afternoon evening week weeks next monday tuesday wednesday thursday friday saturday sunday').split(' '));
  const ACTIVITY_WORDS = new Set('complete finish finalise finalize prepare arrange send share provide conduct'.split(' '));
  function subjectWords(value, owners) {
    const body = canonical(value);
    const ownerWords = new Set((owners || []).flatMap(owner => canonical(owner).split(' ')));
    // An activity word can be part of the object (e.g. quality of finish),
    // rather than the requested operation. Do not erase that distinguishing
    // noun or lower the object-overlap threshold to compensate.
    const objectNouns = new Set([...body.matchAll(/\bof(?:\s+the)?\s+([a-z][a-z'-]*)\b/g)].map(match => match[1]).filter(word => ACTIVITY_WORDS.has(word)));
    return [...new Set((body.match(/[a-z][a-z'-]{2,}/g) || []).filter(word => (!SUBJECT_STOP.has(word) || objectNouns.has(word)) && !ownerWords.has(word)).map(word => word.replace(/(?:ing|ed|es|s)$/, '')))];
  }
  const OPERATION_GROUPS = [
    ['review', 'check', 'assess', 'analyse', 'analyze', 'inspect', 'evaluate', 'examine'],
    ['draft', 'write', 'prepare', 'produce', 'create', 'build', 'develop'],
    ['send', 'share', 'circulate', 'forward', 'provide', 'distribute', 'email', 'submit'],
    ['update', 'revise', 'amend', 'change', 'edit', 'correct'],
    ['book', 'schedule', 'arrange', 'organise', 'organize', 'coordinate', 'plan'],
    ['sign', 'countersign'], ['approve', 'authorise', 'authorize'],
    ['replace', 'fit', 'install', 'repair', 'fix', 'pop'],
    ['order', 'purchase', 'buy', 'place'], ['test', 'validate', 'verify'],
    ['start', 'begin', 'commence'], ['complete', 'finish', 'finalise', 'finalize'],
    ['meet', 'call', 'discuss', 'speak', 'talk']
  ];
  const hasOperation = (value, group) => group.some(verb => new RegExp(`\\b(?:${verb}(?:s|d|ed|ing)?${verb.endsWith('e') ? `|${verb.slice(0, -1)}ing` : ''})\\b`, 'i').test(value))
    || (group.includes('send') && /\b(?:get|pass)\s+(?:it|that|this|those|them)\s+(?:over|across|through)\s+to\b/i.test(value));
  function operationMatches(action, source) {
    let body = canonical(action);
    const modal = body.match(/^([^,;.!?]{1,100}?)\b(?:will|shall|must|should|needs? to|has to|have to|is to|are to)\s+(?:be\s+)?([a-z-]+)(.*)$/);
    const first = body.split(' ')[0];
    // Declarative and passive obligations have an operative verb too. The
    // shared subject word ("devices") cannot prove entered versus deleted.
    // Do not strip an imperative's later relative or coordinated clause.
    if (modal && !OPERATION_GROUPS.some(group => hasOperation(first, group))
      && !/\b(?:who|which|that|and|then)\b/.test(modal[1])) body = `${modal[2]}${modal[3]}`;
    const coordinated = [...body.matchAll(/\b(and|then)\s+([a-z-]+)/g)].filter(match => {
      const verb = match[2];
      if (OPERATION_GROUPS.some(group => hasOperation(verb, group)) || match[1] === 'then') return true;
      const previous = body.slice(0, match.index).trim().split(' ').pop();
      const rest = body.slice(match.index + match[0].length).trim();
      // Two nominal activities sharing a work/record head are an object,
      // e.g. inspection and maintenance records, not a second imperative.
      // Unknown real verbs remain required, including "archive the file".
      const nominal = word => /(?:ing|tion|sion|ment|ness|ity|ance|ence|hood)$/.test(word || '');
      return !(nominal(previous) && nominal(verb)
        && /^(?:work|activities|tasks|documentation|records|requirements|details|information|data|costs|resources)\b/.test(rest));
    }).map(match => match[2]);
    const verbs = [body.split(' ')[0], ...coordinated];
    const required = verbs.map(verb => ({ verb, group: OPERATION_GROUPS.find(group => hasOperation(verb, group)) }));
    return required.length > 0 && required.every(({ verb, group }) => group ? hasOperation(source, group)
      : new RegExp(`\\b${verb}(?:s|d|ed|ing)?\\b`, 'i').test(source));
  }
  function roleAndRecipientMatch(row, clause, unit, options) {
    const opts = options || {};
    const value = canonical(clause), ownerWords = (row.owners || []).map(owner => canonical(owner).split(' '));
    const assigned = [...String(clause).matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:\s+(?:will|shall|must|to|is|are)|['’]s)\s+(?:each\s+)?[a-z]+\b/g)]
      .filter(match => !DAYS.includes(canonical(match[1])) && !MONTHS.includes(canonical(match[1]))
        && !['that', 'this', 'it', 'there', 'here', 'what', 'who', 'the', 'we', 'he', 'she', 'i', 'you', 'they'].includes(canonical(match[1])));
    if (ownerWords.length && assigned.some(match => {
      const preceding = String(clause).slice(0, match.index).match(/((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s*(?:,|and)\s*)+)$/)?.[1] || '';
      const names = [...preceding.split(/,|\band\b/).map(clean).filter(Boolean), match[1]];
      return !ownerWords.some(parts => names.some(name => canonical(name).split(' ').every(part => parts.includes(part))));
    })) return false;
    const recipients = [...String(row.action || '').matchAll(/\b(to|with|for)\s+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,2})\b/gu)]
      .filter(match => !DAYS.includes(canonical(match[2])) && !MONTHS.includes(canonical(match[2])));
    const nameParts = name => canonical(name).split(' ').filter(part => !DAYS.includes(part) && !MONTHS.includes(part));
    const nameMatches = (stated, desired) => {
      const parts = nameParts(stated), wanted = nameParts(desired);
      if (!parts.length || !parts.every(part => wanted.includes(part))) return false;
      if (parts.length > 1) return true;
      // A shortened name is usable only when known people do not make it
      // ambiguous. It cannot make Casey Lee into Casey Patel.
      const alternatives = new Set((opts.people || []).filter(name => nameParts(name).includes(parts[0])).map(canonical));
      return alternatives.size <= 1;
    };
    for (const recipient of recipients) {
      const named = [...String(clause).matchAll(new RegExp(`\\b${recipient[1]}\\s+([A-Z][\\p{L}'’-]*(?:\\s+[A-Z][\\p{L}'’-]*){0,2})\\b`, 'gu'))];
      if (named.length) {
        if (!named.every(match => nameMatches(match[1], recipient[2]))) return false;
        continue;
      }
      // In a referential send promise, "to you ... , Casey" names its own
      // recipient. Do not borrow a name from another timed task in the turn.
      const at = String(unit.text || '').indexOf(clause);
      const tail = at >= 0 ? String(unit.text).slice(at + clause.length) : '';
      const addressed = /\bto you\b/i.test(clause) && tail.match(/^[,\s]+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,2})[.!?]?\s*$/u);
      if (addressed && nameMatches(addressed[1], recipient[2])) continue;
      if (!opts.allowMissingRecipient) return false;
    }
    if (/\b(?:i['’]ll|i will|i can|i am going to)\b/i.test(clause) && ownerWords.length) {
      const speaker = canonical(unit.speaker).split(' ');
      if (!ownerWords.some(parts => parts.every(part => speaker.includes(part)))) return false;
    }
    return true;
  }
  function dateSourceSupported(row, units, meetingDate, date) {
    const ids = new Set(row.evidenceIds || []), owners = row.owners || [];
    const rows = (units || []).filter(unit => unit.classification !== 'remove' || unit.restored);
    const people = [...new Set(rows.map(unit => unit.speaker).filter(Boolean))];
    const rolesMatch = (clause, unit, allowMissingRecipient = false) => roleAndRecipientMatch(row, clause, unit, { people, allowMissingRecipient });
    const subjects = subjectWords(row.action, owners);
    const about = text => {
      const shared = subjectWords(text, owners).filter(word => subjects.includes(word)).length;
      return subjects.length > 0 && shared >= Math.min(2, subjects.length);
    };
    return rows.some((unit, index) => {
      if (!ids.has(unit.id)) return false;
      const clauses = String(unit.text || '').split(/[,;]|(?<=[.!?])\s+|\b(?:before|after|once|following|when|until)\b/i).map(clean).filter(Boolean);
      const carrying = clauses.map((clause, at) => ({ clause, at })).filter(item => resolveExactDate(item.clause, meetingDate) === date);
      if (!carrying.length) return false;
      // A timing answer or referential commitment can use its actual cited
      // preceding commitment as antecedent, without borrowing a later task.
      const temporalFillers = new Set([...MONTHS, 'probably', 'presumably', 'approximately', 'roughly', 'about', 'around', 'early', 'late', 'ideally', 'hopefully', 'prefer', 'preferably', 'weekend', 'last', 'previous', 'year', 'deadline', 'target', 'due', 'being', 'well', 'would', 'could', 'should', 'going', 'just', 'then', 'again', 'still', 'yes', 'yeah', 'okay', 'really', 'fine', 'good', 'great', 'thanks', 'thank', 'everyone']);
      const localSubjects = clause => subjectWords(clause, owners).filter(word => !temporalFillers.has(word)
        && !/^(?:i|we|you|they|it|he|she)(?:'ll|'re|'ve|'m|'d)?$/.test(word));
      return carrying.some(({ clause, at: clauseIndex }) => {
        if (about(clause) && operationMatches(row.action, clause) && rolesMatch(clause, unit)) return true;
        const shortTiming = !localSubjects(clause).length
          || /\b(?:do|send|get|pass|fit|replace|finish|complete)\s+(?:it|that|this|one|unit|them)\b|\bby then\b/i.test(clause);
        if (!shortTiming) return false;
        // A short referential promise still belongs to its own speaker.
        // Finding an older matching task cannot make Jordan's "I'll do it"
        // into a timing commitment by the named owner Morgan.
        if (!rolesMatch(clause, unit, true)) return false;
        let connectedOperation = operationMatches(row.action, clause) && rolesMatch(clause, unit);
        // A turn can change subjects before its short date clause. That nearer
        // subject controls; comma-splitting must not detach it and borrow an
        // older task merely because both passages have the same speaker.
        for (let local = clauseIndex - 1; local >= 0; local -= 1) {
          const antecedent = clauses[local];
          // Comma splitting can put the self-assignment before the date.
          // Check it even when the clause has no concrete subject of its own.
          if (!rolesMatch(antecedent, unit, true)) return false;
          if (!localSubjects(antecedent).length) continue;
          if (!about(antecedent) || !rolesMatch(antecedent, unit, connectedOperation)) return false;
          if (operationMatches(row.action, antecedent) || connectedOperation) return true;
          break;
        }
        for (let at = index - 1; at >= Math.max(0, index - 8); at -= 1) {
          const previous = rows[at];
          if (/\b(?:now (?:the|on to)|next item|another task)\b/i.test(previous.text)) break;
          if (ids.has(previous.id) && operationMatches(row.action, previous.text) && rolesMatch(previous.text, previous)) connectedOperation = true;
          if (ids.has(previous.id) && about(previous.text) && connectedOperation && rolesMatch(previous.text, previous)) return true;
          if (/\b(?:i['’]ll|i will|we['’]ll|we will)\b/i.test(previous.text)
            && !/\b(?:it|that|this|one|unit|those|them)\b/i.test(previous.text)
            && !about(previous.text) && subjectWords(previous.text, owners).length >= 2) break;
        }
        return false;
      });
    });
  }
  function timingComparisonValue(value) {
    let result = canonical(String(value || '').replace(/^\s*(?:deadline|target|preferred|fallback|contingency)\s*:\s*/i, ''));
    result = result.replace(/\b(?:presumably|probably|possibly|maybe|perhaps|hopefully|ideally|preferably|approximately|roughly|about|around)\b/g, ' ')
      .replace(/\ball being well\b|\bif possible\b/g, ' ');
    for (const [word, number] of Object.entries(NUMBERS)) {
      if (word === 'a' || word === 'an') continue;
      result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), String(number));
    }
    return result.replace(/(\d+)\s*(?:-|or|through)\s*(\d+)/g, '$1 to $2').replace(/\s+/g, ' ').trim();
  }
  function timingWordingParts(wording) {
    return String(wording || '').split(/;|\b(?:preferred|fallback|contingency)\s*:/i)
      .map(value => timingComparisonValue(value).replace(/^(?:by|on|at)\s+/, '').trim()).filter(Boolean);
  }
  function wordingSourceBinding(row, units, meetingDate) {
    const ids = new Set(row.evidenceIds || []);
    const rows = (units || []).filter(unit => unit.classification !== 'remove' || unit.restored);
    const cited = rows.filter(unit => ids.has(unit.id));
    const base = { sourceEvidenceIds: cited.map(unit => unit.id), matchedSourceIds: [], conflictingSourceIds: [], sourceQuotes: [], qualifiers: [] };
    if (!cited.length) return { ...base, status: 'unresolved', reason: 'no_source_evidence' };
    const people = [...new Set(rows.map(unit => unit.speaker).filter(Boolean))];
    const rolesMatch = (clause, unit, allowMissingRecipient = false) => roleAndRecipientMatch(row, clause, unit, { people, allowMissingRecipient });
    const owners = row.owners || [], subjects = subjectWords(row.action, owners);
    const firstVerb = canonical(row.action).split(' ')[0]?.replace(/(?:ing|ed|es|s)$/, '');
    const objects = subjects.filter(word => word !== firstVerb);
    const about = text => {
      const other = subjectWords(text, owners), shared = objects.filter(word => other.includes(word)).length;
      return objects.length > 0 && shared >= Math.min(2, objects.length) && shared / objects.length >= 0.6;
    };
    const temporalFillers = new Set([...MONTHS, ...DAYS, ...Object.keys(NUMBERS), ...subjectWords(row.timing?.wording), 'probably', 'presumably', 'approximately', 'roughly', 'about', 'around', 'early', 'mid', 'late', 'ideally', 'hopefully', 'prefer', 'preferably', 'weekend', 'month', 'quarter', 'year', 'deadline', 'target', 'due', 'being', 'well', 'would', 'could', 'should', 'going', 'just', 'then', 'again', 'still', 'yes', 'yeah', 'okay', 'really', 'fine', 'good', 'great', 'thanks', 'thank', 'everyone', 'when', 'what', 'time', 'how', 'long', 'all', 'end', 'day', 'within', 'every', 'each', 'weekly', 'monthly', 'daily', 'so', 'like', 'think', 'say', "let's", "that's", 'me']);
    const localSubjects = clause => subjectWords(clause, owners).filter(word => !temporalFillers.has(word)
      && !/^(?:i|we|you|they|it|he|she)(?:'ll|'re|'ve|'m|'d)?$/.test(word));
    const operationTerms = new Set(OPERATION_GROUPS.flat().map(word => word.replace(/(?:ing|ed|es|s)$/, '')));
    const referenceTerms = clause => localSubjects(clause).filter(word => (!operationTerms.has(word) || objects.includes(word))
      && !['least', 'main', 'focu', 'your', 'our', 'also', 'well', 'as', 'to', 'for'].includes(word));
    const primary = canonical(row.action).split(' ')[0];
    const primaryGroup = OPERATION_GROUPS.find(group => hasOperation(primary, group));
    const primaryMatches = text => primaryGroup ? hasOperation(text, primaryGroup) : new RegExp(`\\b${primary}(?:s|d|ed|ing)?\\b`, 'i').test(text);
    const operationAtPosition = (text, group) => group.some(verb => new RegExp(`(?:^|\\b(?:will|shall|must|to|can|could|would|should|i'll|we'll|is|are|am)\\s+)(?:(?:also|just|then|each|be)\\s+){0,2}(?:${verb}(?:s|d|ed|ing)?${verb.endsWith('e') ? `|${verb.slice(0, -1)}ing` : ''})\\b`, 'i').test(text));
    const conflictingWork = text => {
      const terms = referenceTerms(text);
      // HAVE contractions and the ordinary "have got" construction name
      // the same scheduled event as "have". Normalize only this event test;
      // preserve source quotations and all unresolved binding behavior.
      const eventStatement = canonical(text)
        .replace(/\b(i|you|we|they)'ve\b/g, '$1 have')
        .replace(/\b(he|she|it)'s(?=\s+got\b)/g, '$1 has')
        .replace(/\b(have|has|had)\s+got\b/g, '$1');
      if (/^\s*for\s+(?:the\s+)?/i.test(text) && terms.length && !terms.some(word => objects.includes(word))) return true;
      if (OPERATION_GROUPS.some(group => !hasOperation(row.action, group) && operationAtPosition(text, group))) return true;
      if (/\b(?:have|has|had|hold|arrange|schedule)\s+(?:(?:a|an|another|the|our|team|short|quick)\s+){0,3}(?:meeting|call)\b/i.test(eventStatement)
        && !/\b(?:meeting|call)\b/i.test(row.action)) return true;
      const mainWork = String(row.action || '').split(/\b(?:after|once|following|when|until|before|subject to|dependent on)\b/i)[0];
      if (/\b(?:meeting|call)\b[^.;!?]{0,60}\b(?:is|was|will be|on)\b|\b(?:is|was|will be)\b[^.;!?]{0,30}\b(?:meeting|call)\b/i.test(text)
        && !/\b(?:meeting|call)\b/i.test(mainWork)) return true;
      // A short, explicit alternative object is a real mismatch. A longer
      // paraphrase with missing detail remains unresolved instead of losing
      // valid timing merely because lexical recall is incomplete.
      return objects.length <= 3 && primaryMatches(text) && terms.length >= objects.length && !about(text);
    };
    const parts = timingWordingParts(row.timing?.wording);
    if (!parts.length) return { ...base, status: 'unresolved', reason: 'no_comparable_timing_wording' };
    const results = parts.map(part => {
      const matched = [], conflicting = [], quotes = [];
      let found = false;
      for (let index = 0; index < rows.length; index += 1) {
        const unit = rows[index];
        if (!ids.has(unit.id)) continue;
        // Split actual work clauses, retaining dependency connectors. A date
        // in a neighbouring operation is not evidence for the whole turn.
        const clauses = String(unit.text || '').split(/[,;]|(?<=[.!?])\s+|\b(?:and|but|then)\s+(?=(?:I['’]ll|I will|we will|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:will|shall|to))\b)/).map(clean).filter(Boolean);
        for (let at = 0; at < clauses.length; at += 1) {
          const clause = clauses[at], compared = timingComparisonValue(clause);
          if (!(` ${compared} `).includes(` ${part} `)) continue;
          found = true;
          const beforeTiming = compared.slice(0, compared.indexOf(part)).trim();
          if (/\b(?:not|never|except|excluding|instead of|rather than)(?:\s+(?:until|before|during|in|on|at))?$/.test(beforeTiming)) {
            conflicting.push(unit.id);
            continue;
          }
          let bound = about(clause) && operationMatches(row.action, clause) && rolesMatch(clause, unit);
          const timedWork = clause.replace(/[.!?]+$/, '').match(/\bto\s+([^.;!?]+)$/i)?.[1] || '';
          const timedWorkReferences = subjectWords(timedWork, owners).filter(word =>
            (!operationTerms.has(word) || objects.includes(word))
            && !['least', 'main', 'focu', 'your', 'our', 'also', 'well', 'as', 'for'].includes(word));
          const namesOwnTimedWork = timedWork && primaryMatches(timedWork)
            && timedWorkReferences.length && timedWorkReferences.every(word => objects.includes(word))
            && rolesMatch(clause, unit, true);
          // "...next week to start the testing" explicitly names that
          // operation, even if the expanded action contains unproved detail.
          // Do not backtrack into an adjacent review/purchase and declare its
          // different operation a contradiction. Preserve as unresolved until
          // the full work binding is established; this is not verification.
          if (!bound && namesOwnTimedWork) continue;
          const references = referenceTerms(clause);
          const partialReference = references.length > 0 && references.every(word => objects.includes(word))
            && operationMatches(row.action, clause) && rolesMatch(clause, unit);
          const shortTiming = !localSubjects(clause).length
            || partialReference || /\b(?:do|send|get|pass|fit|replace|finish|complete|review|check|update|write|test)\s+(?:it|that|this|one|unit|them)(?:\s+(?:document|file|letter|report))?\b|\bby then\b/i.test(clause);
          let explicitConflict = !rolesMatch(clause, unit, true)
            || !shortTiming && !bound && conflictingWork(clause);
          let connectedOperation = operationMatches(row.action, clause) && rolesMatch(clause, unit);
          const used = [unit.id];
          const fronted = /^\s*(?:once|after|following|when|upon|subject to|pending|until|if|provided that|before)\b/i.test(clause)
            && at + 1 < clauses.length && !/[.!?]$/.test(clause);
          const followingWork = fronted && (about(clauses[at + 1]) || OPERATION_GROUPS.some(group => operationAtPosition(clauses[at + 1], group)));
          if (!bound && followingWork) {
            bound = about(clauses[at + 1]) && operationMatches(row.action, clauses[at + 1]) && rolesMatch(clauses[at + 1], unit);
            if (!bound && (conflictingWork(clauses[at + 1]) || !rolesMatch(clauses[at + 1], unit, true))) explicitConflict = true;
          }
          if (!bound && shortTiming && !followingWork) {
            for (let local = at - 1; local >= 0; local -= 1) {
              const antecedent = clauses[local];
              if (!rolesMatch(antecedent, unit, true)) { explicitConflict = true; break; }
              if (!localSubjects(antecedent).length) continue;
              if (!rolesMatch(antecedent, unit, connectedOperation)) explicitConflict = true;
              else if (!about(antecedent)) {
                // A named subtask can be restated in a group of work before
                // its own timing clause. Its exact earlier commitment is
                // still required; a different nearer object remains a stop.
                if ((!partialReference || !references.every(word => referenceTerms(antecedent).includes(word))) && conflictingWork(antecedent)) explicitConflict = true;
              }
              else if (operationMatches(row.action, antecedent) || connectedOperation) bound = true;
              else if (conflictingWork(antecedent)) explicitConflict = true;
              break;
            }
            if (!bound && !explicitConflict) {
              for (let previousAt = index - 1; previousAt >= Math.max(0, index - 8); previousAt -= 1) {
                const previous = rows[previousAt];
                if (/\b(?:now (?:the|on to)|next item|another task)\b/i.test(previous.text)) break;
                if (ids.has(previous.id) && operationMatches(row.action, previous.text) && rolesMatch(previous.text, previous)) connectedOperation = true;
                if (ids.has(previous.id) && about(previous.text) && connectedOperation && rolesMatch(previous.text, previous)) {
                  bound = true;
                  used.push(previous.id);
                  break;
                }
                if (/\b(?:i['’]ll|i will|we['’]ll|we will)\b/i.test(previous.text)
                  && !/\b(?:it|that|this|one|unit|those|them)\b/i.test(previous.text)
                  && !about(previous.text) && localSubjects(previous.text).length >= 2) {
                  explicitConflict = true;
                  break;
                }
              }
            }
          }
          if (bound) { matched.push(...used); quotes.push({ sourceId: unit.id, quote: clause }); }
          else if (explicitConflict) conflicting.push(unit.id);
        }
      }
      return { status: matched.length ? 'supported' : conflicting.length ? 'unsupported' : 'unresolved', found, matched, conflicting, quotes };
    });
    const status = results.every(result => result.status === 'supported') ? 'supported'
      : results.some(result => result.status === 'unsupported') ? 'unsupported' : 'unresolved';
    const sourceQuotes = results.flatMap(result => result.quotes);
    return { ...base, status, reason: status === 'supported' ? 'source_bound_wording' : status === 'unsupported' ? 'timing_belongs_to_different_work_or_role' : 'timing_binding_not_established',
      matchedSourceIds: [...new Set(results.flatMap(result => result.matched))], conflictingSourceIds: [...new Set(results.flatMap(result => result.conflicting))], sourceQuotes,
      qualifiers: [...new Set(sourceQuotes.flatMap(item => item.quote.match(/\b(?:presumably|probably|possibly|maybe|perhaps|hopefully|ideally|preferably|approximately|roughly|early|late|if possible|all being well)\b/gi) || []).map(canonical))] };
  }
  function timingConstraints(value) {
    const text = String(value || '');
    const zones = [...text.matchAll(/(?:^|[^A-Za-z])((?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?|BST|CET|CEST|EET|EEST|IST|EST|EDT|CST|CDT|MST|MDT|PST|PDT|AEST|AEDT|JST|NZST|NZDT)(?=$|[^A-Za-z])/gi)].map(match => match[1].toUpperCase());
    const withoutOffsets = text.replace(/\b(?:UTC|GMT)[+-]\d{1,2}(?::?\d{2})?/gi, '');
    const clocks = [...withoutOffsets.matchAll(/(?<!\d)(\d{1,2})[:.](\d{2})(?:\s*(a\.?m\.?|p\.?m\.?))?/gi)]
      .filter(match => Number(match[1]) <= 23 && Number(match[2]) < 60)
      .filter(match => {
        const before = withoutOffsets.slice(0, match.index), after = withoutOffsets.slice(match.index + match[0].length);
        if (/(?:[£$€]|\b(?:GBP|USD|EUR|CAD|AUD|cost|costs|fee|fees|price|balance|budget))\s*$/i.test(before)
          || /^\s*(?:(?:pounds?|dollars?|euros?|pence|cents?|kg|kilograms?|grams?|mg|ml|litres?|liters?|metres?|meters?|cm|mm|miles?|percent)\b|%)/i.test(after)) return false;
        // A decimal is not a clock merely because its digits fit hours and
        // minutes. UK dotted clock notation needs a time cue or stated zone.
        return !/^\d{1,2}\./.test(match[0]) || Boolean(match[3])
          || /\b(?:at|by|from|until|after|before|around|between|to)\s*$/i.test(before)
          || /^\s*(?:UTC|GMT|BST|CET|CEST|EET|EEST|IST|EST|EDT|CST|CDT|MST|MDT|PST|PDT|AEST|AEDT|JST|NZST|NZDT)\b/i.test(after);
      })
      .map(match => {
        const meridiem = (match[3] || '').replace(/\./g, '').toLowerCase();
        const hour = meridiem && Number(match[1]) >= 1 && Number(match[1]) <= 12 ? Number(match[1]) % 12 + (meridiem === 'pm' ? 12 : 0) : Number(match[1]);
        return `${hour}:${match[2]}`;
      });
    const parts = (text.match(/\b(?:morning|afternoon|evening|noon|midnight|lunchtime)\b/gi) || []).map(canonical);
    return { zones: [...new Set(zones)], clocks: [...new Set(clocks)], parts: [...new Set(parts)] };
  }
  function assessClockConstraints(row, units, meetingDate, date) {
    const wanted = timingConstraints(row.timing?.wording);
    if (!Object.values(wanted).some(values => values.length)) return null;
    const matches = [];
    for (const unit of (units || []).filter(item => (row.evidenceIds || []).includes(item.id))) {
      for (const clause of String(unit.text || '').split(/[,;]|(?<=[.!?])\s+|\b(?:before|after|once|following|when|until)\b/i).map(clean).filter(Boolean)) {
        if (resolveExactDate(clause, meetingDate) !== date) continue;
        const limited = units.map(item => item === unit ? { ...item, text: clause } : item);
        if (dateSourceSupported(row, limited, meetingDate, date)) matches.push({ sourceId: unit.id, quote: clause, constraints: timingConstraints(clause) });
      }
    }
    if (matches.some(item => Object.entries(wanted).every(([key, values]) => values.every(value => item.constraints[key].includes(value))))) return null;
    const contradicts = matches.some(item => Object.entries(wanted).some(([key, values]) => values.length && item.constraints[key].length && !values.some(value => item.constraints[key].includes(value))));
    return { status: contradicts ? 'unsupported' : 'unresolved', reason: contradicts ? 'clock_zone_or_day_part_conflict' : 'clock_zone_or_day_part_not_bound',
      matchedSourceIds: [], conflictingSourceIds: contradicts ? [...new Set(matches.map(item => item.sourceId))] : [], sourceQuotes: matches.map(({ sourceId, quote }) => ({ sourceId, quote })) };
  }
  function assessTimingSourceBinding(row, units, options) {
    const opts = options || {}, wording = clean(row?.timing?.wording), date = clean(row?.timing?.exactDate);
    const cited = (units || []).filter(unit => (row?.evidenceIds || []).includes(unit.id) && (unit.classification !== 'remove' || unit.restored));
    const base = { sourceEvidenceIds: cited.map(unit => unit.id), matchedSourceIds: [], conflictingSourceIds: [], sourceQuotes: [], qualifiers: [] };
    if (!wording && !date) return { ...base, status: 'not_stated', reason: 'no_timing_value' };
    const resolved = resolveExactDate(wording, opts.meetingDate) || (!wording && isValidCalendarDate(date) ? date : '');
    if (resolved) {
      const calendarSupported = dateSourceSupported(row, units, opts.meetingDate, resolved);
      const explicitClaim = wording && explicitCalendarDate(wording, opts.meetingDate);
      if (explicitClaim && cited.length && !calendarSupported && !cited.some(unit => explicitCalendarDates(unit.text, opts.meetingDate).includes(resolved)
        || String(unit.text || '').split(/[,;]|(?<=[.!?])\s+/).some(clause => resolveExactDate(clause, opts.meetingDate) === resolved))) {
        // A monthless day number cannot establish a supplied month merely
        // because task binding is otherwise too vague to resolve. This is a
        // precision rejection, not rejection of the accepted work itself.
        return { ...base, status: 'unsupported', reason: 'calendar_date_not_stated_in_cited_source', conflictingSourceIds: base.sourceEvidenceIds };
      }
      if (calendarSupported) {
        const clockBinding = assessClockConstraints(row, units, opts.meetingDate, resolved);
        if (clockBinding) return { ...base, ...clockBinding };
        const carrying = cited.filter(unit => String(unit.text || '').split(/[,;]|(?<=[.!?])\s+/).some(clause => resolveExactDate(clause, opts.meetingDate) === resolved));
        const wordingBinding = wording ? wordingSourceBinding(row, units, opts.meetingDate) : null;
        return { ...base, status: 'supported', reason: 'source_bound_calendar_date', matchedSourceIds: carrying.map(unit => unit.id),
          ...(wordingBinding?.status === 'supported' ? { sourceQuotes: wordingBinding.sourceQuotes, qualifiers: wordingBinding.qualifiers } : {}) };
      }
      const wordingBinding = wording ? wordingSourceBinding(row, units, opts.meetingDate) : null;
      return { ...base, ...(wordingBinding || {}), status: wordingBinding?.status === 'unsupported' ? 'unsupported' : 'unresolved',
        reason: wordingBinding?.status === 'unsupported' ? 'calendar_date_not_bound_to_work' : cited.length ? 'calendar_binding_not_established' : 'no_source_evidence' };
    }
    return wordingSourceBinding(row, units, opts.meetingDate);
  }
  function assessActionTiming(row, units, options) {
    const opts = options || {}, issues = [];
    const human = reviewer(row) || opts.reviewerAuthored === true;
    let action = { ...row, timing: { ...(row?.timing || { kind: 'not_stated', wording: '', exactDate: '' }) } };
    const initialMeaning = classifyTimingWording(action.timing.wording);
    if (!human && action.timing.kind !== 'not_stated') {
      if (initialMeaning.kind === 'dependency') action.timing.kind = 'dependency';
      else if (tentative(action.timing.wording) && action.timing.kind === 'deadline') action.timing.kind = 'target';
    }
    let decision = assessmentMatches(action, units, opts.meetingDate, action.timingDecision) ? action.timingDecision
      : (opts.assessments || []).find(item => assessmentMatches(action, units, opts.meetingDate, item));
    if (!decision) delete action.timingDecision;
    if (!human && decision && assessmentMatches(action, units, opts.meetingDate, decision)) {
      if ((decision.rejectedWordings || []).some(wording => canonical(wording) === canonical(action.timing.wording))) action.timing = { kind: 'not_stated', wording: '', exactDate: '' };
      else if ((decision.rejectedExactDates || []).includes(action.timing.exactDate)) action.timing.exactDate = '';
      action.timingDecision = decision;
    }
    const value = action.timing, date = clean(value.exactDate), wording = clean(value.wording);
    const issue = (code, message, preserveValue) => issues.push({ code, message, field: 'exactDate', ...(preserveValue ? { preserveValue: true } : {}) });
    const wordingDate = resolveExactDate(wording, opts.meetingDate);
    const binding = assessTimingSourceBinding(action, units, opts);
    if (!human && wording && binding.status === 'unsupported') {
      issues.push({ code: wordingDate ? 'unsupported_date_wording' : 'unsupported_timing_wording', field: 'all', message: `The timing wording "${wording}" is not supported by source wording bound to this action.`, sourceEvidenceIds: binding.conflictingSourceIds });
    } else if (!human && wording && (!date || isValidCalendarDate(date)) && binding.status === 'unresolved') {
      issues.push({ code: 'timing_source_unresolved', field: 'wording', preserveValue: true, message: `The source does not establish whether the timing "${wording || date}" belongs to this action; the work and timing are retained for review.`, sourceEvidenceIds: binding.sourceEvidenceIds });
    }
    if (!human && binding.status === 'supported' && binding.qualifiers.some(qualifier => !canonical(wording).includes(qualifier))) {
      if (action.timing.kind === 'deadline') action.timing.kind = 'target';
      issues.push({ code: 'source_timing_qualification', field: 'wording', preserveValue: true, message: `The source qualifies this timing (${binding.qualifiers.join(', ')}); confirm that the action preserves that uncertainty.`, sourceEvidenceIds: binding.matchedSourceIds });
    }
    if (date) {
      const meaning = classifyTimingWording(wording);
      if (!isValidCalendarDate(date)) issue('invalid_calendar_date', `The date ${date} is not a real calendar date.`);
      else if (wording && meaning.kind !== 'specific' && !(meaning.kind === 'ambiguous_weekday' && resolveExactDate(wording, opts.meetingDate))) issue('unsupported_precision', `The exact date ${date} is not established by the qualified timing "${wording}".`);
      else if (isValidCalendarDate(opts.meetingDate) && date < opts.meetingDate && dateSourceSupported(action, units, opts.meetingDate, date)) issue('past_action_date', `The source-stated action date ${date} precedes the meeting date ${opts.meetingDate}; confirm whether the work is overdue.`, true);
      else if (wording && resolveExactDate(wording, opts.meetingDate) && resolveExactDate(wording, opts.meetingDate) !== date) issue('date_wording_conflict', `The exact date ${date} conflicts with the timing wording "${wording}".`);
      else if (!dateSourceSupported(action, units, opts.meetingDate, date)) issue('unsupported_exact_date', `The exact date ${date} is not supported by source wording bound to this action.`);
      const namedDay = DAYS.findIndex(day => new RegExp(`\\b${day}\\b`, 'i').test(wording));
      if (isValidCalendarDate(date) && namedDay >= 0 && new Date(`${date}T12:00:00Z`).getUTCDay() !== namedDay) issue('weekday_date_conflict', `The weekday in "${wording}" does not match ${date}.`, dateSourceSupported(action, units, opts.meetingDate, date));
    }
    if (issues.some(item => !item.preserveValue) && !human) {
      action = rejectActionTiming(action, units, { meetingDate: opts.meetingDate, field: issues.some(item => item.field === 'all') ? 'all' : 'exactDate', reason: issues.map(item => item.code).join(',') });
      decision = action.timingDecision;
    } else if (!human && decision?.status === 'unresolved' && decision.checkerStatus) {
      // A lexical source match cannot overturn a source-bound semantic
      // checker's explicit uncertainty or a missing/invalid check result.
      if (!issues.some(item => item.code === 'timing_source_unresolved')) issues.push({ code: 'timing_check_unresolved', field: 'wording', preserveValue: true, message: `The timing check is ${decision.checkerStatus}; confirm this action's timing before treating it as verified.`, sourceEvidenceIds: decision.sourceEvidenceIds });
      action.timingDecision = decision;
    } else if (!human && (!decision || decision.status !== 'rejected')) {
      const meaning = classifyTimingWording(wording);
      const status = binding.status === 'not_stated' ? 'unverified' : binding.status !== 'supported' ? 'unresolved'
        : meaning.qualified || issues.length || binding.qualifiers.length ? 'qualified' : 'verified';
      decision = { version: TIMING_POLICY_VERSION, ...timingAssessmentKey(action, units, opts.meetingDate), status, rejectedExactDates: decision?.rejectedExactDates || [], rejectedWordings: decision?.rejectedWordings || [], reason: issues.map(item => item.code).join(',') || binding.reason,
        binding: { status: binding.status, reason: binding.reason, matchedSourceIds: binding.matchedSourceIds, conflictingSourceIds: binding.conflictingSourceIds } };
      action.timingDecision = decision;
    }
    return { action: human ? row : action, issues, assessment: decision || null, binding };
  }
  return { TIMING_POLICY_VERSION, isValidCalendarDate, classifyTimingWording, explicitCalendarDate, explicitCalendarDates, resolveExactDate, normaliseTimingValue, formatCalendarDate, formatTimingLabel, timingAssessmentKey, assessmentMatches, rejectActionTiming, assessTimingSourceBinding, assessActionTiming };
}));
