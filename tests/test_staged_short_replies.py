import sys
import unittest
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


if __name__ == "__main__":
    unittest.main()
