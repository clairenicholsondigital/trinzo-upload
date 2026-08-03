const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  saveProjectUpdateDraft,
  getProjectContext,
  hasDatabaseConfig,
  getDatabaseConfigError,
  updateGenerationJobProgress,
  markGenerationJobCompleted,
  markGenerationJobFailure
} = require('./db');
const { runProjectKnowledgeRetrieval } = require('./knowledge');
const {
  runPythonTranscriptScript,
  transcriptMetadata,
  validateTranscriptText
} = require('./meetingMinutesGenerator');

function truthy(value) {
  if (Array.isArray(value)) return value.some((item) => truthy(item));
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function buildProjectKnowledgeQuery(transcriptText, projectContext = {}) {
  const milestoneNames = Array.isArray(projectContext.activeMilestones)
    ? projectContext.activeMilestones.map((item) => item && (item.milestoneName || item.comparisonKey)).filter(Boolean).slice(0, 12)
    : [];
  return [String(transcriptText || '').slice(0, 2000), ...milestoneNames].join('\n');
}

function buildQueuedProjectUpdateResponse(job, result) {
  const transcriptText = String(job.transcriptText || '');
  const input = job.inputPayload || {};
  const response = {
    ok: true,
    source: input.source || 'project-update-test-queue',
    fileName: input.fileName || null,
    transcriptLength: transcriptText.length,
    meetingId: job.meetingId,
    jobId: job.jobId,
    result
  };
  if (input.includeTranscriptMetadata) {
    response.transcriptMetadata = transcriptMetadata(transcriptText);
  }
  return response;
}

async function buildProjectUpdateResultFromTranscript(transcript, options = {}) {
  const startedAt = Date.now();
  let scriptUsed = 'project_update_minilm.py';
  let fallbackUsed = false;
  let contextFound = false;
  let resolvedProjectId = null;
  let saveOk = false;
  let retrievedKnowledge = { retrievalMode: 'none', chunks: [] };
  let statusClassifierDiagnostics = { enabled: true, available: false, items: [], reason: 'Not run yet.' };
  let contextTempDir = null;

  validateTranscriptText(transcript.text);

  const scriptArgs = [];
  const projectName = options.projectName || process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test';
  const projectId = Number(options.projectId || 0) || null;
  const skipStatusDiagnostics = truthy(options.skipStatusDiagnostics);

  if (truthy(options.skipMiniLM)) scriptArgs.push('--skip-minilm');
  if (truthy(options.skipRewrite)) scriptArgs.push('--skip-rewrite');

  try {
    const projectRef = projectId ? { projectId, projectName } : { projectName };
    if (hasDatabaseConfig() && !truthy(options.skipContext)) {
      try {
        const projectContext = await getProjectContext(projectRef, options.contextLimit || 8);
        contextFound = Boolean(projectContext?.found);
        resolvedProjectId = projectContext?.projectId || projectContext?.projectResolution?.projectId || projectId || null;
        if (!truthy(options.skipKnowledge) && resolvedProjectId) {
          try {
            const retrieval = await runProjectKnowledgeRetrieval({
              projectId: resolvedProjectId,
              query: buildProjectKnowledgeQuery(transcript.text, projectContext),
              topK: Number(options.knowledgeTopK || 8),
              itemTypes: ['background_doc', 'decision', 'report_summary', 'risk']
            });
            retrievedKnowledge = {
              retrievalMode: retrieval.retrieval_mode || retrieval.retrievalMode || 'none',
              chunks: Array.isArray(retrieval.chunks) ? retrieval.chunks : [],
              diagnostics: retrieval.diagnostics || {},
              error: retrieval.error || ''
            };
          } catch (knowledgeError) {
            retrievedKnowledge = { retrievalMode: 'error', chunks: [], error: knowledgeError.message };
          }
          projectContext.retrievedKnowledge = retrievedKnowledge;
        } else if (truthy(options.skipKnowledge)) {
          retrievedKnowledge = { retrievalMode: 'skipped', chunks: [] };
          projectContext.retrievedKnowledge = retrievedKnowledge;
        }
        contextTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-project-context-'));
        const contextPath = path.join(contextTempDir, 'context.json');
        await fs.writeFile(contextPath, JSON.stringify({ context: projectContext }), 'utf8');
        scriptArgs.push('--context-file', contextPath);
      } catch (contextError) {
        contextTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-project-context-'));
        const contextPath = path.join(contextTempDir, 'context-error.json');
        retrievedKnowledge = { retrievalMode: 'error', chunks: [], error: contextError.message };
        await fs.writeFile(contextPath, JSON.stringify({ _contextLoadError: contextError.message, retrievedKnowledge }), 'utf8');
        scriptArgs.push('--context-file', contextPath);
      }
    }

    if (skipStatusDiagnostics) {
      statusClassifierDiagnostics = {
        enabled: false,
        available: false,
        items: [],
        reason: 'skipStatusDiagnostics requested.'
      };
    } else {
      try {
        statusClassifierDiagnostics = await runPythonTranscriptScript(
          'project_status_evidence_pack.py',
          transcript.text,
          ['--max-chunks', String(Math.min(Math.max(Number(options.statusDiagnosticsMaxChunks || 24), 1), 80))],
          { timeoutMs: Number(process.env.PROJECT_STATUS_DIAGNOSTICS_TIMEOUT_MS || 45000) }
        );
      } catch (statusError) {
        statusClassifierDiagnostics = {
          enabled: true,
          available: false,
          items: [],
          reason: `Project status diagnostics failed open: ${statusError.message}`
        };
      }
    }

    const projectTimeoutMs = Number(process.env.PROJECT_UPDATE_TIMEOUT_MS || 180000);
    let result;
    try {
      result = await runPythonTranscriptScript('project_update_minilm.py', transcript.text, scriptArgs, { timeoutMs: projectTimeoutMs });
    } catch (primaryError) {
      console.error('[project-update-queue] primary script failed, using legacy fallback', primaryError.message || String(primaryError));
      scriptUsed = 'python_llm.py';
      fallbackUsed = true;
      const fallback = await runPythonTranscriptScript('python_llm.py', transcript.text, [], { timeoutMs: projectTimeoutMs });
      result = {
        ...fallback,
        mode: 'project_update_legacy_fallback',
        projectWorkflowFallback: {
          script: 'python_llm.py',
          reason: primaryError.message
        }
      };
    }

    if (hasDatabaseConfig() && !truthy(options.skipSave)) {
      try {
        result.projectReportPersistence = await saveProjectUpdateDraft({
          projectId,
          projectName,
          periodLabel: options.periodLabel || '',
          fileName: transcript.fileName || null,
          sourceType: transcript.source === 'file' ? 'txt' : 'text',
          transcriptText: transcript.text,
          result
        });
        saveOk = Boolean(result.projectReportPersistence?.saved);
        resolvedProjectId = result.projectReportPersistence?.projectId || resolvedProjectId;
      } catch (saveError) {
        result.projectReportPersistence = {
          saved: false,
          error: saveError.message
        };
      }
    } else {
      result.projectReportPersistence = {
        saved: false,
        reason: hasDatabaseConfig() ? 'skipSave requested' : getDatabaseConfigError()
      };
    }

    result.statusClassifierDiagnostics = {
      ...statusClassifierDiagnostics,
      decisionUse: 'diagnostics_only'
    };
    if (result?.projectReport && typeof result.projectReport === 'object') {
      result.projectReport.retrievedKnowledge = result.projectReport.retrievedKnowledge || {
        retrievalMode: retrievedKnowledge.retrievalMode || 'none',
        chunkCount: Array.isArray(retrievedKnowledge.chunks) ? retrievedKnowledge.chunks.length : 0
      };
      result.projectReport.projectResolution = result.projectReport.projectResolution || {
        requestedProjectId: projectId,
        projectId: resolvedProjectId,
        projectName,
        contextFound
      };
      result.projectReport.statusClassifierDiagnostics = {
        enabled: statusClassifierDiagnostics.enabled !== false,
        available: Boolean(statusClassifierDiagnostics.available),
        decisionUse: 'diagnostics_only',
        chunksAnalysed: Number(statusClassifierDiagnostics.chunksAnalysed || 0),
        itemCount: Array.isArray(statusClassifierDiagnostics.items) ? statusClassifierDiagnostics.items.length : 0,
        topItems: Array.isArray(statusClassifierDiagnostics.items) ? statusClassifierDiagnostics.items.slice(0, 5) : [],
        reason: statusClassifierDiagnostics.reason || ''
      };
    }

    result.queuedDiagnostics = {
      mode: 'project_update_generate',
      scriptUsed,
      fallbackUsed,
      saveOk,
      projectId: resolvedProjectId || projectId || null,
      projectName,
      retrievalMode: retrievedKnowledge.retrievalMode || 'none',
      retrievedKnowledgeChunks: Array.isArray(retrievedKnowledge.chunks) ? retrievedKnowledge.chunks.length : 0,
      statusDiagnosticsAvailable: Boolean(statusClassifierDiagnostics.available),
      statusDiagnosticsItems: Array.isArray(statusClassifierDiagnostics.items) ? statusClassifierDiagnostics.items.length : 0,
      durationMs: Date.now() - startedAt,
      transcriptSha256: crypto.createHash('sha256').update(transcript.text, 'utf8').digest('hex').slice(0, 16)
    };

    return result;
  } finally {
    if (contextTempDir) {
      await fs.rm(contextTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function processProjectUpdateJob(job, options = {}) {
  try {
    if (job.cancelRequested) {
      throw new Error('Job was cancelled before processing started.');
    }

    const input = job.inputPayload || {};
    await updateGenerationJobProgress(job.jobId, 'context', 12, 'Loading project context and transcript.');
    const transcript = {
      text: job.transcriptText || '',
      source: input.source || 'project-update-test-queue',
      fileName: input.fileName || null
    };
    validateTranscriptText(transcript.text);

    await updateGenerationJobProgress(job.jobId, 'analysing', 30, 'Analysing update evidence against project context.');
    const result = await buildProjectUpdateResultFromTranscript(transcript, {
      ...input,
      timeoutMs: options.timeoutMs
    });

    await updateGenerationJobProgress(job.jobId, 'saving', 88, 'Saving draft project update report.');
    const response = buildQueuedProjectUpdateResponse(job, result);
    await markGenerationJobCompleted(job.jobId, job.meetingId, response, 'Project update report is ready for review.');
    return { ok: true, response };
  } catch (error) {
    await markGenerationJobFailure(job, error.message || 'Project update generation failed.', 'Project update generation');
    return { ok: false, error };
  }
}

module.exports = {
  buildProjectUpdateResultFromTranscript,
  buildQueuedProjectUpdateResponse,
  processProjectUpdateJob
};
