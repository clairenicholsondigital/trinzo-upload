# Provider failures and attempt deadlines

## Proven application defects

The target-retention qualification trial received HTTP 200 containing a typed error envelope:

```json
{"error":{"code":"microsoft_route_failure","message":"The Microsoft agent route did not return a response.","retryable":true}}
```

The private wire capture introduced in PR151 retained this exact envelope. For non-referee response kinds, the parser previously required a success-shaped array and reported `power_automate_invalid_structure`, losing the explicit upstream failure category. Referee calls recognised the error envelope, but the error classifier did not recognise this specific transient route failure as retryable.

The parser now recognises nonempty string code/message error envelopes independently of the requested success shape. Non-referee direct generation/audit callers raise the provider error immediately; they cannot normalise it into empty minutes. Referee replies retain their existing decoded hand-off and private audit. The retry wrapper continues to reject errors before treating any result as successful.

Only the known `microsoft_route_failure` code with a literal boolean `retryable: true` receives the new bounded retry classification. Arbitrary provider retry hints do not authorise retries of semantic errors. Existing attempt counts, backoff, candidate repair and validation rules remain unchanged. Unknown malformed shapes still fail validation. This corrects app handling; it does not fix the upstream cause of Microsoft's route failure.

A second deterministic defect caused explicit `attemptTimeoutMs` to be ignored when `deadlineAt` was absent. The computed timeout was passed only when an overall deadline existed. The retry wrapper now passes the configured attempt timeout in both cases and retains the existing remaining-deadline calculation and ten-second minimum when a deadline is supplied.

The transport also used to clear its abort timer and release its active-call slot immediately after response headers arrived. `response.text()` ran outside that protected interval and its errors escaped the normal transport classification. Full body transfer now remains under the same attempt deadline and call slot. Abort and body-stream failures retain the existing timeout/unreachable categories, and cleanup runs on both success and failure. This is a network-attempt fix, not a change to queue-wait or overall workflow policy.

## Verification

Four new regressions failed before the initial corrections. Additional checks cover direct generation/audit callers and reproduce the premature deadline/slot release before the body-read correction. Tests use isolated transport/provider stubs; no real library writes occur.

Coverage includes all requested success-response families, exact private failure evidence, strict rejection of unknown shapes, semantic retry hints remaining ineffective, recovery within the existing maximum attempts, explicit timeouts with/without an overall deadline, response-body timeout/stream failure and cleanup. Existing action owner/date/candidate and unresolved-group checks remain intact.

Validation passed: 3,690 scoped meeting-minutes tests, with two existing skips; 199 targeted tests; the meeting-agent build. All 13 recorded referee responses across the saved five outputs still have identical validation, action reconstruction and 30 unresolved group results. No automatic group closure, context disposal or draft change is enabled.

## Target-retention work remains research

The isolated next-stage harness separates source-only obligation extraction from target-side retention assessment. Source extraction receives no draft action inventory. Retention must quote exact existing target action/timing text; source citations, warning text and invented wording cannot stand in for a retained detail. Twenty local contract checks reject fabricated evidence, missing members/items, stale packets, invalid fields and work reclassified as context.

The live-provider trial did not establish semantic feasibility. One synthetic extraction received the typed route failure above; another timed out. Two subsequent source-only requests were outstanding when the isolated runner was stopped, and four planned controls had not started. These cancellations are not negative semantic results. No target-retention assessment completed and no real five-draft content was sent in this trial. The original failures and incomplete request artifacts are retained; they are not retried into acceptance.

A previously successful synthetic contract was also probed once with a strict 45-second deadline and timed out. This is evidence that the failure is not confined to the new inventory contract; it does not establish the underlying Microsoft cause or a service-wide outage. No further provider retry was attempted.

Before enabling any cleanup, establish a valid bounded control response, distinguish endpoint/route failure from research-contract failure, then complete the retained-paraphrase, missing supporting-work, missing communication qualification, missing approval, polite-acceptance and ambiguous-correction controls. The exact source/target witness validators are ready for qualification; their semantic reliability and a durable production closure path remain unproven.
