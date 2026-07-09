#!/usr/bin/env node
require('dotenv').config();

const {
  claimNextMeetingMinutesJob,
  ensureMeetingJobQueueSchema
} = require('../utils/db');
const { processMeetingMinutesJob } = require('../utils/meetingMinutesGenerator');

const WORKER_ID = process.env.MEETING_MINUTES_WORKER_ID || `minutes-final-${process.pid}`;
const POLL_MS = Number(process.env.MEETING_MINUTES_WORKER_POLL_MS || 5000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop() {
  await ensureMeetingJobQueueSchema();
  console.log(JSON.stringify({ event: 'meeting_minutes_worker_started', workerId: WORKER_ID, pollMs: POLL_MS }));

  while (true) {
    try {
      const job = await claimNextMeetingMinutesJob(WORKER_ID);
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }

      console.log(JSON.stringify({
        event: 'meeting_minutes_worker_claimed',
        workerId: WORKER_ID,
        jobId: job.jobId,
        meetingId: job.meetingId,
        transcriptLength: job.transcriptLength
      }));

      const result = await processMeetingMinutesJob(job);
      console.log(JSON.stringify({
        event: result.ok ? 'meeting_minutes_worker_completed' : 'meeting_minutes_worker_failed',
        workerId: WORKER_ID,
        jobId: job.jobId,
        meetingId: job.meetingId,
        error: result.ok ? null : result.error?.message || String(result.error)
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: 'meeting_minutes_worker_loop_error',
        workerId: WORKER_ID,
        error: error.message || String(error)
      }));
      await sleep(POLL_MS);
    }
  }
}

runLoop().catch((error) => {
  console.error(JSON.stringify({ event: 'meeting_minutes_worker_fatal', error: error.message || String(error) }));
  process.exit(1);
});
