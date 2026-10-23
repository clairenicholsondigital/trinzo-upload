'use strict';
const O = require('../../utils/canonicalMinutes/discussionOwnParentCoverage');
const copy = value => JSON.parse(JSON.stringify(value));
const childText = 'Nora Patel will replace the inlet this weekend, probably on Saturday morning.';
const parentQuote = childText.slice(0, -1);
const parentText = parentQuote + ', before visitors arrive.';
const sourceUnits = [{ id: 'T0001', speaker: 'Nora Patel', text: parentText }];
const discussion = [{ id: 'topic', topic: 'Equipment', points: [{
  id: 'parent', text: parentText, evidenceIds: ['T0001'], reviewFlagIds: ['parent-warning'],
  mergedFromIds: ['earlier-parent'], supportingDetails: [{
    id: 'child', text: childText, evidenceIds: ['T0001'], reviewFlagIds: [],
    mergedFromIds: ['earlier-child'], supportingDetails: []
  }]
}], decisions: [], openQuestions: [] }];
const wrap = (packet, results) => ({ version: O.VERSION, packetHash: packet.packetHash, results });
const witness = c => [{ sourceId: c.sourceUnits[0].id, quote: c.sourceUnits[0].text }];
function inventory(packet) {
  return wrap(packet, packet.candidates.map(c => ({ id: c.id, decision: 'covered', claims: [{
    id: 'claim', text: c.child.text, childQuote: c.child.text, parentQuote,
    sourceWitnesses: witness(c)
  }] })));
}
function verification(packet, selected) {
  return wrap(packet, selected.map(c => ({ id: c.id,
    claimChecks: c.claims.map(claim => ({ claimId: claim.id, supported: true, retained: true,
      parentQuote, sourceWitnesses: witness(c) })),
    sentenceChecks: c.childSentences.map((_, sentenceIndex) => ({ sentenceIndex, allClaimsListed: true,
      supported: true, retained: true, parentQuote, sourceWitnesses: witness(c) }))
  })));
}
const options = () => ({
  inventory: async (_, packet) => inventory(packet),
  verify: async (_, packet, selected) => verification(packet, selected)
});
module.exports = { O, copy, childText, parentQuote, parentText, sourceUnits, discussion,
  wrap, inventory, verification, options };
