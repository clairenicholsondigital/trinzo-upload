# Meeting Minutes Tool — Conor Status Log

_Last updated: 2026-07-29_

## Purpose

This file records the current status of the Trinzo Meeting Minutes work in a way that is useful for client-facing updates with Conor. It is not intended to be a full engineering changelog; it captures what has been discussed, what has changed, known limitations, and the current interpretation of issues raised during review.

## Current client-facing status

The Meeting Minutes tool is live behind the authenticated Trinzo site and currently uses the queued job workflow for normal uploads. The current workflow is:

1. User uploads or pastes a transcript at `/meeting-minutes-final`.
2. The transcript is queued as a background job.
3. A worker processes the transcript and generates draft minutes.
4. The completed job appears on the job result page for review/editing.
5. The reviewer can save edits, copy the table text, export PDF, or inspect advanced/debug information if needed.

Recent work has focused on making the output and review process more reliable for longer or less straightforward transcripts, and making the generated results easier to edit before sharing.

## Recent UI updates shared with Conor

The following usability improvements have been made following discussion/review:

- Restored the **Export PDF** button on the generated Meeting Minutes job result page.
- Added an **Expand** button for generated result rows, opening the row content in a larger editable pop-up/modal.
- Moved secondary/debug information into quieter advanced sections so the main review page is less cluttered.
- Removed redundant navigation/actions from the result page.
- Hid less-useful technical/detail columns from the main table while keeping the information available in the expanded row editor.
- Made the **Topic** field a multi-line editor so it is easier to read and adjust.
- Collapsed **Terms for review** by default so it does not dominate the result page.
- Improved login persistence so routine deploys/restarts should not keep logging users out.

Overall, these changes should make the editing experience smoother, particularly for longer meeting outputs.

## Webinar preparation transcript issue

A webinar preparation transcript was reviewed after it produced poor meeting-minutes output.

The current assessment is that the issue is not that the Meeting Minutes tool is inherently unable to handle webinar-planning meetings. The extraction logic is not hard-coded to a specific meeting type; it relies heavily on the language present in the transcript to determine what looks like a decision, action, discussion point, risk, dependency, or term for review.

In this specific case, the transcript contained very little explicit action language. It was primarily a discussion about potential webinar/content themes and programme sequencing, rather than a meeting where people were clearly assigning tasks or confirming decisions.

Useful examples from the transcript:

- “It’s a great topic to address.”
  - This reads as a potential content/theme discussion rather than an action.
- “November one will be, is your AI vendor an approved supplier?”
  - On first reading this can look like a deadline, but in context it appears more likely to mean “the November topic/session will be…”, rather than assigning work to someone.
- “Would we not want to put that as the first one in September?”
  - This sounds like sequencing topics in a programme/calendar, not allocating an action. The current extraction does not know what “first one” refers to without stronger context.

Other phrases in the transcript are also more thematic than action-oriented:

- “validation, or whatever we want to call it”
- “EU AI Act as a governance drive”
- “scope for AI use”
- “approved supplier”

These describe concepts or topics rather than concrete decisions or actions.

### Additional finding

The stored transcript for the reviewed job appeared incomplete. It began shortly after the transcript was turned on and jumped from approximately `1:26` to `30:30`, meaning the tool only received a fragment of the conversation rather than the full planning discussion.

That matters because the missing middle section may have contained context that would have helped the tool understand that the conversation was about webinar/topic planning.

## Why the output went wrong

The poor output was caused by a combination of factors:

1. **Fragmentary transcript input**
   - The tool can only process the transcript text it receives. In this case, the saved transcript was short and had a large timestamp gap.

2. **Weak meeting-type signals**
   - The transcript did not explicitly contain terms such as “webinar”, “slides”, “audience”, or “presentation”.
   - The planning context was only inferable in hindsight.

3. **Formal-minutes bias in the output schema**
   - The current schema expects structured minutes: objectives, discussion points, actions, decisions, risks/issues, dependencies, and terms for review.
   - For a topic-planning conversation, the better output may be a topic map or planning summary rather than formal meeting minutes.

4. **Ambiguous date/topic language**
   - Phrases such as “November one” and “first one in September” were interpreted too much like deadlines/actions rather than possible webinar or content-schedule references.

## Better expected behaviour for this type of transcript

For a transcript like this, the tool should be more cautious. A better result would say something closer to:

- This appears to be a partial discussion-led planning transcript.
- Few or no explicit actions were clearly stated.
- Dates may refer to content/session sequencing rather than task deadlines.
- The useful output is likely a list of potential topics/themes and open questions, not a formal action list.

Possible topic/theme output from this transcript:

- Defining or framing “AI validation”.
- How traditional validation differs from AI output validation.
- Regulatory comfort with AI terminology.
- EU AI Act as a governance driver.
- AI vendor approval / approved supplier status.
- Scope for AI use across project/service-provider work.

## Current improvement status

The tool now includes a conservative pre-router before generation. This is not a broad meeting classifier; it only catches high-confidence failure patterns such as partial transcripts, large timestamp gaps, very low-substance/audio-check input, and webinar/content-planning language.

Implemented improvements:

1. **Selective meeting/transcript routing before extraction**
   - The generator now identifies obvious partial, gappy, low-substance, and topic-planning transcripts before asking the AI to produce minutes.

2. **Partial transcript and timestamp-gap detection**
   - Cues such as “I just turned on the transcript” and large timestamp gaps are detected and passed into the generation prompts/diagnostics.

3. **Cautious topic-summary mode**
   - For partial webinar/content-planning style transcripts, the tool now avoids forcing formal action-heavy minutes and treats dates/session references cautiously.

4. **Deterministic safety gate**
   - Even if generation fails or tries to over-extract, cautious modes remove weak actions/decisions and add a transcript-quality caveat rather than inventing deadlines or owners.

Still worth improving next:

- Make the caution/routing note more visible in the review UI, rather than mostly in diagnostics/summary text.
- Improve discussion/topic summaries for partial planning transcripts so the output is more useful even when actions and decisions are correctly empty.
- Continue improving the full golden suite for long formal transcripts, where the issue is missed content rather than over-extraction.

## Current caveat for Conor/client use

The tool should be treated as a draft-assist/review tool rather than an automated final-minute generator. It is improving, but meeting transcripts still need human review, especially when:

- the transcript is incomplete;
- the meeting is discussion-led rather than action-led;
- dates are mentioned as part of topic scheduling rather than deadlines;
- people use shorthand that only makes sense with prior context.

The current direction is to make the tool more transparent and conservative in those cases, so it produces useful draft material without over-stating actions or decisions.

## Internal implementation notes

Recent relevant commits include:

- `54ecc25` — added chunked meeting-minutes generation pipeline.
- `402f990` — added compact verifier for chunked minutes.
- `6570c71` — used MiniLM evidence pack in chunked fallback.
- `4dcad8d` — restored PDF export for meeting-minutes jobs.
- `9a23642` — added expanded row editor to meeting-minutes jobs.
- `f28db76` — simplified visible meeting-minutes result columns.
- `bccb0ca` — moved debug tools into advanced section.
- `d71b501` — removed redundant job-detail button.
- `c02e3b3` — moved evidence/source note into expanded row editor.
- `48e481e` — collapsed terms-for-review section.
- `195fd0f` — persisted auth sessions across deploys.
- `e383d6a` — made topic fields multi-line in meeting-minutes result rows.
