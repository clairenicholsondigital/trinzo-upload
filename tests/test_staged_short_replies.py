import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

try:
    import staged_simplified_minilm as staged
except Exception as error:  # heavy optional dependencies may be missing
    staged = None
    IMPORT_ERROR = error


TRANSCRIPT = """Rebecca Gill   2:56I don't know, David, if you want to have a look at that, just make sure I'm along the right lines.

David Didsbury   3:31Okay.

Jacqui Fox   3:37Okay, perfect. And then from the software perspective, there is more to cover here.

Ciaran Ryan   4:10Will do.

Adil Kauim   4:20I think the study is going well.
"""


@unittest.skipIf(staged is None, "staged MiniLM dependencies are not installed")
class ShortRepliesTest(unittest.TestCase):
    def test_whole_turn_short_replies_are_kept_as_rows(self):
        rows = staged.short_reply_rows(TRANSCRIPT, "t.txt")
        self.assertEqual([(row["speaker"], row["text"]) for row in rows],
                         [("David Didsbury", "Okay.")])
        self.assertTrue(all(row["shortReply"] for row in rows))

    def test_a_reply_during_an_update_is_not_kept(self):
        transcript = ("Jacqui Fox   2:24Our hazard analysis needs some additional updates for cybersecurity.\n\n"
                      "Rebecca Gill   2:30Yes.\n\n"
                      "Rebecca Gill   2:40Could you send it over when you can?\n\n"
                      "Ciaran Ryan   2:50Will do.\n")
        rows = staged.short_reply_rows(transcript, "t.txt")
        self.assertEqual([(row["speaker"], row["text"]) for row in rows], [("Ciaran Ryan", "Will do.")])

    def test_long_or_substantive_turns_are_not_short_replies(self):
        rows = staged.short_reply_rows("Adil Kauim   4:20I think the study is going well.\n", "t.txt")
        self.assertEqual(rows, [])

    def test_remote_embeddings_are_batched_and_keep_input_order(self):
        import numpy as np

        class FakeBackend:
            available = True
            model_name = "sentence-transformers/all-MiniLM-L6-v2"

            def __init__(self):
                self.batch_sizes = []

            def encode_many(self, texts):
                self.batch_sizes.append(len(texts))
                return {
                    staged.usefulness.compact(text): [float(text.rsplit(" ", 1)[-1]), 1.0]
                    for text in texts
                }

        backend = FakeBackend()
        texts = [f"Meeting sentence {index}" for index in range(130)]
        matrix = staged.remote_embedding_matrix(texts, backend.model_name, np, backend=backend)

        self.assertEqual(backend.batch_sizes, [130])
        self.assertEqual(matrix.shape, (130, 2))
        self.assertEqual(matrix[0].tolist(), [0.0, 1.0])
        self.assertEqual(matrix[-1].tolist(), [129.0, 1.0])

    def test_incompatible_worker_model_uses_local_fallback(self):
        class FakeBackend:
            available = True
            model_name = "different-model"

        with mock.patch.dict("os.environ", {"MINUTES_MINILM_WORKER_URL": "http://worker"}):
            matrix = staged.remote_embedding_matrix(
                ["Meeting sentence"], "expected-model", object(), backend=FakeBackend()
            )
        self.assertIsNone(matrix)


if __name__ == "__main__":
    unittest.main()
