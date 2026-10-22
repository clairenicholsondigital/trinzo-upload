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


class Probabilities(list):
    def argmax(self):
        return max(range(len(self)), key=self.__getitem__)


class ShortContextFragmentTests(unittest.TestCase):
    def parse(self, text, enabled=True, temporal=True):
        return usefulness.parse_transcript(
            text, "generic", preserve_short_temporal_fragments=temporal,
            preserve_short_context_fragments=enabled,
        )

    def classified(self, text, probabilities=None, enabled=True):
        return staged.classify_source_rows(
            self.parse(text, enabled=enabled), probabilities, ["remove", "retain"], 0.85
        )

    def test_retained_sentence_keeps_exact_adjacent_non_temporal_prefix_and_suffix(self):
        transcript = "Morgan Hale 0:12 Conditional. We can approve the revised plan. Not confirmed.\n"
        rows = self.classified(transcript)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["text"], "We can approve the revised plan.")
        self.assertEqual(rows[0]["cleanedText"], "Conditional. We can approve the revised plan. Not confirmed.")
        self.assertEqual(rows[0]["classification"], "uncertain")
        self.assertEqual(rows[0]["id"], "T0001")
        self.assertIn("Morgan Hale: Conditional. We can approve", staged.render_full_name_clean_transcript(rows))

    def test_negation_and_qualification_are_not_treated_as_acknowledgement_noise(self):
        for fragment in ["No.", "Not approved.", "Not, not.", "Maybe.", "Provisional.", "(Not approved).", "No. Sorry.", "If approved.", "Only provisional.", "Will do.", "Do it.", "Could.", "All."]:
            with self.subTest(fragment=fragment):
                rows = self.classified(f"Morgan Hale: {fragment} We can publish the revised plan.\n")
                self.assertEqual(rows[0]["cleanedText"], f"{fragment} We can publish the revised plan.")

    def test_classifier_inputs_order_ids_and_decisions_do_not_change(self):
        transcript = (
            "Morgan Hale 0:12 Conditional. We will review the proposed plan tomorrow.\n"
            "Sam Lee 0:14 No. We can publish the revised plan.\n"
            "Jordan Park 0:16 We need to sneeze. Not approved.\n"
        )
        original = self.parse(transcript, enabled=False)
        rows = self.parse(transcript)
        for key in ["source", "line", "unit", "speaker", "timestamp", "text"]:
            self.assertEqual([row[key] for row in rows], [row[key] for row in original])
        for probabilities in [None, [Probabilities([0.01, 0.99]), Probabilities([0.2, 0.8]), Probabilities([0.99, 0.01])]]:
            with self.subTest(fallback=probabilities is None):
                before = staged.classify_source_rows(original, probabilities, ["remove", "retain"], 0.85)
                after = staged.classify_source_rows(rows, probabilities, ["remove", "retain"], 0.85)
                for key in ["id", "sequence", "classification", "confidence", "text", "restored"]:
                    self.assertEqual([row[key] for row in after], [row[key] for row in before])
                self.assertNotIn("Not approved.", staged.render_full_name_clean_transcript(
                    [row for row in after if row["classification"] != "remove"]
                ))

    def test_removed_adjacent_sentence_does_not_move_its_fragment_to_a_retained_neighbour(self):
        transcript = "Morgan Hale: We will review the proposed plan tomorrow. Conditional. This sentence is independently removed.\n"
        probabilities = [Probabilities([0.01, 0.99]), Probabilities([0.999, 0.001])]
        rows = self.classified(transcript, probabilities)
        self.assertEqual([row["classification"] for row in rows], ["retain", "remove"])
        prepared = staged.render_full_name_clean_transcript([row for row in rows if row["classification"] != "remove"])
        self.assertEqual(prepared, "Morgan Hale: We will review the proposed plan tomorrow.")

    def test_standalone_fragments_and_other_speakers_do_not_gain_rows_or_context(self):
        transcript = (
            "Morgan Hale 0:12 Conditional.\nSam Lee 0:13 We will review the proposed plan tomorrow.\n"
            "Jordan Park 0:14 No.\nMorgan Hale 0:15 Approved.\n"
        )
        rows = self.parse(transcript)
        self.assertEqual(rows, self.parse(transcript, enabled=False))
        self.assertEqual([(row["speaker"], row["text"]) for row in rows],
                         [("Sam Lee", "We will review the proposed plan tomorrow.")])

    def test_acknowledgements_audio_and_annotation_noise_are_not_restored(self):
        for fragment in ["Yes.", "Yeah, yeah.", "Okay, perfect.", "Thank you.", "Hello.", "Hi.", "Oh.", "Hold on.", "You're muted.", "[Laughter].", "(Laughter).", "Conditional. [Laughter].", "It is.", "And with.", "Could you?", "I see.", "Excellent.", "Wonderful.", "Oh dear.", "All right.", "Anyway.", "Oh, goodness.", "[Unintelligible].", "[Applause].", "[Crosstalk].", "Conditional. [Crosstalk].", "Thanks, Avery.", "Bye bye. Thanks, Jordan. Bye.", "Sorry. Carry on."]:
            with self.subTest(fragment=fragment):
                rows = self.classified(f"Morgan Hale: {fragment} We will review the proposed plan tomorrow.\n")
                self.assertEqual(rows[0]["cleanedText"], "We will review the proposed plan tomorrow.")
        # Mixed context and acknowledgement must stay contiguous, including
        # the filler, rather than deleting a qualification or inventing a quote.
        rows = self.classified("Morgan Hale: Conditional. Yeah. We will review the proposed plan tomorrow.\n")
        self.assertEqual(rows[0]["cleanedText"], "Conditional. Yeah. We will review the proposed plan tomorrow.")
        rows = self.classified("Morgan Hale: No. Hold on. We will review the proposed plan tomorrow.\n")
        self.assertEqual(rows[0]["cleanedText"], "We will review the proposed plan tomorrow.")

    def test_explicitly_noisy_retained_anchors_do_not_gain_context(self):
        for anchor in ["We cannot hear the caller through the microphone.", "The caller is [Unintelligible] but we can continue.", "We paused for (Laughter) before continuing the call."]:
            with self.subTest(anchor=anchor):
                transcript = f"Morgan Hale: Conditional. {anchor} Not approved.\n"
                probabilities = [Probabilities([0.4, 0.6])]
                before = self.classified(transcript, probabilities, enabled=False)
                after = self.classified(transcript, probabilities)
                self.assertNotEqual(after[0]["classification"], "remove")
                self.assertEqual(after[0]["cleanedText"], before[0]["cleanedText"])

    def test_context_runs_are_bounded_and_do_not_expose_unprotected_bare_dates(self):
        for fragment in ["Not confirmed. Wednesday.", "One item. Two items. Three items.", "The 18th, yeah.", "21st onwards.", "Friday, agreed."]:
            with self.subTest(fragment=fragment):
                transcript = f"Morgan Hale: {fragment} We have not agreed the revised plan.\n"
                rows = self.parse(transcript)
                self.assertEqual(rows, self.parse(transcript, enabled=False))
        for phrase in ["No. Wednesday.", "Friday. Changed my mind."]:
            with self.subTest(phrase=phrase):
                rows = self.parse(f"Morgan Hale: {phrase}\n")
                self.assertEqual(rows, self.parse(f"Morgan Hale: {phrase}\n", enabled=False))
                self.assertTrue(rows[0]["shortTemporalFragment"])
                self.assertEqual(staged.prepared_unit_text(rows[0]), phrase)

    def test_default_parser_and_disabled_option_are_identical(self):
        transcript = "Morgan Hale: Conditional. We will review the proposed plan tomorrow.\n"
        self.assertEqual(usefulness.parse_transcript(transcript, "generic"), self.parse(transcript, enabled=False, temporal=False))
        self.assertFalse(any("shortContextPrefix" in row or "shortContextSuffix" in row
                             for row in usefulness.parse_transcript(transcript, "generic")))

    def run_cli(self, transcript, enabled, worker):
        classifier_texts = []
        embedding_texts = []
        probabilities = [Probabilities([0.01, 0.99]), Probabilities([0.999, 0.001])]
        classifier = types.SimpleNamespace(
            classes_=["remove", "retain"],
            predict_proba=lambda matrix: (classifier_texts.append(matrix) or probabilities),
        )
        modules = {
            "joblib": types.SimpleNamespace(load=lambda _path: {"embedding_model": "offline", "classifier": classifier}),
            "numpy": types.SimpleNamespace(),
        }
        def embeddings(texts, _model, _np):
            embedding_texts.extend(texts)
            return "unchanged-matrix" if worker else None
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "generic.txt"
            path.write_text(transcript, encoding="utf-8")
            args = ["staged", str(path), "--model", "unused", "--preserve-short-temporal-fragments"]
            if enabled:
                args.append("--preserve-short-context-fragments")
            output = io.StringIO()
            with mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "argv", args), mock.patch.object(
                staged, "remote_embedding_matrix", side_effect=embeddings
            ), mock.patch.dict("os.environ", {"MINUTES_MINILM_WORKER_URL": "offline-no-network"}), contextlib.redirect_stdout(output):
                self.assertEqual(staged.main(), 0)
        return json.loads(output.getvalue()), embedding_texts, classifier_texts

    def test_cli_worker_and_fallback_preserve_context_without_changing_classification(self):
        transcript = (
            "Morgan Hale 0:12 Conditional. We will review the proposed plan tomorrow.\n"
            "Sam Lee 0:13 Hold on. I need to sneeze. Not approved.\n"
        )
        for worker in [True, False]:
            with self.subTest(worker=worker):
                before, old_texts, old_matrices = self.run_cli(transcript, False, worker)
                after, new_texts, new_matrices = self.run_cli(transcript, True, worker)
                self.assertEqual(old_texts, new_texts)
                self.assertEqual(old_matrices, new_matrices)
                self.assertEqual(after["embeddingSource"], "worker" if worker else "heuristic_fallback")
                for key in ["removedUnitCount", "keptUnitCount", "totalUnitCount", "rawLength"]:
                    self.assertEqual(after[key], before[key])
                for old, new in zip(before["sourceUnits"], after["sourceUnits"]):
                    for key in ["id", "sequence", "speaker", "timestamp", "classification", "confidence", "restored"]:
                        self.assertEqual(old[key], new[key])
                self.assertEqual(after["sourceUnits"][0]["text"], "Conditional. We will review the proposed plan tomorrow.")
                self.assertIn("Morgan Hale: Conditional.", after["preparedTranscript"])
                self.assertNotIn("Not approved.", after["preparedTranscript"])
                self.assertEqual(after["sourceUnits"][1]["text"], before["sourceUnits"][1]["text"])
                self.assertNotIn("shortContext", json.dumps(after["sourceUnits"]))


if __name__ == "__main__":
    unittest.main()
