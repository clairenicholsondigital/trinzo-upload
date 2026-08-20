'use strict';

const { clean } = require('./evidence');

function trimProspectiveTaskClause(value) {
  return clean(value)
    .replace(/\s*,?\s+and then if\b.*$/i, '')
    .replace(/\s*,?\s+if that\b.*$/i, '')
    .replace(/\s+(?:in that\s+)?so that\b.*$/i, '')
    .replace(/\breally\s*,\s*really\s+/gi, '')
    .replace(/^[,;:\s]+|[,;:\s.?!]+$/g, '');
}

function prospectiveLanguageShape(event) {
  const text = clean(event.text);
  const patterns = [
    {
      re: /\bwhat we (?:want|intend|plan) to do is\s+(.+)/i,
      speechAct: 'collective_plan',
      action: (match) => trimProspectiveTaskClause(match[1])
    },
    {
      re: /\bwe(?:['’]re| are) going to\s+(.+)/i,
      speechAct: 'collective_plan_reaffirmation',
      action: (match) => trimProspectiveTaskClause(match[1])
    },
    {
      re: /\b(?:the next step|the plan|the intention) is(?: to)?\s+(.+)/i,
      speechAct: 'collective_plan',
      action: (match) => trimProspectiveTaskClause(match[1])
    },
    {
      re: /\bwe need a way to(?: be able to)?\s+(.+)/i,
      speechAct: 'required_unassigned_work',
      action: (match) => trimProspectiveTaskClause(match[1])
    },
    {
      re: /\b(?:something|work)\s+(?:that\s+)?(?:would\s+)?needs? to be defined(?:\s+as\s+[^,]+)?\s+is\s+(.+)/i,
      speechAct: 'required_unassigned_work',
      action: (match) => {
        const requirement = trimProspectiveTaskClause(match[1])
          .replace(/^exactly how we (?:set|define|establish)\s+/i, '')
          .replace(/^how (?:we|the team) (?:set|define|establish)\s+/i, '');
        return requirement ? `Define ${requirement}` : '';
      }
    },
    {
      re: /\b(.{3,100}?)\s+needs? to be\s+(defined|reviewed|tested|prepared|completed|updated|confirmed|documented|resolved|submitted|provided|scheduled|finalised|finalized)\b/i,
      speechAct: 'required_unassigned_work',
      action: (match) => {
        let subject = clean(match[1]).replace(/^(?:so|and|but|the|a|an)\s+/i, '');
        const existentialSubject = subject.match(/\bthere(?:['’]s| is)(?:\s+a bit of)?[.\s]*([^,;]+)$/i)?.[1];
        if (existentialSubject) subject = clean(existentialSubject).replace(/\s+that$/i, '');
        if (/^(?:it|that|this|something|anything|everything)$/i.test(subject)) return '';
        if (/^(?:upstream|downstream|further|additional|other)?\s*(?:work|stuff|things?)$/i.test(subject)) return '';
        const verbs = {
          defined: 'Define', reviewed: 'Review', tested: 'Test', prepared: 'Prepare',
          completed: 'Complete', updated: 'Update', confirmed: 'Confirm', documented: 'Document',
          resolved: 'Resolve', submitted: 'Submit', provided: 'Provide', scheduled: 'Schedule',
          finalised: 'Finalise', finalized: 'Finalize'
        };
        return `${verbs[match[2].toLowerCase()]} ${subject}`;
      }
    }
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (!match) continue;
    const action = clean(pattern.action(match));
    if (action) return { owner: 'Not stated', action, speechAct: pattern.speechAct };
  }
  return null;
}

function pronominalTask(value) {
  return /^(?:do|handle|take|test|review|send|share|update|complete|prepare|provide|check|resolve|progress|develop|define)\s+(?:it|that|this|them)\b/i.test(clean(value));
}

module.exports = { prospectiveLanguageShape, pronominalTask, trimProspectiveTaskClause };
