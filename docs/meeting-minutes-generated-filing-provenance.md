# Exact generated filing copies

Two handoff paths can retain the same discussion leaf: a discovery record with
primary citations/disposition, and a supporting candidate envelope. The filing
normalizer correctly protected unfamiliar metadata, but that also prevented
exact duplicates from consolidating.

At the internal collection boundary, recognized generated leaf/envelope shapes
are now archived verbatim in `filingOrigins[].generatedRecord` before projecting
the ordinary filing record. This archive preserves the original ID, text,
evidence/warning arrays, primary citations, disposition and (for a candidate)
source pass, priority, topic, type and nested original record. It is review
provenance only. No code uses it to supply evidence, reviewer authorship,
approval, or a new placement decision.

Only bounded recognized shapes qualify. Unknown metadata, reviewer-authored or
manual records, real descendants, malformed fields and already protected rows
remain protected. Exact consolidation still requires identical full text,
evidence and warning sets; different evidence/qualifications are not guessed
away. Every origin and predecessor remains, with at most 1,000 origins/history
IDs and a 128 KiB origin budget per entry. Overflow keeps separate entries.
Glossary/time/date presentation walkers preserve historical filing origins.

Existing saved protected rows are not unlocked or migrated: some lost their
original metadata at the earlier handoff. Archived test data can reconstruct
that handoff only when the exact original record, text and evidence/warning
sets are still available. That replay is distinct from fresh generation.

Verification includes exact archival capture/reload, malformed and protected
negative cases, history/capacity limits, real browser filing/promotion/demotion,
production PATCH/GET/undo/redo fixtures, Word/PDF projections and five archived
handoff replays. The captured five-run replay removes 7 exact DITA copies and
8 Eakin copies; the other three draft inventories remain unchanged. All claims,
evidence sets, warnings and predecessor identities are retained. Three repeated
texts with different evidence remain outside this bounded exact-copy fix.
No transcript-specific rule, semantic threshold or provider configuration changes.
