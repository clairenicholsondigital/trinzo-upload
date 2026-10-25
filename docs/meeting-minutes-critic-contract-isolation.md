# Meeting minutes critic contract isolation

The shared Microsoft critic used persistent ACTION_CRITIC_TIMING instructions even for general action audits, lifecycle checks and salvage. Captured general audits returned timing-shaped objects. Those structures must continue to fail the app's validators.

The timing rules now live, unchanged, in `utils/meetingMinutesTimingInstructions.js`, included by `timingCheckPrompt` on every initial and isolated timing request. General, lifecycle, completeness, semantic and salvage tasks carry their own instructions. The intended shared Microsoft literal is versioned in `config/microsoft/meeting-minutes-critic-passthrough.txt`; retain the existing `agentInput` variable, model, temperature and output configuration.

Rollout order matters: deploy the app first, then publish the generic shared literal. Back up the active published configuration by its active pointer, not by latest modification date. Test captured general-audit, lifecycle, completeness and salvage requests and negative timing cases against the draft before publishing. Verify the active pointer and published literal afterward. During rollback restore Microsoft timing instructions before reverting the app migration.

This removes persistent cross-task instructions; it does not introduce mechanically enforced Microsoft response schemas or replace local structure, source, owner, work, qualification or calendar validation. A successful audit is not a deduplication proof.

## Private comparisons

Use `scripts/lib/meetingMinutesEvaluationSession.js` when bypassing the real queue. Create one session per new run and record its `semanticPolicy` in the run manifest. Use `session.generateStage(generateHybridMeetingAgentStage, draft, stage, options)` at every stage. Paired runs must reuse the reference manifest's policy, not recapture new flags. Virtual payload saves can discard private draft fields; explicit stage options preserve the snapshot.

An absent snapshot intentionally remains off for legacy production work. Do not change that behavior to repair an evaluation. Record candidate availability at each join separately from final quality. Lower action or filing counts cannot establish improvement when one run used fewer upstream candidates.
