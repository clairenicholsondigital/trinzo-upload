'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');

const detail = 'Unassigned context <tag> & "quoted" content. ' + 'A full qualification remains available. '.repeat(58) + ' END_FULL_DETAIL';
const draft = {
  details: { meetingTitle: 'Review', internalAttendees: [] },
  discussion: [{ id: 'topic', topic: 'Review', points: [{ id: 'p', text: 'Main minutes text.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }],
  actions: [], sourceUnits: [
    { id: 'T0001', speaker: 'Morgan Lee', text: 'MAIN_SOURCE' },
    { id: 'T0002', speaker: 'Sam Okoro', text: 'UNASSIGNED_SOURCE <safe> & unchanged.' },
    { id: 'T0003', speaker: 'Another', text: 'UNREFERENCED_SOURCE' }
  ],
  unassignedSupportingDetails: [{ id: 'unfiled', text: detail, evidenceIds: ['T0002'], originalTopic: 'ARBITRARY_OLD_TOPIC', placementReason: 'INTERNAL_REASON' }]
};

async function documentXml(input, evidence) {
  const buffer = await generateMeetingMinutesAgentDocx(input, evidence);
  assert.equal(Buffer.isBuffer(buffer), true);
  const zip = await JSZip.loadAsync(buffer);
  return zip.file('word/document.xml').async('string');
}

test('ordinary Word binary excludes unassigned material and its sources', async () => {
  const xml = await documentXml(draft, false);
  assert.match(xml, /Main minutes text/);
  assert.doesNotMatch(xml, /Needs filing|END_FULL_DETAIL|UNASSIGNED_SOURCE|ARBITRARY_OLD_TOPIC|INTERNAL_REASON/);
  const withoutPool = await documentXml({ ...draft, unassignedSupportingDetails: undefined }, false);
  assert.equal(xml, withoutPool, 'unfiled context does not change ordinary publication');
});

test('evidence Word binary retains complete escaped unassigned text and its referenced source', async () => {
  const xml = await documentXml(draft, true);
  assert.match(xml, /Needs filing/);
  assert.match(xml, /END_FULL_DETAIL/);
  assert.match(xml, /Unassigned context &lt;tag&gt; &amp; &quot;quoted&quot; content/);
  assert.match(xml, /Sources: T0002/);
  assert.match(xml, /UNASSIGNED_SOURCE &lt;safe&gt; &amp; unchanged/);
  assert.doesNotMatch(xml, /UNREFERENCED_SOURCE|ARBITRARY_OLD_TOPIC|INTERNAL_REASON/);
  assert.equal(xml.includes(detail.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')), true, 'the complete text is present beyond old warning/detail caps');
  assert.equal(draft.unassignedSupportingDetails[0].text, detail, 'export does not mutate retained text');
});
