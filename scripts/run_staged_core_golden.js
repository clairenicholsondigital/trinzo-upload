'use strict';

const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');
const api = require('../routes/api').stagedEvaluation;

async function main() {
  const root = path.resolve(__dirname, 'meeting-minutes-core-golden/cases');
  const caseNames = (await fs.readdir(root)).filter((name) => /^\d\d_/.test(name)).sort();
  const outputs = [];
  const outputDirectory = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (outputDirectory) await fs.mkdir(outputDirectory, { recursive: true });
  for (const caseName of caseNames) {
    const transcriptPath = path.join(root, caseName, 'transcript.docx');
    const { value } = await mammoth.extractRawText({ path: transcriptPath });
    const sequence = await api.runStagedSequenceForEvaluation(value, { fileName: `${caseName}.docx` });
    const visible = sequence.visibleOutput;
    const normalised = {
      attendees: [...(visible.participants?.trinzo || []), ...(visible.participants?.client || [])],
      client_attendees: visible.participants?.client || [],
      actions: (visible.actions || []).map((item) => ({
        owner: item.meetingActionPointOwner,
        action: item.meetingActionPoint,
        deadline: item.meetingActionPointDeadline
      })),
      decisions: visible.decisions || [],
      risks: visible.risks || []
    };
    outputs.push({ caseName, normalised, reviewExperience: api.stagedNoEditReviewExperience(sequence.trace) });
    if (outputDirectory) await fs.writeFile(path.join(outputDirectory, `${caseName}.json`), `${JSON.stringify(normalised, null, 2)}\n`);
    process.stderr.write(`${caseName}: ${normalised.actions.length} actions, ${normalised.decisions.length} decisions, ${normalised.risks.length} risks\n`);
  }
  if (!outputDirectory) process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
