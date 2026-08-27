import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "meeting_minutes_usefulness_classifier.py"
SPEC = importlib.util.spec_from_file_location("usefulness_classifier", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UsefulnessClassifierTests(unittest.TestCase):
    def test_parser_preserves_speaker_and_timestamp(self):
        rows = MODULE.parse_transcript(
            "Jacqui Fox   0:03Perfect and I will share the risk plan.\n"
            "Smith, Stuart M   0:08Yep. And the deadline is Friday.\n",
            "example",
        )
        self.assertEqual(rows[0]["speaker"], "Jacqui Fox")
        self.assertEqual(rows[0]["timestamp"], "0:03")
        self.assertIn("risk plan", rows[0]["text"])
        self.assertEqual(rows[1]["speaker"], "Smith, Stuart M")
        self.assertEqual(rows[1]["timestamp"], "0:08")

    def test_bootstrap_is_conservative(self):
        self.assertEqual(MODULE.bootstrap_label("Okay, thanks." )[0], "remove")
        self.assertEqual(MODULE.bootstrap_label("We agreed to review the risk plan by Friday.")[0], "retain")
        self.assertEqual(MODULE.bootstrap_label("The team discussed the current position in detail.")[0], "uncertain")

    def test_noise_is_not_allowed_to_be_deleted_without_high_confidence(self):
        self.assertEqual(MODULE.bootstrap_label("I cannot hear you, can you unmute?")[0], "remove")

    def test_transcription_markers_and_physical_interruptions_are_noise(self):
        self.assertEqual(MODULE.bootstrap_label("Sorry, I was going to sneeze there.")[0], "remove")
        self.assertEqual(MODULE.bootstrap_label("Jacqui Fox stopped transcription")[0], "remove")
        rows = MODULE.parse_transcript("Jacqui Fox 0:03 We should review the plan.\nJacqui Fox stopped transcription\n")
        self.assertEqual(len(rows), 1)

    def test_marker_free_render_removes_speaker_and_time_markers(self):
        rows = [
            {"speaker": "Rebecca Cuckoo", "timestamp": "33:30", "text": "The risk remains under review."},
            {"speaker": "Andrew Kane", "timestamp": "34:06", "text": "I will check the test result."},
        ]
        rendered = MODULE.render_marker_free_transcript(rows)
        self.assertEqual(rendered, "The risk remains under review.\n---\nI will check the test result.")
        self.assertNotIn("Rebecca Cuckoo", rendered)
        self.assertNotIn("34:06", rendered)


if __name__ == "__main__":
    unittest.main()
