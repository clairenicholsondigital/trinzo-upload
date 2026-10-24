# Delivery timing preservation

A meeting-minutes delivery bundle must not append a second version of an inline
condition merely because the timing checker calls it a target or deadline rather
than a dependency. The bundler now refuses synthesis when an action contains an
inline before/after/when/once/following/until/by/as-soon-as clause and separately
stated timing is not literally present in that action. An exact date without
wording also refuses synthesis for an already conditional instruction.

This guard is local to `bundleSameRecipientDeliveries`. It does not alter the
shared dependency parser, action identity, timing validation or semantic merging.
Refused actions retain their original wording, owners, timing, evidence, flags
and history. Other safe deliveries may still bundle. Literal inline timing is
not appended twice. No recipient or pronoun is inferred.

This fixes manufactured repeated timing in these bounded delivery forms. It does
not repair already saved combined sentences, certify their source accuracy, or
resolve wider action overlap. Normal public/save/export source-validation rules
still apply. Existing library drafts are not migrated.

Validation includes generic temporal-kind/condition/order cases, exact-date-only
refusals, positive safe bundles, preservation through publication projections,
regression checks and offline helper replay of all five saved transcript sets.
No transcript-specific production rules or provider changes are introduced.
