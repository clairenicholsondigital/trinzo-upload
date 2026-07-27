// Process stage: the transcript → project-report flow. Reuses the existing
// buildTranscriptTestPage engine, but the project is fixed by the workspace bar
// (fixedProjectId), so the tool's own project picker is suppressed.
(function () {
  function mount(container, ctx) {
    container.innerHTML = `
      <section class="panel">
        <h1>Process transcript</h1>
        <p class="intro">Upload or paste a project check-in transcript for <strong>${window.ProjectWorkspace.escapeHtml(ctx.project.projectName || 'this project')}</strong>. The draft report uses project memory as background, but evidence must come from this transcript.</p>
      </section>
      <main id="transcriptTestRoot"></main>
    `;
    buildTranscriptTestPage({
      title: 'Project update reporting',
      intro: 'Create a draft update report from the transcript. Review it before approving it as project memory.',
      buttonText: 'Create draft report',
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
