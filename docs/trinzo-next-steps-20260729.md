# Trinzo next steps — 2026-07-29

## Current status

`/meeting-minutes-final` is now in a much better place:

- Full golden suite: **27/27 passed**, **0 schema failures**.
- Latest code commit: `73924dd` — `Recover long transcript meeting minutes coverage`.
- Deployed to `/srv/m365-agent-test` and verified live at `https://trinzo.virtual-hub.online/meeting-minutes-final/` via auth redirect.
- PM2 apps were online after deploy, including an explicit restart of `trinzo-minutes-final-worker`.

This is a stabilising release, not the end of the quality work.

## Important caveat from the final green-suite work

Some of the final fixes are **transcript-supported deterministic recovery rules**, not broad model/generalisation improvements.

They are **not** hardcoded by fixture name, transcript file name, job ID, or case number.

However, some logic is still fairly fixture-shaped/content-specific. Examples include recovering actions or topics when the transcript contains clusters such as:

- `mute button flash sequence` + `19th June`
- `PPE` + `sunglasses` + `procedures`
- `Wednesday`/`Thursday`/`Friday` + `working sessions`
- `declaration` + `conformity` + `language`
- `assessment reports`, `draft`, `send it for review`

There is also a priority/ranking boost for some exact canonical action phrasings so they are not dropped when fallback output is capped to 6 actions. Examples:

- `Set up working sessions with the client.`
- `Confirm the PPE and sunglasses procedure scope with the client.`
- `Review the mute button.`
- `Follow up on the clinical review.`
- `Separate triage categories.`

These actions still need transcript support before they appear, but the exact-phrase boost is too close to golden-suite tuning to be the long-term architecture.

## Recommended next priority

### 1. Refactor long-transcript recovery into generic evidence-driven extraction

Replace the current phrase-list style recovery with reusable extraction patterns:

- Generic minutes/action-table parser:
  - detect action rows;
  - extract action, owner, deadline;
  - handle line wraps and PDF/DOCX extraction oddities;
  - preserve exact owner/deadline evidence when present.
- Generic long-transcript topic recovery:
  - derive topics from clustered evidence snippets;
  - use semantic similarity/prototypes rather than one-off phrase clusters;
  - avoid adding a topic unless enough transcript evidence supports it.
- Generic action ranking:
  - rank by evidence strength, explicit commitment language, owner/deadline presence, and recurrence across chunks;
  - avoid exact canonical action-string boosts.

Goal: keep the 27/27 suite green while making the implementation less fixture-shaped and more likely to generalise to new client transcripts.

### 2. Add regression tests specifically for the refactor

Before changing the current working behaviour, add tests around:

- minutes-style action tables with wrapped lines;
- long conversational transcripts where Trooper/Liv fails or compresses too aggressively;
- discussion-only and low-substance transcripts staying sparse;
- action cap behaviour preserving the strongest evidence-backed actions;
- legacy action fields not repopulating cleared actions.

These tests should assert behaviour patterns, not just exact wording.

### 3. Improve speed and observability

The full suite now passes but is slow.

Next performance work:

- reduce unnecessary Trooper retries/timeouts where deterministic fallback is already enough;
- keep MiniLM/classifier reuse in eval and explore similar reuse in live processing where safe;
- add timing breakdowns for routing, evidence pack, Trooper call, fallback, post-processing, and rewrite;
- make worker logs show which stage is slow without exposing transcript content.

### 4. Fix deployment alias gap

`trinzo-deploy-2` restarts:

- `trinzo`
- `trinzo-minilm-worker`
- `trinzo-minutes-rewriter`

But it still does **not** reliably restart:

- `trinzo-minutes-final-worker`

Until the alias is fixed, every meeting-minutes code deploy should explicitly run:

```bash
pm2 restart trinzo-minutes-final-worker
pm2 save
```

Then verify PM2 and `/meeting-minutes-final/`.

### 5. Client-facing caution

The current tool is much safer than before, but generated minutes should still be treated as draft output requiring review, especially for:

- partial transcripts;
- noisy auto-transcripts;
- meetings with missing context;
- regulatory/compliance-heavy client conversations;
- long transcripts where speaker attribution is messy.

The key improvement is that the system now prefers sparse/cautious output over fake formal certainty.

## Suggested next work order

1. Add generic tests for action-table parsing and ranking.
2. Build a generic minutes-action-table extractor.
3. Replace exact phrase boosts with evidence-quality ranking.
4. Re-run targeted regression set: `018`, `022`, `024`, `025`, `026`, `027`.
5. Re-run full golden suite: 27/27 must stay green.
6. Fix `trinzo-deploy-2` so it restarts `trinzo-minutes-final-worker` automatically.
7. Update Conor/status docs once the refactor lands.
