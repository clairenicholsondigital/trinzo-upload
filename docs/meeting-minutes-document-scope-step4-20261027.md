# Document scope: step 4 safety validation — 27 October 2026

Step 4 is complete on the isolated implementation branch. No merge, deployment,
Microsoft request, transcript upload or persistent application-data write occurred.

## Checks and outcomes

- **433 regression tests passed**, including the complete 72-test browser file,
  proposal/persistence/undo/redo, automatic edits, source identity, numeric
  protection, commitment warnings and timing publication.
- **Four complete offline Action-stage scenarios passed**, covering the prefix
  proposal and warning-only response with either discovery route unavailable.
  These exercise generation, background persistence and public projection, with
  controlled provider replies, a seeded secondary ledger and in-memory storage.
  The unavailable route actually returns fixture HTTP 503 failures. Real sockets,
  database connections and child processes are denied.
- **15 wider safety cases passed**: unrelated/competing identities, identifier
  boundaries/revisions, speaker changes, excluded intervening turns, unsupported
  quantities, completed work, conditional timing, uncertain sources, missing
  replies and conflicting prefixes. These are included in the 433 tests.
- Both new browser cases were rerun against the final plain-language message.
  Each shows one source-linked optional review item. Its explanation makes the
  uncertainty explicit; checking it and refreshing does not insert an action.
- The immutable 44-response replay passes the work-available-for-review gate:
  zero paired or single-response cases lose the work entirely, and all 20
  protected distinctions pass. The one warning-only response remains visibly
  counted as **no assessment row**, with a retained review question instead.
- All five saved registers (52 actions) normalise exactly as under deployed
  `339f56849c62d93f01be252fd9d66b9b7c5cd969`.

## Failures investigated rather than hidden

### Fixture isolation

Two initial pipeline tests reused a previous scenario's primary discovery reply.
The app's prompt-keyed prewarm cache was working as designed; the fixtures had
identical meeting details and therefore identical inputs despite expecting
changed responses. Each scenario now uses its own meeting title. The fixture
referee also supplies a valid atomic disposition contract rather than triggering
an unrelated materialisation fallback. All four isolated scenarios then passed.
No production cache policy was changed.

### Genuine ordinal-ID citation defect

Two independent discovery replies can both call an action `A1`. The proposal
normaliser selected the first matching ID even when its wording and document
were different. A new reproduction returned one assessment instead of two.

The local correction requires a unique cleaned-wording match when an ID is
reused. It cannot borrow the first proposal's citations solely from that label.
The same test now retains both assessments with their own evidence. Ambiguous
reused labels cannot authorise guessed citation binding.

### Reviewer wording

The ownership-question message no longer describes an internal discovery
response. It asks plainly whether the work should become an action and who
accepted it. Original provider wording and source context remain in provenance.

## Limits and step 5 hand-off

The offline generation scenarios use the existing fast Action path with optional
semantic reconciliation and some optional review calls disabled to control the
fixture contract. Separate regression tests cover commitment warnings and timing
publication. This is not a fresh run with every production feature enabled and
is not an independent colleague usability test.

Step 5 must qualify the document-specific generation instruction against the
existing Microsoft routes and run an isolated complete Eakin workflow with the
production configuration. Inspect the final reviewer-facing assessment and
warnings; do not infer success from primary responses alone. Existing library
records must remain unchanged. Release and deployment are still step 6.

Private evidence: `/root/trinzo-document-scope-step4-20261027`, including initial
failure logs, corrected runs, the immutable replay and register comparisons.
`readyForRelease` remains false in the offline report.
