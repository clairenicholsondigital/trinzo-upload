'use strict';

function truthyFlag(value) {
  if (Array.isArray(value)) return value.some((item) => truthyFlag(item));
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

module.exports = { truthyFlag };
