'use strict';

const MINIMUM_ACTION_WORDS = 3;

function actionWordCount(value) {
  return (String(value || '').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length;
}

function filterActionsForPresentation(actions, minimumWords = MINIMUM_ACTION_WORDS) {
  const rows = Array.isArray(actions) ? actions : [];
  return rows.filter((row) => actionWordCount(row?.action || row?.meetingActionPoint) >= minimumWords);
}

module.exports = { MINIMUM_ACTION_WORDS, actionWordCount, filterActionsForPresentation };
