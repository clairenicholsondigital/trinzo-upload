'use strict';

// Identity evidence for the two source-promise promotion shortcuts only.
// Do not infer people from generated owners, prose or Settings aliases.
function speakerLabel(value) {
  const raw = String(value || '').normalize('NFKC').toLowerCase().trim()
    .replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  const sides = raw.split(',');
  if (!raw || sides.length > 2 || sides.some(side => !side.trim())) return null;
  const words = part => part.trim().split(/\s+/).filter(Boolean)
    .map(word => word.replace(/\.$/, ''));
  const parts = sides.length === 2 ? [...words(sides[1]), ...words(sides[0])] : words(raw);
  if (!parts.length || parts.some(part => !/^\p{L}[\p{L}\p{M}'-]*$/u.test(part))) return null;
  const base = parts.filter((part, index) => index === 0 || index === parts.length - 1
    || !/^\p{L}$/u.test(part));
  return { key: parts.join(' '), first: parts[0], count: parts.length, base: base.join(' '),
    teamsInitialAlias: sides.length === 2 && base.length !== parts.length };
}

function sourceSpeakerIdentityScope(sourceUnits = []) {
  const full = new Map(), short = new Set();
  for (const unit of Array.isArray(sourceUnits) ? sourceUnits : []) {
    const label = speakerLabel(unit?.speaker);
    if (!label) continue;
    if (label.count === 1) { short.add(label.key); continue; }
    const existing = full.get(label.key);
    full.set(label.key, { ...label, teamsInitialAlias: label.teamsInitialAlias || existing?.teamsInitialAlias });
  }
  const groups = new Map();
  for (const label of full.values()) {
    if (!groups.has(label.base)) groups.set(label.base, []);
    groups.get(label.base).push(label);
  }
  const identities = new Map(), byFirst = new Map();
  for (const [base, labels] of groups) {
    const variants = labels.filter(label => label.key !== base);
    // Teams' "Surname, Given M" may alias "Given Surname" only when the
    // meeting establishes one initial variant and no separate base identity.
    // Full source labels and conflicting initials stay separate; a generated
    // owner cannot create an alias.
    const alias = variants.length === 1 && variants[0].teamsInitialAlias && !full.has(base);
    for (const label of labels) {
      const identity = 'full:' + (alias ? base : label.key);
      identities.set(label.key, identity);
      if (alias) identities.set(base, identity);
      if (!byFirst.has(label.first)) byFirst.set(label.first, new Set());
      byFirst.get(label.first).add(identity);
    }
  }
  return {
    resolve(value) {
      const label = speakerLabel(value);
      if (!label) return null;
      if (label.count > 1) return identities.get(label.key) || null;
      const matching = byFirst.get(label.key);
      if (matching?.size === 1) return [...matching][0];
      if (matching?.size > 1) return null;
      // Retain exact first-name-only source identities, without fabricating a
      // full name when none occurs in the meeting.
      return short.has(label.key) ? 'short:' + label.key : null;
    }
  };
}

module.exports = { sourceSpeakerIdentityScope };
