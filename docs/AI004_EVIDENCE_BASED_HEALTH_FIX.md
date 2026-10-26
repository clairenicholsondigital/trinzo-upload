# AI-004: evidence-based headline health

This bounded correction applies to newly generated project updates. It does not rewrite saved reports, human corrections, approved history or the meeting-minutes agent.

## Behaviour

- Empty or wholly unknown assessments use the existing **Not yet assessed** state and explain that current evidence is insufficient.
- Explicit adverse assessments cannot fall through to an unsupported Green default. Red and multiple-blocker escalation remain; an explicit Amber, delay or awaiting-input assessment requires attention. Canonical report statuses and extraction statuses are both counted.
- Supported positive assessments and explicit meeting-level health signals remain usable. The existing 20 golden cases retain their expected statuses without changing fixtures. Completing an inferred item does not establish completion of the project.
- The executive explanation is constructed after the final transcript-health calculation. Its colour, warning subjects and scope therefore agree with the generated health result.
- Coverage states how many configured milestones were assessed in this meeting, or how many mentioned workstreams were assessed when no configured set exists. Carried-forward historical assessments do not count as fresh evidence. There is no percentage threshold and no requirement to mention every milestone.
- The calculated health statement is not sent through the optional prose rewriter. This removes the opportunity for a rewrite to reverse the assessment or remove the coverage limitation. Key updates and supporting evidence remain available; manual reviewer edits continue to save normally.

No new model, service, schema migration or historical-data repair is required. AI-003's approval boundary remains intact.

## Validation

- Focused health tests cover empty/unknown input, adverse and positive states, completion scope, canonical statuses, sparse configured coverage, carried history, final-status changes and optional rewrite safety.
- Existing project context, knowledge, generation and status-resolution Python tests remain regression checks.
- The unchanged synthetic and representative project-update golden cases run with MiniLM disabled. These behavioural fixtures do not establish real-user success or validate semantic model accuracy.
- Disposable PostgreSQL/browser checks generate Unknown, Amber and Red reports, save them, display them in the actual report editor, save and reload them, and retain manual qualifications and original versions. The Unknown case also uses a mobile viewport.
- Existing approval-history tests, actual keyword/pgvector retrieval, report editing, milestone binding, minutes handoff and task privacy checks are included.

Production verification uses offline synthetic generation against the deployed files and authenticated read-only UI/API checks. No production report is generated, rewritten, approved or deleted as part of verification. Existing reports may retain their old wording until deliberately regenerated or edited by a reviewer.
