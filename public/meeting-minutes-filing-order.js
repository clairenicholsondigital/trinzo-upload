(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeetingMinutesFilingOrder = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A display/export projection only. Backing indices, reviewer slots and
  // stable ties are shared by the browser and both evidence exports.
  function orderedEntries(pool, sourceUnits) {
    var order = new Map();
    (sourceUnits || []).forEach(function (unit, index) {
      if (unit && unit.id && !order.has(unit.id)) {
        var sequence = Number(unit.sequence);
        order.set(unit.id, Number.isFinite(sequence) && sequence > 0 ? sequence : index + 1);
      }
    });
    var entries = pool.map(function (detail, index) {
      var positions = (detail.evidenceIds || []).filter(function (id) { return order.has(id); })
        .map(function (id) { return order.get(id); });
      return { detail:detail, index:index, position:positions.length ? Math.min.apply(null, positions) : Infinity };
    });
    var locked = function (entry) {
      var detail = entry.detail;
      return detail.reviewerAuthored === true || detail.confirmedTopic === true
        || /_human_confirmation$/.test(String(detail.source || ''))
        || /^(manual-|reviewer-)/.test(String(detail.id || ''));
    };
    var generated = entries.filter(function (entry) { return !locked(entry); }).sort(function (a, b) {
      return a.position === b.position ? a.index - b.index : a.position - b.position;
    });
    var next = 0;
    return entries.map(function (entry) { return locked(entry) ? entry : generated[next++]; });
  }

  // Exact text only; every occurrence keeps its own identity and controls.
  function groupedEntries(pool, sourceUnits) {
    var groups = [], byText = new Map();
    orderedEntries(pool, sourceUnits).forEach(function (entry) {
      var detail = entry.detail;
      var locked = detail.reviewerAuthored === true || detail.confirmedTopic === true
        || /_human_confirmation$/.test(String(detail.source || ''))
        || /^(manual-|reviewer-)/.test(String(detail.id || ''));
      var group = !locked && byText.get(detail.text);
      if (!group) {
        group = { text: detail.text, entries: [] }; groups.push(group);
        if (!locked) byText.set(detail.text, group);
      }
      group.entries.push(entry);
    });
    return groups;
  }

  // Compare the complete public inputs rather than a collision-prone hash.
  function suggestionBasis(draft) {
    return JSON.stringify([draft.discussion || [], draft.unassignedSupportingDetails || [], draft.sourceUnits || []]);
  }

  return { orderedEntries: orderedEntries, groupedEntries: groupedEntries, suggestionBasis: suggestionBasis };
}));
