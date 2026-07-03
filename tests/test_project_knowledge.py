import unittest

from scripts.project_knowledge_embeddings import chunk_text
from scripts.project_knowledge_retrieval import tokens


class ProjectKnowledgeTests(unittest.TestCase):
    def test_chunk_text_prefers_sentence_boundaries_and_overlap(self):
        text = "First sentence. " + ("Middle detail. " * 120) + "Final sentence."
        chunks = chunk_text(text, chunk_size=500, overlap=80)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= 560 for chunk in chunks))
        self.assertIn("First sentence", chunks[0])
        self.assertIn("Final sentence", chunks[-1])

    def test_chunk_text_empty_returns_no_chunks(self):
        self.assertEqual(chunk_text("   \n\n  "), [])

    def test_retrieval_tokens_drop_noise_words(self):
        self.assertEqual(tokens("The project update for migration and training plan"), ["migration", "training", "plan"])


if __name__ == "__main__":
    unittest.main()
