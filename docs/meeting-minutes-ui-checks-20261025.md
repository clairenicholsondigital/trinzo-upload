# Meeting Minutes Agent UI check correction

The two previously reported baseline failures did not reproduce as production defects. This change only updates browser tests; page HTML, JavaScript, styles, generation policies and stored drafts remain unchanged.

## Scroll restoration

The original test scrolls to 220px and uses Playwright `click` on an off-screen step tab. Playwright scrolls that button into view before pointerdown; the recorded departure position is therefore 0, correctly restored by the app. Event tracing confirms this order. Native keyboard activation with `focus({preventScroll:true})` restores 220px without a production change.

The repaired test uses wheel scrolling and native Enter activation to exercise reading-position restoration, then separately scrolls back to the visible tabs and clicks to verify that the actual departure position of zero wins. It retains transcript-panel persistence and the separate in-flight autosave navigation check.

## Compact mobile layout

The 390px fixture toolbar is 336.81px wide, including border and horizontal padding. Its content area is 309.21px; the action controls fill that area. The old comparison incorrectly required the controls to fill the outer border box. The replacement checks both usable-content edges within the original 2px tolerance for Discussion and Actions. Existing control-width, alignment, overflow, transcript, regeneration and final-save assertions remain.

The previously unreachable 180px short-action-row cap also predates the current Source controls and owner/timing summaries. The natural row is 181.30px, with no clipping. The replacement bounds the short fixture to 12 root-font units and explicitly checks that action text is fully visible. It does not change production spacing or shrink controls to satisfy the old pixel cap.

## Validation and release

The complete browser suite passes: 65 tests, zero failures or skips. Private mutation checks confirm that disabling real scroll restoration fails the repaired scroll test and reducing the toolbar controls to 80% width fails the repaired mobile test. A third negative control confirms a 25rem action row fails the font-relative compactness limit. These negative controls are local artifacts only, never shipped.

This is a test-only release. No process restart, cache reset, Microsoft request or draft regeneration is needed. It closes two inaccurate baseline test reports; it does not claim additional generated-minutes quality improvements.
