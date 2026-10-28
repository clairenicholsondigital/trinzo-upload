import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import meeting_minutes_usefulness_classifier as parser
import staged_simplified_minilm as staged


class Probability(list):
    def argmax(self):
        return max(range(len(self)), key=self.__getitem__)


class MeaningfulShortAnswerTests(unittest.TestCase):
    def prepare(self, text, enabled=True):
        rows = parser.parse_transcript(text, 'control', preserve_short_temporal_fragments=True,
                                       preserve_short_context_fragments=True,
                                       preserve_meaningful_short_answers=enabled)
        probabilities = [Probability([0.999, 0.001]) for _ in rows]
        classified = staged.classify_source_rows(rows, probabilities, ['remove', 'retain'], 0.85)
        return rows, [r for r in classified if r['classification'] != 'remove']

    def test_quantity_answer_survives_parser_and_high_confidence_remove(self):
        for header in ['Sam Lee 0:02 ', 'Sam Lee: ']:
            for answer in ['Twenty four.', '24.', 'About twenty four.', 'No. Twenty four.',
                           'Twenty four. Actually, no, thirty.', '7.2 kilograms.']:
                with self.subTest(answer=answer, header=header):
                    rows, kept = self.prepare('Alex Bell 0:01 How many units?\n' + header + answer)
                    protected = [r for r in kept if r.get('meaningfulShortAnswer')]
                    self.assertEqual(len(protected), 1)
                    self.assertEqual(protected[0]['text'], answer)
                    self.assertEqual(protected[0]['speaker'], 'Sam Lee')
                    self.assertEqual(protected[0]['classification'], 'uncertain')
                    self.assertEqual(staged.prepared_unit_text(protected[0]), answer)

    def test_explicit_proceed_keeps_complete_timing_or_cancellation(self):
        for reply in ['Okay, do that. Not this week though, this week is the alarm regression.',
                      'Do that. Only if the review passes.',
                      'Okay, do that. Actually, no, do not proceed.',
                      'Yes, go ahead. No. I have changed my mind.']:
            with self.subTest(reply=reply):
                text = ('Alex Bell 0:01 I could automate the searches and write the results.\n'
                        'Jordan Reed 0:02 That is a better answer.\nSam Lee 0:03 ' + reply)
                rows, kept = self.prepare(text)
                protected = [r for r in kept if r.get('meaningfulShortAnswer')]
                self.assertEqual(len(protected), 1)
                self.assertEqual(protected[0]['text'], reply)
                self.assertEqual(protected[0]['timestamp'], '0:03')
                self.assertIn(reply, staged.render_full_name_clean_transcript(kept))

    def test_no_guessing_from_backchannels_quotes_same_speaker_or_unrelated_numbers(self):
        controls = [
            'Alex Bell: I could automate the searches.\nSam Lee: Okay.',
            'Alex Bell: I could automate the searches.\nSam Lee: Yes.',
            'Alex Bell: I could automate the searches.\nSam Lee: The email says "Okay, do that".',
            'Alex Bell: I could automate the searches.\nSam Lee: "Okay, do that".',
            'Alex Bell: We discussed the timetable yesterday.\nSam Lee: Do that.',
            'Alex Bell: How many units?\nAlex Bell: Twenty four.',
            'Alex Bell: The review will happen tomorrow.\nSam Lee: Twenty four.',
            'Alex Bell: How many units?\nSam Lee: How many?',
            'Alex Bell: How many units?\nSam Lee: Twenty four is the example in the training manual.',
            'Alex Bell: I could automate the searches.\nSam Lee: Okay, do that. I need to sneeze.',
        ]
        for text in controls:
            with self.subTest(text=text):
                rows, kept = self.prepare(text)
                self.assertFalse(any(r.get('meaningfulShortAnswer') for r in rows))

    def test_proposal_context_is_bounded_and_does_not_cross_three_turns(self):
        text = ('Alex Bell: I could automate the searches.\nJordan Reed: We need to review the next item.\n'
                'Taylor Green: We need the updated document tomorrow.\nSam Lee: Okay, do that.')
        self.assertFalse(any(r.get('meaningfulShortAnswer') for r in self.prepare(text)[0]))

    def test_disabled_option_preserves_current_rows_exactly(self):
        text = ('Alex Bell 0:01 How many units?\nSam Lee 0:02 Twenty four.\n'
                'Alex Bell 0:03 I could automate the searches.\nSam Lee 0:04 Okay, do that. Not this week.')
        expected = parser.parse_transcript(text, 'control', preserve_short_temporal_fragments=True,
                                           preserve_short_context_fragments=True)
        actual, _ = self.prepare(text, enabled=False)
        self.assertEqual(actual, expected)
        self.assertFalse(any(r.get('meaningfulShortAnswer') for r in actual))

    def test_immediate_following_refusal_is_not_lost_or_reattributed(self):
        for reply, before in [
            ('No. Do not proceed.', 'Alex Bell: I could automate the searches.\nSam Lee: Okay, do that.'),
            ('Actually, no. Thirty.', 'Alex Bell: How many units?\nSam Lee: Twenty four.'),
            ('Only if approved.', 'Alex Bell: I could automate the searches.\nSam Lee: Go ahead.'),
        ]:
            with self.subTest(reply=reply):
                _, kept = self.prepare(before + '\nJordan Reed: ' + reply)
                qualified = [r for r in kept if r.get('meaningfulShortAnswer') == 'answer_qualification']
                self.assertEqual(len(qualified), 1)
                self.assertEqual(qualified[0]['speaker'], 'Jordan Reed')
                self.assertEqual(qualified[0]['text'], reply)
                self.assertEqual(staged.prepared_unit_text(qualified[0]), reply)
        # Protection does not propagate through arbitrary later turns.
        rows, _ = self.prepare('Alex Bell: How many units?\nSam Lee: Twenty four.\n'
                               'Jordan Reed: No.\nTaylor Green: No.')
        self.assertEqual(sum(r.get('meaningfulShortAnswer') == 'answer_qualification' for r in rows), 1)


if __name__ == '__main__':
    unittest.main()
