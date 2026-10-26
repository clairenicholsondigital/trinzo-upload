# Shared source passage for independent optional checks

## Bounded display fix

Two unbound optional-addition checks could show the same source passage twice even when the source IDs were exactly identical. The saved Abbott output reproduces this with two different proposed follow-ups citing the same three source units. The checks are not proven duplicates, but their quoted evidence is identical.

The review queue now shows the shared passage once for this narrow case. Every check keeps its own explanation, editable note and decision controls. There is no group-confirm button, automatic dismissal, semantic merge or change to stored data. The heading explicitly says these are independent checks; the category still counts both items and both checks.

Sharing requires unbound `possible_missed_follow_up` flags with `not_applied_addition`, the exact same nonempty source-ID set, unique source IDs in the source inventory and unique flag IDs. Partly overlapping evidence is insufficient. Explicit or ambiguous targets, coverage/timing notices, reviewer-authored checks and existing reviewer notes remain separate. The existing exact-copy approval mechanism for one explicit target is unchanged and cannot be used by these source-only groups.

When one check is reviewed, the remaining check keeps its own source and controls. The shared source uses the existing full evidence renderer and disclosure-state machinery. Notes, source text, action wording, discussion and warning statuses are preserved through ordinary saves and history operations.

## Evidence and validation

Isolated browsers compared all five saved public outputs before and after this change. Abbott's optional source quotations fall from 13 to 12, with all 110 review checks, their exact flag IDs and the category counts unchanged. DITA, Allotment, Eakin and Parking retain their previous quotation counts and all checks. No output was regenerated and no production draft or cache was written by this comparison.

Twenty targeted browser tests pass. New desktop/mobile tests cover the shared quotation and full source display, honest counts, two independent decisions, individual notes, saved-state reload and undo/redo. Separation cases include partial evidence overlap, absent/ambiguous source IDs, reviewer notes/authorship, coverage notices and explicit action links. Existing exact-duplicate target and review-workflow tests also pass. Content invariance compares canonical publication data because the existing save format omits empty optional arrays.

This is a reading-burden improvement, not proof that either proposed task should be added or removed. It does not close the outstanding action-duplication work.

## Related semantic research remains held

[Draft PR #155](https://github.com/clairenicholsondigital/trinzo-upload/pull/155) separates raw source inventory, independent completeness review and target retention. The final synthetic matrix passes 15/17 controls, but an ambiguous unaccepted request is still classified as outstanding, and a real council example still treats omitted photo work as implied. The raw malformed-response failure is preserved separately. Those results block automatic review-item closure; none of that prototype is included in this production fix.

Private release, preservation and saved-output artifacts are in `/root/trinzo-shared-review-source-results-20261026`. Research artifacts remain separately in `/root/trinzo-obligation-ledger-research-20261026`.
