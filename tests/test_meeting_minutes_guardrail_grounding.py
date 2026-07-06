"""Cross-client contamination guards for the meeting-minutes-final guardrail layer.

The coverage guardrails in scripts/meeting_minutes_final_colab.py were authored
from specific real client transcripts. These tests pin the grounding gates that
stop their canned owners, deadlines, decisions and sentences leaking into a
different meeting that merely shares trigger keywords.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from meeting_minutes_final_colab import (  # noqa: E402
    _clean_action_owners,
    _deadline_is_grounded,
    _set_action,
    _transcript_grounding_ratio,
    apply_real_transcript_coverage_guardrails,
    enforce_quality_control,
)


LOOKALIKE_TRANSCRIPT = """
Priya Nair
This is our NovaMed Devices weekly regulatory catch-up.
Tomás Brennan
We still need an answer from the HPRA on the annual registration fee invoice
and the documentation trail, so I will chase their contact this week.
Saoirse Kelly
The client asked whether we would run a working session on the declaration of
conformity updates and the PPE classification question for the eyewear range.
Priya Nair
When you press the mute button the alarm silences but the indicator does not
update, so a clinical review of that behaviour is booked.
"""


def _empty_output() -> dict:
    return {
        "meetingTitle": "NovaMed regulatory catch-up",
        "discussionPoints": [],
        "decisions": [],
        "meetingActionPoint": [],
        "meetingActionPointOwner": [],
        "meetingActionPointDeadline": [],
        "actions": [],
        "nextSteps": [],
        "meetingMinutes": [{"topic": "Discussion", "discussionPoints": []}],
    }


class GuardrailGroundingTest(unittest.TestCase):
    def test_hardcoded_owner_is_dropped_when_not_in_transcript(self):
        output = _empty_output()
        _set_action(output, LOOKALIKE_TRANSCRIPT, ["hpra"], "Chase the HPRA contact for the registration fee invoice documentation.", "Jacqui", "Not specified")
        self.assertEqual(len(output["actions"]), 1)
        self.assertEqual(output["actions"][0]["meetingActionPointOwner"], "")

    def test_hardcoded_owner_is_kept_when_named_in_transcript(self):
        output = _empty_output()
        _set_action(output, LOOKALIKE_TRANSCRIPT, ["hpra"], "Chase the HPRA contact for the registration fee invoice documentation.", "Priya", "Not specified")
        self.assertEqual(output["actions"][0]["meetingActionPointOwner"], "Priya")

    def test_canned_action_with_ungrounded_content_is_not_injected(self):
        output = _empty_output()
        _set_action(output, LOOKALIKE_TRANSCRIPT, ["ppe"], "Confirm the PPE and sunglasses procedure scope with the client.", "Jacqui", "Not specified")
        self.assertEqual(output["actions"], [])

    def test_hardcoded_deadline_requires_transcript_support(self):
        self.assertFalse(_deadline_is_grounded("19th June", LOOKALIKE_TRANSCRIPT))
        self.assertFalse(_deadline_is_grounded("Wednesday/Thursday/Friday", LOOKALIKE_TRANSCRIPT))
        self.assertTrue(_deadline_is_grounded("Not specified", LOOKALIKE_TRANSCRIPT))
        self.assertTrue(_deadline_is_grounded("", LOOKALIKE_TRANSCRIPT))

    def test_guardrails_do_not_import_other_client_content_on_lookalike_meeting(self):
        report = apply_real_transcript_coverage_guardrails(_empty_output(), LOOKALIKE_TRANSCRIPT)
        blob = " ".join(
            str(value)
            for key in ("discussionPoints", "decisions", "meetingActionPoint", "meetingActionPointOwner", "meetingActionPointDeadline")
            for value in (report.get(key) or [])
        ).lower()
        for fabricated in ("jacqui", "cody", "rebecca", "john-paul", "hannah quinn", "med envoy", "sunglasses", "dublin", "authorised-representative", "authorised representative", "19th june", "26th june", "23rd july"):
            self.assertNotIn(fabricated, blob)

    def test_guardrails_keep_grounded_coverage_on_original_style_meeting(self):
        transcript = """
        Jacqui
        We need to set up working sessions with the client on Wednesday, Thursday and Friday,
        and cover whether PPE and sunglasses requirements belong in the procedures.
        John-Paul
        I will follow up internally on the declaration of conformity language requirements.
        """
        report = apply_real_transcript_coverage_guardrails(_empty_output(), transcript)
        owners = [owner.lower() for owner in report.get("meetingActionPointOwner") or []]
        self.assertIn("jacqui", owners)

    def test_slash_combined_owner_is_cleared_as_ambiguous(self):
        output = _empty_output()
        output["meetingActionPoint"] = ["Circulate the labelling checklist.", "Review the debug commands."]
        output["meetingActionPointOwner"] = ["Saoirse/Kelly", "Andrew/David"]
        output["meetingActionPointDeadline"] = ["Not specified", "Not specified"]
        output["actions"] = [
            {"meetingActionPoint": text, "meetingActionPointOwner": owner, "meetingActionPointDeadline": "Not specified"}
            for text, owner in zip(output["meetingActionPoint"], output["meetingActionPointOwner"])
        ]

        _clean_action_owners(output, LOOKALIKE_TRANSCRIPT)

        self.assertEqual(output["meetingActionPointOwner"], ["", ""])

    def test_action_hygiene_dedupes_and_caps(self):
        output = _empty_output()
        for _ in range(3):
            _set_action(output, LOOKALIKE_TRANSCRIPT, ["nomatchterm"], "Chase the HPRA contact for the registration fee invoice documentation.", "", "Not specified")
        report = apply_real_transcript_coverage_guardrails(output, LOOKALIKE_TRANSCRIPT)
        texts = [str(item).lower() for item in report.get("meetingActionPoint") or []]
        self.assertEqual(len(texts), len(set(texts)))
        self.assertLessEqual(len(texts), 6)


class QualityControlEnforcementTest(unittest.TestCase):
    def test_unsupported_item_is_removed_from_published_output(self):
        output = _empty_output()
        output["discussionPoints"] = ["The board approved the acquisition of a submarine fleet."]
        output["meetingMinutes"][0]["discussionPoints"] = list(output["discussionPoints"])
        qc = {"unsupportedItems": [{"type": "discussion", "text": output["discussionPoints"][0], "bestSimilarity": 0.01}]}
        cleaned, summary = enforce_quality_control(output, qc, LOOKALIKE_TRANSCRIPT)
        self.assertEqual(cleaned["discussionPoints"], [])
        self.assertEqual(cleaned["meetingMinutes"][0]["discussionPoints"], [])
        self.assertEqual(summary["removedCount"], 1)

    def test_transcript_grounded_item_survives_enforcement(self):
        grounded = "The HPRA registration fee invoice and documentation trail need an answer."
        output = _empty_output()
        output["discussionPoints"] = [grounded]
        qc = {"unsupportedItems": [{"type": "discussion", "text": grounded, "bestSimilarity": 0.1}]}
        cleaned, summary = enforce_quality_control(output, qc, LOOKALIKE_TRANSCRIPT)
        self.assertEqual(cleaned["discussionPoints"], [grounded])
        self.assertEqual(summary["removedCount"], 0)
        self.assertEqual(summary["keptCount"], 1)

    def test_flagged_action_removal_keeps_row_alignment(self):
        output = _empty_output()
        output["meetingActionPoint"] = ["Buy a llama for the office.", "Chase the HPRA contact about the invoice."]
        output["meetingActionPointOwner"] = ["", "Priya"]
        output["meetingActionPointDeadline"] = ["Not specified", "Not specified"]
        output["actions"] = [
            {"meetingActionPoint": text, "meetingActionPointOwner": owner, "meetingActionPointDeadline": "Not specified"}
            for text, owner in zip(output["meetingActionPoint"], output["meetingActionPointOwner"])
        ]
        qc = {"unsupportedItems": [{"type": "action", "text": "Buy a llama for the office.", "bestSimilarity": 0.02}]}
        cleaned, summary = enforce_quality_control(output, qc, LOOKALIKE_TRANSCRIPT)
        self.assertEqual(summary["removedCount"], 1)
        self.assertEqual(cleaned["meetingActionPoint"], ["Chase the HPRA contact about the invoice."])
        self.assertEqual(cleaned["meetingActionPointOwner"], ["Priya"])

    def test_grounding_ratio_ignores_function_words(self):
        ratio = _transcript_grounding_ratio(
            "Confirm the PPE and sunglasses procedure scope with the client.",
            LOOKALIKE_TRANSCRIPT.lower(),
        )
        self.assertLess(ratio, 0.65)


if __name__ == "__main__":
    unittest.main()
