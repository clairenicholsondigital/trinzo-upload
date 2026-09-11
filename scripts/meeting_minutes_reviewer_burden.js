'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CATEGORIES = new Set([
  'valid_core_content', 'valid_supporting_context',
  'avoidable_visible_excess', 'unsupported'
]);

function itemId(transcriptId, kind, record = {}) {
  const stable = String(record.id || '').trim();
  if (stable) return `${transcriptId}:${kind}:${stable}`;
  const fingerprint = crypto.createHash('sha256')
    .update(`${kind}|${record.text || ''}|${(record.evidenceIds || []).join('|')}`)
    .digest('hex').slice(0, 16);
  return `${transcriptId}:${kind}:${fingerprint}`;
}

function visibleRecords(result = {}) {
  const discussion = result.discussion || result.visible?.discussion || [];
  return discussion.flatMap((topic) => [
    ...(topic.points || []).map((record) => ({ kind: 'point', topic: topic.topic, record })),
    ...(topic.decisions || []).map((record) => ({ kind: 'decision', topic: topic.topic, record })),
    ...(topic.openQuestions || []).map((record) => ({ kind: 'open_question', topic: topic.topic, record }))
  ]);
}

function evaluationItems(result = {}) {
  const transcriptId = result.id || 'unknown';
  const visible = visibleRecords(result).map((item) => ({
    id: itemId(transcriptId, item.kind, item.record), transcriptId,
    visibility: 'visible', kind: item.kind, topic: item.topic || 'Discussion',
    text: item.record?.text || '', evidenceIds: item.record?.evidenceIds || []
  }));
  const supporting = visibleRecords(result).flatMap((item) => (item.record?.supportingDetails || []).map((record) => ({
    id: itemId(transcriptId, 'supporting', record), transcriptId,
    visibility: 'supporting', kind: 'supporting', topic: item.topic || 'Discussion',
    text: record?.text || '', evidenceIds: record?.evidenceIds || []
  })));
  return [...visible, ...supporting];
}

function loadResults(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

function scoreReviewerBurden(results, fixture = {}) {
  const labels = new Map((fixture.adjudications || []).map((item) => [item.id, item.category]));
  const items = results.flatMap(evaluationItems).map((item) => ({ ...item, category: labels.get(item.id) || '' }));
  const invalidLabels = [...labels.entries()].filter(([, category]) => !CATEGORIES.has(category));
  const visible = items.filter((item) => item.visibility === 'visible');
  const supporting = items.filter((item) => item.visibility === 'supporting');
  const avoidable = visible.filter((item) => ['avoidable_visible_excess', 'unsupported'].includes(item.category));
  return {
    transcriptCount: results.length,
    visibleCount: visible.length,
    supportingCount: supporting.length,
    classifiedVisibleCount: visible.filter((item) => item.category).length,
    unclassifiedVisible: visible.filter((item) => !item.category),
    avoidableVisibleCount: avoidable.length,
    unsupportedVisibleCount: visible.filter((item) => item.category === 'unsupported').length,
    supportingMisclassifiedAsCore: visible.filter((item) => item.category === 'valid_supporting_context').length,
    recoverableSupportingCount: supporting.filter((item) => item.evidenceIds.length).length,
    invalidLabels
  };
}

if (require.main === module) {
  const directory = path.resolve(process.argv[2] || '');
  if (!directory || !fs.existsSync(directory)) throw new Error('Pass a benchmark output directory.');
  const fixturePath = path.resolve(process.argv[3] || path.join(__dirname, '../tests/fixtures/meeting_minutes_agent_reviewer_burden_v1.json'));
  const results = loadResults(directory);
  if (process.argv.includes('--write-template')) {
    const existing = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
    const known = new Map((existing.adjudications || []).map((item) => [item.id, item]));
    for (const item of results.flatMap(evaluationItems)) if (!known.has(item.id)) known.set(item.id, {
      id: item.id, transcriptId: item.transcriptId, visibility: item.visibility,
      category: '', topic: item.topic, text: item.text, evidenceIds: item.evidenceIds
    });
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      version: 1,
      note: 'Human adjudications for reviewer burden only. This file is test data and is never loaded by runtime processing.',
      categories: [...CATEGORIES],
      adjudications: [...known.values()]
    }, null, 2)}\n`);
  }
  const fixture = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
  const report = scoreReviewerBurden(results, fixture);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.invalidLabels.length) process.exitCode = 2;
}

module.exports = { CATEGORIES, itemId, visibleRecords, evaluationItems, scoreReviewerBurden };
