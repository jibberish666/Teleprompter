"""Unit tests for teleprompter telemetry and rehearsal observer (telemetry.py)."""
import unittest

import aligner
from telemetry import RehearsalObserver


class TestRehearsalObserver(unittest.TestCase):
    def setUp(self):
        self.script = ["Today", "we", "will", "test", "rehearsal", "telemetry", "tracking"]
        self.observer = RehearsalObserver(self.script)

    def test_initial_state(self):
        self.assertEqual(len(self.observer.get_all_fumbles()), 0)
        self.assertFalse(self.observer.has_new_fumbles)
        self.assertEqual(len(self.observer.get_new_fumbles()), 0)
        summary = self.observer.get_summary()
        self.assertEqual(summary["total_fumbles"], 0)
        self.assertEqual(summary["skipped"], 0)
        self.assertEqual(summary["stumbled"], 0)
        self.assertEqual(summary["repeated"], 0)

    def test_record_fumble_deduplication(self):
        self.observer.record_fumble(1, "skipped")
        self.assertEqual(len(self.observer.get_all_fumbles()), 1)
        self.assertTrue(self.observer.has_new_fumbles)

        # Duplicate index should not be recorded twice
        self.observer.record_fumble(1, "stumbled")
        self.assertEqual(len(self.observer.get_all_fumbles()), 1)
        self.assertEqual(self.observer.get_all_fumbles()[0]["reason"], "skipped")

    def test_draining_new_fumbles(self):
        self.observer.record_fumble(0, "stumbled")
        self.observer.record_fumble(1, "skipped")
        self.assertTrue(self.observer.has_new_fumbles)

        new_items = self.observer.get_new_fumbles()
        self.assertEqual(len(new_items), 2)
        self.assertFalse(self.observer.has_new_fumbles)
        self.assertEqual(len(self.observer.get_new_fumbles()), 0)
        # All fumbles still contains both
        self.assertEqual(len(self.observer.get_all_fumbles()), 2)

    def test_skip_detection_on_match_and_jump(self):
        # Cursor at 0, match at index 2 (skips index 0 and 1)
        self.observer.on_match([2], score=1.0, is_compound=False, cursor_before=0)
        fumbles = self.observer.get_all_fumbles()
        self.assertEqual(len(fumbles), 2)
        reasons = {f["index"]: f["reason"] for f in fumbles}
        self.assertEqual(reasons[0], "skipped")
        self.assertEqual(reasons[1], "skipped")

    def test_stumble_detection_low_similarity(self):
        # Match with low score (< 0.85) and not compound
        self.observer.on_match([3], score=0.80, is_compound=False, cursor_before=3)
        fumbles = self.observer.get_all_fumbles()
        self.assertEqual(len(fumbles), 1)
        self.assertEqual(fumbles[0]["index"], 3)
        self.assertEqual(fumbles[0]["reason"], "stumbled")

    def test_stumble_detection_unmatched_near_miss(self):
        # Script at cursor 4 is "rehearsal". Spoken token is "rehears"
        self.observer.on_unmatched("rehears", cursor=4)
        fumbles = self.observer.get_all_fumbles()
        self.assertEqual(len(fumbles), 1)
        self.assertEqual(fumbles[0]["index"], 4)
        self.assertEqual(fumbles[0]["reason"], "stumbled")

    def test_repetition_detection_on_token(self):
        # Cursor at 3. Script contains "today" (0), "we" (1), "will" (2).
        # Spoken token repeats "will"
        self.observer.on_token("will", cursor=3)
        fumbles = self.observer.get_all_fumbles()
        self.assertEqual(len(fumbles), 1)
        self.assertEqual(fumbles[0]["index"], 2)
        self.assertEqual(fumbles[0]["reason"], "repeated")

    def test_reset(self):
        self.observer.record_fumble(0, "skipped")
        self.assertEqual(len(self.observer.get_all_fumbles()), 1)

        self.observer.reset(["New", "script"])
        self.assertEqual(len(self.observer.get_all_fumbles()), 0)
        self.assertEqual(self.observer.raw_words, ["New", "script"])
        self.assertEqual(self.observer.script, ["new", "script"])

    def test_attach_observer_to_aligner(self):
        al = aligner.Aligner(self.script, window=5)
        self.assertIsNone(al.observer)
        al.attach_observer(self.observer)
        self.assertIs(al.observer, self.observer)

        # Match through aligner
        al.align(["today", "we"])
        self.assertEqual(al.cursor, 2)
        self.assertEqual(len(al.fumbles), 0)


if __name__ == "__main__":
    unittest.main()
