import unittest
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from meeting_minutes_final_colab import apply_real_transcript_coverage_guardrails
from meeting_minutes_trooper import (
    apply_long_transcript_recovery,
    transcript_local_action_evidence,
)


REPO_DIR = Path(__file__).resolve().parents[1]


class MeetingMinutesRecoveryGroundingTest(unittest.TestCase):
    def test_local_action_evidence_rejects_disconnected_keywords(self):
        transcript = """
Alex: The risk management file was background material.
Several unrelated topics were discussed for twenty minutes.
Priya: A USB demonstration used a screen on Wednesday.
Further unrelated discussion followed.
Morgan: The port lock was replaced last year and the GUI security work was already complete.
"""
        self.assertEqual(
            transcript_local_action_evidence(
                transcript,
                ("risk management file", "rsk mgmt file"),
                "usb port lock",
                "gui security",
            ),
            "",
        )

    def test_action_table_recovery_requires_one_local_evidence_window(self):
        transcript = """
Next steps
Actions Owner Deadline
Update Rsk Mgmt file addressing USB port lock and GUI security
controls - Review competitor controls
Rebecca 22nd June '26
"""
        evidence = transcript_local_action_evidence(
            transcript,
            ("risk management file", "rsk mgmt file"),
            "usb port lock",
            "gui security",
        )
        self.assertIn("Update Rsk Mgmt file", evidence)
        self.assertIn("Rebecca 22nd June", evidence)

    def test_abbott_fixture_does_not_receive_eakin_recovery_action(self):
        transcript = (REPO_DIR / "scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript/transcript.txt").read_text(encoding="utf-8")
        output = apply_long_transcript_recovery({"discussionPoints": [], "decisions": [], "actions": []}, transcript)
        actions = "\n".join(item.get("meetingActionPoint", "") for item in output.get("actions", []))
        self.assertNotIn("USB port lock", actions)
        self.assertNotIn("mute button", actions)

    def test_real_eakin_minutes_table_keeps_grounded_usb_action(self):
        transcript = (REPO_DIR / "scripts/meeting-minutes-final-golden/022_real_eakin_sw_minutes_pdf/transcript.txt").read_text(encoding="utf-8")
        output = apply_long_transcript_recovery({"discussionPoints": [], "decisions": [], "actions": []}, transcript)
        actions = "\n".join(item.get("meetingActionPoint", "") for item in output.get("actions", []))
        self.assertIn("USB port lock and GUI security controls", actions)

    def test_colab_guardrail_does_not_create_eakin_actions_for_abbott(self):
        transcript = (REPO_DIR / "scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript/transcript.txt").read_text(encoding="utf-8")
        output = apply_real_transcript_coverage_guardrails(
            {
                "discussionPoints": [],
                "decisions": [],
                "meetingObjectives": [],
                "meetingActionPoint": [],
                "meetingActionPointOwner": [],
                "meetingActionPointDeadline": [],
                "actions": [],
            },
            transcript,
        )
        actions = "\n".join(output.get("meetingActionPoint", []))
        self.assertNotIn("USB port lock", actions)
        self.assertNotIn("mute button", actions)

    def test_colab_raw_transcript_recovery_does_not_invent_owner_or_deadline(self):
        transcript = """
Rebecca Cuckoo 23:08
I am updating the risk management file to cover the USB port lock and GUI controls.
I will share the updated file on Wednesday.
"""
        output = apply_real_transcript_coverage_guardrails(
            {
                "discussionPoints": [],
                "decisions": [],
                "meetingObjectives": [],
                "meetingActionPoint": [],
                "meetingActionPointOwner": [],
                "meetingActionPointDeadline": [],
                "actions": [],
            },
            transcript,
        )
        self.assertEqual(output["meetingActionPointOwner"], [""])
        self.assertEqual(output["meetingActionPointDeadline"], ["Not specified"])


if __name__ == "__main__":
    unittest.main()
