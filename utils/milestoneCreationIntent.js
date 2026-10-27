'use strict';

const policy = require('../config/milestone_creation_intent.json');
const catalog = require('../config/project_rules.json').milestones;
const normalise = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// This is admission of a NEW tracked record, not matching or progress inference.
// Quotation marks and a generated "creation_intent" flag are not authority.
function hasMilestoneCreationIntent(name, source) {
  const key = normalise(name);
  if (!key) return false;
  const namePattern = key.split(' ').map(escape).join('[\\W_]+');
  const patterns = policy.intentPatterns.map(pattern => new RegExp(pattern.replaceAll('__NAME__', namePattern), 'i'));
  const rejection = new RegExp(policy.rejectionPattern, 'i');
  const clauses = String(source || '').split(/[.!?;\n]+/).map(text => text.trim()).filter(Boolean);
  const aliases = Object.entries(catalog).find(([label]) => normalise(label) === key)?.[1] || [];
  return clauses.some((clause, index) => {
    if (rejection.test(clause)) return false;
    if (patterns.some(pattern => pattern.test(clause))) return true;
    if (new RegExp('\\b' + namePattern + '\\b', 'i').test(clause)
        && index > 0 && new RegExp(policy.precedingIntentPattern, 'i').test(clauses[index - 1])) return true;
    // Retain the application's existing configured programme vocabulary. Require
    // its source alias; model labels alone cannot manufacture a catalog match.
    const catalogKey = value => normalise(value).replace(/\b([a-z]{4,})s\b/g, '$1');
    const text = ' ' + catalogKey(clause) + ' ';
    return aliases.some(alias => text.includes(' ' + catalogKey(alias) + ' '));
  });
}

module.exports = { hasMilestoneCreationIntent };
