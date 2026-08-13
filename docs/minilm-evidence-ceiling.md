# MiniLM evidence-layer ceiling

## Result

The release-candidate ten-transcript run is **2 issues, 0 blocking**, improved
from the previous **8 issues, 0 blocking** candidate and the **37 issues, 7
blocking** no-shortcuts baseline. It averages 95.5, passes all ten semantic
locks, and leaves nine transcripts with no weighted issues.

The result uses frozen `all-MiniLM-L6-v2` embeddings, the existing contextual
heads, the reviewed discourse-role head, and a section-agnostic canonical
resolver. It contains no golden case IDs or transcript-specific phrases in the
training data or resolver policy.

## What worked

- Lifecycle, context-dependency, worthiness and temporal heads made evidence
  filtering more selective.
- The discourse-role head separates canonical assertions/commitments from
  acceptance, recap, completed history, supporting detail and administration.
- Generic consolidation groups repeated evidence by owner, entity anchors,
  lexical overlap and inferred topic relationships.
- Canonical composition attaches temporal fragments and combines supporting
  evidence into one action, decision or risk.
- Action completeness rejects conversational instructions and incomplete
  fragments before publication.

## Experiments rejected by the global gate

| Experiment | Result | Finding |
| --- | ---: | --- |
| Clean v4 baseline | 37 issues / 7 blockers | Honest baseline after removing transcript-specific shortcuts. |
| Pair relation head | 38 issues / 7 blockers | Synthetic held-out F1 was misleading; the head over-grouped real adjacent turns. |
| Discourse head v8 | 28 issues / 5 blockers | Useful, general improvement. |
| Discourse selection v9 | 23 issues / 4 blockers | Better promotion and representative selection. |
| Discourse bundle plus generic resolver | 2 issues / 0 blockers | Release candidate; nine cases have no weighted issues. |
| Token slot head enabled | 26 issues / 6 blockers | Recovered one dense-recap action family but promoted rehearsal narration elsewhere. |

## Why the benchmark does not report zero

Both remaining flags refer to the same supported supplier batch-variation risk.
The evaluator fails to match the conversational paraphrase to the gold wording,
then reports it once as missing and once as extra. This is an evaluation matching
artefact, not an unsupported action or a canonical-selection blocker.

## Improvement path

Keep the current shared-encoder/head architecture and isolated resolver. The
next useful work is evaluator-side semantic risk matching and additional
group-held-out real meetings. Pairwise and token-slot experiments remain out of
the runtime because they regressed the global benchmark.
