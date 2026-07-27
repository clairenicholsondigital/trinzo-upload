// Reports stage: saved reports for THIS project only. Lifted from the old
// reports list page, now fetching /reports?projectId=<selected> — the old page
// sent no projectId and showed every project's reports at once.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml, sentenceLabel, dateValue } = PW;

  function mount(container, ctx) {
    const projectId = ctx.projectId;
    container.innerHTML = `
      <section class="panel">
        <h1>Reports</h1>
        <p class="intro" id="reportsIntro">Loading saved reports…</p>
      </section>
      <section class="panel">
        <div class="bulk-actions">
          <p id="bulkReportStatus" class="status">Select reports to enable bulk actions.</p>
          <button id="bulkDeleteReportsBtn" class="danger" type="button" disabled>Archive selected</button>
        </div>
        <div id="reportList" class="table-scroll"><table><tbody><tr><td>Loading…</td></tr></tbody></table></div>
      </section>
    `;
    const intro = container.querySelector('#reportsIntro');
    const listNode = container.querySelector('#reportList');

    async function load() {
      try {
        const payload = await PW.request(`reports?projectId=${encodeURIComponent(projectId)}`);
        render(PW.asArray(payload.reports));
      } catch (error) {
        listNode.innerHTML = `<table><tbody><tr><td class="status error">${escapeHtml(error.message || 'Could not load reports.')}</td></tr></tbody></table>`;
      }
    }

    function render(reports) {
      intro.textContent = reports.length
        ? `${reports.length} saved report${reports.length === 1 ? '' : 's'} for this project.`
        : 'No saved reports yet. Process a transcript to create one.';
      listNode.innerHTML = `
        <table>
          <thead><tr><th class="select-cell"><input id="selectAllReports" type="checkbox" aria-label="Select all reports" /></th><th>Report</th><th>Period</th><th>Status</th><th>Overall health</th><th>Updated</th><th>Actions</th></tr></thead>
          <tbody>
            ${reports.map((report) => `
              <tr>
                <td class="select-cell"><input type="checkbox" data-report-select="${escapeHtml(report.reportId)}" data-report-name="${escapeHtml(report.reportName || `Report ${report.reportId}`)}" aria-label="Select ${escapeHtml(report.reportName || `Report ${report.reportId}`)}" /></td>
                <td><a href="/project-update-test/reports/${escapeHtml(report.reportId)}">${escapeHtml(report.reportName || `Report ${report.reportId}`)}</a><div class="muted">${escapeHtml(report.fileName || '')}</div></td>
                <td>${escapeHtml(report.periodLabel || '-')}</td>
                <td>${escapeHtml(sentenceLabel(report.reportStatus))}</td>
                <td>${escapeHtml(sentenceLabel(report.overallHealth))}</td>
                <td>${escapeHtml(dateValue(report.updatedAt || report.createdAt))}</td>
                <td class="actions">
                  <a class="button-link" href="/project-update-test/reports/${escapeHtml(report.reportId)}">Open report</a>
                  <button class="danger" type="button" data-delete-report="${escapeHtml(report.reportId)}" data-report-name="${escapeHtml(report.reportName || `Report ${report.reportId}`)}">Archive</button>
                </td>
              </tr>
            `).join('') || '<tr><td colspan="7">No reports yet.</td></tr>'}
          </tbody>
        </table>
      `;
      wireRowDeletes();
      wireBulkActions();
    }

    function wireRowDeletes() {
      listNode.querySelectorAll('[data-delete-report]').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.getAttribute('data-delete-report');
          const name = button.getAttribute('data-report-name') || `Report ${id}`;
          if (!window.confirm(`Archive ${name}? This keeps its version history but removes it from active reports and project context.`)) return;
          button.disabled = true;
          try {
            await PW.request(`reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
            await load();
            if (ctx.reloadProject) ctx.reloadProject();
          } catch (error) {
            window.alert(error.message || 'Could not archive report.');
            button.disabled = false;
          }
        });
      });
    }

    function wireBulkActions() {
      const bulkStatus = container.querySelector('#bulkReportStatus');
      const bulkButton = container.querySelector('#bulkDeleteReportsBtn');
      const selectAll = container.querySelector('#selectAllReports');
      const checkboxes = Array.from(container.querySelectorAll('[data-report-select]'));
      function selected() {
        return checkboxes.filter((c) => c.checked).map((c) => ({ id: c.getAttribute('data-report-select'), name: c.getAttribute('data-report-name') || 'Report' }));
      }
      function update() {
        const chosen = selected();
        bulkButton.disabled = chosen.length === 0;
        bulkStatus.textContent = chosen.length ? `${chosen.length} report${chosen.length === 1 ? '' : 's'} selected.` : 'Select reports to enable bulk actions.';
        if (selectAll) {
          selectAll.checked = checkboxes.length > 0 && chosen.length === checkboxes.length;
          selectAll.indeterminate = chosen.length > 0 && chosen.length < checkboxes.length;
        }
      }
      if (selectAll) selectAll.addEventListener('change', () => { checkboxes.forEach((c) => { c.checked = selectAll.checked; }); update(); });
      checkboxes.forEach((c) => c.addEventListener('change', update));
      bulkButton.addEventListener('click', async () => {
        const chosen = selected();
        if (!chosen.length) return;
        const preview = chosen.slice(0, 8).map((r) => `• ${r.name}`).join('\n');
        const suffix = chosen.length > 8 ? `\n…and ${chosen.length - 8} more.` : '';
        if (!window.confirm(`Archive ${chosen.length} selected report${chosen.length === 1 ? '' : 's'}? This keeps their version history but removes them from active reports and project context.\n\n${preview}${suffix}`)) return;
        bulkButton.disabled = true;
        try {
          await PW.request('reports/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reportIds: chosen.map((r) => r.id) })
          });
          await load();
          if (ctx.reloadProject) ctx.reloadProject();
        } catch (error) {
          window.alert(error.message || 'Could not archive selected reports.');
          update();
        }
      });
      update();
    }

    load();
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.reports = { mount };
}());
