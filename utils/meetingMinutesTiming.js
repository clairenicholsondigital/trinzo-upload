(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeetingMinutesTiming = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const TIMING_POLICY_VERSION = 1;
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
    const found = dayFirst ? { day: dayFirst[1], month: dayFirst[2], year: dayFirst[3] }
      : monthFirst ? { day: monthFirst[2], month: monthFirst[1], year: monthFirst[3] } : null;
    if (!found) return '';
    let year = found.year ? Number(found.year) : isValidCalendarDate(meetingDate) ? Number(meetingDate.slice(0, 4)) : 0;
    if (!found.year && /\bnext year\b/.test(value) && year) year += 1;
    const month = MONTHS.findIndex(name => name.slice(0, 3) === found.month.slice(0, 3)) + 1;
    return year ? isoDate(year, month, dayNumber(found.day)) : '';
  }
  function classifyTimingWording(wording) {
    const value = canonical(wording).replace(/\bnot later than\b/g, 'by');
    if (!value) return { kind: 'empty', qualified: false };
    const calendarExpression = /\b\d{4}-\d{2}-\d{2}\b/.test(value)
      || new RegExp(`\\b(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_RE})\\s+(?:of\\s+)?${MONTH_RE}\\b`).test(value)
      || new RegExp(`\\b${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`).test(value);
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
    const meaning = classifyTimingWording(value);
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
  function subjectWords(value, owners) {
    const ownerWords = new Set((owners || []).flatMap(owner => canonical(owner).split(' ')));
    return [...new Set((canonical(value).match(/[a-z][a-z'-]{2,}/g) || []).filter(word => !SUBJECT_STOP.has(word) && !ownerWords.has(word)).map(word => word.replace(/(?:ing|ed|es|s)$/, '')))];
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
    ['start', 'begin', 'commence'], ['complete', 'finish', 'finalise', 'finalize']
  ];
  const hasOperation = (value, group) => group.some(verb => new RegExp(`\\b${verb}(?:s|d|ed|ing)?\\b`, 'i').test(value));
  function operationMatches(action, source) {
    const body = canonical(action).replace(/^[^,;.!?]{1,80}\b(?:will|shall|is to)\s+/, '');
    const verbs = [body.split(' ')[0], ...[...body.matchAll(/\b(?:and|then)\s+([a-z-]+)/g)].map(match => match[1])];
    const required = verbs.map(verb => ({ verb, group: OPERATION_GROUPS.find(group => hasOperation(verb, group)) }));
    return required.length > 0 && required.every(({ verb, group }) => group ? hasOperation(source, group)
      : new RegExp(`\\b${verb}(?:s|d|ed|ing)?\\b`, 'i').test(source));
  }
  function roleAndRecipientMatch(row, clause, unit) {
    const value = canonical(clause), ownerWords = (row.owners || []).map(owner => canonical(owner).split(' '));
    const assigned = [...String(clause).matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:will|shall|must|to)\s+(?:review|check|write|draft|send|share|update|prepare|sign|complete|replace|arrange|test)\b/g)];
    if (ownerWords.length && assigned.some(match => !ownerWords.some(parts => canonical(match[1]).split(' ').every(part => parts.includes(part))))) return false;
    const recipients = [...String(row.action || '').matchAll(/\b(to|with|for)\s+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,2})\b/gu)]
      .filter(match => !DAYS.includes(canonical(match[2])) && !MONTHS.includes(canonical(match[2])));
    if (recipients.some(match => !value.includes(`${match[1].toLowerCase()} ${canonical(match[2])}`))) return false;
    if (/\b(?:i['’]ll|i will|i can|i am going to)\b/i.test(clause) && ownerWords.length) {
      const speaker = canonical(unit.speaker).split(' ');
      if (!ownerWords.some(parts => parts.every(part => speaker.includes(part)))) return false;
    }
    return true;
  }
  function dateSourceSupported(row, units, meetingDate, date) {
    const ids = new Set(row.evidenceIds || []), owners = row.owners || [];
    const rows = (units || []).filter(unit => unit.classification !== 'remove' || unit.restored);
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
      const temporalFillers = new Set([...MONTHS, 'probably', 'presumably', 'approximately', 'roughly', 'about', 'around', 'early', 'late', 'ideally', 'hopefully', 'prefer', 'preferably', 'weekend', 'deadline', 'target', 'due', 'being', 'well', 'would', 'could', 'should', 'going', 'just', 'then', 'again', 'still', 'yes', 'yeah', 'okay', 'really', 'fine', 'good', 'great', 'thanks', 'thank', 'everyone']);
      const localSubjects = clause => subjectWords(clause, owners).filter(word => !temporalFillers.has(word)
        && !/^(?:i|we|you|they|it|he|she)(?:'ll|'re|'ve|'m|'d)?$/.test(word));
      return carrying.some(({ clause, at: clauseIndex }) => {
        if (about(clause) && operationMatches(row.action, clause) && roleAndRecipientMatch(row, clause, unit)) return true;
        const shortTiming = !localSubjects(clause).length
          || /\b(?:do|send|fit|replace|finish|complete)\s+(?:it|that|this|one|unit|them)\b|\bby then\b/i.test(clause);
        if (!shortTiming) return false;
        let connectedOperation = operationMatches(row.action, clause) && roleAndRecipientMatch(row, clause, unit);
        // A turn can change subjects before its short date clause. That nearer
        // subject controls; comma-splitting must not detach it and borrow an
        // older task merely because both passages have the same speaker.
        for (let local = clauseIndex - 1; local >= 0; local -= 1) {
          const antecedent = clauses[local];
          if (!localSubjects(antecedent).length) continue;
          if (!about(antecedent) || !roleAndRecipientMatch(row, antecedent, unit)) return false;
          if (operationMatches(row.action, antecedent)) return true;
          break;
        }
        for (let at = index - 1; at >= Math.max(0, index - 8); at -= 1) {
          const previous = rows[at];
          if (/\b(?:now (?:the|on to)|next item|another task)\b/i.test(previous.text)) break;
          if (ids.has(previous.id) && operationMatches(row.action, previous.text) && roleAndRecipientMatch(row, previous.text, previous)) connectedOperation = true;
          if (ids.has(previous.id) && about(previous.text) && connectedOperation && roleAndRecipientMatch(row, previous.text, previous)) return true;
          if (/\b(?:i['’]ll|i will|we['’]ll|we will)\b/i.test(previous.text)
            && !/\b(?:it|that|this|one|unit|those|them)\b/i.test(previous.text)
            && !about(previous.text) && subjectWords(previous.text, owners).length >= 2) break;
        }
        return false;
      });
    });
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
    if (wordingDate && !dateSourceSupported(action, units, opts.meetingDate, wordingDate)) {
      issues.push({ code: 'unsupported_date_wording', field: 'all', message: `The date wording "${wording}" is not supported by source wording bound to this action.` });
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
    } else if (!human && !decision) {
      decision = { version: TIMING_POLICY_VERSION, ...timingAssessmentKey(action, units, opts.meetingDate), status: date && !issues.length ? 'verified' : 'unverified', rejectedExactDates: [], rejectedWordings: [], reason: issues.map(item => item.code).join(',') };
      action.timingDecision = decision;
    }
    return { action: human ? row : action, issues, assessment: decision || null };
  }
  return { TIMING_POLICY_VERSION, isValidCalendarDate, classifyTimingWording, explicitCalendarDate, resolveExactDate, normaliseTimingValue, formatCalendarDate, formatTimingLabel, timingAssessmentKey, assessmentMatches, rejectActionTiming, assessActionTiming };
}));
