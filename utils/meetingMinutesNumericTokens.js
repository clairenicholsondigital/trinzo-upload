'use strict';

// Shared tokenization only. Existing semantic reconciliation retains its own
// normalization and policy; automatic edit preservation normalizes locally.
const NUMBERED_IDENTIFIER = /\b[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*\b/gi;
function numberedIdentifiers(value) {
  return (String(value || '').match(NUMBERED_IDENTIFIER) || []).filter(token => /\d/.test(token));
}
function quantityTokens(value) {
  // An artifact/version identifier remains one exact protected token. Its
  // numeric fragments are not independent interchangeable measurements.
  const text = String(value || '').replace(NUMBERED_IDENTIFIER, token => /\d/.test(token) ? ' ' : token)
    // A digit-to-digit range separator is not a unary sign or exponent sign.
    .replace(/(?<=\d)[−-](?=[+−-]?(?:\d|\.\d))/gu, ' ');
  // Keep signs, leading decimals and exponents whole; never fall back to a
  // decimal/coefficient prefix or strip the sign to find a smaller token.
  return text.match(/[£€$]\s*[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+−-]?\d+)?(?!\p{N}|\.\d|e[+−-]?\d)|(?<![\p{L}\p{N}_.+−-])[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+−-]?\d+)?(?!\p{N}|\.\d|e[+−-]?\d)(?=\b|(?:[yzafpnumcdhkmgtpezyµμ]?(?:mol|hz|pa|m|g|s|a|k|n|j|w|c|v|l))\b)|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand)\b/gu) || [];
}
function unitTokens(value) {
  // Conventional prose initialisms are not isolated unit letters. Preserve
  // every other dotted sequence: an unfamiliar unit product may still contain
  // recognized components which must not disappear from the safety check.
  const text = String(value || '').normalize('NFKC')
    .replace(/(?<![\p{L}\p{N}.])(?:e\.g\.|i\.e\.|a\.k\.a\.)(?![\p{L}\p{N}.])/giu, ' ');
  return text.match(/[£€$%‰]|(?<![\p{L}'’])(?:[yzafpnumcdhkMGTPEZYµμ]?(?:mol|Hz|Pa|m|g|s|A|K|N|J|W|C|V|L|l))(?![\p{L}'’])/gu) || [];
}

module.exports = { numberedIdentifiers, quantityTokens, unitTokens };
