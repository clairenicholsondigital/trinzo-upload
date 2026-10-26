# Preserve explicitly requested wording during semantic action merges

## Proven application gap

A deterministic reproduction supplies two actions: one requires the word `caution`, the other substitutes `warning`. With positive model comparison and source-review responses, the previous semantic engine nominates the pair, merges to the second action and issues a valid receipt. The owner's instruction in the source actually requires `caution`. Structural accounting and real source quotations alone do not catch a mistaken model retention verdict.

The normal deterministic duplicate helpers already reject this mismatch. The gap is the semantic path that can accept a model-supported paraphrase despite the missing literal content. The correction belongs there; shared duplicate helpers and other pages are unchanged.

## Bounded correction

`meetingMinutesLiteralWording` recognizes explicit positive constructions using “use/using/include/including the word/term”, and quoted “phrase” constructions. It checks the requested content in the actual target action text, using the existing prose conventions of Unicode normalization, apostrophe/whitespace normalization and case folding. Unicode word boundaries prevent a word being satisfied by a longer word. This is a necessary spelling/content check, not a byte-format or semantic-equivalence proof.

A semantic survivor that omits the recognized literal content is blocked with `required_literal_wording_would_be_lost`. The same check applies when validating existing semantic receipts, so final preservation cannot trust a receipt for this exact unsafe removal. Ordinary receipts and receipts for a genuine word/term paraphrase remain valid. Packet/facet schemas, nomination families and budgets are unchanged; no blanket certificate migration occurs.

The guard does not infer source-to-task relationships, generate new work, replace words, approve a merge, or add review notices. It does not require ordinary action verbs to match literally. Owners, recipients, timing, quantities, conditions, source support, complete-clause coverage and kept/reviewer-authored protections remain mandatory. Merely finding the requested word in a different context does not establish semantic retention.

Unknown bare multiword phrase boundaries, anaphoric references, unclosed quotations and negated/prohibited word use remain outside this positive recognizer and with the existing conservative checks. This work does not claim complete coverage of every natural-language wording instruction.

## Validation

Seven new tests cover the unsafe full merge, a lost quoted phrase, blocked nomination, safe same-word paraphrase with receipt revalidation, Unicode boundaries, quoted apostrophes and conservative grammar boundaries. Existing source-verification tests also pass (40 targeted tests in total).

A separate compatibility replay generates receipts under the previous implementation. The unsafe changed-word receipt is now invalid; a valid required-word receipt and an ordinary paraphrase receipt still validate and merge. Across all five saved drafts, all 1,083 ordered action comparisons retain their previous results. These are preserved-output checks, not a fresh transcript run or evidence of fewer visible duplicates.

## Further source and correction research

The saved council case loses an explicit word before semantic action deduplication: action discovery omits it; deterministic source candidates retain both the full source sentence and a separate literal-word clause; the final writable action still lacks it. Microsoft later proposes adding the word during completeness checking, but also rephrases the original instruction. The application rejects that proposal for changing original work. A replay that keeps the original wording accepts the literal addition, but the existing timing check then withholds the previous timing pending revalidation. That boundary is not bypassed in this release. No original draft or date was edited.

The new guard cannot recover a requirement already absent from both original actions. Nor does it make an omitted supporting photo “implied” by a letter. The source-only semantic prototype remains held in draft PR #155.

A useful next boundary is exact source-focus spans. All 138 member occurrences across the 30 saved unresolved groups have a unique verbatim focus in their referenced source unit. The current prototype passes only member/unit IDs after excluding generated descriptions, losing the distinction between a whole turn and a particular clause within that turn. An exact span can preserve that distinction without treating a generated paraphrase as source evidence. Four member occurrences in two groups specifically include the literal-word requirement. Future work must validate exact focus offsets against the full source, keep antecedents/negation/withdrawals, and avoid applying a neighbouring task's wording requirement to another operation. Elliptical supporting work still needs its own source/operation proof.

Private reproduction, stage trace, correction/timing replay, compatibility results and release artifacts are retained in `/root/trinzo-required-literal-wording-results-20261026`.
