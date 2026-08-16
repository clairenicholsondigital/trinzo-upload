import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from canonical_minutes_minilm_profile import matrix_has_features  # noqa: E402


class CanonicalMiniLMProfileTest(unittest.TestCase):
    def test_zero_feature_context_matrix_is_not_predictable(self):
        class Matrix:
            def __init__(self, shape):
                self.shape = shape

        self.assertFalse(matrix_has_features(Matrix((700, 0))))
        self.assertFalse(matrix_has_features(Matrix((0, 384))))
        self.assertTrue(matrix_has_features(Matrix((700, 384))))


if __name__ == "__main__":
    unittest.main()
