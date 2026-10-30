import unittest
from scripts.project_update_minilm import build_project_update_output, infer_status_from_text


class ProjectStatusBindingRegressionTest(unittest.TestCase):
    def report(self, texts, previous_status=None):
        context = {"found": True, "activeMilestones": [
            {"milestoneId": 1, "milestoneName": "Data migration"},
            {"milestoneId": 2, "milestoneName": "Security sign-off"},
        ]}
        if previous_status:
            context['activeMilestones'][0]['latestAssessment'] = {'status': previous_status}
        output = build_project_update_output("\n".join("Minutes: " + text for text in texts),
            use_minilm=False, use_rewrite=False, project_context=context)
        return {row["milestone"]: row["delivery_status"] for row in output["projectReport"]["milestones"]}

    def test_negated_states_cannot_become_positive_states(self):
        for wording, forbidden in [("is not finished", "complete"), ("has not started", "in_progress"),
                ("is not blocked", "blocked"), ("has not yet been signed off", "complete")]:
            with self.subTest(wording=wording):
                self.assertNotEqual(self.report([f"The milestone for 'Data migration' {wording}."])["Data migration"], forbidden)

    def test_unqualified_positive_states_survive(self):
        for wording, expected in [("is completed", "complete"), ("is blocked", "blocked"),
                ("is in progress", "in_progress"), ("is delayed", "awaiting_input")]:
            with self.subTest(wording=wording):
                self.assertEqual(self.report([f"The milestone for 'Data migration' {wording}."])["Data migration"], expected)

    def test_neighbouring_workstreams_do_not_lend_each_other_status(self):
        for texts in [
            ["The milestone for 'Data migration' is in progress.", "The milestone for 'Security sign-off' is completed."],
            ["The milestone for 'Security sign-off' is completed.", "The milestone for 'Data migration' is in progress."],
            ["The milestone for 'Data migration' is blocked.", "The milestone for 'Security sign-off' is completed."],
        ]:
            with self.subTest(texts=texts):
                statuses = self.report(texts)
                self.assertEqual(statuses['Security sign-off'], 'complete')
                self.assertEqual(statuses['Data migration'], 'blocked' if 'blocked' in ' '.join(texts) else 'in_progress')

    def test_distinct_clauses_in_one_item_are_bound_to_their_own_milestone(self):
        result = self.report(["The milestone for 'Data migration' is blocked, while 'Security sign-off' is completed."])
        self.assertEqual(result['Data migration'], 'blocked')
        self.assertEqual(result['Security sign-off'], 'complete')

    def test_planned_conditional_and_questioned_completion_is_not_established(self):
        for wording in ['will be completed next week', 'might be completed', 'would be complete if approval arrived', 'is completed?']:
            with self.subTest(wording=wording):
                self.assertNotEqual(self.report([f"The milestone for 'Data migration' {wording}"])["Data migration"], 'complete')

    def test_word_fragments_do_not_create_status(self):
        self.assertEqual(infer_status_from_text('The document describes stonework and built-in controls.'), 'unknown')

    def test_current_uncertainty_does_not_reconfirm_a_historical_status(self):
        for previous, wording in [('completed', 'is not finished'), ('completed', 'might be completed'),
                ('blocked', 'is not blocked')]:
            with self.subTest(previous=previous, wording=wording):
                current = self.report([f"The milestone for 'Data migration' {wording}."], previous)['Data migration']
                self.assertNotEqual(current, previous)

    def test_unmentioned_milestone_still_keeps_its_historical_baseline(self):
        self.assertEqual(self.report(["The milestone for 'Security sign-off' is completed."], 'on_track')['Data migration'], 'on_track')


if __name__ == '__main__':
    unittest.main()
