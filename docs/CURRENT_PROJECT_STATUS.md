# Trinzo AI platform — current project status

## 1. Executive summary

The platform turns meeting transcripts into editable, evidence-linked minutes and uses saved minutes, project milestones and background information to prepare project updates. Substantial functionality is implemented and deployed. The next step is a split approach: **start a controlled meeting-minutes pilot; fix four demonstrated project-update safety defects before piloting the combined reporting workflow.**

| Tool / scope | Readiness verdict | Verified P0 critical blockers | Verified P1 pilot blockers | Key caveats |
| --- | --- | ---: | ---: | --- |
| Meeting minutes agent (`/meeting-minutes-agent`) | **READY WITH CAVEATS** | 0 | 0 | Human review remains essential; duplication and variable review workload remain. A fresh complete production journey was not performed during the assessment. |
| Project update tool (`/project-update-test`) | **NOT YET READY** | 4 | 0 | Ordinary editing can lose information; milestone evidence can be misassigned; unapproved assessments influence later reports; health summaries can be misleading. |
| Combined minutes-to-project-report workflow | **NOT YET READY** | 4, all in project updates | 0 | This does not prevent the separate minutes pilot. Technical implementation is further advanced than independent real-user validation. |

**Outstanding register:** 15 tasks: **4 P0, 0 P1, 8 P2 and 3 P3**. Six tasks require external input or participation. These are identified below; no owner, delivery date or commitment has been invented. Optional development is not a condition for beginning the minutes pilot.

This document consolidates the two completed read-only readiness assessments in the project conversation and their supporting evidence. It does not commission another technical investigation, replace their conclusions, or authorise implementation. **Pause non-essential AI-led refinement and obtain real-user feedback.**

## 2. Snapshot date and Git commit reference

- **Snapshot date:** 26 October 2026, UTC.
- **Application baseline inspected, also remote `main` at consolidation:** [`95baf972c17f65e8145404fdc5a0666ab1cb86f9`](https://github.com/clairenicholsondigital/trinzo-upload/commit/95baf972c17f65e8145404fdc5a0666ab1cb86f9), merge of PR #157.
- **Deployment:** the live checkout and its deployment revision marker both identified this application baseline during the assessments. This documentation PR does not change deployment.
- **Assessment sources:** the immediately preceding conversation reports titled “Trinzo project update tool: minimum viable usability review” and “Trinzo meeting minutes agent: minimum viable usability review”. Their conclusions, counts, reproductions and verification limits are preserved in sections 4, 5 and 8.
- **Scope:** the two tools, their owned Library/save/export flows and necessary shared services. Other application areas are not assessed here.
- **Authority:** this Markdown snapshot is the central status reference until deliberately updated. Older plans remain historical evidence rather than competing readiness decisions. Stable task IDs must not be renumbered or reused.

## 3. Overall platform status

The intended outcome is less manual preparation of meeting records and project reporting, with colleagues retaining control over what is saved and relied upon.

The platform currently provides:

1. Authenticated access to a meeting-minutes editor and Library.
2. Background transcript processing and structured, editable minutes with evidence links.
3. A project workspace with project selection/creation, milestones, monitored risks, background memory, reports, Overview/insights, Ask and settings.
4. A handoff from saved meeting minutes into queued project-update generation.
5. Saved report versions, corrections, approval, history and project-context retrieval.

**Maturity:** minutes are a functional internal-pilot candidate with remaining output-quality limitations. Project updates are an implemented workflow with verified safety defects, not a missing product requiring a rebuild. Routine independent internal use has not yet been demonstrated for either tool through an observed first-time-user trial.

There is no defensible percentage-complete figure. A working route, a passing fixture, a merged PR and a successful human workflow are different kinds of evidence.

## 4. Meeting minutes agent: capabilities and readiness

### Current capabilities

The user uploads a Word transcript (`.docx`, maximum 5 MB), then works through **Details → Discussion → Actions → Summary → Review**. The editor supports meeting metadata and attendees, topic-based content, decisions, action wording/owners/timing, summary editing, transcript passages, checks, autosave and final saving. Library retrieval and Word/PDF export are available.

Review separates checks on current minutes from optional additions and processing/coverage notices. Optional retained entries are outside the main minutes until deliberately included. Revision checks, undo/redo and save-state warnings support correction and recovery. “Save final minutes” marks the record Complete; it is not independent factual certification or a separate organisational approval process.

### Readiness conclusion retained

**READY WITH CAVEATS. No verified P0/P1 blocker was identified.** Further speculative optimisation is not required before limited internal testing. Colleagues must read the minutes, check overlapping actions and treat verification as assistance rather than a guarantee.

### Actual review workload

The assessment retrieved the current five Library drafts and measured their presentation using the deployed interface code in an isolated browser. These are existing saved outputs, **not new generations under PR #157**. Discussion counts include the points, decisions and open questions in each draft, excluding optional retained entries.

| Current draft | Discussion entries | Actions | Primary item groups / individual checks | Optional checks | Coverage notices | Optional retained entries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Abbott, draft 479 | 16 | 10 | 17 / 28 | 11 | 35 | 57 |
| DITA, draft 480 | 16 | 11 | 13 / 17 | 10 | 13 | 25 |
| Allotment, draft 478 | 14 | 9 | 16 / 28 | 4 | 8 | 26 |
| Eakin, draft 483 | 21 | 11 | 15 / 21 | 2 | 14 | 12 |
| Parking, draft 482 | 7 | 0 | 2 / 2 | 0 | 1 | 8 |
| **Total** | **74** | **41** | **63 / 96** | **27** | **71** | **128** |

There are **194 open checks**, not 194 confirmed errors or mandatory individual approvals. Related questions share an item presentation without losing independent decisions. Final saving does not require clearing every check. Unclear standard references, timing qualifications and attribution can need judgement; no complete ground-truth adjudication established how many flags represent genuine ambiguity.

Eakin still has two visibly overlapping “Compile…” actions and two “Follow up with Colm…” actions. Normal editing allows correction. Similar wording alone does not prove every pair is safely mergeable. No missing owners were observed in the 41 current action rows, but that does not certify every assignment as correct.

A separate saved fresh-generation cohort had **95 primary groups, 141 primary checks and 238 open checks** across the five transcripts. It is a different cohort, not a controlled before/after comparison proving that the latest releases reduced burden. Review volume varies. **No realistic human review-time measurement exists; no time-saving or meeting-length comparison is claimed.**

## 5. Project update tool: capabilities and readiness

### Current capabilities

The project-first workspace supports creating/selecting projects, setting milestones and monitored risks, storing background knowledge, processing meetings, opening saved reports, editing, approval, history, Overview/insights and Ask.

The current Process journey opens the Meeting Minutes Agent first. Saved minutes are handed to `/api/project-update-test/from-minutes`; reviewed actions travel separately, preserving their wording and timing. Project background is supplied to report generation. This handoff also means minutes review is part of the reporting workload.

### Readiness conclusion retained

**NOT YET READY: four verified P0 blockers; no P1 blocker recorded.** The interface is navigable, but the save and reporting-trust failures below require correction before an independent reporting pilot. An open PR description is not evidence of a deployed fix.

<a id="pu-1"></a>
### PU-1 — ordinary editing loses existing information (AI-001)

- **Step:** correcting and saving a generated report.
- **Evidence:** on live report 42, changing only the executive summary produced an autosave payload that blanked **12 of 23 action deadlines**, including “Target: on Wednesday” and dependency wording. Milestone evidence/provenance fields also disappeared. The request was intercepted and aborted: the server record was not changed. [Editor construction](../views/project-update-reports.html#L400) and [save serialisation](../views/project-update-reports.html#L780).
- **Impact:** ordinary review can unintentionally remove meaningful timing and traceability.
- **Smallest correction:** preserve textual timing and untouched record fields when saving; verify a round trip. Original estimate: **½–1 engineering day** including checks.
- **Existing PR:** none identified; PR #67 does not address this defect.

<a id="pu-2"></a>
### PU-2 — evidence/status can attach to another milestone (AI-002)

- **Step:** persisting a generated report and reading milestone history/Overview.
- **Evidence:** the live Marketing milestone was labelled On Track with unrelated Olympus/Medtronic material; report 41 also contained client-localisation material under Marketing. An isolated execution of the current matching helper reproduced selecting an unrelated segment by row position. [Persistence helper](../utils/db.js#L2956) and [assessment write](../utils/db.js#L3080).
- **Impact:** plausible assessments are supported by the wrong evidence; editing the visible report alone does not reliably repair structured history.
- **Smallest correction:** remove positional substitution, leave unmatched milestones unassessed and correct the affected saved assessments. Original estimate: **½–1 engineering day**.
- **Existing PR:** none identified.

<a id="pu-3"></a>
### PU-3 — approval does not isolate the authoritative baseline (AI-003)

- **Step:** using previous reports and assessments in later project updates.
- **Evidence:** the database contained **zero approved reports**, yet report 42 used previous status/risk information from draft report 41. Context queries admit non-archived drafts; the latest milestone-assessment lookup also lacks an archive filter. [Context construction](../utils/db.js#L1091).
- **Impact:** unchecked output can influence later reporting before approval, contrary to the interface's explanation. Draft visibility itself is not the defect; using unchecked assessments as the authoritative carry-forward is.
- **Smallest correction:** bind authoritative carry-forward to approved versions, including reviewed corrections, and exclude archived/unapproved assessments from that baseline. Original estimate: **approximately 1 engineering day**.
- **Existing PR:** none identified; PR #67 improves attribution, not this boundary.

<a id="pu-4"></a>
### PU-4 — headline health can be materially misleading (AI-004)

- **Step:** reading/reviewing the generated health assessment and executive summary.
- **Evidence:** report 42 says “most milestones are on track or complete” while its final health is Amber and its content records serious delivery problems. The current health-summary function returns Green for zero assessed segments; this was reproduced directly. Later report assembly can change the health colour without updating that explanation. [Summary logic](../scripts/python_llm.py#L1099), [report assembly](../scripts/project_update_minilm.py#L1652).
- **Impact:** a reviewer can accept an unsupported positive headline.
- **Smallest correction:** make insufficient coverage explicit and keep the explanation consistent with the final assessment. Original estimate: **½ engineering day**.
- **Existing PR:** none identified.

### Review burden and limits

Report 42 contains **19 milestones, 8 risks and 23 actions**: 50 substantive rows, plus five health areas and the summary. These are content to inspect, not 50 mandatory approval clicks. Some risk suggestions are low-value, including an objective about assessing risks and an issue described as already fixed.

The original assessment suggested a provisional **30–60 minutes** for that report's review, excluding minutes preparation. **This was an unmeasured planning estimate, not a pilot result or demonstrated review-time requirement.** No complete new production generation–correction–approval–next-report cycle was performed. The two assessments therefore agree on the lack of reliable human timing evidence.

## 6. Shared functionality and architecture

- **Access:** authenticated pages and APIs use persisted sessions. Self-registration is disabled; existing accounts must be provided/confirmed. Authentication is implemented, not proof of fine-grained project privacy or a separate approver role for every operation.
- **Processing:** the minutes workflow uses the existing Microsoft AI/Power Automate integration and, where configured, existing Trooper.ai extraction/preprocessing. It is not a Microsoft-only pipeline. Background jobs allow returning through Library.
- **Reporting:** project generation uses the existing Python/MiniLM analyser, project-context queries and knowledge retrieval, with a legacy analyser fallback. Passing evaluation with MiniLM disabled does not validate production semantic matching.
- **Storage:** PostgreSQL stores drafts, revisions, reports, versions and structured project assessments. Project knowledge uses the existing embedding/retrieval infrastructure. Persistence exists; the project-report editing and approval defects above qualify its safety.
- **Safety:** source/timing/ownership checks, bounded retries, failure diagnostics and recovery preserve uncertain material instead of treating model agreement as sufficient deletion authority.
- **Handoff:** saved minutes, revision checks, selected project identity and reviewed actions connect the two tools. Project-update defects must not be confused with the separate minutes save/export implementation.

## 7. Significant recent improvements

These are grouped achievements, not a claim that every remaining output issue is fixed. “Tested” refers to the recorded checks, not independent first-time-user success.

| Area | What changed and why it matters | Implementation / validation status | References |
| --- | --- | --- | --- |
| Minutes generation and structure | Topic-based editable stages, discussion/action separation and bounded organisation/preservation fixes make the record more usable while retaining qualifications. | Implemented; focused regression and saved-output checks exist. Remaining repetition/placement is not closed. | PRs [#117](https://github.com/clairenicholsondigital/trinzo-upload/pull/117), [#121](https://github.com/clairenicholsondigital/trinzo-upload/pull/121), [#138](https://github.com/clairenicholsondigital/trinzo-upload/pull/138); [review workflow](meeting-minutes-review-workflow.md) |
| Minutes actions and deduplication | Bounded contact/compilation consolidation and atomic target checks constrain merges to proved work, preserving owners, timing, warnings and recovery. | Deployed with targeted tests; real saved examples still contain overlapping actions. | PRs [#144](https://github.com/clairenicholsondigital/trinzo-upload/pull/144), [#145](https://github.com/clairenicholsondigital/trinzo-upload/pull/145), [#150](https://github.com/clairenicholsondigital/trinzo-upload/pull/150) |
| Minutes source/status safeguards | Stronger full-name witnesses, exact self-retention checks, explicit final-exchange status and required-word preservation limit unsafe consolidation. They do not independently remove every completed action. | Deployed and tested with synthetic controls/saved replays; latest guards have not been verified by a new full production user journey. | PRs [#147](https://github.com/clairenicholsondigital/trinzo-upload/pull/147), [#148](https://github.com/clairenicholsondigital/trinzo-upload/pull/148), [#153](https://github.com/clairenicholsondigital/trinzo-upload/pull/153), [#154](https://github.com/clairenicholsondigital/trinzo-upload/pull/154), [#157](https://github.com/clairenicholsondigital/trinzo-upload/pull/157) |
| Minutes review and completion | Related checks are grouped; optional retained material and coverage notices are separate; exact shared optional source passages can be quoted once. Independent decisions, final saving and restoration remain available. | Deployed; browser/persistence checks pass. Grouping is a presentation gain, not elimination of all checks or a formal approval system. | PRs [#145](https://github.com/clairenicholsondigital/trinzo-upload/pull/145), [#146](https://github.com/clairenicholsondigital/trinzo-upload/pull/146), [#149](https://github.com/clairenicholsondigital/trinzo-upload/pull/149), [#156](https://github.com/clairenicholsondigital/trinzo-upload/pull/156) |
| Minutes reliability and Library | Save/freshness handling, resumable Library navigation, visible failures, full-response deadlines and typed Microsoft route errors reduce hidden failure and accidental loss. Raw malformed replies remain available in private diagnostics. | Deployed; scoped audit and current focused tests. No promise of error-free external services. | Commit [`e7ea44e3`](https://github.com/clairenicholsondigital/trinzo-upload/commit/e7ea44e3); PRs [#151](https://github.com/clairenicholsondigital/trinzo-upload/pull/151), [#152](https://github.com/clairenicholsondigital/trinzo-upload/pull/152) |
| Project configuration and insights | Project-first navigation, milestones, monitored risks, memory, report editing/history and Overview/Ask are implemented; absent milestone setup is labelled as a generic agenda. | Navigation verified live; existing tests/docs cover behaviour. Four safety defects prevent readiness. | PRs [#35](https://github.com/clairenicholsondigital/trinzo-upload/pull/35), [#92](https://github.com/clairenicholsondigital/trinzo-upload/pull/92); [pilot checklist](project-update-internal-pilot.md) |
| Meeting-based project reporting | The Process stage uses the central minutes agent; handoff flushes saved edits, checks revisions/project identity and preserves reviewed actions and qualified timing. | PR #54 merged/deployed; focused route, worker/persistence and browser-fixture tests pass. Not a successful live approval-cycle validation. | PR [#54](https://github.com/clairenicholsondigital/trinzo-upload/pull/54), commits [`5da9189b`](https://github.com/clairenicholsondigital/trinzo-upload/commit/5da9189b), [`0dad0a4b`](https://github.com/clairenicholsondigital/trinzo-upload/commit/0dad0a4b) |
| Shared access and testing | Persisted authentication/deep links, revision-guarded minutes persistence, background workers and designed regression/evaluation packs support repeatable checking. | Implemented; focused assessment tests are green. No current whole-platform test pass or colleague login validation is claimed. | Commits [`b76c277d`](https://github.com/clairenicholsondigital/trinzo-upload/commit/b76c277d), [`0c9a1dcb`](https://github.com/clairenicholsondigital/trinzo-upload/commit/0c9a1dcb); section 8 |

**Not yet delivered:** PR [#67](https://github.com/clairenicholsondigital/trinzo-upload/pull/67) proposes accurate approver attribution, project-filtered minutes, duplicate submission/report prevention and visible analyser fallback. It remains open and is not counted as a completed achievement or a fix for AI-001–AI-004.

## 8. Testing and verification evidence

| Evidence | Result / provenance | What it does not establish |
| --- | --- | --- |
| Minutes-focused assessment run | **115 passed, no failures/skips.** Existing browser/state, Library, review-workflow, shared optional-source, retained-review, export-ordering and literal-word tests. Includes fixtures and handler tests with stubbed persistence. | A fresh production upload/generation/save journey; measured human usability. |
| Minutes live inspection | Start page, authenticated draft retrieval, Eakin editor and live Word/PDF export. Files contained readable minutes; Word retained all actions and dependency wording. Draft 483 stayed at revision 89 with identical content. | All export layouts for every transcript, or new generation under the latest code. |
| Five current minutes | Counts in section 4 obtained from current Library payloads displayed with current code in isolated browsers. | A controlled release-to-release improvement in generation quality. |
| Previously saved fresh five | Existing isolated outputs exercise generation, including existing AI services; reviewed read-only during assessment. More checks than current Library cohort. | A new run during either readiness assessment, or the effect of PRs #146–#157 on future outputs. |
| Project-focused assessment run | **29 passed, no failures/skips.** Handoff, pipeline, minutes conversion, project link and agenda browser tests. | A complete live persisted project-report approval cycle. |
| Project golden evaluation | **20/20 passed**, `--mode all --skip-minilm`, offline model downloads disabled. Designed synthetic/realistic fixtures; quality expectations may be advisory. | Real-client accuracy, production semantic matching or absence of the four reproduced defects. |
| Project live inspection | Seven workspace areas and report detail opened without JavaScript errors. Report 42 editing failure reproduced with autosave aborted before reaching server; database reads were write-prohibited. | Successful production saving/approval; independent first-time-user completion. |
| Older project knowledge-loop smoke | Existing documentation records a July 2026 temporary production smoke for indexing, retrieval and approved-report ingestion, subsequently cleaned up. | Current end-to-end readiness after later workflow changes. |
| Independent real-user validation | **No observed successful first-time-user end-to-end trial recorded in these assessments.** There is saved failed-pilot evidence (report 40), not a successful current sign-off. | Routine usability, reliable review time or general user acceptance. |

Assessment logs available on the VPS: `/tmp/trinzo-minutes-pilot-tests.log`, `/tmp/trinzo-minutes-pilot-current-counts.json`, `/tmp/trinzo-minutes-pilot-counts.json`, `/tmp/trinzo-pilot-node-tests.log`, `/tmp/trinzo-pilot-golden.log`. These temporary files are reproducibility aids, **not permanent or portable evidence storage**; the material results are preserved here. Private transcripts, credentials and raw provider responses are not copied into this document.

No full technical investigation or new test run was commissioned by this consolidation. The recorded checks belong to the two preceding assessments.

## 9. Combined readiness assessment

The verdicts are compatible: a usable minutes editor can feed a project-report tool that still has independent safety defects. **The combined platform is NOT YET READY for the full reporting pilot; the separate minutes pilot is READY WITH CAVEATS.**

Technical capabilities are extensive, but real-world usability is not independently validated. Green focused tests do not erase demonstrated defects; remaining improvement possibilities do not automatically block a pilot.

**Documentation discrepancy:** [project-update-internal-pilot.md](project-update-internal-pilot.md) says “ready for a real-data pilot”, and [project-update-robustness-todo.md](project-update-robustness-todo.md) contains July readiness/baseline claims. The October assessment found concrete failures, so its NOT YET READY verdict supersedes those historical readiness statements. Their workflow/checklists remain useful. The July [Conor status log](meeting-minutes-conor-status-log.md) describes `/meeting-minutes-final`; it is not a current description of `/meeting-minutes-agent`.

No later fix evidence was found during consolidation that changes either assessment conclusion. Open research and PR proposals are not treated as deployed remedies.

## 10. Outstanding task register

### Register rules

The two tables below form **one canonical register joined by Task ID**, not separate backlogs. Every task has a title, expected outcome, area, priority, status, category, evidence, PR/issue reference, owner, dependencies, next action and external-input flag.

- Areas: `Meeting minutes`, `Project updates`, `Shared`.
- Priorities: P0 = critical blocker; P1 = verified pilot blocker; P2 = improvement or pilot activity; P3 = optional refinement/research. A P2 validation task is not automatically a pre-pilot code blocker.
- Statuses: `To do`, `In progress`, `Blocked`, `Done`, `Awaiting input`. An open PR marked In progress means work exists; it does not certify active work today or readiness to merge.
- Categories: `Technical`, `Usability`, `Validation`, `Decision`, `External dependency`, `Research`.
- Groups: **A** required before the affected pilot; **B** pilot and feedback; **C** deferred development. The tool-specific gates in section 11 take precedence.
- `Unassigned` means no confirmed task owner. Suggested participants are not assignments. No deadlines are set.
- External input = a colleague's participation, data confirmation or explicit product decision is needed; it does not imply a commitment has been made.
- No open GitHub issues were returned at consolidation. Existing PRs are linked rather than duplicated as new implementation requests.

### Delivery fields

| Task ID | Title and expected outcome | Area | Priority | Status | Category | Group |
| --- | --- | --- | --- | --- | --- | --- |
| AI-001 | **Preserve report data during editing.** Summary-only edits retain action timing, milestone evidence and untouched metadata. | Project updates | P0 | To do | Technical | A |
| AI-002 | **Stop cross-milestone evidence assignment.** Assessments use their own matched evidence; unmatched rows remain unassessed; affected saved data is corrected. | Project updates | P0 | To do | Technical | A |
| AI-003 | **Bind authoritative project history to approval.** Later reports use the reviewed approved version, excluding unapproved/archived assessments from the authoritative baseline. | Project updates | P0 | To do | Technical | A |
| AI-004 | **Make headline health evidence-based.** Insufficient coverage is explicit and the summary agrees with the final health assessment. | Project updates | P0 | To do | Technical | A |
| AI-005 | **Confirm pilot access and reviewers.** Intended users can sign in and named participants agree to take part. Existing access may already satisfy this. | Shared | P2 | Awaiting input | External dependency | A |
| AI-006 | **Confirm representative pilot inputs.** Choose an internal transcript/project and validate the existing milestones, standing risks and background; do not assume data must be created from scratch. | Shared | P2 | Awaiting input | External dependency | A |
| AI-007 | **Complete the first independent minutes journey.** A colleague uploads, reviews, corrects, saves, reopens and exports real minutes; record completion, corrections, confusion and actual review time. | Meeting minutes | P2 | To do | Validation | B |
| AI-008 | **Validate the corrected project-report cycle.** Verify information-preserving edits, approval and a subsequent update using the corrected baseline, then trial with a colleague. | Project updates | P2 | Blocked | Validation | B |
| AI-009 | **Decide whether routine internal use is justified.** Use observed pilot results to agree what can be used routinely and any remaining limits. | Shared | P2 | Awaiting input | Decision | B |
| AI-010 | **Resolve existing project-flow PR #67.** Review the existing attribution/filtering/duplicate/fallback work without treating it as the four P0 fixes. | Project updates | P2 | In progress | Technical | C |
| AI-011 | **Address recurring minutes repetition when justified by pilot evidence.** Correct demonstrated overlapping actions or discussion repetition without losing distinct work or qualifications. | Meeting minutes | P2 | To do | Technical | C |
| AI-012 | **Evaluate review burden and terminology using pilot feedback.** Establish whether checks/retained material and their explanations obstruct routine review; change only demonstrated friction. | Meeting minutes | P2 | To do | Usability | C |
| AI-013 | **Resolve the separately scoped admin-settings PR #61.** Review held people-list/glossary administration if prioritised; do not make it a pilot dependency without evidence. | Shared | P3 | In progress | Technical | C |
| AI-014 | **Keep semantic cleanup experiments held.** PRs #132/#155 have no automatic-cleanup authority; reconsider only if later prioritised and qualification succeeds. | Meeting minutes | P3 | Blocked | Research | C |
| AI-015 | **Obtain separate approval before implementing an internal Tasks tab.** Any future task list belongs exclusively to the internal AI project; Markdown remains authoritative until then. | Project updates | P3 | Awaiting input | Decision | C |
| AI-016 | **Run an AI-011 repetition-focused colleague pilot.** A colleague completes the independent minutes journey and records which repeated rows cost review effort, caused confusion or created correction risk. | Meeting minutes | P2 | To do | Validation | B |

### Evidence, ownership and next actions

| Task ID | Evidence / source | Existing PR / issue | Known owner | Dependencies | Smallest practical next action | External input |
| --- | --- | --- | --- | --- | --- | --- |
| AI-001 | [PU-1](#pu-1); intercepted report-42 autosave | None identified | Unassigned | None known | Correct non-lossy field serialisation and verify summary-only edit/save/reload. | No |
| AI-002 | [PU-2](#pu-2); live Overview and isolated matching reproduction | None identified | Unassigned | None known | Remove positional evidence fallback and identify the affected saved assessments. | No |
| AI-003 | [PU-3](#pu-3); draft 41 feeding report 42 | None identified | Unassigned | None known | Test approved-version context selection and propagation of reviewed corrections. | No |
| AI-004 | [PU-4](#pu-4); zero-assessment reproduction and report-42 contradiction | None identified | Unassigned | None known | Add the bounded insufficient-coverage and final-summary consistency correction. | No |
| AI-005 | Both assessments; self-registration disabled | None | Unassigned | None known | Confirm existing access and who will review; Advait/Saki are suggested, not committed owners. | Yes |
| AI-006 | Existing project pilot checklist; current project 19 already contains 19 milestones | None | Unassigned | None known | Agree one suitable internal transcript and confirm the chosen project's baseline is representative. | Yes |
| AI-007 | Minutes assessment: fresh live full journey unverified; no measured review time | None | Unassigned | AI-005, AI-006 | Ask one participating colleague to follow the walkthrough and record observed results. | Yes |
| AI-008 | Project assessment: four P0 defects and no successful live approval cycle | None | Unassigned | AI-001, AI-002, AI-003, AI-004, AI-005, AI-006 | After the fixes, exercise one full cycle plus a follow-on report; expand only if needed. | Yes |
| AI-009 | Neither assessment proves routine first-time-user usability | None | Unassigned | AI-007, AI-008 for combined use; AI-007 alone for a minutes-only decision | Agree the next usage boundary from observed results, separately for each tool. | Yes |
| AI-010 | Existing open project-flow work; section 7 | [#67](https://github.com/clairenicholsondigital/trinzo-upload/pull/67) | Unassigned | No pilot-gating dependency established | Review/test the existing PR if scheduled; do not duplicate its changes. | No |
| AI-011 | Eakin's two overlapping action pairs; variable output repetition | Related safeguards already deployed; research #132/#155 remains separate | Unassigned | AI-016; AI-007 feedback before expanding scope | Use AI-016 evidence to prioritise only demonstrated repetitions, then implement the narrowest source-aware rule. | No |
| AI-012 | Section 4: 63 primary groups, 128 optional retained entries; no timing study | Existing grouping fixes are completed, not new tasks | Unassigned | AI-007 | Measure actual review effort and unclear terminology before proposing more controls. | No |
| AI-013 | Existing open admin-settings work, not a readiness finding | [#61](https://github.com/clairenicholsondigital/trinzo-upload/pull/61) | Unassigned | No pilot-gating dependency established | Keep scope isolated; review the existing change only if separately prioritised. | No |
| AI-014 | Failed semantic qualification and contradictory retention judgements; source binding alone does not prove meaning | Draft [#132](https://github.com/clairenicholsondigital/trinzo-upload/pull/132), [#155](https://github.com/clairenicholsondigital/trinzo-upload/pull/155) | Unassigned | Qualification failures; no decision to resume as a pilot requirement | Leave held. No additional architecture or research phase is commissioned here. | No |
| AI-015 | Current documentation request's explicit future-import boundary | None | Unassigned | Separate implementation approval; retain these IDs | Await that approval; do not create application tasks, schema, navigation or permissions. | Yes |
| AI-016 | AI-011 qualification and Eakin pilot records; colleague evidence still missing | None | Unassigned | AI-005, AI-006 | Ask one participating colleague to upload, review, correct, save, reopen and export a representative minutes draft, recording repetition corrections and review time. | Yes |

**Counts:** P0 **4**; P1 **0**; P2 **9**; P3 **3**. Statuses: To do **8**, In progress **2**, Blocked **2**, Awaiting input **4**, Done **0**. External-input tasks: **AI-005, AI-006, AI-007, AI-008, AI-009, AI-015, AI-016 — seven**. The future Tasks-tab decision is not a pilot dependency. Completed work is summarised in section 7, not duplicated as outstanding tasks.

## 11. Internal pilot requirements

### A. Required before the affected internal pilot

- **Minutes-only pilot:** no verified P0/P1 code work is required. Confirm ordinary prerequisites AI-005/AI-006 where not already satisfied. Do not turn an unverified access/data concern into an invented blocker.
- **Project-update/combined pilot:** close AI-001–AI-004 and verify their saved-data effects before expecting independent reporting use. Original assessment effort was **approximately 2–4 engineering days including focused validation**, not a deadline or commitment. Confirm AI-005/AI-006.
- PR #67, admin settings, phone polish, semantic research and a Tasks tab are not established pre-pilot requirements.

### B. Internal pilot and feedback

- Start AI-007 now with one willing colleague and a representative internal meeting. For the AI-011 repetition question, record the narrower evidence requested by **AI-016** in the same journey rather than treating general pilot completion as proof of a deduplication benefit.
- Once the project blockers are corrected, run AI-008: correct/save/reopen/approve a report, then create a follow-on update and inspect its baseline.
- Record actual completion, manual corrections, review time, duplicate work, unclear instructions and any need for developer help. Do not invent pass percentages or assume reduced card counts prove usability.
- The older project checklist proposes 3–5 transcripts for broader learning. Begin with one full cycle; it is not necessary to require five new runs before learning from a person.
- Make the tool-specific routine-use decision in AI-009 from that evidence.

### C. Deferred development

AI-010–AI-015 remain separate from the pilot gate. Do not make them prerequisites without a demonstrated new P0/P1 defect. A possible improvement is not evidence that coding must continue.

## 12. External dependencies and decisions

| Dependency / decision | Confirmed fact | Input requiring agreement | Register |
| --- | --- | --- | --- |
| Accounts and reviewers | Access is authenticated; self-registration is disabled. Advait/Saki have been suggested as initial users. | Confirm their access and willingness, or nominate another colleague. No reviewer commitment/owner is recorded. | AI-005 |
| Representative input and baseline | Real saved drafts/reports exist; the AI Team Development project currently has 19 milestones. | Choose suitable internal input and confirm the relevant milestones, standing risks and background. This is confirmation, not a claim that all data is missing. | AI-006 |
| Human feedback | No measured first-time-user review-time result was established. | Participants must supply their observed corrections, effort and points of confusion. | AI-007, AI-008 |
| Routine-use expectations | Both tools are intended for internal colleagues; perfection is not the standard. | Trinzo must agree the permitted usage boundary from pilot results. | AI-009 |
| Future task-list implementation | The requested future location is exclusively the existing internal AI project in `/project-update-test` (currently project 19, AI Team Development). | Separate implementation approval is still required. Do not hard-code this as a general feature for every project. | AI-015 |
| Existing processing services | Microsoft/Power Automate, the configured extraction services and existing workers are operational dependencies. No current outage or missing integration credential was established. | No new provider, access request or migration is required by this snapshot. Treat a future outage as operational evidence, not a current invented blocker. | No standalone change task justified |

## 13. Known risks and limitations

- AI output is fallible. Checks do not guarantee factual accuracy, ownership, outstanding status or completeness. A user must read the minutes/report, not only clear warning cards.
- The same source passage and model agreement do not prove complete semantic retention. Existing safeguards intentionally leave some apparent duplicates untouched.
- Existing saved minutes are not retroactively rewritten by later generation fixes. Recent merged safeguards cannot be credited with unmeasured improvements to old records.
- Current minutes can be exported/saved while checks remain open. Complete means the reviewer saved final minutes, not that every item was independently verified.
- Optional retained material is not automatically part of the exported main minutes; a count of retained entries is not an error count.
- Project-update corrections are unsafe until the four P0 defects are addressed. Draft labels do not compensate for destructive saves or unchecked carry-forward.
- Fallback analysis, missing context, service limits and retries can affect quality/latency. Focused tests and historical service calls are not uptime guarantees.
- No new full live generation/approval cycle, realistic review-time study, current whole-repository green baseline or permission test under each colleague's account is claimed.
- Earlier documentation and temporary logs have different dates/scopes. Preserve that distinction when using their claims.

## 14. Deferred improvements and research

The material P2 themes are remaining minutes repetition/organisation, review volume and terminology, and the project-flow work already in PR #67. These can be prioritised from observed pilot experience rather than becoming an expanding pre-pilot backlog.

P3 work includes the held admin-settings PR, existing semantic experiments and any later approved internal Tasks tab. PR #155's latest research update (`9f173d6f`) binds exact source spans: 17 local tests pass, 138 member occurrences bind, and Microsoft qualification passes 20/21 synthetic controls. Saved cases still produce overlapping obligation records and false whole-promise retention claims. **The experiment remains draft, unmerged and undeployed; its improved test score is not a production achievement.** PR #132 remains a separate held prototype.

Other open PRs exist, including historical mobile/staged-minutes/MiniLM work. They are not converted automatically into platform requirements. Existing mobile fixes and current test passes must not be reopened merely because an older PR remains open. This snapshot authorises no new verification framework, additional AI agent or architectural redesign.

**Future import boundary:** section 10 is the task source, not application data. No database task records or automatic import are created. A future implementation must remain exclusive to the internal AI project, retain stable IDs and require separate approval. It must not create tasks automatically from unrelated minutes or introduce task navigation/permissions for other projects.

## 15. Recommended next steps

1. **Start the separate minutes pilot.** Confirm a participant/input and follow Details → Discussion → Actions → Summary → Review → Save final minutes → Library reopen/export. Observe real effort and any inability to finish.
2. **Schedule only the four verified project-update corrections.** Fix non-lossy editing, evidence identity, the approval baseline and health consistency. Do not make a broader redesign or PR #67 a substitute for these fixes.
3. **Validate one corrected project cycle and a follow-on report**, then seek independent colleague use. Use the existing project checklist where useful.
4. **Review human feedback before more optimisation.** Make separate routine-use decisions for minutes and reporting. Optional refinements/research can wait.
5. **Maintain this snapshot deliberately.** Update evidence, statuses and counts when a task is genuinely completed; retain IDs and distinguish merged, deployed, tested and user-validated work. The documentation PR itself must not be merged automatically.

The principal constraint is **verified project-report safety defects for the combined workflow, and missing real-user usability evidence for the otherwise pilot-ready minutes tool**. Obtaining more data or continuing speculative semantic research is not a substitute for either.

## 16. Supporting PRs, issues and documentation

### Source assessments and implementation evidence

- The two read-only readiness assessments in this conversation; their material findings are preserved above.
- [Meeting minutes review workflow](meeting-minutes-review-workflow.md), [shared optional source presentation](meeting-minutes-shared-optional-review-source.md), [bounded reviewer-burden corrections](meeting-minutes-bounded-reviewer-burden.md).
- [Final-exchange source status](meeting-minutes-final-exchange-source-status.md), [required literal wording](meeting-minutes-required-literal-wording.md), [agent/Library audit](meeting-minutes-agent-library-audit-20261017.md), [UI check correction](meeting-minutes-ui-checks-20261025.md).
- [Project pilot checklist](project-update-internal-pilot.md), [historical robustness list](project-update-robustness-todo.md), [golden evaluation guidance](../scripts/project-update-golden/README.md), [realistic-fixture caveat](../scripts/project-update-golden/real/README.md).
- [Minutes editor](../public/meeting-minutes-agent.js), [minutes page](../views/meeting-minutes-agent.html), [project report editor](../views/project-update-reports.html), [persistence/context](../utils/db.js), [project generator](../utils/projectUpdateGenerator.js), [minutes-to-project conversion](../utils/minutesForProjectUpdate.js), [API routes](../routes/api.js).

### Relevant GitHub work

- Merged achievements: PRs #35, #54, #92, #117, #121, #138, #144–#154, #156 and #157, linked in section 7. Later safeguards do not imply new real-user validation.
- Open project work: [#67](https://github.com/clairenicholsondigital/trinzo-upload/pull/67).
- Separately scoped open admin work: [#61](https://github.com/clairenicholsondigital/trinzo-upload/pull/61).
- Held research: [#132](https://github.com/clairenicholsondigital/trinzo-upload/pull/132), [#155](https://github.com/clairenicholsondigital/trinzo-upload/pull/155).
- No open GitHub issue was returned by the repository issue listing at consolidation. AI IDs are documentation records, not newly opened GitHub issues or application tasks.

**Decision baseline:** preserve the four project-update P0 findings and the minutes READY WITH CAVEATS conclusion unless later, verifiable fix or pilot evidence warrants changing them.
