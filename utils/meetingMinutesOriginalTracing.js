'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');

// Where a suggestion goes between the candidate pool and the review queue.
// MEETING_MINUTES_AGENT_TRACE_PROPOSALS=<text> prints every step for the
// proposals whose wording contains that text.
function traceProposals(step, records = [], draftId = '') {
  const needle = String(process.env.MEETING_MINUTES_AGENT_TRACE_PROPOSALS || '').trim().toLowerCase();
  if (!needle) return;
  const rows = (Array.isArray(records) ? records : []).map((record) => record?.after || record)
    .filter((record) => String(record?.action || '').toLowerCase().includes(needle))
    .map((record) => `${meetingMinutesAgentText(record.action, 120)} | ${JSON.stringify(record.owners || [])} | ${JSON.stringify(record.evidenceIds || [])}`);
  console.info(JSON.stringify({ event: 'meeting_agent_proposal_trace', journeyId: draftId, step, count: rows.length, rows }));
}

function traceOwners(step, actions = [], journeyId = '') {
  actionDiagnostics.checkpoint(step, actions);
  if (!/^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS || ''))) return;
  const list = Array.isArray(actions) ? actions : [];
  const probe = String(process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_PROBE || '').toLowerCase();
  const hit = probe ? list.find((a) => String(a?.action || '').toLowerCase().includes(probe)) : null;
  console.info(JSON.stringify({ event: 'owner_trace', journeyId, step, total: list.length,
    owned: list.filter((a) => (a?.owners || []).length).length,
    probe: probe ? (hit ? { owners: hit.owners || [], evidence: hit.evidenceIds || [] } : 'absent') : undefined }));
  const file = String(process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_FILE || '');
  if (file) {
    try {
      require('fs').appendFileSync(file, `${JSON.stringify({ journeyId, step, actions: list.map((a) => ({
        id: a?.id, action: a?.action, owners: a?.owners || [], evidenceIds: a?.evidenceIds || [], reviewFlagIds: a?.reviewFlagIds || []
      })) })}\n`);
    } catch { /* tracing only */ }
  }
}

module.exports = {
  traceOwners,
  traceProposals,
};
