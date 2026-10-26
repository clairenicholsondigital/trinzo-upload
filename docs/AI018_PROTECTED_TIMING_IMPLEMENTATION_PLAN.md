# AI-018: protected-timing action overlap — investigation and implementation plan

Research date: 26 October 2026  
Repository baseline: `7107e5dc1ec828d855a8c5cbc05e8ea6a88d8936` (main, including PR #174)  
Branch: `research/ai018-protected-timing-plan`  
Persistent task: AI-018, internal AI project 19, record 31, revision 4; P2, To do.

**Research and planning only. No application changes, task updates, external AI calls or live draft changes were made. AI-016 remains separate in open PR #175.**

## Recommendation

Do not relax the general timing or compound-action safeguards.

Prepare a narrowly gated, source-supported work-union capability only after proving that the instructions describe the same work occurrence and can share one timing representation. The observed pair is a partial overlap, not a demonstrated interchangeable duplicate. The source also suggests sequential work. An unconditional one-row merge is not justified.

There is enough information to specify the code paths, proof contract, tests and stop conditions. There is **not** enough evidence to promise that this particular pair should become one row. The first implementation gate must resolve that question, rather than treating nomination eligibility as proof.

## 1. Findings established in this investigation

### The overlap enters during recovery

The captured action ledger contains two recovery candidates (embedded records R10/R11), and their candidate IDs become the two final action IDs. One instruction combines updating/sharing with particular risk-control scope; the other combines completion/sharing with a review purpose. They have the same assignee and overlapping source references.

This establishes admission of overlapping recovery material. It does not establish that the recovery mechanism should discard either candidate: each carries meaning absent from the other.

### The current code still does not nominate or remove the pair

Local replay of the captured pair and its original source units against the baseline above gave:

| Check | Result |
| --- | --- |
| Input actions | 2 |
| Semantic reconciliation candidates | 0 |
| Existing workflow-union packet | None |
| Compilation-union packet | None |
| Hybrid dedupe output | 2 |
| Final preservation output | 2 |
| Actions restored in that replay | 0 |
| Distinct warning references across the pair | 6 |
| Distinct rejected exact dates | 1 |

The semantic checker was not asked to decide equivalence. This is not evidence of a Microsoft veto, retry failure or provider-quality problem.

Directional mechanical checks refuse both directions. Reasons include different timing and operation; one direction also reports lost operation and identifier scope. Neither unchanged survivor currently proves full coverage of the other.

### The source introduces a phase/ordering problem

The relevant source sequence is:

- T0256–T0258: work on the risk file and the hardware/interface control considerations.
- T0264–T0266: a request to progress the two aspects.
- T0268: looking at other devices.
- T0269: tidying the file, sharing it for others to examine, and then adding the material.
- T0270: a hoped-for weekday target in the context of a meeting.

This supports overlap around the file and handoff, but leaves the relationship between the initial review and subsequent additions important. Do not rewrite it into an assertion that all additions precede sharing, that the reviewer is responsible for the file updates, or that every operation has a confirmed deadline.

The pair's source sets differ. A new proof must include the wider context carrying the risk-control scope, not only the two shared source units. Same assignee, document and shared citations are insufficient.

### Timing and warnings are active safeguards

Both rows retain target wording but have rejected timing decisions and a previously rejected exact calendar date. The wordings differ; the shorter wording also omits the expressed uncertainty.

A new action changes its action/evidence identity. Copying a prior timing decision or refreshing its identity key does not prove a new timing binding. Preserve both original decisions in the private receipt and never promote their certainty merely because the text is consolidated.

The six warning references must remain recoverable. This task does not authorise resolving or hiding them; shared warning presentation belongs to AI-012.

### Recent AI-011 work does not close AI-018

PR #174 handles bounded source-supported timing completion for **identical action instructions**. These instructions have different operations/scope/review purpose, and rejected-date history. The current replay confirms that they remain separate.

Preserve those AI-011 gains. Do not generalise identical-instruction timing completion to compound partial overlaps.

## 2. Verified implementation touchpoints

Line numbers below refer to the research baseline; locate by function after other work lands.

| Component | Existing responsibility | Planned change if the proof gate passes |
| --- | --- | --- |
| `utils/canonicalMinutes/actionSemanticReconciliation.js`, `boundedSurvivorPair`, `mechanicalCoverage`, `validateCoverage` | Untimed bounded nomination, protected facets, source/owner/clause proof | Keep existing gates intact. Reuse their proof requirements; do not make general timed rows eligible. |
| `utils/meetingMinutesCompilationUnion.js`, `prepare`, `rewrite`, `valid`, `restore` | Source-bound compilation-specific union with private originals and receipts | Reuse as a design reference, preserving its compile-only scope and tests. It does not currently support the target pair. |
| `utils/meetingMinutesActionUnionRewrite.js`, `rewrite`, `valid`, `rebind`, `restore`, `preserveUnchanged` | Dispatch, immutable receipt validation, identity rebinding and untouched saves | Add explicit dispatch for a new versioned bounded class. Preserve existing workflow/compilation behaviour and priority. |
| `utils/meetingMinutesSemanticPolicy.js` | Frozen policy captured for a run | Add an explicit gated capability, absent on legacy snapshots; do not enable it implicitly or expand existing candidate limits. |
| `utils/meetingMinutesTiming.js`, `timingAssessmentKey`, `assessmentMatches`, `assessActionTiming` | Timing identity and source-binding validation | Reuse unchanged. A new instruction needs an honestly retained/reassessed decision; identity-key renewal is not verification. |
| `routes/api.js`, `finishMeetingAgentGeneratedStage` (~16043) | Calls the workflow-union stage | Route the optional class through the existing stage; honour current cancellation/deadline/protected-ID handling. |
| `routes/api.js`, generated identity admission (~19953) | Rebinds receipts to allocated action/occurrence IDs | Bind the new receipt and its final snapshot hash; fail back to originals if allocation changes meaning. |
| `routes/api.js`, `reconcileFinalApprovedActions` (~12528), final publication (~20557) | Prevents deleted work being lost; accepts validated union receipts | Recognise only validated new-version coverage. An ID exemption or similarity comparison is not sufficient. |
| `routes/api.js`, owned draft PATCH (~18873) | Preserves untouched verified unions during normalisation | Retain the new receipt only for unchanged submitted meaning/date/source; reviewer changes invalidate it. |
| `utils/meetingMinutesEnquiryRecovery.js`, `originalEnquiryActions` | Determines whether separate actions can be restored | Add explicit new-version restoration through the dispatcher. Current union restoration is compilation-specific. |
| `routes/api.js`, `restore-combined-actions` (~20704) | Revision/ownership checks, exact restoration, earlier merge proof recovery | Include the new class without losing existing contact-merge restoration or identity mappings. |

A separate small module, **proposed new file** `utils/meetingMinutesProtectedWorkUnion.js`, is preferable to widening the old classes. Its final name can follow repository conventions. Existing JSON audit storage can hold its proof; no database migration, new agent or verification service is required.

## 3. Implementation sequence and gates

### Step 1 — Freeze and classify the observed example before modifying production logic

1. Re-read current main and AI-018; preserve concurrent changes. Refresh the owned draft only for a read-only comparison if a newer source/reviewer version exists.
2. Keep the captured original actions, source units, warnings, recovery candidates, timing decisions and meeting-date context in a private immutable fixture. Commit only a genuinely generic/anonymised fixture; no client-name or transcript-snippet production rules.
3. Build a claim table for each instruction: operation, artifact/version, owner, recipient, review purpose, occurrence, prerequisite/order, timing scope and source witness.
4. Use the existing Microsoft integration for an isolated assessment of that table and its complete bounded source window, with no draft save. Request a structured same-work/partial-overlap/distinct/unresolved decision and source witnesses for **every** original operation and any proposed ordering.
5. Independently check any positive interpretation using the existing verification pattern. A valid distinct/unresolved decision is a stop, not a request to keep trying until a positive answer appears.

**Decision gate:**
- If separate work phases or independently timed obligations are proved, retain separate actions. Document the source-based reason; do not call it an interchangeable duplicate.
- If the source remains ambiguous, preserve both and leave AI-018 unresolved. Record the precise missing relationship; do not invent a technical fix or mark the task complete.
- Proceed to a one-row rewrite only if one occurrence, complete coverage and a representable common timing scope are proved.
- Neither unchanged original currently passes full coverage. Selecting one as-is is not the planned correction.

The isolated provider assessment is future validation, not something performed during this research. Use existing authorisation appropriately and never transmit additional data silently.

### Step 2 — Establish a conservative bounded admission class

Only after the gate passes:

- Admit at most one supported file/artifact update-and-handoff pair per existing union opportunity, within the existing bounds. Shared terms nominate a comparison; they never authorise deletion.
- Require one identical, source-supported assignee, an unambiguous artifact/version and recipient/purpose relationship, one work occurrence and complete available witnesses.
- Require the same supported operation sequence. A review handoff followed by later additions cannot be rearranged into additions-before-handoff.
- Reject distinct recipients, versions, occurrences, alternative instructions, incompatible prerequisites or different timing scopes.
- Preserve reviewer-authored actions, kept IDs/occurrences, unknown metadata and ambiguous multi-row clusters.
- Do not admit a pair when rejection history conflicts with the proposed retained timing or when one timing field cannot safely represent its phases.
- Place this class after the existing preferred classes. Preserve their pair budgets and priority; do not increase the global candidate budget.

Default to no change when the new capability is absent/off, evidence is incomplete, the provider is unavailable, or the source/inputs change.

### Step 3 — Create and independently verify one complete instruction

Reuse the existing bounded inventory → proposal → coverage verification → work-event verification sequence and service infrastructure.

The proof must explicitly cover:

- every original outstanding operation and its source assignment;
- same artifact/version, owner, recipient and work occurrence;
- review purpose and all technical scope;
- source-supported sequencing and conditional relationships;
- no conversion of proposed/completed work into an outstanding commitment;
- no new work, responsibility, scope or deadline;
- unchanged or conservatively retained timing qualification.

Return a single grammatical instruction only when all checks pass. Preserve original-vocabulary and source-witness checks where suitable; do not force a verb-specific Compile/Review prompt on update-and-handoff work.

A valid negative answer ends that comparison. Transport/schema failures remain bounded and observable. Never retry a valid semantic veto into approval.

### Step 4 — Preserve timing uncertainty, warnings and recovery

Define a versioned private receipt containing the original actions and timing decisions, immutable source/input hashes, claim mappings, all provider decisions, the exact final row and allocated identity mapping.

- Keep the fullest source-supported timing qualification; do not turn a hope into a commitment.
- Retain an empty exact date when the available date was rejected. Union all rejected dates/wordings into active safeguards, and retain original decisions in the receipt.
- Retain all six original warning references and their states for the observed pair if it is ever admitted. No automatic warning dismissal.
- Recompute identity binding only for the new action and its actual source set. Do not label that step a successful timing verification.
- If the retained timing cannot safely apply to the whole rewritten instruction, refuse the merge.
- Restore both original actions and their original metadata exactly when requested and still eligible.
- Preserve other unrelated rows and earlier independently recoverable merges.

No new task-management fields or database schema are needed.

### Step 5 — Integrate all downstream paths before activation

Implement new-version validation/dispatch in the touchpoints above. Prove that:

1. generated identity allocation binds the receipt correctly;
2. final preservation does not restore a covered duplicate;
3. untouched PATCH/GET preserves the row and audit;
4. source/date/owner/action edits invalidate stale proof without losing reviewer work;
5. owned, revision-checked restoration returns the originals and keeps earlier contact restoration usable;
6. normal exports show the intended instruction, qualification and evidence, without leaking private proof snapshots or provider internals;
7. a failed new-class check leaves the original actions and warnings intact.

Do not bypass final preservation with an ID list. Do not automatically rewrite saved historical drafts.

### Step 6 — Validate, release separately and update AI-018 honestly

Keep the feature off until the controlled tests and isolated real-source check succeed. Review the PR before enabling it, then verify the released behaviour separately. Do not mark Done merely because a branch merges or a candidate is finally sent to Microsoft.

## 4. Required validation

| Area | Acceptance checks |
| --- | --- |
| Positive generic cases | Proven same occurrence, all operations/recipients/review purpose retained, compound instruction grammatical, conservative timing retained. Input order reversal gives equivalent meaning and complete provenance. |
| Observed pair | Either a validated complete result with safe phase/timing representation, or a documented source-based distinct-work result. A still-ambiguous pair remains open. |
| Negative cases | Different artifacts/versions/recipients/owners/occurrences; review followed by later additions; completed/proposed work; changed prerequisites; conflicting timing; different uncertainty; incompatible rejected history; missing/truncated/removed sources; more than two competing candidates. |
| Human edits | Reviewer-authored/kept records remain untouched. Changed wording/date/source invalidates stale proof. Unrelated edits and unrelated rows persist. |
| Provider outcomes | Veto, unresolved, malformed output, timeout and unavailable service all preserve originals. Exact supplied witnesses and complete original-clause accounting are mandatory. |
| Timing | Rejected date never returns. Uncertainty never upgrades. Different phase timing is not donated. Both original decisions remain recoverable. |
| Preservation | Final reconciliation, generated identity allocation and subsequent normalisation preserve a valid new result, while rejecting fabricated/stale receipts. |
| Persistence | Real disposable PostgreSQL round trip through the owned route, refresh/reopen, revision conflicts and a second user’s denied access. |
| Output | Browser action display and Word/PDF retain the complete instruction and qualification. Neither duplicate restoration nor loss of evidence occurs. |
| Recovery | Exact restoration of original rows/warnings and subsequent restoration of an earlier contact merge. Refuse stale/edited restoration safely. |
| Regression | Existing compilation/contact/survivor and source-bound identical-action timing suites; relevant persistence/export/recovery suites; normal meeting-minutes regression gate. |

Use existing tests as patterns:
- `tests/meeting-minutes-compilation-union.test.js`
- `tests/ai011-source-aware-duplicate-qualification.test.js`
- `tests/meeting-minutes-semantic-source-verification.test.js`
- `tests/meeting-minutes-claim-consolidation-persistence.test.js` for owned persistence/export/recovery test structure.

New protected-work-union tests and an explicit disposable PostgreSQL test will be needed. Existing route tests do not by themselves prove a real database round trip for the new class.

## 5. What counts as closed

**Implemented resolution:** the bounded class passes the positive/adverse matrix, the representative real-source outcome passes independent proof, all metadata and recovery survive persistence/publication/export, and the released feature is verified. If the observed pair still remains ambiguous, do not claim that its reviewer burden is solved.

**No-change resolution:** source evidence demonstrates that these are genuinely separate responsibilities/phases, and the task records why combining them would mislead. Ambiguity alone is not enough to close it this way.

Fewer rows, fewer warnings, a positive model label, nomination eligibility or a mocked provider result alone are not completion.

## 6. Effort, dependencies and limits

- Initial isolated work/phase proof: approximately **half a day**, including adverse controls and evidence capture.
- If the proof gate passes, bounded implementation and integration: approximately **2–4 engineering days**, including persistence, exports and recovery. Estimate is uncertain until the source/phase decision is established.
- Requires the existing Microsoft endpoint for the isolated feasibility check and a disposable PostgreSQL database for implementation validation. No new infrastructure or migration is proposed.
- Trinzo input is not yet a demonstrated prerequisite. If the transcript cannot resolve the work phases, the only useful clarification is whether the initial review and later control additions are one deliverable/occurrence or separately reviewable work.
- AI-005 remains responsible for independent reviewer usability/time measurements; none have been performed.
- Semantic certainty has a ceiling: overlapping descriptions with unclear phase boundaries cannot always become one safe row. Preserve work rather than manufacturing certainty.
- Partial rewriting/decomposition of two separate tasks, broad recovery redesign, shared-warning UI changes and historical clean-up are outside this bounded plan.

## 7. Evidence from this research

- Persistent AI-018 record read without modification: record 31, project 19, revision 4.
- Private captured example: `/root/trinzo-ai011-validation-20261026/actions-result.json`; recovery ledger R10/R11 and the two source-bound action IDs. Raw client material is not included in this document or branch.
- Earlier nomination receipt: `/root/trinzo-ai011-validation-20261026/remaining-pair-mechanism.json`.
- Reproduced under current main: zero candidates, neither union packet, two rows after dedupe and final preservation, coverage refusal in both directions.
- **80 existing focused tests passed**: compilation union, AI-011 source/timing qualifications and semantic source verification. These include controlled provider responses, not live Microsoft acceptance.
- No new generation, production save, external AI request, implementation change or task-status update was undertaken.

The next authorised implementation action should be Step 1's isolated proof gate, not widening the general deduper.
