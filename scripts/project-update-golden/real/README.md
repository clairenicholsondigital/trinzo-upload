# Real project-update golden cases

`001_realistic_cases.json` contains two **realistic-synthetic** cases, not actual client
transcripts (none were available to add here — genuine client data should only ever be added
after anonymisation/sanitisation and with appropriate approval). They're written to be messier
and more true-to-life than the AI-generated `synthetic/cases.json` set: informal phrasing, false
starts, interruptions, a risk raised conversationally rather than as a formal statement, and a
case with pre-existing stored context to verify a milestone the meeting never mentions still
gets carried forward instead of silently dropped.

**Known limitation:** milestone/risk semantic matching depends on the MiniLM backend
(`sentence-transformers`). In an environment without it installed, `find_by_label` can't match
these cases' invented milestone/risk names against the rule-based extractor's output, so several
checks report as `WARN` rather than a hard pass — this is a property of the runtime, not a bug in
the fixtures. `real_002`'s `shouldBeCarriedForward` milestone check is MiniLM-independent and
verified to genuinely fail if the carry-forward logic breaks. Run with the MiniLM backend
installed (drop `--skip-minilm`) for full validation, and add genuine anonymised client examples
here over time using the same case shape.
