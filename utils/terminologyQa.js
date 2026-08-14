'use strict';

const crypto = require('node:crypto');

const GLOBAL_TERMS = [
  { canonical: 'CAPA', aliases: ['kappa', 'capper', 'capa'] },
  { canonical: 'MDR', aliases: [] },
  { canonical: 'QMS', aliases: [] },
  { canonical: 'CER', aliases: [] },
  { canonical: 'DHF', aliases: [] },
  { canonical: 'UDI', aliases: [] },
  { canonical: 'EUDAMED', aliases: ['eudamed', 'udamed', 'udimed'] },
  { canonical: 'HPRA', aliases: [] },
  { canonical: 'FMEA', aliases: [] },
  { canonical: 'PMS', aliases: [] },
  { canonical: 'SBOM', aliases: [] },
  { canonical: 'MDSAP', aliases: ['medsap'] }
];

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function key(value) { return clean(value).toLowerCase(); }

function editDistance(left, right) {
  const a = key(left); const b = key(right);
  const row = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const held = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = held;
    }
  }
  return row[b.length];
}

function generatedFields(stage, content) {
  if (stage === 'summary') return [
    ...(content.objectives || []).map((text, index) => ({ path: `summary.objectives.${index}`, text })),
    { path: 'summary.executiveSummary', text: content.executiveSummary },
    ...(content.overallTopics || []).map((text, index) => ({ path: `summary.overallTopics.${index}`, text }))
  ];
  if (stage === 'discussion') return (content || []).flatMap((card, index) => [
    { path: `discussion.${index}.topic`, text: card.topic },
    ...(card.points || []).map((text, pointIndex) => ({ path: `discussion.${index}.points.${pointIndex}`, text }))
  ]);
  if (stage === 'actions') return (content || []).flatMap((action, index) => [
    { path: `actions.${index}.owner`, text: action.owner, entityType: 'attendee' },
    { path: `actions.${index}.action`, text: action.action },
    { path: `actions.${index}.deadline`, text: action.deadline }
  ]);
  return [];
}

function suggestion(field, original, replacement, reason, confidence, scope) {
  const signature = `${field.path}|${key(original)}|${key(replacement)}`;
  return {
    id: crypto.createHash('sha256').update(signature).digest('hex').slice(0, 16),
    fieldPath: field.path, original, replacement, reason, confidence,
    scopeType: scope.type, scopeKey: scope.key
  };
}

function termSuggestions(field, terms, learned, scope) {
  const text = clean(field.text); if (!text) return [];
  const tokens = text.match(/\b[A-Za-z][A-Za-z0-9-]{2,15}\b/g) || [];
  const candidates = [];
  for (const mapping of learned) {
    const original = clean(mapping.originalText);
    if (original && key(original) !== key(mapping.suggestedText) && text.toLowerCase().includes(original.toLowerCase())) {
      const matched = text.match(new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0] || original;
      candidates.push(suggestion(field, matched, mapping.suggestedText, 'Previously accepted correction', 0.995, scope));
    }
  }
  for (const token of tokens) {
    const tokenKey = key(token);
    for (const term of terms) {
      if (tokenKey === key(term.canonical)) {
        if (token !== term.canonical) candidates.push(suggestion(field, token, term.canonical, 'Recognised terminology capitalisation', 0.99, scope));
        continue;
      }
      const alias = (term.aliases || []).some((value) => key(value) === tokenKey);
      const fuzzy = !alias && /^[A-Z][A-Za-z0-9-]{2,7}$/.test(token)
        && Math.abs(token.length - term.canonical.length) <= 1
        && editDistance(token, term.canonical) === 1;
      if (alias || fuzzy) candidates.push(suggestion(field, token, term.canonical, alias ? 'Known terminology variant' : 'Close terminology match', alias ? 0.99 : 0.9, scope));
    }
  }
  return candidates;
}

function attendeeSuggestion(field, attendees, scope) {
  const original = clean(field.text);
  if (!original || /^(?:not stated|all)$/i.test(original) || attendees.some((name) => key(name) === key(original))) return null;
  const ranked = attendees.map((name) => ({ name, distance: editDistance(original, name) }))
    .sort((left, right) => left.distance - right.distance);
  if (!ranked.length || ranked[0].distance > Math.max(1, Math.floor(original.length * 0.2))) return null;
  if (ranked[1] && ranked[1].distance === ranked[0].distance) return null;
  return suggestion(field, original, ranked[0].name, 'Close match to a confirmed attendee', 0.94, scope);
}

function reviewGeneratedContent({ stage, content, attendees = [], controlledTerms = [], learned = [], rejected = [], scope = {} }) {
  const resolvedScope = { type: scope.type || 'project', key: clean(scope.key) || 'unscoped' };
  const terms = [...GLOBAL_TERMS, ...controlledTerms.map((item) => typeof item === 'string' ? { canonical: item, aliases: [] } : item)]
    .filter((item) => clean(item.canonical));
  const rejectedKeys = new Set(rejected.map((item) => `${key(item.originalText)}|${key(item.suggestedText)}`));
  const found = [];
  for (const field of generatedFields(stage, content)) {
    found.push(...termSuggestions(field, terms, learned, resolvedScope));
    if (field.entityType === 'attendee') {
      const entity = attendeeSuggestion(field, attendees.map(clean).filter(Boolean), resolvedScope);
      if (entity) found.push(entity);
    }
  }
  const unique = new Map();
  for (const item of found) {
    if (rejectedKeys.has(`${key(item.original)}|${key(item.replacement)}`)) continue;
    const signature = `${item.fieldPath}|${key(item.original)}|${key(item.replacement)}`;
    const current = unique.get(signature);
    if (!current || item.confidence > current.confidence) unique.set(signature, item);
  }
  return [...unique.values()].sort((left, right) => right.confidence - left.confidence);
}

module.exports = { GLOBAL_TERMS, editDistance, reviewGeneratedContent };
