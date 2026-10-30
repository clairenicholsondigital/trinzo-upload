'use strict';

function meetingMinutesAgentText(value, maxLength = 600) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

module.exports = { meetingMinutesAgentText, firstString };
