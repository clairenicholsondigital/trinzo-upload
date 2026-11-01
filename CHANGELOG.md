# Changelog

One line per change in behaviour, newest first. Detail belongs in the PR, not here.

| Date | Change | PR |
| --- | --- | --- |
| 2026-11-01 | Add optional private live-runtime checks and an isolated testing-site sync command; testing pauses on code/configuration drift while normal site behaviour stays unchanged. | — |
| 2026-11-01 | Beta distinguishes Microsoft service failures from unreadable replies, keeps bounded correlation details private, and shows current section failures on Details and after reload without adding retries. | — |
| 2026-11-01 | Beta retries a section once after malformed JSON within its existing time budget, keeps checked sections, and identifies retries in the progress panel; safe response-shape diagnostics remain private. | [#241](https://github.com/clairenicholsondigital/trinzo-upload/pull/241) |
| 2026-11-01 | Beta shows checked Summary, Discussion and Actions previews as each arrives, then opens the saved draft; early previews stay read-only and out of prints, saves and downloads. | [#240](https://github.com/clairenicholsondigital/trinzo-upload/pull/240) |
| 2026-11-01 | Clarified action Due captions and made better use of phone width in the document editor, keeping Finalised controls accessible and editing controls out of print. | [#238](https://github.com/clairenicholsondigital/trinzo-upload/pull/238) |
| 2026-11-01 | Added safe API progress snapshots for Original/Beta generation using the existing status endpoint, with no frontend changes or changes to generation results and retry policy. | [#239](https://github.com/clairenicholsondigital/trinzo-upload/pull/239) |
| 2026-11-01 | Processed minutes open as one editable document with shared menus, transcript and checks drawers, structured action controls, and explicit Preview/Finalise/Reopen states; existing step editing remains under Edit structure. | [#237](https://github.com/clairenicholsondigital/trinzo-upload/pull/237) |
| 2026-11-01 | Added a GitHub Actions check that runs `npm test` on every PR, house rules for AI helpers in `AGENTS.md`, and stopped tracking `agent.log` and MiniLM comparison outputs. | [#236](https://github.com/clairenicholsondigital/trinzo-upload/pull/236) |
