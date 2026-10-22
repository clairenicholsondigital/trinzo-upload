import contextlib
import io
import json
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import meeting_minutes_usefulness_classifier as usefulness
import staged_simplified_minilm as staged
from staged_trooper_chunk_pipeline import numbered_turns


class RemoveProbabilities(list):
    def argmax(self):
        return 0


class ShortTemporalFragmentTests(unittest.TestCase):
    def parse(self, text, enabled=True):
        return usefulness.parse_transcript(
            text, "generic", preserve_short_temporal_fragments=enabled
        )

    def test_short_dates_durations_and_qualifications_remain_complete(self):
        examples = [
            "Tomorrow.", "Friday.", "This week.", "Next month.", "Next Friday morning.",
            "28 November.", "July 28, 2027.", "The 20th.", "2027-07-28.", "28/07/2027.",
            "14:30.", "2pm.", "Five days.", "Three to four weeks.", "2–3 weeks.", "Two working days.",
            "A few days.", "Summer.", "In summer only.", "Not Wednesday.",
            "Not this week.", "Not before Friday.", "Probably early next week.",
            "No more than five days.", "Wednesday, unless approved.", "Friday if she agrees.",
            "Oh, probably Friday.", "Not, not Friday.", "End of next month.",
        ]
        for phrase in examples:
            with self.subTest(phrase=phrase):
                rows = self.parse(f"Morgan Hale 0:12 {phrase}\n")
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["text"], phrase)
                self.assertEqual(rows[0]["speaker"], "Morgan Hale")
                self.assertEqual(rows[0]["timestamp"], "0:12")
                self.assertIs(rows[0]["shortTemporalFragment"], True)

    def test_non_temporal_short_values_do_not_gain_protection(self):
        examples = [
            "Yes.", "No.", "Okay, thanks.", "Five people.", "6 litres.", "2027.",
            "Version 1.02.", "ISO 27427.", "One bar.", "400 pounds.", "The deadline.",
            "May I?", "3 of 17.", "Can you hear me?", "I need to sneeze.",
        ]
        for phrase in examples:
            with self.subTest(phrase=phrase):
                rows = self.parse(f"Morgan Hale 0:12 {phrase}\n")
                self.assertFalse(any(row.get("shortTemporalFragment") for row in rows))
                if len(re.findall(r"[A-Za-z0-9']+", phrase)) < 3:
                    self.assertEqual(rows, [])
        self.assertFalse(usefulness.is_short_temporal_fragment("Hopefully probably by early next Friday."))

    def test_defaults_and_explicit_false_preserve_old_parser_output(self):
        transcript = (
            "Morgan Hale 0:12 I will review the proposed plan.\n"
            "Sam Lee 0:13 Next week.\n"
            "Morgan Hale 0:14 Probably early next week.\n"
            "Sam Lee 0:15 Thank you.\n"
        )
        original = usefulness.parse_transcript(transcript, "generic")
        self.assertEqual(original, self.parse(transcript, enabled=False))
        self.assertEqual([row["text"] for row in original], [
            "I will review the proposed plan.", "Probably early next week."
        ])
        self.assertFalse(any("shortTemporalFragment" in row for row in original))

    def test_orphan_and_other_speaker_fragments_are_not_attached_to_work(self):
        transcript = (
            "Morgan Hale: Probably Friday.\n"
            "Sam Lee: I will review the proposed plan.\n"
            "Jordan Park: Not tomorrow.\n"
        )
        rows = self.parse(transcript)
        self.assertEqual([(row["speaker"], row["text"]) for row in rows], [
            ("Morgan Hale", "Probably Friday."),
            ("Sam Lee", "I will review the proposed plan."),
            ("Jordan Park", "Not tomorrow."),
        ])
        self.assertTrue(all("action" not in row and "owners" not in row and "timing" not in row for row in rows))

    def test_same_turn_short_qualifications_and_cancellations_are_not_detached(self):
        for phrase in [
            "No. Wednesday.", "Maybe. Friday.", "Not confirmed. Wednesday.",
            "Wednesday. Cancelled.", "Friday. Changed my mind.", "Friday. This was cancelled.",
            "That is provisional. Wednesday.", "We need approval. Friday.",
        ]:
            with self.subTest(phrase=phrase):
                rows = self.parse(f"Morgan Hale 0:12 {phrase}\n")
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["text"], phrase)
                self.assertTrue(rows[0]["shortTemporalFragment"])
                result = staged.classify_source_rows(rows, None, ["remove", "retain"], 0.85)
                self.assertEqual(result[0]["classification"], "uncertain")
                self.assertEqual(result[0]["cleanedText"], phrase)

    def test_longer_ambiguous_same_turn_keeps_old_parsing_without_new_bare_date(self):
        transcript = "Morgan Hale 0:12 Not confirmed. Wednesday. We have not agreed the schedule.\n"
        rows = self.parse(transcript)
        self.assertEqual(rows, self.parse(transcript, enabled=False))
        self.assertFalse(any(row["text"] == "Wednesday." for row in rows))

    def test_confident_model_removal_and_heuristic_fallback_both_fail_open(self):
        rows = self.parse(
            "Morgan Hale 0:12 Oh, probably Friday.\n"
            "Sam Lee 0:13 Not, not Friday.\n"
            "Jordan Park 0:14 Wednesday, unless approved.\n"
        )
        for probabilities in [None, [RemoveProbabilities([0.999, 0.001]) for _ in rows]]:
            with self.subTest(fallback=probabilities is None):
                classified = staged.classify_source_rows(rows, probabilities, ["remove", "retain"], 0.85)
                self.assertEqual([row["classification"] for row in classified], ["uncertain"] * 3)
                self.assertEqual([row["id"] for row in classified], ["T0001", "T0002", "T0003"])
                self.assertEqual([row["cleanedText"] for row in classified], [row["text"] for row in rows])
                prepared = staged.render_full_name_clean_transcript(classified)
                self.assertIn("Morgan Hale: Oh, probably Friday.", prepared)
                self.assertIn("Sam Lee: Not, not Friday.", prepared)
                self.assertIn("Jordan Park: Wednesday, unless approved.", prepared)

    def test_non_agent_classification_and_speech_cleaning_stay_unchanged(self):
        rows = self.parse("Morgan Hale 0:12 Oh, probably Friday.\n", enabled=False)
        result = staged.classify_source_rows(rows, None, ["remove", "retain"], 0.85)
        self.assertEqual(result[0]["classification"], "remove")
        self.assertEqual(result[0]["cleanedText"], "probably Friday.")

    def test_next_stage_numbering_preserves_short_qualified_units_and_source_order(self):
        prepared = (
            "[T0001] Morgan Hale 0:12: I will review the proposed plan.\n"
            "[T0002] Sam Lee 0:13: No. Wednesday.\n"
            "[T0003] Jordan Park 0:14: Oh, probably Friday.\n"
        )
        turns, numbered = numbered_turns(prepared)
        self.assertEqual(turns, prepared.strip().splitlines())
        self.assertEqual([re.match(r"\[(T\d+)\]", line).group(1) for line in turns],
                         ["T0001", "T0002", "T0003"])
        self.assertIn("[2] [T0002] Sam Lee 0:13: No. Wednesday.", numbered)
        self.assertIn("[3] [T0003] Jordan Park 0:14: Oh, probably Friday.", numbered)

    def test_cli_serializes_exact_fragments_in_order_with_stable_source_ids(self):
        transcript = (
            "Morgan Hale 0:12 I will review the proposed plan.\n"
            "Sam Lee 0:13 Oh, probably Friday.\n"
            "Jordan Park 0:14 Not before Monday.\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "generic.txt"
            path.write_text(transcript, encoding="utf-8")
            classifier = types.SimpleNamespace(classes_=["remove", "retain"])
            modules = {
                "joblib": types.SimpleNamespace(load=lambda _path: {
                    "embedding_model": "offline", "classifier": classifier
                }),
                "numpy": types.SimpleNamespace(),
            }
            output = io.StringIO()
            with mock.patch.dict(sys.modules, modules), mock.patch.object(
                sys, "argv", ["staged", str(path), "--model", "unused", "--preserve-short-temporal-fragments"]
            ), mock.patch.object(staged, "remote_embedding_matrix", return_value=None), mock.patch.dict(
                "os.environ", {"MINUTES_MINILM_WORKER_URL": "offline-no-network"}
            ), contextlib.redirect_stdout(output):
                self.assertEqual(staged.main(), 0)
            result = json.loads(output.getvalue())
        units = result["sourceUnits"]
        self.assertEqual([(unit["id"], unit["speaker"], unit["timestamp"], unit["text"]) for unit in units], [
            ("T0001", "Morgan Hale", "0:12", "I will review the proposed plan."),
            ("T0002", "Sam Lee", "0:13", "Oh, probably Friday."),
            ("T0003", "Jordan Park", "0:14", "Not before Monday."),
        ])
        self.assertEqual([unit["classification"] for unit in units[1:]], ["uncertain", "uncertain"])
        self.assertIn("Sam Lee: Oh, probably Friday.", result["preparedTranscript"])
        self.assertEqual(result["totalUnitCount"], 3)


if __name__ == "__main__":
    unittest.main()
