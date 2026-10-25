# Generated candidate/original filing aliases

`MEETING_MINUTES_AGENT_FILING_ALIASES_V1=1` captures `filingAliases:true` for new
meeting-minutes agent generations. Legacy and resumed workflows without that
captured policy retain the old behaviour. Existing library drafts are not edited.

An early supporting-candidate handoff can retain an uncited candidate envelope
under its candidate ID when an explicit target fails the subject safeguard. A
later organiser handoff can retain the same original record, now cited, under
its original record ID. Normalization correctly protects the first envelope's
unknown/noncanonical shape; ordinary filing deduplication correctly refuses to
merge different IDs and evidence. The missing operation was reconciliation of
these proven aliases at the generated handoff boundary.

The new agent-only operation requires all of the following:

- A unique known staged candidate with a unique nested original-record identity;
  both discovery evidence lists must be empty and neither record may be edited.
- Exactly one candidate filing row and one original filing row, with identical
  full text, original topic and warning IDs; both must be generated leaves.
- The exact recorded early candidate envelope, including all nested metadata,
  must equal the known ledger projection. The late raw handoff must retain the
  same cited original. Unrecognized metadata and descendants prevent admission.
- The original's existing citations must resolve to unique nonempty source units.
  No citations are copied into the uncited alias or invented from text similarity.
- Only the known `explicit_target_subject_mismatch` / `no_subject_match` handoff
  pair is eligible. Existing filing state and IDs already in Discussion are
  protected; changed text, warnings, origin or ambiguous identities retain both.

At most three pairs are reconciled. The cited record survives unchanged in text,
identity, citations and warning links, with both filing origins and predecessor
history. Merge protection is retained on the survivor. A private, bounded
`qualityState.discussion.filingAliasReconciliation` archive preserves both exact
filing rows, the candidate and both complete raw handoffs. The archive bypasses
prose normalization and is excluded from public draft projection. Restore
requires exact current rows and source hashes; it cannot overwrite reviewer edits.
Archive-capacity overflow keeps all original rows rather than truncating history.

Exact offline replay of the recorded workflows qualified Parking (15 filing rows
to 12) and Allotment (20 to 19), with unchanged main Discussion and warnings.
All original rows restore exactly. Other frozen outputs have no matching
candidate/original pair. Payload serialization, filing/promotion normalization,
warning preservation and plain/evidence Word/PDF export are checked separately.
No Microsoft rules or other application pages are changed. This closes a bounded
structural duplicate class, not broader semantic repetition or filing placement.
