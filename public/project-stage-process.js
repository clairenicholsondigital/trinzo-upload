// Process stage: the transcript → project-report flow. Reuses the existing
// buildTranscriptTestPage engine, but the project is fixed by the workspace bar
// (fixedProjectId), so the tool's own project picker is suppressed.
(function () {
  function mount(container, ctx) {
    container.innerHTML = `
      <section class="panel">
        <h1>Process transcript</h1>
        <p class="intro">Upload or paste a project check-in transcript for <strong>${window.ProjectWorkspace.escapeHtml(ctx.project.projectName || 'this project')}</strong> to extract milestone statuses and create a draft report. The report is saved against this project and appears under Reports and Insights.</p>
      </section>
      <main id="transcriptTestRoot"></main>
    `;
    buildTranscriptTestPage({
      title: 'Project update reporting',
      intro: 'Upload or paste a project check-in transcript to extract milestone statuses and create a draft project report.',
      buttonText: 'Process meeting',
      resetButtonText: 'Clear and restart',
      confirmReset: true,
      loadingMessage: 'Analysing transcript...',
      endpoint: '/api/project-update-test',
      projectReportUi: true,
      fixedProjectId: ctx.projectId,
      summary: projectUpdateSummary
    });
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.process = { mount };
}());
