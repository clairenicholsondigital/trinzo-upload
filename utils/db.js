const { execFile } = require('node:child_process');

function hasDatabaseConfig() {
  return Boolean(
    process.env.DATABASE_URL ||
    (process.env.PGHOST && process.env.PGPORT && process.env.PGDATABASE && process.env.PGUSER && process.env.PGPASSWORD)
  );
}

function getDatabaseConfigError() {
  return 'Database configuration missing. Set DATABASE_URL or PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD.';
}

function runPsql(sql) {
  return new Promise((resolve, reject) => {
    if (!hasDatabaseConfig()) {
      reject(new Error(getDatabaseConfigError()));
      return;
    }

    const args = process.env.DATABASE_URL
      ? [process.env.DATABASE_URL, '-At', '-F', '|', '-c', sql]
      : ['-d', process.env.PGDATABASE || 'postgres', '-At', '-F', '|', '-c', sql];

    execFile('psql', args, { env: process.env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

async function testConnection() {
  const out = await runPsql('SELECT NOW()::text');
  return out.split('\n')[0] || null;
}

function q(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function qJson(value) {
  return `'${JSON.stringify(value || {}).replace(/'/g, "''")}'::jsonb`;
}

async function saveUploadedJob({ fileName, mimeType, transcriptText }) {
  const title = fileName || 'Uploaded transcript';
  const description = 'Auto-created from uploaded transcript.';
  const transcript = transcriptText || '';
  const payload = JSON.stringify({ fileName, mimeType, status: 'uploaded' }).replace(/'/g, "''");

  const sql = `
WITH inserted_meeting AS (
  INSERT INTO meetings (meeting_title, meeting_description, source)
  VALUES (${q(title)}, ${q(description)}, 'trinzo-upload')
  RETURNING id, created_at
), inserted_autosave AS (
  INSERT INTO meeting_autosaves (meeting_id, transcript_text, transcript_length, payload)
  SELECT id, ${q(transcript)}, LENGTH(${q(transcript)}), '${payload}'::jsonb
  FROM inserted_meeting
)
SELECT id::text || '|' || created_at::text FROM inserted_meeting;`;

  const out = await runPsql(sql);
  const [meetingId, createdAt] = (out.split('\n')[0] || '').split('|');
  return { meetingId: Number(meetingId), createdAt };
}

async function saveMeetingMinutes(payload) {
  const meetingTitle = payload?.meetingTitle || 'Untitled meeting';
  const meetingDate = payload?.meetingDate || null;
  const meetingLocation = payload?.meetingLocation || '';
  const meetingDescription = payload?.meetingDescription || '';
  const meetingObjectives = Array.isArray(payload?.meetingObjectives) ? payload.meetingObjectives : [];
  const clientAttendees = Array.isArray(payload?.clientAttendees) ? payload.clientAttendees : [];
  const participantsTrinzo = Array.isArray(payload?.participantsTrinzo) ? payload.participantsTrinzo : [];
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const nextSteps = Array.isArray(payload?.nextSteps) ? payload.nextSteps : [];
  const transcriptText = payload?.transcriptText || '';
  const source = payload?.payload?.source || 'front-end-test';

  const objectivesSql = meetingObjectives
    .map((objective) => `INSERT INTO meeting_objectives (meeting_id, objective_text) VALUES (new_meeting_id, ${q(objective)});`)
    .join('\n');

  const clientSql = clientAttendees
    .map((name) => `INSERT INTO meeting_participants (meeting_id, participant_name, participant_group) VALUES (new_meeting_id, ${q(name)}, 'client');`)
    .join('\n');

  const trinzoSql = participantsTrinzo
    .map((name) => `INSERT INTO meeting_participants (meeting_id, participant_name, participant_group) VALUES (new_meeting_id, ${q(name)}, 'trinzo');`)
    .join('\n');

  const itemsSql = items
    .map((item) => `INSERT INTO meeting_minutes_items (meeting_id, topic, discussion_points) VALUES (new_meeting_id, ${q(item?.topic || '')}, ${qJson(item?.discussionPoints || [])});`)
    .join('\n');

  const nextStepsSql = nextSteps
    .map((step) => `INSERT INTO meeting_next_steps (meeting_id, action_text, owner_name, deadline) VALUES (new_meeting_id, ${q(step?.actionText || '')}, ${q(step?.ownerName || '')}, ${step?.deadline ? q(step.deadline) : 'NULL'});`)
    .join('\n');

  const sql = `
BEGIN;
WITH inserted_meeting AS (
  INSERT INTO meetings (meeting_title, meeting_date, meeting_location, meeting_description, source)
  VALUES (${q(meetingTitle)}, ${meetingDate ? q(meetingDate) : 'NULL'}, ${q(meetingLocation)}, ${q(meetingDescription)}, ${q(source)})
  RETURNING id
)
SELECT id INTO TEMP TABLE temp_inserted_meeting FROM inserted_meeting;
DO $$
DECLARE new_meeting_id INT;
BEGIN
  SELECT id INTO new_meeting_id FROM temp_inserted_meeting LIMIT 1;
  ${objectivesSql}
  ${clientSql}
  ${trinzoSql}
  ${itemsSql}
  ${nextStepsSql}
  INSERT INTO meeting_autosaves (meeting_id, transcript_text, transcript_length, payload)
  VALUES (new_meeting_id, ${q(transcriptText)}, LENGTH(${q(transcriptText)}), ${qJson(payload?.payload || {})});
END $$;
SELECT id::text FROM temp_inserted_meeting LIMIT 1;
COMMIT;`;

  const out = await runPsql(sql);
  const meetingId = Number((out.split('\n').find((line) => /^\d+$/.test(line)) || '').trim());
  return { meetingId };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

async function listMeetings() {
  const sql = `
SELECT id::text, meeting_title, COALESCE(meeting_date::text, ''), COALESCE(meeting_location, ''), COALESCE(meeting_description, ''), created_at::text
FROM meetings
ORDER BY created_at DESC;`;
  const out = await runPsql(sql);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, meetingTitle, meetingDate, meetingLocation, meetingDescription, createdAt] = line.split('|');
      return { id: Number(id), meetingTitle, meetingDate, meetingLocation, meetingDescription, createdAt };
    });
}

async function getMeetingById(meetingId) {
  const sql = `
SELECT m.id::text, COALESCE(m.meeting_title, ''), COALESCE(m.meeting_date::text, ''), COALESCE(m.meeting_location, ''), COALESCE(m.meeting_description, ''),
COALESCE((SELECT json_agg(objective_text) FROM meeting_objectives mo WHERE mo.meeting_id = m.id), '[]'::json)::text,
COALESCE((SELECT json_agg(participant_name) FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.participant_group = 'client'), '[]'::json)::text,
COALESCE((SELECT json_agg(participant_name) FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.participant_group = 'trinzo'), '[]'::json)::text,
COALESCE((SELECT json_agg(json_build_object('id', mi.id, 'topic', mi.topic, 'discussionPoints', mi.discussion_points)) FROM meeting_minutes_items mi WHERE mi.meeting_id = m.id), '[]'::json)::text,
COALESCE((SELECT json_agg(json_build_object('id', ns.id, 'actionText', ns.action_text, 'ownerName', ns.owner_name, 'deadline', ns.deadline)) FROM meeting_next_steps ns WHERE ns.meeting_id = m.id), '[]'::json)::text,
COALESCE((SELECT transcript_text FROM meeting_autosaves ma WHERE ma.meeting_id = m.id ORDER BY ma.id DESC LIMIT 1), ''),
m.created_at::text
FROM meetings m
WHERE m.id = ${Number(meetingId)}
LIMIT 1;`;
  const out = await runPsql(sql);
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const [id, meetingTitle, meetingDate, meetingLocation, meetingDescription, meetingObjectives, clientAttendees, participantsTrinzo, items, nextSteps, transcriptText, createdAt] = line.split('|');
  return {
    id: Number(id),
    meetingTitle,
    meetingDate,
    meetingLocation,
    meetingDescription,
    meetingObjectives: parseJsonArray(meetingObjectives),
    clientAttendees: parseJsonArray(clientAttendees),
    participantsTrinzo: parseJsonArray(participantsTrinzo),
    items: parseJsonArray(items),
    nextSteps: parseJsonArray(nextSteps),
    transcriptText,
    createdAt
  };
}

async function deleteMeetingById(meetingId) {
  const sql = `DELETE FROM meetings WHERE id = ${Number(meetingId)} RETURNING id::text;`;
  const out = await runPsql(sql);
  const deleted = out.split('\n').find((line) => /^\d+$/.test(line));
  return Boolean(deleted);
}

async function updateMeetingById(meetingId, payload) {
  await deleteMeetingById(meetingId);
  return saveMeetingMinutes(payload);
}

module.exports = {
  testConnection,
  saveUploadedJob,
  saveMeetingMinutes,
  listMeetings,
  getMeetingById,
  deleteMeetingById,
  updateMeetingById,
  hasDatabaseConfig,
  getDatabaseConfigError
};
