# Project Status Classifier — Current Misread Text Audit

_Last updated: 2026-07-29_

## Scope

This audit focuses on the **current production use** of the fine-tuned project-update status embedding classifier:

- Production model: `/root/project-update-status-model/models/production/classifier.joblib`
- Current Trinzo use: `scripts/project_status_evidence_pack.py`
- Main production impact: used as a **project-status evidence/attention layer** for `/meeting-minutes-final`, and as **diagnostics only** for `/project-update-test`.

This document is not a general Meeting Minutes quality audit. It records the text patterns the current classifier is likely to over-weight, under-understand, or classify with the wrong project-status meaning.

## Summary

The classifier is useful for spotting genuine blockers, dependencies, timelines and follow-ups, but it is currently too eager around some **content-planning / webinar-planning / topic-discussion** language.

The main pattern is:

> The model sees project-management words such as supplier, approved, September, November, scope, validation, check, topic, or client, and treats them as status/action/dependency evidence even when the transcript is only discussing possible webinar topics or content structure.

This matters because the Meeting Minutes pipeline uses the classifier output as an attention guide. If the classifier highlights the wrong chunks, the downstream writer is more likely to produce fake or over-strong actions, decisions, risks, or deadlines.

## Known current misreads

### 1. Webinar/session title mistaken for supplier/dependency/action evidence

**Text**

> “November one will be, is your AI vendor an approved supplier?”

**What it probably means**

A webinar/session topic or content-calendar item. It should not automatically become a task, supplier dependency, budget issue, or deadline.

**Current model behaviour**

- Top status: `watch` `0.281`
- Top action: `follow_up_required` `0.211`
- High signals:
  - `supplier_action_needed` `0.781`
  - `budget` `0.547`
  - `dependency` `0.520`
  - `timeline` `0.510`

**Why this is wrong / risky**

The phrase contains “approved supplier” and “November”, but in context these are probably part of a webinar title/sequence. The classifier currently treats that wording like project delivery evidence.

**Needed training/guardrail**

Add negative examples where “approved supplier” appears inside a topic/session/webinar title and should be `no_action` / `no_usable_status` or a new meeting-type/topic-planning label.

---

### 2. Content sequencing mistaken for decision/deadline evidence

**Text**

> “Would we not want to put that as the first one in September?”

**What it probably means**

A tentative content/session sequencing suggestion. It may be a topic-ordering question, not a project deadline.

**Current model behaviour**

- Top status: `unknown_or_insufficient_info` `0.308`
- Top action: `decision_required` `0.412`
- High signals:
  - `timeline` `0.920`
  - `decision_needed` `0.804`
  - `no_usable_status` `0.597`

**Why this is wrong / risky**

The model is partly right that this is ambiguous, but `timeline` and `decision_needed` are too strong. In Meeting Minutes, this can encourage the downstream writer to invent a decision or deadline.

**Needed training/guardrail**

Add examples distinguishing:

- calendar/session sequencing;
- tentative suggestions;
- real project deadlines;
- confirmed decisions.

---

### 3. Topic validation mistaken for in-progress/internal action

**Text**

> “It’s a great topic to address.”

**What it probably means**

The speaker is validating a theme or topic. It is not an action.

**Current model behaviour**

- Top status: `on_track` `0.435`
- Top action: `in_progress` `0.335`
- High signals:
  - `stakeholder` `0.690`
  - `technical` `0.685`
  - `internal_action_needed` `0.524`

**Why this is wrong / risky**

The phrase is generic content discussion, not delivery progress. `internal_action_needed` is especially misleading.

**Needed training/guardrail**

Add negative examples for phrases like “good topic”, “useful angle”, “worth covering”, “theme to address” where no owner/task is assigned.

---

### 4. Terminology discussion mistaken for decision/status evidence

**Text**

> “AI validation, or whatever we want to call it.”

**What it probably means**

A terminology/naming discussion. It may be useful as a topic, but not as project status.

**Current model behaviour**

- Top status: `on_track` `0.432`
- Top action: `in_progress` `0.366`
- High signals:
  - `technical` `0.794`
  - `stakeholder` `0.739`
  - `scope` `0.674`
  - `decision_needed` `0.574`
  - `quality` `0.509`

**Why this is wrong / risky**

The model is over-reading domain terminology as project movement. There may be a naming decision eventually, but this text alone does not prove one.

**Needed training/guardrail**

Add examples of naming/terminology uncertainty that should be retained as a discussion theme but not classified as a decision/action unless explicit decision language appears.

---

### 5. Regulatory/content theme mistaken for internal action

**Text**

> “EU AI Act as a governance drive.”

**What it probably means**

A possible explanatory theme or content angle.

**Current model behaviour**

- Top status: `on_track` `0.273`
- Top action: `internal_action_needed` `0.266`
- High signals:
  - `technical` `0.870`
  - `stakeholder` `0.748`
  - `scope` `0.605`
  - `internal_action_needed` `0.575`

**Why this is wrong / risky**

The model sees regulatory/technical language and infers action/status relevance. For webinar planning, this should remain a topic/theme unless linked to a task.

**Needed training/guardrail**

Add topic-only examples for regulatory themes: EU AI Act, validation, governance, risk, supplier approval, intended audience, etc.

---

### 6. Short topic fragment mistaken for scope/decision evidence

**Text**

> “scope for AI use”

**What it probably means**

A short phrase or topic fragment. Too little context to classify confidently.

**Current model behaviour**

- Top status: `on_track` `0.344`
- Top action: `in_progress` `0.318`
- High signals:
  - `scope` `0.974`
  - `stakeholder` `0.782`
  - `technical` `0.643`
  - `decision_needed` `0.554`
  - `resourcing` `0.514`

**Why this is wrong / risky**

The `scope` signal is understandable, but the fragment should not imply a project status or decision. Short fragments need a stronger “insufficient context” bias.

**Needed training/guardrail**

Add short-fragment examples and require more sentence-level evidence before using `decision_needed`, `in_progress`, or project-health labels.

---

### 7. Approved-supplier question mistaken for supplier action/dependency

**Text**

> “Is your AI vendor an approved supplier?”

**What it probably means**

Could be a webinar title, discussion question, or content prompt. It is not a supplier action unless someone is assigned to check/provide/approve something.

**Current model behaviour**

- Top status: `watch` `0.252`
- Top action: `internal_action_needed` `0.268`
- High signals:
  - `supplier_action_needed` `0.906`
  - `budget` `0.590`
  - `stakeholder` `0.549`
  - `dependency` `0.532`
  - `internal_action_needed` `0.501`

**Why this is wrong / risky**

The model over-associates the words “vendor”, “approved”, and “supplier” with real supplier actions/dependencies.

**Needed training/guardrail**

Add contrast examples:

- topic question: “Is your vendor an approved supplier?” → no action/topic only;
- actual action: “Claire will check whether the AI vendor is an approved supplier by Friday” → action/deadline;
- actual dependency: “The work cannot proceed until the vendor is approved as a supplier” → dependency/blocker.

---

### 8. Soft suggestion mistaken for decision/supplier action

**Text**

> “Maybe we should think about doing a short section on approved suppliers.”

**What it probably means**

A tentative content idea, not a confirmed task.

**Current model behaviour**

- Top status: `watch` `0.380`
- Top action: `action_required` `0.236`
- High signals:
  - `decision_needed` `0.702`
  - `supplier_action_needed` `0.635`
  - `stakeholder` `0.623`
  - `scope` `0.527`
  - `quality` `0.516`

**Why this is wrong / risky**

The modal language “maybe we should think about” should reduce action confidence, not increase it.

**Needed training/guardrail**

Add modal/hedged examples: “maybe”, “could”, “might”, “worth thinking about”, “do we want to”, “should we consider”. These should not become actions unless paired with owner + verb + object.

---

### 9. Conditional talking point mistaken for client action/decision need

**Text**

> “If the client asks about validation, we could mention the EU AI Act as context.”

**What it probably means**

A conditional talking point for a future presentation/webinar. Not a current client action or decision.

**Current model behaviour**

- Top status: `watch` `0.321`
- Top action: `needs_information` `0.315`
- High signals:
  - `stakeholder` `0.909`
  - `scope` `0.857`
  - `client_action_needed` `0.784`
  - `decision_needed` `0.748`
  - `no_usable_status` `0.606`

**Why this is wrong / risky**

The `if ... could ...` construction is hypothetical. The model should avoid current-action/client-action labels unless there is actual requested client input.

**Needed training/guardrail**

Add conditional examples with `if`, `could`, `would`, “if asked”, “if they raise”, “if needed” that map to no current action/decision.

---

### 10. Completed past work mistaken for new follow-up/internal action

**Text**

> “Claire already sent the supplier list last week and Conor reviewed it yesterday.”

**What it probably means**

Completed historical work. It should not create a new action.

**Current model behaviour**

- Top status: `watch` `0.382`
- Top action: `follow_up_required` `0.285`
- High signals:
  - `internal_action_needed` `0.726`
  - `stakeholder` `0.700`
  - `supplier_action_needed` `0.688`
  - `delivery` `0.679`
  - `timeline` `0.622`

**Why this is wrong / risky**

Past-tense completion markers such as “already”, “sent”, “reviewed”, “last week”, and “yesterday” should push toward completed/no-action, not follow-up.

**Needed training/guardrail**

Add completed-history examples and tense-aware contrast pairs:

- “Claire sent it yesterday” → completed/no action;
- “Claire will send it tomorrow” → action/deadline;
- “Claire has not sent it yet” → follow-up/blocker depending context.

---

### 11. Partial transcript language not represented strongly enough

**Text**

> “I just turned on the transcript, so we missed the middle bit, but November one will be the approved supplier topic.”

**What it probably means**

The transcript is incomplete, and the remaining content is topic sequencing. This should trigger a partial-transcript warning more than project-status extraction.

**Current model behaviour**

- Top status: `unknown_or_insufficient_info` `0.542`
- Top action: `follow_up_required` `0.182`
- High signals:
  - `timeline` `0.637`
  - `decision_needed` `0.468`
  - `no_usable_status` `0.450`

**Why this is only partly right**

The model does recognise insufficient information, but there is no explicit “partial transcript” output label. The Meeting Minutes flow therefore does not get a clean warning signal.

**Needed training/guardrail**

This may need a separate meeting-input-quality classifier or new signal labels such as:

- `partial_transcript`
- `large_time_gap`
- `topic_planning`
- `low_action_evidence`

---

### 12. Weak review wording still produces misleading sign-off/quality signals

**Text**

> “We went through the document and there were a few things to check, really.”

**What it probably means**

Weak/unspecified review. There may be follow-up, but there is no concrete owner/object/deadline.

**Current model behaviour**

- Top status: `unknown_or_insufficient_info` `0.563`
- Top action: `needs_information` `0.388`
- High signals:
  - `no_usable_status` `0.873`
  - `quality` `0.678`
  - `sign_off` `0.671`

**Why this is partly wrong**

The `no_usable_status` result is good. The `sign_off` signal is not supported: “went through the document” is not the same as approval/sign-off.

**Needed training/guardrail**

Add review-language contrasts:

- “reviewed it” / “went through it” → review activity, not sign-off;
- “signed off” / “approved” / “accepted” → sign-off;
- “needs checking” without owner/object → weak follow-up only.

## Things the model is currently handling well

The production model is not useless — it is good at clear project-status wording.

### Clear blocker/dependency control

**Text**

> “The build is blocked until IT provides firewall access.”

**Current behaviour**

- `blocked` `0.945`
- `dependency` action `0.565`
- signals include:
  - `dependency` `0.936`
  - `technical` `0.915`
  - `missing_access` `0.855`

This is the kind of language the current classifier handles well.

### Clear action/deadline control

**Text**

> “Claire will send Conor the updated draft minutes by Friday.”

**Current behaviour**

- High `timeline` and `delivery` signals.
- Action label is weaker than ideal (`follow_up_required` `0.236`), but the evidence is still usefully highlighted.

This suggests the model is useful as an evidence highlighter, but action-state confidence/calibration could still be improved.

## Priority fixes

### P0 — Add topic-planning negative examples

Add labelled examples where words like `approved supplier`, `validation`, `EU AI Act`, `scope`, `September`, and `November` appear inside webinar/content-planning contexts and should not become supplier actions, deadlines, or decisions.

### P0 — Add modal/hedged-language examples

Train on examples containing:

- “maybe”
- “could”
- “might”
- “should we”
- “do we want to”
- “worth thinking about”
- “if asked”

These should usually reduce action/decision confidence unless there is a named owner and a concrete deliverable.

### P1 — Add tense/completion contrast examples

The model needs more contrast pairs for:

- already sent vs will send;
- reviewed vs will review;
- approved/signed off vs needs approval;
- discussed as a topic vs agreed as an action.

### P1 — Add partial-transcript / meeting-type layer

The current classifier does not truly know that a transcript is:

- a webinar/content-planning session;
- a discussion-only strategy call;
- incomplete/partial;
- low-substance/noisy;
- a formal action/decision meeting.

That probably wants a small separate classifier or an expanded label layer before Meeting Minutes extraction.

### P2 — Calibrate evidence-pack thresholds by label

`project_status_evidence_pack.py` currently keeps chunks when important status/action/signals cross broad thresholds. Some labels probably need stricter thresholds or context checks when used for Meeting Minutes:

- `supplier_action_needed`
- `decision_needed`
- `timeline`
- `internal_action_needed`
- `sign_off`

These should be harder to trigger for short fragments, questions, hypothetical language, and topic-planning phrases.

## Recommended next training batch

Create a reviewed draft batch with approximately 80–120 examples:

- 30 topic-planning / webinar-planning negative examples;
- 20 modal/hedged suggestion examples;
- 20 past-completed vs future-action contrast pairs;
- 15 review/sign-off contrast examples;
- 15 true positive controls for blockers, dependencies, owners, deadlines, approvals.

Do not promote automatically. Evaluate as a draft first, then promote only if it improves the real failure cases without damaging clear blocker/action detection.
